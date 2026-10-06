import { assertResidualBytes, digest, dataLimitError } from "../db/dataBounds.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { formatAgentAuthoringTool, normalizePackageAuthoringTool } from "../types/copilotPackage.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { powerPlatformAuthoringTool } from "../types/powerPlatformInventory.js";
import { inventoryLimits, type InventoryClassification } from "../types/inventoryRecords.js";
import { allowlistedPackage } from "./packageObservation.js";
import { isPackageElementType, normalizedEnvironmentId, normalizedGuid, normalizedSchemaName, readPackageAgentMetadata, readPackageCustomEngineBotIdentity } from "./packageAgentMetadata.js";
import { normalizeNativeIdentity } from "./inventoryIdentity.js";
import { buildRecords } from "./inventoryComponent.js";
import { resolvePackageAgentLinks } from "./packageAgentIdentity.js";
import { unifiedAgentSortKeys, type UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { agentColumnValue, agentManagement, agentRelevanceReasons, agentUserAvailability, matchesAgentView, packageAuthoringTool } from "../types/agentPresentation.js";
import { validateQuarantineTarget } from "./copilotStudioQuarantine.js";

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
  digest(JSON.stringify([value.type, normalizeNativeIdentity(value.environmentId ?? ""), normalizeNativeIdentity(value.nativeId)]));

function bounded(record: InventoryRecord) {
  if (record.facts.length > inventoryLimits.factsPerRecord) throw dataLimitError("inventory_facts", inventoryLimits.factsPerRecord, record.facts.length);
  const bytes = Buffer.byteLength(JSON.stringify(record.residual));
  assertResidualBytes(bytes, "inventory_projection");
  return record;
}

export function packageInventoryRecord(input: CopilotPackageDetail): InventoryRecord {
  const retainedFields = ["identityDetailsCollected", "identityRevalidationRequired", "detailFreshness", "controlObservations"] as const;
  const observation = { ...input };
  // Local freshness/control annotations are not omitted provider fields.
  for (const key of retainedFields) delete observation[key];
  const value = { ...allowlistedPackage(observation), ...Object.fromEntries(
    retainedFields.filter(key => key in input).map(key => [key, input[key]])) } as CopilotPackageDetail;
  const facts: InventoryFact[] = [];
  const fact = (kind: string, value: string, payload: Record<string, unknown> = {}) => facts.push({ kind, value, payload });
  for (const kind of ["supportedHosts", "elementTypes", "categories"] as const) {
    if (value[kind] !== undefined) fact("collection", kind);
    for (const item of value[kind] ?? []) fact(kind, item);
  }
  for (const kind of ["allowedUsersAndGroups", "acquireUsersAndGroups"] as const) {
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
  if (!value.identityRevalidationRequired && (!value.detailFreshness || value.detailFreshness.state === "fresh")) {
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
  const catalogManifest = !value.detailFreshness || value.detailFreshness.state === "fresh"
    || value.detailFreshness.state !== "invalidated" && !value.elementDetails?.some(group => isPackageElementType(group.elementType, "AgentMetadatas"));
  if (!value.identityRevalidationRequired && catalogManifest && metadata.status !== "conflicting"
    && !(metadata.status === "unmatched" && metadata.invalidMetadata) && declarativeCount <= 1
    && (declarativeCount > 0 || value.elementTypes?.some(type => isPackageElementType(type, "DeclarativeCopilots")))
    && normalizedGuid(value.manifestId) && !identity?.cdsBotId) {
    fact("match:manifest", normalizedGuid(value.manifestId)!);
  }
  // Source-native identity evidence stays bounded; child collections are not list payloads.
  const residual: Record<string, unknown> = { ...value };
  for (const key of ["supportedHosts", "elementTypes", "categories", "allowedUsersAndGroups", "acquireUsersAndGroups", "elementDetails"]) delete residual[key];
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

export function restoreInventoryRecord(residual: Record<string, unknown>, facts: readonly InventoryFact[], domain: string) {
  const value = structuredClone(residual);
  if (domain === "packages") {
    for (const kind of ["supportedHosts", "elementTypes", "categories", "allowedUsersAndGroups", "acquireUsersAndGroups"]) {
      const selected = facts.filter(fact => fact.kind === kind);
      if (selected.length || facts.some(fact => fact.kind === "collection" && fact.value === kind)) value[kind] = selected.map(fact => kind.endsWith("UsersAndGroups") ? fact.payload : fact.value);
    }
    const groups = new Map<string, { elementType: string; elements: { id: string; definition: string }[] }>();
    for (const fact of facts.filter(fact => fact.kind === "elementGroup")) groups.set(fact.value, { elementType: fact.value, elements: [] });
    for (const fact of facts.filter(fact => fact.kind === "element")) {
      const { elementType, id, definition } = fact.payload as { elementType: string; id: string; definition: string };
      const group = groups.get(elementType) ?? { elementType, elements: [] };
      group.elements.push({ id, definition }); groups.set(elementType, group);
    }
    if (groups.size || facts.some(fact => fact.kind === "collection" && fact.value === "elementDetails")) value.elementDetails = [...groups.values()];
  } else {
    value.identifiers = facts.filter(fact => fact.kind === "identifier").map(fact => fact.payload);
    const details = value.details as Record<string, unknown>;
    for (const fact of facts.filter(fact => fact.kind === "collection" && fact.value.startsWith("detail:"))) details[fact.value.slice(7)] = [];
    for (const fact of facts.filter(fact => fact.kind.startsWith("detail:"))) {
      const key = fact.kind.slice(7);
      const values = (details[key] ??= []) as unknown[];
      values.push(Object.keys(fact.payload).length === 1 && "value" in fact.payload ? fact.payload.value : fact.payload);
    }
    for (const fact of facts.filter(fact => fact.kind === "connectorOperation")) {
      const connector = (details.connectors as { operations: unknown[] }[])[Number(fact.value)];
      connector.operations.push(fact.payload);
    }
  }
  return value;
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
    const bots = resource.identifiers.filter(value => value.kind === "cds_bot_id");
    const environments = resource.identifiers.filter(value => value.kind === "environment_id");
    if (bots.length === 1 && environments.length === 1 && environments[0].value.toLowerCase() === resource.environmentId?.toLowerCase()) {
      let target;
      try { target = validateQuarantineTarget({ botId: bots[0].value, environmentId: resource.environmentId! }); } catch { /* Invalid evidence never authorizes control. */ }
      if (target) facts.push({ kind: "control:quarantine", value: resource.nativeId,
        payload: { ...target, provenance: resource.provenance["identifiers.cds_bot_id"] ?? null } });
    }
    for (const native of [resource.nativeId, ...resource.identifiers.map(item => item.value)]) facts.push({ kind: "search", value: native, payload: {} });
    if (resource.createdAt && Number.isFinite(Date.parse(resource.createdAt))) facts.push({ kind: "created", value: resource.createdAt,
      number_value: Date.parse(resource.createdAt), payload: {} });
  }
  for (const [role, id] of Object.entries({ owner: resource?.details.ownerId,
    createdBy: resource?.createdBy, lastModifiedBy: resource?.details.lastModifiedBy })) {
    if (id) facts.push({ kind: `person:${role}`, value: id.trim().toLowerCase(), payload: {} });
  }
  const identityExpirations = record.packages.filter(value => value.detailFreshness?.state === "fresh")
    .map(value => Date.parse(value.detailFreshness!.expiresAt ?? "")).filter(Number.isFinite);
  return { identity: id, native_id: id, environment_id: record.environmentId, display_name: record.displayName,
    presence: record.presence, link_state: record.identity.state,
    availability: agentUserAvailability(record), management: agentManagement(record),
    identity_expires_at: identityExpirations.length ? new Date(Math.min(...identityExpirations)).toISOString() : null,
    sort_key: record.displayName.normalize("NFKC").toLowerCase(), resource_type: null, publisher: null, modified_at: null,
    residual: { identity: { reason: record.identity.reason } }, facts };
}
