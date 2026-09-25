import express from "express";
import session from "express-session";
import { request as httpRequest, type Server } from "node:http";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { errorHandler } from "../errors.js";
import { OfficialUsageOverviewService } from "../services/officialUsageOverview.js";
import { createOfficialUsageRouter } from "./officialUsage.js";
import { declaredRoutePolicies } from "./policy.js";

vi.hoisted(() => {
  process.env.TENANT_ID = "11111111-1111-1111-1111-111111111111";
  process.env.CLIENT_ID = "22222222-2222-4222-8222-222222222222";
  process.env.SESSION_SECRET = "official-usage-overview-route-test-secret";
});

vi.mock("../services/telemetry.js", async original => ({
  ...await original<typeof import("../services/telemetry.js")>(),
  operationalLog: vi.fn(),
}));

const client = { query: vi.fn(), release: vi.fn() };
const database = { connect: vi.fn(), query: vi.fn() };
const providerRead = vi.fn();
const overviewRead = vi.spyOn(OfficialUsageOverviewService.prototype, "getOverview");
let server: Server;

beforeAll(async () => {
  const app = express();
  app.use(session({ secret: "official-usage-overview-route-test-secret", resave: false, saveUninitialized: false }));
  app.use((request, _response, next) => {
    const role = request.get("x-test-role");
    if (role) {
      const tenantId = request.get("x-test-tenant") ?? config.tenantId!;
      request.session.accountId = "overview-reader";
      request.session.tenantId = tenantId;
      request.session.rolesValidatedAt = Date.now();
      request.session.user = {
        tenantId, homeAccountId: "overview-reader", username: "reader@example.invalid", displayName: "Reader",
        roles: role === "viewer" ? ["AgentControl.Viewer"] : role === "admin" ? ["AgentControl.Admin"] : [],
      };
    }
    next();
  });
  app.use("/api", createOfficialUsageRouter(database as unknown as pg.Pool));
  app.use(errorHandler);
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
});

beforeEach(() => {
  overviewRead.mockClear();
  database.query.mockReset().mockRejectedValue(new Error("No direct inventory, snapshot or provider reads"));
  database.connect.mockReset().mockResolvedValue(client);
  client.query.mockReset().mockImplementation(async (sql: string) => {
    if (["BEGIN", "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT", "ROLLBACK"].includes(sql)) {
      return { rows: [] };
    }
    expect(sql).toMatch(/^WITH retained_sets/);
    return { rows: [{
      revision: "1", retained_sets: 0, reported_agents: 0, used_agents: 0, active_agents: 0, undated_agents: 0,
      earliest_activity: null, latest_activity: null, agent_count: 0, agents: [],
    }] };
  });
  client.release.mockClear();
  providerRead.mockReset().mockRejectedValue(new Error("Overview must not contact providers"));
  vi.stubGlobal("fetch", providerRead);
});

afterEach(() => {
  try {
    expect(database.query).not.toHaveBeenCalled();
    expect(providerRead).not.toHaveBeenCalled();
    for (const [sql] of client.query.mock.calls) expect(sql).not.toMatch(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\b/);
  } finally { vi.unstubAllGlobals(); }
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe("official usage overview route", () => {
  it("declares an authenticated Viewer read with no write endpoint", () => {
    expect(declaredRoutePolicies.get("GET /official-usage/overview")).toEqual({
      access: "authenticated", dataClass: "official_usage_overview", roles: ["AgentControl.Viewer"],
    });
    expect(declaredRoutePolicies.has("POST /official-usage/overview")).toBe(false);
  });

  it("allows Viewer and inherited Admin and rejects unauthenticated, unassigned and foreign-tenant sessions", async () => {
    expect(await get("", null)).toMatchObject({ status: 401, body: { code: "unauthorized" } });
    expect(await get("", "unassigned")).toMatchObject({ status: 403, body: { code: "missing_internal_role" } });
    expect(await get("", "viewer", "99999999-9999-4999-8999-999999999999"))
      .toMatchObject({ status: 401, body: { code: "unauthorized" } });
    expect(database.connect).not.toHaveBeenCalled();
    expect((await get("", "viewer")).status).toBe(200);
    expect((await get("", "admin")).status).toBe(200);
    expect(database.connect).toHaveBeenCalledTimes(2);
  });

  it("returns zero imported evidence with bounded defaults, not snapshot response totals", async () => {
    const response = await get();
    expect(response).toMatchObject({
      status: 200, body: {
        revision: 1,
        summary: {
          retainedSets: 0, reportedAgents: 0, usedAgents: 0, activeAgents30Days: 0, undatedAgents: 0,
          earliestActivityDateUtc: null, latestActivityDateUtc: null,
          asOf: expect.any(String), activeSinceDateUtc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        },
        agents: { value: [], count: 0, limit: 25, offset: 0 },
        filters: { search: null, startDate: null, endDate: null, sortBy: "lastActivity", sortDirection: "desc" },
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/totalResponses|responsesSentToUsers|username/);
    expect(client.query.mock.calls[2]?.[1]?.[0]).toBe(config.tenantId);
    expect(overviewRead).toHaveBeenCalledWith(config.tenantId, expect.objectContaining({ scope: undefined }));
  });

  it.each(["history", "selected"])("passes the explicit %s scope to the tenant-scoped overview", async scope => {
    expect(await get(`?scope=${scope}`)).toMatchObject({ status: 200 });
    expect(overviewRead).toHaveBeenCalledWith(config.tenantId, expect.objectContaining({ scope }));
  });

  it("passes supported literal filters and bounded paging to the tenant-scoped read", async () => {
    expect(await get("?search=Name%25&startDate=2024-02-29&endDate=2024-03-01&sortBy=agentName&sortDirection=asc&limit=100&offset=100000"))
      .toMatchObject({
        status: 200, body: {
          agents: { limit: 100, offset: 100_000 },
          filters: { search: "Name%", startDate: "2024-02-29", endDate: "2024-03-01", sortBy: "agentName", sortDirection: "asc" },
        },
      });
    expect(overviewRead).toHaveBeenCalledWith(config.tenantId, {
      scope: undefined, search: "Name%", startDate: "2024-02-29", endDate: "2024-03-01",
      sortBy: "agentName", sortDirection: "asc", limit: 100, offset: 100_000,
    });
  });

  it.each([
    "?setId=11111111-1111-4111-8111-111111111111", "?tenantId=other", "?creatorType=Custom",
    "?scope=", "?scope=all", "?scope=Selected", "?scope=history&scope=selected", "?scope[value]=selected",
    "?search=one&search=two", "?limit=25&limit=50", "?search[name]=test",
    `?search=${"x".repeat(257)}`, "?search=%00",
    "?startDate=", "?endDate=", "?startDate=2026-02-29", "?endDate=2026-04-31",
    "?startDate=2026-7-01", "?startDate=2026-07-01T00%3A00%3A00Z", "?startDate=2026-07-16&endDate=2026-07-15",
    "?sortBy=responses", "?sortDirection=DESC", "?sortBy=", "?sortDirection=",
    "?limit=0", "?limit=101", "?offset=-1", "?offset=100001", "?limit=1.5", "?limit=", "?offset=1e2",
  ])("rejects unsupported or malformed query before database access: %s", async query => {
    expect(await get(query)).toMatchObject({ status: 400, body: { code: "invalid_usage_query" } });
    expect(database.connect).not.toHaveBeenCalled();
  });
});

function get(query = "", role: string | null = "viewer", tenantId?: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1", port: (server.address() as { port: number }).port,
      path: `/api/official-usage/overview${query}`,
      headers: { ...(role ? { "x-test-role": role } : {}), ...(tenantId ? { "x-test-tenant": tenantId } : {}) },
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) as Record<string, unknown> }));
    });
    request.on("error", reject);
    request.end();
  });
}
