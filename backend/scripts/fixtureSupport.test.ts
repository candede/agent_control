import { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeFixtureResources, closeFixtureServer, configureBrowserFixtureEnvironment } from "./fixtureSupport.js";

afterEach(() => { vi.restoreAllMocks(); });

function browserEnvironment(values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", AGENT_CONTROL_FIXTURE_MODE: "browser", ...values };
}

describe("browser fixture environment", () => {
  it("removes file-backed identity overrides without changing database settings", () => {
    const env = browserEnvironment({
      TENANT_ID_FILE: "/unused/tenant", CLIENT_ID_FILE: "/unused/client",
      CLIENT_SECRET_FILE: "/unused/client-secret", SESSION_SECRET_FILE: "/unused/session",
      PGDATABASE: "agentcontrol_test_control", PGPASSWORD_FILE: "/unused/admin",
      APP_PGPASSWORD_FILE: "/unused/runtime",
    });
    configureBrowserFixtureEnvironment(env);
    for (const name of ["TENANT_ID", "CLIENT_ID", "CLIENT_SECRET", "SESSION_SECRET"]) {
      expect(env).not.toHaveProperty(`${name}_FILE`);
      expect(env[name]).toBeTruthy();
    }
    expect(env).toMatchObject({
      NODE_ENV: "test", AGENT_CONTROL_FIXTURE_MODE: "browser",
      TENANT_ID: "11111111-1111-1111-1111-111111111111",
      CLIENT_ID: "22222222-2222-2222-2222-222222222222",
      FRONTEND_ORIGIN: "http://localhost:3001", REDIRECT_URI: "http://localhost:3001/api/auth/callback",
      PGDATABASE: "agentcontrol_test_control", PGPASSWORD_FILE: "/unused/admin",
      APP_PGPASSWORD_FILE: "/unused/runtime",
    });
  });

  it.each(["http://127.0.0.1:4301", "http://localhost:4301", "http://localhost"])("uses the same origin for the app and callback: %s", origin => {
    const env = browserEnvironment({ PLAYWRIGHT_BASE_URL: origin });
    configureBrowserFixtureEnvironment(env);
    expect(env.FRONTEND_ORIGIN).toBe(origin);
    expect(env.REDIRECT_URI).toBe(`${origin}/api/auth/callback`);
  });

  it.each([
    "https://localhost:3001", "http://example.invalid:3001", "http://localhost:0",
    "http://localhost:3001/path", "http://localhost:3001?fixture=x", "http://localhost:3001#fragment",
    "http://user@localhost:3001",
  ])("rejects an unsuitable origin without changing the environment: %s", origin => {
    const env = browserEnvironment({ PLAYWRIGHT_BASE_URL: origin });
    const before = { ...env };
    expect(() => configureBrowserFixtureEnvironment(env)).toThrow("plain HTTP loopback origin");
    expect(env).toEqual(before);
  });

  it.each([
    { NODE_ENV: "production" }, { NODE_ENV: "development" }, { NODE_ENV: undefined },
    { AGENT_CONTROL_FIXTURE_MODE: undefined }, { AGENT_CONTROL_FIXTURE_MODE: "other" },
  ])("requires explicit fixture mode and test environment: %j", values => {
    const env = browserEnvironment(values);
    const before = { ...env };
    expect(() => configureBrowserFixtureEnvironment(env)).toThrow("isolated browser test entry point");
    expect(env).toEqual(before);
  });
});

describe("fixture resource cleanup", () => {
  it("awaits each cleanup step before starting the next", async () => {
    const order: string[] = [];
    await closeFixtureResources(
      async () => { await Promise.resolve(); order.push("server"); },
      () => { order.push("pool"); },
      async () => { await Promise.resolve(); order.push("database"); },
    );
    expect(order).toEqual(["server", "pool", "database"]);
  });

  it("attempts the remaining steps after synchronous and asynchronous failures", async () => {
    const storeFailure = new Error("store close failed");
    const poolFailure = new Error("pool close failed");
    const dropDatabase = vi.fn(async () => undefined);
    const restoreMocks = vi.fn();
    await expect(closeFixtureResources(
      () => { throw storeFailure; },
      async () => { throw poolFailure; },
      dropDatabase, restoreMocks,
    )).rejects.toMatchObject({ name: "AggregateError", errors: [storeFailure, poolFailure] });
    expect(dropDatabase).toHaveBeenCalledOnce();
    expect(restoreMocks).toHaveBeenCalledOnce();
  });

  it("preserves a single failure rather than masking it", async () => {
    const failure = new Error("cleanup failed");
    await expect(closeFixtureResources(() => { throw failure; })).rejects.toBe(failure);
  });

  it("does not close a server that never listened or is already closed", async () => {
    const server = new Server();
    const close = vi.spyOn(server, "close");
    await closeFixtureServer();
    await closeFixtureServer(server);
    expect(close).not.toHaveBeenCalled();
  });

  it.each([undefined, new Error("server close failed")])("awaits server closure and propagates callback errors", async failure => {
    const server = new Server();
    vi.spyOn(server, "listening", "get").mockReturnValue(true);
    let finish: ((error?: Error) => void) | undefined;
    vi.spyOn(server, "close").mockImplementation(callback => { finish = callback; return server; });
    const closing = closeFixtureServer(server);
    expect(finish).toBeTypeOf("function");
    finish!(failure);
    if (failure) await expect(closing).rejects.toBe(failure);
    else await expect(closing).resolves.toBeUndefined();
  });
});
