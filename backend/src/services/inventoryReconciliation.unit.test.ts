import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BeginGeneration, GenerationLease } from "../db/dataGenerations.js";
import type { InventoryRoot } from "../types/inventoryRecords.js";
import { dataLimits } from "../db/dataBounds.js";
import { inventoryReconciliationAdmissionSql } from "../db/inventoryReconciliationAdmissionSchema.js";
import { InventoryReconciliation } from "./inventoryReconciliation.js";
import { packageInventoryRecord, type InventoryRecord } from "./inventoryRecordProjection.js";
import { allowlistedPackage } from "./packageObservation.js";

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: vi.fn((name: string) => name === "SESSION_SECRET" ? "synthetic-reconciliation-unit-session-secret" : undefined),
}));

afterEach(() => vi.restoreAllMocks());

function fixture(records: InventoryRecord[], factsError?: Error,
  previous?: { reusable: boolean; unchanged?: boolean; expiresBeforeStaging?: boolean }, cancelRequest?: () => void) {
  const database = new pg.Pool({ max: 4 });
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not access a database."));
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const reconciliation = new InventoryReconciliation(database);
  const at = new Date();
  const root: InventoryRoot = {
    scopeId: randomUUID(), tenantId: "synthetic-tenant", baselineId: randomUUID(), revision: "1", epoch: "0",
  };
  const input: BeginGeneration = {
    scope: { kind: "principal", tenantId: root.tenantId, principalId: "synthetic-principal",
      tokenMode: "delegated", source: "inventory_canonical", selector: "complete" },
    schemaVersion: 1, sessionEpoch: "0", jobId: randomUUID(), jobKind: "fixture",
    observedAt: at, expiresAt: new Date(at.getTime() + 60_000), deadlineAt: new Date(at.getTime() + 60_000), reserveBytes: 1024 ** 3,
  };
  const lease: GenerationLease = {
    id: randomUUID(), scopeId: randomUUID(), tenantId: root.tenantId, owner: randomUUID(), version: 1,
    epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1,
  };
  const pending = new Map<string, InventoryRecord>();
  const byIdentity = new Map(records.map(record => [record.identity, record]));
  const loads: number[] = [];
  const statements: string[] = [];
  const canonical = previous ? { baseline_id: randomUUID(), revision: "1", reusable: previous.reusable } : undefined;
  let reusable = previous?.reusable;
  let inserted = 0;
  const result = (rows: pg.QueryResultRow[] = []): pg.QueryResult =>
    ({ command: "", rows, rowCount: rows.length, fields: [], oid: 0 });
  vi.spyOn(client, "query").mockImplementation(async (sql, parameters) => {
    const statement = String(sql);
    statements.push(statement);
    const values = parameters as unknown[] | undefined;
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return { ...result(), command: statement };
    if (statement.startsWith("INSERT INTO inventory_reconciliation_keys")) cancelRequest?.();
    if (statement.startsWith("SELECT id,epoch FROM data_scope_epochs")) return result([{ id: lease.scopeId, epoch: "0" }]);
    if (statement.startsWith("SELECT * FROM inventory_reconciliation")) return result([{
      pending_inputs: previous ? null : [{ ...root, domain: "packages", expiresAt: input.expiresAt.toISOString() }],
      pending_sequence: "1", published_sequence: previous ? "1" : "0", active_id: null,
      published_inputs: previous ? [{ ...root, revision: previous.unchanged ? "1" : "0",
        domain: "packages", expiresAt: input.expiresAt.toISOString() }] : null,
    }]);
    if (statement.startsWith("SELECT id FROM data_scope_epochs")) return result([{ id: lease.scopeId }]);
    if (statement.startsWith("SELECT * FROM data_scope_epochs")) return result([{
      epoch: "0", session_epoch: "0", principal_id: input.scope.principalId, token_mode: "delegated",
    }]);
    if (statement.startsWith("SELECT r.domain,r.baseline_id,r.revision,g.expires_at")) {
      return result([{ domain: "packages", baseline_id: root.baselineId, revision: "1", expires_at: input.expiresAt }]);
    }
    if (statement.startsWith("SELECT r.baseline_id,r.revision,epoch.epoch,g.expires_at")) {
      return result([{ baseline_id: root.baselineId, revision: "1", epoch: "0", expires_at: input.expiresAt }]);
    }
    if (statement.includes("AS count")) return result([{ count: 0 }]);
    if (statement.startsWith("SELECT r.* FROM inventory_roots")) {
      return result(reusable ? [canonical!] : []);
    }
    if (statement.startsWith("SELECT * FROM inventory_roots")) {
      return result(canonical ? [canonical] : []);
    }
    if (statement.startsWith("WITH roots AS")) return result();
    if (statement.includes("AS expired")) return result([{ expired: false }]);
    if (statement.startsWith("INSERT INTO inventory_reconciliation(")) return result([{
      active_id: null, pending_sequence: "2",
    }]);
    if (statement.startsWith("UPDATE inventory_reconciliation SET active_until")
      || statement.startsWith("SELECT 1 FROM inventory_worker_pins")) return result([{}]);
    if (statement.startsWith("INSERT INTO inventory_frontier(worker_id,source_scope_id,identity)")) {
      const seeded = statement.includes("FROM inventory_reconciliation_keys") && previous ? records.slice(0, 1) : records;
      for (const record of seeded) pending.set(record.identity, record);
      return result();
    }
    if (statement.includes("WHERE ordinal=included")) return result([...pending.values()].slice(0, 100).map((record, ordinal) => ({
      source_scope_id: root.scopeId, identity: record.identity, generation_id: root.baselineId, ordinal: ordinal + 1,
      agent_id: previous ? survivorIds.get(record.identity) : undefined,
    })));
    if (statement.includes("catalog.observed_at AS catalog_observed_at")) {
      const requested = JSON.parse(String(values![0])) as { generation: string; identity: string; position: number }[];
      loads.push(requested.length);
      return result(requested.map(key => ({
        ...byIdentity.get(key.identity), facts: undefined, generation_id: key.generation, scope_id: root.scopeId,
        domain: "packages", position: key.position, observed_at: at, read_started_at: at, expires_at: input.expiresAt,
        catalog_observed_at: at, catalog_expires_at: input.expiresAt, detail_observed_at: null, detail_expires_at: null,
      })));
    }
    if (statement.includes("SELECT f.generation_id,f.identity,f.ordinal,f.kind,f.value,f.payload")) {
      if (factsError) throw factsError;
      const requested = JSON.parse(String(values![0])) as { generation: string; identity: string }[];
      const facts = requested.flatMap(key => byIdentity.get(key.identity)!.facts.flatMap((fact, ordinal) =>
        fact.kind === "supportedHosts" || fact.kind === "element" || fact.kind === "elementGroup" || fact.kind === "collection"
          ? [{ ...fact, generation_id: key.generation, identity: key.identity, ordinal }] : []))
        .sort((a, b) => a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : a.ordinal - b.ordinal)
        .filter(fact => values![1] === null || fact.identity > String(values![2])
          || fact.identity === values![2] && fact.ordinal > Number(values![3]));
      return result(facts.slice(0, 250));
    }
    if (statement.startsWith("UPDATE inventory_frontier frontier")) {
      for (const key of JSON.parse(String(values![1])) as { identity: string }[]) pending.delete(key.identity);
      return result();
    }
    if (statement.includes("FROM seeds seed JOIN roots own")) return result();
    if (statement.startsWith("SELECT source_scope_id,identity FROM inventory_frontier") && !pending.size) return result();
    if (statement.startsWith("SELECT pg_advisory_xact_lock") || statement.startsWith("SELECT set_config") || statement.startsWith("SET LOCAL")
      || statement.startsWith("UPDATE inventory_reconciliation") || statement.startsWith("INSERT INTO")
      || statement.startsWith("DELETE FROM inventory_worker_pins")) return result();
    throw new Error("Unexpected reconciliation unit query.");
  });
  vi.spyOn(reconciliation.stages.generations.connections, "run").mockImplementation(async work => work(client));
  vi.spyOn(reconciliation.stages, "fence").mockResolvedValue({ state: "staging" });
  const execute = vi.spyOn(reconciliation.stages, "execute").mockImplementation(async (_input, _intent, work, options) => {
    if (previous?.expiresBeforeStaging) reusable = false;
    await options.validateInputs?.(client);
    await work(lease, new AbortController().signal);
    return { ...root, scopeId: lease.scopeId, baselineId: lease.id, inserted, closed: 0, changed: inserted };
  });
  const survivorIds = new Map(records.map(record => [record.identity, randomUUID()]));
  const append = vi.spyOn(reconciliation.stages, "appendBounded").mockImplementation(async (_lease, rows) => {
    inserted += rows.filter(row => !row.deleted).length;
  });
  return { database, client, reconciliation, input, root, pending, loads, append, execute, statements, survivorIds };
}

describe("bounded isolated reconciliation without a database", () => {
  it.each([19, 20])("preserves admission at %i queued jobs when retained source observations have aged", async queued => {
    const f = fixture([], undefined, { reusable: false, unchanged: true });
    f.input.observedAt = new Date(Date.now() - 2 * 86_400_000);
    f.input.expiresAt = new Date(Date.now() - 86_400_000);
    const query = vi.mocked(f.client.query).getMockImplementation()!;
    vi.mocked(f.client.query).mockImplementation((...args) => {
      if (args[0] === inventoryReconciliationAdmissionSql) {
        return Promise.resolve({ command: "SELECT", rows: [{ count: queued }], rowCount: 1, fields: [], oid: 0 });
      }
      return query(...args);
    });

    const request = f.reconciliation.request(f.input, [f.root]);
    if (queued < 20) await expect(request).resolves.toMatchObject({ pendingSequence: "2" });
    else {
      await expect(request).rejects.toMatchObject({ code: "inventory_queue_admission" });
      expect(f.statements.some(sql => sql.startsWith("INSERT INTO inventory_reconciliation("))).toBe(false);
    }
    expect(f.client.query).toHaveBeenCalledWith(inventoryReconciliationAdmissionSql, [f.root.tenantId, expect.any(String)]);
    expect(inventoryReconciliationAdmissionSql).toContain("pending_deadline>clock_timestamp()");
    expect(inventoryReconciliationAdmissionSql).toContain("s.epoch IS DISTINCT FROM input.epoch");
    expect(inventoryReconciliationAdmissionSql).not.toContain('input."expiresAt"');
  });

  it("rolls back queued work when its initiating sweep is cancelled during admission", async () => {
    const controller = new AbortController();
    const reason = new Error("Synthetic inventory shutdown.");
    const f = fixture([], undefined, { reusable: false, unchanged: true }, () => controller.abort(reason));
    vi.mocked(f.database.connect).mockImplementation(async () => f.client);
    vi.mocked(f.reconciliation.stages.generations.connections.run).mockRestore();

    await expect(f.reconciliation.request(f.input, [f.root], undefined, controller.signal)).rejects.toBe(reason);
    expect(f.statements).toContain("ROLLBACK");
    expect(f.statements).not.toContain("COMMIT");
  });

  it("shrinks a legal wide batch and reconciles every independent component in source order", async () => {
    const records = Array.from({ length: 40 }, (_, index) => packageInventoryRecord(allowlistedPackage({
      id: `package-${String(index).padStart(3, "0")}`, displayName: `Package ${index}`, isBlocked: false,
      supportedHosts: Array.from({ length: 100 }, (_, host) => `${host}:${"x".repeat(240)}`),
      elementDetails: [{ elementType: "Bots", elements: Array.from({ length: 100 }, (_, element) => ({
        id: `${index}-${element}`, definition: JSON.stringify({ description: "x".repeat(4000) }),
      })) }],
    })));
    expect(records.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record.facts)), 0))
      .toBeGreaterThan(dataLimits.agentDefinitionWorkBytes);
    expect(records.every(record => !record.facts.some(fact => fact.kind.startsWith("match:")))).toBe(true);
    const f = fixture(records);
    await expect(f.reconciliation.runNext(f.input, async () => {})).resolves.toMatchObject({ inserted: records.length });
    expect(f.execute.mock.calls[0][1]).toMatchObject({ domain: "canonical", mode: "baseline" });
    expect(f.pending.size).toBe(0);
    expect(f.loads[0]).toBe(records.length);
    expect(f.loads.some(size => size < records.length)).toBe(true);
    const saved = f.append.mock.calls.flatMap(([, rows]) => rows);
    expect(saved).toHaveLength(records.length);
    expect(new Set(saved.map(record => record.identity)).size).toBe(records.length);
    expect(saved.map(record => record.display_name)).toEqual(records.map(record => record.display_name));
    expect(saved.every(record => record.facts.filter(fact => fact.kind === "host").length === 100)).toBe(true);
  });

  it("still rejects an individually oversized component without staging partial results", async () => {
    const record = packageInventoryRecord(allowlistedPackage({
      id: "oversized", displayName: "Oversized identity work", isBlocked: false,
    }));
    // Exercise the stored-row work fence independently of the earlier provider-observation limit.
    record.facts.push({ kind: "element", value: "0", payload: {
      elementType: "Bots", id: "oversized-element",
      definition: JSON.stringify({ description: "x".repeat(dataLimits.agentDefinitionWorkBytes) }),
    } });
    expect(Buffer.byteLength(JSON.stringify(record.facts))).toBeGreaterThan(dataLimits.agentDefinitionWorkBytes);
    const f = fixture([record]);
    await expect(f.reconciliation.runNext(f.input, async () => {})).rejects.toMatchObject({ code: "inventory_record_work_bytes" });
    expect(f.append).not.toHaveBeenCalled();
    expect(f.pending.size).toBe(1);
    expect(f.loads).toEqual([1]);
  });

  it("does not turn a failed fact read into a smaller successful batch", async () => {
    const failure = new Error("Synthetic storage read failed.");
    const f = fixture(["first", "second"].map(id => packageInventoryRecord(allowlistedPackage({
      id, displayName: id, isBlocked: false,
    }))), failure);
    await expect(f.reconciliation.runNext(f.input, async () => {})).rejects.toBe(failure);
    expect(f.append).not.toHaveBeenCalled();
    expect(f.pending.size).toBe(2);
    expect(f.loads).toEqual([2]);
  });

  it("retains both the staging failure and a failed claim cleanup", async () => {
    const primary = new Error("Synthetic record load failure.");
    const cleanup = new Error("Synthetic claim cleanup failure.");
    const f = fixture([packageInventoryRecord(allowlistedPackage({
      id: "failed-load", displayName: "Failed load", isBlocked: false,
    }))], primary);
    const query = vi.mocked(f.client.query).getMockImplementation()!;
    vi.mocked(f.client.query).mockImplementation((...args) => {
      if (String(args[0]).includes("pending_inputs=coalesce(pending_inputs,active_inputs)")) throw cleanup;
      return query(...args);
    });

    await expect(f.reconciliation.runNext(f.input, async () => {})).rejects.toMatchObject({
      message: "inventory_reconciliation_and_cleanup_failed", errors: [primary, cleanup],
    });
    expect(f.append).not.toHaveBeenCalled();
  });
});

describe("canonical head recovery without a database", () => {
  const records = () => ["first", "untouched"].map(id => packageInventoryRecord(allowlistedPackage({
    id, displayName: id, isBlocked: false,
  })));

  it("fully seeds a replacement for an unavailable canonical head after a missed source notification", async () => {
    const f = fixture(records(), undefined, { reusable: false });
    await expect(f.reconciliation.runNext(f.input, async () => {})).resolves.toMatchObject({ inserted: 2 });
    expect(f.execute.mock.calls[0][1]).toMatchObject({ domain: "canonical", mode: "baseline" });
    expect(f.statements.some(sql => sql.includes("SELECT $3,scope_id,identity FROM inventory_memberships"))).toBe(true);
    const saved = f.append.mock.calls.flatMap(([, rows]) => rows);
    expect(saved.map(row => row.identity)).toEqual([...f.survivorIds.values()]);
  });

  it("does not coalesce an unchanged vector when its canonical output is unavailable", async () => {
    const f = fixture(records(), undefined, { reusable: false, unchanged: true });
    await expect(f.reconciliation.request(f.input, [f.root])).resolves.toMatchObject({ pendingSequence: "2" });
    expect(f.statements.some(sql => sql.startsWith("INSERT INTO inventory_reconciliation("))).toBe(true);
  });

  it("recovers an unavailable unchanged output even without a new request", async () => {
    const f = fixture(records(), undefined, { reusable: false, unchanged: true });
    await expect(f.reconciliation.runNext(f.input, async () => {})).resolves.toMatchObject({ inserted: 2 });
    expect(f.execute.mock.calls[0][1]).toMatchObject({ domain: "canonical", mode: "baseline" });
  });

  it("fences a delta whose canonical head expires after claiming, before staging a partial replacement", async () => {
    const f = fixture(records(), undefined, { reusable: true, expiresBeforeStaging: true });
    await expect(f.reconciliation.runNext(f.input, async () => {})).rejects.toThrow("inventory_reconciliation_fenced");
    expect(f.execute.mock.calls[0][1]).toMatchObject({ domain: "canonical", mode: "delta" });
    expect(f.append).not.toHaveBeenCalled();
    expect(f.statements.some(sql => sql.startsWith("INSERT INTO inventory_frontier"))).toBe(false);
    expect(f.statements.some(sql => sql.includes("pending_inputs=coalesce(pending_inputs,active_inputs)"))).toBe(true);
  });

  it("retains identical-vector no-ops and delta seeding for a reusable canonical head", async () => {
    const unchanged = fixture(records(), undefined, { reusable: true, unchanged: true });
    await expect(unchanged.reconciliation.request(unchanged.input, [unchanged.root])).resolves.toMatchObject({ pendingSequence: "1" });
    await expect(unchanged.reconciliation.runNext(unchanged.input, async () => {})).resolves.toBeNull();
    expect(unchanged.execute).not.toHaveBeenCalled();
    const changed = fixture(records(), undefined, { reusable: true });
    await expect(changed.reconciliation.runNext(changed.input, async () => {})).resolves.toMatchObject({ inserted: 1 });
    expect(changed.execute.mock.calls[0][1]).toMatchObject({ domain: "canonical", mode: "delta" });
    expect(changed.statements.some(sql => sql.includes("SELECT $3,scope_id,identity FROM inventory_memberships"))).toBe(false);
    expect(changed.append.mock.calls.flatMap(([, rows]) => rows.map(row => row.display_name))).toEqual(["first"]);
  });
});
