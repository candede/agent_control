import { describe, expect, it } from "vitest";
import type { DataSyncRun, DataSyncSourceStatus } from "../types/dataSync.js";
import { dataSyncJobSummary } from "./workbench.js";

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
      canCancel: true, canResume: false, href: "/sync?syncRun=sync-1",
    });
  });

  it("reports partial source failures and exposes only explicit retry", () => {
    expect(dataSyncJobSummary(run({
      status: "partial",
      sources: [source(), source({ source: "power_platform", status: "permission_required", canRetry: true })],
    }))).toMatchObject({ partial: true, canResume: true, canReconcile: false, completed: 1 });
  });

  it("does not offer cancellation for a completed full resync", () => {
    expect(dataSyncJobSummary(run({ mode: "full", status: "completed", sources: [source()] }))).toMatchObject({
      label: "Full data resync", completed: 1, total: 1, canCancel: false,
    });
  });
});
