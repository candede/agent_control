import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { operationalLog } from "./telemetry.js";

export type PackageAgentLinkEvidence = {
  kind: "entra_agent_id" | "environment_cds_bot_id" | "environment_schema_native_id";
  basis: "source_declared_metadata";
  elementIds: string[];
  packagePath: string;
  resourcePath: string;
};

export type PackageAgentLinkResolution =
  | {
      packageId: string;
      status: "matched";
      resource: { nativeId: string; environmentId: string };
      evidence: PackageAgentLinkEvidence[];
      controlBotId?: string;
    }
  | { packageId: string; status: "unmatched" | "ambiguous" | "conflicting"; reason: string };

type PackageAgentIdentity = {
  environmentId: string;
  cdsBotId?: string;
  entraAgentId?: string;
  schemaName?: string;
};

type IdentityObservation =
  | { status: "available"; identity: PackageAgentIdentity; elementIds: string[] }
  | { status: "unmatched" | "conflicting"; reason: string };

const guidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const environmentPattern = /^(?:Default-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const metadataPath = "elementDetails.AgentMetadatas.definition";
const schemaNamePattern = /^[a-z_][a-z0-9_]{0,511}$/i;

export function resolvePackageAgentLinks(
  tenantId: string,
  packages: readonly CopilotPackageDetail[],
  resources: readonly PowerPlatformResource[],
): PackageAgentLinkResolution[] {
  const candidates = resources.filter(resource =>
    resource.tenantId === tenantId && resource.type === "microsoft.copilotstudio/agents",
  );
  const index = new Map<string, Set<PowerPlatformResource>>();
  for (const resource of candidates) {
    if (!resource.environmentId) continue;
    for (const kind of ["entra_agent_id", "cds_bot_id"] as const) {
      for (const id of identifierValues(resource, kind)) {
        const key = identityKey(resource.environmentId, kind, id);
        const values = index.get(key) ?? new Set<PowerPlatformResource>();
        values.add(resource);
        index.set(key, values);
      }
    }
    const schemaName = normalizedId(resource.details.schemaName, schemaNamePattern);
    const nativeId = normalizedId(resource.nativeId, guidPattern);
    if (schemaName && nativeId) {
      const key = identityKey(resource.environmentId, "schema_native", `${schemaName}\0${nativeId}`);
      const values = index.get(key) ?? new Set<PowerPlatformResource>();
      values.add(resource);
      index.set(key, values);
    }
  }
  const identities = new Map<string, PackageAgentIdentity>();
  const resolutions: PackageAgentLinkResolution[] = packages.map(value => {
    const observation = packageAgentIdentity(value);
    if (observation.status !== "available") return { packageId: value.id, ...observation };
    const { identity } = observation;
    identities.set(value.id, identity);
    const matches: Array<{ resource: PowerPlatformResource; evidence: PackageAgentLinkEvidence[] }> = [];
    let conflicting = false;
    const possibleCandidates = new Set([
      ...index.get(identityKey(identity.environmentId, "entra_agent_id", identity.entraAgentId ?? "")) ?? [],
      ...index.get(identityKey(identity.environmentId, "cds_bot_id", identity.cdsBotId ?? "")) ?? [],
      ...index.get(identityKey(identity.environmentId, "schema_native", `${identity.schemaName ?? ""}\0${identity.cdsBotId ?? ""}`)) ?? [],
    ]);
    for (const resource of possibleCandidates) {
      if (!resource.environmentId || !sameId(resource.environmentId, identity.environmentId)) continue;
      const entraIds = identifierValues(resource, "entra_agent_id");
      const botIds = identifierValues(resource, "cds_bot_id");
      const entraMatch = Boolean(identity.entraAgentId && entraIds.includes(identity.entraAgentId));
      const botMatch = Boolean(identity.cdsBotId && botIds.includes(identity.cdsBotId));
      const resourceSchemaName = normalizedId(resource.details.schemaName, schemaNamePattern);
      const corroboratedNativeMatch = Boolean(identity.schemaName && identity.cdsBotId
        && resourceSchemaName === identity.schemaName && normalizedId(resource.nativeId, guidPattern) === identity.cdsBotId);
      if (!entraMatch && !botMatch && !corroboratedNativeMatch) continue;
      const invalidIdentifier = resource.identifiers.some(identifier =>
        (identifier.kind === "entra_agent_id" || identifier.kind === "cds_bot_id")
          && !normalizedId(identifier.value, guidPattern)
        || identifier.kind === "environment_id" && !sameId(identifier.value, identity.environmentId),
      );
      if (invalidIdentifier || entraIds.length > 1 || botIds.length > 1
        || identity.entraAgentId && entraIds.length && !entraMatch
        || identity.cdsBotId && botIds.length && !botMatch
        || identity.schemaName && resourceSchemaName && identity.schemaName !== resourceSchemaName) {
        conflicting = true;
        continue;
      }
      const evidence: PackageAgentLinkEvidence[] = [];
      if (entraMatch) evidence.push({
        kind: "entra_agent_id",
        basis: "source_declared_metadata",
        elementIds: observation.elementIds,
        packagePath: `${metadataPath}.AgentIdentityId + SourceIds.EnvironmentId`,
        resourcePath: "identifiers.entra_agent_id + environmentId",
      });
      if (botMatch) evidence.push({
        kind: "environment_cds_bot_id",
        basis: "source_declared_metadata",
        elementIds: observation.elementIds,
        packagePath: `${metadataPath}.SourceIds.EnvironmentId + SourceIds.CdsBotId`,
        resourcePath: "environmentId + identifiers.cds_bot_id",
      });
      if (corroboratedNativeMatch) evidence.push({
        kind: "environment_schema_native_id",
        basis: "source_declared_metadata",
        elementIds: observation.elementIds,
        packagePath: `${metadataPath}.SourceIds.EnvironmentId + SourceIds.SchemaName + SourceIds.CdsBotId`,
        resourcePath: "environmentId + details.schemaName + nativeId",
      });
      matches.push({ resource, evidence });
    }
    if (conflicting) return { packageId: value.id, status: "conflicting", reason: "Provider metadata contains conflicting native agent identities; no link was created." };
    if (matches.length > 1) return { packageId: value.id, status: "ambiguous", reason: "The same explicit identity matches multiple Power Platform resources; no link was created." };
    if (matches.length === 1) return {
      packageId: value.id,
      status: "matched",
      resource: { nativeId: matches[0].resource.nativeId, environmentId: matches[0].resource.environmentId! },
      evidence: matches[0].evidence,
      ...(matches[0].evidence.some(evidence => evidence.kind === "environment_schema_native_id")
        ? { controlBotId: identity.cdsBotId } : {}),
    };
    return { packageId: value.id, status: "unmatched", reason: "No Power Platform agent matches the package's explicit environment and typed agent identifiers." };
  });
  const groupedIdentities = new Map<string, { bots: Set<string>; agents: Set<string> }>();
  for (const resolution of resolutions) {
    if (resolution.status !== "matched") continue;
    const key = identityKey(resolution.resource.environmentId, "native", resolution.resource.nativeId);
    const group = groupedIdentities.get(key) ?? { bots: new Set<string>(), agents: new Set<string>() };
    const identity = identities.get(resolution.packageId)!;
    if (identity.cdsBotId) group.bots.add(identity.cdsBotId);
    if (identity.entraAgentId) group.agents.add(identity.entraAgentId);
    groupedIdentities.set(key, group);
  }
  return resolutions.map(resolution => {
    if (resolution.status !== "matched") return resolution;
    const group = groupedIdentities.get(identityKey(resolution.resource.environmentId, "native", resolution.resource.nativeId))!;
    return group.bots.size > 1 || group.agents.size > 1
      ? { packageId: resolution.packageId, status: "conflicting", reason: "Package representations disagree about this agent's native identities; no link was created." }
      : resolution;
  });
}

function packageAgentIdentity(value: CopilotPackageDetail): IdentityObservation {
  const groups = value.elementDetails?.filter(group => group.elementType === "AgentMetadatas");
  if (!groups?.length) return { status: "unmatched", reason: "Agent identity metadata has not been supplied. Refresh package details to check for a source-declared link." };
  const identities = new Map<string, PackageAgentIdentity>();
  const elementIds = new Set<string>();
  let elementCount = 0;
  for (const group of groups) {
    for (const element of group.elements) {
      elementCount += 1;
      if (elementCount > 16) return malformedIdentity("metadata_limit");
      elementIds.add(element.id);
      let metadata: unknown;
      try {
        metadata = JSON.parse(element.definition);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return malformedIdentity("invalid_json");
      }
      if (!isRecord(metadata) || !isRecord(metadata.SourceIds)) return malformedIdentity("missing_source_ids");
      const source = metadata.SourceIds;
      const environmentId = normalizedId(source.EnvironmentId, environmentPattern);
      const cdsBotId = normalizedId(source.CdsBotId, guidPattern);
      const entraAgentId = normalizedId(metadata.AgentIdentityId, guidPattern);
      const schemaName = normalizedId(source.SchemaName, schemaNamePattern);
      if (!environmentId || !cdsBotId && !entraAgentId
        || supplied(source.CdsBotId) && !cdsBotId
        || supplied(metadata.AgentIdentityId) && !entraAgentId) return malformedIdentity("invalid_typed_identity");
      const identity = {
        environmentId, ...(cdsBotId ? { cdsBotId } : {}), ...(entraAgentId ? { entraAgentId } : {}),
        ...(schemaName ? { schemaName } : {}),
      };
      identities.set(JSON.stringify(identity), identity);
    }
  }
  if (!identities.size) return malformedIdentity("empty_metadata");
  if (identities.size > 1) return { status: "conflicting", reason: "The package contains multiple different agent identity records; no link was created." };
  return { status: "available", identity: [...identities.values()][0], elementIds: [...elementIds].sort() };
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
    verified.set(identityKey(link.resource.environmentId, "native", link.resource.nativeId.toLowerCase()), link.controlBotId);
  }
  return resources.map(resource => {
    const botId = resource.environmentId
      ? verified.get(identityKey(resource.environmentId, "native", resource.nativeId.toLowerCase())) : undefined;
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

function malformedIdentity(reason: string): IdentityObservation {
  operationalLog("warn", "agent_identity_unresolved", { provider: "graph_packages", reason });
  return { status: "unmatched", reason: "Package agent identity metadata is incomplete or invalid; no link was created." };
}

function identifierValues(resource: PowerPlatformResource, kind: "entra_agent_id" | "cds_bot_id") {
  return [...new Set(resource.identifiers.filter(identifier => identifier.kind === kind)
    .map(identifier => normalizedId(identifier.value, guidPattern)).filter((value): value is string => value !== undefined))];
}

function normalizedId(value: unknown, pattern: RegExp) {
  return typeof value === "string" && pattern.test(value) ? value.toLowerCase() : undefined;
}

function sameId(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function identityKey(environmentId: string, kind: string, id: string) {
  return `${environmentId.toLowerCase()}\0${kind}\0${id}`;
}

function supplied(value: unknown) {
  return value !== undefined && value !== null && value !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
