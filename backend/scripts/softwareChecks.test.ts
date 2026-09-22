import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import { runSoftwareChecks } from "./softwareChecks.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(async (_sql: string) => ({ rows: [] })),
  end: vi.fn(async () => undefined),
  Pool: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock("pg", () => ({ default: { Pool: mocks.Pool } }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));

const fixtureEnvironment = {
  AGENT_CONTROL_ISOLATED_TESTS: "1",
  PGHOST: "127.0.0.1",
  PGPORT: "5432",
  PGDATABASE: "agentcontrol_test_control",
  PGUSER: "agentcontrol_admin",
  PGPASSWORD: "isolated-fixture-admin-password-never-production-01",
  APP_PGPASSWORD: "isolated-fixture-password-never-production-01",
  PGSSLMODE: "disable",
};
const result = (overrides: Partial<SpawnSyncReturns<Buffer>> = {}): SpawnSyncReturns<Buffer> => ({
  pid: 123,
  output: [],
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  status: 0,
  signal: null,
  ...overrides,
});

beforeEach(() => {
  for (const [key, value] of Object.entries(fixtureEnvironment)) vi.stubEnv(key, value);
  for (const key of ["PGPASSWORD_FILE", "APP_PGPASSWORD_FILE", "PGDATABASE_FILE", "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE"]) vi.stubEnv(key, undefined);
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.end.mockReset().mockResolvedValue(undefined);
  mocks.Pool.mockReset().mockImplementation(function () { return { query: mocks.query, end: mocks.end }; });
  mocks.spawnSync.mockReset().mockReturnValue(result());
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function messages() {
  return vi.mocked(console.log).mock.calls.map(args => args.join(" ")).join("\n");
}

describe("isolated aggregate software qualification", () => {
  it("labels all five commands and reports only software qualification", async () => {
    await runSoftwareChecks();
    expect(mocks.spawnSync.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ["npm", ["run", "test", "--workspace", "backend"]],
      ["npm", ["run", "test", "--workspace", "frontend"]],
      ["npm", ["run", "typecheck", "--workspace", "backend"]],
      ["npm", ["run", "lint", "--workspace", "frontend"]],
      ["npm", ["run", "build"]],
    ]);
    for (const [index, name] of ["Backend tests", "Frontend tests", "Backend typecheck", "Frontend lint", "Production build"].entries()) {
      expect(messages()).toContain(`[AUTOMATED CHECKS ${index + 1}/5] RUN ${name}`);
      expect(messages()).toContain(`[AUTOMATED CHECKS ${index + 1}/5] PASS ${name}`);
    }
    expect(messages()).toContain("[AUTOMATED CHECKS] PASSED: 5/5 steps passed; isolated database cleanup completed.");
    expect(messages()).not.toMatch(/LOCAL READINESS|MICROSOFT|Permissions/);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("uses a new database with fixture-only settings and never forwards application secrets", async () => {
    for (const key of ["TENANT_ID", "CLIENT_ID", "CLIENT_SECRET", "CLIENT_SECRET_FILE", "SESSION_SECRET", "SESSION_SECRET_FILE", "DATABASE_URL", "NODE_OPTIONS"]) {
      vi.stubEnv(key, "real-application-setting-must-not-reach-fixtures");
    }
    await runSoftwareChecks();
    const create = mocks.query.mock.calls[0][0];
    expect(create).toMatch(/^CREATE DATABASE "agentcontrol_test_[a-f0-9]{32}"$/);
    const name = create.split('"')[1];
    expect(name).not.toBe(fixtureEnvironment.PGDATABASE);
    expect(mocks.Pool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      host: "127.0.0.1", database: "agentcontrol_test_control", user: "agentcontrol_admin",
      password: fixtureEnvironment.PGPASSWORD, ssl: false,
    }));
    for (const call of mocks.spawnSync.mock.calls) {
      expect(call[2]).toMatchObject({
        stdio: "inherit", timeout: 180_000, env: { ...fixtureEnvironment, PGDATABASE: name },
      });
      expect(Object.values(call[2].env)).not.toContain("real-application-setting-must-not-reach-fixtures");
    }
    expect(mocks.query).toHaveBeenLastCalledWith(`DROP DATABASE "${name}" WITH (FORCE)`);
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.end.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.query.mock.invocationCallOrder[1]);
  });

  it.each(Object.keys(fixtureEnvironment))("rejects an unsafe %s before opening a database", async key => {
    vi.stubEnv(key, "application-setting");
    await expect(runSoftwareChecks()).rejects.toThrow("Software qualification failed");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Isolated PostgreSQL setup"),
      expect.objectContaining({ message: expect.stringContaining(`${key} differs`) }),
    );
    expect(mocks.Pool).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(messages()).toContain("[AUTOMATED CHECKS] FAILED: 0/5");
    expect(messages()).not.toContain("[AUTOMATED CHECKS] PASSED");
  });

  it.each(["PGPASSWORD_FILE", "APP_PGPASSWORD_FILE", "PGDATABASE_FILE", "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE"])("rejects file/service override %s without reading it", async key => {
    vi.stubEnv(key, "/must-not-open/production-secret");
    await expect(runSoftwareChecks()).rejects.toThrow("Software qualification failed");
    expect(mocks.Pool).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.stringContaining(`reject ${key}`) }));
  });

  it("stops on the first failed command, retains its cause, and still removes only its created database", async () => {
    mocks.spawnSync.mockReturnValueOnce(result()).mockReturnValueOnce(result({ status: 7 }));
    await expect(runSoftwareChecks()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining("npm run test --workspace frontend exited with 7") })],
    });
    expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
    expect(messages()).toContain("[AUTOMATED CHECKS] FAILED: 1/5 steps passed");
    expect(messages()).not.toContain("PASS Frontend tests");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Frontend tests"), expect.any(Error));
    expect(mocks.query).toHaveBeenLastCalledWith(expect.stringMatching(/^DROP DATABASE "agentcontrol_test_[a-f0-9]{32}" WITH \(FORCE\)$/));
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it.each(["ENOENT", "ETIMEDOUT"])("preserves the %s spawn error and failing command", async code => {
    const error = Object.assign(new Error(`spawn npm ${code}`), { code });
    mocks.spawnSync.mockReturnValue(result({ status: null, error }));
    await expect(runSoftwareChecks()).rejects.toMatchObject({
      errors: [expect.objectContaining({ cause: error, message: expect.stringContaining("npm run test --workspace backend could not complete") })],
    });
    expect(mocks.spawnSync).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(messages()).toContain("FAILED: 0/5");
  });

  it.each([
    { outcome: result({ status: null, signal: "SIGTERM" }), cause: "terminated by SIGTERM" },
    { outcome: result({ status: null }), cause: "exited with no exit status" },
  ])("fails closed when a command $cause", async ({ outcome, cause }) => {
    mocks.spawnSync.mockReturnValue(outcome);
    await expect(runSoftwareChecks()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining(cause) })],
    });
    expect(mocks.spawnSync).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("does not drop an unowned database when creation fails", async () => {
    const error = new Error("CREATE DATABASE denied");
    mocks.query.mockRejectedValueOnce(error);
    await expect(runSoftwareChecks()).rejects.toMatchObject({ errors: [error] });
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("fails qualification if cleanup fails after all commands pass", async () => {
    const error = new Error("DROP DATABASE denied");
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(error);
    await expect(runSoftwareChecks()).rejects.toMatchObject({ errors: [error] });
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(messages()).toContain("[AUTOMATED CHECKS] FAILED: 5/5 steps passed; software is not qualified");
    expect(messages()).not.toContain("cleanup completed");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("cleanup of owned fixture database"), error);
  });

  it("retains command, database cleanup and connection cleanup failures together", async () => {
    const drop = new Error("fixture drop failed");
    const close = new Error("fixture connection close failed");
    mocks.spawnSync.mockReturnValue(result({ status: 1 }));
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(drop);
    mocks.end.mockRejectedValueOnce(close);
    await expect(runSoftwareChecks()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: expect.stringContaining("exited with 1") }),
        expect.objectContaining({ errors: [drop, close] }),
      ],
    });
    expect(mocks.end).toHaveBeenCalledOnce();
  });
});
