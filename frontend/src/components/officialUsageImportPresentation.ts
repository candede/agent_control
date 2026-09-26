import type {
  acceptOfficialUsageBundle,
  OfficialUsageAdminState,
  OfficialUsageBundlePreview,
  OfficialUsageReportKind,
  OfficialUsageStagingPreview,
  stageOfficialUsageReport,
} from "../api/client";

export type ImportStep = "files" | "validation" | "review" | "result";
export type ImportView = "import" | "manage";
export type FileValidation = {
  file: Pick<File, "name" | "size">;
  status: "waiting" | "validating" | "validated" | "rejected";
  preview?: OfficialUsageStagingPreview;
  error?: string;
};
export type ImportResult = {
  accepted: Awaited<ReturnType<typeof acceptOfficialUsageBundle>>;
  priorState?: OfficialUsageAdminState;
  verifiedState?: OfficialUsageAdminState;
  refreshError?: string;
};

export const importSteps: { id: ImportStep; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "validation", label: "Validation" },
  { id: "review", label: "Review & accept" },
  { id: "result", label: "Result" },
];

export function kindLabel(kind: OfficialUsageReportKind) {
  return kind === "agents" ? "Agents" : kind === "userAgents" ? "Users & agents" : "Users";
}

function formatInstant(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatCoverage(period: { startDate: string | null; endDate: string | null }) {
  return period.startDate && period.endDate ? `${period.startDate} to ${period.endDate}` : "No activity dates supplied";
}

export function formatProvenance(provenance?: string) {
  return provenance === "activity_range" ? "Observed last-activity dates; reporting window unknown"
    : provenance === "operator_asserted" ? "Previously supplied by administrator"
      : provenance === "source_metadata" ? "Source-supplied reporting window"
        : "Reporting window unknown";
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

export function acceptedBundleMessage({ accepted, priorState, verifiedState }: ImportResult) {
  if (!accepted.complete) {
    return "Accepted reports remain an incomplete retained snapshot and did not replace the current official usage view.";
  }
  if (!verifiedState) {
    if (accepted.reusedExistingSet) {
      return "The server confirmed an exact duplicate of a retained snapshot. No new history entry was created. Current selection has not yet been verified. Do not upload the files again; refresh the result.";
    }
    return "The server accepted the reviewed bundle. Its retained snapshot and current selection have not yet been verified. Do not upload the files again; refresh the result.";
  }
  const priorSet = priorState?.sets.find(reportSet => reportSet.id === accepted.setId);
  const refreshedSet = verifiedState.sets.find(reportSet => reportSet.id === accepted.setId);
  if (refreshedSet?.deletedAt || (refreshedSet && !refreshedSet.complete) || (!refreshedSet && !accepted.reusedExistingSet)) {
    return "The reports were accepted, but refreshed history could not confirm an available retained snapshot. Refresh import state before relying on its status.";
  }
  const isCurrent = verifiedState.activeSetId === accepted.setId;
  const selectionUnchanged = Boolean(priorState
    && priorState.activeSetId === verifiedState.activeSetId
    && priorState.activeRevision === verifiedState.activeRevision
    && accepted.activeRevision === verifiedState.activeRevision);
  const reused = accepted.reusedExistingSet ?? Boolean(priorSet?.complete && priorSet.acceptedAt && !priorSet.deletedAt);
  const acceptedAt = priorSet?.acceptedAt ?? refreshedSet?.acceptedAt;
  const acceptance = acceptedAt ? ` Original acceptance remains ${formatInstant(acceptedAt)}.` : "";
  if (reused) {
    if (isCurrent) {
      return `The upload exactly matched the current retained snapshot. No new history entry was created.${acceptance}${selectionUnchanged ? " Current selection and revision are unchanged." : " Current selection is on the matched snapshot."} Original upload bytes were discarded.`;
    }
    const current = verifiedState.activeSetId ? verifiedState.activeSetId.slice(0, 8) : "none";
    return `The upload exactly matched retained snapshot ${accepted.setId.slice(0, 8)}. No new history entry was created.${acceptance} Current selection ${selectionUnchanged ? "remains" : "is"} ${current}${selectionUnchanged ? " and its revision is unchanged" : ""}. Original upload bytes were discarded.`;
  }
  if (isCurrent) {
    return "The compatible three-file snapshot was added to retained history and is current. Prior snapshots remain retained separately, and original upload bytes were discarded.";
  }
  const current = verifiedState.activeSetId ? verifiedState.activeSetId.slice(0, 8) : "none";
  return `The compatible three-file snapshot was added to retained history. Current selection is ${current}; the new snapshot is not current. Snapshots remain separate, and original upload bytes were discarded.`;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The official usage request failed.";
}
