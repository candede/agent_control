import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest, type ClientRequest, type Server } from "node:http";
import session from "express-session";
import { parse as parseCsv } from "csv-parse/sync";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { retain } from "../scripts/database.js";
import { testDatabase, fixturePassword } from "../scripts/testDatabase.js";
import { createApp } from "./app.js";
import { acquireDelegatedToken } from "./auth/msal.js";
import { authConfigured, config } from "./config.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation } from "./db/copilotStudioQuarantine.js";
import { DefenderHuntingRepository } from "./db/defenderHunting.js";
import { createJobConfirmation, JobRepository, type JobIntentInput } from "./db/jobs.js";
import { PackageInventoryRepository } from "./db/packageInventory.js";
import { pool } from "./db/pool.js";
import { PowerPlatformInventoryRepository } from "./db/powerPlatformInventory.js";
import { PurviewAuditRepository } from "./db/purviewAudit.js";
import { migrations } from "./db/schema.js";
import { AppError } from "./errors.js";
import { AuditLog } from "./services/auditLog.js";
import { CopilotStudioQuarantineClient } from "./services/copilotStudioQuarantine.js";
import { GraphPackagesClient } from "./services/graphPackages.js";
import { capabilities } from "./services/capabilities.js";
import { launchBulkJob, runBulkJob } from "./services/bulkJobs.js";
import type { AppRole } from "./types/capability.js";
import type { PowerPlatformResource } from "./types/powerPlatformInventory.js";
import { clearAdmissionForTest } from "./middleware/admission.js";

vi.hoisted(() => {
  process.env.TENANT_ID="11111111-1111-1111-1111-111111111111";
  process.env.CLIENT_ID="99999999-9999-4999-8999-999999999999";
  process.env.SESSION_SECRET="fixture-session-secret-never-used-outside-tests-01";
});
const huntingCapabilityFixture = vi.hoisted(() => ({ applicationRevision: 1 }));
const authFixture = vi.hoisted(() => ({
  user: {tenantId:"11111111-1111-1111-1111-111111111111",homeAccountId:"fixture-principal",displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Reader","AgentControl.Operator","AgentControl.SecurityReader","AgentControl.Administrator"]},
  revalidatedUser: {tenantId:"11111111-1111-1111-1111-111111111111",homeAccountId:"fixture-principal",displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Reader","AgentControl.Operator","AgentControl.SecurityReader","AgentControl.Administrator"]},
  pendingRevalidation: undefined as Promise<unknown> | undefined,
  revalidationStarted: 0,
  redemptions: 0,
}));
const inventoryProviderFixture = vi.hoisted(() => ({ queries: 0 }));
vi.mock("./auth/msal.js", () => ({
  acquireDelegatedToken: vi.fn(async () => "fixture-token"),
  acquireApplicationToken: vi.fn(async () => "fixture-application-token"),
  createAuthFlow: (kind:string, options:Record<string,unknown> = {}) => ({kind,state:"fixture-state",nonce:"fixture-nonce",codeVerifier:"fixture-verifier",scopes:["openid","profile"],createdAt:Date.now(),...options,returnTo:typeof options.returnTo === "string" ? options.returnTo : "/"}),
  createAuthorizationUrl: async () => "https://login.microsoftonline.com/fixture", redeemAuthorizationCode: async () => { authFixture.redemptions += 1; return {}; },
  toAuthenticatedUser: () => ({...authFixture.user,roles:[...authFixture.user.roles]}),
  matchesAuthState: (left:string,right:string) => left === right, evictAccount: vi.fn(async () => undefined), revalidateAuthenticatedUser: vi.fn(async () => { authFixture.revalidationStarted += 1; if (authFixture.pendingRevalidation) await authFixture.pendingRevalidation; return {...authFixture.revalidatedUser,roles:[...authFixture.revalidatedUser.roles]}; }),
}));
vi.mock("./services/capabilities.js", () => ({ capabilities: {
  requireAvailable: vi.fn(async () => undefined), requireApplicationDataScope: vi.fn(async () => ({ enabled: true, sharedDataScope: true, revision: huntingCapabilityFixture.applicationRevision })), invalidatePrincipal: vi.fn(async () => undefined), list: vi.fn(async () => []), refresh: vi.fn(), configureApplication: vi.fn(),
  packageQualificationIdentity: vi.fn(async (action: string) => ({ capabilityId: action === "block" || action === "unblock" ? "graph.package.block.manage" : "graph.package.access.manage", contractRevision: "a".repeat(64), configurationRevision: 1, authMode: "delegated" })),
  auditQualificationContext: vi.fn(async (capabilityId: string) => ({ capabilityId, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 })),
  recordAuditQualificationEvidence: vi.fn(async () => ({ authorized: true })),
  huntingQualificationContext: vi.fn(async (capabilityId: string) => ({ capabilityId, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: capabilityId.endsWith(".application") ? huntingCapabilityFixture.applicationRevision : 1 })),
  recordHuntingQualificationEvidence: vi.fn(async () => ({ authorized: true })),
  quarantineAuthorityContext: vi.fn(async () => ({ contractRevision: "c".repeat(64), permissionRevision: "d".repeat(64), configurationRevision: 1 })),
  quarantineApprovalAuthorityContext: vi.fn(async () => ({ contractRevision: "c".repeat(64), permissionRevision: "d".repeat(64), configurationRevision: 1 })),
} }));
vi.mock("./services/powerPlatformResourceQuery.js", () => ({ PowerPlatformResourceQueryClient: class {
  async query() { inventoryProviderFixture.queries += 1; return {resources:[],totalRecords:0,pages:1,unknownFieldCount:0}; }
} }));
vi.mock("./services/bulkJobs.js", async original => ({ ...await original<typeof import("./services/bulkJobs.js")>(), launchBulkJob: vi.fn() }));

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
  vi.spyOn(GraphPackagesClient.prototype,"listCopilotAgents").mockResolvedValue([{id:"package-1",displayName:"Fixture",isBlocked:false}]);
  vi.spyOn(GraphPackagesClient.prototype,"getPackageDetails").mockResolvedValue({id:"package-1",displayName:"Fixture",isBlocked:false,allowedUsersAndGroups:[{resourceType:"user",resourceId:"sensitive-user"}],acquireUsersAndGroups:[]});
  vi.spyOn(GraphPackagesClient.prototype,"blockPackage").mockResolvedValue();
  vi.spyOn(GraphPackagesClient.prototype,"unblockPackage").mockResolvedValue();
  vi.spyOn(CopilotStudioQuarantineClient.prototype,"getStatus").mockImplementation(async (_token, target, options) => ({ ...target, isBotQuarantined: false,
    lastUpdateTimeUtc: "2026-09-09T10:00:00.123Z", observedAt: new Date().toISOString(), correlationId: options.correlationId }));
  await publishPackageSnapshot("fixture-principal");
  await publishPackageSnapshot("operator", ["package-1"]);
});
afterAll(async () => {
  application?.store.close();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
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
async function roleCookie(principalId: string, roles: AppRole[], rolesValidatedAt = Date.now()) {
  const sid=randomUUID();
  await new Promise<void>((resolve,reject) => application.store.set(sid,{cookie:new session.Cookie({maxAge:60000}),tenantId:config.tenantId,accountId:principalId,csrfToken,rolesValidatedAt,user:{tenantId:config.tenantId!,homeAccountId:principalId,username:`${principalId}@example.invalid`,displayName:principalId,roles}},error => error ? reject(error) : resolve()));
  return signedSessionCookie(sid);
}
async function publishPackageSnapshot(principalId: string, requestedIds?: string[]) {
  const repository = new PackageInventoryRepository(fixture.runtime);
  const scope = { tenantId: config.tenantId!, principalId };
  const job = await repository.submit(scope, {
    authorizationPrincipalId: principalId,
    tokenMode: "delegated",
    idempotencyKey: `package-snapshot-${principalId}-${randomUUID()}`,
    requestedIds,
  });
  await repository.markRunning(scope, job.id);
  await repository.publish(scope, job.id, {
    packages: [{
      id: "package-1",
      displayName: "Fixture",
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
    }],
    totalRecords: 1,
    pages: 1,
  });
  return (await repository.getJob(scope, job.id))!.snapshotId!;
}
async function publishQuarantineInventory(principalId: string) {
  const repository = new PowerPlatformInventoryRepository(fixture.runtime);
  const scope = { tenantId: config.tenantId!, principalId };
  const job = await repository.submit(scope, { idempotencyKey: `quarantine-inventory-${principalId}-${randomUUID()}`, roleScope: "full", requestedTypes: ["microsoft.copilotstudio/agents"] });
  await repository.markRunning(scope, job.id);
  await repository.publish(scope, job.id, { resources: [{ tenantId: config.tenantId!, nativeId: "native-agent", type: "microsoft.copilotstudio/agents",
    location: null, displayName: "Exact agent", environmentId: "11111111-1111-4111-8111-111111111111", createdAt: null, createdBy: null,
    lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown", agentKind: "copilot_studio_agent",
    lifecycle: "published", identityConfidence: "exact_native", identifiers: [{ kind: "power_platform_resource_id", value: "native-agent" },
      { kind: "environment_id", value: "11111111-1111-4111-8111-111111111111" }, { kind: "cds_bot_id", value: "22222222-2222-4222-8222-222222222222" }],
    provenance: {}, details: { isQuarantined: true, quarantinedAt: "2026-09-09T09:00:00.000Z" }, unknownFieldCount: 0 }], totalRecords: 1, pages: 1, unknownFieldCount: 0 });
  return (await repository.getJob(scope, job.id))!.snapshotId!;
}
async function mutationPreview(action: "block" | "unblock", ids: string[], mutationScope: "single" | "bulk") {
  const response = await request("/api/agents/mutation-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ids, mutationScope }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ confirmationHash: string }>;
}

describe.sequential("packaged API/session contracts", () => {
  beforeEach(() => clearAdmissionForTest());
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
    for (const route of ["/agents", "/power-platform", "/users", "/official-usage", "/audit", "/security", "/permissions", "/jobs"]) {
      const deepLink = await request(route);
      expect(deepLink.status).toBe(200);
      expect(deepLink.headers.get("cache-control")).toContain("no-store");
      expect(await deepLink.text()).toContain("Fixture shell");
    }
    expect((await request("/assets/app.js")).headers.get("cache-control")).toContain("immutable");
    expect((await request("/api/diagnostics")).status).toBe(401);
    expect((await request("/assets/%2e%2e%2fsecret")).status).toBe(400);
  });
  it("regenerates the session at login and removes the previous identifier", async () => {
    const login = await request("/api/auth/login");
    const previousCookie=login.headers.get("set-cookie")!.split(";")[0];
    cookie=previousCookie;
    const pendingSession=await fixture.runtime.query("SELECT sess::text AS value FROM sessions");
    for (const secret of ["fixture-state","fixture-nonce","fixture-verifier"]) expect(JSON.stringify(pendingSession.rows)).not.toContain(secret);
    const redemptions=authFixture.redemptions;
    const callback=await request("/api/auth/callback?code=fixture&state=fixture-state");
    expect(callback.status).toBe(302); cookie=callback.headers.get("set-cookie")!.split(";")[0];
    expect(cookie).not.toBe(previousCookie);
    const me=await request("/api/me"); expect(me.status).toBe(200); csrfToken=(await me.json()).csrfToken;
    expect((await request("/api/me",{headers:{Cookie:previousCookie}})).status).toBe(401);
    expect((await request("/api/auth/callback?code=fixture&state=fixture-state")).status).toBe(400);
    expect(authFixture.redemptions).toBe(redemptions+1);
    const stored=await fixture.runtime.query("SELECT sess::text AS value FROM sessions");
    expect(JSON.stringify(stored.rows)).not.toContain("fixture-token");
  });
  it("removes stale roles when consent returns an authoritative empty assignment", async () => {
    const originalCookie=cookie;
    cookie=await roleCookie("fixture-principal",["AgentControl.Reader"]);
    try {
      expect((await request("/api/auth/consent",{method:"POST",headers:{"Content-Type":"application/json","x-csrf-token":"wrong"},body:JSON.stringify({capabilityId:"graph.package.read.delegated"})})).status).toBe(403);
      const consent=await request("/api/auth/consent",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({capabilityId:"graph.package.read.delegated"})});
      expect(consent.status).toBe(200);
      authFixture.user.roles=[];
      expect((await request("/api/auth/callback?code=fixture&state=fixture-state")).status).toBe(302);
      const me=await request("/api/me");
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({user:{roles:[]},roleAssignmentRequired:true});
    } finally {
      authFixture.user.roles=["AgentControl.Reader","AgentControl.Operator","AgentControl.SecurityReader","AgentControl.Administrator"];
      cookie=originalCookie;
    }
  });
  it("returns safe cancellation and conditional-access outcomes only after consuming the flow", async () => {
    const originalCookie = cookie;
    try {
      cookie = await roleCookie("fixture-principal", ["AgentControl.Reader"]);
      for (const [providerError, outcome] of [["access_denied", "cancelled"], ["interaction_required", "interaction_required"], ["unrecognized-error", "failed"]]) {
        await request("/api/auth/consent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capabilityId: "graph.package.read.delegated", returnTo: "/?view=permissions" }) });
        const redemptions = authFixture.redemptions;
        const result = await request(`/api/auth/callback?state=fixture-state&error=${providerError}&error_description=private-provider-text`);
        expect(result.status).toBe(302);
        expect(result.headers.get("location")).toBe(`/?view=permissions&authorization=${outcome}`);
        expect(authFixture.redemptions).toBe(redemptions);
        expect((await request("/api/auth/callback?state=fixture-state&error=access_denied")).status).toBe(400);
        expect(await (await request("/api/me")).json()).toMatchObject({ user: { roles: ["AgentControl.Reader"] } });
      }
    } finally { cookie = originalCookie; }
  });
  it("rejects direct provider writes despite manipulated or disabled frontend controls", async () => {
    const operatorCookie = await roleCookie("gate-operator", ["AgentControl.Operator"]);
    const before = await fixture.operator.query("SELECT count(*)::int AS count FROM jobs");
    const denial = new AppError(403, "capability_unavailable", "Preview writes remain unqualified.");
    vi.mocked(capabilities.requireAvailable).mockRejectedValue(denial);
    try {
      for (const endpoint of ["/api/agents/package-1/block", "/api/agents/block", "/api/agents/unblock-all"]) {
        expect((await request(endpoint, { method: "POST", headers: { Cookie: operatorCookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: ["package-1"] }) })).status).toBe(403);
      }
      expect((await fixture.operator.query("SELECT count(*)::int AS count FROM jobs")).rows).toEqual(before.rows);
      const adminCookie = await roleCookie("gate-admin", ["AgentControl.Administrator"]);
      expect((await request("/api/agents/package-1/block", { method: "POST", headers: { Cookie: adminCookie } })).status).toBe(403);
    } finally { vi.mocked(capabilities.requireAvailable).mockResolvedValue(undefined); }
  });
  it("keeps saved provider-audit results private, content-free, locally audited and CSRF-deletable", async () => {
    const previousCsrf = csrfToken;
    const previousCookie = cookie;
    csrfToken = "provider-audit-fixture-csrf";
    const principalId = "provider-audit-reader";
    const securityCookie = await roleCookie(principalId, ["AgentControl.SecurityReader"]);
    const otherCookie = await roleCookie("other-security-reader", ["AgentControl.SecurityReader"]);
    const readerCookie = await roleCookie("ordinary-reader", ["AgentControl.Reader"]);
    const repository = new PurviewAuditRepository(fixture.runtime);
    const scope = { tenantId: config.tenantId!, authorizationPrincipalId: principalId,
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
      expect((await request(`/api/audit-search/jobs/${job.id}/records`, { headers: { Cookie: readerCookie } })).status).toBe(403);
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
        tenantId: config.tenantId,
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

      expect((await fixture.runtime.query("SELECT action,status,metadata FROM audit_projection WHERE tenant_id=$1 AND principal_id=$2 AND action IN ('view-audit-search','export-audit-search') ORDER BY action", [config.tenantId, principalId])).rows).toEqual([
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
    const securityCookie = await roleCookie(principalId, ["AgentControl.SecurityReader", "AgentControl.Administrator"]);
    const otherCookie = await roleCookie("other-hunting-reader", ["AgentControl.SecurityReader"]);
    const readerCookie = await roleCookie("ordinary-hunting-reader", ["AgentControl.Reader"]);
    const repository = new DefenderHuntingRepository(fixture.runtime);
    const scope = { tenantId: config.tenantId!, authorizationPrincipalId: principalId,
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
      const deniedSend = await request("/api/hunting/jobs", { method: "POST", headers: { Cookie: securityCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ tokenMode: "delegated", filters }) });
      expect(deniedSend.status).toBe(403);
      expect(await deniedSend.json()).toMatchObject({ code: "hunting_scope_unqualified" });
      expect(vi.mocked(acquireDelegatedToken).mock.calls).toHaveLength(tokenCalls);
      const history = await request("/api/hunting/jobs?limit=10&offset=0", { headers: { Cookie: securityCookie } });
      expect(history.status).toBe(200);
      expect(history.headers.get("cache-control")).toContain("no-store");
      await expect(history.json()).resolves.toMatchObject({ count: 3, limit: 10, offset: 0 });
      expect((await repository.getJob(scope, job.id))?.providerRequestCount).toBe(beforeNavigation?.providerRequestCount);
      expect((await request(`/api/hunting/jobs/${job.id}/rows`, { headers: { Cookie: readerCookie } })).status).toBe(403);
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
      expect(exportedRow).toMatchObject({ jobId: job.id, tenantId: config.tenantId, sourceTable: "AgentsInfo", agentId: "'@defender-agent",
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
        RETURNING revision`, [config.tenantId, principalId]);
      huntingCapabilityFixture.applicationRevision = Number(configuration.rows[0].revision);
      const applicationScope = { tenantId: config.tenantId!, authorizationPrincipalId: principalId,
        resultScope: { kind: "application" as const, scopeId: config.clientId!, configurationRevision: huntingCapabilityFixture.applicationRevision },
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
        SET revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND capability_id='defender.hunting.application' RETURNING revision`, [config.tenantId]);
      huntingCapabilityFixture.applicationRevision = Number(changedConfiguration.rows[0].revision);
      const changedHistory = await request("/api/hunting/jobs?limit=10&offset=0", { headers: { Cookie: otherCookie } });
      await expect(changedHistory.json()).resolves.toMatchObject({ count: 0, value: [] });
      expect((await request(`/api/hunting/jobs/${applicationJob.id}/rows`, { headers: { Cookie: otherCookie } })).status).toBe(404);

      const auditRows = (await fixture.runtime.query("SELECT action,status,metadata FROM audit_projection WHERE tenant_id=$1 AND principal_id=$2 AND action LIKE '%hunting%' ORDER BY action,observed_at", [config.tenantId, principalId])).rows;
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
  it("returns a durable Audit Search activation while worker revalidation is pending", async () => {
    const previousUser = authFixture.revalidatedUser;
    let release!: () => void;
    authFixture.pendingRevalidation = new Promise<void>(resolve => { release = resolve; });
    authFixture.revalidatedUser = { ...authFixture.user, homeAccountId: "prompt-audit-reader", roles: ["AgentControl.SecurityReader"] };
    const securityCookie = await roleCookie("prompt-audit-reader", ["AgentControl.SecurityReader"]);
    const started = authFixture.revalidationStarted;
    try {
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
      expect(job).toMatchObject({ status: "reconciling_create", activationCount: 1, providerRequestCount: 0 });
      await vi.waitFor(() => expect(authFixture.revalidationStarted).toBe(started + 1));
      expect((await request(`/api/audit-search/jobs/${job.id}/cancel`, { method: "POST", headers: { Cookie: securityCookie } })).status).toBe(200);
    } finally {
      release();
      authFixture.pendingRevalidation = undefined;
      authFixture.revalidatedUser = previousUser;
    }
  });
  it("consumes a mismatched callback state without redeeming it", async () => {
    const originalCookie=cookie;
    try {
      const login=await request("/api/auth/login");
      cookie=login.headers.get("set-cookie")!.split(";")[0];
      const redemptions=authFixture.redemptions;
      expect((await request("/api/auth/callback?code=fixture&state=wrong-state")).status).toBe(400);
      expect((await request("/api/auth/callback?code=fixture&state=fixture-state")).status).toBe(400);
      expect(authFixture.redemptions).toBe(redemptions);
    } finally { cookie=originalCookie; }
  });
  it("routes all mutation forms through durable idempotent jobs", async () => {
    const key=randomUUID();
    const confirmedBlock = await mutationPreview("block", ["package-1"], "single");
    expect(confirmedBlock).toMatchObject({ summary: { risk: true } });
    const single=await request("/api/agents/package-1/block",{method:"POST",headers:{"Idempotency-Key":key,"Content-Type":"application/json"},body:JSON.stringify(confirmedBlock)});
    expect(single.status).toBe(202); const job=await single.json();
    await fixture.operator.query("UPDATE package_inventory_resources SET is_blocked=true,package_data=jsonb_set(package_data,'{isBlocked}','true'::jsonb) WHERE tenant_id=$1 AND principal_id='fixture-principal' AND native_id='package-1'", [config.tenantId]);
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
      await fixture.operator.query("UPDATE package_inventory_resources SET is_blocked=false,package_data=jsonb_set(package_data,'{isBlocked}','false'::jsonb) WHERE tenant_id=$1 AND principal_id='fixture-principal' AND native_id='package-1'", [config.tenantId]);
    }
    expect((await request(`/api/agents/bulk-jobs/${job.id}`)).status).toBe(200);
    await request(`/api/agents/bulk-jobs/${job.id}/cancel`,{method:"POST"});
    for (const endpoint of ["block","unblock","block-all","unblock-all"]) {
      const action = endpoint.startsWith("unblock") ? "unblock" : "block";
      const preview = await mutationPreview(action, ["package-1"], "bulk");
      const bulkKey=randomUUID();
      const headers={"Idempotency-Key":bulkKey,"Content-Type":"application/json"};
      const body=JSON.stringify(endpoint.endsWith("-all") ? { confirmationHash: preview.confirmationHash } : {ids:["package-1"],...preview});
      const response=await request(`/api/agents/${endpoint}`,{method:"POST",headers,body});
      expect(response.status).toBe(202);
      const created=await response.json();
      const launches = vi.mocked(launchBulkJob).mock.calls.length;
      if (endpoint === "block-all") {
        await fixture.operator.query("DELETE FROM package_inventory_resources WHERE tenant_id=$1 AND principal_id='fixture-principal'", [config.tenantId]);
        expect((await request("/api/agents/block-all", { method: "POST", headers, body: JSON.stringify({ ids: ["different-package"], ...preview }) })).status).toBe(400);
      }
      expect((await (await request(`/api/agents/${endpoint}`,{method:"POST",headers,body})).json()).id).toBe(created.id);
      expect(vi.mocked(launchBulkJob).mock.calls.length).toBe(launches);
      if (endpoint === "block-all") await publishPackageSnapshot("fixture-principal");
      await request(`/api/agents/bulk-jobs/${created.id}/cancel`,{method:"POST"});
    }
    expect(launchBulkJob).toHaveBeenCalled();
  });
  it("executes both approved canary directions as separate durable jobs", async () => {
    const originalCookie = cookie;
    const approvalBody = { targetId: "package-canary", action: "block", prestate: { kind: "block", isBlocked: false }, poststate: { kind: "block", isBlocked: true } };
    try {
      cookie = await roleCookie("approver", ["AgentControl.Administrator"]);
      expect((await request("/api/agents/mutation-canaries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...approvalBody, metadata: {} }) })).status).toBe(400);
      const originalResponse = await request("/api/agents/mutation-canaries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(approvalBody) });
      const restorationResponse = await request("/api/agents/mutation-canaries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...approvalBody, action: "unblock", prestate: approvalBody.poststate, poststate: approvalBody.prestate }) });
      expect(originalResponse.status).toBe(201);
      expect(restorationResponse.status).toBe(201);
      const approval = await originalResponse.json();
      const restorationApproval = await restorationResponse.json();
      expect(approval).toMatchObject({ status: "approved", targetId: "package-canary", approvedBy: { principalId: "approver" }, actor: null });
      expect(restorationApproval).toMatchObject({ status: "approved", action: "unblock", approvedBy: { principalId: "approver" } });

      cookie = await roleCookie("operator", ["AgentControl.Operator"]);
      authFixture.revalidatedUser = { tenantId: config.tenantId!, homeAccountId: "operator", displayName: "Operator", username: "operator@example.invalid", roles: ["AgentControl.Operator"] };
      vi.mocked(GraphPackagesClient.prototype.getPackageDetails)
        .mockResolvedValueOnce({ id: "package-canary", displayName: "Canary", isBlocked: false })
        .mockResolvedValueOnce({ id: "package-canary", displayName: "Canary", isBlocked: false })
        .mockResolvedValueOnce({ id: "package-canary", displayName: "Canary", isBlocked: true })
        .mockResolvedValueOnce({ id: "package-canary", displayName: "Canary", isBlocked: true })
        .mockResolvedValueOnce({ id: "package-canary", displayName: "Canary", isBlocked: true })
        .mockResolvedValueOnce({ id: "package-canary", displayName: "Canary", isBlocked: false });
      const executed = await request(`/api/agents/mutation-canaries/${approval.id}/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true, restorationApprovalId: restorationApproval.id }) });
      expect(executed.status).toBe(200);
      const result = await executed.json();
      expect(result).toMatchObject({ status: "qualified", original: { status: "qualified", action: "block", actor: { principalId: "operator" } }, restoration: { status: "qualified", action: "unblock", actor: { principalId: "operator" } }, jobs: { originalId: expect.any(String), restorationId: expect.any(String) } });
      expect(GraphPackagesClient.prototype.blockPackage).toHaveBeenCalledTimes(1);
      expect(GraphPackagesClient.prototype.unblockPackage).toHaveBeenCalledTimes(1);
      expect((await fixture.operator.query("SELECT count(*)::int AS count FROM jobs WHERE id=ANY($1::uuid[])", [[result.jobs.originalId, result.jobs.restorationId]])).rows[0].count).toBe(2);
      expect((await fixture.operator.query("SELECT count(*)::int AS count FROM job_items WHERE job_id=ANY($1::uuid[]) AND status='succeeded' AND sent_at IS NOT NULL", [[result.jobs.originalId, result.jobs.restorationId]])).rows[0].count).toBe(2);
      expect((await fixture.operator.query("SELECT count(*)::int AS count FROM job_attempts WHERE job_id=ANY($1::uuid[]) AND outcome='succeeded' AND sent_at IS NOT NULL", [[result.jobs.originalId, result.jobs.restorationId]])).rows[0].count).toBe(2);
      expect((await request(`/api/agents/mutation-canaries/${approval.id}/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true, restorationApprovalId: restorationApproval.id }) })).status).toBe(409);
      expect(GraphPackagesClient.prototype.blockPackage).toHaveBeenCalledTimes(1);
      expect(GraphPackagesClient.prototype.unblockPackage).toHaveBeenCalledTimes(1);
    } finally {
      authFixture.revalidatedUser = { tenantId: config.tenantId!, homeAccountId: "fixture-principal", displayName: "Fixture", username: "fixture@example.invalid", roles: ["AgentControl.Reader","AgentControl.Operator","AgentControl.SecurityReader","AgentControl.Administrator"] };
      cookie = originalCookie;
    }
  });
  it("never qualifies a forward canary whose restoration meets an external change", async () => {
    const originalCookie = cookie;
    const approvalBody = { targetId: "package-canary-conflict", action: "block", prestate: { kind: "block", isBlocked: false }, poststate: { kind: "block", isBlocked: true } };
    const blocksBefore = vi.mocked(GraphPackagesClient.prototype.blockPackage).mock.calls.length;
    const unblocksBefore = vi.mocked(GraphPackagesClient.prototype.unblockPackage).mock.calls.length;
    try {
      cookie = await roleCookie("conflict-approver", ["AgentControl.Administrator"]);
      const original = await (await request("/api/agents/mutation-canaries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(approvalBody) })).json();
      const restoration = await (await request("/api/agents/mutation-canaries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...approvalBody, action: "unblock", prestate: approvalBody.poststate, poststate: approvalBody.prestate }) })).json();
      cookie = await roleCookie("conflict-operator", ["AgentControl.Operator"]);
      authFixture.revalidatedUser = { tenantId: config.tenantId!, homeAccountId: "conflict-operator", displayName: "Conflict Operator", username: "conflict-operator@example.invalid", roles: ["AgentControl.Operator"] };
      vi.mocked(GraphPackagesClient.prototype.getPackageDetails)
        .mockResolvedValueOnce({ id: approvalBody.targetId, displayName: "Canary", isBlocked: false })
        .mockResolvedValueOnce({ id: approvalBody.targetId, displayName: "Canary", isBlocked: false })
        .mockResolvedValueOnce({ id: approvalBody.targetId, displayName: "Canary", isBlocked: true })
        .mockResolvedValueOnce({ id: approvalBody.targetId, displayName: "Canary", isBlocked: false });
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
      authFixture.revalidatedUser = { tenantId: config.tenantId!, homeAccountId: "fixture-principal", displayName: "Fixture", username: "fixture@example.invalid", roles: ["AgentControl.Reader","AgentControl.Operator","AgentControl.SecurityReader","AgentControl.Administrator"] };
      cookie = originalCookie;
    }
  });
  it("retains Operator authority through reconciliation publication", async () => {
    const repository = new JobRepository(fixture.runtime);
    const owner = { tenantId: config.tenantId!, principalId: "fixture-principal" };
    const intent: JobIntentInput = { action: "block", targets: [{ id: "reconcile-role-loss", displayName: "Reconcile", prestate: { kind: "block", isBlocked: false } }], actor: authFixture.user, requestPath: "/api/agents/block", scope: "single" };
    const job = await repository.submit(owner, { ...intent, idempotencyKey: randomUUID(), confirmationHash: createJobConfirmation(intent).confirmationHash });
    const provider = {
      getPackageDetails: async () => ({ id: "reconcile-role-loss", displayName: "Reconcile", isBlocked: false }),
      blockPackage: async () => { throw new AppError(503, "ServiceUnavailable", "private-provider-message"); },
      unblockPackage: async () => undefined,
    } as unknown as GraphPackagesClient;
    await runBulkJob(job.id, owner, false, repository, provider, async () => "ephemeral-token");
    authFixture.revalidatedUser = { ...authFixture.user, roles: ["AgentControl.Reader"] };
    try {
      expect((await request(`/api/agents/bulk-jobs/${job.id}/reconcile`, { method: "POST" })).status).toBe(403);
      expect(await repository.get(job.id, owner)).toMatchObject({ results: [{ reconciliationStatus: "required" }] });
    } finally {
      authFixture.revalidatedUser = { tenantId: config.tenantId!, homeAccountId: "fixture-principal", displayName: "Fixture", username: "fixture@example.invalid", roles: ["AgentControl.Reader","AgentControl.Operator","AgentControl.SecurityReader","AgentControl.Administrator"] };
    }
  });
  it("requires same-origin mutations and isolates saved jobs by principal", async () => {
    const preview = await mutationPreview("block", ["package-1"], "single");
    const response=await request("/api/agents/package-1/block",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(preview)});
    const job=await response.json();
    expect((await request("/api/agents/package-1/block",{method:"POST",headers:{Origin:"https://unapproved.invalid","Content-Type":"application/json"},body:JSON.stringify(preview)})).status).toBe(403);
    const otherCookie=await roleCookie("other",["AgentControl.Operator"]);
    const mine=await request("/api/agents/bulk-jobs?limit=20");
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({value:expect.arrayContaining([expect.objectContaining({id:job.id})])});
    const others=await request("/api/agents/bulk-jobs?limit=20",{headers:{Cookie:otherCookie}});
    expect(await others.json()).toEqual({value:[]});
    expect((await request(`/api/agents/bulk-jobs/${job.id}`,{headers:{Cookie:otherCookie}})).status).toBe(404);
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
  it("requires CSRF and keeps app roles non-hierarchical", async () => {
    expect((await request("/api/agents/package-1/block",{method:"POST",headers:{"x-csrf-token":"wrong"}})).status).toBe(403);
    const administratorCookie=await roleCookie("administrator",["AgentControl.Administrator"]);
    expect((await request("/api/agents",{headers:{Cookie:administratorCookie}})).status).toBe(403);
    expect((await request("/api/audit/events",{headers:{Cookie:administratorCookie}})).status).toBe(403);
    const diagnostics=await request("/api/diagnostics",{headers:{Cookie:administratorCookie}});
    expect(diagnostics.status).toBe(200);
    expect(await diagnostics.json()).toEqual({
      authConfigured,maintenance:false,providerWorkEnabled:true,schemaVersion:migrations.length,
      limits:{databasePool:4,requestBodyBytes:524288,exportDeadlineSeconds:15},
    });
    const noRoleCookie=await roleCookie("unassigned",[]);
    const me=await request("/api/me",{headers:{Cookie:noRoleCookie}});
    expect(me.status).toBe(200);
    expect((await me.json()).roleAssignmentRequired).toBe(true);
    expect((await request("/api/capabilities",{headers:{Cookie:noRoleCookie}})).status).toBe(200);
    expect((await request("/api/diagnostics",{headers:{Cookie:noRoleCookie}})).status).toBe(403);
  });
  it("keeps broad inventory Reader-only and Operator reads exact-target", async () => {
    const readerCookie=await roleCookie("reader",["AgentControl.Reader"]);
    const operatorCookie=await roleCookie("operator",["AgentControl.Operator"]);
    expect((await request("/api/agents",{headers:{Cookie:readerCookie}})).status).toBe(200);
    expect((await request("/api/agents",{headers:{Cookie:operatorCookie}})).status).toBe(403);
    expect((await request("/api/agents/details",{method:"POST",headers:{Cookie:operatorCookie,"Content-Type":"application/json"},body:JSON.stringify({ids:["package-1"]})})).status).toBe(403);
    const exact=await request("/api/agents/package-1",{headers:{Cookie:operatorCookie}});
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({id:"package-1",allowedUsersAndGroups:[{resourceId:"sensitive-user"}]});
  });
  it("exports only exact authorized package rows with snapshot provenance, formula safety and row-free audit", async () => {
    const principalId="package-export-reader";
    const readerCookie=await roleCookie(principalId,["AgentControl.Reader"]);
    const snapshotId=await publishPackageSnapshot(principalId);
    await fixture.operator.query(`UPDATE package_inventory_resources
      SET publisher='=formula',package_data=jsonb_set(package_data,'{publisher}',to_jsonb('=formula'::text))
      WHERE tenant_id=$1 AND principal_id=$2 AND snapshot_id=$3`,[config.tenantId,principalId,snapshotId]);
    const response=await request("/api/agents/export.csv",{method:"POST",headers:{Cookie:readerCookie,"Content-Type":"application/json"},body:JSON.stringify({ids:["package-1"],snapshotId})});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=package-inventory.csv");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const rows=parseCsv(await response.text(),{bom:true,columns:true});
    expect(rows).toEqual([expect.objectContaining({id:"package-1",publisher:"'=formula",sourceSystem:"graph_packages",snapshotId})]);
    expect(JSON.stringify(rows)).not.toContain("sensitive-user");
    const securityCookie=await roleCookie(principalId,["AgentControl.SecurityReader"]);
    const audit=await request("/api/audit/events?action=export-package-inventory",{headers:{Cookie:securityCookie}});
    expect(audit.status).toBe(200);
    const auditBody=await audit.json() as {value:Array<{action:string;metadata?:Record<string,unknown>}>};
    expect(auditBody.value).toEqual([expect.objectContaining({action:"export-package-inventory",metadata:expect.objectContaining({source:"graph_packages",snapshotId,resultingCount:1})})]);
    expect(JSON.stringify(auditBody)).not.toContain("=formula");
    const operatorCookie=await roleCookie(principalId,["AgentControl.Operator"]);
    expect((await request("/api/agents/export.csv",{method:"POST",headers:{Cookie:operatorCookie,"Content-Type":"application/json"},body:JSON.stringify({ids:["package-1"],snapshotId})})).status).toBe(403);
    await publishPackageSnapshot(principalId);
    const stale = await request("/api/agents/export.csv",{method:"POST",headers:{Cookie:readerCookie,"Content-Type":"application/json"},body:JSON.stringify({ids:["package-1"],snapshotId})});
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ code: "snapshot_invalidated" });
  });
  it.each(["role", "session", "expiry", "deletion", "application-scope", "filter-source"] as const)(
    "denies export when %s changes during final audit without releasing rows", async change => {
      const principalId = `export-race-${change}`;
      const readerCookie = await roleCookie(principalId, change === "filter-source"
        ? ["AgentControl.Reader", "AgentControl.SecurityReader"] : ["AgentControl.Reader"]);
      const ownerId = change === "application-scope" ? config.clientId! : principalId;
      const snapshotId = await publishPackageSnapshot(ownerId);
      if (change === "filter-source") {
        await new AuditLog({ tenantId: config.tenantId!, principalId }, fixture.runtime).startEvent({
          operationId: "abcd1234-race", scope: "bulk", action: "block", targetBlockedState: true, agentId: "package-1",
          actor: { tenantId: config.tenantId!, homeAccountId: principalId, displayName: "Fixture", username: "fixture@example.invalid" },
          requestPath: "/fixture",
        });
      }
      const complete = AuditLog.prototype.completeEvent;
      const applicationScope = vi.mocked(capabilities.requireApplicationDataScope);
      const previousScopeImplementation = applicationScope.getMockImplementation()!;
      const completing = vi.spyOn(AuditLog.prototype, "completeEvent").mockImplementation(async function (id, update) {
        const completed = await complete.call(this, id, update);
        if (completed.action === "export-package-inventory" && completed.status === "succeeded") {
          if (change === "role") await fixture.operator.query(
            "UPDATE sessions SET sess=jsonb_set(sess::jsonb,'{user,roles}','[]'::jsonb) WHERE principal_id=$1", [principalId]);
          else if (change === "session") await fixture.operator.query("DELETE FROM sessions WHERE principal_id=$1", [principalId]);
          else if (change === "expiry") await fixture.operator.query(
            "UPDATE package_inventory_snapshots SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [snapshotId]);
          else if (change === "deletion") await fixture.operator.query("DELETE FROM package_inventory_snapshots WHERE id=$1", [snapshotId]);
          else if (change === "filter-source") await fixture.operator.query("DELETE FROM audit_events WHERE principal_id=$1 AND action='block'", [principalId]);
          else applicationScope.mockRejectedValue(new AppError(403, "scope_revoked", "Application scope revoked."));
        }
        return completed;
      });
      try {
        const exported = await request(`/api/agents/export.csv${change === "application-scope" ? "?mode=application" : ""}`, {
          method: "POST", headers: { Cookie: readerCookie, "Content-Type": "application/json" },
          body: JSON.stringify({ ...(change === "filter-source" ? { filters: { operationIdPrefix: "abcd1234" } } : { ids: ["package-1"] }), snapshotId }),
        });
        expect(exported.status).toBe(change === "expiry" || change === "filter-source" ? 409 : change === "deletion" ? 404 : change === "application-scope" ? 403 : 401);
        expect(exported.headers.get("content-type")).toContain("application/problem+json");
        const body = await exported.text();
        expect(body).not.toContain("package-1");
        const audit = new AuditLog({ tenantId: config.tenantId!, principalId }, fixture.runtime);
        expect(await audit.listEvents({ action: "export-package-inventory" })).toEqual([
          expect.objectContaining({ status: "failed", metadata: expect.objectContaining({ source: "graph_packages", snapshotId }) }),
        ]);
      } finally {
        completing.mockRestore();
        applicationScope.mockImplementation(previousScopeImplementation);
      }
    });

  it("requires the independent audit role before inventory reference filters, counts and exports", async () => {
    const principalId = "inventory-audit-filter";
    const readerCookie = await roleCookie(principalId, ["AgentControl.Reader"]);
    const snapshotId = await publishPackageSnapshot(principalId);
    const audit = new AuditLog({ tenantId: config.tenantId!, principalId }, fixture.runtime);
    await audit.startEvent({ operationId: "abcd1234-own-action", scope: "bulk", action: "block", targetBlockedState: true,
      agentId: "package-1", actor: { tenantId: config.tenantId!, homeAccountId: principalId, displayName: "Fixture", username: "fixture@example.invalid" },
      requestPath: "/fixture" });
    expect((await request("/api/agents?operationIdPrefix=abcd1234", { headers: { Cookie: readerCookie } })).status).toBe(403);
    const exportRequest = { method: "POST", headers: { Cookie: readerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ snapshotId, filters: { operationIdPrefix: "abcd1234" } }) };
    expect((await request("/api/agents/export.csv", exportRequest)).status).toBe(403);
    const authorizedCookie = await roleCookie(principalId, ["AgentControl.Reader", "AgentControl.SecurityReader"]);
    const result = await request("/api/agents?operationIdPrefix=abcd1234", { headers: { Cookie: authorizedCookie } });
    expect(await result.json()).toMatchObject({ count: 1, value: [{ id: "package-1" }] });
    const otherId = "inventory-audit-filter-other";
    await publishPackageSnapshot(otherId);
    const otherCookie = await roleCookie(otherId, ["AgentControl.Reader", "AgentControl.SecurityReader"]);
    expect(await (await request("/api/agents?operationIdPrefix=abcd1234", { headers: { Cookie: otherCookie } })).json())
      .toMatchObject({ count: 0, value: [] });
  });

  it("exports only current scoped administrative events and rechecks deletion before publication", async () => {
    const principalId = "administrative-export";
    const audit = new AuditLog({ tenantId: config.tenantId!, principalId }, fixture.runtime);
    const event = await audit.startEvent({ operationId: "local-export-target", scope: "single", action: "block", targetBlockedState: true,
      agentId: "package-1", actor: { tenantId: config.tenantId!, homeAccountId: principalId, displayName: "=Formula", username: "fixture@example.invalid" },
      requestPath: "/fixture", message: "private selected audit message" });
    const exportRequest = (selectedCookie: string) => request("/api/audit/events/export.csv", {
      method: "POST", headers: { Cookie: selectedCookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [event.id] }),
    });
    const securityCookie = await roleCookie(principalId, ["AgentControl.SecurityReader"]);
    const exported = await exportRequest(securityCookie);
    expect(exported.status).toBe(200);
    const rows = parseCsv(await exported.text(), { bom: true, columns: true });
    expect(rows).toEqual([expect.objectContaining({ eventId: event.id, sourceSystem: "local_administrative_audit", actorName: "'=Formula" })]);
    const auditRecords = await audit.listEvents({ action: "export-administrative-audit" });
    expect(auditRecords).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ resultingCount: 1 }), status: "succeeded" })]);
    expect(JSON.stringify(auditRecords)).not.toContain("private selected audit message");
    const otherCookie = await roleCookie("administrative-export-other", ["AgentControl.SecurityReader"]);
    expect((await exportRequest(otherCookie)).status).toBe(404);
    const readerCookie = await roleCookie(principalId, ["AgentControl.Reader"]);
    expect((await exportRequest(readerCookie)).status).toBe(403);
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
    const scope = { tenantId: config.tenantId!, authorizationPrincipalId: principalId,
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
    const path = `/api/inventory/resources/native-agent/related?snapshotId=${snapshotId}&type=microsoft.copilotstudio%2Fagents&environmentId=11111111-1111-4111-8111-111111111111`;
    const readerOnly = await roleCookie(principalId, ["AgentControl.Reader"]);
    const unauthorized = await request(path, { headers: { Cookie: readerOnly } });
    expect(await unauthorized.json()).toMatchObject({
      audit: { status: "unauthorized" }, security: { status: "unauthorized" },
      package: { status: "unmatched" }, reports: { status: "unmatched" },
    });
    const permittedCookie = await roleCookie(principalId, ["AgentControl.Reader", "AgentControl.SecurityReader"]);
    const permitted = await request(path, { headers: { Cookie: permittedCookie } });
    expect(permitted.status).toBe(200);
    expect(await permitted.json()).toMatchObject({
      snapshotId, nativeId: "native-agent",
      audit: { status: "available", count: 1, value: [{ jobId: job.id, nativeEventId: "88888888-8888-4888-8888-888888888888", matchedKind: "cds_bot_id" }] },
      security: { status: "unmatched" },
      controls: { quarantineTarget: { environmentId: "11111111-1111-4111-8111-111111111111", botId: "22222222-2222-4222-8222-222222222222" }, packageTarget: null },
    });
    const otherReader = await roleCookie("source-detail-other", ["AgentControl.Reader", "AgentControl.SecurityReader"]);
    expect((await request(path, { headers: { Cookie: otherReader } })).status).toBe(404);
  });
  it("reads authorized saved audit data during provider outage", async () => {
    const securityReaderCookie=await roleCookie("security-reader",["AgentControl.SecurityReader"]);
    vi.mocked(capabilities.requireAvailable).mockRejectedValue(new AppError(502,"provider_error","provider unavailable"));
    try {
      const response=await request("/api/audit/events",{headers:{Cookie:securityReaderCookie}});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({value:[],count:0});
    } finally { vi.mocked(capabilities.requireAvailable).mockResolvedValue(undefined); }
  });
  it("enforces inventory role, CSRF and private job/snapshot/export scope without live GET reads", async () => {
    const principalId="inventory-reader";
    const readerCookie=await roleCookie(principalId,["AgentControl.Reader"]);
    const repository=new PowerPlatformInventoryRepository(fixture.runtime);
    const inventoryScope={tenantId:config.tenantId!,principalId};
    const job=await repository.submit(inventoryScope,{idempotencyKey:"route-inventory",roleScope:"full",requestedTypes:["microsoft.copilotstudio/agents"]});
    await repository.markRunning(inventoryScope,job.id);
    const malicious:PowerPlatformResource={
      tenantId:config.tenantId!,nativeId:"@native",type:"microsoft.copilotstudio/agents",location:null,displayName:"=SUM(1,1)",environmentId:"environment-a",
      createdAt:null,createdBy:null,lastPublishedAt:null,sourceSystem:"power_platform",authoringTool:null,creatorType:"unknown",agentKind:"agent",lifecycle:"draft",
      identityConfidence:"exact_native",identifiers:[{kind:"power_platform_resource_id",value:"@native"}],provenance:{},details:{},unknownFieldCount:0,
    };
    await repository.publish(inventoryScope,job.id,{resources:[malicious],totalRecords:1,pages:1,unknownFieldCount:0});
    const snapshotId=(await repository.getJob(inventoryScope,job.id))!.snapshotId!;
    vi.mocked(capabilities.requireAvailable).mockRejectedValue(new AppError(502,"provider_error","provider unavailable"));
    try {
      for (const path of ["/api/inventory/resources","/api/inventory/refresh-jobs","/api/inventory/snapshots"]) {
        expect((await request(path,{headers:{Cookie:readerCookie}})).status).toBe(200);
      }
      expect((await request("/api/inventory/export.csv",{headers:{Cookie:readerCookie}})).status).toBe(400);
      const resources=await (await request(`/api/inventory/resources?snapshotId=${snapshotId}`,{headers:{Cookie:readerCookie}})).json();
      expect(resources).toMatchObject({count:1,value:[{nativeId:"@native"}],snapshot:{id:snapshotId}});
      const csv=await (await request(`/api/inventory/export.csv?snapshotId=${snapshotId}`,{headers:{Cookie:readerCookie}})).text();
      expect(csv.split("\r\n")[0]).toContain("sourceSystem");
      expect(csv).toContain("\"power_platform\"");
      expect(csv).toContain("\"'@native\"");
      expect(csv).toContain("\"'=SUM(1,1)\"");

      expect((await request("/api/inventory/refresh-jobs",{method:"POST",headers:{Cookie:readerCookie,"x-csrf-token":"wrong","Content-Type":"application/json"},body:"{}"})).status).toBe(403);
      expect((await request(`/api/inventory/refresh-jobs/${job.id}/resume`,{method:"POST",headers:{Cookie:readerCookie,"x-csrf-token":"wrong"}})).status).toBe(403);
      for (const role of ["AgentControl.Operator","AgentControl.SecurityReader","AgentControl.Administrator"] as AppRole[]) {
        const roleOnlyCookie=await roleCookie(`inventory-${role}`, [role]);
        for (const path of ["/api/inventory/resources","/api/inventory/refresh-jobs","/api/inventory/snapshots","/api/inventory/export.csv"]) expect((await request(path,{headers:{Cookie:roleOnlyCookie}})).status).toBe(403);
      }

      const otherReader=await roleCookie("inventory-other",["AgentControl.Reader"]);
      expect((await request(`/api/inventory/refresh-jobs/${job.id}`,{headers:{Cookie:otherReader}})).status).toBe(404);
      expect((await request(`/api/inventory/resources?snapshotId=${snapshotId}&limit=1&offset=0`,{headers:{Cookie:otherReader}})).status).toBe(404);
      expect((await request(`/api/inventory/export.csv?snapshotId=${snapshotId}`,{headers:{Cookie:otherReader}})).status).toBe(404);
      expect(await (await request("/api/inventory/resources",{headers:{Cookie:otherReader}})).json()).toMatchObject({count:0,value:[],snapshot:null});
    } finally { vi.mocked(capabilities.requireAvailable).mockResolvedValue(undefined); }
  });
  it("enforces exact quarantine targeting, Operator writes and SecurityReader-only audit review", async () => {
    const originalCookie = cookie;
    const principalId = "quarantine-operator";
    const operatorCookie = await roleCookie(principalId, ["AgentControl.Operator"]);
    const snapshotId = await publishQuarantineInventory(principalId);
    const readerCookie = await roleCookie("quarantine-reader", ["AgentControl.Reader"]);
    const otherOperatorCookie = await roleCookie("quarantine-other", ["AgentControl.Operator"]);
    const administratorCookie = await roleCookie(principalId, ["AgentControl.Administrator"]);
    const securityReaderCookie = await roleCookie(principalId, ["AgentControl.SecurityReader"]);
    authFixture.revalidatedUser = { tenantId: config.tenantId!, homeAccountId: principalId, displayName: "Quarantine operator", username: "quarantine-operator@example.invalid", roles: ["AgentControl.Operator"] };
    const providerReads = vi.mocked(CopilotStudioQuarantineClient.prototype.getStatus).mock.calls.length;
    try {
      expect((await request("/api/quarantine/targets", { headers: { Cookie: readerCookie } })).status).toBe(403);
      const targetList = await request("/api/quarantine/targets?limit=25&offset=0", { headers: { Cookie: operatorCookie } });
      expect(targetList.status).toBe(200);
      const targetPage = await targetList.json();
      expect(targetPage).toMatchObject({ count: 1, snapshot: { id: snapshotId }, value: [{ nativeId: "native-agent", environmentId: "11111111-1111-4111-8111-111111111111", botId: "22222222-2222-4222-8222-222222222222", quarantineEligibility: { eligible: true } }] });
      expect(targetPage.value[0]).not.toHaveProperty("provenance");
      expect(await (await request("/api/quarantine/targets", { headers: { Cookie: otherOperatorCookie } })).json()).toEqual({ value: [], count: 0, snapshot: null });
      expect(vi.mocked(CopilotStudioQuarantineClient.prototype.getStatus).mock.calls.length).toBe(providerReads);
      expect((await request(`/api/quarantine/status?snapshotId=${snapshotId}&nativeId=native-agent`, { headers: { Cookie: readerCookie } })).status).toBe(403);
      expect((await request("/api/quarantine/status?snapshotId=not-a-uuid&nativeId=native-agent", { headers: { Cookie: operatorCookie } })).status).toBe(400);
      expect(vi.mocked(CopilotStudioQuarantineClient.prototype.getStatus).mock.calls.length).toBe(providerReads);

      const status = await request(`/api/quarantine/status?snapshotId=${snapshotId}&nativeId=native-agent`, { headers: { Cookie: operatorCookie } });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ target: { resourceNativeId: "native-agent", environmentId: "11111111-1111-4111-8111-111111111111", botId: "22222222-2222-4222-8222-222222222222" },
        direct: { isBotQuarantined: false, providerUpdatedAt: "2026-09-09T10:00:00.123Z" }, inventory: { isQuarantined: true, snapshotId }, disagreesWithInventory: true });
      const isolated = await request(`/api/quarantine/status?snapshotId=${snapshotId}&nativeId=native-agent`, { headers: { Cookie: otherOperatorCookie } });
      expect(isolated.status).toBe(409);
      expect(await isolated.json()).toMatchObject({ code: "quarantine_inventory_unavailable" });

      expect((await request("/api/quarantine/preview", { method: "POST", headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "quarantine", snapshotId, resourceNativeIds: ["native-agent"], packageId: "must-not-be-a-target" }) })).status).toBe(400);
      const previewResponse = await request("/api/quarantine/preview", { method: "POST", headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "quarantine", snapshotId, resourceNativeIds: ["native-agent"] }) });
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json();
      expect(preview).toMatchObject({ qualification: { qualified: false, requiredForSubmit: true }, summary: { packageControlIndependent: true, targetCount: 1 } });
      expect((await request("/api/quarantine/jobs", { method: "POST", headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "quarantine", snapshotId, resourceNativeIds: ["native-agent"], confirmationHash: preview.confirmationHash }) })).status).toBe(400);
      expect((await request("/api/quarantine/jobs", { method: "POST", headers: { Cookie: operatorCookie, "Content-Type": "application/json", "Idempotency-Key": "strict-scalar" },
        body: JSON.stringify({ action: "quarantine", snapshotId: [snapshotId], resourceNativeIds: ["native-agent"], confirmationHash: preview.confirmationHash }) })).status).toBe(400);
      const submit = await request("/api/quarantine/jobs", { method: "POST", headers: { Cookie: operatorCookie, "Content-Type": "application/json", "Idempotency-Key": "app-route-unqualified" },
        body: JSON.stringify({ action: "quarantine", snapshotId, resourceNativeIds: ["native-agent"], confirmationHash: preview.confirmationHash }) });
      expect(submit.status).toBe(409);
      expect(await submit.json()).toMatchObject({ code: "quarantine_write_unqualified" });

      const quarantineRepository = new CopilotStudioQuarantineRepository(fixture.runtime);
      const inventoryTarget = (await new PowerPlatformInventoryRepository(fixture.runtime).resolveQuarantineTargets({ tenantId: config.tenantId!, principalId }, snapshotId, ["native-agent"]))[0];
      const frozenTarget = { ...inventoryTarget, directStatus: { environmentId: inventoryTarget.environmentId, botId: inventoryTarget.botId, isBotQuarantined: false,
        lastUpdateTimeUtc: "2026-09-09T10:00:00.123Z", observedAt: new Date().toISOString(), correlationId: randomUUID() } };
      const durableInput = { action: "quarantine" as const, targets: [frozenTarget], actor: { tenantId: config.tenantId!, homeAccountId: principalId,
        displayName: "Quarantine operator", username: "quarantine-operator@example.invalid" }, authority: { contractRevision: "c".repeat(64), permissionRevision: "d".repeat(64), configurationRevision: 1 },
        requestPath: "/api/quarantine/jobs" };
      const durableConfirmation = createQuarantineConfirmation(durableInput);
      await fixture.operator.query(`INSERT INTO copilot_quarantine_qualifications
        (id,tenant_id,target_environment_id,target_bot_id,original_approval_id,restoration_approval_id,original_job_id,restoration_job_id,contract_revision,permission_revision,configuration_revision,auth_mode)
        VALUES(gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),repeat('c',64),repeat('d',64),1,'delegated')`,
      [config.tenantId!, inventoryTarget.environmentId, inventoryTarget.botId]);
      const durableJob = await quarantineRepository.submit({ tenantId: config.tenantId!, principalId }, { ...durableInput, idempotencyKey: "app-route-durable", confirmationHash: durableConfirmation.confirmationHash });
      await fixture.operator.query("DELETE FROM copilot_quarantine_qualifications WHERE tenant_id=$1", [config.tenantId!]);
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

      expect((await request("/api/quarantine/audit", { headers: { Cookie: operatorCookie } })).status).toBe(403);
      expect((await request("/api/quarantine/audit", { headers: { Cookie: administratorCookie } })).status).toBe(403);
      expect((await request("/api/quarantine/audit", { headers: { Cookie: securityReaderCookie } })).status).toBe(200);
    } finally {
      authFixture.revalidatedUser = { tenantId: config.tenantId!, homeAccountId: "fixture-principal", displayName: "Fixture", username: "fixture@example.invalid", roles: ["AgentControl.Reader","AgentControl.Operator","AgentControl.SecurityReader","AgentControl.Administrator"] };
      cookie = originalCookie;
    }
  });
  it("returns a durable waiting inventory job when token acquisition fails after submission", async () => {
    const principalId="inventory-token-loss";
    const readerCookie=await roleCookie(principalId,["AgentControl.Reader"]);
    authFixture.revalidatedUser={tenantId:config.tenantId!,homeAccountId:principalId,displayName:"Inventory token loss",username:"inventory-token-loss@example.invalid",roles:["AgentControl.Reader"]};
    inventoryProviderFixture.queries=0;
    vi.mocked(acquireDelegatedToken).mockRejectedValueOnce(new AppError(401,"interaction_required","Interactive authorization is required."));
    try {
      const response=await request("/api/inventory/refresh-jobs",{method:"POST",headers:{Cookie:readerCookie,"Content-Type":"application/json"},body:JSON.stringify({types:["microsoft.copilotstudio/agents"],environmentId:"environment-a"})});
      expect(response.status).toBe(202);
      const job=await response.json();
      expect(job).toMatchObject({status:"waiting_authorization",environmentScope:"environment-a",requestedTypes:["microsoft.copilotstudio/agents"],snapshotId:null});
      expect(inventoryProviderFixture.queries).toBe(0);
      const persisted=await new PowerPlatformInventoryRepository(fixture.runtime).getJob({tenantId:config.tenantId!,principalId},job.id);
      expect(persisted).toMatchObject({status:"waiting_authorization",snapshotId:null});
    } finally {
      authFixture.revalidatedUser={tenantId:config.tenantId!,homeAccountId:"fixture-principal",displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Reader","AgentControl.Operator","AgentControl.SecurityReader","AgentControl.Administrator"]};
    }
  });
  it("imports official usage through bounded multipart staging and enforces aggregate and user roles", async () => {
    const administratorCookie = await roleCookie("usage-administrator", ["AgentControl.Administrator"]);
    const readerCookie = await roleCookie("fixture-principal", ["AgentControl.Reader"]);
    const securityReaderCookie = await roleCookie("usage-security-reader", ["AgentControl.SecurityReader"]);
    const bundleId = randomUUID();
    const reports = [
      ["agents", "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nusage-agent,=Formula agent,Declarative,1,1,4,2026-07-06"],
      ["userAgents", "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\nusage-agent,=Formula agent,Declarative,@pseudonym,4,2026-07-06\nbridge-agent,Bridge only,Custom,@bridge-only,2,2026-07-05"],
      ["users", "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\n@pseudonym,+Formula user,1,4,2026-07-06\n@users-only,Users only,1,3,2026-07-04"],
    ] as const;
    for (const [kind, csv] of reports) {
      const form = new FormData();
      form.append("bundleId", bundleId);
      form.append("reportingStart", "2026-06-07");
      form.append("reportingEnd", "2026-07-06");
      form.append("periodProvenance", "operator_asserted");
      form.append("sourceAsOf", "2026-07-08T12:00:00Z");
      form.append("sourceAsOfProvenance", "operator_asserted");
      form.append("downloadedAt", "2026-07-08T12:10:00Z");
      form.append("file", new Blob([csv], { type: "application/octet-stream" }), `private-${kind}.not-trusted`);
      const response = await request("/api/official-usage/staging", { method: "POST", headers: { Cookie: administratorCookie }, body: form });
      expect(response.status).toBe(201);
      if (kind === "userAgents") {
        const adminState = await (await request("/api/official-usage/admin", { headers: { Cookie: administratorCookie } })).json();
        expect(adminState.staging).toEqual(expect.arrayContaining(reports.slice(0, 2).map(([stagedKind]) => expect.objectContaining({ kind: stagedKind, bundleId }))));
        const incompleteResponse = await request(`/api/official-usage/bundles/${bundleId}/preview`, {
          method: "POST", headers: { Cookie: administratorCookie },
        });
        expect(incompleteResponse.status).toBe(200);
        const incomplete = await incompleteResponse.json();
        expect(incomplete).toMatchObject({ missingKinds: ["users"], staging: expect.any(Array) });
        expect((await request(`/api/official-usage/bundles/${bundleId}/accept`, {
          method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" },
          body: JSON.stringify({ bundleHash: incomplete.bundleHash, expectedActiveRevision: incomplete.expectedActiveRevision }),
        })).status).toBe(409);
      }
    }

    const deniedForm = new FormData();
    deniedForm.append("file", new Blob([reports[0][1]]), "private.csv");
    expect((await request("/api/official-usage/staging", { method: "POST", headers: { Cookie: administratorCookie, "x-csrf-token": "wrong" }, body: deniedForm })).status).toBe(403);
    expect((await request("/api/official-usage/aggregate", { headers: { Cookie: administratorCookie } })).status).toBe(403);
    expect((await request("/api/official-usage/users", { headers: { Cookie: readerCookie } })).status).toBe(403);
    const otherAdministratorCookie = await roleCookie("usage-other-administrator", ["AgentControl.Administrator"]);
    expect((await request(`/api/official-usage/bundles/${bundleId}/preview`, {
      method: "POST", headers: { Cookie: otherAdministratorCookie },
    })).status).toBe(404);

    const bundlePreviewResponse = await request(`/api/official-usage/bundles/${bundleId}/preview`, {
      method: "POST", headers: { Cookie: administratorCookie },
    });
    expect(bundlePreviewResponse.status).toBe(200);
    const bundlePreview = await bundlePreviewResponse.json();
    expect(bundlePreview).toMatchObject({ bundleId, missingKinds: [], staging: expect.arrayContaining(reports.map(([kind]) => expect.objectContaining({ kind }))) });
    expect((await request(`/api/official-usage/staging/${bundlePreview.staging[0].id}/accept`, {
      method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ stagingRevision: 1, fileHash: bundlePreview.staging[0].fileHash, expectedActiveRevision: 1 }),
    })).status).toBe(404);
    expect((await request(`/api/official-usage/bundles/${bundleId}/accept`, {
      method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleHash: "b".repeat(64), expectedActiveRevision: bundlePreview.expectedActiveRevision }),
    })).status).toBe(409);
    const accepted = await request(`/api/official-usage/bundles/${bundleId}/accept`, {
      method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleHash: bundlePreview.bundleHash, expectedActiveRevision: bundlePreview.expectedActiveRevision }),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json();
    expect(acceptedBody).toMatchObject({ complete: true });
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
      user: { tenantId: crossTenantId, homeAccountId: "cross-tenant-admin", username: "cross-tenant@example.invalid", displayName: "cross-tenant", roles: ["AgentControl.Administrator"] },
    }]);
    expect((await request(`/api/official-usage/bundles/${bundleId}/accept`, {
      method: "POST", headers: { Cookie: signedSessionCookie(crossTenantSid), "Content-Type": "application/json" },
      body: JSON.stringify({ bundleHash: bundlePreview.bundleHash, expectedActiveRevision: bundlePreview.expectedActiveRevision }),
    })).status).toBe(401);

    const aggregate = await request("/api/official-usage/aggregate", { headers: { Cookie: readerCookie } });
    expect(aggregate.status).toBe(200);
    const aggregateBody = await aggregate.json();
    expect(aggregateBody).toMatchObject({ availability: "stale", authority: expect.stringContaining("Microsoft 365 admin center"), agents: { count: 2 } });
    expect(aggregateBody.agents.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "usage-agent", creatorTypeSource: "agents_report", identityStatus: "unresolved" }),
      expect.objectContaining({ agentId: "bridge-agent", creatorTypeSource: "users_and_agents_report", identityStatus: "unresolved" }),
    ]));
    expect(JSON.stringify(aggregateBody)).not.toContain("@pseudonym");

    const users = await request("/api/official-usage/users", { headers: { Cookie: securityReaderCookie } });
    expect(users.status).toBe(200);
    const usersBody = await users.json();
    expect(usersBody).toMatchObject({ counts: { users: 3, accessRows: 2 } });
    expect(usersBody.users.value).toEqual(expect.arrayContaining([expect.objectContaining({
      username: "@pseudonym",
      datasetScope: { reportSetId: expect.any(String), usersVersionId: expect.any(String), userAgentsVersionId: expect.any(String) },
      rows: [expect.objectContaining({ creatorTypeSource: "users_and_agents_report", identityStatus: "unresolved" })],
    })]));
    const aggregateCsv = await (await request("/api/official-usage/aggregate.csv", { headers: { Cookie: readerCookie } })).text();
    const usersCsv = await (await request("/api/official-usage/users.csv?search=pseudonym&creatorType=Declarative&responsesOnly=true", { headers: { Cookie: securityReaderCookie } })).text();
    const allUsersCsv = await (await request("/api/official-usage/users.csv", { headers: { Cookie: securityReaderCookie } })).text();
    const [aggregateHeader, ...aggregateRows] = parseCsv(aggregateCsv, { bom: true }) as string[][];
    const aggregateRow = aggregateRows.find(row => row[aggregateHeader.indexOf("agentId")] === "usage-agent")!;
    const exportedAgent = Object.fromEntries(aggregateHeader.map((column, index) => [column, aggregateRow[index]]));
    expect(exportedAgent).toMatchObject({
      activeUsersTotal: "1",
      activeUsersTotalBasis: "userAgents_distinct_identity",
      activeUsersIdentityCount: "1",
      agentsPeriodProvenance: "operator_asserted",
      agentsSourceFreshness: "unknown",
      userAgentsPeriodProvenance: "operator_asserted",
      userAgentsSourceFreshness: "unknown",
      reportSetId: aggregateBody.activeSet.id,
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
      usersPeriodProvenance: "operator_asserted",
      usersSourceFreshness: "unknown",
      userAgentsPeriodProvenance: "operator_asserted",
      userAgentsSourceFreshness: "unknown",
      reportSetId: aggregateBody.activeSet.id,
    });
    const [allUsersHeader, ...allUsersRows] = parseCsv(allUsersCsv, { bom: true }) as string[][];
    const exportedUsersOnly = Object.fromEntries(allUsersHeader.map((column, index) => [column,
      allUsersRows.find(row => row[allUsersHeader.indexOf("username")] === "'@users-only")![index]]));
    expect(exportedUsersOnly).toMatchObject({
      reportedAgentsUsed: "1",
      reportedResponsesReceived: "3",
      userLastActivityDateUtc: "2026-07-04T00:00:00.000Z",
      responsesSentToUsers: "Unknown",
      agentLastUsedByAnyoneDateUtc: "Unknown",
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

    const activeSetId = aggregateBody.activeSet.id;
    const malformed = new FormData();
    malformed.append("bundleId", randomUUID());
    malformed.append("reportingStart", "2026-06-07");
    malformed.append("reportingEnd", "2026-07-06");
    malformed.append("periodProvenance", "operator_asserted");
    malformed.append("file", new Blob(["private row contents"]), "secret-filename.csv");
    const rejected = await request("/api/official-usage/staging", { method: "POST", headers: { Cookie: administratorCookie }, body: malformed });
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(await rejected.json())).not.toContain("secret-filename");
    expect(await (await request("/api/official-usage/aggregate", { headers: { Cookie: readerCookie } })).json()).toMatchObject({ activeSet: { id: activeSetId } });

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

    expect((await request("/api/official-usage/legacy-cleanup-acknowledgements", {
      method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" }, body: JSON.stringify({ disposition: "reimported" }),
    })).status).toBe(204);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_audit WHERE action='legacy_cleanup_acknowledged' AND actor_principal_id='usage-administrator'")).rows[0].count).toBe(1);
  });
  it("caps simultaneous official usage uploads and releases disconnected reservations", async () => {
    const administratorCookie = await roleCookie("usage-admission-administrator", ["AgentControl.Administrator"]);
    const heldRequests: ClientRequest[] = [];
    const openHeldUpload = async () => {
      const boundary = `held-${randomUUID()}`;
      const held = httpRequest(`${base}/api/official-usage/staging`, {
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
      await new Promise<void>((resolve, reject) => held.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="held.csv"\r\nContent-Type: text/csv\r\n\r\nAgent ID`,
        error => error ? reject(error) : resolve(),
      ));
      heldRequests.push(held);
    };

    await openHeldUpload();
    await openHeldUpload();
    await new Promise(resolve => setTimeout(resolve, 50));

    const denied = new FormData();
    denied.append("file", new Blob(["not retained"]), "denied.csv");
    const deniedResponse = await request("/api/official-usage/staging", {
      method: "POST",
      headers: { Cookie: administratorCookie },
      body: denied,
    });
    expect(deniedResponse.status).toBe(429);
    expect(await deniedResponse.json()).toMatchObject({ code: "upload_admission_full" });

    for (const held of heldRequests) held.destroy();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_staging WHERE actor_principal_id='usage-admission-administrator'")).rows[0].count).toBe(0);

    const recoveredBundleId = randomUUID();
    const recovered = new FormData();
    recovered.append("bundleId", recoveredBundleId);
    recovered.append("reportingStart", "2026-06-07");
    recovered.append("reportingEnd", "2026-07-06");
    recovered.append("periodProvenance", "operator_asserted");
    recovered.append("file", new Blob(["Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nrecovered-agent,Recovered,Declarative,1,0,1,2026-07-06"]), "recovered.csv");
    const recoveredResponse = await request("/api/official-usage/staging", {
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
  it("releases upload admission after a Multer limit failure without retaining staging", async () => {
    const administratorCookie = await roleCookie("usage-multer-administrator", ["AgentControl.Administrator"]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const missingFile = new FormData();
      missingFile.append("bundleId", randomUUID());
      const missing = await request("/api/official-usage/staging", {
        method: "POST", headers: { Cookie: administratorCookie }, body: missingFile,
      });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({ code: "missing_report" });
    }
    const oversized = new FormData();
    oversized.append("file", new Blob([Buffer.alloc(8 * 1024 * 1024 + 1)]), "oversized.csv");
    const rejected = await request("/api/official-usage/staging", {
      method: "POST", headers: { Cookie: administratorCookie }, body: oversized,
    });
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toMatchObject({ code: "report_too_large" });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_staging WHERE actor_principal_id='usage-multer-administrator'")).rows[0].count).toBe(0);

    const bundleId = randomUUID();
    const recovered = new FormData();
    recovered.append("bundleId", bundleId);
    recovered.append("reportingStart", "2026-06-07");
    recovered.append("reportingEnd", "2026-07-06");
    recovered.append("periodProvenance", "operator_asserted");
    recovered.append("file", new Blob(["Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nrecovered-multer,Recovered,Declarative,1,0,1,2026-07-06"]), "recovered.csv");
    const accepted = await request("/api/official-usage/staging", {
      method: "POST", headers: { Cookie: administratorCookie }, body: recovered,
    });
    expect(accepted.status).toBe(201);
    const preview = await accepted.json();
    expect((await request(`/api/official-usage/staging/${preview.id}`, {
      method: "DELETE", headers: { Cookie: administratorCookie },
    })).status).toBe(204);
  });
  it("does not release upload capacity while disconnected repository work is still pending", async () => {
    const administratorCookie = await roleCookie("usage-held-work-administrator", ["AgentControl.Administrator"]);
    const lockClient = await fixture.operator.connect();
    const controller = new AbortController();
    let secondUpload: ClientRequest | undefined;
    let lockReleased = false;
    try {
      await lockClient.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`official-usage:${config.tenantId}`]);
      const form = new FormData();
      form.append("bundleId", randomUUID());
      form.append("reportingStart", "2026-06-07");
      form.append("reportingEnd", "2026-07-06");
      form.append("periodProvenance", "operator_asserted");
      form.append("file", new Blob(["Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nheld-work,Work,Declarative,1,0,1,2026-07-06"]), "held-work.csv");
      const heldWork = request("/api/official-usage/staging", {
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
      secondUpload = httpRequest(`${base}/api/official-usage/staging`, {
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
      const deniedResponse = await request("/api/official-usage/staging", {
        method: "POST", headers: { Cookie: administratorCookie }, body: denied,
      });
      expect(deniedResponse.status).toBe(429);
      expect(await deniedResponse.json()).toMatchObject({ code: "upload_admission_full" });

      await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`official-usage:${config.tenantId}`]);
      lockReleased = true;
      secondUpload.destroy();
      await vi.waitFor(async () => {
        expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_staging WHERE actor_principal_id='usage-held-work-administrator'")).rows[0].count).toBe(0);
        const waiting = await fixture.operator.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname=current_database() AND usename='agentcontrol_app' AND query LIKE 'SELECT pg_advisory_xact_lock%'`);
        expect(waiting.rows[0].count).toBe(0);
      });
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      controller.abort();
      secondUpload?.destroy();
      if (!lockReleased) await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`official-usage:${config.tenantId}`]);
      lockClient.release();
    }
  });
  it("times out a never-ending multipart body when the wall-clock timer advances", async () => {
    const administratorCookie = await roleCookie("usage-deadline-administrator", ["AgentControl.Administrator"]);
    const boundary = `deadline-${randomUUID()}`;
    const bundleId = randomUUID();
    const csv = "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\ndeadline-agent,Deadline,Declarative,1,0,1,2026-07-06";
    const fields = [
      ["bundleId", bundleId],
      ["reportingStart", "2026-06-07"],
      ["reportingEnd", "2026-07-06"],
      ["periodProvenance", "operator_asserted"],
    ].map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("");
    const prefix = `${fields}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="deadline.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}`;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let pending: ClientRequest | undefined;
    let response: Promise<{ status: number; body: string }> | undefined;
    try {
      response = new Promise<{ status: number; body: string }>((resolve, reject) => {
        pending = httpRequest(`${base}/api/official-usage/staging`, {
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
      for (let attempt = 0; attempt < 200 && vi.getTimerCount() === 0; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(15_001);
      await expect(response).resolves.toMatchObject({
        status: 408,
        body: expect.stringContaining('"code":"upload_deadline"'),
      });
    } finally {
      pending?.destroy();
      await response?.catch(() => undefined);
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
        cookie=await roleCookie("refresh-principal",["AgentControl.Reader"],0);
        expect((await request("/api/me")).status).toBe(401);
      }
    } finally {
      authFixture.revalidatedUser={tenantId:config.tenantId!,homeAccountId:"fixture-principal",displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Reader","AgentControl.Operator","AgentControl.SecurityReader","AgentControl.Administrator"]};
      cookie=originalCookie;
    }
  });
  it("does not restore a held role refresh after account logout", async () => {
    const staleCookie=await roleCookie("race-principal",["AgentControl.Reader"],0);
    const logoutCookie=await roleCookie("race-principal",["AgentControl.Reader"]);
    let release!: () => void;
    authFixture.pendingRevalidation=new Promise<void>(resolve => { release=resolve; });
    authFixture.revalidatedUser={tenantId:config.tenantId!,homeAccountId:"race-principal",displayName:"Race",username:"race@example.invalid",roles:["AgentControl.Reader"]};
    const started=authFixture.revalidationStarted;
    const staleRequest=request("/api/me",{headers:{Cookie:staleCookie}});
    await vi.waitFor(() => expect(authFixture.revalidationStarted).toBe(started+1));
    expect((await request("/api/auth/logout",{method:"POST",headers:{Cookie:logoutCookie}})).status).toBe(204);
    release();
    expect((await staleRequest).status).toBe(401);
    expect((await fixture.runtime.query("SELECT 1 FROM sessions WHERE principal_id='race-principal'")).rowCount).toBe(0);
    authFixture.pendingRevalidation=undefined;
    authFixture.revalidatedUser={tenantId:config.tenantId!,homeAccountId:"fixture-principal",displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Reader","AgentControl.Operator","AgentControl.SecurityReader","AgentControl.Administrator"]};
  });
  it("deletes legacy sessions without a role-bearing user shape", async () => {
    const sid=randomUUID();
    await fixture.operator.query("INSERT INTO sessions(sid,sess,expire) VALUES ($1,$2,clock_timestamp()+interval '1 hour')",[sid,{cookie:{originalMaxAge:60000,expires:new Date(Date.now()+60000),httpOnly:true,path:"/"},tenantId:config.tenantId,accountId:"legacy",user:{tenantId:config.tenantId,homeAccountId:"legacy",username:"legacy@example.invalid",displayName:"Legacy"}}]);
    expect((await request("/api/me",{headers:{Cookie:signedSessionCookie(sid)}})).status).toBe(401);
    expect((await fixture.operator.query("SELECT 1 FROM sessions WHERE sid=$1",[sid])).rowCount).toBe(0);
  });
  it("denies mutations in maintenance without disabling health", async () => {
    const preview = await mutationPreview("block", ["package-1"], "single");
    process.env.MAINTENANCE_MODE="true";
    try {
      expect((await request("/api/agents/package-1/block",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(preview)})).status).toBe(503);
      expect((await request("/api/health")).status).toBe(200);
    } finally { delete process.env.MAINTENANCE_MODE; }
    await fixture.operator.query("UPDATE operational_state SET mode='maintenance',provider_work_enabled=false");
    expect((await request("/api/ready")).status).toBe(503);
    expect((await request("/api/health")).status).toBe(200);
    await fixture.operator.query("UPDATE operational_state SET mode='normal',provider_work_enabled=true");
    await fixture.operator.query("UPDATE schema_migrations SET checksum='modified' WHERE version=2");
    expect((await request("/api/ready")).status).toBe(503);
    expect(await (await request("/api/health")).json()).toEqual({ok:true});
  });
});