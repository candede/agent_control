import { describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { PackageInventoryRepository } from "./packageInventory.js";
import { PowerPlatformInventoryRepository } from "./powerPlatformInventory.js";

describe("corroborated agent control identity", () => {
  it("uses the same fresh scoped proof for catalog and server controls, never a bare native-ID alias", async () => {
    const fixture = await testDatabase();
    try {
      const scope = { tenantId: "identity-tenant", principalId: "identity-reader" };
      const environmentId = "11111111-1111-4111-8111-111111111111";
      const botId = "22222222-2222-4222-8222-222222222222";
      const inventory = new PowerPlatformInventoryRepository(fixture.runtime);
      const packages = new PackageInventoryRepository(fixture.runtime);
      const resource: PowerPlatformResource = {
        tenantId: scope.tenantId, nativeId: botId, environmentId, type: "microsoft.copilotstudio/agents",
        location: null, displayName: "Clinical agent", createdAt: null, createdBy: null, lastPublishedAt: null,
        sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown",
        agentKind: "copilot_studio_agent", lifecycle: "published", identityConfidence: "exact_native",
        identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "power_platform_resource_id", value: botId }],
        provenance: {}, details: { schemaName: "cr123_clinical", isQuarantined: false }, unknownFieldCount: 0,
      };
      const inventoryJob = await inventory.submit(scope, {
        idempotencyKey: "native-only-inventory", roleScope: "full", requestedTypes: ["microsoft.copilotstudio/agents"],
      });
      await inventory.markRunning(scope, inventoryJob.id);
      const saved = await inventory.publish(scope, inventoryJob.id, {
        resources: [resource], queriedTypes: ["microsoft.copilotstudio/agents"], environmentScope: null, totalRecords: 1, pages: 1, unknownFieldCount: 0,
      });
      await expect(inventory.resolveQuarantineTargets(scope, saved.snapshotId, [botId]))
        .rejects.toMatchObject({ code: "quarantine_native_identity_unavailable" });
      const packaged = allowlistedPackage({
        id: "published-version", displayName: "Clinical agent", isBlocked: false,
        version: "1", lastModifiedDateTime: "2026-09-15T12:00:00.000Z",
        elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition: JSON.stringify({
          SourceIds: { EnvironmentId: environmentId, CdsBotId: botId, SchemaName: "cr123_clinical" },
        }) }] }],
      });
      const publish = async (principalId: string, key: string) => {
        const owner = { ...scope, principalId };
        const job = await packages.submit(owner, { authorizationPrincipalId: principalId, tokenMode: "delegated", idempotencyKey: key });
        await packages.markRunning(owner, job.id);
        return packages.publish(owner, job.id, { packages: [packaged], totalRecords: 1, pages: 1 });
      };
      await publish("another-reader", "private-proof");
      await expect(inventory.resolveQuarantineTargets(scope, saved.snapshotId, [botId]))
        .rejects.toMatchObject({ code: "quarantine_native_identity_unavailable" });
      const proof = await publish(scope.principalId, "current-proof");
      expect(await inventory.resolveQuarantineTargets(scope, saved.snapshotId, [botId]))
        .toMatchObject([{ resourceNativeId: botId, environmentId, botId, snapshotId: saved.snapshotId }]);
      expect((await inventory.readUnifiedSource(scope)).resources[0].identifiers)
        .not.toContainEqual({ kind: "cds_bot_id", value: botId });
      await fixture.operator.query("UPDATE package_inventory_snapshots SET observed_at=clock_timestamp()-interval '25 hours' WHERE id=$1", [proof.snapshotId]);
      await expect(inventory.resolveQuarantineTargets(scope, saved.snapshotId, [botId]))
        .rejects.toMatchObject({ code: "quarantine_native_identity_unavailable" });
      const exact = await packages.submit(scope, {
        authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: "retained-exact-proof", requestedIds: [packaged.id],
      });
      await packages.markRunning(scope, exact.id);
      await packages.publish(scope, exact.id, { packages: [packaged], totalRecords: 1, pages: 1 });
      const refreshed = await packages.submit(scope, {
        authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: "complete-without-metadata",
      });
      await packages.markRunning(scope, refreshed.id);
      await packages.publish(scope, refreshed.id, {
        packages: [{ ...packaged, elementDetails: undefined, identityDetailsCollected: true }], totalRecords: 1, pages: 1,
      });
      const latest = await packages.readUnifiedSource(scope);
      expect(latest.packages[0].elementDetails).toBeUndefined();
      expect(latest.observations[packaged.id].identityDetails).toBeUndefined();
      await expect(inventory.resolveQuarantineTargets(scope, saved.snapshotId, [botId]))
        .rejects.toMatchObject({ code: "quarantine_native_identity_unavailable" });
    } finally {
      await fixture.close();
    }
  });
});
