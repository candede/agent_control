import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { testDatabase } from "../../scripts/testDatabase.js";
import { directoryRecord, generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { DataExports } from "../services/dataExports.js";
import { canonicalQuery, DataSelections } from "../services/dataSelections.js";
import { DataGenerations } from "./dataGenerations.js";
import { retainRecordData } from "./dataRetention.js";
import { inventoryBaseline } from "../../scripts/inventoryFixtures.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
import { InventoryQueries } from "./inventoryQueries.js";
import { InventoryRuntime } from "../services/inventoryRuntime.js";
import { flushDataWorkMetrics } from "../services/dataMetrics.js";

describe("cross-domain bounded lifecycle", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); });
  afterAll(async () => { await fixture?.close(); });

  it("observes scalar deleting-root backlog and oldest generation age without returning identities", async () => {
    const store = new DataGenerations(fixture.runtime), lease = await store.begin(generationInput());
    await store.abort(lease, true);
    await fixture.operator.query("UPDATE data_generations SET state='deleting' WHERE id=$1", [lease.id]);
    await new Promise(resolve => setTimeout(resolve, 20));
    flushDataWorkMetrics();
    await store.connections.run(client => retainRecordData(client));
    const before = flushDataWorkMetrics().find(value => value.stage === "record_gc");
    expect(before?.backlogRoots).toBe(1);
    expect(before?.oldestAgeMs).toBeGreaterThanOrEqual(20);
    await store.connections.run(client => retainRecordData(client));
    expect(flushDataWorkMetrics().find(value => value.stage === "record_gc"))
      .toMatchObject({ backlogRoots: 0, oldestAgeMs: 0 });
  });

  it("revokes every account scope atomically without materializing the full scope set", async () => {
    const tenant = `revoke-${randomUUID()}`, principal = randomUUID(), generations = new DataGenerations(fixture.runtime);
    await generations.sessionEpoch(tenant, principal);
    await fixture.operator.query(`INSERT INTO data_scope_epochs(id,tenant_id,scope_kind,principal_id,token_mode,source,selector)
      SELECT gen_random_uuid(),$1,'principal',$2,'delegated','directory','scope-'||n FROM generate_series(1,501) n`, [tenant, principal]);
    const sizes: number[] = [], observed = new WeakSet<pg.PoolClient>(), spies: Array<{ mockRestore(): void }> = [];
    const acquire = (client: pg.PoolClient) => {
      if (observed.has(client)) return;
      observed.add(client);
      const query = client.query.bind(client);
      spies.push(vi.spyOn(client, "query").mockImplementation((...args: unknown[]) => {
        const result = (query as (...args: unknown[]) => Promise<pg.QueryResult>)(...args);
        return typeof args[0] === "string" && args[0].startsWith("SELECT id FROM data_scope_epochs WHERE tenant_id=")
          ? result.then(value => { sizes.push(value.rows.length); return value; }) : result;
      }));
    };
    fixture.runtime.on("acquire", acquire);
    try {
      expect(await generations.revokePrincipal(tenant, principal)).toBe("1");
      expect(sizes).toEqual([250, 250, 1, 0]);
      expect((await fixture.runtime.query(`SELECT count(*)::int AS n FROM data_scope_epochs
        WHERE tenant_id=$1 AND principal_id=$2 AND epoch=1 AND session_epoch=1`, [tenant, principal])).rows[0].n).toBe(501);
    } finally {
      fixture.runtime.off("acquire", acquire);
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("preserves a pinned reader/export across replacement, invalidates on clear, and collects at most 1 MiB per slice", async () => {
    const identity = { ...selectionIdentity, tenantId: `lifecycle-${randomUUID()}` };
    const generations = new DataGenerations(fixture.runtime);
    const selections = new DataSelections(fixture.runtime);
    const exports = new DataExports(fixture.runtime, selections, async () => {});
    const publish = async () => {
      const lease = await generations.begin(generationInput({ scope: { ...generationInput().scope, tenantId: identity.tenantId } }));
      await generations.append(lease, "directory", 0, [directoryRecord()]);
      await generations.validate(lease, { rows: 1, children: 0, batches: 1, pages: 0, wireRows: 0 });
      await generations.publish(lease);
      return lease;
    };
    const first = await publish();
    const selected = await selections.capture(identity, "/users", { values: {}, allowed: [] }, [{
      kind: "generation", scopeId: first.scopeId, generationId: first.id, revision: "1", expiresAt: new Date(Date.now() + 600_000),
    }]);
    const id = await exports.create(identity, { selectionId: selected.id, queryHash: canonicalQuery({}, []),
      kind: "copilot_users", filename: "lifecycle.csv" });
    await exports.build(id, identity, ["Name"], async function* () {
      for (let i = 0; i < 12; i++) yield [{ Name: "x".repeat(130_000) }];
    });
    await publish();
    await generations.connections.run(client => retainRecordData(client));
    expect((await selections.directoryPage(selected.id, identity, first.id, {})).value).toHaveLength(1);
    const stream = exports.download(id, identity, new AbortController().signal);
    expect((await stream.next()).value?.length).toBeGreaterThan(0);
    await generations.invalidate(first.scopeId, identity.tenantId);
    await expect(stream.next()).rejects.toMatchObject({ code: "selection_invalidated" });
    await fixture.operator.query("UPDATE data_exports SET status='expired' WHERE id=$1", [id]);
    const bytes = async () => Number((await fixture.runtime.query(
      "SELECT coalesce(sum(octet_length(bytes)),0)::text AS bytes FROM data_export_chunks WHERE export_id=$1", [id])).rows[0].bytes);
    const before = await bytes();
    expect(before).toBeGreaterThan(1_048_576);
    await generations.connections.run(client => retainRecordData(client));
    expect(before - await bytes()).toBeLessThanOrEqual(1_048_576);
    for (let slice = 0; slice < 40 && await bytes(); slice++) {
      await generations.connections.run(client => retainRecordData(client));
    }
    expect(await bytes()).toBe(0);
  });

  it("collects beyond 20 historical roots while retaining 18 aged current selectors until explicit retirement, including after restart", async () => {
    const stages = new InventoryGenerations(fixture.runtime), principal = randomUUID();
    const roots = [await inventoryBaseline(stages, principal, 1)];
    const queries = new InventoryQueries(fixture.runtime, "synthetic-lifecycle-inventory-cursor-key");
    const identity = { ...selectionIdentity, tenantId: "synthetic-tenant", principalId: principal };
    const selection = await queries.capture(identity, roots[0].scopeId);
    for (let index = 1; index < 24; index++) roots.push(await inventoryBaseline(stages, principal, 1));
    const aged: Array<{ baselineId: string; scopeId: string; principalId: string }> = [];
    for (let index = 0; index < 18; index++) {
      const principalId = randomUUID();
      const root = await inventoryBaseline(stages, principalId, 1, new Date(), new Date(Date.now() + 2000));
      aged.push({ ...root, principalId });
    }
    await new Promise(resolve => setTimeout(resolve, 2050));
    const before = (await fixture.runtime.query("SELECT count(*)::int AS n FROM data_generations")).rows[0].n;
    for (let index = 0; index < 10; index++) expect((await queries.page(selection.id, identity, { limit: 50 })).value).toHaveLength(1);
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM data_generations")).rows[0].n).toBe(before);
    let runtime = new InventoryRuntime(fixture.runtime, async () => {});
    for (let index = 0; index < 320; index++) {
      await runtime.collect();
      if (index === 40) runtime = new InventoryRuntime(fixture.runtime, async () => {});
    }
    const membershipCount = async (id: string) => (await fixture.runtime.query(
      "SELECT count(*)::int AS n FROM inventory_memberships WHERE baseline_id=$1", [id])).rows[0].n;
    expect(await membershipCount(roots[0].baselineId)).toBe(1);
    expect(await membershipCount(roots[21].baselineId)).toBe(0);
    for (const root of aged) {
      expect(await membershipCount(root.baselineId)).toBe(1);
      const owner = { ...identity, principalId: root.principalId };
      const fresh = await queries.capture(owner, root.scopeId);
      expect((await queries.page(fresh.id, owner)).value).toHaveLength(1);
      await stages.clear(root.scopeId, owner.tenantId);
      await expect(queries.capture(owner, root.scopeId)).rejects.toMatchObject({ code: "selection_invalidated" });
    }
    await fixture.operator.query("UPDATE data_read_selections SET invalidated_at=clock_timestamp() WHERE id=$1", [selection.id]);
    for (let index = 0; index < 4; index++) await stages.generations.connections.run(client => retainRecordData(client));
    for (let index = 0; index < 100; index++) await runtime.collect();
    expect(await membershipCount(roots[0].baselineId)).toBe(0);
    expect(await membershipCount(roots.at(-1)!.baselineId)).toBe(1);
    for (const root of aged) expect(await membershipCount(root.baselineId)).toBe(0);
    expect((await fixture.runtime.query("SELECT slices::int AS n FROM data_lifecycle_progress WHERE worker='inventory'")).rows[0].n).toBeGreaterThan(400);
  }, 30_000);

  it("releases invalidated selection quota once without waiting ten minutes or purging another principal", async () => {
    const store = new DataGenerations(fixture.runtime), selections = new DataSelections(fixture.runtime);
    const tenantId = `quota-${randomUUID()}`, identity = { ...selectionIdentity, tenantId };
    const publish = async (principalId = identity.principalId) => {
      const input = generationInput({ scope: { ...generationInput().scope, tenantId, principalId } });
      const lease = await store.begin(input);
      await store.append(lease, "directory", 0, [directoryRecord()]);
      await store.validate(lease, { rows: 1, children: 0, batches: 1, pages: 0, wireRows: 0 });
      await store.publish(lease);
      return { lease, root: { kind: "generation" as const, scopeId: lease.scopeId, generationId: lease.id,
        revision: String(BigInt(lease.expectedRevision) + 1n), expiresAt: input.expiresAt } };
    };
    const first = await publish(), peer = await publish("unaffected-principal");
    const peerIdentity = { ...identity, principalId: "unaffected-principal" };
    const peerSelection = await selections.capture(peerIdentity, "/users", { values: {}, allowed: [] }, [peer.root]);
    for (let index = 0; index < 100; index++) await selections.capture(identity, "/users", { values: {}, allowed: [] }, [first.root]);
    await expect(selections.capture(identity, "/users", { values: {}, allowed: [] }, [first.root]))
      .rejects.toMatchObject({ code: "data_selection_admission" });
    await store.invalidate(first.lease.scopeId, tenantId);
    const replacement = await publish();
    await selections.capture(identity, "/users", { values: {}, allowed: [] }, [replacement.root]);
    for (let index = 0; index < 8; index++) await store.connections.run(client => retainRecordData(client));
    await selections.capture(identity, "/users", { values: {}, allowed: [] }, [replacement.root]);
    expect((await selections.directoryPage(peerSelection.id, peerIdentity, peer.lease.id, {})).value).toHaveLength(1);
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM data_generation_pins WHERE generation_id=$1", [first.lease.id])).rows[0].n).toBe(0);
  }, 30_000);
});
