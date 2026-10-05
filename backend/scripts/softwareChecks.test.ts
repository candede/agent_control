import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import { runSoftwareChecks } from "./softwareChecks.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(async (_sql: string) => ({ rows: [] })),
  end: vi.fn(async () => undefined),
  Pool: vi.fn(),
  spawnSync: vi.fn(),
  existsSync: vi.fn(),
}));
vi.mock("pg", () => ({ default: { Pool: mocks.Pool } }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: mocks.existsSync,
}));

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
  mocks.existsSync.mockReset().mockReturnValue(true);
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
  it("runs static checks before regression tests without rebuilding compiled artifacts", async () => {
    await runSoftwareChecks();
    expect(mocks.spawnSync.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ["npm", ["run", "lint", "--workspace", "frontend"]],
      ["npm", ["run", "typecheck", "--workspace", "frontend"]],
      ["npm", ["run", "test", "--workspace", "backend"]],
      ["npm", ["run", "test", "--workspace", "frontend"]],
    ]);
    for (const [index, name] of ["Frontend lint", "Frontend typecheck", "Backend tests", "Frontend tests"].entries()) {
      expect(messages()).toContain(`[AUTOMATED CHECKS ${index + 1}/4] RUN ${name}`);
      expect(messages()).toContain(`[AUTOMATED CHECKS ${index + 1}/4] PASS ${name}`);
    }
    expect(messages()).toContain("[AUTOMATED CHECKS] PASSED: 4/4 steps passed; isolated database cleanup completed.");
    expect(messages()).not.toMatch(/LOCAL READINESS|MICROSOFT|Permissions/);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("refuses missing compiled artifacts before creating test infrastructure", async () => {
    mocks.existsSync.mockReturnValue(false);
    await expect(runSoftwareChecks()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining("Build the qualification image first") })],
    });
    expect(mocks.Pool).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("fits all command budgets plus cleanup inside the enclosing local workload deadline", async () => {
    await runSoftwareChecks();
    const script = readFileSync(new URL("../../scripts/local-deployment.ps1", import.meta.url), "utf8");
    const deadline = /Invoke-OwnedFixtureWorkload[^\n]+backend\/scripts\/test-all\.ts[^\n]+-TimeoutSeconds (\d+)/.exec(script);
    expect(deadline).not.toBeNull();
    const combinedBudget = mocks.spawnSync.mock.calls.reduce((total, call) => total + call[2].timeout, 0);
    expect(combinedBudget).toBe(1_740_000);
    expect(Number(deadline?.[1]) * 1_000).toBeGreaterThanOrEqual(combinedBudget + 120_000);
  });

  it("uses a new database with fixture-only settings and never forwards application secrets", async () => {
    for (const key of ["TENANT_ID", "CLIENT_ID", "CLIENT_SECRET", "CLIENT_SECRET_FILE", "TENANTS_JSON", "TENANTS_JSON_FILE", "TENANT_DOMAINS", "TENANT_DOMAINS_FILE", "SESSION_SECRET", "SESSION_SECRET_FILE", "DATABASE_URL", "NODE_OPTIONS"]) {
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
    for (const [index, call] of mocks.spawnSync.mock.calls.entries()) {
      expect(call[2]).toMatchObject({
        stdio: "inherit", timeout: index === 2 ? 1_200_000 : 180_000, env: { ...fixtureEnvironment, PGDATABASE: name,
          NODE_OPTIONS: "--max-old-space-size=768", DEBUG_PRINT_LIMIT: "1200",
          NPM_CONFIG_REGISTRY: "https://packagefeedproxy.microsoft.io/npm/" },
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
    expect(messages()).toContain("[AUTOMATED CHECKS] FAILED: 0/4");
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
      errors: [expect.objectContaining({ message: expect.stringContaining("npm run typecheck --workspace frontend exited with 7") })],
    });
    expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
    expect(messages()).toContain("[AUTOMATED CHECKS] FAILED: 1/4 steps passed");
    expect(messages()).not.toContain("PASS Frontend typecheck");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Frontend typecheck"), expect.any(Error));
    expect(mocks.query).toHaveBeenLastCalledWith(expect.stringMatching(/^DROP DATABASE "agentcontrol_test_[a-f0-9]{32}" WITH \(FORCE\)$/));
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it.each(["ENOENT", "ETIMEDOUT"])("preserves the %s spawn error and failing command", async code => {
    const error = Object.assign(new Error(`spawn npm ${code}`), { code });
    mocks.spawnSync.mockReturnValue(result({ status: null, error }));
    await expect(runSoftwareChecks()).rejects.toMatchObject({
      errors: [expect.objectContaining({ cause: error, message: expect.stringContaining("npm run lint --workspace frontend could not complete") })],
    });
    expect(mocks.spawnSync).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(messages()).toContain("FAILED: 0/4");
  });

  it.each([
    { index: 0, seconds: 180 },
    { index: 1, seconds: 180 },
    { index: 2, seconds: 1_200 },
    { index: 3, seconds: 180 },
  ])("fails closed at step $index with its exact $seconds-second budget", async ({ index, seconds }) => {
    const error = Object.assign(new Error("spawn npm ETIMEDOUT"), { code: "ETIMEDOUT" });
    for (let prior = 0; prior < index; prior += 1) mocks.spawnSync.mockReturnValueOnce(result());
    mocks.spawnSync.mockReturnValueOnce(result({ status: null, error }));
    await expect(runSoftwareChecks()).rejects.toMatchObject({
      errors: [expect.objectContaining({ cause: error, message: expect.stringContaining(`timeout limit ${seconds}s`) })],
    });
    expect(mocks.spawnSync).toHaveBeenCalledTimes(index + 1);
    expect(mocks.spawnSync.mock.calls[index][2].timeout).toBe(seconds * 1_000);
    expect(messages()).toContain(`FAILED: ${index}/4`);
    expect(mocks.query).toHaveBeenLastCalledWith(expect.stringMatching(/^DROP DATABASE "agentcontrol_test_[a-f0-9]{32}" WITH \(FORCE\)$/));
    expect(mocks.end).toHaveBeenCalledOnce();
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
    expect(messages()).toContain("[AUTOMATED CHECKS] FAILED: 4/4 steps passed; software is not qualified");
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
