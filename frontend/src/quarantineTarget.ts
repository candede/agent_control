import type { InventorySnapshot, PowerPlatformResource } from "./api/client";
import { unifiedAgentRecordId } from "../../backend/src/types/unifiedAgents";

export type QuarantineSelectionSnapshot = Pick<InventorySnapshot, "id" | "observedAt" | "expiresAt"> & { current?: boolean };
export type QuarantineSelectableTarget = Pick<PowerPlatformResource, "nativeId" | "type" | "displayName" | "environmentId" | "identifiers" | "details" | "quarantineIdentity"> & {
  quarantineEligibility?: { eligible: boolean; reason?: string };
};

export function quarantineTargetKey(resource: Pick<QuarantineSelectableTarget, "nativeId" | "environmentId">) {
  return unifiedAgentRecordId({ source: "power_platform", nativeId: resource.nativeId, environmentId: resource.environmentId });
}

export function quarantineTargetReason(resource: QuarantineSelectableTarget | undefined, snapshot: QuarantineSelectionSnapshot | null, now = Date.now()) {
  if (!resource || resource.type !== "microsoft.copilotstudio/agents") return "Only exact Copilot Studio agent inventory records support quarantine.";
  if (!snapshot) return "A saved inventory snapshot is required.";
  if (snapshot.current === false) return "This read is historical. Refresh inventory before changing quarantine.";
  if (resource.quarantineEligibility && !resource.quarantineEligibility.eligible) return resource.quarantineEligibility.reason ?? "The server did not qualify this saved inventory record as an exact quarantine target.";
  const observedAt = Date.parse(snapshot.observedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) || observedAt > now || expiresAt <= now || observedAt < now - 24 * 60 * 60_000) return "The saved inventory target is stale. Refresh inventory before changing quarantine.";
  const nativeGuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const environmentGuid = new RegExp(`^(?:Default-)?${nativeGuid.source.slice(1, -1)}$`, "i");
  if (!resource.environmentId || !environmentGuid.test(resource.environmentId)) return "The inventory record does not contain a valid native environment ID.";
  if (!resource.nativeId) return "The native bot target is absent from this inventory record.";
  const identity = resource.quarantineIdentity;
  if (!identity) return "The current server inventory does not prove one valid native CDS bot identity and matching environment.";
  if (identity.environmentId.toLowerCase() !== resource.environmentId.toLowerCase()) return "The current server inventory does not prove one matching native environment identity.";
  if (!nativeGuid.test(identity.botId)) return "The current server inventory does not prove one valid native CDS bot identity.";
  return undefined;
}