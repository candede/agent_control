import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DataExports, type ExportAudit } from "./dataExports.js";
import { DataSelections, canonicalQuery } from "./dataSelections.js";
import { DataGenerations } from "../db/dataGenerations.js";
import { retainRecordData } from "../db/dataRetention.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { generationInput, selectionIdentity as fixtureIdentity } from "../../scripts/largeTenantFixtures.js";
import { digest } from "../db/dataBounds.js";
import { unknownOrigin, withActionOrigin } from "./actionOrigin.js";

describe("persisted bounded exports", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  let exports: DataExports;
  let selections: DataSelections;
  let generations: DataGenerations;
  let scopeId: string;
  let selectionIdentity: typeof fixtureIdentity;
  let selectionId: string;
  const queryHash = canonicalQuery({}, []);
  const audit: ExportAudit = async (client, event) => {
    expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("read committed");
    await client.query("INSERT INTO export_audit_fixture(event) VALUES($1::jsonb)", [JSON.stringify(event)]);
  };
  const eventsFor = async (exportId: string) => (await fixture.runtime.query<{ event: Parameters<ExportAudit>[1] }>(
    "SELECT event FROM export_audit_fixture WHERE event->>'exportId'=$1 ORDER BY ordinal", [exportId])).rows.map(row => row.event);
  beforeAll(async () => {
    fixture = await testDatabase();
    await fixture.operator.query(`CREATE TABLE export_read_fixture(id integer PRIMARY KEY, value integer NOT NULL);
      GRANT SELECT, INSERT, UPDATE ON export_read_fixture TO agentcontrol_app;
      CREATE TABLE export_audit_fixture(ordinal bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event jsonb NOT NULL);
      GRANT SELECT, INSERT ON export_audit_fixture TO agentcontrol_app;
      GRANT USAGE ON SEQUENCE export_audit_fixture_ordinal_seq TO agentcontrol_app`);
    await fixture.runtime.query("INSERT INTO export_read_fixture VALUES(1,10),(2,20)");
  }, 30_000);
  beforeEach(async () => {
    selectionIdentity = { ...fixtureIdentity, tenantId: `exports-${randomUUID()}` };
    generations = new DataGenerations(fixture.runtime);
    const input = generationInput();
    const lease = await generations.begin({ ...input, scope: { ...input.scope, tenantId: selectionIdentity.tenantId } });
    await generations.validate(lease, { rows: 0, children: 0, batches: 0, pages: 0, wireRows: 0 });
    await generations.publish(lease);
    scopeId = lease.scopeId;
    selections = new DataSelections(fixture.runtime);
    selectionId = (await selections.capture(selectionIdentity, "/users", { values: {}, allowed: [] }, [{
      kind: "generation", scopeId, generationId: lease.id, revision: "1", expiresAt: new Date(Date.now() + 3600_000),
    }])).id;
    exports = new DataExports(fixture.runtime, selections, audit);
    await fixture.runtime.query("UPDATE export_read_fixture SET value=id*10");
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  const create = () => exports.create(selectionIdentity, { selectionId, queryHash, kind: "copilot_users", filename: "users.csv" });
  it("persists one initiating origin with acceptance, preserves it through replay/build, and attributes cancellation separately", async () => {
    const mcp = { ...unknownOrigin, channel: "mcp" as const, integrationClientId: "33333333-3333-3333-3333-333333333333", requestId: randomUUID() };
    const web = { ...unknownOrigin, channel: "webapp" as const, integrationClientId: "22222222-2222-2222-2222-222222222222", requestId: randomUUID() };
    const input = { selectionId, queryHash, kind: "copilot_users" as const, filename: "users.csv", idempotencyKey: randomUUID() };
    const id = await withActionOrigin(mcp, () => exports.create(selectionIdentity, input));
    expect(await withActionOrigin(web, () => exports.create(selectionIdentity, input))).toBe(id);
    await withActionOrigin(web, () => exports.build(id, selectionIdentity, ["Name"], async function* () { yield [{ Name: "=1+1" }]; }));
    await withActionOrigin(web, () => exports.cancel(id, selectionIdentity));
    expect((await fixture.runtime.query("SELECT origin FROM data_exports WHERE id=$1", [id])).rows[0].origin).toEqual(mcp);
    expect((await eventsFor(id)).map(event => [event.phase, event.status])).toEqual([
      ["build", "started"], ["build", "succeeded"], ["cancel", "started"], ["cancel", "succeeded"],
    ]);
    await expect(fixture.runtime.query("UPDATE data_exports SET origin=$2 WHERE id=$1", [id, web])).rejects.toThrow("immutable");
  });
  it("persists bounded chunks, defends formulas, polls metadata, verifies stream integrity without files", async () => {
    const id = await create();
    await exports.build(id, selectionIdentity, ["Name"], async function* () {
      yield [{ Name: "=formula" }, { Name: "界".repeat(100_000) }];
    });
    const status = await exports.status(id, selectionIdentity);
    expect(status).toMatchObject({ status: "ready", rows: 2 });
    expect(Object.keys(status)).not.toContain("chunks");
    const sizes = (await fixture.runtime.query("SELECT max(byte_count)::int AS maximum FROM data_export_chunks WHERE export_id=$1", [id])).rows[0];
    expect(sizes.maximum).toBeLessThanOrEqual(262_144);
    let bytes = 0;
    let first = "";
    for await (const chunk of exports.download(id, selectionIdentity, new AbortController().signal)) {
      bytes += chunk.length;
      if (first.length < 40) first += chunk.toString().slice(0, 40);
    }
    expect(first).toContain("'=formula");
    expect(bytes).toBe(status.bytes);
    expect((await eventsFor(id)).map(event => [event.phase, event.status])).toEqual([
      ["build", "started"], ["build", "succeeded"], ["download", "started"], ["download", "succeeded"],
    ]);
    await expect(fixture.runtime.query("UPDATE data_export_chunks SET checksum=repeat('0',64) WHERE export_id=$1", [id])).rejects.toThrow("permission denied");
  });
  it("batches chunk persistence and verification within one MiB without changing artifact bytes or chunk limits", async () => {
    const id = await create(), value = "x".repeat(65_000);
    const expected = Buffer.from(`\uFEFFName\r\n${`"${value}"\r\n`.repeat(20)}`);
    const query = vi.spyOn(pg.Client.prototype, "query");
    try {
      await exports.build(id, selectionIdentity, ["Name"], async function* () {
        for (let index = 0; index < 20; index++) yield [{ Name: value }];
      });
      expect(query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO data_export_chunks"))).toHaveLength(2);
      expect(query.mock.calls.filter(([sql]) => String(sql).startsWith("SELECT bytes,byte_count,checksum"))).toHaveLength(2);
    } finally { query.mockRestore(); }
    expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "ready", rows: 20, bytes: expected.length });
    const chunks = (await fixture.runtime.query<{ ordinal: number; byte_count: number }>(
      "SELECT ordinal,byte_count FROM data_export_chunks WHERE export_id=$1 ORDER BY ordinal", [id])).rows;
    expect(chunks.map(chunk => chunk.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(chunks.every(chunk => chunk.byte_count <= 262_144)).toBe(true);
    expect((await fixture.runtime.query("SELECT checksum FROM data_exports WHERE id=$1", [id])).rows[0].checksum).toBe(digest(expected));
    const downloaded: Buffer[] = [];
    for await (const chunk of exports.download(id, selectionIdentity, new AbortController().signal)) downloaded.push(chunk);
    expect(Buffer.concat(downloaded)).toEqual(expected);
    expect((await eventsFor(id)).map(event => [event.phase, event.status])).toEqual([
      ["build", "started"], ["build", "succeeded"], ["download", "started"], ["download", "succeeded"],
    ]);
  });
  it("audits disconnect/failure and never publishes a failed producer", async () => {
    const id = await create();
    await exports.build(id, selectionIdentity, ["Name"], async function* () { yield [{ Name: "one" }]; });
    const signal = new AbortController();
    const iterator = exports.download(id, selectionIdentity, signal.signal);
    await iterator.next();
    signal.abort(new Error("disconnect"));
    await expect(iterator.next()).rejects.toThrow("disconnect");
    expect((await eventsFor(id)).at(-1)).toMatchObject({ phase: "download", status: "cancelled" });
    const failed = await create();
    await expect(exports.build(failed, selectionIdentity, ["Name"], async function* () {
      yield [{ Name: "first" }]; throw new Error("provider failed");
    })).rejects.toThrow("provider failed");
    expect(await exports.status(failed, selectionIdentity)).toMatchObject({ status: "failed" });
    expect((await eventsFor(failed)).map(event => event.status)).toEqual(["started", "failed"]);
  });
  it("cancels an idle source immediately, persists expiry and detects artifact corruption", async () => {
    const id = await create();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const parent = new AbortController();
    const building = exports.build(id, selectionIdentity, ["Name"], async function* (signal) {
      started();
      signal.throwIfAborted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      yield [{ Name: "unreachable" }];
    }, parent.signal);
    try {
      await Promise.race([ready, building]);
      const failed = expect(building).rejects.toThrow("export_cancelled");
      await new DataExports(fixture.runtime, selections, audit).cancel(id, selectionIdentity);
      await failed;
    } finally {
      parent.abort(new Error("fixture_cleanup"));
      await building.catch(() => {});
    }
    expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "cancelled" });
    expect((await eventsFor(id)).filter(event => event.phase === "build").map(event => event.status)).toEqual(["started", "cancelled"]);
    expect((await eventsFor(id)).filter(event => event.phase === "cancel").map(event => event.status)).toEqual(["started", "succeeded"]);
    const expired = await create(), independentlyOwned = await create();
    await fixture.operator.query("UPDATE data_exports SET expires_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])", [[expired, independentlyOwned]]);
    expect(await exports.expire(expired)).toBe(1);
    expect((await fixture.runtime.query("SELECT status FROM data_exports WHERE id=$1", [independentlyOwned])).rows[0].status).toBe("queued");
    expect(await exports.expire()).toBeGreaterThan(0);
    expect(await exports.status(expired, selectionIdentity)).toMatchObject({ status: "expired" });
    const corrupt = await create();
    await exports.build(corrupt, selectionIdentity, ["Name"], async function* () { yield [{ Name: "ok" }]; });
    await fixture.operator.query("UPDATE data_exports SET checksum=repeat('0',64) WHERE id=$1", [corrupt]);
    await expect(async () => {
      for await (const chunk of exports.download(corrupt, selectionIdentity, new AbortController().signal)) expect(chunk.length).toBeGreaterThan(0);
    }).rejects.toThrow("export_checksum");
    expect((await eventsFor(corrupt)).at(-1)).toMatchObject({ phase: "download", status: "failed" });
  });
  it("persists explicit intent and supplies bounded selected-ID pages to producers", async () => {
    expect(() => exports.create(selectionIdentity, { selectionId, queryHash, kind: "copilot_users", filename: "users.csv", ids: Array(5001).fill("x") })).toThrow("export_explicit_ids");
    const ids = Array.from({ length: 251 }, (_, i) => `selected-${i}`);
    const id = await exports.create(selectionIdentity, { selectionId, queryHash, kind: "copilot_users", filename: "users.csv", ids });
    const batches: number[] = [];
    await exports.build(id, selectionIdentity, ["Name"], async function* (_signal, context) {
      expect(context.mode).toBe("explicit");
      expect(context.query).toEqual({});
      for await (const selected of context.selectedIds()) {
        batches.push(selected.length);
        yield selected.map(Name => ({ Name }));
      }
    });
    expect(batches).toEqual([250, 1]);
    expect(await exports.status(id, selectionIdentity)).toMatchObject({ rows: 251, status: "ready" });
    await expect(fixture.runtime.query("UPDATE data_export_items SET identity='poison' WHERE export_id=$1", [id])).rejects.toThrow("permission denied");
  });
  it("uses repeatable-read source batches, selected IDs, chunk verification, status and downloads", async () => {
    const id = await exports.create(selectionIdentity, { selectionId, queryHash, kind: "copilot_users", filename: "users.csv", ids: ["1", "2"] });
    const phases: string[] = [];
    let phase = "admission";
    const selectedRead = exports.connections.selectedRead.bind(exports.connections);
    const observe = vi.spyOn(exports.connections, "selectedRead").mockImplementation((work, options) =>
      selectedRead(async client => {
        expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
        phases.push(phase);
        return work(client);
      }, options));
    try {
      await exports.build(id, selectionIdentity, ["Value"], async function* (_signal, context) {
        phase = "selected-ids";
        for await (const ids of context.selectedIds()) {
          phase = "source";
          yield await context.read(async client => {
            const rows = (await client.query<{ Value: number }>('SELECT value AS "Value" FROM export_read_fixture WHERE id=ANY($1::int[]) ORDER BY id', [ids])).rows;
            await exports.connections.run(writer => writer.query("UPDATE export_read_fixture SET value=value+1"));
            expect((await client.query("SELECT sum(value)::int AS total FROM export_read_fixture")).rows[0].total).toBe(30);
            return rows;
          });
          phase = "selected-ids";
        }
        phase = "verification";
      });
      phase = "status";
      expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "ready", rows: 2 });
      phase = "download";
      const chunks: string[] = [];
      for await (const chunk of exports.download(id, selectionIdentity, new AbortController().signal)) chunks.push(chunk.toString());
      expect(chunks.join("")).toBe("\uFEFFValue\r\n\"10\"\r\n\"20\"\r\n");
      expect(new Set(phases)).toEqual(new Set(["selected-ids", "source", "verification", "status", "download"]));
    } finally { observe.mockRestore(); }
  });
  it("fails and audits a source serialization conflict without publishing or replaying it", async () => {
    const id = await create();
    let calls = 0;
    await expect(exports.build(id, selectionIdentity, ["Value"], async function* (_signal, context) {
      yield await context.read(async client => {
        calls++;
        await client.query("SELECT value FROM export_read_fixture WHERE id=1");
        await exports.connections.run(writer => writer.query("UPDATE export_read_fixture SET value=value+1 WHERE id=1"));
        await client.query("SELECT value FROM export_read_fixture WHERE id=1 FOR UPDATE");
        return [{ Value: "unreachable" }];
      });
    })).rejects.toMatchObject({ code: "data_read_conflict", cause: { code: "40001" } });
    expect(calls).toBe(1);
    expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "failed", error: "data_read_conflict" });
    expect((await eventsFor(id)).at(-1)).toMatchObject({ phase: "build", status: "failed", errorCode: "data_read_conflict" });
    expect((await fixture.runtime.query("SELECT ordinal FROM data_export_chunks WHERE export_id=$1", [id])).rowCount).toBe(0);
  });
  it("serializes a lease renewal before the next source snapshot without replaying selected reads", async () => {
    const id = await create();
    let renewal: Promise<void> | undefined;
    let reads = 0;
    await exports.build(id, selectionIdentity, ["Value"], async function* (_signal, context) {
      const before = await context.read(async client => {
        reads++;
        const previous = (await client.query("SELECT lease_until FROM data_exports WHERE id=$1", [id])).rows[0].lease_until;
        renewal = exports.connections.run(async renewed => {
          await renewed.query("UPDATE data_exports SET lease_until=lease_until+interval '1 second' WHERE id=$1", [id]);
        }, true, undefined, id);
        void renewal.catch(() => {});
        await vi.waitFor(async () => {
          const waiting = (await fixture.operator.query(`SELECT count(*)::int AS count FROM pg_locks
            WHERE locktype='advisory' AND NOT granted AND objsubid=1
              AND classid::bigint=((hashtextextended($1,149)>>32)&4294967295)
              AND objid::bigint=(hashtextextended($1,149)&4294967295)`, [id])).rows[0].count;
          expect(waiting).toBeGreaterThanOrEqual(1);
        }, { timeout: 5000, interval: 25 });
        return previous as Date;
      });
      await renewal;
      const after = await context.read(async client => {
        reads++;
        return (await client.query("SELECT lease_until FROM data_exports WHERE id=$1", [id])).rows[0].lease_until as Date;
      });
      expect(after.getTime()).toBe(before.getTime() + 1000);
      yield [{ Value: "renewed" }];
    });
    expect(reads).toBe(2);
    expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "ready", rows: 1 });
  }, 10_000);
  it.each([undefined, []] as const)("publishes header-only output for zero rows (explicit IDs: %j)", async ids => {
    const id = await exports.create(selectionIdentity, { selectionId, queryHash, kind: "copilot_users", filename: "users.csv", ids });
    await exports.build(id, selectionIdentity, ["Name"], async function* (_signal, context) {
      expect(context.mode).toBe(ids === undefined ? "all" : "explicit");
      const selected: string[] = [];
      for await (const page of context.selectedIds()) selected.push(...page);
      expect(selected).toEqual([]);
    });
    const chunks: Buffer[] = [];
    for await (const chunk of exports.download(id, selectionIdentity, new AbortController().signal)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("\uFEFFName\r\n");
    expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "ready", rows: 0, bytes: 9 });
  });
  it("keeps ready cancellation idempotent without rewriting the committed build receipt", async () => {
    const id = await create();
    await exports.build(id, selectionIdentity, ["Name"], async function* () { yield [{ Name: "one" }]; });
    const requester = new DataExports(fixture.runtime, selections, audit);
    await requester.cancel(id, selectionIdentity);
    await requester.cancel(id, selectionIdentity);
    expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "cancelled" });
    await expect(exports.download(id, selectionIdentity, new AbortController().signal).next()).rejects.toThrow("export_not_ready");
    expect((await eventsFor(id)).filter(event => event.phase === "build").map(event => event.status)).toEqual(["started", "succeeded"]);
    expect((await eventsFor(id)).filter(event => event.phase === "cancel").map(event => event.status)).toEqual(["started", "succeeded"]);
  });
  it("retains selected roots past page TTL but never past artifact expiry, and collects terminal chunks", async () => {
    const id = await create();
    await fixture.operator.query("UPDATE data_read_selections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [selectionId]);
    await expect(create()).rejects.toMatchObject({ code: "selection_invalidated" });
    await exports.build(id, selectionIdentity, ["Name"], async function* (_signal, context) {
      yield await context.read(async () => [{ Name: "still pinned" }]);
    });
    expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "ready" });
    const chunks: Buffer[] = [];
    for await (const chunk of exports.download(id, selectionIdentity, new AbortController().signal)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toContain("still pinned");
    await fixture.operator.query("UPDATE data_exports SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    expect(await exports.expire(id)).toBe(1);
    expect(await exports.expire(id)).toBe(0);
    expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "expired" });
    await expect(exports.download(id, selectionIdentity, new AbortController().signal).next()).rejects.toThrow();
    for (let index = 0; index < 16; index++) await exports.connections.run(client => retainRecordData(client));
    expect((await fixture.runtime.query("SELECT ordinal FROM data_export_chunks WHERE export_id=$1", [id])).rowCount).toBe(0);
    expect((await fixture.runtime.query("SELECT ordinal FROM data_generation_pins WHERE selection_id=$1", [selectionId])).rowCount).toBe(0);
    expect((await eventsFor(id)).filter(event => event.phase === "build").map(event => event.status)).toEqual(["started", "succeeded"]);
  });
  it("reuses committed creation across instances, rejects changed intent, and persists only one start", async () => {
    const input = { selectionId, queryHash, kind: "copilot_users" as const, filename: "users.csv", ids: ["one"], idempotencyKey: randomUUID() };
    const requester = new DataExports(fixture.runtime, selections, audit);
    const [id, retried] = await Promise.all([exports.create(selectionIdentity, input), requester.create(selectionIdentity, input)]);
    expect(retried).toBe(id);
    await expect(requester.create(selectionIdentity, { ...input, ids: ["two"] })).rejects.toMatchObject({ code: "export_idempotency_conflict" });
    await expect(requester.create(selectionIdentity, { ...input, ids: undefined })).rejects.toMatchObject({ code: "export_idempotency_conflict" });
    await exports.cancel(id, selectionIdentity);
    expect(await requester.create(selectionIdentity, input)).toBe(id);
    expect((await eventsFor(id)).filter(event => event.phase === "build").map(event => event.status)).toEqual(["started", "cancelled"]);
    expect((await eventsFor(id)).filter(event => event.phase === "cancel").map(event => event.status)).toEqual(["started", "succeeded"]);
  });
  it("rolls back cancellation and its receipt when the account fence changes during auditing", async () => {
    const id = await create();
    let current = true;
    const requester = new DataExports(fixture.runtime, selections, async (client, event) => {
      await audit(client, event);
      current = false;
    });
    await expect(requester.cancel(id, selectionIdentity, () => {
      if (!current) throw new Error("account_replaced");
    })).rejects.toThrow("account_replaced");
    expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "queued" });
    expect((await eventsFor(id)).map(event => event.status)).toEqual(["started"]);
  });
  it("rejects an extra immutable chunk inserted before publication", async () => {
    const id = await create();
    await expect(exports.build(id, selectionIdentity, ["Name"], async function* () {
      const bytes = Buffer.from("extra");
      await fixture.runtime.query(`INSERT INTO data_export_chunks(export_id,tenant_id,ordinal,bytes,byte_count,checksum)
        VALUES($1,$2,99,$3,$4,encode(sha256($3::bytea),'hex'))`, [id, selectionIdentity.tenantId, bytes, bytes.length]);
      yield [{ Name: "one" }];
    })).rejects.toThrow("export_checksum");
    expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "failed", error: "export_checksum" });
    expect((await eventsFor(id)).map(event => event.status)).toEqual(["started", "failed"]);
  });
  it.each(["missing", "extra"] as const)("rejects metadata claiming %s downloaded chunks before releasing bytes", async corruption => {
    const id = await create();
    await exports.build(id, selectionIdentity, ["Name"], async function* () { yield [{ Name: "x".repeat(300_000) }]; });
    const adjustment = corruption === "missing" ? 1 : -1;
    await fixture.operator.query("UPDATE data_exports SET chunk_count=chunk_count+$2,byte_count=byte_count+$2*262144 WHERE id=$1", [id, adjustment]);
    await expect(exports.download(id, selectionIdentity, new AbortController().signal).next()).rejects.toThrow("export_checksum");
    expect((await eventsFor(id)).at(-1)).toMatchObject({ phase: "download", status: "failed", bytes: 0 });
  });
  it.each(["selection", "session", "generation"] as const)("withdraws the next chunk after %s invalidation", async invalidation => {
    const id = await create();
    await exports.build(id, selectionIdentity, ["Name"], async function* () { yield [{ Name: "x".repeat(300_000) }]; });
    const iterator = exports.download(id, selectionIdentity, new AbortController().signal);
    try {
      expect((await iterator.next()).value?.length).toBe(262_144);
      if (invalidation === "selection") await selections.invalidate(selectionId, selectionIdentity);
      if (invalidation === "session") await generations.revokePrincipal(selectionIdentity.tenantId, selectionIdentity.principalId);
      if (invalidation === "generation") await generations.invalidate(scopeId, selectionIdentity.tenantId);
      await expect(iterator.next()).rejects.toMatchObject({ code: "selection_invalidated" });
    } finally { await iterator.return(undefined); }
    expect((await eventsFor(id)).filter(event => event.phase === "download").map(event => event.status)).toEqual(["started", "failed"]);
    expect((await eventsFor(id)).at(-1)).toMatchObject({ bytes: 262_144 });
  });
  it("reclaims an abandoned lease across instances without replaying its producer or overwriting expiry", async () => {
    const id = await create(), started = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    let calls = 0;
    const building = exports.build(id, selectionIdentity, ["Name"], async function* () {
      calls++; started.resolve();
      await resume.promise;
      yield [{ Name: "must not publish" }];
    });
    try {
      await Promise.race([started.promise, building]);
      const requester = new DataExports(fixture.runtime, selections, audit);
      await fixture.operator.query("UPDATE data_exports SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
      expect(await requester.expire(id)).toBe(1);
      resume.resolve();
      await expect(building).rejects.toThrow("export_fenced");
      await expect(requester.build(id, selectionIdentity, ["Name"], async function* () {
        calls++; yield [{ Name: "must not restart" }];
      })).rejects.toThrow("export_not_queued");
    } finally { resume.resolve(); await building.catch(() => {}); }
    expect(calls).toBe(1);
    expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "expired" });
    expect((await eventsFor(id)).map(event => event.status)).toEqual(["started", "failed"]);
    expect((await fixture.runtime.query("SELECT ordinal FROM data_export_chunks WHERE export_id=$1", [id])).rowCount).toBe(0);
  });
  it("records transport finish failure without first committing a successful download", async () => {
    const id = await create();
    await exports.build(id, selectionIdentity, ["Name"], async function* () { yield [{ Name: "one" }]; });
    const publication = {
      validate: async () => () => {},
      finish: vi.fn(async () => { throw new Error("transport_finish_failed"); }),
      failed: vi.fn(),
    };
    const iterator = exports.download(id, selectionIdentity, new AbortController().signal, publication);
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow("transport_finish_failed");
    expect(publication.failed).toHaveBeenCalledOnce();
    expect((await eventsFor(id)).filter(event => event.phase === "download").map(event => event.status)).toEqual(["started", "inconclusive", "failed"]);
  });
});
