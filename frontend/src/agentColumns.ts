import { unifiedAgentSortKeys, type UnifiedAgentSort } from "../../backend/src/types/unifiedAgents";

export const agentViewOptions = [
  { value: "all", label: "All agents in repository", description: "All agents in saved repository and Power Platform data, whether or not users can access them." },
  { value: "available", label: "Available to end users", description: "Unblocked agents available to all or selected users, excluding known quarantined agents. Access is based on saved settings, not proof of use or an individual user's permissions." },
  { value: "unavailable", label: "Not available to end users", description: "Agents known to be blocked, quarantined, or available to no users." },
  { value: "availability_unknown", label: "End-user access unknown", description: "Agents without enough saved access information. Creation, publication, installation or past usage alone does not establish access." },
  { value: "organization", label: "Organization-related agents", description: "Organization-created or shared agents, Microsoft agents, and agents with installation or reported usage. This does not establish end-user access." },
  { value: "used", label: "Used in selected report", description: "Agents with positive responses in the selected Microsoft 365 report, matched automatically by exact saved package ID or through an existing administrator-reviewed association. This is not a live or all-channel activity measure." },
  { value: "unknown", label: "No organization or usage evidence", description: "Agents without known organizational origin, installation or linked usage. This does not establish end-user access." },
] as const;

export type AgentColumnId = UnifiedAgentSort | "actions";
export type AgentColumnFormat = "text" | "date" | "number";
export type AgentColumnGroup = "Overview" | "Usage" | "Ownership" | "Configuration" | "Diagnostics";
export type AgentColumnDefinition = {
  id: AgentColumnId;
  label: string;
  group: AgentColumnGroup;
  format?: AgentColumnFormat;
  description?: string;
};

export const agentColumns: readonly AgentColumnDefinition[] = [
  { id: "displayName", label: "Agent", group: "Overview" },
  { id: "environment", label: "Environment", group: "Overview" },
  { id: "builtWith", label: "Built with", group: "Overview" },
  { id: "availability", label: "End-user access", group: "Overview", description: "Saved access settings, accounting for blocking and known quarantine. Specific users or groups does not mean everyone has access." },
  { id: "status", label: "Status", group: "Overview" },
  { id: "hosts", label: "Hosts", group: "Overview", description: "Supported hosts, not evidence of usage in each host." },
  { id: "publisher", label: "Publisher", group: "Overview" },
  { id: "origin", label: "Origin", group: "Overview" },
  { id: "deployment", label: "Installed for", group: "Overview", description: "Deployment scope, not an installed-user count." },
  { id: "responses", label: "Responses", group: "Usage", format: "number", description: "Total responses in the selected report; not lifetime usage." },
  { id: "activeUsers", label: "Active users", group: "Usage", format: "number", description: "Distinct response-producing user identities in the selected report." },
  { id: "lastActivity", label: "Last used", group: "Usage", format: "date", description: "Last reported activity by anyone; may fall outside the reporting period." },
  { id: "owner", label: "Owner", group: "Ownership", description: "Saved owner identifier when reported by Power Platform." },
  { id: "createdBy", label: "Created by", group: "Ownership" },
  { id: "createdAt", label: "Created", group: "Ownership", format: "date" },
  { id: "lastModifiedAt", label: "Modified", group: "Ownership", format: "date", description: "Latest native/package modification, publication or native creation timestamp." },
  { id: "lastPublishedAt", label: "Last published", group: "Ownership", format: "date" },
  { id: "agentType", label: "Agent type", group: "Configuration" },
  { id: "versions", label: "Versions", group: "Configuration" },
  { id: "publication", label: "Publication", group: "Configuration" },
  { id: "quarantine", label: "Quarantine", group: "Configuration" },
  { id: "location", label: "Region", group: "Configuration" },
  { id: "model", label: "Model", group: "Configuration" },
  { id: "authentication", label: "Authentication", group: "Configuration" },
  { id: "channels", label: "Channels", group: "Configuration" },
  { id: "orchestration", label: "Orchestration", group: "Configuration" },
  { id: "webSearch", label: "Web search", group: "Configuration" },
  { id: "managed", label: "Managed solution", group: "Configuration" },
  { id: "source", label: "Source", group: "Diagnostics" },
  { id: "observedAt", label: "Last observed", group: "Diagnostics", format: "date" },
  { id: "linkState", label: "Identity link", group: "Diagnostics" },
  { id: "actions", label: "Actions", group: "Overview" },
];

const defaultColumns = new Set<AgentColumnId>(["displayName", "environment", "builtWith", "availability", "status", "actions"]);
export const defaultAgentColumnVisibility: Record<string, boolean> = Object.fromEntries(agentColumns.map(column => [column.id, defaultColumns.has(column.id)]));
export const agentColumnGroups: readonly AgentColumnGroup[] = ["Overview", "Usage", "Ownership", "Configuration", "Diagnostics"];

export function isAgentSort(value: string): value is UnifiedAgentSort {
  return unifiedAgentSortKeys.some(key => key === value);
}

export const agentSortOptions = [
  { value: "displayName:asc", label: "Name (A-Z)", sortBy: "displayName" as const, direction: "asc" as const },
  { value: "displayName:desc", label: "Name (Z-A)", sortBy: "displayName" as const, direction: "desc" as const },
  { value: "lastModifiedAt:desc", label: "Modified (newest)", sortBy: "lastModifiedAt" as const, direction: "desc" as const },
  { value: "lastModifiedAt:asc", label: "Modified (oldest)", sortBy: "lastModifiedAt" as const, direction: "asc" as const },
  ...agentColumns.flatMap(column => isAgentSort(column.id) && column.id !== "displayName" && column.id !== "lastModifiedAt" ? [
    { value: `${column.id}:asc`, label: `${column.label} (ascending)`, sortBy: column.id, direction: "asc" as const },
    { value: `${column.id}:desc`, label: `${column.label} (descending)`, sortBy: column.id, direction: "desc" as const },
  ] : []),
];

export function loadAgentColumns(owner?: string): { visibility: Record<string, boolean>; error?: string } {
  if (!owner) return { visibility: { ...defaultAgentColumnVisibility } };
  try {
    const raw = window.localStorage.getItem(storageKey(owner));
    if (raw === null) return { visibility: { ...defaultAgentColumnVisibility } };
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== "object" || !("version" in saved) || saved.version !== 1
      || !("visibility" in saved) || !saved.visibility || typeof saved.visibility !== "object" || Array.isArray(saved.visibility)) {
      throw new Error("Column preferences have an unsupported format.");
    }
    const visibility = { ...defaultAgentColumnVisibility };
    for (const [key, value] of Object.entries(saved.visibility)) {
      if (!agentColumns.some(column => column.id === key) || typeof value !== "boolean") throw new Error("Column preferences contain an unsupported column.");
      visibility[key] = value;
    }
    visibility.displayName = true;
    return { visibility };
  } catch (error) {
    return { visibility: { ...defaultAgentColumnVisibility }, error: `Column preferences could not be loaded. Default columns are shown. ${error instanceof Error ? error.message : "Browser storage is unavailable."}` };
  }
}

export function saveAgentColumns(owner: string | undefined, visibility: Record<string, boolean>): string | undefined {
  if (!owner) return undefined;
  try {
    window.localStorage.setItem(storageKey(owner), JSON.stringify({ version: 1, visibility }));
    return undefined;
  } catch {
    return "Column preferences could not be saved. Your choices apply to this page but may not survive a reload.";
  }
}

function storageKey(owner: string) {
  return `agent-control:unified-agent-columns:v1:${encodeURIComponent(owner)}`;
}
