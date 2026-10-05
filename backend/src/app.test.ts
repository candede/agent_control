import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest, type ClientRequest, type Server } from "node:http";
import session from "express-session";
import { parse as parseCsv } from "csv-parse/sync";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, assert, vi } from "vitest";
import { retain } from "../scripts/database.js";
import { testDatabase, fixturePassword } from "../scripts/testDatabase.js";
import { createApp } from "./app.js";
import { acquireDelegatedToken, revalidateAuthenticatedUser } from "./auth/msal.js";
import { authConfigured, config } from "./config.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation } from "./db/copilotStudioQuarantine.js";
import { DefenderHuntingRepository } from "./db/defenderHunting.js";
import { createJobConfirmation, JobRepository, type JobIntentInput } from "./db/jobs.js";
import { PackageRefreshJobs } from "./db/packageRefreshJobs.js";
import { NativeInventory } from "./db/nativeInventory.js";
import { readPackageControls } from "./db/packageControls.js";
import { encodeInventoryFacet } from "./types/inventoryFacets.js";
import { pool } from "./db/pool.js";
import { PowerPlatformRefreshJobs } from "./db/powerPlatformRefreshJobs.js";
import { refreshInventoryFixture } from "../scripts/inventoryFixtures.js";
import { packageInventoryRecord, powerPlatformInventoryRecord } from "./services/inventoryRecordProjection.js";
import { PurviewAuditRepository } from "./db/purviewAudit.js";
import { schemaFingerprint } from "./db/schema.js";
import { AppError } from "./errors.js";
import { AuditLog } from "./services/auditLog.js";
import { CopilotStudioQuarantineClient } from "./services/copilotStudioQuarantine.js";
import { GraphPackagesClient } from "./services/graphPackages.js";
import { allowlistedPackage } from "./services/packageObservation.js";
import { capabilities } from "./services/capabilities.js";
import { DefenderHuntingService, defenderHunting } from "./services/defenderHunting.js";
import { PurviewAuditService, purviewAudit } from "./services/purviewAudit.js";
import { launchBulkJob, runBulkJob } from "./services/bulkJobs.js";
import type { AppRole } from "./types/capability.js";
import type { PowerPlatformResource, PowerPlatformResourceType } from "./types/powerPlatformInventory.js";
import type { CopilotPackageDetail } from "./types/copilotPackage.js";
import { clearAdmissionForTest } from "./middleware/admission.js";
import { AgentPeopleRepository } from "./db/agentPeople.js";
import { dataSync } from "./services/dataSync.js";
import { reportRuntime } from "./services/reportExportDispatcher.js";
import { reportIdentity } from "./services/reportIdentity.js";
import { OfficialReportImports } from "./db/officialReportImports.js";
import { DataGenerations, type GenerationLease } from "./db/dataGenerations.js";
import { generationInput } from "../scripts/largeTenantFixtures.js";
import type { OfficialReportAccepted, OfficialReportBundlePreview, OfficialReportExportStatus, OfficialReportPreview } from "./types/officialReportApi.js";
import type { ReportAgent, ReportHistorySet, ReportPage, ReportRelationship, ReportUser } from "./types/officialReportData.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON=JSON.stringify([
    {tenantId:"11111111-1111-1111-1111-111111111111",clientId:"99999999-9999-4999-8999-999999999999",
      clientSecret:"synthetic-app-test-secret",domains:["example.invalid"]},
    {tenantId:"33333333-3333-4333-8333-333333333333",clientId:"44444444-4444-4444-8444-444444444444",
      clientSecret:"synthetic-other-app-test-secret",domains:["other.example.invalid"]},
  ]);
  process.env.SESSION_SECRET="fixture-session-secret-never-used-outside-tests-01";
});
const huntingCapabilityFixture = vi.hoisted(() => ({ applicationRevision: 1 }));
const authFixture = vi.hoisted(() => ({
  user: {tenantId:"11111111-1111-1111-1111-111111111111",homeAccountId:"fixture-principal",displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Admin"]},
  revalidatedUser: {tenantId:"11111111-1111-1111-1111-111111111111",homeAccountId:"fixture-principal",displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Admin"]},
  pendingRevalidation: undefined as Promise<unknown> | undefined,
  revalidationStarted: 0,
  redemptions: 0,
}));
const inventoryProviderFixture = vi.hoisted(() => ({ queries: 0 }));
vi.mock("./auth/msal.js", async original => {
  const actual = await original<typeof import("./auth/msal.js")>();
  return {
  ...actual,
  acquireDelegatedToken: vi.fn(async () => "fixture-token"),
  acquireApplicationToken: vi.fn(async () => "fixture-application-token"),
  createAuthFlow: (kind:"login", options:Parameters<typeof actual.createAuthFlow>[1]) => ({
    ...actual.createAuthFlow(kind, options),state:"fixture-state______________________________",nonce:"fixture-nonce".padEnd(43, "_"),codeVerifier:"fixture-verifier".padEnd(43, "_"),
  }),
  createAuthorizationUrl: async () => "https://login.microsoftonline.com/fixture", redeemAuthorizationCode: async () => { authFixture.redemptions += 1; return {}; },
  toAuthenticatedUser: () => ({...authFixture.user,roles:[...authFixture.user.roles]}),
  evictAccount: vi.fn(async () => undefined), revalidateAuthenticatedUser: vi.fn(async () => { authFixture.revalidationStarted += 1; if (authFixture.pendingRevalidation) await authFixture.pendingRevalidation; return {...authFixture.revalidatedUser,roles:[...authFixture.revalidatedUser.roles]}; }),
}; });
vi.mock("./services/capabilities.js", () => ({ capabilities: {
  checkProgress: vi.fn(() => null),
  observeOperation: vi.fn(async (_id, _user, operation: (reportFailure: (error: unknown) => void) => Promise<unknown>) => operation(() => undefined)),
  requireAvailable: vi.fn(async () => undefined), requireApplicationDataScope: vi.fn(async () => ({ enabled: true, sharedDataScope: true, revision: huntingCapabilityFixture.applicationRevision })), invalidatePrincipal: vi.fn(async () => undefined), list: vi.fn(async () => []), check: vi.fn(async () => []), refresh: vi.fn(), configureApplication: vi.fn(),
  packageQualificationIdentity: vi.fn(async (action: string) => ({ capabilityId: action === "block" || action === "unblock" ? "graph.package.block.manage" : "graph.package.access.manage", contractRevision: "a".repeat(64), configurationRevision: 1, authMode: "delegated" })),
  auditQualificationContext: vi.fn(async (capabilityId: string) => ({ capabilityId, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 })),
  recordAuditQualificationEvidence: vi.fn(async () => ({ authorized: true })),
  huntingQualificationContext: vi.fn(async (capabilityId: string) => ({ capabilityId, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: capabilityId.endsWith(".application") ? huntingCapabilityFixture.applicationRevision : 1 })),
  recordHuntingQualificationEvidence: vi.fn(async () => ({ authorized: true })),
  quarantineAuthorityContext: vi.fn(async () => ({ contractRevision: "c".repeat(64), permissionRevision: "d".repeat(64), configurationRevision: 1 })),
  quarantineApprovalAuthorityContext: vi.fn(async () => ({ contractRevision: "c".repeat(64), permissionRevision: "d".repeat(64), configurationRevision: 1 })),
} }));
vi.mock("./services/powerPlatformResourceQuery.js", async original => ({ ...await original<typeof import("./services/powerPlatformResourceQuery.js")>(), PowerPlatformResourceQueryClient: class {
  async *pages(_token: string, _queriedTypes: PowerPlatformResourceType[], options: { visit?: (token: string) => Promise<void> } = {}) {
    inventoryProviderFixture.queries += 1;
    await options.visit?.("initial");
    yield { token: "initial", nextToken: null, records: [], rawCount: 0, expectedCount: 0, page: 1, omittedFieldCount: 0 };
  }
} }));
vi.mock("./services/bulkJobs.js", async original => ({ ...await original<typeof import("./services/bulkJobs.js")>(), launchBulkJob: vi.fn() }));
vi.mock("./services/copilotStudioQuarantineJobs.js", async original => ({ ...await original<typeof import("./services/copilotStudioQuarantineJobs.js")>(), launchCopilotStudioQuarantineJob: vi.fn() }));
// Draining is terminal, so each test needs fresh real workers rather than reopened singletons.
vi.mock("./services/defenderHunting.js", async original => ({
  ...await original<typeof import("./services/defenderHunting.js")>(),
  get defenderHunting() { return huntingService; },
}));
vi.mock("./services/purviewAudit.js", async original => ({
  ...await original<typeof import("./services/purviewAudit.js")>(),
  get purviewAudit() { return auditService; },
}));

let huntingService: DefenderHuntingService;
let auditService: PurviewAuditService;
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let application: ReturnType<typeof createApp>;
let server: Server;
let base: string;
let cookie: string;
let csrfToken: string;
const directory = join(process.cwd(), "artifacts", "test-scratch", `packaged-routing-${randomUUID()}`);
beforeAll(async () => {
  fixture = await testDatabase();
  pool.options.database = fixture.name; pool.options.user="agentcontrol_app"; pool.options.password=fixturePassword;
  mkdirSync(join(directory,"assets"), { recursive: true }); writeFileSync(join(directory,"index.html"),"<!doctype html><html><body><div id='root'>Fixture shell</div></body></html>");
  writeFileSync(join(directory,"assets/app.js"),"console.log('fixture')");
  application = createApp(fixture.runtime,directory);
  await new Promise<void>(resolve => { server=application.app.listen(0,"127.0.0.1",resolve); });
  base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  vi.spyOn(GraphPackagesClient.prototype,"catalogPages").mockImplementation(async function* (_token, options = {}) {
    await options.visit?.("initial");
    yield { token: "initial", nextToken: null, records: [{ id: "package-1", displayName: "Fixture", isBlocked: false }],
      rawCount: 1, expectedCount: 1, page: 1 };
  });
  vi.spyOn(GraphPackagesClient.prototype,"getPackageDetails").mockResolvedValue({id:"package-1",displayName:"Fixture",isBlocked:false,allowedUsersAndGroups:[{resourceType:"user",resourceId:"sensitive-user"}],acquireUsersAndGroups:[]});
  vi.spyOn(GraphPackagesClient.prototype,"blockPackage").mockResolvedValue();
  vi.spyOn(GraphPackagesClient.prototype,"unblockPackage").mockResolvedValue();
  vi.spyOn(CopilotStudioQuarantineClient.prototype,"getStatus").mockImplementation(async (_token, target, options) => ({ ...target, isBotQuarantined: false,
    lastUpdateTimeUtc: "2026-09-09T10:00:00.123Z", observedAt: new Date().toISOString(), correlationId: options.correlationId }));
  await publishPackageSnapshot("fixture-principal");
  await publishPackageSnapshot("reader");
  await publishPackageSnapshot("operator", ["package-1"]);
});
afterAll(async () => {
  if (fixture) await reportRuntime(fixture.runtime).drain();
  application?.store.close();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await pool.end(); await fixture?.close(); rmSync(directory,{recursive:true,force:true});
});
function request(path: string, options: RequestInit = {}) {
  const unsafe = Boolean(options.method && !["GET","HEAD","OPTIONS"].includes(options.method));
  return fetch(`${base}${path}`,{...options,redirect:"manual",headers:{Cookie:cookie ?? "",Origin:config.frontendOrigin,...(unsafe && csrfToken ? {"x-csrf-token":csrfToken} : {}),...options.headers}});
}
function signedSessionCookie(sid: string) {
  const signature=createHmac("sha256",config.sessionSecret).update(sid).digest("base64").replace(/=+$/g,"");
  return `agent-control.sid=${encodeURIComponent(`s:${sid}.${signature}`)}`;
}
async function roleCookie(principalId: string, roles: AppRole[], rolesValidatedAt = Date.now(), tenant = config.tenants[0]) {
  const sid=randomUUID();
  await new Promise<void>((resolve,reject) => application.store.set(sid,{cookie:new session.Cookie({maxAge:60000}),tenantId:tenant.tenantId,clientId:tenant.clientId,accountId:principalId,csrfToken,rolesValidatedAt,user:{tenantId:tenant.tenantId,homeAccountId:principalId,username:`${principalId}@${tenant.domains[0]}`,displayName:principalId,roles}},error => error ? reject(error) : resolve()));
  return signedSessionCookie(sid);
}
async function publishPackageSnapshot(principalId: string, requestedIds?: string[], tenantId = config.tenants[0].tenantId,
  displayName = "Fixture", changes: Partial<CopilotPackageDetail> | null = {}) {
  const repository = new PackageRefreshJobs(fixture.runtime);
  const scope = { tenantId, principalId };
  const job = await repository.submit(scope, {
    authorizationPrincipalId: principalId,
    tokenMode: "delegated",
    idempotencyKey: `package-snapshot-${principalId}-${randomUUID()}`,
    requestedIds,
  });
  await repository.markRunning(scope, job.id);
  await refreshInventoryFixture(fixture.runtime, scope, job.id, "packages", changes === null ? [] : [
    packageInventoryRecord({
      id: "package-1",
      displayName,
      isBlocked: false,
      allowedUsersAndGroups: [{ resourceType: "user", resourceId: "sensitive-user" }],
      acquireUsersAndGroups: [],
      sourceSystem: "graph_packages",
      authoringTool: null,
      creatorType: "unknown",
      agentKind: "copilot_package",
      lifecycle: "unknown",
      identityConfidence: "exact_native",
      provenance: {},
      ...changes,
    }),
  ], undefined, { exactTargets: requestedIds });
  return (await repository.getJob(scope, job.id))!.snapshotId!;
}
async function publishQuarantineInventory(principalId: string, ownerId?: string) {
  const repository = new PowerPlatformRefreshJobs(fixture.runtime);
  const scope = { tenantId: config.tenants[0].tenantId!, principalId };
  const job = await repository.submit(scope, { idempotencyKey: `quarantine-inventory-${principalId}-${randomUUID()}`, roleScope: "unknown", requestedTypes: ["microsoft.copilotstudio/agents"] });
  await repository.markRunning(scope, job.id);
  await refreshInventoryFixture(fixture.runtime, scope, job.id, "power_platform", [powerPlatformInventoryRecord({ tenantId: config.tenants[0].tenantId!, nativeId: "native-agent", type: "microsoft.copilotstudio/agents",
    location: null, displayName: "Exact agent", environmentId: "11111111-1111-4111-8111-111111111111", createdAt: null, createdBy: null,
    lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown", agentKind: "copilot_studio_agent",
    lifecycle: "published", identityConfidence: "exact_native", identifiers: [{ kind: "power_platform_resource_id", value: "native-agent" },
      { kind: "environment_id", value: "11111111-1111-4111-8111-111111111111" }, { kind: "cds_bot_id", value: "22222222-2222-4222-8222-222222222222" }],
    provenance: {}, details: { isQuarantined: true, quarantinedAt: "2026-09-09T09:00:00.000Z", ...(ownerId ? { ownerId } : {}) }, unknownFieldCount: 0 })],
  ["microsoft.copilotstudio/agents"], { roleScope: "unknown" });
  return (await repository.getJob(scope, job.id))!.snapshotId!;
}
async function mutationPreview(action: "block" | "unblock", ids: string[], mutationScope: "single" | "bulk", allMatching = false) {
  const selectionId = allMatching ? (await inventoryPage()).selection.id : undefined;
  const response = await request("/api/agents/mutation-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...allMatching ? { selectionId } : { ids }, mutationScope }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ confirmationHash: string; selectionId: string }>;
}
async function inventoryPage(selectedCookie = cookie, query = "") {
  const response = await request(`/api/agent-inventory${query ? `?${query}` : ""}`, { headers: { Cookie: selectedCookie } });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
async function createInventoryExport(selectedCookie: string, selectionId: string,
  kind: "graph_packages" | "power_platform_agents" | "unified_agents", ids?: string[]) {
  const created = await request("/api/data-exports", { method: "POST",
    headers: { Cookie: selectedCookie, "Content-Type": "application/json" }, body: JSON.stringify({ kind, selectionId, ids }) });
  expect(created.status, await created.clone().text()).toBe(202);
  const { id } = await created.json();
  await expect.poll(async () => (await (await request(`/api/data-exports/${id}`, { headers: { Cookie: selectedCookie } })).json()).status).toBe("ready");
  return id as string;
}
async function inventoryExport(selectedCookie: string, selectionId: string,
  kind: "graph_packages" | "power_platform_agents" | "unified_agents", ids?: string[]) {
  const id = await createInventoryExport(selectedCookie, selectionId, kind, ids);
  return request(`/api/data-exports/${id}/download`, { headers: { Cookie: selectedCookie } });
}

describe.sequential("packaged API/session contracts", () => {
  beforeEach(() => {
    clearAdmissionForTest();
    huntingService = new DefenderHuntingService(new DefenderHuntingRepository(fixture.runtime));
    auditService = new PurviewAuditService(new PurviewAuditRepository(fixture.runtime));
  });
  afterEach(async () => {
    await Promise.all([defenderHunting.drain(), purviewAudit.drain()]);
  });
  it("admits automatic refresh only for the current Viewer session with CSRF and no client-selected scope", async () => {
    const originalCsrf = csrfToken;
    csrfToken = "automatic-refresh-fixture-csrf";
    const responseBody = { run: null, detailJob: null,
      revisions: { users: "u", graph_packages: "g", power_platform: "p" },
      nextCheckAt: new Date(Date.now() + 60_000).toISOString() };
    const refresh = vi.spyOn(dataSync, "automaticRefresh").mockResolvedValue(responseBody);
    try {
      const viewerCookie = await roleCookie("automatic-viewer", ["AgentControl.Viewer"]);
      const headers = { Cookie: viewerCookie, "Content-Type": "application/json" };
      const send = (body: unknown = {}, query = "") => request(`/api/data-sync/auto-refresh${query}`,
        { method: "POST", headers, body: JSON.stringify(body) });
      const result = await send();
      expect(result.status).toBe(200);
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(await result.json()).toEqual(responseBody);
      expect(refresh).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        homeAccountId: "automatic-viewer", tenantId: config.tenants[0].tenantId, roles: ["AgentControl.Viewer"],
      }), undefined);
      for (const body of [{ tenantId: "other" }, { principalId: "other" }, { signedInAt: Date.now() }, { clearSavedData: true }, { sources: ["usage_reports"] }, { mode: "full" }]) {
        expect((await send(body)).status).toBe(400);
      }
      expect((await send({}, "?tenantId=other")).status).toBe(400);
      expect((await request("/api/data-sync/auto-refresh", {
        method: "POST", headers: { ...headers, "x-csrf-token": "wrong" }, body: "{}",
      })).status).toBe(403);
      expect((await request("/api/data-sync/auto-refresh", {
        method: "POST", headers: { ...headers, Cookie: await roleCookie("no-auto-role", []) }, body: "{}",
      })).status).toBe(403);
      expect((await request("/api/data-sync/auto-refresh", {
        method: "POST", headers: { ...headers, Cookie: "" }, body: "{}",
      })).status).toBe(401);
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      refresh.mockRestore();
      csrfToken = originalCsrf;
    }
  });
  it("requires the preserved public origin for tunnel permission checks and logout", async () => {
    const previousOrigin = config.frontendOrigin;
    config.frontendOrigin = "https://fixture-3002.euw.devtunnels.ms";
    try {
      for (const path of ["/api/capabilities/check", "/api/auth/logout"]) {
        for (const origin of [undefined, "null", "http://localhost", "https://localhost", "https://unapproved.invalid"]) {
          const denied = await fetch(`${base}${path}`, { method: "POST", headers: {
            ...(origin === undefined ? {} : { Origin: origin }),
            "X-Forwarded-Host": "fixture-3002.euw.devtunnels.ms",
            "X-Forwarded-Proto": "https",
          } });
          expect(denied.status).toBe(403);
          expect(await denied.json()).toMatchObject({
            code: "invalid_origin",
            detail: expect.stringContaining("--origin-header unchanged"),
            details: { expectedOrigin: config.frontendOrigin, receivedOrigin: origin ?? null },
          });
        }
        const preserved = await fetch(`${base}${path}`, { method: "POST", headers: { Origin: config.frontendOrigin } });
        expect(preserved.status).toBe(401);
        expect(await preserved.json()).toMatchObject({ code: "unauthorized" });
      }
    } finally {
      config.frontendOrigin = previousOrigin;
    }
  });
  it("keeps liveness, readiness, API/auth and static routes separate", async () => {
    const health=await request("/api/health");
    expect(await health.json()).toEqual({ok:true});
    expect(health.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("x-frame-options")).toBe("DENY");
    expect(health.headers.get("referrer-policy")).toBe("no-referrer");
    expect(health.headers.get("permissions-policy")).toContain("camera=()");
    expect(health.headers.get("strict-transport-security")).toBeNull();
    expect((await request("/api/ready")).status).toBe(200);
    const missingApi = await request("/api/unknown");
    expect(missingApi.status).toBe(404);
    expect(missingApi.headers.get("content-type")).toContain("application/problem+json");
    expect(missingApi.headers.get("cache-control")).toContain("no-store");
    expect(await missingApi.json()).toMatchObject({
      status: 404,
      code: "not_found",
      requestId: missingApi.headers.get("x-request-id"),
    });
    expect((await request("/api/auth/callback")).status).toBe(400);
    expect((await request("/assets/missing.js")).status).toBe(404);
    expect((await request("/missing.css")).status).toBe(404);
    for (const route of ["/agents", "/users", "/sync", "/audit", "/permissions", "/jobs"]) {
      const deepLink = await request(route);
      expect(deepLink.status).toBe(200);
      expect(deepLink.headers.get("cache-control")).toContain("no-store");
      expect(await deepLink.text()).toContain("Fixture shell");
    }
    expect((await request("/assets/app.js")).headers.get("cache-control")).toContain("immutable");
    expect((await request("/api/diagnostics")).status).toBe(401);
    expect((await request("/assets/%2e%2e%2fsecret")).status).toBe(400);
  });
  it.each([
    "/sync?reports=manage",
    "/sync?reports=import&staging=stage%2Fone",
    "/sync?reports=snapshot&snapshot=set%2Fone&window=30",
    "/official-usage",
    "/official-usage?view=history",
    "/official-usage?view=overview",
    "/official-usage?view=snapshot",
    "/official-usage?snapshot=set%2Fone",
    "/official-usage?window=7",
    "/official-usage?view=history&snapshot=set%2Fone&window=30",
    "/official-usage?staging=stage%2Fone&snapshot=set%2Fone&window=30",
  ])("serves the SPA at %s without stripping bookmark values before client canonicalization", async route => {
    const response = await request(route);
    expect(response.status).toBe(200);
    expect(response.url).toBe(`${base}${route}`);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toContain("Fixture shell");
  });
  it("keeps report data APIs separate from retired page bookmarks", async () => {
    const response = await request("/api/official-usage/history");
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  });
  it("regenerates the session at login and removes the previous identifier", async () => {
    const login = await request("/api/auth/login?username=fixture%40example.invalid");
    const previousCookie=login.headers.get("set-cookie")!.split(";")[0];
    cookie=previousCookie;
    const pendingSession=await fixture.runtime.query("SELECT sess::text AS value FROM sessions");
    for (const secret of ["fixture-state______________________________","fixture-nonce","fixture-verifier"]) expect(JSON.stringify(pendingSession.rows)).not.toContain(secret);
    const redemptions=authFixture.redemptions;
    const signInStartedAt = Date.now();
    const callback=await request("/api/auth/callback?code=fixture&state=fixture-state______________________________");
    expect(callback.status).toBe(302); cookie=callback.headers.get("set-cookie")!.split(";")[0];
    expect(cookie).not.toBe(previousCookie);
    const me=await request("/api/me"); expect(me.status).toBe(200); csrfToken=(await me.json()).csrfToken;
    expect((await request("/api/me",{headers:{Cookie:previousCookie}})).status).toBe(401);
    expect((await request("/api/auth/callback?code=fixture&state=fixture-state______________________________")).status).toBe(400);
    expect(authFixture.redemptions).toBe(redemptions+1);
    const stored=await fixture.runtime.query("SELECT sess::text AS value FROM sessions");
    expect(JSON.stringify(stored.rows)).not.toContain("fixture-token");
    const signedInAt = (await fixture.runtime.query<{ signed_in_at: string }>(
      "SELECT (sess->>'signedInAt')::bigint AS signed_in_at FROM sessions WHERE principal_id=$1",
      [authFixture.user.homeAccountId])).rows.map(row => Number(row.signed_in_at)).find(value => value >= signInStartedAt);
    expect(signedInAt).toBeGreaterThanOrEqual(signInStartedAt);
    const refresh = vi.spyOn(dataSync, "automaticRefresh").mockResolvedValue({
      run: null, detailJob: null, revisions: { users: "u", graph_packages: "g", power_platform: "p" },
      nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
    });
    try {
      expect((await request("/api/data-sync/auto-refresh", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      })).status).toBe(200);
      expect(refresh).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        homeAccountId: authFixture.user.homeAccountId,
      }), signedInAt);
    } finally { refresh.mockRestore(); }
  });
  it("routes username-first login to a configured second tenant and rejects a callback from the first tenant", async () => {
    const previousUser = authFixture.user;
    const tenant = config.tenants[1];
    const start = () => request("/api/auth/login", {
      method: "POST", headers: { Cookie: "", "Content-Type": "application/json" },
      body: JSON.stringify({ username: "login-domain-b@other.example.invalid", returnTo: "/agents" }),
    });
    try {
      const unknown = await request("/api/auth/login", {
        method: "POST", headers: { Cookie: "", "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin@unconfigured.example" }),
      });
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({ code: "unknown_tenant" });
      const mismatched = await start();
      expect(mismatched.status).toBe(200);
      const rejected = await request("/api/auth/callback?code=fixture&state=fixture-state______________________________", {
        headers: { Cookie: mismatched.headers.get("set-cookie")!.split(";")[0] },
      });
      expect(rejected.status).toBe(401);
      authFixture.user = { ...previousUser, tenantId: tenant.tenantId, homeAccountId: "login-domain-b",
        username: "login-domain-b@other.example.invalid" };
      const login = await start();
      expect(await login.json()).toEqual({ authorizationUrl: "https://login.microsoftonline.com/fixture" });
      const signedIn = await request("/api/auth/callback?code=fixture&state=fixture-state______________________________", {
        headers: { Cookie: login.headers.get("set-cookie")!.split(";")[0] },
      });
      expect(signedIn.status).toBe(302);
      expect(signedIn.headers.get("location")).toBe("/agents");
      const tenantCookie = signedIn.headers.get("set-cookie")!.split(";")[0];
      const me = await request("/api/me", { headers: { Cookie: tenantCookie } });
      expect(me.status).toBe(200);
      const identity = await me.json();
      expect(identity.user).toMatchObject({ tenantId: tenant.tenantId, homeAccountId: "login-domain-b" });
      expect(JSON.stringify(identity)).not.toContain(tenant.clientSecret);
      expect((await request("/api/auth/logout", {
        method: "POST", headers: { Cookie: tenantCookie, "x-csrf-token": identity.csrfToken },
      })).status).toBe(204);
      expect((await request("/api/me", { headers: { Cookie: tenantCookie } })).status).toBe(401);
    } finally { authFixture.user = previousUser; }
  });
  it.each(["graph.package.read.delegated", "graph.agentIdentity.read", "defender.hunting.application", "unknown"])("retires permission consent for %s without creating an authorization transaction", async capabilityId => {
    const originalCookie=cookie;
    cookie=await roleCookie("fixture-principal",["AgentControl.Viewer"]);
    try {
      expect((await request("/api/auth/consent",{method:"POST",headers:{"Content-Type":"application/json","x-csrf-token":"wrong"},body:JSON.stringify({capabilityId})})).status).toBe(403);
      const consent=await request("/api/auth/consent",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({capabilityId})});
      expect(consent.status).toBe(410);
      const body = await consent.json();
      expect(body).toMatchObject({ code: "admin_managed_permissions", detail: expect.stringContaining("Grant admin consent") });
      expect(body).not.toHaveProperty("authorizationUrl");
      const redemptions = authFixture.redemptions;
      expect((await request("/api/auth/callback?code=fixture&state=fixture-state______________________________")).status).toBe(400);
      expect(authFixture.redemptions).toBe(redemptions);
    } finally { cookie=originalCookie; }
  });
  it("removes stale roles when normal sign-in returns an authoritative empty assignment", async () => {
    const originalCookie=cookie;
    cookie=await roleCookie("fixture-principal",["AgentControl.Viewer"]);
    try {
      expect((await request("/api/auth/login")).status).toBe(302);
      authFixture.user.roles=[];
      const callback=await request("/api/auth/callback?code=fixture&state=fixture-state______________________________");
      expect(callback.status).toBe(302);
      cookie=callback.headers.get("set-cookie")!.split(";")[0];
      const me=await request("/api/me");
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({user:{roles:[]},roleAssignmentRequired:true});
    } finally {
      authFixture.user.roles=["AgentControl.Admin"];
      cookie=originalCookie;
    }
  });
  it("returns safe normal sign-in cancellation and conditional-access outcomes only after consuming the flow", async () => {
    const originalCookie = cookie;
    try {
      cookie = await roleCookie("fixture-principal", ["AgentControl.Viewer"]);
      for (const [providerError, outcome] of [["access_denied", "cancelled"], ["interaction_required", "interaction_required"], ["unrecognized-error", "failed"]]) {
        const login = await request("/api/auth/login?returnTo=%2F%3Fview%3Dpermissions");
        expect(login.status).toBe(302);
        const redemptions = authFixture.redemptions;
        const result = await request(`/api/auth/callback?state=fixture-state______________________________&error=${providerError}&error_description=private-provider-text`);
        expect(result.status).toBe(302);
        expect(result.headers.get("location")).toBe(`/?view=permissions&authorization=${outcome}`);
        expect(authFixture.redemptions).toBe(redemptions);
        expect((await request("/api/auth/callback?state=fixture-state______________________________&error=access_denied")).status).toBe(400);
        expect(await (await request("/api/me")).json()).toMatchObject({ user: { roles: ["AgentControl.Viewer"] } });
      }
    } finally { cookie = originalCookie; }
  });
  it("rejects direct provider writes despite manipulated or disabled frontend controls", async () => {
    const operatorCookie = await roleCookie("gate-operator", ["AgentControl.Admin"]);
    const before = await fixture.operator.query("SELECT count(*)::int AS count FROM jobs");
    const denial = new AppError(403, "capability_unavailable", "Preview writes remain unqualified.");
    vi.mocked(capabilities.requireAvailable).mockRejectedValue(denial);
    try {
      for (const endpoint of ["/api/agents/package-1/block", "/api/agents/block", "/api/agents/unblock-all"]) {
        expect((await request(endpoint, { method: "POST", headers: { Cookie: operatorCookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: ["package-1"] }) })).status).toBe(403);
      }
      expect((await fixture.operator.query("SELECT count(*)::int AS count FROM jobs")).rows).toEqual(before.rows);
      const adminCookie = await roleCookie("gate-admin", ["AgentControl.Admin"]);
      expect((await request("/api/agents/package-1/block", { method: "POST", headers: { Cookie: adminCookie } })).status).toBe(403);
    } finally { vi.mocked(capabilities.requireAvailable).mockResolvedValue(undefined); }
  });
  it("keeps saved provider-audit results private, content-free, locally audited and CSRF-deletable", async () => {
    const previousCsrf = csrfToken;
    const previousCookie = cookie;
    csrfToken = "provider-audit-fixture-csrf";
    const principalId = "provider-audit-reader";
    const securityCookie = await roleCookie(principalId, ["AgentControl.Viewer"]);
    const otherCookie = await roleCookie("other-security-reader", ["AgentControl.Viewer"]);
    const readerCookie = await roleCookie("ordinary-reader", ["AgentControl.Viewer"]);
    const repository = new PurviewAuditRepository(fixture.runtime);
    const scope = { tenantId: config.tenants[0].tenantId!, authorizationPrincipalId: principalId,
      resultScope: { kind: "principal" as const, scopeId: principalId, configurationRevision: null }, tokenMode: "delegated" as const };
    const filters = { presetId: "copilot_interactions" as const, operations: ["CopilotInteraction"], startDateTime: "2026-09-09T10:00:00.000Z", endDateTime: "2026-09-09T11:00:00.000Z", userPrincipalNames: [], ipAddresses: [], objectIds: [], administrativeUnitIds: [] };
    const job = await repository.submit(scope, { idempotencyKey: "provider-audit-http", filters });
    const execution = await repository.begin(scope, job.id);
    await repository.authorizeProviderRequest(scope, job.id, execution);
    await repository.recordProviderQuery(scope, job.id, execution, "provider-http-fixture", "succeeded");
    await repository.publish(scope, job.id, execution, { records: [{
      projectionVersion: 1, wrapperId: "wrapper-http", nativeEventId: "77777777-7777-4777-8777-777777777777", eventDateTime: "2026-09-09T10:30:00.000Z", auditLogRecordType: "copilotInteraction",
      operation: "CopilotInteraction", service: "Copilot", resultStatus: "Succeeded", actorUserId: "actor-http", actorUserPrincipalName: "=formula@example.invalid",
      actorUserType: "regular", objectId: "object-http", clientIp: "192.0.2.10", administrativeUnits: [], correlationId: "correlation-http", agentId: "agent-http",
      appIdentity: "app-http", appHost: "Teams", botId: null, environmentId: null, botComponentId: null, aiPluginOperationId: null,
      messages: [{ id: "message-http", isPrompt: true }], contentAvailable: false, unknownFieldCount: 1,
    }], pageCount: 1, providerRowCount: 1, storedRowCount: 1, byteCount: 1024, unknownFieldCount: 1, complete: true, nextLink: null, partialReason: null });
    const completedJob = await repository.getJob(scope, job.id);

    try {
      const catalog = await request("/api/audit-search/catalog", { headers: { Cookie: securityCookie } });
      expect(catalog.status).toBe(200);
      expect(catalog.headers.get("cache-control")).toContain("no-store");
      const history = await request("/api/audit-search/jobs?limit=10&offset=0", { headers: { Cookie: securityCookie } });
      expect(history.status).toBe(200);
      expect(history.headers.get("cache-control")).toContain("no-store");
      await expect(history.json()).resolves.toMatchObject({ count: 1, limit: 10, offset: 0 });
      expect((await request(`/api/audit-search/jobs/${job.id}/records`, { headers: { Cookie: readerCookie } })).status).toBe(404);
      expect((await request(`/api/audit-search/jobs/${job.id}/records`, { headers: { Cookie: otherCookie } })).status).toBe(404);
      const saved = await request(`/api/audit-search/jobs/${job.id}/records`, { headers: { Cookie: securityCookie } });
      expect(saved.status).toBe(200);
      expect(saved.headers.get("cache-control")).toContain("no-store");
      const savedBody = await saved.json();
      expect(savedBody).toMatchObject({ count: 1, value: [{ nativeEventId: "77777777-7777-4777-8777-777777777777", messages: [{ id: "message-http", isPrompt: true }], contentAvailable: false }] });
      expect(JSON.stringify(savedBody)).not.toContain("promptText");

      const exported = await request(`/api/audit-search/jobs/${job.id}/export.csv`, { headers: { Cookie: securityCookie } });
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-disposition")).toContain(job.id);
      const exportText = await exported.text();
      const [exportHeader, exportRow] = parseCsv(exportText, { bom: true }) as string[][];
      const exportedRecord = Object.fromEntries(exportHeader.map((column, index) => [column, exportRow[index]]));
      expect(exportedRecord).toMatchObject({
        jobId: job.id,
        tenantId: config.tenants[0].tenantId,
        wrapperId: "wrapper-http",
        requestedStartDateTime: filters.startDateTime,
        requestedEndDateTime: filters.endDateTime,
        observedStartDateTime: completedJob.observedRange!.startDateTime,
        observedEndDateTime: completedJob.observedRange!.endDateTime,
        expiresAt: completedJob.expiresAt,
        finishedAt: completedJob.finishedAt,
      });
      expect(exportText).toContain("Content not present in Purview audit");
      expect(exportText).toContain("message-http");
      expect(exportText).toContain("'=formula@example.invalid");
      expect(exportText).toContain("provider-http-fixture");
      expect(exportText).toContain(job.localRequestId);
      expect(exportText).not.toContain("promptText");

      expect((await fixture.runtime.query("SELECT action,status,metadata FROM audit_projection WHERE tenant_id=$1 AND principal_id=$2 AND action IN ('view-audit-search','export-audit-search') ORDER BY action", [config.tenants[0].tenantId, principalId])).rows).toEqual([
        { action: "export-audit-search", status: "succeeded", metadata: {
          source: "microsoft_purview_audit", jobId: job.id, resultingCount: 1, resultingBytes: expect.any(Number),
        } },
        { action: "view-audit-search", status: "succeeded", metadata: { source: "microsoft_purview_audit", resultingCount: 1 } },
      ]);
      expect((await request(`/api/audit-search/jobs/${job.id}`, { method: "DELETE", headers: { Cookie: securityCookie, "x-csrf-token": "wrong" } })).status).toBe(403);
      expect((await request(`/api/audit-search/jobs/${job.id}`, { method: "DELETE", headers: { Cookie: securityCookie } })).status).toBe(400);
      expect((await request(`/api/audit-search/jobs/${job.id}`, { method: "DELETE", headers: { Cookie: securityCookie, "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: "wrong-job" }) })).status).toBe(409);
      expect((await request(`/api/audit-search/jobs/${job.id}`, { method: "DELETE", headers: { Cookie: securityCookie, "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: job.id }) })).status).toBe(204);
      expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM purview_audit_records WHERE job_id=$1", [job.id])).rows[0].count).toBe(0);
    } finally {
      csrfToken = previousCsrf;
      cookie = previousCookie;
    }
  });
  it("keeps saved Defender hunting source-separated, private, content-free and locally audited without GET collection", async () => {
    const previousCsrf = csrfToken;
    const previousCookie = cookie;
    csrfToken = "defender-hunting-fixture-csrf";
    const principalId = "defender-hunting-reader";
    const securityCookie = await roleCookie(principalId, ["AgentControl.Viewer"]);
    const otherCookie = await roleCookie("other-hunting-reader", ["AgentControl.Viewer"]);
    const readerCookie = await roleCookie("ordinary-hunting-reader", ["AgentControl.Viewer"]);
    const repository = new DefenderHuntingRepository(fixture.runtime);
    const scope = { tenantId: config.tenants[0].tenantId!, authorizationPrincipalId: principalId,
      resultScope: { kind: "principal" as const, scopeId: principalId, configurationRevision: null }, tokenMode: "delegated" as const };
    const filters = { templateId: "agents_inventory" as const, startDateTime: "2026-09-09T10:00:00.000Z", endDateTime: "2026-09-09T11:00:00.000Z",
      agentIds: ["@defender-agent"], blueprintIds: [], actorObjectIds: [], operations: [] };
    const authority = { capabilityId: "defender.hunting.delegated" as const, contractRevision: "a".repeat(64),
      permissionRevision: "b".repeat(64), configurationRevision: 1 };
    const qualificationJob = await repository.submit(scope, { idempotencyKey: "defender-hunting-qualification-http", filters,
      qualification: { ...authority, approvedBy: principalId } });
    const qualificationExecution = await repository.begin(scope, qualificationJob.id);
    await repository.publish(scope, qualificationJob.id, qualificationExecution, { rows: [{
      projectionVersion: 3, sourceTable: "AgentsInfo", observationTime: "2026-09-09T10:30:00.000Z", agentId: "@defender-agent",
      agentName: "=Formula agent", platform: "CopilotStudio", agentDescription: null, version: null, sourceAgentId: null,
      entraAgentObjectId: "11111111-1111-4111-8111-111111111111", entraBlueprintId: "22222222-2222-4222-8222-222222222222",
      observabilityId: null, publishedStatus: "Published", lifecycleStatus: "Active", availability: null, createdDateTime: null,
      lastPublishedDateTime: null, lastUpdatedDateTime: null, instanceCount: 1, model: null, ownerCount: 1, sharedWithCount: 0,
      permissionMetadataKeyCount: 2, authenticationMetadataKeyCount: 1,
      detailStates: { owners: "present_unqualified_shape", sharing: "present_unqualified_shape", permissions: "present_unqualified_shape",
        authentication: "present_unqualified_shape", risk: "not_exposed" },
    }], providerRowCount: 1, storedRowCount: 1, byteCount: 1024, complete: true, partialReason: null });
    const retainedScope = await repository.requireQualifiedScope(scope, filters, authority);
    const job = await repository.submit(scope, { idempotencyKey: "defender-hunting-http", filters, retainedScope });
    const execution = await repository.begin(scope, job.id);
    await repository.authorizeProviderRequest(scope, job.id, execution);
    await repository.recordProviderResponse(scope, job.id, execution, "defender-provider-http");
    await repository.publish(scope, job.id, execution, { rows: [{
      projectionVersion: 3, sourceTable: "AgentsInfo", observationTime: "2026-09-09T10:30:00.000Z", agentId: "@defender-agent",
      agentName: "=Formula agent", platform: "CopilotStudio", agentDescription: null, version: null, sourceAgentId: null,
      entraAgentObjectId: "11111111-1111-4111-8111-111111111111", entraBlueprintId: "22222222-2222-4222-8222-222222222222",
      observabilityId: null, publishedStatus: "Published", lifecycleStatus: "Active", availability: null, createdDateTime: null,
      lastPublishedDateTime: null, lastUpdatedDateTime: null, instanceCount: 1, model: null, ownerCount: 1, sharedWithCount: 0,
      permissionMetadataKeyCount: 2, authenticationMetadataKeyCount: 1,
      detailStates: { owners: "present_unqualified_shape", sharing: "present_unqualified_shape", permissions: "present_unqualified_shape",
        authentication: "present_unqualified_shape", risk: "not_exposed" },
    }], providerRowCount: 1, storedRowCount: 1, byteCount: 1024, complete: true, partialReason: null });
    const pending = await repository.submit(scope, { idempotencyKey: "defender-hunting-cancel-http", filters, retainedScope });
    const beforeNavigation = await repository.getJob(scope, job.id);

    try {
      const catalog = await request("/api/hunting/catalog", { headers: { Cookie: securityCookie } });
      expect(catalog.status).toBe(200);
      expect(catalog.headers.get("cache-control")).toContain("no-store");
      const catalogBody = await catalog.json();
      expect(catalogBody).toMatchObject({ templates: expect.arrayContaining([expect.objectContaining({ id: "agents_inventory", sourceTable: "AgentsInfo" })]),
        qualifications: [expect.objectContaining({ capabilityId: "defender.hunting.delegated", templateId: "agents_inventory", queryVersion: 3, approvedBy: principalId })],
        retainedScopes: [expect.objectContaining({ id: retainedScope.id, tokenMode: "delegated", queryVersion: 3, approvedBy: principalId })] });
      expect(catalogBody).not.toHaveProperty("workspaceId");
      expect(catalogBody.templates.every((template: Record<string, unknown>) => !("workspaceId" in template))).toBe(true);
      await fixture.operator.query("UPDATE defender_hunting_qualification_evidence SET expires_at=clock_timestamp()-interval '1 second' WHERE qualified_job_id=$1", [qualificationJob.id]);
      const tokenCalls = vi.mocked(acquireDelegatedToken).mock.calls.length;
      const history = await request("/api/hunting/jobs?limit=10&offset=0", { headers: { Cookie: securityCookie } });
      expect(history.status).toBe(200);
      expect(history.headers.get("cache-control")).toContain("no-store");
      await expect(history.json()).resolves.toMatchObject({ count: 3, limit: 10, offset: 0 });
      expect((await repository.getJob(scope, job.id))?.providerRequestCount).toBe(beforeNavigation?.providerRequestCount);
      expect((await request(`/api/hunting/jobs/${job.id}/rows`, { headers: { Cookie: readerCookie } })).status).toBe(404);
      expect((await request(`/api/hunting/jobs/${job.id}/rows`, { headers: { Cookie: otherCookie } })).status).toBe(404);
      const saved = await request(`/api/hunting/jobs/${job.id}/rows`, { headers: { Cookie: securityCookie } });
      expect(saved.status).toBe(200);
      const savedBody = await saved.json();
      expect(savedBody).toMatchObject({ count: 1, snapshot: { sourceTable: "AgentsInfo", complete: true, noData: false },
        value: [{ agentId: "@defender-agent" }] });
      expect(savedBody.value[0]).not.toHaveProperty("contentAvailable");
      expect(JSON.stringify(savedBody)).not.toMatch(/RawEventData|Instructions|Memory|InputMessages|OutputMessages|ToolArguments|ToolResult/);

      const exported = await request(`/api/hunting/jobs/${job.id}/export.csv`, { headers: { Cookie: securityCookie } });
      expect(exported.status).toBe(200);
      const exportText = await exported.text();
      const [exportHeader, exportValue] = parseCsv(exportText, { bom: true }) as string[][];
      const exportedRow = Object.fromEntries(exportHeader.map((column, index) => [column, exportValue[index]]));
      expect(exportedRow).toMatchObject({ jobId: job.id, tenantId: config.tenants[0].tenantId, sourceTable: "AgentsInfo", agentId: "'@defender-agent",
        requestedStartDateTime: filters.startDateTime, requestedEndDateTime: filters.endDateTime, complete: "true", noData: "false" });
      expect(exportText).toContain("'=Formula agent");
      expect(exportText).toContain("'@defender-agent");
      expect(exportText).toContain("defender-provider-http");
      expect(exportText).not.toMatch(/RawEventData|Instructions|Memory|ToolArguments|ToolResult/);

      expect((await request(`/api/hunting/jobs/${pending.id}/cancel`, { method: "POST", headers: { Cookie: securityCookie } })).status).toBe(200);
      expect((await request(`/api/hunting/jobs/${pending.id}`, { method: "DELETE", headers: { Cookie: securityCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: pending.id }) })).status).toBe(204);
      await retain(fixture.operator);
      expect((await fixture.operator.query("SELECT count(*)::int AS count FROM defender_hunting_qualification_evidence WHERE qualified_job_id=$1", [qualificationJob.id])).rows[0].count).toBe(0);
      expect((await fixture.operator.query("SELECT count(*)::int AS count FROM defender_hunting_retained_scopes WHERE id=$1", [retainedScope.id])).rows[0].count).toBe(1);
      expect((await request(`/api/hunting/jobs/${job.id}/rows`, { headers: { Cookie: securityCookie } })).status).toBe(200);
      expect((await request(`/api/hunting/jobs/${job.id}/export.csv`, { headers: { Cookie: securityCookie } })).status).toBe(200);
      const retainedHistory = await request("/api/hunting/jobs?limit=10&offset=0", { headers: { Cookie: securityCookie } });
      await expect(retainedHistory.json()).resolves.toMatchObject({ count: 2 });
      expect((await request("/api/hunting/jobs", { method: "POST", headers: { Cookie: securityCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ tokenMode: "delegated", filters: { ...filters, Query: "CloudAppEvents" } }) })).status).toBe(400);
      expect((await request("/api/hunting/qualifications", { method: "POST", headers: { Cookie: securityCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ tokenMode: "delegated", filters: { ...filters, Query: "CloudAppEvents" } }) })).status).toBe(400);
      expect((await request("/api/hunting/qualifications/44444444-4444-4444-8444-444444444444/start", { method: "POST", headers: { Cookie: securityCookie } })).status).toBe(404);

      expect((await request(`/api/hunting/retained-scopes/${retainedScope.id}/revoke`, { method: "POST", headers: { Cookie: securityCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: retainedScope.id }) })).status).toBe(200);
      const hiddenHistory = await request("/api/hunting/jobs?limit=10&offset=0", { headers: { Cookie: securityCookie } });
      await expect(hiddenHistory.json()).resolves.toMatchObject({ count: 0, value: [] });
      expect((await request(`/api/hunting/jobs/${job.id}/rows`, { headers: { Cookie: securityCookie } })).status).toBe(404);
      expect((await request(`/api/hunting/jobs/${job.id}/export.csv`, { headers: { Cookie: securityCookie } })).status).toBe(404);
      expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM defender_hunting_rows WHERE snapshot_id=$1", [beforeNavigation!.snapshotId])).rows[0].count).toBe(1);

      const configuration = await fixture.operator.query<{ revision: string }>(`INSERT INTO capability_configuration
        (tenant_id,capability_id,enabled,shared_data_scope,updated_by)
        VALUES($1,'defender.hunting.application',true,true,$2)
        ON CONFLICT (tenant_id,capability_id) DO UPDATE SET enabled=true,shared_data_scope=true,
          revision=capability_configuration.revision+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
        RETURNING revision`, [config.tenants[0].tenantId, principalId]);
      huntingCapabilityFixture.applicationRevision = Number(configuration.rows[0].revision);
      const applicationScope = { tenantId: config.tenants[0].tenantId!, authorizationPrincipalId: principalId,
        resultScope: { kind: "application" as const, scopeId: config.tenants[0].clientId!, configurationRevision: huntingCapabilityFixture.applicationRevision },
        tokenMode: "application" as const };
      const applicationAuthority = { capabilityId: "defender.hunting.application" as const, contractRevision: "a".repeat(64),
        permissionRevision: "b".repeat(64), configurationRevision: huntingCapabilityFixture.applicationRevision };
      const applicationQualification = await repository.submit(applicationScope, { idempotencyKey: "defender-application-qualification-http", filters,
        qualification: { ...applicationAuthority, approvedBy: principalId } });
      const applicationQualificationExecution = await repository.begin(applicationScope, applicationQualification.id);
      const { association: _association, ...applicationRow } = savedBody.value[0];
      await repository.publish(applicationScope, applicationQualification.id, applicationQualificationExecution,
        { rows: [applicationRow], providerRowCount: 1, storedRowCount: 1, byteCount: 1024, complete: true, partialReason: null });
      const applicationRetainedScope = await repository.requireQualifiedScope(applicationScope, filters, applicationAuthority);
      const applicationJob = await repository.submit(applicationScope, { idempotencyKey: "defender-application-http", filters,
        retainedScope: applicationRetainedScope });
      const applicationExecution = await repository.begin(applicationScope, applicationJob.id);
      await repository.publish(applicationScope, applicationJob.id, applicationExecution,
        { rows: [applicationRow], providerRowCount: 1, storedRowCount: 1, byteCount: 1024, complete: true, partialReason: null });
      const sharedHistory = await request("/api/hunting/jobs?limit=10&offset=0", { headers: { Cookie: otherCookie } });
      await expect(sharedHistory.json()).resolves.toMatchObject({ count: 2 });
      expect((await request(`/api/hunting/jobs/${applicationJob.id}/rows`, { headers: { Cookie: otherCookie } })).status).toBe(200);

      const changedConfiguration = await fixture.operator.query<{ revision: string }>(`UPDATE capability_configuration
        SET revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND capability_id='defender.hunting.application' RETURNING revision`, [config.tenants[0].tenantId]);
      huntingCapabilityFixture.applicationRevision = Number(changedConfiguration.rows[0].revision);
      const changedHistory = await request("/api/hunting/jobs?limit=10&offset=0", { headers: { Cookie: otherCookie } });
      await expect(changedHistory.json()).resolves.toMatchObject({ count: 0, value: [] });
      expect((await request(`/api/hunting/jobs/${applicationJob.id}/rows`, { headers: { Cookie: otherCookie } })).status).toBe(404);
      expect(vi.mocked(acquireDelegatedToken).mock.calls).toHaveLength(tokenCalls);

      const auditRows = (await fixture.runtime.query("SELECT action,status,metadata FROM audit_projection WHERE tenant_id=$1 AND principal_id=$2 AND action LIKE '%hunting%' ORDER BY action,observed_at", [config.tenants[0].tenantId, principalId])).rows;
      expect(auditRows).toEqual(expect.arrayContaining([
        { action: "cancel-hunting", status: "succeeded", metadata: { source: "microsoft_defender_hunting" } },
        { action: "revoke-hunting-scope", status: "succeeded", metadata: { source: "microsoft_defender_hunting" } },
        { action: "export-hunting", status: "succeeded", metadata: {
          source: "microsoft_defender_hunting", jobId: job.id, resultingCount: 1, resultingBytes: expect.any(Number),
        } },
        { action: "view-hunting", status: "succeeded", metadata: { source: "microsoft_defender_hunting", resultingCount: 1 } },
      ]));
      expect(JSON.stringify(auditRows)).not.toMatch(/CloudAppEvents|defender-agent|startDateTime|endDateTime|Query|RawEventData/);
    } finally {
      csrfToken = previousCsrf;
      cookie = previousCookie;
    }
  });
  it("accepts unqualified delegated hunting without bypassing worker authorization or application scope", async () => {
    const previousUser = authFixture.revalidatedUser;
    const previousCsrf = csrfToken;
    csrfToken = "delegated-hunting-fixture-csrf";
    const principalId = "unqualified-delegated-hunting-viewer";
    const filters = {
      templateId: "agents_inventory",
      startDateTime: new Date(Date.now() - 30 * 60_000).toISOString(),
      endDateTime: new Date().toISOString(),
      agentIds: ["@http-delegated-agent"], blueprintIds: [], actorObjectIds: [], operations: [],
    };
    const tokenCalls = vi.mocked(acquireDelegatedToken).mock.calls.length;
    const revalidationCalls = vi.mocked(revalidateAuthenticatedUser).mock.calls.length;
    let release!: () => void;
    authFixture.pendingRevalidation = new Promise<void>(resolve => { release = resolve; });
    authFixture.revalidatedUser = { ...authFixture.user, homeAccountId: principalId, roles: ["AgentControl.Viewer"] };
    try {
      const viewerCookie = await roleCookie(principalId, ["AgentControl.Viewer"]);
      const application = await request("/api/hunting/jobs", {
        method: "POST", headers: { Cookie: viewerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ tokenMode: "application", filters }),
      });
      expect(application.status).toBe(403);
      await expect(application.json()).resolves.toMatchObject({ code: "hunting_scope_unqualified" });

      const response = await request("/api/hunting/jobs", {
        method: "POST", headers: { Cookie: viewerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ tokenMode: "delegated", filters }),
      });
      expect(response.status).toBe(202);
      const job = await response.json();
      assert(job !== null && typeof job === "object" && "id" in job && typeof job.id === "string");
      expect(job).toMatchObject({
        authorizationPrincipalId: principalId, tokenMode: "delegated",
        resultScope: { kind: "principal", scopeId: principalId },
        status: "running", activationCount: 1, providerRequestCount: 0,
        qualification: null, retainedScopeId: null,
      });
      await vi.waitFor(() => expect(vi.mocked(revalidateAuthenticatedUser).mock.calls.slice(revalidationCalls)
        .filter(([, accountId]) => accountId === principalId)).toHaveLength(1));
      expect(vi.mocked(acquireDelegatedToken).mock.calls).toHaveLength(tokenCalls);
      const cancelled = await request(`/api/hunting/jobs/${job.id}/cancel`, { method: "POST", headers: { Cookie: viewerCookie } });
      expect(cancelled.status).toBe(200);
      await expect(cancelled.json()).resolves.toMatchObject({ status: "cancelled", providerRequestCount: 0 });
    } finally {
      release();
      authFixture.pendingRevalidation = undefined;
      await defenderHunting.drain();
      authFixture.revalidatedUser = previousUser;
      csrfToken = previousCsrf;
    }
    expect(vi.mocked(acquireDelegatedToken).mock.calls).toHaveLength(tokenCalls);
  });
  it("returns a durable Audit Search activation while worker revalidation is pending", async () => {
    const previousUser = authFixture.revalidatedUser;
    const previousCsrf = csrfToken;
    csrfToken = "pending-audit-fixture-csrf";
    let release!: () => void;
    authFixture.pendingRevalidation = new Promise<void>(resolve => { release = resolve; });
    authFixture.revalidatedUser = { ...authFixture.user, homeAccountId: "prompt-audit-reader", roles: ["AgentControl.Viewer"] };
    const revalidationCalls = vi.mocked(revalidateAuthenticatedUser).mock.calls.length;
    const tokenCalls = vi.mocked(acquireDelegatedToken).mock.calls.length;
    try {
      const securityCookie = await roleCookie("prompt-audit-reader", ["AgentControl.Viewer"]);
      const response = await request("/api/audit-search/jobs", {
        method: "POST",
        headers: { Cookie: securityCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ tokenMode: "delegated", filters: {
          presetId: "copilot_interactions", operations: ["CopilotInteraction"], startDateTime: new Date(Date.now() - 30 * 60_000).toISOString(),
          endDateTime: new Date().toISOString(), userPrincipalNames: [], ipAddresses: [], objectIds: [], administrativeUnitIds: [],
        } }),
      });
      expect(response.status).toBe(202);
      const job = await response.json();
      assert(job !== null && typeof job === "object" && "id" in job && typeof job.id === "string");
      expect(job).toMatchObject({ status: "reconciling_create", activationCount: 1, providerRequestCount: 0 });
      await vi.waitFor(() => expect(vi.mocked(revalidateAuthenticatedUser).mock.calls.slice(revalidationCalls)
        .filter(([, accountId]) => accountId === "prompt-audit-reader")).toHaveLength(1));
      expect(vi.mocked(acquireDelegatedToken).mock.calls).toHaveLength(tokenCalls);
      expect((await request(`/api/audit-search/jobs/${job.id}/cancel`, { method: "POST", headers: { Cookie: securityCookie } })).status).toBe(200);
    } finally {
      release();
      authFixture.pendingRevalidation = undefined;
      await purviewAudit.drain();
      authFixture.revalidatedUser = previousUser;
      csrfToken = previousCsrf;
    }
  });
  it("consumes a mismatched callback state without redeeming it", async () => {
    const originalCookie=cookie;
    try {
      const login=await request("/api/auth/login");
      cookie=login.headers.get("set-cookie")!.split(";")[0];
      const redemptions=authFixture.redemptions;
      expect((await request("/api/auth/callback?code=fixture&state=wrong-state")).status).toBe(400);
      expect((await request("/api/auth/callback?code=fixture&state=fixture-state______________________________")).status).toBe(400);
      expect(authFixture.redemptions).toBe(redemptions);
    } finally { cookie=originalCookie; }
  });
  it("routes all mutation forms through durable idempotent jobs", async () => {
    const key=randomUUID();
    const confirmedBlock = await mutationPreview("block", ["package-1"], "single");
    expect(confirmedBlock).toMatchObject({ summary: { risk: true } });
    const single=await request("/api/agents/package-1/block",{method:"POST",headers:{"Idempotency-Key":key,"Content-Type":"application/json"},body:JSON.stringify(confirmedBlock)});
    expect(single.status).toBe(202); const job=await single.json();
    await publishPackageSnapshot("fixture-principal", undefined, config.tenants[0].tenantId, "Fixture", { isBlocked: true });
    try {
      expect((await (await request("/api/agents/package-1/block",{method:"POST",headers:{"Idempotency-Key":key,"Content-Type":"application/json"},body:JSON.stringify(confirmedBlock)})).json()).id).toBe(job.id);
      for (const changed of [
        ["/api/agents/package-1/unblock", { ...confirmedBlock }],
        ["/api/agents/block", { ids: ["different-package"], ...confirmedBlock }],
        ["/api/agents/block", { ids: ["package-1"], ...confirmedBlock }],
      ] as const) {
        expect((await request(changed[0],{method:"POST",headers:{"Idempotency-Key":key,"Content-Type":"application/json"},body:JSON.stringify(changed[1])})).status).toBe(409);
      }
    } finally {
      await publishPackageSnapshot("fixture-principal");
    }
    expect((await request(`/api/agents/bulk-jobs/${job.id}`)).status).toBe(200);
    await request(`/api/agents/bulk-jobs/${job.id}/cancel`,{method:"POST"});
    for (const endpoint of ["block","unblock","block-all","unblock-all"]) {
      const action = endpoint.startsWith("unblock") ? "unblock" : "block";
      const preview = await mutationPreview(action, ["package-1"], "bulk", endpoint.endsWith("-all"));
      const bulkKey=randomUUID();
      const headers={"Idempotency-Key":bulkKey,"Content-Type":"application/json"};
      const body=JSON.stringify(endpoint.endsWith("-all") ? { selectionId: preview.selectionId, confirmationHash: preview.confirmationHash } : {ids:["package-1"],...preview});
      const response=await request(`/api/agents/${endpoint}`,{method:"POST",headers,body});
      expect(response.status).toBe(202);
      const created=await response.json();
      expect(created.status).toBe("queued");
      const launches = vi.mocked(launchBulkJob).mock.calls.length;
      if (endpoint === "block-all") {
        await publishPackageSnapshot("fixture-principal", undefined, config.tenants[0].tenantId, "Fixture", null);
        expect((await request("/api/agents/block-all", { method: "POST", headers, body: JSON.stringify({ ids: ["different-package"], ...preview }) })).status).toBe(400);
      }
      expect((await (await request(`/api/agents/${endpoint}`,{method:"POST",headers,body})).json()).id).toBe(created.id);
      expect(vi.mocked(launchBulkJob).mock.calls.length).toBe(launches + 1);
      expect(launchBulkJob).toHaveBeenLastCalledWith(created.id, { tenantId: config.tenants[0].tenantId, principalId: "fixture-principal" });
      const repository = new JobRepository(fixture.runtime);
      expect(await repository.claim(created.id, { tenantId: config.tenants[0].tenantId!, principalId: "fixture-principal" }, randomUUID())).toBeDefined();
      const running = await request(`/api/agents/${endpoint}`, { method: "POST", headers, body });
      expect(running.status).toBe(202);
      expect(await running.json()).toMatchObject({ id: created.id, status: "running" });
      expect(vi.mocked(launchBulkJob).mock.calls.length).toBe(launches + 1);
      if (endpoint === "block-all") await publishPackageSnapshot("fixture-principal");
      await request(`/api/agents/bulk-jobs/${created.id}/cancel`,{method:"POST"});
    }
    expect(launchBulkJob).toHaveBeenCalled();
  });
  it("admits confirmed access intent while preserving role, CSRF and exact confirmation guards", async () => {
    try {
      await publishPackageSnapshot("fixture-principal", undefined, config.tenants[0].tenantId, "Fixture", { availableTo: "some", deployedTo: "none" });
      const intent = { action: "update-availability", ids: ["package-1"], mutationScope: "single", target: "availability", mode: "replace", scope: "none", principals: [] };
      const preview = await request("/api/agents/mutation-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(intent) });
      expect(preview.status).toBe(200);
      const confirmed = await preview.json();
      expect(confirmed.summary).toMatchObject({ risk: true, operation: "update-availability" });
      const body = JSON.stringify({ ...intent, confirmationHash: confirmed.confirmationHash });
      const headers = { "Content-Type": "application/json" };
      expect((await request("/api/agents/package-1/access", { method: "PATCH", headers: { ...headers, "x-csrf-token": "wrong" }, body })).status).toBe(403);
      expect((await request("/api/agents/package-1/access", { method: "PATCH", headers: { ...headers, Cookie: await roleCookie("testing-viewer", ["AgentControl.Viewer"]) }, body })).status).toBe(403);
      expect((await request("/api/agents/package-1/access", { method: "PATCH", headers, body: JSON.stringify({ ...intent, confirmationHash: "f".repeat(64) }) })).status).toBe(409);
      const accepted = await request("/api/agents/package-1/access", { method: "PATCH", headers, body });
      expect(accepted.status).toBe(202);
      const job = await accepted.json();
      expect(job).toMatchObject({ status: "queued", action: "update-availability" });
      await request(`/api/agents/bulk-jobs/${job.id}/cancel`, { method: "POST" });
    } finally {
      await publishPackageSnapshot("fixture-principal");
    }
  });

  it("executes both approved canary directions as separate durable jobs", async () => {
    const originalCookie = cookie;
    const previousUser = authFixture.revalidatedUser;
    const approvalBody = { targetId: "package-canary", action: "block", prestate: { kind: "block", isBlocked: false }, poststate: { kind: "block", isBlocked: true } };
    try {
      cookie = await roleCookie("approver", ["AgentControl.Admin"]);
      authFixture.revalidatedUser = { ...authFixture.user, homeAccountId: "approver" };
      expect((await request("/api/agents/mutation-canaries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...approvalBody, metadata: {} }) })).status).toBe(400);
      const originalResponse = await request("/api/agents/mutation-canaries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(approvalBody) });
      const restorationResponse = await request("/api/agents/mutation-canaries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...approvalBody, action: "unblock", prestate: approvalBody.poststate, poststate: approvalBody.prestate }) });
      expect(originalResponse.status).toBe(201);
      expect(restorationResponse.status).toBe(201);
      const approval = await originalResponse.json();
      const restorationApproval = await restorationResponse.json();
      expect(approval).toMatchObject({ status: "approved", targetId: "package-canary", approvedBy: { principalId: "approver" }, actor: null });
      expect(restorationApproval).toMatchObject({ status: "approved", action: "unblock", approvedBy: { principalId: "approver" } });

      cookie = await roleCookie("operator", ["AgentControl.Admin"]);
      authFixture.revalidatedUser = { tenantId: config.tenants[0].tenantId!, homeAccountId: "operator", displayName: "Operator", username: "operator@example.invalid", roles: ["AgentControl.Admin"] };
      const canaryDetails = (isBlocked: boolean) => allowlistedPackage({ id: "package-canary", displayName: "Canary", isBlocked });
      vi.mocked(GraphPackagesClient.prototype.getPackageDetails)
        .mockResolvedValueOnce(canaryDetails(false))
        .mockResolvedValueOnce(canaryDetails(false))
        .mockResolvedValueOnce(canaryDetails(true))
        .mockResolvedValueOnce(canaryDetails(true))
        .mockResolvedValueOnce(canaryDetails(true))
        .mockResolvedValueOnce(canaryDetails(false));
      const executed = await request(`/api/agents/mutation-canaries/${approval.id}/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true, restorationApprovalId: restorationApproval.id }) });
      expect(executed.status).toBe(200);
      const result = await executed.json();
      expect(result).toMatchObject({ status: "qualified", original: { status: "qualified", action: "block", actor: { principalId: "operator" } }, restoration: { status: "qualified", action: "unblock", actor: { principalId: "operator" } }, jobs: { originalId: expect.any(String), restorationId: expect.any(String) } });
      expect(GraphPackagesClient.prototype.blockPackage).toHaveBeenCalledTimes(1);
      expect(GraphPackagesClient.prototype.unblockPackage).toHaveBeenCalledTimes(1);
      expect((await fixture.operator.query("SELECT count(*)::int AS count FROM jobs WHERE id=ANY($1::uuid[])", [[result.jobs.originalId, result.jobs.restorationId]])).rows[0].count).toBe(2);
      expect((await fixture.operator.query("SELECT count(*)::int AS count FROM job_items WHERE job_id=ANY($1::uuid[]) AND status='succeeded' AND sent_at IS NOT NULL", [[result.jobs.originalId, result.jobs.restorationId]])).rows[0].count).toBe(2);
      expect((await fixture.operator.query("SELECT count(*)::int AS count FROM job_attempts WHERE job_id=ANY($1::uuid[]) AND outcome='succeeded' AND sent_at IS NOT NULL", [[result.jobs.originalId, result.jobs.restorationId]])).rows[0].count).toBe(2);
      expect(await readPackageControls(fixture.runtime, { tenantId: config.tenants[0].tenantId!, principalId: "operator" },
        ["package-canary"])).toEqual([expect.objectContaining({ detail: expect.objectContaining({ id: "package-canary", isBlocked: false }) })]);
      expect(await readPackageControls(fixture.runtime, { tenantId: config.tenants[0].tenantId!, principalId: "another-operator" },
        ["package-canary"])).toEqual([]);
      expect((await request(`/api/agents/mutation-canaries/${approval.id}/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true, restorationApprovalId: restorationApproval.id }) })).status).toBe(409);
      expect(GraphPackagesClient.prototype.blockPackage).toHaveBeenCalledTimes(1);
      expect(GraphPackagesClient.prototype.unblockPackage).toHaveBeenCalledTimes(1);
    } finally {
      authFixture.revalidatedUser = previousUser;
      cookie = originalCookie;
    }
  });
  it("never qualifies a forward canary whose restoration meets an external change", async () => {
    const originalCookie = cookie;
    const previousUser = authFixture.revalidatedUser;
    const approvalBody = { targetId: "package-canary-conflict", action: "block", prestate: { kind: "block", isBlocked: false }, poststate: { kind: "block", isBlocked: true } };
    const blocksBefore = vi.mocked(GraphPackagesClient.prototype.blockPackage).mock.calls.length;
    const unblocksBefore = vi.mocked(GraphPackagesClient.prototype.unblockPackage).mock.calls.length;
    try {
      cookie = await roleCookie("conflict-approver", ["AgentControl.Admin"]);
      authFixture.revalidatedUser = { ...authFixture.user, homeAccountId: "conflict-approver" };
      const originalResponse = await request("/api/agents/mutation-canaries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(approvalBody) });
      const restorationResponse = await request("/api/agents/mutation-canaries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...approvalBody, action: "unblock", prestate: approvalBody.poststate, poststate: approvalBody.prestate }) });
      expect(originalResponse.status).toBe(201);
      expect(restorationResponse.status).toBe(201);
      const original = await originalResponse.json();
      const restoration = await restorationResponse.json();
      cookie = await roleCookie("conflict-operator", ["AgentControl.Admin"]);
      authFixture.revalidatedUser = { tenantId: config.tenants[0].tenantId!, homeAccountId: "conflict-operator", displayName: "Conflict Operator", username: "conflict-operator@example.invalid", roles: ["AgentControl.Admin"] };
      const canaryDetails = (isBlocked: boolean) => allowlistedPackage({ id: approvalBody.targetId, displayName: "Canary", isBlocked });
      vi.mocked(GraphPackagesClient.prototype.getPackageDetails)
        .mockResolvedValueOnce(canaryDetails(false))
        .mockResolvedValueOnce(canaryDetails(false))
        .mockResolvedValueOnce(canaryDetails(true))
        .mockResolvedValueOnce(canaryDetails(false));
      const response = await request(`/api/agents/mutation-canaries/${original.id}/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true, restorationApprovalId: restoration.id }) });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "canary_cycle_incomplete" });
      expect(vi.mocked(GraphPackagesClient.prototype.blockPackage).mock.calls.length).toBe(blocksBefore + 1);
      expect(vi.mocked(GraphPackagesClient.prototype.unblockPackage).mock.calls.length).toBe(unblocksBefore);
      expect((await fixture.runtime.query("SELECT action,status FROM package_mutation_qualifications WHERE id=ANY($1::uuid[]) ORDER BY action", [[original.id, restoration.id]])).rows).toEqual([
        { action: "block", status: "restoration_conflict" }, { action: "unblock", status: "restoration_conflict" },
      ]);
      expect((await fixture.runtime.query("SELECT status FROM jobs WHERE id IN (SELECT job_id FROM package_mutation_qualifications WHERE id=ANY($1::uuid[])) ORDER BY created_at", [[original.id, restoration.id]])).rows).toEqual([
        { status: "succeeded" }, { status: "failed" },
      ]);
    } finally {
      authFixture.revalidatedUser = previousUser;
      cookie = originalCookie;
    }
  });
  it("retains Admin authority through reconciliation publication", async () => {
    const repository = new JobRepository(fixture.runtime);
    const owner = { tenantId: config.tenants[0].tenantId!, principalId: "fixture-principal" };
    const intent: JobIntentInput = { action: "block", targets: [{ id: "reconcile-role-loss", displayName: "Reconcile", prestate: { kind: "block", isBlocked: false } }], actor: authFixture.user, requestPath: "/api/agents/block", scope: "single" };
    const job = await repository.submit(owner, { ...intent, idempotencyKey: randomUUID(), confirmationHash: createJobConfirmation(intent).confirmationHash });
    const provider = {
      getPackageDetails: async () => ({ id: "reconcile-role-loss", displayName: "Reconcile", isBlocked: false }),
      blockPackage: async () => { throw new AppError(503, "ServiceUnavailable", "private-provider-message"); },
      unblockPackage: async () => undefined,
    } as unknown as GraphPackagesClient;
    await runBulkJob(job.id, owner, false, repository, provider, async () => "ephemeral-token");
    authFixture.revalidatedUser = { ...authFixture.user, roles: ["AgentControl.Viewer"] };
    try {
      expect((await request(`/api/agents/bulk-jobs/${job.id}/reconcile`, { method: "POST" })).status).toBe(403);
      expect(await repository.get(job.id, owner)).toMatchObject({ inconclusive: 1, reconciliationRequired: 1 });
      const outcome = await fixture.runtime.query("SELECT reconciliation_status FROM job_items WHERE job_id=$1", [job.id]);
      expect(outcome.rows).toEqual([{ reconciliation_status: "required" }]);
    } finally {
      authFixture.revalidatedUser = { tenantId: config.tenants[0].tenantId!, homeAccountId: "fixture-principal", displayName: "Fixture", username: "fixture@example.invalid", roles: ["AgentControl.Admin"] };
    }
  });
  it("requires same-origin mutations and isolates saved jobs by principal", async () => {
    const preview = await mutationPreview("block", ["package-1"], "single");
    const response=await request("/api/agents/package-1/block",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(preview)});
    const job=await response.json();
    expect((await request("/api/agents/package-1/block",{method:"POST",headers:{Origin:"https://unapproved.invalid","Content-Type":"application/json"},body:JSON.stringify(preview)})).status).toBe(403);
    const otherCookie=await roleCookie("other",["AgentControl.Admin"]);
    const mine=await request("/api/agents/bulk-jobs?limit=20");
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({value:expect.arrayContaining([expect.objectContaining({id:job.id})])});
    const metadata = await (await request(`/api/agents/bulk-jobs/${job.id}`)).json();
    expect(metadata).not.toHaveProperty("results");
    expect(metadata).not.toHaveProperty("result");
    const items = await request(`/api/agents/bulk-jobs/${job.id}/items?limit=1`);
    expect(items.status).toBe(200);
    expect(items.headers.get("cache-control")).toBe("private, no-store");
    expect(await items.json()).toMatchObject({ value: [{ id: "package-1" }], counts: { total: 1, filtered: 1 },
      revision: expect.any(String), page: { limit: 1, nextCursor: null, previousCursor: null } });
    const others=await request("/api/agents/bulk-jobs?limit=20",{headers:{Cookie:otherCookie}});
    expect(await others.json()).toEqual({value:[]});
    expect((await request(`/api/agents/bulk-jobs/${job.id}`,{headers:{Cookie:otherCookie}})).status).toBe(404);
    expect((await request(`/api/agents/bulk-jobs/${job.id}/items`,{headers:{Cookie:otherCookie}})).status).toBe(404);
    expect((await request(`/api/agents/bulk-jobs/${job.id}/cancel`,{method:"POST",headers:{Cookie:otherCookie}})).status).toBe(404);
  });
  it("returns one role-scoped minimized job projection without staged previews or item results", async () => {
    const response = await request("/api/workbench/jobs");
    expect(response.status).toBe(200);
    const body = await response.json() as { value: Array<Record<string, unknown>>; requestId: string; unavailableSources: unknown[] };
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    expect(body.value.length).toBeGreaterThan(0);
    for (const job of body.value) {
      expect(job).not.toHaveProperty("results");
      expect(job).not.toHaveProperty("confirmation");
      expect(job).not.toHaveProperty("filters");
      expect(job).not.toHaveProperty("reconciliation");
    }
    expect(JSON.stringify(body)).not.toContain("sensitive-user");
  });
  it("requires CSRF, gives Admin all Viewer reads, and denies unassigned users", async () => {
    expect((await request("/api/agents/package-1/block",{method:"POST",headers:{"x-csrf-token":"wrong"}})).status).toBe(403);
    const administratorCookie=await roleCookie("administrator",["AgentControl.Admin"]);
    await publishPackageSnapshot("administrator");
    expect((await request("/api/agents",{headers:{Cookie:administratorCookie}})).status).toBe(200);
    expect((await request("/api/audit/events",{headers:{Cookie:administratorCookie}})).status).toBe(200);
    const diagnostics=await request("/api/diagnostics",{headers:{Cookie:administratorCookie}});
    expect(diagnostics.status).toBe(200);
    expect(await diagnostics.json()).toEqual({
      authConfigured,maintenance:false,providerWorkEnabled:true,schemaFingerprint,
      limits:{databasePool:4,requestBodyBytes:524288,exportDeadlineSeconds:15},
    });
    const noRoleCookie=await roleCookie("unassigned",[]);
    const me=await request("/api/me",{headers:{Cookie:noRoleCookie}});
    expect(me.status).toBe(200);
    expect((await me.json()).roleAssignmentRequired).toBe(true);
    expect((await request("/api/capabilities",{headers:{Cookie:noRoleCookie}})).status).toBe(403);
    expect((await request("/api/capabilities/check-progress",{headers:{Cookie:noRoleCookie}})).status).toBe(403);
    expect((await request("/api/capabilities/check",{method:"POST",headers:{Cookie:noRoleCookie}})).status).toBe(403);
    expect((await request("/api/diagnostics",{headers:{Cookie:noRoleCookie}})).status).toBe(403);
    const viewerCookie = await roleCookie("viewer-no-write", ["AgentControl.Viewer"]);
    const beforeProgress = vi.mocked(capabilities.check).mock.calls.length;
    const progress = await request("/api/capabilities/check-progress?retry=failed", { headers: { Cookie: viewerCookie } });
    expect(progress.status).toBe(200);
    expect(progress.headers.get("cache-control")).toBe("no-store");
    expect(await progress.json()).toEqual({ progress: null });
    expect(capabilities.checkProgress).toHaveBeenLastCalledWith(expect.objectContaining({ homeAccountId: "viewer-no-write" }), true);
    expect(vi.mocked(capabilities.check).mock.calls).toHaveLength(beforeProgress);
    expect((await request("/api/capabilities/check-progress?retry=all", { headers: { Cookie: viewerCookie } })).status).toBe(400);
    expect((await request("/api/capabilities/check-progress?principalId=another-account", { headers: { Cookie: viewerCookie } })).status).toBe(400);
    expect((await request("/api/capabilities/check", { method: "POST", headers: { Cookie: viewerCookie, "x-csrf-token": "wrong" } })).status).toBe(403);
    expect((await request("/api/capabilities/check", { method: "POST", headers: { Cookie: viewerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ capabilityId: "graph.package.read.delegated" }) })).status).toBe(400);
    expect((await request("/api/capabilities/check", { method: "POST", headers: { Cookie: viewerCookie } })).status).toBe(200);
    expect((await request("/api/capabilities/check?retry=failed", { method: "POST", headers: { Cookie: viewerCookie } })).status).toBe(200);
    expect(capabilities.check).toHaveBeenLastCalledWith(expect.objectContaining({ homeAccountId: "viewer-no-write" }),
      { retryFailed: true, signal: expect.any(AbortSignal) });
    expect((await request("/api/capabilities/check?retry=failed", { method: "POST", headers: { Cookie: viewerCookie, "x-csrf-token": "wrong" } })).status).toBe(403);
    expect((await request("/api/capabilities/check?retry=all", { method: "POST", headers: { Cookie: viewerCookie } })).status).toBe(400);
    expect(vi.mocked(capabilities.check)).toHaveBeenCalledWith(expect.objectContaining({ homeAccountId: "viewer-no-write" }),
      { retryFailed: false, signal: expect.any(AbortSignal) });
    expect((await request("/api/agents/package-1/block", { method: "POST", headers: { Cookie: viewerCookie, "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await request("/api/official-usage/staging/not-owned", { method: "DELETE", headers: { Cookie: viewerCookie } })).status).toBe(403);
    const legacyCookie = await roleCookie("legacy-role-only", ["AgentControl.Reader" as AppRole]);
    expect((await request("/api/agents", { headers: { Cookie: legacyCookie } })).status).toBe(403);
  });
  it("allows Viewer and inherited Admin package reads including exact targets", async () => {
    const readerCookie=await roleCookie("reader",["AgentControl.Viewer"]);
    const operatorCookie=await roleCookie("operator",["AgentControl.Admin"]);
    await publishPackageSnapshot("reader");
    await publishPackageSnapshot("operator");
    const reader = await (await request("/api/agents",{headers:{Cookie:readerCookie}})).json();
    const operator = await (await request("/api/agents",{headers:{Cookie:operatorCookie}})).json();
    expect(reader.counts.total).toBe(1);
    expect(operator.counts.total).toBe(1);
    expect((await request("/api/agents/details",{method:"POST",headers:{Cookie:operatorCookie,"Content-Type":"application/json"},
      body:JSON.stringify({ids:["package-1"]})})).status).toBe(404);
    const viewerExact = await request(`/api/agents/package-1/detail?selectionId=${reader.selection.id}`,{headers:{Cookie:readerCookie}});
    expect(viewerExact.status).toBe(200);
    expect(await viewerExact.json()).toMatchObject({id:"package-1",allowedUsersAndGroups:[{resourceId:"sensitive-user"}]});
    const exact=await request(`/api/agents/package-1/detail?selectionId=${operator.selection.id}`,{headers:{Cookie:operatorCookie}});
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({id:"package-1",allowedUsersAndGroups:[{resourceId:"sensitive-user"}]});
  });
  it("isolates inventory, audit, exports, and logout when two tenants use the same account and provider IDs", async () => {
    const principalId = "overlapping-tenant-http-account";
    const tenantA = config.tenants[0];
    const tenantB = config.tenants[1];
    const cookieA = await roleCookie(principalId, ["AgentControl.Admin"], Date.now(), tenantA);
    const cookieB = await roleCookie(principalId, ["AgentControl.Admin"], Date.now(), tenantB);
    const snapshotA = await publishPackageSnapshot(principalId, undefined, tenantA.tenantId, "Tenant A only");
    const snapshotB = await publishPackageSnapshot(principalId, undefined, tenantB.tenantId, "Tenant B only");
    const events = [];
    for (const tenant of [tenantA, tenantB]) {
      events.push(await new AuditLog({ tenantId: tenant.tenantId, principalId }, fixture.runtime).startEvent({
        operationId: "same-operation-id", scope: "single", action: "block", targetBlockedState: true,
        agentId: "package-1", actor: { tenantId: tenant.tenantId, homeAccountId: principalId,
          displayName: tenant.tenantId === tenantA.tenantId ? "Tenant A actor" : "Tenant B actor",
          username: `${principalId}@${tenant.domains[0]}` }, requestPath: "/fixture",
      }));
    }
    for (const [tenantCookie, name, event] of [
      [cookieA, "Tenant A only", events[0]], [cookieB, "Tenant B only", events[1]],
    ] as const) {
      const selected = await inventoryPage(tenantCookie);
      const exact = await request(`/api/agents/package-1/detail?selectionId=${selected.selection.id}`, { headers: { Cookie: tenantCookie } });
      expect(exact.status).toBe(200);
      expect(await exact.json()).toMatchObject({ id: "package-1", displayName: name });
      const listed = await request("/api/agents", { headers: { Cookie: tenantCookie } });
      expect(await listed.json()).toMatchObject({ counts: { total: 1 }, value: [{ id: "package-1", displayName: name }] });
      const audit = await request("/api/audit/events?agentId=package-1", { headers: { Cookie: tenantCookie } });
      expect(await audit.json()).toMatchObject({ count: 1, value: [{ id: event.id }] });
    }
    const foreignSelection = await inventoryPage(cookieB);
    const foreignSnapshot = await request("/api/data-exports", {
      method: "POST", headers: { Cookie: cookieA, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "graph_packages", selectionId: foreignSelection.selection.id }),
    });
    expect(foreignSnapshot.status).toBe(409);
    expect(await foreignSnapshot.json()).toMatchObject({ code: "selection_invalidated" });
    expect(snapshotA).not.toBe(snapshotB);
    const foreignAudit = await request("/api/audit/events/export.csv", {
      method: "POST", headers: { Cookie: cookieB, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [events[0].id] }),
    });
    expect(foreignAudit.status).toBe(404);
    expect((await request("/api/auth/logout", { method: "POST", headers: { Cookie: cookieA } })).status).toBe(204);
    expect((await request("/api/me", { headers: { Cookie: cookieA } })).status).toBe(401);
    const unaffected = await request("/api/me", { headers: { Cookie: cookieB } });
    expect(unaffected.status).toBe(200);
    expect(await unaffected.json()).toMatchObject({ user: { tenantId: tenantB.tenantId, homeAccountId: principalId } });
  });
  it("exports only exact authorized package rows with snapshot provenance, formula safety and row-free audit", async () => {
    const principalId="package-export-reader";
    const readerCookie=await roleCookie(principalId,["AgentControl.Viewer"]);
    const snapshotId=await publishPackageSnapshot(principalId, undefined, config.tenants[0].tenantId, "Fixture", { publisher: "=formula" });
    const selected = await inventoryPage(readerCookie);
    const response=await inventoryExport(readerCookie, selected.selection.id, "graph_packages", ["package-1"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const rows=parseCsv(await response.text(),{bom:true,columns:true});
    expect(rows.filter((row: Record<string, string>) => row.recordType === "source"))
      .toEqual([expect.objectContaining({id:"package-1",publisher:"'=formula",sourceSystem:"graph_packages",snapshotId})]);
    expect(JSON.stringify(rows)).not.toContain("sensitive-user");
    const audit=await request("/api/audit/events?action=export-package-inventory",{headers:{Cookie:readerCookie}});
    expect(audit.status).toBe(200);
    const auditBody=await audit.json() as {value:Array<{action:string;metadata?:Record<string,unknown>}>};
    expect(auditBody.value.length).toBeGreaterThanOrEqual(1);
    expect(auditBody.value.every(event => event.action === "export-package-inventory")).toBe(true);
    expect(JSON.stringify(auditBody)).not.toContain("=formula");
    expect(JSON.stringify(auditBody)).not.toContain("sensitive-user");
    const operatorCookie=await roleCookie(principalId,["AgentControl.Admin"]);
    const adminSelection = await inventoryPage(operatorCookie);
    expect((await inventoryExport(operatorCookie, adminSelection.selection.id, "graph_packages", ["package-1"])).status).toBe(200);
    await publishPackageSnapshot(principalId);
    const pinned = await inventoryExport(readerCookie, selected.selection.id, "graph_packages", ["package-1"]);
    expect(pinned.status).toBe(200);
    expect(await pinned.text()).toContain("'=formula");
  });
  it("reads private responsibility with Viewer access, outside paid rosters, without provider reads or ownership-based authority", async () => {
    const principalId = "responsibility-reader";
    const objectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const scope = { tenantId: config.tenants[0].tenantId!, principalId };
    const readerCookie = await roleCookie(principalId, ["AgentControl.Viewer"]);
    await publishQuarantineInventory(principalId, objectId);
    const cache = new AgentPeopleRepository(fixture.runtime);
    await cache.save(scope, [{ objectId, displayName: "Responsibility only", userPrincipalName: "responsibility@example.invalid",
      status: "resolved", checkedAt: new Date().toISOString() }], { generation: await cache.generation(scope) });
    const platformReads = inventoryProviderFixture.queries;
    const graphReads = vi.mocked(GraphPackagesClient.prototype.getPackageDetails).mock.calls.length;
    const tokenReads = vi.mocked(acquireDelegatedToken).mock.calls.length;
    const response = await request(`/api/agent-responsibility?objectId=${objectId}`, { headers: { Cookie: readerCookie } });
    expect(response.status).toBe(200);
    const result = await response.json() as { selection: { id: string }; selected: { agents: Array<{ id: string }> } };
    expect(result).toMatchObject({ selected: { person: { evidence: { displayName: "Responsibility only" } },
      count: 1, agents: [{ roles: ["owner"], presence: "power_platform" }] } });
    expect(result.selected.agents[0].id).toMatch(/^agent:/);
    const exact = await request(`/api/agent-inventory/${encodeURIComponent(result.selected.agents[0].id)}/detail?selectionId=${result.selection.id}`, { headers: { Cookie: readerCookie } });
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ id: result.selected.agents[0].id });
    expect(inventoryProviderFixture.queries).toBe(platformReads);
    expect(GraphPackagesClient.prototype.getPackageDetails).toHaveBeenCalledTimes(graphReads);
    expect(acquireDelegatedToken).toHaveBeenCalledTimes(tokenReads);
    const other = await roleCookie("responsibility-other", ["AgentControl.Viewer"]);
    const otherResult = await request(`/api/agent-responsibility?objectId=${objectId}`, { headers: { Cookie: other } });
    expect(otherResult.status).toBe(409);
    expect(await otherResult.json()).toMatchObject({ code: "inventory_unavailable" });
    expect((await request("/api/agent-responsibility?principalId=responsibility-reader", { headers: { Cookie: other } })).status).toBe(400);
    const unassigned = await roleCookie(principalId, []);
    expect((await request("/api/agent-responsibility", { headers: { Cookie: unassigned } })).status).toBe(403);
    expect((await request("/api/agent-responsibility", { headers: { Cookie: "" } })).status).toBe(401);
  });
  it("exports the authorized unified inventory with revision, environment filtering, source aliases and row-free audit", async () => {
    const principalId = "unified-export-reader";
    const readerCookie = await roleCookie(principalId, ["AgentControl.Viewer"]);
    await publishPackageSnapshot(principalId);
    await publishQuarantineInventory(principalId);
    const graphReads = vi.mocked(GraphPackagesClient.prototype.getPackageDetails).mock.calls.length;
    const platformReads = inventoryProviderFixture.queries;
    const saved = await request("/api/agent-inventory?limit=1", { headers: { Cookie: readerCookie } });
    expect(saved.status).toBe(200);
    const page = await saved.json();
    expect(page.counts.total).toBe(2);
    expect(page).toMatchObject({
      partial: false,
      sources: { powerPlatform: { state: "available", observation: { roleScope: "unknown", verification: { status: "verified", storedCount: 1 } } } },
      verification: {
        status: "details_pending", scope: "authorized_saved_sources", graphPackageCount: 1, powerPlatformAgentCount: 1,
        representedSourceCount: 2, uniqueSourceCount: 2, logicalAgentCount: 2,
        checks: { sourceScopes: true, packageMetadata: false, sourceMemberships: true },
      },
    });
    expect(page.value).toHaveLength(1);
    expect(page.selection.id).toMatch(/^[a-f0-9-]{36}$/);
    const exportRequest = (body: unknown, selectedCookie = readerCookie) => request("/api/data-exports", {
      method: "POST", headers: { Cookie: selectedCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "unified_agents", selectionId: page.selection.id, ...body as object }),
    });
    const all = await inventoryExport(readerCookie, page.selection.id, "unified_agents");
    expect(all.status).toBe(200);
    expect(all.headers.get("content-disposition")).toContain("attachment;");
    expect(all.headers.get("cache-control")).toContain("no-store");
    const allRows = parseCsv(await all.text(), { bom: true, columns: true });
    const agents = allRows.filter((row: Record<string, string>) => row.recordType === "agent");
    expect(agents).toHaveLength(2);
    expect(agents.every((row: Record<string, string>) => row.inventoryVerificationStatus === "details_pending"
      && row.inventorySourceCount === "2" && row.inventoryUniqueSourceCount === "2")).toBe(true);
    expect(JSON.stringify(allRows)).not.toContain("sensitive-user");
    const filteredPage = await inventoryPage(readerCookie, new URLSearchParams({
      environmentId: encodeInventoryFacet("11111111-1111-4111-8111-111111111111"),
    }).toString());
    const filtered = await inventoryExport(readerCookie, filteredPage.selection.id, "unified_agents");
    expect(filtered.status).toBe(200);
    expect(parseCsv(await filtered.text(), { bom: true, columns: true }).filter((row: Record<string, string>) => row.recordType === "agent")).toEqual([
      expect.objectContaining({ nativeResourceId: "native-agent", packageIds: "[]" }),
    ]);
    const exact = await (await request(`/api/agent-inventory/graph_packages:package-1/detail?selectionId=${page.selection.id}`,
      { headers: { Cookie: readerCookie } })).json();
    const selected = await inventoryExport(readerCookie, page.selection.id, "unified_agents", ["graph_packages:package-1", exact.id]);
    expect(selected.status).toBe(200);
    expect(parseCsv(await selected.text(), { bom: true, columns: true }).filter((row: Record<string, string>) => row.recordType === "agent")).toEqual([
      expect.objectContaining({ packageIds: '["package-1"]', inventoryRevision: page.selection.revision }),
    ]);
    const missing = await exportRequest({ ids: ["graph_packages:absent"] });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: "export_selection_changed" });
    const foreignCookie = await roleCookie("unified-export-foreign", ["AgentControl.Viewer"]);
    expect((await exportRequest({}, foreignCookie)).status).toBe(409);
    const audit = await request("/api/audit/events?action=export-agent-inventory", { headers: { Cookie: readerCookie } });
    expect(audit.status).toBe(200);
    const events = await audit.json() as { value: Array<{ status: string; metadata: Record<string, unknown> }> };
    expect(events.value.filter(event => event.status === "succeeded")).toHaveLength(6);
    expect(JSON.stringify(events)).not.toContain("sensitive-user");
    expect(events.value.every(event => Number(event.metadata.rowCount) >= 1)).toBe(true);
    expect(vi.mocked(GraphPackagesClient.prototype.getPackageDetails).mock.calls.length).toBe(graphReads);
    expect(inventoryProviderFixture.queries).toBe(platformReads);
    expect((await request("/api/data-exports", {
      method: "POST", headers: { Cookie: readerCookie, "x-csrf-token": "wrong", "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "unified_agents", selectionId: page.selection.id }),
    })).status).toBe(403);
    const unassigned = await roleCookie("unified-export-unassigned", []);
    expect((await exportRequest({}, unassigned)).status).toBe(403);
    expect((await exportRequest({}, "")).status).toBe(401);
  });

  it.each(["role", "session", "expiry", "cancelled", "exact-overlay", "environment", "filter-source"] as const)(
    "revalidates durable download after %s changes without confusing safe refresh with authority loss", async change => {
      const principalId = `unified-export-race-${change}`;
      const readerCookie = await roleCookie(principalId, ["AgentControl.Viewer"]);
      await publishPackageSnapshot(principalId);
      const scope = { tenantId: config.tenants[0].tenantId!, principalId };
      if (change === "filter-source") await new AuditLog(scope, fixture.runtime).startEvent({
        operationId: "abcd1234-source", scope: "bulk", action: "block", targetBlockedState: true, agentId: "package-1",
        actor: { tenantId: config.tenants[0].tenantId!, homeAccountId: principalId, displayName: "Fixture", username: "fixture@example.invalid" },
        requestPath: "/fixture",
      });
      const page = await inventoryPage(readerCookie, change === "filter-source" ? "operationIdPrefix=abcd1234" : "");
      const id = await createInventoryExport(readerCookie, page.selection.id, "unified_agents");
      if (change === "role") await fixture.operator.query(
        "UPDATE sessions SET sess=jsonb_set(sess::jsonb,'{user,roles}','[]'::jsonb) WHERE principal_id=$1", [principalId]);
      else if (change === "session") await fixture.operator.query("DELETE FROM sessions WHERE principal_id=$1", [principalId]);
      else if (change === "expiry") await fixture.operator.query(
        "UPDATE data_exports SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
      else if (change === "cancelled") expect((await request(`/api/data-exports/${id}`, { method: "DELETE", headers: { Cookie: readerCookie } })).status).toBe(204);
      else if (change === "exact-overlay") await publishPackageSnapshot(principalId, ["package-1"], scope.tenantId, "Newer provider name");
      else if (change === "filter-source") await fixture.operator.query("DELETE FROM audit_events WHERE principal_id=$1 AND action='block'", [principalId]);
      else await publishQuarantineInventory(principalId);
      const exported = await request(`/api/data-exports/${id}/download`, { headers: { Cookie: readerCookie } });
      if (change === "exact-overlay" || change === "environment") {
        expect(exported.status).toBe(200);
        const rows = parseCsv(await exported.text(), { columns: true, bom: true });
        expect(rows.filter((row: Record<string, string>) => row.recordType === "agent"))
          .toMatchObject([{ displayName: "Fixture", packageIds: '["package-1"]' }]);
      } else {
        expect(exported.status).toBe(change === "role" ? 403 : change === "session" ? 401 : 409);
        expect(exported.headers.get("content-type")).toContain("application/problem+json");
        expect(await exported.text()).not.toContain("package-1");
      }
    });

  it.each(["agents", "inventory", "agent-inventory"])("does not restore retired %s CSV routes or create an export from them", async source => {
    const before = (await fixture.runtime.query("SELECT count(*)::int AS count FROM data_exports")).rows[0].count;
    for (const method of ["GET", "POST"]) {
      const result = await request(`/api/${source}/export.csv`, { method,
        ...method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {} });
      expect(result.status).toBe(404);
      expect(result.headers.get("content-type")).not.toContain("text/csv");
      expect(await result.text()).not.toContain("package-1");
    }
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM data_exports")).rows[0].count).toBe(before);
  });

  it("allows Viewer audit-reference filters while preserving principal scope", async () => {
    const principalId = "inventory-audit-filter";
    const readerCookie = await roleCookie(principalId, ["AgentControl.Viewer"]);
    await publishPackageSnapshot(principalId);
    const audit = new AuditLog({ tenantId: config.tenants[0].tenantId!, principalId }, fixture.runtime);
    await audit.startEvent({ operationId: "abcd1234-own-action", scope: "bulk", action: "block", targetBlockedState: true,
      agentId: "package-1", actor: { tenantId: config.tenants[0].tenantId!, homeAccountId: principalId, displayName: "Fixture", username: "fixture@example.invalid" },
      requestPath: "/fixture" });
    expect((await request("/api/agents?operationIdPrefix=abcd1234", { headers: { Cookie: readerCookie } })).status).toBe(200);
    const selection = await inventoryPage(readerCookie, "operationIdPrefix=abcd1234");
    expect((await inventoryExport(readerCookie, selection.selection.id, "graph_packages")).status).toBe(200);
    const result = await request("/api/agents?operationIdPrefix=abcd1234", { headers: { Cookie: readerCookie } });
    expect(await result.json()).toMatchObject({ counts: { total: 1, filtered: 1 }, value: [{ id: "package-1" }] });
    const otherId = "inventory-audit-filter-other";
    await publishPackageSnapshot(otherId);
    const otherCookie = await roleCookie(otherId, ["AgentControl.Viewer"]);
    expect(await (await request("/api/agents?operationIdPrefix=abcd1234", { headers: { Cookie: otherCookie } })).json())
      .toMatchObject({ counts: { total: 1, filtered: 0 }, value: [] });
  });

  it("exports only current scoped administrative events and rechecks deletion before publication", async () => {
    const principalId = "administrative-export";
    const audit = new AuditLog({ tenantId: config.tenants[0].tenantId!, principalId }, fixture.runtime);
    const event = await audit.startEvent({ operationId: "local-export-target", scope: "single", action: "block", targetBlockedState: true,
      agentId: "package-1", actor: { tenantId: config.tenants[0].tenantId!, homeAccountId: principalId, displayName: "=Formula", username: "fixture@example.invalid" },
      requestPath: "/fixture", message: "private selected audit message" });
    const exportRequest = (selectedCookie: string) => request("/api/audit/events/export.csv", {
      method: "POST", headers: { Cookie: selectedCookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [event.id] }),
    });
    const securityCookie = await roleCookie(principalId, ["AgentControl.Viewer"]);
    const exported = await exportRequest(securityCookie);
    expect(exported.status).toBe(200);
    const rows = parseCsv(await exported.text(), { bom: true, columns: true });
    expect(rows).toEqual([expect.objectContaining({ eventId: event.id, sourceSystem: "local_administrative_audit", actorName: "'=Formula" })]);
    const auditRecords = await audit.listEvents({ action: "export-administrative-audit" });
    expect(auditRecords).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ resultingCount: 1 }), status: "succeeded" })]);
    expect(JSON.stringify(auditRecords)).not.toContain("private selected audit message");
    const otherCookie = await roleCookie("administrative-export-other", ["AgentControl.Viewer"]);
    expect((await exportRequest(otherCookie)).status).toBe(404);
    const readerCookie = await roleCookie(principalId, ["AgentControl.Viewer"]);
    expect((await exportRequest(readerCookie)).status).toBe(200);
    const complete = AuditLog.prototype.completeEvent;
    const completion = vi.spyOn(AuditLog.prototype, "completeEvent").mockImplementation(async function (id, update) {
      const result = await complete.call(this, id, update);
      if (result.action === "export-administrative-audit" && result.status === "succeeded") {
        await fixture.operator.query("DELETE FROM audit_events WHERE event_id=$1", [event.id]);
      }
      return result;
    });
    try {
      const deleted = await exportRequest(securityCookie);
      expect(deleted.status).toBe(409);
      expect(await deleted.text()).not.toContain("private selected audit message");
    } finally { completion.mockRestore(); }
  });

  it("projects source-aware detail only after exact source scope and identifier checks", async () => {
    const principalId = "source-detail-reader";
    const snapshotId = await publishQuarantineInventory(principalId);
    const repository = new PurviewAuditRepository(fixture.runtime);
    const scope = { tenantId: config.tenants[0].tenantId!, authorizationPrincipalId: principalId,
      resultScope: { kind: "principal" as const, scopeId: principalId, configurationRevision: null }, tokenMode: "delegated" as const };
    const filters = { presetId: "copilot_studio_admin" as const, operations: ["BotCreate"], startDateTime: "2026-09-09T10:00:00.000Z",
      endDateTime: "2026-09-09T11:00:00.000Z", userPrincipalNames: [], ipAddresses: [], objectIds: [], administrativeUnitIds: [] };
    const job = await repository.submit(scope, { idempotencyKey: "source-detail-audit", filters });
    const execution = await repository.begin(scope, job.id);
    await repository.authorizeProviderRequest(scope, job.id, execution);
    await repository.recordProviderQuery(scope, job.id, execution, "source-detail-provider", "succeeded");
    await repository.publish(scope, job.id, execution, { records: [{
      projectionVersion: 1, wrapperId: "source-detail-wrapper", nativeEventId: "88888888-8888-4888-8888-888888888888",
      eventDateTime: "2026-09-09T10:30:00.000Z", auditLogRecordType: "powerPlatformAdministratorActivity", operation: "BotCreate",
      service: "PowerPlatform", resultStatus: "Succeeded", actorUserId: "actor", actorUserPrincipalName: null, actorUserType: null,
      objectId: null, clientIp: null, administrativeUnits: [], correlationId: "source-detail-correlation", agentId: null,
      appIdentity: null, appHost: null, botId: "22222222-2222-4222-8222-222222222222",
      environmentId: "11111111-1111-4111-8111-111111111111", botComponentId: null, aiPluginOperationId: null,
      messages: [], contentAvailable: false, unknownFieldCount: 0,
    }], pageCount: 1, providerRowCount: 1, storedRowCount: 1, byteCount: 512, unknownFieldCount: 0, complete: true, nextLink: null, partialReason: null });
    const path = `/api/inventory/resources/native-agent/related?snapshotId=${snapshotId}&environmentId=11111111-1111-4111-8111-111111111111`;
    const readerOnly = await roleCookie(principalId, ["AgentControl.Viewer"]);
    const permitted = await request(path, { headers: { Cookie: readerOnly } });
    expect(permitted.status).toBe(200);
    expect(await permitted.json()).toMatchObject({
      snapshotId, nativeId: "native-agent",
      audit: { status: "available", count: 1, value: [{ jobId: job.id, nativeEventId: "88888888-8888-4888-8888-888888888888", matchedKind: "cds_bot_id" }] },
      security: { status: "unmatched" },
    });
    const otherReader = await roleCookie("source-detail-other", ["AgentControl.Viewer"]);
    expect((await request(path, { headers: { Cookie: otherReader } })).status).toBe(409);
  });
  it("reads authorized saved audit data during provider outage", async () => {
    const securityReaderCookie=await roleCookie("security-reader",["AgentControl.Viewer"]);
    vi.mocked(capabilities.requireAvailable).mockRejectedValue(new AppError(502,"provider_error","provider unavailable"));
    try {
      const response=await request("/api/audit/events",{headers:{Cookie:securityReaderCookie}});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({value:[],count:0});
    } finally { vi.mocked(capabilities.requireAvailable).mockResolvedValue(undefined); }
  });
  it("enforces inventory role, CSRF and private job/snapshot/export scope without live GET reads", async () => {
    const principalId="inventory-reader";
    const readerCookie=await roleCookie(principalId,["AgentControl.Viewer"]);
    const repository=new PowerPlatformRefreshJobs(fixture.runtime);
    const inventoryScope={tenantId:config.tenants[0].tenantId!,principalId};
    const job=await repository.submit(inventoryScope,{idempotencyKey:"route-inventory",roleScope:"full",requestedTypes:["microsoft.copilotstudio/agents"]});
    await repository.markRunning(inventoryScope,job.id);
    const malicious:PowerPlatformResource={
      tenantId:config.tenants[0].tenantId!,nativeId:"@native",type:"microsoft.copilotstudio/agents",location:null,displayName:"=SUM(1,1)",environmentId:"environment-a",
      createdAt:null,createdBy:null,lastPublishedAt:null,sourceSystem:"power_platform",authoringTool:null,creatorType:"unknown",agentKind:"agent",lifecycle:"draft",
      identityConfidence:"exact_native",identifiers:[{kind:"power_platform_resource_id",value:"@native"}],
      provenance:{connectors:{sourceSystem:"power_platform",path:"properties.powerPlatformConnectors",maturity:"preview"}},
      details:{
        ownerId:"owner-id",lastModifiedBy:"modifier-id",connectorDetailsStatus:"partial",
        distinctPowerPlatformConnectors:1,distinctPowerPlatformConnectorsOperations:2,
        connectors:[{connectorId:"shared_test",operations:[{
          operationId:"read",isEnabled:false,requiresEndUserConsent:false,createdBy:"52bff06b-5db5-42cd-9919-28f95e3c07af",
          ...{connectionIdSharedByMaker:"private-connection",callbackUrl:"https://private.invalid"},
        }]}],
      },unknownFieldCount:0,
    };
    await refreshInventoryFixture(fixture.runtime, inventoryScope, job.id, "power_platform",
      [powerPlatformInventoryRecord(malicious)], ["microsoft.copilotstudio/agents"]);
    const snapshotId=(await repository.getJob(inventoryScope,job.id))!.snapshotId!;
    vi.mocked(capabilities.requireAvailable).mockRejectedValue(new AppError(502,"provider_error","provider unavailable"));
    try {
      for (const path of ["/api/inventory/resources","/api/inventory/snapshots","/api/quarantine/targets"]) {
        expect((await request(path,{headers:{Cookie:readerCookie}})).status).toBe(404);
      }
      expect((await request("/api/inventory/refresh-jobs",{headers:{Cookie:readerCookie}})).status).toBe(200);
      expect((await request("/api/inventory/export.csv",{headers:{Cookie:readerCookie}})).status).toBe(404);
      const resources=await (await request(`/api/inventory/quarantine-selection?snapshotId=${snapshotId}&selected=%40native`,{headers:{Cookie:readerCookie}})).json();
      expect(resources).toMatchObject({value:[{nativeId:"@native"}],snapshot:{id:snapshotId}});
      const selection = await inventoryPage(readerCookie);
      const csv=await (await inventoryExport(readerCookie, selection.selection.id, "power_platform_agents")).text();
      expect(csv.split("\r\n")[0]).toContain("sourceSystem");
      expect(csv).toContain("\"power_platform\"");
      expect(csv).toContain("\"'@native\"");
      expect(csv).toContain("\"'=SUM(1,1)\"");
      const exportedRows = parseCsv(csv, { columns: true, bom: true }) as Array<Record<string, string>>;
      const exported = exportedRows.find(row => row.recordType === "source");
      expect(exported).toMatchObject({
        ownerId: "owner-id", lastModifiedBy: "modifier-id", connectorDetailsStatus: "partial",
        reportedConnectorTotal: "1", reportedOperationTotal: "2", savedConnectorDetails: "1", savedOperationDetails: "1",
        invokedFlowContext: "unavailable_from_synced_sources",
      });
      expect(JSON.parse(exportedRows.find(row => row.childKind === "connectorOperation")!.childData).payload).toMatchObject({
        isEnabled: false, requiresEndUserConsent: false, createdBy: "52bff06b-5db5-42cd-9919-28f95e3c07af",
      });
      expect(csv).not.toMatch(/private-connection|private.invalid/);

      expect((await request("/api/inventory/refresh-jobs",{method:"POST",headers:{Cookie:readerCookie,"x-csrf-token":"wrong","Content-Type":"application/json"},body:"{}"})).status).toBe(403);
      expect((await request(`/api/inventory/refresh-jobs/${job.id}/resume`,{method:"POST",headers:{Cookie:readerCookie,"x-csrf-token":"wrong"}})).status).toBe(403);
      const adminReader = await roleCookie(principalId, ["AgentControl.Admin"]);
      const adminSelection = await inventoryPage(adminReader);
      expect((await inventoryExport(adminReader, adminSelection.selection.id, "power_platform_agents")).status).toBe(200);
      const unassigned = await roleCookie("inventory-unassigned", []);
      for (const path of ["/api/inventory/quarantine-selection","/api/inventory/refresh-jobs"]) expect((await request(path,{headers:{Cookie:unassigned}})).status).toBe(403);
      expect((await request("/api/data-exports", { method: "POST", headers: { Cookie: unassigned, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "power_platform_agents", selectionId: selection.selection.id }) })).status).toBe(403);

      const otherReader=await roleCookie("inventory-other",["AgentControl.Viewer"]);
      expect((await request(`/api/inventory/refresh-jobs/${job.id}`,{headers:{Cookie:otherReader}})).status).toBe(404);
      expect((await request(`/api/inventory/quarantine-selection?snapshotId=${snapshotId}&selected=%40native`,{headers:{Cookie:otherReader}})).status).toBe(409);
      expect((await request("/api/data-exports", { method: "POST", headers: { Cookie: otherReader, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "power_platform_agents", selectionId: selection.selection.id }) })).status).toBe(409);
      expect(await (await request("/api/inventory/refresh-jobs",{headers:{Cookie:otherReader}})).json()).toMatchObject({value:[]});
    } finally { vi.mocked(capabilities.requireAvailable).mockResolvedValue(undefined); }
  });
  it("allows Viewer quarantine reads while keeping controls and canaries Admin-only", async () => {
    const originalCookie = cookie;
    const principalId = "quarantine-operator";
    const operatorCookie = await roleCookie(principalId, ["AgentControl.Admin"]);
    const snapshotId = await publishQuarantineInventory(principalId);
    const otherOperatorCookie = await roleCookie("quarantine-other", ["AgentControl.Admin"]);
    const administratorCookie = await roleCookie(principalId, ["AgentControl.Admin"]);
    const securityReaderCookie = await roleCookie(principalId, ["AgentControl.Viewer"]);
    authFixture.revalidatedUser = { tenantId: config.tenants[0].tenantId!, homeAccountId: principalId, displayName: "Quarantine operator", username: "quarantine-operator@example.invalid", roles: ["AgentControl.Admin"] };
    const providerReads = vi.mocked(CopilotStudioQuarantineClient.prototype.getStatus).mock.calls.length;
    try {
      const targetList = await request(`/api/inventory/quarantine-selection?snapshotId=${snapshotId}&selected=native-agent`, { headers: { Cookie: operatorCookie } });
      expect(targetList.status).toBe(200);
      const targetPage = await targetList.json();
      expect(targetPage).toMatchObject({ snapshot: { id: snapshotId }, value: [{ nativeId: "native-agent", environmentId: "11111111-1111-4111-8111-111111111111" }] });
      expect((await request(`/api/inventory/quarantine-selection?snapshotId=${snapshotId}&selected=native-agent`, { headers: { Cookie: otherOperatorCookie } })).status).toBe(409);
      expect(vi.mocked(CopilotStudioQuarantineClient.prototype.getStatus).mock.calls.length).toBe(providerReads);
      expect((await request(`/api/quarantine/status?snapshotId=${snapshotId}&nativeId=native-agent`, { headers: { Cookie: securityReaderCookie } })).status).toBe(200);
      expect((await request("/api/quarantine/status?snapshotId=not-a-uuid&nativeId=native-agent", { headers: { Cookie: operatorCookie } })).status).toBe(400);
      expect(vi.mocked(CopilotStudioQuarantineClient.prototype.getStatus).mock.calls.length).toBe(providerReads + 1);

      const status = await request(`/api/quarantine/status?snapshotId=${snapshotId}&nativeId=native-agent`, { headers: { Cookie: operatorCookie } });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ target: { resourceNativeId: "native-agent", environmentId: "11111111-1111-4111-8111-111111111111", botId: "22222222-2222-4222-8222-222222222222" },
        direct: { isBotQuarantined: false, providerUpdatedAt: "2026-09-09T10:00:00.123Z" }, inventory: { isQuarantined: true, snapshotId }, disagreesWithInventory: true });
      const isolated = await request(`/api/quarantine/status?snapshotId=${snapshotId}&nativeId=native-agent`, { headers: { Cookie: otherOperatorCookie } });
      expect(isolated.status).toBe(409);
      expect(await isolated.json()).toMatchObject({ code: "quarantine_target_unavailable" });

      expect((await request("/api/quarantine/preview", { method: "POST", headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "quarantine", snapshotId, resourceNativeIds: ["native-agent"], packageId: "must-not-be-a-target" }) })).status).toBe(400);
      const previewResponse = await request("/api/quarantine/preview", { method: "POST", headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "quarantine", snapshotId, resourceNativeIds: ["native-agent"] }) });
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json();
      expect(preview).toMatchObject({ summary: { packageControlIndependent: true, targetCount: 1 } });
      expect(preview).not.toHaveProperty("qualification");
      expect((await request("/api/quarantine/jobs", { method: "POST", headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "quarantine", snapshotId, resourceNativeIds: ["native-agent"], confirmationHash: preview.confirmationHash }) })).status).toBe(400);
      expect((await request("/api/quarantine/jobs", { method: "POST", headers: { Cookie: operatorCookie, "Content-Type": "application/json", "Idempotency-Key": "strict-scalar" },
        body: JSON.stringify({ action: "quarantine", snapshotId: [snapshotId], resourceNativeIds: ["native-agent"], confirmationHash: preview.confirmationHash }) })).status).toBe(400);
      const submit = await request("/api/quarantine/jobs", { method: "POST", headers: { Cookie: operatorCookie, "Content-Type": "application/json", "Idempotency-Key": "app-route-normal" },
        body: JSON.stringify({ action: "quarantine", snapshotId, resourceNativeIds: ["native-agent"], confirmationHash: preview.confirmationHash }) });
      expect(submit.status).toBe(202);
      expect(await submit.json()).toMatchObject({ status: "queued", action: "quarantine" });

      const quarantineRepository = new CopilotStudioQuarantineRepository(fixture.runtime);
      const inventoryTarget = (await new NativeInventory(fixture.runtime).resolveQuarantineTargets({ tenantId: config.tenants[0].tenantId!, principalId }, snapshotId, ["native-agent"]))[0];
      const frozenTarget = { ...inventoryTarget, directStatus: { environmentId: inventoryTarget.environmentId, botId: inventoryTarget.botId, isBotQuarantined: false,
        lastUpdateTimeUtc: "2026-09-09T10:00:00.123Z", observedAt: new Date().toISOString(), correlationId: randomUUID() } };
      const durableInput = { action: "quarantine" as const, targets: [frozenTarget], actor: { tenantId: config.tenants[0].tenantId!, homeAccountId: principalId,
        displayName: "Quarantine operator", username: "quarantine-operator@example.invalid" }, authority: { contractRevision: "c".repeat(64), permissionRevision: "d".repeat(64), configurationRevision: 1 },
        requestPath: "/api/quarantine/jobs" };
      const durableConfirmation = createQuarantineConfirmation(durableInput);
      const durableJob = await quarantineRepository.submit({ tenantId: config.tenants[0].tenantId!, principalId }, { ...durableInput, idempotencyKey: "app-route-durable", confirmationHash: durableConfirmation.confirmationHash });
      const retryReads = vi.mocked(CopilotStudioQuarantineClient.prototype.getStatus).mock.calls.length;
      const durableRetry = await request("/api/quarantine/jobs", { method: "POST", headers: { Cookie: operatorCookie, "Content-Type": "application/json", "Idempotency-Key": "app-route-durable" },
        body: JSON.stringify({ action: "quarantine", snapshotId, resourceNativeIds: ["native-agent"], confirmationHash: durableConfirmation.confirmationHash }) });
      expect(durableRetry.status).toBe(202);
      expect(await durableRetry.json()).toMatchObject({ id: durableJob.id });
      expect(vi.mocked(CopilotStudioQuarantineClient.prototype.getStatus).mock.calls.length).toBe(retryReads);
      const changedRetry = await request("/api/quarantine/jobs", { method: "POST", headers: { Cookie: operatorCookie, "Content-Type": "application/json", "Idempotency-Key": "app-route-durable" },
        body: JSON.stringify({ action: "unquarantine", snapshotId, resourceNativeIds: ["native-agent"], confirmationHash: durableConfirmation.confirmationHash }) });
      expect(changedRetry.status).toBe(409);
      expect(await changedRetry.json()).toMatchObject({ code: "idempotency_mismatch" });

      expect((await request("/api/quarantine/audit", { headers: { Cookie: operatorCookie } })).status).toBe(200);
      expect((await request("/api/quarantine/audit", { headers: { Cookie: administratorCookie } })).status).toBe(200);
      expect((await request("/api/quarantine/audit", { headers: { Cookie: securityReaderCookie } })).status).toBe(200);
    } finally {
      authFixture.revalidatedUser = { tenantId: config.tenants[0].tenantId!, homeAccountId: "fixture-principal", displayName: "Fixture", username: "fixture@example.invalid", roles: ["AgentControl.Admin"] };
      cookie = originalCookie;
    }
  });
  it("returns a durable waiting inventory job when token acquisition fails after submission", async () => {
    const principalId="inventory-token-loss";
    const readerCookie=await roleCookie(principalId,["AgentControl.Viewer"]);
    authFixture.revalidatedUser={tenantId:config.tenants[0].tenantId!,homeAccountId:principalId,displayName:"Inventory token loss",username:"inventory-token-loss@example.invalid",roles:["AgentControl.Viewer"]};
    inventoryProviderFixture.queries=0;
    vi.mocked(acquireDelegatedToken).mockRejectedValueOnce(new AppError(401,"interaction_required","Interactive authorization is required."));
    try {
      const response=await request("/api/inventory/refresh-jobs",{method:"POST",headers:{Cookie:readerCookie,"Content-Type":"application/json"},body:JSON.stringify({types:["microsoft.copilotstudio/agents"],environmentId:"environment-a"})});
      expect(response.status).toBe(202);
      const job=await response.json();
      expect(job).toMatchObject({status:"waiting_authorization",environmentScope:"environment-a",requestedTypes:["microsoft.copilotstudio/agents"],snapshotId:null});
      expect(inventoryProviderFixture.queries).toBe(0);
      const persisted=await new PowerPlatformRefreshJobs(fixture.runtime).getJob({tenantId:config.tenants[0].tenantId!,principalId},job.id);
      expect(persisted).toMatchObject({status:"waiting_authorization",snapshotId:null});
    } finally {
      authFixture.revalidatedUser={tenantId:config.tenants[0].tenantId!,homeAccountId:"fixture-principal",displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Admin"]};
    }
  });
  it("imports official usage through bounded multipart staging and enforces aggregate and user roles", async () => {
    const administratorCookie = await roleCookie("usage-administrator", ["AgentControl.Admin"]);
    const readerCookie = await roleCookie("fixture-principal", ["AgentControl.Viewer"]);
    const securityReaderCookie = await roleCookie("usage-security-reader", ["AgentControl.Viewer"]);
    const bundleId = randomUUID();
    const reports = [
      ["agents", "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nusage-agent,=Formula agent,Declarative,1,1,4,2026-07-06"],
      ["userAgents", "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\nusage-agent,=Formula agent,Declarative,@pseudonym,4,2026-07-06\nbridge-agent,Bridge only,Custom,@bridge-only,2,2026-07-05"],
      ["users", "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\n@pseudonym,+Formula user,1,4,2026-07-06\n@users-only,Users only,1,3,2026-07-04"],
    ] as const;
    const previews: OfficialReportPreview[] = [];
    for (const [kind, csv] of reports) {
      const form = new FormData();
      form.append("file", new Blob([csv], { type: "application/octet-stream" }), `private-${kind}.not-trusted`);
      const response = await request(`/api/official-usage/staging?bundleId=${bundleId}`, { method: "POST", headers: { Cookie: administratorCookie }, body: form });
      expect(response.status).toBe(201);
      previews.push(await response.json() as OfficialReportPreview);
      if (kind === "userAgents") {
        expect(previews).toEqual(expect.arrayContaining(reports.slice(0, 2).map(([stagedKind]) => expect.objectContaining({ kind: stagedKind, bundleId }))));
        expect((await request("/api/official-usage/admin", { headers: { Cookie: administratorCookie } })).status).toBe(404);
        const incompleteResponse = await request(`/api/official-usage/bundles/${bundleId}/preview`, {
          method: "POST", headers: { Cookie: administratorCookie },
        });
        expect(incompleteResponse.status).toBe(200);
        const incomplete = await incompleteResponse.json() as OfficialReportBundlePreview;
        expect(incomplete).toMatchObject({ complete: false });
        expect(incomplete.stages.map(stage => stage.kind)).toEqual(["agents", "userAgents"]);
        expect((await request(`/api/official-usage/bundles/${bundleId}/accept`, {
          method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" },
          body: JSON.stringify({ bundleHash: incomplete.bundleHash, expectedActiveRevision: incomplete.expectedActiveRevision }),
        })).status).toBe(409);
      }
    }

    const partialMetadata = new FormData();
    partialMetadata.append("reportingStart", "2026-06-07");
    partialMetadata.append("file", new Blob([reports[0][1]]), "partial-metadata.csv");
    const partialMetadataResponse = await request(`/api/official-usage/staging?bundleId=${randomUUID()}`, {
      method: "POST", headers: { Cookie: administratorCookie }, body: partialMetadata,
    });
    expect(partialMetadataResponse.status).toBe(400);
    expect(await partialMetadataResponse.json()).toMatchObject({ code: "invalid_metadata" });

    const deniedForm = new FormData();
    deniedForm.append("file", new Blob([reports[0][1]]), "private.csv");
    expect((await request("/api/official-usage/staging", { method: "POST", headers: { Cookie: administratorCookie, "x-csrf-token": "wrong" }, body: deniedForm })).status).toBe(403);
    expect((await request("/api/official-usage/aggregate", { headers: { Cookie: administratorCookie } })).status).toBe(200);
    expect((await request("/api/official-usage/users", { headers: { Cookie: readerCookie } })).status).toBe(200);
    const otherAdministratorCookie = await roleCookie("usage-other-administrator", ["AgentControl.Admin"]);
    const foreignBundle = await request(`/api/official-usage/bundles/${bundleId}/preview`, {
      method: "POST", headers: { Cookie: otherAdministratorCookie },
    });
    expect(foreignBundle.status).toBe(200);
    expect(await foreignBundle.json()).toMatchObject({ complete: false, stages: [] });

    const bundlePreviewResponse = await request(`/api/official-usage/bundles/${bundleId}/preview`, {
      method: "POST", headers: { Cookie: administratorCookie },
    });
    expect(bundlePreviewResponse.status).toBe(200);
    const bundlePreview = await bundlePreviewResponse.json() as OfficialReportBundlePreview;
    expect(bundlePreview).toMatchObject({ bundleId, complete: true, stages: expect.arrayContaining(reports.map(([kind]) => expect.objectContaining({ kind }))) });
    expect(previews.map(item => item.reportingPeriod)).toEqual(expect.arrayContaining([
      expect.objectContaining({ startDate: "2026-07-06", endDate: "2026-07-06", provenance: "activity_range" }),
      expect.objectContaining({ startDate: "2026-07-05", endDate: "2026-07-06", provenance: "activity_range" }),
      expect.objectContaining({ startDate: "2026-07-04", endDate: "2026-07-06", provenance: "activity_range" }),
    ]));
    expect((await request(`/api/official-usage/staging/${previews[0].id}/accept`, {
      method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ stagingRevision: 1, fileHash: previews[0].fileHash, expectedActiveRevision: 1 }),
    })).status).toBe(400);
    expect((await request(`/api/official-usage/bundles/${bundleId}/accept`, {
      method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleHash: "b".repeat(64), expectedActiveRevision: bundlePreview.expectedActiveRevision }),
    })).status).toBe(409);
    const accepted = await request(`/api/official-usage/bundles/${bundleId}/accept`, {
      method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleHash: bundlePreview.bundleHash, expectedActiveRevision: bundlePreview.expectedActiveRevision }),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json() as OfficialReportAccepted;
    expect(acceptedBody).toMatchObject({ complete: true });
    const acceptedHistory = await (await request("/api/official-usage/history", {
      headers: { Cookie: administratorCookie },
    })).json() as ReportPage<ReportHistorySet>;
    expect(acceptedHistory.reports.activeSetId).toBe(acceptedBody.setId);
    expect(acceptedHistory.value).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: acceptedBody.setId,
        reportingStart: "2026-07-04", reportingEnd: "2026-07-06", periodProvenance: "activity_range",
      }),
    ]));
    const exactRetry = await request(`/api/official-usage/bundles/${bundleId}/accept`, {
      method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleHash: bundlePreview.bundleHash, expectedActiveRevision: bundlePreview.expectedActiveRevision }),
    });
    expect(exactRetry.status).toBe(200);
    expect(await exactRetry.json()).toEqual(acceptedBody);
    expect((await request(`/api/official-usage/bundles/${bundleId}/accept`, {
      method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleHash: "c".repeat(64), expectedActiveRevision: bundlePreview.expectedActiveRevision }),
    })).status).toBe(409);
    expect((await request(`/api/official-usage/bundles/${bundleId}/accept`, {
      method: "POST", headers: { Cookie: otherAdministratorCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleHash: bundlePreview.bundleHash, expectedActiveRevision: bundlePreview.expectedActiveRevision }),
    })).status).toBe(409);
    const crossTenantSid = randomUUID();
    const crossTenantId = "99999999-9999-4999-8999-999999999999";
    await fixture.operator.query("INSERT INTO sessions(sid,sess,expire) VALUES($1,$2,clock_timestamp()+interval '1 minute')", [crossTenantSid, {
      cookie: { originalMaxAge: 60_000, expires: new Date(Date.now() + 60_000), httpOnly: true, path: "/" },
      tenantId: crossTenantId,
      accountId: "cross-tenant-admin",
      csrfToken,
      rolesValidatedAt: Date.now(),
      user: { tenantId: crossTenantId, homeAccountId: "cross-tenant-admin", username: "cross-tenant@example.invalid", displayName: "cross-tenant", roles: ["AgentControl.Admin"] },
    }]);
    expect((await request(`/api/official-usage/bundles/${bundleId}/accept`, {
      method: "POST", headers: { Cookie: signedSessionCookie(crossTenantSid), "Content-Type": "application/json" },
      body: JSON.stringify({ bundleHash: bundlePreview.bundleHash, expectedActiveRevision: bundlePreview.expectedActiveRevision }),
    })).status).toBe(401);

    const aggregate = await request("/api/official-usage/aggregate", { headers: { Cookie: readerCookie } });
    expect(aggregate.status).toBe(200);
    const aggregateBody = await aggregate.json() as ReportPage<ReportAgent>;
    expect(aggregateBody).toMatchObject({ reports: { availability: "stale" }, counts: { total: 2, filtered: 2 } });
    expect(aggregateBody.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "usage-agent", responseSource: "agents", identityStatus: "unresolved" }),
      expect.objectContaining({ agentId: "bridge-agent", responseSource: "userAgents", identityStatus: "unresolved" }),
    ]));
    expect(JSON.stringify(aggregateBody)).not.toContain("@pseudonym");

    const users = await request("/api/official-usage/users", { headers: { Cookie: securityReaderCookie } });
    expect(users.status).toBe(200);
    const usersBody = await users.json() as ReportPage<ReportUser>;
    expect(usersBody).toMatchObject({ counts: { total: 3, filtered: 3 }, reports: { setId: acceptedBody.setId } });
    expect(usersBody.value).toEqual(expect.arrayContaining([expect.objectContaining({
      username: "@pseudonym", relationshipCount: 1,
    })]));
    const relationships = await request(`/api/official-usage/users/${encodeURIComponent("@pseudonym")}/agents?selectionId=${usersBody.selection.id}`, { headers: { Cookie: securityReaderCookie } });
    const relationshipPage = await relationships.json() as ReportPage<ReportRelationship>;
    expect(relationshipPage).toMatchObject({ counts: { total: 1, filtered: 1 }, value: [expect.objectContaining({ agentId: "usage-agent", identityStatus: "unresolved" })] });
    const filteredUsers = await request("/api/official-usage/users?startDate=2026-07-04&endDate=2026-07-04&cohort=low&lowResponseThreshold=3&sort=responses&order=asc", { headers: { Cookie: securityReaderCookie } });
    expect(filteredUsers.status).toBe(200);
    expect(await filteredUsers.json()).toMatchObject({
      filters: { startDate: "2026-07-04", endDate: "2026-07-04", cohort: "low", lowResponseThreshold: 3 },
      counts: { filtered: 1 }, value: [expect.objectContaining({ username: "@users-only", reviewCohort: "low", entitlement: null, relationshipCount: 0 })],
    });
    expect((await request("/api/official-usage/users?startDate=2026-02-30", { headers: { Cookie: securityReaderCookie } })).status).toBe(400);
    const filteredAgents = await request("/api/official-usage/aggregate?startDate=2026-07-05&endDate=2026-07-05&sort=responses&order=asc", { headers: { Cookie: readerCookie } });
    expect(await filteredAgents.json()).toMatchObject({ counts: { filtered: 1 }, value: [expect.objectContaining({ agentId: "bridge-agent" })] });
    for (const removed of ["/api/official-usage/aggregate.csv", "/api/official-usage/users.csv"]) {
      expect((await request(removed, { headers: { Cookie: readerCookie } })).status).toBe(404);
    }
    async function download(selectionId: string, kind: "official_agents" | "official_users", selectedCookie: string) {
      const queued = await request("/api/data-exports", { method: "POST", headers: { Cookie: selectedCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ selectionId, kind }) });
      expect(queued.status).toBe(202);
      const job = await queued.json() as { id: string };
      await vi.waitFor(async () => {
        const status = await (await request(`/api/data-exports/${job.id}`, { headers: { Cookie: selectedCookie } })).json() as OfficialReportExportStatus;
        expect(status.status).toBe("ready");
        expect(status.bytes).toBeLessThan(16384);
      });
      const result = await request(`/api/data-exports/${job.id}/download`, { headers: { Cookie: selectedCookie } });
      expect(result.status).toBe(200);
      expect(result.headers.get("content-type")).toContain("text/csv");
      return result.text();
    }
    const filteredExportUsers = await (await request("/api/official-usage/users?search=pseudonym&creatorType=Declarative&responsesOnly=true",
      { headers: { Cookie: securityReaderCookie } })).json() as ReportPage<ReportUser>;
    const aggregateCsv = await download(aggregateBody.selection.id, "official_agents", readerCookie);
    const usersCsv = await download(filteredExportUsers.selection.id, "official_users", securityReaderCookie);
    const allUsersCsv = await download(usersBody.selection.id, "official_users", securityReaderCookie);
    const [aggregateHeader, ...aggregateRows] = parseCsv(aggregateCsv, { bom: true }) as string[][];
    const aggregateRow = aggregateRows.find(row => row[aggregateHeader.indexOf("agentId")] === "usage-agent")!;
    const exportedAgent = Object.fromEntries(aggregateHeader.map((column, index) => [column, aggregateRow[index]]));
    expect(exportedAgent).toMatchObject({
      activeUsersTotal: "1",
      activeUsersTotalBasis: "userAgents_distinct_identity",
      activeUsersIdentityCount: "1",
      lastActivityDateUtc: "2026-07-06T00:00:00.000Z",
      agentsPeriodProvenance: "activity_range",
      agentsSourceFreshness: "unknown",
      userAgentsPeriodProvenance: "activity_range",
      userAgentsSourceFreshness: "unknown",
      reportSetId: aggregateBody.reports.setId,
    });
    const bridgeAgentRow = aggregateRows.find(row => row[aggregateHeader.indexOf("agentId")] === "bridge-agent")!;
    expect(Object.fromEntries(aggregateHeader.map((column, index) => [column, bridgeAgentRow[index]]))).toMatchObject({
      activeUsersLicensed: "Unknown",
      activeUsersUnlicensed: "Unknown",
      responsesAgentsReport: "Unknown",
      responsesUsersAndAgentsReport: "2",
    });
    expect(aggregateCsv).toContain("\"'=Formula agent\"");
    const [usersHeader, usersRow] = parseCsv(usersCsv, { bom: true }) as string[][];
    const exportedUser = Object.fromEntries(usersHeader.map((column, index) => [column, usersRow[index]]));
    expect(exportedUser).toMatchObject({
      userMetricSource: "users_report",
      usersPeriodProvenance: "activity_range",
      usersSourceFreshness: "unknown",
      userAgentsPeriodProvenance: "activity_range",
      userAgentsSourceFreshness: "unknown",
      reportSetId: aggregateBody.reports.setId,
    });
    const [allUsersHeader, ...allUsersRows] = parseCsv(allUsersCsv, { bom: true }) as string[][];
    const exportedUsersOnly = Object.fromEntries(allUsersHeader.map((column, index) => [column,
      allUsersRows.find(row => row[allUsersHeader.indexOf("username")] === "'@users-only")![index]]));
    expect(exportedUsersOnly).toMatchObject({
      licenseAssignmentStatus: "unavailable",
      reviewCohort: "low_responses",
      reviewCandidate: "true",
      reportedAgentsUsed: "1",
      reportedResponsesReceived: "3",
      userLastActivityDateUtc: "2026-07-04T00:00:00.000Z",
      responsesSentToUsers: "Unknown",
      agentLastUsedByAnyoneDateUtc: "Unknown",
      missingBridgeRows: "true",
    });
    const exportedBridgeOnly = Object.fromEntries(allUsersHeader.map((column, index) => [column,
      allUsersRows.find(row => row[allUsersHeader.indexOf("username")] === "'@bridge-only")![index]]));
    expect(exportedBridgeOnly).toMatchObject({
      reportedAgentsUsed: "Unknown",
      reportedResponsesReceived: "Unknown",
      userLastActivityDateUtc: "Unknown",
      responsesSentToUsers: "2",
      agentLastUsedByAnyoneDateUtc: "2026-07-05T00:00:00.000Z",
    });
    expect(usersCsv).toContain("users_and_agents_report");
    expect(usersCsv).toContain("\"'@pseudonym\"");
    expect(usersCsv).toContain("\"'+Formula user\"");

    const activeSetId = aggregateBody.reports.setId;
    const malformed = new FormData();
    malformed.append("reportingStart", "2026-06-07");
    malformed.append("reportingEnd", "2026-07-06");
    malformed.append("periodProvenance", "operator_asserted");
    malformed.append("file", new Blob(["private row contents"]), "secret-filename.csv");
    const rejected = await request(`/api/official-usage/staging?bundleId=${randomUUID()}`, { method: "POST", headers: { Cookie: administratorCookie }, body: malformed });
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(await rejected.json())).not.toContain("secret-filename");
    expect(await (await request("/api/official-usage/aggregate", { headers: { Cookie: readerCookie } })).json()).toMatchObject({ reports: { activeSetId } });

    const confirmationResponse = await request(`/api/official-usage/sets/${activeSetId}/preview`, {
      method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "select" }),
    });
    expect(confirmationResponse.status).toBe(200);
    const confirmation = await confirmationResponse.json();
    const scalarIdentifier = await request(`/api/official-usage/confirmations/${confirmation.id}`, {
      method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ...confirmation, setId: [activeSetId] }),
    });
    expect(scalarIdentifier.status).toBe(400);

    const auditCount = async () => (await fixture.runtime.query(
      "SELECT count(*)::int AS count FROM official_usage_audit WHERE actor_principal_id='usage-administrator'",
    )).rows[0].count;
    const auditBefore = await auditCount();
    expect((await request("/api/official-usage/legacy-cleanup-acknowledgements", {
      method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" }, body: JSON.stringify({ disposition: "reimported" }),
    })).status).toBe(404);
    expect(await auditCount()).toBe(auditBefore);
  });
  it.each(["before_file", "in_file"] as const)("caps simultaneous official usage uploads %s and releases disconnected reservations", async stage => {
    const principalId = `usage-admission-${stage}`;
    const administratorCookie = await roleCookie(principalId, ["AgentControl.Admin"]);
    const heldRequests: ClientRequest[] = [];
    const timer = vi.spyOn(globalThis, "setTimeout");
    const openHeldUpload = async () => {
      const boundary = `held-${randomUUID()}`;
      const held = httpRequest(`${base}/api/official-usage/staging?bundleId=${randomUUID()}`, {
        method: "POST",
        headers: {
          Cookie: administratorCookie,
          Origin: config.frontendOrigin,
          "X-CSRF-Token": csrfToken,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
      });
      held.on("response", response => response.resume());
      held.on("error", () => undefined);
      const prefix = stage === "before_file" ? `--${boundary}\r\nContent-Disposition: form-data; name="file"`
        : `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="held.csv"\r\nContent-Type: text/csv\r\n\r\nAgent ID`;
      await new Promise<void>((resolve, reject) => held.write(
        prefix,
        error => error ? reject(error) : resolve(),
      ));
      heldRequests.push(held);
    };

    try {
      await openHeldUpload();
      await openHeldUpload();
      await vi.waitFor(() => expect(timer.mock.calls.filter(([, delay]) => delay === 30 * 60_000)).toHaveLength(2));
      await vi.waitFor(async () => {
        expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM official_usage_ingestions
          WHERE principal_id=$1 AND state='streaming'`, [principalId])).rows[0].count).toBe(stage === "in_file" ? 2 : 0);
      });
      const denied = new FormData();
      denied.append("file", new Blob(["not retained"]), "denied.csv");
      const deniedResponse = await request(`/api/official-usage/staging?bundleId=${randomUUID()}`, {
        method: "POST", headers: { Cookie: administratorCookie }, body: denied, signal: AbortSignal.timeout(1500),
      });
      expect(deniedResponse.status).toBe(429);
      expect(await deniedResponse.json()).toMatchObject({ code: "upload_admission_full" });
    } finally { for (const held of heldRequests) held.destroy(); timer.mockRestore(); }
    await vi.waitFor(async () => {
      expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM official_usage_ingestions
        WHERE principal_id=$1 AND state IN ('streaming','validating')`, [principalId])).rows[0].count).toBe(0);
    });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_staging WHERE actor_principal_id=$1", [principalId])).rows[0].count).toBe(0);

    const recoveredBundleId = randomUUID();
    const recovered = new FormData();
    recovered.append("reportingStart", "2026-06-07");
    recovered.append("reportingEnd", "2026-07-06");
    recovered.append("periodProvenance", "operator_asserted");
    recovered.append("file", new Blob(["Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nrecovered-agent,Recovered,Declarative,1,0,1,2026-07-06"]), "recovered.csv");
    const recoveredResponse = await request(`/api/official-usage/staging?bundleId=${recoveredBundleId}`, {
      method: "POST",
      headers: { Cookie: administratorCookie },
      body: recovered,
    });
    expect(recoveredResponse.status).toBe(201);
    const recoveredPreview = await recoveredResponse.json();
    expect((await request(`/api/official-usage/staging/${recoveredPreview.id}`, {
      method: "DELETE",
      headers: { Cookie: administratorCookie },
    })).status).toBe(204);
  });
  it("releases upload admission after a multipart field-limit failure without retaining staging", async () => {
    const administratorCookie = await roleCookie("usage-multer-administrator", ["AgentControl.Admin"]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const missingFile = new FormData();
      missingFile.append("sourceAsOf", "2026-07-06T00:00:00.000Z");
      const missing = await request(`/api/official-usage/staging?bundleId=${randomUUID()}`, {
        method: "POST", headers: { Cookie: administratorCookie }, body: missingFile,
      });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({ code: "missing_report" });
    }
    const oversized = new FormData();
    oversized.append("file", new Blob(["Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nfield-limit,Bounded,Declarative,1,0,1,2026-07-06"]), "field-limit.csv");
    oversized.append("reportingStart", "x".repeat(4097));
    const rejected = await request(`/api/official-usage/staging?bundleId=${randomUUID()}`, {
      method: "POST", headers: { Cookie: administratorCookie }, body: oversized,
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: "invalid_multipart" });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_staging WHERE actor_principal_id='usage-multer-administrator'")).rows[0].count).toBe(0);

    const bundleId = randomUUID();
    const recovered = new FormData();
    recovered.append("reportingStart", "2026-06-07");
    recovered.append("reportingEnd", "2026-07-06");
    recovered.append("periodProvenance", "operator_asserted");
    recovered.append("file", new Blob(["Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nrecovered-multer,Recovered,Declarative,1,0,1,2026-07-06"]), "recovered.csv");
    const accepted = await request(`/api/official-usage/staging?bundleId=${bundleId}`, {
      method: "POST", headers: { Cookie: administratorCookie }, body: recovered,
    });
    expect(accepted.status).toBe(201);
    const preview = await accepted.json();
    expect((await request(`/api/official-usage/staging/${preview.id}`, {
      method: "DELETE", headers: { Cookie: administratorCookie },
    })).status).toBe(204);
  });
  it("does not release upload capacity while disconnected repository work is still pending", async () => {
    const administratorCookie = await roleCookie("usage-held-work-administrator", ["AgentControl.Admin"]);
    const lockClient = await fixture.operator.connect();
    const controller = new AbortController();
    let secondUpload: ClientRequest | undefined;
    let lockReleased = false;
    try {
      await lockClient.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`official-usage:${config.tenants[0].tenantId}`]);
      const form = new FormData();
      form.append("reportingStart", "2026-06-07");
      form.append("reportingEnd", "2026-07-06");
      form.append("periodProvenance", "operator_asserted");
      form.append("file", new Blob(["Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nheld-work,Work,Declarative,1,0,1,2026-07-06"]), "held-work.csv");
      const heldWork = request(`/api/official-usage/staging?bundleId=${randomUUID()}`, {
        method: "POST", headers: { Cookie: administratorCookie }, body: form, signal: controller.signal,
      }).catch(() => undefined);
      await vi.waitFor(async () => {
        const waiting = await fixture.operator.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname=current_database() AND usename='agentcontrol_app' AND wait_event_type='Lock'
            AND query LIKE 'SELECT pg_advisory_xact_lock%'`);
        expect(waiting.rows[0].count).toBeGreaterThan(0);
      });
      controller.abort();
      await heldWork;

      const boundary = `held-parser-${randomUUID()}`;
      secondUpload = httpRequest(`${base}/api/official-usage/staging?bundleId=${randomUUID()}`, {
        method: "POST",
        headers: {
          Cookie: administratorCookie,
          Origin: config.frontendOrigin,
          "X-CSRF-Token": csrfToken,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
      });
      secondUpload.on("response", response => response.resume());
      secondUpload.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => secondUpload!.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="held.csv"\r\nContent-Type: text/csv\r\n\r\nAgent ID`,
        error => error ? reject(error) : resolve(),
      ));
      await new Promise(resolve => setTimeout(resolve, 50));

      const denied = new FormData();
      denied.append("file", new Blob(["not retained"]), "denied.csv");
      const deniedResponse = await request(`/api/official-usage/staging?bundleId=${randomUUID()}`, {
        method: "POST", headers: { Cookie: administratorCookie }, body: denied, signal: AbortSignal.timeout(1500),
      });
      expect(deniedResponse.status).toBe(429);
      expect(await deniedResponse.json()).toMatchObject({ code: "upload_admission_full" });

      await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`official-usage:${config.tenants[0].tenantId}`]);
      lockReleased = true;
      secondUpload.destroy();
      await vi.waitFor(async () => {
        expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_staging WHERE actor_principal_id='usage-held-work-administrator'")).rows[0].count).toBe(0);
        const waiting = await fixture.operator.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname=current_database() AND usename='agentcontrol_app' AND query LIKE 'SELECT pg_advisory_xact_lock%'`);
        expect(waiting.rows[0].count).toBe(0);
      });
      const recovered = await vi.waitFor(async () => {
        const response = await request(`/api/official-usage/staging?bundleId=${randomUUID()}`, {
          method: "POST", headers: { Cookie: administratorCookie }, body: form,
        });
        const preview = await response.json() as OfficialReportPreview;
        expect(response.status).toBe(201);
        return preview;
      });
      expect((await request(`/api/official-usage/staging/${recovered.id}`, {
        method: "DELETE", headers: { Cookie: administratorCookie },
      })).status).toBe(204);
    } finally {
      controller.abort();
      secondUpload?.destroy();
      if (!lockReleased) await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`official-usage:${config.tenants[0].tenantId}`]);
      lockClient.release();
    }
  });
  it("emits the managed value-free alert when rejected-upload cleanup fails", async () => {
    const principalId = "usage-cleanup-failure-administrator", tenantId = config.tenants[0].tenantId;
    const administratorCookie = await roleCookie(principalId, ["AgentControl.Admin"]);
    const cleanup = vi.spyOn(OfficialReportImports.prototype, "cancel").mockRejectedValueOnce(new Error("private-cleanup-connection-detail"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const form = new FormData();
      form.append("file", new Blob(["Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\ncleanup,Fixture,Declarative,1,0,1,2026-07-06"]), "private-cleanup.csv");
      form.append("reportingStart", "2026-07-06");
      const result = await request(`/api/official-usage/staging?bundleId=${randomUUID()}`, {
        method: "POST", headers: { Cookie: administratorCookie }, body: form,
      });
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({ code: "invalid_metadata" });
      await vi.waitFor(() => expect(log.mock.calls.some(([line]) => String(line).includes('"event":"official_usage_upload_cleanup_failed"'))).toBe(true));
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-cleanup|connection-detail/);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      cleanup.mockRestore(); log.mockRestore();
      const pending = (await fixture.runtime.query<{ id: string }>(`SELECT id FROM official_usage_ingestions
        WHERE tenant_id=$1 AND principal_id=$2 AND state='streaming' ORDER BY id LIMIT 2`, [tenantId, principalId])).rows;
      expect(pending).toHaveLength(1);
      const identity = await reportIdentity(fixture.runtime, { tenantId, homeAccountId: principalId,
        username: `${principalId}@example.invalid`, displayName: principalId, roles: ["AgentControl.Admin"] });
      for (const row of pending) await new OfficialReportImports(fixture.runtime).cancel(identity, row.id);
    }
  });
  it("rejects shared source admission without waiting for an unfinished multipart body", async () => {
    const administratorCookie = await roleCookie("usage-shared-admission-administrator", ["AgentControl.Admin"]);
    const generations = new DataGenerations(fixture.runtime), leases: GenerationLease[] = [];
    let pending: ClientRequest | undefined;
    let outcome: { status: number; body: string } | undefined;
    try {
      for (const source of ["directory", "app_activity"]) leases.push(await generations.begin(generationInput({
        scope: { ...generationInput().scope, tenantId: config.tenants[0].tenantId, principalId: "held-source-admission", source },
      })));
      const boundary = `shared-source-${randomUUID()}`;
      pending = httpRequest(`${base}/api/official-usage/staging?bundleId=${randomUUID()}`, {
        method: "POST", headers: { Cookie: administratorCookie, Origin: config.frontendOrigin,
          "X-CSRF-Token": csrfToken, "Content-Type": `multipart/form-data; boundary=${boundary}` },
      }, response => {
        let body = "";
        response.on("data", chunk => { body += String(chunk); });
        response.on("end", () => { outcome = { status: response.statusCode ?? 0, body }; });
      });
      pending.on("error", () => undefined);
      pending.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="waiting.csv"\r\nContent-Type: text/csv\r\n\r\nAgent ID`);
      await vi.waitFor(() => expect(outcome).toMatchObject({ status: 429, body: expect.stringContaining('"code":"upload_admission_full"') }));
    } finally {
      pending?.destroy();
      for (const lease of leases) await generations.abort(lease);
    }
  });
  it.each(["before_file", "in_file"] as const)("times out a never-ending multipart body %s at the frozen upload deadline", async stage => {
    const administratorCookie = await roleCookie("usage-deadline-administrator", ["AgentControl.Admin"]);
    const boundary = `deadline-${randomUUID()}`;
    const bundleId = randomUUID();
    const csv = "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\ndeadline-agent,Deadline,Declarative,1,0,1,2026-07-06";
    const fields = [
      ["reportingStart", "2026-06-07"],
      ["reportingEnd", "2026-07-06"],
      ["periodProvenance", "operator_asserted"],
    ].map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("");
    const prefix = stage === "before_file" ? `--${boundary}\r\nContent-Disposition: form-data; name="file"`
      : `${fields}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="deadline.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}`;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timer = vi.spyOn(globalThis, "setTimeout");
    let pending: ClientRequest | undefined;
    let response: Promise<{ status: number; body: string }> | undefined;
    try {
      response = new Promise<{ status: number; body: string }>((resolve, reject) => {
        pending = httpRequest(`${base}/api/official-usage/staging?bundleId=${bundleId}`, {
          method: "POST",
          headers: {
            Cookie: administratorCookie,
            Origin: config.frontendOrigin,
            "X-CSRF-Token": csrfToken,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": Buffer.byteLength(prefix) + 1024,
          },
        }, result => {
          const chunks: Buffer[] = [];
          result.on("data", chunk => chunks.push(Buffer.from(chunk)));
          result.on("end", () => resolve({ status: result.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        });
        pending.on("error", reject);
        pending.write(prefix);
      });
      await vi.waitFor(() => expect(timer).toHaveBeenCalledWith(expect.any(Function), 30 * 60_000));
      let responseSettled = false;
      void response.then(() => { responseSettled = true; }, () => { responseSettled = true; });
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
      await vi.waitFor(() => expect(responseSettled).toBe(true));
      await expect(response).resolves.toMatchObject({
        status: 408,
        body: expect.stringContaining('"code":"upload_deadline"'),
      });
    } finally {
      pending?.destroy();
      await response?.catch(() => undefined);
      timer.mockRestore();
      vi.useRealTimers();
    }
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_staging WHERE actor_principal_id='usage-deadline-administrator' OR bundle_id=$1", [bundleId])).rows[0].count).toBe(0);
  });
  it("rejects role refreshes that switch account or tenant", async () => {
    const originalCookie=cookie;
    try {
      for (const revalidatedUser of [
        {...authFixture.revalidatedUser,homeAccountId:"other-principal"},
        {...authFixture.revalidatedUser,homeAccountId:"refresh-principal",tenantId:"99999999-9999-9999-9999-999999999999"},
      ]) {
        authFixture.revalidatedUser=revalidatedUser;
        cookie=await roleCookie("refresh-principal",["AgentControl.Viewer"],0);
        expect((await request("/api/me")).status).toBe(401);
      }
    } finally {
      authFixture.revalidatedUser={tenantId:config.tenants[0].tenantId!,homeAccountId:"fixture-principal",displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Admin"]};
      cookie=originalCookie;
    }
  });
  it("applies authoritative demotion and complete role revocation before protected work", async () => {
    const originalCookie = cookie;
    try {
      authFixture.revalidatedUser = { tenantId: config.tenants[0].tenantId!, homeAccountId: "demoted-principal", displayName: "Demoted", username: "demoted@example.invalid", roles: ["AgentControl.Viewer"] };
      const adminSession = await roleCookie("demoted-principal", ["AgentControl.Admin"], 0);
      await publishPackageSnapshot("demoted-principal");
      expect((await request("/api/agents", { headers: { Cookie: adminSession } })).status).toBe(200);
      expect((await request("/api/agents/package-1/block", { method: "POST", headers: { Cookie: adminSession, "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);

      authFixture.revalidatedUser = { ...authFixture.revalidatedUser, roles: [] };
      const viewerSession = await roleCookie("demoted-principal", ["AgentControl.Viewer"], 0);
      expect((await request("/api/agents", { headers: { Cookie: viewerSession } })).status).toBe(403);
    } finally {
      authFixture.revalidatedUser = { tenantId: config.tenants[0].tenantId!, homeAccountId: "fixture-principal", displayName: "Fixture", username: "fixture@example.invalid", roles: ["AgentControl.Admin"] };
      cookie = originalCookie;
    }
  });
  it("does not restore a held role refresh after account logout", async () => {
    const staleCookie=await roleCookie("race-principal",["AgentControl.Viewer"],0);
    const logoutCookie=await roleCookie("race-principal",["AgentControl.Viewer"]);
    let release!: () => void;
    authFixture.pendingRevalidation=new Promise<void>(resolve => { release=resolve; });
    authFixture.revalidatedUser={tenantId:config.tenants[0].tenantId!,homeAccountId:"race-principal",displayName:"Race",username:"race@example.invalid",roles:["AgentControl.Viewer"]};
    const started=authFixture.revalidationStarted;
    const staleRequest=request("/api/me",{headers:{Cookie:staleCookie}});
    await vi.waitFor(() => expect(authFixture.revalidationStarted).toBe(started+1));
    expect((await request("/api/auth/logout",{method:"POST",headers:{Cookie:logoutCookie}})).status).toBe(204);
    release();
    expect((await staleRequest).status).toBe(401);
    expect((await fixture.runtime.query("SELECT 1 FROM sessions WHERE principal_id='race-principal'")).rowCount).toBe(0);
    authFixture.pendingRevalidation=undefined;
    authFixture.revalidatedUser={tenantId:config.tenants[0].tenantId!,homeAccountId:"fixture-principal",displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Admin"]};
  });
  it("deletes legacy sessions without a role-bearing user shape", async () => {
    const sid=randomUUID();
    await fixture.operator.query("INSERT INTO sessions(sid,sess,expire) VALUES ($1,$2,clock_timestamp()+interval '1 hour')",[sid,{cookie:{originalMaxAge:60000,expires:new Date(Date.now()+60000),httpOnly:true,path:"/"},tenantId:config.tenants[0].tenantId,accountId:"legacy",user:{tenantId:config.tenants[0].tenantId,homeAccountId:"legacy",username:"legacy@example.invalid",displayName:"Legacy"}}]);
    expect((await request("/api/me",{headers:{Cookie:signedSessionCookie(sid)}})).status).toBe(401);
    expect((await fixture.operator.query("SELECT 1 FROM sessions WHERE sid=$1",[sid])).rowCount).toBe(0);
  });
  it("denies mutations in maintenance without disabling health", async () => {
    const preview = await mutationPreview("block", ["package-1"], "single");
    process.env.MAINTENANCE_MODE="true";
    try {
      expect((await request("/api/agents/package-1/block",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(preview)})).status).toBe(503);
      expect((await request("/api/health")).status).toBe(200);
      expect(await (await request("/api/diagnostics")).json()).toMatchObject({ maintenance: true, providerWorkEnabled: false });
    } finally { delete process.env.MAINTENANCE_MODE; }
    vi.stubEnv("MAINTENANCE_FILE", `${process.execPath}/maintenance`);
    try {
      expect((await request("/api/ready")).status).toBe(503);
      expect((await request("/api/agents/package-1/block",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(preview)})).status).toBe(503);
      expect((await request("/api/health")).status).toBe(200);
      expect(await (await request("/api/diagnostics")).json()).toMatchObject({ maintenance: true, providerWorkEnabled: false });
    } finally { vi.unstubAllEnvs(); }
    try {
      await fixture.operator.query("UPDATE operational_state SET mode='maintenance',provider_work_enabled=true");
      expect((await request("/api/ready")).status).toBe(503);
      expect((await request("/api/health")).status).toBe(200);
      expect(await (await request("/api/diagnostics")).json()).toMatchObject({ maintenance: true, providerWorkEnabled: false });
      await fixture.operator.query("UPDATE operational_state SET mode='normal',provider_work_enabled=false");
      expect((await request("/api/ready")).status).toBe(200);
      expect(await (await request("/api/diagnostics")).json()).toMatchObject({ maintenance: false, providerWorkEnabled: false });
    } finally {
      await fixture.operator.query("UPDATE operational_state SET mode='normal',provider_work_enabled=true");
    }
    await fixture.operator.query("UPDATE app_schema SET fingerprint=$1 WHERE singleton", ["0".repeat(64)]);
    try {
      expect((await request("/api/ready")).status).toBe(503);
      expect(await (await request("/api/health")).json()).toEqual({ok:true});
    } finally {
      await fixture.operator.query("UPDATE app_schema SET fingerprint=$1 WHERE singleton", [schemaFingerprint]);
    }
  });
});