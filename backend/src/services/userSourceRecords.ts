import { AppError } from "../errors.js";
import type { ActivityRecord, DirectoryRecord, PlanRecord } from "../db/dataGenerations.js";
import { digest } from "../db/dataBounds.js";
import type { CopilotDirectoryUser } from "../types/copilotUsage.js";
import { isCopilotServiceSummaryState } from "../types/copilotUsage.js";
import { normalizeCopilotIdentity } from "./copilotIdentityKey.js";
import type { CopilotReportUser } from "./userSourceGraphFields.js";
import { summarizeCopilotServices } from "./copilotServicePlans.js";
import { copilotAppActivityPeriod, isCopilotServiceActive } from "../types/copilotUsage.js";

export function directorySourceRecord(user: CopilotDirectoryUser): DirectoryRecord {
  const i = user.identity;
  if (user.serviceEvidenceVersion !== 1 || !isCopilotServiceSummaryState(user.copilotServiceState)
    || !Array.isArray(user.servicePlans) || user.servicePlans.length > 1000
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(i.objectId)
    || new Set(user.servicePlans.map(plan => plan.servicePlanId.toLowerCase())).size !== user.servicePlans.length) {
    throw new AppError(502, "provider_schema", "Invalid directory service evidence.");
  }
  const identity = i.objectId.toLowerCase();
  const summarized = user.servicePlans.length ? summarizeCopilotServices(user.servicePlans) : "disabled";
  if (user.copilotServiceState !== summarized && !(user.copilotServiceState === "unknown" && !isCopilotServiceActive(summarized))) {
    throw new AppError(502, "provider_schema", "Inconsistent paid-feature summary.");
  }
  const upn = text(i.userPrincipalName, 320, false)!;
  const display = text(i.displayName, 512);
  if (i.accountEnabled !== null && typeof i.accountEnabled !== "boolean") throw new AppError(502, "provider_schema", "Invalid account state.");
  const row: DirectoryRecord = {
    identity, upn, upn_key: normalizeCopilotIdentity(upn), display_name: display,
    sort_key: (display || upn).normalize("NFKC").toLowerCase(),
    company: text(i.companyName, 256), department: text(i.department, 256), account_enabled: i.accountEnabled,
    user_type: text(i.userType, 64), employee_type: text(i.employeeType, 128),
    service_state: user.copilotServiceState, plan_count: user.servicePlans.length, residual: {},
  };
  // Hash each bounded child separately; the parent carries only a fixed-size digest.
  const hashes = user.servicePlans.map(plan => {
    const record = directoryPlanRecord(identity, plan);
    return [record.plan_id, digest(JSON.stringify(record))];
  }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  row.residual = { evidenceHash: digest(JSON.stringify([row, hashes])) };
  return row;
}

export function directoryPlanRecord(userId: string, plan: CopilotDirectoryUser["servicePlans"][number]): PlanRecord {
  if (!["enabled", "warning", "disabled", "suspended", "locked_out", "unknown"].includes(plan.state)
    || plan.capabilityStatus !== null && !["Enabled", "Warning", "Suspended", "Deleted", "LockedOut"].includes(plan.capabilityStatus)
    || plan.assignedDateTime !== null && (!Number.isFinite(Date.parse(plan.assignedDateTime)) || plan.assignedDateTime.length > 128)) {
    throw new AppError(502, "provider_schema", "Invalid service plan.");
  }
  const planId = text(plan.servicePlanId, 128, false)!.toLowerCase();
  return { identity: `${userId}:${planId}`, user_id: userId, plan_id: planId,
    service: text(plan.service, 256, false)!, display_name: text(plan.displayName, 1024, false)!,
    state: plan.state, capability_status: plan.capabilityStatus, assigned_at: plan.assignedDateTime,
    residual: { assignedDateTime: plan.assignedDateTime } };
}

export function activitySourceRecord(row: CopilotReportUser, ordinal: number): ActivityRecord {
  const a = row.activity;
  return {
    identity: String(ordinal).padStart(6, "0"), upn_key: normalizeCopilotIdentity(row.normalizedUserPrincipalName),
    report_refresh_date: a.reportRefreshDate, last_activity_date: a.lastActivityDate,
    chat_date: a.copilotChatLastActivityDate, teams_date: a.microsoftTeamsCopilotLastActivityDate,
    word_date: a.wordCopilotLastActivityDate, excel_date: a.excelCopilotLastActivityDate,
    powerpoint_date: a.powerpointCopilotLastActivityDate, outlook_date: a.outlookCopilotLastActivityDate,
    onenote_date: a.onenoteCopilotLastActivityDate, loop_date: a.loopCopilotLastActivityDate, period: copilotAppActivityPeriod, residual: {},
  };
}

function text(value: string | null, limit: number, nullable = true) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\r\n\0]/.test(value)) {
    throw new AppError(502, "provider_schema", "Invalid directory text.");
  }
  return value.trim();
}
