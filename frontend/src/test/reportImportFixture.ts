import type { OfficialReportBundlePreview, OfficialReportPreview } from "../../../backend/src/types/officialReportApi";

export function reportStage(kind: OfficialReportPreview["kind"], bundleId: string, overrides: Partial<OfficialReportPreview> = {}): OfficialReportPreview {
  const index = kind === "agents" ? 1 : kind === "userAgents" ? 2 : 3;
  return { id: `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`, revision: 1, kind, bundleId,
    contentHash: String(index).repeat(64), fileHash: "a".repeat(64), rowCount: 100000, storedBytes: 2000000, wireBytes: 1000000,
    activeRevision: "4", expiresAt: "2030-02-01T00:00:00.000Z",
    reportingPeriod: { startDate: "2026-01-01", endDate: "2026-01-31", days: 31, provenance: "activity_range" },
    sourceAsOf: null, sourceAsOfProvenance: "absent", sourceFreshness: "unknown", correctionOfSetId: null,
    status: "active", examples: [], warnings: ["activity_range_not_coverage"],
    reconciliation: { rows: 100000, responses: index === 1 ? 1000000 : index === 2 ? 999999 : 1000001, agentsUsed: kind === "users" ? 300000 : null },
    ...overrides };
}
export function reportBundle(stages: OfficialReportPreview[], bundleId: string, expectedActiveRevision = "4"): OfficialReportBundlePreview {
  return { bundleId, expectedActiveRevision, complete: new Set(stages.map(stage => stage.kind)).size === 3, bundleHash: "b".repeat(64),
    stages: stages.map(stage => ({ stagingId: stage.id, kind: stage.kind, revision: stage.revision, contentHash: stage.contentHash,
      rowCount: stage.rowCount, reconciliation: stage.reconciliation })) };
}
