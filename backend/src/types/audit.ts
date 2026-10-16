import type { AuditOriginV1, OriginFilters } from "./actionOrigin.js";
type BlockAuditAction = "block" | "unblock";

type AccessAuditAction = "update-availability" | "update-installation";

type ReassignAuditAction = "reassign";

type ProviderAuditReadAction = "view-audit-search" | "export-audit-search";

type HuntingReadAction = "view-hunting" | "export-hunting";

type HuntingLifecycleAction = "submit-hunting" | "query-hunting" | "cancel-hunting" | "delete-hunting";

export type AuditAction = BlockAuditAction | AccessAuditAction | ReassignAuditAction;

export type InventoryExportAction = "export-package-inventory" | "export-power-platform-inventory" | "export-agent-inventory";
export type ReportExportAction = "export-official-usage-aggregate" | "export-official-usage-users";
type AdministrativeExportAction = "export-administrative-audit";
export type AgentUsageAuditAction = "associate-agent-usage" | "remove-agent-usage-association";

export type ControlLifecycleAction = "resume-control" | "cancel-control" | "reconcile-control";
export type LocalAuditAction = AuditAction | ProviderAuditReadAction | HuntingReadAction | HuntingLifecycleAction | InventoryExportAction | ReportExportAction | AdministrativeExportAction | AgentUsageAuditAction | ControlLifecycleAction;

export type AuditScope = "single" | "bulk";

export const auditDefaultPageSize = 100;
export const auditMaximumOffset = 100_000;
export const auditMaximumSearchLength = 200;

export function isAuditOperationPrefix(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

export function auditMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string | number | boolean> = {};
  for (const key of ["target", "mode", "scope", "template", "rowCount", "requestCount", "previousCount", "resultingCount", "resultingBytes", "source", "snapshotId", "revision", "selection", "partial", "jobId", "reportSetId", "reportingStart", "reportingEnd", "leaseVersion", "correlationId", "confirmationHash", "targetSelectionHash", "prestateHash", "poststateHash", "readbackCount", "reconciliationStatus", "verification", "reportAgentHash", "inventoryRevision", "changed", "phase"]) {
    const entry: unknown = Reflect.get(value, key);
    if (typeof entry === "string" && entry.length <= 128 || typeof entry === "number" && Number.isFinite(entry) || typeof entry === "boolean") {
      result[key] = entry;
    }
  }
  for (const key of ["checksum", "queryHash"]) {
    const hash: unknown = Reflect.get(value, key);
    if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) result[key] = hash;
  }
  return result;
}

export type AuditStatus = "requested" | "started" | "succeeded" | "failed" | "skipped" | "inconclusive" | "cancelled";

export type AuditActor = {
  username: string;
  displayName: string;
  homeAccountId: string;
  tenantId?: string;
};

type AuditEventBase = {
  id: string;
  operationId: string;
  scope: AuditScope;
  agentId: string;
  agentDisplayName?: string;
  actor: AuditActor;
  startedAt: string;
  completedAt?: string;
  status: AuditStatus;
  message?: string;
  errorCode?: string;
  requestPath: string;
  metadata?: Record<string, unknown>;
  origin: AuditOriginV1;
};

type AuditEventAction =
  | {
      action: BlockAuditAction;
      targetBlockedState: boolean;
    }
  | {
      action: Exclude<LocalAuditAction, BlockAuditAction>;
      targetBlockedState?: never;
    };

export type AuditEvent = AuditEventBase & AuditEventAction;

export type StartAuditEvent = Omit<
  AuditEventBase,
  "id" | "startedAt" | "completedAt" | "status" | "origin"
> &
  AuditEventAction & {
    id?: string;
    startedAt?: string;
    status?: "started";
    origin?: AuditOriginV1;
  };

export type CompleteAuditEvent = {
  completedAt?: string;
  status: Exclude<AuditStatus, "started">;
  message?: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
};

export type ListAuditEventsQuery = OriginFilters & {
  limit?: number;
  offset?: number;
  agentId?: string;
  actorUsername?: string;
  scope?: AuditScope;
  action?: LocalAuditAction;
  status?: AuditStatus;
  operationIdPrefix?: string;
  search?: string;
};
