import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { DataSyncRepository, type DataSyncScope } from "./dataSync.js";
import type { DataSyncRun } from "../types/dataSync.js";
import type { CopilotDirectoryUser } from "../types/copilotUsage.js";
import { generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { publishFixtureDirectory, publishFixtureEmptyActivity } from "../../scripts/userSourceFixture.js";
import { inventoryBaseline, inventoryInput, refreshInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
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
async function failure(scope: DataSyncScope, source: "directory" | "app_activity", authorization = false) {
  const error = new AppError(authorization ? 401 : 403, authorization ? "authentication_required" : "permission_required", "Fixture authorization unavailable");
  await expect(new UserSourceStages(fixture.runtime).execute(generationInput({
    scope: { ...generationInput().scope, ...scope, source },
  }), async () => { throw error; }, { beforePublish: async () => {} })).rejects.toBe(error);
}

async function complete(scope: DataSyncScope, run: DataSyncRun) {
  for (const source of run.sources) await repository.updateSource(scope, run.id, source.source,
    { status: "succeeded", count: 0, message: "Saved empty fixture source.", canRetry: false });
}

describe("session-driven automatic sync admission", () => {
  it("atomically deduplicates across independent callers and does not request manual reports", async () => {
    const scope = owner();
    const [left, right] = await Promise.all([
      repository.submitDue(scope), new DataSyncRepository(fixture.runtime).submitDue(scope),
    ]);
    expect(left.run?.id).toBe(right.run?.id);
    expect([left.created, right.created].sort()).toEqual([false, true]);
    expect(left.run).toMatchObject({ automatic: true, mode: "incremental" });
    expect(left.run?.sources.map(source => source.source)).toEqual(["graph_packages", "power_platform", "users"]);
    expect(await repository.getRun(owner(), left.run!.id)).toBeUndefined();
    await complete(scope, left.run!);
    expect(await repository.submitDue(scope)).toMatchObject({ created: false, run: { id: left.run!.id } });
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
      const selected = await reader.capture(identity(scope), "delegated");
      const { selection: _selection, ...page } = await reader.page(selected.id, identity(scope));
      return page;
    };
  }

  describe("persisted automatic revision boundaries", () => {
    it("separates package, detail, native ownership and people publications/expiry from the Users license/activity response", async () => {
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
        idempotencyKey: "automatic-revision-package", tokenMode: "delegated", authorizationPrincipalId: scope.principalId,
      });
      await packages.markRunning(scope, packageJob.id);
      const summary = allowlistedPackage({ id: "revision-package", displayName: "Saved package", isBlocked: false });
      await refreshInventoryFixture(fixture.runtime, scope, packageJob.id, "packages", [packageInventoryRecord(summary)]);
      await onlyChanged("graph_packages", true);

      const detailJob = await packages.submit(scope, { idempotencyKey: "automatic-revision-detail",
        tokenMode: "delegated", authorizationPrincipalId: scope.principalId, requestedIds: [summary.id] });
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
      await onlyChanged("power_platform");
      const savedPeople = new SavedAgentPeopleService(fixture.runtime);
      expect((await savedPeople.read(scope, [personId])).get(personId)?.displayName).toBe("Exact owner name");

      for (const [expiry, source] of [[packageExpiry, "graph_packages"], [nativeExpiry, "power_platform"]] as const) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry.getTime() - Date.now()) + 20));
        await onlyChanged(source);
        expect(await repository.automaticRevisions(scope)).toEqual(previous);
      }
      await fixture.operator.query(`UPDATE agent_people_cache SET expires_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=$1 AND principal_id=$2`, [scope.tenantId, scope.principalId]);
      await onlyChanged("power_platform");
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

    it.each(["directory", "app_activity"] as const)("tracks %s publication, retained failure, recovery and expiry", async source => {
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
      expect(before.graph_packages).toBe(empty.graph_packages);
      if (source === "directory") expect(before.power_platform).not.toBe(empty.power_platform);
      else expect(before.power_platform).toBe(empty.power_platform);
      await failure(scope, source);
      const failed = await repository.automaticRevisions(scope);
      expect(failed.users).not.toBe(before.users);
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
      expect(recovered.graph_packages).toBe(failed.graph_packages);
      if (source === "directory") expect(recovered.power_platform).not.toBe(failed.power_platform);
      else expect(recovered.power_platform).toBe(failed.power_platform);
      if (source === "directory") expect((await readUsers()).value[0].directory.displayName).toBe("Renamed directory person");
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt!.getTime() - Date.now() + 20)));
      const expired = await repository.automaticRevisions(scope);
      expect(expired.users).not.toBe(recovered.users);
      expect(expired.graph_packages).toBe(recovered.graph_packages);
      if (source === "directory") expect(expired.power_platform).not.toBe(recovered.power_platform);
      else expect(expired.power_platform).toBe(recovered.power_platform);
      expect((await readUsers()).sources[source]).toMatchObject({ state: "unavailable" });
      expect(await repository.automaticRevisions(scope)).toEqual(expired);
    });

    it("ignores other scopes and unlinked snapshots, but detects source status without any retained data", async () => {
      const scope = owner();
      const before = await repository.automaticRevisions(scope);
      const other = await publishFixtureDirectory(fixture.runtime, identity({ ...scope, principalId: "another-reader" }), []);
      await publishFixtureEmptyActivity(fixture.runtime, identity({ ...scope, tenantId: "another-tenant" }));
      expect(await repository.automaticRevisions(scope)).toEqual(before);

      await failure(scope, "directory", true);
      const failed = await repository.automaticRevisions(scope);
      expect(failed.users).not.toBe(before.users);
      expect(failed.graph_packages).toBe(before.graph_packages);
      expect(failed.power_platform).toBe(before.power_platform);
      await expect(fixture.operator.query(`UPDATE data_generation_heads head SET generation_id=$3
        FROM data_scope_epochs scope WHERE head.scope_id=scope.id AND scope.tenant_id=$1 AND scope.principal_id=$2
          AND scope.source='directory'`, [scope.tenantId, scope.principalId, other.generationId])).rejects.toMatchObject({ message: "data_head_fenced" });
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

  it("refreshes only sources whose saved success and latest attempt are at least 15 minutes old", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    await complete(scope, first.run!);
    await fixture.operator.query(`UPDATE data_sync_success_markers SET last_success_at=clock_timestamp()-interval '16 minutes'
      WHERE tenant_id=$1 AND principal_id=$2 AND source_id='graph_packages'`, [scope.tenantId, scope.principalId]);
    // A recent attempt still prevents a duplicate even when its saved timestamp is older.
    expect((await repository.submitDue(scope)).created).toBe(false);
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '16 minutes'
      WHERE run_id=$1 AND source_id='graph_packages'`, [first.run!.id]);
    const next = await repository.submitDue(scope);
    expect(next).toMatchObject({ created: true, run: { sources: [{ source: "graph_packages" }] } });
    await complete(scope, next.run!);
  });

  it("backs off permission failures independently while allowing healthy source refresh", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    for (const source of first.run!.sources) await repository.updateSource(scope, first.run!.id, source.source,
      source.source === "users"
        ? { status: "permission_required", count: null, message: "Directory permission unavailable.", canRetry: true }
        : { status: "succeeded", count: 0, message: "Saved fixture inventory.", canRetry: false });
    await repository.finishAutomatic(scope, first.run!.id);
    expect(await repository.getRun(scope, first.run!.id)).toMatchObject({ status: "partial" });
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '16 minutes'
      WHERE run_id=$1`, [first.run!.id]);
    await fixture.operator.query(`UPDATE data_sync_success_markers SET last_success_at=clock_timestamp()-interval '16 minutes'
      WHERE tenant_id=$1 AND principal_id=$2`, [scope.tenantId, scope.principalId]);
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
    for (const source of first.run!.sources) await repository.updateSource(scope, first.run!.id, source.source, {
      status: source.source === "graph_packages" ? "waiting_authorization"
        : source.source === "power_platform" ? "permission_required" : "succeeded",
      count: 0, message: "Fixture result.", canRetry: source.source !== "users",
    });
    await repository.finishAutomatic(scope, first.run!.id);
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '1 minute'
      WHERE run_id=$1`, [first.run!.id]);
    const signedInAt = Date.now();
    expect((await repository.submitDue(scope)).created).toBe(false);
    const next = await repository.submitDue(scope, signedInAt);
    expect(next).toMatchObject({ created: true, run: { sources: [{ source: "graph_packages", status: "queued" }] } });
    await repository.updateSource(scope, next.run!.id, "graph_packages", {
      status: "waiting_authorization", message: "MFA is still required.", canRetry: true,
    });
    await repository.finishAutomatic(scope, next.run!.id);
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

  it("allows recovery when an old worker reports its authentication failure after sign-in completes", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    await repository.updateSource(scope, first.run!.id, "users",
      { status: "succeeded", count: 0, message: "Saved.", canRetry: false });
    await repository.updateSource(scope, first.run!.id, "power_platform",
      { status: "succeeded", count: 0, message: "Saved.", canRetry: false });
    const signedInAt = Date.now();
    await repository.updateSource(scope, first.run!.id, "graph_packages",
      { status: "waiting_authorization", message: "Old token request finished late.", canRetry: true });
    await repository.finishAutomatic(scope, first.run!.id);
    expect(await repository.submitDue(scope, signedInAt)).toMatchObject({
      created: true, run: { sources: [{ source: "graph_packages", status: "queued" }] },
    });
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
