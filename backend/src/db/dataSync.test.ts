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
      "graph_packages", "power_platform", "usage_reports", "users",
    ]);
    await expect(repository.submit(scope, { mode: "full" })).rejects.toMatchObject({ code: "data_sync_active" });
    expect(await repository.listRuns(scope, 1)).toEqual([
      expect.objectContaining({ id: left.run.id, sources: expect.any(Array) }),
    ]);
    expect(await repository.listRuns({ ...scope, principalId: "viewer-b" }, 50)).toEqual([]);
    await expect(repository.listRuns(scope, 51)).rejects.toMatchObject({ code: "invalid_data_sync_limit" });
  });

  it("uses persisted success markers so a successful zero-row source is not first-use again", async () => {
    const run = (await repository.getLatestRun(scope))!;
    await repository.updateSource(scope, run.id, "users", {
      status: "succeeded", count: 0, message: "Saved zero licensed users.", canRetry: false,
    });
    const marker = (await repository.listMarkers(scope)).find(source => source.source === "users");
    expect(marker).toMatchObject({ status: "succeeded", count: 0 });
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
    },
    licenses: [],
    servicePlans: [],
  };
}
