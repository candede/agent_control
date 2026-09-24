import type { AppRole, CapabilityId } from "./capability.js";
import type { DataSyncSourceId } from "./dataSync.js";

export const workbenchViewIds = [
  "agents",
  "users",
  "sync",
  "audit",
  "permissions",
  "jobs",
] as const;

export type WorkbenchViewId = (typeof workbenchViewIds)[number];

export type WorkbenchViewDefinition = {
  id: WorkbenchViewId;
  label: string;
  path: `/${string}`;
  roles: AppRole[];
  source: string;
};

export type WorkbenchActionDefinition = {
  id: string;
  label: string;
  roles: AppRole[];
  capabilityId: CapabilityId | null;
  nativeTarget: "none" | "graph_package_id" | "power_platform_resource_id" | "copilot_environment_bot" | "provider_job_id" | "official_usage_set" | "purview_query_window" | "defender_fixed_template_window" | "sync_run";
  preview: "none" | "required";
  confirmation: "none" | "explicit" | "risk_and_exact_targets";
  recovery: "none" | "resume_unsent" | "cancel_unsent" | "reconcile_get_only" | "reauthorize";
  method: "GET" | "POST" | "PATCH" | "DELETE";
  route: `/api/${string}`;
  source: "unified_inventory" | "graph_packages" | "power_platform" | "official_usage" | "local_audit" | "purview" | "defender" | "data_sync";
};

export type WorkbenchMetadata = {
  views: WorkbenchViewDefinition[];
  actions: WorkbenchActionDefinition[];
};

export type WorkbenchJobSource =
  | "data-sync"
  | "package-refresh"
  | "package-controls"
  | "power-platform"
  | "official-usage"
  | "purview"
  | "defender"
  | "quarantine";

export type WorkbenchJobSummary = {
  id: string;
  source: WorkbenchJobSource;
  label: string;
  target: string;
  status: string;
  /** Source-specific count: null means unknown, while confirmed empty results use zero. */
  total: number | null;
  completed: number | null;
  partial: boolean;
  canResume: boolean;
  canCancel: boolean;
  canReconcile: boolean;
  tokenMode?: "delegated" | "application";
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  syncSources?: DataSyncSourceId[];
  updatedAt: string;
  expiresAt?: string;
  href: `/${string}`;
};

export type WorkbenchJobsResponse = {
  value: WorkbenchJobSummary[];
  unavailableSources: Array<{ source: WorkbenchJobSource; code: string }>;
  polledAt: string;
  requestId: string;
};

export type RelatedSource<T> =
  | { status: "available"; count: number; value: T[] }
  | { status: "unauthorized" | "unmatched" | "unavailable"; reason: string };

export type InventorySourceAwareDetail = {
  source: "power_platform";
  nativeId: string;
  resourceType: string;
  environmentId: string | null;
  snapshotId: string;
  observedAt: string;
  expiresAt: string;
  identifiers: Array<{ kind: string; value: string }>;
  audit: RelatedSource<{
    jobId: string; nativeEventId: string | null; wrapperId: string; observedAt: string;
    operation: string; resultStatus: string | null; correlationId: string | null; matchedKind: "cds_bot_id";
  }>;
  security: RelatedSource<{
    jobId: string; snapshotId: string; nativeRecordId: string; observedAt: string; platform: string | null;
    lifecycleStatus: string | null; publishedStatus: string | null; matchedKind: "entra_agent_id";
  }>;
};
