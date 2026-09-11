export const appRoles = [
  "AgentControl.Reader",
  "AgentControl.Operator",
  "AgentControl.SecurityReader",
  "AgentControl.Administrator",
] as const;

export type AppRole = (typeof appRoles)[number];

export const capabilityIds = [
  "graph.package.read.delegated",
  "graph.package.read.application",
  "graph.package.access.manage",
  "graph.package.block.manage",
  "graph.package.reassign.manage",
  "graph.directory.read",
  "powerPlatform.inventory.read",
  "powerPlatform.quarantine.manage",
  "purview.audit.search.delegated",
  "purview.audit.search.application",
  "defender.hunting.delegated",
  "defender.hunting.application",
  "reports.official.import",
] as const;

export type CapabilityId = (typeof capabilityIds)[number];
export type CapabilityStatus =
  | "available"
  | "missing_permission"
  | "missing_internal_role"
  | "missing_role"
  | "missing_license"
  | "not_configured"
  | "unsupported"
  | "preview_disabled"
  | "provider_error"
  | "unknown";
export type TokenMode = "delegated" | "application" | "local";
export type DataClass =
  | "inventory"
  | "package_control"
  | "directory"
  | "provider_audit"
  | "hunting"
  | "aggregate_usage"
  | "report_import";

export type CapabilityDefinition = {
  id: CapabilityId;
  displayName: string;
  purpose: string;
  provider: "Microsoft Graph" | "Power Platform" | "Local";
  maturity: "v1.0" | "preview" | "local";
  cloud: "global" | "local";
  audience: string;
  mode: TokenMode;
  permissions: string[];
  acceptedPermissions?: string[];
  providerRoles: string[];
  licenses: string[];
  configuration: string[];
  sources: string[];
  dataClass: DataClass;
  internalRoles: AppRole[];
  consentGroup?: string;
  probe: {
    kind: "provider_read" | "live_qualification" | "local_policy" | "qualification_only" | "not_registered";
    adapterRegistered: boolean;
    description: string;
  };
};

export type CapabilityDecision = {
  capabilityId: CapabilityId;
  status: CapabilityStatus;
  authorized: boolean;
  fresh: boolean;
  checkedAt?: string;
  expiresAt?: string;
  lastSuccessAt?: string;
  previewQualification: "not_required" | "unqualified" | "qualified";
  evidence?: { category?: string; correlationId?: string };
  remediation: string[];
};

export type CapabilityView = {
  definition: CapabilityDefinition;
  decision: CapabilityDecision;
};