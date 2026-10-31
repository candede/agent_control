import {
  appRoles,
  capabilityIds,
  hasAppRole,
  type AppRole,
  type CapabilityDefinition,
  type CapabilityId,
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
const copilotUsageReportSource = "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/reports/copilotreportroot-getmicrosoft365copilotusageuserdetail";

const viewer: AppRole[] = ["AgentControl.Viewer"];
const admin: AppRole[] = ["AgentControl.Admin"];

export const capabilityDefinitions: readonly CapabilityDefinition[] = [
  {
    id: "graph.package.read.delegated", displayName: "Package control readback", purpose: "Reconcile an administrator's exact package-control result using the administrator's delegated authority; ordinary collection uses application access.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "delegated",
    permissions: ["CopilotPackages.ReadWrite.All"], providerRoles: [], licenses: ["Microsoft Agent 365"],
    configuration: ["Delegated consent"], sources: [packageDetailSource], dataClass: "package_control", internalRoles: admin,
    consentGroup: "graph.package.manage", probe: { kind: "on_demand", adapterRegistered: true, description: "Reconcile an exact previously submitted control. Microsoft authorizes the delegated request when it runs." },
  },
  {
    id: "graph.package.read.application", displayName: "Package inventory", purpose: "Collect tenant-shared packages and package details using the application identity.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "application",
    permissions: ["CopilotPackages.Read.All"], acceptedPermissions: ["CopilotPackages.ReadWrite.All"], providerRoles: [], licenses: ["Microsoft Agent 365"],
    configuration: ["Tenant application credentials", "Application admin consent"], sources: [packageListSource, packageDetailSource], dataClass: "inventory", internalRoles: viewer,
    probe: { kind: "provider_read", adapterRegistered: true, description: "Response-size/time-bounded package catalog first-page read using an application token and the documented filter, without following pagination." },
  },
  {
    id: "graph.package.access.manage", displayName: "Package access management", purpose: "Change exact package availability or installation assignments.",
    provider: "Microsoft Graph", maturity: "preview", cloud: "global", audience: graphAudience, mode: "delegated",
    permissions: ["CopilotPackages.ReadWrite.All"], providerRoles: [], licenses: ["Microsoft Agent 365"], configuration: ["Delegated consent"],
    sources: [packageAccessSource], dataClass: "package_control", internalRoles: admin, consentGroup: "graph.package.manage",
    probe: { kind: "on_demand", adapterRegistered: true, description: "Choose an exact package and confirm the access change. Microsoft authorizes the delegated request when it runs." },
  },
  {
    id: "graph.package.block.manage", displayName: "Package block management", purpose: "Block or unblock an exact package target.",
    provider: "Microsoft Graph", maturity: "preview", cloud: "global", audience: graphAudience, mode: "delegated",
    permissions: ["CopilotPackages.ReadWrite.All"], providerRoles: [], licenses: ["Microsoft Agent 365"], configuration: ["Delegated consent"],
    sources: [packageBlockSource, packageUnblockSource], dataClass: "package_control", internalRoles: admin, consentGroup: "graph.package.manage",
    probe: { kind: "on_demand", adapterRegistered: true, description: "Choose an exact package and confirm block or unblock. Microsoft authorizes the delegated request when it runs." },
  },
  {
    id: "graph.package.reassign.manage", displayName: "Package reassignment", purpose: "Reassign package ownership; this adapter is not implemented.",
    provider: "Microsoft Graph", maturity: "preview", cloud: "global", audience: graphAudience, mode: "delegated",
    permissions: ["CopilotPackages.ReadWrite.All"], providerRoles: [], licenses: ["Microsoft Agent 365"], configuration: ["A supported owner readback contract"],
    sources: [packageReassignSource, packageDetailSource], dataClass: "package_control", internalRoles: admin, consentGroup: "graph.package.manage",
    probe: { kind: "not_registered", adapterRegistered: false, description: "The beta POST contract is documented, but package detail exposes no owner field for required provider readback." },
  },
  {
    id: "graph.directory.read", displayName: "Management group lookup", purpose: "Find and validate groups for exact administrative package access assignments.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "delegated",
    permissions: ["Group.Read.All"], providerRoles: [], licenses: [], configuration: ["Delegated consent"],
    sources: [directorySource], dataClass: "directory", internalRoles: viewer, consentGroup: "graph.directory.read",
    probe: { kind: "on_demand", adapterRegistered: true, description: "Explicit management group lookup. Microsoft authorizes the delegated request when it runs." },
  },
  {
    id: "graph.users.read", displayName: "User lookup", purpose: "Find and validate management user recipients and resolve exact agent creators and owners using read-only application access.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "application",
    permissions: ["User.Read.All"], providerRoles: [], licenses: [],
    configuration: ["Tenant application credentials", "Application admin consent"],
    sources: [directorySource], dataClass: "directory", internalRoles: viewer,
    probe: { kind: "on_demand", adapterRegistered: true, description: "Exact user resolution uses application permissions; no signed-in user's Microsoft directory role is required." },
  },
  {
    id: "graph.agentIdentity.read", displayName: "Agent identity resolution", purpose: "Explicitly verify one saved Copilot Studio Entra agent identity for scoped investigations.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "delegated",
    permissions: ["AgentIdentity.Read.All"], providerRoles: ["Agent ID Administrator (for nonowners)"], licenses: [],
    configuration: ["Delegated consent", "An exact current source-declared Copilot Studio Entra agent identity"],
    sources: ["https://learn.microsoft.com/en-us/graph/api/agentidentity-get?view=graph-rest-1.0",
      "https://learn.microsoft.com/en-us/graph/api/resources/agentidentity?view=graph-rest-1.0",
      "https://learn.microsoft.com/en-us/entra/agent-id/agent-identities#authorizing-agent-identities",
      "https://learn.microsoft.com/en-us/microsoft-agent-365/developer/direct-open-telemetry-integration#s2s-blueprint-derived-agent-identity"],
    dataClass: "directory", internalRoles: viewer, consentGroup: "graph.agentIdentity.read",
    probe: { kind: "on_demand", adapterRegistered: true, description: "Only an explicit resolve action reads the typed agentIdentity endpoint; context reads use saved mappings. Microsoft authorizes the delegated request when it runs." },
  },
  {
    id: "graph.licenses.read", displayName: "M365 Copilot licenses", purpose: "Read Copilot-capable product assignments and verify active paid Microsoft 365 Copilot features using application access, separately from basic Copilot Chat access.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "application",
    permissions: ["User.Read.All", "LicenseAssignment.Read.All"], providerRoles: [], licenses: [], configuration: ["Tenant application credentials", "Application admin consent"],
    sources: ["https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0", "https://learn.microsoft.com/en-us/graph/api/subscribedsku-list?view=graph-rest-1.0"], dataClass: "licensed_usage", internalRoles: viewer,
    probe: { kind: "on_demand", adapterRegistered: true, description: "Explicit Users sync checks filtered directory candidates and paid-feature evidence in bulk; a containing product assignment alone is not Copilot entitlement. Microsoft authorizes the application request when it runs." },
  },
  {
    id: "powerPlatform.inventory.read", displayName: "Power Platform inventory", purpose: "Read tenant Power Platform resource inventory on explicit request.",
    provider: "Power Platform", maturity: "v1.0", cloud: "global", audience: powerPlatformAudience, mode: "delegated",
    permissions: ["ResourceQuery.Resources.Read"], providerRoles: ["Global Administrator", "Power Platform Administrator", "Dynamics 365 Administrator", "Global Reader", "AI Administrator", "AI Reader"],
    licenses: [], configuration: ["Power Platform inventory access", "AI roles are limited to AI-scoped resources"], sources: [inventorySource], dataClass: "inventory", internalRoles: viewer,
    consentGroup: "powerPlatform.inventory.read", probe: { kind: "provider_read", adapterRegistered: true, description: "Bounded Power Platform environment inventory query." },
  },
  {
    id: "powerPlatform.quarantine.read", displayName: "Copilot Studio quarantine status", purpose: "Read quarantine status for an exact supported Copilot Studio agent.",
    provider: "Power Platform", maturity: "v1.0", cloud: "global", audience: powerPlatformAudience, mode: "delegated",
    permissions: ["CopilotStudio.AdminActions.Invoke"], providerRoles: ["Global Administrator", "AI Administrator", "Power Platform Administrator"], licenses: [],
    configuration: ["Classic bots are unsupported", "Microsoft authorizes each exact provider request; optional ID-token role claims are not used as a grant"], sources: [quarantineSource], dataClass: "inventory", internalRoles: viewer,
    consentGroup: "powerPlatform.quarantine.manage", probe: { kind: "provider_read", adapterRegistered: true, description: "Capability refresh verifies delegated token acquisition without selecting a bot; Microsoft authorizes the explicit target-scoped status request." },
  },
  {
    id: "powerPlatform.quarantine.manage", displayName: "Copilot Studio quarantine", purpose: "Read and change quarantine for an exact supported Copilot Studio agent.",
    provider: "Power Platform", maturity: "v1.0", cloud: "global", audience: powerPlatformAudience, mode: "delegated",
    permissions: ["CopilotStudio.AdminActions.Invoke"], providerRoles: ["Global Administrator", "AI Administrator", "Power Platform Administrator"], licenses: [],
    configuration: ["Classic bots are unsupported", "Microsoft authorizes each exact provider request; optional ID-token role claims are not used as a grant"], sources: [quarantineSource], dataClass: "package_control", internalRoles: admin,
    consentGroup: "powerPlatform.quarantine.manage", probe: { kind: "on_demand", adapterRegistered: true, description: "Choose an exact agent and confirm quarantine or restore. Microsoft authorizes the delegated request when it runs." },
  },
  {
    id: "purview.audit.search.delegated", displayName: "Purview audit search", purpose: "Run a bounded, user-requested Microsoft Purview audit search.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "delegated", permissions: ["AuditLogsQuery.Read.All"],
    providerRoles: ["Audit Logs", "View-Only Audit Logs"], licenses: ["Microsoft Purview Audit entitlement controls retention and bandwidth"], configuration: ["Audit enabled"],
    sources: [auditSource], dataClass: "provider_audit", internalRoles: viewer, consentGroup: "purview.audit.search",
    probe: { kind: "on_demand", adapterRegistered: true, description: "Run a bounded search directly. Microsoft authorizes the create, poll, and records requests when they run." },
  },
  {
    id: "purview.audit.search.application", displayName: "Purview application audit search", purpose: "Run an explicitly requested audit search under approved application data scope.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "application", permissions: ["AuditLogsQuery.Read.All"], providerRoles: [],
    licenses: ["Microsoft Purview Audit entitlement controls retention and bandwidth"], configuration: ["Audit enabled", "Admin-enabled application mode", "Admin-approved shared data scope"],
    sources: [auditSource], dataClass: "provider_audit", internalRoles: viewer,
    probe: { kind: "on_demand", adapterRegistered: true, description: "Run the requested search with an application token in the configured shared data scope." },
  },
  {
    id: "defender.hunting.delegated", displayName: "Defender hunting", purpose: "Run a curated, bounded Defender advanced hunting query on behalf of the signed-in user.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "delegated", permissions: ["ThreatHunting.Read.All"],
    providerRoles: ["Defender XDR RBAC and data-source assignment"], licenses: ["Microsoft Defender XDR and applicable Agent 365 or service licensing"], configuration: [],
    sources: [huntingSource], dataClass: "hunting", internalRoles: viewer, consentGroup: "defender.hunting",
    probe: { kind: "on_demand", adapterRegistered: true, description: "Run a bounded fixed-template hunt directly. Microsoft authorizes provider access when the request runs." },
  },
  {
    id: "defender.hunting.application", displayName: "Defender application hunting", purpose: "Run an explicitly requested curated hunt under approved application data scope.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "application", permissions: ["ThreatHunting.Read.All"], providerRoles: [],
    licenses: ["Microsoft Defender XDR and applicable Agent 365 or service licensing"], configuration: ["Admin-enabled application mode", "Admin-approved shared data scope"],
    sources: [huntingSource], dataClass: "hunting", internalRoles: viewer,
    probe: { kind: "on_demand", adapterRegistered: true, description: "Run the requested hunt with an application token in the configured shared data scope." },
  },
  {
    id: "reports.copilotUsage.read", displayName: "Microsoft 365 Copilot app activity", purpose: "Read the D28 per-user Microsoft 365 Copilot app activity report using application access; this does not replace the three agent-usage CSV reports.",
    provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: graphAudience, mode: "application",
    permissions: ["Reports.Read.All"], providerRoles: [], licenses: [],
    configuration: ["Tenant application credentials", "Application admin consent", "Microsoft 365 usage report privacy settings can conceal user identities"],
    sources: [copilotUsageReportSource], dataClass: "licensed_usage", internalRoles: viewer,
    probe: { kind: "on_demand", adapterRegistered: true, description: "Users sync validates the bounded report request; saved dashboard reads and background capability checks never scan the report." },
  },
  {
    id: "reports.official.import", displayName: "Import reports", purpose: "Upload, validate and publish new Microsoft 365 usage CSV report sets. Replacing and deleting saved reports requires Admin.",
    provider: "Local", maturity: "local", cloud: "local", audience: "agent-control", mode: "local", permissions: [], providerRoles: [], licenses: [],
    configuration: ["UsageReportUploader or Admin-submitted files", "Tenant-shared aggregate and user-level data"], sources: [reportsSource], dataClass: "report_import", internalRoles: ["AgentControl.UsageReportUploader"],
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
  return required.some(role => hasAppRole(actual, role));
}

if (definitions.size !== capabilityIds.length) throw new Error("Capability IDs must be unique and complete.");