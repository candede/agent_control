import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { retain } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { AgentIdentityRepository, type AgentIdentitySource } from "./agentIdentity.js";
import { DataSyncRepository } from "./dataSync.js";
import { inventoryInput, nativeInventoryFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { LiveInventory } from "./liveInventory.js";
import { InventoryGenerations, inventorySelector } from "./inventoryGenerations.js";
import { powerPlatformInventoryRecord } from "../services/inventoryRecordProjection.js";
import { InventoryRuntime } from "../services/inventoryRuntime.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { verifiedAgentIdentityClientIdProvenance, type VerifiedAgentIdentityIds } from "../types/agentInvestigations.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: AgentIdentityRepository;
const objectId = "11111111-1111-4111-8111-111111111111";
const applicationId = objectId;
const otherId = "22222222-2222-4222-8222-222222222222";
const mapping: VerifiedAgentIdentityIds = { objectId, applicationId, runtimeStatus: "available",
  runtimeProvenance: verifiedAgentIdentityClientIdProvenance };
const fence = async () => {};

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new AgentIdentityRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });

function identityResource(tenantId: string, nativeId = "native-agent", candidateId = objectId): PowerPlatformResource {
  return { sourceSystem: "power_platform", tenantId, nativeId, type: "microsoft.copilotstudio/agents",
    environmentId: "environment-a", displayName: nativeId, location: null, createdAt: null, createdBy: null,
    lastPublishedAt: null, authoringTool: null, creatorType: "unknown", agentKind: "copilot_studio_agent",
    lifecycle: "published", identityConfidence: "exact_native", details: {}, unknownFieldCount: 0,
    identifiers: [{ kind: "entra_agent_id", value: candidateId }],
    provenance: { entraAgentId: { sourceSystem: "power_platform", path: "properties.entraAgentId", maturity: "ga" } } };
}
async function saved(tenantId = randomUUID(), options: { expiresAt?: Date } = {}) {
  const scope = { tenantId, principalId: randomUUID() };
  await nativeInventoryFixture(fixture.runtime, scope, [identityResource(tenantId)], options);
  await reconcileInventoryFixture(fixture.runtime, scope);
  const record = await new LiveInventory(fixture.runtime).record(scope,
    unifiedAgentRecordId({ source: "power_platform", nativeId: "native-agent", environmentId: "environment-a" }));
  const source: AgentIdentitySource = { recordId: record.id, snapshotId: record.native!.observation.snapshotId,
    nativeId: "native-agent", environmentId: "environment-a", candidateId: objectId, sourceRevision: record.revision };
  return { scope, source };
}
async function capacitySource(tenantId: string, count: number) {
  const scope = { tenantId, principalId: randomUUID() };
  const input = inventoryInput(scope.principalId, "power_platform");
  input.scope.tenantId = tenantId;
  const intent = { domain: "power_platform" as const, mode: "baseline" as const, channel: "catalog" as const,
    resourceTypes: ["microsoft.copilotstudio/agents" as const], roleScope: "full" as const };
  input.scope.selector = inventorySelector(intent);
  const store = new InventoryGenerations(fixture.runtime);
  await store.execute(input, intent, async lease => {
    for (let offset = 0; offset < count; offset += 100) {
      const records = Array.from({ length: Math.min(100, count - offset) }, (_, index) =>
        powerPlatformInventoryRecord(identityResource(tenantId, `capacity-${String(offset + index).padStart(5, "0")}`, randomUUID())));
      await store.visit(lease, String(offset));
      await store.appendBounded(lease, records);
      await store.acceptPage(lease, { token: String(offset), nextToken: offset + 100 < count ? String(offset + 100) : null,
        records, rawCount: records.length, expectedCount: count, page: offset / 100 + 1 }, records.length);
    }
  }, { authorize: async () => {} });
  const runtime = new InventoryRuntime(fixture.runtime, async () => {});
  const canonical = inventoryInput(scope.principalId, "canonical");
  canonical.scope.tenantId = tenantId;
  canonical.reserveBytes = input.reserveBytes;
  expect(await runtime.enqueue(scope)).not.toBeNull();
  await runtime.reconciliation.runNext(canonical, async () => {});
  const target = async (index: number) => {
    const nativeId = `capacity-${String(index).padStart(5, "0")}`;
    const record = await new LiveInventory(fixture.runtime).record(scope,
      unifiedAgentRecordId({ source: "power_platform", nativeId, environmentId: "environment-a" }));
    const candidateId = record.native!.identifiers.find(value => value.kind === "entra_agent_id")!.value;
    return { source: { recordId: record.id, snapshotId: record.native!.observation.snapshotId,
      nativeId, environmentId: "environment-a", candidateId, sourceRevision: record.revision },
    mapping: { ...mapping, objectId: candidateId, applicationId: candidateId } };
  };
  const seed = async (amount: number, start = 0) => {
    let after = start ? `capacity-${String(start - 1).padStart(5, "0")}` : "";
    for (let offset = 0; offset < amount; offset += 100) {
      const rows = (await fixture.operator.query(`INSERT INTO agent_identity_cache
        (tenant_id,principal_id,record_id,snapshot_id,native_id,environment_id,source_revision,candidate_id,
          application_id,checked_at,expires_at,runtime_status,runtime_provenance)
        SELECT source.tenant_id,source.principal_id,'agent:'||source.agent_id,source.source_generation_id,
          source.native_id,source.environment_id,$3,identifier.value::uuid,identifier.value::uuid,
          statement_timestamp(),statement_timestamp()+interval '1 hour','available','verified-entra-agent-identity-client-id'
        FROM inventory_live_sources source JOIN inventory_facts identifier
          ON identifier.generation_id=source.source_generation_id AND identifier.identity=source.source_identity
          AND identifier.kind='identifier' AND identifier.payload->>'kind'='entra_agent_id'
        WHERE source.tenant_id=$1 AND source.principal_id=$2 AND source.source='power_platform'
          AND source.native_id COLLATE "C">$4
        ORDER BY source.native_id COLLATE "C" LIMIT $5 RETURNING native_id`,
      [tenantId, scope.principalId, "a".repeat(64), after, Math.min(100, amount - offset)])).rows;
      expect(rows).toHaveLength(Math.min(100, amount - offset));
      after = rows.at(-1)!.native_id;
    }
  };
  return { scope, target, seed };
}

describe("source-bound agent identity cache (isolated PostgreSQL)", () => {
  it("denies runtime schema changes and unrestricted cache truncation", async () => {
    await expect(fixture.runtime.query("ALTER TABLE agent_identity_cache ADD COLUMN forbidden text")).rejects.toThrow("must be owner");
    await expect(fixture.runtime.query("TRUNCATE agent_identity_cache")).rejects.toThrow("permission denied");
  });

  it("persists the verified child object/client identity and isolates every source/account binding", async () => {
    const f = await saved();
    await repository.save(f.scope, f.source, mapping, fence);
    expect(await repository.read(f.scope, f.source)).toMatchObject(mapping);
    expect(await repository.read({ ...f.scope, principalId: randomUUID() }, f.source)).toBeNull();
    expect(await repository.read({ ...f.scope, tenantId: randomUUID() }, f.source)).toBeNull();
    for (const change of [{ recordId: `agent:${randomUUID()}` }, { snapshotId: randomUUID() }, { nativeId: "different" },
      { environmentId: "other" }, { candidateId: otherId }, { sourceRevision: "b".repeat(64) }]) {
      expect(await repository.read(f.scope, { ...f.source, ...change })).toBeNull();
    }
    await repository.invalidate({ ...f.scope, principalId: randomUUID() }, f.source);
    expect(await repository.read(f.scope, f.source)).not.toBeNull();
    await repository.invalidate(f.scope, f.source);
    expect(await repository.read(f.scope, f.source)).toBeNull();
  });

  it("publishes with runtime grants while forbidding source identity and provenance mutations", async () => {
    const f = await saved();
    const privileges = (await fixture.runtime.query(`SELECT
      has_any_column_privilege(current_user,'inventory_records','UPDATE') AS resource_update,
      has_table_privilege(current_user,'inventory_records','DELETE') AS resource_delete`)).rows[0];
    expect(privileges).toEqual({ resource_update: false, resource_delete: false });
    await expect(fixture.runtime.query(`UPDATE power_platform_record_rows
      SET native_id='forged',residual='{}'::jsonb WHERE generation_id=$1`, [f.source.snapshotId]))
      .rejects.toMatchObject({ code: "42501" });
    await expect(fixture.runtime.query("DELETE FROM power_platform_record_rows WHERE generation_id=$1", [f.source.snapshotId]))
      .rejects.toThrow("inventory_content_pinned");
    await repository.save(f.scope, f.source, mapping, fence);
    expect(await repository.read(f.scope, f.source)).toMatchObject(mapping);
  });

  it("holds current source and clear-data locks through the final authorization fence", async () => {
    const f = await saved();
    const competing = await fixture.runtime.connect();
    let resume!: () => void;
    const held = new Promise<void>(resolve => { resume = resolve; });
    const guarded = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => held);
    const publication = Promise.allSettled([repository.save(f.scope, f.source, mapping, guarded)]);
    try {
      await vi.waitFor(() => expect(guarded).toHaveBeenCalledTimes(2));
      await competing.query("BEGIN");
      const lock = await competing.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired`,
        [`data-sync:${f.scope.tenantId}:${f.scope.principalId}`]);
      expect(lock.rows[0].acquired).toBe(false);
      await competing.query("SET LOCAL lock_timeout='100ms'");
      await expect(competing.query(`SELECT scope.id FROM data_scope_epochs scope
        JOIN data_generations generation ON generation.scope_id=scope.id
        WHERE generation.id=$1 FOR UPDATE OF scope`, [f.source.snapshotId]))
        .rejects.toMatchObject({ code: "55P03" });
    } finally {
      resume();
      try { await competing.query("ROLLBACK"); }
      finally { competing.release(); await publication; }
    }
    expect(await publication).toEqual([{ status: "fulfilled", value: undefined }]);
    expect(await repository.read(f.scope, f.source)).toMatchObject(mapping);
    await new DataSyncRepository(fixture.runtime).submit(f.scope, { mode: "full", clearSavedData: true });
    expect(await repository.read(f.scope, f.source)).toBeNull();
    await expect(repository.save(f.scope, f.source, mapping, fence)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
  });

  it("enforces typed client-ID provenance in the database rather than accepting arbitrary application IDs", async () => {
    const f = await saved();
    await repository.save(f.scope, f.source, mapping, fence);
    await expect(fixture.runtime.query(`UPDATE agent_identity_cache SET application_id=$3
      WHERE tenant_id=$1 AND principal_id=$2`, [f.scope.tenantId, f.scope.principalId, otherId]))
      .rejects.toThrow("agent_identity_cache_client_id_provenance");
    await expect(fixture.runtime.query(`UPDATE agent_identity_cache SET runtime_provenance=NULL
      WHERE tenant_id=$1 AND principal_id=$2`, [f.scope.tenantId, f.scope.principalId]))
      .rejects.toThrow("agent_identity_cache_client_id_provenance");
    expect(await repository.read(f.scope, f.source)).toMatchObject(mapping);
  });

  it("persists bounded source-scoped failure outcomes without ever returning candidate IDs as verified", async () => {
    const f = await saved();
    for (const status of ["authorization_required", "not_found", "provider_error", "setup_required"] as const) {
      await repository.save(f.scope, f.source, mapping, fence);
      await repository.saveFailure(f.scope, f.source, { status, code: "fixture_error" }, fence);
      const result = await repository.readState(f.scope, f.source);
      expect(result).toMatchObject({ status, lastErrorCode: "fixture_error" });
      expect(result.value).toBeUndefined();
      expect(await repository.read(f.scope, f.source)).toBeNull();
      expect(Date.parse(result.expiresAt!) - Date.parse(result.checkedAt!)).toBe(300_000);
      expect(await repository.readState({ ...f.scope, principalId: randomUUID() }, f.source)).toEqual({ status: "missing" });
      expect(await repository.readState(f.scope, { ...f.source, sourceRevision: "b".repeat(64) })).toEqual({ status: "missing" });
    }
    await repository.save(f.scope, f.source, mapping, fence);
    const resolved = await repository.readState(f.scope, f.source);
    expect(resolved.status).toBe("resolved");
    expect(resolved.lastErrorCode).toBeUndefined();
    expect(resolved.value).toMatchObject(mapping);
  });

  it("bounds TTL to one hour and current source expiry and excludes expired mappings before retention", async () => {
    const f = await saved();
    await repository.save(f.scope, f.source, mapping, fence);
    const value = (await repository.read(f.scope, f.source))!;
    expect(Date.parse(value.expiresAt) - Date.parse(value.checkedAt)).toBe(3_600_000);
    const short = await saved(randomUUID(), { expiresAt: new Date(Date.now() + 600_000) });
    await repository.save(short.scope, short.source, mapping, fence);
    const shorter = (await repository.read(short.scope, short.source))!;
    expect(Date.parse(shorter.expiresAt) - Date.parse(shorter.checkedAt)).toBeLessThanOrEqual(600_000);
    const authority = (await fixture.runtime.query(`SELECT authority_expires_at FROM inventory_live_sources
      WHERE tenant_id=$1 AND principal_id=$2 LIMIT 1`, [short.scope.tenantId, short.scope.principalId])).rows[0];
    expect(Date.parse(shorter.expiresAt)).toBe(authority.authority_expires_at.getTime());
    await fixture.operator.query(`UPDATE agent_identity_cache SET checked_at=clock_timestamp()-interval '1 hour',
      expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1`, [f.scope.tenantId]);
    expect(await repository.read(f.scope, f.source)).toBeNull();
    expect(await repository.readState(f.scope, f.source)).toMatchObject({ status: "expired" });
    await retain(fixture.operator);
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM agent_identity_cache WHERE tenant_id=$1", [f.scope.tenantId])).rows[0].count).toBe(0);
  });

  it("rejects source refreshes, candidate/provenance changes and all-zero IDs", async () => {
    const f = await saved();
    await repository.save(f.scope, f.source, mapping, fence);
    await nativeInventoryFixture(fixture.runtime, f.scope, [identityResource(f.scope.tenantId, "native-agent", otherId)]);
    await reconcileInventoryFixture(fixture.runtime, f.scope);
    expect(await repository.read(f.scope, f.source)).toBeNull();
    await expect(repository.save(f.scope, f.source, mapping, fence)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
    const changed = await new LiveInventory(fixture.runtime).record(f.scope, f.source.recordId);
    await expect(repository.save(f.scope, { ...f.source, snapshotId: changed.native!.observation.snapshotId,
      sourceRevision: changed.revision }, mapping, fence)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
    await nativeInventoryFixture(fixture.runtime, f.scope, [{ ...identityResource(f.scope.tenantId), provenance: {} }]);
    await reconcileInventoryFixture(fixture.runtime, f.scope);
    expect(await repository.read(f.scope, f.source)).toBeNull();
    await expect(repository.save(f.scope, f.source, mapping, fence)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
    const unproved = await new LiveInventory(fixture.runtime).record(f.scope, f.source.recordId);
    await expect(repository.save(f.scope, { ...f.source, snapshotId: unproved.native!.observation.snapshotId,
      sourceRevision: unproved.revision }, mapping, fence)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
    const current = await saved();
    await repository.save(current.scope, current.source, mapping, fence);
    await nativeInventoryFixture(fixture.runtime, current.scope, [identityResource(current.scope.tenantId)]);
    await reconcileInventoryFixture(fixture.runtime, current.scope);
    expect(await repository.read(current.scope, current.source)).toBeNull();
    await expect(repository.save(current.scope, current.source, mapping, fence)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
    for (const value of [{ ...mapping, objectId: otherId }, { ...mapping, applicationId: otherId },
      { ...mapping, applicationId: "00000000-0000-0000-0000-000000000000" }]) {
      await expect(repository.save(current.scope, current.source, value, fence)).rejects.toMatchObject({ code: "agent_identity_mismatch" });
    }
  });

  it("clears only the admitted account, prevents stale republishing and binds source deletion by generation", async () => {
    const f = await saved();
    const other = await saved(f.scope.tenantId);
    await repository.save(f.scope, f.source, mapping, fence);
    await repository.save(other.scope, other.source, mapping, fence);
    await new DataSyncRepository(fixture.runtime).submit(f.scope, { mode: "full", clearSavedData: true });
    expect(await repository.read(f.scope, f.source)).toBeNull();
    await expect(repository.save(f.scope, f.source, mapping, fence)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
    expect(await repository.read(other.scope, other.source)).not.toBeNull();
    expect((await fixture.runtime.query(`SELECT confdeltype FROM pg_constraint
      WHERE conrelid='agent_identity_cache'::regclass AND conname='agent_identity_cache_generation'`)).rows).toEqual([{ confdeltype: "c" }]);
    await new DataSyncRepository(fixture.runtime).submit(other.scope, { mode: "full", clearSavedData: true });
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM agent_identity_cache WHERE tenant_id=$1", [f.scope.tenantId])).rows[0].count).toBe(0);
  });

  it("rolls back publication when its last authorization fence fails", async () => {
    const f = await saved();
    const guarded = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("session changed"));
    await expect(repository.save(f.scope, f.source, mapping, guarded)).rejects.toThrow("session changed");
    expect(await repository.read(f.scope, f.source)).toBeNull();
  });

});

describe("identity cache exact capacity with current typed sources", () => {
  const tenantId = randomUUID();
  let f: Awaited<ReturnType<typeof capacitySource>>;
  beforeAll(async () => { f = await capacitySource(tenantId, 1001); });
  it.each(Array.from({ length: 10 }, (_, index) => index))("seeds verified account batch %i without bypassing guards", async index => {
    await f.seed(100, index * 100);
    expect((await fixture.operator.query(`SELECT count(*)::int AS count FROM agent_identity_cache
      WHERE tenant_id=$1 AND principal_id=$2`, [tenantId, f.scope.principalId])).rows[0].count).toBe((index + 1) * 100);
  });
  it("rejects target 1,001 while permitting an exact in-place refresh at account capacity", async () => {
    const existing = await f.target(0), additional = await f.target(1000);
    await repository.save(f.scope, existing.source, existing.mapping, fence);
    expect(await repository.read(f.scope, existing.source)).toMatchObject(existing.mapping);
    await expect(repository.save(f.scope, additional.source, additional.mapping, fence))
      .rejects.toMatchObject({ code: "agent_identity_cache_limit" });
  });
  describe.each(Array.from({ length: 9 }, (_, index) => index))("additional account %i", index => {
    let other: Awaited<ReturnType<typeof capacitySource>>;
    beforeAll(async () => { other = await capacitySource(tenantId, 1000); });
    it.each(Array.from({ length: 10 }, (_, batch) => batch))("seeds source-proved batch %i without bypassing guards", async batch => {
      await other.seed(100, batch * 100);
      expect((await fixture.operator.query("SELECT count(*)::int AS count FROM agent_identity_cache WHERE tenant_id=$1",
        [tenantId])).rows[0].count).toBe((index + 1) * 1000 + (batch + 1) * 100);
    });
  });
  it("rejects an eleventh current account at the exact 10,000-tenant boundary", async () => {
    const third = await saved(tenantId);
    await expect(repository.save(third.scope, third.source, mapping, fence)).rejects.toMatchObject({ code: "agent_identity_cache_limit" });
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM agent_identity_cache WHERE tenant_id=$1", [tenantId])).rows[0].count).toBe(10_000);
  });
});
