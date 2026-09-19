import { agentAuthoringToolLabels, agentColumnValue } from "../types/agentPresentation.js";
import type { UnifiedAgentInventoryPage, UnifiedAgentSort } from "../types/unifiedAgents.js";
import { buildBoundedCsv } from "./csvExport.js";

export function buildUnifiedAgentCsv(inventory: UnifiedAgentInventoryPage, deadlineAt: number) {
  const environments = new Map(inventory.facets.environments.map(value => [value.value.toLowerCase(), value.label]));
  const columns = [
    "agentId", "displayName", "environmentId", "environmentName", "builtWith", "packageIds", "packageStates",
    "nativeResourceId", "publicationStatus", "quarantineStatus", "identityState", "identityEvidence",
    "inventoryPartial", "inventoryRevision", "powerPlatformSnapshotId", "powerPlatformObservedAt",
    "inventoryVerificationStatus", "inventoryVerificationScope", "inventoryVerifiedAt",
    "inventorySourceCount", "inventoryUniqueSourceCount", "inventoryLogicalAgentCount", "inventoryVerificationChecks",
    "hosts", "publisher", "origin", "availability", "installedFor", "owner", "createdBy", "createdAt", "lastModifiedAt",
    "lastPublishedAt", "agentType", "versions", "region", "model", "authentication", "channels", "orchestration",
    "webSearch", "managedSolution", "source", "lastObservedAt",
    "usageStatus", "responses", "activeUsers", "lastActivityDateUtc", "usageReportSetId", "usageAvailability",
    "usageReportPeriodStart", "usageReportPeriodEnd", "usageReportPeriodProvenance", "usageReportAcceptedAt",
    "usageRevision", "usageAssociations",
  ] as const;
  const rows = inventory.value.map(record => {
    const value = (key: UnifiedAgentSort) => agentColumnValue(record, key);
    const date = (key: "createdAt" | "lastModifiedAt" | "lastPublishedAt" | "observedAt") => {
      const timestamp = value(key);
      return typeof timestamp === "number" ? new Date(timestamp).toISOString() : null;
    };
    return {
      agentId: record.id,
      displayName: record.displayName,
      environmentId: record.environmentId,
      environmentName: record.environmentId ? environments.get(record.environmentId.toLowerCase()) ?? record.environmentId : null,
      builtWith: agentAuthoringToolLabels(record).join("; "),
      packageIds: JSON.stringify(record.packages.map(value => value.id)),
      packageStates: JSON.stringify(record.packages.map(value => ({
        packageId: value.id, version: value.version ?? null, isBlocked: value.isBlocked, availableTo: value.availableTo ?? null,
        deployedTo: value.deployedTo ?? null, publisher: value.publisher ?? null,
        supportedHosts: value.supportedHosts ?? [],
        snapshotId: record.observations.packageSnapshots[value.id]?.snapshotId ?? null,
        observedAt: record.observations.packageSnapshots[value.id]?.observedAt ?? null,
      }))),
      nativeResourceId: record.powerPlatformResource?.nativeId,
      publicationStatus: record.powerPlatformResource?.lifecycle ?? "unknown",
      quarantineStatus: !record.powerPlatformResource ? "not_observed"
        : typeof record.powerPlatformResource.details.isQuarantined !== "boolean" ? "unknown"
          : record.powerPlatformResource.details.isQuarantined ? "quarantined" : "not_quarantined",
      identityState: record.identity.state,
      identityEvidence: JSON.stringify(record.identity.packageEvidence),
      inventoryPartial: inventory.partial,
      inventoryRevision: inventory.revision,
      inventoryVerificationStatus: inventory.verification.status,
      inventoryVerificationScope: inventory.verification.scope,
      inventoryVerifiedAt: inventory.verification.checkedAt,
      inventorySourceCount: inventory.verification.representedSourceCount,
      inventoryUniqueSourceCount: inventory.verification.uniqueSourceCount,
      inventoryLogicalAgentCount: inventory.verification.logicalAgentCount,
      inventoryVerificationChecks: JSON.stringify(inventory.verification.checks),
      powerPlatformSnapshotId: record.observations.powerPlatform?.snapshotId,
      powerPlatformObservedAt: record.observations.powerPlatform?.observedAt,
      hosts: value("hosts"),
      publisher: value("publisher"),
      origin: value("origin"),
      availability: value("availability"),
      installedFor: value("deployment"),
      owner: value("owner"),
      createdBy: value("createdBy"),
      createdAt: date("createdAt"),
      lastModifiedAt: date("lastModifiedAt"),
      lastPublishedAt: date("lastPublishedAt"),
      agentType: value("agentType"),
      versions: value("versions"),
      region: value("location"),
      model: value("model"),
      authentication: value("authentication"),
      channels: value("channels"),
      orchestration: value("orchestration"),
      webSearch: value("webSearch"),
      managedSolution: value("managed"),
      source: value("source"),
      lastObservedAt: date("observedAt"),
      usageStatus: record.usage?.status ?? "unavailable",
      responses: record.usage?.responses,
      activeUsers: record.usage?.activeUsers,
      lastActivityDateUtc: record.usage?.lastActivityDateUtc,
      usageReportSetId: record.usage?.reportSetId,
      usageAvailability: inventory.usageContext?.availability ?? "unavailable",
      usageReportPeriodStart: inventory.usageContext?.reportSet?.reportingPeriod.startDate,
      usageReportPeriodEnd: inventory.usageContext?.reportSet?.reportingPeriod.endDate,
      usageReportPeriodProvenance: inventory.usageContext?.reportSet?.reportingPeriod.provenance,
      usageReportAcceptedAt: inventory.usageContext?.reportSet?.acceptedAt,
      usageRevision: inventory.usageContext?.revision,
      usageAssociations: JSON.stringify(record.usage?.associations ?? []),
    };
  });
  return buildBoundedCsv(columns, rows, { maximumRows: 5_000, maximumBytes: 8_000_000, deadlineAt });
}
