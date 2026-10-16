import { createHash } from "node:crypto";
import { AppError } from "../errors.js";
import type { AuditAction } from "../types/audit.js";
import { isPackageAccessEntity, isWritablePackageAccessScope, normalizePackageStatus, packageAccessCollectionLimit } from "../types/copilotPackage.js";
import type { CopilotPackageDetail, PackageAccessEntity, PackageAccessUpdate } from "../types/copilotPackage.js";

type PackageBlockMutationState = {
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

export function capturePackageMutationState(details: Pick<CopilotPackageDetail,
  "isBlocked" | "availableTo" | "deployedTo" | "allowedUsersAndGroups" | "acquireUsersAndGroups">, action: AuditAction): PackageMutationState {
  const observed = mutationRecord(details);
  if (action === "block" || action === "unblock") {
    if (typeof observed.isBlocked !== "boolean") throw new AppError(409, "incomplete_package_block_state", "An explicit current block state is required.");
    return { kind: "block", isBlocked: observed.isBlocked };
  }
  if (action === "reassign") {
    throw new AppError(409, "reassign_verification_unavailable", "Package owner reassignment is not implemented: Microsoft Graph package detail does not expose an owner field for verifying the result.");
  }
  if (observed.allowedUsersAndGroups === undefined || observed.acquireUsersAndGroups === undefined) {
    throw new AppError(409, "incomplete_package_access_state", "Both package access collections must be present before an access change can be confirmed.");
  }
  const allowedUsersAndGroups = canonicalAccessEntities(observed.allowedUsersAndGroups);
  const acquireUsersAndGroups = canonicalAccessEntities(observed.acquireUsersAndGroups);
  const availableTo = normalizeScope(observed.availableTo, allowedUsersAndGroups);
  const deployedTo = normalizeScope(observed.deployedTo, acquireUsersAndGroups);
  if (availableTo === "unknown" || deployedTo === "unknown") {
    throw new AppError(409, "ambiguous_access_scope", "Both package access scopes must be unambiguous before an access change can be confirmed.");
  }
  return { kind: "access", availableTo, deployedTo, allowedUsersAndGroups, acquireUsersAndGroups };
}

export function expectedPackageMutationState(before: PackageMutationState, action: AuditAction, accessUpdate?: PackageAccessUpdate): PackageMutationState {
  before = canonicalMutationState(before);
  if (action === "block" || action === "unblock") {
    if (before.kind !== "block" || accessUpdate) throw new AppError(409, "mutation_state_mismatch", "The frozen package state does not match the requested block operation.");
    return { kind: "block", isBlocked: action === "block" };
  }
  if (action === "reassign") {
    throw new AppError(409, "reassign_verification_unavailable", "Reassignment cannot be projected without a documented owner readback field.");
  }
  if (!accessUpdate || before.kind !== "access") throw new AppError(409, "mutation_state_mismatch", "The frozen package state does not match the requested access operation.");
  validatePackageAccessUpdate(accessUpdate);
  if (action !== (accessUpdate.target === "availability" ? "update-availability" : "update-installation")) {
    throw new AppError(409, "mutation_state_mismatch", "The package access action does not match its selected target.");
  }
  const requested = canonicalAccessEntities(accessUpdate.principals);
  const previousScope = accessUpdate.target === "availability" ? before.availableTo : before.deployedTo;
  const previousPrincipals = canonicalAccessEntities(accessUpdate.target === "availability" ? before.allowedUsersAndGroups : before.acquireUsersAndGroups);
  if (accessUpdate.mode === "add" && previousScope === "all") return before;
  const principals = accessUpdate.mode === "add" && previousScope === "some"
    ? canonicalAccessEntities([...new Map([...previousPrincipals, ...requested].map(principal => [`${principal.resourceType}:${principal.resourceId}`, principal])).values()])
    : requested;
  if (accessUpdate.target === "availability") {
    return { ...before, availableTo: accessUpdate.scope === "none" ? "none" : "some", allowedUsersAndGroups: principals };
  }
  return { ...before, deployedTo: accessUpdate.scope === "none" ? "none" : "some", acquireUsersAndGroups: principals };
}

export function packageMutationStateHash(state: PackageMutationState) {
  // Preserve capture's field order for existing hashes; JSONB does not retain object key order.
  return createHash("sha256").update(JSON.stringify(canonicalMutationState(state))).digest("hex");
}

export function packageMutationStatesEqual(left: PackageMutationState, right: PackageMutationState) {
  return packageMutationStateHash(left) === packageMutationStateHash(right);
}

export function requirePreservablePackageAccessScope(status: string | undefined, principals: readonly PackageAccessEntity[]) {
  if (!isWritablePackageAccessScope(status, principals)) {
    throw new AppError(409, "unpreservable_access_scope", "The untouched access setting cannot be preserved by Microsoft Graph's collection-only PATCH. No write was dispatched; review both access settings.");
  }
}

export function validatePackageAccessUpdate(update: PackageAccessUpdate) {
  const record = mutationRecord(update, "invalid_access_update");
  if (record.target !== "availability" && record.target !== "installation"
    || record.mode !== "add" && record.mode !== "replace"
    || record.scope !== "specific" && record.scope !== "none") {
    throw new AppError(400, "invalid_access_update", "Package access requires a supported target, mode, and scope.");
  }
  if (!Array.isArray(record.principals) || record.principals.length > packageAccessCollectionLimit) {
    throw new AppError(400, "invalid_principals", "Package access requires at most 5000 principals per collection.");
  }
  if (record.scope === "none" ? record.mode !== "replace" || record.principals.length !== 0 : record.principals.length === 0) {
    throw new AppError(400, "invalid_access_update", "Specific access requires principals; no users requires replace mode and no principals.");
  }
}

export function requirePersistablePackageMutationState(state: PackageMutationState) {
  const canonical = canonicalMutationState(state);
  // JSONB text adds a space after each colon/comma, including principal objects and array separators.
  const punctuation = canonical.kind === "block" ? 3 : 9
    + [canonical.allowedUsersAndGroups, canonical.acquireUsersAndGroups]
      .reduce((total, principals) => total + principals.length * 3 + Math.max(0, principals.length - 1), 0);
  const bytes = Buffer.byteLength(JSON.stringify(canonical)) + punctuation;
  if (bytes > 65_536) {
    throw new AppError(413, "mutation_state_too_large", "The complete package mutation state exceeds durable verification storage. Reduce assignments before confirming a new write; oversized readback requires review.", { limit: 65_536, observed: bytes });
  }
  return canonical;
}

function canonicalMutationState(state: PackageMutationState): PackageMutationState {
  const record = mutationRecord(state);
  if (record.kind === "block" && typeof record.isBlocked === "boolean") {
    return { kind: "block", isBlocked: record.isBlocked };
  }
  if (record.kind !== "access"
    || record.availableTo !== "all" && record.availableTo !== "some" && record.availableTo !== "none"
    || record.deployedTo !== "all" && record.deployedTo !== "some" && record.deployedTo !== "none") {
    throw new AppError(400, "invalid_mutation_state", "Package mutation state requires an explicit boolean block state or both canonical access scopes.");
  }
  return {
    kind: "access",
    availableTo: record.availableTo,
    deployedTo: record.deployedTo,
    allowedUsersAndGroups: canonicalAccessEntities(record.allowedUsersAndGroups),
    acquireUsersAndGroups: canonicalAccessEntities(record.acquireUsersAndGroups),
  };
}

export function canonicalAccessEntities(entities: unknown) {
  if (!Array.isArray(entities) || entities.length > packageAccessCollectionLimit) {
    throw new AppError(400, "invalid_principals", "Package access requires at most 5000 principals per collection.");
  }
  const values = Array.from({ length: entities.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(entities, index);
    const entity: unknown = property && Object.hasOwn(property, "value") ? property.value : undefined;
    if (!isPackageAccessEntity(entity)) {
      throw new AppError(400, "invalid_principal", "Each access principal requires a user/group type and a bounded, control-free opaque ID.");
    }
    return { resourceType: entity.resourceType.toLowerCase(), resourceId: entity.resourceId };
  });
  const keys = values.map(entity => `${entity.resourceType}:${entity.resourceId}`);
  if (new Set(keys).size !== keys.length) throw new AppError(400, "duplicate_principal", "Duplicate package access principals are not allowed.");
  return values.sort((left, right) => ordinal(`${left.resourceType}:${left.resourceId}`, `${right.resourceType}:${right.resourceId}`));
}

function mutationRecord(value: unknown, code = "invalid_mutation_state"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, code, "Package mutation evidence must be an object with own data properties.");
  }
  const result: Record<string, unknown> = Object.setPrototypeOf({}, null);
  for (const key of Object.getOwnPropertyNames(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !Object.hasOwn(property, "value")) {
      throw new AppError(400, code, "Package mutation evidence must contain own data properties.");
    }
    result[key] = property.value;
  }
  return result;
}

function normalizeScope(value: unknown, principals: PackageAccessEntity[]) {
  if (value !== undefined && typeof value !== "string") return "unknown";
  return normalizePackageStatus(value) ?? (value === undefined && principals.length ? "some" : "unknown");
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}