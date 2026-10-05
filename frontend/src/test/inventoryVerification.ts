import type { InventorySnapshotVerification, PowerPlatformResourceType, UnifiedAgentInventoryVerification, UnifiedAgentInventoryPage } from "../api/client";
import { reports } from "./reportDataFixture";

export function inventoryPageMetadata(counts: UnifiedAgentInventoryPage["counts"] = { total: 0, scoped: 0, filtered: 0, packageTargets: 0 },
  expiresAt = "2030-01-01T00:00:00.000Z"): Pick<UnifiedAgentInventoryPage, "selection" | "page" | "counts" | "freshness" | "usageContext" | "inventoryOverview"> {
  return {
    selection: { id: "20000000-0000-4000-8000-000000000002", revision: "1",
      evaluatedAt: "2026-09-20T12:00:00.000Z", expiresAt },
    page: { limit: 50, nextCursor: null, previousCursor: null }, counts,
    freshness: { state: "idle", capturedRevision: "1", sources: [] },
    usageContext: { revision: "1", expiresAt, reports: { ...reports, setId: null, activeSetId: null,
      availability: "never_imported", lineages: [], expiresAt: null, reportingPeriod: null, acceptedAt: null,
      acceptedAgeDays: null, periodAgeDays: null } },
    inventoryOverview: { availableToUsers: 0, organizationCreated: 0, teamsAvailable: 0, createdOrAvailable: 0 },
  };
}

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
