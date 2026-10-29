import { AppError } from "../errors.js";
import { packageObservationLimits, type CopilotPackageDetail, type PackageElementDetail } from "../types/copilotPackage.js";
import { operationalLog } from "./telemetry.js";
import { dataLimits } from "../db/dataBounds.js";
import { compareInventoryInstants, isInventoryTimestamp } from "../types/inventoryTimestamp.js";

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

export function hasSavedPackageIdentityDetails(value: CopilotPackageDetail) {
  const details = value.detailFreshness;
  return !details || (details.state === "fresh" || details.state === "stale")
    && isInventoryTimestamp(details.observedAt) && isInventoryTimestamp(details.expiresAt)
    && compareInventoryInstants(details.observedAt, details.expiresAt) < 0
    && compareInventoryInstants(details.observedAt, new Date().toISOString()) <= 0;
}

export function normalizedGuid(value: unknown) {
  return normalizedId(value, guidPattern);
}

export function normalizedEnvironmentId(value: unknown) {
  return normalizedId(value, environmentPattern);
}

export function normalizedSchemaName(value: unknown) {
  return normalizedId(value, schemaNamePattern) ?? normalizedGuid(value);
}

export function isPackageElementType(value: unknown, expected: string) {
  return typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
}

export function parsePackageIdentityDefinition(definition: string, elementType: string): unknown {
  if (typeof definition !== "string" || Buffer.byteLength(definition, "utf8") > dataLimits.agentDefinitionBytes) {
    throw new SyntaxError("Package identity definition must be a bounded JSON string.");
  }
  const metadata: unknown = JSON.parse(definition);
  const agentMetadata = isPackageElementType(elementType, "AgentMetadatas");
  const fields = agentMetadata ? ["SourceIds", "AgentIdentityId"]
    : isPackageElementType(elementType, "Bots") ? ["botId"]
      : isPackageElementType(elementType, "CustomEngineCopilots") ? ["type", "id", "botId"] : [];
  if (!fields.length) return metadata;
  const frames: Array<{ fields: readonly string[]; keys: Set<string>; property?: string }> = [];
  let depth = 0;
  // JSON.parse discards repeated properties. Check only identity-bearing objects,
  // decoding escaped member names without interpreting unrestricted authoring JSON.
  for (const match of definition.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],]/g)) {
    const token = match[0];
    const frame = depth <= 2 ? frames.at(-1) : undefined;
    if (token === "{" || token === "[") {
      if (++depth > 2) continue;
      frames.push({
        fields: token === "[" ? [] : depth === 1 ? fields : agentMetadata && frame?.property === "SourceIds" ? sourceFields : [],
        keys: new Set<string>(),
      });
    } else if (token === "}" || token === "]") {
      if (depth-- <= 2) frames.pop();
    } else if (token === ",") {
      if (frame) frame.property = undefined;
    } else if (frame) {
      let next = match.index + token.length;
      while (/[\t\n\r ]/.test(definition.charAt(next))) next++;
      if (definition.charAt(next) !== ":") continue;
      const key: string = JSON.parse(token);
      frame.property = key;
      if (!frame.fields.includes(key)) continue;
      if (frame.keys.has(key)) throw new SyntaxError("Package element contains duplicate identity properties.");
      frame.keys.add(key);
    }
  }
  return metadata;
}

export function validatePackageAgentMetadata(definition: string): string {
  let metadata: unknown;
  try {
    metadata = parsePackageIdentityDefinition(definition, "AgentMetadatas");
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new AppError(502, "provider_schema", "Package agent identity metadata is not valid JSON.");
  }
  if (!isRecord(metadata)) throw new AppError(502, "provider_schema", "Package agent identity metadata must be an object.");
  const projected: Record<string, unknown> = Object.setPrototypeOf({}, null);
  if (Object.hasOwn(metadata, "SourceIds")) {
    const source = metadata.SourceIds;
    projected.SourceIds = isRecord(source)
      ? Object.fromEntries(sourceFields.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]))
      : source;
  }
  if (Object.hasOwn(metadata, "AgentIdentityId")) projected.AgentIdentityId = metadata.AgentIdentityId;
  let result: string;
  try {
    result = JSON.stringify(projected);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new AppError(502, "provider_schema", "Package agent identity fields exceed the storage limit.");
  }
  if (Buffer.byteLength(result, "utf8") > 16_384) {
    throw new AppError(502, "provider_schema", "Package agent identity fields exceed the storage limit.");
  }
  return definition;
}

export function readPackageAgentMetadata(value: CopilotPackageDetail): PackageAgentMetadataObservation {
  let groups: PackageElementDetail[];
  try {
    groups = identityElementGroups(value).filter(group => isPackageElementType(group.elementType, "AgentMetadatas"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return malformedIdentity("invalid_element_details");
  }
  if (!groups?.length) return {
    status: "unmatched",
    reason: ownValue(value, "identityDetailsCollected") === true
      ? "Package details were collected, but Microsoft Graph did not supply native agent metadata or a corroborated declarative manifest identity."
      : "Agent identity metadata has not been supplied. Refresh package details to check for a source-declared link.",
  };
  const identity: PackageAgentMetadata = Object.setPrototypeOf({ graphAgentIds: [] }, null);
  const elementIds = new Set<string>();
  let elementCount = 0;
  for (const group of groups) {
    for (const element of group.elements) {
      if (++elementCount > 16) return malformedIdentity("metadata_limit");
      if (element.id) elementIds.add(element.id);
      let metadata: unknown;
      try {
        metadata = parsePackageIdentityDefinition(element.definition, "AgentMetadatas");
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return malformedIdentity("invalid_json");
      }
      if (!isRecord(metadata)) return malformedIdentity("invalid_source_ids");
      const sourceIds = ownValue(metadata, "SourceIds");
      if (supplied(sourceIds) && !isRecord(sourceIds)) {
        return malformedIdentity("invalid_source_ids");
      }
      const source = isRecord(sourceIds) ? sourceIds : {};
      const fields = {
        environmentId: normalizedEnvironmentId(ownValue(source, "EnvironmentId")),
        cdsBotId: normalizedGuid(ownValue(source, "CdsBotId")),
        schemaName: normalizedSchemaName(ownValue(source, "SchemaName")),
        manifestId: normalizedGuid(ownValue(source, "ManifestId")),
        entraApplicationId: normalizedGuid(ownValue(source, "EntraApplicationId")),
      };
      const graphAgentId = normalizedGuid(ownValue(metadata, "AgentIdentityId"));
      if (supplied(ownValue(source, "EnvironmentId")) && !fields.environmentId
        || supplied(ownValue(source, "CdsBotId")) && !fields.cdsBotId
        || supplied(ownValue(source, "SchemaName")) && !fields.schemaName
        || supplied(ownValue(source, "ManifestId")) && !fields.manifestId
        || supplied(ownValue(source, "EntraApplicationId")) && !fields.entraApplicationId
        || supplied(ownValue(metadata, "AgentIdentityId")) && !graphAgentId) return malformedIdentity("invalid_typed_identity");
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
  let groups: PackageElementDetail[];
  try {
    groups = identityElementGroups(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    operationalLog("warn", "agent_identity_unresolved", { provider: "graph_packages", reason: "invalid_element_details" });
    return undefined;
  }
  const botGroups = groups.filter(group => isPackageElementType(group.elementType, "Bots"));
  const engineGroups = groups.filter(group => isPackageElementType(group.elementType, "CustomEngineCopilots"));
  if (!botGroups.length || !engineGroups.length) return undefined;
  const applications = readPackageBotApplications(botGroups, engineGroups);
  if (!applications || applications.engines.size !== 1) return undefined;
  const botApplicationId = [...applications.engines][0];
  if (!applications.bots.has(botApplicationId)) {
    operationalLog("warn", "agent_identity_unresolved", { provider: "graph_packages", reason: "bot_application_disagreement" });
    return undefined;
  }
  return { botApplicationId, elementIds: [...applications.elementIds.get(botApplicationId) ?? []].sort() };
}

export function packageCustomEngineBotIdentityChanged(current: CopilotPackageDetail, incoming: CopilotPackageDetail) {
  let nextGroups: PackageElementDetail[];
  try {
    nextGroups = identityElementGroups(incoming).filter(group => group.elements.length);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return true;
  }
  const botGroups = nextGroups.filter(group => isPackageElementType(group.elementType, "Bots"));
  const engineGroups = nextGroups.filter(group => isPackageElementType(group.elementType, "CustomEngineCopilots"));
  if (!botGroups.length && !engineGroups.length) return false;
  const next = readPackageBotApplications(botGroups, engineGroups);
  if (!next) return true;
  let previousGroups: PackageElementDetail[];
  try {
    previousGroups = identityElementGroups(current);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return true;
  }
  const previous = readPackageBotApplications(
    previousGroups.filter(group => isPackageElementType(group.elementType, "Bots")),
    previousGroups.filter(group => isPackageElementType(group.elementType, "CustomEngineCopilots")),
  );
  // Compare positive fragments independently; omitted complementary groups are not deletions.
  if ([...next.bots].some(id => !previous?.bots.has(id))
    || [...next.engines].some(id => !previous?.engines.has(id))) return true;
  const previousBot = previous?.engines.size === 1 ? [...previous.engines][0] : undefined;
  if (!previousBot || !previous?.bots.has(previousBot)) return false;
  const bots = botGroups.length ? next.bots : previous.bots;
  const engines = engineGroups.length ? next.engines : previous.engines;
  return engines.size !== 1 || !engines.has(previousBot) || !bots.has(previousBot);
}

function readPackageBotApplications(botGroups: PackageElementDetail[], engineGroups: PackageElementDetail[]) {
  const bots = new Set<string>();
  const engines = new Set<string>();
  const elementIds = new Map<string, Set<string>>();
  for (const [groups, customEngine] of [[botGroups, false], [engineGroups, true]] as const) {
    for (const element of groups.flatMap(group => group.elements)) {
      let definition: unknown;
      try {
        definition = parsePackageIdentityDefinition(element.definition, customEngine ? "CustomEngineCopilots" : "Bots");
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        operationalLog("warn", "agent_identity_unresolved", { provider: "graph_packages", reason: "invalid_bot_application_json" });
        return undefined;
      }
      if (!isRecord(definition)) {
        operationalLog("warn", "agent_identity_unresolved", { provider: "graph_packages", reason: "invalid_bot_application_definition" });
        return undefined;
      }
      if (customEngine && ownValue(definition, "type") !== "bot") continue;
      const botId = normalizedGuid(ownValue(definition, customEngine ? "id" : "botId"));
      const declaredBotId = ownValue(definition, "botId");
      if (!botId || customEngine && supplied(declaredBotId) && normalizedGuid(declaredBotId) !== botId) {
        operationalLog("warn", "agent_identity_unresolved", { provider: "graph_packages", reason: "invalid_bot_application_identity" });
        return undefined;
      }
      (customEngine ? engines : bots).add(botId);
      const ids = elementIds.get(botId) ?? new Set<string>();
      if (element.id) ids.add(element.id);
      elementIds.set(botId, ids);
    }
  }
  return { bots, engines, elementIds };
}

function identityElementGroups(value: CopilotPackageDetail): PackageElementDetail[] {
  if (!isRecord(value)) throw new SyntaxError("Invalid package identity observation.");
  for (const key of ["elementDetails", "elementTypes", "manifestId", "identityDetailsCollected", "identityRevalidationRequired", "detailFreshness"]) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property && !Object.hasOwn(property, "value")) throw new SyntaxError("Package identity evidence must contain data properties.");
  }
  const details = ownValue(value, "elementDetails");
  if (details === undefined || details === null) return [];
  if (!Array.isArray(details) || details.length > packageObservationLimits.elementGroups) {
    throw new SyntaxError("Package identity element groups are invalid or oversized.");
  }
  let bytes = 0;
  const groups = Array.from({ length: details.length }, (_, index) => {
    const input = ownValue(details, String(index));
    if (!isRecord(input)) throw new SyntaxError("Invalid package identity element group.");
    const elementType = ownValue(input, "elementType"), elements = ownValue(input, "elements");
    if (typeof elementType !== "string" || !elementType || elementType.length > 256 || /[\0\uD800-\uDFFF]/u.test(elementType)
      || !Array.isArray(elements) || elements.length > packageObservationLimits.elementsPerGroup) {
      throw new SyntaxError("Invalid package identity element group.");
    }
    bytes += Buffer.byteLength(elementType, "utf8");
    return { elementType, elements: Array.from({ length: elements.length }, (_, ordinal) => {
      const element = ownValue(elements, String(ordinal));
      if (!isRecord(element)) throw new SyntaxError("Invalid package identity element.");
      const id = ownValue(element, "id"), definition = ownValue(element, "definition");
      if (typeof id !== "string" || id.length > 512 || typeof definition !== "string"
        || /[\0\uD800-\uDFFF]/u.test(id) || /[\0\uD800-\uDFFF]/u.test(definition)
        || Buffer.byteLength(definition, "utf8") > dataLimits.agentDefinitionBytes) {
        throw new SyntaxError("Invalid package identity element.");
      }
      bytes += Buffer.byteLength(id, "utf8") + Buffer.byteLength(definition, "utf8");
      if (bytes > dataLimits.agentDefinitionWorkBytes) throw new SyntaxError("Package identity elements exceed the saved work limit.");
      return { id, definition };
    }) };
  });
  if (Buffer.byteLength(JSON.stringify(groups), "utf8") > dataLimits.agentDefinitionWorkBytes) {
    throw new SyntaxError("Package identity elements exceed the observation limit.");
  }
  return groups;
}

function ownValue(value: object, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && Object.hasOwn(property, "value") ? property.value : undefined;
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
