import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDistinctDatabaseTargets, backup, prepareRestoredDatabase, reopenRestoredDatabase, restore } from "./backup.js";
import { backupTableKeys, fingerprintAlgorithm } from "./backupInventory.js";

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
