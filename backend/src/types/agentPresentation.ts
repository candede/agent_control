import { formatAgentAuthoringTool, formatPackageFacetLabel, normalizePackageStatus, type CopilotPackage } from "./copilotPackage.js";
import { powerPlatformAuthoringTool } from "./powerPlatformInventory.js";
import type { SavedAgentPerson, UnifiedAgentRecord, UnifiedAgentSort, UnifiedAgentView } from "./unifiedAgents.js";

export type AgentRelevanceReason = "organization_created" | "organization_shared" | "microsoft" | "deployed" | "reported_usage";
export type AgentColumnValue = string | number | null;

const originLabels = new Map<string, string>([
  ["microsoft", "Microsoft"],
  ["external", "Third-party"],
  ["shared", "Shared in organization"],
  ["custom", "Organization-created"],
]);

export function agentRelevanceReasons(record: UnifiedAgentRecord): AgentRelevanceReason[] {
  const reasons = new Set<AgentRelevanceReason>();
  if (record.powerPlatformResource) reasons.add("organization_created");
  for (const item of record.packages) {
    switch (item.type?.trim().toLowerCase()) {
      case "custom": reasons.add("organization_created"); break;
      case "shared": reasons.add("organization_shared"); break;
      case "microsoft": reasons.add("microsoft"); break;
    }
    const deployment = normalizePackageStatus(item.deployedTo);
    if (deployment === "all" || deployment === "some") reasons.add("deployed");
  }
  if (record.usage?.status === "linked" && (record.usage.responses ?? 0) > 0) reasons.add("reported_usage");
  return [...reasons];
}

export function matchesAgentView(record: UnifiedAgentRecord, view: UnifiedAgentView = "all") {
  if (view === "all") return true;
  if (view === "available" || view === "unavailable") return agentUserAvailability(record) === view;
  if (view === "availability_unknown") return agentUserAvailability(record) === "unknown";
  if (view === "used") return record.usage?.status === "linked" && (record.usage.responses ?? 0) > 0;
  const reasons = agentRelevanceReasons(record);
  return view === "organization" ? reasons.length > 0 : reasons.length === 0;
}

function packageAvailableToUsers(item: CopilotPackage) {
  const availability = normalizePackageStatus(item.availableTo);
  return item.isBlocked === false && (availability === "all" || availability === "some");
}

export function agentUserAvailability(record: UnifiedAgentRecord): "available" | "unavailable" | "unknown" {
  if (record.powerPlatformResource?.details.isQuarantined === true) return "unavailable";
  if (record.packages.some(packageAvailableToUsers)) return "available";
  if (record.packages.length > 0 && record.packages.every(item =>
    item.isBlocked === true || normalizePackageStatus(item.availableTo) === "none")) return "unavailable";
  return "unknown";
}

export function agentUserAvailabilityLabel(record: UnifiedAgentRecord): string | null {
  const availability = agentUserAvailability(record);
  if (availability === "unknown") return null;
  if (availability === "unavailable") return "Not available";
  return record.packages.some(item => packageAvailableToUsers(item) && normalizePackageStatus(item.availableTo) === "all")
    ? "All users" : "Specific users or groups";
}

export function summarizeAgentAvailability(records: readonly UnifiedAgentRecord[]) {
  let availableToUsers = 0;
  let organizationCreated = 0;
  let teamsAvailable = 0;
  let createdOrAvailable = 0;
  for (const record of records) {
    if (agentUserAvailability(record) === "available") availableToUsers += 1;
    const created = agentRelevanceReasons(record).includes("organization_created");
    const available = record.packages.some(item => {
      const availability = normalizePackageStatus(item.availableTo);
      return item.isBlocked === false && (availability === "all" || availability === "some")
        && item.supportedHosts?.some(host => host.trim().toLowerCase() === "teams");
    });
    if (created) organizationCreated += 1;
    if (available) teamsAvailable += 1;
    if (created || available) createdOrAvailable += 1;
  }
  return { availableToUsers, organizationCreated, teamsAvailable, createdOrAvailable };
}

export function agentAccessLabel(value: string | undefined): string | null {
  switch (normalizePackageStatus(value)) {
    case "all": return "All users";
    case "some": return "Specific users or groups";
    case "none": return "No users";
    default: return null;
  }
}

export function agentAccessSummary(record: UnifiedAgentRecord, target: "availableTo" | "deployedTo") {
  const values = [...new Set(record.packages.map(item => agentAccessLabel(item[target])))];
  return values.length === 0 ? null : values.length === 1 ? values[0]
    : values.includes(null) ? "Partially known" : "Varies by package";
}

export function agentStatusLabels(record: UnifiedAgentRecord): string[] {
  const states = record.packages.map(item => item.isBlocked === true ? "Blocked" : item.isBlocked === false ? "Not blocked" : "Block status unknown");
  const distinct = [...new Set(states)];
  const blockStatus = distinct.length === 1 ? distinct[0] : distinct.length > 1
    ? distinct.map(state => `${states.filter(value => value === state).length} ${state.toLowerCase()}`).join(" · ")
    : undefined;
  const resource = record.powerPlatformResource;
  return [
    ...(blockStatus ? [blockStatus] : []),
    ...(resource ? [
      resource.lifecycle === "published" ? "Published" : resource.lifecycle === "draft" ? "Draft" : "Publication status unknown",
      resource.details.isQuarantined === true ? "Quarantined" : resource.details.isQuarantined === false ? "Not quarantined" : "Quarantine status unknown",
    ] : []),
  ];
}

export function packageAuthoringTool(item: Pick<CopilotPackage, "authoringTool" | "platform" | "shortDescription">) {
  return item.authoringTool ?? item.platform ?? item.shortDescription?.trim().match(/^built\s+using\s+(.+?)\.?$/i)?.[1]?.trim();
}

export function agentAuthoringToolLabels(record: UnifiedAgentRecord) {
  return uniqueValues([record.powerPlatformResource ? powerPlatformAuthoringTool(record.powerPlatformResource) : null,
    ...record.packages.map(packageAuthoringTool)], formatAgentAuthoringTool);
}

export function agentPersonLabel(person: SavedAgentPerson | undefined, nativeId: string | null | undefined): string | null {
  if (!person || !nativeId || person.objectId.toLowerCase() !== nativeId.trim().toLowerCase()) return nativeId ?? null;
  const name = person.displayName && person.userPrincipalName ? `${person.displayName} (${person.userPrincipalName})`
    : person.displayName || person.userPrincipalName || nativeId;
  return person.status === "not_found" ? `${nativeId} (not found)`
    : person.status === "lookup_failed" ? `${name} (lookup failed)` : name;
}

export function agentColumnValue(record: UnifiedAgentRecord, column: UnifiedAgentSort, environmentNames: Readonly<Record<string, string>> = {}): AgentColumnValue {
  const resource = record.powerPlatformResource;
  const details = resource?.details;
  switch (column) {
    case "displayName": return record.displayName;
    case "environment": return record.environmentId ? environmentNames[record.environmentId.toLowerCase()] || record.environmentId : null;
    case "builtWith": return agentAuthoringToolLabels(record).join(" / ") || null;
    case "availability": return agentUserAvailabilityLabel(record);
    case "status": {
      const hasKnownStatus = record.packages.some(item => typeof item.isBlocked === "boolean")
        || resource?.lifecycle === "published" || resource?.lifecycle === "draft"
        || typeof details?.isQuarantined === "boolean";
      return hasKnownStatus ? uniqueText(agentStatusLabels(record), undefined, false) : null;
    }
    case "hosts": return uniqueText(record.packages.flatMap(item => item.supportedHosts ?? []), formatPackageFacetLabel);
    case "publisher": return uniqueText([...record.packages.map(item => item.publisher), details?.publisher]);
    case "origin": return partiallyKnownText([
      ...record.packages.map(item => originLabels.get(item.type?.trim().toLowerCase() ?? "")),
      ...(resource ? ["Organization-created"] : []),
    ]);
    case "deployment": return agentAccessSummary(record, "deployedTo");
    case "owner": return agentPersonLabel(record.people?.owner, details?.ownerId);
    case "createdBy": return agentPersonLabel(record.people?.createdBy, resource?.createdBy);
    case "createdAt": return dateValue(resource?.createdAt ? [resource.createdAt] : record.packages.map(item => item.createdDateTime), "earliest");
    case "lastModifiedAt": return dateValue([details?.lastModifiedAt, resource?.lastPublishedAt, resource?.createdAt,
      ...record.packages.map(item => item.lastModifiedDateTime)]);
    case "lastPublishedAt": return dateValue([resource?.lastPublishedAt]);
    case "agentType": return uniqueText([...record.packages.flatMap(item => item.elementTypes ?? []), resource?.agentKind], formatPackageFacetLabel);
    case "versions": return partiallyKnownText(record.packages.map(item => item.version));
    case "publication": return resource?.lifecycle === "published" ? "Published" : resource?.lifecycle === "draft" ? "Draft" : null;
    case "quarantine": return details?.isQuarantined === undefined ? null : details.isQuarantined ? "Quarantined" : "Not quarantined";
    case "location": return resource?.location ?? null;
    case "model": return details?.model ?? null;
    case "authentication": return details?.authentication ?? null;
    case "channels": return details?.channels?.length === 0 ? "None reported" : uniqueText(details?.channels ?? [], formatPackageFacetLabel);
    case "orchestration": return details?.orchestration ?? null;
    case "webSearch": return booleanLabel(details?.isWebSearchEnabledForKnowledge);
    case "managed": return booleanLabel(details?.isManaged);
    case "source": return record.presence === "both" ? "Graph and Power Platform" : record.presence === "graph_packages" ? "Graph packages" : "Power Platform";
    case "observedAt": return dateValue([
      record.observations.powerPlatform?.observedAt,
      record.observations.graphPackages?.observedAt,
      ...Object.values(record.observations.packageSnapshots).map(item => item.observedAt),
    ]);
    case "linkState": return formatPackageFacetLabel(record.identity.state);
    case "responses": return record.usage?.status === "linked" ? record.usage.responses : null;
    case "activeUsers": return record.usage?.status === "linked" ? record.usage.activeUsers : null;
    case "lastActivity": return record.usage?.status === "linked" ? dateValue([record.usage.lastActivityDateUtc]) : null;
  }
}

function uniqueText(values: readonly (string | null | undefined)[], format?: (value: string) => string, sort = true) {
  return uniqueValues(values, format, sort).join(" / ") || null;
}

function partiallyKnownText(values: readonly (string | null | undefined)[]) {
  return values.some(value => value?.trim()) ? uniqueText(values.map(value => value?.trim() || "Unknown")) : null;
}

function uniqueValues(values: readonly (string | null | undefined)[], format?: (value: string) => string, sort = true) {
  const distinct = [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map(value => format ? format(value.trim()) : value.trim()))];
  if (sort) distinct.sort((left, right) => left.localeCompare(right, "en-US", { sensitivity: "base" }));
  return distinct;
}

function dateValue(values: readonly (string | null | undefined)[], direction: "earliest" | "latest" = "latest") {
  const timestamps = values.filter((value): value is string => Boolean(value)).map(value => {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) throw new RangeError("Saved agent inventory contains an invalid timestamp.");
    return timestamp;
  });
  return timestamps.length ? (direction === "earliest" ? Math.min(...timestamps) : Math.max(...timestamps)) : null;
}

function booleanLabel(value: boolean | undefined) {
  return value === undefined ? null : value ? "Yes" : "No";
}
