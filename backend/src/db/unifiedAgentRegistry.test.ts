import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrap, grantRuntime, migrate, retain } from "../../scripts/database.js";
import { fixturePassword, testDatabase } from "../../scripts/testDatabase.js";
import { AuditLog } from "../services/auditLog.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { inventoryQueryTypes } from "../services/inventoryRoleScope.js";
import { powerPlatformResourceTypes, type PowerPlatformResource } from "../types/powerPlatformInventory.js";
import type { UnifiedAgentLinkEvidence, UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { DataSyncRepository } from "./dataSync.js";
import { PackageInventoryRepository, type PackageRefreshInput } from "./packageInventory.js";
import { PowerPlatformInventoryRepository, type InventoryRefreshInput } from "./powerPlatformInventory.js";
import { migrations, migrationChecksum } from "./schema.js";
import { UnifiedAgentRegistry, type UnifiedAgentRegistryScope } from "./unifiedAgentRegistry.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let registry: UnifiedAgentRegistry;

beforeAll(async () => {
  fixture = await testDatabase();
  registry = new UnifiedAgentRegistry(fixture.runtime);
}, 60_000);
afterAll(async () => { await fixture?.close(); });

const nativeGuid = "abcdefab-1234-4567-89ab-abcdefabcdef";
const newScope = (): UnifiedAgentRegistryScope => ({ tenantId: `tenant-${randomUUID()}`, principalId: `principal-${randomUUID()}` });
const evidence: UnifiedAgentLinkEvidence = {
  kind: "environment_cds_bot_id", basis: "source_declared_metadata", elementIds: ["element"],
  packagePath: "elementDetails.AgentMetadatas.definition.SourceIds.CdsBotId", resourcePath: "identifiers.cds_bot_id",
};
const canonicalId = (record: UnifiedAgentRecord) => record.id.slice("agent:".length);

describe("canonical agent registry", () => {
  it("upgrades migration31 without changing its checksums or saved source data", async () => {
    const upgrade = await testDatabase(false);
    try {
      await bootstrap(upgrade.operator, fixturePassword);
      await migrate(upgrade.operator, migrations.filter(step => step.version <= 31));
      await grantRuntime(upgrade.operator);
      const scope = newScope();
      const records = await observeGroups(scope, [{ packageIds: ["upgrade"], resource: { nativeId: nativeGuid } }], upgrade.runtime, true);
      const before = await upgrade.runtime.query(`SELECT to_jsonb(snapshot) AS value FROM package_inventory_snapshots snapshot`);
      const resourcesBefore = await upgrade.runtime.query("SELECT to_jsonb(resource) AS value,xmin::text AS row_version FROM package_inventory_resources resource");
      const boundaries = () => upgrade.operator.query<{ conname: string; definition: string }>(`
        SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE (conrelid='audit_events'::regclass AND conname IN ('audit_events_action_check','audit_events_action_state'))
          OR (conrelid='jobs'::regclass AND conname='jobs_action_check') ORDER BY conname`);
      const constraintsBefore = new Map((await boundaries()).rows.map(row => [row.conname, row.definition]));
      const actionNames = (definition: string) => [...definition.matchAll(/'([a-z-]+)'/g)].map(match => match[1]).sort();
      const previousActions = actionNames(constraintsBefore.get("audit_events_action_check")!);
      expect(previousActions).toHaveLength(21);
      for (const action of previousActions) {
        await appendAuditEvent(upgrade.runtime, scope, action, action === "block" ? true : action === "unblock" ? false : null);
      }
      const auditBefore = await upgrade.runtime.query("SELECT to_jsonb(event) AS value,xmin::text AS row_version FROM audit_events event ORDER BY id");
      await migrate(upgrade.operator);
      await grantRuntime(upgrade.operator);
      expect((await upgrade.runtime.query(`SELECT to_jsonb(snapshot) AS value FROM package_inventory_snapshots snapshot`)).rows).toEqual(before.rows);
      expect((await upgrade.runtime.query("SELECT to_jsonb(resource) AS value,xmin::text AS row_version FROM package_inventory_resources resource")).rows).toEqual(resourcesBefore.rows);
      expect((await upgrade.runtime.query("SELECT to_jsonb(event) AS value,xmin::text AS row_version FROM audit_events event ORDER BY id")).rows).toEqual(auditBefore.rows);
      const constraintsAfter = new Map((await boundaries()).rows.map(row => [row.conname, row.definition]));
      expect(actionNames(constraintsAfter.get("audit_events_action_check")!)).toEqual([...previousActions, "export-agent-inventory"].sort());
      for (const name of ["audit_events_action_state", "jobs_action_check"]) {
        expect(constraintsAfter.get(name)).toBe(constraintsBefore.get(name));
      }
      expect((await upgrade.runtime.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows).toEqual(
        migrations.map(step => ({ version: step.version, checksum: migrationChecksum(step.sql) })),
      );
      expect(migrations.some(step => step.version === 32)).toBe(true);
      expect((await reconcile(scope, records, new UnifiedAgentRegistry(upgrade.runtime)))[0].id).toMatch(/^agent:[0-9a-f-]{36}$/);
    } finally {
      await upgrade.close();
    }
  }, 30_000);

  it("admits unified inventory export audit events only with null blocked-state", async () => {
    const scope = newScope();
    const audit = new AuditLog(scope, fixture.runtime);
    const started = await audit.startEvent({
      operationId: `export-agent-inventory:${randomUUID()}`, action: "export-agent-inventory", scope: "bulk",
      agentId: "agent-inventory", requestPath: "/fixture/agent-inventory/export",
      actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId, username: "fixture@example.invalid", displayName: "Fixture" },
      metadata: { source: "unified_agents" },
    });
    expect(started).toMatchObject({ action: "export-agent-inventory", status: "started" });
    expect(started).not.toHaveProperty("targetBlockedState");
    await expect(audit.completeEvent(started.id, { status: "succeeded" }))
      .resolves.toMatchObject({ action: "export-agent-inventory", status: "succeeded" });
    for (const state of [true, false]) {
      await expect(appendAuditEvent(fixture.runtime, scope, "export-agent-inventory", state))
        .rejects.toMatchObject({ code: "23514", constraint: "audit_events_action_state" });
    }
    for (const action of ["block", "unblock"]) {
      await expect(appendAuditEvent(fixture.runtime, scope, action, null))
        .rejects.toMatchObject({ code: "23514", constraint: "audit_events_action_state" });
    }
    await expect(appendAuditEvent(fixture.runtime, scope, "unknown-export", null))
      .rejects.toMatchObject({ code: "23514", constraint: "audit_events_action_check" });
    expect((await fixture.runtime.query(`SELECT action,target_blocked_state,status FROM audit_events
      WHERE tenant_id=$1 AND principal_id=$2 ORDER BY observed_at,id`, [scope.tenantId, scope.principalId])).rows)
      .toEqual([
        { action: "export-agent-inventory", target_blocked_state: null, status: "started" },
        { action: "export-agent-inventory", target_blocked_state: null, status: "succeeded" },
      ]);
  });

  it("fails migration32 atomically rather than rewriting legacy PP casing duplicates", async () => {
    const upgrade = await testDatabase(false);
    try {
      await bootstrap(upgrade.operator, fixturePassword);
      await migrate(upgrade.operator, migrations.filter(step => step.version <= 31));
      await grantRuntime(upgrade.operator);
      const scope = newScope();
      await observeGroups(scope, [
        { packageIds: [], resource: { nativeId: nativeGuid, environmentId: "environment" } },
        { packageIds: [], resource: { nativeId: nativeGuid.toUpperCase(), environmentId: "ENVIRONMENT" } },
      ], upgrade.runtime, true);
      const before = (await upgrade.runtime.query("SELECT to_jsonb(resource) AS value FROM power_platform_inventory_resources resource ORDER BY native_id")).rows;
      await expect(migrate(upgrade.operator)).rejects.toMatchObject({ code: "23505" });
      expect((await upgrade.operator.query("SELECT version FROM schema_migrations WHERE version=32")).rows).toEqual([]);
      expect((await upgrade.operator.query("SELECT to_regclass('public.unified_agents') AS name")).rows[0].name).toBeNull();
      expect((await upgrade.runtime.query("SELECT to_jsonb(resource) AS value FROM power_platform_inventory_resources resource ORDER BY native_id")).rows).toEqual(before);
    } finally {
      await upgrade.close();
    }
  }, 30_000);

  it("accepts package JSONB through exactly 2 MiB while retaining the object-only contract", async () => {
    const scope = newScope();
    const [record] = await observeGroups(scope, [{ packageIds: ["seed"] }]);
    const snapshot = record.observations.packageSnapshots.seed.snapshotId;
    const insertBytes = (bytes: number, object = true) => fixture.runtime.query<{ bytes: number }>(`
      INSERT INTO package_inventory_resources(
        snapshot_id,tenant_id,principal_id,native_id,display_name,is_blocked,identifiers,package_data)
      SELECT snapshot_id,tenant_id,principal_id,$2,display_name,is_blocked,
        jsonb_build_array(jsonb_build_object('kind','package_id','value',$2::text)),
        CASE WHEN $4 THEN jsonb_build_object('definition',
          repeat('x',$3::integer-octet_length(jsonb_build_object('definition',''::text)::text)))
          ELSE '[]'::jsonb END
      FROM package_inventory_resources WHERE snapshot_id=$1 AND native_id='seed'
      RETURNING octet_length(package_data::text) AS bytes`, [snapshot, randomUUID(), bytes, object]);
    for (const bytes of [1_048_577, 2_048_000, 2_097_152]) {
      expect((await insertBytes(bytes)).rows).toEqual([{ bytes }]);
    }
    for (const result of [() => insertBytes(2_097_153), () => insertBytes(2, false)]) {
      await expect(result()).rejects.toMatchObject({ code: "23514", constraint: "package_inventory_resources_package_data_check" });
    }
  });

  it.each(["DeclarativeCopilots", "AgentMetadatas"])("publishes complete %s definitions larger than the former 1 MiB row limit", async elementType => {
    const scope = newScope();
    const definition = JSON.stringify({
      SourceIds: { EnvironmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CdsBotId: nativeGuid, SchemaName: "cr_registry" },
      description: "x".repeat(1_200_000),
    });
    const value = allowlistedPackage({
      id: "large-definition", displayName: "Large definition", isBlocked: false, elementTypes: [elementType],
      elementDetails: [{ elementType, elements: [{ id: "definition", definition }] }],
    });
    const packages = new PackageInventoryRepository(fixture.runtime);
    const job = await packages.submit(scope, {
      authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: randomUUID(),
    });
    await packages.markRunning(scope, job.id);
    await packages.publish(scope, job.id, { packages: [value], totalRecords: 1, pages: 1 });
    const result = await fixture.runtime.query<{ package_data: typeof value; bytes: number }>(`
      SELECT package_data,octet_length(package_data::text) AS bytes FROM package_inventory_resources
      WHERE tenant_id=$1 AND principal_id=$2 AND native_id=$3`, [scope.tenantId, scope.principalId, value.id]);
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].bytes).toBeGreaterThan(1_048_576);
    expect(result.rows[0].bytes).toBeLessThanOrEqual(2_097_152);
    expect(result.rows[0].package_data.elementDetails?.[0]?.elements[0]?.definition).toBe(definition);
  });

  it("stores many opaque packages and one PP agent under one UUID without persisting provider payloads", async () => {
    const scope = newScope();
    const records = await observeGroups(scope, [{
      packageIds: ["Graph/Alpha:%", "Graph/alpha:%", nativeGuid.toUpperCase()],
      resource: { nativeId: nativeGuid.toUpperCase(), environmentId: "ENVIRONMENT-ONE" },
    }]);
    const extraEvidence = { ...evidence, displayName: "Private provider payload", fullPayload: records[0].packages };
    records[0].identity.packageEvidence = [
      { packageId: "Graph/Alpha:%", evidence: [extraEvidence] },
      { packageId: "Graph/alpha:%", evidence: [{ ...evidence, elementIds: ["another-element"] }] },
    ];
    const before = structuredClone(records[0]);
    const [record] = await reconcile(scope, records);
    expect(record).toEqual({ ...before, id: record.id });
    expect(record.id).toMatch(/^agent:[0-9a-f-]{36}$/);
    expect(record.packages).toBe(records[0].packages);
    expect(record.powerPlatformResource).toBe(records[0].powerPlatformResource);
    expect(record.identity).toBe(records[0].identity);
    expect(record.observations).toBe(records[0].observations);
    const saved = await registryRows(scope);
    expect(saved.agents).toHaveLength(1);
    expect(saved.sources).toHaveLength(4);
    expect(new Set(saved.sources.map(source => source.agent_id))).toEqual(new Set([canonicalId(record)]));
    expect(saved.sources.find(source => source.native_id === "Graph/Alpha:%")).toMatchObject({
      environment_id: "", native_id: "Graph/Alpha:%", matching_evidence: [evidence],
      package_snapshot_id: records[0].observations.packageSnapshots["Graph/Alpha:%"].snapshotId,
    });
    expect(saved.sources.find(source => source.source === "power_platform")).toMatchObject({
      native_id: nativeGuid.toUpperCase(), environment_id: "ENVIRONMENT-ONE",
      normalized_native_id: nativeGuid, normalized_environment_id: "environment-one", matching_evidence: [],
      power_platform_snapshot_id: records[0].observations.powerPlatform!.snapshotId,
    });
    expect(JSON.stringify(saved)).not.toContain("Private provider");
  });

  it("preserves shared custom-engine evidence without granting controls to an alias-only package", async () => {
    const scope = newScope();
    const directId = "Direct-package:A";
    const aliasId = "Alias-package:B";
    const [record] = await observeGroups(scope, [{ packageIds: [directId, aliasId], resource: { nativeId: nativeGuid } }]);
    const aliasEvidence: UnifiedAgentLinkEvidence = {
      kind: "shared_custom_engine_bot_id", basis: "source_declared_metadata",
      elementIds: ["bot-element", "custom-engine-element"],
      packagePath: "elementDetails.Bots.definition.botId+elementDetails.CustomEngineCopilots.definition.id",
      resourcePath: "corroboratedPackage.nativeId", relatedPackageIds: [directId],
    };
    record.identity.evidence = [evidence, aliasEvidence];
    record.identity.packageEvidence = [
      { packageId: directId, evidence: [evidence] }, { packageId: aliasId, evidence: [aliasEvidence] },
    ];
    const before = structuredClone(record);
    const [resolved] = await reconcile(scope, [record]);
    expect(resolved).toEqual({ ...before, id: resolved.id });
    expect(resolved.identity).toBe(record.identity);
    expect(resolved.packages).toBe(record.packages);
    expect(resolved.packages.find(value => value.id === aliasId)).not.toHaveProperty("controlBotId");
    expect(resolved.powerPlatformResource).toBe(record.powerPlatformResource);
    const saved = await registryRows(scope);
    expect(saved.sources.find(source => source.native_id === aliasId)).toMatchObject({ matching_evidence: [aliasEvidence] });
    expect(saved.sources.find(source => source.native_id === directId)).toMatchObject({ matching_evidence: [evidence] });
    expect(new Set(saved.sources.map(source => source.agent_id))).toEqual(new Set([canonicalId(resolved)]));
  });

  it("preserves UUIDs through source order, input ID changes, no-op reads and new snapshots with GUID casing changes", async () => {
    const scope = newScope();
    const groups: GroupInput[] = [
      { packageIds: ["b", "a"], resource: { nativeId: nativeGuid, environmentId: "Environment-A" } },
      { packageIds: ["c"] },
      { packageIds: [], resource: { nativeId: "OpaqueNative", environmentId: null } },
    ];
    const records = await observeGroups(scope, groups);
    const first = await reconcile(scope, records);
    const saved = await registryRows(scope);
    const reordered = [...records].reverse().map(record => ({
      ...record, id: first[0].id, packages: [...record.packages].reverse(),
    }));
    expect((await reconcile(scope, reordered)).map(record => record.id)).toEqual([...first].reverse().map(record => record.id));
    expect(await registryRows(scope)).toEqual(saved);
    const refreshed = await observeGroups(scope, [
      groups[2], groups[1],
      { packageIds: ["a", "b"], resource: { nativeId: nativeGuid.toUpperCase(), environmentId: "ENVIRONMENT-A" } },
    ]);
    const latest = await reconcile(scope, refreshed);
    expect(latest.map(record => record.id)).toEqual([...first].reverse().map(record => record.id));
    expect(latest[2].powerPlatformResource).toBe(refreshed[2].powerPlatformResource);
    expect((await registryRows(scope)).sources.find(source => source.agent_id === canonicalId(first[0]) && source.source === "power_platform"))
      .toMatchObject({ native_id: nativeGuid.toUpperCase(), environment_id: "ENVIRONMENT-A" });
    await fixture.operator.query("DELETE FROM package_inventory_snapshots WHERE tenant_id=$1 AND principal_id=$2 AND NOT is_current", [scope.tenantId, scope.principalId]);
    await fixture.operator.query("DELETE FROM power_platform_inventory_snapshots WHERE tenant_id=$1 AND principal_id=$2 AND NOT is_current", [scope.tenantId, scope.principalId]);
    expect((await registryRows(scope)).sources).toHaveLength(5);
    expect((await reconcile(scope, refreshed)).map(record => record.id)).toEqual(latest.map(record => record.id));
  });

  it("canonicalizes only stored evidence ordering, removes withdrawn proof, and bounds its size", async () => {
    const scope = newScope();
    const [record] = await observeGroups(scope, [{ packageIds: ["a", "b"], resource: { nativeId: nativeGuid } }]);
    record.identity.packageEvidence = [{ packageId: "a", evidence: [{
      ...evidence, elementIds: ["z", "a"], relatedPackageIds: ["b", "a"],
    }] }];
    const [first] = await reconcile(scope, [record]);
    const before = await registryRows(scope);
    const reordered = {
      ...record, identity: { ...record.identity, packageEvidence: [{ packageId: "a", evidence: [{
        ...evidence, elementIds: ["a", "z"], relatedPackageIds: ["a", "b"],
      }] }] },
    };
    expect((await reconcile(scope, [reordered]))[0].id).toBe(first.id);
    expect(await registryRows(scope)).toEqual(before);
    expect(record.identity.packageEvidence[0].evidence[0].elementIds).toEqual(["z", "a"]);
    const withdrawn = { ...record, identity: { ...record.identity, packageEvidence: [] } };
    expect((await reconcile(scope, [withdrawn]))[0].id).toBe(first.id);
    const after = await registryRows(scope);
    expect(after.sources.find(source => source.native_id === "a")).toMatchObject({ matching_evidence: [] });
    expect(after.sources.filter(source => source.native_id !== "a")).toEqual(before.sources.filter(source => source.native_id !== "a"));
    await expect(reconcile(scope, [{
      ...record, identity: { ...record.identity, packageEvidence: [{ packageId: "a", evidence: Array.from({ length: 20 }, (_, index) => ({
        ...evidence, packagePath: `${index}.${"p".repeat(1_000)}`,
      })) }] },
    }])).rejects.toMatchObject({ code: "saved_source_invalid", message: expect.stringContaining("16 KiB") });
    expect(await registryRows(scope)).toEqual(after);
  });

  it.each(["oldest", "uuid"] as const)("merges all memberships onto the deterministic %s survivor", async preference => {
    const scope = newScope();
    const first = await reconcile(scope, await observeGroups(scope, [
      { packageIds: ["a"] }, { packageIds: ["b"], resource: { nativeId: nativeGuid } },
    ]));
    await fixture.operator.query(`UPDATE unified_agents SET created_at=CASE
      WHEN id=$3 OR $4='uuid' THEN '2026-01-01'::timestamptz ELSE '2026-01-02'::timestamptz END
      WHERE tenant_id=$1 AND principal_id=$2`, [scope.tenantId, scope.principalId, canonicalId(first[0]), preference]);
    const expected = preference === "oldest" ? first[0].id : first.map(record => record.id).sort()[0];
    const merged = await reconcile(scope, await observeGroups(scope, [
      { packageIds: ["b", "a"], resource: { nativeId: nativeGuid }, inputId: first.find(record => record.id !== expected)!.id },
    ]));
    expect(merged[0].id).toBe(expected);
    const saved = await registryRows(scope);
    expect(saved.agents).toHaveLength(1);
    expect(saved.sources).toHaveLength(3);
    expect(saved.sources.every(source => `agent:${source.agent_id}` === expected)).toBe(true);
  });

  it("splits later matching decisions without lending the same UUID to two rows or using equal names", async () => {
    const scope = newScope();
    const [first] = await reconcile(scope, await observeGroups(scope, [{
      packageIds: ["a", "b"], resource: { nativeId: nativeGuid },
    }]));
    const records = await observeGroups(scope, [
      { packageIds: ["b"], resource: { nativeId: nativeGuid }, inputId: first.id },
      { packageIds: ["a"], inputId: first.id },
    ]);
    const split = await reconcile(scope, records);
    expect(new Set(split.map(record => record.id)).size).toBe(2);
    expect(split.filter(record => record.id === first.id)).toHaveLength(1);
    expect(split[0].displayName).toBe(split[1].displayName);
    expect((await reconcile(scope, [...records].reverse())).map(record => record.id)).toEqual([...split].reverse().map(record => record.id));
    expect((await registryRows(scope)).agents).toHaveLength(2);
  });

  it("retains both prior UUIDs when a merge and split occur in the same complete view", async () => {
    const scope = newScope();
    const first = await reconcile(scope, await observeGroups(scope, [{ packageIds: ["a", "b"] }, { packageIds: ["c"] }]));
    const next = await reconcile(scope, await observeGroups(scope, [{ packageIds: ["a", "c"] }, { packageIds: ["b"] }]));
    expect(next.map(record => record.id).sort()).toEqual(first.map(record => record.id).sort());
    expect(next[1].id).toBe(first[0].id);
    expect((await registryRows(scope)).sources).toHaveLength(3);
  });

  it("atomically swaps PP memberships while enforcing at most one PP agent per canonical entity", async () => {
    const scope = newScope();
    const first = await reconcile(scope, await observeGroups(scope, [
      { packageIds: ["a"], resource: { nativeId: "Native-A" } },
      { packageIds: ["b"], resource: { nativeId: "Native-B" } },
    ]));
    const swapped = await reconcile(scope, await observeGroups(scope, [
      { packageIds: ["a"], resource: { nativeId: "Native-B" } },
      { packageIds: ["b"], resource: { nativeId: "Native-A" } },
    ]));
    expect(swapped.map(record => record.id)).toEqual(first.map(record => record.id));
    await expect(fixture.runtime.query(`UPDATE unified_agent_sources SET agent_id=$3
      WHERE tenant_id=$1 AND principal_id=$2 AND native_id='Native-A'`,
    [scope.tenantId, scope.principalId, canonicalId(swapped[0])])).rejects.toMatchObject({ code: "23505", constraint: "unified_agent_one_power_platform" });
    expect((await registryRows(scope)).sources.filter(source => source.source === "power_platform")
      .map(source => source.agent_id).sort()).toEqual(swapped.map(canonicalId).sort());
  });

  it("removes absent complete-view memberships and scoped orphans, including an empty view", async () => {
    const scope = newScope();
    const other = { ...scope, principalId: "other-principal" };
    await reconcile(other, await observeGroups(other, [{ packageIds: ["a", "b"], resource: { nativeId: nativeGuid } }]));
    const otherSaved = await registryRows(other);
    const [first] = await reconcile(scope, await observeGroups(scope, [{ packageIds: ["a", "b"], resource: { nativeId: nativeGuid } }]));
    const [withoutPackage] = await reconcile(scope, await observeGroups(scope, [{ packageIds: ["a"], resource: { nativeId: nativeGuid } }]));
    expect(withoutPackage.id).toBe(first.id);
    expect((await registryRows(scope)).sources).toHaveLength(2);
    const [withoutPP] = await reconcile(scope, await observeGroups(scope, [{ packageIds: ["a"] }]));
    expect(withoutPP.id).toBe(first.id);
    expect((await registryRows(scope)).sources).toHaveLength(1);
    expect(await reconcile(scope, [])).toEqual([]);
    expect(await registryRows(scope)).toEqual({ agents: [], sources: [] });
    expect(await registryRows(other)).toEqual(otherSaved);
  });

  it("requires observed nonempty rows, rejects duplicates, and rolls back invalid exact-resource provenance", async () => {
    const scope = newScope();
    const records = await observeGroups(scope, [{ packageIds: ["a"] }]);
    await reconcile(scope, records);
    const before = await registryRows(scope);
    const record = records[0];
    for (const invalid of [
      [record, { ...record, id: "another-input" }],
      [{ ...record, packages: [record.packages[0], record.packages[0]] }],
      [{ ...record, packages: [] }],
      [{ ...record, observations: { ...record.observations, packageSnapshots: {} } }],
      [{ ...record, observations: { ...record.observations, packageSnapshots: {
        a: { ...record.observations.packageSnapshots.a, snapshotId: randomUUID() },
      } } }],
      [{ ...record, identity: { ...record.identity, packageEvidence: [{ packageId: "unknown", evidence: [evidence] }] } }],
    ]) {
      await expect(reconcile(scope, invalid)).rejects.toMatchObject({ code: "saved_source_invalid" });
      expect(await registryRows(scope)).toEqual(before);
    }
    const invented = {
      ...record, packages: [{ ...record.packages[0], id: "not-in-the-observed-snapshot" }],
      observations: { ...record.observations, packageSnapshots: { "not-in-the-observed-snapshot": record.observations.packageSnapshots.a } },
    };
    await expect(reconcile(scope, [invented])).rejects.toMatchObject({ code: "23503" });
    expect(await registryRows(scope)).toEqual(before);
    await observeGroups(scope, [{ packageIds: ["a"] }]);
    await expect(reconcile(scope, records)).rejects.toMatchObject({ code: "saved_source_invalid" });
  });

  it("requires each source observation even when the other source is present", async () => {
    const scope = newScope();
    const [record] = await observeGroups(scope, [{ packageIds: ["package"], resource: { nativeId: nativeGuid } }]);
    await reconcile(scope, [record]);
    const before = await registryRows(scope);
    const invalidObservations: UnifiedAgentRecord["observations"][] = [
      { ...record.observations, packageSnapshots: {} },
      { ...record.observations, powerPlatform: null },
      { ...record.observations, powerPlatform: { ...record.observations.powerPlatform!, snapshotId: randomUUID() } },
    ];
    for (const observations of invalidObservations) {
      await expect(reconcile(scope, [{ ...record, observations }])).rejects.toMatchObject({ code: "saved_source_invalid" });
      expect(await registryRows(scope)).toEqual(before);
    }
  });

  it("enforces tenant, principal, exact snapshot and canonical membership scopes with runtime least privilege", async () => {
    const scope = newScope();
    const scopes = [scope, { ...scope, principalId: "another-principal" }, { ...scope, tenantId: "another-tenant" }];
    const observed = await Promise.all(scopes.map(value => observeGroups(value, [{ packageIds: ["same"], resource: { nativeId: nativeGuid } }])));
    const canonical = await Promise.all(scopes.map((value, index) => reconcile(value, observed[index])));
    expect(new Set(canonical.map(value => value[0].id)).size).toBe(3);
    const before = await registryRows(scope);
    await expect(reconcile(scope, [{
      ...observed[0][0], powerPlatformResource: { ...observed[0][0].powerPlatformResource!, tenantId: scopes[2].tenantId },
    }])).rejects.toMatchObject({ status: 403, code: "scope_mismatch" });
    await expect(reconcile(scope, observed[1])).rejects.toMatchObject({ code: "saved_source_invalid" });
    await expect(fixture.runtime.query(`UPDATE unified_agent_sources SET agent_id=$3 WHERE tenant_id=$1 AND principal_id=$2`,
      [scope.tenantId, scope.principalId, canonicalId(canonical[1][0])])).rejects.toMatchObject({ code: "23503" });
    await expect(fixture.runtime.query(`UPDATE unified_agent_sources SET package_snapshot_id=$3
      WHERE tenant_id=$1 AND principal_id=$2 AND source='graph_packages'`,
    [scope.tenantId, scope.principalId, observed[1][0].observations.packageSnapshots.same.snapshotId])).rejects.toMatchObject({ code: "23503" });
    for (const sql of [
      "UPDATE unified_agents SET tenant_id='forbidden'",
      "UPDATE unified_agents SET created_at=clock_timestamp()",
      "UPDATE unified_agent_sources SET principal_id='forbidden'",
      "UPDATE unified_agent_sources SET source='graph_packages'",
      "DELETE FROM package_inventory_snapshots",
      "SELECT clear_admitted_unified_agent_registry()",
      "SELECT lock_unified_agent_publication('forbidden','forbidden','graph_packages')",
      "SELECT * FROM unified_agent_package_publication_targets('forbidden','forbidden')",
      "SELECT unified_agent_power_platform_publication_snapshot('forbidden','forbidden')",
      "SELECT prepare_unified_agent_source_publication()",
      "SELECT advance_unified_agent_package_sources()",
      "SELECT advance_unified_agent_power_platform_sources()",
    ]) await expect(fixture.runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
    expect(await registryRows(scope)).toEqual(before);
    expect((await reconcile(scope, [{ ...observed[0][0], id: canonical[1][0].id }]))[0].id).toBe(canonical[0][0].id);
  });

  it("rejects normalized PP GUID variants in both reconciliation and the unique database index", async () => {
    const scope = newScope();
    const [original] = await observeGroups(scope, [
      { packageIds: [], resource: { nativeId: nativeGuid, environmentId: "environment" } },
    ]);
    const [first] = await reconcile(scope, [original]);
    const [variant] = await observeGroups(scope, [
      { packageIds: [], resource: { nativeId: nativeGuid.toUpperCase(), environmentId: "ENVIRONMENT" } },
    ]);
    const before = await registryRows(scope);
    expect(before.sources[0]).toMatchObject({ agent_id: canonicalId(first), native_id: nativeGuid.toUpperCase() });
    await expect(reconcile(scope, [original, variant])).rejects.toMatchObject({ code: "saved_source_invalid" });
    expect(await registryRows(scope)).toEqual(before);
    const otherId = randomUUID();
    await fixture.runtime.query("INSERT INTO unified_agents(id,tenant_id,principal_id) VALUES($1,$2,$3)", [otherId, scope.tenantId, scope.principalId]);
    await expect(fixture.runtime.query(`INSERT INTO unified_agent_sources(
      tenant_id,principal_id,agent_id,source,environment_id,native_id,power_platform_snapshot_id)
      VALUES($1,$2,$3,'power_platform','environment',$4,$5)`,
    [scope.tenantId, scope.principalId, otherId, nativeGuid, original.observations.powerPlatform!.snapshotId]))
      .rejects.toMatchObject({ code: "23505", constraint: "unified_agent_sources_normalized_identity" });
    await expect(fixture.runtime.query(`INSERT INTO unified_agent_sources(
      tenant_id,principal_id,agent_id,source,environment_id,native_id)
      VALUES($1,$2,$3,'graph_packages','','missing-observation')`, [scope.tenantId, scope.principalId, otherId]))
      .rejects.toMatchObject({ code: "23514", constraint: "unified_agent_source_observation" });
    expect((await reconcile(scope, [variant]))[0].id).toBe(first.id);
    expect((await registryRows(scope)).agents).toHaveLength(1);
  });

  it("enforces normalized PP identities per snapshot and resource type without folding opaque IDs", async () => {
    const scope = newScope();
    const [record] = await observeGroups(scope, [
      { packageIds: [], resource: { nativeId: nativeGuid, environmentId: "environment" } },
    ]);
    const snapshot = record.observations.powerPlatform!.snapshotId;
    const copy = (nativeId: string, environmentId: string, resourceType = "microsoft.copilotstudio/agents") =>
      fixture.runtime.query(`INSERT INTO power_platform_inventory_resources(
          snapshot_id,tenant_id,principal_id,native_id,resource_type,environment_id,source_system,creator_type,
          agent_kind,lifecycle,identity_confidence,identifiers,provenance,details,unknown_field_count)
        SELECT snapshot_id,tenant_id,principal_id,$2,$3,$4,source_system,creator_type,agent_kind,lifecycle,identity_confidence,
          jsonb_build_array(jsonb_build_object('kind','power_platform_resource_id','value',$2::text)),provenance,details,unknown_field_count
        FROM power_platform_inventory_resources
        WHERE snapshot_id=$1 AND resource_type='microsoft.copilotstudio/agents' AND native_id=$5 AND environment_id='environment'`,
      [snapshot, nativeId, resourceType, environmentId, nativeGuid]);
    for (const [nativeId, environmentId] of [
      [nativeGuid.toUpperCase(), "environment"],
      [nativeGuid, "ENVIRONMENT"],
      [nativeGuid.toUpperCase(), "ENVIRONMENT"],
    ]) {
      await expect(copy(nativeId, environmentId)).rejects.toMatchObject({
        code: "23505", constraint: "power_platform_inventory_resources_normalized_identity",
      });
    }
    expect((await fixture.runtime.query(`SELECT native_id,environment_id FROM power_platform_inventory_resources WHERE snapshot_id=$1`, [snapshot])).rows)
      .toEqual([{ native_id: nativeGuid, environment_id: "environment" }]);
    await expect(copy(nativeGuid.toUpperCase(), "ENVIRONMENT", "microsoft.powerapps/canvasapps")).resolves.toMatchObject({ rowCount: 1 });
    await expect(copy(nativeGuid.toUpperCase(), "another-environment")).resolves.toMatchObject({ rowCount: 1 });
    for (const nativeId of ["Opaque", "opaque", `${nativeGuid}-suffix`, `${nativeGuid.toUpperCase()}-SUFFIX`]) {
      await expect(copy(nativeId, "environment")).resolves.toMatchObject({ rowCount: 1 });
    }
    const [refreshed] = await observeGroups(scope, [
      { packageIds: [], resource: { nativeId: nativeGuid.toUpperCase(), environmentId: "ENVIRONMENT" } },
    ]);
    expect(refreshed.observations.powerPlatform!.snapshotId).not.toBe(snapshot);
    expect(refreshed.powerPlatformResource!.nativeId).toBe(nativeGuid.toUpperCase());
  });

  it("never case-folds opaque Graph IDs, even GUID-shaped IDs, or opaque PP native IDs", async () => {
    const scope = newScope();
    const records = await observeGroups(scope, [
      { packageIds: [nativeGuid] }, { packageIds: [nativeGuid.toUpperCase()] },
      { packageIds: ["Opaque"] }, { packageIds: ["opaque"] },
      { packageIds: [], resource: { nativeId: "Opaque", environmentId: "ENV" } },
      { packageIds: [], resource: { nativeId: "opaque", environmentId: "env" } },
    ]);
    const result = await reconcile(scope, records);
    expect(new Set(result.map(record => record.id)).size).toBe(6);
    const saved = await registryRows(scope);
    expect(saved.sources).toHaveLength(6);
    expect(saved.sources.every(source => source.native_id === source.normalized_native_id)).toBe(true);
    expect((await reconcile(scope, [...records].reverse())).map(record => record.id)).toEqual([...result].reverse().map(record => record.id));
  });

  it("uses the database's environment case rules without changing raw provider targets", async () => {
    const scope = newScope();
    const environmentId = "\u0130";
    const records = await observeGroups(scope, [{ packageIds: [], resource: { nativeId: "Opaque", environmentId } }]);
    const [first] = await reconcile(scope, records);
    const before = await registryRows(scope);
    expect((await reconcile(scope, records))[0].id).toBe(first.id);
    expect(await registryRows(scope)).toEqual(before);
    const normalized = await fixture.runtime.query<{ value: string }>("SELECT lower($1::text) AS value", [environmentId]);
    const refreshed = await observeGroups(scope, [{ packageIds: [], resource: { nativeId: "Opaque", environmentId: normalized.rows[0].value } }]);
    const [next] = await reconcile(scope, refreshed);
    expect(next.id).toBe(first.id);
    expect(first.powerPlatformResource!.environmentId).toBe(environmentId);
    expect(next.powerPlatformResource!.environmentId).toBe(normalized.rows[0].value);
  });

  it.each(["retention", "deletion"])("retains unchanged UUIDs across old-snapshot %s before the next Agents read", async cleanupMode => {
    const scope = newScope();
    const initial: GroupInput[] = [
      { packageIds: ["graph-only"] },
      { packageIds: [], resource: { nativeId: nativeGuid, environmentId: "environment" } },
      { packageIds: ["merged-a", "merged-b", "merged-removed"], resource: { nativeId: "Merged", environmentId: "environment" } },
      { packageIds: ["removed-graph"] },
      { packageIds: [], resource: { nativeId: "Removed", environmentId: "environment" } },
    ];
    const first = await reconcile(scope, await publishGroups(scope, initial));
    const replacement = await publishGroups(scope, [
      initial[0],
      { packageIds: [], resource: { nativeId: nativeGuid.toUpperCase(), environmentId: "ENVIRONMENT" } },
      { ...initial[2], packageIds: ["merged-b", "merged-a"] },
      { packageIds: ["brand-new"] },
    ]);
    if (cleanupMode === "deletion") {
      await fixture.operator.query("DELETE FROM package_inventory_snapshots WHERE tenant_id=$1 AND principal_id=$2 AND NOT is_current", [scope.tenantId, scope.principalId]);
      await fixture.operator.query("DELETE FROM power_platform_inventory_snapshots WHERE tenant_id=$1 AND principal_id=$2 AND NOT is_current", [scope.tenantId, scope.principalId]);
    }
    const cleanup = await retain(fixture.operator);
    if (cleanupMode === "retention") {
      expect(cleanup.affected.packageSnapshots).toBeGreaterThan(0);
      expect(cleanup.affected.powerPlatformSnapshots).toBeGreaterThan(0);
    }
    expect((await registryRows(scope)).agents.map(agent => `agent:${agent.id}`).sort()).toEqual(first.slice(0, 3).map(record => record.id).sort());
    expect((await registryRows(scope)).sources).toHaveLength(5);
    const next = await reconcile(scope, replacement);
    expect(next.slice(0, 3).map(record => record.id)).toEqual(first.slice(0, 3).map(record => record.id));
    expect(first.map(record => record.id)).not.toContain(next[3].id);
    expect((await registryRows(scope)).sources).toHaveLength(6);
  });

  it.each(["graph_packages", "power_platform"])("invalidates native proof on %s publication without inferring grouping", async source => {
    const scope = newScope();
    const group = { packageIds: ["proof-a", "proof-b"], resource: { nativeId: nativeGuid, environmentId: "environment" } };
    const [record] = await publishGroups(scope, [group]);
    record.identity.packageEvidence = group.packageIds.map(packageId => ({ packageId, evidence: [evidence] }));
    const [first] = await reconcile(scope, [record]);
    if (source === "graph_packages") {
      await publishPackageSnapshot(scope, [...groupSources(scope, [group]).packages.values()]);
    } else {
      await publishPowerPlatformSnapshot(scope, [nativeResource(scope, { nativeId: nativeGuid.toUpperCase(), environmentId: "ENVIRONMENT" })]);
    }
    await retain(fixture.operator);
    const saved = await registryRows(scope);
    expect(saved.agents.map(agent => agent.id)).toEqual([canonicalId(first)]);
    expect(saved.sources).toHaveLength(3);
    expect(saved.sources.every(member => member.matching_evidence.length === 0)).toBe(true);
    const splitRecords = await publishGroups(scope, [{ packageIds: group.packageIds }, { packageIds: [], resource: group.resource }]);
    expect((await registryRows(scope)).agents).toHaveLength(1);
    const split = await reconcile(scope, splitRecords);
    expect(new Set(split.map(value => value.id)).size).toBe(2);
    expect(split.filter(value => value.id === first.id)).toHaveLength(1);
  });

  it("clears PP-dependent proof on an empty publication without renewing removed PP targets", async () => {
    const scope = newScope();
    const [record] = await publishGroups(scope, [{ packageIds: ["package"], resource: { nativeId: nativeGuid } }]);
    record.identity.packageEvidence = [{ packageId: "package", evidence: [evidence] }];
    const [first] = await reconcile(scope, [record]);
    await publishPowerPlatformSnapshot(scope, []);
    expect((await registryRows(scope)).sources.find(member => member.source === "graph_packages"))
      .toMatchObject({ matching_evidence: [] });
    await retain(fixture.operator);
    expect((await registryRows(scope)).sources).toMatchObject([{ source: "graph_packages", agent_id: canonicalId(first) }]);
    const graphOnly: UnifiedAgentRecord = {
      ...record, presence: "graph_packages", powerPlatformResource: null,
      identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
      observations: { ...record.observations, powerPlatform: null },
    };
    expect((await reconcile(scope, [graphOnly]))[0].id).toBe(first.id);
  });

  it("does not promote application Graph data, ignored scoped PP data, or another principal's publication", async () => {
    const scope = newScope();
    const group = { packageIds: ["private-package"], resource: { nativeId: nativeGuid, environmentId: "environment" } };
    const [record] = await publishGroups(scope, [group]);
    record.identity.packageEvidence = [{ packageId: "private-package", evidence: [evidence] }];
    await reconcile(scope, [record]);
    const before = await registryRows(scope);
    await publishPackageSnapshot(scope, [...groupSources(scope, [group]).packages.values()], { tokenMode: "application" });
    await publishPowerPlatformSnapshot(scope, [nativeResource(scope, group.resource)], {
      requestedTypes: ["microsoft.copilotstudio/agents"], environmentScope: "environment",
    });
    for (const other of [{ ...scope, principalId: "other-principal" }, { ...scope, tenantId: "other-tenant" }]) {
      await reconcile(other, await publishGroups(other, [group]));
      await publishGroups(other, [group]);
    }
    expect(await registryRows(scope)).toEqual(before);
    await reconcile(scope, [record]);
    expect(await registryRows(scope)).toEqual(before);
  });

  it("advances only effective delegated exact observations and honors later broad observations", async () => {
    const scope = newScope();
    const groups = [{ packageIds: ["exact-target"] }, { packageIds: ["broad-target"] }];
    const records = await publishGroups(scope, groups);
    const first = await reconcile(scope, records);
    const { packages } = groupSources(scope, groups);
    const exact = await publishPackageSnapshot(scope, [packages.get("exact-target")!], {
      tokenMode: "delegated", requestedIds: ["exact-target"],
    });
    expect((await registryRows(scope)).sources.find(member => member.native_id === "exact-target"))
      .toMatchObject({ package_snapshot_id: exact.id });
    expect((await registryRows(scope)).sources.find(member => member.native_id === "broad-target"))
      .toMatchObject({ package_snapshot_id: records[1].observations.packageSnapshots["broad-target"].snapshotId });
    const broad = await publishPackageSnapshot(scope, [...packages.values()]);
    await fixture.operator.query("DELETE FROM package_inventory_snapshots WHERE tenant_id=$1 AND principal_id=$2 AND id<>$3",
      [scope.tenantId, scope.principalId, broad.id]);
    await retain(fixture.operator);
    expect((await registryRows(scope)).agents.map(agent => `agent:${agent.id}`).sort()).toEqual(first.map(record => record.id).sort());
    expect((await registryRows(scope)).sources.every(member => member.package_snapshot_id === broad.id)).toBe(true);
    await publishPackageSnapshot(scope, [], { tokenMode: "delegated", requestedIds: ["exact-target"] });
    expect((await new PackageInventoryRepository(fixture.runtime).readUnifiedSource(scope)).packages.map(value => value.id)).toEqual(["broad-target"]);
    expect((await registryRows(scope)).sources.find(member => member.native_id === "exact-target"))
      .toMatchObject({ package_snapshot_id: broad.id });
  });

  it("does not preserve identities for case-changed opaque Graph or PP targets", async () => {
    const scope = newScope();
    const first = await reconcile(scope, await publishGroups(scope, [
      { packageIds: [nativeGuid] }, { packageIds: [], resource: { nativeId: "Opaque", environmentId: "environment" } },
    ]));
    const nextRecords = await publishGroups(scope, [
      { packageIds: [nativeGuid.toUpperCase()] }, { packageIds: [], resource: { nativeId: "opaque", environmentId: "ENVIRONMENT" } },
    ]);
    await retain(fixture.operator);
    expect(await registryRows(scope)).toEqual({ agents: [], sources: [] });
    const next = await reconcile(scope, nextRecords);
    expect(next.every(record => !first.some(old => old.id === record.id))).toBe(true);
  });

  it("does not renew a Graph membership from an exact overlay the source reader does not select", async () => {
    const scope = newScope();
    const [record] = await publishGroups(scope, [{ packageIds: ["same-millisecond"] }]);
    await reconcile(scope, [record]);
    const original = record.observations.packageSnapshots["same-millisecond"].snapshotId;
    const stamp = (await fixture.operator.query<{ value: Date }>("SELECT date_trunc('milliseconds',clock_timestamp())+interval '1 second' AS value")).rows[0].value;
    const broadId = `ffffffff-${randomUUID().slice(9)}`;
    const exactId = `eeeeeeee-${randomUUID().slice(9)}`;
    const insert = async (id: string, exact: boolean) => {
      await fixture.runtime.query(`INSERT INTO package_inventory_snapshots(
        id,tenant_id,principal_id,token_mode,query_hash,scope_kind,requested_ids,observed_count,total_records,page_count,observed_at)
        VALUES($1,$2,$3,'delegated',$4,$5,$6::jsonb,1,1,1,$7::timestamptz+CASE WHEN $8 THEN interval '900 microseconds' ELSE interval '100 microseconds' END)`,
      [id, scope.tenantId, scope.principalId, (exact ? "d" : "c").repeat(64), exact ? "exact" : "broad",
        JSON.stringify(exact ? ["same-millisecond"] : []), stamp, exact]);
      await fixture.runtime.query(`INSERT INTO package_inventory_resources(
        snapshot_id,tenant_id,principal_id,native_id,display_name,is_blocked,identifiers,package_data)
        SELECT $1,tenant_id,principal_id,native_id,display_name,is_blocked,identifiers,package_data
        FROM package_inventory_resources WHERE snapshot_id=$2`, [id, original]);
    };
    await insert(broadId, false);
    const before = await registryRows(scope);
    await insert(exactId, true);
    expect((await new PackageInventoryRepository(fixture.runtime).readUnifiedSource(scope)).observations["same-millisecond"].snapshotId).toBe(broadId);
    expect(await registryRows(scope)).toEqual(before);
  });

  it("rolls back publication handoff and cleared evidence when later publication work fails", async () => {
    const scope = newScope();
    const group = { packageIds: ["rollback-publication-package"], resource: { nativeId: nativeGuid } };
    const [record] = await publishGroups(scope, [group]);
    record.identity.packageEvidence = [{ packageId: group.packageIds[0], evidence: [evidence] }];
    await reconcile(scope, [record]);
    const before = await registryRows(scope);
    await fixture.operator.query(`
      CREATE FUNCTION fail_after_registry_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM unified_agent_sources member JOIN package_inventory_snapshots snapshot
            ON snapshot.id=member.package_snapshot_id
          WHERE member.native_id='rollback-publication-package' AND snapshot.is_current)
        THEN RAISE EXCEPTION 'publication handoff was missing before injected failure'; END IF;
        RAISE EXCEPTION 'publication failed after registry handoff';
      END $$;
      CREATE TRIGGER zz_fail_after_registry_handoff AFTER INSERT ON source_identifiers
        FOR EACH STATEMENT EXECUTE FUNCTION fail_after_registry_handoff();
    `);
    try {
      await expect(publishPackageSnapshot(scope, [...groupSources(scope, [group]).packages.values()]))
        .rejects.toThrow("publication failed after registry handoff");
      expect(await registryRows(scope)).toEqual(before);
      expect((await new PackageInventoryRepository(fixture.runtime).readUnifiedSource(scope)).snapshot?.id)
        .toBe(record.observations.packageSnapshots[group.packageIds[0]].snapshotId);
    } finally {
      await fixture.operator.query("DROP TRIGGER zz_fail_after_registry_handoff ON source_identifiers; DROP FUNCTION fail_after_registry_handoff()");
    }
  });

  it("does not acquire the package advisory lock from a PP publication", async () => {
    const scope = newScope();
    const [record] = await publishGroups(scope, [{ packageIds: ["package"], resource: { nativeId: nativeGuid } }]);
    const [first] = await reconcile(scope, [record]);
    const holder = await fixture.runtime.connect();
    let pending: Promise<SnapshotRow> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`package-refresh:${scope.tenantId}:${scope.principalId}`]);
      let settled = false;
      pending = publishPowerPlatformSnapshot(scope, [nativeResource(scope, { nativeId: nativeGuid.toUpperCase() })]);
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await vi.waitFor(() => { expect(settled).toBe(true); }, { timeout: 3_000, interval: 20 });
      const snapshot = await pending;
      expect((await registryRows(scope)).sources.find(member => member.source === "power_platform"))
        .toMatchObject({ agent_id: canonicalId(first), power_platform_snapshot_id: snapshot.id, native_id: nativeGuid.toUpperCase() });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      if (pending) await Promise.allSettled([pending]);
    }
  });

  it("serializes simultaneous Graph and PP handoffs without reversing the existing source locks", async () => {
    const scope = newScope();
    const group = { packageIds: ["package"], resource: { nativeId: nativeGuid } };
    const [record] = await publishGroups(scope, [group]);
    const [first] = await reconcile(scope, [record]);
    const holder = await fixture.runtime.connect();
    let pending: Promise<SnapshotRow[]> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`unified-agent-publication:${scope.tenantId}:${scope.principalId}`]);
      const held = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      pending = Promise.all([
        publishPackageSnapshot(scope, [...groupSources(scope, [group]).packages.values()]),
        publishPowerPlatformSnapshot(scope, [nativeResource(scope, { nativeId: nativeGuid.toUpperCase() })]),
      ]);
      const outcome = Promise.allSettled([pending]);
      await vi.waitFor(async () => {
        const waiting = await fixture.operator.query<{ count: number }>(`SELECT count(*)::int AS count
          FROM pg_locks waiting JOIN pg_locks held
            ON waiting.locktype=held.locktype AND waiting.database=held.database
              AND waiting.classid=held.classid AND waiting.objid=held.objid AND waiting.objsubid=held.objsubid
          WHERE held.pid=$1 AND held.locktype='advisory' AND held.granted AND NOT waiting.granted`, [held.rows[0].pid]);
        expect(waiting.rows[0].count).toBe(2);
      }, { timeout: 3_000, interval: 20 });
      await holder.query("COMMIT");
      const [result] = await outcome;
      if (result.status === "rejected") throw result.reason;
      const [packages, pp] = result.value;
      await retain(fixture.operator);
      const saved = await registryRows(scope);
      expect(saved.agents.map(agent => agent.id)).toEqual([canonicalId(first)]);
      expect(saved.sources).toMatchObject([
        { source: "graph_packages", package_snapshot_id: packages.id },
        { source: "power_platform", power_platform_snapshot_id: pp.id },
      ]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      if (pending) await Promise.allSettled([pending]);
    }
  });

  it("cascades deleted source snapshots and lets bounded retention remove only orphan entities", async () => {
    const scope = newScope();
    const other = { ...scope, principalId: "retained-principal" };
    await reconcile(other, await observeGroups(other, [{ packageIds: ["same"], resource: { nativeId: nativeGuid } }]));
    const otherSaved = await registryRows(other);
    await reconcile(scope, await observeGroups(scope, [
      { packageIds: ["a"], resource: { nativeId: nativeGuid } }, { packageIds: ["b"] },
    ]));
    await fixture.operator.query("DELETE FROM power_platform_inventory_snapshots WHERE tenant_id=$1 AND principal_id=$2", [scope.tenantId, scope.principalId]);
    expect((await registryRows(scope)).sources).toHaveLength(2);
    await fixture.operator.query("DELETE FROM package_inventory_snapshots WHERE tenant_id=$1 AND principal_id=$2", [scope.tenantId, scope.principalId]);
    expect((await registryRows(scope)).sources).toHaveLength(0);
    expect((await registryRows(scope)).agents).toHaveLength(2);
    expect((await retain(fixture.operator, { batchSize: 1, dryRun: true })).affected.unifiedAgentOrphans).toBe(1);
    expect((await registryRows(scope)).agents).toHaveLength(2);
    expect((await retain(fixture.operator, { batchSize: 1 })).affected.unifiedAgentOrphans).toBe(1);
    expect((await registryRows(scope)).agents).toHaveLength(1);
    expect((await retain(fixture.operator, { batchSize: 1 })).affected.unifiedAgentOrphans).toBe(1);
    expect(await registryRows(scope)).toEqual({ agents: [], sources: [] });
    expect(await registryRows(other)).toEqual(otherSaved);
  });

  it("clears only the admitted clean-resync scope and never reuses an invalidated canonical UUID", async () => {
    const scope = newScope();
    const other = { ...scope, principalId: "other-principal" };
    const otherTenant = { ...scope, tenantId: "other-tenant" };
    const group = { packageIds: ["same"], resource: { nativeId: nativeGuid } };
    const [first] = await reconcile(scope, await observeGroups(scope, [group]));
    for (const value of [other, otherTenant]) await reconcile(value, await observeGroups(value, [group]));
    const others = await Promise.all([registryRows(other), registryRows(otherTenant)]);
    const sync = new DataSyncRepository(fixture.runtime);
    await sync.submit(other, { mode: "full", clearSavedData: false });
    expect(await registryRows(other)).toEqual(others[0]);
    const cleared = await sync.submit(scope, { mode: "full", clearSavedData: true });
    expect(cleared.created).toBe(true);
    expect(await registryRows(scope)).toEqual({ agents: [], sources: [] });
    expect(await Promise.all([registryRows(other), registryRows(otherTenant)])).toEqual(others);
    const [resynced] = await reconcile(scope, await observeGroups(scope, [group]));
    expect(resynced.id).not.toBe(first.id);
    const after = await registryRows(scope);
    expect(await sync.submit(scope, { mode: "full", clearSavedData: true })).toMatchObject({ created: false, run: { id: cleared.run.id } });
    expect(await registryRows(scope)).toEqual(after);
  });

  it("acquires package then PP transaction locks before work and rolls back work failures", async () => {
    const scope = newScope();
    const holder = await fixture.runtime.connect();
    let pending: Promise<unknown> | undefined;
    let entered = false;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`package-refresh:${scope.tenantId}:${scope.principalId}`]);
      const held = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      pending = registry.withSnapshot(scope, async client => {
        entered = true;
        const locks = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_locks
          WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted`);
        expect(locks.rows[0].count).toBe(2);
        await client.query("INSERT INTO unified_agents(id,tenant_id,principal_id) VALUES($1,$2,$3)", [randomUUID(), scope.tenantId, scope.principalId]);
        throw new Error("rollback registry work");
      });
      const rejection = expect(pending).rejects.toThrow("rollback registry work");
      await vi.waitFor(async () => {
        const waiting = await fixture.operator.query<{ other_locks: number }>(`SELECT (
            SELECT count(*)::int FROM pg_locks acquired
            WHERE acquired.pid=waiting.pid AND acquired.locktype='advisory' AND acquired.granted
          ) AS other_locks
          FROM pg_locks waiting JOIN pg_locks held
            ON waiting.locktype=held.locktype AND waiting.database=held.database
              AND waiting.classid=held.classid AND waiting.objid=held.objid AND waiting.objsubid=held.objsubid
          WHERE held.pid=$1 AND held.locktype='advisory' AND held.granted AND NOT waiting.granted`, [held.rows[0].pid]);
        expect(waiting.rows).toEqual([{ other_locks: 0 }]);
      }, { timeout: 3_000, interval: 20 });
      expect(entered).toBe(false);
      await holder.query("COMMIT");
      await rejection;
      expect(entered).toBe(true);
      expect(await registryRows(scope)).toEqual({ agents: [], sources: [] });
      await expect(registry.reconcile(holder, scope, [])).rejects.toMatchObject({ code: "unified_agent_snapshot_required" });
      await expect(registry.withSnapshot(scope, client => registry.reconcile(client, { ...scope, principalId: "wrong" }, [])))
        .rejects.toMatchObject({ code: "unified_agent_snapshot_required" });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      if (pending) await Promise.allSettled([pending]);
    }
  });

  it.each([1_000, 5_000])("reconciles %i memberships in bounded batches without rewriting unchanged rows", async count => {
    const scope = newScope();
    const records = await observeGroups(scope, Array.from({ length: count }, (_, index) => ({
      packageIds: [`package-${String(index).padStart(5, "0")}`],
    })));
    let queryCount = 0;
    const started = performance.now();
    const first = await registry.withSnapshot(scope, async client => {
      const spy = vi.spyOn(client, "query");
      try {
        return await registry.reconcile(client, scope, records);
      } finally {
        queryCount = spy.mock.calls.length;
        spy.mockRestore();
      }
    });
    expect(queryCount).toBeLessThanOrEqual(7 + Math.ceil(count / 1_000));
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(new Set(first.map(record => record.id)).size).toBe(count);
    const before = await fingerprint(scope);
    const readStarted = performance.now();
    expect((await reconcile(scope, [...records].reverse())).map(record => record.id)).toEqual([...first].reverse().map(record => record.id));
    expect(performance.now() - readStarted).toBeLessThan(15_000);
    expect(await fingerprint(scope)).toEqual(before);
    expect(before.map(row => row.count)).toEqual([count, count]);
    if (count === 5_000) {
      await expect(reconcile(scope, [...records, {
        ...records[0], packages: [{ ...records[0].packages[0], id: "above-source-bound" }],
        observations: { ...records[0].observations, packageSnapshots: { "above-source-bound": records[0].observations.packageSnapshots["package-00000"] } },
      }])).rejects.toMatchObject({ code: "saved_source_invalid" });
      expect(await fingerprint(scope)).toEqual(before);
    }
    const publicationStarted = performance.now();
    const refreshed = await publishPackageSnapshot(scope, records.map(record => allowlistedPackage(record.packages[0])));
    expect(performance.now() - publicationStarted).toBeLessThan(15_000);
    await fixture.operator.query("DELETE FROM package_inventory_snapshots WHERE id=$1", [records[0].observations.packageSnapshots["package-00000"].snapshotId]);
    await retain(fixture.operator);
    const published = await registryRows(scope);
    expect(published.agents.map(agent => `agent:${agent.id}`).sort()).toEqual(first.map(record => record.id).sort());
    expect(published.sources.every(member => member.package_snapshot_id === refreshed.id)).toBe(true);
  }, 30_000);

  it("rolls back earlier batches when a later exact-resource FK fails", async () => {
    const scope = newScope();
    const records = await observeGroups(scope, Array.from({ length: 1_000 }, (_, index) => ({ packageIds: [`a-${String(index).padStart(4, "0")}`] })));
    await reconcile(scope, records);
    const before = await fingerprint(scope);
    const changed = { ...records[0], identity: {
      ...records[0].identity, packageEvidence: [{ packageId: records[0].packages[0].id, evidence: [evidence] }],
    } };
    const invalid = {
      ...records[0], id: "invalid-late-record", packages: [{ ...records[0].packages[0], id: "z-missing-resource" }],
      observations: { ...records[0].observations, packageSnapshots: { "z-missing-resource": records[0].observations.packageSnapshots["a-0000"] } },
    };
    await expect(reconcile(scope, [changed, ...records.slice(1), invalid])).rejects.toMatchObject({ code: "23503" });
    expect(await fingerprint(scope)).toEqual(before);
  }, 30_000);
});

type GroupInput = {
  packageIds: string[];
  resource?: { nativeId: string; environmentId?: string | null };
  inputId?: string;
};
type SnapshotRow = { id: string; observed_at: Date; expires_at: Date };

async function observeGroups(scope: UnifiedAgentRegistryScope, groups: GroupInput[], database: pg.Pool = fixture.runtime, legacyCoverage = false): Promise<UnifiedAgentRecord[]> {
  const { packages, resources } = groupSources(scope, groups);
  await database.query("UPDATE package_inventory_snapshots SET is_current=false WHERE tenant_id=$1 AND principal_id=$2 AND is_current", [scope.tenantId, scope.principalId]);
  const packageSnapshot = (await database.query<SnapshotRow>(`INSERT INTO package_inventory_snapshots(
      id,tenant_id,principal_id,token_mode,query_hash,scope_kind,requested_ids,observed_count,total_records,page_count)
    VALUES($1,$2,$3,'delegated',$4,'broad','[]',$5,$5,1) RETURNING id,observed_at,expires_at`,
  [randomUUID(), scope.tenantId, scope.principalId, "a".repeat(64), packages.size])).rows[0];
  if (packages.size) {
    await database.query(`INSERT INTO package_inventory_resources(
        snapshot_id,tenant_id,principal_id,native_id,display_name,is_blocked,identifiers,package_data)
      SELECT $1,$2,$3,value.id,value.display_name,value.is_blocked,
        jsonb_build_array(jsonb_build_object('kind','package_id','value',value.id)),value.package_data
      FROM jsonb_to_recordset($4::jsonb) AS value(id text,display_name text,is_blocked boolean,package_data jsonb)`,
    [packageSnapshot.id, scope.tenantId, scope.principalId, JSON.stringify([...packages.values()].map(value => ({
      id: value.id, display_name: value.displayName, is_blocked: value.isBlocked, package_data: value,
    })))]);
  }
  await database.query("UPDATE power_platform_inventory_snapshots SET is_current=false WHERE tenant_id=$1 AND principal_id=$2 AND is_current", [scope.tenantId, scope.principalId]);
  const powerPlatformSnapshot = (await database.query<SnapshotRow>(`INSERT INTO power_platform_inventory_snapshots(
      id,tenant_id,principal_id,query_hash,role_scope,requested_types,${legacyCoverage ? "coverage" : "queried_types"},observed_count,total_records,page_count,unknown_field_count)
    VALUES($1,$2,$3,$4,'full',$5::jsonb,$6::jsonb,$7,$7,1,0) RETURNING id,observed_at,expires_at`,
  [randomUUID(), scope.tenantId, scope.principalId, "b".repeat(64), JSON.stringify(powerPlatformResourceTypes),
    JSON.stringify(legacyCoverage ? powerPlatformResourceTypes.map(type => ({ type, status: "covered", count: type === "microsoft.copilotstudio/agents" ? resources.size : 0 })) : powerPlatformResourceTypes), resources.size])).rows[0];
  if (resources.size) {
    await database.query(`INSERT INTO power_platform_inventory_resources(
        snapshot_id,tenant_id,principal_id,native_id,resource_type,environment_id,display_name,source_system,
        creator_type,agent_kind,lifecycle,identity_confidence,identifiers,provenance,details,unknown_field_count)
      SELECT $1,$2,$3,value.native_id,'microsoft.copilotstudio/agents',value.environment_id,'Private provider agent',
        'power_platform','unknown','agent','published','exact_native',
        jsonb_build_array(jsonb_build_object('kind','power_platform_resource_id','value',value.native_id)),
        '{}'::jsonb,'{"description":"Private provider payload"}'::jsonb,0
      FROM jsonb_to_recordset($4::jsonb) AS value(native_id text,environment_id text)`,
    [powerPlatformSnapshot.id, scope.tenantId, scope.principalId, JSON.stringify([...resources.values()].map(value => ({
      native_id: value.nativeId, environment_id: value.environmentId ?? "",
    })))]);
  }
  return observedGroups(groups, packages, resources, packageSnapshot, powerPlatformSnapshot);
}

function groupResourceKey(resource: NonNullable<GroupInput["resource"]>) {
  return JSON.stringify([resource.environmentId ?? "", resource.nativeId]);
}

function groupSources(scope: UnifiedAgentRegistryScope, groups: GroupInput[]) {
  const packages = new Map(groups.flatMap(group => group.packageIds.map(id => [
    id, allowlistedPackage({ id, displayName: "Private provider package", publisher: "Private provider publisher", isBlocked: id.endsWith("b") }),
  ] as const)));
  const resources = new Map(groups.flatMap(group => group.resource ? [[groupResourceKey(group.resource), nativeResource(scope, group.resource)] as const] : []));
  return { packages, resources };
}

async function publishPackageSnapshot(
  scope: UnifiedAgentRegistryScope,
  values: ReturnType<typeof allowlistedPackage>[],
  options: Pick<PackageRefreshInput, "tokenMode" | "requestedIds"> = { tokenMode: "delegated" },
) {
  const repository = new PackageInventoryRepository(fixture.runtime);
  const job = await repository.submit(scope, { authorizationPrincipalId: scope.principalId, idempotencyKey: randomUUID(), ...options });
  await repository.markRunning(scope, job.id);
  const result = await repository.publish(scope, job.id, { packages: values, totalRecords: values.length, pages: 1 });
  return (await fixture.runtime.query<SnapshotRow>("SELECT id,observed_at,expires_at FROM package_inventory_snapshots WHERE id=$1", [result.snapshotId])).rows[0];
}

async function publishPowerPlatformSnapshot(
  scope: UnifiedAgentRegistryScope,
  values: PowerPlatformResource[],
  options: Partial<Pick<InventoryRefreshInput, "roleScope" | "requestedTypes" | "environmentScope">> = {},
) {
  const repository = new PowerPlatformInventoryRepository(fixture.runtime);
  const job = await repository.submit(scope, { idempotencyKey: randomUUID(), roleScope: "full", requestedTypes: powerPlatformResourceTypes, ...options });
  await repository.markRunning(scope, job.id);
  const result = await repository.publish(scope, job.id, {
    resources: values, queriedTypes: inventoryQueryTypes(job.roleScope, job.requestedTypes),
    environmentScope: job.environmentScope, totalRecords: values.length, pages: 1, unknownFieldCount: 0,
  });
  return (await fixture.runtime.query<SnapshotRow>("SELECT id,observed_at,expires_at FROM power_platform_inventory_snapshots WHERE id=$1", [result.snapshotId])).rows[0];
}

async function publishGroups(scope: UnifiedAgentRegistryScope, groups: GroupInput[]) {
  const { packages, resources } = groupSources(scope, groups);
  const packageSnapshot = await publishPackageSnapshot(scope, [...packages.values()]);
  const powerPlatformSnapshot = await publishPowerPlatformSnapshot(scope, [...resources.values()]);
  return observedGroups(groups, packages, resources, packageSnapshot, powerPlatformSnapshot);
}

function observedGroups(
  groups: GroupInput[],
  packages: Map<string, ReturnType<typeof allowlistedPackage>>,
  resources: Map<string, PowerPlatformResource>,
  packageSnapshot: SnapshotRow,
  powerPlatformSnapshot: SnapshotRow,
): UnifiedAgentRecord[] {
  const observation = (snapshot: SnapshotRow) => ({
    id: snapshot.id, snapshotId: snapshot.id, observedAt: snapshot.observed_at.toISOString(), expiresAt: snapshot.expires_at.toISOString(), current: true as const,
  });
  return groups.map((group, index) => ({
    id: group.inputId ?? `untrusted-input-${index}`, displayName: "Identical row display name",
    presence: group.resource ? group.packageIds.length ? "both" : "power_platform" : "graph_packages",
    environmentId: group.resource?.environmentId ?? null,
    packages: group.packageIds.map(id => packages.get(id)!),
    powerPlatformResource: group.resource ? resources.get(groupResourceKey(group.resource))! : null,
    identity: { state: group.resource && group.packageIds.length ? "matched" : "unmatched", evidence: [], packageEvidence: [], reason: null },
    observations: {
      graphPackages: group.packageIds.length ? {
        ...observation(packageSnapshot), tokenMode: "delegated", scopeKind: "broad", observedCount: packages.size, totalRecords: packages.size,
      } : null,
      packageSnapshots: Object.fromEntries(group.packageIds.map(id => [id, { ...observation(packageSnapshot), scopeKind: "broad", identityDetails: null }])),
      powerPlatform: group.resource ? {
        ...observation(powerPlatformSnapshot), roleScope: "full", environmentScope: null, coverage: "covered",
        coveredCount: resources.size, observedCount: resources.size, totalRecords: resources.size, pageCount: 1,
        verification: {
          status: "verified", scope: "authorized_query", basis: "provider_total_and_saved_rows",
          checkedAt: powerPlatformSnapshot.observed_at.toISOString(), storedCount: resources.size,
          uniqueIdentityCount: resources.size, queriedTypes: [...powerPlatformResourceTypes],
        },
      } : null,
    },
  }));
}

function nativeResource(scope: UnifiedAgentRegistryScope, input: NonNullable<GroupInput["resource"]>): PowerPlatformResource {
  return {
    tenantId: scope.tenantId, nativeId: input.nativeId, type: "microsoft.copilotstudio/agents", environmentId: input.environmentId ?? null,
    location: null, displayName: "Private provider agent", createdAt: null, createdBy: null, lastPublishedAt: null,
    sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown", agentKind: "agent",
    lifecycle: "published", identityConfidence: "exact_native",
    identifiers: [{ kind: "power_platform_resource_id", value: input.nativeId }],
    provenance: {}, details: { description: "Private provider payload" }, unknownFieldCount: 0,
  };
}

function reconcile(scope: UnifiedAgentRegistryScope, records: UnifiedAgentRecord[], target = registry) {
  return target.withSnapshot(scope, client => target.reconcile(client, scope, records));
}

function appendAuditEvent(database: pg.Pool, scope: UnifiedAgentRegistryScope, action: string, blockedState: boolean | null) {
  return database.query(`INSERT INTO audit_events(
      id,event_id,operation_id,tenant_id,principal_id,actor_username,actor_name,scope,action,target_blocked_state,
      agent_id,started_at,status,request_path)
    VALUES(gen_random_uuid(),gen_random_uuid()::text,gen_random_uuid()::text,$1,$2,'fixture@example.invalid',
      'Fixture','bulk',$3,$4,'fixture',clock_timestamp(),'succeeded','/fixture')`,
  [scope.tenantId, scope.principalId, action, blockedState]);
}

async function registryRows(scope: UnifiedAgentRegistryScope) {
  const [agents, sources] = await Promise.all([
    fixture.runtime.query("SELECT *,xmin::text AS row_version FROM unified_agents WHERE tenant_id=$1 AND principal_id=$2 ORDER BY id", [scope.tenantId, scope.principalId]),
    fixture.runtime.query<{
      agent_id: string; source: string; native_id: string; normalized_native_id: string;
      package_snapshot_id: string | null; power_platform_snapshot_id: string | null; matching_evidence: UnifiedAgentLinkEvidence[];
    }>("SELECT *,xmin::text AS row_version FROM unified_agent_sources WHERE tenant_id=$1 AND principal_id=$2 ORDER BY source,environment_id,native_id", [scope.tenantId, scope.principalId]),
  ]);
  return { agents: agents.rows, sources: sources.rows };
}

async function fingerprint(scope: UnifiedAgentRegistryScope) {
  return (await fixture.runtime.query<{ count: number; digest: string }>(`SELECT count(*)::int AS count,
      md5(string_agg(id::text||':'||xmin::text||':'||updated_at::text,',' ORDER BY id)) AS digest
    FROM unified_agents WHERE tenant_id=$1 AND principal_id=$2
    UNION ALL SELECT count(*)::int,md5(string_agg(source||':'||environment_id||':'||native_id||':'||xmin::text||':'||updated_at::text,','
      ORDER BY source,environment_id,native_id))
    FROM unified_agent_sources WHERE tenant_id=$1 AND principal_id=$2`, [scope.tenantId, scope.principalId])).rows;
}
