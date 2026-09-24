import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { revalidateAuthenticatedUser } from "../auth/msal.js";
import { AppError } from "../errors.js";
import { DataSyncRepository } from "../db/dataSync.js";
import { OfficialUsageRepository } from "../db/officialUsage.js";
import { PackageInventoryRepository } from "../db/packageInventory.js";
import { PowerPlatformInventoryRepository } from "../db/powerPlatformInventory.js";
import type { AuthenticatedUser } from "../types/session.js";
import { AgentPeopleService } from "./agentPeople.js";
import { CopilotUsageService } from "./copilotUsage.js";
import { CopilotUsageGraphClient } from "./copilotUsageGraph.js";
import { DataSyncService } from "./dataSync.js";
import { GraphPackagesClient } from "./graphPackages.js";
import { PackageInventoryService } from "./packageInventory.js";
import { allowlistedPackage } from "./packageObservation.js";
import { PowerPlatformInventoryService } from "./powerPlatformInventory.js";

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
    async query(_token: string, queriedTypes: string[]) {
      return { resources: [], queriedTypes, environmentScope: null, totalRecords: 0, pages: 1, unknownFieldCount: 0 };
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
let packageRepository: PackageInventoryRepository;

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new DataSyncRepository(fixture.runtime);
  packageRepository = new PackageInventoryRepository(fixture.runtime);
  packages = new PackageInventoryService(packageRepository);
  powerPlatform = new PowerPlatformInventoryService(new PowerPlatformInventoryRepository(fixture.runtime));
  service = new DataSyncService(fixture.runtime, {
    repository, packages, powerPlatform,
    officialUsage: new OfficialUsageRepository(fixture.runtime),
    copilotUsage: new CopilotUsageService(fixture.runtime),
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

it("publishes fast inventory and user sources while enrichment is blocked, then exposes detail publication independently", async () => {
  const summary = allowlistedPackage({ id: "fixture-package", displayName: "Fixture agent", isBlocked: false,
    lastModifiedDateTime: "2026-09-24T00:00:00.000Z", version: "1" });
  const list = vi.spyOn(GraphPackagesClient.prototype, "listCopilotAgents").mockResolvedValue([summary]);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const details = vi.spyOn(GraphPackagesClient.prototype, "getPackageDetails").mockImplementation(async () => {
    await blocked;
    return { ...summary, longDescription: "Saved slow detail", allowedUsersAndGroups: [], acquireUsersAndGroups: [] };
  });
  const directory = vi.spyOn(CopilotUsageGraphClient.prototype, "listCopilotUsers").mockResolvedValue([]);
  const activity = vi.spyOn(CopilotUsageGraphClient.prototype, "listAppActivity").mockResolvedValue({ users: [], reportRefreshDate: null });
  try {
    const initial = await service.automaticRefresh(user);
    expect(initial.run).toMatchObject({ automatic: true });
    await vi.waitFor(async () => expect(await repository.getRun(scope, initial.run!.id)).toMatchObject({ status: "completed" }),
      { timeout: 10_000 });
    expect(list).toHaveBeenCalledOnce();
    if (!initial.detailJob) expect(details).not.toHaveBeenCalled();
    expect(directory).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalledOnce();
    expect((await packageRepository.list(scope, {})).value.map(value => value.id)).toEqual([summary.id]);

    const enriching = await service.automaticRefresh(user);
    expect(enriching.detailJob).toMatchObject({ status: "running" });
    await vi.waitFor(() => expect(details).toHaveBeenCalledOnce(), { timeout: 10_000 });
    await fixture.operator.query(`UPDATE data_sync_success_markers SET last_success_at=clock_timestamp()-interval '16 minutes'
      WHERE tenant_id=$1 AND principal_id=$2 AND source_id='graph_packages'`, [scope.tenantId, scope.principalId]);
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '16 minutes'
      WHERE run_id=$1 AND source_id='graph_packages'`, [initial.run!.id]);
    const next = await service.automaticRefresh(user);
    expect(next.run?.id).not.toBe(initial.run!.id);
    await vi.waitFor(async () => expect(await repository.getRun(scope, next.run!.id)).toMatchObject({ status: "completed" }),
      { timeout: 10_000 });
    expect(list).toHaveBeenCalledTimes(2);
    expect(details).toHaveBeenCalledOnce();
    const beforeDetails = await repository.automaticRevisions(scope);
    release();
    await vi.waitFor(async () => expect(await packages.get(user, enriching.detailJob!.id, "delegated"))
      .toMatchObject({ status: "succeeded" }), { timeout: 10_000 });
    expect((await packageRepository.get(scope, summary.id))?.package.longDescription).toBe("Saved slow detail");
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
  vi.spyOn(GraphPackagesClient.prototype, "listCopilotAgents").mockResolvedValue([]);
  vi.spyOn(CopilotUsageGraphClient.prototype, "listCopilotUsers").mockResolvedValue([]);
  vi.spyOn(CopilotUsageGraphClient.prototype, "listAppActivity").mockResolvedValue({ users: [], reportRefreshDate: null });
  try {
    const failed = await service.automaticRefresh(reader, expiredSignIn);
    await vi.waitFor(async () => expect(await repository.getRun(owner, failed.run!.id)).toMatchObject({ status: "partial" }),
      { timeout: 10_000 });
    const beforeLogin = await service.automaticRefresh(reader, expiredSignIn);
    expect(beforeLogin.run?.id).toBe(failed.run!.id);
    expect(beforeLogin.run?.sources.map(source => source.status)).toContain("waiting_authorization");

    vi.mocked(revalidateAuthenticatedUser).mockResolvedValue(reader);
    const signedInAt = Date.now();
    const recovered = await service.automaticRefresh(reader, signedInAt);
    expect(recovered.run?.id).not.toBe(failed.run!.id);
    await vi.waitFor(async () => expect(await repository.getRun(owner, recovered.run!.id)).toMatchObject({ status: "completed" }),
      { timeout: 10_000 });
    const checked = await service.automaticRefresh(reader, signedInAt);
    expect(checked.run?.id).toBe(recovered.run!.id);
    expect(checked.run?.sources.every(source => source.status === "succeeded")).toBe(true);
  } finally {
    vi.mocked(revalidateAuthenticatedUser).mockResolvedValue(user);
  }
});
