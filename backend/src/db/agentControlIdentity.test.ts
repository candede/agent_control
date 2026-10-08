import { describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventoryInput, nativeInventoryFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { packageInventoryRecord } from "../services/inventoryRecordProjection.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
import { NativeInventory } from "./nativeInventory.js";

describe("corroborated current agent control identity", () => {
  it("uses fresh scoped canonical proof, never a bare native-ID or historical source alias", async () => {
    const fixture = await testDatabase();
    try {
      const scope = { tenantId: "identity-tenant", principalId: "identity-reader" };
      const environmentId = "11111111-1111-4111-8111-111111111111";
      const botId = "22222222-2222-4222-8222-222222222222";
      const inventory = new NativeInventory(fixture.runtime);
      const native = await nativeInventoryFixture(fixture.runtime, scope, [{
        nativeId: botId, environmentId, displayName: "Clinical agent", authoringTool: "Copilot Studio", lifecycle: "published",
        identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "power_platform_resource_id", value: botId }],
        details: { schemaName: "cr123_clinical", isQuarantined: false },
      }]);
      await reconcileInventoryFixture(fixture.runtime, scope);
      const resolve = () => inventory.resolveQuarantineTargets(scope, native.baselineId, [botId]);
      await expect(resolve()).rejects.toMatchObject({ code: "quarantine_native_identity_unavailable" });
      const packaged = allowlistedPackage({
        id: "published-version", displayName: "Clinical agent", isBlocked: false,
        version: "1", lastModifiedDateTime: "2026-09-15T12:00:00.000Z",
        elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition: JSON.stringify({
          SourceIds: { EnvironmentId: environmentId, CdsBotId: botId, SchemaName: "cr123_clinical" },
        }) }] }],
      });
      const publish = async (principalId: string, mode: "baseline" | "delta", detail = packaged, expiresAt?: Date) => {
        const input = inventoryInput(principalId);
        input.scope.tenantId = scope.tenantId;
        if (expiresAt) input.expiresAt = expiresAt;
        const stages = new InventoryGenerations(fixture.runtime);
        const record = packageInventoryRecord(detail);
        const root = await stages.execute(input, { domain: "packages", mode,
          channel: mode === "baseline" ? "catalog" : "exact", ...(mode === "delta" ? { targets: [detail.id] } : {}) },
        async lease => {
          await stages.appendBounded(lease, [record]);
          if (mode === "baseline") {
            await stages.visit(lease, "source");
            await stages.acceptPage(lease, { token: "source", nextToken: null, records: [record], rawCount: 1, expectedCount: 1, page: 1 }, 1);
          }
        }, { authorize: async () => {} });
        await reconcileInventoryFixture(fixture.runtime, { ...scope, principalId });
        return root;
      };
      await publish("another-reader", "baseline");
      await expect(resolve()).rejects.toMatchObject({ code: "quarantine_native_identity_unavailable" });
      const proof = await publish(scope.principalId, "baseline", packaged, new Date(Date.now() + 2000));
      expect(await resolve()).toMatchObject([{ resourceNativeId: botId, environmentId, botId, snapshotId: native.baselineId }]);
      expect((await fixture.runtime.query(`SELECT count(*)::int AS n FROM inventory_facts
        WHERE generation_id=$1 AND kind='identifier' AND payload->>'kind'='cds_bot_id'`, [native.baselineId])).rows[0].n).toBe(0);

      await expect(fixture.operator.query("UPDATE data_generations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [proof.baselineId]))
        .rejects.toThrow("data_generation_intent_immutable");
      await expect.poll(async () => {
        try { await resolve(); return "available"; }
        catch (error) { return (error as { code?: string }).code; }
      }, { timeout: 3000 }).toBe("quarantine_target_unavailable");
      await reconcileInventoryFixture(fixture.runtime, scope);
      await expect(resolve()).rejects.toMatchObject({ code: "quarantine_target_unavailable" });

      await publish(scope.principalId, "delta");
      expect(await resolve()).toMatchObject([{ resourceNativeId: botId, environmentId, botId }]);
      await publish(scope.principalId, "baseline", { ...packaged, elementDetails: undefined, identityDetailsCollected: true });
      await expect(resolve()).rejects.toMatchObject({ code: "quarantine_native_identity_unavailable" });
      expect((await fixture.runtime.query(`SELECT count(*)::int AS n FROM inventory_facts f
        JOIN inventory_memberships m ON m.generation_id=f.generation_id AND m.identity=f.identity
        JOIN inventory_roots r ON r.baseline_id=m.baseline_id AND r.current
        JOIN data_scope_epochs s ON s.id=r.scope_id
        WHERE s.tenant_id=$1 AND s.principal_id=$2 AND r.domain='packages' AND f.kind='element'
          AND m.valid_from_revision<=r.revision AND (m.valid_to_revision IS NULL OR m.valid_to_revision>r.revision)`,
      [scope.tenantId, scope.principalId])).rows[0].n).toBe(0);
    } finally { await fixture.close(); }
  });
});
