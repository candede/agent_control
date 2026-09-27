import type {
  OfficialUsageAdminState,
  OfficialUsageBundlePreview,
  OfficialUsageHistoryBundleSummary,
  OfficialUsageReportKind,
  OfficialUsageStagingPreview,
  stageOfficialUsageReport,
} from "../api/client";
import { usageDate } from "../usageInsights";

export type FileValidation = {
  file: Pick<File, "name" | "size">;
  status: "waiting" | "validating" | "validated" | "rejected";
  preview?: OfficialUsageStagingPreview;
  error?: string;
};

export function kindLabel(kind: OfficialUsageReportKind) {
  return kind === "agents" ? "Agents" : kind === "userAgents" ? "Users & agents" : "Users";
}

export function reportDates(bundle: Pick<OfficialUsageHistoryBundleSummary, "reportingPeriod">) {
  const { startDate, endDate } = bundle.reportingPeriod;
  return startDate && endDate ? `${usageDate(startDate)} to ${usageDate(endDate)}` : "No activity dates";
}

export function companionMetadata(
  preview?: OfficialUsageBundlePreview,
  reportSet?: OfficialUsageAdminState["sets"][number],
  stagedCompanion?: OfficialUsageStagingPreview,
): Omit<Parameters<typeof stageOfficialUsageReport>[1], "bundleId" | "correctionOfSetId"> {
  const basis = preview?.staging[0] ?? preview?.acceptedVersions[0] ?? stagedCompanion;
  const period = basis?.reportingPeriod ?? reportSet?.reportingPeriod;
  return {
    ...(period?.startDate && period.endDate && (period.provenance === "operator_asserted" || period.provenance === "source_metadata")
      ? { reportingStart: period.startDate, reportingEnd: period.endDate, periodProvenance: period.provenance }
      : {}),
    ...(basis?.sourceAsOf && basis.sourceAsOfProvenance !== "absent"
      ? { sourceAsOf: basis.sourceAsOf, sourceAsOfProvenance: basis.sourceAsOfProvenance }
      : {}),
  };
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The official usage request failed.";
}
