import { assertResidualBytes, digest, dataLimitError, dataLimits } from "../db/dataBounds.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { formatAgentAuthoringTool, isDirectoryObjectId, isPackageProviderUsage, normalizePackageAuthoringTool, packagePrincipalCollections } from "../types/copilotPackage.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { powerPlatformAuthoringTool } from "../types/powerPlatformInventory.js";
import { inventoryLimits, type InventoryClassification } from "../types/inventoryRecords.js";
import { allowlistedSavedPackage } from "./packageObservation.js";
import { hasSavedPackageIdentityDetails, isPackageElementType, normalizedEnvironmentId, normalizedGuid, normalizedSchemaName, readPackageAgentMetadata, readPackageCustomEngineBotIdentity } from "./packageAgentMetadata.js";
import { normalizeEnvironmentIdentity, normalizeNativeIdentity } from "./inventoryIdentity.js";
import { buildRecords } from "./inventoryComponent.js";
import { resolvePackageAgentLinks } from "./packageAgentIdentity.js";
import { unifiedAgentSortKeys, type UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { agentColumnValue, agentManagement, agentRelevanceReasons, agentUserAvailability, matchesAgentView, packageAuthoringTool } from "../types/agentPresentation.js";
import { validateQuarantineTarget } from "./copilotStudioQuarantine.js";
import { AppError } from "../errors.js";
import { compareInventoryTimestamps, inventoryTimestamp } from "./inventoryTimestamp.js";

export type InventoryFact = { kind: string; value: string; payload: Record<string, unknown>;
  text_value?: string | null; number_value?: number | null; boolean_value?: boolean | null };
export type InventoryRecord = InventoryClassification & {
  identity: string; native_id: string; environment_id: string | null; display_name: string;
  sort_key: string; resource_type: string | null; publisher: string | null; modified_at: string | null;
  residual: Record<string, unknown>; facts: InventoryFact[]; deleted?: boolean;
  factSource?: { generationId: string; identity: string; kinds: string[]; excludeCollections?: string[]; includeCollections?: string[] };
  catalog_generation?: string | null; detail_generation?: string | null; control_generation?: string | null;
  read_started_at?: string; observed_at?: string; expires_at?: string;
  identity_expires_at?: string | null;
};
export const inventoryMatchKey = (environment: string, value: string) => digest(JSON.stringify([environment, value]));
export const nativeInventoryKey = (value: PowerPlatformResource) =>
  digest(JSON.stringify([value.type, normalizeEnvironmentIdentity(value.environmentId ?? ""), normalizeNativeIdentity(value.nativeId)]));

function bounded(record: InventoryRecord) {
  if (record.facts.length > inventoryLimits.factsPerRecord) throw dataLimitError("inventory_facts", inventoryLimits.factsPerRecord, record.facts.length);
  const bytes = Buffer.byteLength(JSON.stringify(record.residual));
  assertResidualBytes(bytes, "inventory_projection");
  return record;
}

function aboutFacts(kind: string, text: string): InventoryFact[] {
  const bytes = Buffer.byteLength(text);
  if (bytes > dataLimits.agentDefinitionBytes) throw dataLimitError("inventory_about_bytes", dataLimits.agentDefinitionBytes, bytes);
  if (bytes <= 16384) return [];
  const facts: InventoryFact[] = [];
  for (let offset = 0, part = 0; offset < text.length; part++) {
    let end = Math.min(text.length, offset + 8192);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    facts.push({ kind, value: String(part), payload: { text: text.slice(offset, end) } });
    offset = end;
  }
  return facts;
}

export function packageInventoryRecord(input: CopilotPackageDetail): InventoryRecord {
  const retainedFields = ["identityDetailsCollected", "identityRevalidationRequired", "detailFreshness", "controlObservations", "providerUsage", "provenance"] as const;
  const properties = Object.getOwnPropertyDescriptors(input);
  if (Object.values(properties).some(property => !Object.hasOwn(property, "value"))) {
    throw new AppError(502, "provider_schema", "Package observations must contain own data properties.");
  }
  const observation = Object.fromEntries(Object.entries(properties).map(([key, property]) => [key, property.value]));
  if (Object.hasOwn(input, "providerUsage") && !isPackageProviderUsage(input.providerUsage)) {
    throw new AppError(502, "provider_schema", "Package provider telemetry is invalid.");
  }
  // Local freshness/control annotations are not omitted provider fields.
  for (const key of retainedFields) delete observation[key];
  const checked = allowlistedSavedPackage(observation);
  const value: CopilotPackageDetail = { ...checked, ...structuredClone(Object.fromEntries(
    retainedFields.filter(key => key !== "provenance" && Object.hasOwn(input, key)).map(key => [key, input[key]]))),
    provenance: { ...checked.provenance, ...(Object.hasOwn(input, "provenance") ? structuredClone(input.provenance) : {}) } };
  const facts: InventoryFact[] = [];
  const fact = (kind: string, value: string, payload: Record<string, unknown> = {}) => facts.push({ kind, value, payload });
  for (const kind of ["supportedHosts", "elementTypes", "categories"] as const) {
    if (value[kind] !== undefined) fact("collection", kind);
    for (const item of value[kind] ?? []) fact(kind, item);
  }
  for (const kind of packagePrincipalCollections) {
    if (value[kind] !== undefined) fact("collection", kind);
    for (const item of value[kind] ?? []) fact(kind, item.resourceId, item);
  }
  if (value.elementDetails !== undefined) fact("collection", "elementDetails");
  for (const group of value.elementDetails ?? []) {
    fact("elementGroup", group.elementType);
    for (const element of group.elements) fact("element", `${group.elementType}:${element.id}`, { elementType: group.elementType, ...element });
  }
  const metadata = readPackageAgentMetadata(value);
  const identity = metadata.identity;
  if (!value.identityRevalidationRequired && hasSavedPackageIdentityDetails(value)) {
    const environment = identity?.environmentId;
    if (environment) {
      if (identity.cdsBotId) {
        fact("match:cds_bot_id", inventoryMatchKey(environment, identity.cdsBotId));
        if (identity.schemaName) fact("match:schema_native", inventoryMatchKey(environment, `${identity.schemaName}:${identity.cdsBotId}`));
      }
      if (identity.entraApplicationId) fact("match:entra_app_id", inventoryMatchKey(environment, identity.entraApplicationId));
      for (const id of identity.graphAgentIds) fact("match:entra_agent_id", inventoryMatchKey(environment, id));
    }
    const bot = readPackageCustomEngineBotIdentity(value);
    if (bot) fact("match:custom_engine", bot.botApplicationId);
  }
  const declarativeCount = value.elementDetails?.reduce((count, group) =>
    count + (isPackageElementType(group.elementType, "DeclarativeCopilots") ? group.elements.length : 0), 0) ?? 0;
  const catalogManifest = hasSavedPackageIdentityDetails(value)
    || value.detailFreshness?.state !== "invalidated" && !value.elementDetails?.some(group => isPackageElementType(group.elementType, "AgentMetadatas"));
  if (!value.identityRevalidationRequired && catalogManifest && metadata.status !== "conflicting"
    && !(metadata.status === "unmatched" && metadata.invalidMetadata) && declarativeCount <= 1
    && (declarativeCount > 0 || value.elementTypes?.some(type => isPackageElementType(type, "DeclarativeCopilots")))
    && normalizedGuid(value.manifestId) && !identity?.cdsBotId) {
    fact("match:manifest", normalizedGuid(value.manifestId)!);
  }
  // Source-native identity evidence stays bounded; child collections are not list payloads.
  const residual: Record<string, unknown> = { ...value };
  for (const field of ["longDescription", "shortDescription"] as const) {
    const text = value[field];
    const chunks = text === undefined ? [] : aboutFacts(`about:${field === "longDescription" ? "long" : "short"}`, text);
    if (chunks.length) {
      facts.push(...chunks);
      delete residual[field];
    }
  }
  for (const key of ["supportedHosts", "elementTypes", "categories", ...packagePrincipalCollections, "elementDetails"]) delete residual[key];
  const projection = canonicalRecord(value.id, buildRecords([value], [], resolvePackageAgentLinks("", [value], []), null, null)[0]);
  facts.push(...projection.facts);
  return bounded({ identity: value.id, native_id: value.id, environment_id: identity?.environmentId ?? null,
    presence: projection.presence, link_state: projection.link_state, availability: projection.availability, management: projection.management,
    display_name: value.displayName, sort_key: value.displayName.normalize("NFKC").toLowerCase(),
    resource_type: value.type ?? null, publisher: value.publisher ?? null, modified_at: value.lastModifiedDateTime ?? null,
    residual, facts });
}

export function powerPlatformInventoryRecord(value: PowerPlatformResource): InventoryRecord {
  const facts: InventoryFact[] = [];
  if (value.type === "microsoft.copilotstudio/agents") facts.push({ kind: "match:native", value: nativeInventoryKey(value), payload: {} });
  const environment = normalizedEnvironmentId(value.environmentId);
  for (const identifier of value.identifiers) {
    facts.push({ kind: "identifier", value: identifier.value, payload: { ...identifier } });
    const id = normalizedGuid(identifier.value);
    if (environment && id && ["entra_agent_id", "entra_app_id", "cds_bot_id"].includes(identifier.kind)) {
      facts.push({ kind: `match:${identifier.kind}`, value: inventoryMatchKey(environment, id), payload: {} });
    }
  }
  const schema = normalizedSchemaName(value.details.schemaName);
  const native = normalizedGuid(value.nativeId);
  if (environment && schema && native) facts.push({ kind: "match:schema_native", value: inventoryMatchKey(environment, `${schema}:${native}`), payload: {} });
  if (schema && schema === native) facts.push({ kind: "match:manifest", value: native, payload: {} });
  const residual = structuredClone(value) as unknown as Record<string, unknown>;
  delete residual.identifiers;
  const details = residual.details as Record<string, unknown>;
  const about = value.details.description === undefined ? [] : aboutFacts("about:native", value.details.description);
  if (about.length) { facts.push(...about); delete details.description; }
  for (const [kind, items] of Object.entries(details)) if (Array.isArray(items)) {
    facts.push({ kind: "collection", value: `detail:${kind}`, payload: {} });
    for (const [ordinal, item] of items.entries()) {
      if (kind === "connectors") {
        const connector = item as { connectorId: string; operations?: Record<string, unknown>[] };
        facts.push({ kind: "detail:connectors", value: String(ordinal), payload: { connectorId: connector.connectorId,
          ...(connector.operations !== undefined ? { operations: [] } : {}) } });
        for (const operation of connector.operations ?? []) facts.push({ kind: "connectorOperation", value: String(ordinal),
          payload: operation });
      } else facts.push({ kind: `detail:${kind}`, value: typeof item === "string" ? item : String(ordinal),
        payload: typeof item === "object" && item !== null ? item : { value: item } });
    }
    delete details[kind];
  }
  const presentation = buildRecords([], [value], [], null, null)[0];
  const projection = presentation ? canonicalRecord(nativeInventoryKey(value), presentation) : null;
  if (projection) facts.push(...projection.facts);
  return bounded({ identity: nativeInventoryKey(value), native_id: value.nativeId, environment_id: value.environmentId ?? null,
    presence: projection?.presence ?? null, link_state: projection?.link_state ?? null,
    availability: projection?.availability ?? null, management: projection?.management ?? null,
    display_name: value.displayName ?? value.nativeId, sort_key: (value.displayName ?? value.nativeId).normalize("NFKC").toLowerCase(),
    resource_type: value.type, publisher: null, modified_at: value.details.lastModifiedAt ?? null, residual, facts });
}

export function restoreInventoryRecord(residual: Record<string, unknown>, inputFacts: readonly InventoryFact[], domain: string) {
  const value = structuredClone(residual);
  const facts = structuredClone(inputFacts);
  if (facts.some(fact => !fact || typeof fact.kind !== "string" || typeof fact.value !== "string"
    || !fact.payload || typeof fact.payload !== "object" || Array.isArray(fact.payload))) {
    throw new AppError(500, "saved_source_invalid", "Saved inventory child facts are invalid.");
  }
  if (domain === "packages") {
    for (const [field, kind] of [["longDescription", "about:long"], ["shortDescription", "about:short"]] as const) {
      const chunks = facts.filter(fact => fact.kind === kind);
      if (chunks.length) {
        if (chunks.some((fact, index) => fact.value !== String(index) || typeof fact.payload.text !== "string")) {
          throw new AppError(500, "saved_source_invalid", "Saved About text has invalid chunk ordering.");
        }
        value[field] = chunks.map(fact => fact.payload.text).join("");
      }
    }
    for (const kind of ["supportedHosts", "elementTypes", "categories", ...packagePrincipalCollections]) {
      const selected = facts.filter(fact => fact.kind === kind);
      if (selected.length || facts.some(fact => fact.kind === "collection" && fact.value === kind)) value[kind] = selected.map(fact => kind.endsWith("UsersAndGroups") ? fact.payload : fact.value);
    }
    const groups: { elementType: string; elements: { id: string; definition: string }[] }[] = [];
    for (const fact of facts) {
      if (fact.kind === "elementGroup") {
        groups.push({ elementType: fact.value, elements: [] });
        continue;
      }
      if (fact.kind !== "element") continue;
      const { elementType, id, definition } = fact.payload as { elementType: string; id: string; definition: string };
      const group = groups.at(-1);
      if (!group || group.elementType !== elementType || typeof id !== "string" || typeof definition !== "string") {
        throw new AppError(500, "saved_source_invalid", "Saved package elements do not have valid source-ordinal parentage.");
      }
      group.elements.push({ id, definition });
    }
    if (groups.length || facts.some(fact => fact.kind === "collection" && fact.value === "elementDetails")) value.elementDetails = groups;
  } else {
    if (domain !== "power_platform" || !value.details || typeof value.details !== "object" || Array.isArray(value.details)) {
      throw new AppError(500, "saved_source_invalid", "Saved native inventory details are invalid.");
    }
    value.identifiers = facts.filter(fact => fact.kind === "identifier").map(fact => fact.payload);
    const details = value.details as Record<string, unknown>;
    const about = facts.filter(fact => fact.kind === "about:native");
    if (about.length) {
      if (about.some((fact, index) => fact.value !== String(index) || typeof fact.payload.text !== "string")) {
        throw new AppError(500, "saved_source_invalid", "Saved native About text has invalid chunk ordering.");
      }
      details.description = about.map(fact => fact.payload.text).join("");
    }
    let connectorOrdinal: string | undefined;
    for (const fact of facts) {
      if (fact.kind === "collection" && fact.value.startsWith("detail:")) {
        connectorOrdinal = undefined;
        const key = fact.value.slice(7);
        if (Object.hasOwn(details, key)) {
          throw new AppError(500, "saved_source_invalid", "Saved native detail collections have invalid source ordering.");
        }
        Object.defineProperty(details, key, { value: [], enumerable: true, configurable: true, writable: true });
        continue;
      }
      if (fact.kind === "connectorOperation") {
        const ordinal = Number(fact.value);
        const connector = (details.connectors as { operations?: unknown[] }[] | undefined)?.[ordinal];
        if (fact.value !== connectorOrdinal || !Number.isSafeInteger(ordinal) || ordinal < 0
          || fact.value !== String(ordinal) || !Array.isArray(connector?.operations)) {
          throw new AppError(500, "saved_source_invalid", "Saved native connector operations do not have valid source-ordinal parentage.");
        }
        connector.operations.push(fact.payload);
        continue;
      }
      if (!fact.kind.startsWith("detail:")) continue;
      const key = fact.kind.slice(7);
      const values = (details[key] ??= []) as unknown[];
      if (!Array.isArray(values) || key === "connectors" && (fact.value !== String(values.length)
        || typeof fact.payload.connectorId !== "string"
        || fact.payload.operations !== undefined && (!Array.isArray(fact.payload.operations) || fact.payload.operations.length !== 0))) {
        throw new AppError(500, "saved_source_invalid", "Saved native connectors do not have valid source-ordinal parentage.");
      }
      values.push(Object.keys(fact.payload).length === 1 && "value" in fact.payload ? fact.payload.value : fact.payload);
      connectorOrdinal = key === "connectors" ? fact.value : undefined;
    }
  }
  return value;
}

export function inventoryQuarantineIdentity(resource: PowerPlatformResource) {
  const bots = resource.identifiers.filter(value => value.kind === "cds_bot_id")
    .sort((left, right) => left.value < right.value ? -1 : left.value > right.value ? 1 : 0);
  const environments = resource.identifiers.filter(value => value.kind === "environment_id");
  const botIds = new Set(bots.map(value => normalizedGuid(value.value)));
  const environmentIds = new Set(environments.map(value => normalizedEnvironmentId(value.value)));
  const environmentId = normalizedEnvironmentId(resource.environmentId);
  if (resource.type !== "microsoft.copilotstudio/agents" || botIds.size !== 1 || botIds.has(undefined)
    || environmentIds.size !== 1 || !environmentId || !environmentIds.has(environmentId)) return undefined;
  try {
    return validateQuarantineTarget({ botId: bots[0].value, environmentId: resource.environmentId! });
  } catch {
    return undefined;
  }
}

export function canonicalRecord(id: string, record: UnifiedAgentRecord): InventoryRecord {
  const facts: InventoryFact[] = unifiedAgentSortKeys.flatMap(key => {
    const value = agentColumnValue(record, key);
    if (value === null || value === undefined) return [];
    return [{ kind: `column:${key}`, value: "", payload: {},
      text_value: typeof value === "string" ? value : null, number_value: typeof value === "number" ? value : null }];
  });
  for (const view of ["first_party", "third_party", "copilot_studio"] as const) {
    if (matchesAgentView(record, view)) facts.push({ kind: "view", value: view, payload: {}, boolean_value: true });
  }
  for (const reason of agentRelevanceReasons(record)) facts.push({ kind: "relevance", value: reason, payload: {} });
  const platforms = new Map<string, string>();
  for (const label of [...record.packages.map(value => packageAuthoringTool(value) ?? ""),
    ...(record.powerPlatformResource ? [powerPlatformAuthoringTool(record.powerPlatformResource) ?? ""] : [])]) {
    const key = normalizePackageAuthoringTool(label);
    const formatted = formatAgentAuthoringTool(label);
    if (!platforms.has(key) || formatted < platforms.get(key)!) platforms.set(key, formatted);
  }
  for (const [value, label] of platforms) facts.push({ kind: "platform", value, text_value: label, payload: {} });
  for (const value of record.packages) {
    for (const [kind, text] of Object.entries({ type: value.type, publisher: value.publisher, availableTo: value.availableTo,
      blocked: value.isBlocked === undefined ? undefined : String(value.isBlocked) })) facts.push({ kind, value: text ?? "", payload: {} });
    for (const host of value.supportedHosts?.length ? value.supportedHosts : [""]) facts.push({ kind: "host", value: host, payload: {} });
    for (const native of [value.id, value.appId, value.manifestId, value.assetId]) if (native) facts.push({ kind: "search", value: native, payload: {} });
    if (value.createdDateTime && Number.isFinite(Date.parse(value.createdDateTime))) facts.push({ kind: "created", value: value.createdDateTime,
      number_value: Date.parse(value.createdDateTime), payload: {} });
  }
  const resource = record.powerPlatformResource;
  if (resource) {
    const target = inventoryQuarantineIdentity(resource);
    if (target) facts.push({ kind: "control:quarantine", value: resource.nativeId,
      payload: { ...target, provenance: resource.provenance["identifiers.cds_bot_id"] ?? null } });
    for (const native of [resource.nativeId, ...resource.identifiers.map(item => item.value)]) facts.push({ kind: "search", value: native, payload: {} });
    if (resource.createdAt && Number.isFinite(Date.parse(resource.createdAt))) facts.push({ kind: "created", value: resource.createdAt,
      number_value: Date.parse(resource.createdAt), payload: {} });
  }
  for (const [role, id] of Object.entries({ owner: resource?.details.ownerId,
    createdBy: resource?.createdBy, lastModifiedBy: resource?.details.lastModifiedBy })) {
    if (id) facts.push({ kind: `person:${role}`, value: isDirectoryObjectId(id) ? id.toLowerCase() : id, payload: {} });
  }
  const identityExpirations = record.packages.filter(value => value.detailFreshness?.state === "fresh")
    .map(value => inventoryTimestamp(value.detailFreshness!.expiresAt ?? ""));
  const identityExpiry = identityExpirations.reduce<string | null>((earliest, value) =>
    earliest === null || compareInventoryTimestamps(value, earliest) < 0 ? value : earliest, null);
  return { identity: id, native_id: id, environment_id: record.environmentId, display_name: record.displayName,
    presence: record.presence, link_state: record.identity.state,
    availability: agentUserAvailability(record), management: agentManagement(record),
    identity_expires_at: identityExpiry,
    sort_key: record.displayName.normalize("NFKC").toLowerCase(), resource_type: null, publisher: null, modified_at: null,
    residual: { identity: { reason: record.identity.reason,
      ...(record.identity.warnings?.length ? { warnings: structuredClone(record.identity.warnings) } : {}),
      ...(record.identity.invalidMetadata ? { invalidMetadata: true } : {}) } }, facts };
}
