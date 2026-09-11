import type { InventorySnapshot, PowerPlatformResource } from "./api/client";

export type QuarantineSelectionSnapshot = Pick<InventorySnapshot, "id" | "observedAt" | "expiresAt">;
export type QuarantineSelectableTarget = Pick<PowerPlatformResource, "nativeId" | "type" | "displayName" | "environmentId" | "identifiers" | "details"> & {
  quarantineEligibility?: { eligible: boolean; reason?: string };
};

export function quarantineTargetReason(resource: QuarantineSelectableTarget | undefined, snapshot: QuarantineSelectionSnapshot | null, now = Date.now()) {
  if (!resource || resource.type !== "microsoft.copilotstudio/agents") return "Only exact Copilot Studio agent inventory records support quarantine.";
  if (!snapshot) return "A saved inventory snapshot is required.";
  if (resource.quarantineEligibility && !resource.quarantineEligibility.eligible) return resource.quarantineEligibility.reason ?? "The server did not qualify this saved inventory record as an exact quarantine target.";
  if (Date.parse(snapshot.expiresAt) <= now || Date.parse(snapshot.observedAt) < now - 24 * 60 * 60_000) return "The saved inventory target is stale. Refresh inventory before changing quarantine.";
  const nativeGuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const environmentGuid = new RegExp(`^(?:Default-)?${nativeGuid.source.slice(1, -1)}$`, "i");
  if (!resource.environmentId || !environmentGuid.test(resource.environmentId)) return "The inventory record does not contain a valid native environment ID.";
  if (!resource.nativeId) return "The native bot target is absent from this inventory record.";
  const environmentIds = resource.identifiers.filter(identifier => identifier.kind === "environment_id").map(identifier => identifier.value);
  const botIds = resource.identifiers.filter(identifier => identifier.kind === "cds_bot_id").map(identifier => identifier.value);
  if (environmentIds.length !== 1 || environmentIds[0] !== resource.environmentId) return "The inventory record does not contain one matching native environment identity.";
  if (botIds.length !== 1 || !nativeGuid.test(botIds[0])) return "The inventory record does not contain one valid native CDS bot identity.";
  return undefined;
}