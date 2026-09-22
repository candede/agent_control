import { AppError } from "../errors.js";
import type pg from "pg";
import { UnifiedAgentRegistry } from "../db/unifiedAgentRegistry.js";
import { readUnifiedInventoryRevision } from "../db/unifiedInventoryRevision.js";
import {
  PackageInventoryRepository,
  packageFacets,
  type PackageDataScope,
  type UnifiedPackageSourceResult,
} from "../db/packageInventory.js";
import {
  PowerPlatformInventoryRepository,
  type InventoryDataScope,
  type UnifiedPowerPlatformSourceResult,
} from "../db/powerPlatformInventory.js";
import {
  normalizePackageAuthoringTool,
  normalizePackageStatus,
  type CopilotPackage,
  type CopilotPackageDetail,
} from "../types/copilotPackage.js";
import { powerPlatformAuthoringTool, type PowerPlatformResource } from "../types/powerPlatformInventory.js";
import type {
  UnifiedAgentInventoryPage,
  UnifiedAgentInventoryQuery,
  UnifiedAgentInventorySummary,
  UnifiedAgentInventoryVerification,
  UnifiedAgentPackageObservation,
  UnifiedAgentPackageRecordObservation,
  UnifiedAgentPowerPlatformObservation,
  UnifiedAgentRecord,
  UnifiedAgentSourceError,
  UnifiedAgentSourceStatus,
} from "../types/unifiedAgents.js";
import {
  resolvePackageAgentLinks,
  withVerifiedControlIdentities,
  type PackageAgentLinkEvidence,
  type PackageAgentIdentityWarning,
  type PackageAgentLinkResolution,
} from "./packageAgentIdentity.js";
import { powerPlatformAgentKey } from "./inventoryIdentity.js";
import { parseUnifiedAgentRecordId, unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { AuditLog } from "./auditLog.js";
import { agentColumnValue, matchesAgentView, packageAuthoringTool, summarizeAgentAvailability, type AgentColumnValue } from "../types/agentPresentation.js";
import { agentUsage, combineAgentInventoryRevision } from "./agentUsage.js";
import { savedAgentPeople } from "./savedAgentPeople.js";

export type UnifiedAgentDependencies = {
  packages: Pick<PackageInventoryRepository, "readUnifiedSource">;
  powerPlatform: Pick<PowerPlatformInventoryRepository, "readUnifiedSource">;
  resolveLinks: typeof resolvePackageAgentLinks;
  operationPackageIds: (scope: PackageDataScope, ids: readonly string[], prefix: string, database?: pg.PoolClient) => Promise<string[]>;
  registry?: Pick<UnifiedAgentRegistry, "withSnapshot" | "reconcile">;
  readRevision: typeof readUnifiedInventoryRevision;
  usage: Pick<typeof agentUsage, "project" | "revision">;
  people?: Pick<typeof savedAgentPeople, "project">;
};

const defaultDependencies: UnifiedAgentDependencies = {
  packages: new PackageInventoryRepository(),
  powerPlatform: new PowerPlatformInventoryRepository(),
  resolveLinks: resolvePackageAgentLinks,
  operationPackageIds: (scope, ids, prefix, database) => new AuditLog(scope, database).matchingOperationPackageIds(ids, prefix),
  registry: new UnifiedAgentRegistry(),
  readRevision: readUnifiedInventoryRevision,
  usage: agentUsage,
  people: savedAgentPeople,
};

type SourceLoad<T> =
  | { state: "loaded"; value: T }
  | { state: "unavailable"; error: UnifiedAgentSourceError };

export class UnifiedAgentsService {
  constructor(private readonly dependencies: UnifiedAgentDependencies = defaultDependencies) {}

  async list(scope: PackageDataScope & InventoryDataScope, query: UnifiedAgentInventoryQuery = {}): Promise<UnifiedAgentInventoryPage> {
    return this.readPage(scope, query, 250);
  }

  async forExport(scope: PackageDataScope & InventoryDataScope, revision: string, query: UnifiedAgentInventoryQuery = {}, recordIds?: readonly string[]) {
    const result = await this.readPage(scope, { ...query, limit: 5_000, offset: 0 }, 5_000, recordIds);
    if (result.revision !== revision) throw inventoryChanged();
    if (result.sources.graphPackages.state === "unavailable" && result.sources.powerPlatform.state === "unavailable") {
      throw new AppError(409, "snapshot_unavailable", "No authorized saved agent inventory is available to export. Refresh Agents first.");
    }
    if (result.count > 5_000 || result.value.length !== result.count) {
      throw new AppError(413, "export_row_limit", "The unified selection exceeds the 5,000 agent export limit.");
    }
    return result;
  }

  async assertRevision(scope: PackageDataScope & InventoryDataScope, revision: string) {
    const check = async (database?: pg.PoolClient) => {
      const baseRevision = await this.dependencies.readRevision(scope, database);
      const usageRevision = await this.dependencies.usage.revision(scope, database);
      if (combineAgentInventoryRevision(baseRevision, usageRevision) !== revision
        || await this.dependencies.readRevision(scope, database) !== baseRevision) throw inventoryChanged();
    };
    return this.dependencies.registry
      ? this.dependencies.registry.withSnapshot(scope, check)
      : check();
  }

  private async readPage(scope: PackageDataScope & InventoryDataScope, query: UnifiedAgentInventoryQuery, maximumLimit: number, recordIds?: readonly string[]) {
    return this.dependencies.registry
      ? this.dependencies.registry.withSnapshot(scope, database => this.listSnapshot(scope, query, maximumLimit, recordIds, database))
      : this.listSnapshot(scope, query, maximumLimit, recordIds);
  }

  private async listSnapshot(scope: PackageDataScope & InventoryDataScope, query: UnifiedAgentInventoryQuery, maximumLimit: number,
    recordIds?: readonly string[], database?: pg.PoolClient): Promise<UnifiedAgentInventoryPage> {
    const baseRevision = await this.dependencies.readRevision(scope, database);
    const [packageSettled, powerPlatformSettled] = await Promise.allSettled([
      database ? this.dependencies.packages.readUnifiedSource(scope, database) : this.dependencies.packages.readUnifiedSource(scope),
      database ? this.dependencies.powerPlatform.readUnifiedSource(scope, database) : this.dependencies.powerPlatform.readUnifiedSource(scope),
    ]);
    const packageLoad = sourceLoad("graph_packages", packageSettled);
    const powerPlatformLoad = sourceLoad("power_platform", powerPlatformSettled);
    if (this.dependencies.registry) {
      const incomplete = [packageLoad, powerPlatformLoad].find(load => load.state === "unavailable");
      if (incomplete?.state === "unavailable") throw new AppError(409, incomplete.error.code,
        `${incomplete.error.message} Canonical memberships were not changed because the saved sources could not be read completely.`);
    }
    const packageSource = packageLoad.state === "loaded" ? packageLoad.value : emptyPackageSource();
    const powerPlatformSource = powerPlatformLoad.state === "loaded" ? powerPlatformLoad.value : emptyPowerPlatformSource();
    const packageObservation = packageSource.snapshot ? packageObservationFrom(packageSource) : null;
    const powerPlatformObservation = powerPlatformSource.snapshot ? powerPlatformObservationFrom(powerPlatformSource) : null;
    const packageSnapshots: Record<string, UnifiedAgentPackageRecordObservation> = Object.fromEntries(
      Object.entries(packageSource.observations).map(([id, observation]) => [id, {
        ...observation,
        id: observation.snapshotId,
        current: true as const,
        identityDetails: observation.identityDetails ? {
          ...observation.identityDetails,
          id: observation.identityDetails.snapshotId,
          current: true as const,
        } : null,
      }]),
    );
    const sourceErrors: UnifiedAgentSourceError[] = [];

    const graphStatus: UnifiedAgentSourceStatus = packageLoad.state === "unavailable"
      ? { state: "unavailable", observation: null, error: packageLoad.error }
      : packageObservation
        ? { state: "available", observation: packageObservation, error: null }
        : unavailableStatus("graph_packages", "snapshot_unavailable", "No current delegated Graph package inventory snapshot is available.");
    if (graphStatus.error) sourceErrors.push(graphStatus.error);

    const powerPlatformStatus = powerPlatformSourceStatus(powerPlatformLoad, powerPlatformObservation);
    if (powerPlatformStatus.error) sourceErrors.push(powerPlatformStatus.error);
    const usablePowerPlatform = powerPlatformStatus.state === "unavailable" ? [] : powerPlatformSource.resources;
    const usablePackages = graphStatus.state === "unavailable" ? [] : packageSource.packages.map(value => {
      const observation = packageSource.observations[value.id];
      return !value.identityDetailsCollected && (observation?.scopeKind === "exact" || observation?.identityDetails)
        ? { ...value, identityDetailsCollected: true as const }
        : value;
    });
    const links = this.dependencies.resolveLinks(scope.tenantId, usablePackages, usablePowerPlatform);
    const grouped = buildRecords(
      usablePackages,
      withVerifiedControlIdentities(usablePowerPlatform, links, packageSource.observations),
      links,
      packageObservation,
      powerPlatformObservation,
      packageSnapshots,
    );
    const canonicalRecords = database && this.dependencies.registry
      ? await this.dependencies.registry.reconcile(database, scope, grouped) : grouped;
    const sourceCounts = verifySourceMemberships(canonicalRecords, usablePackages, usablePowerPlatform);
    const usage = await this.dependencies.usage.project(scope, canonicalRecords, database);
    const enrichedRecords = this.dependencies.people
      ? await this.dependencies.people.project(scope, canonicalRecords, database) : canonicalRecords;
    const records = enrichedRecords.map(record => {
      const summary = usage.summaries.get(record.id);
      if (!summary) throw new AppError(500, "agent_usage_projection_incomplete", "Saved usage did not account for every authorized inventory agent.");
      return { ...record, usage: summary };
    });
    const revision = combineAgentInventoryRevision(baseRevision, usage.context.revision);
    const selected = recordIds ? exactSelection(records, recordIds) : undefined;
    const summary = summarize(records);
    const environments = new Map<string, { value: string; label: string }>();
    for (const record of records) {
      if (!record.environmentId) continue;
      const key = record.environmentId.toLocaleLowerCase("en-US");
      if (!environments.has(key)) environments.set(key, {
        value: record.environmentId,
        label: powerPlatformSource.environmentNames[key] ?? record.environmentId,
      });
    }
    const platforms = new Map(packageFacets(usablePackages).platforms.map(option => [normalizePackageAuthoringTool(option.value), option]));
    for (const resource of usablePowerPlatform) {
      const label = powerPlatformAuthoringTool(resource);
      if (label && !platforms.has(normalizePackageAuthoringTool(label))) platforms.set(normalizePackageAuthoringTool(label), { value: label, label });
    }
    const byLabel = (left: { value: string; label: string }, right: { value: string; label: string }) =>
      left.label.localeCompare(right.label) || left.value.localeCompare(right.value);
    const referenceIds = query.operationIdPrefix
      ? new Set(await this.dependencies.operationPackageIds(scope, usablePackages.map(value => value.id), query.operationIdPrefix, database))
      : undefined;
    const filtered = records.filter(record => (!selected || selected.has(record)) && matches(record, query)
      && (!referenceIds || record.packages.some(value => referenceIds.has(value.id))));
    const filteredSummary = summarize(filtered);
    const sorted = [...filtered].sort(recordComparator(query, powerPlatformSource.environmentNames));
    const limit = Math.min(Math.max(query.limit ?? 50, 1), maximumLimit);
    const offset = Math.min(Math.max(query.offset ?? 0, 0), 100_000);
    const checkedPackages = usablePackages.filter(value => value.identityDetailsCollected).length;
    const invalidPackages = links.filter(link => link.status !== "matched" && link.invalidMetadata).length;
    const checks: UnifiedAgentInventoryVerification["checks"] = {
      sourceScopes: sourceErrors.length === 0,
      packageMetadata: checkedPackages === usablePackages.length && invalidPackages === 0,
      identityLinks: summary.ambiguous === 0 && summary.conflicting === 0,
      sourceMemberships: true,
    };
    if (await this.dependencies.readRevision(scope, database) !== baseRevision) throw inventoryChanged();

    return {
      revision,
      usageContext: usage.context,
      inventoryOverview: summarizeAgentAvailability(records),
      value: sorted.slice(offset, offset + limit),
      count: filtered.length,
      offset,
      limit,
      summary,
      filteredSummary,
      verification: {
        status: Object.values(checks).every(Boolean) ? "verified" : "needs_attention",
        scope: "authorized_saved_sources",
        checkedAt: new Date().toISOString(),
        graphPackageCount: usablePackages.length,
        powerPlatformAgentCount: usablePowerPlatform.length,
        ...sourceCounts,
        logicalAgentCount: records.length,
        checks,
      },
      identityCollection: {
        checkedPackages, pendingPackages: usablePackages.length - checkedPackages,
        ...(invalidPackages ? { invalidPackages } : {}),
      },
      facets: {
        environments: [...environments.values()].sort(byLabel),
        platforms: [...platforms.values()].sort(byLabel),
      },
      sources: { graphPackages: graphStatus, powerPlatform: powerPlatformStatus },
      partial: sourceErrors.length > 0,
      errors: sourceErrors,
    };
  }
}

export const unifiedAgents = new UnifiedAgentsService();

function verifySourceMemberships(records: readonly UnifiedAgentRecord[], packages: readonly CopilotPackage[], resources: readonly PowerPlatformResource[]) {
  const packageKey = (id: string) => JSON.stringify(["graph_packages", id]);
  const nativeKey = (resource: PowerPlatformResource) => JSON.stringify(["power_platform", powerPlatformAgentKey(resource.environmentId, resource.nativeId)]);
  const expected = new Set([...packages.map(value => packageKey(value.id)), ...resources.map(nativeKey)]);
  const represented = new Set<string>();
  const failed = () => new AppError(409, "inventory_verification_failed",
    "Unified inventory failed verification: every collected source identity must appear in exactly one agent. No incomplete reconciliation was published.");
  if (expected.size !== packages.length + resources.length || new Set(records.map(record => record.id)).size !== records.length) throw failed();
  for (const record of records) {
    const keys = record.packages.map(value => packageKey(value.id));
    if (record.powerPlatformResource) keys.push(nativeKey(record.powerPlatformResource));
    if (!keys.length) throw failed();
    for (const key of keys) {
      if (!expected.has(key) || represented.has(key)) throw failed();
      represented.add(key);
    }
  }
  if (represented.size !== expected.size) throw failed();
  return { representedSourceCount: represented.size, uniqueSourceCount: expected.size };
}

function buildRecords(
  packages: readonly CopilotPackageDetail[],
  resources: readonly PowerPlatformResource[],
  resolutions: readonly PackageAgentLinkResolution[],
  packageObservation: UnifiedAgentPackageObservation | null,
  powerPlatformObservation: UnifiedAgentPowerPlatformObservation | null,
  packageSnapshots: Record<string, UnifiedAgentPackageRecordObservation> = {},
): UnifiedAgentRecord[] {
  if (resolutions.length !== packages.length) {
    throw new AppError(500, "link_resolution_invalid", "The package identity resolver returned an incomplete result.");
  }
  const resourceRows = new Map<string, {
    resource: PowerPlatformResource;
    packages: CopilotPackage[];
    evidence: PackageAgentLinkEvidence[];
    packageEvidence: Array<{ packageId: string; evidence: PackageAgentLinkEvidence[] }>;
    warnings: PackageAgentIdentityWarning[];
  }>();
  for (const resource of resources) {
    const key = powerPlatformAgentKey(resource.environmentId, resource.nativeId);
    if (resourceRows.has(key)) {
      throw new AppError(500, "saved_source_invalid", "Saved Power Platform agent inventory contains a duplicate exact environment and native identity.");
    }
    resourceRows.set(key, {
      resource,
      packages: [],
      evidence: [],
      packageEvidence: [],
      warnings: [],
    });
  }
  const packageById = new Map(packages.map(value => [value.id, value]));
  if (packageById.size !== packages.length) throw new AppError(500, "saved_source_invalid", "Saved Graph inventory contains duplicate package identities.");
  const graphOnly = new Map<string, UnifiedAgentRecord>();
  const seenResolutions = new Set<string>();
  for (const resolution of resolutions) {
    const detail = packageById.get(resolution.packageId);
    if (!detail || seenResolutions.has(resolution.packageId)) throw new AppError(500, "link_resolution_invalid", "The package identity resolver returned an unknown or duplicate package.");
    seenResolutions.add(resolution.packageId);
    if (resolution.status === "matched") {
      const row = resourceRows.get(powerPlatformAgentKey(resolution.resource.environmentId, resolution.resource.nativeId));
      if (!row) throw new AppError(500, "link_resolution_invalid", "The package identity resolver returned an unknown Power Platform resource.");
      row.packages.push(packageSummary(detail));
      row.evidence.push(...resolution.evidence);
      row.packageEvidence.push({ packageId: detail.id, evidence: resolution.evidence });
      row.warnings.push(...resolution.warnings ?? []);
      continue;
    }
    const groupKey = resolution.status === "unmatched" && resolution.grouping
      ? resolution.grouping.key : JSON.stringify(["package", detail.id]);
    const existing = graphOnly.get(groupKey);
    if (existing) {
      existing.packages.push(packageSummary(detail));
      Object.assign(existing.observations.packageSnapshots, pickPackageSnapshots([detail.id], packageSnapshots));
      continue;
    }
    graphOnly.set(groupKey, {
      id: unifiedAgentRecordId({ source: "graph_packages", packageId: detail.id }),
      displayName: detail.displayName.trim() || detail.id,
      presence: "graph_packages",
      environmentId: resolution.grouping?.environmentId ?? null,
      packages: [packageSummary(detail)],
      powerPlatformResource: null,
      identity: {
        state: resolution.status, evidence: [], packageEvidence: [], reason: resolution.reason,
        ...(resolution.invalidMetadata ? { invalidMetadata: true } : {}),
      },
      observations: {
        graphPackages: packageObservation,
        packageSnapshots: pickPackageSnapshots([detail.id], packageSnapshots),
        powerPlatform: null,
      },
    });
  }
  for (const record of graphOnly.values()) {
    record.packages.sort((left, right) => ordinal(left.id, right.id));
    record.id = unifiedAgentRecordId({ source: "graph_packages", packageId: record.packages[0].id });
    record.displayName = record.packages[0].displayName.trim() || record.packages[0].id;
  }
  const powerRows = [...resourceRows.values()].map(({ resource, packages: linkedPackages, evidence, packageEvidence, warnings }) => {
    const packagesSorted = linkedPackages.sort((left, right) => ordinal(left.id, right.id));
    const matched = packagesSorted.length > 0;
    return {
      id: unifiedAgentRecordId({ source: "power_platform", nativeId: resource.nativeId, environmentId: resource.environmentId }),
      displayName: resource.displayName?.trim() || packagesSorted[0]?.displayName.trim() || resource.nativeId,
      presence: matched ? "both" : "power_platform",
      environmentId: resource.environmentId,
      packages: packagesSorted,
      powerPlatformResource: resource,
      identity: matched
        ? {
            state: "matched",
            evidence: uniqueEvidence(evidence),
            packageEvidence: packageEvidence.sort((left, right) => ordinal(left.packageId, right.packageId)),
            reason: null,
            ...(warnings.length ? { warnings: [...new Map(warnings.map(warning => [warning.code, warning])).values()] } : {}),
          }
        : {
            state: "unmatched",
            evidence: [],
            packageEvidence: [],
            reason: "No Graph package has a source-declared metadata link to this Power Platform agent.",
          },
      observations: {
        graphPackages: matched ? packageObservation : null,
        packageSnapshots: pickPackageSnapshots(packagesSorted.map(value => value.id), packageSnapshots),
        powerPlatform: powerPlatformObservation,
      },
    } satisfies UnifiedAgentRecord;
  });
  return [...powerRows, ...graphOnly.values()];
}

function packageSummary(value: CopilotPackageDetail): CopilotPackage {
  const {
    longDescription: _longDescription,
    categories: _categories,
    sensitivity: _sensitivity,
    allowedUsersAndGroups: _allowedUsersAndGroups,
    acquireUsersAndGroups: _acquireUsersAndGroups,
    elementDetails: _elementDetails,
    identityDetailsCollected: _identityDetailsCollected,
    ...summary
  } = value;
  return summary;
}

function packageObservationFrom(source: UnifiedPackageSourceResult): UnifiedAgentPackageObservation {
  return {
    id: source.snapshot!.id,
    snapshotId: source.snapshot!.id,
    observedAt: source.snapshot!.observedAt,
    expiresAt: source.snapshot!.expiresAt,
    current: true,
    tokenMode: "delegated",
    scopeKind: "broad",
    observedCount: source.snapshot!.observedCount,
    totalRecords: source.snapshot!.totalRecords,
  };
}

function powerPlatformObservationFrom(source: UnifiedPowerPlatformSourceResult): UnifiedAgentPowerPlatformObservation {
  const coverage = source.snapshot!.coverage.find(item => item.type === "microsoft.copilotstudio/agents");
  return {
    id: source.snapshot!.id,
    snapshotId: source.snapshot!.id,
    observedAt: source.snapshot!.observedAt,
    expiresAt: source.snapshot!.expiresAt,
    current: true,
    roleScope: source.snapshot!.roleScope,
    environmentScope: source.snapshot!.environmentScope,
    coverage: coverage?.status ?? "unknown",
    coveredCount: coverage?.count ?? null,
    observedCount: source.snapshot!.observedCount,
    totalRecords: source.snapshot!.totalRecords,
    pageCount: source.snapshot!.pageCount,
    verification: source.snapshot!.verification,
  };
}

function powerPlatformSourceStatus(
  load: SourceLoad<UnifiedPowerPlatformSourceResult>,
  observation: UnifiedAgentPowerPlatformObservation | null,
): UnifiedAgentSourceStatus {
  if (load.state === "unavailable") return { state: "unavailable", observation: null, error: load.error };
  if (!observation) {
    return unavailableStatus("power_platform", "snapshot_unavailable", "No current Power Platform snapshot covering Copilot Studio agents is available.");
  }
  if (observation.coverage === "not_authorized_scope") {
    return unavailableStatus(
      "power_platform",
      "not_authorized_scope",
      "The saved Power Platform role scope is not authorized to enumerate Copilot Studio agents.",
      observation,
    );
  }
  if (observation.coverage !== "covered" || observation.verification?.status !== "verified" || observation.environmentScope !== null) {
    const reasons: string[] = [];
    if (observation.environmentScope !== null) reasons.push(
      "The Power Platform query was restricted to one environment. Other environments were not included in this saved inventory.",
    );
    if (observation.coverage !== "covered" || observation.verification?.status !== "verified") reasons.push(
      "The selected saved query does not contain verified Copilot Studio agent collection evidence. Refresh Power Platform inventory before treating this source as complete.",
    );
    const error: UnifiedAgentSourceError = {
      source: "power_platform",
      code: observation.environmentScope !== null ? "environment_scope_limited" : "coverage_unknown",
      message: reasons.join(" "),
    };
    return { state: "partial", observation, error };
  }
  return { state: "available", observation, error: null };
}

function sourceLoad<T>(
  source: UnifiedAgentSourceError["source"],
  settled: PromiseSettledResult<T>,
): SourceLoad<T> {
  if (settled.status === "fulfilled") return { state: "loaded", value: settled.value };
  if (settled.reason instanceof AppError && settled.reason.code === "source_result_limit") {
    return {
      state: "unavailable",
      error: { source, code: "source_result_limit", message: settled.reason.message },
    };
  }
  throw settled.reason;
}

function unavailableStatus(
  source: UnifiedAgentSourceError["source"],
  code: UnifiedAgentSourceError["code"],
  message: string,
  observation: UnifiedAgentPackageObservation | UnifiedAgentPowerPlatformObservation | null = null,
): UnifiedAgentSourceStatus {
  return { state: "unavailable", observation, error: { source, code, message } };
}

function matches(record: UnifiedAgentRecord, query: UnifiedAgentInventoryQuery) {
  if (!matchesAgentView(record, query.view)) return false;
  if (query.recordId && !matchesRecordId(record, query.recordId)) return false;
  if (query.source && query.source !== "all") {
    if (query.source === "both" && record.presence !== "both") return false;
    if (query.source === "graph_packages" && !record.packages.length) return false;
    if (query.source === "power_platform" && !record.powerPlatformResource) return false;
  }
  if (query.linkState && record.identity.state !== query.linkState) return false;
  if (query.environmentId && record.environmentId?.toLocaleLowerCase("en-US") !== query.environmentId.toLocaleLowerCase("en-US")) return false;
  if (query.blocked !== undefined && !record.packages.some(value => value.isBlocked === query.blocked)) return false;
  if (query.publisher && !record.packages.some(value =>
    query.publisher === "__unknown__" ? value.publisher === undefined : value.publisher === query.publisher,
  )) return false;
  if (query.availableTo && !record.packages.some(value => matchesAvailability(value.availableTo, query.availableTo!))) return false;
  if (query.host && !record.packages.some(value => matchesHost(value.supportedHosts, query.host!))) return false;
  if (query.platform && !record.packages.some(value => packagePlatform(value) === normalizePackageAuthoringTool(query.platform!))
    && normalizePackageAuthoringTool(record.powerPlatformResource ? powerPlatformAuthoringTool(record.powerPlatformResource) ?? "" : "") !== normalizePackageAuthoringTool(query.platform)) return false;
  if (query.createdWithinDays !== undefined) {
    const threshold = Date.now() - query.createdWithinDays * 24 * 60 * 60_000;
    const createdDates = [...record.packages.map(value => value.createdDateTime), record.powerPlatformResource?.createdAt];
    if (!createdDates.some(value => {
      const createdAt = value ? Date.parse(value) : Number.NaN;
      return Number.isFinite(createdAt) && createdAt >= threshold;
    })) return false;
  }
  const search = query.search?.trim().toLocaleLowerCase("en-US");
  if (!search) return true;
  const values = [
    record.displayName,
    record.environmentId,
    record.powerPlatformResource?.nativeId,
    record.powerPlatformResource?.details.ownerId,
    record.powerPlatformResource?.createdBy,
    record.powerPlatformResource?.details.lastModifiedBy,
    ...Object.values(record.people ?? {}).flatMap(person => [person.objectId, person.displayName, person.userPrincipalName]),
    ...record.packages.flatMap(value => [value.id, value.displayName, value.publisher]),
    ...(record.powerPlatformResource?.identifiers.map(identifier => identifier.value) ?? []),
  ];
  return values.some(value => value?.toLocaleLowerCase("en-US").includes(search));
}

function matchesRecordId(record: UnifiedAgentRecord, recordId: string) {
  if (record.id === recordId) return true;
  const target = parseUnifiedAgentRecordId(recordId);
  if (target?.source === "graph_packages") return record.packages.some(value => value.id === target.packageId);
  if (target?.source === "power_platform" && record.powerPlatformResource) {
    return powerPlatformAgentKey(target.environmentId, target.nativeId)
      === powerPlatformAgentKey(record.powerPlatformResource.environmentId, record.powerPlatformResource.nativeId);
  }
  return false;
}

function exactSelection(records: readonly UnifiedAgentRecord[], references: readonly string[]) {
  if (!references.length || references.length > 5_000) throw new AppError(400, "invalid_export_selection", "Select 1-5,000 exact agent references.");
  const canonical = new Map(records.map(record => [record.id, record]));
  const packages = new Map(records.flatMap(record => record.packages.map(value => [value.id, record] as const)));
  const resources = new Map(records.flatMap(record => record.powerPlatformResource ? [[
    powerPlatformAgentKey(record.powerPlatformResource.environmentId, record.powerPlatformResource.nativeId), record,
  ] as const] : []));
  const selected = new Set<UnifiedAgentRecord>();
  for (const reference of references) {
    const target = parseUnifiedAgentRecordId(reference);
    const record = canonical.get(reference) ?? (target?.source === "graph_packages" ? packages.get(target.packageId)
      : target?.source === "power_platform" ? resources.get(powerPlatformAgentKey(target.environmentId, target.nativeId)) : undefined);
    if (!record) throw new AppError(409, "export_selection_changed", "A selected agent is no longer in the authorized saved inventory. Refresh Agents and select it again.");
    selected.add(record);
  }
  return selected;
}

function inventoryChanged() {
  return new AppError(409, "inventory_changed", "Saved inventory changed. Refresh Agents and try the export again.");
}

function recordComparator(query: UnifiedAgentInventoryQuery, environmentNames: Record<string, string>) {
  const direction = query.sortDirection === "desc" ? -1 : 1;
  const sortBy = query.sortBy ?? "displayName";
  const values = new Map<UnifiedAgentRecord, AgentColumnValue>();
  const value = (record: UnifiedAgentRecord) => {
    if (values.has(record)) return values.get(record)!;
    let result: AgentColumnValue;
    try {
      result = agentColumnValue(record, sortBy, environmentNames);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new AppError(500, "saved_source_invalid", error.message);
    }
    values.set(record, result);
    return result;
  };
  return (left: UnifiedAgentRecord, right: UnifiedAgentRecord) => {
    const leftValue = value(left);
    const rightValue = value(right);
    if (leftValue === null || rightValue === null) {
      if (leftValue === rightValue) return ordinal(left.id, right.id) * direction;
      const missingOrder = leftValue === null ? 1 : -1;
      return sortBy === "lastModifiedAt" ? -missingOrder * direction : missingOrder;
    }
    const comparison = typeof leftValue === "number" && typeof rightValue === "number"
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), "en-US", { sensitivity: "base", numeric: sortBy === "versions" });
    return (comparison || ordinal(left.id, right.id)) * direction;
  };
}

function summarize(records: readonly UnifiedAgentRecord[]): UnifiedAgentInventorySummary {
  return {
    total: records.length,
    linked: records.filter(record => record.presence === "both").length,
    graphOnly: records.filter(record => record.presence === "graph_packages").length,
    powerPlatformOnly: records.filter(record => record.presence === "power_platform").length,
    ambiguous: records.filter(record => record.identity.state === "ambiguous").length,
    conflicting: records.filter(record => record.identity.state === "conflicting").length,
  };
}

function uniqueEvidence(values: readonly PackageAgentLinkEvidence[]) {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = JSON.stringify([value.kind, value.basis, value.packagePath, value.resourcePath,
      [...value.elementIds].sort(ordinal), [...value.relatedPackageIds ?? []].sort(ordinal)]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchesAvailability(value: string | undefined, filter: string) {
  const expected = filter.startsWith("available:") ? filter.slice("available:".length) : filter;
  if (expected === "__unknown__") return value === undefined;
  if (expected === "__some_or_all__") {
    const status = normalizePackageStatus(value);
    return status === "all" || status === "some";
  }
  return value === expected;
}

function matchesHost(values: readonly string[] | undefined, filter: string) {
  if (filter === "__unknown_host__") return !values?.length || values.some(value => typeof value !== "string" || !value.trim());
  return values?.some(value => value.trim() === filter) ?? false;
}

function packagePlatform(value: CopilotPackage) {
  return normalizePackageAuthoringTool(packageAuthoringTool(value) ?? "");
}

function emptyPackageSource(): UnifiedPackageSourceResult {
  return { packages: [], observations: {}, snapshot: null };
}

function emptyPowerPlatformSource(): UnifiedPowerPlatformSourceResult {
  return { resources: [], environmentNames: {}, snapshot: null };
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pickPackageSnapshots(
  ids: readonly string[],
  observations: Record<string, UnifiedAgentPackageRecordObservation>,
) {
  return Object.fromEntries(ids.flatMap(id => observations[id] ? [[id, observations[id]]] : []));
}
