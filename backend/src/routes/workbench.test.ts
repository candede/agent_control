import { describe, expect, it } from "vitest";
import type { DataSyncRun, DataSyncSourceStatus } from "../types/dataSync.js";
import { dataSyncJobSummary, packageRefreshJobSummary, powerPlatformJobSummary } from "./workbench.js";

const source = (overrides: Partial<DataSyncSourceStatus> = {}): DataSyncSourceStatus => ({
  source: "users", status: "succeeded", jobId: null, count: 0,
  lastSuccessAt: "2026-09-15T08:00:00.000Z", updatedAt: "2026-09-15T08:00:00.000Z",
  message: "No licensed users found.", canRetry: false, ...overrides,
});
const run = (overrides: Partial<DataSyncRun> = {}): DataSyncRun => ({
  id: "sync-1", mode: "initial", status: "waiting", startedAt: "2026-09-15T08:00:00.000Z",
  updatedAt: "2026-09-15T08:00:00.000Z", completedAt: null,
  sources: [source(), source({ source: "usage_reports", status: "awaiting_upload", count: null, lastSuccessAt: null })],
  ...overrides,
});

describe("sync jobs projection", () => {
  it("counts successful zero-row sources and keeps a manual upload incomplete", () => {
    expect(dataSyncJobSummary(run())).toMatchObject({
      source: "data-sync", total: 2, completed: 1, status: "waiting",
      target: "Users, Usage reports", syncSources: ["users", "usage_reports"],
      startedAt: "2026-09-15T08:00:00.000Z",
      canCancel: true, canResume: false, href: "/sync?syncRun=sync-1",
    });
    expect(dataSyncJobSummary(run())).not.toHaveProperty("completedAt");
  });

  it("reports partial source failures and exposes only explicit retry", () => {
    expect(dataSyncJobSummary(run({
      status: "partial",
      sources: [source(), source({ source: "power_platform", status: "permission_required", canRetry: true })],
    }))).toMatchObject({ partial: true, canResume: true, canReconcile: false, completed: 1 });
  });

  it("does not offer cancellation for a completed full resync", () => {
    expect(dataSyncJobSummary(run({
      mode: "full", status: "completed", sources: [source()], completedAt: "2026-09-15T08:05:00.000Z",
    }))).toMatchObject({
      label: "Full data resync", completed: 1, total: 1, canCancel: false,
      target: "Users", syncSources: ["users"], completedAt: "2026-09-15T08:05:00.000Z",
    });
  });

  it("names every requested automatic source without adding manual uploads to the scope", () => {
    expect(dataSyncJobSummary(run({
      sources: [source(), source({ source: "graph_packages" }), source({ source: "power_platform" })],
    }))).toMatchObject({
      target: "Users, Graph packages, Power Platform",
      syncSources: ["users", "graph_packages", "power_platform"],
    });
  });
});

describe("read-source job projection", () => {
  const dates = {
    createdAt: "2026-09-15T08:00:00.000Z",
    attemptedAt: "2026-09-15T08:01:00.000Z",
    updatedAt: "2026-09-15T08:05:00.000Z",
    finishedAt: "2026-09-15T08:05:00.000Z",
  };
  const packageJob: Parameters<typeof packageRefreshJobSummary>[0] = {
    id: "package-1", authorizationPrincipalId: "viewer", tokenMode: "delegated", scopeKind: "broad",
    requestedIds: [], status: "succeeded", pageCount: 2, observedCount: 25, totalRecords: 25, snapshotId: "snapshot-1",
    ...dates,
  };
  const inventoryJob: Parameters<typeof powerPlatformJobSummary>[0] = {
    id: "inventory-1", status: "succeeded", roleScope: "full", environmentScope: null, requestedTypes: [],
    pageCount: 2, observedCount: 25, totalRecords: 25, unknownFieldCount: 0, snapshotId: "snapshot-2",
    ...dates,
  };

  it("uses stored provider-attempt and completion dates rather than treating admission as execution", () => {
    for (const summary of [packageRefreshJobSummary(packageJob), powerPlatformJobSummary(inventoryJob)]) {
      expect(summary).toMatchObject({
        startedAt: dates.attemptedAt, completedAt: dates.finishedAt,
        canResume: false, canCancel: false, canReconcile: false,
      });
      expect(summary).not.toHaveProperty("syncSources");
    }
  });

  it("omits unknown dates and preserves waiting-authorization recovery actions", () => {
    const waiting = { status: "waiting_authorization" as const, attemptedAt: null, finishedAt: null };
    for (const summary of [
      packageRefreshJobSummary({ ...packageJob, ...waiting }),
      powerPlatformJobSummary({ ...inventoryJob, ...waiting }),
    ]) {
      expect(summary).not.toHaveProperty("startedAt");
      expect(summary).not.toHaveProperty("completedAt");
      expect(summary).toMatchObject({ canResume: true, canCancel: true, canReconcile: false });
    }
  });

  it("keeps observed progress distinct from known provider targets", () => {
    const running = { status: "running" as const, observedCount: 7, totalRecords: 120, finishedAt: null };
    for (const summary of [
      packageRefreshJobSummary({ ...packageJob, ...running }),
      powerPlatformJobSummary({ ...inventoryJob, ...running }),
    ]) {
      expect(summary).toMatchObject({ completed: 7, total: 120, startedAt: dates.attemptedAt, canCancel: true, canResume: false });
      expect(summary).not.toHaveProperty("completedAt");
    }
  });
});
