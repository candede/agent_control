import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventoryBaseline, inventoryDelta, inventoryInput, streamedPackageFixture } from "../../scripts/inventoryFixtures.js";
import { InventoryGenerations, inventoryAsOf, inventorySelector } from "../db/inventoryGenerations.js";
import { InventoryReconciliation } from "./inventoryReconciliation.js";
import { packageInventoryRecord, powerPlatformInventoryRecord, restoreInventoryRecord, type InventoryRecord } from "./inventoryRecordProjection.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { pendingInventoryIdentityExpirySql } from "../db/inventoryIdentityExpiry.js";
import { selectionIdentity, officialGoldenCsvRows } from "../../scripts/largeTenantFixtures.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { schemaRegistry } from "./officialReportFields.js";
import { NativeInventory } from "../db/nativeInventory.js";
import { InventoryRuntime } from "./inventoryRuntime.js";
import { publishPackageReadback } from "../db/packageControls.js";
import { capturePackageMutationState } from "./packageMutationState.js";
import { allowlistedPackage } from "./packageObservation.js";
import { DataSyncRepository } from "../db/dataSync.js";
import { StreamedInventory } from "./streamedInventory.js";
import { readAutomaticInventoryRevisions } from "../db/inventoryAutomaticRevisions.js";
import { checkpointQueries, observePeakMemory, observeQueryWork } from "./peakMemory.js";
import { inventoryReconciliationAdmissionSql, verifyInventoryReconciliationAdmissionSchema } from "../db/inventoryReconciliationAdmissionSchema.js";

describe("durable bounded reconciliation", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  let sources: InventoryGenerations;
  let reconcile: InventoryReconciliation;
  beforeAll(async () => {
    fixture = await testDatabase(); sources = new InventoryGenerations(fixture.runtime); reconcile = new InventoryReconciliation(fixture.runtime);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  it("fails readiness when the admission index is missing or excludes pending work", async () => {
    const client = await fixture.operator.connect();
    try {
      await client.query("BEGIN");
      await client.query("DROP INDEX inventory_reconciliation_tenant_admission");
      await expect(verifyInventoryReconciliationAdmissionSchema(client)).rejects.toThrow("inventory_reconciliation_admission_schema");
      await client.query(`CREATE INDEX inventory_reconciliation_tenant_admission ON inventory_reconciliation(tenant_id)
        WHERE active_id IS NOT NULL`);
      await expect(verifyInventoryReconciliationAdmissionSchema(client)).rejects.toThrow("inventory_reconciliation_admission_schema");
    } finally { await client.query("ROLLBACK");client.release(); }
    await verifyInventoryReconciliationAdmissionSchema(fixture.runtime);
  });
  it("seeks scoped pending admission while retaining the exact twenty/plus-one queue bound", async () => {
    const tenantId = randomUUID();
    await verifyInventoryReconciliationAdmissionSchema(fixture.runtime);
    for (let index=0;index<21;index++) {
      const principalId = randomUUID();
      const root = await streamedPackageFixture(fixture.runtime,{ tenantId,principalId },[
        { id: "admission-package",displayName: "Admission package",isBlocked: false },
      ]);
      const input = inventoryInput(principalId,"canonical");
      input.scope.tenantId = tenantId;
      if (index<20) await expect(reconcile.request(input,[root])).resolves.toBeDefined();
      else await expect(reconcile.request(input,[root])).rejects.toMatchObject({ code: "inventory_queue_admission" });
    }
    await sources.generations.connections.run(async client => {
      await client.query("SET LOCAL enable_seqscan=off; SET LOCAL jit=off");
      expect((await client.query(inventoryReconciliationAdmissionSql,[tenantId,randomUUID()])).rows[0].count).toBe(20);
      const plan = (await client.query(`EXPLAIN(ANALYZE,BUFFERS,WAL,SETTINGS,FORMAT JSON) ${inventoryReconciliationAdmissionSql}`,
        [tenantId,randomUUID()])).rows;
      expect(JSON.stringify(plan)).toContain("inventory_reconciliation_tenant_admission");
      process.stdout.write(JSON.stringify({ contract: "inventory-scoped-admission-plan",admitted: 20,rejected: 21,plan })+"\n");
    });
  }, 30_000);
  const environment = "11111111-1111-4111-8111-111111111111";
  const bot = "22222222-2222-4222-8222-222222222222";
  const native = (id: string, identifiers: PowerPlatformResource["identifiers"] = [{ kind: "cds_bot_id", value: bot }],
    details: PowerPlatformResource["details"] = {}) => powerPlatformInventoryRecord({
    tenantId: "synthetic-tenant", nativeId: id, type: "microsoft.copilotstudio/agents", location: null, displayName: id,
    environmentId: environment, createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform",
    authoringTool: "Copilot Studio", creatorType: "unknown", agentKind: "copilot_studio_agent", lifecycle: "published",
    identityConfidence: "exact_native", identifiers, provenance: {}, details, unknownFieldCount: 0,
  });
  const packaged = (id: string, linked = true) => packageInventoryRecord({ id, displayName: id, isBlocked: false,
    ...(linked ? { elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "identity",
      definition: JSON.stringify({ SourceIds: { EnvironmentId: environment, CdsBotId: bot } }) }] }] } : {}) });
  it("bounds orphan control cleanup without attempting publication from an expired or missing baseline", async () => {
    const principalId = randomUUID(), scope = { tenantId: "synthetic-tenant", principalId };
    const client = await fixture.runtime.connect();
    try {
      await client.query("BEGIN");
      for (let index = 0; index < 251; index++) {
        const detail = allowlistedPackage({ id: `orphan-${index}`, displayName: `Orphan ${index}`, isBlocked: true });
        await publishPackageReadback(scope, detail, client, null, capturePackageMutationState(detail, "block"));
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    const runtime = new InventoryRuntime(fixture.runtime);
    const pending = async () => (await fixture.runtime.query(`SELECT count(*)::int AS count
      FROM inventory_control_pending WHERE tenant_id=$1 AND principal_id=$2`, [scope.tenantId, principalId])).rows[0].count;
    expect(await pending()).toBe(251);
    await expect(runtime.publishControls(scope)).resolves.toBe(0);
    expect(await pending()).toBe(1);
    await expect(runtime.publishControls(scope)).resolves.toBe(0);
    expect(await pending()).toBe(0);
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM data_generations g
      JOIN data_scope_epochs s ON s.id=g.scope_id WHERE s.principal_id=$1`,
      [principalId])).rows[0].count).toBe(0);
  });
  async function publish(principal: string, domain: "packages" | "power_platform", records: InventoryRecord[], delta = false) {
    const input = inventoryInput(principal, domain);
    const intent = { domain, mode: delta ? "delta" as const : "baseline" as const, channel: delta ? "exact" as const : "catalog" as const,
      ...(domain === "power_platform" ? { resourceTypes: ["microsoft.copilotstudio/agents"], environmentId: environment } : {}),
      ...(delta ? { targets: records.map(row => row.native_id) } : {}) };
    input.scope.selector = inventorySelector(intent);
    return sources.execute(input, intent, async lease => {
      if (!delta) await sources.visit(lease, "all");
      await sources.appendBounded(lease, records);
      if (!delta) await sources.acceptPage(lease, { token: "all", nextToken: null, records, rawCount: records.length, expectedCount: records.length, page: 1 }, records.length);
    }, { authorize: async () => {} });
  }
  it("rebuilds changed baselines without a duplicate per-key change log and still journals deltas",async () => {
    const principal = randomUUID(),input = inventoryInput(principal,"canonical");
    let graph = await publish(principal,"packages",[packaged("baseline-a",false),packaged("baseline-b",false)]);
    await reconcile.request(input,[graph]);
    let canonical = (await reconcile.runNext(input,async () => {}))!;
    const changes = async (scope: string) => (await fixture.runtime.query(
      "SELECT count(*)::int AS count FROM inventory_changes WHERE scope_id=$1",[scope])).rows[0].count;
    expect(canonical.changed).toBe(2);
    expect(await changes(graph.scopeId)).toBe(0);
    expect(await changes(canonical.scopeId)).toBe(0);
    graph = await publish(principal,"packages",[packageInventoryRecord({
      id: "baseline-a",displayName: "Changed",isBlocked: true,
    })],true);
    expect(graph.changed).toBe(1);
    expect(await changes(graph.scopeId)).toBe(1);
    await reconcile.request(input,[graph]);
    await reconcile.runNext(input,async () => {});
    graph = await publish(principal,"packages",[packaged("baseline-c",false)]);
    await reconcile.request(input,[graph]);
    const replacement = (await reconcile.runNext(input,async () => {}))!;
    expect(replacement.baselineId).not.toBe(canonical.baselineId);
    expect((await fixture.runtime.query(`SELECT row_count FROM inventory_roots WHERE baseline_id=$1`,
      [replacement.baselineId])).rows[0].row_count).toBe(1);
    expect((await fixture.runtime.query(`SELECT source_identity FROM unified_agent_memberships member
      JOIN inventory_memberships current ON current.generation_id=member.generation_id AND current.identity=member.identity
      WHERE current.baseline_id=$1 AND current.valid_to_revision IS NULL`,[replacement.baselineId])).rows)
      .toEqual([{ source_identity: "baseline-c" }]);
  });
  it("keeps cold-statistics pair probes keyed by source record and exact scoped match", async () => {
    const principal = randomUUID(), input = inventoryInput(principal, "canonical");
    const graph = await publish(principal, "packages", [packaged("point-package")]);
    const nativeRoot = await publish(principal, "power_platform", [native("point-native")]);
    let captured: { sql: string; parameters?: unknown[] } | undefined;
    observePeakMemory(() => {});
    fixture.runtime.on("acquire",checkpointQueries);
    observeQueryWork(value => {
      if (value.sql.includes("FROM seeds seed JOIN roots own")) captured = value;
    });
    try {
      await reconcile.request(input, [graph,nativeRoot]);
      const result = await reconcile.runNext(input,async () => {});
      expect(result?.inserted).toBe(1);
    } finally {
      fixture.runtime.removeListener("acquire",checkpointQueries);
      observeQueryWork(); observePeakMemory();
    }
    expect(captured).toBeDefined();
    const plan = (await fixture.runtime.query("EXPLAIN (FORMAT JSON) "+captured!.sql,captured!.parameters)).rows[0]["QUERY PLAN"][0].Plan;
    type PlanNode = { "Relation Name"?: string; Alias?: string; "Index Cond"?: string; "Recheck Cond"?: string; Filter?: string; Plans?: PlanNode[] };
    const scans: PlanNode[] = [];
    const visit = (node: PlanNode) => {
      if (node["Relation Name"]==="inventory_facts") scans.push(node);
      for (const child of node.Plans ?? []) visit(child);
    };
    visit(plan);
    const own = scans.filter(node => node.Alias?.startsWith("inventory_facts"));
    const matches = scans.filter(node => node.Alias?.startsWith("other"));
    expect(own.length).toBeGreaterThan(0); expect(matches.length).toBeGreaterThan(0);
    for (const node of own) {
      const predicate = [node["Index Cond"],node["Recheck Cond"],node.Filter].join(" ");
      expect(predicate).toContain("generation_id"); expect(predicate).toContain("identity");
      expect(predicate).not.toContain("match:%");
    }
    for (const node of matches) {
      const predicate = [node["Index Cond"],node["Recheck Cond"],node.Filter].join(" ");
      for (const field of ["scope_id","kind","value"]) expect(predicate).toContain(field);
    }
  });
  it("coalesces only newly changed keys instead of recopying the growing pending range", async () => {
    const principal = randomUUID(), input = inventoryInput(principal, "canonical");
    const baseline = await inventoryBaseline(sources, principal, 100);
    await reconcile.request(input, [baseline]); await reconcile.runNext(input, async () => {});
    const update = async (batch: number) => publish(principal, "packages",
      Array.from({ length: 20 }, (_, index) => {
        const number = batch * 20 + index;
        return packageInventoryRecord({ id: `package-${String(number).padStart(6, "0")}`,
          displayName: `Changed batch ${batch} row ${index}`, isBlocked: false });
      }), true);
    const activeRoot = await update(0);
    const requested = await reconcile.request(input, [activeRoot]);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    let paused = false;
    const active = reconcile.runNext(input, async () => {
      if (!paused) { paused = true; started(); await gate; }
    });
    await entered;
    try {
      for (let batch = 1; batch <= 3; batch++) await reconcile.request(input, [await update(batch)]);
      const counts = (await fixture.runtime.query(`SELECT sequence,count(*)::int AS rows
        FROM inventory_reconciliation_keys keys JOIN inventory_reconciliation work ON work.scope_id=keys.scope_id
        WHERE work.scope_id=$1 AND keys.sequence>work.active_sequence GROUP BY sequence ORDER BY sequence`, [requested.scopeId])).rows;
      expect(counts.map(row => row.rows)).toEqual([20, 20, 20]);
    } finally { release(); await active; }
    const next = await reconcile.runNext(input, async () => {});
    expect(next).not.toBeNull();
  }, 30_000);
  it("resolves native controls only from the current private canonical vector, never a historical selection", async () => {
    const principal = randomUUID(), input = inventoryInput(principal, "canonical");
    const inventory = new NativeInventory(fixture.runtime), scope = { tenantId: "synthetic-tenant", principalId: principal };
    const identifiers: PowerPlatformResource["identifiers"] = [{ kind: "environment_id", value: environment }, { kind: "cds_bot_id", value: bot }];
    const first = await publish(principal, "power_platform", [native("exact-native", identifiers, { isQuarantined: false })]);
    await expect(inventory.resolveQuarantineTargets(scope, first.baselineId, ["exact-native"])).rejects.toMatchObject({ code: "quarantine_target_unavailable" });
    await reconcile.request(input, [first]);
    const canonical = (await reconcile.runNext(input, async () => {}))!;
    const queries = new InventoryQueries(fixture.runtime, "synthetic-native-control-cursor-key-32-bytes");
    const identity = { ...selectionIdentity, principalId: principal };
    const pin = await queries.capture(identity, canonical.scopeId);
    const target = (await inventory.resolveQuarantineTargets(scope, first.baselineId, ["exact-native"]))[0];
    expect(target).toMatchObject({ resourceNativeId: "exact-native", environmentId: environment, botId: bot, inventoryQuarantineState: false });
    await expect(inventory.resolveQuarantineTargets({ ...scope, principalId: randomUUID() }, first.baselineId, ["exact-native"]))
      .rejects.toMatchObject({ code: "quarantine_target_unavailable" });
    const next = await publish(principal, "power_platform", [native("exact-native", identifiers, { isQuarantined: true })]);
    await expect(inventory.resolveQuarantineTargets(scope, first.baselineId, ["exact-native"])).rejects.toMatchObject({ code: "quarantine_target_unavailable" });
    expect((await queries.page(pin.id, identity)).counts.filtered).toBe(1);
    await reconcile.request(input, [next]);
    await reconcile.runNext(input, async () => {});
    await expect(inventory.resolveQuarantineTargets(scope, first.baselineId, ["exact-native"])).rejects.toMatchObject({ code: "quarantine_target_unavailable" });
    expect((await inventory.resolveQuarantineTargets(scope, next.baselineId, ["exact-native"]))[0].inventoryQuarantineState).toBe(true);
  });
  it("does not guess a quarantine bot ID from an otherwise valid native GUID", async () => {
    const principal = randomUUID(), input = inventoryInput(principal, "canonical");
    const root = await publish(principal, "power_platform", [native(bot, [{ kind: "environment_id", value: environment }])]);
    await reconcile.request(input, [root]); await reconcile.runNext(input, async () => {});
    await expect(new NativeInventory(fixture.runtime).resolveQuarantineTargets(
      { tenantId: "synthetic-tenant", principalId: principal }, root.baselineId, [bot]))
      .rejects.toMatchObject({ code: "quarantine_native_identity_unavailable" });
  });
  it("fences and recovers verified native readback off GET, without treating status-cache observations as publications", async () => {
    const principal = randomUUID(), input = inventoryInput(principal, "canonical");
    const scope = { tenantId: "synthetic-tenant", principalId: principal };
    const identifiers: PowerPlatformResource["identifiers"] = [{ kind: "environment_id", value: environment }, { kind: "cds_bot_id", value: bot }];
    const source = await publish(principal, "power_platform", [native("native-readback", identifiers, { isQuarantined: false })]);
    await reconcile.request(input, [source]);
    const canonical = (await reconcile.runNext(input, async () => {}))!;
    const queries = new InventoryQueries(fixture.runtime, "synthetic-native-readback-cursor-key-32-bytes");
    const identity = { ...selectionIdentity, principalId: principal };
    const pin = await queries.capture(identity, canonical.scopeId);
    const originalAgentId = (await queries.page(pin.id, identity)).value[0].id;
    const observe = async (verified: boolean, state = true) => {
      const id = randomUUID();
      await fixture.runtime.query(`INSERT INTO copilot_quarantine_status_observations
        (id,tenant_id,principal_id,resource_native_id,environment_id,bot_id,is_bot_quarantined,provider_updated_at,observed_at,correlation_id,verified_readback)
        VALUES($1,$2,$3,'native-readback',$4,$5,$6,$7,clock_timestamp(),$8,$9)`,
      [id, scope.tenantId, principal, environment, bot, state, new Date().toISOString(), randomUUID(), verified]);
    };
    const nativeInventory = new NativeInventory(fixture.runtime);
    await observe(false);
    expect((await nativeInventory.resolveQuarantineTargets(scope, source.baselineId, ["native-readback"]))[0].inventoryQuarantineState).toBe(false);
    expect((await queries.page(pin.id, identity)).counts.filtered).toBe(1);
    await observe(true);
    await expect(queries.page(pin.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    await expect(nativeInventory.resolveQuarantineTargets(scope, source.baselineId, ["native-readback"])).rejects.toMatchObject({ code: "quarantine_target_unavailable" });
    const runtime = new InventoryRuntime(fixture.runtime, async () => {});
    expect(await runtime.enqueue(scope)).toBe(false);
    await sources.gcMetadata(source.scopeId, scope.tenantId);
    await sources.gc(source);
    await sources.gcMetadata(canonical.scopeId, scope.tenantId);
    await expect(queries.page(pin.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    expect(await runtime.publishNativeControls(scope)).toBe(1);
    await sources.gcMetadata(canonical.scopeId, scope.tenantId);
    expect(await runtime.enqueue(scope)).toBe(true);
    await reconcile.runNext(input, async () => {});
    const latest = (await fixture.runtime.query(`SELECT revision.generation_id FROM inventory_roots root
      JOIN inventory_revisions revision ON revision.scope_id=root.scope_id AND revision.revision=root.revision WHERE root.scope_id=$1 AND root.current`,
    [source.scopeId])).rows[0].generation_id;
    expect((await nativeInventory.resolveQuarantineTargets(scope, latest, ["native-readback"]))[0].inventoryQuarantineState).toBe(true);
    const refreshed = await queries.capture(identity, canonical.scopeId);
    expect((await queries.page(refreshed.id, identity)).value[0].id).toBe(originalAgentId);
    await observe(false, false);
    expect((await nativeInventory.resolveQuarantineTargets(scope, latest, ["native-readback"]))[0].inventoryQuarantineState).toBe(true);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM inventory_native_control_pending WHERE principal_id=$1", [principal])).rows[0].count).toBe(0);
  });
  it("publishes and independently pages five thousand legal child definitions without loading them into canonical work", async () => {
    const principal = randomUUID(), input = inventoryInput(principal, "canonical");
    const value = { id: "wide-children", displayName: "Wide children", isBlocked: false,
      identityDetailsCollected: true, version: "1", manifestId: bot, lastModifiedDateTime: new Date().toISOString(),
      detailFreshness: { state: "fresh" as const, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      elementDetails: Array.from({ length: 50 }, (_, group) => ({ elementType: `PublishedContent${group}`,
        elements: Array.from({ length: 100 }, (_, index) => ({
          id: `child-${String(group * 100 + index).padStart(5, "0")}`,
          definition: JSON.stringify({ description: `${group * 100 + index}:${"x".repeat(256)}` }),
        })) })) };
    const record = packageInventoryRecord(value);
    expect(Buffer.byteLength(JSON.stringify(record.facts))).toBeGreaterThan(1_048_576);
    const source = await publish(principal, "packages", [record]);
    await reconcile.request(input, [source]);
    const canonical = (await reconcile.runNext(input, async () => {}))!;
    const queries = new InventoryQueries(fixture.runtime, "synthetic-high-fanout-cursor-secret-32-bytes");
    const identity = { ...selectionIdentity, principalId: principal };
    const pin = await queries.capture(identity, canonical.scopeId);
    const page = await queries.page(pin.id, identity);
    expect(page.counts.filtered).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1_048_576);
    const member = (await queries.members(pin.id, identity, page.value[0].id)).value[0];
    let cursor: string | undefined, total = 0;
    do {
      const children = await queries.children(pin.id, identity, page.value[0].id, {
        sourceScopeId: member.source_scope_id, sourceIdentity: member.source_identity, kind: "element", limit: 100, cursor,
      });
      expect(children.total).toBe(5000);
      expect(children.value.length).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(JSON.stringify(children))).toBeLessThan(524288);
      for (const child of children.value) {
        expect(child.payload.id).toBe(`child-${String(total++).padStart(5, "0")}`);
        expect(JSON.parse(String(child.payload.definition)).description).toBe(`${total - 1}:${"x".repeat(256)}`);
      }
      cursor = children.nextCursor ?? undefined;
    } while (cursor);
    expect(total).toBe(5000);
    const blocked = allowlistedPackage({ id: "wide-children", displayName: "Wide children", isBlocked: true });
    await sources.generations.connections.run(client => publishPackageReadback(
      { tenantId: source.tenantId, principalId: principal }, blocked, client, null, capturePackageMutationState(blocked, "block")));
    const runtime = new InventoryRuntime(fixture.runtime, async () => {});
    await sources.gcMetadata(source.scopeId, source.tenantId);
    await sources.gc(source);
    await expect(queries.page(pin.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    expect(await runtime.publishControls({ tenantId: source.tenantId, principalId: principal })).toBe(1);
    const refreshed = (await fixture.runtime.query(`SELECT r.generation_id,r.residual FROM inventory_roots root
      JOIN inventory_memberships m ON m.baseline_id=root.baseline_id AND m.valid_from_revision<=root.revision
        AND (m.valid_to_revision IS NULL OR m.valid_to_revision>root.revision)
      JOIN package_record_rows r ON r.generation_id=m.generation_id AND r.identity=m.identity
      WHERE root.scope_id=$1 AND root.current AND r.native_id='wide-children'`, [source.scopeId])).rows[0];
    expect(refreshed.residual.isBlocked).toBe(true);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM inventory_facts WHERE generation_id=$1 AND kind='element'",
      [refreshed.generation_id])).rows[0].count).toBe(5000);
    const streamed = new StreamedInventory(fixture.runtime);
    for (const channel of ["catalog", "exact", "detail"] as const) {
      const baseline = channel === "catalog", fresh = { ...value, isBlocked: true };
      if (baseline) delete (fresh as Partial<typeof fresh>).elementDetails;
      const next = await sources.execute(inventoryInput(principal, "packages"), {
        domain: "packages", mode: baseline ? "baseline" : "delta", channel, ...(baseline ? {} : { targets: [value.id] }),
      }, async lease => {
        if (baseline) await sources.visit(lease, "catalog");
        await streamed.packageObservation(lease, fresh, channel);
        if (baseline) await sources.acceptPage(lease, { token: "catalog", nextToken: null, records: [fresh], rawCount: 1, expectedCount: 1, page: 1 }, 1);
      }, { authorize: async () => {} });
      expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM inventory_memberships m
        JOIN inventory_facts f ON f.generation_id=m.generation_id AND f.identity=m.identity WHERE ${inventoryAsOf()}
        AND f.kind='element'`, [next.baselineId, next.revision])).rows[0].count).toBe(5000);
    }
  });
  it("clears scoped inventory heads and pending readbacks atomically without reusing historical revision numbers", async () => {
    const principal = randomUUID(), other = randomUUID(), input = inventoryInput(principal, "canonical");
    const scope = { tenantId: "synthetic-tenant", principalId: principal };
    const identifiers: PowerPlatformResource["identifiers"] = [{ kind: "environment_id", value: environment }, { kind: "cds_bot_id", value: bot }];
    const graph = await publish(principal, "packages", [packaged("cleared-graph", false)]);
    const source = await publish(principal, "power_platform", [native("cleared-native", identifiers, { isQuarantined: false })]);
    const foreign = await publish(other, "packages", [packaged("other-principal", false)]);
    await reconcile.request(input, [graph, source]); await reconcile.runNext(input, async () => {});
    const queries = new InventoryQueries(fixture.runtime, "synthetic-clear-selection-cursor-key-32-bytes");
    const identity = { ...selectionIdentity, principalId: principal };
    const pin = await queries.capture(identity, graph.scopeId);
    await fixture.runtime.query(`INSERT INTO copilot_quarantine_status_observations
      (id,tenant_id,principal_id,resource_native_id,environment_id,bot_id,is_bot_quarantined,provider_updated_at,observed_at,correlation_id,verified_readback)
      VALUES($1,$2,$3,'cleared-native',$4,$5,true,$6,clock_timestamp(),$7,true)`,
    [randomUUID(), scope.tenantId, principal, environment, bot, new Date().toISOString(), randomUUID()]);
    expect((await queries.page(pin.id, identity)).counts.filtered).toBe(1);
    const clear = await new DataSyncRepository(fixture.runtime).submit(scope, { mode: "full", clearSavedData: true });
    expect(clear.created).toBe(true);
    await expect(queries.page(pin.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM inventory_roots root
      JOIN data_scope_epochs s ON s.id=root.scope_id WHERE s.principal_id=$1 AND root.current`, [principal])).rows[0].count).toBe(0);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM inventory_native_control_pending WHERE principal_id=$1", [principal])).rows[0].count).toBe(0);
    const runtime = new InventoryRuntime(fixture.runtime, async () => {});
    expect(await runtime.publishNativeControls(scope)).toBe(0);
    expect(await runtime.enqueue(scope)).toBe(false);
    expect((await fixture.runtime.query("SELECT current FROM inventory_roots WHERE baseline_id=$1", [foreign.baselineId])).rows[0].current).toBe(true);
    const next = await publish(principal, "power_platform", [native("after-clear", identifiers)]);
    expect(BigInt(next.revision)).toBeGreaterThan(BigInt(source.revision));
    await reconcile.request(input, [next]);
    const rebuilt = (await reconcile.runNext(input, async () => {}))!;
    const current = await queries.capture(identity, rebuilt.scopeId);
    expect((await queries.page(current.id, identity)).value.map(value => value.displayName)).toEqual(["after-clear"]);
  });
  it("preserves case-distinct opaque Graph IDs and both canonical survivors on an ordinary update", async () => {
    const principal = randomUUID(), input = inventoryInput(principal, "canonical");
    const ids = ["abcdefab-abcd-4abc-8abc-abcdefabcdef", "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF"];
    const rows = () => ids.map((id, index) => packageInventoryRecord({ id, displayName: id, isBlocked: false,
      elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "identity", definition: JSON.stringify({
        SourceIds: { EnvironmentId: environment, CdsBotId: bot, SchemaName: `schema${index}` },
      }) }] }] }));
    const root = await publish(principal, "packages", rows());
    await reconcile.request(input, [root]);
    const first = (await reconcile.runNext(input, async () => {}))!;
    const members = async (revision: string) => (await fixture.runtime.query(`SELECT m.identity,s.source_identity
      FROM inventory_memberships m JOIN unified_agent_memberships s ON s.generation_id=m.generation_id AND s.identity=m.identity
      WHERE ${inventoryAsOf()} ORDER BY s.source_identity COLLATE "C"`, [first.baselineId, revision])).rows;
    const original = await members(first.revision);
    expect(original).toHaveLength(2); expect(new Set(original.map(row => row.identity)).size).toBe(2);
    expect(original.map(row => row.source_identity)).toEqual([...ids].sort());
    const changed = await publish(principal, "packages", rows(), true);
    await reconcile.request(input, [changed]);
    const second = (await reconcile.runNext(input, async () => {}))!;
    expect(await members(second.revision)).toEqual(original);
  });
  it.each(["native", "package", "linked"] as const)("projects normalized authoring platform facts without duplicate facets (%s)", async scenario => {
    const principal = randomUUID(), input = inventoryInput(principal, "canonical");
    const roots = [];
    if (scenario !== "package") roots.push(await publish(principal, "power_platform", [native("native")]));
    if (scenario !== "native") {
      const value = packaged("package");
      value.residual.platform = "COPILOT-STUDIO";
      roots.push(await publish(principal, "packages", [packageInventoryRecord(
        restoreInventoryRecord(value.residual, value.facts, "packages") as Parameters<typeof packageInventoryRecord>[0])]));
    }
    await reconcile.request(input, roots);
    const root = (await reconcile.runNext(input, async () => {}))!;
    const identity = { ...selectionIdentity, principalId: principal };
    const queries = new InventoryQueries(fixture.runtime, "synthetic-platform-fact-normalization-secret");
    for (const platform of ["Copilot Studio", "copilotstudio", "COPILOT-STUDIO"]) {
      const selected = await queries.capture(identity, root.scopeId, { platform });
      const page = await queries.page(selected.id, identity);
      expect(page.counts.filtered).toBe(1);
      expect((await queries.facets(selected.id, identity, "platform")).value).toEqual([{ value: "copilotstudio", label: "Copilot Studio" }]);
      await queries.selections.invalidate(selected.id, identity);
    }
    const facts = await fixture.runtime.query(`SELECT f.value FROM inventory_memberships m JOIN inventory_facts f
      ON f.generation_id=m.generation_id AND f.identity=m.identity WHERE ${inventoryAsOf()} AND f.kind='platform'`,
    [root.baselineId, root.revision]);
    expect(facts.rows).toEqual([{ value: "copilotstudio" }]);
  });
  it.each([100, 1000])("reconciles twenty changed keys without cloning a %i-row canonical manifest", async size => {
    const principal = randomUUID();
    const source = await inventoryBaseline(sources, principal, size);
    await reconcile.request(inventoryInput(principal, "canonical"), [source]);
    const baseline = await reconcile.runNext(inventoryInput(principal, "canonical"), async () => {});
    expect(baseline?.inserted).toBe(size);
    const before = (await fixture.runtime.query("SELECT sum(pg_column_size(r))::text AS bytes FROM unified_agent_rows r WHERE scope_id=$1", [baseline!.scopeId])).rows[0].bytes;
    const delta = await inventoryDelta(sources, principal);
    await reconcile.request(inventoryInput(principal, "canonical"), [delta]);
    const result = await reconcile.runNext(inventoryInput(principal, "canonical"), async () => {});
    expect(result).toMatchObject({ inserted: 20, closed: 20, changed: 20, baselineId: baseline!.baselineId });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM unified_agent_rows WHERE scope_id=$1", [baseline!.scopeId])).rows[0].count).toBe(size + 20);
    const after = (await fixture.runtime.query("SELECT sum(pg_column_size(r))::text AS bytes FROM unified_agent_rows r WHERE scope_id=$1", [baseline!.scopeId])).rows[0].bytes;
    const job = (await fixture.runtime.query(`SELECT g.job_id FROM data_generation_heads h JOIN data_generations g ON g.id=h.generation_id WHERE h.scope_id=$1`, [baseline!.scopeId])).rows[0].job_id;
    const frontier = (await fixture.runtime.query("SELECT count(*)::int AS count FROM inventory_frontier WHERE worker_id=$1", [job])).rows[0].count;
    expect(frontier).toBe(20);
    const plan = (await fixture.runtime.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)
      SELECT source_scope_id,identity FROM inventory_frontier WHERE worker_id=$1 AND component IS NULL ORDER BY source_scope_id,identity LIMIT 1`, [job])).rows[0];
    process.stdout.write("CANONICAL_WRITE_PROOF " + JSON.stringify({ baseline: size, changed: result, frontierRows: frontier,
      contentBytes: Number(after) - Number(before), maximumBindBytes: reconcile.stages.maximumParameterBytes, plan }) + "\n");
  }, 30_000);
  it.each([1, 2])("keeps safe pending work while the real worker pauses at authorization %s", async authorization => {
    const principal = randomUUID();
    const root = await inventoryBaseline(sources, principal, 100);
    const input = inventoryInput(principal, "canonical");
    await reconcile.request(input, [root]);
    let calls = 0;
    const first = await reconcile.runNext(input, async () => {
      if (++calls !== authorization) return;
      for (let update = 0; update < 3; update++) {
        const changed = await inventoryDelta(sources, principal);
        await reconcile.request(input, [changed]);
      }
      expect((await fixture.runtime.query(`SELECT state.active_id IS NOT NULL AS active,state.pending_inputs IS NOT NULL AS pending,
        (SELECT count(*)::int FROM data_generations generation WHERE generation.scope_id=state.scope_id
          AND generation.state IN ('staging','validating')) AS active_jobs
        FROM inventory_reconciliation state JOIN data_scope_epochs scope ON scope.id=state.scope_id
        WHERE scope.tenant_id=$1 AND scope.principal_id=$2`, [input.scope.tenantId, principal])).rows[0])
        .toEqual({ active: true, pending: true, active_jobs: authorization === 2 ? 1 : 0 });
      expect(await reconcile.runNext(input, async () => {})).toBeNull();
      if (authorization === 2) {
        const active = (await fixture.runtime.query(`SELECT scope_id,active_id FROM inventory_reconciliation
          WHERE active_id IS NOT NULL AND scope_id IN (SELECT id FROM data_scope_epochs WHERE tenant_id=$1 AND principal_id=$2)`,
        [input.scope.tenantId, principal])).rows[0];
        const count = async () => (await fixture.runtime.query("SELECT count(*)::int AS count FROM inventory_frontier WHERE worker_id=$1",
          [active.active_id])).rows[0].count;
        const before = await count();
        expect(before).toBe(100);
        await sources.gcMetadata(active.scope_id, input.scope.tenantId);
        expect(await count()).toBe(before);
      }
    });
    expect(first?.inserted).toBe(100);
    expect((await fixture.runtime.query("SELECT status FROM inventory_reconciliation WHERE scope_id=$1", [first!.scopeId])).rows[0].status).toBe("catching_up");
    const next = await reconcile.runNext(input, async () => {});
    expect(next).not.toBeNull();
    expect(next?.inserted).toBe(20);
    expect((await fixture.runtime.query("SELECT status,published_sequence,pending_sequence FROM inventory_reconciliation WHERE scope_id=$1", [first!.scopeId])).rows[0])
      .toMatchObject({ status: "idle", published_sequence: "4", pending_sequence: "4" });
    for (let pass = 0; pass < 10; pass++) {
      const slice = await sources.gcMetadataSlice(first!.scopeId, input.scope.tenantId);
      expect(slice.rows).toBeLessThanOrEqual(1000);
      expect(slice.bytes).toBeLessThanOrEqual(1_048_576);
    }
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM inventory_frontier f
      JOIN data_generations g ON g.job_id=f.worker_id WHERE g.scope_id=$1`, [first!.scopeId])).rows[0].count).toBe(0);
    await reconcile.request(input, [root]);
    expect(await reconcile.runNext(input, async () => {})).toBeNull();
    await inventoryDelta(sources, principal);
    expect(await reconcile.runNext(input, async () => {})).toMatchObject({ inserted: 20, closed: 20 });
  }, 30_000);
  it("does not replace a captured active vector when detail evidence expires, then converges off GET", async () => {
    const principal = randomUUID(), expiresAt = new Date(Date.now() + 1_000);
    const root = await publish(principal, "packages", [packageInventoryRecord({
      ...allowlistedPackage({ id: "aging", displayName: "Aging evidence", isBlocked: false }),
      identityDetailsCollected: true,
      detailFreshness: { state: "fresh", observedAt: new Date(Date.now() - 3_599_000).toISOString(), expiresAt: expiresAt.toISOString() },
      elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "element", definition: "{}" }] }],
    })]);
    const input = inventoryInput(principal, "canonical");
    const request = (await reconcile.request(input, [root]))!;
    let calls = 0;
    const first = await reconcile.runNext(input, async () => {
      if (calls++) return;
      const active = (await fixture.runtime.query(`SELECT active_id,pending_sequence FROM inventory_reconciliation
        WHERE scope_id=$1`, [request.scopeId])).rows[0];
      await expect.poll(() => Date.now() >= expiresAt.getTime(), { interval: 25, timeout: 1_500 }).toBe(true);
      await reconcile.request(input, [root]);
      const after = (await fixture.runtime.query(`SELECT active_id,pending_sequence,pending_inputs FROM inventory_reconciliation
        WHERE scope_id=$1`, [request.scopeId])).rows[0];
      expect(after).toEqual({ ...active, pending_inputs: null });
      expect(await reconcile.runNext(input, async () => {})).toBeNull();
    });
    expect(first).not.toBeNull();
    const live = () => fixture.runtime.query(`SELECT count(*)::int AS count FROM inventory_live_sources
      WHERE tenant_id=$1 AND principal_id=$2 AND authority_expires_at>clock_timestamp()`, [input.scope.tenantId, principal]);
    expect((await live()).rows[0].count).toBe(0);
    const nextInput = inventoryInput(principal, "canonical");
    await reconcile.request(nextInput, [root]);
    expect(await reconcile.runNext(nextInput, async () => {})).toMatchObject({ inserted: 1, closed: 1 });
    expect((await live()).rows[0].count).toBe(1);
    await reconcile.request(inventoryInput(principal, "canonical"), [root]);
    expect(await reconcile.runNext(inventoryInput(principal, "canonical"), async () => {})).toBeNull();
  });
  it("seeks expiry at statement execution after an older transaction began",async () => {
    const client = await fixture.runtime.connect();
    try {
      await client.query("BEGIN");
      const principal = randomUUID(),expiresAt = new Date(Date.now()+2000);
      const root = await publish(principal,"packages",[packageInventoryRecord({
        ...allowlistedPackage({ id: "wall-clock-expiry",displayName: "Wall clock",isBlocked: false }),
        identityDetailsCollected: true,detailFreshness: { state: "fresh",observedAt: new Date().toISOString(),
          expiresAt: expiresAt.toISOString() },
      })]);
      const input = inventoryInput(principal,"canonical");
      await reconcile.request(input,[root]);
      const canonical = await reconcile.runNext(input,async () => {});
      expect(canonical).not.toBeNull();
      expect(Date.now()).toBeLessThan(expiresAt.getTime());
      await new Promise(resolve => setTimeout(resolve,Math.max(0,expiresAt.getTime()-Date.now()+20)));
      expect((await client.query("SELECT transaction_timestamp()<$1 AS earlier",[expiresAt])).rows[0].earlier).toBe(true);
      expect((await client.query(`SELECT EXISTS(${pendingInventoryIdentityExpirySql}) AS expired`,[canonical!.scopeId])).rows[0].expired).toBe(true);
      await client.query("SET LOCAL enable_seqscan=off");
      const plan = JSON.stringify((await client.query(`EXPLAIN(FORMAT JSON) ${pendingInventoryIdentityExpirySql}`,[canonical!.scopeId])).rows);
      expect(plan).toContain("inventory_identity_expiry");
      expect(plan).toMatch(/Index Cond[^}]+identity_expires_at/);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("unsafe invalidation fences captured inputs instead of publishing a stale authority", async () => {
    const principal = randomUUID();
    const root = await inventoryBaseline(sources, principal, 20);
    const input = inventoryInput(principal, "canonical");
    await reconcile.request(input, [root]);
    let calls = 0;
    await expect(reconcile.runNext(input, async () => {
      if (!calls++) await sources.generations.invalidate(root.scopeId, root.tenantId);
    })).rejects.toThrow("inventory_input_fenced");
  });
  it("retains unselected canonical source inputs and collects bounded metadata only after replacement", async () => {
    const principal = randomUUID(), input = inventoryInput(principal, "canonical");
    const expiresAt = new Date(Date.now() + 3000);
    const root = await inventoryBaseline(sources, principal, 20, new Date(), expiresAt);
    await reconcile.request(input, [root]);
    const canonical = (await reconcile.runNext(input, async () => {}))!;
    const changed = await inventoryDelta(sources, principal);
    expect(await sources.gc(changed)).toBe(0);
    expect((await sources.gcMetadata(root.scopeId, root.tenantId)).revisions).toBe(0);
    await reconcile.runNext(input, async () => {});
    expect(await sources.gc(changed)).toBe(20);
    expect((await sources.gcMetadata(root.scopeId, root.tenantId)).revisions).toBe(1);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 20)));
    const queries = new InventoryQueries(fixture.runtime, "synthetic-inventory-cursor-secret-32-bytes");
    const identity = { ...selectionIdentity, principalId: principal };
    const selected = await queries.capture(identity, canonical.scopeId);
    expect((await queries.page(selected.id, identity)).counts.total).toBe(20);

    const emptyPrincipal = randomUUID(), emptyInput = inventoryInput(emptyPrincipal, "canonical");
    const empty = await inventoryBaseline(sources, emptyPrincipal, 0);
    await reconcile.request(emptyInput, [empty]);
    await reconcile.runNext(emptyInput, async () => {});
    await inventoryBaseline(sources, emptyPrincipal, 1);
    expect((await sources.gcMetadata(empty.scopeId, empty.tenantId)).revisions).toBe(0);
    await reconcile.runNext(emptyInput, async () => {});
    for (let pass = 0; pass < 5; pass++) {
      const removed = await sources.gcMetadata(empty.scopeId, empty.tenantId);
      expect(Object.values(removed).every(count => count <= 50)).toBe(true);
    }
    expect((await fixture.runtime.query("SELECT 1 FROM inventory_roots WHERE baseline_id=$1", [empty.baselineId])).rowCount).toBe(0);
    expect((await fixture.runtime.query("SELECT state FROM data_generations WHERE id=$1", [empty.baselineId])).rows[0].state).toBe("deleting");
  }, 15_000);
  it("preserves deterministic merge/split survivors and old canonical pins with exact source-reference reads", async () => {
    const principal = randomUUID(), input = inventoryInput(principal, "canonical");
    const pp = await publish(principal, "power_platform", [native("agent")]);
    let graph = await publish(principal, "packages", [packaged("a"), packaged("b", false)]);
    await reconcile.request(input, [graph, pp]);
    const baseline = (await reconcile.runNext(input, async () => {}))!;
    const queries = new InventoryQueries(fixture.runtime, "synthetic-canonical-pin-and-cursor-secret");
    const identity = { ...selectionIdentity, principalId: principal };
    const old = await queries.capture(identity, baseline.scopeId);
    const reference = (await queries.sourceReferences(old.id, identity, [{ domain: "packages", nativeId: "a", environmentId: null }]))[0].canonical_id;
    expect((await queries.members(old.id, identity, reference)).value).toHaveLength(2);
    graph = await publish(principal, "packages", [packaged("b")], true);
    await reconcile.request(input, [graph, pp]);
    const merged = (await reconcile.runNext(input, async () => {}))!;
    const middle = await queries.capture(identity, baseline.scopeId);
    expect((await queries.page(middle.id, identity)).counts.total).toBe(1);
    expect((await queries.sourceReferences(middle.id, identity, [{ domain: "packages", nativeId: "a", environmentId: null }]))[0].canonical_id).toBe(reference);
    await sources.gc(merged);
    expect((await queries.page(old.id, identity)).counts.total).toBe(2);
    graph = await publish(principal, "packages", [packaged("b", false)], true);
    await reconcile.request(input, [graph, pp]);
    await reconcile.runNext(input, async () => {});
    const latest = await queries.capture(identity, baseline.scopeId);
    expect((await queries.page(latest.id, identity)).counts.total).toBe(2);
    expect((await queries.page(middle.id, identity)).counts.total).toBe(1);
    await expect(queries.currentControl(old.id, identity, reference, async () => true)).rejects.toMatchObject({ code: "selection_invalidated" });
    await publish(principal, "packages", [packaged("a")], true);
    expect((await queries.page(latest.id, identity)).freshness.state).toBe("catching_up");
    await expect(queries.currentControl(latest.id, identity, reference, async () => true)).rejects.toMatchObject({ code: "selection_invalidated" });
  }, 30_000);
  it("retains collision ambiguity and fails a dense SQL component without publishing partial membership", async () => {
    const principal = randomUUID(), input = inventoryInput(principal, "canonical");
    const pp = await publish(principal, "power_platform", [native("first"), native("second")]);
    const graph = await publish(principal, "packages", [packaged("collision")]);
    await reconcile.request(input, [graph, pp]);
    const root = (await reconcile.runNext(input, async () => {}))!;
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM inventory_memberships m
      JOIN unified_agent_rows r ON r.generation_id=m.generation_id AND r.identity=m.identity
      WHERE ${inventoryAsOf()} AND r.link_state='ambiguous'`, [root.baselineId, root.revision])).rows[0].count).toBe(1);
    const densePrincipal = randomUUID(), dense = await publish(densePrincipal, "packages", Array.from({ length: 251 }, (_, index) => packaged(`dense-${index}`)));
    const denseInput = inventoryInput(densePrincipal, "canonical");
    const request = await reconcile.request(denseInput, [dense]);
    await expect(reconcile.runNext(denseInput, async () => {})).rejects.toMatchObject({ code: "inventory_dense_component" });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM inventory_roots WHERE scope_id=$1", [request.scopeId])).rows[0].count).toBe(0);
  }, 30_000);
  it("takes over an expired active claim without a pending request and fences the old owner", async () => {
    const principal = randomUUID(), input = inventoryInput(principal, "canonical");
    const root = await inventoryBaseline(sources, principal, 1);
    const request = await reconcile.request(input, [root]);
    let start!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const old = reconcile.runNext(input, async () => { start(); await wait; }).catch(error => error);
    await started;
    await fixture.operator.query("UPDATE inventory_reconciliation SET active_until=clock_timestamp()-interval '1 second' WHERE scope_id=$1", [request.scopeId]);
    expect(await reconcile.runNext(input, async () => {})).not.toBeNull();
    release();
    expect(await old).toBeInstanceOf(Error);
  });
  it.each(["manifest", "custom-engine", "conflicting"] as const)("preserves %s identity evidence through the indexed SQL frontier", async scenario => {
    const principal = randomUUID(), input = inventoryInput(principal, "canonical"), application = randomUUID();
    const metadata = (id: string, cds: string) => ({ id, definition: JSON.stringify({ SourceIds: { EnvironmentId: environment, CdsBotId: cds } }) });
    const engine = (id: string, anchored: boolean) => packageInventoryRecord({ id, displayName: id, isBlocked: false, elementDetails: [
      ...anchored ? [{ elementType: "AgentMetadatas", elements: [metadata("identity", bot)] }] : [],
      { elementType: "Bots", elements: [{ id: application, definition: JSON.stringify({ botId: application }) }] },
      { elementType: "CustomEngineCopilots", elements: [{ id: application, definition: JSON.stringify({ id: application, type: "bot" }) }] },
    ] });
    const packages = scenario === "manifest" ? [packageInventoryRecord({ id: "manifest", displayName: "Manifest", isBlocked: false, manifestId: bot,
      elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "declarative", definition: "{}" }] }] })]
      : scenario === "custom-engine" ? [engine("anchor", true), engine("legacy", false)]
        : [packageInventoryRecord({ id: "conflict", displayName: "Conflict", isBlocked: false,
          elementDetails: [{ elementType: "AgentMetadatas", elements: [metadata("one", bot), metadata("two", randomUUID())] }] })];
    const pp = await publish(principal, "power_platform", [scenario === "manifest" ? native(bot.toUpperCase(), [], { schemaName: bot }) : native("native")]);
    const graph = await publish(principal, "packages", packages);
    await reconcile.request(input, [graph, pp]);
    const root = (await reconcile.runNext(input, async () => {}))!;
    const classifications = (await fixture.runtime.query(`SELECT r.presence,r.link_state FROM inventory_memberships m
      JOIN unified_agent_rows r ON r.generation_id=m.generation_id AND r.identity=m.identity
      WHERE ${inventoryAsOf()}`, [root.baselineId, root.revision])).rows;
    if (scenario === "conflicting") expect(classifications).toEqual(expect.arrayContaining([expect.objectContaining({ link_state: "conflicting" })]));
    else {
      expect(root.inserted).toBe(1);
      expect(classifications).toEqual([expect.objectContaining({ presence: "both" })]);
    }
  });
  it("joins native reports, resolved people and responsibility in one selected revision and invalidates changed people", async () => {
    const principal = randomUUID(), input = inventoryInput(principal, "canonical"), objectId = randomUUID();
    const observerScope = { tenantId: "synthetic-tenant", principalId: principal };
    const absent = await readAutomaticInventoryRevisions(observerScope, fixture.runtime);
    const ppRecord = native("owned");
    ppRecord.residual = { ...ppRecord.residual, createdBy: objectId, details: { ownerId: objectId } };
    ppRecord.facts.push({ kind: "person:owner", value: objectId, payload: {} }, { kind: "person:createdBy", value: objectId, payload: {} });
    const pp = await publish(principal, "power_platform", [ppRecord]);
    const withNative = await readAutomaticInventoryRevisions(observerScope, fixture.runtime);
    expect(withNative.power_platform).not.toBe(absent.power_platform);
    expect(withNative.graph_packages).toBe(absent.graph_packages);
    const graph = await publish(principal, "packages", [packaged("agent-one")]);
    const withGraph = await readAutomaticInventoryRevisions(observerScope, fixture.runtime);
    expect(withGraph.graph_packages).not.toBe(withNative.graph_packages);
    expect(withGraph.power_platform).toBe(withNative.power_platform);
    await reconcile.request(input, [graph, pp]);
    const root = (await reconcile.runNext(input, async () => {}))!;
    const withCanonical = await readAutomaticInventoryRevisions(observerScope, fixture.runtime);
    expect(withCanonical.graph_packages).not.toBe(withGraph.graph_packages);
    expect(withCanonical.power_platform).not.toBe(withGraph.power_platform);
    const identity = { ...selectionIdentity, principalId: principal };
    const imports = new OfficialReportImports(fixture.runtime), bundleId = randomUUID(), rows = officialGoldenCsvRows();
    for (const kind of ["agents", "users", "userAgents"] as const) {
      async function* source() { yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n${rows[kind].join("\n")}\n`); }
      await imports.stage(identity, { bundleId }, source());
    }
    await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
    const queries = new InventoryQueries(fixture.runtime, "synthetic-report-people-inventory-secret");
    await queries.reports.sources.savePeople(identity, [{ objectId, status: "resolved", displayName: "Resolved Owner",
      userPrincipalName: "owner@example.invalid", checkedAt: new Date().toISOString() }], async () => {});
    const withPeople = await readAutomaticInventoryRevisions(observerScope, fixture.runtime);
    expect(withPeople.power_platform).not.toBe(withCanonical.power_platform);
    expect(withPeople.graph_packages).toBe(withCanonical.graph_packages);
    expect(await readAutomaticInventoryRevisions(observerScope, fixture.runtime)).toEqual(withPeople);
    await expect(fixture.runtime.query("UPDATE inventory_people_revisions SET revision=revision+1 WHERE tenant_id=$1 AND principal_id=$2",
      [observerScope.tenantId, principal])).rejects.toMatchObject({ code: "42501" });
    const selected = await queries.capture(identity, root.scopeId, { search: "Resolved Owner", sortBy: "owner" });
    const page = await queries.page(selected.id, identity);
    expect(page.counts.filtered).toBe(1);
    expect(page.value[0]).toMatchObject({ responses: 9, activeUsers: 2, columns: {
      owner: "Resolved Owner (owner@example.invalid)", createdBy: "Resolved Owner (owner@example.invalid)" } });
    expect((await queries.usage(selected.id, identity, [page.value[0].id]))[0]).toMatchObject({ status: "linked", responses: 9, activeUsers: 2 });
    expect((await queries.people(selected.id, identity, [objectId]))[0]).toMatchObject({ displayName: "Resolved Owner", status: "resolved" });
    expect((await queries.responsibility(selected.id, identity)).people.map(({ objectId, agentCount }) => ({ objectId, agentCount })))
      .toEqual([{ objectId, agentCount: 1 }]);
    expect((await queries.responsibilityAgents(selected.id, identity, objectId)).value[0].identity).toBe(page.value[0].id);
    await queries.reports.sources.savePeople(identity, [{ objectId, status: "resolved", displayName: "Changed Owner",
      userPrincipalName: "owner@example.invalid", checkedAt: new Date().toISOString() }], async () => {});
    expect((await readAutomaticInventoryRevisions(observerScope, fixture.runtime)).power_platform).not.toBe(withPeople.power_platform);
    await expect(queries.page(selected.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
  }, 30_000);
});
