import type { InventoryConnectorOperation, PowerPlatformResource } from "../types/powerPlatformInventory.js";

export const agentCapabilityExportColumns = [
  "connectorDetailsStatus", "reportedConnectorTotal", "reportedOperationTotal",
  "savedConnectorDetails", "savedOperationDetails", "configuredConnectors", "capabilityProvenance",
  "invokedFlowContext",
] as const;

export function agentCapabilityExport(resource: PowerPlatformResource | null) {
  const details = resource?.details;
  return {
    connectorDetailsStatus: details?.connectorDetailsStatus ?? "not_supplied",
    reportedConnectorTotal: details?.distinctPowerPlatformConnectors,
    reportedOperationTotal: details?.distinctPowerPlatformConnectorsOperations,
    savedConnectorDetails: resource?.connectorCounts?.connectors ?? details?.connectors?.length,
    savedOperationDetails: resource?.connectorCounts?.operations ?? details?.connectors?.reduce((count, connector) => count + (connector.operations?.length ?? 0), 0),
    configuredConnectors: details?.connectors === undefined ? null : JSON.stringify(details.connectors.map(connector => ({
      connectorId: connector.connectorId,
      operations: connector.operations?.map(exportConnectorOperation) ?? null,
    }))),
    capabilityProvenance: resource?.provenance.connectors || resource?.provenance.capabilityCounts ? JSON.stringify({
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
