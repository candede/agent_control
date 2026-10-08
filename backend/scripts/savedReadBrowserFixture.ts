import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { expect } from "vitest";
import { InventoryGenerations } from "../src/db/inventoryGenerations.js";
import { retainRecordData } from "../src/db/dataRetention.js";
import { UserSourceStages } from "../src/db/userSourceStages.js";
import { DataSyncRepository } from "../src/db/dataSync.js";
import { InventoryRuntime } from "../src/services/inventoryRuntime.js";
import { reportIdentity } from "../src/services/reportIdentity.js";
import { appRoles } from "../src/types/capability.js";
import { AppError } from "../src/errors.js";
import { generationInput } from "./largeTenantFixtures.js";
import { inventoryInput, nativeInventoryFixture, packageRecord } from "./inventoryFixtures.js";
import { fixtureDirectoryUser } from "./userSourceFixture.js";
import { closeFixtureServer } from "./fixtureSupport.js";

// Standalone loopback control belongs only to the isolated browser fixture, never createApp.
export async function savedReadBrowserFixture(database: pg.Pool, operator: pg.Pool, tenantId: string) {
  const store = new InventoryGenerations(database);
  const runtime = new InventoryRuntime(database, async () => {});
  const subjects = new Map<string, Awaited<ReturnType<typeof setup>>>();
  async function setup(key: string) {
    const started = performance.now(), principalId = `fixture-lifecycle-${key}`;
    const identity = await reportIdentity(database, { tenantId, homeAccountId: principalId,
      displayName: "Synthetic account", username: "fixture@example.invalid", roles: [...appRoles],
      providerRoleIds: ["d2562ede-74db-457e-a7b6-544e236ebb61"] });
    const deadline = new Date(Date.now() - 86_400_000), observedAt = new Date(deadline.getTime() - 86_400_000);
    const input = (domain: string) => ({ ...inventoryInput(principalId, domain), sessionEpoch: identity.sessionEpoch,
      scope: { ...inventoryInput(principalId, domain).scope, tenantId }, observedAt, expiresAt: deadline });
    const directory = new UserSourceStages(database), person = randomUUID(), environment = randomUUID();
    await directory.execute(generationInput({ scope: { ...generationInput().scope, tenantId, principalId },
      sessionEpoch: identity.sessionEpoch, observedAt, expiresAt: deadline }), async lease => {
      const query = await directory.query(lease, "discovery", "synthetic:lifecycle-browser-directory");
      await directory.page(lease, query, "synthetic:lifecycle-browser-directory", 1, 1);
      await directory.directory(lease, query, [fixtureDirectoryUser(person, "Retained person", "retained@example.invalid")]);
      await directory.finishQuery(lease, query);
    }, { beforePublish: async () => {} });
    const native = await nativeInventoryFixture(database, identity, [
      { nativeId: "native", displayName: "Retained native", identifiers: [], environmentId: environment,
        createdBy: person, details: { ownerId: person } },
      { nativeId: environment, identifiers: [], type: "microsoft.powerplatform/environments", displayName: "Retained environment" },
    ], { observedAt, expiresAt: deadline });
    const source = await store.execute(input("packages"), { domain: "packages", mode: "baseline", channel: "catalog" },
      async lease => {
        for (let offset = 0; offset < 1001; offset += 250) {
          const records = Array.from({ length: Math.min(250, 1001 - offset) }, (_, n) =>
            packageRecord(offset + n, `Before ${String(offset + n).padStart(4, "0")}`));
          const token = `synthetic:browser-${offset}`, nextToken = offset + 250 < 1001 ? `synthetic:browser-${offset + 250}` : null;
          await store.visit(lease, token);
          await store.appendBounded(lease, records);
          await store.acceptPage(lease, { token, nextToken, records, rawCount: records.length,
            expectedCount: 1001, page: Math.floor(offset / 250) + 1 }, records.length);
        }
      }, { authorize: async () => {} });
    await runtime.enqueue(identity);
    const canonical = (await runtime.reconciliation.runNext(input("canonical"), async () => {}))!;
    const sync = new DataSyncRepository(database);
    for (const [source, count] of [["graph_packages", 1001], ["power_platform", 2], ["users", 1]] as const) {
      await sync.recordSuccessMarker(identity, source, count, observedAt.toISOString());
    }
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let failed = false;
    const successor = store.execute({ ...input("packages"), observedAt: new Date(deadline.getTime() - 1) },
      { domain: "packages", mode: "delta", channel: "exact", targets: ["package-000000"] }, async lease => {
        await store.appendBounded(lease, [packageRecord(0, "After 0000")]);
        entered();
        await waiting;
        if (key.endsWith("failed")) throw new AppError(504, "provider_timeout", "Synthetic failed replacement");
      }, { authorize: async () => {} }).catch(error => {
        expect(error).toMatchObject({ status: 504, code: "provider_timeout" });
        failed = true;
      });
    await Promise.race([ready, successor.then(() => { throw new Error("fixture_successor_not_pending"); })]);
    if (key.endsWith("failed")) { release(); await successor; }
    return { identity, source, canonical, native, input, release, successor, failed: () => failed,
      started, deadline, gc: { slices: 0, maximumRows: 0, maximumBytes: 0, maximumMilliseconds: 0 } };
  }
  async function collect(subject: Awaited<ReturnType<typeof setup>>, passes = 2) {
    for (let pass = 0; pass < passes; pass++) {
      const roots = (await database.query(`SELECT r.scope_id AS "scopeId",r.tenant_id AS "tenantId",
        r.baseline_id AS "baselineId",r.revision,s.epoch FROM inventory_roots r JOIN data_scope_epochs s ON s.id=r.scope_id
        WHERE r.tenant_id=$1 AND s.principal_id=$2`, [tenantId, subject.identity.principalId])).rows;
      for (const root of roots) {
        const started = performance.now();
        for (const slice of [await store.gcSlice(root), await store.gcContent(root.scopeId, tenantId),
          await store.gcMetadataSlice(root.scopeId, tenantId)]) {
          expect(slice.rows).toBeLessThanOrEqual(1000);
          expect(slice.bytes).toBeLessThanOrEqual(1_048_576);
          subject.gc.slices++;
          subject.gc.maximumRows = Math.max(subject.gc.maximumRows, slice.rows);
          subject.gc.maximumBytes = Math.max(subject.gc.maximumBytes, slice.bytes);
        }
        const elapsed = performance.now() - started;
        expect(elapsed).toBeLessThan(5000);
        subject.gc.maximumMilliseconds = Math.max(subject.gc.maximumMilliseconds, elapsed);
      }
      await store.generations.connections.run(client => retainRecordData(client, 250));
    }
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://127.0.0.1");
      const key = url.searchParams.get("key") ?? "";
      if (request.method !== "POST" || !/^(desktop|mobile)-(running|failed)$/.test(key)
        || !["/setup", "/source", "/canonical", "/expire", "/retire", "/proof", "/finish"].includes(url.pathname)) {
        throw new Error("invalid_fixture_command");
      }
      if (url.pathname === "/setup") {
        if (subjects.has(key)) throw new Error("duplicate_fixture_subject");
        subjects.set(key, await setup(key));
      }
      const subject = subjects.get(key);
      if (!subject && url.pathname === "/finish") { response.statusCode = 204; response.end(); return; }
      if (!subject) throw new Error("missing_fixture_subject");
      if (url.pathname === "/source" || url.pathname === "/finish") { subject.release(); await subject.successor; }
      if (url.pathname === "/canonical") {
        await runtime.enqueue(subject.identity);
        await runtime.reconciliation.runNext(subject.input("canonical"), async () => {});
      }
      if (url.pathname === "/expire") await operator.query(`UPDATE data_read_selections
        SET expires_at=evaluated_at+interval '1 millisecond' WHERE tenant_id=$1 AND principal_id=$2`,
      [tenantId, subject.identity.principalId]);
      if (url.pathname === "/retire") await store.clear(subject.canonical.scopeId, tenantId);
      await collect(subject);
      const generations = (await database.query(`SELECT state,count(*)::int AS n FROM data_generations
        WHERE tenant_id=$1 AND scope_id IN (SELECT id FROM data_scope_epochs WHERE tenant_id=$1 AND principal_id=$2)
        AND expires_at<=clock_timestamp() GROUP BY state ORDER BY state`, [tenantId, subject.identity.principalId])).rows;
      const roots = (await database.query(`SELECT r.domain,r.revision FROM inventory_roots r JOIN data_scope_epochs s ON s.id=r.scope_id
        WHERE r.current AND s.tenant_id=$1 AND s.principal_id=$2 ORDER BY r.domain`, [tenantId, subject.identity.principalId])).rows;
      const selections = (await database.query(`SELECT id,endpoint FROM data_read_selections
        WHERE tenant_id=$1 AND principal_id=$2 ORDER BY id LIMIT 100`, [tenantId, subject.identity.principalId])).rows;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ scenario: `lifecycle-${key}`, failed: subject.failed(), generations, roots, selections,
        gc: subject.gc, deadline: subject.deadline, elapsedMilliseconds: performance.now() - subject.started }));
    } catch (error) {
      console.error(error);
      response.statusCode = 500;
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_control_unavailable");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const subject of subjects.values()) subject.release();
      await Promise.all([...subjects.values()].map(subject => subject.successor));
      await closeFixtureServer(server);
    },
  };
}
