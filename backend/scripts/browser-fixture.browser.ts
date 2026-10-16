import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type Server } from "node:http";
import { resolve } from "node:path";
import type { AuthenticationResult } from "@azure/msal-node";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { testDatabase, fixturePassword } from "./testDatabase.js";
import { browserFixtureFilePattern, browserFixtureTestFiles, closeFixtureResources, closeFixtureServer } from "./fixtureSupport.js";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { CapabilityRepository, capabilityContractRevision, capabilityPermissionRevision } from "../src/db/capabilities.js";
import { capabilityDefinitions } from "../src/services/capabilityRegistry.js";
import { capabilities } from "../src/services/capabilities.js";
import { GraphPackagesClient } from "../src/services/graphPackages.js";
import { DirectoryPrincipalsClient } from "../src/services/directoryPrincipals.js";
import { appRoles, type CapabilityStatus } from "../src/types/capability.js";
import { AppError } from "../src/errors.js";
import { LargeTenantUsersReports } from "../src/services/largeTenantUsersReports.js";
import { officialReportFingerprint } from "./officialReportFingerprint.js";
import { reportIdentity } from "../src/services/reportIdentity.js";
import { reportRuntime } from "../src/services/reportExportDispatcher.js";
import { PowerPlatformRefreshJobs } from "../src/db/powerPlatformRefreshJobs.js";
import { refreshInventoryFixture } from "./inventoryFixtures.js";
import { powerPlatformInventoryRecord } from "../src/services/inventoryRecordProjection.js";
import { CopilotStudioQuarantineClient } from "../src/services/copilotStudioQuarantine.js";
import { PowerPlatformResourceQueryClient } from "../src/services/powerPlatformResourceQuery.js";
import type { AuthenticatedUser } from "../src/types/session.js";
import { inventoryRuntime } from "../src/services/inventoryRuntime.js";
import { dataSync } from "../src/services/dataSync.js";
import { packageInventory } from "../src/services/packageInventory.js";
import { powerPlatformInventory } from "../src/services/powerPlatformInventory.js";
import { savedReadBrowserFixture } from "./savedReadBrowserFixture.js";
import { DataSyncRepository } from "../src/db/dataSync.js";
import { UserSourceProvider } from "../src/services/userSourceProvider.js";
import { buildCopilotReportUrl, reportHeaders } from "../src/services/userSourceGraphFields.js";

await vi.hoisted(async () => {
  const { configureBrowserFixtureEnvironment } = await import("./fixtureSupport.js");
  const tenant = configureBrowserFixtureEnvironment();
  process.env.TENANTS_JSON = JSON.stringify([
    { tenantId: "11111111-1111-1111-1111-111111111111", domains: ["example.invalid"] },
    { tenantId: "33333333-3333-4333-8333-333333333333", domains: ["csv-desktop.example.invalid"] },
    { tenantId: "44444444-4444-4444-8444-444444444444", domains: ["csv-mobile.example.invalid"] },
    { tenantId: "55555555-5555-4555-8555-555555555555", domains: ["lifecycle.example.invalid"] },
  ].map(profile => ({ ...tenant, ...profile })));
});
const identity = vi.hoisted(() => ({ scenarios: new Map<string, { scenario: string; tenantId: string; username: string }>() }));
vi.mock("../src/auth/msal.js", async original => {
  const actual = await original<typeof import("../src/auth/msal.js")>();
  const fixtureResult = (tenantId: string, accountId: string): AuthenticationResult => {
    const scenario = accountId.replace(/^fixture-/, "");
    const roles = scenario === "missing_internal_role" ? [] : scenario.startsWith("role-") ? appRoles.filter(role => role.endsWith(`.${scenario.slice(5)}`)) : [...appRoles];
    const username = `fixture@${config.tenants.find(profile => profile.tenantId === tenantId)!.domains[0]}`;
    const claims = { tid: tenantId, oid: accountId, preferred_username: username, roles,
      wids: ["d2562ede-74db-457e-a7b6-544e236ebb61"] };
    return {
      authority: `https://login.microsoftonline.com/${tenantId}`, uniqueId: accountId, tenantId,
      scopes: ["openid", "profile"], account: { homeAccountId: accountId, localAccountId: accountId, tenantId,
        environment: "login.microsoftonline.com", username, name: "Synthetic account", idTokenClaims: claims },
      idToken: "synthetic-browser-identity", idTokenClaims: claims, accessToken: accountId,
      fromCache: false, expiresOn: new Date(Date.now() + 3600_000), tokenType: "Bearer", correlationId: "",
    };
  };
  return {
    ...actual,
    createAuthorizationUrl: async (flow: ReturnType<typeof actual.createAuthFlow>) => {
      const scenario = new URL(flow.returnTo, process.env.FRONTEND_ORIGIN).searchParams.get("fixture") ?? "available";
      identity.scenarios.set(flow.state, { scenario, tenantId: flow.tenantId, username: flow.username });
      return `/api/auth/callback?state=${flow.state}&code=${flow.state}`;
    },
    redeemAuthorizationCode: async (code: string) => identity.scenarios.get(code),
    toAuthenticatedUser: (result: AuthenticationResult | { scenario: string; tenantId: string; username: string }) => {
      if (!("scenario" in result)) return actual.toAuthenticatedUser(result);
      const roles = result.scenario === "missing_internal_role" ? [] : result.scenario.startsWith("role-") ? appRoles.filter(role => role.endsWith(`.${result.scenario.slice(5)}`)) : [...appRoles];
      return { tenantId: result.tenantId, homeAccountId: `fixture-${result.scenario}`, displayName: "Synthetic account", username: result.username, roles,
        providerRoleIds: ["d2562ede-74db-457e-a7b6-544e236ebb61"] };
    },
    acquireDelegatedTokenResult: async (tenantId: string, accountId: string) => {
      if (accountId === "fixture-missing_permission" || accountId === "fixture-missing_delegated_grant") throw new AppError(403, "missing_permission", "Synthetic missing permission");
      return fixtureResult(tenantId, accountId);
    },
    acquireApplicationToken: async () => "fixture-application",
    revalidateAuthenticatedUserResult: async (tenantId: string, accountId: string) => fixtureResult(tenantId, accountId),
    evictAccount: async () => undefined,
  };
});

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const selectedBrowserFiles = browserFixtureTestFiles();
let application: ReturnType<typeof createApp>;
let server: Server;
let savedLifecycle: Awaited<ReturnType<typeof savedReadBrowserFixture>> | undefined;
const statuses: CapabilityStatus[] = ["available", "missing_permission", "missing_internal_role", "missing_role", "missing_license", "not_configured", "unsupported", "preview_disabled", "provider_error", "unknown"];
const quarantineEnvironmentId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const qualifiedQuarantineBotId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const unqualifiedQuarantineBotId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const quarantineProviderFixture = { reads: 0, writes: 0, states: new Map<string, boolean>(), updatedAt: new Map<string, string>() };
function quarantineResources() {
  return [
    { nativeId: "browser-qualified-agent", displayName: "Qualified browser agent", botId: qualifiedQuarantineBotId },
    { nativeId: "browser-unqualified-agent", displayName: "Unqualified browser agent", botId: unqualifiedQuarantineBotId },
  ].map(target => ({
    tenantId: config.tenants[0].tenantId!, nativeId: target.nativeId, type: "microsoft.copilotstudio/agents" as const, location: null, displayName: target.displayName,
    environmentId: quarantineEnvironmentId, createdAt: null, createdBy: null, lastPublishedAt: "2026-09-09T09:00:00.000Z", sourceSystem: "power_platform" as const,
    authoringTool: "Copilot Studio", creatorType: "unknown" as const, agentKind: "copilot_studio_agent" as const, lifecycle: "published" as const,
    identityConfidence: "exact_native" as const, identifiers: [{ kind: "power_platform_resource_id" as const, value: target.nativeId },
      { kind: "environment_id" as const, value: quarantineEnvironmentId }, { kind: "cds_bot_id" as const, value: target.botId }],
    provenance: {}, details: { isQuarantined: quarantineProviderFixture.states.get(target.botId) ?? false }, unknownFieldCount: 0,
  }));
}
beforeAll(async () => {
  fixture = await testDatabase();
  pool.options.database = fixture.name; pool.options.user = "agentcontrol_app"; pool.options.password = fixturePassword;
  const repository = new CapabilityRepository(fixture.runtime);
  const applicationDefinition = capabilityDefinitions.find(definition => definition.id === "graph.package.read.application")!;
  await repository.setApplicationConfiguration(config.tenants[0].tenantId!, applicationDefinition.id, true, true, "fixture-administrator", () => undefined);
  const invalidatePrincipal = capabilities.invalidatePrincipal.bind(capabilities);
  vi.spyOn(capabilities, "invalidatePrincipal").mockImplementation(async (user: AuthenticatedUser) => {
    await invalidatePrincipal(user);
    const scenario = user.homeAccountId.replace(/^fixture-/, "");
    if (![...statuses, "stale", "role-Viewer", "role-Admin"].includes(scenario) && !scenario.startsWith("lifecycle-")) return;
    for (const definition of capabilityDefinitions.filter(definition => definition.probe.kind === "provider_read")) {
      const configuration = await repository.configuration(config.tenants[0].tenantId!, definition.id);
      await repository.recordEvidence({ tenantId: config.tenants[0].tenantId!, principalId: definition.mode === "application" ? config.tenants[0].clientId! : user.homeAccountId,
        authorizationPrincipalId: user.homeAccountId, capabilityId: definition.id, resourceAudience: definition.audience, environmentId: definition.cloud,
        tokenMode: definition.mode as "delegated" | "application", permissionRevision: capabilityPermissionRevision(definition), contractRevision: capabilityContractRevision(definition), configurationRevision: configuration.revision,
      }, statuses.includes(scenario as CapabilityStatus) ? scenario as CapabilityStatus : "available", {
        category: scenario === "provider_error" ? "provider_error" : undefined,
        verification: definition.id === "powerPlatform.quarantine.read" ? "token" : "provider",
      }, scenario === "stale" ? -1000 : 240000, () => undefined);
    }
  });
  vi.spyOn(GraphPackagesClient.prototype, "checkCatalogAccess").mockImplementation(async token => {
    if (token === "fixture-provider_error") throw new AppError(502, "provider_error", "Synthetic provider outage");
  });
  vi.spyOn(GraphPackagesClient.prototype, "catalogPages").mockImplementation(async function* (token, options) {
    if (token === "fixture-provider_error") throw new AppError(502, "provider_error", "Synthetic provider outage");
    options.signal?.throwIfAborted();
    const tokenValue = "synthetic-browser-catalog";
    await options.visit(tokenValue);
    const records = [{ id: "synthetic-package", displayName: "Synthetic package", isBlocked: false,
      sourceSystem: "graph_packages" as const, authoringTool: null, creatorType: "unknown" as const,
      agentKind: "copilot_package" as const, lifecycle: "unknown" as const, identityConfidence: "exact_native" as const, provenance: {} }];
    await options.onProgress?.({ pages: 1, observedCount: 1, totalRecords: 1 });
    yield { token: tokenValue, nextToken: null, records, rawCount: 1, expectedCount: 1, page: 1 };
  });
  vi.spyOn(GraphPackagesClient.prototype, "getPackageDetails").mockResolvedValue({ id: "synthetic-package", displayName: "Synthetic package", isBlocked: false, availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [], sourceSystem: "graph_packages", authoringTool: null, creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {} });
  vi.spyOn(DirectoryPrincipalsClient.prototype, "search").mockResolvedValue([]);
  const directory = UserSourceProvider.prototype.directory;
  const activity = UserSourceProvider.prototype.activity;
  const users = new UserSourceProvider(async input => {
    const url = new URL(String(input));
    if (url.origin === "https://graph.microsoft.com"
      && ["/v1.0/subscribedSkus", "/v1.0/users"].includes(url.pathname)) {
      return new Response(JSON.stringify({value:[],"@odata.count":0}), {headers:{"Content-Type":"application/json"}});
    }
    if (url.href === buildCopilotReportUrl()) return new Response(`${reportHeaders.join(",")}\n`,
      {headers:{"Content-Type":"text/csv"}});
    throw new Error("Unexpected synthetic user-source request.");
  });
  vi.spyOn(UserSourceProvider.prototype, "directory").mockImplementation((...args) => directory.apply(users,args));
  vi.spyOn(UserSourceProvider.prototype, "activity").mockImplementation((...args) => activity.apply(users,args));
  vi.spyOn(PowerPlatformResourceQueryClient.prototype, "checkAccess").mockResolvedValue(undefined);
  vi.spyOn(PowerPlatformResourceQueryClient.prototype, "pages").mockImplementation(async function* (token, types, options) {
    options.signal?.throwIfAborted();
    const value = "synthetic-browser-power-platform";
    await options.visit(value);
    const records = token === "fixture-role-Admin" && types.includes("microsoft.copilotstudio/agents")
      && (!options.environmentId || options.environmentId === quarantineEnvironmentId) ? quarantineResources() : [];
    yield { token: value, nextToken: null, records, rawCount: records.length, expectedCount: records.length, page: 1 };
  });
  await seedQuarantineTargets(repository);
  vi.spyOn(CopilotStudioQuarantineClient.prototype, "getStatus").mockImplementation(async (_token, target, options) => {
    quarantineProviderFixture.reads += 1;
    return { ...target, isBotQuarantined: quarantineProviderFixture.states.get(target.botId) ?? false,
      lastUpdateTimeUtc: quarantineProviderFixture.updatedAt.get(target.botId) ?? "2026-09-09T10:00:00.123Z", observedAt: new Date().toISOString(), correlationId: options?.correlationId ?? randomUUID() };
  });
  vi.spyOn(CopilotStudioQuarantineClient.prototype, "setQuarantine").mockImplementation(async (_token, target, requestedState, options) => {
    quarantineProviderFixture.writes += 1;
    quarantineProviderFixture.states.set(target.botId, requestedState);
    quarantineProviderFixture.updatedAt.set(target.botId, "2026-09-10T10:00:00.456Z");
    return { ...target, isBotQuarantined: requestedState, lastUpdateTimeUtc: "2026-09-10T10:00:00.456Z", observedAt: new Date().toISOString(), correlationId: options.correlationId };
  });
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Live provider requests are forbidden in browser fixtures.");
    return realFetch(input, init);
  });
  application = createApp(fixture.runtime, resolve("../frontend/dist"));
  reportRuntime(fixture.runtime).start();
  if (!selectedBrowserFiles.length || selectedBrowserFiles.includes("savedBackendLifecycle.spec.ts")) {
    savedLifecycle = await savedReadBrowserFixture(fixture.runtime, fixture.operator, config.tenants[3].tenantId!);
    process.env.AGENT_CONTROL_LIFECYCLE_CONTROL = savedLifecycle.origin;
    const automaticRefresh = dataSync.automaticRefresh.bind(dataSync);
    vi.spyOn(dataSync, "automaticRefresh").mockImplementation(async (user, signedInAt) => {
      if (!user.homeAccountId.startsWith("fixture-lifecycle-")) return automaticRefresh(user, signedInAt);
      return { run: null, detailJob: null, nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
        revisions: await new DataSyncRepository(fixture.runtime).automaticRevisions({
          tenantId: user.tenantId!, principalId: user.homeAccountId,
        }) };
    });
    const runtime = inventoryRuntime();
    const enqueue = runtime.enqueue.bind(runtime);
    vi.spyOn(runtime, "enqueue").mockImplementation((scope, schedule, signal) => {
      signal?.throwIfAborted();
      return scope.principalId.startsWith("fixture-lifecycle-") ? Promise.resolve(false) : enqueue(scope, schedule, signal);
    });
  }
  inventoryRuntime().start();
  const origin = new URL(process.env.FRONTEND_ORIGIN!);
  await new Promise<void>((done, reject) => {
    server = application.app.listen(Number(origin.port || 80), origin.hostname, error => error ? reject(error) : done());
    server.once("error", reject);
  });
  console.log(JSON.stringify({ event: "isolated_browser_fixture", origin: origin.origin, database: fixture.name, liveProviders: false }));
  expect((await fetch(new URL("/api/ready", origin))).ok).toBe(true);
  const html = await (await fetch(origin)).text();
  const entry = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
  expect(entry).toBeDefined();
  const served = Buffer.from(await (await fetch(new URL(entry!, origin))).arrayBuffer());
  expect(served).toEqual(await readFile(resolve("../frontend/dist", entry!.slice(1))));
  console.log(JSON.stringify({ event: "fixture_compiled_frontend_verified", entry, bytes: served.length,
    sha256: createHash("sha256").update(served).digest("hex") }));
});
afterAll(() => closeFixtureResources(
  () => savedLifecycle?.close(),
  () => dataSync.drain(),
  () => packageInventory.drain(),
  () => powerPlatformInventory.drain(),
  () => inventoryRuntime().drain(),
  () => application?.store.close(),
  () => closeFixtureServer(server),
  () => fixture && reportRuntime(fixture.runtime).drain(),
  () => pool.end(),
  () => fixture?.close(),
  () => { vi.unstubAllGlobals(); },
  () => { vi.restoreAllMocks(); },
));
const browserRuns = selectedBrowserFiles.length
  ? [{ name: "selected workflows", project: undefined }]
  : ["desktop", "mobile"].map(project => ({ name: `${project} workflows`, project }));
for (const run of browserRuns) it(`qualifies packaged ${run.name} through Chromium and axe`, async ({ signal }) => {
  const evidence = process.env.PLAYWRIGHT_EVIDENCE_DIR;
  const exitCode = await new Promise<number | null>((done, reject) => {
    const child = spawn(process.execPath, ["../node_modules/@playwright/test/cli.js", "test", "--config", "../frontend/playwright.config.ts",
      ...(run.project ? ["--project", run.project] : []), ...selectedBrowserFiles.map(browserFixtureFilePattern)], {
      stdio: "inherit", env: { ...process.env,
        ...(run.project && evidence ? { PLAYWRIGHT_EVIDENCE_DIR: `${evidence}/${run.project}` } : {}),
      }, signal,
    });
    child.once("error", reject); child.once("exit", done);
  });
  if (exitCode !== 0) {
    console.info(JSON.stringify({ contract: "browser-inventory-head-diagnostic", value: (await fixture.operator.query(`SELECT
      s.principal_id,s.source,s.epoch,s.session_epoch,r.revision,g.state,g.scope_epoch,g.session_epoch AS generation_session_epoch,
      g.expires_at,c.status AS reconciliation_status,c.pending_sequence,c.published_sequence
      FROM data_scope_epochs s LEFT JOIN inventory_roots r ON s.id=r.scope_id AND r.current
      LEFT JOIN inventory_revisions v ON v.scope_id=r.scope_id AND v.revision=r.revision LEFT JOIN data_generations g ON g.id=v.generation_id
      LEFT JOIN inventory_reconciliation c ON c.scope_id=s.id
      WHERE s.source IN ('inventory_canonical','inventory_packages','inventory_power_platform')
      ORDER BY s.principal_id,s.source LIMIT 100`)).rows }));
  }
  expect(exitCode).toBe(0);
  expect((await fixture.operator.query("SELECT count(*)::int AS count FROM jobs")).rows[0].count).toBe(0);
});
if (!selectedBrowserFiles.length) it("verifies full-browser persistence and exact native provider counts", async () => {
  // The report restart and quarantine mutation postconditions belong to the full browser campaign.
  const reportTenant = config.tenants.find(tenant => tenant.domains.includes("csv-desktop.example.invalid"));
  if (!reportTenant) throw new Error("Synthetic desktop CSV tenant is required for persisted report qualification.");
  const reportReader = new LargeTenantUsersReports(fixture.runtime, config.sessionSecret, config.officialUsageStaleDays);
  const reportScope = await reportIdentity(fixture.runtime, { tenantId: reportTenant.tenantId, homeAccountId: "browser-restart-observer",
    username: "fixture@csv-desktop.example.invalid", displayName: "Synthetic observer", roles: ["AgentControl.Admin"] });
  const beforeRestart = await officialReportFingerprint(reportReader, reportScope);

  await closeFixtureResources(() => closeFixtureServer(server), () => reportRuntime(fixture.runtime).drain(), () => application.store.close());
  application = createApp(fixture.runtime, resolve("../frontend/dist"));
  reportRuntime(fixture.runtime).start();
  const origin = new URL(process.env.FRONTEND_ORIGIN!);
  await new Promise<void>((done, reject) => {
    server = application.app.listen(Number(origin.port || 80), origin.hostname, error => error ? reject(error) : done());
    server.once("error", reject);
  });

  const afterRestart = await officialReportFingerprint(reportReader, reportScope);
  expect(afterRestart).toEqual(beforeRestart);
  expect(afterRestart.activeSetId).not.toBeNull();
  expect(afterRestart.lineage).toHaveLength(3);
  expect(afterRestart.aggregate).toMatchObject({ responses: 9, activeUsers: 1 });
  expect(afterRestart.users).toMatchObject({ count: 1, responses: 9 });
  expect(quarantineProviderFixture.writes).toBe(2);
  expect((await fixture.operator.query("SELECT status,count(*)::int AS count FROM copilot_quarantine_jobs GROUP BY status")).rows).toEqual(expect.arrayContaining([
    { status: "succeeded", count: 2 },
  ]));
});

async function seedQuarantineTargets(capabilityRepository: CapabilityRepository) {
  const scope = { tenantId: config.tenants[0].tenantId!, principalId: "fixture-role-Admin" };
  const inventory = new PowerPlatformRefreshJobs(fixture.runtime);
  const job = await inventory.submit(scope, { idempotencyKey: "browser-quarantine-targets", roleScope: "full", requestedTypes: ["microsoft.copilotstudio/agents"] });
  expect(await inventory.markRunning(scope, job.id)).toBe(true);
  await refreshInventoryFixture(fixture.runtime, scope, job.id, "power_platform", quarantineResources().map(powerPlatformInventoryRecord),
    ["microsoft.copilotstudio/agents"]);
  const published = (await inventory.getJob(scope, job.id))!;
  expect(published.snapshotId).toBeTruthy();
  const definition = capabilityDefinitions.find(value => value.id === "powerPlatform.quarantine.manage")!;
  const configuration = await capabilityRepository.configuration(scope.tenantId, definition.id);
  await fixture.operator.query(`INSERT INTO copilot_quarantine_qualifications
    (id,tenant_id,target_environment_id,target_bot_id,original_approval_id,restoration_approval_id,original_job_id,restoration_job_id,contract_revision,permission_revision,configuration_revision,auth_mode)
    VALUES(gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),$4,$5,$6,'delegated')`,
  [scope.tenantId, quarantineEnvironmentId, qualifiedQuarantineBotId, capabilityContractRevision(definition), capabilityPermissionRevision(definition), configuration.revision]);
  quarantineProviderFixture.states.set(qualifiedQuarantineBotId, false);
  quarantineProviderFixture.states.set(unqualifiedQuarantineBotId, false);
}
