import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventoryBaseline, inventoryDelta, inventoryInput, packageRecord,streamedPackageFixture,reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { InventoryGenerations, inventoryAsOf, inventorySelector } from "./inventoryGenerations.js";
import type { GenerationLease } from "./dataGenerations.js";
import { InventoryQueries } from "./inventoryQueries.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { StreamedInventory, storedInventoryRecord } from "../services/streamedInventory.js";
import { packageInventoryRecord, restoreInventoryRecord } from "../services/inventoryRecordProjection.js";
import { unifiedAgentSortKeys } from "../types/unifiedAgents.js";
import { matchesAgentView } from "../types/agentPresentation.js";
import { buildRecords } from "../services/inventoryComponent.js";
import { resolvePackageAgentLinks } from "../services/packageAgentIdentity.js";
import { PowerPlatformResourceQueryClient } from "../services/powerPlatformResourceQuery.js";
import { publishPackageReadback } from "./packageControls.js";
import { capturePackageMutationState } from "../services/packageMutationState.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { grantRuntime, initializeSchema } from "../../scripts/database.js";
import { schemaFingerprint, verifySchema } from "./schema.js";
import { retainRecordData } from "./dataRetention.js";
import { GraphPackagesClient } from "../services/graphPackages.js";
import { checkpointQueries, observePeakMemory, observeQueryWork } from "../services/peakMemory.js";
import { verifyInventoryCollectionRewindSchema } from "./inventoryCollectionRewindSchema.js";
import { AuditLog } from "../services/auditLog.js";
import { withTelemetryContext } from "../services/telemetry.js";

describe("immutable inventory record storage", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  let store: InventoryGenerations;
  beforeAll(async () => { fixture = await testDatabase(); store = new InventoryGenerations(fixture.runtime); }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  it("enters account serialization before opening publication locks and retains it through completion", async () => {
    const isolated = await testDatabase();
    const store = new InventoryGenerations(isolated.runtime);
    let guarded = false;
    const publish = store.generations.publish.bind(store.generations);
    const observed = vi.spyOn(store.generations, "publish").mockImplementation(async (...args) => {
      expect(guarded).toBe(true);
      return publish(...args);
    });
    const completion = vi.fn(async () => { expect(guarded).toBe(true); });
    const guard = vi.fn(async (operation: () => Promise<void>) => {
      guarded = true;
      try { await operation(); } finally { guarded = false; }
    });
    try {
      const root = await store.execute(inventoryInput(randomUUID()), { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
        await store.visit(lease, "only-page");
        const records = [packageRecord(1, "Serialized publication")];
        await store.appendBounded(lease, records);
        await store.acceptPage(lease, { token: "only-page", nextToken: null, records, rawCount: 1, expectedCount: 1, page: 1 }, 1);
      }, { authorize: async () => {}, commitPublication: guard, completeJob: completion });
      expect(root.inserted).toBe(1);
      expect(guard).toHaveBeenCalledOnce();
      expect(observed).toHaveBeenCalledOnce();
      expect(completion).toHaveBeenCalledOnce();
      expect(guarded).toBe(false);
    } finally { observed.mockRestore(); await isolated.close(); }
  });
  it("fresh initialization and runtime grants include all guarded indexed inventory relations", async () => {
    await verifySchema(fixture.runtime);
    expect((await fixture.runtime.query(`SELECT has_table_privilege(current_user,'inventory_collection_progress','SELECT')
      AND has_table_privilege(current_user,'inventory_collection_progress','INSERT')
      AND has_table_privilege(current_user,'inventory_collection_progress','UPDATE') AS allowed`)).rows[0].allowed).toBe(true);
    await expect(fixture.runtime.query("UPDATE package_record_rows SET display_name='forged'")).rejects.toMatchObject({ code: "42501" });
    const before = (await fixture.operator.query("SELECT singleton,fingerprint,initialized_at FROM app_schema")).rows;
    await initializeSchema(fixture.operator);
    await grantRuntime(fixture.operator);
    await verifySchema(fixture.runtime);
    const initialized = (await fixture.operator.query("SELECT singleton,fingerprint,initialized_at FROM app_schema")).rows;
    expect(initialized).toEqual([{ singleton: true, fingerprint: schemaFingerprint, initialized_at: expect.any(Date) }]);
    expect(initialized).toEqual(before);
    process.stdout.write("INVENTORY_SCHEMA_PROOF " + JSON.stringify({ fresh: true, repeated: true, grants: true, initialized }) + "\n");
  });
  it.each([false,true])("prepares bounded hidden memberships before atomic publication (cancel=%s)",async cancel => {
    const principal = randomUUID(),prior = await inventoryBaseline(store,principal,30);
    const batches: number[] = [];
    let authorizations = 0,stagedId = "";
    observePeakMemory(() => {});
    fixture.runtime.on("acquire",checkpointQueries);
    observeQueryWork(value => {
      if (value.sql.includes("FROM jsonb_to_recordset($5::jsonb) member(identity text,generation_id uuid)")) {
        batches.push(JSON.parse(value.parameters![4] as string).length);
      }
    });
    try {
      const execution = store.execute(inventoryInput(principal),{ domain: "packages",mode: "baseline",channel: "catalog" },async lease => {
        stagedId = lease.id;
        for (let offset=0;offset<501;offset+=100) {
          const records = Array.from({ length: Math.min(100,501-offset) },(_,index) => packageRecord(offset+index,"Replacement"));
          await store.visit(lease,String(offset));await store.appendBounded(lease,records);
          await store.acceptPage(lease,{ token: String(offset),nextToken: offset+100<501 ? String(offset+100) : null,
            records,rawCount: records.length,expectedCount: 501,page: Math.floor(offset/100)+1 },records.length);
        }
      },{ authorize: async () => {
        if (++authorizations!==2) return;
        expect((await fixture.runtime.query(`SELECT r.current,r.row_count,a.membership_prepared FROM inventory_roots r
          JOIN inventory_attempts a ON a.generation_id=r.baseline_id WHERE r.baseline_id=$1`,[stagedId])).rows)
          .toEqual([{ current: false,row_count: 501,membership_prepared: true }]);
        expect((await fixture.runtime.query("SELECT baseline_id FROM inventory_roots WHERE scope_id=$1 AND current",[prior.scopeId])).rows[0].baseline_id)
          .toBe(prior.baselineId);
        expect((await store.gcSlice({ ...prior,baselineId: stagedId })).rows).toBe(0);
        await store.gcMetadata(prior.scopeId,prior.tenantId);
        await expect(fixture.runtime.query("DELETE FROM inventory_memberships WHERE baseline_id=$1",[stagedId]))
          .rejects.toThrow("inventory_preparation_pinned");
        await expect(fixture.runtime.query(`UPDATE inventory_attempts SET prepared_changed_count=prepared_changed_count+1
          WHERE generation_id=$1`,[stagedId])).rejects.toThrow("inventory_preparation_fenced");
        await expect(fixture.runtime.query(`INSERT INTO inventory_memberships(
          baseline_id,scope_id,tenant_id,identity,valid_from_revision,valid_to_revision,generation_id)
          SELECT baseline_id,scope_id,tenant_id,identity,$2,$2::bigint+2,generation_id FROM inventory_memberships
          WHERE baseline_id=$1 AND identity='package-000000'`,[stagedId,prior.revision]))
          .rejects.toThrow("inventory_interval_fenced");
        if (cancel) throw new Error("prepublication_authorization_closed");
      } });
      if (cancel) {
        await expect(execution).rejects.toThrow("prepublication_authorization_closed");
        expect((await fixture.runtime.query("SELECT baseline_id FROM inventory_roots WHERE scope_id=$1 AND current",[prior.scopeId])).rows[0].baseline_id)
          .toBe(prior.baselineId);
        expect((await store.gcSlice({ ...prior,baselineId: stagedId })).removed).toBe(501);
      } else {
        const current = await execution;
        expect(current).toMatchObject({ baselineId: stagedId,inserted: 501,closed: 0,changed: 501 });
        expect((await fixture.runtime.query("SELECT current,row_count FROM inventory_roots WHERE baseline_id=$1",[stagedId])).rows)
          .toEqual([{ current: true,row_count: 501 }]);
      }
      expect(batches).toEqual([250,250,1]);
    } finally {
      fixture.runtime.off("acquire",checkpointQueries);observeQueryWork(undefined);observePeakMemory(undefined);
    }
  });
  it("rejects every row of a mixed fenced interval insert without changing the published root",async () => {
    const principal = randomUUID(), baseline = await inventoryBaseline(store,principal,30);
    const current = await inventoryDelta(store,principal);
    const before = (await fixture.runtime.query("SELECT count(*)::int AS count FROM inventory_memberships WHERE baseline_id=$1",
      [baseline.baselineId])).rows[0].count;
    await expect(fixture.runtime.query(`INSERT INTO inventory_memberships(
        baseline_id,scope_id,tenant_id,identity,valid_from_revision,valid_to_revision,generation_id)
      SELECT baseline_id,scope_id,tenant_id,identity,
        CASE WHEN identity='package-000025' THEN $2::bigint ELSE 999 END,
        CASE WHEN identity='package-000025' THEN $2::bigint+1 ELSE 1000 END,generation_id
      FROM inventory_memberships WHERE baseline_id=$1 AND identity IN ('package-000025','package-000026')
        AND valid_to_revision IS NULL`,[baseline.baselineId,current.revision])).rejects.toThrow("inventory_interval_fenced");
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM inventory_memberships WHERE baseline_id=$1",
      [baseline.baselineId])).rows[0].count).toBe(before);
    expect((await fixture.runtime.query("SELECT revision FROM inventory_roots WHERE baseline_id=$1 AND current",
      [baseline.baselineId])).rows[0].revision).toBe(current.revision);
    await verifySchema(fixture.runtime);
  });
  it.each([100, 1000])("writes only twenty changed intervals over a %i-key baseline and retains the old pin", async count => {
    const principal = randomUUID();
    const baseline = await inventoryBaseline(store, principal, count);
    const before = (await fixture.runtime.query("SELECT count(*)::int AS count,sum(pg_column_size(r))::text AS bytes FROM package_record_rows r WHERE scope_id=$1", [baseline.scopeId])).rows[0];
    const changed = await inventoryDelta(store, principal);
    expect(changed).toMatchObject({ inserted: 20, closed: 20, changed: 20 });
    const after = (await fixture.runtime.query("SELECT count(*)::int AS count,sum(pg_column_size(r))::text AS bytes FROM package_record_rows r WHERE scope_id=$1", [baseline.scopeId])).rows[0];
    expect(after.count - before.count).toBe(20);
    const precedence = (await fixture.runtime.query("SELECT count(*)::int AS rows,sum(pg_column_size(h))::int AS bytes FROM inventory_exact_heads h WHERE scope_id=$1",
      [baseline.scopeId])).rows[0];
    expect(precedence.rows).toBe(20);
    const read = async (revision: string) => (await fixture.runtime.query(`SELECT count(*)::int AS count,
      count(*) FILTER(WHERE r.display_name LIKE 'Changed%')::int AS changed FROM inventory_memberships m
      JOIN package_record_rows r ON r.generation_id=m.generation_id AND r.identity=m.identity WHERE ${inventoryAsOf()}`,
    [baseline.baselineId, revision])).rows[0];
    expect(await read(baseline.revision)).toEqual({ count, changed: 0 });
    expect(await read(changed.revision)).toEqual({ count, changed: 20 });
    await expect(fixture.runtime.query("UPDATE inventory_memberships SET valid_to_revision=99 WHERE baseline_id=$1 AND valid_to_revision IS NOT NULL", [baseline.baselineId]))
      .rejects.toThrow("inventory_interval_immutable");
    const plan = await fixture.runtime.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT generation_id FROM inventory_memberships m
      WHERE ${inventoryAsOf()} AND identity=$3`, [baseline.baselineId, baseline.revision, "package-000010"]);
    await fixture.operator.query("ANALYZE inventory_memberships");
    const analyzed = await fixture.runtime.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT generation_id FROM inventory_memberships m
      WHERE ${inventoryAsOf()} AND identity=$3`, [baseline.baselineId, baseline.revision, "package-000010"]);
    process.stdout.write("INVENTORY_WRITE_PROOF " + JSON.stringify({ baseline: count, changed: 20, closed: changed.closed,
      inserted: changed.inserted, newContentRows: after.count - before.count, bytes: Number(after.bytes) - Number(before.bytes), precedence,
      maximumBindBytes: store.maximumParameterBytes, freshPlan: plan.rows[0], analyzedPlan: analyzed.rows[0] }) + "\n");
  });
  describe("indexed membership GC",() => {
    const roots: Awaited<ReturnType<typeof inventoryBaseline>>[] = [];
    beforeAll(async () => {
      const currentPrincipal = randomUUID(),retiredPrincipal = randomUUID();
      await inventoryBaseline(store,currentPrincipal,1000);
      roots.push(await inventoryDelta(store,currentPrincipal));
      roots.push(await inventoryBaseline(store,retiredPrincipal,1000));
      await inventoryBaseline(store,retiredPrincipal,1000);
    },30_000);
    it.each([0,1])("bounds range %i without sorting or deleting N members",async index => {
      const root = roots[index],captured: { sql: string;parameters?: unknown[] }[] = [];
      observePeakMemory(() => {});
      fixture.runtime.on("acquire",checkpointQueries);
      observeQueryWork(value => {
        if (value.sql.startsWith("WITH candidates AS MATERIALIZED") && value.sql.includes("member_tid")) {
          captured.push({ sql: value.sql,parameters: value.parameters });
        }
      });
      try {
        const collected = await store.gcSlice(root);
        expect(collected.removed).toBe(index===0 ? 20 : 997);
        expect(collected.rows+2).toBeLessThanOrEqual(1000);
        expect(captured).toHaveLength(1);
        expect(captured[0].sql).toContain(index===0 ? "AND valid_to_revision<=$4" : "ORDER BY identity,valid_from_revision LIMIT 997");
        const client = await fixture.runtime.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL enable_seqscan=off");
          const value = captured[0];
          const plan = JSON.stringify((await client.query(`EXPLAIN(FORMAT JSON) ${value.sql}`,value.parameters)).rows);
          expect(plan).toContain(index===0 ? "inventory_member_gc" : "inventory_memberships_pkey");
          expect(plan).toContain("Tid Scan");
        } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
        expect((await store.gcSlice(root)).removed).toBe(index===0 ? 0 : 3);
      } finally {
        fixture.runtime.off("acquire",checkpointQueries);
        observeQueryWork(undefined);observePeakMemory(undefined);
      }
    });
  });
  it("retains identity index conditions across key-to-child delta and collection joins",async () => {
    const principal = randomUUID(),root = await inventoryBaseline(store,principal,300);
    const captured: { sql: string;parameters?: unknown[] }[] = [];
    observePeakMemory(() => {});
    fixture.runtime.on("acquire",checkpointQueries);
    observeQueryWork(value => {
      if (value.sql.startsWith("WITH changed AS MATERIALIZED") || value.sql.startsWith("WITH candidates AS MATERIALIZED") && value.sql.includes("AS collectable")) {
        captured.push({ sql: value.sql,parameters: value.parameters });
      }
    });
    try {
      await inventoryDelta(store,principal);
      await store.gcContent(root.scopeId,root.tenantId);
      expect(captured).toHaveLength(2);
      const client = await fixture.runtime.connect();
      try {
        await client.query("BEGIN; SET LOCAL enable_seqscan=off");
        type Plan = { Plans?: Plan[];"Index Name"?: string;"Index Cond"?: string };
        const nodes = (plan: Plan): Plan[] => [plan,...(plan.Plans ?? []).flatMap(nodes)];
        for (const value of captured) {
          const result = await client.query(`EXPLAIN(FORMAT JSON) ${value.sql}`,value.parameters);
          const members = nodes(result.rows[0]["QUERY PLAN"][0].Plan)
            .filter(plan => plan["Index Name"]?.startsWith("inventory_member"));
          expect(members.length).toBeGreaterThan(0);
          for (const member of members) expect(member["Index Cond"]).toContain("identity =");
        }
      } finally { await client.query("ROLLBACK");client.release(); }
    } finally {
      fixture.runtime.off("acquire",checkpointQueries);
      observeQueryWork(undefined);observePeakMemory(undefined);
    }
  });
  it("an aborted stage never closes visible intervals", async () => {
    const principal = randomUUID();
    const root = await inventoryBaseline(store, principal, 30);
    await expect(inventoryDelta(store, principal, 20, async () => { throw new Error("interrupted"); })).rejects.toThrow("interrupted");
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM inventory_memberships WHERE baseline_id=$1 AND valid_to_revision IS NOT NULL", [root.baselineId])).rows[0].count).toBe(0);
    expect((await inventoryDelta(store, principal)).closed).toBe(20);
  });
  it("batches mixed-source facts without crossing record ordinals or the 250-row and encoded-byte limits", async () => {
    const principal = randomUUID();
    const records = Array.from({ length: 50 }, (_, index) => {
      const row = packageRecord(index);
      row.facts.push(...Array.from({ length: 6 }, (_unused, ordinal) => ({
        kind: "fixture:mixed", value: `${index}:${ordinal}`, payload: { index, ordinal },
      })));
      return row;
    });
    const root = await store.execute(inventoryInput(principal),
      { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
        await store.visit(lease, "mixed-facts");
        await store.appendBounded(lease, records);
        await store.acceptPage(lease, { token: "mixed-facts", nextToken: null, records, rawCount: records.length,
          expectedCount: records.length, page: 1 }, records.length);
      }, { authorize: async () => {} });
    expect((await fixture.runtime.query(`SELECT identity,count(*)::int AS count,min(ordinal)::int AS first,
      max(ordinal)::int AS last FROM inventory_facts WHERE generation_id=$1 GROUP BY identity ORDER BY identity`,
    [root.baselineId])).rows).toEqual(records.map(row => ({
      identity: row.identity, count: row.facts.length, first: 0, last: row.facts.length - 1,
    })));
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM inventory_facts WHERE generation_id=$1
      AND kind='fixture:mixed' AND value=(payload->>'index')||':'||(payload->>'ordinal')`, [root.baselineId])).rows[0].count).toBe(300);
    expect(store.maximumParameterBytes).toBeLessThanOrEqual(1_048_576);
  });
  it("atomically rejects the 100001 effective-count boundary on an exact append", async () => {
    const principal = randomUUID(), root = await inventoryBaseline(store, principal, 1);
    // Exercise the counter boundary without presenting this sparse fixture as 100k qualification.
    await fixture.operator.query("UPDATE inventory_roots SET row_count=100000 WHERE baseline_id=$1", [root.baselineId]);
    await expect(store.execute(inventoryInput(principal),
      { domain: "packages", mode: "delta", channel: "exact", targets: ["package-000001"] },
      lease => store.appendBounded(lease, [packageRecord(1)]).then(() => {}), { authorize: async () => {} }))
      .rejects.toMatchObject({ code: "inventory_effective_rows", details: { limit: 100000, observed: 100001 } });
    expect((await fixture.runtime.query("SELECT revision,row_count FROM inventory_roots WHERE baseline_id=$1", [root.baselineId])).rows[0])
      .toEqual({ revision: root.revision, row_count: 100000 });
    expect((await fixture.runtime.query("SELECT identity FROM inventory_memberships WHERE baseline_id=$1", [root.baselineId])).rows)
      .toEqual([{ identity: "package-000000" }]);
  });

  it("splits legal wide Graph catalog projection work without dropping records or changing encoded limits", async () => {
    const principal = randomUUID(), total = 100, publisher = "publisher".repeat(400);
    const graph = new GraphPackagesClient(async () => Response.json({
      value: Array.from({ length: total }, (_, index) => ({ id: `wide-${index}`, displayName: `Wide ${index}`,
        publisher, description: "description".repeat(360), isBlocked: false })),
      "@odata.count": total,
    }));
    const stream = new StreamedInventory(fixture.runtime, graph);
    const root = await stream.graphCatalog(inventoryInput(principal), "synthetic", { authorize: async () => {} });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM package_record_rows WHERE generation_id=$1",
      [root.baselineId])).rows[0].count).toBe(total);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM package_record_rows WHERE generation_id=$1 AND publisher=$2",
      [root.baselineId, publisher])).rows[0].count).toBe(total);
    expect((await fixture.runtime.query("SELECT batch_count FROM data_generations WHERE id=$1", [root.baselineId])).rows[0].batch_count).toBeGreaterThan(1);
    expect(stream.stages.maximumParameterBytes).toBeLessThanOrEqual(1_048_576);
  });

  it("pins operation-reference reads through unrelated and newer audit writes but fences deletion of matching retained evidence", async () => {
    const principalId = randomUUID(), scope = { tenantId: selectionIdentity.tenantId, principalId };
    const identity = { ...selectionIdentity, principalId }, root = await inventoryBaseline(store, principalId, 1);
    const audit = new AuditLog(scope, fixture.runtime);
    const actor = { tenantId: scope.tenantId, homeAccountId: principalId, displayName: "Fixture", username: "fixture@example.invalid" };
    const source = await audit.startEvent({ operationId: "abcdef01-original", scope: "bulk", action: "block",
      targetBlockedState: true, agentId: "package-000000", actor, requestPath: "/fixture" });
    const queries = new InventoryQueries(fixture.runtime, "synthetic-operation-selection-secret-32");
    const selected = await queries.capture(identity, root.scopeId, { operationIdPrefix: "abcdef01" });
    expect((await queries.page(selected.id, identity)).counts.filtered).toBe(1);
    const unrelated = await audit.startEvent({ operationId: "data-export:unrelated", scope: "bulk", action: "export-package-inventory",
      agentId: "export-id", actor, requestPath: "/api/data-exports" });
    await audit.completeEvent(unrelated.id, { status: "succeeded" });
    await audit.startEvent({ operationId: "abcdef01-newer", scope: "bulk", action: "block",
      targetBlockedState: true, agentId: "package-000000", actor, requestPath: "/fixture" });
    await fixture.operator.query("DELETE FROM audit_events WHERE tenant_id=$1 AND principal_id=$2 AND event_id=$3",
      [scope.tenantId, scope.principalId, unrelated.id]);
    expect((await queries.page(selected.id, identity)).counts.filtered).toBe(1);
    await fixture.operator.query("DELETE FROM audit_events WHERE tenant_id=$1 AND principal_id=$2 AND event_id=$3",
      [scope.tenantId, scope.principalId, source.id]);
    await expect(queries.page(selected.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
  });
  it("pins old rows across a delta and bounded GC, and rejects current control from an old selection", async () => {
    const principal = randomUUID();
    const root = await inventoryBaseline(store, principal, 100);
    const queries = new InventoryQueries(fixture.runtime, "synthetic-inventory-cursor-secret-32-bytes");
    const identity = { ...selectionIdentity, principalId: principal };
    const selection = await queries.capture(identity, root.scopeId);
    expect((await queries.page(selection.id, identity, { limit: 7 })).counts).toMatchObject({ total: 100, filtered: 100 });
    const changed = await inventoryDelta(store, principal);
    expect(await store.gc(changed)).toBe(0);
    await expect(fixture.runtime.query("DELETE FROM inventory_revisions WHERE scope_id=$1 AND revision=$2", [root.scopeId, root.revision]))
      .rejects.toThrow("inventory_revision_pinned");
    expect((await queries.exact(selection.id, identity, ["package-000001"]))[0].residual.displayName).toBe("Agent 1");
    await expect(queries.currentControl(selection.id, identity, "package-000001", async () => true)).rejects.toMatchObject({ code: "selection_invalidated" });
    const page = await queries.page(selection.id, identity, { limit: 7 });
    expect(page.page.nextCursor).toBeTruthy();
    expect((await queries.page(selection.id, identity, { limit: 7, cursor: page.page.nextCursor! })).value).toHaveLength(7);
    await fixture.operator.query("UPDATE data_generation_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE selection_id=$1", [selection.id]);
    expect(await store.gc(changed)).toBe(20);
    await expect(queries.page(selection.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    let reclaimed = 0;
    for (let pass = 0; pass < 50; pass++) {
      const removed = await store.gcContent(root.scopeId, root.tenantId);
      expect(removed.rows).toBeLessThanOrEqual(1000);
      expect(removed.bytes).toBeLessThanOrEqual(1_048_576);
      reclaimed += removed.bytes;
      if (!removed.rows) break;
    }
    expect(reclaimed).toBeGreaterThan(0);
    expect((await store.gcMetadata(root.scopeId, root.tenantId)).changes).toBe(20);
    const current = await queries.capture(identity, root.scopeId);
    expect((await queries.exact(current.id, identity, ["package-000001"]))[0].residual.displayName).toBe("Changed 1");
    process.stdout.write("INVENTORY_GC_PROOF " + JSON.stringify({ reclaimedContentBytes: reclaimed, changedKeys: 20 }) + "\n");
  });
  it("compacts bounded references without cloning content, preserving old selections", async () => {
    const principal = randomUUID();
    const root = await inventoryBaseline(store, principal, 100);
    const changed = await inventoryDelta(store, principal);
    const queries = new InventoryQueries(fixture.runtime, "synthetic-inventory-cursor-secret-32-bytes");
    const identity = { ...selectionIdentity, principalId: principal };
    const old = await queries.capture(identity, changed.scopeId);
    const before = (await fixture.runtime.query("SELECT count(*)::int AS count FROM package_record_rows WHERE scope_id=$1", [root.scopeId])).rows[0].count;
    const compacted = await store.compact(inventoryInput(principal), changed, { authorize: async () => {} });
    expect(compacted.inserted).toBe(100);
    expect(compacted.baselineId).not.toBe(root.baselineId);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM package_record_rows WHERE scope_id=$1", [root.scopeId])).rows[0].count).toBe(before);
    await store.gc(changed);
    expect((await queries.exact(old.id, identity, ["package-000001"]))[0].residual.displayName).toBe("Changed 1");
  });
  it("advances bounded content scans past live keys, wraps, and revisits newly unpinned keys", async () => {
    const principal = randomUUID(), root = await inventoryBaseline(store,principal,600);
    const reader = new InventoryQueries(fixture.runtime,"synthetic-collection-cursor-secret-32");
    const identity = { ...selectionIdentity,principalId: principal };
    const pin = await reader.capture(identity,root.scopeId);
    const positions = [];
    for (let pass=0;pass<3;pass++) {
      const work = await store.gcContent(root.scopeId,root.tenantId);
      expect(work.rows).toBeLessThanOrEqual(1000); expect(work.bytes).toBeLessThanOrEqual(1_048_576);
      positions.push((await fixture.runtime.query(`SELECT after_identity FROM inventory_collection_progress WHERE scope_id=$1`,[root.scopeId])).rows[0].after_identity);
    }
    expect(positions).toEqual(["package-000249","package-000499",null]);
    const changed = await inventoryDelta(store,principal);
    expect(await store.gc(changed)).toBe(0);
    for (let pass=0;pass<3;pass++) await store.gcContent(root.scopeId,root.tenantId);
    expect((await reader.exact(pin.id,identity,["package-000001"]))[0].residual.displayName).toBe("Agent 1");
    await reader.selections.invalidate(pin.id,identity);
    await store.generations.connections.run(client => retainRecordData(client));
    expect(await store.gc(changed)).toBe(20);
    for (let pass=0;pass<10;pass++) {
      const work = await store.gcContent(root.scopeId,root.tenantId);
      expect(work.rows).toBeLessThanOrEqual(1000); expect(work.bytes).toBeLessThanOrEqual(1_048_576);
    }
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM inventory_keys WHERE generation_id=$1`,[root.baselineId])).rows[0].count).toBe(580);
    const current = await reader.capture(identity,root.scopeId);
    expect((await reader.exact(current.id,identity,["package-000001"]))[0].residual.displayName).toBe("Changed 1");
  });
  it("bounds immutable summary caching while refreshing current-head status and enforcing invalidation",async () => {
    const principal = randomUUID(),root = await inventoryBaseline(store,principal,30);
    const reader = new InventoryQueries(fixture.runtime,"synthetic-bounded-summary-cache-secret");
    const identity = { ...selectionIdentity,principalId: principal };
    const pins = [];
    for (let i=0;i<33;i++) {
      const pin = await reader.capture(identity,root.scopeId,i%3===1 ? { inventoryScope: "catalog" }
        : i%3===2 ? { source: "all",inventoryScope: "all" } : {});
      expect((await reader.summary(pin.id,identity)).counts.total).toBe(30);
      pins.push(pin);
    }
    const cache = (reader as unknown as { summaryCache: Map<string,unknown> }).summaryCache;
    expect(cache.size).toBe(32); expect(cache.has(pins[0].id)).toBe(false);
    for (const entry of cache.values()) expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThan(16_384+128);
    const pin = pins.at(-1)!;
    const nextRequest = new InventoryQueries(fixture.runtime,"synthetic-bounded-summary-cache-secret");
    expect((nextRequest as unknown as { summaryCache: Map<string,unknown> }).summaryCache).toBe(cache);
    expect((await nextRequest.summary(pin.id,identity)).counts.total).toBe(30);
    await expect(nextRequest.summary(pin.id,{ ...identity,principalId: randomUUID() })).rejects.toThrow();
    await inventoryDelta(store,principal);
    const old = await reader.summary(pin.id,identity);
    expect(old.counts.total).toBe(30); expect(old.freshness.state).toBe("stale");
    await store.clear(root.scopeId,root.tenantId);
    await expect(reader.summary(pin.id,identity)).rejects.toMatchObject({ code: "selection_invalidated" });
  });
  it.each(["packages","canonical"] as const)("keeps source=all HTTP defaults on bounded %s pages and shared immutable summaries",async domain => {
    const principalId = randomUUID(),identity = { ...selectionIdentity,principalId };
    let root = await inventoryBaseline(store,principalId,30);
    if (domain==="canonical") root = (await reconcileInventoryFixture(fixture.runtime,identity))!;
    const reader = new InventoryQueries(fixture.runtime,"synthetic-source-all-query-secret");
    const reference = await reader.capture(identity,root.scopeId);
    const expected = await reader.page(reference.id,identity,{ limit: 3 });
    const selected = await reader.capture(identity,root.scopeId,{ source: "all",inventoryScope: "all",sortBy: "displayName",sortDirection: "asc" });
    await reader.summary(selected.id,identity);
    const queries: string[] = [],sizes: number[] = [];
    observePeakMemory(() => {});
    observeQueryWork(value => {
      queries.push(value.sql);
      if (value.sql.startsWith("WITH report_binding") && Array.isArray(value.parameters?.[12])) sizes.push(value.parameters[12].length);
    });
    fixture.runtime.on("acquire",checkpointQueries);
    try {
      const nextRequest = new InventoryQueries(fixture.runtime,"synthetic-source-all-query-secret");
      const page = await nextRequest.page(selected.id,identity,{ limit: 3 });
      expect(page.value).toEqual(expected.value);
      expect(page.counts).toEqual(expected.counts);
      expect(sizes).toEqual([4]);
      expect(queries.some(sql => sql.includes("inventory AS MATERIALIZED"))).toBe(true);
      expect(queries.some(sql => sql.includes("FROM summary_facts f"))).toBe(false);
    } finally {
      fixture.runtime.removeListener("acquire",checkpointQueries);
      observeQueryWork();observePeakMemory();
    }
  });
  it.each(["scope","sync"] as const)("yields all inventory collection paths without waiting on a held %s fence",async fence => {
    const principal = randomUUID(),root = await inventoryBaseline(store,principal,30);
    const held = await fixture.runtime.connect();
    try {
      await held.query("BEGIN");
      if (fence==="scope") await held.query("SELECT id FROM data_scope_epochs WHERE id=$1 FOR UPDATE",[root.scopeId]);
      else await held.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`data-sync:${root.tenantId}:${principal}`]);
      const started = performance.now();
      expect(await store.gcSlice(root)).toEqual({ rows: 0,removed: 0,bytes: 0 });
      expect(await store.gcContent(root.scopeId,root.tenantId)).toEqual({ rows: 0,bytes: 0 });
      expect(await store.gcMetadataSlice(root.scopeId,root.tenantId)).toEqual({ removed: {},rows: 0,bytes: 0 });
      expect(performance.now()-started).toBeLessThan(1000);
      expect((await held.query("SELECT count(*)::int AS n FROM inventory_keys WHERE generation_id=$1",[root.baselineId])).rows[0].n).toBe(30);
    } finally { await held.query("ROLLBACK");held.release(); }
    expect((await store.gcContent(root.scopeId,root.tenantId)).rows).toBeGreaterThan(0);
  });
  it("keeps exact twenty-key reads on current indexed records after retained detail generations",async () => {
      const principalId = randomUUID(),identity = { ...selectionIdentity,principalId };
      const root = await inventoryBaseline(store,principalId,1000);
      for (let revision=0;revision<10;revision++) await inventoryDelta(store,principalId,20);
      await fixture.operator.query("ANALYZE package_record_rows; ANALYZE inventory_memberships");
      const reader = new InventoryQueries(fixture.runtime,"synthetic-exact-record-query-secret");
      const selected = await reader.capture(identity,root.scopeId);
      const ids = Array.from({ length: 20 },(_,index) => packageRecord(index).native_id);
      let captured: { sql: string;parameters: unknown[] } | undefined;
      observePeakMemory(() => {});
      observeQueryWork(value => {
        if (value.sql.startsWith("WITH candidates AS") && value.parameters) captured = { sql: value.sql,parameters: value.parameters };
      });
      fixture.runtime.on("acquire",checkpointQueries);
      try {
        const rows = await reader.exact(selected.id,identity,ids);
        expect(rows.map(row => row.identity).sort()).toEqual([...ids].sort());
        expect(captured?.sql).toContain("CROSS JOIN LATERAL");
        expect(captured?.sql).toContain("r.scope_id=$4 AND r.domain='packages' OFFSET 0");
        await store.generations.connections.run(async client => {
          await client.query("SET LOCAL jit=off; SET LOCAL enable_nestloop=on");
          const plan = (await client.query(`EXPLAIN(ANALYZE,BUFFERS,WAL,SETTINGS,FORMAT JSON) ${captured!.sql}`,captured!.parameters)).rows;
          expect(JSON.stringify(plan)).toContain("package_record_rows_pkey");
          process.stdout.write(JSON.stringify({ contract: "inventory-exact-twenty-plan",rows: rows.length,plan })+"\n");
        });
      } finally {
        fixture.runtime.removeListener("acquire",checkpointQueries);observeQueryWork();observePeakMemory();
      }
    },30_000);
  it("rewinds precisely when canonical cleanup releases source keys behind an advanced collection cursor",async () => {
      const principalId = randomUUID(),identity = { ...selectionIdentity,principalId };
      const root = await inventoryBaseline(store,principalId,1000);
      await reconcileInventoryFixture(fixture.runtime,identity);
      await store.gcContent(root.scopeId,root.tenantId);
      const progress = async () => (await fixture.runtime.query(`SELECT after_generation,after_identity,after_inclusive
        FROM inventory_collection_progress WHERE scope_id=$1`,[root.scopeId])).rows[0];
      expect((await progress()).after_inclusive).toBe(false);
      await inventoryDelta(store,principalId,20);
      const canonical = (await reconcileInventoryFixture(fixture.runtime,identity))!;
      await store.gcSlice(root);
      expect((await progress()).after_inclusive).toBe(true);
      await store.gcContent(root.scopeId,root.tenantId);
      expect((await progress()).after_inclusive).toBe(false);
      await store.gcSlice(canonical);
      let released: Awaited<ReturnType<typeof progress>> | undefined;
      for (let index=0;index<12;index++) {
        const slice = await store.gcContent(canonical.scopeId,canonical.tenantId);
        expect(slice.rows).toBeLessThanOrEqual(1000);expect(slice.bytes).toBeLessThanOrEqual(1_048_576);
        const value = await progress();
        if (value.after_inclusive) { released = value;break; }
      }
      expect(released).toBeDefined();
      expect(released!.after_generation).toBe(root.baselineId);
      for (let index=0;index<2;index++) await store.gcContent(root.scopeId,root.tenantId);
      expect((await fixture.runtime.query("SELECT 1 FROM inventory_keys WHERE generation_id=$1 AND identity=$2",
        [released!.after_generation,released!.after_identity])).rowCount).toBe(0);
      expect((await new InventoryQueries(fixture.runtime,"synthetic-rewind-cursor-query-key-for-tests").capture(identity,root.scopeId)).id).toBeDefined();
    },60_000);
  it("rewinds newly failed staging keys and rejects a missing reference-release trigger at readiness",async () => {
      const principalId = randomUUID(),input = inventoryInput(principalId);
      let staged: GenerationLease | undefined;
      await expect(store.execute(input,{ domain: "packages",mode: "baseline",channel: "catalog" },async lease => {
        staged = lease;
        await store.appendBounded(lease,[packageRecord(0)]);
        await store.gcContent(lease.scopeId,lease.tenantId);
        await fixture.runtime.query(`UPDATE inventory_collection_progress
          SET after_generation=$2,after_identity=$3,after_inclusive=false WHERE scope_id=$1`,
        [lease.scopeId,lease.id,packageRecord(0).identity]);
        throw new Error("synthetic_failed_staging");
      },{ authorize: async () => {} })).rejects.toThrow("synthetic_failed_staging");
      const lease = staged!;
      const cursor = (await fixture.runtime.query(`SELECT after_generation,after_identity,after_inclusive
        FROM inventory_collection_progress WHERE scope_id=$1`,[lease.scopeId])).rows[0];
      expect(cursor).toEqual({ after_generation: lease.id,after_identity: packageRecord(0).identity,after_inclusive: true });
      await store.gcContent(lease.scopeId,lease.tenantId);
      expect((await fixture.runtime.query("SELECT 1 FROM inventory_keys WHERE generation_id=$1",[lease.id])).rowCount).toBe(0);
      const client = await fixture.operator.connect();
      try {
        await client.query("BEGIN");
        await client.query("DROP TRIGGER ac_inventory_exact_heads_update_rewind ON inventory_exact_heads");
        await expect(verifyInventoryCollectionRewindSchema(client)).rejects.toThrow("inventory_collection_rewind_schema");
      } finally { await client.query("ROLLBACK");client.release(); }
      await verifyInventoryCollectionRewindSchema(fixture.runtime);
    },30_000);
  it.each(["packages","canonical"] as const)("matches the filtered summary oracle with set-based %s categorical facts",async domain => {
    const principalId = randomUUID(),scope = { tenantId: selectionIdentity.tenantId,principalId };
    let root = await streamedPackageFixture(fixture.runtime,scope,[
      { id: "summary-available",displayName: "Agent available",isBlocked: false,availableTo: "Everyone",supportedHosts: ["teams"] },
      { id: "summary-blocked",displayName: "Agent blocked",isBlocked: true,availableTo: "Everyone" },
      { id: "summary-unknown",displayName: "Agent unknown",isBlocked: false },
    ],{ exact: true });
    if (domain==="canonical") root = (await reconcileInventoryFixture(fixture.runtime,scope))!;
    const identity = { ...selectionIdentity,principalId };
    const reader = new InventoryQueries(fixture.runtime,"synthetic-summary-aggregate-secret-32");
    const aggregate = await reader.summary((await reader.capture(identity,root.scopeId)).id,identity);
    const filtered = await reader.summary((await reader.capture(identity,root.scopeId,{ search: "Agent" })).id,identity);
    expect(aggregate.counts.total).toBe(3);
    for (const key of ["counts","summary","scopeSummary","filteredSummary","inventoryOverview","verificationCounts"] as const) {
      expect(aggregate[key]).toEqual(filtered[key]);
    }
  });
  it("rejects retired scalar facts before publication instead of allowing competing representations",async () => {
    const principalId = randomUUID(),record = packageRecord(0);
    record.facts.push({ kind: "presence",value: "power_platform",payload: {} });
    await expect(store.execute(inventoryInput(principalId),{ domain: "packages",mode: "baseline",channel: "catalog" },async lease => {
      await store.visit(lease,"duplicate-scalar");
      await store.appendBounded(lease,[record]);
      await store.acceptPage(lease,{ token: "duplicate-scalar",nextToken: null,records: [record],rawCount: 1,expectedCount: 1,page: 1 },1);
    },{ authorize: async () => {} })).rejects.toThrow("inventory_scalar_fact_retired");
  });
  it.each(["packages","canonical"] as const)("merges short and long name seeks in exact %s collation order",async domain => {
    const principalId = randomUUID(),scope = { tenantId: selectionIdentity.tenantId,principalId };
    const names = ["Alfa","Alpha"+"m".repeat(70),"Écho","echo"+"n".repeat(70),"Zulu","Z"+"m".repeat(70)];
    let root = await streamedPackageFixture(fixture.runtime,scope,names.map((displayName,i) => ({ id: `name-${i}`,displayName,isBlocked: false })));
    if (domain==="canonical") root = (await reconcileInventoryFixture(fixture.runtime,scope))!;
    const identity = { ...selectionIdentity,principalId };
    const reader = new InventoryQueries(fixture.runtime,"synthetic-name-partition-secret-32");
    const collator = new Intl.Collator("en-US",{ sensitivity: "base" });
    const normalized = (value: string) => value.normalize("NFKC").toLowerCase();
    const ordered = [...names].sort((a,b) => domain==="canonical" ? collator.compare(normalized(a),normalized(b))
      : Buffer.compare(Buffer.from(normalized(a)),Buffer.from(normalized(b))));
    for (const sortDirection of ["asc","desc"] as const) {
      const expected = sortDirection==="asc" ? ordered : [...ordered].reverse(),seen: string[] = [];
      const pin = await reader.capture(identity,root.scopeId,{ sortBy: "displayName",sortDirection,
        ...(domain==="packages" ? { inventoryScope: "catalog" as const } : {}) });
      let cursor: string | undefined;
      do {
        const page = await reader.page(pin.id,identity,{ limit: 2,cursor });
        seen.push(...page.value.map(row => row.displayName));
        if (page.page.previousCursor) {
          const previous = await reader.page(pin.id,identity,{ limit: 2,cursor: page.page.previousCursor });
          expect(previous.value.map(row => row.displayName)).toEqual(expected.slice(seen.length-4,seen.length-2));
        }
        cursor = page.page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual(expected);
    }
  });
  it("retains newer exact present and missing targets across an older-started broad scan", async () => {
    const principal = randomUUID();
    await inventoryBaseline(store, principal, 3, new Date(Date.now() - 20_000));
    const started = new Date(Date.now() - 10_000);
    await store.execute(inventoryInput(principal), { domain: "packages", mode: "delta", channel: "exact",
      targets: ["package-000000", "package-000003"] }, async lease => {
      await store.append(lease, [{ ...packageRecord(0), deleted: true }, packageRecord(3, "Newest exact")]);
    }, { authorize: async () => {} });
    const broad = await store.execute({ ...inventoryInput(principal), observedAt: started }, { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      const records = [packageRecord(0), packageRecord(1)];
      await store.visit(lease, "old");
      await store.append(lease, records);
      await store.acceptPage(lease, { token: "old", nextToken: null, records, rawCount: 2, expectedCount: 2, page: 1 }, 2);
    }, { authorize: async () => {} });
    const rows = (await fixture.runtime.query(`SELECT r.identity,r.display_name FROM inventory_memberships m
      JOIN inventory_records r ON r.generation_id=m.generation_id AND r.identity=m.identity WHERE ${inventoryAsOf()} ORDER BY r.identity`,
    [broad.baselineId, broad.revision])).rows;
    expect(rows).toEqual([{ identity: "package-000001", display_name: "Agent 1" }, { identity: "package-000003", display_name: "Newest exact" }]);
  });
  it("retains exact tombstones and presence through repeated broad swaps, compaction and GC until newer evidence", async () => {
    const principal = randomUUID(), now = Date.now(), stream = new StreamedInventory(fixture.runtime);
    const initial = await inventoryBaseline(store, principal, 2, new Date(now - 40_000));
    const identity = { ...selectionIdentity, principalId: principal };
    const queries = new InventoryQueries(fixture.runtime, "synthetic-repeated-broad-precedence-secret");
    const old = await queries.capture(identity, initial.scopeId);
    const exact = await store.execute({ ...inventoryInput(principal), observedAt: new Date(now - 10_000) },
      { domain: "packages", mode: "delta", channel: "exact", targets: ["package-000000", "package-000003"] },
      async lease => {
        await stream.exactMissing(lease, "package-000000");
        await stream.packageObservation(lease, { id: "package-000003", displayName: "Newest exact", isBlocked: false }, "exact");
      },
      { authorize: async () => {} });
    const broad = (time: number) => store.execute({ ...inventoryInput(principal), observedAt: new Date(time) },
      { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
        const records = [packageRecord(0), packageRecord(1)];
        await store.visit(lease, "all"); await store.append(lease, records);
        await store.acceptPage(lease, { token: "all", nextToken: null, records, rawCount: 2, expectedCount: 2, page: 1 }, 2);
      }, { authorize: async () => {} });
    const read = async (root: typeof initial) => (await fixture.runtime.query(`SELECT r.identity,r.display_name
      FROM inventory_memberships m JOIN inventory_records r ON r.generation_id=m.generation_id AND r.identity=m.identity
      WHERE ${inventoryAsOf()} ORDER BY r.identity`, [root.baselineId, root.revision])).rows;
    const expected = [{ identity: "package-000001", display_name: "Agent 1" }, { identity: "package-000003", display_name: "Newest exact" }];
    const first = await broad(now - 30_000);
    expect(await read(first)).toEqual(expected);
    const second = await broad(now - 20_000);
    expect(await read(second)).toEqual(expected);
    const compacted = await store.compact(inventoryInput(principal), second, { authorize: async () => {} });
    expect(await read(compacted)).toEqual(expected);
    await store.gc(exact); await store.gc(first); await store.gc(second);
    for (let i = 0; i < 30; i++) { await store.gcContent(initial.scopeId, initial.tenantId); await store.gcMetadata(initial.scopeId, initial.tenantId); }
    expect((await queries.exact(old.id, identity, ["package-000000"]))[0].residual.displayName).toBe("Agent 0");
    const third = await broad(now - 15_000);
    expect(await read(third)).toEqual(expected);
    const latest = await broad(now);
    expect(await read(latest)).toEqual([{ identity: "package-000000", display_name: "Agent 0" }, { identity: "package-000001", display_name: "Agent 1" }]);
    await store.gcMetadata(initial.scopeId, initial.tenantId);
    expect((await fixture.runtime.query("SELECT identity FROM inventory_exact_heads WHERE scope_id=$1", [initial.scopeId])).rows).toEqual([]);
    expect(await read(await broad(now - 25_000))).toEqual(await read(latest));
  });
  it("fences exact precedence updates, ignores stale exact evidence and collects superseded heads in bounded batches", async () => {
    const principal = randomUUID(), now = Date.now();
    const baseline = await inventoryBaseline(store, principal, 100, new Date(now - 10_000));
    const root = await inventoryDelta(store, principal, 100);
    await expect(fixture.runtime.query("DELETE FROM inventory_exact_heads WHERE scope_id=$1", [root.scopeId])).rejects.toThrow("inventory_exact_reachable");
    await expect(fixture.runtime.query("UPDATE inventory_exact_heads SET read_started_at=read_started_at-interval '1 second' WHERE scope_id=$1", [root.scopeId]))
      .rejects.toThrow("inventory_exact_immutable");
    await expect(store.execute(inventoryInput(principal), { domain: "packages", mode: "delta", channel: "exact", targets: ["package-000000"] },
      async lease => { await store.append(lease, [packageRecord(0, "Aborted")]); throw new Error("aborted"); },
      { authorize: async () => {} })).rejects.toThrow("aborted");
    const head = (await fixture.runtime.query("SELECT generation_id FROM inventory_exact_heads WHERE scope_id=$1 AND identity='package-000000'", [root.scopeId])).rows[0];
    const stale = await store.execute({ ...inventoryInput(principal), observedAt: new Date(now - 5000) },
      { domain: "packages", mode: "delta", channel: "exact", targets: ["package-000000"] },
      lease => store.append(lease, [{ ...packageRecord(0), deleted: true }]).then(() => {}), { authorize: async () => {} });
    expect(stale).toMatchObject({ inserted: 0, closed: 0, changed: 0 });
    expect((await fixture.runtime.query("SELECT generation_id FROM inventory_exact_heads WHERE scope_id=$1 AND identity='package-000000'", [root.scopeId])).rows[0]).toEqual(head);
    await inventoryBaseline(store, principal, 100);
    expect((await store.gcMetadata(root.scopeId, root.tenantId)).exactHeads).toBe(50);
    expect((await store.gcMetadata(root.scopeId, root.tenantId)).exactHeads).toBe(50);
    expect((await store.gcMetadata(root.scopeId, root.tenantId)).exactHeads).toBe(0);
    await store.clear(baseline.scopeId, baseline.tenantId);
    expect((await inventoryDelta(store, principal, 1)).inserted).toBe(1);
  });
  it("rejects the oversized child at actual staging and pages every legal multibyte child within the encoded budget", async () => {
    const oversized = packageInventoryRecord({ id: "oversized", displayName: "Oversized", isBlocked: false,
      elementDetails: [{ elementType: "Custom", elements: [{ id: "one", definition: "x".repeat(600_000) }] }] });
    const payload = oversized.facts.find(fact => fact.kind === "element")!.payload;
    const bytes = (await fixture.operator.query("SELECT octet_length($1::jsonb::text) AS bytes", [JSON.stringify(payload)])).rows[0].bytes;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(withTelemetryContext({ requestId: "request-oversized", jobId: "job-oversized" }, () =>
        store.execute(inventoryInput(), { domain: "packages", mode: "delta", channel: "exact", targets: ["oversized"] },
          lease => store.append(lease, [oversized]).then(() => {}), { authorize: async () => {} })))
        .rejects.toMatchObject({ code: "data_residual_bytes", details: { limit: 262_144, observed: bytes } });
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.parse(warn.mock.calls[0][0])).toEqual({
        timestamp: expect.any(String), level: "warn", event: "data_residual_limit_exceeded",
        requestId: "request-oversized", jobId: "job-oversized", errorCode: "data_residual_bytes",
        stage: "database", field: "payload", bytes, maximumLength: 262_144,
      });
    } finally { warn.mockRestore(); }
    const input = inventoryInput(), record = packageRecord(0);
    const facts = Array.from({ length: 80 }, (_, i) => ({ kind: "wide-child", value: String(i).padStart(3, "0") + "😀".repeat(4093), payload: {} }));
    record.facts.push(...facts);
    const root = await store.execute(input, { domain: "packages", mode: "delta", channel: "exact", targets: [record.identity] },
      lease => store.append(lease, [record]).then(() => {}), { authorize: async () => {} });
    const identity = { ...selectionIdentity, principalId: input.scope.principalId! };
    const queries = new InventoryQueries(fixture.runtime, "synthetic-legal-multibyte-children-secret");
    const selection = await queries.capture(identity, root.scopeId);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await queries.children(selection.id, identity, record.identity, { kind: "wide-child", cursor, limit: 100 });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1_048_576);
      expect(page.value.length).toBeGreaterThan(0);
      seen.push(...page.value.map(row => row.value)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(facts.map(fact => fact.value));
    const payloadBytes = (await fixture.runtime.query("SELECT octet_length($1::jsonb::text)::int AS bytes",
      [JSON.stringify(oversized.facts.find(fact => fact.kind === "element")!.payload)])).rows[0].bytes;
    expect(payloadBytes).toBeGreaterThan(262144);
    await queries.selections.invalidate(selection.id, identity);
    await store.generations.connections.run(client => retainRecordData(client));
    await inventoryBaseline(store, identity.principalId, 1);
    await store.gcMetadata(root.scopeId, root.tenantId); await store.gc(root);
    let collected = 0, partial = false;
    for (let i = 0; i < 10; i++) {
      const removed = await store.gcContent(root.scopeId, root.tenantId);
      expect(removed.rows).toBeLessThanOrEqual(1000); expect(removed.bytes).toBeLessThanOrEqual(1_048_576);
      collected += removed.rows;
      const left = Number((await fixture.runtime.query("SELECT count(*)::text AS count FROM inventory_facts WHERE generation_id=$1",
        [root.baselineId])).rows[0].count);
      if (left>0 && removed.rows>3) {
        partial = true;
        expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM inventory_keys WHERE generation_id=$1",[root.baselineId])).rows[0].count).toBe(1);
      }
      if (!removed.rows) break;
    }
    expect(collected).toBeGreaterThanOrEqual(80);
    expect(partial).toBe(true);
    process.stdout.write("INVENTORY_CHILD_REPAIR_PROOF " + JSON.stringify({ rejectedPayloadBytes: payloadBytes, payloadLimit: 262144,
      legalMultibyteValues: facts.length, returned: seen.length, gcRows: collected }) + "\n");
  });
  it.each(["asc", "desc"].flatMap(sortDirection => (["publisher", "builtWith", "versions"] as const)
    .map(sortBy => ({ sortDirection: sortDirection as "asc" | "desc", sortBy }))))
  ("round-trips full wide sort boundaries with selected-row cursors ($sortBy/$sortDirection)", async ({ sortDirection, sortBy }) => {
    const input = inventoryInput(), values = [
      { id: "a", displayName: "A", publisher: "界".repeat(4095) + "a" },
      { id: "b", displayName: "B", publisher: "界".repeat(4095) + "b" },
      { id: "c", displayName: "C", publisher: "界".repeat(4095) + "b" },
      { id: "d", displayName: "D" },
    ].map(value => ({ ...value, platform: value.publisher, version: value.publisher, isBlocked: false }));
    const root = await store.execute(input, { domain: "packages", mode: "delta", channel: "exact", targets: values.map(value => value.id) },
      lease => store.appendBounded(lease, values.map(packageInventoryRecord)).then(() => {}), { authorize: async () => {} });
    const identity = { ...selectionIdentity, principalId: input.scope.principalId! };
    const queries = new InventoryQueries(fixture.runtime, "synthetic-wide-sort-boundary-secret");
    const selected = await queries.capture(identity, root.scopeId, { sortBy, sortDirection });
    const expected = sortDirection === "asc" ? ["a", "b", "c", "d"] : ["c", "b", "a", "d"];
    let page = await queries.page(selected.id, identity, { limit: 1 });
    const other = await queries.capture(identity, root.scopeId, { sortBy: "displayName" });
    await expect(queries.page(other.id, identity, { cursor: page.page.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(queries.children(selected.id, identity, "a", { kind: "element", cursor: page.page.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    await queries.selections.invalidate(other.id, identity);
    const ids = [page.value[0].id];
    while (page.page.nextCursor) {
      expect(Buffer.byteLength(page.page.nextCursor)).toBeLessThanOrEqual(4096);
      const next = await queries.page(selected.id, identity, { limit: 1, cursor: page.page.nextCursor });
      const previous = await queries.page(selected.id, identity, { limit: 1, cursor: next.page.previousCursor! });
      expect(previous.value.map(row => row.id)).toEqual(page.value.map(row => row.id));
      ids.push(next.value[0].id); page = next;
    }
    expect(ids).toEqual(expected);
  });
  it("round-trips byte-short list pages while recovering full selected sort values", async () => {
    const principal = randomUUID(), input = inventoryInput(principal);
    const records = Array.from({ length: 60 }, (_, i) => packageInventoryRecord({ id: `wide-${i.toString().padStart(2, "0")}`,
      displayName: `Wide ${i}`, isBlocked: false, publisher: "界".repeat(4093) + i.toString().padStart(3, "0") }));
    const root = await store.execute(input, { domain: "packages", mode: "delta", channel: "exact", targets: records.map(row => row.identity) },
      lease => store.appendBounded(lease, records).then(() => {}), { authorize: async () => {} });
    const identity = { ...selectionIdentity, principalId: principal }, queries = new InventoryQueries(fixture.runtime, "synthetic-byte-short-list-cursor-secret");
    const selection = await queries.capture(identity, root.scopeId, { sortBy: "publisher" });
    let page = await queries.page(selection.id, identity, { limit: 100 });
    expect(page.value.length).toBeLessThan(60); expect(page.page.nextCursor).toBeTruthy();
    const ids = page.value.map(row => row.id);
    while (page.page.nextCursor) {
      const next = await queries.page(selection.id, identity, { limit: 100, cursor: page.page.nextCursor });
      const previous = await queries.page(selection.id, identity, { limit: page.value.length, cursor: next.page.previousCursor! });
      expect(previous.value.map(row => row.id)).toEqual(page.value.map(row => row.id));
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(1_048_576);
      ids.push(...next.value.map(row => row.id)); page = next;
    }
    expect(ids).toEqual(records.map(row => row.identity));
  });
  it("separates catalog/detail evidence, preserves empty child collections and bounds authenticated detail pages", async () => {
    const principal = randomUUID(), stream = new StreamedInventory(fixture.runtime);
    const value = { id: "one", displayName: "One", isBlocked: false, availableTo: "all", allowedUsersAndGroups: [],
      lastModifiedDateTime: new Date().toISOString(), manifestId: randomUUID(), version: "1",
      elementDetails: [{ elementType: "AgentMetadatas", elements: [] }] };
    const root = await store.execute(inventoryInput(principal), { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      await store.visit(lease, "one");
      await stream.packageObservation(lease, value, "catalog");
      await store.acceptPage(lease, { token: "one", nextToken: null, records: [value], rawCount: 1, expectedCount: 1, page: 1 }, 1);
    }, { authorize: async () => {} });
    const detail = await store.execute(inventoryInput(principal), { domain: "packages", mode: "delta", channel: "detail", targets: ["one"] }, async lease => {
      await stream.packageObservation(lease, { ...value, elementDetails: [{ elementType: "Custom",
        elements: Array.from({ length: 5 }, (_, index) => ({ id: String(index), definition: "x".repeat(180_000) })) }] }, "detail");
    }, { authorize: async () => {} });
    const client = await fixture.runtime.connect();
    try {
      await client.query("BEGIN; SET LOCAL jit=off; SET LOCAL enable_seqscan=off; SET LOCAL enable_nestloop=off");
      const member = (await client.query(`SELECT generation_id FROM inventory_memberships m WHERE ${inventoryAsOf()} AND identity='one'`,
        [detail.baselineId, detail.revision])).rows[0];
      const queries = vi.spyOn(client,"query");
      let statement: { sql: string;values: unknown[] } | undefined;
      let row: Awaited<ReturnType<typeof storedInventoryRecord>>;
      try {
        row = await storedInventoryRecord(client, member.generation_id, "one");
        statement = queries.mock.calls.flatMap(([sql,values]) => typeof sql==="string" && sql.includes("AS catalog_observed_at")
          ? [{ sql,values: values as unknown[] }] : [])[0];
      } finally { queries.mockRestore(); }
      expect(row!.catalog_generation).toBe(root.baselineId);
      expect(row!.detail_generation).toBe(member.generation_id);
      expect(row!.value.allowedUsersAndGroups).toEqual([]);
      expect(row!.catalog_observed_at).toBeInstanceOf(Date);
      expect(row!.detail_observed_at).toBeInstanceOf(Date);
      expect(statement?.sql.match(/LEFT JOIN LATERAL/g)).toHaveLength(2);
      const plan = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,WAL,SETTINGS,FORMAT JSON) ${statement!.sql}`,statement!.values)).rows[0]["QUERY PLAN"];
      const generations: Record<string,unknown>[] = [];
      const visit = (node: Record<string,unknown>) => {
        if (node["Relation Name"]==="data_generations") generations.push(node);
        for (const child of (node.Plans ?? []) as Record<string,unknown>[]) visit(child);
      };
      visit(plan[0].Plan);
      expect(generations).toHaveLength(2);
      for (const generation of generations) {
        expect(generation["Index Cond"]).toBeTruthy();
        expect(generation["Actual Rows"]).toBe(1);
      }
      process.stdout.write(JSON.stringify({ contract: "inventory-component-lineage-point-lookups",plan })+"\n");
    } finally { await client.query("ROLLBACK");client.release(); }
    const queries = new InventoryQueries(fixture.runtime, "synthetic-inventory-cursor-secret-32-bytes");
    const identity = { ...selectionIdentity, principalId: principal };
    const selected = await queries.capture(identity, root.scopeId);
    const first = await queries.children(selected.id, identity, "one", { kind: "element", limit: 5 });
    expect(first.value).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const next = await queries.children(selected.id, identity, "one", { kind: "element", cursor: first.nextCursor! });
    expect(next.value).toHaveLength(2);
    await expect(queries.children(selected.id, identity, "different", { kind: "element", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(restoreInventoryRecord(packageInventoryRecord(value).residual, packageInventoryRecord(value).facts, "packages").elementDetails)
      .toEqual(value.elementDetails);
  });
  it("matches every presentation view/filter and exposes every sort with deterministic cursor ties", async () => {
    const principal = randomUUID();
    const values = [
      { id: "a", displayName: "Écho", isBlocked: false, type: "FirstParty", availableTo: "all", publisher: "A", supportedHosts: ["teams"] },
      { id: "b", displayName: "Echo", isBlocked: true, type: "ThirdParty", availableTo: "none", publisher: "B" },
      { id: "c", displayName: "echo", isBlocked: false, type: "Custom", availableTo: "none", deployedTo: "none", platform: "Microsoft 365 Copilot Agent Builder" },
      { id: "d", displayName: "Unknown", isBlocked: false },
    ];
    const root = await store.execute(inventoryInput(principal), { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      await store.visit(lease, "all"); await store.append(lease, values.map(packageInventoryRecord));
      await store.acceptPage(lease, { token: "all", nextToken: null, records: values, rawCount: values.length, expectedCount: values.length, page: 1 }, values.length);
    }, { authorize: async () => {} });
    const queries = new InventoryQueries(fixture.runtime, "synthetic-inventory-cursor-secret-32-bytes");
    const identity = { ...selectionIdentity, principalId: principal };
    const records = buildRecords(values, [], resolvePackageAgentLinks(identity.tenantId, values, []), null, null);
    for (const view of ["all", "first_party", "third_party", "user_managed", "copilot_studio", "organization_managed",
      "available", "unavailable", "availability_unknown", "organization", "used", "unknown"] as const) {
      const selected = await queries.capture(identity, root.scopeId, { view });
      const page = await queries.page(selected.id, identity);
      expect(page.counts.filtered, view).toBe(records.filter(record => matchesAgentView(record, view)).length);
      expect(page.counts.total).toBe(4);
      await queries.selections.invalidate(selected.id, identity);
    }
    for (const view of ["all", "organization", "unknown", "first_party"] as const) {
      for (const relevance of ["all", "organization", "unknown"] as const) {
        const selected = await queries.capture(identity, root.scopeId, { view, relevance });
        const page = await queries.page(selected.id, identity);
        expect(page.value.map(row => row.id).sort(), `${view}/${relevance}`).toEqual(records
          .filter(record => matchesAgentView(record, view) && matchesAgentView(record, relevance))
          .flatMap(record => record.packages.map(value => value.id)).sort());
        await queries.selections.invalidate(selected.id, identity);
      }
    }
    for (const sortBy of unifiedAgentSortKeys) {
      const selected = await queries.capture(identity, root.scopeId, { sortBy });
      const page = await queries.page(selected.id, identity, { limit: 2 });
      expect(page.value).toHaveLength(2);
      expect(page.value[0].columns).toHaveProperty(sortBy);
      const next = await queries.page(selected.id, identity, { limit: 2, cursor: page.page.nextCursor! });
      expect(new Set([...page.value, ...next.value].map(row => row.id)).size).toBe(4);
      const previous = await queries.page(selected.id, identity, { limit: 2, cursor: next.page.previousCursor! });
      expect(previous.value).toEqual(page.value);
      await queries.selections.invalidate(selected.id, identity);
    }
    const selected = await queries.capture(identity, root.scopeId);
    const facet = await queries.facets(selected.id, identity, "publisher", { limit: 1 });
    expect(facet.total).toBe(3);
    expect((await queries.facets(selected.id, identity, "publisher", { cursor: facet.nextCursor! })).value).toHaveLength(2);
  }, 30_000);
  it("publishes 5001 scoped Power Platform records with durable complete page evidence inside the fixed RAM budget", async () => {
    const input = inventoryInput(randomUUID(), "power_platform");
    input.scope.tenantId = randomUUID();
    input.reserveBytes = 64 * 1024 ** 2;
    const environmentId = randomUUID();
    const botId = (index: number) => `11111111-1111-4111-8111-${index.toString(16).padStart(12, "0")}`;
    const types = ["microsoft.copilotstudio/agents"] as const;
    input.scope.selector = inventorySelector({ domain: "power_platform", environmentId, resourceTypes: types });
    const provider = new PowerPlatformResourceQueryClient(async (_url, init) => {
      const offset = Number(JSON.parse(String(init!.body)).Options.SkipToken ?? 0), count = Math.min(100, 5001 - offset);
      return Response.json({ totalRecords: 5001, count, resultTruncated: offset + count < 5001,
        skipToken: offset + count < 5001 ? String(offset + count) : undefined,
        data: Array.from({ length: count }, (_, index) => ({ tenantId: input.scope.tenantId, name: `native-${offset + index}`,
          type: types[0], properties: { environmentId, botId: botId(offset + index) } })) });
    });
    const stream = new StreamedInventory(fixture.runtime, undefined, provider);
    const root = await stream.powerPlatformCatalog(input, "synthetic", types, { environmentId, authorize: async () => {} });
    expect(root.inserted).toBe(5001);
    const counts = (await fixture.runtime.query(`SELECT count(*)::int AS pages,sum(raw_count)::int AS raw,sum(unique_count)::int AS unique,
      bool_and(accepted)::boolean AS accepted FROM inventory_pages WHERE generation_id=$1`, [root.baselineId])).rows[0];
    expect(counts).toEqual({ pages: 51, raw: 5001, unique: 5001, accepted: true });
    const maximum = stream.stages.maximumParameterBytes;
    expect(maximum).toBeLessThanOrEqual(1_048_576);
    const graphRecord = packageInventoryRecord({ id: "indexed-probe", displayName: "Probe", isBlocked: false,
      elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "identity",
        definition: JSON.stringify({ SourceIds: { EnvironmentId: environmentId, CdsBotId: botId(17) } }) }] }] });
    const graph = await store.execute({ ...input, jobId: randomUUID(),
      scope: { ...input.scope, source: "inventory_packages", selector: "complete" } },
    { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      await store.visit(lease, "one"); await store.appendBounded(lease, [graphRecord]);
      await store.acceptPage(lease, { token: "one", nextToken: null, records: [graphRecord], rawCount: 1, expectedCount: 1, page: 1 }, 1);
    }, { authorize: async () => {} });
    const matchSql = `SELECT other.identity FROM inventory_facts own JOIN inventory_facts other
      ON other.scope_id=$4 AND other.kind=own.kind AND other.value=own.value
      JOIN inventory_memberships m ON m.generation_id=other.generation_id AND m.identity=other.identity
      WHERE own.generation_id=$3 AND own.identity='indexed-probe' AND own.kind LIKE 'match:%' AND other.kind LIKE 'match:%' AND ${inventoryAsOf()}`;
    const values = [root.baselineId, root.revision, graph.baselineId, root.scopeId];
    const matches = (await fixture.runtime.query(matchSql, values)).rows;
    expect(matches).toHaveLength(1);
    const freshPlan = (await fixture.runtime.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${matchSql}`, values)).rows[0];
    await fixture.operator.query("ANALYZE inventory_facts; ANALYZE inventory_memberships");
    const analyzedPlan = (await fixture.runtime.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${matchSql}`, values)).rows[0];
    expect(JSON.stringify(analyzedPlan)).toContain("inventory_fact_match");
    process.stdout.write("INVENTORY_SCOPED_STREAM_PROOF " + JSON.stringify({ rows: root.inserted, ...counts, maximumBindBytes: maximum,
      candidateRows: matches.length, candidateResponseBytes: Buffer.byteLength(JSON.stringify(matches)), freshPlan, analyzedPlan }) + "\n");
  }, 60_000);
  it("keeps application exact-only visibility separate, rejects oversized exact responses, and never resurrects cleared rows", async () => {
    const principal = randomUUID(), input = inventoryInput(principal);
    input.scope.tokenMode = "application";
    await fixture.operator.query(`INSERT INTO capability_configuration(tenant_id,capability_id,enabled,shared_data_scope,updated_by)
      VALUES($1,'graph.package.read.application',true,true,$2) ON CONFLICT(tenant_id,capability_id)
      DO UPDATE SET enabled=true,shared_data_scope=true`, [input.scope.tenantId, principal]);
    const records = Array.from({ length: 20 }, (_, index) => packageInventoryRecord({ id: `wide-${index}`, displayName: `Wide ${index}`,
      isBlocked: false, longDescription: "x".repeat(32768) }));
    const root = await store.execute(input, { domain: "packages", mode: "delta", channel: "exact", targets: records.map(row => row.native_id) },
      lease => store.appendBounded(lease, records), { authorize: async () => {} });
    const identity = { ...selectionIdentity, principalId: principal };
    const queries = new InventoryQueries(fixture.runtime, "synthetic-inventory-cursor-secret-32-bytes", 7,
      { tenantId: input.scope.tenantId, principalId: principal });
    await expect(queries.capture(identity, root.scopeId)).rejects.toMatchObject({ code: "selection_invalidated" });
    const selected = await queries.capture(identity, root.scopeId, {}, "application");
    expect((await queries.page(selected.id, identity)).partial).toBe(true);
    await expect(queries.exact(selected.id, identity, records.map(row => row.native_id))).rejects.toMatchObject({ code: "inventory_exact_bytes" });
    expect(await queries.exact(selected.id, identity, ["wide-0"])).toHaveLength(1);
    await expect(queries.currentControl(selected.id, identity, "wide-0", async () => true)).rejects.toMatchObject({ code: "selection_invalidated" });
    await store.clear(root.scopeId, root.tenantId);
    const replacement = await store.execute({ ...input, jobId: randomUUID() }, { domain: "packages", mode: "delta", channel: "exact", targets: ["wide-0"] },
      lease => store.appendBounded(lease, [records[0]]), { authorize: async () => {} });
    expect(replacement.baselineId).not.toBe(root.baselineId);
    const fresh = await queries.capture(identity, root.scopeId, {}, "application");
    expect((await queries.page(fresh.id, identity)).counts.total).toBe(1);
  });
  it("enforces stored presentation byte bounds and maximum-size facet cursors", async () => {
    const input = inventoryInput(randomUUID());
    input.reserveBytes = 64 * 1024 ** 2;
    const records = Array.from({ length: 100 }, (_, index) => packageInventoryRecord({
      id: `facet-${index}`, displayName: `Agent ${index}`, isBlocked: false,
      publisher: `${String(index).padStart(3, "0")}${"界".repeat(4093)}`,
    }));
    records[0].facts.push(
      { kind: "column:shortDescription", value: "", text_value: "x".repeat(262144), payload: {} },
      { kind: "column:longDescription", value: "", text_value: "x".repeat(262144), payload: {} },
    );
    const root = await store.execute(input, { domain: "packages", mode: "delta", channel: "exact", targets: records.map(row => row.native_id) },
      lease => store.appendBounded(lease, records).then(() => {}), { authorize: async () => {} });
    const identity = { ...selectionIdentity, principalId: input.scope.principalId! };
    const queries = new InventoryQueries(fixture.runtime, "synthetic-inventory-cursor-secret-32-bytes");
    const selected = await queries.capture(identity, root.scopeId);
    await expect(queries.page(selected.id, identity)).rejects.toMatchObject({ code: "inventory_page_record_bytes" });
    const first = await queries.facets(selected.id, identity, "publisher", { limit: 100 });
    expect(first.nextCursor).toBeTruthy();
    expect(first.value.length).toBeLessThan(100);
    const values = first.value.map(row => row.value);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await queries.facets(selected.id, identity, "publisher", { limit: 100, cursor });
      expect(Buffer.byteLength(JSON.stringify(page.value))).toBeLessThanOrEqual(524288);
      values.push(...page.value.map(row => row.value)); cursor = page.nextCursor;
    }
    expect(values).toEqual(records.map(row => row.publisher));
  });
  it("projects only verified stored control readback and fences old selections without cloning other keys", async () => {
    const principal = randomUUID(), root = await inventoryBaseline(store, principal, 20);
    const queries = new InventoryQueries(fixture.runtime, "synthetic-inventory-cursor-secret-32-bytes");
    const identity = { ...selectionIdentity, principalId: principal }, old = await queries.capture(identity, root.scopeId);
    const value = allowlistedPackage({ id: "package-000001", displayName: "Agent 1", isBlocked: true });
    const client = await fixture.runtime.connect();
    try {
      await client.query("BEGIN");
      await publishPackageReadback({ tenantId: root.tenantId, principalId: principal }, value, client, null, capturePackageMutationState(value, "block"));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    await expect(queries.page(old.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    const stream = new StreamedInventory(fixture.runtime);
    const updated = await stream.controlReadback(inventoryInput(principal), value.id, { authorize: async () => {} });
    expect(updated).toMatchObject({ baselineId: root.baselineId, inserted: 1, closed: 1, changed: 1 });
    await expect(queries.page(old.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    const current = await queries.capture(identity, root.scopeId);
    expect((await queries.exact(current.id, identity, [value.id]))[0].residual.isBlocked).toBe(true);
    expect((await queries.page(current.id, identity)).counts.total).toBe(20);
  });
  it.each(["exact", "guid_case"])("rejects %s native identities across streamed pages and preserves the prior complete head", async mode => {
    const input = inventoryInput(randomUUID(), "power_platform");
    const environmentId = randomUUID(), types = ["microsoft.copilotstudio/agents"] as const;
    input.scope.selector = inventorySelector({ domain: "power_platform", environmentId, resourceTypes: types });
    let duplicate = false;
    const nativeId = mode === "guid_case" ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "Opaque-A";
    const provider = new PowerPlatformResourceQueryClient(async (_url, init) => {
      const second = Boolean(JSON.parse(String(init!.body)).Options.SkipToken);
      return Response.json({ totalRecords: duplicate ? 2 : 1, count: 1,
        resultTruncated: duplicate && !second, ...(duplicate && !second ? { skipToken: "next" } : {}),
        data: [{ tenantId: input.scope.tenantId, name: second && mode === "guid_case" ? nativeId.toUpperCase() : nativeId,
          type: types[0], properties: { environmentId } }] });
    });
    const stream = new StreamedInventory(fixture.runtime, undefined, provider);
    const root = await stream.powerPlatformCatalog(input, "synthetic", types, { environmentId, authorize: async () => {} });
    duplicate = true;
    const attempt = { ...input, jobId: randomUUID() };
    await expect(stream.powerPlatformCatalog(attempt, "synthetic", types, { environmentId, authorize: async () => {} }))
      .rejects.toMatchObject({ code: "23505" });
    expect((await fixture.runtime.query(`SELECT baseline_id,revision,row_count FROM inventory_roots
      WHERE scope_id=$1 AND tenant_id=$2 AND current`, [root.scopeId, input.scope.tenantId])).rows)
      .toEqual([{ baseline_id: root.baselineId, revision: root.revision, row_count: 1 }]);
    expect((await fixture.runtime.query("SELECT state FROM data_generations WHERE job_id=$1", [attempt.jobId])).rows)
      .toEqual([{ state: "failed" }]);
  });
  it("rejects repeated tokens, partial counts, duplicate identities and late writes after clear", async () => {
    await expect(store.execute(inventoryInput(), { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      await store.visit(lease, "one");
      await store.acceptPage(lease, { token: "one", nextToken: "one", records: [], rawCount: 0, expectedCount: null, page: 1 }, 0);
      await store.visit(lease, "one");
    }, { authorize: async () => {} })).rejects.toMatchObject({ code: "23505" });
    await expect(store.execute(inventoryInput(), { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      await store.visit(lease, "one");
      await store.append(lease, [packageRecord(0)]);
      await store.acceptPage(lease, { token: "one", nextToken: null, records: [packageRecord(0)], rawCount: 1, expectedCount: 2, page: 1 }, 1);
    }, { authorize: async () => {} })).rejects.toThrow("inventory_incomplete");
    await expect(store.execute(inventoryInput(), { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      await store.append(lease, [packageRecord(0), packageRecord(0)]);
    }, { authorize: async () => {} })).rejects.toMatchObject({ code: "23505" });
    await expect(store.execute(inventoryInput(), { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      await store.generations.invalidate(lease.scopeId, lease.tenantId);
      await store.append(lease, [packageRecord(0)]);
    }, { authorize: async () => {} })).rejects.toThrow("data_writer_fenced");
  });
});
