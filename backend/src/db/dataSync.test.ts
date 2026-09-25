import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import type { CopilotDirectoryUser, CopilotReportResult } from "../services/copilotUsageGraph.js";
import { copilotServicePlanDefinitions, resolveCopilotServicePlan } from "../services/copilotServicePlans.js";
import { DataSyncRepository } from "./dataSync.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: DataSyncRepository;
const scope = { tenantId: "tenant-data-sync", principalId: "viewer-a" };

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new DataSyncRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });

describe.sequential("Data sync repository", () => {
  it("distinguishes an empty database from a successful zero-row sync", async () => {
    expect(await repository.getLatestRun(scope)).toBeUndefined();
    expect(await repository.listMarkers(scope)).toEqual([
      expect.objectContaining({ source: "users", status: "not_started", count: null }),
      expect.objectContaining({ source: "graph_packages", status: "not_started", count: null }),
      expect.objectContaining({ source: "power_platform", status: "not_started", count: null }),
      expect.objectContaining({ source: "usage_reports", status: "not_started", count: null }),
    ]);
  });

  it("creates one durable onboarding run and deduplicates concurrent equivalent starts", async () => {
    const [left, right] = await Promise.all([
      repository.submit(scope, { mode: "initial" }),
      repository.submit(scope, { mode: "initial" }),
    ]);
    expect(left.run.id).toBe(right.run.id);
    expect([left.created, right.created].sort()).toEqual([false, true]);
    expect(left.run.sources.map(source => source.source)).toEqual([
      "graph_packages", "power_platform", "users",
    ]);
    await expect(repository.submit(scope, { mode: "full" })).rejects.toMatchObject({ code: "data_sync_active" });
    expect(await repository.listRuns(scope, 1)).toEqual([
      expect.objectContaining({ id: left.run.id, sources: expect.any(Array) }),
    ]);
    expect(await repository.listRuns({ ...scope, principalId: "viewer-b" }, 50)).toEqual([]);
    await expect(repository.listRuns(scope, 51)).rejects.toMatchObject({ code: "invalid_data_sync_limit" });
  });

  it.each(["initial", "incremental", "full"] as const)("defaults %s to automatic sources and respects explicit narrower requests", async mode => {
    const owner = { ...scope, principalId: `default-${mode}` };
    const { run } = await repository.submit(owner, { mode });
    expect(run.sources.map(source => source.source)).toEqual(["graph_packages", "power_platform", "users"]);
    expect(run.sources.every(source => source.count === null)).toBe(true);
    for (const source of run.sources) await repository.updateSource(owner, run.id, source.source, {
      status: "succeeded", count: 0, message: "Saved a valid zero-row source.", canRetry: false,
    });
    expect((await repository.getRun(owner, run.id))?.status).toBe("completed");
    const usersOnly = await repository.submit(owner, { mode, sources: ["users"] });
    expect(usersOnly.run.sources).toEqual([expect.objectContaining({
      source: "users", status: "queued", count: null, lastSuccessAt: expect.any(String),
    })]);
    await repository.cancel(owner, usersOnly.run.id);
  });

  it("keeps explicit legacy four-source runs waiting for manual usage and accepts a complete zero-row bundle", async () => {
    const owner = { ...scope, principalId: "manual-usage" };
    const { run } = await repository.submit(owner, {
      mode: "full", sources: ["users", "graph_packages", "power_platform", "usage_reports"],
    });
    for (const source of run.sources) await repository.updateSource(owner, run.id, source.source, source.source === "usage_reports"
      ? { status: "awaiting_upload", count: null, message: "Waiting for official reports.", canRetry: false }
      : { status: "succeeded", count: 0, message: "Saved a valid zero-row source.", canRetry: false });
    const retained = new DataSyncRepository(fixture.runtime);
    expect(await retained.getRun(owner, run.id)).toMatchObject({ status: "waiting", sources: expect.any(Array) });
    await retained.updateSource(owner, run.id, "usage_reports", {
      status: "succeeded", count: 0, message: "Accepted a complete zero-row usage bundle.", canRetry: false,
    });
    expect((await retained.getRun(owner, run.id))?.status).toBe("completed");
    expect((await retained.listMarkers(owner)).every(marker => marker.status === "succeeded" && marker.count === 0)).toBe(true);
  });

  it("starts new and retried counts unknown, preserves completed sources and markers, and fences old progress", async () => {
    const owner = { ...scope, principalId: "observed-counts" };
    await repository.recordSuccessMarker(owner, "users", 40, "2026-09-15T10:00:00.000Z");
    await repository.recordSuccessMarker(owner, "graph_packages", 120, "2026-09-15T10:00:00.000Z");
    const { run } = await repository.submit(owner, { mode: "incremental", sources: ["users", "graph_packages"] });
    expect(run.sources.every(source => source.count === null)).toBe(true);
    await repository.updateSource(owner, run.id, "graph_packages", {
      status: "succeeded", count: 130, message: "Saved a complete package snapshot.", canRetry: false,
    });
    const completed = (await repository.getRun(owner, run.id))!.sources.find(source => source.source === "graph_packages")!;
    const previousJobId = randomUUID();
    await repository.attachJob(owner, run.id, "users", previousJobId);
    await repository.updateSource(owner, run.id, "users", {
      status: "running", jobId: previousJobId, count: 5, message: "Read five distinct licensed users.", canRetry: false,
    });
    await repository.updateSource(owner, run.id, "users", {
      status: "failed", jobId: previousJobId, message: "A later directory page failed.", canRetry: true,
    });
    expect((await repository.getRun(owner, run.id))?.sources.find(source => source.source === "users"))
      .toMatchObject({ status: "failed", count: 5 });
    expect((await repository.listMarkers(owner)).find(source => source.source === "users"))
      .toMatchObject({ status: "succeeded", count: 40 });

    await repository.retry(owner, run.id, ["users"]);
    await repository.updateSource(owner, run.id, "users", {
      status: "running", jobId: previousJobId, count: 99, message: "Late progress from the old attempt.", canRetry: false,
    });
    const retry = (await repository.getRun(owner, run.id))!;
    expect(retry.sources.find(source => source.source === "users")).toMatchObject({ status: "queued", count: null, jobId: null });
    expect(retry.sources.find(source => source.source === "graph_packages")).toEqual(completed);
    const newJobId = randomUUID();
    await repository.attachJob(owner, run.id, "users", newJobId);
    await repository.updateSource(owner, run.id, "users", {
      status: "running", jobId: newJobId, count: 2, message: "Read two distinct licensed users.", canRetry: false,
    });
    const cancelled = await repository.cancel(owner, run.id);
    expect(cancelled.sources.find(source => source.source === "users")).toMatchObject({ status: "cancelled", count: 2 });
    expect(cancelled.sources.find(source => source.source === "graph_packages")).toEqual(completed);
    expect((await repository.listMarkers(owner)).filter(source => ["users", "graph_packages"].includes(source.source))).toEqual([
      expect.objectContaining({ source: "users", status: "succeeded", count: 40 }),
      expect.objectContaining({ source: "graph_packages", status: "succeeded", count: 130 }),
    ]);
    const next = await repository.submit(owner, { mode: "incremental", sources: ["users"] });
    await repository.updateSource(owner, next.run.id, "users", { status: "failed", message: "Failed before the first page.", canRetry: true });
    expect((await repository.getRun(owner, next.run.id))?.sources[0]).toMatchObject({ status: "failed", count: null });
    expect((await repository.listMarkers(owner))[0]).toMatchObject({ status: "succeeded", count: 40 });
  });

  it("uses persisted success markers so a successful zero-row source is not first-use again", async () => {
    const run = (await repository.getLatestRun(scope))!;
    await repository.updateSource(scope, run.id, "users", {
      status: "succeeded", count: 0, message: "Saved zero licensed users.", canRetry: false,
    });
    const marker = (await repository.listMarkers(scope)).find(source => source.source === "users");
    expect(marker).toMatchObject({ status: "succeeded", count: 0 });
  });

  it("reconciles usage marker changes without changing its saved timestamp on every state read", async () => {
    const owner = { ...scope, principalId: "usage-marker" };
    const acceptedAt = "2026-09-15T10:00:00.000Z";
    await repository.recordSuccessMarker(owner, "usage_reports", 0, acceptedAt);
    const before = (await repository.listMarkers(owner))[3];
    expect(before).toMatchObject({ status: "succeeded", count: 0, lastSuccessAt: acceptedAt });
    await repository.recordSuccessMarker(owner, "usage_reports", 0, acceptedAt);
    expect((await repository.listMarkers(owner))[3]).toEqual(before);
    await repository.recordSuccessMarker(owner, "usage_reports", 4, acceptedAt);
    expect((await repository.listMarkers(owner))[3]).toMatchObject({ status: "succeeded", count: 4, lastSuccessAt: acceptedAt });
  });

  it("keeps run and saved user data private to the tenant and principal", async () => {
    expect(await repository.getRun({ ...scope, principalId: "viewer-b" }, (await repository.getLatestRun(scope))!.id)).toBeUndefined();
    await repository.publishDirectory(scope, [directoryUser("saved@example.com")], "2026-09-15T10:00:00.000Z", "Saved one record.");
    expect((await repository.getUserSources(scope)).directory.value).toHaveLength(1);
    expect((await repository.getUserSources({ ...scope, principalId: "viewer-b" })).directory.value).toBeNull();
    expect((await repository.getUserSources({ tenantId: "other-tenant", principalId: scope.principalId })).directory.value).toBeNull();
  });

  it("preserves the last good normalized snapshots when a later source attempt fails", async () => {
    const report: CopilotReportResult = { users: [], reportRefreshDate: null };
    await repository.publishAppActivity(scope, report, "2026-09-15T10:01:00.000Z", "Saved empty activity report.");
    await repository.recordUserSourceFailure(scope, "directory", "permission_required", "Directory permission was denied.", "2026-09-15T10:02:00.000Z");
    const saved = await repository.getUserSources(scope);
    expect(saved.directory).toMatchObject({
      attemptStatus: "permission_required",
      rowCount: 1,
      value: [{ identity: { userPrincipalName: "saved@example.com" } }],
    });
    expect(saved.appActivity).toMatchObject({ attemptStatus: "available", rowCount: 0, value: report });
  });

  it("withholds expired user snapshots even when the last attempt succeeded", async () => {
    const owner = { ...scope, principalId: "expired-user-sources" };
    const observedAt = new Date().toISOString();
    const directoryId = await repository.publishDirectory(owner, [], observedAt, "Saved an empty directory.");
    const reportId = await repository.publishAppActivity(owner, { users: [], reportRefreshDate: null }, observedAt, "Saved an empty report.");
    await fixture.operator.query(`UPDATE copilot_usage_snapshots SET expires_at=clock_timestamp()-interval '1 second'
      WHERE id=ANY($1::uuid[])`, [[directoryId, reportId]]);

    const saved = await repository.getUserSources(owner);
    for (const source of [saved.directory, saved.appActivity]) {
      expect(source).toMatchObject({
        attemptStatus: "available", lastSuccessAt: observedAt, rowCount: 0, value: null, observedAt: null,
      });
    }
  });

  it("persists company and department in the licensed-user snapshot across repository instances", async () => {
    const owner = { ...scope, principalId: "organization-reader" };
    const user = directoryUser("organization@example.invalid");
    user.identity.companyName = "Example Health";
    user.identity.department = "Clinical Services";
    await repository.publishDirectory(owner, [user], new Date().toISOString(), "Saved organization metadata.");
    expect(await new DataSyncRepository(fixture.runtime).getDirectorySource(owner)).toMatchObject({
      rowCount: 1, value: [{ identity: {
        userPrincipalName: "organization@example.invalid", companyName: "Example Health", department: "Clinical Services",
      } }],
    });
    expect((await repository.getDirectorySource({ ...owner, principalId: "other-reader" })).value).toBeNull();
  });

  it("persists and reloads all 30,001 paid-license users with all three paid features within the snapshot byte bound", async () => {
    const owner = { ...scope, principalId: "large-paid-license-roster" };
    const servicePlans = [...copilotServicePlanDefinitions.keys()].map(servicePlanId => resolveCopilotServicePlan(
      servicePlanId, true, [{ servicePlanId, assignedDateTime: "2026-01-01T00:00:00Z", capabilityStatus: "Enabled" }],
    ));
    const users = Array.from({ length: 30_001 }, (_, index) => {
      const user = directoryUser(`person${index}@example.com`);
      user.identity.displayName = `Person ${index}`;
      user.identity.companyName = "Contoso Health";
      user.copilotServiceState = "enabled";
      user.servicePlans = servicePlans;
      return user;
    });
    const original = JSON.stringify({ serviceEvidenceVersion: 1, users });
    const bytes = Buffer.byteLength(original);
    expect(bytes).toBeGreaterThan(30 * 1024 * 1024);
    expect(bytes).toBeLessThan(32 * 1024 * 1024);
    const unencoded = await fixture.runtime.query<{ bytes: number }>(
      "SELECT octet_length($1::jsonb::text) AS bytes", [original],
    );
    expect(unencoded.rows[0].bytes).toBeGreaterThan(32 * 1024 * 1024);
    await repository.publishDirectory(owner, users, new Date().toISOString(), "Saved all matching paid-license users.");

    const saved = await new DataSyncRepository(fixture.runtime).getDirectorySource(owner);
    expect(saved).toMatchObject({ attemptStatus: "available", rowCount: 30_001 });
    expect(saved.value).toHaveLength(30_001);
    expect(saved.value).toEqual(users);
    expect(saved.value?.at(-1)).toEqual(users.at(-1));
    expect(saved.value?.every(user => user.servicePlans.length === 3)).toBe(true);
    const storage = await fixture.runtime.query<{ bytes: number }>(`SELECT octet_length(snapshot_data::text) AS bytes
      FROM copilot_usage_snapshots WHERE tenant_id=$1 AND principal_id=$2 AND source_id='directory' AND is_current`,
    [owner.tenantId, owner.principalId]);
    expect(storage.rows[0].bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  }, 30_000);

  it("losslessly reloads distinct service-plan sets without sharing mutable feature evidence between users", async () => {
    const owner = { ...scope, principalId: "mixed-paid-license-roster" };
    const enabled = [...copilotServicePlanDefinitions.keys()].map(servicePlanId => resolveCopilotServicePlan(
      servicePlanId, true, [{ servicePlanId, assignedDateTime: "2026-01-01T00:00:00Z", capabilityStatus: "Enabled" }],
    ));
    const changed = enabled.toReversed().map((plan, index) => ({
      ...plan,
      state: index === 0 ? "disabled" as const : "unknown" as const,
      assignedDateTime: index === 0 ? "2026-02-02T12:34:56Z" : null,
      capabilityStatus: index === 0 ? "Deleted" as const : null,
    }));
    const sets = [enabled, changed, [], enabled, changed, enabled.slice(1)];
    const users = sets.map((servicePlans, index) => ({
      ...directoryUser(`person${index}@example.com`), servicePlans,
    }));
    await repository.publishDirectory(owner, users, new Date().toISOString(), "Saved complete mixed service evidence.");
    const storage = await fixture.runtime.query<{ encoding: string }>(`
      SELECT snapshot_data->>'storageEncoding' AS encoding FROM copilot_usage_snapshots
      WHERE tenant_id=$1 AND principal_id=$2 AND source_id='directory' AND is_current`,
    [owner.tenantId, owner.principalId]);
    expect(storage.rows[0].encoding).toBe("service-plan-sets-v1");
    const saved = await new DataSyncRepository(fixture.runtime).getUserSources(owner);
    expect(saved.directory.value).toEqual(users);
    expect(saved.directory.value![0].servicePlans).not.toBe(saved.directory.value![3].servicePlans);
    expect(saved.directory.value![0].servicePlans[0]).not.toBe(saved.directory.value![3].servicePlans[0]);
  });

  it("reads an existing unencoded service-evidence-v1 snapshot without migration or refresh", async () => {
    const owner = { ...scope, principalId: "legacy-service-evidence-reader" };
    const user = directoryUser("legacy@example.invalid");
    user.servicePlans = [...copilotServicePlanDefinitions.keys()].map(servicePlanId => resolveCopilotServicePlan(
      servicePlanId, true, [{ servicePlanId, assignedDateTime: "2026-01-01T00:00:00Z", capabilityStatus: "Enabled" }],
    ));
    const observedAt = new Date().toISOString();
    await fixture.runtime.query(`WITH saved AS (
      INSERT INTO copilot_usage_snapshots(id,tenant_id,principal_id,source_id,snapshot_data,row_count,observed_at)
      VALUES($1,$2,$3,'directory',$4::jsonb,1,$5)
      RETURNING id,tenant_id,principal_id,source_id,observed_at,row_count)
      INSERT INTO copilot_usage_source_state(
        tenant_id,principal_id,source_id,attempt_status,message,attempted_at,last_success_at,row_count,current_snapshot_id)
      SELECT tenant_id,principal_id,source_id,'available','Previously saved service evidence.',
        observed_at,observed_at,row_count,id FROM saved`,
    [randomUUID(), owner.tenantId, owner.principalId, JSON.stringify({ serviceEvidenceVersion: 1, users: [user] }), observedAt]);
    const reader = new DataSyncRepository(fixture.runtime);
    expect(await reader.getDirectorySource(owner)).toMatchObject({
      attemptStatus: "available", rowCount: 1, observedAt, value: [user],
    });
    expect((await reader.getUserSources(owner)).directory.value).toEqual([user]);
  });

  it.each(["directory", "app_activity"] as const)(
    "enforces the actual JSONB UTF-8 byte boundary for %s and rolls back an oversized replacement",
    async source => {
      const owner = { ...scope, principalId: `snapshot-byte-bound-${source}` };
      const user = directoryUser("byte-bound@example.invalid");
      const report: CopilotReportResult = { users: [], reportRefreshDate: "" };
      user.identity.department = "";
      const payload = () => source === "directory" ? { serviceEvidenceVersion: 1, users: [user] } : report;
      const fixed = await fixture.runtime.query<{ bytes: number }>(
        "SELECT octet_length($1::jsonb::text) AS bytes", [JSON.stringify(payload())],
      );
      const remaining = 32 * 1024 * 1024 - fixed.rows[0].bytes;
      const text = "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
      if (source === "directory") user.identity.department = text;
      else report.reportRefreshDate = text;
      const observedAt = new Date().toISOString();
      const publish = () => source === "directory"
        ? repository.publishDirectory(owner, [user], observedAt, "Saved at the byte bound.")
        : repository.publishAppActivity(owner, report, observedAt, "Saved at the byte bound.");
      const id = await publish();
      const stored = await fixture.runtime.query<{ bytes: number }>(
        "SELECT octet_length(snapshot_data::text) AS bytes FROM copilot_usage_snapshots WHERE id=$1", [id],
      );
      expect(stored.rows[0].bytes).toBe(32 * 1024 * 1024);

      if (source === "directory") user.identity.department += "x";
      else report.reportRefreshDate += "x";
      expect(Buffer.byteLength(JSON.stringify(payload()))).toBeLessThanOrEqual(32 * 1024 * 1024);
      await expect(publish()).rejects.toMatchObject({ status: 413, code: "copilot_usage_snapshot_limit" });
      const retained = await fixture.runtime.query(`
        SELECT snapshot.id,state.current_snapshot_id,state.row_count,state.attempt_status
        FROM copilot_usage_snapshots snapshot JOIN copilot_usage_source_state state
          ON state.current_snapshot_id=snapshot.id
        WHERE snapshot.tenant_id=$1 AND snapshot.principal_id=$2 AND snapshot.source_id=$3 AND snapshot.is_current`,
      [owner.tenantId, owner.principalId, source]);
      expect(retained.rows).toEqual([{
        id, current_snapshot_id: id, row_count: source === "directory" ? 1 : 0, attempt_status: "available",
      }]);
    }, 30_000,
  );

  it("retries only incomplete top-level sources and retains every child association", async () => {
    const run = (await repository.getLatestRun(scope))!;
    await repository.updateSource(scope, run.id, "graph_packages", {
      status: "failed", message: "Provider failed.", canRetry: true,
    });
    await repository.updateSource(scope, run.id, "power_platform", {
      status: "succeeded", count: 0, message: "Saved zero resources.", canRetry: false,
    });
    await repository.updateSource(scope, run.id, "usage_reports", {
      status: "awaiting_upload", message: "requiresAdmin: upload three reports.", canRetry: false,
    });
    await expect(repository.retry(scope, run.id, ["power_platform"])).rejects.toMatchObject({ code: "data_sync_source_complete" });
    await expect(repository.retry(scope, run.id, ["usage_reports"])).rejects.toMatchObject({ code: "data_sync_source_complete" });
    expect(await repository.retry(scope, run.id, ["graph_packages"])).toEqual(["graph_packages"]);
    const firstJob = randomUUID();
    await repository.attachJob(scope, run.id, "graph_packages", firstJob);
    await repository.updateSource(scope, run.id, "graph_packages", {
      status: "failed", jobId: firstJob, message: "Failed again.", canRetry: true,
    });
    expect(await repository.retry(scope, run.id, ["graph_packages"])).toEqual(["graph_packages"]);
    const secondJob = randomUUID();
    await repository.attachJob(scope, run.id, "graph_packages", secondJob);
    const associations = await fixture.runtime.query<{ job_id: string }>(
      "SELECT job_id FROM data_sync_source_jobs WHERE run_id=$1 ORDER BY attempt",
      [run.id],
    );
    expect(associations.rows.map(row => row.job_id)).toEqual([firstJob, secondJob]);
  });

  it("pauses provider work on sign-out/restart and cancels without erasing successful sources", async () => {
    const run = (await repository.getLatestRun(scope))!;
    await repository.updateSource(scope, run.id, "graph_packages", {
      status: "running", message: "Reading packages.", canRetry: false,
    });
    expect(await repository.pausePrincipal(scope)).toBe(1);
    expect((await repository.getRun(scope, run.id))?.sources.find(source => source.source === "graph_packages"))
      .toMatchObject({ status: "waiting_authorization", canRetry: true });
    const cancelled = await repository.cancel(scope, run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.sources.find(source => source.source === "power_platform")?.status).toBe("succeeded");

    const restartScope = { tenantId: scope.tenantId, principalId: "restart-viewer" };
    const restarted = await repository.submit(restartScope, { mode: "incremental", sources: ["users"] });
    expect(await repository.recoverInterrupted()).toBeGreaterThanOrEqual(1);
    expect((await repository.getRun(restartScope, restarted.run.id))?.sources[0]).toMatchObject({
      status: "waiting_authorization",
      canRetry: true,
    });
  });

  it("keeps a historical retry current through completion without reordering retained history", async () => {
    const retryScope = { ...scope, principalId: "historical-retry-viewer" };
    const older = await repository.submit(retryScope, { mode: "incremental", sources: ["users"] });
    await repository.updateSource(retryScope, older.run.id, "users", {
      status: "failed", message: "Retry required.", canRetry: true,
    });
    const newer = await repository.submit(retryScope, { mode: "incremental", sources: ["users"] });
    await repository.updateSource(retryScope, newer.run.id, "users", {
      status: "succeeded", count: 0, message: "Saved zero users.", canRetry: false,
    });
    expect((await repository.getLatestRun(retryScope))?.id).toBe(newer.run.id);

    await repository.retry(retryScope, older.run.id, ["users"]);
    expect(await repository.getLatestRun(retryScope)).toMatchObject({ id: older.run.id, status: "running" });
    await repository.updateSource(retryScope, older.run.id, "users", {
      status: "succeeded", count: 0, message: "Retry completed with zero users.", canRetry: false,
    });
    expect(await repository.getLatestRun(retryScope)).toMatchObject({ id: older.run.id, status: "completed" });
    expect((await repository.listRuns(retryScope)).map(run => run.id)).toEqual([newer.run.id, older.run.id]);
  });
});

function directoryUser(userPrincipalName: string): CopilotDirectoryUser {
  return {
    identity: {
      objectId: randomUUID(),
      userPrincipalName,
      displayName: "Saved User",
      accountEnabled: true,
      userType: "Member",
      employeeType: "Employee",
      department: "Engineering",
      companyName: null,
    },
    serviceEvidenceVersion: 1,
    copilotServiceState: "unknown",
    servicePlans: [],
  };
}
