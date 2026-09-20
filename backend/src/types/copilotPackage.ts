export type PackageAccessEntity = {
  resourceId: string;
  resourceType: "user" | "group" | string;
};

export function isDirectoryObjectId(value: string) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

export type PackageAccessTarget = "availability" | "installation";

export type PackageAccessMutationMode = "add" | "replace";

export type PackageAccessScope = "specific" | "none";

// Provider strings, including future values, stay raw until normalized for an access decision.
export type PackageStatus = string;

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
};

export type CopilotPackageDetail = CopilotPackage & {
  identityDetailsCollected?: true;
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

export type BulkPackageResult = {
  id: string;
  displayName: string;
  status: "succeeded" | "failed" | "skipped";
  message?: string;
  errorCode?: string;
  errorDetails?: unknown;
  accessResult?: PackageAccessUpdateResult;
};

export type BulkSideEffectError = {
  phase: "start" | "result";
  agentId: string;
  message: string;
};

type BulkActionResultBase = {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: BulkPackageResult[];
  sideEffectErrors?: BulkSideEffectError[];
};

export type BulkActionResult = BulkActionResultBase &
  (
    | {
        targetBlockedState: boolean;
        accessUpdate?: never;
      }
    | {
        targetBlockedState?: never;
        accessUpdate: PackageAccessUpdate;
      }
  );

export type BulkPackageDetailResult =
  | {
      id: string;
      status: "succeeded";
      package: CopilotPackageDetail;
    }
  | {
      id: string;
      status: "failed";
      message: string;
    };

export type BulkPackageDetailsResult = {
  total: number;
  succeeded: number;
  failed: number;
  results: BulkPackageDetailResult[];
};

export type GraphCollectionResponse<T> = {
  value: T[];
  "@odata.nextLink"?: string;
};
