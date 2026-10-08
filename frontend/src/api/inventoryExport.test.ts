import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentUser, getInventoryRefreshJobs, getInventoryRefreshJob, getUnifiedAgentDetail, signOut, subscribeSessionRevalidationRequired } from "./client";
import { cancelReportExport, createReportExport, reportExportStatus } from "./reportData";
import { createSavedQueryClient, readSavedQuery } from "../savedQueries";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("durable inventory export request contract", () => {
  it("forwards cancellation and only the pinned selection, without resending filters or paging", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "export" }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await createReportExport({ kind: "power_platform_agents", selectionId: "saved-selection" }, controller.signal);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/data-exports",
      expect.objectContaining({ signal: controller.signal, credentials: "include",
        body: expect.any(String) }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      kind: "power_platform_agents", selectionId: "saved-selection", idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
  });

  describe.each([
    { name: "creation", send: () => createReportExport({ kind: "unified_agents", selectionId: "saved-selection" }) },
    { name: "status", send: () => reportExportStatus("export-id") },
    { name: "cancellation", send: () => cancelReportExport("export-id") },
  ])("export $name retry session boundary", ({ send }) => {
    it.each(["new session", "logout", "session denial"] as const)("does not resend old work after %s during backoff", async boundary => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ code: "data_snapshot_conflict" }, { status: 503 }));
      vi.stubGlobal("fetch", fetchMock);
      const outcome = Promise.allSettled([send()]);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      if (boundary === "new session") {
        fetchMock.mockResolvedValueOnce(Response.json({ csrfToken: "replacement-session" }));
        await getCurrentUser();
      } else if (boundary === "logout") {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
        await signOut();
      } else {
        fetchMock.mockResolvedValueOnce(Response.json({ code: "unauthorized" }, { status: 401 }));
        await expect(getInventoryRefreshJobs()).rejects.toMatchObject({ code: "unauthorized" });
      }
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await outcome).toMatchObject([{ status: "rejected", reason: { code: "request_aborted", kind: "aborted" } }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("continues the same-session retry after a scoped provider denial", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ code: "data_snapshot_conflict" }, { status: 503 }));
      vi.stubGlobal("fetch", fetchMock);
      const pending = send();
      await vi.advanceTimersByTimeAsync(1);
      fetchMock.mockResolvedValueOnce(Response.json({ code: "interaction_required" }, { status: 401 }));
      await expect(getInventoryRefreshJobs()).rejects.toMatchObject({ code: "interaction_required" });
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      await vi.advanceTimersByTimeAsync(1999);
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[2][0]).toBe(fetchMock.mock.calls[0][0]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("rejects delayed export metadata after cancellation even when the transport ignores abort", async () => {
    let resolve!: (value: { id: string }) => void;
    const response = Response.json({});
    vi.spyOn(response, "json").mockImplementation(() => new Promise<{ id: string }>(done => { resolve = done; }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const controller = new AbortController();
    const pending = createReportExport({ kind: "power_platform_agents", selectionId: "saved-selection" }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ status: 0, code: "request_aborted", kind: "aborted" });
    await vi.waitFor(() => expect(response.json).toHaveBeenCalledOnce());
    controller.abort();
    resolve({ id: "obsolete" });
    await rejected;
  });

  it("does not start already-cancelled export creation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "export" }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(createReportExport({ kind: "power_platform_agents", selectionId: "saved-selection" }, controller.signal)).rejects.toMatchObject({ code: "request_aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("inventory saved-read authorization boundaries", () => {
  it.each([
    { status: 401, code: "unauthorized", revokeSession: true },
    { status: 403, code: "missing_internal_role", revokeSession: true },
    { status: 403, code: "invalid_csrf", revokeSession: true },
    { status: 403, code: "forbidden", revokeSession: false },
    { status: 401, code: "interaction_required", revokeSession: false },
    { status: 401, code: "authorization_expired", revokeSession: false },
    { status: 409, code: "selection_invalidated", revokeSession: false },
    { status: 409, code: "export_selection_changed", revokeSession: false },
  ])("fences all admitted siblings only for session-wide $code denials", async ({ status, code, revokeSession }) => {
    const client = createSavedQueryClient();
    const retainedKey = ["saved", "previously-authorized"] as const;
    client.setQueryDefaults(retainedKey, { gcTime: Infinity });
    client.setQueryData(retainedKey, { value: "Authorized saved data" });
    const complete: Array<(response: Response) => void> = [];
    const transports = Array.from({ length: 3 }, () => new Promise<Response>(resolve => { complete.push(resolve); }));
    const fetchMock = vi.fn().mockReturnValueOnce(transports[0]).mockReturnValueOnce(transports[1])
      .mockReturnValueOnce(transports[2]).mockResolvedValueOnce(Response.json({ code }, { status }));
    vi.stubGlobal("fetch", fetchMock);
    const onSessionDenied = vi.fn(() => client.clear());
    const unsubscribe = subscribeSessionRevalidationRequired(onSessionDenied);
    try {
      const resourceRead = () => readSavedQuery(client, ["inventory-selection"], signal =>
        getUnifiedAgentDetail("saved-selection", "agent-a", { signal }), new AbortController().signal);
      const outcomes = Promise.allSettled([
        resourceRead(), resourceRead(),
        readSavedQuery(client, ["inventory-exact-job"], signal =>
          getInventoryRefreshJob("exact-job", { signal }), new AbortController().signal),
        readSavedQuery(client, ["inventory-refresh-jobs"], signal =>
          getInventoryRefreshJobs({ signal }), new AbortController().signal),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const signals = fetchMock.mock.calls.map(([, options]) => (options as RequestInit).signal);
      await expect(createReportExport({ kind: "unified_agents", selectionId: "saved-selection" })).rejects.toMatchObject({ status, code });
      expect(onSessionDenied).toHaveBeenCalledTimes(revokeSession ? 1 : 0);
      expect(signals.every(signal => signal?.aborted === revokeSession)).toBe(true);
      complete[0](Response.json({ id: "agent-a" }));
      complete[1](Response.json({ value: [] }));
      complete[2](Response.json({ value: [], lastAttemptAt: null, lastSuccessAt: null }));
      const results = await outcomes;
      if (revokeSession) {
        expect(results).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({
          status: "rejected", reason: expect.objectContaining({ code: "request_aborted", kind: "aborted" }),
        })));
        expect(client.getQueryData(retainedKey)).toBeUndefined();
      } else {
        expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
        expect(client.getQueryData(retainedKey)).toEqual({ value: "Authorized saved data" });
      }
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
