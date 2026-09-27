import { describe, expect, it } from "vitest";
import type { OfficialUsageBundlePreview } from "../api/client";
import { companionMetadata, errorMessage, kindLabel } from "./officialUsageImportPresentation";
import { usageInsightsPublished } from "../test/usageInsightsFixture";

function preview(provenance: "activity_range" | "operator_asserted" | "source_metadata"): OfficialUsageBundlePreview {
  return {
    bundleId: "bundle", bundleHash: "hash", expectedActiveRevision: 1, staging: [], missingKinds: [], reconciliation: {},
    acceptedVersions: [{
      kind: "agents", versionId: "version", fileHash: "file",
      reportingPeriod: { startDate: "2026-08-01", endDate: "2026-08-30", provenance },
      sourceAsOf: null, sourceAsOfProvenance: "absent",
    }],
  };
}

describe("CSV import presentation and restored companion metadata", () => {
  it("keeps the three report names understandable", () => {
    expect(["agents", "userAgents", "users"].map(kind => kindLabel(kind as "agents" | "userAgents" | "users")))
      .toEqual(["Agents", "Users & agents", "Users"]);
  });

  it("does not turn observed activity dates into a supplied reporting period", () => {
    expect(companionMetadata(preview("activity_range"))).toEqual({});
    expect(companionMetadata()).toEqual({});
  });

  it.each(["operator_asserted", "source_metadata"] as const)("preserves an explicit %s period when resuming a legacy draft", provenance => {
    expect(companionMetadata(preview(provenance))).toEqual({
      reportingStart: "2026-08-01", reportingEnd: "2026-08-30", periodProvenance: provenance,
    });
  });

  it("preserves known source freshness but never invents it from a date or filename", () => {
    const value = preview("activity_range");
    value.acceptedVersions[0].sourceAsOf = "2026-09-01T00:00:00Z";
    expect(companionMetadata(value)).toEqual({});
    value.acceptedVersions[0].sourceAsOfProvenance = "source_metadata";
    expect(companionMetadata(value)).toEqual({ sourceAsOf: "2026-09-01T00:00:00Z", sourceAsOfProvenance: "source_metadata" });
  });

  it("uses an incomplete retained set's explicit period when there is no staging preview", () => {
    const set = { ...usageInsightsPublished.activeSet!, reportingPeriod: {
      startDate: "2026-08-01", endDate: "2026-08-30", provenance: "operator_asserted" as const,
    } };
    expect(companionMetadata(undefined, set)).toEqual({
      reportingStart: "2026-08-01", reportingEnd: "2026-08-30", periodProvenance: "operator_asserted",
    });
  });

  it("retains useful errors and supplies an explicit message for unknown failures", () => {
    expect(errorMessage(new Error("CSV header missing."))).toBe("CSV header missing.");
    expect(errorMessage(null)).toBe("The official usage request failed.");
  });
});
