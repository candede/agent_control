import { describe, expect, it } from "vitest";
import type { ReportMetadata } from "../../backend/src/types/officialReportData";
import { isValidLowResponseThreshold, usageAvailabilityLabel, usageCount, usageCoverageLabel, usageDate } from "./usageInsights";

describe("usage evidence formatting", () => {
  it.each([null, undefined, NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "keeps missing or invalid count %s unknown", value => {
      expect(usageCount(value)).toBe("Unknown");
    },
  );
  it.each([0, 1, 123456, Number.MAX_SAFE_INTEGER])("preserves exact count %s, including zero", value => {
    expect(usageCount(value)).toBe(value.toLocaleString());
  });
  it("normalizes signed zero without inventing a negative count", () => {
    expect(usageCount(-0)).toBe((0).toLocaleString());
  });
  it.each([
    null, undefined, "", "not-a-date", "0", "2026", "2026-02-29", "2026-04-31",
    "2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T12:00:00",
    "2026-01-01T12:00:00+14:01", "2026-01-01T12:00:00+15:00",
  ])("does not turn invalid or ambiguous date %s into reported activity", value => {
    expect(usageDate(value)).toBe("Not reported");
  });
  it.each([
    ["2024-02-29", "2024-02-29T00:00:00Z"],
    ["2026-01-01T00:30:00+02:00", "2025-12-31T22:30:00Z"],
    ["2026-01-01T23:30:00-02:00", "2026-01-02T01:30:00Z"],
    ["2026-01-01T12:00:00.1234567Z", "2026-01-01T12:00:00Z"],
    ["1970-01-01", "1970-01-01T00:00:00Z"],
  ])("formats %s using its UTC date", (value, instant) => {
    expect(usageDate(value)).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(instant)));
  });
  it.each([
    ["activity_range", "Observed activity range"],
    ["operator_asserted", "Admin-supplied period"],
    ["source_metadata", "Reporting period"],
  ] as const)("keeps %s period provenance explicit", (provenance, label) => {
    expect(usageCoverageLabel({ reportingPeriod: { startDate: "2026-01-01", endDate: "2026-01-30", days: 30, provenance } }))
      .toBe(`${label}: 2026-01-01 to 2026-01-30`);
  });
  it.each([
    ["2026-02-30", "2026-03-01"], ["2026-02-01", "invalid"], ["2026-03-01", "2026-02-01"],
  ])("does not present %s to %s as a reporting window", (startDate, endDate) => {
    expect(usageCoverageLabel({ reportingPeriod: { startDate, endDate, days: null, provenance: "activity_range" } }))
      .toBe("Reporting period unavailable");
  });
  it("keeps absent and partial periods unknown", () => {
    expect(usageCoverageLabel(null)).toBe("Reporting period not supplied");
    expect(usageCoverageLabel({ reportingPeriod: null })).toBe("Reporting period not supplied");
    expect(usageCoverageLabel({ reportingPeriod: { startDate: "2026-01-01", endDate: null, days: null, provenance: "activity_range" } }))
      .toBe("Reporting period not supplied");
  });
  it.each([
    ["active", "Selected report"], ["stale", "Out-of-date report"], ["never_imported", "Reports not imported"],
    ["incomplete", "Incomplete report bundle"], ["not_selected", "No report selected"], ["deleted", "Selected report deleted"],
  ] satisfies Array<[ReportMetadata["availability"], string]>)("preserves %s availability without inferring freshness", (value, label) => {
    expect(usageAvailabilityLabel(value)).toBe(label);
  });
  it.each(["", "0", "-1", "1.5", "1e2", "NaN", "Infinity", " 5", "5 ", "100000001"])("rejects invalid threshold %s", value => {
    expect(isValidLowResponseThreshold(value)).toBe(false);
  });
  it.each(["1", "5", "0005", "100000000"])("accepts bounded integer threshold %s", value => {
    expect(isValidLowResponseThreshold(value)).toBe(true);
  });
});
