import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import type { CopilotDirectoryUser, CopilotReportResult } from "../services/copilotUsageGraph.js";
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
    licenses: [],
    servicePlans: [],
  };
}
