import type {
  PackageAccessEntity,
  PackageAccessScope,
  PackageStatus,
} from "./api/client";

export type AccessScopeSelection = PackageAccessScope | "all";

export function getInitialAccessScope(
  status: PackageStatus | undefined,
  principals: PackageAccessEntity[],
): AccessScopeSelection | undefined {
  const normalizedStatus = normalizePackageStatus(status);

  if (normalizedStatus === "all") {
    return "all";
  }

  if (normalizedStatus === "some") {
    return "specific";
  }

  if (normalizedStatus === "none") {
    return "none";
  }

  return principals.length > 0 ? "specific" : undefined;
}

export function formatAccessScope(
  status: PackageStatus | undefined,
  principals: PackageAccessEntity[],
) {
  const scope = getInitialAccessScope(status, principals);

  if (scope === "all") {
    return "All users";
  }

  if (scope === "specific") {
    return "Specific users or groups";
  }

  if (scope === "none") {
    return "No users";
  }

  return "Unknown";
}

function normalizePackageStatus(status: PackageStatus | undefined) {
  const normalized = status?.replace(/[^a-z0-9]/gi, "").toLowerCase();

  if (
    normalized === "all" ||
    normalized === "everyone" ||
    normalized === "allowedforall" ||
    normalized === "availabletoall" ||
    normalized === "deployedtoall" ||
    normalized === "installedforall"
  ) {
    return "all" as const;
  }

  if (
    normalized === "some" ||
    normalized === "allowedforsome" ||
    normalized === "availabletosome" ||
    normalized === "deployedtosome" ||
    normalized === "installedforsome"
  ) {
    return "some" as const;
  }

  if (
    normalized === "none" ||
    normalized === "noone" ||
    normalized === "allowedfornoone" ||
    normalized === "availabletonoone" ||
    normalized === "deployedtonoone" ||
    normalized === "installedfornoone" ||
    normalized === "notavailable" ||
    normalized === "notdeployed"
  ) {
    return "none" as const;
  }

  return undefined;
}
