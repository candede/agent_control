import type { OfficialReportPreview } from "../../../backend/src/types/officialReportApi";
import type { ReportUploadMetadata } from "../api/reportData";

export function kindLabel(kind: OfficialReportPreview["kind"]) {
  return kind === "agents" ? "Agents" : kind === "userAgents" ? "Users & agents" : "Users";
}
export function companionMetadata(preview?: Pick<OfficialReportPreview, "reportingPeriod" | "sourceAsOf" | "sourceAsOfProvenance">): ReportUploadMetadata {
  const period = preview?.reportingPeriod;
  return {
    ...(period?.startDate && period.endDate && (period.provenance === "operator_asserted" || period.provenance === "source_metadata")
      ? { reportingStart: period.startDate, reportingEnd: period.endDate, periodProvenance: period.provenance } : {}),
    ...(preview?.sourceAsOf && (preview.sourceAsOfProvenance === "source_metadata" || preview.sourceAsOfProvenance === "operator_asserted")
      ? { sourceAsOf: preview.sourceAsOf, sourceAsOfProvenance: preview.sourceAsOfProvenance } : {}),
  };
}
