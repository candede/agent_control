import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { retain } from "../../scripts/database.js";
import { generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { fixtureDirectoryUser } from "../../scripts/userSourceFixture.js";
import { AppError } from "../errors.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { OfficialReportExports } from "../services/officialReportExports.js";
import { usageAudit } from "./agentUsageTestSupport.js";
import { retainRecordData } from "./dataRetention.js";
import { UserSourceStages } from "./userSourceStages.js";
import { UserSourcesRepository } from "./userSources.js";
import { DataGenerations } from "./dataGenerations.js";

vi.hoisted(() => { process.env.SESSION_SECRET ??= "synthetic-record-retention-session-secret"; });
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); });
const identity = () => ({ ...selectionIdentity, tenantId: `retention-${randomUUID()}` });
const reader = () => new UserSourcesRepository(fixture.runtime, "synthetic-record-retention-cursor-secret");

async function publish(owner: ReturnType<typeof identity>, count: number, fail = false) {
  const stages = new UserSourceStages(fixture.runtime);
  return stages.execute(generationInput({ scope: { ...generationInput().scope,
    tenantId: owner.tenantId, principalId: owner.principalId } }), async lease => {
    const key = await stages.query(lease, "discovery", "synthetic:retention");
    await stages.page(lease, key, "synthetic:retention", count, count);
    for (let offset = 0; offset < count; offset += 250) {
      await stages.directory(lease, key, Array.from({ length: Math.min(250, count - offset) }, (_, index) =>
        fixtureDirectoryUser(randomUUID(), `User ${offset + index}`, `user${offset + index}@example.invalid`)));
    }
    await stages.finishQuery(lease, key);
    if (fail) throw new AppError(502, "provider_schema", "Synthetic partial attempt.");
  }, { beforePublish: async () => {} });
}
const collect = (limit = 250) => reader().connections.run(client => retainRecordData(client, limit));

describe("live bounded record retention", () => {
  it("skips a writer-held scope before locking its abandoned generation and budgets the derived charge update", async () => {
    const owner = identity(), generations = new DataGenerations(fixture.runtime);
    const lease = await generations.begin(generationInput({ scope: { ...generationInput().scope,
      tenantId: owner.tenantId, principalId: owner.principalId } }));
    await fixture.operator.query("UPDATE data_generations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [lease.id]);
    const held = await fixture.runtime.connect();
    try {
      await held.query("BEGIN");
      await held.query("SELECT id FROM data_scope_epochs WHERE id=$1 FOR UPDATE", [lease.scopeId]);
      expect((await collect()).recordAbandonedGenerations).toBe(0);
      expect((await held.query("SELECT state FROM data_generations WHERE id=$1 FOR UPDATE", [lease.id])).rows[0].state).toBe("staging");
    } finally { await held.query("ROLLBACK"); held.release(); }
    const before = (await fixture.runtime.query("SELECT rows_collected::int AS n FROM data_lifecycle_progress WHERE worker='records'")).rows[0].n;
    const collected = await collect();
    expect(collected).toMatchObject({ recordAbandonedGenerations: 1, recordDeletingGenerations: 1,
      recordCollectedGenerations: 1, recordGenerationMetadata: 1 });
    expect((await fixture.runtime.query("SELECT generation_bytes::text AS bytes FROM data_generation_charges WHERE scope_id=$1", [lease.scopeId])).rows[0].bytes).toBe("0");
    const after = (await fixture.runtime.query("SELECT rows_collected::int AS n FROM data_lifecycle_progress WHERE worker='records'")).rows[0].n;
    expect(after - before).toBe(6);
  });

  it("collects invalidated records in bounded slices and releases quota only after the last physical child", async () => {
    const owner = identity(), published = await publish(owner, 501);
    const generation = (await fixture.runtime.query("SELECT scope_id,byte_count FROM data_generations WHERE id=$1", [published.generationId])).rows[0];
    await new UserSourceStages(fixture.runtime).generations.invalidate(generation.scope_id, owner.tenantId);
    const dryRun = await retain(fixture.operator, { batchSize: 250, dryRun: true });
    expect(dryRun.affected.record_directory_user_rows).toBe(250);
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM directory_user_rows WHERE generation_id=$1", [published.generationId])).rows[0].n).toBe(501);
    const first = await collect();
    expect(first.record_directory_user_rows).toBe(250);
    expect((await fixture.runtime.query("SELECT collected_at FROM data_generations WHERE id=$1", [published.generationId])).rows[0].collected_at).toBeNull();
    await expect(fixture.runtime.query("UPDATE data_generations SET collected_at=clock_timestamp() WHERE id=$1", [published.generationId]))
      .rejects.toThrow("data_generation_not_collected");
    await collect(); await collect();
    const remaining = (await fixture.runtime.query("SELECT state,collected_at,byte_count FROM data_generations WHERE id=$1", [published.generationId])).rows[0];
    expect(remaining).toMatchObject({ state: "deleting", collected_at: expect.any(Date), byte_count: generation.byte_count });
    expect((await fixture.runtime.query(`SELECT coalesce(sum(byte_count) FILTER(WHERE collected_at IS NULL),0)::text AS bytes
      FROM data_generations WHERE tenant_id=$1`, [owner.tenantId])).rows[0].bytes).toBe("0");
    await expect(fixture.runtime.query("UPDATE data_generations SET collected_at=NULL WHERE id=$1", [published.generationId]))
      .rejects.toThrow("data_generation_collection_immutable");
    expect((await fixture.runtime.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1", [generation.scope_id])).rows[0].generation_id)
      .toBe(published.generationId);
  });

  it("preserves the latest failed-attempt metadata after collecting its unpublished records", async () => {
    const owner = identity();
    await publish(owner, 1);
    await expect(publish(owner, 1, true)).rejects.toMatchObject({ code: "provider_schema" });
    await collect();
    const sources = reader(), selected = await sources.capture(owner, "delegated");
    const page = await sources.page(selected.id, owner);
    expect(page.value).toHaveLength(1);
    expect(page.sources.directory).toMatchObject({ attemptStatus: "failed", state: "partial", rowCount: 1 });
    expect((await fixture.runtime.query(`SELECT a.status,g.collected_at FROM user_source_attempts a JOIN data_generations g
      ON g.id=a.generation_id WHERE a.tenant_id=$1 AND a.status='failed'`, [owner.tenantId])).rows[0])
      .toEqual({ status: "failed", collected_at: expect.any(Date) });
  });

  it("protects pinned generations and removes obsolete control rows only after selection invalidation", async () => {
    const owner = identity(), first = await publish(owner, 1), sources = reader();
    const selected = await sources.capture(owner, "delegated");
    await publish(owner, 1);
    await collect();
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM directory_user_rows WHERE generation_id=$1", [first.generationId])).rows[0].n).toBe(1);
    await fixture.runtime.query("UPDATE data_read_selections SET invalidated_at=clock_timestamp() WHERE id=$1", [selected.id]);
    await collect();
    expect((await fixture.runtime.query("SELECT id FROM data_generations WHERE id=$1", [first.generationId])).rows).toEqual([]);
    expect((await fixture.runtime.query("SELECT id FROM data_read_selections WHERE id=$1", [selected.id])).rows).toEqual([]);
  });

  it("expires queued exports with their real audit classification and purges explicit IDs in bounded batches", async () => {
    const owner = identity(), reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-retention-export-secret", 30);
    const selected = await reports.capture(owner, "delegated", "copilot_users");
    const producer = new OfficialReportExports(reports, usageAudit(owner).actor);
    const id = await producer.create(owner, { selectionId: selected.id, kind: "copilot_users",
      ids: Array.from({ length: 501 }, (_, index) => `synthetic-${index}`) });
    await fixture.operator.query("UPDATE data_exports SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    const first = await collect();
    expect(first.recordExpiredExports).toBe(1);
    expect(first.record_data_export_items).toBe(250);
    expect((await producer.status(id, owner)).status).toBe("expired");
    await collect(); await collect();
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM data_export_items WHERE export_id=$1", [id])).rows[0].n).toBe(0);
    expect((await fixture.runtime.query(`SELECT action,status,error_code FROM audit_events
      WHERE operation_id=$1 ORDER BY completed_at NULLS FIRST`, [`data-export:${id}`])).rows).toEqual([
      { action: "export-official-usage-users", status: "started", error_code: null },
      { action: "export-official-usage-users", status: "failed", error_code: "export_expired" },
    ]);
  });
});
