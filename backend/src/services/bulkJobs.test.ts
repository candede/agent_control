import { describe, expect, it } from "vitest";
import {
  completeBulkActionJob,
  createBulkActionJob,
  getBulkActionJob,
  recordBulkActionPackageResult,
  startBulkActionPackage,
} from "./bulkJobs.js";

describe("Bulk action jobs", () => {
  it("tracks package progress and final result", () => {
    const job = createBulkActionJob("block", true, 2);

    startBulkActionPackage(job.id, "First agent");
    recordBulkActionPackageResult(job.id, {
      id: "P_1",
      displayName: "First agent",
      status: "succeeded",
    });

    expect(getBulkActionJob(job.id)).toMatchObject({
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

    expect(getBulkActionJob(job.id)).toMatchObject({
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
});
