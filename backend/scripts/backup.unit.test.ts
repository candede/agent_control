import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDistinctDatabaseTargets, backup, prepareRestoredDatabase, reopenPreparedRestoredDatabase, reopenRestoredDatabase, restore } from "./backup.js";
import { backupTableKeys, fingerprintAlgorithm } from "./backupInventory.js";
import { currentSchemaSql } from "../src/db/currentSchema.js";

const mocks = vi.hoisted(() => ({
  files: new Map<string, { body: string; mode: number }>(),
  pools: [] as pg.Pool[],
  spawn: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  preflight: vi.fn(),
  copy: vi.fn(),
  transaction: vi.fn(),
  commandExit: 0,
}));
const snapshotAt = "2026-01-01T00:00:00.000Z";
const filename = "unit-backup.dump";
const settings: pg.PoolConfig = {
  host: "ambient.invalid", port: 5432, database: "ambient", user: "ambient-user",
  password: "synthetic-ambient-password", max: 4, ssl: false, options: "-c timezone=UTC",
};
const operatorSettings: pg.PoolConfig = {
  ...settings, host: "operator.invalid", port: 6432, database: "current",
  user: "operator-user", password: "synthetic-operator-password",
};

vi.mock("pg", async importOriginal => {
  const actual = await importOriginal<typeof import("pg")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      Pool: class extends actual.default.Pool {
        constructor(options?: pg.PoolConfig) {
          super(options);
          mocks.pools.push(this);
        }
      },
    },
  };
});
vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: (path: string) => mocks.files.has(path),
  openSync: mocks.open,
  closeSync: mocks.close,
  chmodSync: (path: string, mode: number) => { mocks.files.get(path)!.mode = mode; },
  createReadStream: (path: string) => Readable.from([Buffer.from(mocks.files.get(path)!.body)]),
  readFileSync: (path: string) => mocks.files.get(path)!.body,
  statSync: (path: string) => ({ size: Buffer.byteLength(mocks.files.get(path)!.body) }),
  writeFileSync: (path: string, body: string, options: { flag: string; mode: number }) => {
    if (options.flag === "wx" && mocks.files.has(path)) throw new Error("EEXIST");
    mocks.files.set(path, { body, mode: options.mode });
  },
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/db/pool.js", () => ({
  databaseSettings: () => settings,
  transaction: mocks.transaction,
}));
vi.mock("../src/db/schema.js", () => ({
  schemaFingerprint: "unit-schema",
  verifySchema: vi.fn(async () => {}),
}));
vi.mock("../src/db/dataGenerationAccountingSchema.js", () => ({ verifyDataGenerationCharges: vi.fn(async () => {}) }));
vi.mock("../src/db/reportMembershipCountsSchema.js", () => ({ verifyReportMembershipCounts: vi.fn(async () => {}) }));
vi.mock("./database.js", () => ({
  preflightSchema: mocks.preflight,
  grantRuntime: vi.fn(async () => {}),
  retainUntilConverged: vi.fn(async () => {}),
}));
vi.mock("./backupFingerprintStream.js", () => ({ copyFingerprint: mocks.copy }));
vi.mock("../src/db/dataConnections.js", () => ({
  dataConnections: (database: pg.Pool) => ({
    selectedRead: async (work: (client: pg.PoolClient) => Promise<unknown>) => {
      const client = await database.connect();
      try { return await work(client); } finally { client.release(); }
    },
  }),
}));
vi.mock("../src/db/officialReportHistory.js", () => ({
  OfficialReportHistory: class { invalidate = vi.fn(async () => {}); },
}));
vi.mock("../src/services/peakMemory.js", () => ({ checkpointQueries: vi.fn() }));
vi.mock("../src/services/dataMetrics.js", () => ({ flushDataWorkMetrics: vi.fn() }));

function result(rows: Record<string, unknown>[] = []) {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
}
function queryResult(sql: string) {
  if (sql.includes("pg_export_snapshot()")) return result([{ snapshot: "unit-snapshot", snapshot_at: new Date(snapshotAt) }]);
  if (sql === "SHOW transaction_isolation") return result([{ transaction_isolation: "repeatable read" }]);
  if (sql.includes("SELECT c.relname AS name")) return result(Object.keys(backupTableKeys).sort().map(name => ({ name, keys: backupTableKeys[name] })));
  if (sql.includes("SELECT transaction_timestamp() AS now")) return result([{ now: new Date(snapshotAt) }]);
  if (sql.includes("SELECT current_database() AS database")) return result([{ database: "unit-database" }]);
  if (sql.startsWith("UPDATE operational_state")) return { ...result(), rowCount: 1 };
  if (sql.startsWith("SELECT * FROM operational_state")) return result([{ mode: "maintenance" }]);
  if (sql.includes("AS count")) return result([{ count: "0" }]);
  return result();
}
function client() {
  const client = Object.assign(new pg.Client(operatorSettings), { release: vi.fn() });
  vi.spyOn(client, "query").mockImplementation(async sql => queryResult(String(sql)));
  return client;
}
function receipt() {
  const hash = createHash("sha256").digest("hex");
  return {
    format: "agent-control-backup-v1", fingerprintAlgorithm, schemaFingerprint: "unit-schema",
    sha256: createHash("sha256").update("unit-dump").digest("hex"),
    tables: Object.fromEntries(Object.keys(backupTableKeys).sort().map(table => [table, { count: 0, hash }])),
    snapshotAt, createdAt: snapshotAt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.files.clear();
  mocks.pools.length = 0;
  mocks.commandExit = 0;
  mocks.preflight.mockResolvedValue({ currentFingerprint: "unit-schema" });
  mocks.copy.mockResolvedValue(0);
  mocks.open.mockImplementation((path: string, flag: string, mode: number) => {
    if (flag === "wx" && mocks.files.has(path)) throw new Error("EEXIST");
    mocks.files.set(path, { body: "", mode });
    return 17;
  });
  mocks.spawn.mockImplementation((name: string, args: string[]) => {
    if (name === "pg_dump") {
      const path = args[args.indexOf("--file") + 1];
      const mode = mocks.files.get(path)?.mode ?? 0o644;
      mocks.files.set(path, { body: "unit-dump", mode });
    }
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false });
    queueMicrotask(() => child.emit("close", mocks.commandExit, null));
    return child;
  });
  vi.spyOn(pg.Pool.prototype, "query").mockImplementation(async sql => queryResult(String(sql)));
  vi.spyOn(pg.Pool.prototype, "connect").mockImplementation(async () => client());
  mocks.transaction.mockImplementation(async (database: pg.Pool, work: (client: pg.PoolClient) => Promise<unknown>) => {
    const connected = await database.connect();
    try {
      await connected.query("BEGIN");
      const value = await work(connected);
      await connected.query("COMMIT");
      return value;
    } catch (error) {
      await connected.query("ROLLBACK");
      throw error;
    } finally { connected.release(); }
  });
});
afterEach(async () => {
  await Promise.all(mocks.pools.filter(database => !database.ending).map(database => database.end()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("backup filesystem and exact-target contracts without infrastructure", () => {
  it("distinguishes separate PostgreSQL servers on the same hostname by port", () => {
    const current = new pg.Pool(operatorSettings);
    const restored = new pg.Pool({ ...operatorSettings, port: 6433 });
    expect(() => assertDistinctDatabaseTargets(current, restored)).not.toThrow();
    expect(() => assertDistinctDatabaseTargets(current, new pg.Pool(operatorSettings))).toThrow("exact separate server/database");
    vi.stubEnv("PGPORT", "5432");
    expect(() => assertDistinctDatabaseTargets(new pg.Pool({ ...operatorSettings, port: undefined }),
      new pg.Pool({ ...operatorSettings, port: 5432 }))).toThrow("exact separate server/database");
    vi.stubEnv("PGPORT", "6432");
    expect(() => assertDistinctDatabaseTargets(new pg.Pool({ ...operatorSettings, port: undefined }),
      current)).toThrow("exact separate server/database");
  });

  it("reserves the dump exclusively with private permissions before starting pg_dump", async () => {
    const database = new pg.Pool(operatorSettings);
    mocks.spawn.mockImplementationOnce(() => {
      expect(mocks.files.get(filename)?.mode).toBe(0o600);
      mocks.files.get(filename)!.body = "unit-dump";
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false });
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });
    await backup(database, filename);
    expect(mocks.open).toHaveBeenCalledWith(filename, "wx", 0o600);
    expect(mocks.close).toHaveBeenCalledWith(17);
    expect(mocks.files.get(`${filename}.json`)?.mode).toBe(0o600);
    const written = JSON.parse(mocks.files.get(`${filename}.json`)!.body);
    expect(written).toMatchObject({ ...receipt(), createdAt: expect.any(String) });
    expect(Date.parse(written.createdAt)).toBeGreaterThanOrEqual(Date.parse(snapshotAt));
    expect(Date.parse(written.createdAt)).toBeLessThanOrEqual(Date.now());
  });

  it("does not overwrite a target created after the initial existence check", async () => {
    mocks.preflight.mockImplementationOnce(async () => {
      mocks.files.set(filename, { body: "unrelated-existing-data", mode: 0o600 });
      return { currentFingerprint: "unit-schema" };
    });
    await expect(backup(new pg.Pool(operatorSettings), filename)).rejects.toThrow("EEXIST");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.files.get(filename)?.body).toBe("unrelated-existing-data");
    expect(mocks.files.has(`${filename}.json`)).toBe(false);
  });

  it("rejects schema inventory drift before creating a dump or receipt", async () => {
    const connected = client();
    vi.mocked(connected.query).mockImplementation(async sql => String(sql).includes("SELECT c.relname AS name")
      ? result([]) : queryResult(String(sql)));
    const database = new pg.Pool(operatorSettings);
    vi.mocked(database.connect).mockImplementation(async () => connected);
    await expect(backup(database, filename)).rejects.toThrow("Backup schema inventory mismatch");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(connected.query).toHaveBeenCalledWith("ROLLBACK");
    expect(connected.release).toHaveBeenCalledWith(undefined);
  });

  it("uses the snapshot pool's connection settings and resolved password for pg_dump", async () => {
    const password = vi.fn(async () => "synthetic-callback-password");
    await backup(new pg.Pool({ ...operatorSettings, password }), filename);
    expect(password).toHaveBeenCalledOnce();
    const [name, args, options] = mocks.spawn.mock.calls[0];
    expect(name).toBe("pg_dump");
    expect(args).toContain("--snapshot=unit-snapshot");
    const keys = ["PGHOST", "PGPORT", "PGUSER", "PGDATABASE", "PGPASSWORD", "PGOPTIONS", "PGSSLMODE"];
    expect(Object.fromEntries(keys.map(key => [key, options.env[key]]))).toEqual({
      PGHOST: operatorSettings.host, PGPORT: "6432", PGUSER: operatorSettings.user,
      PGDATABASE: operatorSettings.database, PGPASSWORD: "synthetic-callback-password",
      PGOPTIONS: operatorSettings.options, PGSSLMODE: "disable",
    });
  });

  it("restores and reopens on the supplied operator server rather than ambient configuration", async () => {
    mocks.files.set(filename, { body: "unit-dump", mode: 0o600 });
    mocks.files.set(`${filename}.json`, { body: JSON.stringify(receipt()), mode: 0o600 });
    const database = new pg.Pool(operatorSettings);
    const target = "agentcontrol_restore_unit";
    await restore(database, filename, target);
    expect(mocks.pools.at(-1)?.options).toMatchObject({
      host: operatorSettings.host, port: operatorSettings.port, user: operatorSettings.user, database: target,
    });
    expect(mocks.pools.at(-1)?.options.password).toBe(operatorSettings.password);
    const [name, , options] = mocks.spawn.mock.calls[0];
    expect(name).toBe("pg_restore");
    expect(options.env.PGHOST).toBe(operatorSettings.host);
    expect(options.env.PGPORT).toBe("6432");
    expect(options.env.PGDATABASE).toBe(target);
    await expect(reopenRestoredDatabase(database, target)).resolves.toEqual({ mode: "normal", providerWorkEnabled: true });
    expect(mocks.pools.at(-1)?.options.host).toBe(operatorSettings.host);
    expect(mocks.pools.at(-1)?.options.password).toBe(operatorSettings.password);
  });

  it("rejects a changed dump before creating a restored database", async () => {
    mocks.files.set(filename, { body: "changed-unit-dump", mode: 0o600 });
    mocks.files.set(`${filename}.json`, { body: JSON.stringify(receipt()), mode: 0o600 });
    const database = new pg.Pool(operatorSettings);
    await expect(restore(database, filename, "agentcontrol_restore_unit")).rejects.toThrow("Backup receipt/checksum mismatch");
    expect(database.query).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.pools).toHaveLength(1);
  });

  it("retains the dump failure and destroys the client when rollback also fails", async () => {
    const connected = client(), rollback = new Error("unit rollback failure");
    vi.mocked(connected.query).mockImplementation(async sql => {
      if (sql === "ROLLBACK") throw rollback;
      return queryResult(String(sql));
    });
    const database = new pg.Pool(operatorSettings);
    vi.mocked(database.connect).mockImplementation(async () => connected);
    mocks.commandExit = 1;
    const failure = await backup(database, filename).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0].message).toContain("pg_dump failed");
    expect((failure as AggregateError).errors[1]).toBe(rollback);
    expect(connected.release).toHaveBeenCalledWith(rollback);
    expect(mocks.files.has(`${filename}.json`)).toBe(false);
  });

  it("reviews current data in a read-only repeatable-read transaction during preparation", async () => {
    const current = new pg.Pool(operatorSettings);
    const restored = new pg.Pool({ ...operatorSettings, database: "agentcontrol_restore_unit" });
    await prepareRestoredDatabase(current, restored);
    const review = await vi.mocked(current.connect).mock.results[0].value;
    expect(review.query).toHaveBeenCalledWith("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(review.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["preparation", prepareRestoredDatabase],
    ["reopening", reopenPreparedRestoredDatabase],
  ] as const)("preserves erased future-request fences separately from bearer issuance during %s", async (_stage, recover) => {
    const current = new pg.Pool(operatorSettings);
    const restored = new pg.Pool({ ...operatorSettings, database: "agentcontrol_restore_unit" });
    const currentClient = client(), restoredClient = client();
    const records = [{ tenant_id: "tenant", principal_id: "principal", epoch: "2",
      bearer_issued_after: "1000", adoption_request_cutoff: "31000" }];
    vi.mocked(pg.Pool.prototype.connect).mockImplementation(async function(this: pg.Pool) {
      return this === current ? currentClient : restoredClient;
    });
    vi.mocked(currentClient.query).mockImplementation(async (sql, values) => {
      if (String(sql).includes("FROM data_principal_epochs")) {
        expect(sql).toContain("adoption_request_cutoff::text");
        return result(values?.[0] === null ? records : []);
      }
      return queryResult(String(sql));
    });
    await recover(current, restored);
    const merge = vi.mocked(restoredClient.query).mock.calls.find(([sql]) =>
      String(sql).startsWith("INSERT INTO data_principal_epochs AS existing"));
    expect(merge?.[0]).toContain("adoption_request_cutoff=GREATEST(existing.adoption_request_cutoff,EXCLUDED.adoption_request_cutoff)");
    expect(merge?.[1]).toEqual([JSON.stringify(records), expect.any(Number)]);
    expect(String(merge?.[0]).split("FROM jsonb_to_recordset")[0])
      .toContain("ceil(extract(epoch FROM clock_timestamp())*1000)::bigint),adoption_request_cutoff");
  });

  it.each([
    ["preparation", prepareRestoredDatabase],
    ["reopening", reopenPreparedRestoredDatabase],
  ] as const)("clears inventory heads without violating their UPDATE guard during %s", async (_stage, recover) => {
    const guard = currentSchemaSql.slice(currentSchemaSql.indexOf("CREATE FUNCTION data_protect_head()"),
      currentSchemaSql.indexOf("CREATE FUNCTION data_protect_record()"));
    expect(guard).toContain("IF NEW.generation_id IS NULL AND pg_trigger_depth()>1");
    expect(guard).toContain("WHERE g.id=NEW.generation_id");
    const current = new pg.Pool(operatorSettings);
    const restored = new pg.Pool({ ...operatorSettings, database: "agentcontrol_restore_unit" });
    const currentClient = client(), restoredClient = client();
    vi.mocked(pg.Pool.prototype.connect).mockImplementation(async function(this: pg.Pool) {
      return this === current ? currentClient : restoredClient;
    });
    const scopes = ["inventory_packages", "inventory_power_platform", "inventory_canonical"].map((source, index) => ({
      id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000001`,
      tenant_id: "cleared-tenant", source, selector: "complete", epoch: "0",
    }));
    const revision = 9007199254740993n;
    const heads = new Map([
      [scopes[0].id, { generationId: "restored-generation" as string | null, revision }],
      [scopes[1].id, { generationId: null as string | null, revision }],
    ]);
    const retired = new Set<string>(), clearedRoots = new Set<string>();
    vi.mocked(currentClient.query).mockImplementation(async sql => String(sql).startsWith("SELECT epoch::text FROM data_scope_epochs")
      ? result([{ epoch: "5" }]) : queryResult(String(sql)));
    vi.mocked(restoredClient.query).mockImplementation(async (sql, values) => {
      const statement = String(sql);
      if (statement.startsWith("SELECT id,tenant_id,source,selector,epoch::text FROM data_scope_epochs")) {
        return result(values?.[0] === "" ? scopes : []);
      }
      const scopeId = String(values?.[0]);
      if (statement.startsWith("UPDATE data_generations SET state='retired' WHERE scope_id=")) retired.add(scopeId);
      if (statement.startsWith("UPDATE inventory_roots SET current=false")) clearedRoots.add(scopeId);
      if (statement.startsWith("UPDATE data_generation_heads SET generation_id=NULL")) throw new Error("data_head_fenced");
      if (statement.startsWith("WITH cleared AS (")) {
        expect(retired.has(scopeId) && clearedRoots.has(scopeId)).toBe(true);
        const normalized = statement.replace(/\s+/g, " ");
        expect(normalized).toContain("DELETE FROM data_generation_heads WHERE scope_id=$1 AND generation_id IS NOT NULL");
        expect(normalized).toContain("RETURNING scope_id,tenant_id,revision");
        expect(normalized).toContain("INSERT INTO data_generation_heads(scope_id,tenant_id,generation_id,revision)");
        expect(normalized).toContain("SELECT scope_id,tenant_id,NULL,revision+1 FROM cleared");
        const head = heads.get(scopeId);
        if (head?.generationId) heads.set(scopeId, { generationId: null, revision: head.revision + 1n });
      }
      return queryResult(statement);
    });

    await recover(current, restored);

    expect(heads.get(scopes[0].id)).toEqual({ generationId: null, revision: revision + 1n });
    expect(heads.get(scopes[1].id)).toEqual({ generationId: null, revision });
    expect(heads.has(scopes[2].id)).toBe(false);
    expect(restoredClient.query).toHaveBeenCalledWith("COMMIT");
  });

  it.each([
    ["preparation", prepareRestoredDatabase],
    ["reopening", reopenPreparedRestoredDatabase],
  ] as const)("preserves source clear fences and inventory recollection revisions during %s", async (_stage, recover) => {
    const current = new pg.Pool(operatorSettings);
    const restored = new pg.Pool({ ...operatorSettings, database: "agentcontrol_restore_unit" });
    const currentClient = client(), restoredClient = client();
    vi.mocked(pg.Pool.prototype.connect).mockImplementation(async function (this: pg.Pool) {
      return this === current ? currentClient : restoredClient;
    });
    const sources = ["inventory_packages", "inventory_power_platform", "inventory_canonical", "user_sources", "agent_people"];
    const scopes = sources.flatMap((source, domain) => [
      { tenant_id: "cleared-tenant", epoch: "0" },
      { tenant_id: "missing-tenant", epoch: "0" },
      { tenant_id: "unchanged-tenant", epoch: "0" },
      { tenant_id: "older-tenant", epoch: "2" },
    ].map((scope, index) => ({ ...scope, source, selector: source === "agent_people" ? "cache" : "complete",
      id: `${String(domain).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}` })));
    vi.mocked(currentClient.query).mockImplementation(async (sql, values) => {
      if (String(sql).startsWith("SELECT epoch::text FROM data_scope_epochs")) {
        expect(values).toEqual([expect.any(String), expect.any(String), values?.[1] === "agent_people" ? "cache" : "complete"]);
        return result(values?.[0] === "missing-tenant" ? [] : [{ epoch: values?.[0] === "cleared-tenant" ? "5" : "0" }]);
      }
      return queryResult(String(sql));
    });
    vi.mocked(restoredClient.query).mockImplementation(async (sql, values) => {
      if (String(sql).startsWith("SELECT id,tenant_id,source,selector,epoch::text FROM data_scope_epochs")) {
        return result(values?.[0] === "" ? scopes.filter(scope => String(sql).includes(`'${scope.source}'`)) : []);
      }
      return queryResult(String(sql));
    });

    await recover(current, restored);

    for (const scope of scopes) {
      const invalidated = ["cleared-tenant", "missing-tenant"].includes(scope.tenant_id);
      const rootUpdate = ["UPDATE inventory_roots SET current=false WHERE scope_id=$1 AND current", [scope.id]];
      if (invalidated) {
        expect(restoredClient.query).toHaveBeenCalledWith("UPDATE data_scope_epochs SET epoch=GREATEST(epoch+1,$2::bigint) WHERE id=$1",
          [scope.id, scope.tenant_id === "cleared-tenant" ? "5" : null]);
        expect(restoredClient.query).toHaveBeenCalledWith(
          "UPDATE data_generations SET state='retired' WHERE scope_id=$1 AND state='published'", [scope.id]);
        if (scope.source.startsWith("inventory_")) {
          expect(restoredClient.query).toHaveBeenCalledWith(...rootUpdate);
          expect(restoredClient.query).toHaveBeenCalledWith(
            expect.stringContaining("SELECT scope_id,tenant_id,NULL,revision+1 FROM cleared"), [scope.id]);
          expect(restoredClient.query).toHaveBeenCalledWith(
            expect.stringContaining("published_sequence=pending_sequence,status='idle'"), [scope.id]);
          expect(restoredClient.query).not.toHaveBeenCalledWith("DELETE FROM data_generation_heads WHERE scope_id=$1", [scope.id]);
        } else {
          expect(restoredClient.query).toHaveBeenCalledWith("DELETE FROM data_generation_heads WHERE scope_id=$1", [scope.id]);
          if (scope.source === "agent_people") {
            expect(restoredClient.query).toHaveBeenCalledWith(expect.stringContaining(
              `FROM agent_people_cache AS record WHERE record.tenant_id='${scope.tenant_id}'`));
          }
        }
      } else {
        expect(restoredClient.query).not.toHaveBeenCalledWith(...rootUpdate);
        expect(restoredClient.query).not.toHaveBeenCalledWith("UPDATE data_scope_epochs SET epoch=GREATEST(epoch+1,$2::bigint) WHERE id=$1",
          [scope.id, "0"]);
      }
    }
    expect(vi.mocked(currentClient.query).mock.calls.filter(([sql]) => String(sql).startsWith("SELECT epoch::text FROM data_scope_epochs")))
      .toHaveLength(scopes.length);
  });

  it("delegates failed current reviews to standard transaction cleanup without hiding the failure", async () => {
    const current = new pg.Pool(operatorSettings);
    const restored = new pg.Pool({ ...operatorSettings, database: "agentcontrol_restore_unit" });
    const failure = new AggregateError([new Error("unit review failure"), new Error("unit rollback failure")], "unit transaction failure");
    mocks.transaction.mockRejectedValueOnce(failure);
    await expect(prepareRestoredDatabase(current, restored)).rejects.toBe(failure);
    expect(mocks.transaction).toHaveBeenCalledExactlyOnceWith(current, expect.any(Function));
    expect(current.connect).not.toHaveBeenCalled();
  });
});
