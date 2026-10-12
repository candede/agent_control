import type { InventoryConnectorOperation, PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { isPackageElementType, normalizedEnvironmentId, normalizedGuid, normalizedSchemaName, parsePackageIdentityDefinition } from "./packageAgentMetadata.js";
import { exportJson } from "./csvEncoding.js";

export const agentCapabilityExportColumns = [
  "connectorDetailsStatus", "reportedConnectorTotal", "reportedOperationTotal",
  "savedConnectorDetails", "savedOperationDetails", "configuredConnectors", "capabilityProvenance",
  "invokedFlowContext",
  "capabilityDetailsTruncated",
] as const;

export function agentCapabilityExport(resource: PowerPlatformResource | null) {
  const details = resource?.details;
  return {
    connectorDetailsStatus: details?.connectorDetailsStatus ?? "not_supplied",
    capabilityDetailsTruncated: details?.capabilityDetailsTruncated,
    reportedConnectorTotal: details?.distinctPowerPlatformConnectors,
    reportedOperationTotal: details?.distinctPowerPlatformConnectorsOperations,
    savedConnectorDetails: resource?.connectorCounts?.connectors ?? details?.connectors?.length,
    savedOperationDetails: resource?.connectorCounts?.operations ?? details?.connectors?.reduce((count, connector) => count + (connector.operations?.length ?? 0), 0),
    configuredConnectors: details?.connectors === undefined ? resource?.connectorCounts?.connectors === 0 ? "[]" : null : exportJson(details.connectors.map(connector => ({
      connectorId: connector.connectorId,
      operations: connector.operations?.map(exportConnectorOperation) ?? null,
    }))),
    capabilityProvenance: resource?.provenance.connectors || resource?.provenance.capabilityCounts ? exportJson({
      connectors: resource.provenance.connectors ?? null,
      counts: resource.provenance.capabilityCounts ?? null,
    }) : null,
    invokedFlowContext: "unavailable_from_synced_sources",
  };
}

export function exportConnectorOperation(operation: InventoryConnectorOperation) {
  return {
    operationId: operation.operationId, createdBy: operation.createdBy, usedAs: operation.usedAs,
    isEnabled: operation.isEnabled, requiresEndUserConsent: operation.requiresEndUserConsent,
    connectionProvider: operation.connectionProvider, whenCanBeUsed: operation.whenCanBeUsed,
  };
}

export function exportPackageElement(payload: Record<string, unknown>) {
  const kind = Object.getOwnPropertyDescriptor(payload, "elementType")?.value;
  const common = { elementType: kind, id: Object.getOwnPropertyDescriptor(payload, "id")?.value };
  const omitted = { ...common, definition: null, definitionStatus: "not_exported" };
  if (typeof kind !== "string" || !["AgentMetadatas", "Bots", "CustomEngineCopilots"].some(type => isPackageElementType(kind, type))) return omitted;
  const invalid = { ...common, definition: null, definitionStatus: "invalid" };
  const text = Object.getOwnPropertyDescriptor(payload, "definition")?.value;
  if (typeof text !== "string") return invalid;
  let definition: unknown;
  try { definition = parsePackageIdentityDefinition(text, kind); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return invalid;
  }
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return invalid;
  const value = definition as Record<string, unknown>;
  const projected: Record<string, unknown> = Object.setPrototypeOf({}, null);
  // Definitions are unrestricted provider JSON; export only typed identity fields, never runtimes or credentials.
  if (isPackageElementType(kind, "AgentMetadatas")) {
    if (Object.hasOwn(value, "SourceIds")) {
      if (value.SourceIds === null || value.SourceIds === "") projected.SourceIds = value.SourceIds;
      else {
        if (!value.SourceIds || typeof value.SourceIds !== "object" || Array.isArray(value.SourceIds)) return invalid;
        const source = value.SourceIds as Record<string, unknown>, safe: Record<string, unknown> = Object.setPrototypeOf({}, null);
        for (const [field, validate] of [
          ["EnvironmentId", normalizedEnvironmentId], ["CdsBotId", normalizedGuid], ["SchemaName", normalizedSchemaName],
          ["ManifestId", normalizedGuid], ["EntraApplicationId", normalizedGuid],
        ] as const) {
          if (!Object.hasOwn(source, field)) continue;
          if (source[field] !== null && source[field] !== "" && !validate(source[field])) return invalid;
          safe[field] = source[field];
        }
        projected.SourceIds = safe;
      }
    }
    if (Object.hasOwn(value, "AgentIdentityId")) {
      if (value.AgentIdentityId !== null && value.AgentIdentityId !== "" && !normalizedGuid(value.AgentIdentityId)) return invalid;
      projected.AgentIdentityId = value.AgentIdentityId;
    }
  } else {
    if (isPackageElementType(kind, "CustomEngineCopilots")) {
      if (!Object.hasOwn(value, "type") || value.type !== "bot") return omitted;
      projected.type = "bot";
      if (!Object.hasOwn(value, "id") || !normalizedGuid(value.id)) return invalid;
      projected.id = value.id;
    }
    if (Object.hasOwn(value, "botId")) {
      if (!normalizedGuid(value.botId)) return invalid;
      if (isPackageElementType(kind, "CustomEngineCopilots") && normalizedGuid(value.botId) !== normalizedGuid(value.id)) return invalid;
      projected.botId = value.botId;
    } else if (isPackageElementType(kind, "Bots")) return invalid;
  }
  return { ...common, definition: JSON.stringify(projected), definitionStatus: "identity_only" };
}
