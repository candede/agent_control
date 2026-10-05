import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { publishFixtureDirectory, publishFixtureEmptyActivity } from "../../scripts/userSourceFixture.js";
import { inventorySelectionFixture, refreshInventoryFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { fingerprints } from "../../scripts/backup.js";
import { AppError } from "../errors.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import type { StartDataSyncInput } from "../types/dataSync.js";
import { powerPlatformResourceTypes, type PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { DataSyncRepository, requireUserPublication, type DataSyncScope, type UserSourcePublication } from "./dataSync.js";
import { createJobConfirmation, JobRepository, type JobIntentInput } from "./jobs.js";
import { OfficialReportImports } from "./officialReportImports.js";
import { UserSourceStages } from "./userSourceStages.js";
import { UserSourcesRepository } from "./userSources.js";
import { PackageRefreshJobs } from "./packageRefreshJobs.js";
import { PowerPlatformRefreshJobs } from "./powerPlatformRefreshJobs.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
import { completeInventoryJob, inventoryJobInput } from "../services/inventoryRuntime.js";
import { packageInventoryRecord, powerPlatformInventoryRecord } from "../services/inventoryRecordProjection.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: DataSyncRepository;
let packages: PackageRefreshJobs;
let inventory: PowerPlatformRefreshJobs;

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new DataSyncRepository(fixture.runtime);
  packages = new PackageRefreshJobs(fixture.runtime);
  inventory = new PowerPlatformRefreshJobs(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });

const cleanInput = { mode: "full", clearSavedData: true } as const;
const now = () => new Date().toISOString();
const newScope = (): DataSyncScope => ({ tenantId: `tenant-${randomUUID()}`, principalId: `viewer-${randomUUID()}` });
const identity = (scope: DataSyncScope) => ({ ...selectionIdentity, ...scope });
async function userPage(scope: DataSyncScope) {
  const reader = new UserSourcesRepository(fixture.runtime, "synthetic-native-cleanup-source-secret");
  const selected = await reader.capture(identity(scope), "delegated");
  return reader.page(selected.id, identity(scope));
}
function collectSource(scope: DataSyncScope, source: "directory" | "app_activity", publication: UserSourcePublication, failure?: Error) {
  const stages = new UserSourceStages(fixture.runtime);
  return stages.execute(generationInput({
    scope: { ...generationInput().scope, ...scope, source }, jobKind: "data_sync", ...publication,
  }), async lease => {
    if (failure) throw failure;
    const key = await stages.query(lease, source === "directory" ? "discovery" : "activity", "synthetic:cleanup-empty");
    await stages.page(lease, key, "synthetic:cleanup-empty", 0, 0);
    await stages.finishQuery(lease, key);
  }, { beforePublish: async () => {}, completeJob: client => requireUserPublication(client, scope, publication) });
}

describe("clean full data sync admission", () => {
  it("validates the cleanup contract even when callers bypass HTTP parsing", async () => {
    const scope = newScope();
    for (const input of [
      ...[null, 0, 1, "true", [], {}].map(clearSavedData => ({ mode: "full", clearSavedData })),
      { mode: "initial", clearSavedData: true },
      { mode: "incremental", clearSavedData: true },
      { ...cleanInput, sources: ["users"] },
      { ...cleanInput, sources: ["users", "graph_packages", "power_platform", "usage_reports"] },
    ]) {
      await expect(repository.submit(scope, input as StartDataSyncInput)).rejects.toMatchObject({
        status: 400, code: "invalid_data_sync_cleanup",
      });
    }
    expect(await repository.listRuns(scope)).toEqual([]);
  });

  it("preserves saved data for existing full callers, including an explicit false flag", async () => {
    const scope = newScope();
    await seedSnapshots(scope);
    const before = await scopedSnapshots(scope);
    const first = await repository.submit(scope, { mode: "full" });
    const equivalent = await repository.submit(scope, { mode: "full", clearSavedData: false });
    expect(equivalent).toMatchObject({ created: false, run: { id: first.run.id } });
    expect(await scopedSnapshots(scope)).toEqual(before);
    await expect(repository.submit(scope, cleanInput)).rejects.toMatchObject({ code: "data_sync_active" });
    expect(await scopedSnapshots(scope)).toEqual(before);
  });

  it("clears all scoped read snapshots and core markers but preserves accepted history and control records", async () => {
    const scope = newScope();
    const otherPrincipal = { ...scope, principalId: "other-viewer" };
    const otherTenant = { ...scope, tenantId: "other-tenant" };
    await seedSnapshots(scope);
    const selected = await inventorySelectionFixture(fixture.runtime, scope);
    await seedSnapshots(otherPrincipal);
    await seedSnapshots(otherTenant);
    const othersBefore = await Promise.all([scopedSnapshots(otherPrincipal), scopedSnapshots(otherTenant)]);
    await seedAcceptedUsage(scope);
    const jobs = new JobRepository(fixture.runtime);
    const intent: JobIntentInput = {
      targets: [{ id: "package", displayName: "Package", prestate: { kind: "block", isBlocked: false } }],
      action: "block", scope: "single", requestPath: "/api/agents/package/block",
      actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId, username: "fixture@example.invalid", displayName: "Fixture" },
    };
    const controlJob = await jobs.submit(scope, {
      ...intent, idempotencyKey: randomUUID(), confirmationHash: createJobConfirmation(intent).confirmationHash,
    });
    await jobs.cancel(controlJob.id, scope);
    await fixture.operator.query(`INSERT INTO audit_events
      (id,event_id,operation_id,tenant_id,principal_id,actor_username,actor_name,scope,action,target_blocked_state,agent_id,started_at,status,request_path)
      VALUES(gen_random_uuid(),$3,$3,$1,$2,'fixture@example.invalid','Fixture','single','block',true,'package',clock_timestamp(),'succeeded','/fixture')`,
    [scope.tenantId, scope.principalId, randomUUID()]);
    const preservedTables = [
      "official_usage_artifacts", "official_usage_sets", "official_usage_versions", "official_usage_state",
      "official_usage_row_facts", "official_usage_version_rows", "official_usage_set_versions",
      "official_usage_bundle_receipts", "official_usage_audit", "audit_events", "jobs", "job_items", "job_attempts",
      "package_refresh_jobs", "power_platform_refresh_jobs", "inventory_canonical_ids", "capability_configuration",
      "capability_evidence", "package_mutation_qualifications", "copilot_quarantine_status_observations",
      "copilot_quarantine_jobs", "copilot_quarantine_audit", "operational_state",
    ];
    const preserved = await tableRows(preservedTables);
    const result = await repository.submit(scope, cleanInput);
    expect(result.created).toBe(true);
    expect(result.run.sources).toEqual([
      expect.objectContaining({ source: "graph_packages", count: null, lastSuccessAt: null }),
      expect.objectContaining({ source: "power_platform", count: null, lastSuccessAt: null }),
      expect.objectContaining({ source: "users", count: null, lastSuccessAt: null }),
    ]);
    expect(await scopedSnapshots(scope)).toMatchObject({
      userSources: { value: [], sources: {
        directory: { state: "unavailable", generationId: null, rowCount: null },
        app_activity: { state: "unavailable", generationId: null, rowCount: null },
      } },
      inventoryRoots: [], inventoryRecords: [],
    });
    expect(await repository.listMarkers(scope)).toEqual([
      expect.objectContaining({ source: "users", status: "not_started", count: null }),
      expect.objectContaining({ source: "graph_packages", status: "not_started", count: null }),
      expect.objectContaining({ source: "power_platform", status: "not_started", count: null }),
      expect.objectContaining({ source: "usage_reports", status: "succeeded", count: 3 }),
    ]);
    expect(await tableRows(preservedTables)).toEqual(preserved);
    expect(await Promise.all([scopedSnapshots(otherPrincipal), scopedSnapshots(otherTenant)])).toEqual(othersBefore);
    await expect(selected.queries.page(selected.selection.id, selected.identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    expect((await scopedSnapshots(scope)).inventoryRecords).toEqual([]);
    expect((await userPage(scope)).sources.directory).toMatchObject({ state: "unavailable", generationId: null, rowCount: null, observedAt: null });
    await expect(fixture.runtime.query("DELETE FROM package_inventory_snapshots WHERE tenant_id=$1", [scope.tenantId])).rejects.toThrow();
    await expect(fixture.runtime.query("DELETE FROM data_sync_success_markers WHERE tenant_id=$1", [scope.tenantId])).rejects.toThrow();
    await expect(fixture.runtime.query("SELECT clear_admitted_data_sync_snapshots()")).rejects.toThrow();
  });

  it("deduplicates concurrent clean starts and never clears again when polling or resubmitting", async () => {
    const scope = newScope();
    await seedSnapshots(scope);
    const [first, second] = await Promise.all([repository.submit(scope, cleanInput), repository.submit(scope, cleanInput)]);
    expect(first.run.id).toBe(second.run.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    await publishFixtureDirectory(fixture.runtime, identity(scope), []);
    const replacement = await scopedSnapshots(scope);
    expect(await repository.submit(scope, cleanInput)).toMatchObject({ created: false, run: { id: first.run.id } });
    await expect(repository.submit(scope, { mode: "full" })).rejects.toMatchObject({ code: "data_sync_active" });
    expect(await scopedSnapshots(scope)).toEqual(replacement);
    await expect(fixture.runtime.query("UPDATE data_sync_runs SET clear_saved_data=false WHERE id=$1", [first.run.id]))
      .rejects.toThrow("data sync run intent is immutable");
  });

  it("rolls back the entire deletion if durable source creation fails after cleanup", async () => {
    const scope = newScope();
    await seedSnapshots(scope);
    const before = await scopedSnapshots(scope);
    const markers = await repository.listMarkers(scope);
    await fixture.operator.query(`CREATE FUNCTION reject_cleanup_source_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture source insert failure'; END $$;
      CREATE TRIGGER reject_cleanup_source_fixture BEFORE INSERT ON data_sync_run_sources
      FOR EACH ROW EXECUTE FUNCTION reject_cleanup_source_fixture()`);
    try {
      await expect(repository.submit(scope, cleanInput)).rejects.toThrow("fixture source insert failure");
    } finally {
      await fixture.operator.query("DROP TRIGGER reject_cleanup_source_fixture ON data_sync_run_sources; DROP FUNCTION reject_cleanup_source_fixture()");
    }
    expect(await scopedSnapshots(scope)).toEqual(before);
    expect(await repository.listMarkers(scope)).toEqual(markers);
    expect(await repository.listRuns(scope)).toEqual([]);
  });

  it("does not clear data when hourly admission is full", async () => {
    const scope = newScope();
    await seedSnapshots(scope);
    const before = await scopedSnapshots(scope);
    await fixture.operator.query(`INSERT INTO data_sync_runs(id,tenant_id,principal_id,mode,source_ids,request_hash,status)
      SELECT gen_random_uuid(),$1,$2,'incremental','["users"]',repeat('a',64),'completed' FROM generate_series(1,20)`,
    [scope.tenantId, scope.principalId]);
    await expect(repository.submit(scope, cleanInput)).rejects.toMatchObject({ code: "data_sync_admission_full" });
    expect(await scopedSnapshots(scope)).toEqual(before);
    expect(await repository.listRuns(scope)).toHaveLength(20);
  });

  it.each(["packages", "inventory"] as const)("rejects unfinished %s refreshes before any deletion", async provider => {
    const scope = newScope();
    await seedSnapshots(scope);
    const before = await scopedSnapshots(scope);
    const job = await submitProvider(scope, provider);
    for (const running of [false, true]) {
      if (running) await (provider === "packages" ? packages : inventory).markRunning(scope, job.id);
      await expect(repository.submit(scope, cleanInput)).rejects.toMatchObject({
        status: 409, code: "data_sync_source_active",
      });
      expect(await scopedSnapshots(scope)).toEqual(before);
      expect(await repository.listRuns(scope)).toEqual([]);
    }
    if (provider === "packages") await packages.cancel(scope, job.id, scope.principalId);
    else await inventory.cancel(scope, job.id);
    await repository.submit(scope, cleanInput);
    await expect(publishProvider(scope, provider, job.id)).rejects.toMatchObject({
      code: "inventory_job_fenced",
    });
    expect((await scopedSnapshots(scope)).inventoryRoots).toEqual([]);
  });

  it.each(["packages", "inventory"] as const)("serializes %s publication with clean admission", async provider => {
    const scope = newScope();
    await seedSnapshots(scope);
    const job = await submitProvider(scope, provider);
    await (provider === "packages" ? packages : inventory).markRunning(scope, job.id);
    const [admission, publication] = await Promise.allSettled([
      repository.submit(scope, cleanInput),
      publishProvider(scope, provider, job.id),
    ]);
    expect(publication.status).toBe("fulfilled");
    if (admission.status === "rejected") {
      expect(admission.reason).toMatchObject({ code: "data_sync_source_active" });
      expect((await scopedSnapshots(scope)).inventoryRoots.length).toBeGreaterThan(0);
      await repository.submit(scope, cleanInput);
    }
    expect((await scopedSnapshots(scope)).inventoryRoots).toEqual([]);
  });

  it("fences stopped user attempts and keeps failed replacement data missing instead of stale or zero", async () => {
    const scope = newScope();
    const old = await repository.submit(scope, { mode: "incremental", sources: ["users"] });
    const publication = { runId: old.run.id, jobId: randomUUID() };
    await repository.attachJob(scope, old.run.id, "users", publication.jobId);
    await repository.updateSource(scope, old.run.id, "users", {
      status: "running", jobId: publication.jobId, message: "Reading old user sources.", canRetry: false,
    });
    await collectSource(scope, "directory", publication);
    await repository.cancel(scope, old.run.id);
    const clean = await repository.submit(scope, cleanInput);
    await expect(collectSource(scope, "directory", publication)).rejects.toThrow("data_source_job_fenced");
    await expect(collectSource(scope, "app_activity", publication)).rejects.toThrow("data_source_job_fenced");
    await expect(collectSource(scope, "directory", publication, new Error("Late old error."))).rejects.toThrow("data_source_job_fenced");
    await repository.updateSource(scope, old.run.id, "users", {
      status: "succeeded", jobId: publication.jobId, count: 0, message: "Late worker completion.", canRetry: false,
    });
    const failedPublication = { runId: clean.run.id, jobId: randomUUID() };
    await repository.attachJob(scope, clean.run.id, "users", failedPublication.jobId);
    await repository.updateSource(scope, clean.run.id, "users", {
      status: "running", jobId: failedPublication.jobId, message: "Reading replacement.", canRetry: false,
    });
    await expect(collectSource(scope, "directory", failedPublication, new AppError(403, "permission_required", "Directory permission required.")))
      .rejects.toMatchObject({ status: 403, code: "permission_required" });
    await repository.updateSource(scope, clean.run.id, "users", {
      status: "failed", jobId: failedPublication.jobId, message: "Replacement failed.", canRetry: true,
    });
    expect((await userPage(scope)).sources.directory).toMatchObject({
      attemptStatus: "permission_required", generationId: null, rowCount: null, observedAt: null,
    });
    expect((await repository.listMarkers(scope))[0]).toMatchObject({ source: "users", status: "not_started", count: null });
    await repository.retry(scope, clean.run.id, ["users"]);
    await repository.updateSource(scope, clean.run.id, "users", {
      status: "succeeded", jobId: failedPublication.jobId, count: 0, message: "Late completion before the retry attaches.", canRetry: false,
    });
    expect((await repository.getRun(scope, clean.run.id))?.sources.find(source => source.source === "users")?.status).toBe("queued");
    const replacement = { runId: clean.run.id, jobId: randomUUID() };
    await repository.attachJob(scope, clean.run.id, "users", replacement.jobId);
    await repository.updateSource(scope, clean.run.id, "users", {
      status: "running", jobId: replacement.jobId, message: "Retrying replacement.", canRetry: false,
    });
    await expect(collectSource(scope, "directory", failedPublication)).rejects.toThrow("data_source_job_fenced");
    await repository.updateSource(scope, clean.run.id, "users", {
      status: "succeeded", jobId: failedPublication.jobId, count: 0, message: "Late previous attempt completion.", canRetry: false,
    });
    expect((await repository.getRun(scope, clean.run.id))?.sources.find(source => source.source === "users")?.status).toBe("running");
    await collectSource(scope, "directory", replacement);
    expect(await userPage(scope)).toMatchObject({ value: [], sources: { directory: { state: "available", generationId: expect.any(String), rowCount: 0 } } });
  });
});

async function seedSnapshots(scope: DataSyncScope) {
  await publishFixtureDirectory(fixture.runtime, identity(scope), []);
  await publishFixtureDirectory(fixture.runtime, identity(scope), []);
  await publishFixtureEmptyActivity(fixture.runtime, identity(scope));
  for (const requestedIds of [[], ["package"]]) {
    const job = await packages.submit(scope, {
      authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: randomUUID(), requestedIds,
    });
    await packages.markRunning(scope, job.id);
    const records = [packageInventoryRecord(allowlistedPackage({ id: "package", displayName: "Fixture package", isBlocked: false }))];
    if (!requestedIds.length) await refreshInventoryFixture(fixture.runtime, scope, job.id, "packages", records);
    else {
      const input = await inventoryJobInput(fixture.runtime, scope, "packages", job.id);
      const stages = new InventoryGenerations(fixture.runtime);
      await stages.execute(input, { domain: "packages", mode: "delta", channel: "exact", targets: requestedIds }, async lease => {
        await stages.appendBounded(lease, records);
      }, { authorize: async () => {}, completeJob: completeInventoryJob(input, "packages") });
      await reconcileInventoryFixture(fixture.runtime, scope);
    }
  }
  const job = await submitProvider(scope, "inventory");
  await inventory.markRunning(scope, job.id);
  await refreshInventoryFixture(fixture.runtime, scope, job.id, "power_platform",
    [powerPlatformInventoryRecord(resource(scope))], [...powerPlatformResourceTypes]);
  for (const source of ["users", "graph_packages", "power_platform", "usage_reports"] as const) {
    await repository.recordSuccessMarker(scope, source, source === "usage_reports" ? 3 : 1, now());
  }
}

function submitProvider(scope: DataSyncScope, provider: "packages" | "inventory") {
  return provider === "packages"
    ? packages.submit(scope, { authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: randomUUID() })
    : inventory.submit(scope, { roleScope: "full", requestedTypes: powerPlatformResourceTypes, idempotencyKey: randomUUID() });
}

function publishProvider(scope: DataSyncScope, provider: "packages" | "inventory", jobId: string) {
  return provider === "packages"
    ? refreshInventoryFixture(fixture.runtime, scope, jobId, "packages", [])
    : refreshInventoryFixture(fixture.runtime, scope, jobId, "power_platform", [], [...powerPlatformResourceTypes]);
}

function resource(scope: DataSyncScope): PowerPlatformResource {
  return {
    tenantId: scope.tenantId, nativeId: "resource", type: "microsoft.copilotstudio/agents", location: null,
    displayName: "Fixture agent", environmentId: "environment", createdAt: null, createdBy: null, lastPublishedAt: null,
    sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown", agentKind: "copilot_studio_agent",
    lifecycle: "draft", identityConfidence: "exact_native",
    identifiers: [{ kind: "power_platform_resource_id", value: "resource" }], provenance: {}, details: {}, unknownFieldCount: 0,
  };
}

async function scopedSnapshots(scope: DataSyncScope) {
  const inventoryRoots = (await fixture.runtime.query(`SELECT root.scope_id,root.baseline_id,root.revision,root.domain
    FROM inventory_roots root JOIN data_scope_epochs scope ON scope.id=root.scope_id
    JOIN inventory_revisions revision ON revision.scope_id=root.scope_id AND revision.revision=root.revision
    JOIN data_generations generation ON generation.id=revision.generation_id
    WHERE root.current AND scope.tenant_id=$1 AND scope.principal_id=$2
      AND generation.scope_epoch=scope.epoch AND generation.session_epoch=scope.session_epoch
      AND generation.state='published' AND generation.expires_at>clock_timestamp()
    ORDER BY root.scope_id LIMIT 17`, [scope.tenantId, scope.principalId])).rows;
  expect(inventoryRoots.length).toBeLessThan(17);
  const inventoryRecords = (await fixture.runtime.query(`SELECT record.generation_id,record.identity,record.domain
    FROM inventory_roots root JOIN inventory_memberships membership ON membership.baseline_id=root.baseline_id
      AND membership.valid_from_revision<=root.revision AND (membership.valid_to_revision IS NULL OR membership.valid_to_revision>root.revision)
    JOIN inventory_records record ON record.generation_id=membership.generation_id AND record.identity=membership.identity
    WHERE root.scope_id=ANY($1::uuid[]) AND root.current ORDER BY record.domain,record.identity LIMIT 250`,
  [inventoryRoots.map(root => root.scope_id)])).rows;
  expect(inventoryRecords.length).toBeLessThan(250);
  const { selection: _selection, ...userSources } = await userPage(scope);
  return { inventoryRoots, inventoryRecords, userSources };
}

async function tableRows(tables: string[]) {
  return fingerprints(fixture.operator, tables);
}

async function seedAcceptedUsage(scope: DataSyncScope) {
  const official = new OfficialReportImports(fixture.runtime);
  const bundleId = randomUUID();
  for (const content of [
    "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nagent,Agent,Your org,1,0,4,2026-08-15",
    "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\nagent,Agent,Your org,user@example.invalid,4,2026-08-15",
    "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\nuser@example.invalid,User,1,4,2026-08-15",
  ]) {
    await official.stage(identity(scope), { bundleId }, (async function* () { yield Buffer.from(content); })(), {
        reportingPeriod: { startDate: "2026-08-02", endDate: "2026-08-31", provenance: "operator_asserted" },
        sourceAsOf: { value: "2026-09-01T00:00:00.000Z", provenance: "operator_asserted" },
    });
  }
  await official.acceptBundle(identity(scope), bundleId, await official.bundle(identity(scope), bundleId));
}
