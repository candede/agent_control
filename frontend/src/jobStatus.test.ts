import { describe, it, expect } from "vitest";
import { isJobPolling, jobStatusMessage } from "./jobStatus";

describe("durable job status cutover", () => {
  it("polls only queued and running jobs", () => {
    expect(isJobPolling("queued")).toBe(true);
    expect(isJobPolling("running")).toBe(true);
    for (const status of ["waiting_authorization","succeeded","failed","cancelled","partial"] as const) expect(isJobPolling(status)).toBe(false);
  });
  it("keeps authorization and uncertain outcomes distinct from success", () => {
    expect(jobStatusMessage("waiting_authorization")).toContain("explicit resume");
    expect(jobStatusMessage("partial")).toContain("reconciliation");
    expect(jobStatusMessage("succeeded")).toBeUndefined();
  });
});