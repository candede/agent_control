import { isProxy } from "node:util/types";
import { AppError } from "../errors.js";
import type { ActivityRecord, DirectoryRecord, PlanRecord } from "../db/dataGenerations.js";
import { dataLimitError, dataLimits, digest } from "../db/dataBounds.js";
import type { CopilotDirectoryUser } from "../types/copilotUsage.js";
import { isCopilotServiceSummaryState, isGraphGuid } from "../types/copilotUsage.js";
import { normalizeCopilotIdentity } from "./copilotIdentityKey.js";
import { civilDate, optionalDateTime, type CopilotReportUser } from "./userSourceGraphFields.js";
import { normalizeCopilotAssignmentTime, summarizeCopilotServices } from "./copilotServicePlans.js";
import { copilotAppActivityPeriod, isCopilotServiceActive } from "../types/copilotUsage.js";

export function directorySourceRecord(user: CopilotDirectoryUser): DirectoryRecord {
  const source = ownRecord(user, ["identity", "serviceEvidenceVersion", "copilotServiceState", "servicePlans"]);
  const i = ownRecord(source.identity, ["objectId", "userPrincipalName", "displayName", "accountEnabled",
    "companyName", "department", "userType", "employeeType"]);
  if (source.serviceEvidenceVersion !== 1 || !isCopilotServiceSummaryState(source.copilotServiceState)
    || typeof i.objectId !== "string" || !isGraphGuid(i.objectId)) throw invalidEvidence();
  const identity = i.objectId.toLowerCase();
  const plans = ownArray(source.servicePlans, dataLimits.plansPerUser).map(plan => directoryPlanRecord(identity, plan));
  if (new Set(plans.map(plan => plan.plan_id)).size !== plans.length) throw invalidEvidence();
  const summarized = plans.length ? summarizeCopilotServices(plans) : "disabled";
  if (source.copilotServiceState !== summarized && !(source.copilotServiceState === "unknown" && !isCopilotServiceActive(summarized))) {
    throw new AppError(502, "provider_schema", "Inconsistent paid-feature summary.");
  }
  const upn = text(i.userPrincipalName, 320, false)!;
  const display = text(i.displayName, 512);
  if (i.accountEnabled !== null && typeof i.accountEnabled !== "boolean") throw new AppError(502, "provider_schema", "Invalid account state.");
  const row: DirectoryRecord = {
    identity, upn, upn_key: identityKey(upn), display_name: display,
    sort_key: (display || upn).normalize("NFKC").toLowerCase(),
    company: text(i.companyName, 256), department: text(i.department, 256), account_enabled: i.accountEnabled,
    user_type: text(i.userType, 64), employee_type: text(i.employeeType, 128),
    service_state: source.copilotServiceState, plan_count: plans.length, residual: {},
  };
  // Hash each bounded child separately; the parent carries only a fixed-size digest.
  const hashes = plans.map(record => {
    return [record.plan_id, digest(JSON.stringify(record))];
  }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  row.residual = { evidenceHash: digest(JSON.stringify([row, hashes])) };
  return row;
}

export function directoryPlanRecord(userId: string, input: unknown): PlanRecord {
  const plan = ownRecord(input, ["servicePlanId", "service", "displayName", "state", "capabilityStatus", "assignedDateTime"]);
  const capability = plan.capabilityStatus;
  if (!isGraphGuid(userId) || typeof plan.servicePlanId !== "string" || !isGraphGuid(plan.servicePlanId)
    || !isCopilotServiceSummaryState(plan.state) || plan.state === "partially_enabled"
    || capability !== null && capability !== "Enabled" && capability !== "Warning" && capability !== "Suspended"
      && capability !== "Deleted" && capability !== "LockedOut"
    || plan.assignedDateTime !== null && (typeof plan.assignedDateTime !== "string" || !plan.assignedDateTime)) {
    throw new AppError(502, "provider_schema", "Invalid service plan.");
  }
  const assigned = optionalDateTime(plan.assignedDateTime, "Directory service plan assignment time");
  const assignedAt = assigned === null ? null : normalizeCopilotAssignmentTime(assigned);
  const planId = plan.servicePlanId.toLowerCase();
  userId = userId.toLowerCase();
  return { identity: `${userId}:${planId}`, user_id: userId, plan_id: planId,
    service: text(plan.service, 256, false)!, display_name: text(plan.displayName, 1024, false)!,
    state: plan.state, capability_status: capability, assigned_at: assignedAt,
    residual: { assignedDateTime: assignedAt } };
}

export function activitySourceRecord(row: CopilotReportUser, ordinal: number): ActivityRecord {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > dataLimits.sourceRows) throw invalidEvidence();
  const source = ownRecord(row, ["normalizedUserPrincipalName", "activity"]);
  const a = ownRecord(source.activity, ["reportRefreshDate", "lastActivityDate", "copilotChatLastActivityDate",
    "microsoftTeamsCopilotLastActivityDate", "wordCopilotLastActivityDate", "excelCopilotLastActivityDate",
    "powerpointCopilotLastActivityDate", "outlookCopilotLastActivityDate", "onenoteCopilotLastActivityDate", "loopCopilotLastActivityDate"]);
  const date = (value: unknown, required = false) => {
    if (value !== null && (typeof value !== "string" || !value)) throw invalidEvidence();
    return civilDate(value, "activity date", !required);
  };
  return {
    identity: String(ordinal).padStart(6, "0"), upn_key: identityKey(text(source.normalizedUserPrincipalName, 512, false)!),
    report_refresh_date: date(a.reportRefreshDate, true), last_activity_date: date(a.lastActivityDate),
    chat_date: date(a.copilotChatLastActivityDate), teams_date: date(a.microsoftTeamsCopilotLastActivityDate),
    word_date: date(a.wordCopilotLastActivityDate), excel_date: date(a.excelCopilotLastActivityDate),
    powerpoint_date: date(a.powerpointCopilotLastActivityDate), outlook_date: date(a.outlookCopilotLastActivityDate),
    onenote_date: date(a.onenoteCopilotLastActivityDate), loop_date: date(a.loopCopilotLastActivityDate), period: copilotAppActivityPeriod, residual: {},
  };
}

export function snapshotUserSourceBatch<T>(rows: readonly T[]): T[] {
  if (!isProxy(rows) && Array.isArray(rows) && rows.length > dataLimits.batchRows) {
    throw dataLimitError("data_batch_rows", dataLimits.batchRows, rows.length);
  }
  ownArray(rows, dataLimits.batchRows);
  let bytes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    bytes += 1 + (typeof value === "string" ? Buffer.byteLength(value) : 0);
    if (bytes > dataLimits.batchBytes) throw dataLimitError("data_batch_bytes", dataLimits.batchBytes, bytes);
    if (typeof value === "string" && /[\0\p{Cs}]/u.test(value)) throw invalidEvidence();
    if (value === null || typeof value === "string" || typeof value === "boolean"
      || typeof value === "number" && Number.isFinite(value)) return;
    if (isProxy(value) || typeof value !== "object" || depth > 64 || ancestors.has(value)) throw invalidEvidence();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) throw invalidEvidence();
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) throw invalidEvidence();
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || /[\0\p{Cs}]/u.test(key)
        || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw invalidEvidence();
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !Object.hasOwn(property, "value") || !property.enumerable) throw invalidEvidence();
      bytes += Buffer.byteLength(key);
      visit(property.value, depth + 1);
    }
    ancestors.delete(value);
  };
  visit(rows, 0);
  return structuredClone(rows).map(row => row);
}

function ownRecord(value: unknown, fields: readonly string[]) {
  if (isProxy(value) || !value || typeof value !== "object" || Array.isArray(value)) throw invalidEvidence();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(value).length !== fields.length) throw invalidEvidence();
  const result: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const property = Object.getOwnPropertyDescriptor(value, field);
    if (!property || !Object.hasOwn(property, "value") || !property.enumerable) throw invalidEvidence();
    result[field] = property.value;
  }
  return result;
}

function ownArray(value: unknown, maximum: number) {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) throw invalidEvidence();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !Object.hasOwn(property, "value") || !property.enumerable) throw invalidEvidence();
    result.push(property.value);
  }
  return result;
}

function identityKey(value: string) {
  const key = normalizeCopilotIdentity(value);
  if (key.length > 512) throw invalidEvidence();
  return key;
}

function invalidEvidence() { return new AppError(502, "provider_schema", "Invalid user-source evidence."); }

function text(value: unknown, limit: number, nullable = true) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\r\n\0\p{Cs}]/u.test(value)) {
    throw new AppError(502, "provider_schema", "Invalid directory text.");
  }
  return value.trim();
}
