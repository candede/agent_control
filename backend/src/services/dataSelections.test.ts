import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CursorCodec, DataSelections, canonicalQuery } from "./dataSelections.js";
import { DataGenerations } from "../db/dataGenerations.js";
import { dataConnections,isSelectedRead } from "../db/dataConnections.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { directoryRecord, generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";

describe("selected-read transactions", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  let selections: DataSelections;
  let selectionId: string;
  let scopeId: string;
  let generationId: string;
  beforeAll(async () => {
    fixture = await testDatabase();
    await fixture.operator.query(`CREATE TABLE selected_read_fixture(id integer PRIMARY KEY, value integer NOT NULL);
      GRANT SELECT, INSERT, UPDATE ON selected_read_fixture TO agentcontrol_app`);
    await fixture.runtime.query("INSERT INTO selected_read_fixture VALUES(1,10)");
    const generations = new DataGenerations(fixture.runtime);
    const lease = await generations.begin(generationInput());
    scopeId = lease.scopeId;
    generationId = lease.id;
    await generations.validate(lease, { rows: 0, children: 0, batches: 0, pages: 0, wireRows: 0 });
    await generations.publish(lease);
    selections = new DataSelections(fixture.runtime);
    selectionId = (await selections.capture(selectionIdentity, "/users", { values: {}, allowed: [] }, [{
      kind: "generation", scopeId, generationId: lease.id, revision: "1", expiresAt: new Date(Date.now() + 600_000),
    }])).id;
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise,release: () => release() };
  };
  const promptly = async (value: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([value,new Promise((_,reject) => { timer = setTimeout(() => reject(new Error("selected_read_serialized")),1000); })]);
    } finally { clearTimeout(timer); }
  };
  it("overlaps selected readers, read-only actor lookup and capture while fencing a real epoch update until both readers commit",async () => {
    const release = deferred(),first = deferred(),second = deferred(),writing = deferred();
    const tasks: Promise<unknown>[] = [];
    let updated = false,results: PromiseSettledResult<unknown>[] = [];
    const track = (value: Promise<unknown>) => { tasks.push(value);void value.catch(() => {});return value; };
    try {
      track(selections.read(selectionId,selectionIdentity,async client => {
        expect(isSelectedRead(client)).toBe(true);
        first.release();await release.promise;
        await selections.assert(client,selectionId,selectionIdentity);
      }));
      await promptly(first.promise);
      track(selections.read(selectionId,selectionIdentity,async client => {
        expect(isSelectedRead(client)).toBe(true);
        second.release();await release.promise;
        await selections.assert(client,selectionId,selectionIdentity);
      }));
      await promptly(second.promise);
      await promptly(track(new DataGenerations(fixture.runtime).sessionEpoch(selectionIdentity.tenantId,selectionIdentity.principalId)
        .then(epoch => { expect(epoch).toBe(selectionIdentity.sessionEpoch); })));
      await promptly(track(selections.capture(selectionIdentity,"/users",{ values: {},allowed: [] },[{
        kind: "generation",scopeId,generationId,revision: "1",expiresAt: new Date(Date.now()+600_000),
      }])));
      track(dataConnections(fixture.runtime).run(async client => {
        expect(isSelectedRead(client)).toBe(false);
        await client.query("SAVEPOINT epoch_probe");
        writing.release();
        await client.query("UPDATE data_scope_epochs SET epoch=epoch+1 WHERE id=$1",[scopeId]);
        updated = true;
        await client.query("ROLLBACK TO SAVEPOINT epoch_probe");
        await client.query("RELEASE SAVEPOINT epoch_probe");
      }));
      await promptly(writing.promise);
      await new Promise(resolve => setTimeout(resolve,50));
      expect(updated).toBe(false);
    } finally { release.release();results = await Promise.allSettled(tasks); }
    expect(results.every(value => value.status==="fulfilled")).toBe(true);
    expect(updated).toBe(true);
  });
  it("keeps ordinary writer assertions exclusive against selected readers",async () => {
    const entered = deferred(),release = deferred();
    let readStarted = false,writer: Promise<unknown> | undefined,reader: Promise<unknown> | undefined;
    try {
      writer = dataConnections(fixture.runtime).run(async client => {
        expect(isSelectedRead(client)).toBe(false);
        await selections.assert(client,selectionId,selectionIdentity);
        entered.release();await release.promise;
      });
      await promptly(entered.promise);
      reader = selections.read(selectionId,selectionIdentity,async () => { readStarted = true; });
      await new Promise(resolve => setTimeout(resolve,50));
      expect(readStarted).toBe(false);
    } finally { release.release();await Promise.all([writer,reader]); }
    expect(readStarted).toBe(true);
  });
  it("continues fencing a real actor epoch change until selected readers commit",async () => {
    const entered = deferred(),release = deferred(),writing = deferred();
    let updated = false;
    const reader = selections.read(selectionId,selectionIdentity,async () => { entered.release();await release.promise; });
    void reader.catch(() => {});
    let writer: Promise<unknown> | undefined;
    try {
      await promptly(entered.promise);
      writer = dataConnections(fixture.runtime).run(async client => {
        await client.query("SAVEPOINT actor_probe");writing.release();
        await client.query("UPDATE data_principal_epochs SET epoch=epoch+1 WHERE tenant_id=$1 AND principal_id=$2",
          [selectionIdentity.tenantId,selectionIdentity.principalId]);
        updated = true;await client.query("ROLLBACK TO SAVEPOINT actor_probe");
      });
      void writer.catch(() => {});
      await promptly(writing.promise);await new Promise(resolve => setTimeout(resolve,50));
      expect(updated).toBe(false);
    } finally { release.release();await Promise.all([reader,writer]); }
    expect(updated).toBe(true);
  });
  it("clears selected-read lock context on commit, rollback and pooled-client release",async () => {
    const connections = dataConnections(fixture.runtime);
    await connections.selectedRead(async client => { expect(isSelectedRead(client)).toBe(true); });
    await expect(connections.selectedRead(async client => {
      expect(isSelectedRead(client)).toBe(true);throw new Error("read_probe");
    })).rejects.toThrow("read_probe");
    for (let index=0;index<4;index++) await connections.run(async client => {
      expect(isSelectedRead(client)).toBe(false);
      expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("read committed");
    });
    const client = await fixture.runtime.connect();
    try { expect(isSelectedRead(client)).toBe(false); } finally { client.release(); }
  });
  it("uses runtime-role repeatable read without changing writer or pooled-session defaults", async () => {
    const connections = dataConnections(fixture.runtime);
    await connections.selectedRead(async client => {
      expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
      expect((await client.query("SELECT current_user")).rows[0].current_user).toBe("agentcontrol_app");
    });
    for (const renewal of [false, true]) await connections.run(async client => {
      expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("read committed");
    }, renewal);
  });
  it.each(["begin","abort","collection"] as const)("does not rewrite authorization epochs or conflict with selected reads during quota %s",async operation => {
    const generations = new DataGenerations(fixture.runtime);
    let lease: Awaited<ReturnType<DataGenerations["begin"]>> | undefined;
    if (operation!=="begin") lease = await generations.begin(generationInput());
    if (operation==="collection") {
      await generations.append(lease!,"directory",0,[directoryRecord("collected-quota")]);
      await generations.abort(lease!);
    }
    try {
      await generations.connections.selectedRead(async client => {
        const before = (await client.query("SELECT xmin::text AS version FROM data_scope_epochs WHERE id=$1",[scopeId])).rows[0].version;
        if (operation==="begin") lease = await generations.begin(generationInput());
        else if (operation==="abort") await generations.abort(lease!);
        else await generations.connections.run(async writer => {
          await writer.query("UPDATE data_generations SET state='deleting' WHERE id=$1",[lease!.id]);
          await writer.query("DELETE FROM directory_user_rows WHERE generation_id=$1",[lease!.id]);
          await writer.query("DELETE FROM data_generation_batches WHERE generation_id=$1",[lease!.id]);
          await writer.query("UPDATE data_generations SET collected_at=clock_timestamp() WHERE id=$1",[lease!.id]);
        });
        const after = (await fixture.runtime.query("SELECT xmin::text AS version FROM data_scope_epochs WHERE id=$1",[scopeId])).rows[0].version;
        process.stdout.write(JSON.stringify({ contract: "selected-read-quota-scope-version",operation,before,after })+"\n");
        await selections.assert(client,selectionId,selectionIdentity);
        expect(after).toBe(before);
        expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
      });
    } finally {
      if (operation==="begin" && lease) await generations.abort(lease);
    }
  });
  it("keeps multi-query values and counts coherent across a concurrent runtime commit", async () => {
    const connections = dataConnections(fixture.runtime);
    await selections.read(selectionId, selectionIdentity, async (client, { selection, pins }) => {
      expect(selection.id).toBe(selectionId);
      expect(pins).toHaveLength(1);
      expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
      expect((await client.query("SELECT value FROM selected_read_fixture WHERE id=1")).rows[0].value).toBe(10);
      await connections.run(async writer => {
        await writer.query("UPDATE selected_read_fixture SET value=20 WHERE id=1");
        await writer.query("INSERT INTO selected_read_fixture VALUES(2,30)");
      });
      expect((await client.query("SELECT value FROM selected_read_fixture ORDER BY id")).rows).toEqual([{ value: 10 }]);
      expect((await client.query("SELECT count(*)::int AS n FROM selected_read_fixture")).rows[0].n).toBe(1);
    });
    expect((await fixture.runtime.query("SELECT value FROM selected_read_fixture ORDER BY id")).rows).toEqual([{ value: 20 }, { value: 30 }]);
  });
  it("rolls back serialization conflicts and exposes retryable failure without replaying the callback", async () => {
    const connections = dataConnections(fixture.runtime);
    let calls = 0;
    await expect(connections.selectedRead(async client => {
      calls++;
      await client.query("SELECT value FROM selected_read_fixture WHERE id=1");
      await client.query("INSERT INTO selected_read_fixture VALUES(3,40)");
      await connections.run(writer => writer.query("UPDATE selected_read_fixture SET value=value+1 WHERE id=1"));
      await client.query("SELECT value FROM selected_read_fixture WHERE id=1 FOR UPDATE");
    })).rejects.toMatchObject({ status: 503, code: "data_read_conflict", retryAfterSeconds: 5, cause: { code: "40001" } });
    expect(calls).toBe(1);
    expect((await fixture.runtime.query("SELECT id FROM selected_read_fixture WHERE id=3")).rowCount).toBe(0);
    await connections.selectedRead(async client => {
      expect((await client.query("SELECT value FROM selected_read_fixture WHERE id=1 FOR UPDATE")).rows[0].value).toBe(21);
    });
  });
  it("rejects a fence changed after the snapshot, then reports invalidation on a fresh read", async () => {
    const connections = dataConnections(fixture.runtime);
    await expect(connections.selectedRead(async client => {
      await client.query("SELECT 1");
      await new DataGenerations(fixture.runtime).invalidate(scopeId, selectionIdentity.tenantId);
      await selections.assert(client, selectionId, selectionIdentity);
    })).rejects.toMatchObject({ code: "data_read_conflict", cause: { code: "40001" } });
    await expect(selections.read(selectionId, selectionIdentity, async () => "unreachable"))
      .rejects.toThrow("selection_invalidated");
  });
  it("releases capture admission after rollback and cancellation without leaking a session lock", async () => {
    const connections = dataConnections(fixture.runtime);
    const controller = new AbortController();
    await expect(connections.selectedRead(async () => { throw new Error("capture-failed"); },
      { admissionTenantId: selectionIdentity.tenantId })).rejects.toThrow("capture-failed");
    await expect(connections.selectedRead(async () => { controller.abort(new Error("capture-cancelled")); },
      { admissionTenantId: selectionIdentity.tenantId, signal: controller.signal })).rejects.toThrow("capture-cancelled");
    expect((await fixture.operator.query(`SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)).rows[0].n).toBe(0);
  });
});

describe("selection cursor authentication", () => {
  const codec = new CursorCodec("synthetic-session-secret-not-a-production-secret");
  const queryHash = canonicalQuery({ company: "Example", sort: "name" }, ["company", "sort"]);
  const expected = { identity: selectionIdentity, endpoint: "/users", selectionId: "selected", revision: "one", queryHash };
  const cursor = codec.encode({ ...expected, direction: "next", boundary: { key: null, nullRank: 1, id: "tied" } });
  it("canonicalizes filters and authenticates null/tie/direction boundaries", () => {
    expect(canonicalQuery({ sort: "name", company: "Example" }, ["company", "sort"])).toBe(queryHash);
    expect(codec.decode(cursor, expected).boundary).toEqual({ key: null, nullRank: 1, id: "tied" });
    expect(() => canonicalQuery({ all: true }, ["sort"])).toThrow("invalid_cursor");
  });
  it("rejects tampering, filter, principal, endpoint and revision reuse", () => {
    expect(() => codec.decode(`${cursor}x`, expected)).toThrow("invalid_cursor");
    for (const change of [{ queryHash: "other" }, { endpoint: "/other" }, { revision: "two" },
      { identity: { ...selectionIdentity, principalId: "other" } }]) {
      expect(() => codec.decode(cursor, { ...expected, ...change })).toThrow("invalid_cursor");
    }
  });
});
describe("SQL pinned reads", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  let selections: DataSelections;
  let generationId: string;
  let scopeId: string;
  let id: string;
  beforeAll(async () => {
    fixture = await testDatabase();
    const generations = new DataGenerations(fixture.runtime);
    const lease = await generations.begin(generationInput());
    generationId = lease.id; scopeId = lease.scopeId;
    await generations.append(lease, "directory", 0, [
      directoryRecord("a", { sort_key: "same" }), directoryRecord("b", { sort_key: "same" }), directoryRecord("c", { sort_key: null }),
    ]);
    await generations.observePage(lease, "one", 3);
    await generations.validate(lease, { rows: 3, children: 0, batches: 1, pages: 1, wireRows: 3 });
    await generations.publish(lease);
    selections = new DataSelections(fixture.runtime);
    id = (await selections.capture(selectionIdentity, "/users", { values: {}, allowed: [] }, [
      { kind: "generation", scopeId, generationId, revision: "1", expiresAt: new Date(Date.now() + 600_000) },
    ])).id;
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  it("pages tied/null keys forward and backward with exact count bases", async () => {
    const first = await selections.directoryPage(id, selectionIdentity, generationId, { limit: 1 });
    expect(first.value.map(row => row.identity)).toEqual(["a"]);
    expect(first.counts).toEqual({ total: 3, filtered: 3 });
    const second = await selections.directoryPage(id, selectionIdentity, generationId, { limit: 1, boundary: { key: "same", nullRank: 0, id: "a" } });
    expect(second.value.map(row => row.identity)).toEqual(["b"]);
    const previous = await selections.directoryPage(id, selectionIdentity, generationId, { limit: 1, direction: "previous", boundary: { key: null, nullRank: 1, id: "c" } });
    expect(previous.value.map(row => row.identity)).toEqual(["b"]);
    await expect(selections.directoryPage(id, selectionIdentity, generationId, { company: "absent" })).rejects.toThrow("invalid_cursor");
    const filtered = await selections.capture(selectionIdentity, "/users", { values: { company: "absent" }, allowed: ["company"] }, [
      { kind: "generation", scopeId, generationId, revision: "1", expiresAt: new Date(Date.now() + 600_000) },
    ]);
    expect((await selections.directoryPage(filtered.id, selectionIdentity, generationId, { company: "absent" })).counts).toEqual({ total: 3, filtered: 0 });
  });
  it("captures and composes domain validators, page and exact reads in repeatable read", async () => {
    const validate = vi.fn(async (client: Parameters<DataSelections["assert"]>[0]) => {
      expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
    });
    const domain = new DataSelections(fixture.runtime, validate);
    const selected = await domain.capture(selectionIdentity, "/users", { values: {}, allowed: [] }, [{
      kind: "inventory_delta", scopeId, generationId, revision: "1", expiresAt: new Date(Date.now() + 600_000),
    }]);
    expect((await domain.directoryPage(selected.id, selectionIdentity, generationId, {})).counts.total).toBe(3);
    expect((await domain.exactDirectory(selected.id, selectionIdentity, generationId, ["a"])).map(row => row.identity)).toEqual(["a"]);
    await domain.read(selected.id, selectionIdentity, async (client, { selection }) => {
      expect(selection.evaluated_at).toEqual(selected.evaluatedAt);
      expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
    });
    expect(validate).toHaveBeenCalledTimes(4);
  });
  it("enforces scope and exact-ID/page/vector bounds and explicit invalidation", async () => {
    expect(() => selections.exactDirectory(id, selectionIdentity, generationId, Array(101).fill("a"))).toThrow("data_exact_ids_limit");
    expect(() => selections.directoryPage(id, selectionIdentity, generationId, { limit: 101 })).toThrow("invalid_cursor");
    await expect(selections.directoryPage(id, { ...selectionIdentity, principalId: "other" }, generationId, {})).rejects.toThrow("selection_invalidated");
    await selections.invalidate(id, selectionIdentity);
    await expect(selections.directoryPage(id, selectionIdentity, generationId, {})).rejects.toThrow("selection_invalidated");
  });
  it("bounds roots, refuses unavailable future validators and uses earlier expiry", async () => {
    const root = { kind: "generation" as const, scopeId, generationId, revision: "1", expiresAt: new Date(Date.now() + 3600_000) };
    await expect(selections.capture(selectionIdentity, "/users", { values: {}, allowed: [] }, Array(17).fill(root))).rejects.toThrow("data_selection_roots");
    await expect(selections.capture(selectionIdentity, "/history", { values: {}, allowed: [] }, [
      { kind: "tenant_history", scopeId, revision: "2", expiresAt: root.expiresAt },
    ])).rejects.toThrow("data_domain_root_validator_required");
    const cutoff = new Date(Date.now() + 500);
    const expiring = await selections.capture(selectionIdentity, "/users", { values: {}, allowed: [] }, [root], cutoff);
    expect(expiring.expiresAt.getTime()).toBe(cutoff.getTime());
    await fixture.operator.query("UPDATE data_read_selections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expiring.id]);
    await expect(selections.directoryPage(expiring.id, selectionIdentity, generationId, {})).rejects.toThrow("selection_invalidated");
  });
  it("keeps safe replaced inputs pinned, but cannot recapture epoch-invalidated generations", async () => {
    const source = new DataGenerations(fixture.runtime);
    const pinned = await selections.capture(selectionIdentity, "/users", { values: {}, allowed: [] }, [
      { kind: "generation", scopeId, generationId, revision: "1", expiresAt: new Date(Date.now() + 600_000) },
    ]);
    const replacement = await source.begin(generationInput());
    await source.validate(replacement, { rows: 0, children: 0, batches: 0, pages: 0, wireRows: 0 });
    await source.publish(replacement);
    expect((await selections.directoryPage(pinned.id, selectionIdentity, generationId, {})).counts.total).toBe(3);
    await source.invalidate(scopeId, selectionIdentity.tenantId);
    await expect(selections.capture(selectionIdentity, "/users", { values: {}, allowed: [] }, [
      { kind: "generation", scopeId, generationId, revision: "1", expiresAt: new Date(Date.now() + 600_000) },
    ])).rejects.toThrow("selection_invalidated");
  });
  it("counts the response envelope, not only rows, against the 1-MiB ceiling", async () => {
    const source = new DataGenerations(fixture.runtime);
    const lease = await source.begin(generationInput({ scope: { ...generationInput().scope, selector: "response-bytes" } }));
    const rows = Array.from({ length: 100 }, (_, index) => directoryRecord(`wide-${index}`, {
      display_name: "界".repeat(1024), sort_key: "界".repeat(1024), company: "界".repeat(1024), department: "",
    }));
    const projected = () => rows.map(({ identity, upn, display_name, sort_key, company, department, service_state }) =>
      ({ identity, upn, display_name, sort_key, company, department, service_state }));
    let remaining = 1_048_576 - Buffer.byteLength(JSON.stringify(projected()));
    for (const row of rows) {
      const length = Math.min(3072, remaining);
      row.department = "界".repeat(Math.floor(length / 3)) + "x".repeat(length % 3);
      remaining -= length;
    }
    expect(remaining).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(projected()))).toBe(1_048_576);
    await source.append(lease, "directory", 0, rows.slice(0, 50));
    await source.append(lease, "directory", 1, rows.slice(50));
    await source.validate(lease, { rows: 100, children: 0, batches: 2, pages: 0, wireRows: 0 });
    await source.publish(lease);
    const selection = await selections.capture(selectionIdentity, "/users", { values: {}, allowed: [] }, [{
      kind: "generation", scopeId: lease.scopeId, generationId: lease.id, revision: "1", expiresAt: new Date(Date.now() + 600_000),
    }]);
    await expect(selections.directoryPage(selection.id, selectionIdentity, lease.id, { limit: 100 })).rejects.toThrow("data_response_bytes");
  });
  it("returns retryable admission rather than an internal error at the principal selection ceiling", async () => {
    const source = new DataGenerations(fixture.runtime);
    const identity = { ...selectionIdentity, principalId: "selection-quota" };
    const lease = await source.begin(generationInput({ scope: { ...generationInput().scope, principalId: identity.principalId } }));
    await source.validate(lease, { rows: 0, children: 0, batches: 0, pages: 0, wireRows: 0 });
    await source.publish(lease);
    const roots = [{ kind: "generation" as const, scopeId: lease.scopeId, generationId: lease.id, revision: "1", expiresAt: new Date(Date.now() + 600_000) }];
    for (let index = 0; index < 99; index++) await selections.capture(identity, "/users", { values: {}, allowed: [] }, roots);
    const captures = await Promise.allSettled([
      selections.capture(identity, "/users", { values: {}, allowed: [] }, roots),
      selections.capture(identity, "/users", { values: {}, allowed: [] }, roots),
    ]);
    expect(captures.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(captures.filter(result => result.status === "rejected")).toMatchObject([
      { reason: { status: 429, code: "data_selection_admission" } },
    ]);
    await expect(selections.capture(identity, "/users", { values: {}, allowed: [] }, roots))
      .rejects.toMatchObject({ status: 429, code: "data_selection_admission", retryAfterSeconds: 5 });
  });
});
