import { afterEach, describe, expect, it, vi } from "vitest";

import {
  blockAgent,
  checkCapabilities,
  getBulkActionJob,
  getDefenderHuntingJob,
  getAgents,
  getPackageRefreshJob,
  getPurviewAuditJob,
  getQuarantineJob,
  getQuarantineTargets,
  getQuarantineStatus,
  previewQuarantine,
  previewPackageMutation,
  reconcileBulkActionJob,
  searchDirectoryPrincipals,
  startExactPackageRefresh,
  startPackageRefresh,
  subscribeSessionRevalidationRequired,
  submitQuarantine,
  updateAgentAccess,
  updateAgentsAccess,
  type PackageAccessReplacement,
  type PackageAccessUpdate,
} from "./client";

const accessUpdate: PackageAccessReplacement = {
  target: "availability",
  mode: "replace",
  scope: "specific",
  principals: [
    { resourceId: "user-1", resourceType: "user" },
    { resourceId: "group-1", resourceType: "group" },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("access API client", () => {
  it("requests failed-check recovery only for an explicit retry", async () => {
    const fetchMock = mockJsonResponse({ value: [] });
    await checkCapabilities();
    await checkCapabilities({ retryFailed: true });
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "/api/capabilities/check",
      "/api/capabilities/check?retry=failed",
    ]);
    expect(fetchMock.mock.calls.every(call => call[1]?.method === "POST")).toBe(true);
  });

  it("encodes directory searches and limits", async () => {
    const fetchMock = mockJsonResponse({ value: [] });

    await searchDirectoryPrincipals("Research & Development", 40);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/directory/principals?search=Research+%26+Development&limit=40",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("sends a single-agent replacement to the encoded access route", async () => {
    const fetchMock = mockJsonResponse({ agent: {}, result: {} });

    await updateAgentAccess("package/with spaces", accessUpdate, "a".repeat(64));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/package%2Fwith%20spaces/access",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ ...accessUpdate, confirmationHash: "a".repeat(64) }),
      }),
    );
  });

  it("sends agent ids and Add semantics in one bulk request", async () => {
    const fetchMock = mockJsonResponse({ id: "job-1" });
    const addUpdate: PackageAccessUpdate = {
      ...accessUpdate,
      mode: "add",
    };

    await updateAgentsAccess(["agent-1", "agent-2"], addUpdate, "b".repeat(64));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/access",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ids: ["agent-1", "agent-2"], ...addUpdate, confirmationHash: "b".repeat(64) }),
      }),
    );
  });

  it("loads saved package data without a provider refresh", async () => {
    const fetchMock = mockJsonResponse({ value: [], count: 0, snapshot: null });
    await getAgents();
    expect(fetchMock).toHaveBeenCalledWith("/api/agents", expect.objectContaining({ credentials: "include" }));
  });

  it("notifies session owners for API 401 and internal role loss, but not provider 403 responses", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionRevalidationRequired(listener);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: 403, code: "forbidden", detail: "Current provider permission is insufficient." }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ status: 403, code: "missing_internal_role", detail: "Viewer is required." }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ status: 401, code: "unauthorized", detail: "The current session has expired.", requestId: "request-401" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAgents()).rejects.toMatchObject({ status: 403 });
    expect(listener).not.toHaveBeenCalled();
    await expect(getAgents()).rejects.toMatchObject({ status: 403, code: "missing_internal_role" });
    expect(listener).toHaveBeenCalledOnce();
    await expect(getAgents()).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 401,
      code: "unauthorized",
      requestId: "request-401",
    }));
    unsubscribe();
  });

  it("starts and polls an explicit delegated package refresh", async () => {
    const fetchMock = mockJsonResponse({ id: "job-1", status: "succeeded" });
    await startPackageRefresh();
    await startExactPackageRefresh("package/one");
    await getPackageRefreshJob("job/1");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/agents/refresh-jobs", expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "delegated" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/agents/package%2Fone/refresh-jobs", expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "delegated" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/agents/refresh-jobs/job%2F1?mode=delegated", expect.objectContaining({ credentials: "include" }));
  });

  it("uses distinct encoded GET routes for exact saved job sources", async () => {
    const fetchMock = mockJsonResponse({ id: "job/1" });
    const controller = new AbortController();
    await getBulkActionJob("job/1", { signal: controller.signal });
    await getQuarantineJob("job/1", { signal: controller.signal });
    await getPurviewAuditJob("job/1", { signal: controller.signal });
    await getDefenderHuntingJob("job/1", { signal: controller.signal });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/agents/bulk-jobs/job%2F1",
      "/api/quarantine/jobs/job%2F1",
      "/api/audit-search/jobs/job%2F1",
      "/api/hunting/jobs/job%2F1",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(expect.objectContaining({ signal: controller.signal }));
      expect(init).not.toHaveProperty("method");
    }
  });

  it("previews exact mutation intent and submits the returned hash", async () => {
    const fetchMock = mockJsonResponse({ confirmationHash: "c".repeat(64), summary: {} });
    await previewPackageMutation({ action: "block", ids: ["package-1"], mutationScope: "single" });
    await blockAgent("package-1", "c".repeat(64));
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/agents/mutation-preview", expect.objectContaining({
      method: "POST", body: JSON.stringify({ action: "block", ids: ["package-1"], mutationScope: "single" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/agents/package-1/block", expect.objectContaining({
      method: "POST", body: JSON.stringify({ confirmationHash: "c".repeat(64) }),
    }));
  });

  it("reconciles an inconclusive job through a read-only review route", async () => {
    const fetchMock = mockJsonResponse({ id: "job-1", status: "partial", reconciliation: { attempted: 1, failed: 0, errors: [] } });
    await reconcileBulkActionJob("job/1");
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/bulk-jobs/job%2F1/reconcile", expect.objectContaining({ method: "POST" }));
  });

  it("encodes exact quarantine status targets and preserves a caller-owned write key", async () => {
    const fetchMock = mockJsonResponse({ confirmationHash: "c".repeat(64), summary: {} });
    await getQuarantineTargets({ search: "Agent & one", limit: 25, offset: 50 });
    await getQuarantineStatus("snapshot/id", "native id", true);
    await previewQuarantine({ action: "quarantine", snapshotId: "snapshot-a", resourceNativeIds: ["native-a"] });
    await submitQuarantine({ action: "quarantine", snapshotId: "snapshot-a", resourceNativeIds: ["native-a"], confirmationHash: "c".repeat(64) }, "stable-write-key");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/quarantine/targets?search=Agent+%26+one&limit=25&offset=50", expect.objectContaining({ credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/quarantine/status?snapshotId=snapshot%2Fid&nativeId=native+id&force=true", expect.objectContaining({ credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/quarantine/preview", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "quarantine", snapshotId: "snapshot-a", resourceNativeIds: ["native-a"] }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/quarantine/jobs", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "Idempotency-Key": "stable-write-key" }) }));
  });
});

function mockJsonResponse(body: unknown) {
  const fetchMock = vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
