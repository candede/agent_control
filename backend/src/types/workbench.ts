import type { AppRole, CapabilityId } from "./capability.js";

export const workbenchViewIds = [
  "agents",
  "power-platform",
  "users",
  "official-usage",
  "audit",
  "security",
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
  nativeTarget: "none" | "graph_package_id" | "power_platform_resource_id" | "copilot_environment_bot" | "provider_job_id" | "official_usage_set" | "purview_query_window" | "defender_fixed_template_window";
  preview: "none" | "required";
  confirmation: "none" | "explicit" | "risk_and_exact_targets";
  recovery: "none" | "resume_unsent" | "cancel_unsent" | "reconcile_get_only" | "reauthorize";
  method: "GET" | "POST" | "PATCH" | "DELETE";
  route: `/api/${string}`;
  source: "graph_packages" | "power_platform" | "official_usage" | "local_audit" | "purview" | "defender";
};

export type WorkbenchMetadata = {
  views: WorkbenchViewDefinition[];
  actions: WorkbenchActionDefinition[];
};

export type WorkbenchJobSource =
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
  total: number | null;
  completed: number | null;
  partial: boolean;
  canResume: boolean;
  canCancel: boolean;
  canReconcile: boolean;
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
  package: RelatedSource<never>;
  reports: RelatedSource<never>;
  audit: RelatedSource<{
    jobId: string; nativeEventId: string | null; wrapperId: string; observedAt: string;
    operation: string; resultStatus: string | null; correlationId: string | null; matchedKind: "cds_bot_id";
  }>;
  security: RelatedSource<{
    jobId: string; snapshotId: string; nativeRecordId: string; observedAt: string; platform: string | null;
    lifecycleStatus: string | null; publishedStatus: string | null; matchedKind: "entra_agent_id";
  }>;
  controls: { quarantineTarget: { environmentId: string; botId: string } | null; packageTarget: null };
};
