import { afterEach, describe, expect, it, vi } from "vitest";
import { getInventoryRefreshJobs, getInventoryRefreshJob, getUnifiedAgentDetail, subscribeSessionRevalidationRequired } from "./client";
import { createReportExport } from "./reportData";
import { createSavedQueryClient, readSavedQuery } from "../savedQueries";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
    { status: 403, code: "forbidden", revokeSession: false },
    { status: 401, code: "interaction_required", revokeSession: false },
    { status: 401, code: "authorization_expired", revokeSession: false },
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
