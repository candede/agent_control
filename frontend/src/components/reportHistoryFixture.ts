import type { OfficialUsageHistoryView, OfficialUsageSetSummary } from "../api/client";
import { usageInsightsPublished } from "../test/usageInsightsFixture";

export function reportHistoryFixture(sets: OfficialUsageSetSummary[] = [usageInsightsPublished.activeSet!], activeSetId?: string | null): OfficialUsageHistoryView {
  return {
    summary: {
      importCount: sets.length, uniqueObservationCount: 0, observationRowCount: 0, uniquePayloadCount: 0, repeatedRowsReused: 0,
      earliestObservedAt: null, latestObservedAt: null,
      activityDateRange: { earliestDateUtc: null, latestDateUtc: null, provenance: "last_activity_dates", provesReportingCoverage: false },
      reportingWindows: { earliestStartDateUtc: null, latestEndDateUtc: null, knownCount: 0, unknownCount: sets.length, overlappingKnownWindowCount: 0, additive: false },
      warning: { code: "rolling_snapshots_not_additive", message: "Rolling snapshots must not be summed." },
    },
    bundles: {
      value: sets.map(set => ({
        ...set, contentHash: "a".repeat(64), isActive: set.id === activeSetId, observationCount: 0, rowCount: 0,
        uniquePayloadCount: 0, repeatedRowsReused: 0, reportingWindowKnown: false, activityRangeIsCoverage: false, observations: [],
      })),
      count: sets.length, limit: 25, offset: 0,
    },
  };
}
