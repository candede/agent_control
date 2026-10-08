import type { InventorySnapshotVerification, PowerPlatformResourceType, UnifiedAgentInventoryVerification, UnifiedAgentInventoryPage } from "../api/client";

export function inventoryPageMetadata(counts: UnifiedAgentInventoryPage["counts"] = { total: 0, scoped: 0, filtered: 0, packageTargets: 0 },
  expiresAt = "2030-01-01T00:00:00.000Z",
  selection: Partial<Omit<UnifiedAgentInventoryPage["selection"], "expiresAt">> = {},
): Pick<UnifiedAgentInventoryPage, "selection" | "page" | "counts" | "freshness" | "usageContext" | "inventoryOverview"> {
  const captured = { id: "20000000-0000-4000-8000-000000000002", revision: "1",
    evaluatedAt: "2026-09-20T12:00:00.000Z", validatedAt: selection.evaluatedAt ?? "2026-09-20T12:00:00.000Z",
    publicationRevisions: { graph_packages: "1".repeat(64), power_platform: "2".repeat(64), users: "3".repeat(64) }, ...selection, expiresAt };
  return {
    selection: captured,
    page: { limit: 50, nextCursor: null, previousCursor: null }, counts: { ...counts },
    freshness: { state: "idle", capturedRevision: captured.revision, sources: [] },
    usageContext: { revision: captured.id, expiresAt, reports: { setId: null, activeSetId: null,
      activeRevision: "0", historyRevision: "0", historyEpoch: "0", staleAfterDays: 7,
      availability: "never_imported", lineages: [], expiresAt: null, reportingPeriod: null, acceptedAt: null,
      acceptedAgeDays: null, periodAgeDays: null } },
    inventoryOverview: { availableToUsers: 0, organizationCreated: 0, teamsAvailable: 0, createdOrAvailable: 0 },
  };
}

export function createInventoryVerification(
  storedCount: number,
  queriedTypes: readonly PowerPlatformResourceType[] = ["microsoft.copilotstudio/agents"],
  checkedAt = "2026-09-17T06:00:00.000Z",
): InventorySnapshotVerification {
  return {
    status: "verified", scope: "authorized_query", basis: "provider_total_and_saved_rows",
    checkedAt, storedCount, uniqueIdentityCount: storedCount, queriedTypes: [...queriedTypes],
  };
}

export function createUnifiedVerification(
  counts: Pick<UnifiedAgentInventoryVerification, "graphPackageCount" | "powerPlatformAgentCount" | "logicalAgentCount">,
  checks: Partial<Omit<UnifiedAgentInventoryVerification["checks"], "sourceMemberships">> = {},
  checkedAt = "2026-09-17T06:00:00.000Z",
  identityCollection?: UnifiedAgentInventoryPage["identityCollection"],
): UnifiedAgentInventoryVerification {
  const sourceCount = counts.graphPackageCount + counts.powerPlatformAgentCount;
  const verifiedChecks = { sourceScopes: true, packageMetadata: true, identityLinks: true, sourceMemberships: true as const, ...checks };
  const invalidPackages = identityCollection?.invalidPackages ?? 0;
  if (identityCollection) {
    verifiedChecks.packageMetadata = identityCollection.pendingPackages === 0 && invalidPackages === 0;
  }
  return {
    status: !verifiedChecks.sourceScopes || !verifiedChecks.identityLinks || invalidPackages > 0
      ? "needs_attention" : !verifiedChecks.packageMetadata ? "details_pending" : "verified",
    scope: "authorized_saved_sources", checkedAt,
    graphPackageCount: counts.graphPackageCount,
    powerPlatformAgentCount: counts.powerPlatformAgentCount,
    logicalAgentCount: counts.logicalAgentCount,
    representedSourceCount: sourceCount, uniqueSourceCount: sourceCount, checks: verifiedChecks,
  };
}
