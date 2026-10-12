import type { InventorySnapshot, PowerPlatformResource } from "./api/client";
import { inventoryEnvironmentPattern, inventoryGuidPattern, normalizeEnvironmentIdentity } from "../../backend/src/services/inventoryIdentity";
import { compareInventoryInstants, isInventoryTimestamp } from "../../backend/src/types/inventoryTimestamp";

export type QuarantineSelectionSnapshot = Pick<InventorySnapshot, "id" | "observedAt" | "expiresAt"> & { current?: boolean };
export type QuarantineSelectableTarget = Pick<PowerPlatformResource, "nativeId" | "type" | "displayName" | "environmentId" | "identifiers" | "details" | "quarantineIdentity"> & {
  quarantineEligibility?: { eligible: boolean; reason?: string };
};

export function quarantineTargetKey(resource: Pick<QuarantineSelectableTarget, "nativeId" | "environmentId">) {
  return `power_platform:${encodeURIComponent(normalizeEnvironmentIdentity(resource.environmentId ?? ""))}:${encodeURIComponent(resource.nativeId)}`;
}

export function quarantineTargetReason(resource: QuarantineSelectableTarget | undefined, snapshot: QuarantineSelectionSnapshot | null, now = Date.now()) {
  if (!resource || resource.type !== "microsoft.copilotstudio/agents") return "Only exact Copilot Studio agent inventory records support quarantine.";
  if (!snapshot) return "A saved inventory snapshot is required.";
  if (snapshot.current === false) return "This read is historical. Refresh inventory before changing quarantine.";
  if (resource.quarantineEligibility && !resource.quarantineEligibility.eligible) return resource.quarantineEligibility.reason ?? "The server did not qualify this saved inventory record as an exact quarantine target.";
  const staleReason = "The saved inventory target is stale. Refresh inventory before changing quarantine.";
  if (!isInventoryTimestamp(snapshot.observedAt) || !isInventoryTimestamp(snapshot.expiresAt)) return staleReason;
  const evaluation = new Date(now);
  const observationOrder = compareInventoryInstants(snapshot.observedAt, evaluation);
  const expiryOrder = compareInventoryInstants(snapshot.expiresAt, evaluation);
  const ageOrder = compareInventoryInstants(snapshot.observedAt, new Date(now - 24 * 60 * 60_000));
  if (![observationOrder, expiryOrder, ageOrder].every(Number.isFinite)
    || observationOrder > 0 || expiryOrder <= 0 || ageOrder < 0) return staleReason;
  const nativeGuid = new RegExp(inventoryGuidPattern, "i");
  const environmentGuid = new RegExp(inventoryEnvironmentPattern, "i");
  if (!resource.environmentId || ![36, 44].includes(resource.environmentId.length)
    || !environmentGuid.test(resource.environmentId)) return "The inventory record does not contain a valid native environment ID.";
  if (!resource.nativeId) return "The native bot target is absent from this inventory record.";
  const identity = resource.quarantineIdentity;
  if (!identity) return "The current server inventory does not prove one valid native CDS bot identity and matching environment.";
  if (normalizeEnvironmentIdentity(identity.environmentId) !== normalizeEnvironmentIdentity(resource.environmentId)) return "The current server inventory does not prove one matching native environment identity.";
  if (identity.botId.length !== 36 || !nativeGuid.test(identity.botId)) return "The current server inventory does not prove one valid native CDS bot identity.";
  return undefined;
}