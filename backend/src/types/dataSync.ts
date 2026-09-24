export const dataSyncSourceIds = ["users", "graph_packages", "power_platform", "usage_reports"] as const;
export type DataSyncSourceId = (typeof dataSyncSourceIds)[number];
export const automaticDataSyncSourceIds = ["users", "graph_packages", "power_platform"] as const satisfies readonly DataSyncSourceId[];
export type DataSyncMode = "initial" | "incremental" | "full";
export type DataSyncSourceState =
  | "not_started"
  | "queued"
  | "running"
  | "waiting_authorization"
  | "permission_required"
  | "awaiting_upload"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

export function dataSyncFailureStatus(code: string, status?: number): Extract<DataSyncSourceState, "waiting_authorization" | "permission_required" | "failed"> {
  if (status === 401 || ["interaction_required", "authorization_expired", "unauthorized", "conditional_access_required", "graph_http_401"].includes(code.toLowerCase())) {
    return "waiting_authorization";
  }
  if (status === 403 || ["missing_permission", "missing_internal_role", "missing_provider_role", "missing_provider_scope",
    "missing_role", "missing_license", "capability_unavailable", "not_configured", "authorization_requestdenied", "graph_http_403"].includes(code.toLowerCase())) {
    return "permission_required";
  }
  return "failed";
}

export type DataSyncSourceStatus = {
  source: DataSyncSourceId;
  status: DataSyncSourceState;
  jobId: string | null;
  /** Saved total for markers/success; observations in the current attempt's phase otherwise. Null means unknown. */
  count: number | null;
  lastSuccessAt: string | null;
  updatedAt: string | null;
  message: string;
  canRetry: boolean;
};

export type DataSyncRun = {
  id: string;
  mode: DataSyncMode;
  automatic?: boolean;
  status: "running" | "waiting" | "completed" | "partial" | "cancelled";
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  sources: DataSyncSourceStatus[];
};

export type DataSyncState = {
  onboardingRequired: boolean;
  usageImportRequired: boolean;
  run: DataSyncRun | null;
  /** Last successful saved-data markers, independent of the latest run's attempts. */
  sources: DataSyncSourceStatus[];
};

export type StartDataSyncInput = {
  mode: DataSyncMode;
  /** Defaults to automatic sources; usage_reports is manual and must be explicitly requested. */
  sources?: DataSyncSourceId[];
  clearSavedData?: boolean;
};

export type AutomaticRefreshResult = {
  run: DataSyncRun | null;
  detailJob: {
    id: string;
    status: "waiting_authorization" | "running" | "succeeded" | "failed" | "cancelled";
    updatedAt: string;
    message?: string;
    errorCode?: string;
  } | null;
  revisions: Record<(typeof automaticDataSyncSourceIds)[number], string>;
  nextCheckAt: string;
};
