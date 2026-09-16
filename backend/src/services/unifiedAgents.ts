import { AppError } from "../errors.js";
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
import type { CopilotPackage, CopilotPackageDetail } from "../types/copilotPackage.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import type {
  UnifiedAgentInventoryPage,
  UnifiedAgentInventoryQuery,
  UnifiedAgentInventorySummary,
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
  type PackageAgentLinkResolution,
} from "./packageAgentIdentity.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { getAuditLog } from "./auditLog.js";

export type UnifiedAgentDependencies = {
  packages: Pick<PackageInventoryRepository, "readUnifiedSource">;
  powerPlatform: Pick<PowerPlatformInventoryRepository, "readUnifiedSource">;
  resolveLinks: typeof resolvePackageAgentLinks;
  operationPackageIds: (scope: PackageDataScope, ids: readonly string[], prefix: string) => Promise<string[]>;
};

const defaultDependencies: UnifiedAgentDependencies = {
  packages: new PackageInventoryRepository(),
  powerPlatform: new PowerPlatformInventoryRepository(),
  resolveLinks: resolvePackageAgentLinks,
  operationPackageIds: (scope, ids, prefix) => getAuditLog(scope).matchingOperationPackageIds(ids, prefix),
};

type SourceLoad<T> =
  | { state: "loaded"; value: T }
  | { state: "unavailable"; error: UnifiedAgentSourceError };

export class UnifiedAgentsService {
  constructor(private readonly dependencies: UnifiedAgentDependencies = defaultDependencies) {}

  async list(scope: PackageDataScope & InventoryDataScope, query: UnifiedAgentInventoryQuery = {}): Promise<UnifiedAgentInventoryPage> {
    const [packageSettled, powerPlatformSettled] = await Promise.allSettled([
      this.dependencies.packages.readUnifiedSource(scope),
      this.dependencies.powerPlatform.readUnifiedSource(scope),
    ]);
    const packageLoad = sourceLoad("graph_packages", packageSettled);
    const powerPlatformLoad = sourceLoad("power_platform", powerPlatformSettled);
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
    const usablePackages = graphStatus.state === "unavailable" ? [] : packageSource.packages;
    const links = this.dependencies.resolveLinks(scope.tenantId, usablePackages, usablePowerPlatform);
    const records = buildRecords(
      usablePackages,
      withVerifiedControlIdentities(usablePowerPlatform, links, packageSource.observations),
      links,
      packageObservation,
      powerPlatformObservation,
      packageSnapshots,
    );
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
    const platforms = new Map(packageFacets(usablePackages).platforms.map(option => [normalizeFacet(option.value), option]));
    for (const resource of usablePowerPlatform) {
      const label = resource.authoringTool?.trim();
      if (label && !platforms.has(normalizeFacet(label))) platforms.set(normalizeFacet(label), { value: label, label });
    }
    const byLabel = (left: { value: string; label: string }, right: { value: string; label: string }) =>
      left.label.localeCompare(right.label) || left.value.localeCompare(right.value);
    const referenceIds = query.operationIdPrefix
      ? new Set(await this.dependencies.operationPackageIds(scope, usablePackages.map(value => value.id), query.operationIdPrefix))
      : undefined;
    const filtered = records.filter(record => matches(record, query)
      && (!referenceIds || record.packages.some(value => referenceIds.has(value.id))));
    const filteredSummary = summarize(filtered);
    const sorted = [...filtered].sort(recordComparator(query));
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 250);
    const offset = Math.min(Math.max(query.offset ?? 0, 0), 100_000);
    const checkedPackages = usablePackages.filter(value => value.identityDetailsCollected
      || packageSource.observations[value.id]?.scopeKind === "exact"
      || packageSource.observations[value.id]?.identityDetails).length;

    return {
      value: sorted.slice(offset, offset + limit),
      count: filtered.length,
      offset,
      limit,
      summary,
      filteredSummary,
      identityCollection: { checkedPackages, pendingPackages: usablePackages.length - checkedPackages },
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
  }>();
  for (const resource of resources) {
    const key = resourceKey(resource.environmentId, resource.nativeId);
    if (resourceRows.has(key)) {
      throw new AppError(500, "saved_source_invalid", "Saved Power Platform agent inventory contains a duplicate exact environment and native identity.");
    }
    resourceRows.set(key, {
      resource,
      packages: [],
      evidence: [],
      packageEvidence: [],
    });
  }
  const packageById = new Map(packages.map(value => [value.id, value]));
  const graphOnly: UnifiedAgentRecord[] = [];
  for (const resolution of resolutions) {
    const detail = packageById.get(resolution.packageId);
    if (!detail) throw new AppError(500, "link_resolution_invalid", "The package identity resolver returned an unknown package.");
    if (resolution.status === "matched") {
      const row = resourceRows.get(resourceKey(resolution.resource.environmentId, resolution.resource.nativeId));
      if (!row) throw new AppError(500, "link_resolution_invalid", "The package identity resolver returned an unknown Power Platform resource.");
      row.packages.push(packageSummary(detail));
      row.evidence.push(...resolution.evidence);
      row.packageEvidence.push({ packageId: detail.id, evidence: resolution.evidence });
      continue;
    }
    graphOnly.push({
      id: unifiedAgentRecordId({ source: "graph_packages", packageId: detail.id }),
      displayName: detail.displayName,
      presence: "graph_packages",
      environmentId: null,
      packages: [packageSummary(detail)],
      powerPlatformResource: null,
      identity: { state: resolution.status, evidence: [], packageEvidence: [], reason: resolution.reason },
      observations: {
        graphPackages: packageObservation,
        packageSnapshots: pickPackageSnapshots([detail.id], packageSnapshots),
        powerPlatform: null,
      },
    });
  }
  const powerRows = [...resourceRows.values()].map(({ resource, packages: linkedPackages, evidence, packageEvidence }) => {
    const packagesSorted = linkedPackages.sort((left, right) => ordinal(left.id, right.id));
    const matched = packagesSorted.length > 0;
    return {
      id: unifiedAgentRecordId({ source: "power_platform", nativeId: resource.nativeId, environmentId: resource.environmentId }),
      displayName: resource.displayName ?? packagesSorted[0]?.displayName ?? resource.nativeId,
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
  return [...powerRows, ...graphOnly];
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
  if (observation.coverage !== "covered" || observation.environmentScope !== null) {
    const message = observation.environmentScope
      ? "The saved Power Platform inventory covers only one environment; observed agents are returned as partial availability."
      : "The saved Power Platform inventory does not prove complete Copilot Studio agent coverage; observed agents are returned as partial availability.";
    const error: UnifiedAgentSourceError = { source: "power_platform", code: "coverage_unknown", message };
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
  if (query.recordId && record.id !== query.recordId && !record.packages.some(value =>
    unifiedAgentRecordId({ source: "graph_packages", packageId: value.id }) === query.recordId,
  )) return false;
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
  if (query.platform && !record.packages.some(value => packagePlatform(value) === normalizeFacet(query.platform!))
    && normalizeFacet(record.powerPlatformResource?.authoringTool ?? "") !== normalizeFacet(query.platform)) return false;
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
    ...record.packages.flatMap(value => [value.id, value.displayName, value.publisher]),
    ...(record.powerPlatformResource?.identifiers.map(identifier => identifier.value) ?? []),
  ];
  return values.some(value => value?.toLocaleLowerCase("en-US").includes(search));
}

function recordComparator(query: UnifiedAgentInventoryQuery) {
  const direction = query.sortDirection === "desc" ? -1 : 1;
  const value = (record: UnifiedAgentRecord) => {
    if (query.sortBy === "environment") return record.environmentId ?? "";
    if (query.sortBy === "source") return record.presence;
    if (query.sortBy === "lastModifiedAt") {
      return [
        record.powerPlatformResource?.lastPublishedAt,
        record.powerPlatformResource?.createdAt,
        ...record.packages.map(item => item.lastModifiedDateTime),
      ].filter((item): item is string => Boolean(item)).sort().at(-1) ?? "";
    }
    return record.displayName;
  };
  return (left: UnifiedAgentRecord, right: UnifiedAgentRecord) =>
    (value(left).localeCompare(value(right), "en-US", { sensitivity: "base" }) || ordinal(left.id, right.id)) * direction;
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
    const key = `${value.kind}\0${value.basis}\0${value.packagePath}\0${value.resourcePath}\0${[...value.elementIds].sort(ordinal).join("\0")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resourceKey(environmentId: string | null, nativeId: string) {
  return `${environmentId ?? ""}\0${nativeId}`;
}

function matchesAvailability(value: string | undefined, filter: string) {
  const expected = filter.startsWith("available:") ? filter.slice("available:".length) : filter;
  if (expected === "__unknown__") return value === undefined;
  if (expected === "__some_or_all__") {
    return ["all", "some", "allowedforall", "allowedforsome"].includes(normalizeFacet(value ?? ""));
  }
  return value === expected;
}

function matchesHost(values: readonly string[] | undefined, filter: string) {
  if (filter === "__unknown_host__") return !values?.length || values.some(value => typeof value !== "string" || !value.trim());
  return values?.some(value => value.trim() === filter) ?? false;
}

function packagePlatform(value: CopilotPackage) {
  const raw = value.authoringTool
    ?? value.platform
    ?? value.shortDescription?.trim().match(/^built\s+using\s+(.+?)\.?$/i)?.[1]?.trim()
    ?? "";
  return normalizeFacet(raw);
}

function normalizeFacet(value: string) {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
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
