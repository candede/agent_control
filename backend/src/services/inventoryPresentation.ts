import type { InventoryQueries } from "../db/inventoryQueries.js";
import type { CopilotPackage } from "../types/copilotPackage.js";
import { isPackageProviderUsage } from "../types/copilotPackage.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { isAgentComponentCounts, isMakerSharing, isNullableInventoryCount } from "../types/powerPlatformInventory.js";
import { packageSummary } from "./inventoryComponent.js";
import { AppError } from "../errors.js";
import { dataLimitError, dataLimits } from "../db/dataBounds.js";
import type { PackageAgentLinkEvidence } from "./packageAgentIdentity.js";
import { inventoryGuidPattern, normalizeEnvironmentIdentity, normalizeNativeIdentity } from "./inventoryIdentity.js";
import { compareInventoryTimestamps, inventoryTimestamp } from "./inventoryTimestamp.js";
import type { UnifiedAgentInventoryPage, UnifiedAgentInventorySummary,
  UnifiedAgentPackageObservation, UnifiedAgentPowerPlatformObservation, UnifiedAgentRecord, UnifiedAgentSourceStatus } from "../types/unifiedAgents.js";

type Page = Awaited<ReturnType<InventoryQueries["page"]>>;
type Source = Page["freshness"]["sources"][number];
function invalid(message: string): never {
  throw new AppError(500, "saved_source_invalid", message);
}
function savedCount(value: unknown, positive = false): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))) {
    return invalid("Saved inventory contains an invalid count.");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < (positive ? 1 : 0)) return invalid("Saved inventory contains an invalid count.");
  return count;
}

export function inventoryObservation(id: string, observed: string | Date, expires: string | Date, authority: boolean,
  evaluatedAt: string | Date) {
  if (typeof id !== "string" || !id || typeof authority !== "boolean") return invalid("Saved inventory observation provenance is invalid.");
  const observedAt = inventoryTimestamp(observed), expiresAt = inventoryTimestamp(expires);
  if (compareInventoryTimestamps(observedAt, expiresAt) >= 0) return invalid("Saved inventory observation expires before it was observed.");
  const evaluation = inventoryTimestamp(evaluatedAt);
  return { id, snapshotId: id, observedAt, expiresAt,
    current: authority && compareInventoryTimestamps(observedAt, evaluation) <= 0 };
}

function status(source: Source | undefined, kind: "graph_packages" | "power_platform", evaluatedAt: string | Date): UnifiedAgentSourceStatus {
  if (!source) return { state: "unavailable", observation: null,
    error: { source: kind, code: "snapshot_unavailable", message: "No complete authorized saved source is available." } };
  const common = inventoryObservation(source.generation_id, source.observed_at, source.expires_at, source.current, evaluatedAt);
  const rowCount = savedCount(source.row_count);
  if (rowCount > dataLimits.sourceRows) throw dataLimitError("inventory_source_rows", dataLimits.sourceRows, rowCount);
  if (source.expected_count !== null && source.expected_count !== undefined) savedCount(source.expected_count);
  if (typeof source.catalog_complete !== "boolean" || typeof source.catalog_scope_complete !== "boolean" || typeof source.complete !== "boolean") {
    return invalid("Saved inventory source completeness is invalid.");
  }
  if (source.catalog_scope_complete === true && (!source.catalog_observed_at || !source.catalog_expires_at)) {
    return invalid("Saved catalog source observation provenance is unavailable.");
  }
  if (source.catalog_observed_at !== null && source.catalog_observed_at !== undefined
    || source.catalog_expires_at !== null && source.catalog_expires_at !== undefined) {
    const catalog = inventoryObservation(source.generation_id, source.catalog_observed_at, source.catalog_expires_at, source.current, evaluatedAt);
    if (!catalog.current) source = { ...source, catalog_complete: false };
  }
  const complete = source.catalog_complete && source.complete;
  const error = !common.current ? { source: kind, code: "snapshot_stale" as const,
    message: "The selected saved source is stale or no longer authoritative. Refresh it in Data sync." }
    : !complete ? { source: kind, code: "coverage_unknown" as const,
      message: "The captured source does not contain a complete authorized catalog query." } : null;
  if (kind === "graph_packages") {
    if (!["delegated", "application"].includes(source.token_mode)) return invalid("Saved Graph source token mode is invalid.");
    const value: UnifiedAgentPackageObservation = { ...common, tokenMode: source.token_mode,
      scopeKind: source.catalog_scope_complete ? "broad" : "exact", observedCount: rowCount, totalRecords: rowCount };
    return error ? { state: "partial", observation: value, error } : { state: "available", observation: value, error: null };
  }
  if (!Array.isArray(source.resource_types) || new Set(source.resource_types).size !== source.resource_types.length
    || source.resource_types.some((type: unknown) => typeof type !== "string"
      || !["microsoft.copilotstudio/agents", "microsoft.powerplatform/environments"].includes(type))
    || !["full", "ai", "unknown"].includes(source.role_scope)
    || source.environment_id !== null && typeof source.environment_id !== "string") return invalid("Saved native source scope is invalid.");
  const requested = source.resource_types.includes("microsoft.copilotstudio/agents");
  const agentCount = savedCount(source.agent_count), pageCount = savedCount(source.page_count);
  if (pageCount > dataLimits.pages) throw dataLimitError("inventory_source_pages", dataLimits.pages, pageCount);
  if (agentCount > rowCount || !requested && agentCount !== 0) return invalid("Saved native source counts disagree with its requested types.");
  const expectedCount = source.expected_count === null ? null : savedCount(source.expected_count);
  if (source.channel === "catalog" && source.complete && expectedCount !== null && expectedCount !== rowCount) {
    return invalid("Saved native provider total disagrees with its stored records.");
  }
  const verified = complete && common.current && source.channel === "catalog" && expectedCount === rowCount && pageCount > 0;
  const covered = verified && requested;
  const value: UnifiedAgentPowerPlatformObservation = { ...common, roleScope: source.role_scope, environmentScope: source.environment_id,
    coverage: covered ? "covered" : requested ? "unknown" : "not_requested", coveredCount: covered ? agentCount : null,
    observedCount: rowCount, totalRecords: rowCount, pageCount,
    verification: verified ? { status: "verified", scope: "authorized_query", basis: "provider_total_and_saved_rows", checkedAt: common.observedAt,
      storedCount: rowCount, uniqueIdentityCount: rowCount, queriedTypes: source.resource_types } : null };
  return covered ? { state: "available", observation: value, error: null }
    : { state: "partial", observation: value, error: error ?? { source: kind, code: "coverage_unknown",
      message: "The captured source does not contain a complete authorized agent query." } };
}

export function inventoryPresentation(page: Page): UnifiedAgentInventoryPage {
  const evaluatedAt = inventoryTimestamp(page.selection.evaluatedAt as string | Date);
  const expiresAt = inventoryTimestamp(page.selection.expiresAt as string | Date);
  if (compareInventoryTimestamps(evaluatedAt, expiresAt) >= 0) return invalid("Saved inventory selection expiry is invalid.");
  if (page.value.length > dataLimits.pageRows) throw dataLimitError("inventory_presentation_rows", dataLimits.pageRows, page.value.length);
  const { graphPackages: graph, powerPlatform: native } = inventorySourceStatuses(page.freshness.sources, evaluatedAt);
  const counts = Object.fromEntries(["packages", "native_agents", "represented", "unique_sources", "checked_packages",
    "stale_packages", "invalidated_packages", "invalid_packages"].map(key => [key, savedCount(page.verificationCounts[key])]));
  validateSummaries(page);
  if (counts.checked_packages + counts.stale_packages + counts.invalidated_packages > counts.packages
    || counts.invalid_packages > counts.packages || counts.unique_sources > counts.represented) {
    return invalid("Saved inventory verification counts are inconsistent.");
  }
  const sourcePartial = page.partial || graph.state !== "available" || native.state !== "available"
    || page.freshness.state !== "idle";
  const pendingPackages = counts.packages - counts.checked_packages;
  const invalidPackages = counts.invalid_packages;
  const identityLinks = page.summary.ambiguous === 0 && page.summary.conflicting === 0;
  const nativeSource = native.observation as UnifiedAgentPowerPlatformObservation | null;
  const nativeSourceRow = nativeSource ? page.freshness.sources.find(source =>
    source.source === "inventory_power_platform" && source.generation_id === nativeSource.id) : undefined;
  const sourceMemberships = counts.represented === counts.unique_sources && counts.represented === counts.packages + counts.native_agents
    && counts.unique_sources >= page.counts.total
    && (counts.unique_sources === 0 ? page.counts.total === 0 : page.counts.total > 0)
    && counts.packages >= page.summary.linked + page.summary.graphOnly
    && counts.native_agents === page.summary.linked + page.summary.powerPlatformOnly
    && (counts.packages === 0 ? page.summary.linked + page.summary.graphOnly === 0 : page.summary.linked + page.summary.graphOnly > 0)
    && (graph.observation ? graph.observation.observedCount === counts.packages : counts.packages === 0)
    && (nativeSourceRow ? savedCount(nativeSourceRow.agent_count) === counts.native_agents : counts.native_agents === 0);
  const rowIds = new Set<string>(), visibleSources = new Set<string>();
  let visiblePackages = 0, visibleNativeAgents = 0;
  let memberSourcesAvailable = true, memberSourcesFresh = true;
  const value: UnifiedAgentRecord[] = page.value.map(row => {
    validateRow(row, evaluatedAt);
    if (rowIds.has(row.id)) return invalid("Saved inventory contains duplicate logical rows.");
    rowIds.add(row.id);
    for (const member of row.members) {
      const key = JSON.stringify([member.domain, member.scope_id, member.source_identity]);
      if (visibleSources.has(key)) return invalid("Saved inventory contains duplicate source memberships.");
      visibleSources.add(key);
      const kind = member.domain === "packages" ? "graph_packages" : "power_platform";
      const source = page.freshness.sources.find(source => source.scope_id === member.scope_id
        && source.source === (member.domain === "packages" ? "inventory_packages" : "inventory_power_platform"));
      memberSourcesAvailable &&= status(source, kind, evaluatedAt).state === "available";
      memberSourcesFresh &&= status(source ? { ...source, current: true } : undefined, kind, evaluatedAt).state === "available";
    }
    const packages = row.members.filter(member => member.domain === "packages");
    const resource = row.members.find(member => member.domain === "power_platform");
    const packageCount = packages.reduce((sum, member) => sum + savedCount(member.total, true), 0);
    visiblePackages += packageCount;
    visibleNativeAgents += Number(Boolean(resource));
    if (visiblePackages > counts.packages || visibleNativeAgents > counts.native_agents || rowIds.size > page.counts.total) {
      return invalid("Saved inventory previews exceed their full source accounting.");
    }
    const nativeSource = resource ? page.freshness.sources.find(source => source.source === "inventory_power_platform" && source.scope_id === resource.scope_id) : undefined;
    const nativeObservation = nativeSource ? status(nativeSource, "power_platform", evaluatedAt).observation as UnifiedAgentPowerPlatformObservation : null;
    return { id: `agent:${row.id}`, displayName: row.displayName, presence: row.presence, environmentId: row.environmentId,
      environment: row.environment ? { ...row.environment, observation: inventoryObservation(row.environment.observation.id,
        row.environment.observation.observedAt, row.environment.observation.expiresAt, row.environment.observation.current, evaluatedAt) } : null,
      people: row.people,
      usage: { recordId: `agent:${row.id}`, reportSetId: page.reports.setId,
        status: !page.reports.setId ? "unavailable" : savedCount(row.associationCount) ? "linked" : "unlinked",
        responses: row.responses === null ? null : savedCount(row.responses), activeUsers: row.activeUsers === null ? null : savedCount(row.activeUsers),
        associationCount: savedCount(row.associationCount),
        lastActivityDateUtc: row.lastActivity === null ? null : new Date(Number(row.lastActivity)).toISOString() },
      columns: row.columns, memberCount: row.members.reduce((sum, member) => sum + Number(member.total), 0),
      packageCount,
      packagesComplete: packages.every(member => Number(member.total) === 1),
      packages: packages.map(member => {
        const summary = packageSummary(member.residual as CopilotPackage), detail = summary.detailFreshness;
        if (detail?.state === "fresh" && !inventoryObservation(member.detail_generation, detail.observedAt!, detail.expiresAt!, true, evaluatedAt).current) {
          summary.detailFreshness = { ...detail, state: "stale" };
        }
        return summary;
      }),
      powerPlatformResource: resource ? { ...resource.residual, identifiers: resource.identifiers,
        savedSource: { scopeId: resource.scope_id, identity: resource.source_identity },
        connectorCounts: resource.connector_counts == null ? resource.connector_counts
          : { connectors: savedCount(resource.connector_counts.connectors), operations: savedCount(resource.connector_counts.operations) },
        identifierCount: savedCount(resource.identifier_count), identifiersComplete: savedCount(resource.identifier_count) === resource.identifiers.length,
        quarantineIdentity: resource.quarantine_identity } as PowerPlatformResource : null,
      identity: { state: row.linkState, evidence: resource?.evidence ?? [],
        packageEvidence: packages.map(member => ({ packageId: member.native_id, evidence: member.evidence })),
        reason: row.identity?.reason ?? null,
        ...(row.identity?.warnings?.length ? { warnings: structuredClone(row.identity.warnings) } : {}),
        ...(row.identity?.invalidMetadata === true ? { invalidMetadata: true } : {}) },
      observations: {
        graphPackages: packages.length ? graph.observation as UnifiedAgentPackageObservation | null : null,
        powerPlatform: resource && nativeObservation ? { ...nativeObservation,
          ...inventoryObservation(resource.generation_id, resource.observed_at, resource.expires_at, nativeObservation.current, evaluatedAt),
          verification: resource.generation_id === nativeSource?.generation_id ? nativeObservation.verification : null } : null,
        packageSnapshots: Object.fromEntries(packages.map(member => {
          const current = page.freshness.sources.some(source => source.source === "inventory_packages" && source.scope_id === member.scope_id
            && inventoryObservation(source.generation_id, source.observed_at, source.expires_at, source.current, evaluatedAt).current);
          const providerGeneration = member.catalog_generation ?? member.generation_id;
          const catalogObservedAt = member.catalog_observed_at ?? (member.catalog_generation ? null : member.observed_at);
          const catalogExpiresAt = member.catalog_expires_at ?? (member.catalog_generation ? null : member.expires_at);
          if (!catalogObservedAt || !catalogExpiresAt) {
            throw new AppError(500, "saved_source_invalid", "Saved package catalog observation provenance is unavailable.");
          }
          const detail = member.residual.detailFreshness;
          const catalogObservation = inventoryObservation(providerGeneration, catalogObservedAt, catalogExpiresAt, current, evaluatedAt);
          return [member.native_id, {
            ...catalogObservation,
            scopeKind: member.source_channel === "catalog" ? "broad" as const : "exact" as const,
            identityDetails: member.detail_generation && detail?.observedAt && detail.expiresAt
              && ["fresh", "stale"].includes(detail.state) ? {
                ...inventoryObservation(member.detail_generation, detail.observedAt, detail.expiresAt, catalogObservation.current, evaluatedAt),
              } : null,
          }];
        })),
      },
    };
  });
  const visiblePending = page.value.flatMap(row => row.members.filter(member => member.domain === "packages")).filter(member => {
    const detail = member.residual.detailFreshness;
    return member.residual.identityDetailsCollected !== true || detail && (!["fresh", "stale"].includes(detail.state)
      || !inventoryObservation(member.detail_generation, detail.observedAt, detail.expiresAt, true, evaluatedAt).current);
  }).length;
  if (visiblePending > pendingPackages || counts.invalid_packages === 0 && value.some(row => row.identity.invalidMetadata)) {
    return invalid("Saved package verification counts disagree with their selected member evidence.");
  }
  const partial = sourcePartial || !memberSourcesAvailable || value.some(row => row.powerPlatformResource !== null && !row.observations.powerPlatform?.current
    || Object.values(row.observations.packageSnapshots).some(observation => !observation.current));
  const sourceScopes = !partial;
  // Publication may supersede healthy captured revisions; their strict current/partial flags remain unchanged.
  const updating = ["stale", "catching_up", "reconciling"].includes(page.freshness.state) && !page.partial && memberSourcesFresh
    && Object.values(inventorySourceStatuses(page.freshness.sources.map(source => ({ ...source, current: true })), evaluatedAt))
      .every(source => source.state === "available")
    && value.every(row => [...Object.values(row.observations.packageSnapshots),
      ...(row.observations.powerPlatform ? [row.observations.powerPlatform] : [])]
      .every(observation => inventoryObservation(observation.id, observation.observedAt, observation.expiresAt, true, evaluatedAt).current));
  const verificationStatus = !sourceMemberships || !identityLinks || invalidPackages > 0 || !sourceScopes && !updating
    ? "needs_attention" : updating ? "updating" : pendingPackages ? "details_pending" : "verified";
  const result: UnifiedAgentInventoryPage = { value, inventoryScope: page.inventoryScope,
    usageContext: { reports: page.reports, revision: page.selection.id,
      expiresAt },
    counts: page.counts, page: page.page, selection: { id: page.selection.id, revision: String(page.selection.revision),
      evaluatedAt, expiresAt, validatedAt: new Date(page.selection.validatedAt as string).toISOString(),
      publicationRevisions: page.selection.publicationRevisions },
    freshness: page.freshness,
    summary: page.summary as UnifiedAgentInventorySummary, scopeSummary: page.scopeSummary as UnifiedAgentInventorySummary,
    filteredSummary: page.filteredSummary as UnifiedAgentInventorySummary,
    inventoryOverview: page.inventoryOverview as UnifiedAgentInventoryPage["inventoryOverview"],
    sources: { graphPackages: graph, powerPlatform: native }, partial,
    errors: [graph.error, native.error].filter((error): error is NonNullable<typeof error> => error !== null),
    identityCollection: { checkedPackages: counts.checked_packages, pendingPackages, invalidPackages,
      pendingDetails: { missing: pendingPackages - counts.stale_packages - counts.invalidated_packages,
        stale: counts.stale_packages, invalidated: counts.invalidated_packages } },
    verification: { status: verificationStatus, scope: "authorized_saved_sources",
      checkedAt: evaluatedAt, graphPackageCount: counts.packages,
      powerPlatformAgentCount: counts.native_agents, representedSourceCount: counts.represented,
      uniqueSourceCount: counts.unique_sources, logicalAgentCount: page.counts.total,
      checks: { sourceScopes, packageMetadata: pendingPackages === 0 && invalidPackages === 0, identityLinks, sourceMemberships } },
  };
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > dataLimits.batchBytes) throw dataLimitError("inventory_presentation_bytes", dataLimits.batchBytes, bytes);
  return structuredClone(result);
}

export function inventorySourceStatuses(sources: Source[], evaluatedAt: string | Date) {
  if (sources.length > dataLimits.roots) throw dataLimitError("inventory_source_limit", dataLimits.roots, sources.length);
  const scopes = sources.map(source => source.scope_id).filter(scope => scope !== undefined);
  if (new Set(scopes).size !== scopes.length) return invalid("Saved inventory contains duplicate source scopes.");
  const graph = sources.filter(source => source.source === "inventory_packages");
  if (graph.length > 1) return invalid("Saved inventory contains ambiguous Graph source scopes.");
  for (const source of sources) {
    if (!["inventory_packages", "inventory_power_platform"].includes(source.source)) return invalid("Saved inventory source is invalid.");
    status(source, source.source === "inventory_packages" ? "graph_packages" : "power_platform", evaluatedAt);
  }
  const native = sources.filter(source => source.source === "inventory_power_platform").sort((left, right) =>
    Number(right.resource_types.includes("microsoft.copilotstudio/agents")) - Number(left.resource_types.includes("microsoft.copilotstudio/agents"))
    || Number(right.environment_id === null) - Number(left.environment_id === null)
    || (left.catalog_observed_at && right.catalog_observed_at ? compareInventoryTimestamps(right.catalog_observed_at, left.catalog_observed_at)
      : Number(Boolean(right.catalog_observed_at)) - Number(Boolean(left.catalog_observed_at)))
    || (String(left.scope_id) < String(right.scope_id) ? -1 : String(left.scope_id) > String(right.scope_id) ? 1 : 0));
  return { graphPackages: status(graph[0], "graph_packages", evaluatedAt),
    powerPlatform: status(native[0], "power_platform", evaluatedAt) };
}

function validateSummaries(page: Page) {
  const summaries = [page.summary, page.scopeSummary, page.filteredSummary];
  for (const [index, summary] of summaries.entries()) {
    for (const key of ["total", "linked", "graphOnly", "powerPlatformOnly", "ambiguous", "conflicting"]) savedCount(summary[key]);
    if (summary.linked + summary.graphOnly + summary.powerPlatformOnly !== summary.total
      || summary.ambiguous + summary.conflicting > summary.total
      || index > 0 && Object.keys(summary).some(key => summary[key] > summaries[index - 1][key])) {
      return invalid("Saved inventory summaries are inconsistent.");
    }
  }
  for (const count of Object.values(page.counts)) savedCount(count);
  if (page.counts.total !== page.summary.total || page.counts.scoped !== page.scopeSummary.total
    || page.counts.filtered !== page.filteredSummary.total) return invalid("Saved inventory page counts disagree with its summaries.");
}

function validateEvidence(value: unknown): asserts value is PackageAgentLinkEvidence[] {
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object"
    || Object.keys(item).some(key => !["kind", "basis", "packagePath", "resourcePath", "elementIds", "relatedPackageIds"].includes(key))
    || !["entra_agent_id", "environment_entra_app_id", "environment_cds_bot_id", "environment_schema_native_id",
      "manifest_schema_native_id", "shared_custom_engine_bot_id"].includes(item.kind)
    || item.basis !== "source_declared_metadata" || typeof item.packagePath !== "string" || typeof item.resourcePath !== "string"
    || !Array.isArray(item.elementIds) || item.elementIds.some((id: unknown) => typeof id !== "string")
    || item.relatedPackageIds !== undefined && (!Array.isArray(item.relatedPackageIds) || item.relatedPackageIds.some((id: unknown) => typeof id !== "string")))) {
    return invalid("Saved inventory membership evidence is invalid.");
  }
}

function isSavedRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function savedIdentityText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\uD800-\uDFFF]/u.test(value);
}

function assertSavedJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || depth > 64 || ancestors.has(value)
    || !Array.isArray(value) && !isSavedRecord(value)) {
    return invalid("Saved inventory residual evidence is not bounded JSON data.");
  }
  ancestors.add(value);
  for (const child of Object.values(value)) assertSavedJson(child, ancestors, depth + 1);
  ancestors.delete(value);
}

function validateProvenance(value: unknown, sourceSystem: "graph_packages" | "power_platform") {
  if (!isSavedRecord(value) || Object.values(value).some(provenance => !isSavedRecord(provenance)
    || provenance.sourceSystem !== sourceSystem || typeof provenance.path !== "string"
    || typeof provenance.maturity !== "string" || !["ga", "preview", "observed"].includes(provenance.maturity))) {
    return invalid("Saved inventory field provenance is invalid.");
  }
}

const personObjectIdPattern = new RegExp(inventoryGuidPattern, "i");
function validatePeople(value: unknown) {
  if (!isSavedRecord(value)) return invalid("Saved directory person evidence is invalid.");
  for (const person of Object.values(value)) {
    if (!isSavedRecord(person) || typeof person.objectId !== "string" || person.objectId.length !== 36
      || !personObjectIdPattern.test(person.objectId)
      || person.displayName !== null && typeof person.displayName !== "string"
      || person.userPrincipalName !== null && typeof person.userPrincipalName !== "string"
      || person.errorCode !== undefined && typeof person.errorCode !== "string"
      || person.status !== undefined && (typeof person.status !== "string" || !["resolved", "not_found", "lookup_failed"].includes(person.status))
      || typeof person.observedAt !== "string") {
      return invalid("Saved directory person evidence is invalid.");
    }
    inventoryTimestamp(person.observedAt);
    for (const timestamp of [person.checkedAt, person.expiresAt]) {
      if (timestamp !== undefined) {
        if (typeof timestamp !== "string") return invalid("Saved directory person evidence is invalid.");
        inventoryTimestamp(timestamp);
      }
    }
    assertSavedJson(value);
  }
}

function validateEnvironment(value: unknown, environmentId: unknown, evaluatedAt: string) {
  if (value === null) return;
  if (!isSavedRecord(value) || !savedIdentityText(value.id) || !savedIdentityText(environmentId)
    || normalizeEnvironmentIdentity(value.id) !== normalizeEnvironmentIdentity(environmentId)) {
    return invalid("Saved environment evidence disagrees with the canonical inventory identity.");
  }
  if (["displayName", "region", "environmentType", "groupName", "groupId"].some(key => value[key] !== null && typeof value[key] !== "string")
    || value.isManaged !== null && typeof value.isManaged !== "boolean") {
    return invalid("Saved environment fields are invalid.");
  }
  const observation = value.observation;
  if (!isSavedRecord(observation) || typeof observation.id !== "string" || observation.snapshotId !== observation.id
    || typeof observation.observedAt !== "string" || typeof observation.expiresAt !== "string" || typeof observation.current !== "boolean") {
    return invalid("Saved environment observation provenance is invalid.");
  }
  inventoryObservation(observation.id, observation.observedAt, observation.expiresAt, observation.current, evaluatedAt);
  validateProvenance(value.provenance, "power_platform");
  assertSavedJson(value);
}

function validateIdentifier(value: unknown, nativeId: string, environmentId: unknown) {
  if (!isSavedRecord(value) || typeof value.kind !== "string"
    || !["power_platform_resource_id", "cds_bot_id", "entra_app_id", "entra_agent_id", "entra_blueprint_id",
      "environment_id", "package_id", "package_app_id", "manifest_id", "asset_id"].includes(value.kind)
    || !savedIdentityText(value.value)
    || value.kind === "power_platform_resource_id" && normalizeNativeIdentity(value.value) !== normalizeNativeIdentity(nativeId)
    || value.kind === "environment_id" && (!savedIdentityText(environmentId)
      || normalizeEnvironmentIdentity(value.value) !== normalizeEnvironmentIdentity(environmentId))) {
    return invalid("Saved inventory source identifiers are invalid.");
  }
  assertSavedJson(value);
}

function validateStringFields(value: Record<string, unknown>, fields: readonly string[]) {
  if (fields.some(field => value[field] !== undefined && typeof value[field] !== "string")) {
    return invalid("Saved inventory source text fields are invalid.");
  }
}

function validateBooleanFields(value: Record<string, unknown>, fields: readonly string[]) {
  if (fields.some(field => value[field] !== undefined && typeof value[field] !== "boolean")) {
    return invalid("Saved inventory source boolean fields are invalid.");
  }
}

function validateStringArray(value: unknown) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    return invalid("Saved inventory source collection is invalid.");
  }
}

function validatePackage(value: Record<string, unknown>, detailGeneration: unknown, evaluatedAt: string) {
  if (!savedIdentityText(value.id) || typeof value.isBlocked !== "boolean"
    || value.authoringTool !== null && typeof value.authoringTool !== "string"
    || value.creatorType !== "unknown" || value.agentKind !== "copilot_package"
    || value.lifecycle !== "unknown" || value.identityConfidence !== "exact_native") {
    return invalid("Saved package source fields are invalid.");
  }
  validateStringFields(value, ["type", "shortDescription", "publisher", "availableTo", "deployedTo", "platform",
    "version", "manifestVersion", "manifestId", "appId", "assetId", "createdDateTime", "lastModifiedDateTime"]);
  for (const field of ["ownerId", "agentIdentityId"]) {
    if (value[field] !== undefined && value[field] !== null && !savedIdentityText(value[field])) return invalid("Saved package observed identity metadata is invalid.");
  }
  if (value.providerUsage !== undefined && !isPackageProviderUsage(value.providerUsage)) return invalid("Saved package provider telemetry is invalid.");
  for (const field of ["supportedHosts", "elementTypes"]) if (value[field] !== undefined) validateStringArray(value[field]);
  for (const field of ["createdDateTime", "lastModifiedDateTime"]) {
    if (typeof value[field] === "string") inventoryTimestamp(value[field]);
  }
  for (const field of ["identityDetailsCollected", "identityRevalidationRequired"]) {
    if (value[field] !== undefined && value[field] !== true) return invalid("Saved package detail flags are invalid.");
  }
  if (value.controlObservations !== undefined) {
    if (!isSavedRecord(value.controlObservations)) return invalid("Saved package control observations are invalid.");
    for (const [kind, observation] of Object.entries(value.controlObservations)) {
      if (!["block", "access"].includes(kind) || !isSavedRecord(observation)
        || typeof observation.snapshotId !== "string" || typeof observation.observedAt !== "string"
        || typeof observation.expiresAt !== "string") return invalid("Saved package control observations are invalid.");
      inventoryObservation(observation.snapshotId, observation.observedAt, observation.expiresAt, false, evaluatedAt);
    }
  }
  const detail = value.detailFreshness;
  if (detail === undefined && !detailGeneration) return;
  if (!isSavedRecord(detail) || typeof detail.state !== "string" || !["fresh", "stale", "missing", "invalidated"].includes(detail.state)) {
    return invalid("Saved package detail observation provenance is unavailable.");
  }
  if (detail.state === "missing") {
    if (detailGeneration || detail.observedAt !== null || detail.expiresAt !== null || value.identityDetailsCollected === true) {
      return invalid("Saved missing package details contain collected evidence.");
    }
    return;
  }
  if (typeof detailGeneration !== "string" || typeof detail.observedAt !== "string" || typeof detail.expiresAt !== "string") {
    return invalid("Saved package detail observation provenance is unavailable.");
  }
  inventoryObservation(detailGeneration, detail.observedAt, detail.expiresAt, false, evaluatedAt);
}

function validateNativeResource(value: Record<string, unknown>, environmentId: string | null) {
  const nativeEnvironment = value.environmentId;
  if (nativeEnvironment !== null && !savedIdentityText(nativeEnvironment)) return invalid("Saved native environment identity is invalid.");
  if (!savedIdentityText(value.tenantId) || !savedIdentityText(value.nativeId)
    || ["displayName", "location", "authoringTool", "createdAt", "createdBy", "lastPublishedAt"]
      .some(field => value[field] !== null && typeof value[field] !== "string")
    || value.creatorType !== "unknown" || typeof value.agentKind !== "string"
    || typeof value.lifecycle !== "string" || !["draft", "published", "unknown", "not_applicable"].includes(value.lifecycle)
    || typeof value.identityConfidence !== "string" || !["exact_native", "partial"].includes(value.identityConfidence)
    || normalizeEnvironmentIdentity(nativeEnvironment ?? "") !== normalizeEnvironmentIdentity(environmentId ?? "")
    || !isSavedRecord(value.details) || typeof value.unknownFieldCount !== "number") {
    return invalid("Saved native source fields disagree with their inventory projection.");
  }
  savedCount(value.unknownFieldCount);
  for (const field of ["createdAt", "lastPublishedAt"]) if (typeof value[field] === "string") inventoryTimestamp(value[field]);
  const details = value.details;
  if (value.providerResourceId !== undefined && value.providerResourceId !== null
    && (typeof value.providerResourceId !== "string" || !value.providerResourceId.length || value.providerResourceId.length > 2048)) {
    return invalid("Saved native provider resource path is invalid.");
  }
  if (details.makerSharing !== undefined && !isMakerSharing(details.makerSharing)) return invalid("Saved maker-controlled sharing is invalid.");
  if (details.componentsCounts !== undefined && !isAgentComponentCounts(details.componentsCounts)) return invalid("Saved native component counts are invalid.");
  for (const field of ["instructionsCharactersCount", "distinctFlows", "flowReferenceCount", "triggerCount"]) {
    if (details[field] !== undefined && !isNullableInventoryCount(details[field])) return invalid("Saved native configuration counts are invalid.");
  }
  for (const field of ["harness", "titleId"]) {
    if (details[field] !== undefined && details[field] !== null
      && (typeof details[field] !== "string" || !details[field].length || details[field].length > 512)) return invalid("Saved native observed configuration is invalid.");
  }
  validateStringFields(details, ["ownerId", "lastModifiedAt", "lastModifiedBy", "quarantinedAt", "schemaName", "createdIn",
    "environmentType", "environmentGroup", "environmentGroupId", "orchestration", "model", "authentication"]);
  validateBooleanFields(details, ["isQuarantined", "isManaged", "isWebSearchEnabledForKnowledge", "capabilityDetailsTruncated"]);
  for (const field of ["lastModifiedAt", "quarantinedAt"]) if (typeof details[field] === "string") inventoryTimestamp(details[field]);
  for (const field of ["distinctPowerPlatformConnectors", "distinctPowerPlatformConnectorsOperations"]) {
    if (details[field] !== undefined) {
      if (typeof details[field] !== "number") return invalid("Saved native connector counts are invalid.");
      savedCount(details[field]);
    }
  }
  if (details.connectorDetailsStatus !== undefined && (typeof details.connectorDetailsStatus !== "string"
    || !["not_supplied", "complete", "partial"].includes(details.connectorDetailsStatus))) {
    return invalid("Saved native connector detail status is invalid.");
  }
  if (details.channels !== undefined) validateStringArray(details.channels);
  if (details.connectors !== undefined) {
    if (!Array.isArray(details.connectors)) return invalid("Saved native connector details are invalid.");
    for (const connector of details.connectors) {
      if (!isSavedRecord(connector) || typeof connector.connectorId !== "string"
        || connector.operations !== undefined && !Array.isArray(connector.operations)) return invalid("Saved native connector details are invalid.");
      for (const operation of connector.operations ?? []) {
        if (!isSavedRecord(operation) || typeof operation.operationId !== "string") return invalid("Saved native connector operations are invalid.");
        validateStringFields(operation, ["createdBy", "usedAs", "whenCanBeUsed", "connectionProvider"]);
        validateBooleanFields(operation, ["isEnabled", "requiresEndUserConsent"]);
      }
    }
  }
}

function validateRow(row: Page["value"][number], evaluatedAt: string) {
  if (!isSavedRecord(row) || !savedIdentityText(row.id) || typeof row.displayName !== "string"
    || !Array.isArray(row.members) || !["graph_packages", "power_platform", "both"].includes(row.presence)
    || !["matched", "unmatched", "ambiguous", "conflicting"].includes(row.linkState)
    || (row.linkState === "matched") !== (row.presence === "both")
    || row.presence === "power_platform" && row.linkState !== "unmatched") return invalid("Saved canonical inventory classification is invalid.");
  for (const member of row.members) if (!isSavedRecord(member)) return invalid("Saved canonical inventory membership is invalid.");
  const domains = row.members.map(member => member.domain);
  if (new Set(domains).size !== domains.length || domains.some(domain => !["packages", "power_platform"].includes(domain))
    || domains.includes("packages") !== (row.presence !== "power_platform")
    || domains.includes("power_platform") !== (row.presence !== "graph_packages")) return invalid("Saved canonical inventory memberships disagree with its presence.");
  const associationCount = savedCount(row.associationCount);
  if (row.environmentId !== null && !savedIdentityText(row.environmentId)) return invalid("Saved canonical environment identity is invalid.");
  validateEnvironment(row.environment, row.environmentId, evaluatedAt);
  validatePeople(row.people);
  if (row.columns != null && !isSavedRecord(row.columns)) return invalid("Saved inventory display columns are invalid.");
  for (const [column, value] of Object.entries(row.columns ?? {})) {
    if (value !== null && typeof value !== "string" && typeof value !== "number"
      || typeof value === "number" && (!Number.isFinite(value) || ["observedAt", "createdAt", "lastModifiedAt", "lastPublishedAt", "lastActivity"].includes(column)
        && !Number.isFinite(new Date(value).getTime()))) return invalid("Saved inventory display columns are invalid.");
  }
  for (const metric of [row.responses, row.activeUsers]) if (metric !== null) savedCount(metric);
  if (row.lastActivity !== null && (typeof row.lastActivity !== "number"
    && (typeof row.lastActivity !== "string" || !/^-?\d+(?:\.\d+)?$/.test(row.lastActivity))
    || !Number.isFinite(Number(row.lastActivity)) || !Number.isFinite(new Date(Number(row.lastActivity)).getTime()))) {
    return invalid("Saved inventory usage contains an invalid timestamp.");
  }
  if (!associationCount && [row.responses, row.activeUsers, row.lastActivity].some(value => value !== null)) return invalid("Saved inventory usage has no source association.");
  if (row.identity !== null && row.identity !== undefined) {
    if (!isSavedRecord(row.identity) || row.identity.reason != null && typeof row.identity.reason !== "string"
      || row.identity.invalidMetadata != null && typeof row.identity.invalidMetadata !== "boolean"
      || row.identity.warnings != null && (!Array.isArray(row.identity.warnings)
        || row.identity.warnings.some((warning: unknown) => !warning || typeof warning !== "object"
          || Object.keys(warning).some(key => !["code", "message"].includes(key))
          || !("code" in warning) || warning.code !== "source_specific_agent_identity" || !("message" in warning) || typeof warning.message !== "string"))) {
      return invalid("Saved canonical inventory identity metadata is invalid.");
    }
  }
  for (const member of row.members) {
    savedCount(member.total, true);
    validateEvidence(member.evidence);
    assertSavedJson(member.residual);
    assertSavedJson(member.evidence);
    inventoryObservation(member.generation_id, member.observed_at, member.expires_at, false, evaluatedAt);
    if (!isSavedRecord(member.residual) || !savedIdentityText(member.native_id)
      || !savedIdentityText(member.scope_id) || !savedIdentityText(member.source_identity)
      || member.residual.sourceSystem !== (member.domain === "packages" ? "graph_packages" : "power_platform")
      || member.domain === "packages" && (member.residual.id !== member.native_id || typeof member.residual.displayName !== "string")
      || member.domain === "power_platform" && (savedCount(member.total, true) !== 1 || member.residual.nativeId !== member.native_id
        || member.residual.type !== "microsoft.copilotstudio/agents" || !member.residual.details || typeof member.residual.details !== "object"
        || Array.isArray(member.residual.details)
        || member.residual.environmentId !== null && !savedIdentityText(member.residual.environmentId)
        || !Array.isArray(member.identifiers) || savedCount(member.identifier_count) < member.identifiers.length)) {
      return invalid("Saved inventory source record projection is invalid.");
    }
    if (member.domain === "power_platform") {
      validateNativeResource(member.residual, row.environmentId);
      for (const identifier of member.identifiers) validateIdentifier(identifier, member.native_id, member.residual.environmentId);
      if (member.quarantine_identity != null) {
        const identity = member.quarantine_identity;
        if (!isSavedRecord(identity) || !savedIdentityText(identity.environmentId)
          || normalizeEnvironmentIdentity(identity.environmentId) !== normalizeEnvironmentIdentity(row.environmentId ?? "")
          || typeof identity.botId !== "string" || identity.botId.length !== 36 || !personObjectIdPattern.test(identity.botId)) {
          return invalid("Saved native quarantine identity is invalid.");
        }
        assertSavedJson(identity);
      }
    } else validatePackage(member.residual, member.detail_generation, evaluatedAt);
    validateProvenance(member.residual.provenance, member.domain === "packages" ? "graph_packages" : "power_platform");
    if (member.connector_counts !== null && member.connector_counts !== undefined) {
      if (!isSavedRecord(member.connector_counts)) return invalid("Saved connector counts are invalid.");
      savedCount(member.connector_counts.connectors);
      savedCount(member.connector_counts.operations);
    }
  }
}
