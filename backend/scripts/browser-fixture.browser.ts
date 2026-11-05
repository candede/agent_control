import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
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
import { seedBrowserCapabilityEvidence } from "./browserFixtureCapabilities.js";
import { capabilityDefinitions } from "../src/services/capabilityRegistry.js";
import { capabilities } from "../src/services/capabilities.js";
import { GraphPackagesClient } from "../src/services/graphPackages.js";
import { DirectoryPrincipalsClient } from "../src/services/directoryPrincipals.js";
import { appRoles } from "../src/types/capability.js";
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
import { officeFixtureActivity, officeFixturePerson, publishOfficeSource } from "./officeAppAdoptionFixtures.js";
import { OfficeAppAdoptionRepository } from "../src/db/officeAppAdoption.js";
import { officeApps } from "../src/types/officeAppAdoption.js";
import * as copilotSemantics from "../src/types/copilotUsage.js";

await vi.hoisted(async () => {
  const { configureBrowserFixtureEnvironment, createBrowserFixtureFetch } = await import("./fixtureSupport.js");
  const tenant = configureBrowserFixtureEnvironment();
  process.env.TENANTS_JSON = JSON.stringify([
    { tenantId: "11111111-1111-1111-1111-111111111111", domains: ["example.invalid"] },
    { tenantId: "33333333-3333-4333-8333-333333333333", domains: ["csv-desktop.example.invalid"] },
    { tenantId: "44444444-4444-4444-8444-444444444444", domains: ["csv-mobile.example.invalid"] },
    { tenantId: "55555555-5555-4555-8555-555555555555", domains: ["desktop-running.lifecycle.example.invalid"] },
    { tenantId: "66666666-6666-4666-8666-666666666666", domains: ["desktop-failed.lifecycle.example.invalid"] },
    { tenantId: "77777777-7777-4777-8777-777777777777", domains: ["mobile-running.lifecycle.example.invalid"] },
    { tenantId: "88888888-8888-4888-8888-888888888888", domains: ["mobile-failed.lifecycle.example.invalid"] },
    { tenantId: "99999999-9999-4999-8999-999999999999", domains: ["office-desktop.example.invalid"] },
    { tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", domains: ["office-mobile.example.invalid"] },
    { tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", domains: ["first-sync-desktop.example.invalid"] },
    { tenantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", domains: ["first-sync-mobile.example.invalid"] },
  ].map(profile => ({ ...tenant, ...profile })));
  // Provider clients capture fetch during module initialization.
  vi.stubGlobal("fetch", createBrowserFixtureFetch(globalThis.fetch));
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
let metadataProcess: ChildProcess | undefined;
let metadataDirectory: string | undefined;
async function startMcpMetadata() {
  if (!selectedBrowserFiles.includes("mcpSettings.spec.ts")) return;
  const python = process.env.AGENT_CONTROL_MCP_METADATA_PYTHON;
  if (python !== "/opt/mcp/.venv/bin/python") throw new Error("Verified MCP browser image required.");
  metadataDirectory = resolve(`../.local/browser-mcp-${randomUUID()}`);
  await mkdir(metadataDirectory, { mode: 0o700, recursive: true });
  metadataProcess = spawn(python, ["/opt/mcp/tests/browser_metadata_service.py", metadataDirectory], {
    env: { ...process.env, MCP_FIXTURE_METADATA_TOKEN: randomBytes(32).toString("base64url") + "=" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("MCP metadata fixture startup deadline.")), 15_000);
    metadataProcess!.once("error", error => { clearTimeout(timer); reject(error); });
    metadataProcess!.once("exit", () => { clearTimeout(timer); reject(new Error("MCP metadata fixture exited during startup.")); });
    metadataProcess!.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (!output.includes("\n")) return;
      try {
        const event = JSON.parse(output.split("\n")[0]);
        if (event.event !== "browser_mcp_metadata" || !Number.isInteger(event.port) || event.port < 1024) throw new Error();
        clearTimeout(timer); resolvePort(event.port);
      } catch { clearTimeout(timer); reject(new Error("Invalid MCP metadata fixture identity.")); }
    });
  });
  const tenant = config.tenants[0];
  tenant.integration = { clientId: "33333333-3333-3333-3333-333333333333", audience: tenant.clientId, scope: "AgentControl.Access" };
  Object.assign(process.env, {
    MCP_TENANT_ID: tenant.tenantId, MCP_CLIENT_ID: tenant.integration.clientId, MCP_API_CLIENT_ID: tenant.clientId,
    MCP_PUBLIC_URL: "https://browser-mcp.example.invalid/mcp", MCP_METADATA_ORIGIN: `http://127.0.0.1:${port}`,
    MCP_METADATA_TOKEN_FILE: `${metadataDirectory}/METADATA_TOKEN`, MCP_LOCAL_HOST_PORT: String(port),
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { /* The process reports its bound socket before lifespan finishes. */ }
    if (ready) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  if (!ready) throw new Error("Real MCP metadata fixture did not become ready.");
  console.log(JSON.stringify({ event: "real_mcp_metadata_ready", port, tools: "actual_registered_catalog", providerCalls: 0 }));
}
async function seedOfficeBrowserEvidence() {
  if (selectedBrowserFiles.length && !selectedBrowserFiles.some(file => ["adoptionDashboard.spec.ts", "adoption.spec.ts"].includes(file))) return;
  const repository = new OfficeAppAdoptionRepository(fixture.runtime);
  const freshness = vi.spyOn(copilotSemantics, "isCopilotAppActivityFresh").mockReturnValue(true);
  try {
    for (const tenant of config.tenants.filter(tenant => tenant.domains.some(domain => /^office-(desktop|mobile)\.example\.invalid$/.test(domain)))) {
      for (const [point, days] of [14, 7, 0].entries()) {
        const date = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
        const people = Array.from({ length: 60 }, (_, offset) => {
          const person = officeFixturePerson(offset + 1);
          return { ...person, identity: { ...person.identity, companyName: "Office Fixture",
            department: offset < 54 ? point === 2 ? "Engineering" : "Historical Engineering" : `Department ${offset - 52}`,
            displayName: `${point === 2 ? "Current" : "Historical"} Office Person ${offset + 1}` } };
        });
        await publishOfficeSource(fixture.runtime, "directory", people, tenant.tenantId!);
        const activity = Array.from({ length: 58 }, (_, offset) => {
          const active = offset < 20 + point * 10;
          const recent = new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10);
          const older = new Date(Date.parse(date) - 60 * 86_400_000).toISOString().slice(0, 10);
          const future = new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10);
          const fields = Object.fromEntries(officeApps.map((app, appIndex) => [app.column,
            active && (appIndex < 2 || app.id === "outlook" || offset < 3 && appIndex < 7 - offset) ? recent : appIndex === 0 ? offset === 57 ? future : older : null]));
          return officeFixtureActivity(offset + 1, fields, date);
        });
        await publishOfficeSource(fixture.runtime, "app_activity", activity, tenant.tenantId!);
        const outcome = await repository.reconcile(tenant.tenantId!);
        expect(["published", "idle"]).toContain(outcome.state);
        expect((await fixture.operator.query(`SELECT count(*)::int AS count FROM office_observations o
          JOIN data_generation_heads h ON h.generation_id=o.generation_id WHERE o.tenant_id=$1`, [tenant.tenantId])).rows[0].count).toBe(point + 2);
      }
      expect((await fixture.operator.query(`SELECT count(*)::int AS count FROM office_observations o
        JOIN data_generation_heads h ON h.generation_id=o.generation_id WHERE o.tenant_id=$1`, [tenant.tenantId])).rows[0].count).toBe(4);
      expect((await fixture.operator.query(`SELECT count(*)::int AS count FROM office_person_facts p
        JOIN office_observations o ON o.generation_id=p.generation_id WHERE o.tenant_id=$1 AND o.kind='weekly'`, [tenant.tenantId])).rows[0].count).toBe(0);
      expect((await fixture.operator.query(`SELECT count(*)::int AS count FROM official_usage_sets WHERE tenant_id=$1`, [tenant.tenantId])).rows[0].count).toBe(0);
    }
  } finally {
    freshness.mockRestore();
  }
}
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
  await startMcpMetadata();
  fixture = await testDatabase();
  pool.options.database = fixture.name; pool.options.user = "agentcontrol_app"; pool.options.password = fixturePassword;
  const repository = new CapabilityRepository(fixture.runtime);
  const applicationDefinition = capabilityDefinitions.find(definition => definition.id === "graph.package.read.application")!;
  await repository.setApplicationConfiguration(config.tenants[0].tenantId!, applicationDefinition.id, true, true, "fixture-administrator", () => undefined);
  const invalidatePrincipal = capabilities.invalidatePrincipal.bind(capabilities);
  vi.spyOn(capabilities, "invalidatePrincipal").mockImplementation(async (user: AuthenticatedUser) => {
    await invalidatePrincipal(user);
    await seedBrowserCapabilityEvidence(repository, user);
  });
  vi.spyOn(GraphPackagesClient.prototype, "checkCatalogAccess").mockImplementation(async token => {
    if (token === "fixture-provider_error") throw new AppError(502, "provider_error", "Synthetic provider outage");
  });
  vi.spyOn(GraphPackagesClient.prototype, "collectCatalog").mockImplementation(async (token, options) => {
    if (token === "fixture-provider_error") throw new AppError(502, "provider_error", "Synthetic provider outage");
    options.signal?.throwIfAborted();
    const tokenValue = "synthetic-browser-catalog";
    await options.visit(tokenValue);
    const records = [{ id: "synthetic-package", displayName: "Synthetic package", isBlocked: false,
      sourceSystem: "graph_packages" as const, authoringTool: null, creatorType: "unknown" as const,
      agentKind: "copilot_package" as const, lifecycle: "unknown" as const, identityConfidence: "exact_native" as const, provenance: {} }];
    await options.onRecords(records);
    await options.onPage({ token: tokenValue, nextToken: null, rawCount: 1, expectedCount: 1, page: 1 });
    await options.onProgress?.({ pages: 1, observedCount: 1, totalRecords: 1 });
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
  await seedOfficeBrowserEvidence();
  application = createApp(fixture.runtime, resolve("../frontend/dist"));
  reportRuntime(fixture.runtime).start();
  if (!selectedBrowserFiles.length || selectedBrowserFiles.includes("savedBackendLifecycle.spec.ts")) {
    savedLifecycle = await savedReadBrowserFixture(fixture.runtime, fixture.operator,
      config.tenants.map(tenant => ({ tenantId: tenant.tenantId!, domains: tenant.domains })));
    process.env.AGENT_CONTROL_LIFECYCLE_CONTROL = savedLifecycle.origin;
    const runtime = inventoryRuntime();
    const enqueue = runtime.enqueue.bind(runtime);
    vi.spyOn(runtime, "enqueue").mockImplementation((scope, schedule, signal) => {
      signal?.throwIfAborted();
      return scope.principalId.startsWith("fixture-lifecycle-") ? Promise.resolve(false) : enqueue(scope, schedule, signal);
    });
  }
  const automaticRefresh = dataSync.automaticRefresh.bind(dataSync);
  vi.spyOn(dataSync, "automaticRefresh").mockImplementation(async (user, signedInAt) => {
    const officeFixture = config.tenants.some(tenant => tenant.tenantId === user.tenantId
      && tenant.domains.some(domain => /^office-(desktop|mobile)\.example\.invalid$/.test(domain)));
    if (!officeFixture && !user.homeAccountId.startsWith("fixture-lifecycle-")) return automaticRefresh(user, signedInAt);
    return { run: null, detailJob: null, nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
      revisions: await new DataSyncRepository(fixture.runtime).automaticRevisions({
        tenantId: user.tenantId!, principalId: user.homeAccountId,
      }) };
  });
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
  async () => {
    if (metadataProcess && metadataProcess.exitCode === null) {
      const exited = new Promise<void>(resolveExit => metadataProcess!.once("exit", () => resolveExit()));
      metadataProcess.kill("SIGTERM");
      await exited;
    }
    if (metadataDirectory) await rm(metadataDirectory, { recursive: true });
  },
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
