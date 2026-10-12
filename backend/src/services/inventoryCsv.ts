import { agentColumnValue } from "../types/agentPresentation.js";
import { isDirectoryObjectId } from "../types/copilotPackage.js";
import type { SavedAgentPerson, UnifiedAgentInventoryPage, UnifiedAgentSort } from "../types/unifiedAgents.js";
import { agentCapabilityExport, agentCapabilityExportColumns } from "./agentContextExport.js";
import { exportJson } from "./csvEncoding.js";
import { normalizeEnvironmentIdentity } from "./inventoryIdentity.js";
import { compareInventoryTimestamps, inventoryTimestamp } from "./inventoryTimestamp.js";

export const unifiedAgentExportColumns = [
    "agentId", "displayName", "environmentId", "environmentName", "builtWith", "packageIds", "packageStates",
    "nativeResourceId", "publicationStatus", "quarantineStatus", "identityState", "identityEvidence",
    "inventoryPartial", "inventoryRevision", "powerPlatformSnapshotId", "powerPlatformObservedAt",
    "inventoryVerificationStatus", "inventoryVerificationScope", "inventoryVerifiedAt",
    "inventorySourceCount", "inventoryUniqueSourceCount", "inventoryLogicalAgentCount", "inventoryVerificationChecks",
    "hosts", "publisher", "origin", "availability", "installedFor", "owner", "createdBy", "createdAt", "lastModifiedAt",
    "lastPublishedAt", "agentType", "versions", "region", "model", "authentication", "channels", "orchestration",
    "webSearch", "managedSolution", "source", "lastObservedAt",
    "usageStatus", "responses", "activeUsers", "lastActivityDateUtc", "usageReportSetId", "usageAvailability",
    "usageReportPeriodStart", "usageReportPeriodEnd", "usageReportPeriodProvenance", "usageReportAcceptedAt",
    "usageRevision", "usageAssociationCount",
    "ownerDisplayName", "ownerUserPrincipalName", "ownerObservedAt",
    "createdByDisplayName", "createdByUserPrincipalName", "createdByObservedAt",
    "lastModifiedBy", "lastModifiedByDisplayName", "lastModifiedByUserPrincipalName", "lastModifiedByObservedAt",
    "ownerResolutionStatus", "ownerCheckedAt", "ownerErrorCode",
    "createdByResolutionStatus", "createdByCheckedAt", "createdByErrorCode",
    "lastModifiedByResolutionStatus", "lastModifiedByCheckedAt", "lastModifiedByErrorCode",
    "environmentContextStatus", "environmentRegion", "environmentType", "managedEnvironment",
    "environmentGroup", "environmentGroupId", "environmentSnapshotId", "environmentObservedAt",
    "environmentExpiresAt", "environmentProvenance",
    ...agentCapabilityExportColumns,
    "inventorySelection", "inventoryFreshness", "inventorySources", "inventoryErrors", "inventoryIdentityCollection", "inventoryScope",
    "identityDetails", "memberCount", "packageCount", "packagesComplete", "powerPlatformCount", "powerPlatformState",
    "peopleEvidence", "environmentObservation", "usageEvidence",
  ] as const;
export function* unifiedAgentExportRows(inventory: UnifiedAgentInventoryPage) {
    if (inventory.value.length > 100) throw new Error("inventory_csv_page_limit");
    for (const record of inventory.value) {
      const value = (key: UnifiedAgentSort) => record.columns && key in record.columns ? record.columns[key] : agentColumnValue(record, key);
      const resource = record.powerPlatformResource;
      const environment = record.environment && record.environmentId !== null
        && normalizeEnvironmentIdentity(record.environment.id) === normalizeEnvironmentIdentity(record.environmentId) ? record.environment : null;
      const packagesComplete = record.packagesComplete ?? true;
      const packageCount = record.packageCount ?? record.packages.length;
      const memberCount = record.memberCount ?? (packagesComplete ? packageCount + Number(Boolean(resource)) : null);
      const nativeComplete = memberCount === null ? !resource : memberCount - packageCount <= 1;
      const person = (role: "owner" | "createdBy" | "lastModifiedBy", nativeId: string | null | undefined) => {
        const saved = record.people?.[role];
        return saved && typeof nativeId === "string" && isDirectoryObjectId(nativeId) && isDirectoryObjectId(saved.objectId)
          && saved.objectId.toLowerCase() === nativeId.toLowerCase() ? saved : undefined;
      };
      const owner = person("owner", resource?.details.ownerId), createdBy = person("createdBy", resource?.createdBy),
        lastModifiedBy = person("lastModifiedBy", resource?.details.lastModifiedBy);
      yield {
        agentId: record.id,
        displayName: record.displayName,
        environmentId: record.environmentId,
        environmentName: environment?.displayName,
        environmentContextStatus: environment ? "available" : record.environmentId ? "saved_metadata_unavailable" : "identity_not_established",
        environmentRegion: environment?.region,
        environmentType: environment?.environmentType,
        managedEnvironment: environment?.isManaged,
        environmentGroup: environment?.groupName,
        environmentGroupId: environment?.groupId,
        environmentSnapshotId: environment?.observation.snapshotId,
        environmentObservedAt: environment?.observation.observedAt,
        environmentExpiresAt: environment?.observation.expiresAt,
        environmentProvenance: environment ? exportJson(environment.provenance) : null,
        ...agentCapabilityExport(record.powerPlatformResource),
        builtWith: value("builtWith"),
        packageIds: exportJson(record.packages.map(value => value.id)),
        packageStates: exportJson(record.packages.map(value => ({
          packageId: value.id, version: value.version ?? null, isBlocked: value.isBlocked, availableTo: value.availableTo ?? null,
          deployedTo: value.deployedTo ?? null, publisher: value.publisher ?? null, type: value.type ?? null,
          displayName: value.displayName, authoringTool: value.authoringTool, platform: value.platform ?? null,
          sourceSystem: value.sourceSystem, creatorType: value.creatorType, agentKind: value.agentKind,
          lifecycle: value.lifecycle, identityConfidence: value.identityConfidence, shortDescription: value.shortDescription ?? null,
          createdDateTime: value.createdDateTime ?? null, lastModifiedDateTime: value.lastModifiedDateTime ?? null,
          manifestVersion: value.manifestVersion ?? null, manifestId: value.manifestId ?? null,
          appId: value.appId ?? null, assetId: value.assetId ?? null, elementTypes: value.elementTypes ?? null,
          supportedHosts: value.supportedHosts ?? null,
          snapshotId: record.observations.packageSnapshots[value.id]?.snapshotId ?? null,
          observedAt: record.observations.packageSnapshots[value.id]?.observedAt ?? null,
          expiresAt: record.observations.packageSnapshots[value.id]?.expiresAt ?? null,
          current: record.observations.packageSnapshots[value.id]?.current ?? null,
          scopeKind: record.observations.packageSnapshots[value.id]?.scopeKind ?? null,
          identityDetails: record.observations.packageSnapshots[value.id]?.identityDetails ?? null,
          detailFreshness: value.detailFreshness ?? null,
          controlObservations: value.controlObservations ?? null,
          provenance: value.provenance,
        }))),
        nativeResourceId: record.powerPlatformResource?.nativeId,
        publicationStatus: record.powerPlatformResource?.lifecycle ?? "unknown",
        quarantineStatus: !record.powerPlatformResource ? "not_observed"
          : typeof record.powerPlatformResource.details.isQuarantined !== "boolean" ? "unknown"
            : record.powerPlatformResource.details.isQuarantined ? "quarantined" : "not_quarantined",
        identityState: record.identity.state,
        identityEvidence: exportJson(record.identity.packageEvidence),
        identityDetails: exportJson(record.identity),
        memberCount, packageCount, packagesComplete,
        powerPlatformCount: memberCount === null ? null : memberCount - packageCount,
        powerPlatformState: resource ? exportJson({
          nativeId: resource.nativeId, type: resource.type, displayName: resource.displayName, environmentId: resource.environmentId,
          location: resource.location, authoringTool: resource.authoringTool, agentKind: resource.agentKind,
          lifecycle: resource.lifecycle, identityConfidence: resource.identityConfidence,
          sourceSystem: resource.sourceSystem, unknownFieldCount: resource.unknownFieldCount,
          complete: memberCount !== null && memberCount - packageCount === 1,
          createdAt: resource.createdAt, createdBy: resource.createdBy, lastPublishedAt: resource.lastPublishedAt,
          savedSource: resource.savedSource ?? null, observation: record.observations.powerPlatform,
          connectorCounts: resource.connectorCounts ?? null,
          identifiers: resource.identifiers, identifierCount: resource.identifierCount ?? resource.identifiers.length,
          identifiersComplete: resource.identifiersComplete ?? true, provenance: resource.provenance,
          details: Object.fromEntries([
            "ownerId", "lastModifiedBy", "lastModifiedAt", "isQuarantined", "quarantinedAt", "isManaged", "schemaName",
            "createdIn", "environmentType", "environmentGroup", "environmentGroupId", "orchestration", "model",
            "authentication", "channels", "isWebSearchEnabledForKnowledge", "connectorDetailsStatus", "capabilityDetailsTruncated",
            "distinctPowerPlatformConnectors", "distinctPowerPlatformConnectorsOperations",
          ].map(key => [key, Object.hasOwn(resource.details, key) ? resource.details[key as keyof typeof resource.details] : null])),
        }) : null,
        peopleEvidence: exportJson({ owner: personEvidence(owner), createdBy: personEvidence(createdBy), lastModifiedBy: personEvidence(lastModifiedBy) }),
        environmentObservation: environment ? exportJson(environment.observation) : null,
        usageEvidence: record.usage ? exportJson({ summary: record.usage, context: inventory.usageContext }) : null,
        inventoryPartial: inventory.partial,
        inventoryRevision: inventory.selection.revision,
        inventorySelection: exportJson(inventory.selection),
        inventoryFreshness: exportJson(inventory.freshness),
        inventorySources: exportJson(inventory.sources),
        inventoryErrors: exportJson(inventory.errors),
        inventoryIdentityCollection: inventory.identityCollection ? exportJson(inventory.identityCollection) : null,
        inventoryScope: inventory.inventoryScope,
        inventoryVerificationStatus: inventory.verification.status,
        inventoryVerificationScope: inventory.verification.scope,
        inventoryVerifiedAt: inventory.verification.checkedAt,
        inventorySourceCount: inventory.verification.representedSourceCount,
        inventoryUniqueSourceCount: inventory.verification.uniqueSourceCount,
        inventoryLogicalAgentCount: inventory.verification.logicalAgentCount,
        inventoryVerificationChecks: exportJson(inventory.verification.checks),
        powerPlatformSnapshotId: record.observations.powerPlatform?.snapshotId,
        powerPlatformObservedAt: record.observations.powerPlatform?.observedAt,
        hosts: value("hosts"),
        publisher: value("publisher"),
        origin: value("origin"),
        availability: value("availability"),
        installedFor: value("deployment"),
        owner: record.powerPlatformResource?.details.ownerId,
        createdBy: record.powerPlatformResource?.createdBy,
        ownerDisplayName: owner?.displayName,
        ownerUserPrincipalName: owner?.userPrincipalName,
        ownerObservedAt: owner?.observedAt,
        ownerResolutionStatus: owner ? owner.status ?? "resolved" : null,
        ownerCheckedAt: owner?.checkedAt,
        ownerErrorCode: owner?.errorCode,
        createdByDisplayName: createdBy?.displayName,
        createdByUserPrincipalName: createdBy?.userPrincipalName,
        createdByObservedAt: createdBy?.observedAt,
        createdByResolutionStatus: createdBy ? createdBy.status ?? "resolved" : null,
        createdByCheckedAt: createdBy?.checkedAt,
        createdByErrorCode: createdBy?.errorCode,
        lastModifiedBy: record.powerPlatformResource?.details.lastModifiedBy,
        lastModifiedByDisplayName: lastModifiedBy?.displayName,
        lastModifiedByUserPrincipalName: lastModifiedBy?.userPrincipalName,
        lastModifiedByObservedAt: lastModifiedBy?.observedAt,
        lastModifiedByResolutionStatus: lastModifiedBy ? lastModifiedBy.status ?? "resolved" : null,
        lastModifiedByCheckedAt: lastModifiedBy?.checkedAt,
        lastModifiedByErrorCode: lastModifiedBy?.errorCode,
        createdAt: !nativeComplete ? null : resource?.createdAt !== null && resource?.createdAt !== undefined ? exactDate([resource.createdAt], "earliest")
          : packagesComplete ? exactDate(record.packages.map(item => item.createdDateTime), "earliest") : null,
        lastModifiedAt: packagesComplete && nativeComplete ? exactDate([resource?.details.lastModifiedAt, ...record.packages.map(item => item.lastModifiedDateTime)]) : null,
        lastPublishedAt: nativeComplete ? exactDate([resource?.lastPublishedAt]) : null,
        agentType: value("agentType"),
        versions: value("versions"),
        region: value("location"),
        model: value("model"),
        authentication: value("authentication"),
        channels: value("channels"),
        orchestration: value("orchestration"),
        webSearch: resource?.details.isWebSearchEnabledForKnowledge,
        managedSolution: resource?.details.isManaged,
        source: value("source"),
        lastObservedAt: packagesComplete && nativeComplete ? exactDate([record.observations.powerPlatform?.observedAt,
          ...Object.values(record.observations.packageSnapshots).flatMap(item => [item.observedAt, item.identityDetails?.observedAt])]) : null,
        usageStatus: record.usage?.status ?? "unavailable",
        responses: record.usage?.responses,
        activeUsers: record.usage?.activeUsers,
        lastActivityDateUtc: record.usage?.lastActivityDateUtc,
        usageReportSetId: record.usage?.reportSetId,
        usageAvailability: inventory.usageContext?.reports.availability ?? "unavailable",
        usageReportPeriodStart: inventory.usageContext?.reports.reportingPeriod?.startDate,
        usageReportPeriodEnd: inventory.usageContext?.reports.reportingPeriod?.endDate,
        usageReportPeriodProvenance: inventory.usageContext?.reports.reportingPeriod?.provenance,
        usageReportAcceptedAt: inventory.usageContext?.reports.acceptedAt,
        usageRevision: inventory.usageContext?.revision,
        usageAssociationCount: record.usage?.associationCount,
      };
    }
}

function exactDate(values: readonly (string | null | undefined)[], direction: "earliest" | "latest" = "latest") {
  let selected: string | null = null;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    inventoryTimestamp(value);
    if (selected === null || (direction === "earliest" ? compareInventoryTimestamps(value, selected) < 0 : compareInventoryTimestamps(value, selected) > 0)) selected = value;
  }
  return selected;
}

function personEvidence(person: SavedAgentPerson | undefined) {
  return person ? {
    objectId: person.objectId, displayName: person.displayName, userPrincipalName: person.userPrincipalName,
    observedAt: person.observedAt, status: person.status ?? "resolved", checkedAt: person.checkedAt,
    expiresAt: person.expiresAt, errorCode: person.errorCode,
  } : null;
}
