export type AuditAction = "block" | "unblock";

export type AuditScope = "single" | "bulk";

export type AuditStatus = "started" | "succeeded" | "failed" | "skipped";

export type AuditActor = {
  username: string;
  displayName: string;
  homeAccountId: string;
  tenantId?: string;
};

export type AuditEvent = {
  id: string;
  operationId: string;
  scope: AuditScope;
  action: AuditAction;
  targetBlockedState: boolean;
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

export type StartAuditEvent = Omit<
  AuditEvent,
  "id" | "startedAt" | "completedAt" | "status"
> & {
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
  agentId?: string;
  actorUsername?: string;
  scope?: AuditScope;
  action?: AuditAction;
  status?: AuditStatus;
  operationIdPrefix?: string;
};
