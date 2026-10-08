import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { generationInput } from "../../scripts/largeTenantFixtures.js";
import { DataSyncRepository, requireUserPublication } from "../db/dataSync.js";
import { transaction } from "../db/pool.js";
import { UserSourceStages } from "../db/userSourceStages.js";
import { UserSourcesRepository } from "../db/userSources.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { DataGenerations } from "../db/dataGenerations.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { AppError } from "../errors.js";
import { CopilotUsageService } from "./copilotUsage.js";
import { UserSourceProvider } from "./userSourceProvider.js";
import { reportHeaders } from "./userSourceGraphFields.js";
import { schemaRegistry } from "./officialReportFields.js";
import { reportIdentity } from "./reportIdentity.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { UserSourceKind } from "../types/userSources.js";
import type { CapabilityId } from "../types/capability.js";
import type { FetchLike } from "./graphPackages.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{
    tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
    clientSecret: "synthetic-orchestrator-secret", domains: ["example.invalid"],
  }]);
  process.env.SESSION_SECRET = "orchestrator-synthetic-session-secret";
});
const objectId = "30000000-0000-4000-8000-000000000003";
const skuId = "40000000-0000-4000-8000-000000000004";
const planId = "a62f8878-de10-42f3-b68f-6149a25ceb97";
const date = new Date().toISOString().slice(0, 10);
function graphUser() {
  return { id: objectId, userPrincipalName: "person@example.invalid", displayName: "Person", companyName: "Contoso",
    department: "Engineering", accountEnabled: false, assignedLicenses: [{ skuId, disabledPlans: [] }],
    assignedPlans: [{ servicePlanId: planId, service: "Copilot", capabilityStatus: "Enabled", assignedDateTime: null }] };
}
function activity() {
  return new Response(`${reportHeaders.join(",")}\n${[date, "person@example.invalid", "Person", date, "", "", "", "", "", "", "", "", "28"].join(",")}\n`);
}

describe("live Users orchestration and publication boundary", () => {
  it("exposes source refresh, not the retired tenant-wide user and report getters", () => {
    expect(Object.getOwnPropertyNames(CopilotUsageService.prototype).sort()).toEqual(["constructor", "refreshUsers"]);
  });
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30000);
  afterAll(async () => { await fixture?.close(); });
  afterEach(() => vi.restoreAllMocks());
  async function harness() {
    const user: AuthenticatedUser = { tenantId: randomUUID(), homeAccountId: randomUUID(),
      username: "viewer@example.invalid", displayName: "Viewer", roles: ["AgentControl.Viewer"] };
    const identity = await reportIdentity(fixture.runtime, user), repository = new DataSyncRepository(fixture.runtime);
    const { run } = await repository.submit(identity, { mode: "full", sources: ["users"] }), jobId = randomUUID();
    const publication = { runId: run.id, jobId };
    await repository.attachJob(identity, run.id, "users", jobId);
    await repository.updateSource(identity, run.id, "users", { status: "running", jobId, count: null, message: "Collecting", canRetry: false });
    const fetcher = vi.fn<FetchLike>(async url => String(url).includes("subscribedSkus")
      ? Response.json({ value: [{ skuId, appliesTo: "User", servicePlans: [{ servicePlanId: planId }] }] })
      : String(url).includes("/users?") ? Response.json({ value: [graphUser()], "@odata.count": 1 }) : activity());
    const provider = new UserSourceProvider(fetcher);
    const revalidateUser = vi.fn(async () => user), delegatedToken = vi.fn(async () => "synthetic-token");
    const requireAvailable = vi.fn<(capability: CapabilityId, user: AuthenticatedUser) => Promise<unknown>>(async () => {}), admissions = vi.fn(() => {});
    const service = new CopilotUsageService(fixture.runtime, { provider, revalidateUser, delegatedToken, requireAvailable, admissions,
      observeOperation: async (_capability, _user, operation) => operation(() => {}) });
    const sources = new UserSourcesRepository(fixture.runtime, "synthetic-source-secret-never-production");
    const status = () => sources.refreshStatus(identity, "delegated");
    const seed = (source: UserSourceKind, observedAt = new Date(), expiresAt?: Date) => provider.refresh(new UserSourceStages(fixture.runtime), generationInput({
      scope: { kind: "principal", tenantId: identity.tenantId, principalId: identity.principalId, tokenMode: "delegated", source, selector: "complete" },
      sessionEpoch: identity.sessionEpoch, observedAt, ...(expiresAt ? { expiresAt } : {}),
    }), { authorize: async () => "synthetic-token" });
    return { service, user, identity, repository, publication, fetcher, provider, revalidateUser, delegatedToken, requireAvailable, admissions, sources, status, seed };
  }
  it("publishes both real sources but leaves the shared Users job running for the orchestrator's people phase", async () => {
    const h = await harness(), progress = vi.fn(async () => {});
    expect(await h.service.refreshUsers(h.user, undefined, { publication: h.publication, onDirectoryProgress: progress }))
      .toMatchObject({ status: "succeeded", count: 1 });
    expect(await h.status()).toMatchObject({ sources: { directory: { state: "available", rowCount: 1 }, app_activity: { state: "available", rowCount: 1 } } });
    expect((await h.repository.getRun(h.identity, h.publication.runId))?.sources[0]).toMatchObject({ status: "running", count: 1, jobId: h.publication.jobId });
    expect(progress).toHaveBeenCalledWith(1);
    expect(h.revalidateUser).toHaveBeenCalledTimes(4);
    expect(h.delegatedToken).toHaveBeenCalledTimes(4);
    const selected = await h.sources.capture(h.identity, "delegated");
    const people = await h.sources.people(selected.id, h.identity, [objectId]);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ objectId, displayName: "Person", userPrincipalName: "person@example.invalid" });
  });
  it("does not let report-identity capture failure prevent independent app collection or finish its shared job", async () => {
    const h = await harness(), pending = Promise.withResolvers<void>();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = vi.spyOn(LargeTenantUsersReports.prototype, "captureReportIdentities").mockRejectedValueOnce(new Error("Identity read unavailable"));
    h.fetcher.mockImplementation(async url => {
      if (String(url).includes("getMicrosoft365CopilotUsageUserDetail")) { await pending.promise; return activity(); }
      throw new Error("Failed directory source must not reach Graph");
    });

    let settled = false;
    const refresh = h.service.refreshUsers(h.user, undefined, { publication: h.publication }).finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      expect((await h.repository.getRun(h.identity, h.publication.runId))?.sources[0].status).toBe("running");
    } finally { pending.resolve(); }
    expect(await refresh).toMatchObject({ status: "partial" });
    expect(warnings.mock.calls.map(([value]) => JSON.parse(String(value)))).toContainEqual(expect.objectContaining({
      event: "user_source_refresh_failed", source: "directory", errorKind: "unexpected",
    }));
    expect(await h.status()).toMatchObject({ sources: { directory: { attemptStatus: "failed", generationId: null },
      app_activity: { generationId: expect.any(String), attemptStatus: "available", state: "partial", rowCount: 1 } } });
  });
  it("reports the signed-download HTTP failure without losing directory success or exposing internal names and secrets", async () => {
    const h = await harness();
    const original = h.fetcher.getMockImplementation()!;
    h.fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes("getMicrosoft365CopilotUsageUserDetail")) {
        throw new AppError(502, "report_download_failed", "private signed URL and response", { httpStatus: 404 });
      }
      return original(url, init);
    });
    const result = await h.service.refreshUsers(h.user, undefined, { publication: h.publication });
    expect(result).toMatchObject({ status: "partial", count: 1 });
    expect(result.message).toContain("HTTP 404");
    expect(result.message).toContain("Office app activity");
    expect(result.message).toContain("Retry Users sync");
    expect(result.message).not.toMatch(/app_activity|private signed/);
    expect(await h.status()).toMatchObject({ sources: {
      directory: { attemptStatus: "available", rowCount: 1 },
      app_activity: { attemptStatus: "failed", errorCode: "report_download_failed", message: expect.stringContaining("HTTP 404") },
    } });
  });
  it.each(["directory", "app_activity"] as const)("keeps source-independent completion while %s is still collecting", async blocked => {
    const h = await harness(), pending = Promise.withResolvers<void>(), original = h.fetcher.getMockImplementation()!;
    h.fetcher.mockImplementation(async (url, init) => {
      const source = String(url).includes("getMicrosoft365CopilotUsageUserDetail") ? "app_activity" : "directory";
      if (source === blocked) await pending.promise;
      return original(url, init);
    });
    let settled = false;
    const refresh = h.service.refreshUsers(h.user, undefined, { publication: h.publication }).finally(() => { settled = true; });
    try {
      const other = blocked === "directory" ? "app_activity" : "directory";
      await vi.waitFor(async () => expect((await h.status()).sources[other].attemptStatus).toBe("available"));
      expect(settled).toBe(false);
      expect((await h.repository.getRun(h.identity, h.publication.runId))?.sources[0].status).toBe("running");
    } finally { pending.resolve(); }
    expect(await refresh).toMatchObject({ status: "succeeded" });
  });
  it.each(["directory", "app_activity"] as const)("retains a good %s head after denied refresh and records a new partial attempt", async denied => {
    const h = await harness();
    await h.service.refreshUsers(h.user, undefined, { publication: h.publication });
    const previous = (await h.status()).sources[denied].generationId;
    h.requireAvailable.mockImplementation(async capability => {
      if (capability === (denied === "directory" ? "graph.licenses.read" : "reports.copilotUsage.read")) {
        throw new AppError(403, "permission_required", "Permission required.");
      }
    });
    const result = await h.service.refreshUsers(h.user, undefined, { publication: h.publication });
    expect(result.status).toBe("partial");
    expect((await h.status()).sources[denied]).toMatchObject({ generationId: previous, state: "partial", attemptStatus: "permission_required" });
  });
  it("honors independent automatic TTLs without external calls for fresh sources", async () => {
    const h = await harness();
    await h.seed("directory", new Date(Date.now() - 16 * 60000));
    await h.seed("app_activity", new Date(Date.now() - 5 * 3600000));
    h.fetcher.mockClear();
    expect(await h.service.refreshUsers(h.user, undefined, { publication: h.publication, automatic: true })).toMatchObject({ status: "succeeded" });
    expect(h.fetcher.mock.calls.every(([url]) => !String(url).includes("getMicrosoft365CopilotUsageUserDetail"))).toBe(true);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    h.fetcher.mockClear();
    await h.service.refreshUsers(h.user, undefined, { publication: h.publication, automatic: true });
    expect(h.fetcher).not.toHaveBeenCalled();
    await h.seed("app_activity", new Date(Date.now() - 7 * 3600000)); h.fetcher.mockClear();
    await h.service.refreshUsers(h.user, undefined, { publication: h.publication, automatic: true });
    expect(h.fetcher).toHaveBeenCalledOnce();
    expect(String(h.fetcher.mock.calls[0][0])).toContain("getMicrosoft365CopilotUsageUserDetail");
  });
  it("backs off failed automatic attempts but never reports false success", async () => {
    const h = await harness();
    h.requireAvailable.mockImplementation(async capability => { if (capability === "reports.copilotUsage.read") throw new AppError(403, "permission_required", "Denied"); });
    expect(await h.service.refreshUsers(h.user, undefined, { publication: h.publication, automatic: true })).toMatchObject({ status: "partial" });
    h.fetcher.mockClear(); h.requireAvailable.mockClear();
    expect(await h.service.refreshUsers(h.user, undefined, { publication: h.publication, automatic: true })).toMatchObject({ status: "partial" });
    expect(h.fetcher).not.toHaveBeenCalled(); expect(h.requireAvailable).not.toHaveBeenCalled();
  });
  it("blocks restored provider-disabled collection before any token or provider call", async () => {
    const h = await harness();
    h.admissions.mockImplementation(() => { throw new AppError(503, "provider_admissions_disabled", "Disabled after restore"); });
    await expect(h.service.refreshUsers(h.user, undefined, { publication: h.publication })).rejects.toMatchObject({ code: "provider_admissions_disabled" });
    expect(h.delegatedToken).not.toHaveBeenCalled(); expect(h.fetcher).not.toHaveBeenCalled();
  });
  it.each(["directory", "app_activity"] as const)("transactionally rejects %s publication after job cancellation", async cancelled => {
    const h = await harness(), original = h.fetcher.getMockImplementation()!;
    await h.seed(cancelled === "directory" ? "app_activity" : "directory");
    h.fetcher.mockImplementation(async (url, init) => {
      await h.repository.cancel(h.identity, h.publication.runId);
      return original(url, init);
    });
    await h.service.refreshUsers(h.user, undefined, { publication: h.publication, incompleteOnly: true });
    expect((await h.status()).sources[cancelled].generationId).toBeNull();
    expect((await h.repository.getRun(h.identity, h.publication.runId))?.status).toBe("cancelled");
  });
  it("holds the publication validity check through its transaction while cancellation waits", async () => {
    const h = await harness(), admitted = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const publishing = transaction(fixture.runtime, async client => {
      await requireUserPublication(client, h.identity, h.publication);
      admitted.resolve();
      await finish.promise;
      await requireUserPublication(client, h.identity, h.publication);
    });
    await admitted.promise;
    let cancelled = false;
    const cancellation = h.repository.cancel(h.identity, h.publication.runId).then(() => { cancelled = true; });
    try {
      await vi.waitFor(async () => expect((await fixture.operator.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`)).rows[0].n).toBeGreaterThan(0));
      expect(cancelled).toBe(false);
    } finally { finish.resolve(); await publishing; await cancellation; }
    await expect(transaction(fixture.runtime, client => requireUserPublication(client, h.identity, h.publication)))
      .rejects.toMatchObject({ code: "data_sync_publication_superseded" });
  });
  it.each(["revalidation", "capability", "token", "provider", "progress", "publication-revalidation", "publication-capability"] as const)(
    "fences cancellation during %s and does not publish the affected directory generation", async boundary => {
      const h = await harness(), controller = new AbortController(), reason = new Error("User collection cancelled");
      await h.seed("app_activity");
      const cancel = () => controller.abort(reason);
      if (boundary === "revalidation") h.revalidateUser.mockImplementationOnce(async () => { cancel(); return h.user; });
      if (boundary === "capability") h.requireAvailable.mockImplementationOnce(async () => { cancel(); });
      if (boundary === "token") h.delegatedToken.mockImplementationOnce(async () => { cancel(); return "late-token"; });
      if (boundary === "provider") h.fetcher.mockImplementationOnce(async () => { cancel(); return Response.json({ value: [] }); });
      if (boundary === "publication-revalidation") h.revalidateUser.mockResolvedValueOnce(h.user).mockImplementationOnce(async () => { cancel(); return h.user; });
      if (boundary === "publication-capability") h.requireAvailable.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { cancel(); });
      await expect(h.service.refreshUsers(h.user, controller.signal, { publication: h.publication, incompleteOnly: true,
        onDirectoryProgress: async () => { if (boundary === "progress") cancel(); } })).rejects.toBe(reason);
      expect((await h.status()).sources.directory.generationId).toBeNull();
      expect(h.delegatedToken).toHaveBeenCalledTimes(boundary === "revalidation" || boundary === "capability" ? 0 : 1);
    },
  );
  it.each(["capability", "token", "provider"] as const)("fences revoked sessions during %s even without an AbortSignal", async boundary => {
    const h = await harness();
    await h.seed("app_activity");
    let revocation: Promise<void> | undefined;
    const revoke = () => { revocation = revokeAccountSessionMutations(h.identity.tenantId, h.identity.principalId, async () => {
      await new DataGenerations(fixture.runtime).revokePrincipal(h.identity.tenantId, h.identity.principalId);
    }); };
    if (boundary === "capability") h.requireAvailable.mockImplementationOnce(async () => { revoke(); });
    if (boundary === "token") h.delegatedToken.mockImplementationOnce(async () => { revoke(); return "late-token"; });
    if (boundary === "provider") h.fetcher.mockImplementationOnce(async () => { revoke(); await revocation; return Response.json({ value: [] }); });
    try {
      await expect(h.service.refreshUsers(h.user, undefined, { publication: h.publication, incompleteOnly: true })).rejects.toMatchObject({ status: 401 });
      expect((await fixture.runtime.query(`SELECT count(*)::int AS n FROM data_generation_heads h JOIN data_scope_epochs s ON s.id=h.scope_id
        WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.source='directory' AND h.generation_id IS NOT NULL`,
      [h.identity.tenantId, h.identity.principalId])).rows[0].n).toBe(0);
    } finally { await revocation; await activateAccountSession(h.identity.tenantId, h.identity.principalId, async () => {}); }
  });
  it("feeds positive Users OR bridge identities into bounded exact verification and moves newly paid people out of the unpaid cohort", async () => {
    const h = await harness(), imports = new OfficialReportImports(fixture.runtime), bundleId = randomUUID();
    for (const kind of ["users", "agents", "userAgents"] as const) {
      const rows = kind === "users" ? `person@example.invalid,Person,1,5,${date}\nzero@example.invalid,Zero,0,0,${date}`
        : kind === "agents" ? `agent,Agent,Your org,1,1,8,${date}` : `agent,Agent,Your org,bridge@example.invalid,3,${date}`;
      await imports.stage(h.identity, { bundleId }, (async function* () { yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n${rows}\n`); })());
    }
    await imports.acceptBundle(h.identity, bundleId, await imports.bundle(h.identity, bundleId));
    let paid = false;
    const original = h.fetcher.getMockImplementation()!;
    h.fetcher.mockImplementation(async (url, init) => {
      const filter = new URL(String(url)).searchParams.get("$filter");
      if (!filter) return original(url, init);
      const candidates = [
        { ...graphUser(), assignedLicenses: paid ? [{ skuId, disabledPlans: [] }] : [], assignedPlans: paid ? graphUser().assignedPlans : [] },
        { ...graphUser(), id: "30000000-0000-4000-8000-000000000004", userPrincipalName: "bridge@example.invalid", assignedLicenses: [], assignedPlans: [] },
      ];
      const value = filter.includes("assignedLicenses") ? paid ? [candidates[0]] : []
        : candidates.filter(candidate => filter.includes(candidate.userPrincipalName) || filter.includes(candidate.id));
      return Response.json({ value, "@odata.count": value.length });
    });
    const reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-report-secret-never-production", 30);
    const unpaid = async () => reports.page((await reports.capture(h.identity, "delegated", "official_users", { licenseCohort: "active_without_paid" })).id, h.identity);
    expect(await h.service.refreshUsers(h.user, undefined, { publication: h.publication })).toMatchObject({ status: "succeeded", count: 2 });
    expect((await unpaid()).counts.filtered).toBe(2);
    const exact = h.fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("$filter")).filter(filter => filter && !filter.includes("assignedLicenses"));
    expect(exact).toHaveLength(1);
    expect(exact[0]).toContain("person@example.invalid"); expect(exact[0]).toContain("bridge@example.invalid");
    expect(exact[0]).not.toContain("zero@example.invalid");
    paid = true;
    expect(await h.service.refreshUsers(h.user, undefined, { publication: h.publication })).toMatchObject({ status: "succeeded", count: 2 });
    expect((await unpaid()).counts.filtered).toBe(1);
    expect((await reports.page((await reports.capture(h.identity, "delegated", "copilot_users", { cohort: "licensed" })).id, h.identity)).counts.filtered).toBe(1);
  });
  it("does not report preserved directory rows as users observed by an app-only retry", async () => {
    const h = await harness();
    h.requireAvailable.mockImplementation(async capability => {
      if (capability === "reports.copilotUsage.read") throw new AppError(503, "report_unavailable", "Synthetic activity unavailable.");
    });
    expect(await h.service.refreshUsers(h.user, undefined, { publication: h.publication })).toMatchObject({ status: "partial", count: 1 });
    h.requireAvailable.mockClear(); h.fetcher.mockClear();
    expect(await h.service.refreshUsers(h.user, undefined, { incompleteOnly: true, publication: h.publication })).toMatchObject({ status: "partial", count: null });
    expect(h.requireAvailable.mock.calls.map(([capability]) => capability)).toEqual(["reports.copilotUsage.read"]);
    expect((await h.status()).sources.directory).toMatchObject({ attemptStatus: "available", rowCount: 1 });
  });
  it.each(["directory", "app_activity"] as const)("retries %s authorization only after a new sign-in without recollecting its fresh companion", async source => {
    const h = await harness(), capability = source === "directory" ? "graph.licenses.read" : "reports.copilotUsage.read";
    h.requireAvailable.mockImplementation(async current => {
      if (current === capability) throw new AppError(401, "login_required", "Synthetic authorization required.");
    });
    expect((await h.service.refreshUsers(h.user, undefined, { publication: h.publication })).status).toBe("partial");
    expect((await h.status()).sources[source].attemptStatus).toBe("waiting_authorization");
    h.requireAvailable.mockClear();
    expect((await h.service.refreshUsers(h.user, undefined, { automatic: true, publication: h.publication })).status).toBe("partial");
    expect(h.requireAvailable).not.toHaveBeenCalled();
    h.requireAvailable.mockImplementation(async () => {});
    expect((await h.service.refreshUsers(h.user, undefined, { automatic: true, signedInAt: Date.now() + 1_000, publication: h.publication })).status).toBe("succeeded");
    expect(h.requireAvailable.mock.calls.map(([current]) => current)).toEqual([capability, capability]);
  });
  it.each(["directory", "app_activity", "both"] as const)("reuses complete authorized %s evidence past freshness on incomplete-only retry", async expired => {
    const h = await harness(), expiry = new Date(Date.now() + 1500);
    for (const source of ["directory", "app_activity"] as const) await h.seed(source, new Date(), expired === source || expired === "both" ? expiry : undefined);
    const prior = (await h.status()).sources;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry.getTime() - Date.now()) + 20));
    h.fetcher.mockClear();
    expect(await h.service.refreshUsers(h.user, undefined, { incompleteOnly: true, publication: h.publication }))
      .toMatchObject({ status: "succeeded", count: 1 });
    const current = (await h.status()).sources;
    for (const source of ["directory", "app_activity"] as const) {
      expect(current[source].attemptStatus).toBe("available");
      expect(current[source].generationId).toBe(prior[source].generationId);
    }
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("publishes a verified zero only after a successful complete empty directory discovery", async () => {
    const h = await harness();
    expect((await h.status()).sources.directory.rowCount).toBeNull();
    h.fetcher.mockImplementation(async url => String(url).includes("getMicrosoft365CopilotUsageUserDetail")
      ? new Response(reportHeaders.join(",") + "\n") : Response.json({ value: [] }));
    expect(await h.service.refreshUsers(h.user, undefined, { publication: h.publication })).toMatchObject({ status: "succeeded", count: 0 });
    const reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-report-secret-never-production", 30);
    const page = await reports.page((await reports.capture(h.identity, "delegated", "copilot_users")).id, h.identity);
    expect(page.counts).toEqual({ total: 0, filtered: 0 });
    expect(page.summary).toMatchObject({ checkedUsers: 0, licensedUsers: 0, usingAgentsUsers: null });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });
});
