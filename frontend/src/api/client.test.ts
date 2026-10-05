import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { LocalAuditAction as BackendLocalAuditAction } from "../../../backend/src/types/audit";
import { createUnifiedVerification } from "../test/inventoryVerification";
import { createReportExport, reportExportStatus, reportExportDownload, reportPages, readReportDetail, readAgentReportSummary, readAgentReportCandidates, mutateAgentReportAssociation, stageReport } from "./reportData";

import {
  ApiError,
  blockAgent,
  cancelDataSyncRun,
  cancelInventoryRefresh,
  cancelPurviewAuditSearch,
  cancelDefenderHunt,
  checkCapabilities,
  checkAutomaticRefresh,
  getCapabilityCheckProgress,
  getBulkActionJob,
  getDefenderHuntingJob,
  getAgents,
  getAgentDetails,
  getAgentInvestigationContext,
  resolveAgentInvestigationIdentity,
  getAgentPurviewRecords,
  getCurrentUser,
  getUnifiedAgents,
  getUnifiedAgentDetail,
  getAuditEvents,
  downloadPurviewAuditCsv,
  downloadDefenderHuntingCsv,
  downloadAdministrativeAuditCsv,
  deletePurviewAuditSearch,
  deleteDefenderHunt,
  approvePurviewAuditQualification,
  approveDefenderHuntingQualification,
  getPackageRefreshJob,
  getDataSyncRun,
  getDataSyncState,
  getDefenderHuntingCatalog,
  getPurviewAuditJob,
  getDefenderHuntingJobs,
  getDefenderHuntingRows,
  getPurviewAuditCatalog,
  getPurviewAuditJobs,
  getPurviewAuditRecords,
  getQuarantineJob,
  getQuarantineStatus,
  previewQuarantine,
  previewPackageMutation,
  reconcileBulkActionJob,
  resumePurviewAuditSearch,
  resumeDefenderHunt,
  revokeDefenderHuntingRetainedScope,
  refreshPackageIdentityDetails,
  request,
  searchDirectoryPrincipals,
  resolveDirectoryPrincipals,
  resolveAgentPeople,
  startExactPackageRefresh,
  startPackageRefresh,
  signOut,
  startSignIn,
  startDataSync,
  startPurviewAuditQualification,
  startDefenderHuntingQualification,
  subscribeSessionRevalidationRequired,
  submitPurviewAuditSearch,
  submitDefenderHunt,
  submitQuarantine,
  updateAgentAccess,
  updateAgentsAccess,
  type PackageAccessReplacement,
  type PackageAccessUpdate,
  type AuditEvent,
  type AuditEventsQuery,
  type PackageRefreshJob,
  type PurviewAuditFilters,
  type DefenderHuntingFilters,
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

it("checks automatic refresh with an empty JSON body and the current session CSRF token", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ user: {}, csrfToken: "auto-csrf", roleAssignmentRequired: false }))
    .mockResolvedValueOnce(Response.json({ run: null, detailJob: null, revisions: {}, nextCheckAt: "next" }));
  vi.stubGlobal("fetch", fetchMock);
  await getCurrentUser();
  const controller = new AbortController();
  await checkAutomaticRefresh({ signal: controller.signal });
  expect(fetchMock).toHaveBeenLastCalledWith("/api/data-sync/auto-refresh", expect.objectContaining({
    method: "POST", body: "{}", credentials: "include", signal: controller.signal,
  }));
  const headers = new Headers(fetchMock.mock.lastCall?.[1]?.headers);
  expect(headers.get("Content-Type")).toBe("application/json");
  expect(headers.get("X-CSRF-Token")).toBe("auto-csrf");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request headers", () => {
  const formats: Array<{ name: string; create: (entries: [string, string][]) => HeadersInit }> = [
    { name: "record", create: entries => Object.fromEntries(entries) },
    { name: "Headers", create: entries => new Headers(entries) },
    { name: "tuples", create: entries => entries },
  ];

  it.each(formats)("preserves $name headers and case-insensitive overrides without mutating the caller", async ({ create }) => {
    const fetchMock = mockJsonResponse({ csrfToken: "session-csrf" });
    await getCurrentUser();
    const headers = create([
      ["accept", "application/problem+json"],
      ["content-type", "application/json"],
      ["idempotency-key", "caller-operation"],
      ["x-csrf-token", "caller-csrf"],
      ["x-request-context", "caller-context"],
    ]);
    const original = Array.from(new Headers(headers));

    await request("/api/agents/refresh-jobs", { method: "POST", headers, body: "{}" });

    expect(Array.from(new Headers(fetchMock.mock.lastCall?.[1]?.headers))).toEqual(original);
    expect(Array.from(new Headers(headers))).toEqual(original);
  });

  it.each((["POST", "post", "PATCH", "patch", "DELETE", "delete", "GET", "get", "HEAD", "head", "OPTIONS", "options"] as const))(
    "applies session headers according to the normalized %s method",
    async method => {
      const fetchMock = mockJsonResponse({ csrfToken: "session-csrf" });
      await getCurrentUser();
      await request("/api/example", { method });
      const headers = new Headers(fetchMock.mock.lastCall?.[1]?.headers);
      const normalized = method.toUpperCase();
      expect(headers.get("Accept")).toBe("application/json");
      expect(headers.get("X-CSRF-Token")).toBe(["GET", "HEAD", "OPTIONS"].includes(normalized) ? null : "session-csrf");
      if (normalized === "GET") expect(headers.has("Idempotency-Key")).toBe(false);
      else expect(headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    },
  );
});

describe("username sign-in API client", () => {
  const authorizationUrl = "https://login.microsoftonline.com/example/oauth2/v2.0/authorize?state=test-state";

  it("posts the username and return path to the same-origin login endpoint with session cookies", async () => {
    const fetchMock = mockJsonResponse({ authorizationUrl });
    const controller = new AbortController();
    const input = { username: "user@example.com", returnTo: "/agents?q=Budget" };
    await expect(startSignIn(input, { signal: controller.signal })).resolves.toEqual({ authorizationUrl });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/auth/login", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify(input),
      signal: controller.signal,
    }));
    const headers = new Headers(fetchMock.mock.lastCall?.[1]?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("omits an unspecified return path", async () => {
    const fetchMock = mockJsonResponse({ authorizationUrl });
    await startSignIn({ username: "user@example.com" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ username: "user@example.com" });
  });

  it.each([400, 401, 403, 503])("preserves login errors without session revalidation for HTTP %s", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      code: status === 401 ? "unauthorized" : "tenant_not_configured",
      detail: "Your organization is not configured for sign-in.",
      requestId: "login-request",
    }, { status })));
    const listener = vi.fn();
    const unsubscribe = subscribeSessionRevalidationRequired(listener);
    try {
      await expect(startSignIn({ username: "user@unknown.example" })).rejects.toMatchObject({
        status,
        message: "Your organization is not configured for sign-in.",
        requestId: "login-request",
      });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it.each([401, 403])("does not treat an unclassified login HTTP %s as a protected-session denial", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Sign-in unavailable", { status })));
    const listener = vi.fn();
    const unsubscribe = subscribeSessionRevalidationRequired(listener);
    try {
      await expect(startSignIn({ username: "user@example.com" })).rejects.toMatchObject({ status, code: "request_failed" });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it.each([
    null, {}, { authorizationUrl: null }, { authorizationUrl: 42 }, { authorizationUrl: "/api/auth/login" },
    { authorizationUrl: "/api/auth/callback?state=synthetic-state&code=synthetic-code" },
    { authorizationUrl: "javascript:alert(1)" }, { authorizationUrl: "http://login.microsoftonline.com/authorize" },
    { authorizationUrl: "https://username:password@login.microsoftonline.com/authorize" },
  ])("rejects a malformed or unsafe sign-in URL: %j", response => {
    mockJsonResponse(response);
    return expect(startSignIn({ username: "user@example.com" })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("normalizes network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network unavailable")));
    await expect(startSignIn({ username: "user@example.com" })).rejects.toMatchObject({
      code: "network_error", message: "The server could not be reached.",
    });
  });

  it("rejects a late authorization URL after the form is abandoned", async () => {
    const pending = deferredResponse();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
    const controller = new AbortController();
    const result = startSignIn({ username: "user@example.com" }, { signal: controller.signal });
    const cancelled = expect(result).rejects.toMatchObject({ code: "request_aborted" });
    controller.abort();
    pending.resolve(Response.json({ authorizationUrl }));
    await cancelled;
  });
});

describe("access API client", () => {
  it.each([false, true])("reads live permission progress without starting checks (retry=%s)", async retryFailed => {
    const progress = { checks: [{ capabilityId: "graph.directory.read", state: "checking" }] };
    const fetchMock = mockJsonResponse({ progress });
    const controller = new AbortController();
    await expect(getCapabilityCheckProgress({ retryFailed, signal: controller.signal })).resolves.toEqual({ progress });
    expect(fetchMock).toHaveBeenCalledWith(`/api/capabilities/check-progress${retryFailed ? "?retry=failed" : ""}`,
      expect.objectContaining({ signal: controller.signal }));
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
  });

  it("accepts an idle progress response", async () => {
    mockJsonResponse({ progress: null });
    await expect(getCapabilityCheckProgress()).resolves.toEqual({ progress: null });
  });

  it.each([
    {}, { progress: "invalid" }, { progress: { checks: [{ capabilityId: "graph.directory.read", state: "available" }] } },
    { progress: { checks: [{ capabilityId: "graph.directory.read", state: ["checking"] }] } },
    { progress: { checks: [{ capabilityId: "graph.licenses.read", state: "checking" }] } },
    { progress: { checks: [{ capabilityId: "defender.hunting.application", state: "checking" }] } },
    { progress: { checks: Array.from({ length: 2 }, () => ({ capabilityId: "graph.directory.read", state: "checking" })) } },
  ])("rejects malformed or ineligible progress rather than inventing activity: %j", result => {
    mockJsonResponse(result);
    return expect(getCapabilityCheckProgress()).rejects.toMatchObject({ code: "invalid_response" });
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
    }));
    const headers = new Headers(fetchMock.mock.lastCall?.[1]?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-CSRF-Token")).toBe("people-csrf");
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
    await reportPages.overview({
      search: "June & July", startDate: "2026-06-01", endDate: "2026-07-15",
      sort: "lastActivity", order: "asc", limit: 25, cursor: "next",
    }, controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/official-usage/overview?search=June+%26+July&startDate=2026-06-01&endDate=2026-07-15&sort=lastActivity&order=asc&limit=25&cursor=next",
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

  it("keeps audit receipt and query actions aligned with the backend contract", () => {
    expectTypeOf<AuditEvent["action"]>().toEqualTypeOf<BackendLocalAuditAction>();
    expectTypeOf<AuditEventsQuery["action"]>().toEqualTypeOf<BackendLocalAuditAction | undefined>();
  });

  it("filters and retains hunting-scope revocation receipts without package blocked state", async () => {
    const event: AuditEvent = {
      id: "hunting-scope-revocation", operationId: "revoke-operation", action: "revoke-hunting-scope",
      scope: "single", agentId: "retained-scope-one", status: "succeeded",
      actor: { displayName: "Reviewer", username: "reviewer@example.invalid", homeAccountId: "reviewer", roles: ["AgentControl.Admin"] },
      startedAt: "2026-09-15T12:00:00.000Z", completedAt: "2026-09-15T12:00:01.000Z",
      requestPath: "/api/hunting/retained-scopes/retained-scope-one/revoke",
    };
    const fetchMock = mockJsonResponse({ value: [event], count: 1 });
    const result = await getAuditEvents({ action: "revoke-hunting-scope" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/audit/events?action=revoke-hunting-scope", expect.objectContaining({ credentials: "include" }));
    expect(result.value).toEqual([event]);
    expect(result.value[0]).not.toHaveProperty("targetBlockedState");
  });

  it.each(["official_agents", "official_users"] as const)("passes cancellation through %s durable export admission", async kind => {
    const fetchMock = mockJsonResponse({ id: "export-id" });
    const controller = new AbortController();
    const selectionId = "11111111-1111-4111-8111-111111111111";
    const idempotencyKey = crypto.randomUUID();
    expect(await createReportExport({ kind, selectionId, idempotencyKey }, controller.signal)).toEqual({ id: "export-id" });
    expect(fetchMock).toHaveBeenCalledWith("/api/data-exports", expect.objectContaining({
      credentials: "include", signal: controller.signal, method: "POST", body: JSON.stringify({ kind, selectionId, idempotencyKey }),
    }));
    expect(new Headers(fetchMock.mock.lastCall?.[1]?.headers).get("Content-Type")).toBe("application/json");
    expect(reportExportDownload("export-id")).toBe("/api/data-exports/export-id/download");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serializes the nonpaid license cohort with pinned user CSV filters", async () => {
    const fetchMock = mockJsonResponse({ id: "export-id" });
    const controller = new AbortController();
    const idempotencyKey = crypto.randomUUID();
    await reportPages.reportedUsers({
      licenseCohort: "active_without_paid", setId: "saved-set", agentId: "report/agent", search: "A & B",
      cohort: "zero", sort: "responses", order: "asc", selectionId: "saved-selection",
    }, controller.signal);
    await createReportExport({ kind: "official_users", selectionId: "saved-selection", idempotencyKey }, controller.signal);
    expect(fetchMock).toHaveBeenNthCalledWith(1,
      "/api/official-usage/users?licenseCohort=active_without_paid&setId=saved-set&agentId=report%2Fagent&search=A+%26+B&cohort=zero&sort=responses&order=asc&selectionId=saved-selection",
      expect.objectContaining({ credentials: "include", signal: controller.signal }),
    );
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({ kind: "official_users", selectionId: "saved-selection", idempotencyKey }));
  });

  it.each([false, true])("creates a pinned Power Platform export with cancellation supplied: %s", async cancellable => {
    const fetchMock = vi.fn(async () => Response.json({ id: "export" }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const signal = cancellable ? controller.signal : undefined;
    const idempotencyKey = crypto.randomUUID();
    const result = await createReportExport({ kind: "power_platform_agents", selectionId: "saved-selection", idempotencyKey }, signal);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/data-exports",
      expect.objectContaining({ credentials: "include", signal, body: JSON.stringify({ kind: "power_platform_agents", selectionId: "saved-selection", idempotencyKey }) }),
    );
    expect(result.id).toBe("export");
  });

  it("rejects late inventory export metadata after its owner cancels", async () => {
    const pending = deferredResponse();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
    const controller = new AbortController();
    const result = createReportExport({ kind: "power_platform_agents", selectionId: "saved-selection" }, controller.signal);
    const cancelled = expect(result).rejects.toMatchObject({ status: 0, code: "request_aborted", kind: "aborted" });
    controller.abort();
    pending.resolve(Response.json({ id: "superseded-export" }));
    await cancelled;
  });

  it("revalidates exact inventory summary under the same historical set and selected evidence", async () => {
    const fetchMock = mockJsonResponse({});
    const controller = new AbortController();
    await readAgentReportSummary("graph_packages:package%2Fone", { selectionId: "pinned-selection", setId: "retained-set" }, controller.signal);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/agent-inventory/graph_packages%3Apackage%252Fone/usage?selectionId=pinned-selection&setId=retained-set",
      expect.objectContaining({ signal: controller.signal, credentials: "include" }));
  });

  it("encodes agent usage reads and sends confirmed, CSRF-protected association changes", async () => {
    const fetchMock = mockJsonResponse({ csrfToken: "association-fixture-csrf" });
    await getCurrentUser();
    const controller = new AbortController();
    const id = "graph_packages:package%2Fone";
    await readAgentReportCandidates(id, { search: "Report & agent", limit: 20, cursor: "next" }, controller.signal);
    const common = {
      reportSetId: "11111111-1111-4111-8111-111111111111", reportAgentId: "report/Upper:1",
      selectionId: "22222222-2222-4222-8222-222222222222", inventoryRevision: "a".repeat(64), usageRevision: "b".repeat(64), confirmed: true as const,
    };
    await mutateAgentReportAssociation(id, { ...common, target: { source: "graph_packages", packageId: "package/one" } }, "associate");
    await mutateAgentReportAssociation(id, common, "remove");
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/agent-inventory/graph_packages%3Apackage%252Fone/usage-candidates?search=Report+%26+agent&limit=20&cursor=next",
      expect.objectContaining({ signal: controller.signal }),
    ]);
    for (const [index, method] of [[2, "POST"], [3, "DELETE"]] as const) {
      const [path, options] = fetchMock.mock.calls[index];
      expect(path).toBe("/api/agent-inventory/graph_packages%3Apackage%252Fone/usage-associations");
      expect(options).toMatchObject({ method, credentials: "include" });
      const headers = new Headers(options?.headers);
      expect(headers.get("X-CSRF-Token")).toBe("association-fixture-csrf");
      expect(headers.get("Content-Type")).toBe("application/json");
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
      ["/api/data-sync/runs/run%2Fone/cancel", "POST", undefined],
    ]);
  });

  it("loads the Copilot service usage snapshot with a cancellable read-only request", async () => {
    const fetchMock = mockJsonResponse({ value: [] });
    const controller = new AbortController();
    await reportPages.users({}, controller.signal);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/copilot-usage/users");
    expect(init?.signal).toBe(controller.signal);
    expect(init?.body).toBeUndefined();
    expect(init?.method ?? "GET").toBe("GET");
  });
  it("uploads official usage without requesting dates or inventing a download timestamp", async () => {
    const fetchMock = mockJsonResponse({ id: "staging-id" });
    const file = new File(["Username,Display name"], "users.csv", { type: "text/csv" });
    await stageReport(file, { bundleId: "bundle-id" }, {});
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/official-usage/staging?bundleId=bundle-id");
    expect(init?.method).toBe("POST");
    const form = init?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) throw new Error("Expected multipart upload");
    expect([...form.keys()]).toEqual(["file"]);
    expect(form.get("file")).toBe(file);
    expect(form.get("bundleId")).toBeNull();
  });

  it("forwards cancellation to the CSV upload transport", async () => {
    const fetchMock = mockJsonResponse({ id: "staging-id" });
    const controller = new AbortController();
    await stageReport(new File(["report"], "agents.csv"), { bundleId: "bundle-id", rejectDuplicateKind: true }, {}, controller.signal);
    const signal = fetchMock.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("preserves explicitly supplied source metadata without moving immutable intent into multipart fields", async () => {
    const fetchMock = mockJsonResponse({ id: "staging-id" });
    await stageReport(new File(["report"], "agents.csv"), { bundleId: "bundle-id" }, {
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
    await reportPages.agents({
      setId: "11111111-1111-4111-8111-111111111111",
      search: "Agent & one",
      creatorType: "Agent built by your org",
      startDate: "2026-01-01",
      endDate: "2026-09-12",
      sort: "unlicensedUsers",
      order: "asc",
      limit: 100,
      cursor: "agent-next",
    });

    await reportPages.reportedUsers({
      setId: "11111111-1111-4111-8111-111111111111",
      licenseCohort: "active_without_paid",
      search: "User + one",
      company: "Contoso & Co",
      department: "Research + Development",
      cohort: "low",
      lowResponseThreshold: 5,
      startDate: "2026-01-01",
      endDate: "2026-09-12",
      sort: "responses",
      order: "desc",
      limit: 100,
      cursor: "user-next",
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/official-usage/aggregate?setId=11111111-1111-4111-8111-111111111111&search=Agent+%26+one&creatorType=Agent+built+by+your+org&startDate=2026-01-01&endDate=2026-09-12&sort=unlicensedUsers&order=asc&limit=100&cursor=agent-next");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/official-usage/users?setId=11111111-1111-4111-8111-111111111111&licenseCohort=active_without_paid&search=User+%2B+one&company=%7Estring%3AContoso+%26+Co&department=%7Estring%3AResearch+%2B+Development&cohort=low&lowResponseThreshold=5&startDate=2026-01-01&endDate=2026-09-12&sort=responses&order=desc&limit=100&cursor=user-next");
  });

  it("loads paginated cumulative official usage history without changing active selection", async () => {
    const fetchMock = mockJsonResponse({});
    const controller = new AbortController();
    await reportPages.history({ limit: 25, cursor: "history-next" }, controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/official-usage/history?limit=25&cursor=history-next",
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
    await readReportDetail(`official-usage/agents/${encodeURIComponent(agentId)}`, "exact-selection", controller.signal);
    await reportPages.reportedUsers({ agentId, setId }, controller.signal);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/official-usage/agents/Report%2FUpper%25Case%3A1?selectionId=exact-selection");
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
    fetchMock.mockResolvedValueOnce(Response.json({ id: "package-selection" }));
    await getAgents();
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/agents/selections", expect.objectContaining({
      credentials: "include", method: "POST", body: JSON.stringify({ query: {}, mode: "delegated" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/agents?selectionId=package-selection&limit=50",
      expect.objectContaining({ credentials: "include" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("cancels an exact data-sync run through the CSRF-protected endpoint with a cancellable request", async () => {
    const fetchMock = mockJsonResponse({ user: {}, csrfToken: "cancel-csrf", roleAssignmentRequired: false });
    await getCurrentUser();
    fetchMock.mockResolvedValue(Response.json({ id: "job/one", status: "cancelled" }));
    const controller = new AbortController();
    await cancelDataSyncRun("job/one", { signal: controller.signal });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/data-sync/runs/job%2Fone/cancel", expect.objectContaining({
      method: "POST", credentials: "include", signal: controller.signal,
    }));
    expect(new Headers(fetchMock.mock.lastCall?.[1]?.headers).get("X-CSRF-Token")).toBe("cancel-csrf");
  });

  it("cancels an exact Power Platform refresh without acquiring provider authorization", async () => {
    const fetchMock = mockJsonResponse({ user: {}, csrfToken: "cancel-csrf", roleAssignmentRequired: false });
    await getCurrentUser();
    fetchMock.mockResolvedValue(Response.json({ id: "job/one", status: "cancelled" }));
    await cancelInventoryRefresh("job/one");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/inventory/refresh-jobs/job%2Fone/cancel", expect.objectContaining({
      method: "POST", credentials: "include",
    }));
    expect(new Headers(fetchMock.mock.lastCall?.[1]?.headers).get("X-CSRF-Token")).toBe("cancel-csrf");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a stable idempotency key when collecting missing agent identities", async () => {
    const fetchMock = mockJsonResponse({ id: "identity-job", status: "running" });
    await startPackageRefresh("delegated", { idempotencyKey: "agent-identities-snapshot-one" });
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/refresh-jobs", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ mode: "delegated" }),
    }));
    expect(new Headers(fetchMock.mock.lastCall?.[1]?.headers).get("Idempotency-Key")).toBe("agent-identities-snapshot-one");
  });

  it("requests unified saved rows and explicitly refreshes selected matching details", async () => {
    const fetchMock = mockJsonResponse({
      value: [],
      verification: createUnifiedVerification({ graphPackageCount: 0, powerPlatformAgentCount: 0, logicalAgentCount: 0 }, { sourceScopes: false }),
    });
    fetchMock.mockResolvedValueOnce(Response.json({ id: "selected-root" }));
    await getUnifiedAgents({
      view: "third_party",
      endUserAccess: "available",
      reportedUsage: "used",
      management: "organization_managed",
      relevance: "organization",
      search: "Builder & one",
      source: "both",
      linkState: "matched",
      environmentId: "environment/one",
      blocked: true,
      publisher: null,
      availableTo: { kind: "some-or-all" },
      host: "__unknown_host__",
      platform: "Copilot Studio",
      createdWithinDays: 30,
      limit: 50,
    });
    await refreshPackageIdentityDetails({ selectionId: "selected-root", ids: ["package-1", "package-2"] });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/agent-inventory/selections",
      expect.objectContaining({ credentials: "include", method: "POST", body: JSON.stringify({ query: {
        view: "third_party", endUserAccess: "available", reportedUsage: "used", management: "organization_managed",
        relevance: "organization", search: "Builder & one", source: "both", linkState: "matched",
        environmentId: "~string:environment/one", blocked: "true", publisher: "~null", availableTo: "~some-or-all",
        host: "~string:__unknown_host__", platform: "~string:Copilot Studio", createdWithinDays: "30",
      } }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/agent-inventory?selectionId=selected-root&limit=50",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/agents/refresh-selection",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ selectionId: "selected-root", ids: ["package-1", "package-2"] }),
      }),
    );
  });

  it.each(["not_collected", "preparing"])("returns explicit %s inventory availability without reading a nonexistent selection", async state => {
    const unavailable = { state, message: "Inventory is not ready yet." };
    const fetchMock = mockJsonResponse(unavailable);
    await expect(getUnifiedAgents()).resolves.toEqual(unavailable);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/agent-inventory/selections");
  });

  it.each([{ state: "unknown", message: "Invalid" }, { state: "preparing" }])("rejects malformed inventory availability: %j", async response => {
    const fetchMock = mockJsonResponse(response);
    await expect(getUnifiedAgents()).rejects.toMatchObject({ code: "invalid_inventory_availability" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("captures maximum-width Unicode criteria in a body and continues with bounded selection URLs", async () => {
    const publisher = "界".repeat(4096), controller = new AbortController();
    const fetchMock = mockJsonResponse({ value: [] });
    fetchMock.mockResolvedValueOnce(Response.json({ id: "wide-selection" }));
    await getUnifiedAgents({ publisher, inventoryScope: "catalog", limit: 50 }, { signal: controller.signal });
    const [path, capture] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/agent-inventory/selections");
    expect(JSON.parse(String(capture?.body))).toEqual({ query: { publisher: `~string:${publisher}`, inventoryScope: "catalog" } });
    expect(capture?.signal).toBe(controller.signal);
    await getUnifiedAgents({ publisher, inventoryScope: "catalog", selectionId: "wide-selection", cursor: "next" },
      { signal: controller.signal });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      "/api/agent-inventory?selectionId=wide-selection&limit=50",
      "/api/agent-inventory?selectionId=wide-selection&limit=50&cursor=next",
    ]);
    expect(fetchMock.mock.calls.every(([, request]) => request?.signal === controller.signal)).toBe(true);
  });

  it.each(["delegated", "application"] as const)("captures wide %s package criteria without including them in read URLs", async mode => {
    const publisher = "界".repeat(4096), controller = new AbortController();
    const fetchMock = mockJsonResponse({ value: [] });
    fetchMock.mockResolvedValueOnce(Response.json({ id: "package-selection" }));
    await getAgents({ publisher, mode, limit: 25 }, { signal: controller.signal });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/agents/selections", expect.objectContaining({
      method: "POST", body: JSON.stringify({ query: { publisher: `~string:${publisher}` }, mode }), signal: controller.signal,
    }));
    await getAgents({ publisher, mode, selectionId: "package-selection", cursor: "next", limit: 25 }, { signal: controller.signal });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      `/api/agents?selectionId=package-selection&limit=25&mode=${mode}`,
      `/api/agents?selectionId=package-selection&limit=25&mode=${mode}&cursor=next`,
    ]);
    expect(fetchMock.mock.calls.every(([, request]) => request?.signal === controller.signal)).toBe(true);
  });

  it.each([
    { path: "/api/agents/selections", read: () => getAgents() },
    { path: "/api/agent-inventory/selections", read: () => getUnifiedAgents() },
  ])("fences $path when the principal changes between capture and its first selected read", async ({ path, read }) => {
    let replacement: Promise<unknown> | undefined;
    const selection = Object.defineProperty({}, "id", { get() {
      replacement = getCurrentUser();
      return "captured-selection";
    } });
    const response = Response.json({});
    response.json = async () => selection;
    const fetchMock = vi.fn().mockResolvedValueOnce(response)
      .mockResolvedValueOnce(Response.json({ user: { tenantId: "replacement" }, csrfToken: "replacement-csrf" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(read()).rejects.toMatchObject({ code: "request_aborted", kind: "aborted" });
    await replacement;
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([path, "/api/me"]);
  });

  it("stages a server-filtered refresh and separately reauthorizes its start without downloading targets", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({
      id: "selected-refresh", status: "waiting_authorization", tokenMode: "delegated", targetCount: 5000,
    })).mockResolvedValueOnce(Response.json({ id: "selected-refresh", status: "running", tokenMode: "delegated", targetCount: 5000 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    expect(await refreshPackageIdentityDetails({ selectionId: "selected-root" }, { signal: controller.signal }))
      .toMatchObject({ status: "running", targetCount: 5000 });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/agents/refresh-selection",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ selectionId: "selected-root" }), signal: controller.signal }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/agents/refresh-jobs/selected-refresh/resume",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "delegated" }), signal: controller.signal }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["waiting_authorization", "running"] as const)(
    "fences a %s refresh if the session changes after staging completes",
    async status => {
      let replacement: Promise<unknown> | undefined;
      const response = Response.json({});
      response.json = async () => {
        // Change sessions after the transport's body check, before the wrapper resumes.
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
          replacement = getCurrentUser();
        })));
        return { id: "selected-refresh", status, tokenMode: "delegated", targetCount: 2 };
      };
      const fetchMock = vi.fn().mockResolvedValueOnce(response)
        .mockResolvedValueOnce(Response.json({ csrfToken: "replacement-csrf" }))
        .mockResolvedValueOnce(Response.json({ id: "selected-refresh", status: "running" }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(refreshPackageIdentityDetails({ selectionId: "selected-root" })).rejects.toMatchObject({
        code: "request_aborted", kind: "aborted",
      });
      await replacement;
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/agents/refresh-selection", "/api/me"]);
    },
  );

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
    const fetchMock = mockJsonResponse(record);
    const controller = new AbortController();
    for (const recordId of [record.id, "graph_packages:package%2Fa", "power_platform:environment-a:native%2Fa"]) {
      const response = await getUnifiedAgentDetail("selected-root", recordId, { signal: controller.signal });
      expect(response).toEqual(record);
      expect(fetchMock).toHaveBeenLastCalledWith(
        `/api/agent-inventory/${encodeURIComponent(recordId)}/detail?selectionId=selected-root`,
        expect.objectContaining({ signal: controller.signal, credentials: "include" }),
      );
    }
  });

  it("creates selected unified exports with cookies and the current CSRF token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ user: { roles: ["AgentControl.Viewer"] }, csrfToken: "csv-csrf" }))
      .mockResolvedValueOnce(Response.json({ id: "selected-export" }));
    vi.stubGlobal("fetch", fetchMock);
    await getCurrentUser();
    const input = { kind: "unified_agents" as const, selectionId: "saved-selection", idempotencyKey: crypto.randomUUID() };
    expect(await createReportExport(input)).toEqual({ id: "selected-export" });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/data-exports", expect.objectContaining({
      method: "POST", credentials: "include",
      body: JSON.stringify(input),
    }));
    const headers = new Headers(fetchMock.mock.lastCall?.[1]?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-CSRF-Token")).toBe("csv-csrf");
  });

  it("preserves exact selected references and reports invalidation without a source-export fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      code: "agent_inventory_changed", detail: "Saved source revision or selected references changed.",
    }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      kind: "unified_agents" as const, selectionId: "saved-selection",
      ids: ["agent:11111111-1111-4111-8111-111111111111", "graph_packages:opaque%2Fid"],
      idempotencyKey: crypto.randomUUID(),
    };
    await expect(createReportExport(input)).rejects.toMatchObject({ status: 409, code: "agent_inventory_changed" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/data-exports", expect.objectContaining({
      method: "POST", body: JSON.stringify(input),
    }));
  });

  it("preserves separate opaque package targets in detail reads, exact refreshes and mutation previews", async () => {
    const fetchMock = mockJsonResponse({});
    for (const id of ["opaque/legacy%target", "opaque:anchor/target"]) {
      await getAgentDetails("selected-root", id);
      expect(fetchMock).toHaveBeenLastCalledWith(`/api/agents/${encodeURIComponent(id)}/detail?selectionId=selected-root`,
        expect.objectContaining({ credentials: "include" }));
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

  it("encodes exact user scope and paging for Purview history without losing cancellation", async () => {
    const fetchMock = mockJsonResponse({});
    const controller = new AbortController();
    await getPurviewAuditJobs(20, 40, { signal: controller.signal, userPrincipalName: "employee+test@example.invalid" });
    expect(fetchMock).toHaveBeenCalledWith("/api/audit-search/jobs?limit=20&offset=40&userPrincipalName=employee%2Btest%40example.invalid",
      expect.objectContaining({ signal: controller.signal }));
  });

  it("passes cancellation through all saved audit and hunting reads", async () => {
    const fetchMock = mockJsonResponse({});
    const controller = new AbortController();
    await getAuditEvents({ action: "block", limit: 100, offset: 200 }, { signal: controller.signal });
    await getPurviewAuditCatalog({ signal: controller.signal });
    await getPurviewAuditJobs(20, 40, { signal: controller.signal });
    await getPurviewAuditRecords("audit/job", 100, 300, { signal: controller.signal });
    await getDefenderHuntingCatalog({ signal: controller.signal });
    await getDefenderHuntingJobs(20, 60, { signal: controller.signal });
    await getDefenderHuntingRows("hunt/job", 100, 400, { signal: controller.signal });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/audit/events?limit=100&offset=200&action=block",
      "/api/audit-search/catalog",
      "/api/audit-search/jobs?limit=20&offset=40",
      "/api/audit-search/jobs/audit%2Fjob/records?limit=100&offset=300",
      "/api/hunting/catalog",
      "/api/hunting/jobs?limit=20&offset=60",
      "/api/hunting/jobs/hunt%2Fjob/rows?limit=100&offset=400",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(expect.objectContaining({ signal: controller.signal }));
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
    await getQuarantineStatus("snapshot/id", "native id", true);
    await previewQuarantine({ action: "quarantine", snapshotId: "snapshot-a", resourceNativeIds: ["native-a"] });
    await submitQuarantine({ action: "quarantine", snapshotId: "snapshot-a", resourceNativeIds: ["native-a"], confirmationHash: "c".repeat(64) }, "stable-write-key");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/quarantine/status?snapshotId=snapshot%2Fid&nativeId=native+id&force=true", expect.objectContaining({ credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/quarantine/preview", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "quarantine", snapshotId: "snapshot-a", resourceNativeIds: ["native-a"] }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/quarantine/jobs", expect.objectContaining({ method: "POST" }));
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("Idempotency-Key")).toBe("stable-write-key");
  });

  it.each(["status", "preview"] as const)("cancels an explicitly admitted quarantine %s read without changing its target", async kind => {
    const pending = deferredResponse();
    const fetchMock = mockJsonResponse({});
    fetchMock.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const intent = { action: "quarantine" as const, snapshotId: "snapshot-a", resourceNativeIds: ["native-a"] };
    const read = kind === "status"
      ? getQuarantineStatus("snapshot-a", "native-a", true, { signal: controller.signal })
      : previewQuarantine(intent, { signal: controller.signal });
    const cancelled = expect(read).rejects.toMatchObject({ code: "request_aborted", kind: "aborted" });
    controller.abort();
    pending.resolve(Response.json({}));
    await cancelled;
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      kind === "status" ? "/api/quarantine/status?snapshotId=snapshot-a&nativeId=native-a&force=true" : "/api/quarantine/preview",
      expect.objectContaining({
        signal: controller.signal, credentials: "include",
        ...(kind === "preview" ? { method: "POST", body: JSON.stringify(intent) } : {}),
      }),
    );
  });
});

describe("investigation request cancellation", () => {
  const id = "job/one";
  const auditFilters: PurviewAuditFilters = {
    presetId: "copilot_interactions", startDateTime: "2026-09-20T00:00:00Z", endDateTime: "2026-09-20T01:00:00Z",
    operations: [], userPrincipalNames: [], ipAddresses: [], objectIds: [], administrativeUnitIds: [],
  };
  const huntingFilters: DefenderHuntingFilters = {
    templateId: "agents_inventory", startDateTime: "2026-09-20T00:00:00Z", endDateTime: "2026-09-20T01:00:00Z",
    agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [],
  };
  const auditBody = JSON.stringify({ tokenMode: "delegated", filters: auditFilters });
  const huntingBody = JSON.stringify({ tokenMode: "application", filters: huntingFilters });
  const confirmationBody = JSON.stringify({ confirmation: id });
  const requests: Array<{
    name: string; path: string; method?: "POST" | "DELETE"; body?: string;
    send: (options?: { signal?: AbortSignal; agentRecordId?: string }) => Promise<unknown>;
  }> = [
    { name: "Agent identity resolution", path: "/api/agent-inventory/investigations/resolve", method: "POST", body: JSON.stringify({ recordId: "power_platform:env/one:agent%one" }), send: options => resolveAgentInvestigationIdentity("power_platform:env/one:agent%one", options) },
    { name: "Purview submit", path: "/api/audit-search/jobs", method: "POST", body: auditBody, send: options => submitPurviewAuditSearch("delegated", auditFilters, options) },
    { name: "Purview resume", path: "/api/audit-search/jobs/job%2Fone/resume", method: "POST", send: options => resumePurviewAuditSearch(id, options) },
    { name: "Purview cancel", path: "/api/audit-search/jobs/job%2Fone/cancel", method: "POST", send: options => cancelPurviewAuditSearch(id, options) },
    { name: "Purview delete", path: "/api/audit-search/jobs/job%2Fone", method: "DELETE", body: confirmationBody, send: options => deletePurviewAuditSearch(id, options) },
    { name: "Purview qualification approval", path: "/api/audit-search/qualifications", method: "POST", body: auditBody, send: options => approvePurviewAuditQualification("delegated", auditFilters, options) },
    { name: "Purview qualification start", path: "/api/audit-search/qualifications/job%2Fone/start", method: "POST", send: options => startPurviewAuditQualification(id, options) },
    { name: "Purview CSV", path: "/api/audit-search/jobs/job%2Fone/export.csv", send: options => downloadPurviewAuditCsv(id, options) },
    { name: "Defender submit", path: "/api/hunting/jobs", method: "POST", body: huntingBody, send: options => submitDefenderHunt("application", huntingFilters, options) },
    { name: "Defender resume", path: "/api/hunting/jobs/job%2Fone/resume", method: "POST", send: options => resumeDefenderHunt(id, options) },
    { name: "Defender cancel", path: "/api/hunting/jobs/job%2Fone/cancel", method: "POST", send: options => cancelDefenderHunt(id, options) },
    { name: "Defender delete", path: "/api/hunting/jobs/job%2Fone", method: "DELETE", body: confirmationBody, send: options => deleteDefenderHunt(id, options) },
    { name: "Defender qualification approval", path: "/api/hunting/qualifications", method: "POST", body: huntingBody, send: options => approveDefenderHuntingQualification("application", huntingFilters, options) },
    { name: "Defender qualification start", path: "/api/hunting/qualifications/job%2Fone/start", method: "POST", send: options => startDefenderHuntingQualification(id, options) },
    { name: "Defender scope revocation", path: "/api/hunting/retained-scopes/job%2Fone/revoke", method: "POST", body: confirmationBody, send: options => revokeDefenderHuntingRetainedScope(id, options) },
    { name: "Defender CSV", path: "/api/hunting/jobs/job%2Fone/export.csv", send: options => downloadDefenderHuntingCsv(id, options) },
  ];

  it("protects explicit identity resolution with CSRF and sends only the saved agent reference", async () => {
    const fetchMock = mockJsonResponse({ user: {}, csrfToken: "identity-csrf", roleAssignmentRequired: false });
    await getCurrentUser();
    fetchMock.mockResolvedValue(Response.json({}));
    await resolveAgentInvestigationIdentity("power_platform:env/one:agent%one");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/agent-inventory/investigations/resolve", expect.objectContaining({
      method: "POST", body: JSON.stringify({ recordId: "power_platform:env/one:agent%one" }),
      credentials: "include",
    }));
    const headers = new Headers(fetchMock.mock.lastCall?.[1]?.headers);
    expect(headers.get("X-CSRF-Token")).toBe("identity-csrf");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  describe.each(requests)("$name", ({ path, method, body, send }) => {
    it.each([false, true])("preserves exact request intent with cancellation supplied: %s", async cancellable => {
      const fetchMock = mockJsonResponse({});
      const controller = new AbortController();
      await send(cancellable ? { signal: controller.signal } : undefined);
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(path, expect.objectContaining({
        credentials: "include",
      }));
      const init = fetchMock.mock.calls[0][1];
      expect(init.signal).toBe(cancellable ? controller.signal : undefined);
      expect(init.method ?? "GET").toBe(method ?? "GET");
      expect(init.body).toBe(body);
    });

    it.each(requests.filter(item => item.name.startsWith("Defender")))("binds $name to the exact selected agent on every lifecycle request", async ({ path, send }) => {
      const fetchMock = mockJsonResponse({});
      const agentRecordId = "power_platform:env/id:opaque%agent";
      await send({ agentRecordId });
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${path}?${new URLSearchParams({ agentRecordId })}`,
        expect.objectContaining({ credentials: "include" }));
    });

    it("sends only investigation choices, never client-supplied identities, for an agent-scoped hunt or approval", async () => {
      const fetchMock = mockJsonResponse({});
      const choices = { ...huntingFilters, agentIds: ["untrusted-agent"], entraAgentIds: ["untrusted-object"],
        entraAgentApplicationIds: ["untrusted-application"], blueprintIds: ["untrusted-blueprint"], actorObjectIds: ["untrusted-actor"] };
      await submitDefenderHunt("delegated", choices, { agentRecordId: "graph_packages:agent" });
      await approveDefenderHuntingQualification("application", choices, { agentRecordId: "graph_packages:agent" });
      for (const [, init] of fetchMock.mock.calls) {
        expect(JSON.parse(init.body as string).filters).toEqual({
          templateId: choices.templateId, startDateTime: choices.startDateTime, endDateTime: choices.endDateTime, operations: choices.operations,
        });
      }
    });

    it("binds saved context, history, details, rows and Purview paging to their agent", async () => {
      const fetchMock = mockJsonResponse({});
      const recordId = "power_platform:env/id:opaque%agent";
      const options = { agentRecordId: recordId };
      const agentQuery = new URLSearchParams({ agentRecordId: recordId }).toString();
      await getDefenderHuntingCatalog(options);
      await getDefenderHuntingJobs(20, 40, options);
      await getDefenderHuntingJob("job/one", options);
      await getDefenderHuntingRows("job/one", 100, 100, options);
      await getAgentInvestigationContext(recordId);
      await getAgentPurviewRecords(recordId, { limit: 50, offset: 50, search: "actor+correlation", operation: "InvokeAgent" });
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `/api/hunting/catalog?${agentQuery}`,
        `/api/hunting/jobs?limit=20&offset=40&${agentQuery}`,
        `/api/hunting/jobs/job%2Fone?${agentQuery}`,
        `/api/hunting/jobs/job%2Fone/rows?limit=100&offset=100&${agentQuery}`,
        `/api/agent-inventory/investigations/context?${new URLSearchParams({ recordId })}`,
        `/api/agent-inventory/investigations/purview?${new URLSearchParams({ recordId, limit: "50", offset: "50", search: "actor+correlation", operation: "InvokeAgent" })}`,
      ]);
    });

    it("rejects an aborted response even when the transport completes late", async () => {
      const pending = deferredResponse();
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
      const controller = new AbortController();
      const result = send({ signal: controller.signal });
      const cancelled = expect(result).rejects.toMatchObject({ code: "request_aborted", kind: "aborted" });
      controller.abort();
      pending.resolve(Response.json({}));
      await cancelled;
    });
  });

  it.each(["capability_unavailable", "hunting_scope_unqualified", "not_configured"])(
    "keeps explicit provider failure %s separate from session invalidation",
    async code => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code }, { status: 403 })));
      const listener = vi.fn();
      const unsubscribe = subscribeSessionRevalidationRequired(listener);
      try {
        await expect(submitDefenderHunt("application", huntingFilters)).rejects.toMatchObject({ status: 403, code });
        expect(listener).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    },
  );
});

describe("API response failures", () => {
  describe.each(["JSON", "CSV"] as const)("logout completion ownership (%s)", format => {
    const csv = "saved,private,csv";
    const response = () => format === "JSON" ? Response.json({ value: [] }) : new Response(csv);
    const send = () => format === "JSON" ? getAgents({ selectionId: "transport-selection" }) : downloadPurviewAuditCsv("saved-job");
    const expected = format === "JSON" ? { value: [] } : { size: csv.length };

    it.each((["before", "during"] as const).flatMap(timing =>
      (["fetch", "body"] as const).map(phase => ({ timing, phase })),
    ))("fences a $timing-logout read waiting for $phase after logout succeeds", async ({ timing, phase }) => {
      const fetchMock = mockJsonResponse({ csrfToken: "logout-session-csrf" });
      await getCurrentUser();
      const logoutResponse = deferredResponse();
      const readResponse = deferredResponse();
      const earlyResponse = response();
      const body = vi.spyOn(earlyResponse, format === "JSON" ? "json" : "blob")
        .mockImplementation(() => readResponse.promise.then(value => format === "JSON" ? value.json() : value.blob()));
      const startRead = () => {
        if (phase === "fetch") fetchMock.mockReturnValueOnce(readResponse.promise);
        else fetchMock.mockResolvedValueOnce(earlyResponse);
        return send();
      };
      const earlierRead = timing === "before" ? startRead() : undefined;
      fetchMock.mockReturnValueOnce(logoutResponse.promise);
      const logout = signOut();
      const read = earlierRead ?? startRead();
      const cancelled = expect(read).rejects.toMatchObject({ status: 0, code: "request_aborted", kind: "aborted" });
      if (phase === "body") await vi.waitFor(() => expect(body).toHaveBeenCalledOnce());
      logoutResponse.resolve(new Response(null, { status: 204 }));
      await logout;
      readResponse.resolve(response());
      await cancelled;
      await checkCapabilities();
      expect(new Headers(fetchMock.mock.lastCall?.[1]?.headers).has("X-CSRF-Token")).toBe(false);
    });

    it.each([
      { status: 503, code: "service_unavailable" },
      { status: 403, code: "invalid_origin" },
    ].flatMap(failure => (["before", "during"] as const).map(timing => ({ ...failure, timing }))))("preserves $timing-logout reads and CSRF after logout fails with $code", async ({ status, code, timing }) => {
      const fetchMock = mockJsonResponse({ csrfToken: "retained-session-csrf" });
      await getCurrentUser();
      const logoutResponse = deferredResponse();
      const readResponse = deferredResponse();
      const startRead = () => {
        fetchMock.mockReturnValueOnce(readResponse.promise);
        return send();
      };
      const earlierRead = timing === "before" ? startRead() : undefined;
      fetchMock.mockReturnValueOnce(logoutResponse.promise);
      const failure = expect(signOut()).rejects.toMatchObject({ status, code });
      const read = earlierRead ?? startRead();
      const completedRead = expect(read).resolves.toMatchObject(expected);
      logoutResponse.resolve(Response.json({ code }, { status }));
      await failure;
      readResponse.resolve(response());
      await completedRead;
      await checkCapabilities();
      expect(new Headers(fetchMock.mock.lastCall?.[1]?.headers).get("X-CSRF-Token")).toBe("retained-session-csrf");
    });

    it("does not retire a newer session validation when the older logout finishes", async () => {
      const fetchMock = mockJsonResponse({ csrfToken: "original-session-csrf" });
      await getCurrentUser();
      const logoutResponse = deferredResponse();
      fetchMock.mockReturnValueOnce(logoutResponse.promise);
      const staleLogout = expect(signOut()).rejects.toMatchObject({ code: "request_aborted", kind: "aborted" });
      const sessionResponse = deferredResponse();
      fetchMock.mockReturnValueOnce(sessionResponse.promise);
      const session = getCurrentUser();
      const readResponse = deferredResponse();
      fetchMock.mockReturnValueOnce(readResponse.promise);
      const read = send();
      logoutResponse.resolve(new Response(null, { status: 204 }));
      await staleLogout;
      sessionResponse.resolve(Response.json({ csrfToken: "newer-session-csrf" }));
      await expect(session).resolves.toMatchObject({ csrfToken: "newer-session-csrf" });
      readResponse.resolve(response());
      await expect(read).resolves.toMatchObject(expected);
      await checkCapabilities();
      expect(new Headers(fetchMock.mock.lastCall?.[1]?.headers).get("X-CSRF-Token")).toBe("newer-session-csrf");
    });
  });

  it("forwards session-read cancellation and never installs a cancelled CSRF token", async () => {
    const pending = deferredResponse();
    const fetchMock = mockJsonResponse({});
    fetchMock.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const result = getCurrentUser({ signal: controller.signal });
    const cancelled = expect(result).rejects.toMatchObject({ code: "request_aborted", kind: "aborted" });
    expect(fetchMock).toHaveBeenCalledWith("/api/me", expect.objectContaining({ signal: controller.signal }));
    controller.abort();
    pending.resolve(Response.json({ csrfToken: "cancelled-session-csrf" }));
    await cancelled;
    await checkCapabilities();
    expect(new Headers(fetchMock.mock.lastCall?.[1]?.headers).has("X-CSRF-Token")).toBe(false);
  });

  it.each(["JSON", "CSV"] as const)("rejects a late %s success from a denied session", async format => {
    const pending = deferredResponse();
    const fetchMock = mockJsonResponse({});
    fetchMock.mockReturnValueOnce(pending.promise);
    const result = format === "JSON" ? getAgents() : downloadPurviewAuditCsv("saved-job");
    const cancelled = expect(result).rejects.toMatchObject({ code: "request_aborted", kind: "aborted" });
    fetchMock.mockResolvedValueOnce(Response.json({ code: "unauthorized" }, { status: 401 }));
    await expect(getAgents()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    pending.resolve(format === "JSON" ? Response.json({ value: ["private"] }) : new Response("private,csv"));
    await cancelled;
  });

  it("does not revalidate a replacement session for a cancelled request's late denial", async () => {
    const pending = deferredResponse();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
    const listener = vi.fn();
    const unsubscribe = subscribeSessionRevalidationRequired(listener);
    const controller = new AbortController();
    try {
      const result = getAgents({}, { signal: controller.signal });
      const cancelled = expect(result).rejects.toMatchObject({ code: "request_aborted" });
      controller.abort();
      pending.resolve(Response.json({ code: "missing_internal_role" }, { status: 403 }));
      await cancelled;
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it.each([401, 403])("revalidates a %s denial whose problem body is unavailable", async status => {
    const response = Response.json({}, { status });
    vi.spyOn(response, "json").mockRejectedValue(new TypeError("Connection interrupted"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const listener = vi.fn();
    const unsubscribe = subscribeSessionRevalidationRequired(listener);
    try {
      await expect(getAgents()).rejects.toMatchObject({ status, code: "request_failed" });
      expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status, code: "request_failed" }));
    } finally {
      unsubscribe();
    }
  });

  it("preserves the denial when a session owner cancels protected reads during notification", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "unauthorized" }, { status: 401 })));
    const controller = new AbortController();
    const unsubscribe = subscribeSessionRevalidationRequired(() => controller.abort());
    try {
      await expect(getAgents({}, { signal: controller.signal })).rejects.toMatchObject({
        status: 401, code: "unauthorized", kind: "problem",
      });
      expect(controller.signal.aborted).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it.each(["new session", "sign-out"] as const)("does not install an old session after %s completes", async boundary => {
    const pending = deferredResponse();
    const fetchMock = mockJsonResponse({ csrfToken: "current-session-csrf" });
    fetchMock.mockReturnValueOnce(pending.promise);
    const previous = getCurrentUser();
    const cancelled = expect(previous).rejects.toMatchObject({ code: "request_aborted" });
    if (boundary === "new session") await getCurrentUser();
    else {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await signOut();
    }
    pending.resolve(Response.json({ csrfToken: "old-session-csrf" }));
    await cancelled;
    await checkCapabilities();
    if (boundary === "new session") {
      expect(new Headers(fetchMock.mock.lastCall?.[1]?.headers).get("X-CSRF-Token")).toBe("current-session-csrf");
    } else {
      expect(new Headers(fetchMock.mock.lastCall?.[1]?.headers).has("X-CSRF-Token")).toBe(false);
    }
  });

  const requests = [
    { name: "JSON", send: () => getAgents(), body: "json" },
    { name: "inventory export metadata", send: () => createReportExport({ kind: "unified_agents", selectionId: "saved-selection" }), body: "json" },
    { name: "Purview CSV", send: () => downloadPurviewAuditCsv("job/one"), body: "blob" },
    { name: "Defender CSV", send: () => downloadDefenderHuntingCsv("job/one"), body: "blob" },
    { name: "official export metadata", send: () => reportExportStatus("export-id"), body: "json" },
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
      vi.useFakeTimers();
      const cause = new TypeError("Connection interrupted");
      const response = Response.json({});
      if (phase === "body") vi.spyOn(response, body).mockRejectedValue(cause);
      vi.stubGlobal("fetch", phase === "fetch" ? vi.fn().mockRejectedValue(cause) : vi.fn().mockResolvedValue(response));

      try {
        const result = send();
        const rejected = Promise.all([
          expect(result).rejects.toBeInstanceOf(ApiError),
          expect(result).rejects.toMatchObject({ status: 0, code: "network_error", kind: "network" }),
        ]);
        await vi.advanceTimersByTimeAsync(6000);
        await rejected;
      } finally { vi.useRealTimers(); }
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
    { name: "inventory export metadata", send: (signal: AbortSignal) => createReportExport({ kind: "unified_agents", selectionId: "saved-selection" }, signal), body: "json" },
    { name: "official export metadata", send: (signal: AbortSignal) => reportExportStatus("export-id", signal), body: "json" },
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
      await expect(createReportExport({ kind: "unified_agents", selectionId: "saved-selection" })).rejects.toMatchObject({ status: 401, code: "session_invalidated" });
      expect(listener).toHaveBeenCalledOnce();
      await checkCapabilities();
      expect(new Headers(fetchMock.mock.lastCall?.[1]?.headers).has("X-CSRF-Token")).toBe(false);
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
    expect(new Headers(fetchMock.mock.lastCall?.[1]?.headers).has("X-CSRF-Token")).toBe(false);
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

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(complete => { resolve = complete; });
  return { promise, resolve };
}
