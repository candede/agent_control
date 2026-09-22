import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { normalizeNativeIdentity, powerPlatformAgentKey } from "./inventoryIdentity.js";
import {
  isPackageElementType, normalizedEnvironmentId, normalizedGuid, normalizedSchemaName,
  readPackageAgentMetadata, readPackageCustomEngineBotIdentity, supplied, type PackageAgentMetadata,
} from "./packageAgentMetadata.js";

export type PackageAgentLinkEvidence = {
  kind: "entra_agent_id" | "environment_entra_app_id" | "environment_cds_bot_id" | "environment_schema_native_id" | "manifest_schema_native_id" | "shared_custom_engine_bot_id";
  basis: "source_declared_metadata";
  elementIds: string[];
  packagePath: string;
  resourcePath: string;
  relatedPackageIds?: string[];
};

export type PackageAgentIdentityWarning = {
  code: "source_specific_agent_identity";
  message: string;
};

export type PackageAgentLinkResolution =
  | {
      packageId: string;
      status: "matched";
      resource: { nativeId: string; environmentId: string };
      evidence: PackageAgentLinkEvidence[];
      warnings?: PackageAgentIdentityWarning[];
      controlBotId?: string;
    }
  | {
      packageId: string;
      status: "unmatched" | "ambiguous" | "conflicting";
      reason: string;
      invalidMetadata?: true;
      grouping?: { key: string; environmentId: string | null };
    };

const metadataPath = "elementDetails.AgentMetadatas.definition";

export function resolvePackageAgentLinks(
  tenantId: string,
  packages: readonly CopilotPackageDetail[],
  resources: readonly PowerPlatformResource[],
): PackageAgentLinkResolution[] {
  const candidates = resources.filter(resource =>
    normalizeNativeIdentity(resource.tenantId) === normalizeNativeIdentity(tenantId)
      && resource.type === "microsoft.copilotstudio/agents",
  );
  const index = new Map<string, Set<PowerPlatformResource>>();
  const add = (key: string, resource: PowerPlatformResource) => {
    const values = index.get(key) ?? new Set<PowerPlatformResource>();
    values.add(resource);
    index.set(key, values);
  };
  for (const resource of candidates) {
    const environmentId = normalizedEnvironmentId(resource.environmentId);
    if (!environmentId) continue;
    for (const kind of ["entra_agent_id", "entra_app_id", "cds_bot_id"] as const) {
      for (const id of identifierValues(resource, kind)) add(identityKey(environmentId, kind, id), resource);
    }
    const schemaName = normalizedSchemaName(resource.details.schemaName);
    const nativeId = normalizedGuid(resource.nativeId);
    if (schemaName && nativeId) {
      add(identityKey(environmentId, "schema_native", `${schemaName}\0${nativeId}`), resource);
      if (schemaName === nativeId) add(identityKey("", "declarative_manifest", nativeId), resource);
    }
  }
  const identities = new Map<string, PackageAgentMetadata>();
  const resolutions: PackageAgentLinkResolution[] = packages.map(value => {
    const observation = readPackageAgentMetadata(value);
    if (observation.status === "conflicting" || observation.status === "unmatched" && observation.invalidMetadata) {
      return { packageId: value.id, ...observation };
    }
    const identity = observation.identity;
    if (identity) identities.set(value.id, identity);
    const elementIds = observation.status === "available" ? observation.elementIds : [];
    const declarativeElements = value.elementDetails?.filter(group => isPackageElementType(group.elementType, "DeclarativeCopilots"))
      .flatMap(group => group.elements) ?? [];
    const isDeclarative = declarativeElements.length > 0 || value.elementTypes?.some(type => isPackageElementType(type, "DeclarativeCopilots"));
    const manifestId = isDeclarative ? normalizedGuid(value.manifestId) : undefined;
    if (manifestId && !identity?.cdsBotId && identity?.manifestId && manifestId !== identity.manifestId) {
      return { packageId: value.id, status: "conflicting", reason: "The package manifest identity disagrees with its source metadata; no link was created." };
    }
    if (manifestId && declarativeElements.length > 1) {
      return { packageId: value.id, status: "ambiguous", reason: "The package contains multiple declarative agents; a manifest alone cannot select one native agent." };
    }
    const grouping = identity?.environmentId && identity.cdsBotId
      ? { key: identityKey(identity.environmentId, "cds_bot_id", identity.cdsBotId), environmentId: identity.environmentId }
      : manifestId && !identity?.cdsBotId
        ? { key: identityKey(identity?.environmentId ?? "", "declarative_manifest", manifestId), environmentId: identity?.environmentId ?? null }
        : undefined;
    const possibleCandidates = new Set<PowerPlatformResource>();
    const addCandidates = (key: string) => {
      for (const candidate of index.get(key) ?? []) possibleCandidates.add(candidate);
    };
    if (identity?.environmentId) {
      if (identity.cdsBotId) {
        addCandidates(identityKey(identity.environmentId, "cds_bot_id", identity.cdsBotId));
        if (identity.schemaName) addCandidates(identityKey(identity.environmentId, "schema_native", `${identity.schemaName}\0${identity.cdsBotId}`));
      }
      if (identity.entraApplicationId) addCandidates(identityKey(identity.environmentId, "entra_app_id", identity.entraApplicationId));
      for (const id of identity.graphAgentIds) addCandidates(identityKey(identity.environmentId, "entra_agent_id", id));
    }
    if (manifestId && !identity?.cdsBotId) addCandidates(identityKey("", "declarative_manifest", manifestId));
    const matches: Array<{
      resource: PowerPlatformResource; evidence: PackageAgentLinkEvidence[]; warnings: PackageAgentIdentityWarning[];
      primary: boolean;
    }> = [];
    let primaryConflict = false;
    let secondaryConflict = false;
    for (const resource of possibleCandidates) {
      const environmentId = normalizedEnvironmentId(resource.environmentId);
      if (!environmentId || identity?.environmentId && environmentId !== identity.environmentId) continue;
      const agentIds = identifierValues(resource, "entra_agent_id");
      const appIds = identifierValues(resource, "entra_app_id");
      const botIds = identifierValues(resource, "cds_bot_id");
      const botMatch = Boolean(identity?.cdsBotId && botIds.includes(identity.cdsBotId));
      const agentMatch = Boolean(identity?.graphAgentIds.some(id => agentIds.includes(id)));
      const appMatch = Boolean(identity?.entraApplicationId && appIds.includes(identity.entraApplicationId));
      const resourceSchemaName = normalizedSchemaName(resource.details.schemaName);
      const nativeMatch = Boolean(identity?.schemaName && identity.cdsBotId
        && resourceSchemaName === identity.schemaName && normalizedGuid(resource.nativeId) === identity.cdsBotId);
      const manifestMatch = Boolean(manifestId && !identity?.cdsBotId
        && normalizedGuid(resource.nativeId) === manifestId && resourceSchemaName === manifestId);
      if (!botMatch && !nativeMatch && !manifestMatch && !agentMatch && !appMatch) continue;
      const invalidIdentifier = resource.identifiers.some(identifier =>
        (identifier.kind === "entra_agent_id" || identifier.kind === "entra_app_id" || identifier.kind === "cds_bot_id")
          && !normalizedGuid(identifier.value)
        || identifier.kind === "environment_id" && normalizedEnvironmentId(identifier.value) !== environmentId
        || identifier.kind === "power_platform_resource_id"
          && normalizeNativeIdentity(identifier.value) !== normalizeNativeIdentity(resource.nativeId),
      );
      if (invalidIdentifier || botIds.length > 1
        || supplied(resource.details.schemaName) && !resourceSchemaName
        || identity?.cdsBotId && botIds.length > 0 && !botMatch
        || identity?.schemaName && resourceSchemaName && identity.schemaName !== resourceSchemaName
        || manifestMatch && botIds.length > 0) {
        if (botMatch || nativeMatch || manifestMatch) primaryConflict = true;
        else secondaryConflict = true;
        continue;
      }
      const evidence: PackageAgentLinkEvidence[] = [];
      if (agentMatch) evidence.push({
        kind: "entra_agent_id", basis: "source_declared_metadata", elementIds,
        packagePath: `${metadataPath}.AgentIdentityId + SourceIds.EnvironmentId`,
        resourcePath: "identifiers.entra_agent_id + environmentId",
      });
      if (appMatch) evidence.push({
        kind: "environment_entra_app_id", basis: "source_declared_metadata", elementIds,
        packagePath: `${metadataPath}.SourceIds.EnvironmentId + SourceIds.EntraApplicationId`,
        resourcePath: "environmentId + identifiers.entra_app_id",
      });
      if (botMatch) evidence.push({
        kind: "environment_cds_bot_id", basis: "source_declared_metadata", elementIds,
        packagePath: `${metadataPath}.SourceIds.EnvironmentId + SourceIds.CdsBotId`,
        resourcePath: "environmentId + identifiers.cds_bot_id",
      });
      if (nativeMatch) evidence.push({
        kind: "environment_schema_native_id", basis: "source_declared_metadata", elementIds,
        packagePath: `${metadataPath}.SourceIds.EnvironmentId + SourceIds.SchemaName + SourceIds.CdsBotId`,
        resourcePath: "environmentId + details.schemaName + nativeId",
      });
      if (manifestMatch) evidence.push({
        kind: "manifest_schema_native_id", basis: "source_declared_metadata",
        elementIds: declarativeElements.map(element => element.id).filter(Boolean).sort(),
        packagePath: "manifestId + elementTypes.DeclarativeCopilots",
        resourcePath: "nativeId + details.schemaName (declarative manifest identity, not a CDS bot ID)",
      });
      const warnings: PackageAgentIdentityWarning[] = identity?.graphAgentIds.length && agentIds.length && !agentMatch
        ? [{
            code: "source_specific_agent_identity",
            message: "The package and Power Platform report different source-specific agent identity IDs. Their exact native agent identity agrees; both source identities are retained separately.",
          }]
        : [];
      matches.push({ resource, evidence, warnings, primary: botMatch || nativeMatch || manifestMatch });
    }
    const primary = matches.filter(match => match.primary);
    const selected = primary.length ? primary : matches;
    if (primaryConflict || !primary.length && secondaryConflict) return { packageId: value.id, status: "conflicting", reason: "Provider metadata contains conflicting native agent identities; no link was created." };
    if (selected.length > 1) return { packageId: value.id, status: "ambiguous", reason: "The same explicit identity matches multiple Power Platform resources; no link was created." };
    if (selected.length === 1) {
      const match = selected[0];
      return {
        packageId: value.id, status: "matched",
        resource: { nativeId: match.resource.nativeId, environmentId: match.resource.environmentId! },
        evidence: match.evidence,
        ...(match.warnings.length ? { warnings: match.warnings } : {}),
        ...(match.evidence.some(evidence => evidence.kind === "environment_schema_native_id")
          && identity?.schemaName && !normalizedGuid(identity.schemaName) ? { controlBotId: identity.cdsBotId } : {}),
      };
    }
    return {
      packageId: value.id, status: "unmatched",
      reason: observation.status === "unmatched" && !manifestId ? observation.reason
        : "No saved Power Platform agent matches the package's source-native or declarative manifest identity.",
      ...(grouping ? { grouping } : {}),
    };
  });
  const grouped = new Map<string, { bots: Set<string>; schemas: Set<string> }>();
  const groupKeys = (resolution: PackageAgentLinkResolution) => {
    const identity = identities.get(resolution.packageId);
    const resolvedKey = resolution.status === "matched"
      ? powerPlatformAgentKey(resolution.resource.environmentId, resolution.resource.nativeId)
      : resolution.status === "unmatched" ? resolution.grouping?.key : undefined;
    const nativeKey = identity?.environmentId && identity.cdsBotId
      ? identityKey(identity.environmentId, "cds_bot_id", identity.cdsBotId) : undefined;
    return [...new Set([resolvedKey, nativeKey].filter((key): key is string => key !== undefined))];
  };
  for (const resolution of resolutions) {
    const identity = identities.get(resolution.packageId);
    if (!identity) continue;
    for (const key of groupKeys(resolution)) {
      const group = grouped.get(key) ?? { bots: new Set<string>(), schemas: new Set<string>() };
      if (identity.cdsBotId) group.bots.add(identity.cdsBotId);
      if (identity.schemaName) group.schemas.add(identity.schemaName);
      grouped.set(key, group);
    }
  }
  const validated: PackageAgentLinkResolution[] = resolutions.map(resolution => {
    const conflicting = groupKeys(resolution).some(key => {
      const group = grouped.get(key);
      return group && (group.bots.size > 1 || group.schemas.size > 1);
    });
    return conflicting
      ? { packageId: resolution.packageId, status: "conflicting", reason: "Package representations disagree about this agent's native identities or schema name; no link was created." }
      : resolution;
  });
  return linkCustomEngineRepresentations(packages, identities, validated, candidates);
}

function linkCustomEngineRepresentations(
  packages: readonly CopilotPackageDetail[],
  identities: ReadonlyMap<string, PackageAgentMetadata>,
  resolutions: readonly PackageAgentLinkResolution[],
  resources: readonly PowerPlatformResource[],
): PackageAgentLinkResolution[] {
  const resourceSchemas = new Map(resources.map(resource => [
    powerPlatformAgentKey(resource.environmentId, resource.nativeId), normalizedSchemaName(resource.details.schemaName),
  ]));
  const groups = new Map<string, Array<{ packageId: string; elementIds: string[] }>>();
  for (const value of packages) {
    const bot = readPackageCustomEngineBotIdentity(value);
    if (!bot) continue;
    const group = groups.get(bot.botApplicationId) ?? [];
    group.push({ packageId: value.id, elementIds: bot.elementIds });
    groups.set(bot.botApplicationId, group);
  }
  const result = new Map(resolutions.map(resolution => [resolution.packageId, resolution]));
  for (const [botApplicationId, members] of groups) {
    if (members.length < 2) continue;
    if (members.some(member => {
      const resolution = result.get(member.packageId)!;
      return resolution.status === "conflicting" || resolution.status === "ambiguous"
        || resolution.status === "unmatched" && resolution.invalidMetadata;
    })) continue;
    const matched = members.flatMap(member => {
      const resolution = result.get(member.packageId)!;
      return resolution.status === "matched" ? [resolution] : [];
    });
    const anchors = matched.filter(resolution => resolution.evidence.some(evidence =>
      evidence.kind === "environment_cds_bot_id" || evidence.kind === "environment_schema_native_id",
    ));
    const targets = new Set(matched.map(resolution => powerPlatformAgentKey(resolution.resource.environmentId, resolution.resource.nativeId)));
    const nativeIdentities = members.flatMap(member => identities.get(member.packageId) ?? []);
    const environments = new Set(nativeIdentities.flatMap(identity => identity.environmentId ?? []));
    const bots = new Set(nativeIdentities.flatMap(identity => identity.cdsBotId ?? []));
    const schemas = new Set([
      ...nativeIdentities.flatMap(identity => identity.schemaName ?? []),
      ...[...targets].flatMap(target => resourceSchemas.get(target) ?? []),
    ]);
    if (targets.size > 1 || environments.size > 1 || bots.size > 1 || schemas.size > 1) {
      for (const member of members) {
        const resolution = result.get(member.packageId)!;
        if (resolution.status === "unmatched" && !resolution.invalidMetadata && !identities.get(member.packageId)?.cdsBotId) {
          result.set(member.packageId, {
            packageId: member.packageId, status: "ambiguous",
            reason: "This custom-engine bot application is associated with multiple native agents; no package association was chosen.",
          });
        }
      }
      continue;
    }
    const relatedPackageIds = anchors.map(anchor => anchor.packageId).sort();
    for (const member of members) {
      const resolution = result.get(member.packageId)!;
      if (resolution.status !== "unmatched" || resolution.invalidMetadata) continue;
      if (anchors.length) {
        result.set(member.packageId, {
          packageId: member.packageId, status: "matched", resource: anchors[0].resource,
          evidence: [{
            kind: "shared_custom_engine_bot_id", basis: "source_declared_metadata", elementIds: member.elementIds,
            packagePath: "elementDetails.Bots.definition.botId + CustomEngineCopilots.definition.id (type=bot)",
            resourcePath: "related packages' exact environment and native agent identity (not a CDS bot ID alias)",
            relatedPackageIds,
          }],
        });
      } else if (!members.some(member => result.get(member.packageId)!.status !== "unmatched")) {
        const sourceGroup = members.flatMap(member => {
          const candidate = result.get(member.packageId)!;
          return candidate.status === "unmatched" && identities.get(member.packageId)?.cdsBotId && candidate.grouping ? [candidate.grouping] : [];
        })[0];
        result.set(member.packageId, {
          ...resolution,
          grouping: sourceGroup ?? { key: identityKey("", "custom_engine_bot_application", botApplicationId), environmentId: [...environments][0] ?? null },
        });
      }
    }
  }
  return resolutions.map(resolution => result.get(resolution.packageId)!);
}

export function withVerifiedControlIdentities(
  resources: readonly PowerPlatformResource[],
  links: readonly PackageAgentLinkResolution[],
  observations: Readonly<Record<string, {
    observedAt: string;
    expiresAt: string;
    identityDetails?: { observedAt: string; expiresAt: string } | null;
  }>>,
  now = Date.now(),
  maximumAgeMs = 24 * 60 * 60 * 1000,
): PowerPlatformResource[] {
  const verified = new Map<string, string>();
  for (const link of links) {
    if (link.status !== "matched" || !link.controlBotId
      || !link.evidence.some(evidence => evidence.kind === "environment_schema_native_id")) continue;
    const observation = observations[link.packageId];
    const identityObservation = observation?.identityDetails ?? observation;
    if (!identityObservation) continue;
    const observedAt = Date.parse(identityObservation.observedAt);
    if (!Number.isFinite(observedAt) || observedAt > now || observedAt < now - maximumAgeMs
      || !(Date.parse(identityObservation.expiresAt) > now) || !(Date.parse(observation.expiresAt) > now)) continue;
    verified.set(powerPlatformAgentKey(link.resource.environmentId, link.resource.nativeId), link.controlBotId);
  }
  return resources.map(resource => {
    const botId = resource.environmentId ? verified.get(powerPlatformAgentKey(resource.environmentId, resource.nativeId)) : undefined;
    if (!botId || resource.identifiers.some(identifier => identifier.kind === "cds_bot_id")) return resource;
    return {
      ...resource,
      identifiers: [...resource.identifiers, { kind: "cds_bot_id" as const, value: botId }],
      provenance: {
        ...resource.provenance,
        "identifiers.cds_bot_id": {
          sourceSystem: "graph_packages" as const,
          path: `${metadataPath}.SourceIds.CdsBotId (corroborated by inventory environmentId, schemaName and nativeId)`,
          maturity: "preview" as const,
        },
      },
    };
  });
}

function identifierValues(resource: PowerPlatformResource, kind: "entra_agent_id" | "entra_app_id" | "cds_bot_id") {
  return [...new Set(resource.identifiers.filter(identifier => identifier.kind === kind)
    .map(identifier => normalizedGuid(identifier.value)).filter((value): value is string => value !== undefined))];
}

function identityKey(environmentId: string, kind: string, id: string) {
  return JSON.stringify([environmentId.toLowerCase(), kind, id]);
}
