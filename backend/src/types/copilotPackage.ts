export type PackageAccessEntity = {
  resourceId: string;
  resourceType: "user" | "group" | string;
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
};

export type BulkActionResult = {
  targetBlockedState: boolean;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: BulkPackageResult[];
};

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
