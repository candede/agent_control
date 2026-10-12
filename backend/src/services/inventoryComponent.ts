import { AppError } from "../errors.js";
import type { CopilotPackage, CopilotPackageDetail } from "../types/copilotPackage.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { unifiedAgentRecordId, type UnifiedAgentPackageObservation, type UnifiedAgentPackageRecordObservation,
  type UnifiedAgentPowerPlatformObservation, type UnifiedAgentRecord } from "../types/unifiedAgents.js";
import type { PackageAgentIdentityWarning, PackageAgentLinkEvidence, PackageAgentLinkResolution } from "./packageAgentIdentity.js";
import { powerPlatformAgentKey } from "./inventoryIdentity.js";
import { dataLimitError, dataLimits } from "../db/dataBounds.js";

export function buildRecords(
  packages: readonly CopilotPackageDetail[],
  resources: readonly PowerPlatformResource[],
  resolutions: readonly PackageAgentLinkResolution[],
  packageObservation: UnifiedAgentPackageObservation | null,
  powerPlatformObservation: UnifiedAgentPowerPlatformObservation | null,
  packageSnapshots: Record<string, UnifiedAgentPackageRecordObservation> = {},
): UnifiedAgentRecord[] {
  if (packages.length + resources.length > dataLimits.batchRows) {
    throw dataLimitError("inventory_component", dataLimits.batchRows, packages.length + resources.length);
  }
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
    resourceRows.set(key, { resource, packages: [], evidence: [], packageEvidence: [], warnings: [] });
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
      row.packageEvidence.push({ packageId: detail.id, evidence: resolution.evidence.map(copyEvidence).sort(compareEvidence) });
      row.warnings.push(...resolution.warnings ?? []);
      continue;
    }
    const groupKey = resolution.status === "unmatched" && resolution.grouping
      ? resolution.grouping.key : JSON.stringify(["package", detail.id]);
    const existing = graphOnly.get(groupKey);
    if (existing) {
      existing.packages.push(packageSummary(detail));
      continue;
    }
    graphOnly.set(groupKey, {
      id: unifiedAgentRecordId({ source: "graph_packages", packageId: detail.id }),
      displayName: detail.displayName.trim() || detail.id,
      presence: "graph_packages",
      environmentId: resolution.grouping?.environmentId ?? null,
      packages: [packageSummary(detail)],
      powerPlatformResource: null,
      identity: { state: resolution.status, evidence: [], packageEvidence: [], reason: resolution.reason,
        ...(resolution.invalidMetadata ? { invalidMetadata: true } : {}) },
      observations: { graphPackages: packageObservation, packageSnapshots: pickPackageSnapshots([detail.id], packageSnapshots), powerPlatform: null },
    });
  }
  for (const record of graphOnly.values()) {
    record.packages.sort((left, right) => ordinal(left.id, right.id));
    record.id = unifiedAgentRecordId({ source: "graph_packages", packageId: record.packages[0].id });
    record.displayName = record.packages[0].displayName.trim() || record.packages[0].id;
    record.observations.packageSnapshots = pickPackageSnapshots(record.packages.map(value => value.id), packageSnapshots);
    const primary = resolutions.find(value => value.packageId === record.packages[0].id)!;
    if (primary.status === "matched") throw new AppError(500, "link_resolution_invalid", "A matched package cannot form a Graph-only record.");
    record.identity.reason = primary.reason;
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
        ? { state: "matched", evidence: uniqueEvidence(evidence),
            packageEvidence: packageEvidence.sort((left, right) => ordinal(left.packageId, right.packageId)), reason: null,
            ...(warnings.length ? { warnings: [...new Map(warnings.map(warning => [JSON.stringify([warning.code, warning.message]), warning])).values()]
              .sort((left, right) => ordinal(left.code, right.code) || ordinal(left.message, right.message)) } : {}) }
        : { state: "unmatched", evidence: [], packageEvidence: [], reason: "No Graph package has a source-declared metadata link to this Power Platform agent." },
      observations: { graphPackages: matched ? packageObservation : null,
        packageSnapshots: pickPackageSnapshots(packagesSorted.map(value => value.id), packageSnapshots), powerPlatform: powerPlatformObservation },
    } satisfies UnifiedAgentRecord;
  });
  const records = [...powerRows, ...graphOnly.values()].sort((left, right) => ordinal(left.id, right.id));
  const bytes = Buffer.byteLength(JSON.stringify(records));
  if (bytes > dataLimits.batchBytes) throw dataLimitError("inventory_component_bytes", dataLimits.batchBytes, bytes);
  return records.map(record => structuredClone(record));
}

export function packageSummary(value: CopilotPackage): CopilotPackage {
  const summary: CopilotPackage = {
    id: value.id, displayName: value.displayName, isBlocked: value.isBlocked, sourceSystem: value.sourceSystem,
    authoringTool: value.authoringTool, creatorType: value.creatorType, agentKind: value.agentKind,
    lifecycle: value.lifecycle, identityConfidence: value.identityConfidence, provenance: value.provenance,
  };
  const fields = [
    "type", "shortDescription", "supportedHosts", "createdDateTime",
    "lastModifiedDateTime", "publisher", "availableTo", "deployedTo", "elementTypes", "platform",
    "version", "manifestVersion", "manifestId", "appId", "assetId", "ownerId", "agentIdentityId", "providerUsage", "controlObservations", "detailFreshness",
  ] as const satisfies readonly (keyof CopilotPackage)[];
  for (const key of fields) if (Object.hasOwn(value, key)) Object.assign(summary, { [key]: value[key] });
  return structuredClone(summary);
}
function uniqueEvidence(values: readonly PackageAgentLinkEvidence[]) {
  const seen = new Set<string>();
  return values.map(copyEvidence).filter(value => {
    const key = evidenceKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort(compareEvidence);
}
function copyEvidence(value: PackageAgentLinkEvidence): PackageAgentLinkEvidence {
  return { kind: value.kind, basis: value.basis, packagePath: value.packagePath, resourcePath: value.resourcePath,
    elementIds: [...value.elementIds].sort(ordinal),
    ...(value.relatedPackageIds ? { relatedPackageIds: [...value.relatedPackageIds].sort(ordinal) } : {}) };
}
function evidenceKey(value: PackageAgentLinkEvidence) {
  return JSON.stringify([value.kind, value.basis, value.packagePath, value.resourcePath, value.elementIds, value.relatedPackageIds ?? []]);
}
function compareEvidence(left: PackageAgentLinkEvidence, right: PackageAgentLinkEvidence) {
  return ordinal(evidenceKey(left), evidenceKey(right));
}
function ordinal(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
function pickPackageSnapshots(ids: readonly string[], observations: Record<string, UnifiedAgentPackageRecordObservation>) {
  return Object.fromEntries(ids.flatMap(id => Object.hasOwn(observations, id) && observations[id] ? [[id, observations[id]]] : []));
}
