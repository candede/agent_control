export type BlockAuditAction = "block" | "unblock";

export type AccessAuditAction = "update-availability" | "update-installation";

export type AuditAction = BlockAuditAction | AccessAuditAction;

export type AuditScope = "single" | "bulk";

export type AuditStatus = "started" | "succeeded" | "failed" | "skipped";

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
      action: AccessAuditAction;
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
  action?: AuditAction;
  status?: AuditStatus;
  operationIdPrefix?: string;
  search?: string;
};
