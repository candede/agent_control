import { IncomingMessage, Server, ServerResponse, type RequestListener } from "node:http";
import { Socket } from "node:net";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DataConnections } from "../src/db/dataConnections.js";
import { DataSyncRepository } from "../src/db/dataSync.js";
import { InventoryGenerations } from "../src/db/inventoryGenerations.js";
import { UserSourceStages } from "../src/db/userSourceStages.js";
import type { GenerationLease } from "../src/db/dataGenerations.js";
import { AppError } from "../src/errors.js";
import { InventoryReconciliation } from "../src/services/inventoryReconciliation.js";
import { InventoryRuntime } from "../src/services/inventoryRuntime.js";
import { reportIdentity } from "../src/services/reportIdentity.js";
import { StreamedInventory } from "../src/services/streamedInventory.js";
import { nativeInventoryFixture } from "./inventoryFixtures.js";
import { savedReadBrowserFixture } from "./savedReadBrowserFixture.js";

const mocks = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock("node:http", async importOriginal => ({
  ...await importOriginal<typeof import("node:http")>(), createServer: mocks.createServer,
}));
vi.mock("../src/services/reportIdentity.js", () => ({ reportIdentity: vi.fn() }));
vi.mock("../src/db/dataRetention.js", () => ({ retainRecordData: vi.fn(async () => undefined) }));
vi.mock("./inventoryFixtures.js", async importOriginal => ({
  ...await importOriginal<typeof import("./inventoryFixtures.js")>(), nativeInventoryFixture: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function dependencies() {
  const database = new pg.Pool({ max: 4 }), operator = new pg.Pool({ max: 4 });
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
  vi.spyOn(operator, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
  const query = vi.spyOn(database, "query").mockImplementation(async () => ({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] }));
  const operatorQuery = vi.spyOn(operator, "query").mockImplementation(async () => ({ rows: [], rowCount: 0, command: "UPDATE", oid: 0, fields: [] }));
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(client, "query").mockRejectedValue(new Error("Unexpected database query."));
  vi.spyOn(DataConnections.prototype, "run").mockImplementation(async work => work(client));
  const root = { scopeId: "scope", tenantId: "tenant", baselineId: "baseline", revision: "1", epoch: "0",
    inserted: 0, closed: 0, changed: 0 };
  const lease: GenerationLease = { id: "generation", scopeId: root.scopeId, tenantId: root.tenantId, owner: "owner",
    version: 1, epoch: "0", sessionEpoch: "7", expectedRevision: "0", schemaVersion: 1 };
  vi.mocked(reportIdentity).mockImplementation(async (_database, user) => ({
    tenantId: user.tenantId!, principalId: user.homeAccountId, sessionEpoch: "7", authorizationHash: "synthetic-authorization",
  }));
  vi.mocked(nativeInventoryFixture).mockResolvedValue(root);
  vi.spyOn(UserSourceStages.prototype, "execute").mockResolvedValue({
    generationId: lease.id, scopeId: lease.scopeId, revision: "1", rows: 1, children: 0, batches: 1, pages: 1, wireRows: 1, bytes: 64,
  });
  const execute = vi.spyOn(InventoryGenerations.prototype, "execute").mockImplementation(async (_input, _intent, work) => {
    await work(lease, new AbortController().signal);
    return root;
  });
  const append = vi.spyOn(InventoryGenerations.prototype, "appendBounded").mockResolvedValue(undefined);
  vi.spyOn(InventoryGenerations.prototype, "visit").mockResolvedValue(undefined);
  const accept = vi.spyOn(InventoryGenerations.prototype, "acceptPage").mockResolvedValue(undefined);
  const clear = vi.spyOn(InventoryGenerations.prototype, "clear").mockResolvedValue(undefined);
  vi.spyOn(InventoryGenerations.prototype, "gcSlice").mockResolvedValue({ rows: 1, removed: 1, bytes: 64 });
  vi.spyOn(InventoryGenerations.prototype, "gcContent").mockResolvedValue({ rows: 1, bytes: 64 });
  vi.spyOn(InventoryGenerations.prototype, "gcMetadataSlice").mockResolvedValue({ rows: 1, removed: {}, bytes: 64 });
  vi.spyOn(InventoryRuntime.prototype, "enqueue").mockResolvedValue(true);
  const reconcile = vi.spyOn(InventoryReconciliation.prototype, "runNext").mockResolvedValue(root);
  vi.spyOn(DataSyncRepository.prototype, "recordSuccessMarker").mockResolvedValue(undefined);
  const observation = vi.spyOn(StreamedInventory.prototype, "packageObservation").mockResolvedValue(undefined);
  return { database, operator, root, query, operatorQuery, execute, append, accept, clear, reconcile, observation };
}

let server: Server, handler: RequestListener, listening: boolean;
let closeServer: MockInstance<Server["close"]>;
const fixtures: Awaited<ReturnType<typeof savedReadBrowserFixture>>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  server = new Server();
  listening = false;
  mocks.createServer.mockImplementation((listener: RequestListener) => { handler = listener; return server; });
  vi.spyOn(server, "listen").mockImplementation((...args: unknown[]) => {
    listening = true;
    const done = args.at(-1);
    if (typeof done === "function") done();
    return server;
  });
  vi.spyOn(server, "listening", "get").mockImplementation(() => listening);
  vi.spyOn(server, "address").mockReturnValue({ address: "127.0.0.1", family: "IPv4", port: 4321 });
  closeServer = vi.spyOn(server, "close").mockImplementation(done => {
    listening = false;
    done?.();
    return server;
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  await Promise.allSettled(fixtures.splice(0).map(fixture => fixture.close()));
  vi.restoreAllMocks();
});

async function open(f: ReturnType<typeof dependencies>) {
  const fixture = await savedReadBrowserFixture(f.database, f.operator,
    ["desktop-running", "desktop-failed", "mobile-running", "mobile-failed"]
      .map(key => ({ tenantId: `tenant-${key}`, domains: [`${key}.lifecycle.example.invalid`] })));
  fixtures.push(fixture);
  expect(server.listenerCount("error")).toBe(0);
  return fixture;
}

async function command(path: string, key = "desktop-running") {
  const request = new IncomingMessage(new Socket());
  request.method = "POST";
  request.url = `/${path}?key=${key}`;
  const response = new ServerResponse(request);
  let text = "";
  vi.spyOn(response, "end").mockImplementation(chunk => { text = String(chunk ?? ""); return response; });
  await handler(request, response);
  return { status: response.statusCode, text };
}

describe("saved-read browser fixture without infrastructure", () => {
  it.each(["desktop-running", "desktop-failed", "mobile-running", "mobile-failed"])(
    "preserves the publication lifecycle for %s", async key => {
      const f = dependencies(), fixture = await open(f);
      f.query.mockImplementation(async () => ({ rows: [f.root], rowCount: 1, command: "SELECT", oid: 0, fields: [] }));
      const setup = await command("setup", key);
      expect(setup.status).toBe(200);
      expect(JSON.parse(setup.text)).toMatchObject({
        scenario: `lifecycle-${key}`, username: `fixture@${key}.lifecycle.example.invalid`,
        failed: key.endsWith("failed"), gc: { slices: 6, maximumRows: 1, maximumBytes: 64 },
      });
      expect(f.execute.mock.calls[0][0]).toMatchObject({
        scope: { tenantId: `tenant-${key}`, principalId: null, kind: "tenant" },
        actorPrincipalId: `fixture-lifecycle-${key}`, sessionEpoch: "7",
      });
      expect(f.append.mock.calls.map(([, records]) => records.length)).toEqual([250, 250, 250, 250, 1]);
      expect(f.accept).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
        nextToken: null, page: 5, rawCount: 1, expectedCount: 1001,
      }), 1);
      for (const path of ["proof", "expire", "source", "canonical", "retire", "finish"]) {
        expect((await command(path, key)).status).toBe(200);
      }
      expect(f.operatorQuery).toHaveBeenCalledWith(expect.stringContaining("UPDATE data_read_selections"),
        [`tenant-${key}`, `fixture-lifecycle-${key}`]);
      expect(f.clear).toHaveBeenCalledWith(f.root.scopeId, `tenant-${key}`);
      await fixture.close();
      expect(closeServer).toHaveBeenCalledOnce();
    });

  it("reserves a subject before asynchronous setup can overlap", async () => {
    const f = dependencies();
    await open(f);
    const identity = deferred<Awaited<ReturnType<typeof reportIdentity>>>();
    vi.mocked(reportIdentity).mockReturnValueOnce(identity.promise);
    const first = command("setup");
    const second = await command("setup");
    identity.resolve({ tenantId: "tenant-desktop-running", principalId: "fixture-lifecycle-desktop-running",
      sessionEpoch: "7", authorizationHash: "synthetic-authorization" });
    expect(second.status).toBe(500);
    expect(second.text).toContain("duplicate_fixture_subject");
    expect((await first).status).toBe(200);
    expect(reportIdentity).toHaveBeenCalledOnce();
  });

  it("preserves idempotent finish and releases the reservation after failed setup", async () => {
    const f = dependencies();
    await open(f);
    vi.mocked(reportIdentity).mockRejectedValueOnce(new Error("Synthetic identity failure"));
    expect((await command("setup")).status).toBe(500);
    expect((await command("finish")).status).toBe(204);
    expect((await command("setup")).status).toBe(200);
  });

  it("drains a setup that was still pending when cleanup started", async () => {
    const f = dependencies(), fixture = await open(f);
    const identity = deferred<Awaited<ReturnType<typeof reportIdentity>>>();
    vi.mocked(reportIdentity).mockReturnValueOnce(identity.promise);
    const setup = command("setup");
    const closing = fixture.close();
    identity.resolve({ tenantId: "tenant-desktop-running", principalId: "fixture-lifecycle-desktop-running",
      sessionEpoch: "7", authorizationHash: "synthetic-authorization" });
    await setup;
    await closing;
    expect(f.execute.mock.settledResults[1]?.type).toBe("fulfilled");
    expect(closeServer).toHaveBeenCalledOnce();
  });

  it("does not start another subject after cleanup has begun", async () => {
    const f = dependencies(), fixture = await open(f);
    const closing = fixture.close();
    const result = await command("setup");
    await closing;
    expect(result.status).toBe(500);
    expect(result.text).toContain("fixture_closing");
    expect(reportIdentity).not.toHaveBeenCalled();
  });

  it("does not accept an unrelated provider timeout as the running scenario's synthetic failure", async () => {
    const f = dependencies();
    await open(f);
    const execute = f.execute.getMockImplementation()!;
    const failure = new AppError(504, "provider_timeout", "Unexpected publication timeout");
    f.execute.mockImplementation(async (...args) => {
      const root = await execute(...args);
      if (args[1].mode === "delta") throw failure;
      return root;
    });
    expect((await command("setup")).status).toBe(200);
    const result = await command("source");
    expect(result.status).toBe(500);
    expect(result.text).toContain("Unexpected publication timeout");
  });

  it("propagates a provider failure before the intentional failed replacement is reached", async () => {
    const f = dependencies();
    await open(f);
    f.observation.mockRejectedValue(new AppError(504, "provider_timeout", "Unexpected observation timeout"));
    const result = await command("setup", "desktop-failed");
    expect(result.status).toBe(500);
    expect(result.text).toContain("Unexpected observation timeout");
  });

  it("closes its server even when a successor rejects", async () => {
    const f = dependencies(), fixture = await open(f);
    const execute = f.execute.getMockImplementation()!;
    const failure = new Error("Unexpected successor failure");
    f.execute.mockImplementation(async (...args) => {
      const root = await execute(...args);
      if (args[1].mode === "delta") throw failure;
      return root;
    });
    await command("setup");
    await expect(fixture.close()).rejects.toBe(failure);
    expect(closeServer).toHaveBeenCalledOnce();
    expect(listening).toBe(false);
  });

  it("fails setup if no initial canonical publication was produced", async () => {
    const f = dependencies();
    await open(f);
    f.reconcile.mockResolvedValue(null);
    const result = await command("setup");
    expect(result.status).toBe(500);
    expect(result.text).toContain("fixture_canonical_unavailable");
    expect(f.observation).not.toHaveBeenCalled();
  });

  it("rejects listener startup errors and removes the startup listener after success", async () => {
    const f = dependencies(), failure = new Error("Synthetic listener startup failure");
    vi.mocked(server.listen).mockImplementation(() => {
      if (!server.listenerCount("error")) throw new Error("Missing startup error handler");
      queueMicrotask(() => server.emit("error", failure));
      return server;
    });
    await expect(open(f)).rejects.toBe(failure);
    expect(server.listenerCount("error")).toBe(0);
  });
});
