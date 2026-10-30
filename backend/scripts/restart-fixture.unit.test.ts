import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const createPool = () => ({
    options: { max: 4 },
    query: vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] as Record<string, unknown>[], rowCount: 0 })),
    end: vi.fn<() => Promise<void>>(async () => undefined),
  });
  return {
    createPool,
    pools: [] as ReturnType<typeof createPool>[],
    openPool: vi.fn(createPool),
    fixture: {
      name: "agentcontrol_test_restart",
      operator: createPool(),
      runtime: createPool(),
      close: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    },
    testDatabase: vi.fn(),
    identity: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    fingerprints: vi.fn(),
    loadState: vi.fn(),
    settings: vi.fn(() => ({})),
    secret: vi.fn<(name: string) => string | undefined>(),
  };
});

vi.mock("pg", async importOriginal => {
  const original = await importOriginal<typeof import("pg")>();
  return {
    ...original,
    default: {
      ...original.default,
      Pool: class {
        constructor() {
          const pool = mocks.openPool();
          mocks.pools.push(pool);
          return pool;
        }
      },
    },
  };
});
vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(),
  readFileSync: mocks.readFile,
  writeFileSync: mocks.writeFile,
}));
vi.mock("../src/db/pool.js", () => ({
  databaseSettings: mocks.settings,
  secretValue: mocks.secret,
  pool: {},
  transaction: vi.fn(() => { throw new Error("Unexpected database transaction."); }),
}));
vi.mock("./testDatabase.js", () => ({ testDatabase: mocks.testDatabase }));
vi.mock("../src/services/reportIdentity.js", () => ({ reportIdentity: mocks.identity }));
vi.mock("./backup.js", () => ({ fingerprints: mocks.fingerprints }));
vi.mock("../src/services/operationalState.js", () => ({ loadOperationalState: mocks.loadState }));

const originalArgv = process.argv;
const receipt = {
  database: "agentcontrol_test_restart",
  job: "bulk-job",
  unsent: "unsent-job",
  canaryJob: "canary-job",
  quarantineSent: "quarantine-job",
  lifecycleLease: { id: "generation" },
  tables: { jobs: { count: 2, hash: "fixture-hash" } },
};

function dispatchedPool() {
  const operator = mocks.createPool();
  operator.query.mockImplementation(async sql => {
    const rows = sql.startsWith("SELECT target_id")
      ? [
        { target_id: "a-success", status: "succeeded", sent: true },
        { target_id: "b-uncertain", status: "running", sent: true },
        { target_id: "c-unsent", status: "queued", sent: false },
      ]
      : sql.startsWith("SELECT sent_at") ? [{ sent: true }] : [];
    return { rows, rowCount: rows.length };
  });
  return operator;
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.pools.length = 0;
  mocks.openPool.mockImplementation(mocks.createPool);
  mocks.testDatabase.mockResolvedValue(mocks.fixture);
  mocks.readFile.mockReturnValue(JSON.stringify(receipt));
  mocks.fingerprints.mockResolvedValue(receipt.tables);
  mocks.settings.mockReturnValue({});
  mocks.fixture.runtime.options.max = 4;
  process.argv = [originalArgv[0], "/fixture/restart-fixture.ts", "verify", "/fixture/receipt.json"];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe("restart fixture command boundaries", () => {
  it.each([undefined, "", "verfiy"])("rejects command %s before reading a receipt or opening pools", async mode => {
    process.argv = [originalArgv[0], "/fixture/restart-fixture.ts", ...mode === undefined ? [] : [mode, "/fixture/receipt.json"]];
    await expect(import("./restart-fixture.js")).rejects.toThrow("Usage:");
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.testDatabase).not.toHaveBeenCalled();
    expect(mocks.openPool).not.toHaveBeenCalled();
  });

  it.each(["seed", "verify", "expire", "recover"])("requires a receipt path for %s before opening pools", async mode => {
    process.argv = [originalArgv[0], "/fixture/restart-fixture.ts", mode];
    await expect(import("./restart-fixture.js")).rejects.toThrow("Usage:");
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.testDatabase).not.toHaveBeenCalled();
    expect(mocks.openPool).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only receipt path before opening the seed fixture", async () => {
    process.argv[2] = "seed";
    process.argv[3] = "   ";
    await expect(import("./restart-fixture.js")).rejects.toThrow("Usage:");
    expect(mocks.testDatabase).not.toHaveBeenCalled();
  });

  it("rejects a receipt selecting a non-fixture database before opening pools", async () => {
    mocks.readFile.mockReturnValue(JSON.stringify({ ...receipt, database: "agentcontrol" }));
    await expect(import("./restart-fixture.js")).rejects.toThrow();
    expect(mocks.openPool).not.toHaveBeenCalled();
  });
});

describe("restart fixture cleanup and completion", () => {
  it("closes the seed fixture if constructing a repository fails", async () => {
    process.argv[2] = "seed";
    mocks.fixture.runtime.options.max = 5;
    await expect(import("./restart-fixture.js")).rejects.toThrow("data_pool_budget");
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("closes a newly created seed fixture if report identity initialization fails", async () => {
    process.argv[2] = "seed";
    const failure = new Error("Report identity failed.");
    mocks.identity.mockRejectedValue(failure);
    await expect(import("./restart-fixture.js")).rejects.toBe(failure);
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
    expect(mocks.fixture.release).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("preserves both seed initialization and cleanup failures", async () => {
    process.argv[2] = "seed";
    const failure = new Error("Report identity failed."), cleanup = new Error("Fixture close failed.");
    mocks.identity.mockRejectedValue(failure);
    mocks.fixture.close.mockRejectedValue(cleanup);
    const error = await import("./restart-fixture.js").catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([failure, cleanup]);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("checks persistence without writes and reports success only after pool closure", async () => {
    await import("./restart-fixture.js");
    const [operator] = mocks.pools;
    expect(mocks.fingerprints).toHaveBeenCalledWith(operator);
    expect(operator.query).not.toHaveBeenCalled();
    expect(operator.end).toHaveBeenCalledOnce();
    expect(operator.end.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(console.log).mock.invocationCallOrder[0]);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual({
      event: "persistent_fixture_fingerprints", outcome: "passed",
    });
  });

  it("does not report persistence success if closing the pool fails", async () => {
    const cleanup = new Error("Pool close failed."), operator = mocks.createPool();
    operator.end.mockRejectedValue(cleanup);
    mocks.openPool.mockReturnValueOnce(operator);
    await expect(import("./restart-fixture.js")).rejects.toBe(cleanup);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("awaits pool closure before reporting persistence success", async () => {
    let release!: () => void;
    const closing = new Promise<void>(resolve => { release = resolve; }), operator = mocks.createPool();
    operator.end.mockReturnValue(closing);
    mocks.openPool.mockReturnValueOnce(operator);
    const completed = import("./restart-fixture.js");
    try {
      await vi.waitFor(() => { expect(operator.end).toHaveBeenCalledOnce(); });
      expect(console.log).not.toHaveBeenCalled();
    } finally {
      release();
      await completed;
    }
    expect(console.log).toHaveBeenCalledOnce();
  });

  it("preserves fingerprint and pool closure failures", async () => {
    const failure = new Error("Fingerprint failed."), cleanup = new Error("Pool close failed.");
    const operator = mocks.createPool();
    mocks.fingerprints.mockRejectedValue(failure);
    operator.end.mockRejectedValue(cleanup);
    mocks.openPool.mockReturnValueOnce(operator);
    const error = await import("./restart-fixture.js").catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([failure, cleanup]);
  });

  it.each([true, false])("verifies dispatch and expires leases before reporting completion (lifecycle lease: %s)", async lifecycle => {
    process.argv[2] = "expire";
    const operator = dispatchedPool();
    mocks.openPool.mockReturnValueOnce(operator);
    if (!lifecycle) mocks.readFile.mockReturnValue(JSON.stringify({ ...receipt, lifecycleLease: undefined }));
    await import("./restart-fixture.js");
    expect(operator.query.mock.calls).toEqual([
      ["SELECT target_id,status,sent_at IS NOT NULL AS sent FROM job_items WHERE job_id=$1 ORDER BY ordinal", [receipt.job]],
      ["SELECT sent_at IS NOT NULL AS sent FROM job_items WHERE job_id=$1", [receipt.canaryJob]],
      ["SELECT sent_at IS NOT NULL AS sent FROM copilot_quarantine_job_items WHERE job_id=$1", [receipt.quarantineSent]],
      ["UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])", [[receipt.job, receipt.canaryJob]]],
      ...lifecycle ? [["UPDATE data_generations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [receipt.lifecycleLease.id]]] : [],
    ]);
    expect(operator.end).toHaveBeenCalledOnce();
    expect(operator.end.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(console.log).mock.invocationCallOrder[0]);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual({
      event: "restart_fixture_dispatch_verified", outcome: "passed", items: 3,
    });
  });

  it.each(["UPDATE jobs", "UPDATE data_generations"])("does not report completion if %s fails", async statement => {
    process.argv[2] = "expire";
    const operator = dispatchedPool(), dispatch = operator.query.getMockImplementation()!;
    const failure = new Error("Lease expiration failed.");
    operator.query.mockImplementation((sql, values) => sql.startsWith(statement) ? Promise.reject(failure) : dispatch(sql, values));
    mocks.openPool.mockReturnValueOnce(operator);
    await expect(import("./restart-fixture.js")).rejects.toBe(failure);
    expect(operator.end).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("refuses to expire leases when the persisted dispatch evidence does not match", async () => {
    process.argv[2] = "expire";
    const operator = dispatchedPool();
    operator.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mocks.openPool.mockReturnValueOnce(operator);
    await expect(import("./restart-fixture.js")).rejects.toThrow();
    expect(operator.query).toHaveBeenCalledOnce();
    expect(operator.end).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("closes recovery resources and drops the owned fixture if runtime setup fails", async () => {
    process.argv[2] = "recover";
    const failure = new Error("Runtime credential unavailable.");
    mocks.secret.mockImplementation(name => { if (name === "APP_PGPASSWORD") throw failure; return undefined; });
    await expect(import("./restart-fixture.js")).rejects.toBe(failure);
    expect(mocks.pools).toHaveLength(2);
    expect(mocks.pools[0].end).toHaveBeenCalledOnce();
    expect(mocks.pools[1].query).toHaveBeenCalledWith('DROP DATABASE "agentcontrol_test_restart" WITH (FORCE)');
    expect(mocks.pools[1].end).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("attempts every recovery cleanup step and retains all failures", async () => {
    process.argv[2] = "recover";
    const failure = new Error("Operational state failed.");
    const operatorFailure = new Error("Operator close failed."), runtimeFailure = new Error("Runtime close failed.");
    const dropFailure = new Error("Database cleanup failed."), cleanupFailure = new Error("Cleanup pool close failed.");
    const operator = mocks.createPool(), runtime = mocks.createPool(), cleanup = mocks.createPool();
    mocks.openPool.mockReturnValueOnce(operator).mockReturnValueOnce(runtime).mockReturnValueOnce(cleanup);
    mocks.loadState.mockRejectedValue(failure);
    operator.end.mockRejectedValue(operatorFailure);
    runtime.end.mockRejectedValue(runtimeFailure);
    cleanup.query.mockRejectedValue(dropFailure);
    cleanup.end.mockRejectedValue(cleanupFailure);
    const error = await import("./restart-fixture.js").catch(error => error);
    expect(operator.end).toHaveBeenCalledOnce();
    expect(runtime.end).toHaveBeenCalledOnce();
    expect(cleanup.query).toHaveBeenCalledOnce();
    expect(cleanup.end).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors[0]).toBe(failure);
    expect(error.errors[1].errors.slice(0, 2)).toEqual([operatorFailure, runtimeFailure]);
    expect(error.errors[1].errors[2].errors).toEqual([dropFailure, cleanupFailure]);
    expect(console.log).not.toHaveBeenCalled();
  });
});
