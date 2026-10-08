import { createHash, randomUUID } from "node:crypto";
import type { OfficialReportBundlePreview, OfficialReportPreview } from "../../../backend/src/types/officialReportApi";

const capturedAt = Date.now(), day = 86_400_000;
const reportingEnd = new Date(capturedAt - day).toISOString().slice(0, 10);
const reportingStart = new Date(Date.parse(reportingEnd) - 30 * day).toISOString().slice(0, 10);

export function reportStage(kind: OfficialReportPreview["kind"], bundleId: string, overrides: Partial<OfficialReportPreview> = {}): OfficialReportPreview {
  const index = kind === "agents" ? 1 : kind === "userAgents" ? 2 : 3;
  const stage: OfficialReportPreview = { id: randomUUID(), revision: 1, kind, bundleId,
    contentHash: "", fileHash: "",
    rowCount: 100000, storedBytes: 2000000, wireBytes: 1000000,
    activeRevision: "4", expiresAt: new Date(capturedAt + 1_800_000).toISOString(),
    reportingPeriod: { startDate: reportingStart, endDate: reportingEnd, days: 31, provenance: "activity_range" },
    sourceAsOf: null, sourceAsOfProvenance: "absent", sourceFreshness: "unknown", correctionOfSetId: null,
    status: "active", examples: [], warnings: [],
    reconciliation: { rows: overrides.rowCount ?? 100000,
      responses: overrides.rowCount === 0 ? 0 : index === 1 ? 1000000 : index === 2 ? 999999 : 1000001,
      agentsUsed: kind === "users" ? overrides.rowCount === 0 ? 0 : 300000 : null },
    ...overrides };
  const rows = { kind: stage.kind, rowCount: stage.rowCount, reconciliation: stage.reconciliation, examples: stage.examples };
  stage.fileHash = overrides.fileHash ?? createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  stage.contentHash = overrides.contentHash ?? createHash("sha256").update(JSON.stringify({
    ...rows, reportingPeriod: stage.reportingPeriod, sourceAsOf: stage.sourceAsOf,
    sourceAsOfProvenance: stage.sourceAsOfProvenance, sourceFreshness: stage.sourceFreshness,
  })).digest("hex");
  stage.warnings = overrides.warnings ?? [
    ...(stage.sourceFreshness === "unknown" ? ["source_refresh_unknown"] : []),
    ...(stage.reportingPeriod.provenance === "activity_range" ? ["activity_range_not_coverage"] : []),
  ];
  return structuredClone(stage);
}
export function reportBundle(stages: readonly OfficialReportPreview[], bundleId: string, expectedActiveRevision = "4"): OfficialReportBundlePreview {
  if (stages.length > 3 || stages.some(stage => stage.bundleId !== bundleId)
    || new Set(stages.map(stage => stage.kind)).size !== stages.length
    || new Set(stages.map(stage => stage.id)).size !== stages.length) throw new Error("Invalid report fixture bundle membership.");
  const projected = structuredClone([...stages].sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
    .map(stage => ({ stagingId: stage.id, kind: stage.kind, revision: stage.revision, contentHash: stage.contentHash,
      rowCount: stage.rowCount, reconciliation: stage.reconciliation })));
  // Match OfficialReportImports.bundle: status changes do not rewrite the reviewed receipt.
  return { bundleId, expectedActiveRevision, complete: projected.length === 3, stages: projected,
    bundleHash: createHash("sha256").update(JSON.stringify({ bundleId, expectedActiveRevision, stages: projected })).digest("hex") };
}
