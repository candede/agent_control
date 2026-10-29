import type { CopilotPackageDetail, PackageDetailFreshness } from "../types/copilotPackage.js";
import { normalizePackageStatus } from "../types/copilotPackage.js";
import { packageControlIdentityChanged } from "./packageControlProjection.js";
import { compareInventoryTimestamps } from "./inventoryTimestamp.js";
import { isInventoryTimestamp } from "../types/inventoryTimestamp.js";
import { normalizedGuid } from "./packageAgentMetadata.js";

export type SavedPackageDetail = {
  package: CopilotPackageDetail | null;
  observedAt: string;
  expiresAt: string;
  catalogRevision?: ReturnType<typeof packageDetailRevision> | null;
};

export function projectPackageDetailAge<T extends CopilotPackageDetail>(value: T, evaluatedAt: number | string | Date): T {
  const freshness = value.detailFreshness;
  if (freshness?.state !== "fresh") return value;
  const evaluation = typeof evaluatedAt === "number" ? new Date(evaluatedAt) : evaluatedAt;
  if (compareInventoryTimestamps(freshness.expiresAt ?? "", evaluation) > 0
    && compareInventoryTimestamps(freshness.observedAt ?? "", evaluation) <= 0) return value;
  const result = { ...value, detailFreshness: { ...freshness, state: "stale" as const } };
  if (compareInventoryTimestamps(freshness.observedAt ?? "", evaluation) > 0) delete result.identityDetailsCollected;
  return result;
}

export function packageDetailRevision(value: CopilotPackageDetail) {
  return [value.lastModifiedDateTime, value.appId, normalizedGuid(value.manifestId) ?? value.manifestId,
    value.assetId, value.version, value.manifestVersion]
    .map(marker => marker ?? null);
}

function packageDetailRevisionMatches(current: CopilotPackageDetail, detailed: CopilotPackageDetail) {
  const modified = current.lastModifiedDateTime;
  return Boolean(modified && isInventoryTimestamp(modified)
    && packageDetailRevision(current).slice(1).some(marker => typeof marker === "string" && marker.trim())
    && JSON.stringify(packageDetailRevision(current)) === JSON.stringify(packageDetailRevision(detailed)));
}

function hasCollectedDetails(value: CopilotPackageDetail) {
  // A completed empty read still has provenance.
  return value.identityDetailsCollected === true
    || value.detailFreshness?.state !== "missing" && typeof value.detailFreshness?.observedAt === "string"
      && typeof value.detailFreshness.expiresAt === "string";
}

export function packageDetailAccessScopesMatch(left: string | undefined, right: string | undefined) {
  const normalized = normalizePackageStatus(left);
  return left === right || normalized !== undefined && normalized === normalizePackageStatus(right);
}

export function projectPackageDetails(current: CopilotPackageDetail, saved: SavedPackageDetail | undefined,
  authoritativeCurrent = false, now = Date.now(), currentReadStartedAt?: number): CopilotPackageDetail {
  if (!saved || saved.package && !hasCollectedDetails(saved.package)) {
    const result: CopilotPackageDetail = {
      ...current,
      ...(saved?.package?.identityRevalidationRequired ? { identityRevalidationRequired: true } : {}),
      detailFreshness: { state: "missing", observedAt: null, expiresAt: null },
    };
    delete result.elementDetails;
    delete result.identityDetailsCollected;
    return result;
  }
  // List and detail endpoints can report different modification timestamps.
  // A reserved, unchanged catalog revision binds automatic details to that catalog;
  // positive identity/version disagreements still invalidate the association.
  const catalogMatches = !saved.catalogRevision
    || JSON.stringify(saved.catalogRevision) === JSON.stringify(packageDetailRevision(current));
  const detailed = saved.package && saved.catalogRevision && catalogMatches
    ? { ...current, ...saved.package } : saved.package;
  const compatible = saved.package?.detailFreshness?.state !== "invalidated"
    && catalogMatches && detailed && detailed.id === current.id
    && (authoritativeCurrent || packageDetailRevisionMatches(current, saved.catalogRevision
      ? { ...detailed, lastModifiedDateTime: current.lastModifiedDateTime } : detailed)
      && !packageControlIdentityChanged(detailed, current));
  const state: PackageDetailFreshness["state"] = !compatible ? "invalidated"
    : compareInventoryTimestamps(saved.expiresAt, new Date(now)) > 0
      && compareInventoryTimestamps(saved.observedAt, new Date(now)) <= 0 ? "fresh" : "stale";
  const result: CopilotPackageDetail = {
    ...current,
    ...(saved.package?.identityRevalidationRequired ? { identityRevalidationRequired: true } : {}),
    detailFreshness: { state, observedAt: saved.observedAt, expiresAt: saved.expiresAt },
  };
  if (!compatible) {
    delete result.elementDetails;
    delete result.identityDetailsCollected;
    result.identityRevalidationRequired = true;
    return result;
  }
  // Detail enrichment never replaces the catalog's summary, revision markers, or block/access scope.
  for (const key of ["longDescription", "categories", "sensitivity", "elementDetails"] as const) {
    delete result[key];
    Object.assign(result, saved.package![key] === undefined ? {} : { [key]: saved.package![key] });
  }
  const newerCatalog = currentReadStartedAt !== undefined
    && compareInventoryTimestamps(new Date(currentReadStartedAt), saved.observedAt) > 0;
  if (!newerCatalog) {
    for (const field of ["ownerId", "agentIdentityId", "providerUsage"] as const) {
      delete result[field];
      if (saved.package![field] !== undefined) Object.assign(result, { [field]: saved.package![field] });
    }
    result.provenance = { ...result.provenance };
    for (const field of Object.keys(result.provenance)) {
      if (field === "ownerId" || field === "agentIdentityId" || field.startsWith("providerUsage.")) delete result.provenance[field];
    }
    for (const [field, provenance] of Object.entries(saved.package!.provenance ?? {})) {
      if (field === "ownerId" || field === "agentIdentityId" || field.startsWith("providerUsage.")) result.provenance[field] = provenance;
    }
  }
  if (!(newerCatalog && current.sharedWithUsersAndGroups !== undefined)) {
    delete result.sharedWithUsersAndGroups;
    if (saved.package!.sharedWithUsersAndGroups !== undefined) result.sharedWithUsersAndGroups = saved.package!.sharedWithUsersAndGroups;
  }
  if (packageDetailAccessScopesMatch(current.availableTo, saved.package!.availableTo)
    && !(newerCatalog && current.allowedUsersAndGroups !== undefined)) {
    delete result.allowedUsersAndGroups;
    if (saved.package!.allowedUsersAndGroups !== undefined) result.allowedUsersAndGroups = saved.package!.allowedUsersAndGroups;
  }
  if (packageDetailAccessScopesMatch(current.deployedTo, saved.package!.deployedTo)
    && !(newerCatalog && current.acquireUsersAndGroups !== undefined)) {
    delete result.acquireUsersAndGroups;
    if (saved.package!.acquireUsersAndGroups !== undefined) result.acquireUsersAndGroups = saved.package!.acquireUsersAndGroups;
  }
  if (!result.identityRevalidationRequired && compareInventoryTimestamps(saved.observedAt, new Date(now)) <= 0) result.identityDetailsCollected = true;
  else delete result.identityDetailsCollected;
  return result;
}
