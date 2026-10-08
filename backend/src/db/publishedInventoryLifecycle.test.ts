import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { fixtureDirectoryUser } from "../../scripts/userSourceFixture.js";
import { inventoryInput, nativeInventoryFixture, packageRecord } from "../../scripts/inventoryFixtures.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
import { InventoryQueries } from "./inventoryQueries.js";
import { DataGenerations } from "./dataGenerations.js";
import { UserSourceStages } from "./userSourceStages.js";
import { InventoryRuntime } from "../services/inventoryRuntime.js";
import { LiveInventory } from "./liveInventory.js";
import { retainRecordData } from "./dataRetention.js";
import { readAutomaticInventoryRevisions } from "./inventoryAutomaticRevisions.js";
import type { SelectionIdentity } from "../services/dataSelections.js";
import { AppError } from "../errors.js";
import { withQueries } from "../../scripts/lifecycleEvidence.js";
import { PackageRefreshJobs } from "./packageRefreshJobs.js";
import { PowerPlatformRefreshJobs } from "./powerPlatformRefreshJobs.js";

describe("published inventory reachability independent of freshness", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  };
  const after = async (date: Date) => {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, date.getTime() - Date.now() + 30)));
  };
  const input = (identity: SelectionIdentity, domain: string, expiresAt: Date) => ({
    ...inventoryInput(identity.principalId, domain),
    scope: { ...inventoryInput(identity.principalId, domain).scope, tenantId: identity.tenantId },
    observedAt: new Date(Math.min(Date.now(), expiresAt.getTime() - 1)), expiresAt,
  });

  async function collect(identity: SelectionIdentity, passes = 2) {
    const store = new InventoryGenerations(fixture.runtime);
    for (let pass = 0; pass < passes; pass++) {
      const roots = (await fixture.runtime.query(`SELECT r.scope_id AS "scopeId",r.tenant_id AS "tenantId",
        r.baseline_id AS "baselineId",r.revision,s.epoch FROM inventory_roots r JOIN data_scope_epochs s ON s.id=r.scope_id
        WHERE r.tenant_id=$1 AND s.principal_id=$2 ORDER BY r.domain,r.first_revision`,
      [identity.tenantId, identity.principalId])).rows;
      for (const root of roots) {
        for (const result of [await store.gcSlice(root), await store.gcContent(root.scopeId, root.tenantId),
          await store.gcMetadataSlice(root.scopeId, root.tenantId)]) {
          expect(result.rows).toBeLessThanOrEqual(1000);
          expect(result.bytes).toBeLessThanOrEqual(1_048_576);
        }
      }
      await store.generations.connections.run(client => retainRecordData(client, 250));
    }
  }

  it.each(["published", "failed"] as const)(
    "retains fresh admissions, complete rows and bounded input closure past TTL during a %s successor",
    async outcome => {
      const identity = { ...selectionIdentity, tenantId: randomUUID(), principalId: randomUUID() };
      const inventory = new InventoryQueries(fixture.runtime, "synthetic-current-anchor-lifecycle-secret");
      const store = new InventoryGenerations(fixture.runtime), runtime = new InventoryRuntime(fixture.runtime, async () => {});
      const deadline = new Date(Date.now() + 2500);
      const person = randomUUID(), environmentId = randomUUID();
      const directory = new UserSourceStages(fixture.runtime);
      await directory.execute(generationInput({ scope: { ...generationInput().scope,
        tenantId: identity.tenantId, principalId: identity.principalId }, expiresAt: deadline }), async lease => {
        const key = await directory.query(lease, "discovery", "synthetic:retained-directory");
        await directory.page(lease, key, "synthetic:retained-directory", 1, 1);
        await directory.directory(lease, key, [fixtureDirectoryUser(person, "Retained person", "retained@example.invalid")]);
        await directory.finishQuery(lease, key);
      }, { beforePublish: async () => {} });
      const native = await nativeInventoryFixture(fixture.runtime, identity, [
        { nativeId: "native", identifiers: [], environmentId, createdBy: person, details: { ownerId: person } },
        { nativeId: environmentId, identifiers: [], type: "microsoft.powerplatform/environments", displayName: "Retained Environment" },
      ], { expiresAt: deadline });
      const publish = (name: string, expiry: Date, pause?: ReturnType<typeof gate>, entered?: ReturnType<typeof gate>) =>
        store.execute(input(identity, "packages", expiry), { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
          await store.visit(lease, `synthetic:${name}`);
          await store.appendBounded(lease, [packageRecord(0, `${name} 0`)]);
          if (pause) { entered!.release(); await pause.promise; }
          if (pause && outcome === "failed") throw new AppError(504, "provider_timeout", "Synthetic successor failed");
          const records = [packageRecord(0, `${name} 0`), packageRecord(1, `${name} 1`)];
          await store.appendBounded(lease, [records[1]]);
          await store.acceptPage(lease, { token: `synthetic:${name}`, nextToken: null, records, rawCount: 2,
            expectedCount: 2, page: 1 }, 2);
        }, { authorize: async () => {} });
      const original = await publish("Before", deadline);
      await runtime.enqueue(identity);
      const canonical = (await runtime.reconciliation.runNext(input(identity, "canonical", deadline), async () => {}))!;
      const selected = await inventory.capture(identity, canonical.scopeId);
      const first = await inventory.page(selected.id, identity);
      const packageAgent = first.value.find(row => row.displayName === "Before 0")!;
      const live = new LiveInventory(fixture.runtime);
      await expect(live.record(identity, `agent:${packageAgent.id}`)).resolves.toBeDefined();
      const beforeVector = await readAutomaticInventoryRevisions(identity, fixture.runtime);
      const success = async () => [
        (await new PackageRefreshJobs(fixture.runtime).listJobs(identity, identity.principalId)).lastSuccessAt,
        (await new PowerPlatformRefreshJobs(fixture.runtime).listJobs(identity)).lastSuccessAt,
      ];
      const beforeSuccess = await success();
      expect(beforeSuccess).toEqual([expect.any(String), expect.any(String)]);
      const pending = gate(), entered = gate();
      const successor = publish("After", deadline, pending, entered);
      void successor.catch(() => {});
      try {
        await Promise.race([entered.promise, successor]);
        for (const offset of [-1, 0, 1, 172_800_000]) {
          const instant = new Date(deadline.getTime() + offset).toISOString();
          await withQueries(fixture.runtime, text => text.replaceAll("clock_timestamp()", `'${instant}'::timestamptz`), async () => {
            const boundary = await inventory.capture(identity, canonical.scopeId);
            const page = await inventory.page(boundary.id, identity);
            expect(page.value.map(row => row.displayName)).toEqual(first.value.map(row => row.displayName));
            expect(page.counts).toEqual(first.counts);
            expect(page.summary).toEqual(first.summary);
          });
        }
        await after(deadline);
        await collect(identity);
        expect(await success()).toEqual(beforeSuccess);
        expect(await readAutomaticInventoryRevisions(identity, fixture.runtime)).toEqual(beforeVector);
        const leaseState = (await fixture.runtime.query(`SELECT state FROM data_generations
          WHERE tenant_id=$1 AND state='staging' AND expires_at<=clock_timestamp()`, [identity.tenantId])).rows;
        expect(leaseState).toEqual([{ state: "staging" }]);
        expect((await inventory.page(selected.id, identity)).value).toEqual(first.value);
        await fixture.operator.query("UPDATE data_read_selections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [selected.id]);
        await expect(inventory.page(selected.id, identity)).rejects.toMatchObject({ details: { reason: "expired" } });
        const fresh = await inventory.capture(identity, canonical.scopeId);
        const page = await inventory.page(fresh.id, identity);
        expect(page.counts).toEqual(first.counts);
        expect(page.summary).toEqual(first.summary);
        expect(page.value.map(row => row.displayName)).toEqual(first.value.map(row => row.displayName));
        expect(page.value.find(row => row.displayName === "native")).toMatchObject({
          environment: { displayName: "Retained Environment" }, people: { owner: { displayName: "Retained person" } },
        });
        expect((await inventory.page((await inventory.capture(identity, original.scopeId)).id, identity)).value
          .map(row => row.residual.displayName)).toEqual(["Before 0", "Before 1"]);
        const report = await inventory.reports.capture(identity, "delegated", "copilot_users");
        expect((await inventory.reports.page(report.id, identity)).sources.directory).toMatchObject({ state: "stale", rowCount: 1 });
        await expect(live.record(identity, `agent:${packageAgent.id}`)).rejects.toMatchObject({ code: "agent_not_found" });
        await expect(inventory.currentControl(fresh.id, identity, packageAgent.id, async () => "must not authorize"))
          .rejects.toMatchObject({ code: "selection_invalidated" });
      } finally { pending.release(); }
      if (outcome === "failed") {
        await expect(successor).rejects.toMatchObject({ status: 504 });
        await collect(identity);
        expect((await inventory.page((await inventory.capture(identity, canonical.scopeId)).id, identity)).counts).toEqual(first.counts);
        await publish("After", new Date(Date.now() + 60_000));
      } else await successor;
      await fixture.runtime.query("UPDATE data_read_selections SET invalidated_at=clock_timestamp() WHERE tenant_id=$1", [identity.tenantId]);
      await collect(identity);
      expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM data_generation_pins WHERE tenant_id=$1",
        [identity.tenantId])).rows[0].n).toBe(0);
      await expect(fixture.runtime.query("DELETE FROM inventory_memberships WHERE baseline_id=$1", [original.baselineId]))
        .rejects.toThrow("inventory_interval_pinned");
      await expect(fixture.runtime.query("DELETE FROM inventory_revisions WHERE baseline_id=$1", [original.baselineId]))
        .rejects.toThrow("inventory_revision_pinned");
      const retained = await inventory.capture(identity, canonical.scopeId);
      expect((await inventory.page(retained.id, identity)).value.map(row => row.displayName)).toEqual(first.value.map(row => row.displayName));
      await runtime.enqueue(identity);
      const publishing = gate(), reachedPublication = gate(), buildExpiry = new Date(Date.now() + 150);
      let authorizations = 0;
      const replacement = runtime.reconciliation.runNext(input(identity, "canonical", buildExpiry), async () => {
        if (++authorizations === 2) { reachedPublication.release(); await publishing.promise; }
      });
      void replacement.catch(() => {});
      try {
        await Promise.race([reachedPublication.promise, replacement.then(() => { throw new Error("expected_pending_publication"); })]);
        await after(buildExpiry);
        await collect(identity);
        expect((await inventory.page((await inventory.capture(identity, canonical.scopeId)).id, identity)).value
          .map(row => row.displayName)).toEqual(first.value.map(row => row.displayName));
      } finally { publishing.release(); }
      await replacement;
      const current = await inventory.capture(identity, canonical.scopeId);
      const replaced = await inventory.page(current.id, identity);
      expect(replaced.counts).toEqual(first.counts);
      expect(replaced.value.map(row => row.displayName).sort()).toEqual(["After 0", "After 1", "native"]);
      expect((await inventory.page(retained.id, identity)).value.map(row => row.displayName)).toEqual(first.value.map(row => row.displayName));
      await fixture.runtime.query("UPDATE data_read_selections SET invalidated_at=clock_timestamp() WHERE tenant_id=$1", [identity.tenantId]);
      await collect(identity, 12);
      expect((await fixture.runtime.query("SELECT id FROM data_generations WHERE id=ANY($1::uuid[])",
        [[original.baselineId, canonical.baselineId]])).rows).toEqual([]);
      expect((await fixture.runtime.query("SELECT id FROM data_generations WHERE id=$1", [native.baselineId])).rowCount).toBe(1);
      expect((await inventory.page((await inventory.capture(identity, canonical.scopeId)).id, identity)).counts).toEqual(first.counts);
      await store.clear(canonical.scopeId, identity.tenantId);
      await expect(inventory.capture(identity, canonical.scopeId)).rejects.toMatchObject({ code: "selection_invalidated" });
    }, 30_000,
  );

  it("admits a delta after the old TTL and publishes past its own freshness deadline without dropping unchanged rows", async () => {
    const identity = { ...selectionIdentity, tenantId: randomUUID(), principalId: randomUUID() };
    const store = new InventoryGenerations(fixture.runtime);
    const inventory = new InventoryQueries(fixture.runtime, "synthetic-post-ttl-delta-cursor-secret-32");
    const expiry = new Date(Date.now() + 400);
    const original = await store.execute(input(identity, "packages", expiry),
      { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
        const records = [packageRecord(0, "Before 0"), packageRecord(1, "Before 1")];
        await store.visit(lease, "synthetic:delta-baseline");
        await store.appendBounded(lease, records);
        await store.acceptPage(lease, { token: "synthetic:delta-baseline", nextToken: null, records, rawCount: 2,
          expectedCount: 2, page: 1 }, 2);
      }, { authorize: async () => {} });
    await after(expiry);
    await collect(identity);
    const selected = await inventory.capture(identity, original.scopeId);
    const buildExpiry = new Date(Date.now() + 200);
    const delta = await store.execute(input(identity, "packages", buildExpiry),
      { domain: "packages", mode: "delta", channel: "exact", targets: ["package-000000"] }, async lease => {
        await store.appendBounded(lease, [packageRecord(0, "After 0")]);
        await after(buildExpiry);
        await collect(identity);
        expect((await inventory.page(selected.id, identity)).value.map(row => row.displayName)).toEqual(["Before 0", "Before 1"]);
      }, { authorize: async () => {} });
    expect(delta.baselineId).toBe(original.baselineId);
    expect(BigInt(delta.revision)).toBe(BigInt(original.revision) + 1n);
    const current = await inventory.capture(identity, original.scopeId);
    const page = await inventory.page(current.id, identity);
    expect(page.counts.total).toBe(2);
    expect(page.value.map(row => row.displayName)).toEqual(["After 0", "Before 1"]);
    expect((await inventory.page(selected.id, identity)).value.map(row => row.displayName)).toEqual(["Before 0", "Before 1"]);
  }, 15_000);

  it("still abandons a writer whose worker lease is lost, independently of its publication freshness", async () => {
    const generations = new DataGenerations(fixture.runtime), value = generationInput();
    value.scope.principalId = randomUUID();
    const lease = await generations.begin(value);
    await fixture.operator.query("UPDATE data_generations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [lease.id]);
    await generations.connections.run(client => retainRecordData(client, 250));
    await expect(generations.renew(lease)).rejects.toThrow("data_writer_fenced");
  });
});
