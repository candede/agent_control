import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { DataSyncRepository, type DataSyncScope } from "./dataSync.js";
import { automaticDataSyncSourceIds, type DataSyncRun } from "../types/dataSync.js";
import type { CopilotDirectoryUser } from "../types/copilotUsage.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { powerPlatformResourceTypes } from "../types/powerPlatformInventory.js";
import { generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { publishFixtureDirectory, publishFixtureEmptyActivity } from "../../scripts/userSourceFixture.js";
import { inventoryBaseline, inventoryInput, refreshInventoryFixture, streamedPackageFixture, nativeInventoryFixture,
  reconcileInventoryFixture, inventorySelectionFixture } from "../../scripts/inventoryFixtures.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
import { DataGenerations } from "./dataGenerations.js";
import { InventoryRuntime } from "../services/inventoryRuntime.js";
import { UserSourcesRepository } from "./userSources.js";
import { UserSourceStages } from "./userSourceStages.js";
import { AppError } from "../errors.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { SavedAgentPeopleService } from "../services/savedAgentPeople.js";
import { AgentPeopleRepository } from "./agentPeople.js";
import { PackageRefreshJobs } from "./packageRefreshJobs.js";
import { PowerPlatformRefreshJobs } from "./powerPlatformRefreshJobs.js";
import { packageInventoryRecord, powerPlatformInventoryRecord } from "../services/inventoryRecordProjection.js";
import { seedReportSet } from "../../scripts/officialReportFixtures.js";
import { OfficialReportHistory } from "./officialReportHistory.js";
import { inventoryPresentation } from "../services/inventoryPresentation.js";

vi.hoisted(() => { process.env.SESSION_SECRET = "synthetic-automatic-source-revision-secret"; });

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: DataSyncRepository;
beforeAll(async () => {
  fixture = await testDatabase();
  repository = new DataSyncRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });
const owner = (): DataSyncScope => ({ tenantId: randomUUID(), principalId: randomUUID() });
const identity = (scope: DataSyncScope) => ({ ...selectionIdentity, ...scope });
async function savedSourcesAvailable(scope: DataSyncScope) {
  const sources = await repository.listSavedSources(scope);
  return automaticDataSyncSourceIds.every(id => sources.find(source => source.source === id)?.status === "succeeded");
}
async function failure(scope: DataSyncScope, source: "directory" | "app_activity", authorization = false) {
  const error = new AppError(authorization ? 401 : 403, authorization ? "authentication_required" : "permission_required", "Fixture authorization unavailable");
  await expect(new UserSourceStages(fixture.runtime).execute(generationInput({
    scope: { ...generationInput().scope, tenantId: scope.tenantId, source }, actorPrincipalId: scope.principalId,
  }), async () => { throw error; }, { beforePublish: async () => {} })).rejects.toBe(error);
}

async function publishSource(scope: DataSyncScope, source: "users" | "graph_packages" | "power_platform", packages: CopilotPackageDetail[] = []) {
  if (source === "users") {
    const savedIdentity = { ...identity(scope),
      sessionEpoch: await new DataGenerations(fixture.runtime).sessionEpoch(scope.tenantId, scope.principalId) };
    await publishFixtureDirectory(fixture.runtime, savedIdentity, []);
    await publishFixtureEmptyActivity(fixture.runtime, savedIdentity);
  } else if (source === "graph_packages") await streamedPackageFixture(fixture.runtime, scope, packages);
  else await nativeInventoryFixture(fixture.runtime, scope, [], { resourceTypes: [...powerPlatformResourceTypes] });
}

async function complete(scope: DataSyncScope, run: DataSyncRun, packages: CopilotPackageDetail[] = []) {
  for (const source of run.sources) {
    if (source.source === "usage_reports") throw new Error("This fixture completes automatic sources only.");
    await publishSource(scope, source.source, packages);
    await repository.updateSource(scope, run.id, source.source,
      { status: "succeeded", count: source.source === "graph_packages" ? packages.length : 0,
        message: "Saved fixture source.", canRetry: false });
  }
}

describe("session-driven automatic sync admission", () => {
  it.each(["automatic", "manual"] as const)("does not let completed run history block %s sync and still joins concurrent starts", async kind => {
    const scope = owner();
    await fixture.operator.query(`INSERT INTO data_sync_runs(id,tenant_id,principal_id,mode,source_ids,request_hash,status,automatic)
      SELECT gen_random_uuid(),$1,$2,'incremental','["users"]',repeat('a',64),'completed',true FROM generate_series(1,20)`,
    [scope.tenantId, scope.principalId]);
    const submit = () => kind === "automatic" ? repository.submitDue(scope) : repository.submit(scope, { mode: "incremental", sources: ["users"] });
    const [first, second] = await Promise.all([submit(), submit()]);
    expect(first.run?.id).toBe(second.run?.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM data_sync_runs
      WHERE tenant_id=$1 AND principal_id=$2`, [scope.tenantId, scope.principalId])).rows[0].count).toBe(21);
  });

  it("finishes a mixed automatic run when inventory is the last source to publish and retries after cooldown", async () => {
    const scope = owner();
    const { run } = await repository.submitDue(scope);
    const packages = new PackageRefreshJobs(fixture.runtime);
    const job = await packages.submit(scope, {
      idempotencyKey: "mixed-run-final-publication", tokenMode: "application",
      authorizationPrincipalId: scope.principalId, requestedIds: [],
    });
    await repository.attachJob(scope, run!.id, "graph_packages", job.id);
    await repository.updateSource(scope, run!.id, "graph_packages", {
      status: "running", jobId: job.id, message: "Collecting inventory.", canRetry: false,
    });
    await packages.markRunning(scope, job.id);
    for (const source of ["users", "power_platform"] as const) {
      await repository.updateSource(scope, run!.id, source, {
        status: source === "users" ? "partial" : "failed", count: 500,
        message: "Latest collection did not complete.", canRetry: true,
      });
    }
    await refreshInventoryFixture(fixture.runtime, scope, job.id, "packages", []);
    expect(await repository.getRun(scope, run!.id)).toMatchObject({
      status: "partial", completedAt: expect.any(String),
      sources: expect.arrayContaining([expect.objectContaining({ source: "graph_packages", status: "succeeded" })]),
    });
    expect((await repository.submitDue(scope)).created).toBe(false);
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '61 minutes'
      WHERE run_id=$1 AND source_id IN ('users','power_platform')`, [run!.id]);
    const next = await repository.submitDue(scope);
    expect(next.created).toBe(true);
    expect(next.run!.id).not.toBe(run!.id);
    expect(next.run!.sources.map(source => source.source)).toEqual(["power_platform", "users"]);
  });

  it.each(["running", "waiting"] as const)("repairs a stale %s automatic aggregate without restarting fresh sources", async status => {
    const scope = owner();
    const { run } = await repository.submitDue(scope);
    await complete(scope, run!);
    await fixture.operator.query(`UPDATE data_sync_runs SET status=$2,completed_at=NULL WHERE id=$1`, [run!.id, status]);
    const checked = await repository.submitDue(scope);
    expect(checked).toMatchObject({ created: false, run: { id: run!.id, status: "completed", completedAt: expect.any(String) } });
  });

  it("finishes a stale mixed automatic run even if its aggregate still says running", async () => {
    const scope = owner();
    const { run } = await repository.submitDue(scope);
    for (const source of run!.sources) await repository.updateSource(scope, run!.id, source.source, {
      status: "failed", message: "Collection failed.", canRetry: true,
    });
    await fixture.operator.query(`UPDATE data_sync_runs SET status='running',completed_at=NULL WHERE id=$1`, [run!.id]);
    await repository.finishRun(scope, run!.id);
    expect(await repository.getRun(scope, run!.id)).toMatchObject({ status: "partial", completedAt: expect.any(String) });
  });

  it("atomically deduplicates across independent callers and does not request manual reports", async () => {
    const scope = owner();
    const publication = await repository.automaticRevisions(scope);
    const [left, right] = await Promise.all([
      repository.submitDue(scope), new DataSyncRepository(fixture.runtime).submitDue(scope),
    ]);
    expect(left.run?.id).toBe(right.run?.id);
    expect([left.created, right.created].sort()).toEqual([false, true]);
    expect(left.run).toMatchObject({ automatic: true, mode: "incremental" });
    expect(left.run?.sources.map(source => source.source)).toEqual(["graph_packages", "power_platform", "users"]);
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM data_sync_runs
      WHERE tenant_id=$1 AND principal_id=$2`, [scope.tenantId, scope.principalId])).rows[0].count).toBe(1);
    await repository.updateSource(scope, left.run!.id, "graph_packages",
      { status: "running", count: 123, message: "Synthetic progressing source.", canRetry: false });
    expect(await repository.automaticRevisions(scope)).toEqual(publication);
    expect(await repository.getRun(owner(), left.run!.id)).toBeUndefined();
    await complete(scope, left.run!);
    const saved = await repository.automaticRevisions(scope);
    expect(saved.users).not.toBe(publication.users);
    expect(await repository.submitDue(scope)).toMatchObject({ created: false, run: { id: left.run!.id } });
    expect(await repository.automaticRevisions(scope)).toEqual(saved);
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM data_sync_runs
      WHERE tenant_id=$1 AND principal_id=$2`, [scope.tenantId, scope.principalId])).rows[0].count).toBe(1);
  });

  function directoryUser(objectId: string, displayName = "Directory person"): CopilotDirectoryUser {
    return {
      identity: { objectId, displayName, userPrincipalName: "person@example.invalid", accountEnabled: true,
        userType: "Member", employeeType: null, department: null, companyName: null },
      serviceEvidenceVersion: 1, copilotServiceState: "unknown", servicePlans: [],
    };
  }

  function savedUsers(scope: DataSyncScope) {
    const reader = new UserSourcesRepository(fixture.runtime, "synthetic-automatic-source-read-secret");
    return async () => {
      const selected = await reader.capture(identity(scope));
      const { selection: _selection, ...page } = await reader.page(selected.id, identity(scope));
      return page;
    };
  }

  it.each(["failed", "permission_required", "waiting_authorization"] as const)(
    "refreshes licenses after the automatic report head advances but retains the %s retry cooldown", async status => {
      const scope = owner(), principal = identity(scope);
      const saved = await seedReportSet(fixture.runtime, scope.tenantId, 1);
      const other = await seedReportSet(fixture.runtime, scope.tenantId, 2);
      const history = new OfficialReportHistory(fixture.runtime);
      await history.ensure(scope.tenantId);
      await history.connections.run(async client => {
        await history.accepted(client, scope.tenantId, saved.id);
        await history.reconcileHead(client, scope.tenantId);
      });
      const first = await repository.submitDue(scope);
      await publishFixtureDirectory(fixture.runtime, principal, []);
      await complete(scope, first.run!);
      expect((await repository.submitDue(scope)).created).toBe(false);
      await history.connections.run(async client => {
        await history.accepted(client, scope.tenantId, other.id);
        await history.reconcileHead(client, scope.tenantId);
      });
      const refresh = await repository.submitDue(scope);
      expect(refresh).toMatchObject({ created: true, run: { automatic: true, sources: [{ source: "users" }] } });
      await repository.updateSource(scope, refresh.run!.id, "users", {
        status, count: null, message: "Fixture directory collection did not finish.", canRetry: true,
      });
      await repository.finishRun(scope, refresh.run!.id);
      const latest = await seedReportSet(fixture.runtime, scope.tenantId, 3);
      await history.connections.run(async client => {
        await history.accepted(client, scope.tenantId, latest.id);
        await history.reconcileHead(client, scope.tenantId);
      });
      expect(await repository.submitDue(scope)).toMatchObject({ created: false, run: { id: refresh.run!.id } });
    },
  );

  describe("persisted automatic revision boundaries", () => {
    it("separates persisted inventory and people publications from freshness and the Users response", async () => {
      const scope = owner();
      const personId = randomUUID();
      const observedAt = new Date(Date.now() - 60_000).toISOString();
      await publishFixtureDirectory(fixture.runtime, identity(scope), [directoryUser(personId)], { observedAt: new Date(observedAt) });
      await publishFixtureEmptyActivity(fixture.runtime, identity(scope), { observedAt: new Date(observedAt) });
      const readUsers = savedUsers(scope);
      const users = await readUsers();
      let previous = await repository.automaticRevisions(scope);
      const onlyChanged = async (source: "graph_packages" | "power_platform", canonical = false) => {
        const next = await repository.automaticRevisions(scope);
        for (const key of ["graph_packages", "power_platform", "users"] as const) {
          if (key === source || canonical && key !== "users") expect(next[key]).not.toBe(previous[key]);
          else expect(next[key]).toBe(previous[key]);
        }
        expect(await readUsers()).toEqual(users);
        previous = next;
      };

      const packages = new PackageRefreshJobs(fixture.runtime);
      const packageJob = await packages.submit(scope, {
        idempotencyKey: "automatic-revision-package", tokenMode: "application", authorizationPrincipalId: scope.principalId,
      });
      await packages.markRunning(scope, packageJob.id);
      const summary = allowlistedPackage({ id: "revision-package", displayName: "Saved package", isBlocked: false });
      await refreshInventoryFixture(fixture.runtime, scope, packageJob.id, "packages", [packageInventoryRecord(summary)]);
      await onlyChanged("graph_packages", true);

      const detailJob = await packages.submit(scope, { idempotencyKey: "automatic-revision-detail",
        tokenMode: "application", authorizationPrincipalId: scope.principalId, requestedIds: [summary.id] });
      await packages.markRunning(scope, detailJob.id);
      const packageExpiry = new Date(Date.now() + 1200);
      await refreshInventoryFixture(fixture.runtime, scope, detailJob.id, "packages",
        [packageInventoryRecord({ ...summary, longDescription: "Saved detail.", identityDetailsCollected: true })],
        undefined, { exactTargets: [summary.id], expiresAt: packageExpiry });
      await onlyChanged("graph_packages", true);

      const native = new PowerPlatformRefreshJobs(fixture.runtime);
      const nativeJob = await native.submit(scope, {
        idempotencyKey: "automatic-revision-native", roleScope: "full", requestedTypes: ["microsoft.copilotstudio/agents"],
      });
      await native.markRunning(scope, nativeJob.id);
      const nativeExpiry = new Date(Date.now() + 2200);
      await refreshInventoryFixture(fixture.runtime, scope, nativeJob.id, "power_platform",
        [powerPlatformInventoryRecord({
          tenantId: scope.tenantId, nativeId: "revision-native", environmentId: randomUUID(),
          type: "microsoft.copilotstudio/agents", displayName: "Saved native agent", location: null,
          createdAt: null, createdBy: personId, lastPublishedAt: null, sourceSystem: "power_platform",
          authoringTool: "Copilot Studio", creatorType: "unknown", agentKind: "agent", lifecycle: "published",
          identityConfidence: "exact_native", identifiers: [{ kind: "power_platform_resource_id", value: "revision-native" }],
          provenance: {}, unknownFieldCount: 0, details: { ownerId: personId },
        })], ["microsoft.copilotstudio/agents"], { expiresAt: nativeExpiry });
      await onlyChanged("power_platform", true);

      const people = new AgentPeopleRepository(fixture.runtime);
      await people.save(scope, [{
        objectId: personId, status: "resolved", displayName: "Exact owner name",
        userPrincipalName: "owner@example.invalid", checkedAt: observedAt,
      }], { generation: await people.generation(scope) });
      await onlyChanged("power_platform", true);
      const savedPeople = new SavedAgentPeopleService(fixture.runtime);
      expect((await savedPeople.read(scope, [personId])).get(personId)?.displayName).toBe("Exact owner name");

      for (const expiry of [packageExpiry, nativeExpiry]) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry.getTime() - Date.now()) + 20));
        expect(await repository.automaticRevisions(scope)).toEqual(previous);
        expect(await readUsers()).toEqual(users);
      }
      await fixture.operator.query(`UPDATE agent_people_cache SET expires_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=$1 AND principal_id=$2`, [scope.tenantId, scope.principalId]);
      await onlyChanged("power_platform", true);
      expect((await savedPeople.read(scope, [personId])).get(personId)?.displayName).toBe("Directory person");
    });

    it("announces delayed canonical publication even when no native source changes again", async () => {
      const scope = { tenantId: "synthetic-tenant", principalId: randomUUID() };
      await inventoryBaseline(new InventoryGenerations(fixture.runtime), scope.principalId, 1);
      const sourcePublished = await repository.automaticRevisions(scope);
      const runtime = new InventoryRuntime(fixture.runtime, async () => {});
      expect(await runtime.enqueue(scope, false)).toBe(true);
      expect(await repository.automaticRevisions(scope)).toEqual(sourcePublished);
      await runtime.reconciliation.runNext(inventoryInput(scope.principalId, "canonical"), async () => {});
      const ready = await repository.automaticRevisions(scope);
      expect(ready.graph_packages).not.toBe(sourcePublished.graph_packages);
      expect(ready.power_platform).not.toBe(sourcePublished.power_platform);
      expect(ready.users).toBe(sourcePublished.users);
      expect(await new DataSyncRepository(fixture.runtime).automaticRevisions(scope)).toEqual(ready);
    });

    it.each(["directory", "app_activity"] as const)("tracks %s publication but not retained failure or freshness expiry", async source => {
      const scope = owner();
      const observedAt = new Date().toISOString();
      const person = directoryUser(randomUUID());
      let expiresAt: Date | undefined;
      const publish = () => source === "directory"
        ? publishFixtureDirectory(fixture.runtime, identity(scope), [person], { observedAt: new Date(observedAt), expiresAt })
        : publishFixtureEmptyActivity(fixture.runtime, identity(scope), { observedAt: new Date(observedAt), expiresAt });
      const empty = await repository.automaticRevisions(scope);
      await publish();
      const before = await repository.automaticRevisions(scope);
      expect(before.users).not.toBe(empty.users);
      for (const key of ["graph_packages", "power_platform"] as const) {
        if (source === "directory") expect(before[key]).not.toBe(empty[key]);
        else expect(before[key]).toBe(empty[key]);
      }
      await failure(scope, source);
      const failed = await repository.automaticRevisions(scope);
      expect(failed.users).toBe(before.users);
      expect(failed.graph_packages).toBe(before.graph_packages);
      expect(failed.power_platform).toBe(before.power_platform);
      const readUsers = savedUsers(scope);
      expect((await readUsers()).sources[source]).toMatchObject({
        state: "partial", attemptStatus: "permission_required", message: expect.stringContaining("requires"),
      });

      person.identity.displayName = "Renamed directory person";
      expiresAt = new Date(Date.now() + 1000);
      await publish();
      const recovered = await repository.automaticRevisions(scope);
      expect(recovered.users).not.toBe(failed.users);
      for (const key of ["graph_packages", "power_platform"] as const) {
        if (source === "directory") expect(recovered[key]).not.toBe(failed[key]);
        else expect(recovered[key]).toBe(failed[key]);
      }
      if (source === "directory") expect((await readUsers()).value[0].directory.displayName).toBe("Renamed directory person");
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt!.getTime() - Date.now() + 20)));
      const expired = await repository.automaticRevisions(scope);
      expect(expired).toEqual(recovered);
      expect((await readUsers()).sources[source]).toMatchObject({ state: "stale" });
      expect(await repository.automaticRevisions(scope)).toEqual(expired);
    });

    it("ignores other tenants, failed attempts and unlinked snapshots but detects actual retirement", async () => {
      const scope = owner();
      await publishFixtureDirectory(fixture.runtime, identity(scope), []);
      const before = await repository.automaticRevisions(scope);
      const other = await publishFixtureDirectory(fixture.runtime, identity({ tenantId: randomUUID(), principalId: "another-reader" }), []);
      await publishFixtureEmptyActivity(fixture.runtime, identity({ ...scope, tenantId: "another-tenant" }));
      expect(await repository.automaticRevisions(scope)).toEqual(before);

      await failure(scope, "directory", true);
      const failed = await repository.automaticRevisions(scope);
      expect(failed.users).toBe(before.users);
      expect(failed.graph_packages).toBe(before.graph_packages);
      expect(failed.power_platform).toBe(before.power_platform);
      await expect(fixture.operator.query(`UPDATE data_generation_heads head SET generation_id=$2
        FROM data_scope_epochs scope WHERE head.scope_id=scope.id AND scope.tenant_id=$1 AND scope.scope_kind='tenant'
          AND scope.source='directory'`, [scope.tenantId, other.generationId])).rejects.toMatchObject({ message: "data_head_fenced" });
      expect(await repository.automaticRevisions(scope)).toEqual(failed);

      const own = await publishFixtureDirectory(fixture.runtime, identity(scope), []);
      const linked = await repository.automaticRevisions(scope);
      await fixture.operator.query("DELETE FROM data_generation_heads WHERE scope_id=$1", [own.scopeId]);
      const orphaned = await repository.automaticRevisions(scope);
      expect(orphaned.users).not.toBe(linked.users);
      expect(orphaned.power_platform).not.toBe(linked.power_platform);
      await fixture.operator.query("UPDATE data_generations SET state='retired' WHERE id=$1", [own.generationId]);
      expect(await repository.automaticRevisions(scope)).toEqual(orphaned);
    });
  });

  it("retains successful sources at fifteen minutes and refreshes only after six hours", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    await complete(scope, first.run!);
    await fixture.operator.query(`UPDATE data_sync_success_markers SET last_success_at=clock_timestamp()-interval '16 minutes'
      WHERE tenant_id=$1 AND source_id='graph_packages'`, [scope.tenantId]);
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '16 minutes'
      WHERE run_id=$1 AND source_id='graph_packages'`, [first.run!.id]);
    expect((await repository.submitDue(scope)).created).toBe(false);
    await fixture.operator.query(`UPDATE data_sync_success_markers SET last_success_at=clock_timestamp()-interval '6 hours 1 minute'
      WHERE tenant_id=$1 AND source_id='graph_packages'`, [scope.tenantId]);
    // A recent attempt still prevents a duplicate even when its saved timestamp is older.
    expect((await repository.submitDue(scope)).created).toBe(false);
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '6 hours 1 minute'
      WHERE run_id=$1 AND source_id='graph_packages'`, [first.run!.id]);
    const next = await repository.submitDue(scope);
    expect(next).toMatchObject({ created: true, run: { sources: [{ source: "graph_packages" }] } });
    await complete(scope, next.run!);
  });

  it("automatically rebuilds missing inventory despite recent historical success", async () => {
    const scope = owner(), generations = new DataGenerations(fixture.runtime);
    const packages = [allowlistedPackage({ id: "recover-me", displayName: "Recovered agent", isBlocked: false })];
    const first = await repository.submitDue(scope);
    await complete(scope, first.run!, packages);
    await reconcileInventoryFixture(fixture.runtime, scope);
    const details = new PackageRefreshJobs(fixture.runtime);
    expect(await savedSourcesAvailable(scope)).toBe(true);
    expect(await details.detailCoverage(scope)).toMatchObject({ catalog_available: true, total: 1 });
    const history = await repository.listMarkers(scope);

    await generations.revokePrincipal(scope.tenantId, scope.principalId);
    expect(await savedSourcesAvailable(scope)).toBe(true);
    const roots = await fixture.runtime.query<{ scope_id: string }>(`SELECT root.scope_id FROM inventory_roots root
      JOIN data_scope_epochs scope ON scope.id=root.scope_id WHERE scope.tenant_id=$1 AND scope.scope_kind='tenant'`,
    [scope.tenantId]);
    const inventory = new InventoryGenerations(fixture.runtime);
    for (const root of roots.rows) {
      await generations.invalidate(root.scope_id, scope.tenantId);
      await inventory.gcMetadataSlice(root.scope_id, scope.tenantId);
    }
    expect((await fixture.runtime.query(`SELECT count(*)::int AS n FROM inventory_roots root
      JOIN data_scope_epochs scope ON scope.id=root.scope_id
      WHERE scope.tenant_id=$1 AND scope.scope_kind='tenant' AND root.current`, [scope.tenantId])).rows[0].n).toBe(0);
    await publishSource(scope, "users");
    expect(await savedSourcesAvailable(scope)).toBe(false);
    expect(await repository.listSavedSources(scope)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "graph_packages", status: "not_started", count: 1,
        lastSuccessAt: history.find(source => source.source === "graph_packages")!.lastSuccessAt }),
      expect.objectContaining({ source: "users", status: "succeeded" }),
    ]));
    expect(await details.detailCoverage(scope)).toMatchObject({ catalog_available: false, total: 0 });
    expect(await repository.listMarkers(scope)).toEqual(history);

    const recovery = await repository.submitDue(scope, Date.now());
    expect(recovery).toMatchObject({ created: true });
    expect(recovery.run!.sources.map(source => source.source)).toEqual(["graph_packages", "power_platform"]);
    expect(await repository.submitDue(scope, Date.now())).toMatchObject({
      created: false, run: { id: recovery.run!.id },
    });

    await complete(scope, recovery.run!, packages);
    await reconcileInventoryFixture(fixture.runtime, scope);
    const selected = await inventorySelectionFixture(fixture.runtime, scope);
    expect(inventoryPresentation(selected.raw).value).toHaveLength(1);
    expect(await savedSourcesAvailable(scope)).toBe(true);
    expect(await details.detailCoverage(scope)).toMatchObject({ catalog_available: true, total: 1, fresh: 0, eligible: 1 });
    const detailJob = await details.claimDueDetails({ ...scope, tokenMode: "application" }, scope.principalId);
    expect(detailJob).toMatchObject({ targetCount: 1 });
    expect((await fixture.runtime.query(`SELECT target_id FROM inventory_refresh_targets
      WHERE job_id=$1 ORDER BY ordinal`, [detailJob!.id])).rows).toEqual([{ target_id: "recover-me" }]);
    expect((await repository.submitDue(scope, Date.now())).created).toBe(false);
  });

  it("keeps retained sources usable across a normal sign-out without recollecting them", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    await complete(scope, first.run!);
    await new DataGenerations(fixture.runtime).revokePrincipal(scope.tenantId, scope.principalId, { preserveSources: true });
    expect(await savedSourcesAvailable(scope)).toBe(true);
    expect((await repository.submitDue(scope, Date.now())).created).toBe(false);
  });

  it("recognizes complete saved publications without requiring sync-history bookkeeping", async () => {
    const scope = owner();
    for (const source of automaticDataSyncSourceIds) await publishSource(scope, source);
    expect((await repository.listMarkers(scope)).every(source => source.status === "not_started")).toBe(true);
    expect(await savedSourcesAvailable(scope)).toBe(true);
    expect((await repository.listSavedSources(scope)).filter(source => source.source !== "usage_reports"))
      .toEqual(automaticDataSyncSourceIds.map(source => expect.objectContaining({
        source, status: "succeeded", count: null, lastSuccessAt: null,
      })));
  });

  it("keeps dated complete sources usable after a failed later attempt", async () => {
    const scope = { tenantId: selectionIdentity.tenantId, principalId: randomUUID() };
    const first = await repository.submitDue(scope);
    const dated = { observedAt: new Date(Date.now() - 2 * 86_400_000), expiresAt: new Date(Date.now() - 86_400_000) };
    await publishFixtureDirectory(fixture.runtime, identity(scope), [], dated);
    await publishFixtureEmptyActivity(fixture.runtime, identity(scope), dated);
    await inventoryBaseline(new InventoryGenerations(fixture.runtime), scope.principalId, 0, dated.observedAt, dated.expiresAt);
    await nativeInventoryFixture(fixture.runtime, scope, [], { ...dated, resourceTypes: [...powerPlatformResourceTypes] });
    for (const source of first.run!.sources) await repository.updateSource(scope, first.run!.id, source.source, {
      status: "succeeded", count: 0, message: "Saved dated fixture source.", canRetry: false,
    });
    await failure(scope, "directory");
    expect(await savedSourcesAvailable(scope)).toBe(true);
    expect((await repository.submitDue(scope)).created).toBe(false);
  });

  it("keeps the failed-attempt cooldown when a saved source is missing", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    await complete(scope, first.run!);
    const graph = (await fixture.runtime.query<{ id: string }>(`SELECT id FROM data_scope_epochs
      WHERE tenant_id=$1 AND scope_kind='tenant' AND source='inventory_packages' AND selector='complete'`,
    [scope.tenantId])).rows[0];
    await new DataGenerations(fixture.runtime).invalidate(graph.id, scope.tenantId);
    const failed = await repository.submit(scope, { mode: "incremental", sources: ["graph_packages"] });
    await repository.updateSource(scope, failed.run.id, "graph_packages", {
      status: "failed", message: "Provider unavailable.", canRetry: true,
    });
    expect(await savedSourcesAvailable(scope)).toBe(false);
    expect((await repository.submitDue(scope)).created).toBe(false);
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '61 minutes'
      WHERE run_id=$1`, [failed.run.id]);
    expect(await repository.submitDue(scope)).toMatchObject({
      created: true, run: { sources: [{ source: "graph_packages", status: "queued" }] },
    });
  });

  it("uses the same saved source and freshness after a successful narrower Power Platform collection", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    await complete(scope, first.run!);
    const native = (await fixture.runtime.query<{ id: string }>(`SELECT id FROM data_scope_epochs
      WHERE tenant_id=$1 AND scope_kind='tenant' AND source='inventory_power_platform' AND selector='complete'`,
    [scope.tenantId])).rows[0];
    await new DataGenerations(fixture.runtime).invalidate(native.id, scope.tenantId);
    await nativeInventoryFixture(fixture.runtime, scope, [], {
      resourceTypes: [powerPlatformResourceTypes[0]], environmentId: "environment-only",
    });
    expect(await savedSourcesAvailable(scope)).toBe(true);
    expect(await repository.submitDue(scope)).toMatchObject({ created: false });
  });

  it("backs off permission failures independently while allowing healthy source refresh", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    for (const source of first.run!.sources) {
      if (source.source !== "users" && source.source !== "usage_reports") await publishSource(scope, source.source);
      await repository.updateSource(scope, first.run!.id, source.source, source.source === "users"
        ? { status: "permission_required", count: null, message: "Directory permission unavailable.", canRetry: true }
        : { status: "succeeded", count: 0, message: "Saved fixture inventory.", canRetry: false });
    }
    await repository.finishRun(scope, first.run!.id);
    expect(await repository.getRun(scope, first.run!.id)).toMatchObject({ status: "partial" });
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-
      CASE WHEN source_id='users' THEN interval '16 minutes' ELSE interval '6 hours 1 minute' END
      WHERE run_id=$1`, [first.run!.id]);
    await fixture.operator.query(`UPDATE data_sync_success_markers SET last_success_at=clock_timestamp()-interval '6 hours 1 minute'
      WHERE tenant_id=$1`, [scope.tenantId]);
    const next = await repository.submitDue(scope);
    expect(next.run?.sources.map(source => source.source)).toEqual(["graph_packages", "power_platform"]);
    await complete(scope, next.run!);
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '61 minutes'
      WHERE run_id=$1 AND source_id='users'`, [first.run!.id]);
    expect((await repository.submitDue(scope)).run?.sources.map(source => source.source)).toEqual(["users"]);
  });

  it("retries old authorization failures once after sign-in without bypassing other source cooldowns", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    await publishSource(scope, "users");
    for (const source of first.run!.sources) await repository.updateSource(scope, first.run!.id, source.source, {
      status: source.source === "graph_packages" ? "waiting_authorization"
        : source.source === "power_platform" ? "permission_required" : "succeeded",
      count: 0, message: "Fixture result.", canRetry: source.source !== "users",
    });
    await repository.finishRun(scope, first.run!.id);
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '1 minute'
      WHERE run_id=$1`, [first.run!.id]);
    const signedInAt = Date.now();
    expect((await repository.submitDue(scope)).created).toBe(false);
    const next = await repository.submitDue(scope, signedInAt);
    expect(next).toMatchObject({ created: true, run: { sources: [{ source: "graph_packages", status: "queued" }] } });
    await repository.updateSource(scope, next.run!.id, "graph_packages", {
      status: "waiting_authorization", message: "MFA is still required.", canRetry: true,
    });
    await repository.finishRun(scope, next.run!.id);
    expect((await repository.submitDue(scope, signedInAt)).created).toBe(false);
  });

  it("does not close a live run during the child authorization handoff", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    for (const source of first.run!.sources) await repository.updateSource(scope, first.run!.id, source.source,
      { status: "waiting_authorization", message: "Starting authorized child work.", canRetry: true });
    const concurrent = await repository.submitDue(scope);
    expect(concurrent).toMatchObject({ created: false, run: { id: first.run!.id, status: "waiting" } });
    await repository.updateSource(scope, first.run!.id, "graph_packages",
      { status: "running", message: "Child started.", canRetry: false });
    expect(await repository.getRun(scope, first.run!.id)).toMatchObject({ status: "running" });
  });

  it("does not reuse an old run's start to bypass a newly retried source's authorization cooldown", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    await publishSource(scope, "users");
    await publishSource(scope, "power_platform");
    for (const source of first.run!.sources) await repository.updateSource(scope, first.run!.id, source.source, {
      status: source.source === "graph_packages" ? "waiting_authorization" : "succeeded",
      count: 0, message: "Fixture result.", canRetry: source.source === "graph_packages",
    });
    await repository.finishRun(scope, first.run!.id);
    const signedInAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 5));
    await repository.retry(scope, first.run!.id, ["graph_packages"]);
    const boundary = (await fixture.runtime.query(`SELECT attempt_started_at FROM data_sync_run_sources
      WHERE run_id=$1 AND source_id='graph_packages'`, [first.run!.id])).rows[0].attempt_started_at as Date;
    expect(boundary.getTime()).toBeGreaterThan(signedInAt);
    await repository.updateSource(scope, first.run!.id, "graph_packages", {
      status: "waiting_authorization", message: "The renewed session still needs interaction.", canRetry: true,
    });
    await repository.finishRun(scope, first.run!.id);
    expect(await repository.submitDue(scope, signedInAt)).toMatchObject({ created: false, run: { id: first.run!.id } });
    expect((await fixture.runtime.query(`SELECT attempt_started_at FROM data_sync_run_sources
      WHERE run_id=$1 AND source_id='graph_packages'`, [first.run!.id])).rows[0].attempt_started_at).toEqual(boundary);
    await expect(fixture.runtime.query(`UPDATE data_sync_run_sources SET attempt_started_at=clock_timestamp()
      WHERE run_id=$1 AND source_id='graph_packages'`, [first.run!.id])).rejects.toThrow("attempt start is immutable");
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await repository.submitDue(scope, Date.now())).toMatchObject({
      created: true, run: { sources: [{ source: "graph_packages", status: "queued" }] },
    });
  });

  it("allows recovery when an old worker reports its authentication failure after sign-in completes", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    await publishSource(scope, "users");
    await publishSource(scope, "power_platform");
    await repository.updateSource(scope, first.run!.id, "users",
      { status: "succeeded", count: 0, message: "Saved.", canRetry: false });
    await repository.updateSource(scope, first.run!.id, "power_platform",
      { status: "succeeded", count: 0, message: "Saved.", canRetry: false });
    const signedInAt = Date.now();
    await repository.updateSource(scope, first.run!.id, "graph_packages",
      { status: "waiting_authorization", message: "Old token request finished late.", canRetry: true });
    await repository.finishRun(scope, first.run!.id);
    expect(await repository.submitDue(scope, signedInAt)).toMatchObject({
      created: true, run: { sources: [{ source: "graph_packages", status: "queued" }] },
    });
  });

  it.each(["manual", "automatic"] as const)("releases a finished %s authorization wait for one fresh-sign-in retry", async mode => {
    const scope = owner();
    const now = new Date().toISOString();
    await publishSource(scope, "graph_packages");
    await publishSource(scope, "power_platform");
    await repository.recordSuccessMarker(scope, "graph_packages", 0, now);
    await repository.recordSuccessMarker(scope, "power_platform", 0, now);
    const first = mode === "manual"
      ? await repository.submit(scope, { mode: "full", sources: ["users"] })
      : await repository.submitDue(scope);
    await repository.updateSource(scope, first.run!.id, "users", {
      status: "waiting_authorization", count: 2100, message: "Previous authorization expired.", canRetry: true,
    });
    expect(await repository.submitDue(scope)).toMatchObject({ created: false, run: { id: first.run!.id, status: "waiting" } });
    await repository.finishRun(scope, first.run!.id);
    expect(await repository.getRun(scope, first.run!.id)).toMatchObject({
      status: "partial", completedAt: expect.any(String),
      sources: [{ source: "users", status: "waiting_authorization", count: 2100 }],
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const signedInAt = Date.now();
    const [left, right] = await Promise.all([repository.submitDue(scope, signedInAt), repository.submitDue(scope, signedInAt)]);
    expect([left.created, right.created].sort()).toEqual([false, true]);
    expect(left.run?.id).toBe(right.run?.id);
    expect(left.run).toMatchObject({ automatic: true, mode: "incremental", sources: [{ source: "users", status: "queued" }] });
    expect((await fixture.runtime.query("SELECT clear_saved_data FROM data_sync_runs WHERE id=$1", [left.run!.id])).rows[0])
      .toEqual({ clear_saved_data: false });
  });

  it("defers to manual work and never clears snapshots or rewrites immutable intent", async () => {
    const scope = owner();
    const manual = await repository.submit(scope, { mode: "initial" });
    expect(await repository.submitDue(scope)).toMatchObject({ created: false, run: { id: manual.run.id } });
    await repository.cancel(scope, manual.run.id);
    const automatic = await repository.submitDue(owner());
    await expect(fixture.runtime.query("UPDATE data_sync_runs SET automatic=false WHERE id=$1", [automatic.run!.id]))
      .rejects.toThrow("immutable");
    await expect(fixture.runtime.query("UPDATE data_sync_runs SET clear_saved_data=true WHERE id=$1", [automatic.run!.id]))
      .rejects.toThrow();
    expect((await fixture.runtime.query("SELECT clear_saved_data FROM data_sync_runs WHERE id=$1", [automatic.run!.id])).rows[0])
      .toEqual({ clear_saved_data: false });
  });

  it("recovers interrupted automatic work without launching anything until a signed-in due check", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    await repository.recoverInterrupted();
    expect(await repository.getRun(scope, first.run!.id)).toMatchObject({ status: "partial" });
    expect((await repository.submitDue(scope)).created).toBe(false);
    expect(await repository.getRun(scope, first.run!.id)).toMatchObject({ status: "partial" });
    expect(await repository.automaticRevisions(scope)).toEqual({
      users: expect.stringMatching(/^[a-f0-9]{64}$/),
      graph_packages: expect.stringMatching(/^[a-f0-9]{64}$/),
      power_platform: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
