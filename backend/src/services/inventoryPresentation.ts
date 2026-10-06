import type { InventoryQueries } from "../db/inventoryQueries.js";
import type { CopilotPackage } from "../types/copilotPackage.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import type { UnifiedAgentInventoryPage, UnifiedAgentInventorySummary,
  UnifiedAgentPackageObservation, UnifiedAgentPowerPlatformObservation, UnifiedAgentRecord, UnifiedAgentSourceStatus } from "../types/unifiedAgents.js";

type Page = Awaited<ReturnType<InventoryQueries["page"]>>;
type Source = Page["freshness"]["sources"][number];
function observation(source: Source) {
  return { id: source.generation_id, snapshotId: source.generation_id,
    observedAt: new Date(source.catalog_observed_at ?? source.observed_at).toISOString(),
    expiresAt: new Date(source.catalog_expires_at ?? source.expires_at).toISOString(), current: source.current === true };
}
function status(source: Source | undefined, kind: "graph_packages" | "power_platform"): UnifiedAgentSourceStatus {
  if (!source) return { state: "unavailable", observation: null,
    error: { source: kind, code: "snapshot_unavailable", message: "No complete authorized saved source is available." } };
  const common = observation(source);
  if (kind === "graph_packages") return {
    state: "available", error: null, observation: { ...common, tokenMode: source.token_mode, scopeKind: source.catalog_complete ? "broad" : "exact",
      observedCount: Number(source.row_count), totalRecords: Number(source.row_count) },
  };
  const covered = source.catalog_complete && source.resource_types.includes("microsoft.copilotstudio/agents");
  const value: UnifiedAgentPowerPlatformObservation = { ...common, roleScope: source.role_scope, environmentScope: source.environment_id,
    coverage: covered ? "covered" : "not_requested", coveredCount: covered ? Number(source.agent_count) : null,
    observedCount: Number(source.row_count), totalRecords: Number(source.row_count), pageCount: source.page_count,
    verification: { status: "verified", scope: "authorized_query", basis: "provider_total_and_saved_rows", checkedAt: common.observedAt,
      storedCount: Number(source.row_count), uniqueIdentityCount: Number(source.row_count), queriedTypes: source.resource_types } };
  return covered ? { state: "available", observation: value, error: null }
    : { state: "partial", observation: value, error: { source: kind, code: "coverage_unknown",
      message: "The captured source does not contain a complete authorized agent query." } };
}

export function inventoryPresentation(page: Page): UnifiedAgentInventoryPage {
  const { graphPackages: graph, powerPlatform: native } = inventorySourceStatuses(page.freshness.sources);
  const counts = page.verificationCounts;
  const partial = page.partial || graph.state === "unavailable" || native.state !== "available";
  const pendingPackages = counts.packages - counts.checked_packages;
  const identityLinks = page.summary.ambiguous === 0 && page.summary.conflicting === 0;
  const sourceScopes = !partial && counts.represented === counts.unique_sources;
  const value: UnifiedAgentRecord[] = page.value.map(row => {
    const packages = row.members.filter(member => member.domain === "packages");
    const resource = row.members.find(member => member.domain === "power_platform");
    const nativeSource = resource ? page.freshness.sources.find(source => source.scope_id === resource.scope_id) : undefined;
    const nativeObservation = nativeSource ? status(nativeSource, "power_platform").observation as UnifiedAgentPowerPlatformObservation : null;
    return { id: `agent:${row.id}`, displayName: row.displayName, presence: row.presence, environmentId: row.environmentId,
      environment: row.environment, people: row.people,
      usage: { recordId: `agent:${row.id}`, reportSetId: page.reports.setId,
        status: !page.reports.setId ? "unavailable" : row.associationCount ? "linked" : "unlinked",
        responses: row.responses, activeUsers: row.activeUsers, associationCount: row.associationCount,
        lastActivityDateUtc: row.lastActivity === null ? null : new Date(Number(row.lastActivity)).toISOString() },
      columns: row.columns, memberCount: row.members.reduce((sum, member) => sum + Number(member.total), 0),
      packageCount: packages.reduce((sum, member) => sum + Number(member.total), 0),
      packagesComplete: packages.every(member => Number(member.total) === 1),
      packages: packages.map(member => member.residual as CopilotPackage),
      powerPlatformResource: resource ? { ...resource.residual, identifiers: resource.identifiers,
        savedSource: { scopeId: resource.scope_id, identity: resource.source_identity },
        connectorCounts: resource.connector_counts,
        identifierCount: resource.identifier_count, identifiersComplete: resource.identifier_count === resource.identifiers.length,
        quarantineIdentity: resource.quarantine_identity } as PowerPlatformResource : null,
      identity: { state: row.linkState, evidence: row.members[0]?.evidence ?? [],
        packageEvidence: packages.map(member => ({ packageId: member.native_id, evidence: member.evidence })),
        reason: row.identity?.reason ?? null },
      observations: {
        graphPackages: graph.observation as UnifiedAgentPackageObservation | null,
        powerPlatform: resource && nativeObservation ? { ...nativeObservation,
          observedAt: new Date(resource.observed_at).toISOString(), expiresAt: new Date(resource.expires_at).toISOString() } : null,
        packageSnapshots: Object.fromEntries(packages.map(member => {
          const current = page.freshness.sources.find(source => source.scope_id === member.scope_id)?.current === true;
          const providerGeneration = member.catalog_generation ?? member.generation_id;
          const detail = member.residual.detailFreshness;
          return [member.native_id, {
            id: providerGeneration, snapshotId: providerGeneration, current,
            scopeKind: member.source_channel === "catalog" ? "broad" as const : "exact" as const,
            observedAt: new Date(member.observed_at).toISOString(), expiresAt: new Date(member.expires_at).toISOString(),
            identityDetails: member.detail_generation && detail?.observedAt && detail.expiresAt
              && ["fresh", "stale"].includes(detail.state) ? {
                id: member.detail_generation, snapshotId: member.detail_generation, observedAt: detail.observedAt,
                expiresAt: detail.expiresAt, current: current && detail.state === "fresh"
                  && Date.parse(detail.expiresAt) > Date.parse(String(page.selection.evaluatedAt)),
              } : null,
          }];
        })),
      },
    };
  });
  return { value, inventoryScope: page.inventoryScope,
    usageContext: { reports: page.reports, revision: page.selection.id,
      expiresAt: new Date(page.selection.expiresAt as string).toISOString() },
    counts: page.counts, page: page.page, selection: { id: page.selection.id, revision: String(page.selection.revision),
      evaluatedAt: new Date(page.selection.evaluatedAt as string).toISOString(), expiresAt: new Date(page.selection.expiresAt as string).toISOString() },
    freshness: page.freshness,
    summary: page.summary as UnifiedAgentInventorySummary, scopeSummary: page.scopeSummary as UnifiedAgentInventorySummary,
    filteredSummary: page.filteredSummary as UnifiedAgentInventorySummary,
    inventoryOverview: page.inventoryOverview as UnifiedAgentInventoryPage["inventoryOverview"],
    sources: { graphPackages: graph, powerPlatform: native }, partial,
    errors: [graph.error, native.error].filter((error): error is NonNullable<typeof error> => error !== null),
    identityCollection: { checkedPackages: counts.checked_packages, pendingPackages,
      pendingDetails: { missing: Math.max(0, pendingPackages - counts.stale_packages - counts.invalidated_packages),
        stale: counts.stale_packages, invalidated: counts.invalidated_packages } },
    verification: { status: !sourceScopes || !identityLinks ? "needs_attention" : pendingPackages ? "details_pending" : "verified", scope: "authorized_saved_sources",
      checkedAt: new Date(page.selection.evaluatedAt as string).toISOString(), graphPackageCount: counts.packages,
      powerPlatformAgentCount: counts.native_agents, representedSourceCount: counts.represented,
      uniqueSourceCount: counts.unique_sources, logicalAgentCount: page.counts.total,
      checks: { sourceScopes, packageMetadata: pendingPackages === 0, identityLinks, sourceMemberships: true } },
  };
}

export function inventorySourceStatuses(sources: Source[]) {
  return { graphPackages: status(sources.find(source => source.source === "inventory_packages"), "graph_packages"),
    powerPlatform: status(sources.find(source => source.source === "inventory_power_platform"), "power_platform") };
}
