import { normalizePackageStatus } from "../../backend/src/types/copilotPackage";
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
