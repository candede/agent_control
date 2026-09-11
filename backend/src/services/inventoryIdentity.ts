import type { CopilotPackage } from "../types/copilotPackage.js";
import type { InventoryIdentifier, InventoryIdentifierKind, PowerPlatformResource } from "../types/powerPlatformInventory.js";

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

export function packageInventoryIdentity(tenantId: string, value: CopilotPackage): InventoryIdentityRecord {
  return {
    nativeId: value.id,
    tenantId,
    environmentId: null,
    sourceSystem: "graph_packages",
    resourceType: "microsoft.graph/copilotpackages",
    identifiers: sortIdentifiers([
      { kind: "package_id", value: value.id },
      ...(value.appId ? [{ kind: "package_app_id" as const, value: value.appId }] : []),
      ...(value.manifestId ? [{ kind: "manifest_id" as const, value: value.manifestId }] : []),
      ...(value.assetId ? [{ kind: "asset_id" as const, value: value.assetId }] : []),
    ]),
  };
}

export function powerPlatformInventoryIdentity(value: PowerPlatformResource): InventoryIdentityRecord {
  return {
    nativeId: value.nativeId,
    tenantId: value.tenantId,
    environmentId: value.environmentId,
    sourceSystem: "power_platform",
    resourceType: value.type,
    identifiers: sortIdentifiers(value.identifiers),
  };
}

export function resolveExactInventoryIdentity(source: InventoryIdentityRecord, candidates: readonly InventoryIdentityRecord[], options: {
  documentedCrossSourceKinds?: readonly InventoryIdentifierKind[];
  blueprintParentAcrossSources?: boolean;
} = {}): IdentityResolution {
  const sourceIdentifiers = sortIdentifiers(source.identifiers);
  const sourceBlueprint = sourceIdentifiers.find(identifier => identifier.kind === "entra_blueprint_id");
  const documentedCrossSourceKinds = new Set(options.documentedCrossSourceKinds ?? []);
  const orderedCandidates = [...candidates].sort((left, right) => ordinal(identityKey(left), identityKey(right)));
  const matches = orderedCandidates.flatMap(candidate => {
    if (candidate.tenantId !== source.tenantId) return [];
    for (const sourceIdentifier of sourceIdentifiers) {
      if (!equivalentKinds.has(sourceIdentifier.kind)) continue;
      if (candidate.sourceSystem !== source.sourceSystem && !documentedCrossSourceKinds.has(sourceIdentifier.kind)) continue;
      const candidateIdentifier = sortIdentifiers(candidate.identifiers).find(identifier => identifier.kind === sourceIdentifier.kind && identifier.value === sourceIdentifier.value);
      if (!candidateIdentifier) continue;
      if (environmentScopedKinds.has(sourceIdentifier.kind) && (!source.environmentId || !candidate.environmentId || source.environmentId !== candidate.environmentId)) continue;
      if (sourceIdentifier.kind === "power_platform_resource_id" && source.resourceType !== candidate.resourceType) continue;
      return [{ candidate, kind: sourceIdentifier.kind }];
    }
    return [];
  });
  const unique = [...new Map(matches.map(match => [identityKey(match.candidate), match])).values()];
  if (unique.length === 1) return { status: "resolved", candidate: identityScope(unique[0].candidate), matchedKind: unique[0].kind };
  if (unique.length > 1) return { status: "ambiguous", reason: "multiple_exact_candidates", candidates: unique.slice(0, 20).map(match => identityScope(match.candidate)), ...(unique.length > 20 ? { candidateCount: unique.length, candidatesTruncated: true as const } : {}) };
  if (sourceBlueprint && orderedCandidates.some(candidate => candidate.tenantId === source.tenantId
    && (candidate.sourceSystem === source.sourceSystem || options.blueprintParentAcrossSources)
    && candidate.identifiers.some(identifier => identifier.kind === "entra_blueprint_id" && identifier.value === sourceBlueprint.value))) {
    return { status: "unresolved", reason: "blueprint_is_parent_not_equivalence" };
  }
  if (orderedCandidates.some(candidate => candidate.tenantId === source.tenantId && candidate.sourceSystem !== source.sourceSystem)) return { status: "unresolved", reason: "no_documented_cross_source_relation" };
  return { status: "unresolved", reason: "no_documented_exact_identifier" };
}

export function sortIdentifiers(identifiers: InventoryIdentifier[]) {
  return [...identifiers].sort((left, right) => ordinal(`${left.kind}\0${left.value}`, `${right.kind}\0${right.value}`));
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identityKey(value: InventoryIdentityRecord) {
  return `${value.tenantId}\0${value.sourceSystem}\0${value.resourceType}\0${value.environmentId ?? ""}\0${value.nativeId}`;
}

function identityScope(value: InventoryIdentityRecord): InventoryIdentityScope {
  return { nativeId: value.nativeId, tenantId: value.tenantId, environmentId: value.environmentId, sourceSystem: value.sourceSystem, resourceType: value.resourceType };
}