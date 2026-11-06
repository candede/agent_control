import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { revalidateAuthorizedUser } from "../auth/msal.js";
import { AppError } from "../errors.js";
import { DataSyncRepository } from "../db/dataSync.js";
import { OfficialReportStatusRepository } from "../db/officialReportStatus.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { OfficeAppAdoptionRepository } from "../db/officeAppAdoption.js";
import { PackageRefreshJobs } from "../db/packageRefreshJobs.js";
import { PowerPlatformRefreshJobs } from "../db/powerPlatformRefreshJobs.js";
import { inventorySelectionFixture } from "../../scripts/inventoryFixtures.js";
import type { AuthenticatedUser } from "../types/session.js";
import { AgentPeopleService } from "./agentPeople.js";
import { CopilotUsageService } from "./copilotUsage.js";
import { UserSourceProvider } from "./userSourceProvider.js";
import { reportHeaders } from "./userSourceGraphFields.js";
import type { FetchLike } from "./graphPackages.js";
import { DataSyncService } from "./dataSync.js";
import { GraphPackagesClient } from "./graphPackages.js";
import { PackageInventoryService } from "./packageInventory.js";
import { allowlistedPackage } from "./packageObservation.js";
import { PowerPlatformInventoryService } from "./powerPlatformInventory.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import { reportIdentity } from "./reportIdentity.js";
import { schemaRegistry } from "./officialReportFields.js";
import { config } from "../config.js";
import { browserRequestPrincipal, principalEpochAuthority } from "../auth/requestPrincipal.js";
import { createBrowserCredentials } from "../auth/delegatedCredentials.js";
import { authorityUser, withAuthority } from "../auth/authorityContext.js";
import { activateAccountSession } from "../db/sessions.js";
import { account, apiToken, browserSession, jwk, sdkResponse } from "../auth/authFoundationTestSupport.js";
import { createApp } from "../app.js";
import { loadOperationalState } from "./operationalState.js";
import { dataSync } from "./dataSync.js";

const testTenants = vi.hoisted(() => {
  process.env.SESSION_SECRET = "synthetic-automatic-refresh-integration-secret";
  delete process.env.TENANTS_JSON_FILE;
  const tenants = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  process.env.TENANTS_JSON = JSON.stringify(tenants.map((tenantId, index) => ({
    tenantId, clientId: "44444444-4444-4444-8444-444444444444", clientSecret: "synthetic-automatic-client-secret",
    domains: [`tenant-${index}.example.invalid`],
    integration: { clientId: "55555555-5555-4555-8555-555555555555",
      audience: "44444444-4444-4444-8444-444444444444", scope: "AgentControl.Access" },
  })));
  return tenants;
});

vi.mock("../auth/msal.js", async original => ({
  ...await original<typeof import("../auth/msal.js")>(),
  acquireAuthorizedToken: vi.fn(async () => "synthetic-delegated-token"),
  acquireApplicationToken: vi.fn(async () => "synthetic-application-token"),
  revalidateAuthorizedUser: vi.fn(async () => user),
}));
vi.mock("./capabilities.js", async original => {
  const actual = await original<typeof import("./capabilities.js")>();
  vi.spyOn(actual.capabilities, "requireAvailable").mockResolvedValue(undefined);
  vi.spyOn(actual.capabilities, "requireApplicationDataScope").mockImplementation(async (_capability, actor) => {
    if (!testTenants.includes(actor.tenantId)) throw new Error("Unconfigured synthetic tenant");
  });
  vi.spyOn(actual.capabilities, "observeOperation").mockImplementation(async (_id, _user, operation) => operation(() => undefined));
  vi.spyOn(actual.capabilities, "beginOperationValidation").mockImplementation(() => () => undefined);
  return actual;
});
vi.mock("./powerPlatformResourceQuery.js", async original => ({
  ...await original<typeof import("./powerPlatformResourceQuery.js")>(),
  PowerPlatformResourceQueryClient: class {
    async *pages(_token: string, _queriedTypes: string[], options: { visit: (token: string) => Promise<void> }) {
      await options.visit("native-first");
      yield { token: "native-first", nextToken: null, records: [], rawCount: 0, expectedCount: 0, page: 1, omittedFieldCount: 0 };
    }
  },
}));

const user: AuthenticatedUser = { tenantId: testTenants[0], homeAccountId: randomUUID(),
  username: "automatic@example.invalid", displayName: "Automatic fixture", roles: ["AgentControl.Viewer"] };
const scope = { tenantId: user.tenantId!, principalId: user.homeAccountId };
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let service: DataSyncService;
let packages: PackageInventoryService;
let powerPlatform: PowerPlatformInventoryService;
let repository: DataSyncRepository;
let packageRepository: PackageRefreshJobs;
const sourceRead: FetchLike = async url => {
  if (String(url).includes("/subscribedSkus")) return Response.json({ value: [] });
  if (new URL(String(url)).pathname.endsWith("/users")) return Response.json({ value: [] });
  if (String(url).includes("getMicrosoft365CopilotUsageUserDetail")) return new Response(`${reportHeaders.join(",")}\n`);
  throw new Error("Unexpected native synthetic provider request");
};
const sourceFetch = vi.fn(sourceRead);
const provider = new UserSourceProvider(sourceFetch);

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new DataSyncRepository(fixture.runtime);
  packageRepository = new PackageRefreshJobs(fixture.runtime);
  packages = new PackageInventoryService(packageRepository);
  powerPlatform = new PowerPlatformInventoryService(new PowerPlatformRefreshJobs(fixture.runtime));
  service = new DataSyncService(fixture.runtime, {
    repository, packages, powerPlatform,
    officialUsage: new OfficialReportStatusRepository(fixture.runtime),
    copilotUsage: new CopilotUsageService(fixture.runtime, { provider }),
    agentPeople: new AgentPeopleService(fixture.runtime),
    wait: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
  });
});
afterAll(async () => {
  await service?.drain();
  await Promise.all([packages?.drain(), powerPlatform?.drain()]);
  vi.restoreAllMocks();
  await fixture?.close();
});

it("bootstraps a fresh employee-first database once across reconnects and concurrent identities without publishing a workplace for an unlicensed caller", async () => {
  const isolated = await testDatabase();
  const tenant = config.tenants[0];
  const firstOid = randomUUID();
  const first = { ...account(firstOid), tenantId: tenant.tenantId, homeAccountId: `${firstOid}.${tenant.tenantId}` };
  const session = { ...browserSession(first), tenantId: tenant.tenantId, clientId: tenant.clientId };
  session.user = { ...session.user!, tenantId: tenant.tenantId, roles: [] };
  await activateAccountSession(tenant.tenantId, first.homeAccountId, async () => {});
  const epochs = principalEpochAuthority(isolated.runtime);
  const source = createBrowserCredentials(await browserRequestPrincipal(session, first, epochs), epochs);
  const actor = authorityUser(source);
  const secondOid = randomUUID();
  const second = { ...account(secondOid), tenantId: tenant.tenantId, homeAccountId: `${secondOid}.${tenant.tenantId}` };
  const otherSession = { ...session, accountId: second.homeAccountId, user: { ...session.user, homeAccountId: second.homeAccountId } };
  await activateAccountSession(tenant.tenantId, second.homeAccountId, async () => {});
  const other = createBrowserCredentials(await browserRequestPrincipal(otherSession, second, epochs), epochs);
  const repo = new DataSyncRepository(isolated.runtime);
  const packageJobs = new PackageRefreshJobs(isolated.runtime);
  const packageService = new PackageInventoryService(packageJobs);
  const pp = new PowerPlatformInventoryService(new PowerPlatformRefreshJobs(isolated.runtime));
  const ppSubmit = vi.spyOn(pp, "submit");
  const reads = vi.fn<FetchLike>(async url => {
    if (String(url).includes("/subscribedSkus")) return Response.json({ value: [] });
    if (String(url).includes("getMicrosoft365CopilotUsageUserDetail")) return new Response(`${reportHeaders.join(",")}\n`);
    throw new Error("Unlicensed fixture must not enumerate a guessed employee workplace.");
  });
  const sync = new DataSyncService(isolated.runtime, {
    repository: repo, packages: packageService, powerPlatform: pp,
    officialUsage: new OfficialReportStatusRepository(isolated.runtime),
    copilotUsage: new CopilotUsageService(isolated.runtime, { provider: new UserSourceProvider(reads) }),
    agentPeople: new AgentPeopleService(isolated.runtime),
    officeRecovery: signal => new OfficeAppAdoptionRepository(isolated.runtime).recover(undefined, signal),
    wait: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
  });
  const submitted = vi.spyOn(packageService, "submit");
  const catalog = vi.spyOn(GraphPackagesClient.prototype, "collectCatalog").mockImplementation(async (_token, options) => {
    await options?.visit?.("employee-first");
    await options.onRecords([]);
    await options.onPage({ token: "employee-first", nextToken: null, rawCount: 0, expectedCount: 0, page: 1 });
  });
  vi.mocked(revalidateAuthorizedUser).mockImplementation(async (_tenant, principal) => principal === actor.homeAccountId ? actor : authorityUser(other));
  const identityFetch: typeof fetch = async (url, request) => {
    if (String(url).endsWith("/discovery/v2.0/keys")) return Response.json({ keys: [jwk] });
    if (String(url).startsWith("https://graph.microsoft.com/v1.0/users/")) {
      return Response.json({ id: first.localAccountId, accountEnabled: true, userType: "Member" });
    }
    return sdkResponse({ oid: first.localAccountId, uid: firstOid, utid: tenant.tenantId,
      claims: { aud: tenant.clientId, tid: tenant.tenantId, iss: `https://login.microsoftonline.com/${tenant.tenantId}/v2.0` } }, request);
  };
  const application = createApp(isolated.runtime, undefined, identityFetch);
  await loadOperationalState(isolated.runtime);
  const server = createServer(application.app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Isolated HTTP fixture did not start.");
  const origin = `http://127.0.0.1:${address.port}`;
  const token = apiToken({ aud: tenant.clientId, tid: tenant.tenantId, oid: first.localAccountId,
    iss: `https://login.microsoftonline.com/${tenant.tenantId}/v2.0`, azp: tenant.integration!.clientId, roles: [] });
  const entry = vi.spyOn(dataSync, "authenticatedEntry").mockImplementation((reader, at) => sync.authenticatedEntry(reader, at));
  try {
    const profile = await fetch(`${origin}/api/mcp/access-profile`, { headers: { authorization: `Bearer ${token}` } });
    expect(profile.status).toBe(200);
    expect((await profile.json()).audience).toBe("end_user");
    expect(submitted).not.toHaveBeenCalled();
    const entered = await fetch(`${origin}/api/mcp/authenticated-entry`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}",
    });
    expect(entered.status).toBe(202);
    expect((await entered.json()).admission).toBe("scheduled");
    expect(entry).toHaveBeenCalledWith(expect.objectContaining({ homeAccountId: actor.homeAccountId, roles: [] }), expect.any(Number));
    await Promise.all([
      withAuthority(source, () => sync.authenticatedEntry(actor, source.principal.authenticatedAt)),
      withAuthority(other, () => sync.authenticatedEntry(authorityUser(other), other.principal.authenticatedAt)),
    ]);
    const run = await repo.getLatestRun({ tenantId: tenant.tenantId, principalId: actor.homeAccountId });
    expect(run).toBeDefined();
    await vi.waitFor(async () => expect(await repo.getRun({ tenantId: tenant.tenantId, principalId: actor.homeAccountId }, run!.id)).toMatchObject({ status: "completed" }), { timeout: 5000 });
    await withAuthority(source, () => sync.authenticatedEntry(actor, source.principal.authenticatedAt));
    expect(submitted).toHaveBeenCalledOnce();
    expect(submitted.mock.calls[0][0]).toMatchObject({ homeAccountId: actor.homeAccountId, roles: [] });
    expect(catalog).toHaveBeenCalledOnce();
    expect(ppSubmit).not.toHaveBeenCalled();
    const runs = await isolated.runtime.query("SELECT principal_id FROM data_sync_runs WHERE tenant_id=$1", [tenant.tenantId]);
    expect(runs.rows).toEqual([{ principal_id: actor.homeAccountId }]);
    expect((await repo.getRun({ tenantId: tenant.tenantId, principalId: actor.homeAccountId }, run!.id))!.sources.map(value => value.source).sort()).toEqual(["graph_packages", "users"]);
    expect(reads.mock.calls).toHaveLength(2);
    expect((await isolated.runtime.query("SELECT identity,company,department FROM directory_user_rows")).rows).toEqual([]);
    await expect(sync.start(actor, { mode: "incremental" })).rejects.toMatchObject({ code: "missing_internal_role" });
    await expect(sync.automaticRefresh(actor)).rejects.toMatchObject({ code: "missing_internal_role" });
    await expect(packageService.cancel(actor, randomUUID(), "application")).rejects.toMatchObject({ code: "missing_internal_role" });
    await expect(pp.cancel(actor, randomUUID())).rejects.toMatchObject({ code: "missing_internal_role" });
    await sync.recover();
    await withAuthority(source, () => sync.authenticatedEntry(actor, source.principal.authenticatedAt));
    expect(catalog).toHaveBeenCalledOnce();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    application.store.close();
    try { await sync.drain(); }
    finally {
      await Promise.all([packageService.drain(), pp.drain()]);
      submitted.mockRestore(); catalog.mockRestore(); ppSubmit.mockRestore(); entry.mockRestore();
      vi.mocked(revalidateAuthorizedUser).mockResolvedValue(user);
      await isolated.close();
    }
  }
}, 20_000);

it("automatically recovers interrupted employee application reads after worker restart and fresh same-user sign-in", async () => {
  const isolated = await testDatabase();
  const tenant = config.tenants[0];
  const oid = randomUUID();
  const selected = { ...account(oid), tenantId: tenant.tenantId, homeAccountId: `${oid}.${tenant.tenantId}` };
  const epochs = principalEpochAuthority(isolated.runtime);
  const freshSource = async () => {
    const session = { ...browserSession(selected), tenantId: tenant.tenantId, clientId: tenant.clientId };
    session.user = { ...session.user!, tenantId: tenant.tenantId, roles: [] };
    await activateAccountSession(tenant.tenantId, selected.homeAccountId, async () => {});
    return createBrowserCredentials(await browserRequestPrincipal(session, selected, epochs), epochs);
  };
  const repository = new DataSyncRepository(isolated.runtime);
  let interruptedDirectory = false;
  const reads: FetchLike = async (url, options) => {
    if (String(url).includes("/subscribedSkus")) {
      if (!interruptedDirectory) {
        interruptedDirectory = true;
        const signal = options?.signal;
        if (!signal) throw new Error("Interrupted directory must have its real cancellation signal.");
        await new Promise<void>((_resolve, reject) => {
          signal.throwIfAborted();
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return Response.json({ value: [] });
    }
    return new Response(`${reportHeaders.join(",")}\n`);
  };
  const instance = () => {
    const packages = new PackageInventoryService(new PackageRefreshJobs(isolated.runtime));
    const powerPlatform = new PowerPlatformInventoryService(new PowerPlatformRefreshJobs(isolated.runtime));
    const sync = new DataSyncService(isolated.runtime, { repository, packages, powerPlatform,
      officialUsage: new OfficialReportStatusRepository(isolated.runtime),
      copilotUsage: new CopilotUsageService(isolated.runtime, { provider: new UserSourceProvider(reads) }),
      agentPeople: new AgentPeopleService(isolated.runtime),
      wait: (milliseconds, signal) => delay(milliseconds, undefined, { signal }) });
    return { sync, packages, powerPlatform };
  };
  const original = instance(), restarted = instance();
  const source = await freshSource(), actor = authorityUser(source);
  const owner = { tenantId: tenant.tenantId, principalId: actor.homeAccountId };
  const catalog = vi.spyOn(GraphPackagesClient.prototype, "collectCatalog").mockImplementation(async (_token, options) => {
    await options.visit("recovered-employee");
    await options.onRecords([]);
    await options.onPage({ token: "recovered-employee", nextToken: null, rawCount: 0, expectedCount: 0, page: 1 });
  }).mockImplementationOnce(async (_token, options) => {
    const signal = options.signal;
    if (!signal) throw new Error("Interrupted collection must have its real cancellation signal.");
    await options.visit("interrupted-employee");
    await new Promise<void>((_resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const originalPp = vi.spyOn(original.powerPlatform, "submit"), restartedPp = vi.spyOn(restarted.powerPlatform, "submit");
  vi.mocked(revalidateAuthorizedUser).mockResolvedValue(actor);
  try {
    await withAuthority(source, () => original.sync.authenticatedEntry(actor, source.principal.authenticatedAt));
    await vi.waitFor(() => expect(catalog).toHaveBeenCalledOnce(), { timeout: 5000 });
    await vi.waitFor(() => expect(interruptedDirectory).toBe(true), { timeout: 5000 });
    const interrupted = await repository.getLatestRun(owner);
    await original.sync.drain();
    await Promise.all([original.packages.drain(), original.powerPlatform.drain()]);
    expect((await isolated.runtime.query("SELECT status,error_code FROM user_source_attempts WHERE source='directory'")).rows)
      .toEqual([{ status: "cancelled", error_code: "interaction_required" }]);
    await restarted.sync.recover();
    const renewed = await freshSource();
    await withAuthority(renewed, () => restarted.sync.authenticatedEntry(authorityUser(renewed), renewed.principal.authenticatedAt));
    const resumed = await repository.getLatestRun(owner);
    expect(resumed?.id).not.toBe(interrupted?.id);
    await vi.waitFor(async () => {
      const current = await repository.getRun(owner, resumed!.id);
      expect(current, JSON.stringify(current)).toMatchObject({ status: "completed" });
    }, { timeout: 5000 });
    expect(catalog).toHaveBeenCalledTimes(2);
    expect(originalPp).not.toHaveBeenCalled(); expect(restartedPp).not.toHaveBeenCalled();
    expect(resumed!.sources.map(value => value.source).every(value => ["graph_packages", "users"].includes(value))).toBe(true);
    expect((await isolated.runtime.query("SELECT DISTINCT principal_id FROM data_sync_runs")).rows)
      .toEqual([{ principal_id: actor.homeAccountId }]);
    await expect(restarted.sync.start(actor, { mode: "incremental" })).rejects.toMatchObject({ code: "missing_internal_role" });
  } finally {
    await Promise.all([original.sync.drain(), restarted.sync.drain()]);
    await Promise.all([original.packages.drain(), original.powerPlatform.drain(), restarted.packages.drain(), restarted.powerPlatform.drain()]);
    catalog.mockRestore(); originalPp.mockRestore(); restartedPp.mockRestore();
    vi.mocked(revalidateAuthorizedUser).mockResolvedValue(user);
    await isolated.close();
  }
}, 20_000);

it.each(["AgentControl.Viewer", "AgentControl.Admin"] as const)("preserves fresh %s automatic first-run admission", async role => {
  const isolated = await testDatabase();
  const tenant = config.tenants[0];
  const selected = { ...account(randomUUID()), tenantId: tenant.tenantId };
  const session = { ...browserSession(selected), tenantId: tenant.tenantId, clientId: tenant.clientId };
  session.user = { ...session.user!, tenantId: tenant.tenantId, roles: [role] };
  await activateAccountSession(tenant.tenantId, selected.homeAccountId, async () => {});
  const epochs = principalEpochAuthority(isolated.runtime);
  const source = createBrowserCredentials(await browserRequestPrincipal(session, selected, epochs), epochs);
  const actor = authorityUser(source), owner = { tenantId: tenant.tenantId, principalId: actor.homeAccountId };
  const repository = new DataSyncRepository(isolated.runtime);
  const packages = new PackageInventoryService(new PackageRefreshJobs(isolated.runtime));
  const powerPlatform = new PowerPlatformInventoryService(new PowerPlatformRefreshJobs(isolated.runtime));
  const sync = new DataSyncService(isolated.runtime, { repository, packages, powerPlatform,
    officialUsage: new OfficialReportStatusRepository(isolated.runtime),
    copilotUsage: new CopilotUsageService(isolated.runtime, { provider: new UserSourceProvider(sourceRead) }), agentPeople: new AgentPeopleService(isolated.runtime),
    wait: (milliseconds, signal) => delay(milliseconds, undefined, { signal }) });
  const catalog = vi.spyOn(GraphPackagesClient.prototype, "collectCatalog").mockImplementation(async (_token, options) => {
    await options.visit("staff-first");
    await options.onRecords([]);
    await options.onPage({ token: "staff-first", nextToken: null, rawCount: 0, expectedCount: 0, page: 1 });
  });
  vi.mocked(revalidateAuthorizedUser).mockResolvedValue(actor);
  try {
    await withAuthority(source, () => sync.authenticatedEntry(actor, source.principal.authenticatedAt));
    const run = await repository.getLatestRun(owner);
    await vi.waitFor(async () => expect(await repository.getRun(owner, run!.id)).toMatchObject({ status: "completed" }), { timeout: 5000 });
    expect(run!.sources.map(value => value.source).sort()).toEqual(["graph_packages", "power_platform", "users"]);
    await withAuthority(source, () => sync.authenticatedEntry(actor, source.principal.authenticatedAt));
    expect(catalog).toHaveBeenCalledOnce();
  } finally {
    await sync.drain(); await Promise.all([packages.drain(), powerPlatform.drain()]);
    catalog.mockRestore(); vi.mocked(revalidateAuthorizedUser).mockResolvedValue(user); await isolated.close();
  }
}, 15_000);

async function waitForRun(owner: typeof scope, id: string, status: "completed" | "partial") {
  try {
    await vi.waitFor(async () => expect(await repository.getRun(owner, id)).toMatchObject({ status }), { timeout: 2000 });
  } catch (error) {
    const attempts = await fixture.runtime.query(`SELECT a.source,a.status,a.error_code FROM user_source_attempts a
      JOIN data_scope_epochs s ON s.id=a.scope_id WHERE a.tenant_id=$1 AND s.scope_kind='tenant' ORDER BY a.source LIMIT 20`,
    [owner.tenantId]);
    throw new Error(`Automatic ${status} boundary: ${JSON.stringify({ run: await repository.getRun(owner, id), attempts: attempts.rows })}`, { cause: error });
  }
}

it("publishes initial inventory/users independently, then queues a same-selector catalogue behind bounded detail work without failing", async () => {
  const summary = allowlistedPackage({ id: "fixture-package", displayName: "Fixture agent", isBlocked: false,
    lastModifiedDateTime: "2026-09-24T00:00:00.000Z", version: "1" });
  const list = vi.spyOn(GraphPackagesClient.prototype, "collectCatalog").mockImplementation(async (_token, options) => {
    await options?.visit?.("graph-first");
    await options.onRecords([summary]);
    await options.onPage({ token: "graph-first", nextToken: null, rawCount: 1, expectedCount: 1, page: 1 });
  });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const details = vi.spyOn(GraphPackagesClient.prototype, "getPackageDetails").mockImplementation(async () => {
    await blocked;
    return { ...summary, longDescription: "Saved slow detail", allowedUsersAndGroups: [], acquireUsersAndGroups: [] };
  });
  const sources = vi.spyOn(provider, "refresh");
  try {
    const initial = await service.automaticRefresh(user);
    expect(initial.run).toMatchObject({ automatic: true });
    await waitForRun(scope, initial.run!.id, "completed");
    expect(await service.state(user)).toMatchObject({ onboardingRequired: false });
    expect(list).toHaveBeenCalledOnce();
    expect(details.mock.calls.length).toBeLessThanOrEqual(1);
    expect(sources.mock.calls.map(([, input]) => input.scope.source).sort()).toEqual(["app_activity", "directory"]);
    expect(sourceFetch).toHaveBeenCalledTimes(2);
    expect(sourceFetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(expect.arrayContaining([
      "/v1.0/subscribedSkus", "/v1.0/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D28',version='v2')",
    ]));
    expect((await fixture.runtime.query(`SELECT attempt.source,attempt.status,attempt.observed_count FROM user_source_attempts attempt
      JOIN data_scope_epochs scope ON scope.id=attempt.scope_id AND scope.tenant_id=attempt.tenant_id
      WHERE attempt.tenant_id=$1 AND scope.scope_kind='tenant' AND scope.token_mode='tenant'
      ORDER BY attempt.source LIMIT 250`, [scope.tenantId])).rows).toEqual([
      { source: "app_activity", status: "available", observed_count: 0 }, { source: "directory", status: "available", observed_count: 0 },
    ]);
    expect((await inventorySelectionFixture(fixture.runtime, scope, {}, "packages")).raw.value.map(value => value.id)).toEqual([summary.id]);

    const enriching = await service.automaticRefresh(user);
    expect(enriching.detailJob).toMatchObject({ status: "running" });
    await vi.waitFor(() => expect(details).toHaveBeenCalledOnce(), { timeout: 10_000 });
    await fixture.operator.query(`UPDATE data_sync_success_markers SET last_success_at=clock_timestamp()-interval '6 hours 1 minute'
      WHERE tenant_id=$1 AND source_id='graph_packages'`, [scope.tenantId]);
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '6 hours 1 minute'
      WHERE run_id=$1 AND source_id='graph_packages'`, [initial.run!.id]);
    const next = await service.automaticRefresh(user);
    expect(next.run?.id).not.toBe(initial.run!.id);
    await vi.waitFor(async () => {
      const current = await repository.getRun(scope, next.run!.id);
      expect(current?.sources.find(source => source.source === "graph_packages")).toMatchObject({ status: "running" });
    });
    expect(list).toHaveBeenCalledOnce();
    expect(details).toHaveBeenCalledOnce();
    expect((await fixture.runtime.query(`SELECT count(*)::integer AS count FROM data_generations g
      JOIN data_scope_epochs s ON s.id=g.scope_id WHERE s.tenant_id=$1 AND s.scope_kind='tenant'
        AND s.source='inventory_packages' AND g.state IN ('staging','validating')`,
    [scope.tenantId])).rows[0].count).toBe(1);
    expect((await inventorySelectionFixture(fixture.runtime, scope, {}, "packages")).raw.value.map(value => value.id)).toEqual([summary.id]);
    const beforeDetails = await repository.automaticRevisions(scope);
    release();
    await vi.waitFor(async () => expect(await packages.get(user, enriching.detailJob!.id, "application"))
      .toMatchObject({ status: "succeeded" }), { timeout: 10_000 });
    await waitForRun(scope, next.run!.id, "completed");
    expect(list).toHaveBeenCalledTimes(2);
    const saved = await inventorySelectionFixture(fixture.runtime, scope, {}, "packages");
    expect((await saved.queries.exact(saved.selection.id, saved.identity, [summary.id]))[0].residual.longDescription).toBe("Saved slow detail");
    expect((await repository.automaticRevisions(scope)).graph_packages).not.toBe(beforeDetails.graph_packages);
  } finally {
    release();
  }
});

it("recovers the same principal after sign-in without replaying old authentication failures or restarting fresh work", async () => {
  const reader = { ...user, tenantId: testTenants[1], homeAccountId: randomUUID() };
  const owner = { tenantId: reader.tenantId!, principalId: reader.homeAccountId };
  const expiredSignIn = Date.now() - 60_000;
  vi.mocked(revalidateAuthorizedUser).mockRejectedValue(new AppError(401, "interaction_required", "Token cache unavailable."));
  vi.spyOn(GraphPackagesClient.prototype, "collectCatalog").mockImplementation(async (_token, options) => {
    await options?.visit?.("empty-first");
    await options.onPage({ token: "empty-first", nextToken: null, rawCount: 0, expectedCount: 0, page: 1 });
  });
  try {
    const failed = await service.automaticRefresh(reader, expiredSignIn);
    await waitForRun(owner, failed.run!.id, "partial");
    const beforeLogin = await service.automaticRefresh(reader, expiredSignIn);
    expect(beforeLogin.run?.id).toBe(failed.run!.id);
    expect(beforeLogin.run?.sources.map(source => source.status)).toContain("waiting_authorization");

    vi.mocked(revalidateAuthorizedUser).mockResolvedValue(reader);
    const signedInAt = Date.now();
    const recovered = await service.automaticRefresh(reader, signedInAt);
    expect(recovered.run?.id).not.toBe(failed.run!.id);
    await waitForRun(owner, recovered.run!.id, "completed");
    const checked = await service.automaticRefresh(reader, signedInAt);
    expect(checked.run?.id).toBe(recovered.run!.id);
    expect(checked.run?.sources.every(source => source.status === "succeeded")).toBe(true);
  } finally {
    vi.mocked(revalidateAuthorizedUser).mockResolvedValue(user);
  }
});

it("finishes a partial automatic run when the last inventory child publishes after Users failed", async () => {
  const reader = { ...user, tenantId: testTenants[2], homeAccountId: randomUUID() };
  const owner = { tenantId: reader.tenantId!, principalId: reader.homeAccountId };
  vi.mocked(revalidateAuthorizedUser).mockResolvedValue(reader);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(GraphPackagesClient.prototype, "collectCatalog").mockImplementation(async (_token, options) => {
    await blocked;
    await options?.visit?.("partial-run-first");
    await options.onPage({ token: "partial-run-first", nextToken: null, rawCount: 0, expectedCount: 0, page: 1 });
  });
  const people = vi.spyOn(AgentPeopleService.prototype, "refreshReferences")
    .mockRejectedValueOnce(new AppError(503, "provider_timeout", "Agent people lookup did not complete."));
  let usersSettled = false;
  const updateSource = repository.updateSource.bind(repository);
  const publication = vi.spyOn(repository, "updateSource").mockImplementation(async (...args) => {
    const result = await updateSource(...args);
    if (args[0].principalId === owner.principalId && args[2] === "users" && args[3].status === "partial") usersSettled = true;
    return result;
  });
  try {
    const submitted = await service.automaticRefresh(reader);
    try {
      await vi.waitFor(() => expect(usersSettled).toBe(true), { timeout: 10_000 });
    } catch (error) {
      const sources = await fixture.operator.query(`SELECT source_id,status,job_id,message
        FROM data_sync_run_sources WHERE run_id=$1 ORDER BY source_id`, [submitted.run!.id]);
      const activity = await fixture.operator.query(`SELECT state,wait_event_type,wait_event,left(query,150) AS query
        FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() LIMIT 20`);
      const generations = await fixture.operator.query(`SELECT job_kind,state,scope_id FROM data_generations
        WHERE tenant_id=$1 AND state IN ('staging','validating')`, [owner.tenantId]);
      throw new Error(`Automatic Users boundary: ${JSON.stringify({ sources: sources.rows, activity: activity.rows, generations: generations.rows })}`, { cause: error });
    }
    const current = await repository.getRun(owner, submitted.run!.id);
    expect(current?.sources.find(source => source.source === "users")).toMatchObject({ status: "partial" });
    expect(current?.sources.find(source => source.source === "graph_packages")).toMatchObject({ status: "running" });
    release();
    await waitForRun(owner, submitted.run!.id, "partial");
    expect((await repository.getRun(owner, submitted.run!.id))?.sources
      .filter(source => source.source !== "users").every(source => source.status === "succeeded")).toBe(true);
  } finally {
    release();
    publication.mockRestore();
    people.mockRestore();
    vi.mocked(revalidateAuthorizedUser).mockResolvedValue(user);
  }
}, 15_000);
