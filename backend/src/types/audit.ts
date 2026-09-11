export type BlockAuditAction = "block" | "unblock";

export type AccessAuditAction = "update-availability" | "update-installation";

export type ReassignAuditAction = "reassign";

export type ProviderAuditReadAction = "view-audit-search" | "export-audit-search";

export type HuntingReadAction = "view-hunting" | "export-hunting";

export type HuntingLifecycleAction = "approve-hunting" | "qualify-hunting" | "submit-hunting" | "query-hunting" | "cancel-hunting" | "delete-hunting" | "revoke-hunting-scope";

export type AuditAction = BlockAuditAction | AccessAuditAction | ReassignAuditAction;

export type InventoryExportAction = "export-package-inventory" | "export-power-platform-inventory";
export type ReportExportAction = "export-official-usage-aggregate" | "export-official-usage-users";
export type AdministrativeExportAction = "export-administrative-audit";

export type LocalAuditAction = AuditAction | ProviderAuditReadAction | HuntingReadAction | HuntingLifecycleAction | InventoryExportAction | ReportExportAction | AdministrativeExportAction;

export type AuditScope = "single" | "bulk";

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
};

type AuditEventAction =
  | {
      action: BlockAuditAction;
      targetBlockedState: boolean;
    }
  | {
      action: AccessAuditAction | ReassignAuditAction | ProviderAuditReadAction | HuntingReadAction | HuntingLifecycleAction | InventoryExportAction | ReportExportAction | AdministrativeExportAction;
      targetBlockedState?: never;
    };

export type AuditEvent = AuditEventBase & AuditEventAction;

export type StartAuditEvent = Omit<
  AuditEventBase,
  "id" | "startedAt" | "completedAt" | "status"
> &
  AuditEventAction & {
    id?: string;
    startedAt?: string;
    status?: "started";
  };

export type CompleteAuditEvent = {
  completedAt?: string;
  status: Exclude<AuditStatus, "started">;
  message?: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
};

export type ListAuditEventsQuery = {
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
