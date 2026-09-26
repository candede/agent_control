export type PackageAccessEntity = {
  resourceId: string;
  resourceType: "user" | "group" | string;
};

export function isDirectoryObjectId(value: string) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
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

export type PackageAccessUpdate =
  | {
      target: PackageAccessTarget;
      mode: PackageAccessMutationMode;
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
