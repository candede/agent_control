import express from "express";
import session from "express-session";
import pg from "pg";
import { request as httpRequest, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { errorHandler } from "../errors.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { canonicalQuery, SelectionError, type SelectionIdentity } from "../services/dataSelections.js";
import { LargeTenantUsersReports, reportQuery, reportQueryFields, type ReportReadContext } from "../services/largeTenantUsersReports.js";
import type { ReportEndpoint, ReportQuery } from "../types/officialReportData.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import { reportQueryString } from "../../../frontend/src/api/reportData.js";
import { createOfficialReportDataRouter } from "./officialReportData.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{
    tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
    clientSecret: "synthetic-route-test-secret", domains: ["example.invalid"],
  }]);
  process.env.SESSION_SECRET = "synthetic-official-report-route-secret";
});
vi.mock("../services/telemetry.js", async original => ({
  ...await original<typeof import("../services/telemetry.js")>(), operationalLog: vi.fn(),
}));

const selectionId = "33333333-3333-4333-8333-333333333333";
const setId = "44444444-4444-4444-8444-444444444444";
const objectId = "55555555-5555-4555-8555-555555555555";
const identity: SelectionIdentity = { tenantId: config.tenants[0].tenantId!, principalId: "report-reader",
  authorizationHash: "viewer", sessionEpoch: "1" };
const database = new pg.Pool({ max: 4 });
const client = Object.assign(new pg.Client(), { release: vi.fn() });
const reports = new LargeTenantUsersReports(database, "synthetic-official-report-route-secret", 35);
let server: Server, saved: ReportReadContext;

function source(source: UserSourceMetadata["source"]): UserSourceMetadata {
  return { source, generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
    attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null,
    rowCount: null, state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null };
}
function context(endpoint: ReportEndpoint, input: ReportQuery = {}): ReportReadContext {
  const query = reportQuery(endpoint, input);
  return { identity, tokenMode: "delegated", endpoint, query, queryHash: canonicalQuery(query, reportQueryFields),
    evaluatedAt: new Date("2026-10-01T00:00:00Z"),
    selection: { id: selectionId, revision: "1", evaluatedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-01T00:10:00Z" },
    metadata: { directory: source("directory"), app_activity: source("app_activity") },
    report: { setId, activeSetId: setId, activeRevision: "1", historyRevision: "1", historyEpoch: "0",
      availability: "active", staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: 0,
      reportingPeriod: null, acceptedAt: "2026-10-01T00:00:00Z", expiresAt: null, lineages: [] } };
}
function rows() {
  return { raw: [], value: [], counts: { total: 0, filtered: 0 },
    page: { limit: 50, nextCursor: null, previousCursor: null } };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "synthetic-official-report-route-secret", resave: false, saveUninitialized: false }));
  app.use((request, _response, next) => {
    request.session.accountId = identity.principalId;
    request.session.tenantId = identity.tenantId;
    request.session.clientId = config.tenants[0].clientId;
    request.session.rolesValidatedAt = Date.now();
    request.session.csrfToken = "fixture-csrf";
    request.session.user = { tenantId: identity.tenantId, homeAccountId: identity.principalId,
      username: "reader@example.invalid", displayName: "Reader", roles: ["AgentControl.Admin"] };
    next();
  });
  app.use("/api", createOfficialReportDataRouter({ reports, identity: async () => ({ identity, tokenMode: "delegated" }),
    enqueueExport: async () => { throw new Error("Unexpected export dispatch"); } }));
  app.use(errorHandler);
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
});
beforeEach(() => {
  saved = context("official_agents");
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected database query"));
  vi.spyOn(client, "query").mockRejectedValue(new Error("Unexpected client query"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected provider request")));
  vi.spyOn(reports, "capture").mockImplementation(async (_identity, _tokenMode, endpoint, query) => {
    saved = context(endpoint, query);
    return saved.selection;
  });
  vi.spyOn(reports, "read").mockImplementation((_id, _identity, work) => work(client, saved));
  vi.spyOn(reports, "rowsInRead").mockImplementation(async () => rows());
  vi.spyOn(reports, "summaryInRead").mockRejectedValue(new Error("Unexpected report summary"));
  vi.spyOn(reports, "pageInRead").mockImplementation(async () => {
    throw new Error("Unexpected full report page");
  });
  vi.spyOn(reports, "exactInRead").mockImplementation(async () => ({
    value: { agentId: "agent", agentName: "Agent", creatorType: "", responses: 0, responseSource: "agents",
      activeUsers: 0, activeUsersBasis: "userAgents_distinct_identity", licensedUserOccurrences: 0,
      unlicensedUserOccurrences: 0, lastActivityDateUtc: null, reportResponses: 0, bridgeResponses: 0,
      relationshipCount: 0, responseComparison: "matching", identityStatus: "unresolved" },
    selection: saved.selection, reports: saved.report, sources: saved.metadata,
  }));
});
afterEach(() => {
  try {
    expect(database.connect).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await database.end();
});

function allowPage() {
  vi.mocked(reports.pageInRead).mockResolvedValue({
    ...rows(), selection: saved.selection, reports: saved.report, sources: saved.metadata,
    filters: saved.query, summary: { checkedUsers: null, licensedUsers: null, measuredActivityUsers: null,
      needsAttentionUsers: null, usingAgentsUsers: null, noAgentActivityUsers: null, unknownMetricsUsers: null,
      unresolvedIdentities: 0, activeWithoutPaidUsers: null, paidActiveReportUsers: null, unknownLicenseActiveReportUsers: 0,
      reportedResponses: null, bridgeResponses: null, userReportedResponses: null, distinctActiveReportUsers: null,
      licensedOccurrences: null, unlicensedOccurrences: null, responseReconciliation: "not_comparable", activeUsersAreNonAdditive: true },
    analytics: { basis: "filtered_rows", rowCount: 0, responses: null, zeroResponses: null, unknownResponses: null,
      review: null, agents: null, history: null, overview: null },
  });
  return vi.spyOn(reports, "page");
}

describe("report query HTTP contracts", () => {
  it.each(["official-usage/aggregate", "official-usage/users", "copilot-usage/users", "official-usage/agent-users"])(
    "round-trips a literal empty creator type through %s", async path => {
      allowPage();
      expect(await request("GET", `/${path}${reportQueryString({ creatorType: "" })}`)).toMatchObject({ status: 200 });
      expect(reports.capture).toHaveBeenCalledWith(identity, "delegated", expect.any(String),
        expect.objectContaining({ creatorType: "" }));
    },
  );
  it.each(["creatorType=&creatorType=Custom", "creatorType=%00", `creatorType=${"x".repeat(257)}`, "agentId=", "limit="])(
    "still rejects malformed scalars: %s", async query => {
      expect(await request("GET", `/official-usage/aggregate?${query}`)).toMatchObject({ status: 400 });
      expect(reports.capture).not.toHaveBeenCalled();
    },
  );
  it("retains literal creator-type values and their length boundary", async () => {
    allowPage();
    for (const creatorType of ["~null", "~string:", "x".repeat(256)]) {
      expect(await request("GET", `/official-usage/aggregate${reportQueryString({ creatorType })}`)).toMatchObject({ status: 200 });
      expect(reports.capture).toHaveBeenLastCalledWith(identity, "delegated", "official_agents",
        reportQuery("official_agents", { creatorType }));
    }
  });
  it("reuses an immutable empty creator-type filter", async () => {
    saved = context("official_agents", { creatorType: "" });
    allowPage();
    expect(await request("GET", `/official-usage/aggregate${reportQueryString({ selectionId, creatorType: "" })}`))
      .toMatchObject({ status: 200 });
    expect(await request("GET", `/official-usage/aggregate${reportQueryString({ selectionId, creatorType: "Custom" })}`))
      .toMatchObject({ status: 400, body: { code: "invalid_cursor" } });
    expect(reports.capture).not.toHaveBeenCalled();
  });
  it("keeps the compact history route ahead of parameterized history paths", async () => {
    const response = await request("GET", "/official-usage/history/options");
    expect(response).toMatchObject({ status: 200, body: { value: [], selection: { id: selectionId } } });
    expect(Object.keys(response.body).sort()).toEqual(["counts", "page", "reports", "selection", "value"]);
    expect(reports.capture).toHaveBeenCalledWith(identity, "delegated", "history", reportQuery("history"));
    expect(reports.pageInRead).not.toHaveBeenCalled();
    expect(reports.summaryInRead).not.toHaveBeenCalled();
  });
});

describe.each([
  [`/copilot-usage/users/${objectId}/agents`, "copilot_users"],
  ["/official-usage/agents/agent/users", "official_agents"],
  ["/official-usage/users/user%40example.invalid/agents", "official_users"],
] as const)("relationship parent selection: %s", (path, endpoint) => {
  beforeEach(() => {
    saved = context(endpoint);
    allowPage();
  });
  it("captures the requested historical set without applying child filters to the parent", async () => {
    expect(await request("GET", `${path}${reportQueryString({ setId, search: "Child", sort: "creatorType" })}`))
      .toMatchObject({ status: 200 });
    expect(reports.capture).toHaveBeenCalledExactlyOnceWith(identity, "delegated", endpoint, reportQuery(endpoint, { setId }));
    const options = endpoint === "copilot_users" ? vi.mocked(reports.pageInRead).mock.calls[0][2] : vi.mocked(reports.page).mock.calls[0][2];
    expect(options?.childQuery).toEqual(reportQuery("relationships", { search: "Child", sort: "creatorType" }));
  });
  it("accepts the pinned set independently of the parent's row filters", async () => {
    saved = context(endpoint, { search: "Parent" });
    expect(await request("GET", `${path}${reportQueryString({ selectionId, setId, search: "Child" })}`))
      .toMatchObject({ status: 200 });
    expect(reports.capture).not.toHaveBeenCalled();
  });
  it("recovers the pinned selection from a continuation without repeating setId", async () => {
    const childFilters = { creatorType: "", sort: "responses" as const, order: "desc" as const };
    expect(await request("GET", `${path}${reportQueryString({ setId, ...childFilters })}`)).toMatchObject({ status: 200 });
    const firstOptions = vi.mocked(reports.pageInRead).mock.calls[0][2];
    const cursor = reports.codec.encode({ identity, endpoint: `relationships:${firstOptions?.child}`,
      selectionId, revision: saved.selection.revision, queryHash: "a".repeat(64), direction: "next",
      boundary: { id: "first", key: "0", nullRank: 0 } });
    expect(await request("GET", `${path}${reportQueryString({ cursor, ...childFilters })}`)).toMatchObject({ status: 200 });
    expect(reports.capture).toHaveBeenCalledOnce();
    expect(vi.mocked(reports.pageInRead).mock.calls[1][2]).toEqual({ ...firstOptions, cursor });
    expect(reports.read).toHaveBeenCalledWith(selectionId, identity, expect.any(Function));
  });
  it("propagates an unavailable historical set without falling back to the active report", async () => {
    vi.mocked(reports.capture).mockRejectedValue(new SelectionError("selection_invalidated"));
    expect(await request("GET", `${path}${reportQueryString({ setId })}`))
      .toMatchObject({ status: 409, body: { code: "selection_invalidated" } });
    expect(reports.capture).toHaveBeenCalledExactlyOnceWith(identity, "delegated", endpoint, reportQuery(endpoint, { setId }));
    expect(reports.exactInRead).not.toHaveBeenCalled();
    expect(reports.pageInRead).not.toHaveBeenCalled();
  });
  it("rejects switching a pinned selection to another set", async () => {
    expect(await request("GET", `${path}${reportQueryString({ selectionId, setId: objectId })}`))
      .toMatchObject({ status: 400, body: { code: "invalid_cursor" } });
    expect(reports.exactInRead).not.toHaveBeenCalled();
    expect(reports.page).not.toHaveBeenCalled();
  });
  it.each(["setId=bad", "setId=one&setId=two", "search=a&search=b", "sort=acceptedAt", "company=Contoso"])(
    "rejects malformed parent/child intent before capturing: %s", async query => {
      expect(await request("GET", `${path}?${query}`)).toMatchObject({ status: 400 });
      expect(reports.capture).not.toHaveBeenCalled();
      expect(reports.exactInRead).not.toHaveBeenCalled();
    },
  );
});

describe("report confirmation HTTP input", () => {
  it.each([`/official-usage/sets/${setId}/preview`, `/official-usage/confirmations/${selectionId}`])(
    "rejects a missing body as a client error: %s", async path => {
      expect(await request("POST", path)).toMatchObject({ status: 400 });
    },
  );
  it.each([null, {}, []])("rejects malformed confirmation bodies: %j", async body => {
    for (const path of [`/official-usage/sets/${setId}/preview`, `/official-usage/confirmations/${selectionId}`]) {
      expect(await request("POST", path, body)).toMatchObject({ status: 400 });
    }
  });
  it("passes a valid preview operation through unchanged", async () => {
    const confirmation = { id: selectionId, setId, operation: "select" as const, activeRevision: "1",
      historyRevision: "1", historyEpoch: "0", hash: "a".repeat(64) };
    const preview = vi.spyOn(OfficialReportImports.prototype, "confirmPreview").mockResolvedValue(confirmation);
    expect(await request("POST", `/official-usage/sets/${setId}/preview`, { operation: "select" }))
      .toMatchObject({ status: 200, body: confirmation });
    expect(preview).toHaveBeenCalledExactlyOnceWith(identity, setId, "select");
    const confirm = vi.spyOn(OfficialReportImports.prototype, "confirm").mockResolvedValue({ activeSetId: setId, activeRevision: "2" });
    expect(await request("POST", `/official-usage/confirmations/${selectionId}`, confirmation)).toMatchObject({ status: 200 });
    expect(confirm).toHaveBeenCalledExactlyOnceWith(identity, confirmation);
  });
});

function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const json = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const message = httpRequest({ host: "127.0.0.1", port: address.port, method, path: `/api${path}`,
      headers: { "x-csrf-token": "fixture-csrf",
        ...(json ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) } : {}) },
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
    });
    message.once("error", reject);
    message.end(json);
  });
}
