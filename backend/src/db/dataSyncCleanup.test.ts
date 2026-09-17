import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { parseOfficialUsageReport } from "../services/officialUsageParser.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import type { StartDataSyncInput } from "../types/dataSync.js";
import { powerPlatformResourceTypes, type PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { DataSyncRepository, type DataSyncScope } from "./dataSync.js";
import { createJobConfirmation, JobRepository, type JobIntentInput } from "./jobs.js";
import { OfficialUsageRepository } from "./officialUsage.js";
import { PackageInventoryRepository } from "./packageInventory.js";
import { PowerPlatformInventoryRepository } from "./powerPlatformInventory.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: DataSyncRepository;
let packages: PackageInventoryRepository;
let inventory: PowerPlatformInventoryRepository;

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new DataSyncRepository(fixture.runtime);
  packages = new PackageInventoryRepository(fixture.runtime);
  inventory = new PowerPlatformInventoryRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });

const cleanInput = { mode: "full", clearSavedData: true } as const;
const now = () => new Date().toISOString();
const newScope = (): DataSyncScope => ({ tenantId: `tenant-${randomUUID()}`, principalId: `viewer-${randomUUID()}` });

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
      "package_refresh_jobs", "power_platform_refresh_jobs", "source_identifiers", "capability_configuration",
      "capability_evidence", "package_mutation_qualifications", "copilot_quarantine_status_observations",
      "copilot_quarantine_jobs", "copilot_quarantine_audit", "operational_state",
    ];
    const preserved = await tableRows(preservedTables);
    const result = await repository.submit(scope, cleanInput);
    expect(result.created).toBe(true);
    expect(result.run.sources.filter(source => source.source !== "usage_reports")).toEqual([
      expect.objectContaining({ source: "graph_packages", count: null, lastSuccessAt: null }),
      expect.objectContaining({ source: "power_platform", count: null, lastSuccessAt: null }),
      expect.objectContaining({ source: "users", count: null, lastSuccessAt: null }),
    ]);
    expect(await scopedSnapshots(scope)).toEqual({
      copilot_usage_snapshots: [], copilot_usage_source_state: [],
      package_inventory_snapshots: [], package_inventory_resources: [],
      power_platform_inventory_snapshots: [], power_platform_inventory_resources: [],
    });
    expect(await repository.listMarkers(scope)).toEqual([
      expect.objectContaining({ source: "users", status: "not_started", count: null }),
      expect.objectContaining({ source: "graph_packages", status: "not_started", count: null }),
      expect.objectContaining({ source: "power_platform", status: "not_started", count: null }),
      expect.objectContaining({ source: "usage_reports", status: "succeeded", count: 3 }),
    ]);
    expect(await tableRows(preservedTables)).toEqual(preserved);
    expect(await Promise.all([scopedSnapshots(otherPrincipal), scopedSnapshots(otherTenant)])).toEqual(othersBefore);
    expect(await packages.readUnifiedSource(scope)).toMatchObject({ packages: [], snapshot: null, observations: {} });
    expect(await inventory.list(scope)).toMatchObject({ value: [], snapshot: null });
    expect((await repository.getUserSources(scope)).directory).toMatchObject({ value: null, rowCount: null, lastSuccessAt: null });
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
    await repository.publishDirectory(scope, [], now(), "Replacement saved zero users.");
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
      code: provider === "packages" ? "package_refresh_state" : "inventory_job_state",
    });
    expect((await (provider === "packages" ? packages : inventory).list(scope)).snapshot).toBeNull();
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
      expect((await (provider === "packages" ? packages : inventory).list(scope)).snapshot).not.toBeNull();
      await repository.submit(scope, cleanInput);
    }
    expect((await (provider === "packages" ? packages : inventory).list(scope)).snapshot).toBeNull();
  });

  it("fences stopped user attempts and keeps failed replacement data missing instead of stale or zero", async () => {
    const scope = newScope();
    const old = await repository.submit(scope, { mode: "incremental", sources: ["users"] });
    const publication = { runId: old.run.id, jobId: randomUUID() };
    await repository.attachJob(scope, old.run.id, "users", publication.jobId);
    await repository.updateSource(scope, old.run.id, "users", {
      status: "running", jobId: publication.jobId, message: "Reading old user sources.", canRetry: false,
    });
    await repository.publishDirectory(scope, [], now(), "Previously successful empty directory.", publication);
    await repository.cancel(scope, old.run.id);
    const clean = await repository.submit(scope, cleanInput);
    await expect(repository.publishDirectory(scope, [], now(), "Late old directory.", publication))
      .rejects.toMatchObject({ code: "data_sync_publication_superseded" });
    await expect(repository.publishAppActivity(scope, { users: [], reportRefreshDate: null }, now(), "Late old report.", publication))
      .rejects.toMatchObject({ code: "data_sync_publication_superseded" });
    await expect(repository.recordUserSourceFailure(scope, "directory", "failed", "Late old error.", now(), publication))
      .rejects.toMatchObject({ code: "data_sync_publication_superseded" });
    await repository.updateSource(scope, old.run.id, "users", {
      status: "succeeded", jobId: publication.jobId, count: 0, message: "Late worker completion.", canRetry: false,
    });
    const failedPublication = { runId: clean.run.id, jobId: randomUUID() };
    await repository.attachJob(scope, clean.run.id, "users", failedPublication.jobId);
    await repository.updateSource(scope, clean.run.id, "users", {
      status: "running", jobId: failedPublication.jobId, message: "Reading replacement.", canRetry: false,
    });
    await repository.recordUserSourceFailure(scope, "directory", "permission_required", "Directory permission required.", now(), failedPublication);
    await repository.updateSource(scope, clean.run.id, "users", {
      status: "failed", jobId: failedPublication.jobId, message: "Replacement failed.", canRetry: true,
    });
    expect((await repository.getUserSources(scope)).directory).toMatchObject({
      attemptStatus: "permission_required", value: null, rowCount: null, lastSuccessAt: null,
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
    await expect(repository.publishDirectory(scope, [], now(), "Late previous attempt.", failedPublication))
      .rejects.toMatchObject({ code: "data_sync_publication_superseded" });
    await repository.updateSource(scope, clean.run.id, "users", {
      status: "succeeded", jobId: failedPublication.jobId, count: 0, message: "Late previous attempt completion.", canRetry: false,
    });
    expect((await repository.getRun(scope, clean.run.id))?.sources.find(source => source.source === "users")?.status).toBe("running");
    await repository.publishDirectory(scope, [], now(), "New successful zero-row directory.", replacement);
    expect((await repository.getUserSources(scope)).directory).toMatchObject({ value: [], rowCount: 0 });
  });
});

async function seedSnapshots(scope: DataSyncScope) {
  await repository.publishDirectory(scope, [], now(), "Saved prior empty directory.");
  await repository.publishDirectory(scope, [], now(), "Saved latest empty directory.");
  await repository.publishAppActivity(scope, { users: [], reportRefreshDate: null }, now(), "Saved activity.");
  for (const requestedIds of [[], ["package"]]) {
    const job = await packages.submit(scope, {
      authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: randomUUID(), requestedIds,
    });
    await packages.markRunning(scope, job.id);
    await packages.publish(scope, job.id, {
      packages: [allowlistedPackage({ id: "package", displayName: "Fixture package", isBlocked: false })],
      totalRecords: 1, pages: 1,
    });
  }
  const job = await submitProvider(scope, "inventory");
  await inventory.markRunning(scope, job.id);
  await inventory.publish(scope, job.id, { resources: [resource(scope)], queriedTypes: [...powerPlatformResourceTypes], environmentScope: null, totalRecords: 1, pages: 1, unknownFieldCount: 0 });
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
    ? packages.publish(scope, jobId, { packages: [], totalRecords: 0, pages: 1 })
    : inventory.publish(scope, jobId, { resources: [], queriedTypes: [...powerPlatformResourceTypes], environmentScope: null, totalRecords: 0, pages: 1, unknownFieldCount: 0 });
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
  const tables = [
    "copilot_usage_snapshots", "copilot_usage_source_state", "package_inventory_snapshots", "package_inventory_resources",
    "power_platform_inventory_snapshots", "power_platform_inventory_resources",
  ];
  return Object.fromEntries(await Promise.all(tables.map(async table => [
    table,
    (await fixture.runtime.query(`SELECT to_jsonb(value) AS value FROM ${table} value
      WHERE tenant_id=$1 AND principal_id=$2 ORDER BY to_jsonb(value)::text`, [scope.tenantId, scope.principalId])).rows,
  ])));
}

async function tableRows(tables: string[]) {
  return Object.fromEntries(await Promise.all(tables.map(async table => [
    table, (await fixture.runtime.query(`SELECT to_jsonb(value) AS value FROM ${table} value ORDER BY to_jsonb(value)::text`)).rows,
  ])));
}

async function seedAcceptedUsage(scope: DataSyncScope) {
  const official = new OfficialUsageRepository(fixture.runtime);
  const bundleId = randomUUID();
  for (const content of [
    "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nagent,Agent,Your org,1,0,4,2026-08-15",
    "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\nagent,Agent,Your org,user@example.invalid,4,2026-08-15",
    "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\nuser@example.invalid,User,1,4,2026-08-15",
  ]) {
    await official.stage(scope, {
      report: parseOfficialUsageReport(Buffer.from(content), {
        reportingPeriod: { startDate: "2026-08-02", endDate: "2026-08-31", provenance: "operator_asserted" },
        sourceAsOf: { value: "2026-09-01T00:00:00.000Z", provenance: "operator_asserted" },
      }),
      fileHash: createHash("sha256").update(content).digest("hex"), bundleId,
    });
  }
  await official.acceptBundle(scope, bundleId, await official.previewBundle(scope, bundleId));
}
