import { AppError } from "../errors.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { operationalLog } from "./telemetry.js";

export type PackageAgentMetadata = {
  environmentId?: string;
  cdsBotId?: string;
  schemaName?: string;
  manifestId?: string;
  entraApplicationId?: string;
  graphAgentIds: string[];
};

export type PackageAgentMetadataObservation =
  | { status: "available"; identity: PackageAgentMetadata; elementIds: string[] }
  | { status: "unmatched" | "conflicting"; reason: string; invalidMetadata?: true; identity?: PackageAgentMetadata };

const guidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const environmentPattern = /^(?:Default-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const schemaNamePattern = /^[a-z_][a-z0-9_]{0,511}$/i;
const sourceFields = ["EnvironmentId", "CdsBotId", "SchemaName", "ManifestId", "EntraApplicationId"] as const;

export function normalizedGuid(value: unknown) {
  return normalizedId(value, guidPattern);
}

export function normalizedEnvironmentId(value: unknown) {
  return normalizedId(value, environmentPattern);
}

export function normalizedSchemaName(value: unknown) {
  return normalizedId(value, schemaNamePattern) ?? normalizedGuid(value);
}

export function isPackageElementType(value: string, expected: string) {
  return value.toLowerCase() === expected.toLowerCase();
}

export function validatePackageAgentMetadata(definition: string): string {
  let metadata: unknown;
  try {
    metadata = JSON.parse(definition);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new AppError(502, "provider_schema", "Package agent identity metadata is not valid JSON.");
  }
  if (!isRecord(metadata)) throw new AppError(502, "provider_schema", "Package agent identity metadata must be an object.");
  const projected: Record<string, unknown> = {};
  if (Object.hasOwn(metadata, "SourceIds")) {
    const source = metadata.SourceIds;
    projected.SourceIds = isRecord(source)
      ? Object.fromEntries(sourceFields.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]))
      : source;
  }
  if (Object.hasOwn(metadata, "AgentIdentityId")) projected.AgentIdentityId = metadata.AgentIdentityId;
  const result = JSON.stringify(projected);
  if (Buffer.byteLength(result, "utf8") > 16_384) {
    throw new AppError(502, "provider_schema", "Package agent identity fields exceed the storage limit.");
  }
  return definition;
}

export function readPackageAgentMetadata(value: CopilotPackageDetail): PackageAgentMetadataObservation {
  const groups = value.elementDetails?.filter(group => isPackageElementType(group.elementType, "AgentMetadatas"));
  if (!groups?.length) return {
    status: "unmatched",
    reason: value.identityDetailsCollected
      ? "Package details were collected, but Microsoft Graph did not supply native agent metadata or a corroborated declarative manifest identity."
      : "Agent identity metadata has not been supplied. Refresh package details to check for a source-declared link.",
  };
  const identity: PackageAgentMetadata = { graphAgentIds: [] };
  const elementIds = new Set<string>();
  let elementCount = 0;
  for (const group of groups) {
    for (const element of group.elements) {
      if (++elementCount > 16) return malformedIdentity("metadata_limit");
      if (element.id) elementIds.add(element.id);
      let metadata: unknown;
      try {
        metadata = JSON.parse(element.definition);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return malformedIdentity("invalid_json");
      }
      if (!isRecord(metadata) || supplied(metadata.SourceIds) && !isRecord(metadata.SourceIds)) {
        return malformedIdentity("invalid_source_ids");
      }
      const source = isRecord(metadata.SourceIds) ? metadata.SourceIds : {};
      const fields = {
        environmentId: normalizedEnvironmentId(source.EnvironmentId),
        cdsBotId: normalizedGuid(source.CdsBotId),
        schemaName: normalizedSchemaName(source.SchemaName),
        manifestId: normalizedGuid(source.ManifestId),
        entraApplicationId: normalizedGuid(source.EntraApplicationId),
      };
      const graphAgentId = normalizedGuid(metadata.AgentIdentityId);
      if (supplied(source.EnvironmentId) && !fields.environmentId
        || supplied(source.CdsBotId) && !fields.cdsBotId
        || supplied(source.SchemaName) && !fields.schemaName
        || supplied(source.ManifestId) && !fields.manifestId
        || supplied(source.EntraApplicationId) && !fields.entraApplicationId
        || supplied(metadata.AgentIdentityId) && !graphAgentId) return malformedIdentity("invalid_typed_identity");
      for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
        const next = fields[key];
        if (!next) continue;
        if (identity[key] && identity[key] !== next) {
          return { status: "conflicting", reason: "The package contains conflicting source-native agent identities; no link was created." };
        }
        identity[key] = next;
      }
      if (graphAgentId && !identity.graphAgentIds.includes(graphAgentId)) identity.graphAgentIds.push(graphAgentId);
    }
  }
  if (!elementCount) return malformedIdentity("empty_metadata");
  if (!identity.cdsBotId && !identity.manifestId && !identity.entraApplicationId && !identity.graphAgentIds.length) {
    return { status: "unmatched", identity, reason: "Package metadata does not supply a source-native agent identity." };
  }
  identity.graphAgentIds.sort();
  return { status: "available", identity, elementIds: [...elementIds].sort() };
}

export function readPackageCustomEngineBotIdentity(value: CopilotPackageDetail): {
  botApplicationId: string; elementIds: string[];
} | undefined {
  const botGroups = value.elementDetails?.filter(group => isPackageElementType(group.elementType, "Bots")) ?? [];
  const engineGroups = value.elementDetails?.filter(group => isPackageElementType(group.elementType, "CustomEngineCopilots")) ?? [];
  if (!botGroups.length || !engineGroups.length) return undefined;
  const bots = new Set<string>();
  const engines = new Set<string>();
  const elementIds = new Set<string>();
  for (const [groups, customEngine] of [[botGroups, false], [engineGroups, true]] as const) {
    for (const element of groups.flatMap(group => group.elements)) {
      let definition: unknown;
      try {
        definition = JSON.parse(element.definition);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        operationalLog("warn", "agent_identity_unresolved", { provider: "graph_packages", reason: "invalid_bot_application_json" });
        return undefined;
      }
      if (!isRecord(definition)) {
        operationalLog("warn", "agent_identity_unresolved", { provider: "graph_packages", reason: "invalid_bot_application_definition" });
        return undefined;
      }
      if (customEngine && definition.type !== "bot") continue;
      const botId = normalizedGuid(customEngine ? definition.id : definition.botId);
      if (!botId || customEngine && supplied(definition.botId) && normalizedGuid(definition.botId) !== botId) {
        operationalLog("warn", "agent_identity_unresolved", { provider: "graph_packages", reason: "invalid_bot_application_identity" });
        return undefined;
      }
      (customEngine ? engines : bots).add(botId);
      if (element.id) elementIds.add(element.id);
    }
  }
  if (engines.size !== 1) return undefined;
  const botApplicationId = [...engines][0];
  if (!bots.has(botApplicationId)) {
    operationalLog("warn", "agent_identity_unresolved", { provider: "graph_packages", reason: "bot_application_disagreement" });
    return undefined;
  }
  return { botApplicationId, elementIds: [...elementIds].sort() };
}

function malformedIdentity(reason: string): PackageAgentMetadataObservation {
  operationalLog("warn", "agent_identity_unresolved", { provider: "graph_packages", reason });
  return {
    status: "unmatched", invalidMetadata: true,
    reason: "Package agent identity metadata is incomplete or invalid. Refresh this package's matching details; no link was created.",
  };
}

function normalizedId(value: unknown, pattern: RegExp) {
  return typeof value === "string" && value.trim() === value && !/[\r\n\0]/.test(value) && pattern.test(value) ? value.toLowerCase() : undefined;
}

export function supplied(value: unknown) {
  return value !== undefined && value !== null && value !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
