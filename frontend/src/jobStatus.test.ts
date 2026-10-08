// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { BulkJobStatus } from "./api/client";
import { isJobPolling, isKnownJobStatus, jobStatusMessage } from "./jobStatus";

describe("durable job status cutover", () => {
  const statuses = {
    queued: { polling: true, message: undefined },
    running: { polling: true, message: undefined },
    waiting_authorization: { polling: false, message: "explicit resume" },
    succeeded: { polling: false, message: undefined },
    failed: { polling: false, message: "failed" },
    cancelled: { polling: false, message: "Already dispatched changes may have finished" },
    partial: { polling: false, message: "reconciliation" },
  } satisfies Record<BulkJobStatus, { polling: boolean; message: string | undefined }>;

  it.each(Object.entries(statuses))("classifies %s without equating stopped polling with success", (status, expected) => {
    expect(isKnownJobStatus(status)).toBe(true);
    expect(isJobPolling(status)).toBe(expected.polling);
    if (expected.message === undefined) expect(jobStatusMessage(status)).toBeUndefined();
    else expect(jobStatusMessage(status)).toContain(expected.message);
  });

  it.each(["provider_pending", "completed", "constructor", "__proto__", "", null, undefined, 1])(
    "does not silently accept unsupported status %s",
    status => {
      expect(isKnownJobStatus(status)).toBe(false);
      expect(isJobPolling(status)).toBe(false);
      expect(jobStatusMessage(status)).toContain("unrecognized job status");
      expect(jobStatusMessage(status)).toContain("Refresh status");
    },
  );

  it("classifies a later observation independently of a previous terminal outcome", () => {
    expect(["queued", "running", "partial", "queued", "running", "succeeded"].map(isJobPolling))
      .toEqual([true, true, false, true, true, false]);
  });
});