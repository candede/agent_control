import { isGraphGuid } from "./copilotUsage.js";

export type PackageAccessEntity = {
  resourceId: string;
  resourceType: "user" | "group" | string;
};

export const packageAccessCollectionLimit = 5000;
export const packageObservationLimits = { bytes: 2_048_000, elementGroups: 50, elementsPerGroup: 100 } as const;

export function isPackageAccessEntity(value: unknown): value is PackageAccessEntity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const resourceId = Object.getOwnPropertyDescriptor(value, "resourceId")?.value;
  const resourceType = Object.getOwnPropertyDescriptor(value, "resourceType")?.value;
  return typeof resourceId === "string" && Boolean(resourceId.trim()) && resourceId.length <= 512
    && !/[\u0000-\u001F\u007F-\u009F\uD800-\uDFFF]/u.test(resourceId)
    && typeof resourceType === "string" && /^(user|group)$/i.test(resourceType);
}

export function isDirectoryObjectId(value: unknown) {
  return isGraphGuid(value);
}

export function isPackageId(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 512
    && value !== "." && value !== ".." && !/[\u0000-\u001F\u007F\uD800-\uDFFF]/u.test(value);
}

export type PackageAccessTarget = "availability" | "installation";

export type PackageAccessMutationMode = "add" | "replace";

// Provider strings, including future values, stay raw until normalized for an access decision.
export type PackageStatus = string;

export function formatPackageType(value: string): string {
  switch (value) {
    case "firstParty": return "1st party agents";
    case "thirdParty": return "3rd party agents";
    case "shared": return "Shared in your organization";
    case "lob": return "Built by your org";
    default: return value;
  }
}

export const packageStatusAliases = {
  all: ["all", "everyone", "allowedforall", "availabletoall", "deployedtoall", "installedforall"],
  some: ["some", "allowedforsome", "availabletosome", "deployedtosome", "installedforsome"],
  none: ["none", "noone", "allowedfornoone", "availabletonoone", "deployedtonoone", "deployedtonone", "installedfornoone", "notavailable", "notdeployed"],
} as const;

export function normalizePackageStatus(value: PackageStatus | undefined): "all" | "some" | "none" | undefined {
  const normalized = value?.replace(/[^a-z0-9]/gi, "").toLowerCase();
  for (const status of ["all", "some", "none"] as const) {
    if (packageStatusAliases[status].some(alias => alias === normalized)) return status;
  }
  return undefined;
}

export function isWritablePackageAccessScope(status: PackageStatus | undefined, principals: readonly PackageAccessEntity[] | undefined) {
  if (principals === undefined) return false;
  const scope = normalizePackageStatus(status) ?? (status === undefined && principals.length ? "some" : undefined);
  return scope === "none" && principals.length === 0 || scope === "some" && principals.length > 0;
}

export type PackageAccessUpdate =
  | {
      target: PackageAccessTarget;
      mode: "add";
      scope: "specific";
      principals: PackageAccessEntity[];
    }
  | {
      target: PackageAccessTarget;
      mode: "replace";
      scope: "specific";
      principals: PackageAccessEntity[];
    }
  | {
      target: PackageAccessTarget;
      mode: "replace";
      scope: "none";
      principals: never[];
    };

export type PackageAccessUpdateResult = {
  changed: boolean;
  previousCount: number;
  resultingCount: number;
  principals: PackageAccessEntity[];
};

export type PackageElementDetail = {
  elementType: string;
  elements: Array<{
    id: string;
    definition: string;
  }>;
};

export type PackageControlObservation = {
  snapshotId: string;
  observedAt: string;
  expiresAt: string;
};

export type PackageDetailFreshness = {
  state: "fresh" | "stale" | "missing" | "invalidated";
  observedAt: string | null;
  expiresAt: string | null;
};

export type CopilotPackage = {
  id: string;
  displayName: string;
  type?: string;
  shortDescription?: string;
  isBlocked: boolean;
  supportedHosts?: string[];
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  publisher?: string;
  availableTo?: PackageStatus;
  deployedTo?: PackageStatus;
  elementTypes?: string[];
  platform?: string;
  version?: string;
  manifestVersion?: string;
  manifestId?: string;
  appId?: string;
  assetId?: string;
  sourceSystem: "graph_packages";
  authoringTool: string | null;
  creatorType: "unknown";
  agentKind: "copilot_package";
  lifecycle: "unknown";
  identityConfidence: "exact_native";
  provenance: Record<string, { sourceSystem: "graph_packages"; path: string; maturity: "ga" | "preview" }>;
  controlObservations?: Partial<Record<"block" | "access", PackageControlObservation>>;
  detailFreshness?: PackageDetailFreshness;
};

export type CopilotPackageDetail = CopilotPackage & {
  identityDetailsCollected?: true;
  identityRevalidationRequired?: true;
  longDescription?: string;
  categories?: string[];
  sensitivity?: string;
  allowedUsersAndGroups?: PackageAccessEntity[];
  acquireUsersAndGroups?: PackageAccessEntity[];
  elementDetails?: PackageElementDetail[];
};

export function formatPackageFacetLabel(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
}

export function normalizePackageAuthoringTool(value: string) {
  const normalized = value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
  if (normalized === "copilotstudiolite" || normalized === "microsoftcopilotstudiolite") return "microsoft365copilotagentbuilder";
  return normalized.includes("copilotstudio") ? "copilotstudio" : normalized;
}

export function formatAgentAuthoringTool(value: string) {
  const normalized = normalizePackageAuthoringTool(value);
  return normalized === "copilotstudio" ? "Copilot Studio"
    : normalized === "microsoft365copilotagentbuilder" ? "Microsoft 365 Copilot Agent Builder" : formatPackageFacetLabel(value);
}

export type GraphCollectionResponse<T> = {
  value: T[];
  "@odata.nextLink"?: string;
};
