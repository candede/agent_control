import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bootstrap, grantRuntime, migrate } from "../../scripts/database.js";
import { fixturePassword, testDatabase } from "../../scripts/testDatabase.js";
import { AgentUsageService } from "../services/agentUsage.js";
import { AuditLog } from "../services/auditLog.js";
import { packageInventoryIdentity } from "../services/inventoryIdentity.js";
import { resolvePackageAgentLinks } from "../services/packageAgentIdentity.js";
import { packageMutationStateHash } from "../services/packageMutationState.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { UnifiedAgentsService } from "../services/unifiedAgents.js";
import { createJobConfirmation, JobRepository, type JobIntentInput } from "./jobs.js";
import { PackageInventoryRepository, type UnifiedPackageSourceResult } from "./packageInventory.js";
import { PowerPlatformInventoryRepository } from "./powerPlatformInventory.js";
import { migrations } from "./schema.js";
import { UnifiedAgentRegistry } from "./unifiedAgentRegistry.js";
import { readUnifiedInventoryRevision } from "./unifiedInventoryRevision.js";

describe("package control observation upgrade", () => {
  it("reclassifies proven legacy readbacks and reunites split source records without a Microsoft resync", async () => {
    const fixture = await testDatabase(false);
    try {
      await bootstrap(fixture.operator, fixturePassword);
      await migrate(fixture.operator, migrations.filter(step => step.version < 44));
      await grantRuntime(fixture.operator);
      const scope = { tenantId: "upgrade-tenant", principalId: "upgrade-reader" };
      const environmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const manifestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const original = allowlistedPackage({
        id: "rain", displayName: "Rain watch", isBlocked: false, manifestId, elementTypes: ["DeclarativeCopilots"],
        availableTo: "allowedForAll", platform: "Microsoft 365 Copilot Agent Builder",
        elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "", definition: "{}" }] }],
      });
      const readback = allowlistedPackage({ id: "rain", displayName: "Rain watch", isBlocked: true });
      const baselineId = randomUUID();
      const controlId = randomUUID();
      const unprovedId = randomUUID();
      const snapshotRows = new Map<string, { observed_at: Date; expires_at: Date }>();
      for (const [id, value, exact, age, owner, queryHash] of [
        [baselineId, original, false, "30 minutes", scope.principalId, "a".repeat(64)],
        [controlId, readback, true, "15 minutes", scope.principalId, "b".repeat(64)],
        [unprovedId, readback, true, "15 minutes", "unproved-reader", "c".repeat(64)],
      ] as const) {
        const snapshot = await fixture.operator.query<{ observed_at: Date; expires_at: Date }>(`INSERT INTO package_inventory_snapshots(
          id,tenant_id,principal_id,token_mode,query_hash,scope_kind,requested_ids,observed_count,total_records,page_count,observed_at)
          VALUES($1,$2,$3,'delegated',$4,$5,$6::jsonb,1,1,1,clock_timestamp()-$7::interval) RETURNING observed_at,expires_at`,
        [id, scope.tenantId, owner, queryHash, exact ? "exact" : "broad", JSON.stringify(exact ? ["rain"] : []), age]);
        snapshotRows.set(id, snapshot.rows[0]);
        await fixture.operator.query(`INSERT INTO package_inventory_resources(snapshot_id,tenant_id,principal_id,native_id,display_name,is_blocked,identifiers,package_data)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, scope.tenantId, owner, value.id, value.displayName, value.isBlocked,
          JSON.stringify(packageInventoryIdentity(scope.tenantId, value).identifiers), value]);
      }
      const intent: JobIntentInput = {
        action: "block", targets: [{ id: "rain", displayName: "Rain watch", prestate: { kind: "block", isBlocked: false } }],
        scope: "single", actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId, displayName: "Upgrade", username: "upgrade@example.invalid" },
        requestPath: "/api/agents/rain/block",
      };
      const job = await new JobRepository(fixture.runtime).submit(scope, {
        ...intent, idempotencyKey: randomUUID(), confirmationHash: createJobConfirmation(intent).confirmationHash,
      });
      const state = { kind: "block" as const, isBlocked: true };
      const item = await fixture.operator.query<{ id: string }>(`UPDATE job_items SET poststate=$2,poststate_hash=$3
        WHERE job_id=$1 RETURNING id`, [job.id, state, packageMutationStateHash(state)]);
      const audit = new AuditLog(scope, fixture.runtime);
      const event = await audit.startEvent({
        id: `${item.rows[0].id}:1`, operationId: job.id, scope: "single", action: "block", targetBlockedState: true,
        agentId: "rain", actor: intent.actor, requestPath: intent.requestPath,
      });
      await audit.completeEvent(event.id, { status: "succeeded", metadata: { snapshotId: controlId, verification: "provider_readback" } });

      const powerPlatform = new PowerPlatformInventoryRepository(fixture.runtime);
      const native = await powerPlatform.submit(scope, {
        idempotencyKey: "native", roleScope: "unknown", requestedTypes: ["microsoft.copilotstudio/agents"],
      });
      await powerPlatform.markRunning(scope, native.id);
      await powerPlatform.publish(scope, native.id, {
        resources: [{
          tenantId: scope.tenantId, nativeId: manifestId, environmentId, type: "microsoft.copilotstudio/agents",
          displayName: "Rain watch", location: null, createdAt: null, createdBy: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown",
          agentKind: "agent", lifecycle: "published", identityConfidence: "exact_native",
          identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "power_platform_resource_id", value: manifestId }],
          provenance: {}, details: { schemaName: manifestId, isQuarantined: false }, unknownFieldCount: 0,
        }],
        queriedTypes: ["microsoft.copilotstudio/agents"], environmentScope: null, totalRecords: 1, pages: 1, unknownFieldCount: 0,
      });
      const baseline = snapshotRows.get(baselineId)!;
      const control = snapshotRows.get(controlId)!;
      const oldProjection: UnifiedPackageSourceResult = {
        packages: [readback],
        observations: { rain: { snapshotId: controlId, scopeKind: "exact", observedAt: control.observed_at.toISOString(), expiresAt: control.expires_at.toISOString() } },
        snapshot: {
          id: baselineId, tokenMode: "delegated", scopeKind: "broad", requestedIds: [], observedCount: 1, totalRecords: 1, pageCount: 1,
          observedAt: baseline.observed_at.toISOString(), expiresAt: baseline.expires_at.toISOString(),
        },
      };
      const dependencies = {
        powerPlatform, usage: new AgentUsageService(fixture.runtime), registry: new UnifiedAgentRegistry(fixture.runtime),
        resolveLinks: resolvePackageAgentLinks, operationPackageIds: async () => [],
        readRevision: (owner: typeof scope) => readUnifiedInventoryRevision(owner, fixture.runtime),
      };
      const legacy = new UnifiedAgentsService({
        ...dependencies, packages: { readUnifiedSource: async () => oldProjection },
        readRevision: async () => "pre-enrichment-schema-fixture",
      });
      const before = await legacy.list(scope);
      expect(before.count).toBe(2);
      expect(before.value.map(row => row.presence).sort()).toEqual(["graph_packages", "power_platform"]);

      await migrate(fixture.operator);
      await grantRuntime(fixture.operator);
      const classification = await fixture.runtime.query("SELECT id,observation_kind,control_state FROM package_inventory_snapshots ORDER BY id");
      expect(classification.rows).toEqual(expect.arrayContaining([
        { id: baselineId, observation_kind: "inventory", control_state: null },
        { id: controlId, observation_kind: "block", control_state: state },
        { id: unprovedId, observation_kind: "inventory", control_state: null },
      ]));
      const packages = new PackageInventoryRepository(fixture.runtime);
      const current = new UnifiedAgentsService({ ...dependencies, packages });
      const after = await current.list(scope);
      expect(after.count).toBe(1);
      expect(before.value.map(row => row.id)).toContain(after.value[0].id);
      expect(after.value[0]).toMatchObject({
        presence: "both", identity: { state: "matched" },
        packages: [{ id: "rain", manifestId, isBlocked: true, availableTo: "allowedForAll" }],
        powerPlatformResource: { createdBy: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      });
      expect(after.value[0].observations.packageSnapshots.rain.snapshotId).toBe(baselineId);
      expect((await packages.get(scope, "rain"))?.package).toMatchObject({ manifestId, isBlocked: true });
      expect((await packages.list(scope, { blocked: true })).count).toBe(1);
      expect((await current.forExport(scope, after.revision!)).count).toBe(1);
      expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM package_inventory_resources")).rows[0].count).toBe(3);
    } finally { await fixture.close(); }
  });
});
