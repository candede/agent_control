import { packageFacets } from "../db/packageInventory.js";
import { formatAgentAuthoringTool, normalizePackageAuthoringTool } from "../types/copilotPackage.js";
import type { UnifiedAgentInventoryPage } from "../types/unifiedAgents.js";
import { buildBoundedCsv } from "./csvExport.js";

export function buildUnifiedAgentCsv(inventory: UnifiedAgentInventoryPage, deadlineAt: number) {
  const environments = new Map(inventory.facets.environments.map(value => [value.value.toLowerCase(), value.label]));
  const columns = [
    "agentId", "displayName", "environmentId", "environmentName", "builtWith", "packageIds", "packageStates",
    "nativeResourceId", "publicationStatus", "quarantineStatus", "identityState", "identityEvidence",
    "inventoryPartial", "inventoryRevision", "powerPlatformSnapshotId", "powerPlatformObservedAt",
    "inventoryVerificationStatus", "inventoryVerificationScope", "inventoryVerifiedAt",
    "inventorySourceCount", "inventoryUniqueSourceCount", "inventoryLogicalAgentCount", "inventoryVerificationChecks",
  ] as const;
  const rows = inventory.value.map(record => {
    const platforms = packageFacets(record.packages).platforms.map(value => value.label);
    if (record.powerPlatformResource?.authoringTool) platforms.push(formatAgentAuthoringTool(record.powerPlatformResource.authoringTool));
    const builtWith = [...new Map(platforms.map(value => [normalizePackageAuthoringTool(value), value])).values()].sort();
    return {
      agentId: record.id,
      displayName: record.displayName,
      environmentId: record.environmentId,
      environmentName: record.environmentId ? environments.get(record.environmentId.toLowerCase()) ?? record.environmentId : null,
      builtWith: builtWith.join("; "),
      packageIds: JSON.stringify(record.packages.map(value => value.id)),
      packageStates: JSON.stringify(record.packages.map(value => ({
        packageId: value.id, isBlocked: value.isBlocked, availableTo: value.availableTo ?? null,
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
    };
  });
  return buildBoundedCsv(columns, rows, { maximumRows: 5_000, maximumBytes: 8_000_000, deadlineAt });
}
