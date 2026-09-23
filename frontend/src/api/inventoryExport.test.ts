import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadInventoryCsv, getInventoryRefreshJobs, getInventoryRefreshJob, getInventoryQuarantineSelection, subscribeSessionRevalidationRequired } from "./client";
import { createSavedQueryClient, readSavedQuery } from "../savedQueries";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("inventory CSV request contract", () => {
  it("forwards cancellation with the exact saved scope and server sort, without paging", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nativeId\nresource-a", { headers: { "Content-Type": "text/csv" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await downloadInventoryCsv({
      snapshotId: "saved-snapshot", search: "Agent & bot",
      sortBy: "environmentId", sortDirection: "desc",
    }, controller.signal);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/inventory/export.csv?snapshotId=saved-snapshot&search=Agent+%26+bot&sortBy=environmentId&sortDirection=desc",
      { signal: controller.signal, credentials: "include", headers: { Accept: "text/csv" } },
    );
  });

  it("rejects a delayed CSV body after caller cancellation even when the transport ignores abort", async () => {
    let resolve!: (value: Blob) => void;
    const response = new Response("", { headers: { "Content-Type": "text/csv" } });
    vi.spyOn(response, "blob").mockImplementation(() => new Promise<Blob>(done => { resolve = done; }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const controller = new AbortController();
    const pending = downloadInventoryCsv({ snapshotId: "saved-snapshot" }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ status: 0, code: "request_aborted", kind: "aborted" });
    await vi.waitFor(() => expect(response.blob).toHaveBeenCalledOnce());
    controller.abort();
    resolve(new Blob(["obsolete"]));
    await rejected;
  });

  it("does not start an already-cancelled CSV request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("csv"));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(downloadInventoryCsv({ snapshotId: "saved-snapshot" }, controller.signal)).rejects.toMatchObject({ code: "request_aborted" });
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
        getInventoryQuarantineSelection("saved-snapshot", ["agent-a"], { signal }), new AbortController().signal);
      const outcomes = Promise.allSettled([
        resourceRead(), resourceRead(),
        readSavedQuery(client, ["inventory-exact-job"], signal =>
          getInventoryRefreshJob("exact-job", { signal }), new AbortController().signal),
        readSavedQuery(client, ["inventory-refresh-jobs"], signal =>
          getInventoryRefreshJobs({ signal }), new AbortController().signal),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const signals = fetchMock.mock.calls.map(([, options]) => (options as RequestInit).signal);
      await expect(downloadInventoryCsv({ snapshotId: "saved-snapshot" })).rejects.toMatchObject({ status, code });
      expect(onSessionDenied).toHaveBeenCalledTimes(revokeSession ? 1 : 0);
      expect(signals.every(signal => signal?.aborted === revokeSession)).toBe(true);
      complete[0](Response.json({ value: [], snapshot: null }));
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
