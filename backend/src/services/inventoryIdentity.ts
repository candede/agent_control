import type { InventoryIdentifier, InventoryIdentifierKind } from "../types/powerPlatformInventory.js";

export type InventoryIdentityRecord = {
  nativeId: string;
  tenantId: string;
  environmentId: string | null;
  sourceSystem: "power_platform" | "graph_packages" | "defender_hunting";
  resourceType: string;
  identifiers: InventoryIdentifier[];
};

export type InventoryIdentityScope = Pick<InventoryIdentityRecord, "nativeId" | "tenantId" | "environmentId" | "sourceSystem" | "resourceType">;

export type IdentityResolution =
  | { status: "resolved"; candidate: InventoryIdentityScope; matchedKind: InventoryIdentifierKind }
  | { status: "unresolved"; reason: "no_documented_exact_identifier" | "no_documented_cross_source_relation" | "blueprint_is_parent_not_equivalence" }
  | { status: "ambiguous"; reason: "multiple_exact_candidates"; candidates: InventoryIdentityScope[]; candidateCount?: number; candidatesTruncated?: true };

const equivalentKinds = new Set<InventoryIdentifierKind>([
  "power_platform_resource_id",
  "cds_bot_id",
  "entra_app_id",
  "entra_agent_id",
  "package_id",
  "package_app_id",
  "manifest_id",
  "asset_id",
]);
const environmentScopedKinds = new Set<InventoryIdentifierKind>(["power_platform_resource_id", "cds_bot_id"]);
export const inventoryGuidPattern = "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$";
export const inventoryEnvironmentPattern = "^(Default-)?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$";
const guidPattern = new RegExp(inventoryGuidPattern, "i");
const environmentPattern = new RegExp(inventoryEnvironmentPattern, "i");

export function normalizeNativeIdentity(value: string): string {
  return value.length === 36 && guidPattern.test(value)
    ? value.toLowerCase() : value;
}

export function normalizeEnvironmentIdentity(value: string): string {
  return (value.length === 36 || value.length === 44) && environmentPattern.test(value)
    ? value.toLowerCase() : value;
}

export function normalizeInventoryIdentifier(identifier: InventoryIdentifier): string {
  return identifier.kind === "package_id" || identifier.kind === "package_app_id"
    || identifier.kind === "manifest_id" || identifier.kind === "asset_id"
    ? identifier.value : identifier.kind === "environment_id" ? normalizeEnvironmentIdentity(identifier.value)
      : normalizeNativeIdentity(identifier.value);
}

export function powerPlatformAgentKey(environmentId: string | null, nativeId: string): string {
  return JSON.stringify([normalizeEnvironmentIdentity(environmentId ?? ""), normalizeNativeIdentity(nativeId)]);
}

export function resolveExactInventoryIdentity(source: InventoryIdentityRecord, candidates: readonly InventoryIdentityRecord[], options: {
  documentedCrossSourceKinds?: readonly InventoryIdentifierKind[];
  blueprintParentAcrossSources?: boolean;
} = {}): IdentityResolution {
  const sourceIdentifiers = sortIdentifiers(source.identifiers).filter(identifier => identifier.value !== "");
  const sourceBlueprints = new Set(sourceIdentifiers.filter(identifier => identifier.kind === "entra_blueprint_id")
    .map(identifier => normalizeNativeIdentity(identifier.value)));
  const documentedCrossSourceKinds = new Set(options.documentedCrossSourceKinds ?? []);
  const orderedCandidates = candidates.filter(candidate => normalizeNativeIdentity(candidate.tenantId) === normalizeNativeIdentity(source.tenantId))
    .sort((left, right) => ordinal(identityKey(left), identityKey(right)) || ordinal(rawIdentityKey(left), rawIdentityKey(right)));
  const matches = orderedCandidates.flatMap(candidate => {
    const candidateIdentifiers = new Set(candidate.identifiers.map(identifier =>
      JSON.stringify([identifier.kind, normalizeInventoryIdentifier(identifier)])));
    for (const sourceIdentifier of sourceIdentifiers) {
      if (!equivalentKinds.has(sourceIdentifier.kind)) continue;
      if (candidate.sourceSystem !== source.sourceSystem && !documentedCrossSourceKinds.has(sourceIdentifier.kind)) continue;
      if (!candidateIdentifiers.has(JSON.stringify([sourceIdentifier.kind, normalizeInventoryIdentifier(sourceIdentifier)]))) continue;
      if (environmentScopedKinds.has(sourceIdentifier.kind) && (!source.environmentId || !candidate.environmentId
        || normalizeEnvironmentIdentity(source.environmentId) !== normalizeEnvironmentIdentity(candidate.environmentId))) continue;
      if (sourceIdentifier.kind === "power_platform_resource_id" && source.resourceType !== candidate.resourceType) continue;
      return [{ candidate, kind: sourceIdentifier.kind }];
    }
    return [];
  });
  const byIdentity = new Map<string, typeof matches[number]>();
  for (const match of matches) {
    const key = identityKey(match.candidate);
    const existing = byIdentity.get(key);
    if (!existing) byIdentity.set(key, match);
    else if (ordinal(match.kind, existing.kind) < 0) byIdentity.set(key, match);
  }
  const unique = [...byIdentity.values()];
  if (unique.length === 1) return { status: "resolved", candidate: identityScope(unique[0].candidate), matchedKind: unique[0].kind };
  if (unique.length > 1) return { status: "ambiguous", reason: "multiple_exact_candidates", candidates: unique.slice(0, 20).map(match => identityScope(match.candidate)), ...(unique.length > 20 ? { candidateCount: unique.length, candidatesTruncated: true as const } : {}) };
  if (orderedCandidates.some(candidate => (candidate.sourceSystem === source.sourceSystem || options.blueprintParentAcrossSources)
    && candidate.identifiers.some(identifier => identifier.kind === "entra_blueprint_id" && sourceBlueprints.has(normalizeNativeIdentity(identifier.value))))) {
    return { status: "unresolved", reason: "blueprint_is_parent_not_equivalence" };
  }
  if (orderedCandidates.some(candidate => candidate.sourceSystem !== source.sourceSystem)) return { status: "unresolved", reason: "no_documented_cross_source_relation" };
  return { status: "unresolved", reason: "no_documented_exact_identifier" };
}

export function sortIdentifiers(identifiers: InventoryIdentifier[]) {
  return [...identifiers].sort((left, right) => ordinal(`${left.kind}\0${left.value}`, `${right.kind}\0${right.value}`));
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identityKey(value: InventoryIdentityRecord) {
  return JSON.stringify([normalizeNativeIdentity(value.tenantId), value.sourceSystem, value.resourceType,
    normalizeEnvironmentIdentity(value.environmentId ?? ""), value.sourceSystem === "graph_packages" ? value.nativeId : normalizeNativeIdentity(value.nativeId)]);
}

function rawIdentityKey(value: InventoryIdentityRecord) {
  return JSON.stringify([value.tenantId, value.sourceSystem, value.resourceType, value.environmentId, value.nativeId]);
}

function identityScope(value: InventoryIdentityRecord): InventoryIdentityScope {
  return { nativeId: value.nativeId, tenantId: value.tenantId, environmentId: value.environmentId, sourceSystem: value.sourceSystem, resourceType: value.resourceType };
}