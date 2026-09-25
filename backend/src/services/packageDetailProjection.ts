import type { CopilotPackageDetail, PackageDetailFreshness } from "../types/copilotPackage.js";
import { packageControlIdentityChanged } from "./packageControlProjection.js";

export type SavedPackageDetail = {
  package: CopilotPackageDetail | null;
  observedAt: string;
  expiresAt: string;
  catalogRevision?: ReturnType<typeof packageDetailRevision> | null;
};

export function packageDetailRevision(value: CopilotPackageDetail) {
  return [value.lastModifiedDateTime, value.appId, value.manifestId, value.assetId, value.version, value.manifestVersion]
    .map(marker => marker ?? null);
}

export function packageDetailRevisionMatches(current: CopilotPackageDetail, detailed: CopilotPackageDetail) {
  const modified = current.lastModifiedDateTime;
  return Boolean(modified && Number.isFinite(Date.parse(modified))
    && packageDetailRevision(current).slice(1).some(marker => typeof marker === "string" && marker.trim())
    && JSON.stringify(packageDetailRevision(current)) === JSON.stringify(packageDetailRevision(detailed)));
}

function hasCollectedDetails(value: CopilotPackageDetail) {
  return value.identityDetailsCollected === true || Array.isArray(value.elementDetails) && value.elementDetails.some(detail =>
    detail && typeof detail.elementType === "string" && detail.elementType.length > 0 && Array.isArray(detail.elements)
      && detail.elements.some(element => element && typeof element.id === "string" && typeof element.definition === "string"));
}

export function projectPackageDetails(current: CopilotPackageDetail, saved: SavedPackageDetail | undefined,
  authoritativeCurrent = false, now = Date.now(), currentReadStartedAt?: number): CopilotPackageDetail {
  if (!saved || saved.package && !hasCollectedDetails(saved.package)) {
    const result = { ...current, detailFreshness: { state: "missing" as const, observedAt: null, expiresAt: null } };
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
  const compatible = catalogMatches && detailed && detailed.id === current.id
    && (authoritativeCurrent || packageDetailRevisionMatches(current, saved.catalogRevision
      ? { ...detailed, lastModifiedDateTime: current.lastModifiedDateTime } : detailed)
      && !packageControlIdentityChanged(detailed, current));
  const state: PackageDetailFreshness["state"] = !compatible ? "invalidated"
    : Date.parse(saved.expiresAt) > now && Date.parse(saved.observedAt) <= now ? "fresh" : "stale";
  const result: CopilotPackageDetail = {
    ...current,
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
  const newerCatalog = currentReadStartedAt !== undefined && currentReadStartedAt > Date.parse(saved.observedAt);
  if (current.availableTo === saved.package!.availableTo && !(newerCatalog && current.allowedUsersAndGroups !== undefined)) {
    delete result.allowedUsersAndGroups;
    if (saved.package!.allowedUsersAndGroups !== undefined) result.allowedUsersAndGroups = saved.package!.allowedUsersAndGroups;
  }
  if (current.deployedTo === saved.package!.deployedTo && !(newerCatalog && current.acquireUsersAndGroups !== undefined)) {
    delete result.acquireUsersAndGroups;
    if (saved.package!.acquireUsersAndGroups !== undefined) result.acquireUsersAndGroups = saved.package!.acquireUsersAndGroups;
  }
  if (state === "fresh" && !current.identityRevalidationRequired) result.identityDetailsCollected = true;
  else delete result.identityDetailsCollected;
  return result;
}
