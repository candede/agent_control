import { appRoles, capabilityIds, type AppRole, type CapabilityId } from "./capability.js";
import type { DataSyncSourceId } from "./dataSync.js";

export const workbenchViewIds = [
  "agents",
  "dashboard",
  "users",
  "sync",
  "audit",
  "permissions",
] as const;

type WorkbenchViewId = (typeof workbenchViewIds)[number];

export type WorkbenchViewDefinition = {
  id: WorkbenchViewId;
  label: string;
  path: `/${string}`;
  roles: AppRole[];
  source: string;
};

export type WorkbenchActionDefinition = {
  /** Unique within a metadata response; consumers reject ambiguous IDs. */
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

export const workbenchMetadataMaximumBytes = 65_536;

export function parseWorkbenchMetadataJson(text: string): WorkbenchMetadata {
  if (typeof text !== "string" || text.length > workbenchMetadataMaximumBytes) invalidMetadata();
  // JSON is the boundary: caller-owned objects, accessors and proxies are never inspected.
  const frames: Array<Set<string> | null> = [];
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]]/g)) {
    const token = match[0];
    if (token === "{" || token === "[") {
      frames.push(token === "{" ? new Set() : null);
      if (frames.length > 4) invalidMetadata();
    } else if (token === "}" || token === "]") frames.pop();
    else {
      const keys = frames.at(-1);
      let next = match.index + token.length;
      while (/[\t\n\r ]/.test(text.charAt(next))) next++;
      if (!keys || text.charAt(next) !== ":") continue;
      const key: string = JSON.parse(token);
      if (keys.has(key)) invalidMetadata();
      keys.add(key);
    }
  }
  const value: unknown = JSON.parse(text);
  const views = metadataList(metadataField(value, "views"), workbenchViewIds.length).map(view => {
    const id = metadataChoice(metadataField(view, "id"), workbenchViewIds);
    if (metadataField(view, "path") !== `/${id}`) invalidMetadata();
    return {
      id, path: `/${id}` as const,
      label: metadataText(metadataField(view, "label"), 128),
      roles: metadataRoles(metadataField(view, "roles")),
      source: metadataText(metadataField(view, "source"), 1_024),
    };
  });
  const actions = metadataList(metadataField(value, "actions"), 128).map((action): WorkbenchActionDefinition => {
    const id = metadataText(metadataField(action, "id"), 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(id)) invalidMetadata();
    const capabilityId = metadataField(action, "capabilityId");
    const route = metadataText(metadataField(action, "route"), 256);
    if (!/^\/api\/[A-Za-z0-9_/:.-]+$/.test(route)
      || route.includes("//") || route.split("/").some(part => part === "." || part === "..")) invalidMetadata();
    const nativeTarget = metadataChoice(metadataField(action, "nativeTarget"), [
      "none", "graph_package_id", "power_platform_resource_id", "copilot_environment_bot", "provider_job_id",
      "official_usage_set", "purview_query_window", "defender_fixed_template_window", "sync_run",
    ] as const);
    const preview = metadataChoice(metadataField(action, "preview"), ["none", "required"] as const);
    const confirmation = metadataChoice(metadataField(action, "confirmation"), ["none", "explicit", "risk_and_exact_targets"] as const);
    if (preview === "required" && (nativeTarget === "none" || confirmation === "none")) invalidMetadata();
    return {
      id, label: metadataText(metadataField(action, "label"), 128),
      roles: metadataRoles(metadataField(action, "roles")),
      capabilityId: capabilityId === null ? null : metadataChoice(capabilityId, capabilityIds),
      nativeTarget, preview, confirmation,
      recovery: metadataChoice(metadataField(action, "recovery"), ["none", "resume_unsent", "cancel_unsent", "reconcile_get_only", "reauthorize"] as const),
      method: metadataChoice(metadataField(action, "method"), ["GET", "POST", "PATCH", "DELETE"] as const),
      route: `/api/${route.slice("/api/".length)}`,
      source: metadataChoice(metadataField(action, "source"), [
        "unified_inventory", "graph_packages", "power_platform", "official_usage", "local_audit", "purview", "defender", "data_sync",
      ] as const),
    };
  });
  if (new Set(views.map(view => view.id)).size !== views.length
    || new Set(actions.map(action => action.id)).size !== actions.length) invalidMetadata();
  return { views, actions };
}

function metadataField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidMetadata();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) invalidMetadata();
  return descriptor.value;
}

function metadataList(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalidMetadata();
  return value;
}

function metadataText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) invalidMetadata();
  return value;
}

function metadataChoice<T extends string>(value: unknown, choices: readonly T[]): T {
  const choice = choices.find(item => item === value);
  if (choice === undefined) invalidMetadata();
  return choice;
}

function metadataRoles(value: unknown): AppRole[] {
  const roles = metadataList(value, appRoles.length).map(role => metadataChoice(role, appRoles));
  if (!roles.length || new Set(roles).size !== roles.length) invalidMetadata();
  return roles;
}

function invalidMetadata(): never {
  throw new SyntaxError("Workbench metadata does not match the contract.");
}

export type WorkbenchJobSource =
  | "data-sync"
  | "package-refresh"
  | "power-platform";

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
  tokenMode?: "delegated" | "application";
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  syncSources?: DataSyncSourceId[];
  updatedAt: string;
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
