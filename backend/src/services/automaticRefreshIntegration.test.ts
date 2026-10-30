import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { revalidateAuthorizedUser } from "../auth/msal.js";
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
  acquireAuthorizedToken: vi.fn(async () => "synthetic-delegated-token"),
  acquireApplicationToken: vi.fn(async () => { throw new Error("Automatic sync must never use application tokens."); }),
  revalidateAuthorizedUser: vi.fn(async () => user),
}));
vi.mock("./capabilities.js", () => ({ capabilities: {
  requireAvailable: vi.fn(async () => undefined),
  requireApplicationDataScope: vi.fn(async () => { throw new Error("No shared data scope."); }),
  observeOperation: vi.fn(async (_id, _user, operation) => operation(() => undefined)),
  beginOperationValidation: vi.fn(() => () => undefined),
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
      JOIN data_scope_epochs s ON s.id=a.scope_id WHERE a.tenant_id=$1 AND s.scope_kind='tenant' ORDER BY a.source LIMIT 20`,
    [owner.tenantId]);
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
    expect(await service.state(user)).toMatchObject({ onboardingRequired: false });
    expect(list).toHaveBeenCalledOnce();
    expect(details.mock.calls.length).toBeLessThanOrEqual(1);
    expect(sources.mock.calls.map(([, input]) => input.scope.source).sort()).toEqual(["app_activity", "directory"]);
    expect(sourceFetch).toHaveBeenCalledTimes(2);
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
  const reader = { ...user, tenantId: randomUUID(), homeAccountId: randomUUID() };
  const owner = { tenantId: reader.tenantId!, principalId: reader.homeAccountId };
  const expiredSignIn = Date.now() - 60_000;
  vi.mocked(revalidateAuthorizedUser).mockRejectedValue(new AppError(401, "interaction_required", "Token cache unavailable."));
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
  const reader = { ...user, tenantId: randomUUID(), homeAccountId: randomUUID() };
  const owner = { tenantId: reader.tenantId!, principalId: reader.homeAccountId };
  vi.mocked(revalidateAuthorizedUser).mockResolvedValue(reader);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(GraphPackagesClient.prototype, "catalogPages").mockImplementation(async function* (_token, options) {
    await blocked;
    await options?.visit?.("partial-run-first");
    yield { token: "partial-run-first", nextToken: null, records: [], rawCount: 0, expectedCount: 0, page: 1 };
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
      await vi.waitFor(() => expect(usersSettled).toBe(true), { timeout: 2000 });
    } catch (error) {
      const sources = await fixture.operator.query(`SELECT source_id,status,job_id,message
        FROM data_sync_run_sources WHERE run_id=$1 ORDER BY source_id`, [submitted.run!.id]);
      const activity = await fixture.operator.query(`SELECT state,wait_event_type,wait_event,left(query,150) AS query
        FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() LIMIT 20`);
      throw new Error(`Automatic Users boundary: ${JSON.stringify({ sources: sources.rows, activity: activity.rows })}`, { cause: error });
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
});
