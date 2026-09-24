import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrap, grantRuntime, migrate, retain } from "../../scripts/database.js";
import { fixturePassword, testDatabase } from "../../scripts/testDatabase.js";
import { AgentIdentityRepository, type AgentIdentitySource } from "./agentIdentity.js";
import { DataSyncRepository } from "./dataSync.js";
import { saveUsageInventory } from "./agentUsageTestSupport.js";
import { migrations, verifySchema } from "./schema.js";
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

async function saved(tenantId = randomUUID(), database = fixture) {
  const scope = { tenantId, principalId: randomUUID() };
  const [record] = await saveUsageInventory(database.runtime, scope, [{ packages: [], native: { nativeId: "native-agent", environmentId: "environment-a" } }]);
  await database.operator.query(`UPDATE power_platform_inventory_resources SET agent_kind='copilot_studio_agent',
    identifiers=$3::jsonb,provenance=$4::jsonb WHERE tenant_id=$1 AND principal_id=$2`,
  [scope.tenantId, scope.principalId, JSON.stringify([{ kind: "entra_agent_id", value: objectId }]),
    JSON.stringify({ entraAgentId: { sourceSystem: "power_platform", path: "properties.entraAgentId", maturity: "ga" } })]);
  const source: AgentIdentitySource = { recordId: record.id, snapshotId: record.observations.powerPlatform!.snapshotId!,
    nativeId: "native-agent", environmentId: "environment-a", candidateId: objectId, sourceRevision: "a".repeat(64) };
  return { scope, source };
}

describe("source-bound agent identity cache (isolated PostgreSQL)", () => {
  it("upgrades only verified typed mappings from schema 42 without extending TTL or promoting failed candidates", async () => {
    const upgrade = await testDatabase(false);
    try {
      await bootstrap(upgrade.operator, fixturePassword);
      await migrate(upgrade.operator, migrations.filter(value => value.version <= 42));
      await grantRuntime(upgrade.operator);
      const f = await saved(randomUUID(), upgrade);
      const inventoryOnly = await saved(f.scope.tenantId, upgrade);
      const failed = await saved(f.scope.tenantId, upgrade);
      for (const [target, oldAppId, outcome, runtimeStatus, errorCode] of [
        [f, otherId, "resolved", "available", null],
        [inventoryOnly, null, "resolved", "missing", null],
        [failed, null, "authorization_required", "unverified", "missing_permission"],
      ] as const) {
        await upgrade.runtime.query(`INSERT INTO agent_identity_cache
          (tenant_id,principal_id,record_id,snapshot_id,native_id,environment_id,source_revision,candidate_id,application_id,checked_at,expires_at,
            outcome,runtime_status,last_error_code)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,statement_timestamp(),statement_timestamp()+interval '1 hour',$10,$11,$12)`,
        [target.scope.tenantId, target.scope.principalId, target.source.recordId, target.source.snapshotId, target.source.nativeId,
          target.source.environmentId, target.source.sourceRevision, objectId, oldAppId, outcome, runtimeStatus, errorCode]);
      }
      const checksums = (await upgrade.operator.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows;
      const dates = (await upgrade.runtime.query("SELECT record_id,checked_at,expires_at FROM agent_identity_cache ORDER BY record_id")).rows;
      await migrate(upgrade.operator);
      await grantRuntime(upgrade.operator);
      await verifySchema(upgrade.runtime);
      expect((await upgrade.operator.query("SELECT version,checksum FROM schema_migrations WHERE version<=42 ORDER BY version")).rows).toEqual(checksums);
      const upgraded = new AgentIdentityRepository(upgrade.runtime);
      expect(await upgraded.read(f.scope, f.source)).toMatchObject(mapping);
      expect(await upgraded.read(inventoryOnly.scope, inventoryOnly.source)).toMatchObject(mapping);
      expect(await upgraded.read(failed.scope, failed.source)).toBeNull();
      expect(await upgraded.readState(failed.scope, failed.source)).toMatchObject({ status: "authorization_required", lastErrorCode: "missing_permission" });
      expect((await upgrade.runtime.query("SELECT record_id,checked_at,expires_at FROM agent_identity_cache ORDER BY record_id")).rows).toEqual(dates);
      await expect(upgrade.runtime.query("ALTER TABLE agent_identity_cache ADD COLUMN forbidden text")).rejects.toThrow("must be owner");
      await expect(upgrade.runtime.query("TRUNCATE agent_identity_cache")).rejects.toThrow("permission denied");
    } finally { await upgrade.close(); }
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
      has_any_column_privilege(current_user,'power_platform_inventory_resources','UPDATE') AS resource_update,
      has_table_privilege(current_user,'power_platform_inventory_resources','DELETE') AS resource_delete,
      has_table_privilege(current_user,'power_platform_inventory_snapshots','UPDATE') AS snapshot_update`)).rows[0];
    expect(privileges).toEqual({ resource_update: false, resource_delete: false, snapshot_update: true });
    await expect(fixture.runtime.query(`UPDATE power_platform_inventory_resources
      SET native_id='forged',identifiers='[]'::jsonb,provenance='{}'::jsonb WHERE snapshot_id=$1`, [f.source.snapshotId]))
      .rejects.toMatchObject({ code: "42501" });
    await expect(fixture.runtime.query("DELETE FROM power_platform_inventory_resources WHERE snapshot_id=$1", [f.source.snapshotId]))
      .rejects.toMatchObject({ code: "42501" });
    await repository.save(f.scope, f.source, mapping, fence);
    expect(await repository.read(f.scope, f.source)).toMatchObject(mapping);
  });

  it("holds snapshot and clear-data locks through the final authorization fence without locking resource rows", async () => {
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
      await expect(competing.query("UPDATE power_platform_inventory_snapshots SET is_current=false WHERE id=$1", [f.source.snapshotId]))
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
    await fixture.operator.query("UPDATE power_platform_inventory_snapshots SET expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1", [f.source.snapshotId]);
    await repository.save(f.scope, f.source, mapping, fence);
    const shorter = (await repository.read(f.scope, f.source))!;
    expect(Date.parse(shorter.expiresAt) - Date.parse(shorter.checkedAt)).toBeLessThanOrEqual(600_000);
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
    await fixture.operator.query(`UPDATE power_platform_inventory_resources SET identifiers=$2::jsonb WHERE snapshot_id=$1`,
      [f.source.snapshotId, JSON.stringify([{ kind: "entra_agent_id", value: otherId }])]);
    expect(await repository.read(f.scope, f.source)).toBeNull();
    await expect(repository.save(f.scope, f.source, mapping, fence)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
    await fixture.operator.query(`UPDATE power_platform_inventory_resources SET identifiers=$2::jsonb WHERE snapshot_id=$1`,
      [f.source.snapshotId, JSON.stringify([{ kind: "entra_agent_id", value: objectId }])]);
    await fixture.operator.query(`UPDATE power_platform_inventory_resources SET provenance='{}' WHERE snapshot_id=$1`, [f.source.snapshotId]);
    expect(await repository.read(f.scope, f.source)).toBeNull();
    await expect(repository.save(f.scope, f.source, mapping, fence)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
    const current = await saved();
    await repository.save(current.scope, current.source, mapping, fence);
    await fixture.operator.query("UPDATE power_platform_inventory_snapshots SET is_current=false WHERE id=$1", [current.source.snapshotId]);
    expect(await repository.read(current.scope, current.source)).toBeNull();
    await expect(repository.save(current.scope, current.source, mapping, fence)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
    for (const value of [{ ...mapping, objectId: otherId }, { ...mapping, applicationId: otherId },
      { ...mapping, applicationId: "00000000-0000-0000-0000-000000000000" }]) {
      await expect(repository.save(current.scope, current.source, value, fence)).rejects.toMatchObject({ code: "agent_identity_mismatch" });
    }
  });

  it("clears only the admitted account, prevents stale republishing and cascades source deletion", async () => {
    const f = await saved();
    const other = await saved(f.scope.tenantId);
    await repository.save(f.scope, f.source, mapping, fence);
    await repository.save(other.scope, other.source, mapping, fence);
    await new DataSyncRepository(fixture.runtime).submit(f.scope, { mode: "full", clearSavedData: true });
    expect(await repository.read(f.scope, f.source)).toBeNull();
    await expect(repository.save(f.scope, f.source, mapping, fence)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
    expect(await repository.read(other.scope, other.source)).not.toBeNull();
    await fixture.operator.query("DELETE FROM power_platform_inventory_snapshots WHERE id=$1", [other.source.snapshotId]);
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM agent_identity_cache WHERE tenant_id=$1", [f.scope.tenantId])).rows[0].count).toBe(0);
  });

  it("rolls back publication when its last authorization fence fails", async () => {
    const f = await saved();
    const guarded = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("session changed"));
    await expect(repository.save(f.scope, f.source, mapping, guarded)).rejects.toThrow("session changed");
    expect(await repository.read(f.scope, f.source)).toBeNull();
  });

  it("enforces exact 1,000-account/10,000-tenant entry limits and permits in-place refresh at capacity", async () => {
    const f = await saved();
    await repository.save(f.scope, f.source, mapping, fence);
    const seed = async (scope: typeof f.scope, source: AgentIdentitySource, count: number) => {
      await fixture.operator.query(`INSERT INTO agent_identity_cache
        (tenant_id,principal_id,record_id,snapshot_id,native_id,environment_id,source_revision,candidate_id,application_id,checked_at,expires_at,runtime_status,runtime_provenance)
        SELECT $1,$2,'agent:'||gen_random_uuid()::text,$3,$4,$5,$6,$7,$8,statement_timestamp(),statement_timestamp()+interval '1 hour','available',
          'verified-entra-agent-identity-client-id'
        FROM generate_series(1,$9::int)`, [scope.tenantId, scope.principalId, source.snapshotId, source.nativeId,
        source.environmentId, source.sourceRevision, objectId, applicationId, count]);
    };
    await seed(f.scope, f.source, 999);
    await repository.save(f.scope, f.source, mapping, fence);
    await expect(repository.save(f.scope, { ...f.source, recordId: `agent:${randomUUID()}` }, mapping, fence))
      .rejects.toMatchObject({ code: "agent_identity_cache_limit" });
    const other = await saved(f.scope.tenantId);
    await seed(other.scope, other.source, 9_000);
    const third = await saved(f.scope.tenantId);
    await expect(repository.save(third.scope, third.source, mapping, fence)).rejects.toMatchObject({ code: "agent_identity_cache_limit" });
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM agent_identity_cache WHERE tenant_id=$1", [f.scope.tenantId])).rows[0].count).toBe(10_000);
  });
});
