import { describe, expect, it } from "vitest";
import {
  completeBulkActionJob,
  createBulkActionJob,
  createBulkAccessJob,
  failBulkActionJob,
  getBulkActionJob,
  recordBulkActionPackageResult,
  startBulkActionPackage,
} from "./bulkJobs.js";

describe("Bulk action jobs", () => {
  it("tracks package progress and final result", () => {
    const job = createBulkActionJob("owner-1", "block", true, 2);

    startBulkActionPackage(job.id, "First agent");
    recordBulkActionPackageResult(job.id, {
      id: "P_1",
      displayName: "First agent",
      status: "succeeded",
    });

    expect(getBulkActionJob(job.id, "owner-1")).toMatchObject({
      status: "running",
      completed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
      currentAgentName: "First agent",
    });

    completeBulkActionJob(job.id, {
      targetBlockedState: true,
      total: 2,
      succeeded: 1,
      failed: 0,
      skipped: 1,
      results: [
        { id: "P_1", displayName: "First agent", status: "succeeded" },
        { id: "P_2", displayName: "Second agent", status: "skipped" },
      ],
    });

    expect(getBulkActionJob(job.id, "owner-1")).toMatchObject({
      status: "completed",
      completed: 2,
      succeeded: 1,
      failed: 0,
      skipped: 1,
      currentAgentName: undefined,
      result: {
        targetBlockedState: true,
        total: 2,
      },
    });
  });

  it("creates an access job without block-specific state", () => {
    const accessUpdate = {
      target: "availability" as const,
      mode: "replace" as const,
      scope: "none" as const,
      principals: [],
    };
    const job = createBulkAccessJob(
      "owner-1",
      "update-availability",
      accessUpdate,
      3,
    );

    expect(job).toMatchObject({
      action: "update-availability",
      accessUpdate,
      total: 3,
      status: "queued",
    });
    expect(job).not.toHaveProperty("targetBlockedState");
  });

  it("does not double-count repeated package results", () => {
    const job = createBulkActionJob("owner-1", "block", true, 1);
    const result = {
      id: "P_1",
      displayName: "First agent",
      status: "succeeded" as const,
    };

    recordBulkActionPackageResult(job.id, result);
    recordBulkActionPackageResult(job.id, result);

    expect(getBulkActionJob(job.id, "owner-1")).toMatchObject({
      completed: 1,
      succeeded: 1,
      results: [result],
    });
  });

  it("does not expose jobs to another account", () => {
    const job = createBulkActionJob("owner-1", "block", true, 1);

    expect(getBulkActionJob(job.id, "owner-1")).toBe(job);
    expect(getBulkActionJob(job.id, "owner-2")).toBeUndefined();
  });

  it("does not overwrite a terminal job", () => {
    const job = createBulkActionJob("owner-1", "block", true, 1);

    failBulkActionJob(job.id, new Error("catalog unavailable"));
    completeBulkActionJob(job.id, {
      targetBlockedState: true,
      total: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
      results: [{ id: "P_1", displayName: "First agent", status: "succeeded" }],
    });

    expect(getBulkActionJob(job.id, "owner-1")).toMatchObject({
      status: "failed",
      error: "catalog unavailable",
    });
  });
});
