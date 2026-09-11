import { createHash } from "node:crypto";
import { AppError } from "../errors.js";
import type { AuditAction } from "../types/audit.js";
import type { CopilotPackageDetail, PackageAccessEntity, PackageAccessUpdate } from "../types/copilotPackage.js";

export type PackageBlockMutationState = {
  kind: "block";
  isBlocked: boolean;
};

export type PackageAccessMutationState = {
  kind: "access";
  availableTo: "all" | "some" | "none";
  deployedTo: "all" | "some" | "none";
  allowedUsersAndGroups: PackageAccessEntity[];
  acquireUsersAndGroups: PackageAccessEntity[];
};

export type PackageMutationState = PackageBlockMutationState | PackageAccessMutationState;

export function capturePackageMutationState(details: CopilotPackageDetail, action: AuditAction): PackageMutationState {
  if (action === "block" || action === "unblock") {
    return { kind: "block", isBlocked: details.isBlocked };
  }
  if (action === "reassign") {
    throw new AppError(409, "reassign_verification_unavailable", "Microsoft Graph documents reassignment but does not expose an owner field for provider readback. Reassign owner remains disabled until a verifiable owner contract is published.");
  }
  if (details.allowedUsersAndGroups === undefined || details.acquireUsersAndGroups === undefined) {
    throw new AppError(409, "incomplete_package_access_state", "Both package access collections must be present before an access change can be confirmed.");
  }
  const allowedUsersAndGroups = canonicalAccessEntities(details.allowedUsersAndGroups);
  const acquireUsersAndGroups = canonicalAccessEntities(details.acquireUsersAndGroups);
  const availableTo = normalizeScope(details.availableTo, allowedUsersAndGroups);
  const deployedTo = normalizeScope(details.deployedTo, acquireUsersAndGroups);
  if (availableTo === "unknown" || deployedTo === "unknown") {
    throw new AppError(409, "ambiguous_access_scope", "Both package access scopes must be unambiguous before an access change can be confirmed.");
  }
  return { kind: "access", availableTo, deployedTo, allowedUsersAndGroups, acquireUsersAndGroups };
}

export function expectedPackageMutationState(before: PackageMutationState, action: AuditAction, accessUpdate?: PackageAccessUpdate): PackageMutationState {
  if (action === "block" || action === "unblock") {
    if (before.kind !== "block") throw new AppError(409, "mutation_state_mismatch", "The frozen package state does not match the requested block operation.");
    return { kind: "block", isBlocked: action === "block" };
  }
  if (action === "reassign") {
    throw new AppError(409, "reassign_verification_unavailable", "Reassignment cannot be projected without a documented owner readback field.");
  }
  if (!accessUpdate || before.kind !== "access") throw new AppError(409, "mutation_state_mismatch", "The frozen package state does not match the requested access operation.");
  const principals = canonicalAccessEntities(accessUpdate.principals);
  if (accessUpdate.target === "availability") {
    return { ...before, availableTo: accessUpdate.scope === "none" ? "none" : "some", allowedUsersAndGroups: principals };
  }
  return { ...before, deployedTo: accessUpdate.scope === "none" ? "none" : "some", acquireUsersAndGroups: principals };
}

export function packageMutationStateHash(state: PackageMutationState) {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

export function packageMutationStatesEqual(left: PackageMutationState, right: PackageMutationState) {
  return packageMutationStateHash(left) === packageMutationStateHash(right);
}

export function canonicalAccessEntities(entities: readonly PackageAccessEntity[]) {
  const values = entities.map(entity => {
    if (typeof entity.resourceId !== "string" || typeof entity.resourceType !== "string" || !entity.resourceId.trim() || !entity.resourceType.trim()) {
      throw new AppError(400, "invalid_principal", "Each access principal requires a resource type and ID.");
    }
    return { resourceType: entity.resourceType.trim().toLowerCase(), resourceId: entity.resourceId.trim().toLowerCase() };
  });
  const keys = values.map(entity => `${entity.resourceType}:${entity.resourceId}`);
  if (new Set(keys).size !== keys.length) throw new AppError(400, "duplicate_principal", "Duplicate package access principals are not allowed.");
  return values.sort((left, right) => ordinal(`${left.resourceType}:${left.resourceId}`, `${right.resourceType}:${right.resourceId}`));
}

function normalizeScope(value: string | undefined, principals: PackageAccessEntity[]) {
  const normalized = value?.replace(/[^a-z0-9]/gi, "").toLowerCase() ?? "";
  if (["all", "everyone", "allowedforall", "availabletoall", "deployedtoall", "installedforall"].includes(normalized)) return "all" as const;
  if (["none", "noone", "allowedfornoone", "availabletonoone", "deployedtonone", "installedfornoone", "notavailable", "notdeployed"].includes(normalized)) return "none" as const;
  if (["some", "allowedforsome", "availabletosome", "deployedtosome", "installedforsome"].includes(normalized) || principals.length) return "some" as const;
  return "unknown" as const;
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}