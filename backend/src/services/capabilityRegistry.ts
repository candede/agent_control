import {
  appRoles,
  capabilityIds,
  type AppRole,
  type CapabilityDefinition,
  type CapabilityId,
  type CapabilityStatus,
} from "../types/capability.js";

const graphAudience = "https://graph.microsoft.com";
const powerPlatformAudience = "8578e004-a5c6-46e7-913e-12f58912df43";
const packageApiBase = "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package";
const packageListSource = `${packageApiBase}/copilotpackages-list`;
const packageDetailSource = `${packageApiBase}/copilotpackagedetail-get`;
const packageAccessSource = `${packageApiBase}/copilotpackagedetail-update`;
const packageBlockSource = `${packageApiBase}/copilotpackage-block`;
const packageUnblockSource = `${packageApiBase}/copilotpackage-unblock`;
const packageReassignSource = `${packageApiBase}/copilotpackage-reassign`;
const directorySource = "https://learn.microsoft.com/en-us/graph/permissions-reference";
const inventorySource = "https://learn.microsoft.com/en-us/power-platform/admin/inventory-api";
const quarantineSource = "https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine";
const auditSource = "https://learn.microsoft.com/en-us/graph/api/security-auditcoreroot-post-auditlogqueries?view=graph-rest-1.0";
const huntingSource = "https://learn.microsoft.com/en-us/graph/api/security-security-runhuntingquery?view=graph-rest-1.0";
const reportsSource = "https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/activity-reports?view=o365-worldwide";

const reader: AppRole[] = ["AgentControl.Reader"];
const operator: AppRole[] = ["AgentControl.Operator"];
const securityReader: AppRole[] = ["AgentControl.SecurityReader"];
const administrator: AppRole[] = ["AgentControl.Administrator"];

export const capabilityDefinitions: readonly CapabilityDefinition[] = [
  {
    id: "graph.package.read.delegated", displayName: "Package catalog read", purpose: "Read the Microsoft 365 Copilot package catalog on behalf of the signed-in user.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "delegated",
    permissions: ["CopilotPackages.Read.All"], acceptedPermissions: ["CopilotPackages.ReadWrite.All"], providerRoles: [], licenses: ["Microsoft Agent 365"],
    configuration: ["Single-tenant Entra application", "Delegated consent"], sources: [packageListSource, packageDetailSource], dataClass: "inventory", internalRoles: ["AgentControl.Reader", "AgentControl.Operator"],
    consentGroup: "graph.package.read", probe: { kind: "provider_read", adapterRegistered: true, description: "Bounded package catalog list request." },
  },
  {
    id: "graph.package.read.application", displayName: "Package catalog application read", purpose: "Run an explicitly requested shared package catalog read using the application identity.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "application",
    permissions: ["CopilotPackages.Read.All"], acceptedPermissions: ["CopilotPackages.ReadWrite.All"], providerRoles: [], licenses: ["Microsoft Agent 365"],
    configuration: ["Administrator-enabled application mode", "Administrator-approved shared data scope"], sources: [packageListSource, packageDetailSource], dataClass: "inventory", internalRoles: reader,
    probe: { kind: "provider_read", adapterRegistered: true, description: "Bounded package catalog list request using an application token." },
  },
  {
    id: "graph.package.access.manage", displayName: "Package access management", purpose: "Change exact package availability or installation assignments.",
    provider: "Microsoft Graph", maturity: "preview", cloud: "global", audience: graphAudience, mode: "delegated",
    permissions: ["CopilotPackages.ReadWrite.All"], providerRoles: [], licenses: ["Microsoft Agent 365"], configuration: ["No documented If-Match or equivalent lost-update bound", "Explicit write qualification"],
    sources: [packageAccessSource], dataClass: "package_control", internalRoles: operator, consentGroup: "graph.package.manage",
    probe: { kind: "qualification_only", adapterRegistered: true, description: "The exact adapter is fixture-tested, but the operation stays disabled without documented conditional-write protection." },
  },
  {
    id: "graph.package.block.manage", displayName: "Package block management", purpose: "Block or unblock an exact package target.",
    provider: "Microsoft Graph", maturity: "preview", cloud: "global", audience: graphAudience, mode: "delegated",
    permissions: ["CopilotPackages.ReadWrite.All"], providerRoles: [], licenses: ["Microsoft Agent 365"], configuration: ["Explicit block and unblock qualification"],
    sources: [packageBlockSource, packageUnblockSource], dataClass: "package_control", internalRoles: operator, consentGroup: "graph.package.manage",
    probe: { kind: "qualification_only", adapterRegistered: true, description: "Catalog read does not qualify block or unblock; Phase 05 owns bounded canaries." },
  },
  {
    id: "graph.package.reassign.manage", displayName: "Package reassignment", purpose: "Reassign an exact supported package target after independent contract qualification.",
    provider: "Microsoft Graph", maturity: "preview", cloud: "global", audience: graphAudience, mode: "delegated",
    permissions: ["CopilotPackages.ReadWrite.All"], providerRoles: [], licenses: ["Microsoft Agent 365"], configuration: ["Explicit reassignment qualification"],
    sources: [packageReassignSource, packageDetailSource], dataClass: "package_control", internalRoles: operator, consentGroup: "graph.package.manage",
    probe: { kind: "not_registered", adapterRegistered: false, description: "The beta POST contract is documented, but package detail exposes no owner field for required provider readback." },
  },
  {
    id: "graph.directory.read", displayName: "Directory lookup", purpose: "Resolve users and groups for exact package access assignments.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "delegated",
    permissions: ["User.ReadBasic.All", "Group.Read.All"], providerRoles: [], licenses: [], configuration: ["Delegated consent"],
    sources: [directorySource], dataClass: "directory", internalRoles: operator, consentGroup: "graph.directory.read",
    probe: { kind: "provider_read", adapterRegistered: true, description: "Bounded directory lookup through the existing adapter." },
  },
  {
    id: "powerPlatform.inventory.read", displayName: "Power Platform inventory", purpose: "Read tenant Power Platform resource inventory on explicit request.",
    provider: "Power Platform", maturity: "v1.0", cloud: "global", audience: powerPlatformAudience, mode: "delegated",
    permissions: ["ResourceQuery.Resources.Read"], providerRoles: ["Global Administrator", "Power Platform Administrator", "Dynamics 365 Administrator", "Global Reader", "AI Administrator", "AI Reader"],
    licenses: [], configuration: ["Power Platform inventory access", "AI roles are limited to AI-scoped resources"], sources: [inventorySource], dataClass: "inventory", internalRoles: reader,
    consentGroup: "powerPlatform.inventory.read", probe: { kind: "provider_read", adapterRegistered: true, description: "Bounded Power Platform environment inventory query." },
  },
  {
    id: "powerPlatform.quarantine.manage", displayName: "Copilot Studio quarantine", purpose: "Read and change quarantine for an exact supported Copilot Studio agent.",
    provider: "Power Platform", maturity: "v1.0", cloud: "global", audience: powerPlatformAudience, mode: "delegated",
    permissions: ["CopilotStudio.AdminActions.Invoke"], providerRoles: ["Global Administrator", "AI Administrator", "Power Platform Administrator"], licenses: [],
    configuration: ["Classic bots are unsupported", "Explicit quarantine and restore qualification"], sources: [quarantineSource], dataClass: "package_control", internalRoles: operator,
    consentGroup: "powerPlatform.quarantine.manage", probe: { kind: "provider_read", adapterRegistered: true, description: "Capability refresh verifies delegated consent and a supported provider role without selecting a bot or calling quarantine status; direct status is an explicit target-scoped action and writes require separate full-cycle qualification." },
  },
  {
    id: "purview.audit.search.delegated", displayName: "Purview audit search", purpose: "Run a bounded, user-requested Microsoft Purview audit search.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "delegated", permissions: ["AuditLogsQuery.Read.All"],
    providerRoles: ["Audit Logs", "View-Only Audit Logs"], licenses: ["Microsoft Purview Audit entitlement controls retention and bandwidth"], configuration: ["Audit enabled"],
    sources: [auditSource], dataClass: "provider_audit", internalRoles: securityReader, consentGroup: "purview.audit.search",
    probe: { kind: "live_qualification", adapterRegistered: true, description: "Requires a separately approved bounded create, poll, and list-records lifecycle; routine refresh never creates a query." },
  },
  {
    id: "purview.audit.search.application", displayName: "Purview application audit search", purpose: "Run an explicitly requested audit search under approved application data scope.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "application", permissions: ["AuditLogsQuery.Read.All"], providerRoles: [],
    licenses: ["Microsoft Purview Audit entitlement controls retention and bandwidth"], configuration: ["Audit enabled", "Administrator-enabled application mode", "Administrator-approved shared data scope"],
    sources: [auditSource], dataClass: "provider_audit", internalRoles: securityReader,
    probe: { kind: "live_qualification", adapterRegistered: true, description: "Requires a separately approved bounded create, poll, and list-records lifecycle under the approved application scope; routine refresh never creates a query." },
  },
  {
    id: "defender.hunting.delegated", displayName: "Defender hunting", purpose: "Run a curated, bounded Defender advanced hunting query on behalf of the signed-in user.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "delegated", permissions: ["ThreatHunting.Read.All"],
    providerRoles: ["Defender XDR RBAC and data-source assignment"], licenses: ["Microsoft Defender XDR and applicable Agent 365 or service licensing"], configuration: [],
    sources: [huntingSource], dataClass: "hunting", internalRoles: securityReader, consentGroup: "defender.hunting",
    probe: { kind: "live_qualification", adapterRegistered: true, description: "Requires one separately approved bounded fixed-template hunt using query/projection contract v3; routine capability refresh never runs hunting KQL." },
  },
  {
    id: "defender.hunting.application", displayName: "Defender application hunting", purpose: "Run an explicitly requested curated hunt under approved application data scope.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "application", permissions: ["ThreatHunting.Read.All"], providerRoles: [],
    licenses: ["Microsoft Defender XDR and applicable Agent 365 or service licensing"], configuration: ["Administrator-enabled application mode", "Administrator-approved shared data scope"],
    sources: [huntingSource], dataClass: "hunting", internalRoles: securityReader,
    probe: { kind: "live_qualification", adapterRegistered: true, description: "Requires one separately approved bounded fixed-template hunt using query/projection contract v3 under the exact application data scope; routine refresh never runs hunting KQL." },
  },
  {
    id: "reports.official.import", displayName: "Official report import", purpose: "Validate and import administrator-supplied Microsoft 365 usage CSV reports.",
    provider: "Local", maturity: "local", cloud: "local", audience: "agent-control", mode: "local", permissions: [], providerRoles: [], licenses: [],
    configuration: ["Administrator-submitted files", "Tenant-shared aggregate and role-restricted user-level data"], sources: [reportsSource], dataClass: "report_import", internalRoles: administrator,
    probe: { kind: "local_policy", adapterRegistered: true, description: "Local authorization policy only; no Microsoft token or probe." },
  },
] as const;

const definitions = new Map(capabilityDefinitions.map(definition => [definition.id, definition]));

export function getCapabilityDefinition(id: string): CapabilityDefinition | undefined {
  return definitions.get(id as CapabilityId);
}

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && (appRoles as readonly string[]).includes(value);
}

export function hasAnyRole(actual: readonly AppRole[], required: readonly AppRole[]) {
  return required.some(role => actual.includes(role));
}

export function resolveCapabilityStatus(statuses: readonly CapabilityStatus[]): CapabilityStatus {
  const precedence: CapabilityStatus[] = [
    "missing_internal_role", "not_configured", "preview_disabled", "missing_permission", "missing_role",
    "missing_license", "unsupported", "provider_error", "unknown", "available",
  ];
  return precedence.find(status => statuses.includes(status)) ?? "unknown";
}

if (definitions.size !== capabilityIds.length) throw new Error("Capability IDs must be unique and complete.");