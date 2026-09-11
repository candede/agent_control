export type QuarantineAction = "quarantine" | "unquarantine";

export type CopilotStudioQuarantineTarget = {
  environmentId: string;
  botId: string;
};

export type CopilotStudioQuarantineStatus = CopilotStudioQuarantineTarget & {
  isBotQuarantined: boolean;
  lastUpdateTimeUtc: string;
  observedAt: string;
  correlationId: string;
};

export type InventoryQuarantineTarget = CopilotStudioQuarantineTarget & {
  resourceNativeId: string;
  displayName: string;
  snapshotId: string;
  inventoryObservedAt: string;
  inventoryExpiresAt: string;
  inventoryQuarantineState: boolean | null;
  inventoryQuarantinedAt: string | null;
};

export type QuarantineTargetEligibilityCode = "eligible" | "stale_snapshot" | "ambiguous_native_id" | "native_identity_unavailable";

export type QuarantineTargetCandidate = {
  nativeId: string;
  type: "microsoft.copilotstudio/agents";
  displayName: string;
  environmentId: string | null;
  botId: string | null;
  identifiers: Array<{ kind: "environment_id" | "cds_bot_id"; value: string }>;
  details: { isQuarantined?: boolean; quarantinedAt?: string };
  quarantineEligibility: { eligible: boolean; code: QuarantineTargetEligibilityCode; reason?: string };
};

export type QuarantineTargetPage = {
  value: QuarantineTargetCandidate[];
  count: number;
  snapshot: { id: string; observedAt: string; expiresAt: string } | null;
};

export type FrozenQuarantineTarget = InventoryQuarantineTarget & {
  directStatus: CopilotStudioQuarantineStatus;
};

export type QuarantineAuthority = {
  contractRevision: string;
  permissionRevision: string;
  configurationRevision: number;
};

export type QuarantineActor = {
  tenantId: string;
  homeAccountId: string;
  displayName: string;
  username: string;
};

export type QuarantineConfirmationSummary = {
  risk: true;
  operation: QuarantineAction;
  provider: "Power Platform Copilot Studio";
  endpoint: "api-version=1 botQuarantine";
  permission: "Delegated CopilotStudio.AdminActions.Invoke";
  targetCount: number;
  targetSelectionHash: string;
  actor: { id: string; displayName: string; username: string };
  packageControlIndependent: true;
  makerBehavior: string;
  providerAtomicity: false;
  targets: Array<{
    resourceNativeId: string;
    displayName: string;
    environmentId: string;
    botId: string;
    currentState: boolean;
    currentProviderUpdatedAt: string;
    requestedState: boolean;
    inventoryState: boolean | null;
    inventoryObservedAt: string;
  }>;
  additionalTargetCount: number;
};

export type QuarantineJobStatus = "queued" | "running" | "waiting_authorization" | "succeeded" | "failed" | "cancelled" | "partial" | "inconclusive";
export type QuarantineItemStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "inconclusive" | "skipped";
export type QuarantineReconciliationStatus = "not_required" | "required" | "verified_applied" | "verified_not_applied" | "conflict";

export type QuarantineJob = {
  id: string;
  action: QuarantineAction;
  status: QuarantineJobStatus;
  confirmationHash: string;
  confirmation: QuarantineConfirmationSummary;
  isCanary: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  inconclusive: number;
  cancelled: number;
  canResume: boolean;
  canReconcile: boolean;
  createdAt: string;
  updatedAt: string;
  results: Array<{
    resourceNativeId: string;
    displayName: string;
    environmentId: string;
    botId: string;
    status: QuarantineItemStatus;
    requestedState: boolean;
    observedState: boolean | null;
    observedProviderUpdatedAt: string | null;
    observedAt: string | null;
    correlationId: string | null;
    reconciliationStatus: QuarantineReconciliationStatus;
    retryEligible: boolean;
    errorCode?: string;
    message?: string;
  }>;
};