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
import { reportBase } from "../services/officialReportFields.js";
import { streamOfficialReport } from "../services/officialReportStream.js";
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
    selection: { id: selectionId, revision: "1", evaluatedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-01T00:10:00Z",
      validatedAt: "2026-10-01T00:00:00Z", publicationRevisions: { graph_packages: "1".repeat(64), power_platform: "2".repeat(64), users: "3".repeat(64) } },
    metadata: { directory: source("directory"), app_activity: source("app_activity") },
    report: { setId, activeSetId: setId, activeRevision: "1", historyRevision: "1", historyEpoch: "0",
      availability: "active", staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: 0,
      reportingPeriod: null, acceptedAt: "2026-10-01T00:00:00Z", expiresAt: null, lineages: [] } };
}
function rows() {
  return { raw: [], value: [], counts: { total: 0, filtered: 0 },
    summaryRow: undefined, analyticsRow: undefined,
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
    return { ...saved.selection, endpoint: saved.endpoint, queryHash: saved.queryHash,
      evaluatedAt: saved.evaluatedAt, expiresAt: new Date(saved.selection.expiresAt) };
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
  it.each(["official-usage/overview", "official-usage/aggregate", "official-usage/users", "official-usage/agent-users", "copilot-usage/users"])(
    "rejects PostgreSQL's unsupported year zero before capturing %s", async path => {
      for (const field of ["startDate", "endDate"]) {
        expect(await request("GET", `/${path}?${field}=0000-01-01`))
          .toMatchObject({ status: 400, body: { code: "invalid_cursor" } });
      }
      expect(reports.capture).not.toHaveBeenCalled();
      expect(reports.pageInRead).not.toHaveBeenCalled();
    },
  );

  it.each(["", "/service-plans", "/agents"])("canonicalizes Graph directory GUIDs for exact Users%s reads", async child => {
    const objectId = "AAAAAAAA-AAAA-7AAA-1AAA-AAAAAAAAAAAA";
    saved = context("copilot_users");
    allowPage();
    expect(await request("GET", `/copilot-usage/users/${objectId}${child}${reportQueryString({ selectionId })}`))
      .toMatchObject({ status: 200 });
    expect(reports.exactInRead).toHaveBeenCalledWith(client, saved, objectId.toLowerCase());
    if (child) expect(reports.pageInRead).toHaveBeenCalledWith(client, saved, expect.objectContaining({
      endpoint: child === "/agents" ? "relationships" : "plans", child: objectId.toLowerCase(),
    }));
  });

  it("preserves opaque reported-user GUID spelling instead of treating it as a directory ID", async () => {
    const username = "AAAAAAAA-AAAA-7AAA-1AAA-AAAAAAAAAAAA";
    saved = context("official_users");
    expect(await request("GET", `/official-usage/users/${username}${reportQueryString({ selectionId })}`))
      .toMatchObject({ status: 200 });
    expect(reports.exactInRead).toHaveBeenCalledExactlyOnceWith(client, saved, username);
  });

  it.each([
    "/official-usage/agents/Agent%C2%85", "/official-usage/agents/Agent%09/users",
    "/official-usage/users/User%C2%85", "/official-usage/users/User%09/agents",
  ])("rejects malformed exact path identities before capturing a selection: %s", async path => {
    expect(await request("GET", path)).toMatchObject({ status: 400, body: { code: "invalid_usage_query" } });
    expect(reports.capture).not.toHaveBeenCalled();
    expect(reports.exactInRead).not.toHaveBeenCalled();
  });

  it("canonicalizes a historical set UUID before checking cohort membership and reading observations", async () => {
    const historicalSetId = "ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF";
    saved = context("history");
    allowPage();
    expect(await request("GET", `/official-usage/history/${historicalSetId}/observations${reportQueryString({ selectionId })}`))
      .toMatchObject({ status: 200 });
    expect(reports.exactInRead).toHaveBeenCalledExactlyOnceWith(client, saved, historicalSetId.toLowerCase());
    expect(reports.pageInRead).toHaveBeenCalledExactlyOnceWith(client, saved, {
      limit: 50, endpoint: "observations", child: historicalSetId.toLowerCase(),
    });
  });

  it.each([
    ["official-usage/aggregate", "official_agents"],
    ["official-usage/users", "official_users"],
    ["copilot-usage/users", "copilot_users"],
    ["official-usage/history", "history"],
    ["official-usage/overview", "overview"],
  ] as const)("retains an immutable %s selection when the report-set UUID changes casing", async (path, endpoint) => {
    const historicalSetId = "abcdefab-1234-4567-89ab-abcdefabcdef";
    saved = context(endpoint, { setId: historicalSetId });
    allowPage();
    expect(await request("GET", `/${path}${reportQueryString({ selectionId, setId: historicalSetId.toUpperCase() })}`))
      .toMatchObject({ status: 200 });
    expect(reports.capture).not.toHaveBeenCalled();
    expect(await request("GET", `/${path}${reportQueryString({ selectionId, setId })}`))
      .toMatchObject({ status: 400, body: { code: "invalid_cursor" } });
    expect(reports.pageInRead).toHaveBeenCalledOnce();
  });

  it.each(["official-usage/aggregate", "official-usage/users", "copilot-usage/users", "official-usage/agent-users"])(
    "round-trips a literal empty creator type through %s", async path => {
      allowPage();
      expect(await request("GET", `/${path}${reportQueryString({ creatorType: "" })}`)).toMatchObject({ status: 200 });
      expect(reports.capture).toHaveBeenCalledWith(identity, "delegated", expect.any(String),
        expect.objectContaining({ creatorType: "" }));
    },
  );
  it.each(["creatorType=&creatorType=Custom", "creatorType=%00", "creatorType=Custom%0BAgent", "creatorType=Custom%C2%85Agent",
    `creatorType=${"x".repeat(257)}`, "agentId=", "agentId=Agent%09ID", "limit="])(
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
  it.each(["Custom\tAgent", "Custom\nAgent", "Custom\r\nAgent"])(
    "round-trips imported creator-type whitespace through capture and selected rereads: %j", async creatorType => {
      allowPage();
      for (const [path, endpoint] of [
        ["official-usage/aggregate", "official_agents"],
        ["official-usage/users", "official_users"],
        ["copilot-usage/users", "copilot_users"],
        ["official-usage/agent-users", "relationships"],
      ] as const) {
        expect(await request("GET", `/${path}${reportQueryString({ creatorType })}`))
          .toMatchObject({ status: 200 });
        expect(reports.capture).toHaveBeenLastCalledWith(identity, "delegated", endpoint,
          expect.objectContaining({ creatorType }));
        expect(await request("GET", `/${path}${reportQueryString({ selectionId, creatorType })}`))
          .toMatchObject({ status: 200 });
        expect(saved.query.creatorType).toBe(creatorType);
      }
    },
  );
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

describe("report multipart metadata validation without persistence", () => {
  function upload(fields: Array<[string, string]>) {
    const cancelled = vi.fn(async () => {});
    vi.spyOn(OfficialReportImports.prototype, "open").mockImplementation(async () => {
      const controller = new AbortController();
      return {
        id: selectionId, signal: controller.signal, cancel: cancelled,
        receive: async input => {
          const report = await streamOfficialReport(input, undefined, controller.signal, { batch: async () => {} });
          return { kind: report.kind, rows: report.rowCount, wireBytes: report.wireBytes };
        },
        finish: async metadata => {
          reportBase("users", metadata, []);
          throw new Error("Unexpected successful import");
        },
      };
    });
    const boundary = "official-report-fixture";
    const value = [
      ...fields.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="users.csv"\r\nContent-Type: text/csv\r\n\r\nUsername,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\r\n`,
      `--${boundary}--\r\n`,
    ].join("");
    return { cancelled, response: request("POST", `/official-usage/staging?bundleId=${setId}`, undefined,
      { value, type: `multipart/form-data; boundary=${boundary}` }) };
  }

  it.each(([
    [["downloadedAt", ""]], [["sourceAsOf", ""], ["sourceAsOfProvenance", ""]],
    [["sourceAsOf", ""]], [["sourceAsOfProvenance", "operator_asserted"]],
    [["downloadedAt", "2026-02-30T12:00:00Z"]], [["downloadedAt", "2026-07-08T12:00:00"]],
    [["reportingStart", "2026-06-08"], ["reportingEnd", "2026-07-06"], ["periodProvenance", "operator_asserted"]],
  ] satisfies Array<Array<[string, string]>>).map(fields => ({ fields })))("returns actionable 400 errors rather than dropping assertions or reporting 500: %j", async ({ fields }) => {
    const { response, cancelled } = upload(fields);
    expect(await response).toMatchObject({ status: 400, body: {
      code: fields.some(([key]) => key === "reportingStart") ? "invalid_reporting_period" : "invalid_metadata",
    } });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

describe("report multipart parser error contracts without persistence", () => {
  const header = "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\n";
  it.each([
    ["Username,Unknown\n", "schema_drift"],
    [header.replace("Display name", "username"), "duplicate_header"],
    [`${header}user,"unterminated`, "invalid_csv"],
    [`${header}first,First,9007199254740991,0,\nsecond,Second,1,0,\n`, "numeric_overflow"],
    [`${header}user,Name,1,-1,\n`, "invalid_number"],
    [`${header}user,Name,1,1,2026-02-30\n`, "invalid_date"],
    [`${header}user,Name,1,1,\0\n`, "invalid_content"],
    [`${header}user,${" ".repeat(4097)},1,1,\n`, "field_limit_exceeded"],
  ])("returns the actionable parser code through real multipart handling (case %#)", async (csv, code) => {
    const cancelled = vi.fn(async () => {});
    vi.spyOn(OfficialReportImports.prototype, "open").mockImplementation(async (_identity, _intent, parent) => {
      const signal = parent ?? new AbortController().signal;
      return {
        id: selectionId, signal, cancel: cancelled,
        receive: async input => {
          const report = await streamOfficialReport(input, undefined, signal, { batch: async () => {} });
          return { kind: report.kind, rows: report.rowCount, wireBytes: report.wireBytes };
        },
        finish: async () => { throw new Error("Unexpected parser acceptance."); },
      };
    });
    const boundary = "official-parser-fixture";
    const value = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="users.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
    expect(await request("POST", `/official-usage/staging?bundleId=${setId}`, undefined,
      { value, type: `multipart/form-data; boundary=${boundary}` })).toMatchObject({ status: 400, body: { code } });
    expect(cancelled).toHaveBeenCalled();
  });
});

function request(method: string, path: string, body?: unknown, raw?: { value: string; type: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const content = raw?.value ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const message = httpRequest({ host: "127.0.0.1", port: address.port, method, path: `/api${path}`,
      headers: { "x-csrf-token": "fixture-csrf",
        ...(content ? { "Content-Type": raw?.type ?? "application/json", "Content-Length": Buffer.byteLength(content) } : {}) },
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
