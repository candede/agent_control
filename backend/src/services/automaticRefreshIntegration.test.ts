import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { revalidateAuthenticatedUser } from "../auth/msal.js";
import { AppError } from "../errors.js";
import { DataSyncRepository } from "../db/dataSync.js";
import { OfficialReportStatusRepository } from "../db/officialReportStatus.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
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

vi.hoisted(() => { process.env.SESSION_SECRET = "synthetic-automatic-refresh-integration-secret"; });

vi.mock("../auth/msal.js", () => ({
  acquireDelegatedToken: vi.fn(async () => "synthetic-delegated-token"),
  acquireApplicationToken: vi.fn(async () => { throw new Error("Automatic sync must never use application tokens."); }),
  revalidateAuthenticatedUser: vi.fn(async () => user),
}));
vi.mock("./capabilities.js", () => ({ capabilities: {
  requireAvailable: vi.fn(async () => undefined),
  requireApplicationDataScope: vi.fn(async () => { throw new Error("No shared data scope."); }),
  observeOperation: vi.fn(async (_id, _user, operation) => operation(() => undefined)),
} }));
vi.mock("./powerPlatformResourceQuery.js", async original => ({
  ...await original<typeof import("./powerPlatformResourceQuery.js")>(),
  PowerPlatformResourceQueryClient: class {
    async *pages(_token: string, _queriedTypes: string[], options: { visit: (token: string) => Promise<void> }) {
      await options.visit("native-first");
      yield { token: "native-first", nextToken: null, records: [], rawCount: 0, expectedCount: 0, page: 1, omittedFieldCount: 0 };
    }
  },
}));

const user: AuthenticatedUser = { tenantId: randomUUID(), homeAccountId: randomUUID(),
  username: "automatic@example.invalid", displayName: "Automatic fixture", roles: ["AgentControl.Viewer"] };
const scope = { tenantId: user.tenantId!, principalId: user.homeAccountId };
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let service: DataSyncService;
let packages: PackageInventoryService;
let powerPlatform: PowerPlatformInventoryService;
let repository: DataSyncRepository;
let packageRepository: PackageRefreshJobs;
const sourceFetch = vi.fn<FetchLike>(async url => {
  if (String(url).includes("/subscribedSkus")) return Response.json({ value: [] });
  if (String(url).includes("getMicrosoft365CopilotUsageUserDetail")) return new Response(`${reportHeaders.join(",")}\n`);
  throw new Error("Unexpected native synthetic provider request");
});
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

async function waitForRun(owner: typeof scope, id: string, status: "completed" | "partial") {
  try {
    await vi.waitFor(async () => expect(await repository.getRun(owner, id)).toMatchObject({ status }), { timeout: 2000 });
  } catch (error) {
    const attempts = await fixture.runtime.query(`SELECT a.source,a.status,a.error_code FROM user_source_attempts a
      JOIN data_scope_epochs s ON s.id=a.scope_id WHERE a.tenant_id=$1 AND s.principal_id=$2 ORDER BY a.source LIMIT 20`,
    [owner.tenantId, owner.principalId]);
    throw new Error(`Automatic ${status} boundary: ${JSON.stringify({ run: await repository.getRun(owner, id), attempts: attempts.rows })}`, { cause: error });
  }
}

it("publishes initial inventory/users independently, then queues a same-selector catalogue behind bounded detail work without failing", async () => {
  const summary = allowlistedPackage({ id: "fixture-package", displayName: "Fixture agent", isBlocked: false,
    lastModifiedDateTime: "2026-09-24T00:00:00.000Z", version: "1" });
  const list = vi.spyOn(GraphPackagesClient.prototype, "catalogPages").mockImplementation(async function* (_token, options) {
    await options?.visit?.("graph-first");
    yield { token: "graph-first", nextToken: null, records: [summary], rawCount: 1, expectedCount: 1, page: 1 };
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
    expect(list).toHaveBeenCalledOnce();
    if (!initial.detailJob) expect(details).not.toHaveBeenCalled();
    expect(sources.mock.calls.map(([, input]) => input.scope.source).sort()).toEqual(["app_activity", "directory"]);
    expect(sourceFetch).toHaveBeenCalledTimes(2);
    expect((await fixture.runtime.query(`SELECT attempt.source,attempt.status,attempt.observed_count FROM user_source_attempts attempt
      JOIN data_scope_epochs scope ON scope.id=attempt.scope_id AND scope.tenant_id=attempt.tenant_id
      WHERE attempt.tenant_id=$1 AND scope.principal_id=$2 AND scope.token_mode='delegated'
      ORDER BY attempt.source LIMIT 250`, [scope.tenantId, scope.principalId])).rows).toEqual([
      { source: "app_activity", status: "available", observed_count: 0 }, { source: "directory", status: "available", observed_count: 0 },
    ]);
    expect((await inventorySelectionFixture(fixture.runtime, scope, {}, "packages")).raw.value.map(value => value.id)).toEqual([summary.id]);

    const enriching = await service.automaticRefresh(user);
    expect(enriching.detailJob).toMatchObject({ status: "running" });
    await vi.waitFor(() => expect(details).toHaveBeenCalledOnce(), { timeout: 10_000 });
    await fixture.operator.query(`UPDATE data_sync_success_markers SET last_success_at=clock_timestamp()-interval '16 minutes'
      WHERE tenant_id=$1 AND principal_id=$2 AND source_id='graph_packages'`, [scope.tenantId, scope.principalId]);
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '16 minutes'
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
      JOIN data_scope_epochs s ON s.id=g.scope_id WHERE s.tenant_id=$1 AND s.principal_id=$2
        AND s.source='inventory_packages' AND g.state IN ('staging','validating')`,
    [scope.tenantId, scope.principalId])).rows[0].count).toBe(1);
    expect((await inventorySelectionFixture(fixture.runtime, scope, {}, "packages")).raw.value.map(value => value.id)).toEqual([summary.id]);
    const beforeDetails = await repository.automaticRevisions(scope);
    release();
    await vi.waitFor(async () => expect(await packages.get(user, enriching.detailJob!.id, "delegated"))
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
  const reader = { ...user, homeAccountId: randomUUID() };
  const owner = { tenantId: reader.tenantId!, principalId: reader.homeAccountId };
  const expiredSignIn = Date.now() - 60_000;
  vi.mocked(revalidateAuthenticatedUser).mockRejectedValue(new AppError(401, "interaction_required", "Token cache unavailable."));
  vi.spyOn(GraphPackagesClient.prototype, "catalogPages").mockImplementation(async function* (_token, options) {
    await options?.visit?.("empty-first");
    yield { token: "empty-first", nextToken: null, records: [], rawCount: 0, expectedCount: 0, page: 1 };
  });
  try {
    const failed = await service.automaticRefresh(reader, expiredSignIn);
    await waitForRun(owner, failed.run!.id, "partial");
    const beforeLogin = await service.automaticRefresh(reader, expiredSignIn);
    expect(beforeLogin.run?.id).toBe(failed.run!.id);
    expect(beforeLogin.run?.sources.map(source => source.status)).toContain("waiting_authorization");

    vi.mocked(revalidateAuthenticatedUser).mockResolvedValue(reader);
    const signedInAt = Date.now();
    const recovered = await service.automaticRefresh(reader, signedInAt);
    expect(recovered.run?.id).not.toBe(failed.run!.id);
    await waitForRun(owner, recovered.run!.id, "completed");
    const checked = await service.automaticRefresh(reader, signedInAt);
    expect(checked.run?.id).toBe(recovered.run!.id);
    expect(checked.run?.sources.every(source => source.status === "succeeded")).toBe(true);
  } finally {
    vi.mocked(revalidateAuthenticatedUser).mockResolvedValue(user);
  }
});

it.each(["after", "during"] as const)("checks newly reported users when a report is uploaded %s Users sync, without recollecting fresh app activity", async timing => {
  const reader = { ...user, tenantId: randomUUID(), homeAccountId: randomUUID() };
  const owner = { tenantId: reader.tenantId, principalId: reader.homeAccountId };
  const identity = await reportIdentity(fixture.runtime, reader);
  const imports = new OfficialReportImports(fixture.runtime);
  const reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-report-refresh-secret-never-production", 30);
  const cohort = async () => reports.page((await reports.capture(identity, "delegated", "official_users",
    { licenseCohort: "active_without_paid" })).id, identity);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = sourceFetch.getMockImplementation()!;
  const details = vi.spyOn(packages, "refreshDueDetails").mockResolvedValue(null);
  let catalogReads = 0, activityReads = 0;
  const exactFilters: string[] = [];
  vi.mocked(revalidateAuthenticatedUser).mockResolvedValue(reader);
  sourceFetch.mockImplementation(async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith("/subscribedSkus")) {
      catalogReads += 1;
      entered.resolve();
      if (catalogReads === 1 && timing === "during") await release.promise;
    }
    if (target.pathname.includes("getMicrosoft365CopilotUsageUserDetail")) activityReads += 1;
    if (target.pathname === "/v1.0/users") {
      exactFilters.push(target.searchParams.get("$filter")!);
      return Response.json({ "@odata.count": 1, value: [{
        id: "30000000-0000-4000-8000-000000000003", userPrincipalName: "report-only@example.invalid",
        displayName: "Report-only user", assignedLicenses: [], assignedPlans: [],
      }] });
    }
    return original(url, init);
  });
  try {
    for (const source of ["graph_packages", "power_platform"] as const) {
      await repository.recordSuccessMarker(owner, source, 0, new Date().toISOString());
    }
    const initial = await service.start(reader, { mode: "incremental", sources: ["users"] });
    await entered.promise;
    if (timing === "after") await waitForRun(owner, initial.id, "completed");
    else await vi.waitFor(async () => expect((await reports.sources.refreshStatus(identity, "delegated"))
      .sources.app_activity.attemptStatus).toBe("available"));
    const bundleId = randomUUID(), date = new Date().toISOString().slice(0, 10);
    for (const kind of ["users", "agents", "userAgents"] as const) {
      const rows = kind === "users" ? `report-only@example.invalid,Report-only user,1,2,${date}\ngone@example.invalid,Gone,1,1,${date}`
        : kind === "agents" ? `agent,Agent,Your org,0,2,3,${date}`
          : `agent,Agent,Your org,report-only@example.invalid,2,${date}`;
      await imports.stage(identity, { bundleId }, (async function* () {
        yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n${rows}\n`);
      })());
    }
    await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
    if (timing === "during") {
      expect((await service.automaticRefresh(reader)).run?.id).toBe(initial.id);
      expect(catalogReads).toBe(1);
      release.resolve();
      await waitForRun(owner, initial.id, "completed");
    }
    const before = await cohort();
    expect(before.summary).toMatchObject({ activeWithoutPaidUsers: 0, unknownLicenseActiveReportUsers: 2 });
    const [next, concurrent] = await Promise.all([service.automaticRefresh(reader), service.automaticRefresh(reader)]);
    expect(next.run?.id).not.toBe(initial.id);
    expect(concurrent.run?.id).toBe(next.run?.id);
    expect(next.run).toMatchObject({ automatic: true, sources: [{ source: "users" }] });
    await waitForRun(owner, next.run!.id, "completed");
    const after = await cohort();
    expect(after.value.map(value => value.username)).toEqual(["report-only@example.invalid"]);
    expect(after.summary).toMatchObject({ activeWithoutPaidUsers: 1, unknownLicenseActiveReportUsers: 1 });
    expect(after.sources.app_activity.generationId).toBe(before.sources.app_activity.generationId);
    expect(after.sources.directory.generationId).not.toBe(before.sources.directory.generationId);
    expect(exactFilters).toHaveLength(1);
    expect(exactFilters[0]).toContain("report-only@example.invalid");
    expect(exactFilters[0]).toContain("gone@example.invalid");
    expect(catalogReads).toBe(2);
    expect(activityReads).toBe(1);
    expect((await service.automaticRefresh(reader)).run?.id).toBe(next.run!.id);
    expect(catalogReads).toBe(2);
  } finally {
    release.resolve();
    await vi.waitFor(async () => expect((await repository.getLatestRun(owner))?.status).not.toBe("running"));
    details.mockRestore();
    sourceFetch.mockImplementation(original);
    vi.mocked(revalidateAuthenticatedUser).mockResolvedValue(user);
  }
});
