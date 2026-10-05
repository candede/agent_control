import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DataExports, type ExportAudit } from "./dataExports.js";
import { DataSelections, canonicalQuery } from "./dataSelections.js";
import { DataGenerations } from "../db/dataGenerations.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";

describe("persisted bounded exports", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  let exports: DataExports;
  let selectionId: string;
  const queryHash = canonicalQuery({}, []);
  const events: Parameters<ExportAudit>[1][] = [];
  beforeAll(async () => {
    fixture = await testDatabase();
    const generations = new DataGenerations(fixture.runtime);
    const lease = await generations.begin(generationInput());
    await generations.validate(lease, { rows: 0, children: 0, batches: 0, pages: 0, wireRows: 0 });
    await generations.publish(lease);
    const selections = new DataSelections(fixture.runtime);
    selectionId = (await selections.capture(selectionIdentity, "/users", { values: {}, allowed: [] }, [{
      kind: "generation", scopeId: lease.scopeId, generationId: lease.id, revision: "1", expiresAt: new Date(Date.now() + 600_000),
    }])).id;
    exports = new DataExports(fixture.runtime, selections, async (client, event) => {
      expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("read committed");
      events.push(event);
    });
    await fixture.operator.query(`CREATE TABLE export_read_fixture(id integer PRIMARY KEY, value integer NOT NULL);
      GRANT SELECT, INSERT, UPDATE ON export_read_fixture TO agentcontrol_app`);
    await fixture.runtime.query("INSERT INTO export_read_fixture VALUES(1,10),(2,20)");
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  const create = () => exports.create(selectionIdentity, { selectionId, queryHash, kind: "copilot_users", filename: "users.csv" });
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
    expect(events.at(-1)).toMatchObject({ phase: "download", status: "succeeded" });
    await expect(fixture.runtime.query("UPDATE data_export_chunks SET checksum=repeat('0',64) WHERE export_id=$1", [id])).rejects.toThrow("permission denied");
  });
  it("audits disconnect/failure and never publishes a failed producer", async () => {
    const id = await create();
    await exports.build(id, selectionIdentity, ["Name"], async function* () { yield [{ Name: "one" }]; });
    const signal = new AbortController();
    const iterator = exports.download(id, selectionIdentity, signal.signal);
    await iterator.next();
    signal.abort(new Error("disconnect"));
    await expect(iterator.next()).rejects.toThrow("disconnect");
    expect(events.at(-1)).toMatchObject({ phase: "download", status: "failed" });
    const failed = await create();
    await expect(exports.build(failed, selectionIdentity, ["Name"], async function* () {
      yield [{ Name: "first" }]; throw new Error("provider failed");
    })).rejects.toThrow("provider failed");
    expect(await exports.status(failed, selectionIdentity)).toMatchObject({ status: "failed" });
  });
  it("cancels an idle source immediately, persists expiry and detects artifact corruption", async () => {
    const id = await create();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const building = exports.build(id, selectionIdentity, ["Name"], async function* (signal) {
      started();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      yield [{ Name: "unreachable" }];
    });
    const failed = expect(building).rejects.toThrow("export_cancelled");
    await ready;
    await exports.cancel(id, selectionIdentity);
    await failed;
    expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "cancelled" });
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
    expect(events.at(-1)).toMatchObject({ phase: "download", status: "failed" });
  });
  it("persists explicit/all intent and supplies bounded selected-ID pages to producers", async () => {
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
    let phase = "build";
    const selectedRead = exports.connections.selectedRead.bind(exports.connections);
    const observe = vi.spyOn(exports.connections, "selectedRead").mockImplementation((work, options) =>
      selectedRead(async client => {
        expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
        phases.push(phase);
        return work(client);
      }, options));
    try {
      await exports.build(id, selectionIdentity, ["Value"], async function* (_signal, context) {
        for await (const ids of context.selectedIds()) {
          yield await context.read(async client => {
            const rows = (await client.query<{ Value: number }>('SELECT value AS "Value" FROM export_read_fixture WHERE id=ANY($1::int[]) ORDER BY id', [ids])).rows;
            await exports.connections.run(writer => writer.query("UPDATE export_read_fixture SET value=value+1"));
            expect((await client.query("SELECT sum(value)::int AS total FROM export_read_fixture")).rows[0].total).toBe(30);
            return rows;
          });
        }
      });
      phase = "status";
      expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "ready", rows: 2 });
      phase = "download";
      const chunks: string[] = [];
      for await (const chunk of exports.download(id, selectionIdentity, new AbortController().signal)) chunks.push(chunk.toString());
      expect(chunks.join("")).toBe("\uFEFFValue\r\n\"10\"\r\n\"20\"\r\n");
      expect(phases).toEqual(["build", "build", "build", "build", "status", "download"]);
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
            await vi.waitFor(async () => {
              const waiting = (await fixture.operator.query(`SELECT count(*)::int AS count FROM pg_locks
                WHERE locktype='advisory' AND NOT granted AND objsubid=1
                  AND classid::bigint=((hashtextextended($1,149)>>32)&4294967295)
                  AND objid::bigint=(hashtextextended($1,149)&4294967295)`, [id])).rows[0].count;
              expect(waiting).toBe(1);
            });
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
      });
    })).rejects.toMatchObject({ code: "data_read_conflict", cause: { code: "40001" } });
    expect(calls).toBe(1);
    expect(await exports.status(id, selectionIdentity)).toMatchObject({ status: "failed", error: "data_read_conflict" });
    expect(events.at(-1)).toMatchObject({ phase: "build", status: "failed", errorCode: "data_read_conflict" });
    expect((await fixture.runtime.query("SELECT ordinal FROM data_export_chunks WHERE export_id=$1", [id])).rowCount).toBe(0);
  });
});
