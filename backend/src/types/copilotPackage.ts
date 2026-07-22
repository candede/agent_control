export type PackageAccessEntity = {
  resourceId: string;
  resourceType: "user" | "group" | string;
};

export type PackageAccessTarget = "availability" | "installation";

export type PackageAccessMutationMode = "add" | "replace";

export type PackageAccessScope = "specific" | "none";

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
  availableTo?: string;
  deployedTo?: string;
  elementTypes?: string[];
  platform?: string;
  version?: string;
  manifestVersion?: string;
  manifestId?: string;
  appId?: string;
  assetId?: string;
};

export type CopilotPackageDetail = CopilotPackage & {
  longDescription?: string;
  categories?: string[];
  sensitivity?: string;
  allowedUsersAndGroups?: PackageAccessEntity[];
  acquireUsersAndGroups?: PackageAccessEntity[];
  elementDetails?: PackageElementDetail[];
};

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
