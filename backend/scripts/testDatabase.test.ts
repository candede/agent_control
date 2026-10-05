import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabase } from "./testDatabase.js";

const mocks = vi.hoisted(() => {
  const createPool = () => ({
    query: vi.fn(async (_sql: string) => ({ rows: [] })),
    end: vi.fn(async () => undefined),
  });
  return {
    admin: createPool(), operator: createPool(), runtime: createPool(),
    Pool: vi.fn(),
    databaseSettings: vi.fn(() => ({ database: "agentcontrol_test_control" })),
    bootstrap: vi.fn(async () => undefined),
    initializeSchema: vi.fn(async () => undefined),
    grantRuntime: vi.fn(async () => undefined),
    template: vi.fn<() => Promise<string | undefined>>(async () => undefined),
    verify: vi.fn(async () => undefined),
  };
});

vi.mock("pg", () => ({ default: { Pool: mocks.Pool } }));
vi.mock("../src/db/pool.js", () => ({
  databaseSettings: mocks.databaseSettings,
  secretValue: () => undefined,
}));
vi.mock("./database.js", () => ({
  bootstrap: mocks.bootstrap, initializeSchema: mocks.initializeSchema, grantRuntime: mocks.grantRuntime,
}));
vi.mock("./testDatabaseTemplate.js", () => ({ prepareTestSchemaTemplate: mocks.template }));
vi.mock("../src/db/schema.js", () => ({ verifySchema: mocks.verify }));

beforeEach(() => {
  for (const pool of [mocks.admin, mocks.operator, mocks.runtime]) {
    pool.query.mockReset().mockResolvedValue({ rows: [] });
    pool.end.mockReset().mockResolvedValue(undefined);
  }
  for (const operation of [mocks.bootstrap, mocks.initializeSchema, mocks.grantRuntime]) {
    operation.mockReset().mockResolvedValue(undefined);
  }
  mocks.template.mockReset().mockResolvedValue(undefined);
  mocks.verify.mockReset().mockResolvedValue(undefined);
  mocks.databaseSettings.mockReset().mockReturnValue({ database: "agentcontrol_test_control" });
  mocks.Pool.mockReset()
    .mockImplementationOnce(function () { return mocks.admin; })
    .mockImplementationOnce(function () { return mocks.operator; })
    .mockImplementationOnce(function () { return mocks.runtime; });
});
afterEach(() => { vi.useRealTimers(); });

describe("isolated test database lifecycle without PostgreSQL", () => {
  it("clones only the prepared owned template while retaining bootstrap and runtime schema verification", async () => {
    mocks.template.mockResolvedValue("agentcontrol_test_schema_1234");
    const fixture = await testDatabase();
    expect(mocks.admin.query).toHaveBeenCalledExactlyOnceWith(
      `CREATE DATABASE "${fixture.name}" TEMPLATE "agentcontrol_test_schema_1234" ALLOW_CONNECTIONS true`);
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith(mocks.runtime);
    expect(mocks.initializeSchema).not.toHaveBeenCalled();
    expect(mocks.grantRuntime).not.toHaveBeenCalled();
    await fixture.close();
    expect(mocks.admin.query).toHaveBeenLastCalledWith(`DROP DATABASE "${fixture.name}"`);
  });

  it("never creates a leaf database when its template fails identity verification", async () => {
    mocks.template.mockRejectedValue(new Error("test_schema_template_identity"));
    await expect(testDatabase()).rejects.toThrow("test_schema_template_identity");
    expect(mocks.admin.query).not.toHaveBeenCalled();
    expect(mocks.admin.end).toHaveBeenCalledOnce();
  });

  it("rejects an unguarded database before constructing any pools", async () => {
    mocks.databaseSettings.mockReturnValue({ database: "agentcontrol" });
    await expect(testDatabase()).rejects.toThrow("separately named agentcontrol_test_*");
    expect(mocks.Pool).not.toHaveBeenCalled();
  });

  it("preserves successful initialization and closes pools before dropping its database", async () => {
    const fixture = await testDatabase();
    expect(fixture.name).toMatch(/^agentcontrol_test_[a-f0-9]{32}$/);
    expect(mocks.admin.query).toHaveBeenCalledExactlyOnceWith(`CREATE DATABASE "${fixture.name}"`);
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    expect(mocks.initializeSchema).toHaveBeenCalledExactlyOnceWith(mocks.operator);
    expect(mocks.grantRuntime).toHaveBeenCalledExactlyOnceWith(mocks.operator);
    expect(mocks.admin.end).not.toHaveBeenCalled();
    await fixture.close();
    expect(mocks.admin.query).toHaveBeenLastCalledWith(`DROP DATABASE "${fixture.name}"`);
    const dropOrder = mocks.admin.query.mock.invocationCallOrder[1];
    expect(mocks.operator.end.mock.invocationCallOrder[0]).toBeLessThan(dropOrder);
    expect(mocks.runtime.end.mock.invocationCallOrder[0]).toBeLessThan(dropOrder);
    expect(mocks.admin.end.mock.invocationCallOrder[0]).toBeGreaterThan(dropOrder);
  });

  it("retains the uninitialized fixture option", async () => {
    const fixture = await testDatabase(false);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.initializeSchema).not.toHaveBeenCalled();
    expect(mocks.grantRuntime).not.toHaveBeenCalled();
    await fixture.close();
    expect(mocks.admin.end).toHaveBeenCalledOnce();
  });

  it("closes the admin pool without dropping a database when creation fails", async () => {
    const failure = new Error("create failed");
    mocks.admin.query.mockRejectedValueOnce(failure);
    await expect(testDatabase()).rejects.toBe(failure);
    expect(mocks.admin.end).toHaveBeenCalledOnce();
    expect(mocks.admin.query).toHaveBeenCalledOnce();
    expect(mocks.Pool).toHaveBeenCalledOnce();
  });

  it.each(["bootstrap", "initializeSchema", "grantRuntime"] as const)("cleans up when %s fails before returning a fixture", async stage => {
    const failure = new Error(`${stage} failed`);
    mocks[stage].mockRejectedValueOnce(failure);
    await expect(testDatabase()).rejects.toBe(failure);
    for (const pool of [mocks.admin, mocks.operator, mocks.runtime]) expect(pool.end).toHaveBeenCalledOnce();
    expect(mocks.admin.query).toHaveBeenLastCalledWith(expect.stringMatching(/^DROP DATABASE "agentcontrol_test_[a-f0-9]{32}"$/));
  });

  it.each(["operator", "runtime"] as const)("cleans up a partially constructed fixture when the %s pool constructor fails", async stage => {
    const failure = new Error("pool construction failed");
    mocks.Pool.mockReset().mockImplementationOnce(function () { return mocks.admin; });
    if (stage === "runtime") mocks.Pool.mockImplementationOnce(function () { return mocks.operator; });
    mocks.Pool.mockImplementationOnce(function () { throw failure; });
    await expect(testDatabase()).rejects.toBe(failure);
    expect(mocks.admin.end).toHaveBeenCalledOnce();
    expect(mocks.admin.query).toHaveBeenLastCalledWith(expect.stringMatching(/^DROP DATABASE "agentcontrol_test_[a-f0-9]{32}"$/));
    expect(mocks.operator.end).toHaveBeenCalledTimes(stage === "runtime" ? 1 : 0);
    expect(mocks.runtime.end).not.toHaveBeenCalled();
  });

  it("reports both initialization and cleanup failures", async () => {
    const setupFailure = new Error("schema initialization failed");
    const cleanupFailure = new Error("drop failed");
    mocks.initializeSchema.mockRejectedValueOnce(setupFailure);
    mocks.admin.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(cleanupFailure);
    await expect(testDatabase()).rejects.toMatchObject({
      name: "AggregateError", errors: [setupFailure, cleanupFailure],
    });
    expect(mocks.admin.end).toHaveBeenCalledOnce();
  });

  it("attempts every cleanup step and reports every failure", async () => {
    const fixture = await testDatabase();
    const failures = ["operator", "runtime", "drop", "admin"].map(stage => new Error(`${stage} failed`));
    mocks.operator.end.mockRejectedValueOnce(failures[0]);
    mocks.runtime.end.mockRejectedValueOnce(failures[1]);
    mocks.admin.query.mockRejectedValueOnce(failures[2]);
    mocks.admin.end.mockRejectedValueOnce(failures[3]);
    await expect(fixture.close()).rejects.toMatchObject({ name: "AggregateError", errors: failures });
    for (const pool of [mocks.admin, mocks.operator, mocks.runtime]) expect(pool.end).toHaveBeenCalledOnce();
  });

  it.each([
    Object.assign(new Error("database in use"), { code: "55006" }),
    { code: "55006" },
  ])("retries an in-use database and stops after a successful drop", async inUse => {
    vi.useFakeTimers();
    const fixture = await testDatabase();
    mocks.admin.query.mockRejectedValueOnce(inUse).mockRejectedValueOnce(inUse);
    const closing = fixture.close();
    await vi.runAllTimersAsync();
    await closing;
    expect(mocks.admin.query).toHaveBeenCalledTimes(4);
    expect(mocks.admin.end).toHaveBeenCalledOnce();
  });

  it("bounds drop retries and still closes the admin pool", async () => {
    vi.useFakeTimers();
    const fixture = await testDatabase();
    const inUse = Object.assign(new Error("database in use"), { code: "55006" });
    mocks.admin.query.mockRejectedValue(inUse);
    const closing = expect(fixture.close()).rejects.toBe(inUse);
    await vi.runAllTimersAsync();
    await closing;
    expect(mocks.admin.query).toHaveBeenCalledTimes(41);
    expect(mocks.admin.end).toHaveBeenCalledOnce();
  });
});
