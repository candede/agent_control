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
