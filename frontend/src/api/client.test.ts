import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createUnifiedVerification } from "../test/inventoryVerification";

import {
  ApiError,
  beginCapabilityConsent,
  blockAgent,
  cancelDataSyncRun,
  cancelInventoryRefresh,
  cancelPackageRefreshJob,
  checkCapabilities,
  getBulkActionJob,
  getDefenderHuntingJob,
  getAgents,
  getAgentDetails,
  getCurrentUser,
  getUnifiedAgents,
  getAgentUsageCandidates,
  getAuditEvents,
  associateAgentUsage,
  removeAgentUsageAssociation,
  downloadUnifiedAgentInventoryCsv,
  downloadPackageInventoryCsv,
  downloadInventoryCsv,
  downloadPurviewAuditCsv,
  downloadDefenderHuntingCsv,
  downloadAdministrativeAuditCsv,
  downloadOfficialUsageCsv,
  getPackageRefreshJob,
  getOfficialUsageAggregate,
  getOfficialUsageAgentDetail,
  getOfficialUsageHistory,
  getOfficialUsageOverview,
  getOfficialUsageUsers,
  getCopilotUsageUsers,
  getDataSyncRun,
  getDataSyncState,
  getPurviewAuditJob,
  getQuarantineJob,
  getQuarantineTargets,
  getQuarantineStatus,
  previewQuarantine,
  previewPackageMutation,
  reconcileBulkActionJob,
  retryDataSyncRun,
  refreshPackageIdentityDetails,
  searchDirectoryPrincipals,
  resolveDirectoryPrincipals,
  resolveAgentPeople,
  startExactPackageRefresh,
  startPackageRefresh,
  stageOfficialUsageReport,
  signOut,
  startDataSync,
  subscribeSessionRevalidationRequired,
  submitQuarantine,
  updateAgentAccess,
  updateAgentsAccess,
  type PackageAccessReplacement,
  type PackageAccessUpdate,
  type AuditEvent,
  type PackageRefreshJob,
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
  it("starts consent with CSRF, the requested return path, and cancellation", async () => {
    const fetchMock = mockJsonResponse({ user: {}, csrfToken: "consent-csrf", roleAssignmentRequired: false });
    await getCurrentUser();
    const result = { authorizationUrl: "https://login.microsoftonline.com/fixture/authorize" };
    fetchMock.mockResolvedValue(Response.json(result));
    const controller = new AbortController();
    await expect(beginCapabilityConsent("graph.package.read.delegated", "/permissions", { signal: controller.signal })).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/consent", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ capabilityId: "graph.package.read.delegated", returnTo: "/permissions" }),
      signal: controller.signal,
      credentials: "include",
      headers: expect.objectContaining({ "Content-Type": "application/json", "X-CSRF-Token": "consent-csrf" }),
    }));
  });

  it("preserves the default consent return path when cancellation is omitted", async () => {
    const fetchMock = mockJsonResponse({ authorizationUrl: "https://login.microsoftonline.com/fixture/authorize" });
    await beginCapabilityConsent("graph.package.read.delegated");
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/consent", expect.objectContaining({
      method: "POST", body: JSON.stringify({ capabilityId: "graph.package.read.delegated", returnTo: "/" }),
    }));
  });

  it.each([false, true])("persists record-scoped people with CSRF, cancellation and force=%s", async force => {
    const fetchMock = mockJsonResponse({ user: {}, csrfToken: "people-csrf", roleAssignmentRequired: false });
    await getCurrentUser();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ people: {}, changed: true }), {
      headers: { "Content-Type": "application/json" },
    }));
    const controller = new AbortController();
    await expect(resolveAgentPeople("agent:record", { force, signal: controller.signal })).resolves.toEqual({
      people: {}, changed: true,
    });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/agent-inventory/people/resolve", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ recordId: "agent:record", ...(force ? { force: true } : {}) }),
      signal: controller.signal,
      credentials: "include",
      headers: expect.objectContaining({ "Content-Type": "application/json", "X-CSRF-Token": "people-csrf" }),
    }));
  });

  it("cancels exact person resolution through the existing protected directory endpoint", async () => {
    const fetchMock = mockJsonResponse({ value: [] });
    const controller = new AbortController();
    const principals = [{ resourceType: "user", resourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }];
    await resolveDirectoryPrincipals(principals, { signal: controller.signal });
    expect(fetchMock).toHaveBeenCalledWith("/api/directory/principals/resolve", expect.objectContaining({
      method: "POST", body: JSON.stringify({ principals }), signal: controller.signal, credentials: "include",
    }));
  });

  it("serializes cumulative activity filters with cancellation and no implicit snapshot selection", async () => {
    const fetchMock = mockJsonResponse({});
    const controller = new AbortController();
    await getOfficialUsageOverview({
      search: "June & July", startDate: "2026-06-01", endDate: "2026-07-15",
      sortBy: "lastActivity", sortDirection: "asc", limit: 25, offset: 50,
    }, { signal: controller.signal });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/official-usage/overview?search=June+%26+July&startDate=2026-06-01&endDate=2026-07-15&sortBy=lastActivity&sortDirection=asc&limit=25&offset=50",
      expect.objectContaining({ signal: controller.signal, credentials: "include" }),
    );
  });

  it("retains administrative-audit export receipts without a package blocked-state claim", async () => {
    const event: AuditEvent = {
      id: "audit-export-receipt", operationId: "export-operation", action: "export-administrative-audit",
      scope: "bulk", agentId: "audit-export", status: "succeeded",
      actor: { displayName: "Reviewer", username: "reviewer@example.invalid", homeAccountId: "reviewer", roles: ["AgentControl.Admin"] },
      startedAt: "2026-09-15T12:00:00.000Z", completedAt: "2026-09-15T12:00:01.000Z",
      requestPath: "/api/audit/events/export.csv", metadata: { selectedCount: 2 },
    };
    mockJsonResponse({ value: [event], count: 1 });
    const result = await getAuditEvents({ action: "export-administrative-audit" });
    expect(result.value).toEqual([event]);
    expect(result.value[0]).not.toHaveProperty("targetBlockedState");
  });

  it.each(["aggregate", "users"] as const)("passes cancellation through the %s official-usage CSV request", async kind => {
    const fetchMock = vi.fn(async () => new Response("selected-report-csv", { headers: { "Content-Type": "text/csv" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const setId = "11111111-1111-4111-8111-111111111111";
    const blob = await downloadOfficialUsageCsv(kind, { setId }, controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(`/api/official-usage/${kind}.csv?setId=${setId}`, {
      credentials: "include", signal: controller.signal, headers: { Accept: "text/csv" },
    });
    expect(await blob.text()).toBe("selected-report-csv");
  });

  it("encodes agent usage reads and sends confirmed, CSRF-protected association changes", async () => {
    const fetchMock = mockJsonResponse({ csrfToken: "association-fixture-csrf" });
    await getCurrentUser();
    const controller = new AbortController();
    const id = "graph_packages:package%2Fone";
    await getAgentUsageCandidates(id, { search: "Report & agent", limit: 20, offset: 40 }, { signal: controller.signal });
    const common = {
      reportSetId: "11111111-1111-4111-8111-111111111111", reportAgentId: "report/Upper:1",
      expectedInventoryRevision: "a".repeat(64), expectedUsageRevision: "b".repeat(64), confirmed: true as const,
    };
    await associateAgentUsage(id, { ...common, target: { source: "graph_packages", packageId: "package/one" } });
    await removeAgentUsageAssociation(id, common);
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/agent-inventory/graph_packages%3Apackage%252Fone/usage-candidates?search=Report+%26+agent&limit=20&offset=40",
      expect.objectContaining({ signal: controller.signal }),
    ]);
    for (const [index, method] of [[2, "POST"], [3, "DELETE"]] as const) {
      const [path, options] = fetchMock.mock.calls[index];
      expect(path).toBe("/api/agent-inventory/graph_packages%3Apackage%252Fone/usage-associations");
      expect(options).toMatchObject({ method, credentials: "include", headers: { "X-CSRF-Token": "association-fixture-csrf", "Content-Type": "application/json" } });
      expect(JSON.parse(String(options?.body))).toMatchObject(common);
    }
  });

  it("uses the durable data-sync state and run contracts", async () => {
    const fetchMock = mockJsonResponse({});
    const controller = new AbortController();

    await getDataSyncState({ signal: controller.signal });
    await getDataSyncRun("run/one", { signal: controller.signal });
    await startDataSync({ mode: "initial" });
    await startDataSync({ mode: "incremental", sources: ["users"] });
    await startDataSync({ mode: "full", clearSavedData: true });
    await retryDataSyncRun("run/one", ["users", "usage_reports"]);
    await cancelDataSyncRun("run/one");

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/data-sync/state",
      expect.objectContaining({ signal: controller.signal }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/data-sync/runs/run%2Fone",
      expect.objectContaining({ signal: controller.signal }),
    ]);
    expect(fetchMock.mock.calls.slice(2).map(([path, init]) => [
      path,
      init?.method,
      init?.body,
    ])).toEqual([
      ["/api/data-sync/runs", "POST", JSON.stringify({ mode: "initial" })],
      ["/api/data-sync/runs", "POST", JSON.stringify({ mode: "incremental", sources: ["users"] })],
      ["/api/data-sync/runs", "POST", JSON.stringify({ mode: "full", clearSavedData: true })],
      ["/api/data-sync/runs/run%2Fone/retry", "POST", JSON.stringify({ sources: ["users", "usage_reports"] })],
      ["/api/data-sync/runs/run%2Fone/cancel", "POST", undefined],
    ]);
  });

  it("loads the licensed usage snapshot with a cancellable read-only request", async () => {
    const fetchMock = mockJsonResponse({ users: [] });
    const controller = new AbortController();
    await getCopilotUsageUsers({ signal: controller.signal });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/copilot-usage/users");
    expect(init?.signal).toBe(controller.signal);
    expect(init?.body).toBeUndefined();
    expect(init?.method ?? "GET").toBe("GET");
  });
  it("uploads official usage without requesting dates or inventing a download timestamp", async () => {
    const fetchMock = mockJsonResponse({ id: "staging-id" });
    const file = new File(["Username,Display name"], "users.csv", { type: "text/csv" });
    await stageOfficialUsageReport(file, { bundleId: "bundle-id" });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/official-usage/staging");
    expect(init?.method).toBe("POST");
    const form = init?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) throw new Error("Expected multipart upload");
    expect([...form.keys()]).toEqual(["file", "bundleId"]);
    expect(form.get("file")).toBe(file);
    expect(form.get("bundleId")).toBe("bundle-id");
  });

  it("preserves explicitly supplied legacy import metadata", async () => {
    const fetchMock = mockJsonResponse({ id: "staging-id" });
    await stageOfficialUsageReport(new File(["report"], "agents.csv"), {
      bundleId: "bundle-id",
      reportingStart: "2026-08-14",
      reportingEnd: "2026-09-12",
      periodProvenance: "operator_asserted",
      downloadedAt: "2026-09-12T14:41:53.000Z",
    });

    const form = fetchMock.mock.calls[0][1]?.body;
    if (!(form instanceof FormData)) throw new Error("Expected multipart upload");
    expect(form.get("reportingStart")).toBe("2026-08-14");
    expect(form.get("reportingEnd")).toBe("2026-09-12");
    expect(form.get("periodProvenance")).toBe("operator_asserted");
    expect(form.get("downloadedAt")).toBe("2026-09-12T14:41:53.000Z");
  });

  it("encodes official usage dashboard filters, thresholds, sorting, and paging", async () => {
    const fetchMock = mockJsonResponse({});
    await getOfficialUsageAggregate({
      setId: "11111111-1111-4111-8111-111111111111",
      search: "Agent & one",
      creatorType: "Agent built by your org",
      startDate: "2026-01-01",
      endDate: "2026-09-12",
      sortBy: "unlicensedUsers",
      sortDirection: "asc",
      limit: 100,
      offset: 200,
    });

    await getOfficialUsageUsers({
      setId: "11111111-1111-4111-8111-111111111111",
      search: "User + one",
      cohort: "low",
      lowResponseThreshold: 5,
      startDate: "2026-01-01",
      endDate: "2026-09-12",
      sortBy: "responses",
      sortDirection: "desc",
      limit: 100,
      offset: 100,
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/official-usage/aggregate?setId=11111111-1111-4111-8111-111111111111&search=Agent+%26+one&creatorType=Agent+built+by+your+org&startDate=2026-01-01&endDate=2026-09-12&sortBy=unlicensedUsers&sortDirection=asc&limit=100&offset=200");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/official-usage/users?setId=11111111-1111-4111-8111-111111111111&search=User+%2B+one&cohort=low&lowResponseThreshold=5&startDate=2026-01-01&endDate=2026-09-12&sortBy=responses&sortDirection=desc&limit=100&offset=100");
  });

  it("loads paginated cumulative official usage history without changing active selection", async () => {
    const fetchMock = mockJsonResponse({});
    const controller = new AbortController();
    await getOfficialUsageHistory({ limit: 25, offset: 50 }, { signal: controller.signal });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/official-usage/history?limit=25&offset=50",
      expect.objectContaining({ signal: controller.signal, credentials: "include" }),
    );
    expect(fetchMock.mock.calls[0][1]?.method ?? "GET").toBe("GET");
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
  });

  it("encodes exact report identities and pins bounded drilldowns to their report set", async () => {
    const fetchMock = mockJsonResponse({});
    const controller = new AbortController();
    const agentId = "Report/Upper%Case:1";
    const setId = "11111111-1111-4111-8111-111111111111";
    await getOfficialUsageAgentDetail(agentId, {
      setId, search: "User + one", sortBy: "displayName", sortDirection: "asc", limit: 20, offset: 40,
    }, { signal: controller.signal });
    await getOfficialUsageUsers({ agentId, setId }, { signal: controller.signal });
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/official-usage/agents/Report%2FUpper%25Case%3A1?setId=${setId}&search=User+%2B+one&sortBy=displayName&sortDirection=asc&limit=20&offset=40`);
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/official-usage/users?agentId=Report%2FUpper%25Case%3A1&setId=${setId}`);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({ credentials: "include", signal: controller.signal });
      expect(options.method).toBeUndefined();
    }
  });

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

  it("notifies session owners for session auth failures and internal role loss, but not provider authorization failures", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionRevalidationRequired(listener);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: 403, code: "forbidden", detail: "Current provider permission is insufficient." }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ status: 401, code: "interaction_required", detail: "Microsoft authorization is required for this capability." }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ status: 401, code: "authorization_expired", detail: "Microsoft authorization expired." }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ status: 403, code: "missing_internal_role", detail: "Viewer is required." }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ status: 401, code: "unauthorized", detail: "The current session has expired.", requestId: "request-401" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAgents()).rejects.toMatchObject({ status: 403 });
    expect(listener).not.toHaveBeenCalled();
    await expect(getAgents()).rejects.toMatchObject({ status: 401, code: "interaction_required" });
    expect(listener).not.toHaveBeenCalled();
    await expect(getAgents()).rejects.toMatchObject({ status: 401, code: "authorization_expired" });
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

  it.each(["delegated", "application"] as const)("cancels an exact %s package refresh through the existing CSRF-protected endpoint", async mode => {
    const fetchMock = mockJsonResponse({ user: {}, csrfToken: "cancel-csrf", roleAssignmentRequired: false });
    await getCurrentUser();
    fetchMock.mockResolvedValue(Response.json({ id: "job/one", status: "cancelled" }));
    await cancelPackageRefreshJob("job/one", mode);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/agents/refresh-jobs/job%2Fone/cancel", expect.objectContaining({
      method: "POST", credentials: "include", body: JSON.stringify({ mode }),
      headers: expect.objectContaining({ "Content-Type": "application/json", "X-CSRF-Token": "cancel-csrf" }),
    }));
  });

  it("cancels an exact Power Platform refresh without acquiring provider authorization", async () => {
    const fetchMock = mockJsonResponse({ user: {}, csrfToken: "cancel-csrf", roleAssignmentRequired: false });
    await getCurrentUser();
    fetchMock.mockResolvedValue(Response.json({ id: "job/one", status: "cancelled" }));
    await cancelInventoryRefresh("job/one");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/inventory/refresh-jobs/job%2Fone/cancel", expect.objectContaining({
      method: "POST", credentials: "include",
      headers: expect.objectContaining({ "X-CSRF-Token": "cancel-csrf" }),
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a stable idempotency key when collecting missing agent identities", async () => {
    const fetchMock = mockJsonResponse({ id: "identity-job", status: "running" });
    await startPackageRefresh("delegated", { idempotencyKey: "agent-identities-snapshot-one" });
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/refresh-jobs", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ mode: "delegated" }),
      headers: expect.objectContaining({ "Idempotency-Key": "agent-identities-snapshot-one" }),
    }));
  });

  it("requests unified saved rows and explicitly refreshes selected matching details", async () => {
    const fetchMock = mockJsonResponse({
      value: [],
      verification: createUnifiedVerification({ graphPackageCount: 0, powerPlatformAgentCount: 0, logicalAgentCount: 0 }, { sourceScopes: false }),
    });
    await getUnifiedAgents({
      search: "Builder & one",
      source: "both",
      linkState: "matched",
      environmentId: "environment/one",
      blocked: true,
      publisher: "__unknown__",
      availableTo: "__some_or_all__",
      host: "__unknown_host__",
      platform: "Copilot Studio",
      createdWithinDays: 30,
      limit: 50,
      offset: 100,
    });
    await refreshPackageIdentityDetails(["package-1", "package-2"]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/agent-inventory?search=Builder+%26+one&source=both&linkState=matched&environmentId=environment%2Fone&blocked=true&publisher=__unknown__&availableTo=__some_or_all__&host=__unknown_host__&platform=Copilot+Studio&createdWithinDays=30&limit=50&offset=100",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/agents/refresh-jobs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ids: ["package-1", "package-2"], mode: "delegated" }),
      }),
    );
  });

  it("resolves canonical and exact source aliases through the unified endpoint without rewriting package targets", async () => {
    const record = {
      id: "agent:11111111-1111-4111-8111-111111111111",
      packages: [{ id: "package/a" }, { id: "package:b" }],
      powerPlatformResource: { nativeId: "native/a", environmentId: "environment-a" },
      identity: {
        state: "matched",
        evidence: [
          { kind: "manifest_schema_native_id", basis: "source_declared_metadata", elementIds: [], packagePath: "manifestId", resourcePath: "nativeId + details.schemaName" },
          { kind: "shared_custom_engine_bot_id", basis: "source_declared_metadata", elementIds: ["bot-one"], packagePath: "Bots.definition.botId", resourcePath: "related package native identity evidence", relatedPackageIds: ["package:b"] },
        ],
        packageEvidence: [], reason: null, invalidMetadata: true,
        warnings: [{ code: "source_specific_agent_identity", message: "Source-specific identity IDs differ without a native resource conflict." }],
      },
    };
    const inventory = {
      value: [record], count: 1, identityCollection: { checkedPackages: 2, pendingPackages: 0, invalidPackages: 1 },
      verification: createUnifiedVerification({ graphPackageCount: 2, powerPlatformAgentCount: 1, logicalAgentCount: 1 }, { packageMetadata: false }),
    };
    const fetchMock = mockJsonResponse(inventory);
    const controller = new AbortController();
    for (const recordId of [record.id, "graph_packages:package%2Fa", "power_platform:environment-a:native%2Fa"]) {
      const response = await getUnifiedAgents({ recordId }, { signal: controller.signal });
      expect(response).toEqual(inventory);
      expect(fetchMock).toHaveBeenLastCalledWith(
        `/api/agent-inventory?${new URLSearchParams({ recordId })}`,
        expect.objectContaining({ signal: controller.signal, credentials: "include" }),
      );
    }
  });

  it("downloads revision-bound unified CSV with cookies and the current CSRF token", async () => {
    const csv = "agentId,packageIds,inventoryPartial\r\nagent-one,\"package-one;package-two\",true\r\n";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ user: { roles: ["AgentControl.Viewer"] }, csrfToken: "csv-csrf" }))
      .mockResolvedValueOnce(new Response(csv, { headers: { "Content-Type": "text/csv" } }));
    vi.stubGlobal("fetch", fetchMock);
    await getCurrentUser();
    const input = { revision: "a".repeat(64), query: { environmentId: "env/one", search: "Agent & one", sortBy: "lastModifiedAt" as const, sortDirection: "desc" as const } };
    const blob = await downloadUnifiedAgentInventoryCsv(input);
    expect(await blob.text()).toBe(csv);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/agent-inventory/export.csv", {
      method: "POST", credentials: "include",
      headers: { Accept: "text/csv", "Content-Type": "application/json", "X-CSRF-Token": "csv-csrf" },
      body: JSON.stringify(input),
    });
  });

  it("preserves exact selected references and reports invalidation without a source-export fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      code: "agent_inventory_changed", detail: "Saved source revision or selected references changed.",
    }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      revision: "b".repeat(64),
      recordIds: ["agent:11111111-1111-4111-8111-111111111111", "graph_packages:opaque%2Fid"],
      query: { sortBy: "displayName" as const, sortDirection: "asc" as const },
    };
    await expect(downloadUnifiedAgentInventoryCsv(input)).rejects.toMatchObject({ status: 409, code: "agent_inventory_changed" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/agent-inventory/export.csv", expect.objectContaining({
      method: "POST", body: JSON.stringify(input),
    }));
  });

  it("preserves separate opaque package targets in detail reads, exact refreshes and mutation previews", async () => {
    const fetchMock = mockJsonResponse({});
    for (const id of ["opaque/legacy%target", "opaque:anchor/target"]) {
      await getAgentDetails(id);
      expect(fetchMock).toHaveBeenLastCalledWith(`/api/agents/${encodeURIComponent(id)}`, expect.objectContaining({ credentials: "include" }));
      await startExactPackageRefresh(id);
      expect(fetchMock).toHaveBeenLastCalledWith(`/api/agents/${encodeURIComponent(id)}/refresh-jobs`, expect.objectContaining({
        method: "POST", body: JSON.stringify({ mode: "delegated" }),
      }));
      await previewPackageMutation({ action: "block", ids: [id], mutationScope: "single" });
      expect(fetchMock).toHaveBeenLastCalledWith("/api/agents/mutation-preview", expect.objectContaining({
        method: "POST", body: JSON.stringify({ action: "block", ids: [id], mutationScope: "single" }),
      }));
    }
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

describe("API response failures", () => {
  const requests = [
    { name: "JSON", send: () => getAgents(), body: "json" },
    { name: "unified inventory CSV", send: () => downloadUnifiedAgentInventoryCsv({ revision: "a".repeat(64) }), body: "blob" },
    { name: "package inventory CSV", send: () => downloadPackageInventoryCsv({ snapshotId: "snapshot-one" }), body: "blob" },
    { name: "Power Platform CSV", send: () => downloadInventoryCsv(), body: "blob" },
    { name: "Purview CSV", send: () => downloadPurviewAuditCsv("job/one"), body: "blob" },
    { name: "Defender CSV", send: () => downloadDefenderHuntingCsv("job/one"), body: "blob" },
    { name: "official usage CSV", send: () => downloadOfficialUsageCsv("aggregate"), body: "blob" },
    { name: "administrative audit CSV", send: () => downloadAdministrativeAuditCsv(["event-one"]), body: "blob" },
  ] as const;

  describe.each(requests)("$name", ({ send, body }) => {
    it.each(["fetch", "body"] as const)("normalizes cancellation during %s", async phase => {
      const cause = new DOMException("Cancelled", "AbortError");
      const response = Response.json({});
      if (phase === "body") vi.spyOn(response, body).mockRejectedValue(cause);
      vi.stubGlobal("fetch", phase === "fetch" ? vi.fn().mockRejectedValue(cause) : vi.fn().mockResolvedValue(response));

      const result = send();
      await expect(result).rejects.toBeInstanceOf(ApiError);
      await expect(result).rejects.toMatchObject({ status: 0, code: "request_aborted", kind: "aborted" });
    });

    it.each(["fetch", "body"] as const)("normalizes connection loss during %s", async phase => {
      const cause = new TypeError("Connection interrupted");
      const response = Response.json({});
      if (phase === "body") vi.spyOn(response, body).mockRejectedValue(cause);
      vi.stubGlobal("fetch", phase === "fetch" ? vi.fn().mockRejectedValue(cause) : vi.fn().mockResolvedValue(response));

      const result = send();
      await expect(result).rejects.toBeInstanceOf(ApiError);
      await expect(result).rejects.toMatchObject({ status: 0, code: "network_error", kind: "network" });
    });

    it("preserves HTTP errors without treating provider authorization as session expiry", async () => {
      const listener = vi.fn();
      const unsubscribe = subscribeSessionRevalidationRequired(listener);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
        status: 200, code: "interaction_required", detail: "Provider consent required.", requestId: "problem-request",
      }, { status: 401 })));
      try {
        await expect(send()).rejects.toMatchObject({
          status: 401, code: "interaction_required", kind: "problem", requestId: "problem-request",
        });
        expect(listener).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });
  });

  describe.each([
    { name: "JSON", send: (signal: AbortSignal) => getAgents({}, { signal }), body: "json" },
    { name: "official usage CSV", send: (signal: AbortSignal) => downloadOfficialUsageCsv("aggregate", {}, signal), body: "blob" },
    { name: "administrative audit CSV", send: (signal: AbortSignal) => downloadAdministrativeAuditCsv(["event-one"], signal), body: "blob" },
  ] as const)("$name cancellation signal", ({ send, body }) => {
    it.each(["fetch", "body", "problem body"] as const)("recognizes a custom abort reason during %s", async phase => {
      const controller = new AbortController();
      const cause = new TypeError("The view was closed");
      const response = Response.json({}, { status: phase === "problem body" ? 400 : 200 });
      vi.spyOn(response, phase === "problem body" ? "json" : body).mockImplementation(async () => {
        controller.abort(cause);
        throw cause;
      });
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
        if (phase === "fetch") {
          controller.abort(cause);
          throw cause;
        }
        return response;
      }));
      await expect(send(controller.signal)).rejects.toMatchObject({
        status: 0, code: "request_aborted", kind: "aborted",
      });
    });
  });

  it("preserves a known HTTP denial when its problem body cannot be received", async () => {
    const response = Response.json({}, { status: 403, headers: { "X-Request-ID": "denied-request" } });
    vi.spyOn(response, "json").mockRejectedValue(new TypeError("Connection interrupted"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(getAgents()).rejects.toMatchObject({
      status: 403, code: "request_failed", kind: "problem", requestId: "denied-request",
    });
  });

  it("reports invalid successful JSON as a protocol error with the request ID", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON", { headers: { "X-Request-ID": "invalid-json-request" } })));
    await expect(getAgents()).rejects.toMatchObject({
      status: 200, code: "invalid_response", kind: "problem", requestId: "invalid-json-request",
      message: "The server returned an invalid JSON response.",
    });
  });

  it.each(["not JSON", "null", "[]", '{"code":23,"detail":{},"requestId":false,"type":[]}'])(
    "retains HTTP status and request diagnostics for malformed problem body %s",
    async body => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
        status: 503, headers: { "X-Request-ID": "fallback-request" },
      })));
      await expect(getAgents()).rejects.toMatchObject({
        status: 503, code: "request_failed", message: "Request failed with status 503.",
        requestId: "fallback-request", type: undefined,
      });
    },
  );

  it("does not replace an aborted problem body with an HTTP failure", async () => {
    const response = Response.json({}, { status: 401 });
    vi.spyOn(response, "json").mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(getAgents()).rejects.toMatchObject({ status: 0, code: "request_aborted", kind: "aborted" });
  });

  it("clears CSRF and notifies session owners for an expired CSV session", async () => {
    const fetchMock = mockJsonResponse({ csrfToken: "expired-session-csrf" });
    await getCurrentUser();
    const listener = vi.fn();
    const unsubscribe = subscribeSessionRevalidationRequired(listener);
    try {
      fetchMock.mockResolvedValueOnce(Response.json({ code: "session_invalidated" }, { status: 401 }));
      await expect(downloadInventoryCsv()).rejects.toMatchObject({ status: 401, code: "session_invalidated" });
      expect(listener).toHaveBeenCalledOnce();
      await checkCapabilities();
      expect(fetchMock.mock.lastCall?.[1]?.headers).not.toHaveProperty("X-CSRF-Token");
    } finally {
      unsubscribe();
    }
  });

  it("accepts an empty 204 logout and clears its CSRF token", async () => {
    const fetchMock = mockJsonResponse({ csrfToken: "logout-csrf" });
    await getCurrentUser();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(signOut()).resolves.toBeUndefined();
    await checkCapabilities();
    expect(fetchMock.mock.lastCall?.[1]?.headers).not.toHaveProperty("X-CSRF-Token");
  });

  it("includes the backend's cancelled package-refresh state in the client contract", () => {
    expectTypeOf<PackageRefreshJob["status"]>().toEqualTypeOf<
      "waiting_authorization" | "running" | "succeeded" | "failed" | "cancelled"
    >();
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
