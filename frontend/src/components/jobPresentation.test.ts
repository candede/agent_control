import { describe, expect, it } from "vitest";
import type { WorkbenchJobSummary } from "../api/client";
import { formatJobInstant, jobDuration, jobResultCount, jobStatusLabel } from "./jobPresentation";

const base: WorkbenchJobSummary = {
  id: "job-1", source: "data-sync", label: "Sync", target: "3 sources",
  status: "completed", total: 3, completed: 3, partial: false,
  createdAt: "2026-09-10T09:00:00.000Z", startedAt: "2026-09-10T09:01:00.000Z",
  completedAt: "2026-09-10T09:02:05.000Z", updatedAt: "2026-09-20T09:00:00.000Z", href: "/sync",
};

describe("sync job presentation", () => {
  it.each([
    ["running", "Syncing"],
    ["waiting", "Action required"],
    ["waiting_authorization", "Sign-in required"],
    ["succeeded", "Complete"],
  ])("keeps the current Sync label for %s", (status, expected) => {
    expect(jobStatusLabel({ ...base, status })).toBe(expected);
  });

  it.each([
    ["provider_pending", "provider pending"],
    ["constructor", "constructor"],
    ["toString", "toString"],
    ["hasOwnProperty", "hasOwnProperty"],
    ["__proto__", "  proto  "],
  ])("renders unknown status %s as text, not an inherited property", (status, expected) => {
    expect(jobStatusLabel({ ...base, status })).toBe(expected);
  });

  it("does not treat full progress or partial success as complete", () => {
    expect(jobStatusLabel({ ...base, status: "failed" })).toBe("Failed");
    expect(jobStatusLabel({ ...base, partial: true })).toBe("Complete with partial results");
    expect(jobResultCount({ ...base, completed: 0 })).toBe(0);
    expect(jobResultCount({ ...base, completed: null })).toBeUndefined();
  });

  it("requires genuine start and finish times without inventing completion", () => {
    expect(formatJobInstant("invalid")).toBe("Not recorded");
    expect(formatJobInstant(undefined)).toBe("Not recorded");
    expect(jobDuration(base)).toBe("1m 5s");
    expect(jobDuration({ ...base, startedAt: undefined })).toBe("Not recorded");
    expect(jobDuration({ ...base, completedAt: undefined })).toBe("Not recorded");
    expect(jobDuration({ ...base, completedAt: "2026-09-10T08:00:00.000Z" })).toBe("Not recorded");
  });
});
