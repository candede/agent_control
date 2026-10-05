import { describe, expect, it } from "vitest";
import type { OfficialReportPreview } from "../../../backend/src/types/officialReportApi";
import { companionMetadata, kindLabel } from "./officialUsageImportPresentation";

function preview(provenance: "activity_range" | "operator_asserted" | "source_metadata"): Pick<OfficialReportPreview, "reportingPeriod" | "sourceAsOf" | "sourceAsOfProvenance"> {
  return {
    reportingPeriod: { startDate: "2026-08-01", endDate: "2026-08-30", provenance, days: 30 },
    sourceAsOf: null, sourceAsOfProvenance: "absent",
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

  it.each(["operator_asserted", "source_metadata"] as const)("preserves an explicit %s period when resuming streamed staging", provenance => {
    expect(companionMetadata(preview(provenance))).toEqual({
      reportingStart: "2026-08-01", reportingEnd: "2026-08-30", periodProvenance: provenance,
    });
  });

  it("preserves known source freshness but never invents it from a date or filename", () => {
    const value = preview("activity_range");
    value.sourceAsOf = "2026-09-01T00:00:00Z";
    expect(companionMetadata(value)).toEqual({});
    value.sourceAsOfProvenance = "source_metadata";
    expect(companionMetadata(value)).toEqual({ sourceAsOf: "2026-09-01T00:00:00Z", sourceAsOfProvenance: "source_metadata" });
  });

  it("retains an explicit period without inferring source freshness", () => {
    expect(companionMetadata(preview("operator_asserted"))).toEqual({
      reportingStart: "2026-08-01", reportingEnd: "2026-08-30", periodProvenance: "operator_asserted",
    });
  });
});
