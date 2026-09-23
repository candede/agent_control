import { describe, expect, it } from "vitest";
import {
  automaticDataSyncSourceIds,
  dataSyncSourceIds,
  type DataSyncMode,
  type DataSyncRun,
  type DataSyncSourceId,
  type DataSyncSourceState,
} from "../../../backend/src/types/dataSync";
import {
  automaticSyncSources,
  formatSyncInstant,
  syncDuration,
  syncModeLabel,
  syncSourceDetails,
  syncStatusLabel,
} from "./syncPresentation";

describe("sync presentation", () => {
  it("describes every declared source and keeps manual reports out of automatic sync", () => {
    expect(Object.keys(syncSourceDetails).sort()).toEqual([...dataSyncSourceIds].sort());
    expect(automaticSyncSources).toEqual(automaticDataSyncSourceIds);
    expect(automaticSyncSources).not.toContain("usage_reports");
    expect(syncSourceDetails.power_platform.description).toBe("Agents and supporting environment metadata");
  });

  const sourceLabels: Record<DataSyncSourceId, { label: string; unit: string }> = {
    users: { label: "Users", unit: "directory users checked" },
    graph_packages: { label: "Graph packages", unit: "packages" },
    power_platform: { label: "Power Platform", unit: "resources" },
    usage_reports: { label: "CSV usage reports", unit: "report rows" },
  };
  it.each(dataSyncSourceIds)("labels %s with its saved-count unit", source => {
    expect(syncSourceDetails[source]).toMatchObject(sourceLabels[source]);
    expect(syncSourceDetails[source].description.trim()).not.toBe("");
  });

  it("explains Users counts as checked candidates rather than licensed users, tenant headcount or referenced people", () => {
    expect(syncSourceDetails.users.description).toBe(
      "M365 Copilot candidate checks, app activity, and referenced agent people; count is directory users checked, not licensed users or tenant headcount",
    );
    expect(`3,993 ${syncSourceDetails.users.unit}`).toBe("3,993 directory users checked");
    expect(automaticSyncSources).toEqual(["users", "graph_packages", "power_platform"]);
  });

  const statusLabels: Record<DataSyncSourceState | DataSyncRun["status"], string> = {
    not_started: "Not synced",
    queued: "Queued",
    running: "Syncing",
    waiting_authorization: "Sign-in required",
    permission_required: "Permission required",
    awaiting_upload: "Import needed",
    succeeded: "Complete",
    partial: "Incomplete",
    failed: "Failed",
    cancelled: "Cancelled",
    waiting: "Action required",
    completed: "Complete",
  };
  it.each(Object.entries(statusLabels))("labels the declared %s status", (status, label) => {
    expect(syncStatusLabel(status)).toBe(label);
  });

  it.each([
    ["provider_pending_review", "provider pending review"],
    ["constructor", "constructor"],
    ["toString", "toString"],
    ["hasOwnProperty", "hasOwnProperty"],
    ["__proto__", "  proto  "],
  ])("preserves unknown status %s as readable text", (status, label) => {
    expect(syncStatusLabel(status)).toBe(label);
  });

  it.each([
    ["initial", "Initial sync"],
    ["incremental", "Data refresh"],
    ["full", "Full resync"],
  ] satisfies Array<[DataSyncMode, string]>)("labels the %s collection mode", (mode, label) => {
    expect(syncModeLabel(mode)).toBe(label);
  });

  it.each([
    "1970-01-01T00:00:00.000Z",
    "2024-02-29T23:59:59.999Z",
    "2026-09-15T10:05:30.000Z",
  ])("formats %s with the viewer's locale and timezone", instant => {
    expect(formatSyncInstant(instant)).toBe(new Date(instant).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }));
  });

  it.each([
    "2026-09-15T14:05:30.000+04:00",
    "2026-09-15T03:05:30.000-07:00",
  ])("formats offset timestamp %s as the same absolute instant", instant => {
    expect(formatSyncInstant(instant)).toBe(formatSyncInstant("2026-09-15T10:05:30.000Z"));
  });

  it.each([
    [0, "0s"],
    [999, "0s"],
    [1_000, "1s"],
    [59_999, "59s"],
    [60_000, "1m 0s"],
    [61_999, "1m 1s"],
    [3_599_999, "59m 59s"],
    [3_600_000, "1h 0m"],
    [3_659_999, "1h 0m"],
    [3_660_000, "1h 1m"],
    [86_399_999, "23h 59m"],
    [86_400_000, "24h 0m"],
    [90_061_000, "25h 1m"],
  ] as const)("formats %i elapsed milliseconds as %s", (milliseconds, expected) => {
    const start = "2026-09-15T10:00:00.000Z";
    const end = new Date(Date.parse(start) + milliseconds).toISOString();
    expect(syncDuration(start, end)).toBe(expected);
  });

  it("measures elapsed time across a timezone-offset change", () => {
    expect(syncDuration("2026-03-29T01:59:30+01:00", "2026-03-29T03:00:30+02:00")).toBe("1m 0s");
  });

  it("preserves nonnegative duration output when completion precedes the start", () => {
    expect(syncDuration("2026-09-15T10:01:00.000Z", "2026-09-15T10:00:00.000Z")).toBe("0s");
  });
});
