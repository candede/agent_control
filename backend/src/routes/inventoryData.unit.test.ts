import express from "express";
import session from "express-session";
import pg from "pg";
import { request as httpRequest, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { errorHandler } from "../errors.js";
import * as identities from "../services/reportIdentity.js";
import { type SelectionIdentity } from "../services/dataSelections.js";
import { parseUnifiedAgentRecordId, unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { createInventoryDataRouter } from "./inventoryData.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{
    tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
    clientSecret: "synthetic-inventory-route-secret", domains: ["example.invalid"],
  }]);
  process.env.SESSION_SECRET = "synthetic-inventory-route-session-secret";
});
vi.mock("../services/telemetry.js", async original => ({
  ...await original<typeof import("../services/telemetry.js")>(), operationalLog: vi.fn(),
}));

const selectionId = "33333333-3333-4333-8333-333333333333";
const identity: SelectionIdentity = { tenantId: config.tenants[0].tenantId, principalId: "inventory-reader",
  authorizationHash: "viewer", sessionEpoch: "1" };
const at = new Date("2026-10-01T00:00:00Z");
const selection = { id: selectionId, revision: "1", evaluatedAt: at, validatedAt: at,
  expiresAt: new Date(at.getTime() + 600_000), endpoint: "inventory", queryHash: "query" };
const database = new pg.Pool({ max: 4 });
let server: Server, signedIn = true;

function emptyPage(): Awaited<ReturnType<InventoryQueries["page"]>> {
  const summary = { total: 0, linked: 0, graphOnly: 0, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 };
  return {
    inventoryScope: "all", value: [], summary, scopeSummary: summary, filteredSummary: summary,
    inventoryOverview: { availableToUsers: 0, organizationCreated: 0, teamsAvailable: 0, createdOrAvailable: 0 },
    counts: { total: 0, scoped: 0, filtered: 0, packageTargets: 0 },
    page: { limit: 50, nextCursor: null, previousCursor: null },
    selection: { ...selection, evaluatedAt: at.toISOString(), validatedAt: at.toISOString(),
      expiresAt: selection.expiresAt.toISOString(),
      publicationRevisions: { graph_packages: "1".repeat(64), power_platform: "2".repeat(64), users: "3".repeat(64) } },
    reports: { setId: null, activeSetId: null, activeRevision: "0", historyRevision: "0", historyEpoch: "0",
      availability: "never_imported", staleAfterDays: 7, periodAgeDays: null, acceptedAgeDays: null,
      reportingPeriod: null, acceptedAt: null, expiresAt: null, lineages: [] },
    freshness: { state: "idle", capturedRevision: "1", sources: [] },
    verificationCounts: { packages: 0, native_agents: 0, represented: 0, unique_sources: 0, checked_packages: 0,
      stale_packages: 0, invalidated_packages: 0, invalid_packages: 0 },
    partial: false,
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: config.sessionSecret, resave: false, saveUninitialized: false }));
  app.use((request, _response, next) => {
    if (signedIn) {
      request.session.accountId = identity.principalId;
      request.session.tenantId = identity.tenantId;
      request.session.clientId = config.tenants[0].clientId;
      request.session.rolesValidatedAt = Date.now();
      request.session.csrfToken = "fixture-csrf";
      request.session.user = { tenantId: identity.tenantId, homeAccountId: identity.principalId,
        username: "reader@example.invalid", displayName: "Reader", roles: ["AgentControl.Viewer"] };
    }
    next();
  });
  app.use("/api", createInventoryDataRouter(database));
  app.use(errorHandler);
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
});

beforeEach(() => {
  signedIn = true;
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
  vi.spyOn(database, "query").mockResolvedValue({
    command: "SELECT", rowCount: 1, oid: 0, fields: [],
    rows: [{ id: "inventory-scope", published: true, previously_published: true, preparing: false }],
  });
  vi.spyOn(identities, "reportIdentity").mockResolvedValue(identity);
  vi.spyOn(InventoryQueries.prototype, "capture").mockResolvedValue(selection);
  vi.spyOn(InventoryQueries.prototype, "page").mockImplementation(async () => emptyPage());
  vi.spyOn(InventoryQueries.prototype, "facets").mockResolvedValue({ value: [], total: 0, nextCursor: null });
  vi.spyOn(InventoryQueries.prototype, "responsibility").mockResolvedValue({
    selection: emptyPage().selection, counts: { total: 0, filtered: 0 },
    page: { limit: 50, nextCursor: null, previousCursor: null }, people: [], selected: null,
    invalidReferenceCount: 0, sourceRows: [],
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected provider request")));
});

afterEach(() => {
  try {
    expect(database.connect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await database.end();
});

function request(method: "GET" | "POST", path: string, body?: unknown, csrf = true):
  Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const content = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const message = httpRequest({ host: "127.0.0.1", port: address.port, method, path: `/api${path}`,
      headers: { ...(csrf ? { "x-csrf-token": "fixture-csrf" } : {}),
        ...(content ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(content) } : {}) },
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
    });
    message.once("error", reject);
    message.end(content);
  });
}

describe("endpoint-local inventory searches", () => {
  it.each(["", "   ", "\u3000"])("passes a blank facet search %j to the facet reader", async search => {
    const query = new URLSearchParams({ selectionId, field: "publisher", search });
    const response = await request("GET", `/agent-inventory/facets?${query}`);
    expect(response).toEqual({ status: 200, body: { value: [], total: 0, nextCursor: null } });
    expect(InventoryQueries.prototype.facets).toHaveBeenCalledWith(selectionId, identity, "publisher",
      expect.objectContaining({ search }));
    expect(InventoryQueries.prototype.capture).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("passes a blank responsibility search %j without filtering the captured agents", async search => {
    const response = await request("GET", `/agent-responsibility?${new URLSearchParams({ search })}`);
    expect(response.status).toBe(200);
    expect(InventoryQueries.prototype.capture).toHaveBeenCalledWith(identity, "inventory-scope",
      { inventoryScope: "all", source: "all", sortBy: "owner", sortDirection: "asc" });
    expect(InventoryQueries.prototype.responsibility).toHaveBeenCalledWith(selectionId, identity,
      expect.objectContaining({ search }));
  });

  it.each(["search=a&search=b", `search=${"x".repeat(257)}`, "search=%0A", "search=%00"])(
    "rejects malformed facet searches: %s", async search => {
      const response = await request("GET", `/agent-inventory/facets?selectionId=${selectionId}&field=publisher&${search}`);
      expect(response.status).toBe(400);
      expect(InventoryQueries.prototype.facets).not.toHaveBeenCalled();
    });

  it("does not relax empty inventory filter validation", async () => {
    expect((await request("POST", "/agent-inventory/selections", { query: { search: "" } })).status).toBe(400);
    expect(InventoryQueries.prototype.capture).not.toHaveBeenCalled();
  });
});

describe("source-qualified inventory record bounds", () => {
  const nativeId = "\u754c".repeat(512);
  const recordIds = [
    unifiedAgentRecordId({ source: "graph_packages", packageId: nativeId }),
    unifiedAgentRecordId({ source: "power_platform", nativeId, environmentId: nativeId }),
  ];

  it.each(["agent-inventory", "agents"])("captures supported encoded record IDs in %s filters", async resource => {
    for (const recordId of recordIds) {
      expect(recordId.length).toBeGreaterThan(4096);
      expect(parseUnifiedAgentRecordId(recordId)).toBeDefined();
      const response = await request("POST", `/${resource}/selections`, { query: { recordId } });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(InventoryQueries.prototype.capture).toHaveBeenLastCalledWith(identity, "inventory-scope",
        expect.objectContaining({ recordId }), ...(resource === "agents" ? ["delegated"] : []));
    }
  });

  it.each(["agent-inventory", "agents"])("reads supported encoded record IDs through %s", async resource => {
    for (const recordId of recordIds) {
      const response = await request("GET", `/${resource}?${new URLSearchParams({ recordId })}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(InventoryQueries.prototype.page).toHaveBeenLastCalledWith(selectionId, identity,
        expect.objectContaining({ expectedQuery: { recordId } }));
    }
  });

  it("resolves long valid detail references against the saved selection", async () => {
    const recordId = recordIds[1];
    expect(recordId.length).toBeGreaterThan(8192);
    const response = await request("GET", `/agent-inventory/${encodeURIComponent(recordId)}/detail?selectionId=${selectionId}`);
    expect(response).toMatchObject({ status: 404, body: { code: "inventory_record_not_found" } });
    expect(InventoryQueries.prototype.page).toHaveBeenCalledWith(selectionId, identity, { limit: 2, recordId });
  });

  it("still rejects overlong record filters before capture", async () => {
    const response = await request("POST", "/agent-inventory/selections", {
      query: { recordId: `graph_packages:${"x".repeat(10_000)}` },
    });
    expect(response.status).toBe(400);
    expect(InventoryQueries.prototype.capture).not.toHaveBeenCalled();
  });
});

describe("saved inventory availability and access", () => {
  it.each([
    { published: false, previously_published: false, preparing: false, state: "not_collected" },
    { published: false, previously_published: true, preparing: false, state: "unavailable" },
    { published: false, previously_published: true, preparing: true, state: "preparing" },
  ])("returns $state without creating a selection", async ({ state, ...root }) => {
    vi.mocked(database.query).mockResolvedValue({ command: "SELECT", rowCount: 1, oid: 0, fields: [],
      rows: [{ id: "inventory-scope", ...root }] });
    const response = await request("POST", "/agent-inventory/selections", { query: {} });
    expect(response).toMatchObject({ status: 200, body: { state, message: expect.any(String) } });
    expect(InventoryQueries.prototype.capture).not.toHaveBeenCalled();
  });

  it("requires sign-in for saved reads", async () => {
    signedIn = false;
    expect((await request("GET", `/agent-inventory?selectionId=${selectionId}`)).status).toBe(401);
    expect(InventoryQueries.prototype.page).not.toHaveBeenCalled();
  });

  it("requires CSRF protection when capturing a selection", async () => {
    expect((await request("POST", "/agent-inventory/selections", { query: {} }, false)).status).toBe(403);
    expect(InventoryQueries.prototype.capture).not.toHaveBeenCalled();
  });
});
