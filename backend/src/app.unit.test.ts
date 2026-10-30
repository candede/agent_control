import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import session from "express-session";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { config } from "./config.js";
import * as schema from "./db/schema.js";
import { clearAdmissionForTest } from "./middleware/admission.js";
import * as maintenance from "./services/maintenance.js";
import * as operationalState from "./services/operationalState.js";

const database = new pg.Pool({ max: 4 });
const memoryStore = new session.MemoryStore();
const identityFetch = vi.fn<typeof fetch>();
let application: ReturnType<typeof createApp>;
let server: Server;
let origin: string;
let directory: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "agent-control-app-"));
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Fixture shell</title>");
  writeFileSync(join(directory, "assets", "app.js"), "console.log('fixture');");
  application = createApp(database, directory, identityFetch);
  server = createServer(application.app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local test port.");
  origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  clearAdmissionForTest();
  identityFetch.mockReset().mockRejectedValue(new Error("Unexpected identity request."));
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected database request."));
  vi.spyOn(application.store, "get").mockImplementation(memoryStore.get.bind(memoryStore));
  vi.spyOn(application.store, "set").mockImplementation(memoryStore.set.bind(memoryStore));
  vi.spyOn(application.store, "destroy").mockImplementation(memoryStore.destroy.bind(memoryStore));
  vi.spyOn(application.store, "touch").mockImplementation(memoryStore.touch.bind(memoryStore));
  vi.spyOn(schema, "verifySchema").mockResolvedValue();
  vi.spyOn(operationalState, "readOperationalState").mockResolvedValue({ mode: "normal", providerWorkEnabled: true });
  vi.spyOn(maintenance, "maintenanceActive").mockReturnValue(false);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  try {
    expect(database.query).not.toHaveBeenCalled();
    expect(identityFetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  application?.store.close();
  await database.end();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function request(path: string, options: RequestInit = {}) {
  return fetch(`${origin}${path}`, { redirect: "manual", ...options });
}

describe("infrastructure-free application HTTP boundaries", () => {
  it.each(["/api/health", "/api/ready", "/api/auth/status"])("does not cache public API response %s", async path => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps unavailable readiness uncached without changing liveness", async () => {
    vi.mocked(schema.verifySchema).mockRejectedValue(new Error("Synthetic schema failure."));
    const response = await request("/api/ready");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await request("/api/health")).status).toBe(200);
  });

  it("does not cache an authentication rejection before route dispatch", async () => {
    const response = await request("/api/diagnostics", { headers: { authorization: "invalid" } });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("does not cache session-store failures", async () => {
    vi.mocked(application.store.get).mockImplementation((_id, callback) => callback(new Error("Synthetic session failure.")));
    const id = "synthetic-session";
    const signature = createHmac("sha256", config.sessionSecret).update(id).digest("base64").replace(/=+$/, "");
    const response = await request("/api/diagnostics", {
      headers: { cookie: `agent-control.sid=${encodeURIComponent(`s:${id}.${signature}`)}` },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "internal_error" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it.each([
    { headers: { "content-type": "application/json; charset=iso-8859-1" }, body: "{}" },
    { headers: { "content-type": "application/json", "content-encoding": "unsupported" }, body: "{}" },
  ])("returns a client problem for unsupported JSON transport $headers", async ({ headers, body }) => {
    const response = await request("/api/auth/login", { method: "POST", headers, body });
    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      status: 415, title: "Unsupported media type", code: "request_rejected",
      detail: "The request could not be served.", requestId: response.headers.get("x-request-id"),
    });
  });

  it.each([
    { body: "{", status: 400 },
    { body: JSON.stringify({ value: "x".repeat(524_288) }), status: 413 },
  ])("preserves JSON rejection status $status and prevents caching", async ({ body, status }) => {
    const response = await request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ status, code: "request_rejected" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("accepts a JSON body exactly at the 512 KiB limit", async () => {
    const body = JSON.stringify({ value: "x".repeat(524_288 - '{"value":""}'.length) });
    expect(Buffer.byteLength(body)).toBe(524_288);
    const response = await request("/api/unknown", {
      method: "POST",
      headers: { "content-type": "application/json", origin: config.frontendOrigin },
      body,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });

  it("preserves same-origin protection for browser writes", async () => {
    const response = await request("/api/auth/login", { method: "POST", headers: { origin: "https://other.invalid" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "invalid_origin" });
  });

  it("preserves anonymous authorization and API not-found problems", async () => {
    const denied = await request("/api/diagnostics");
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ code: "unauthorized" });
    const missing = await request("/api/unknown");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });
    expect(missing.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps invalid API paths uncached", async () => {
    const response = await request("/api/%00");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_path" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("preserves the SPA shell and immutable asset caching", async () => {
    const shell = await request("/sync?reports=manage");
    expect(shell.status).toBe(200);
    expect(shell.headers.get("cache-control")).toContain("no-store");
    expect(await shell.text()).toContain("Fixture shell");
    const asset = await request("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toContain("console.log");
    expect((await request("/assets/missing.js")).status).toBe(404);
  });
});
