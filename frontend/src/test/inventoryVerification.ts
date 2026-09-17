import type { InventorySnapshotVerification, PowerPlatformResourceType, UnifiedAgentInventoryVerification } from "../api/client";

export function createInventoryVerification(
  storedCount: number,
  queriedTypes: PowerPlatformResourceType[] = ["microsoft.copilotstudio/agents"],
  checkedAt = "2026-09-17T06:00:00.000Z",
): InventorySnapshotVerification {
  return {
    status: "verified", scope: "authorized_query", basis: "provider_total_and_saved_rows",
    checkedAt, storedCount, uniqueIdentityCount: storedCount, queriedTypes,
  };
}

export function createUnifiedVerification(
  counts: Pick<UnifiedAgentInventoryVerification, "graphPackageCount" | "powerPlatformAgentCount" | "logicalAgentCount">,
  checks: Partial<Omit<UnifiedAgentInventoryVerification["checks"], "sourceMemberships">> = {},
  checkedAt = "2026-09-17T06:00:00.000Z",
): UnifiedAgentInventoryVerification {
  const sourceCount = counts.graphPackageCount + counts.powerPlatformAgentCount;
  const verifiedChecks = { sourceScopes: true, packageMetadata: true, identityLinks: true, sourceMemberships: true as const, ...checks };
  return {
    status: Object.values(verifiedChecks).every(Boolean) ? "verified" : "needs_attention",
    scope: "authorized_saved_sources", checkedAt,
    graphPackageCount: counts.graphPackageCount,
    powerPlatformAgentCount: counts.powerPlatformAgentCount,
    logicalAgentCount: counts.logicalAgentCount,
    representedSourceCount: sourceCount, uniqueSourceCount: sourceCount, checks: verifiedChecks,
  };
}
