import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

vi.mock("./db/sessions.js", async importOriginal => {
  const session = await import("express-session");
  return { ...await importOriginal<typeof import("./db/sessions.js")>(), createSessionStore: () => new session.default.MemoryStore() };
});

let server: Server;
let origin: string;
const database = { query: vi.fn(() => { throw new Error("Bookmark migration must not access a database."); }) };

beforeAll(async () => {
  const { app } = createApp(database as never, "artifacts/not-used");
  await new Promise<void>(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve())); });

describe("retired Security bookmark migration", () => {
  it.each(["/security", "/security/", "/security?job=private-job&agentRecordId=private-agent",
    "/security/?source=defender&agentIds=private-id&returnTo=https%3A%2F%2Fexample.invalid"])(
    "redirects %s to Agents without preserving any query or requiring a session", async path => {
      const response = await fetch(`${origin}${path}`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/agents");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).not.toMatch(/private-|example\.invalid|agentIds|returnTo/);
      expect(database.query).not.toHaveBeenCalled();
    },
  );
});
