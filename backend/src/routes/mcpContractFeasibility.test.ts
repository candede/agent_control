import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ConfidentialClientApplication, type INetworkModule, type AuthenticationResult } from "@azure/msal-node";
import pg from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { CursorCodec, canonicalQuery, type SelectionIdentity } from "../services/dataSelections.js";
import { reportQuery } from "../services/largeTenantUsersReports.js";
import { adoptionDataset } from "../services/adoptionGroups.js";
import { LargeTenantUsersReports, type ReportReadContext } from "../services/largeTenantUsersReports.js";
import { canonicalRecord } from "../services/inventoryRecordProjection.js";
import { officialReportLimits } from "../services/officialReportStream.js";
import { declaredRoutePolicies } from "./policy.js";
import { unifiedAgentInventoryQuery } from "./unifiedAgents.js";
import { unifiedAgentRecordId, parseUnifiedAgentRecordId, type UnifiedAgentRecord } from "../types/unifiedAgents.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const document = readFileSync(resolve(root, "docs/mcp-integration.md"), "utf8");
const currentMap = document.split("## Administrative audit origin v1")[0];
const routeRows = [...currentMap.matchAll(/^\| `(GET|POST|PUT|PATCH|DELETE) ([^`]+)` \|(.+)$/gm)];
const currentRoutes = routeRows.map(match => `${match[1]} ${match[2]}`);
const tenant = "11111111-1111-1111-1111-111111111111";
const apiClient = "22222222-2222-2222-2222-222222222222";
const native = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const guest = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const guestHome = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const guestTenant = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const secret = "mcp-v1-synthetic-cursor-secret-no-production";
const identity: SelectionIdentity = {
  tenantId: tenant, principalId: `${native}.${tenant}`, authorizationHash: "synthetic-role-hash", sessionEpoch: "1",
};
const selected = {
  identity, endpoint: "inventory", selectionId: "60000000-0000-4000-8000-000000000001",
  revision: "70000000-0000-4000-8000-000000000001", queryHash: canonicalQuery({ source: "all" }, ["source"]),
};
const fixtureId = (prefix: string, index: number) => `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
const fakePool = new pg.Pool({ max: 4 });
fakePool.query = () => { throw new Error("phase 01 must not query a database"); };
fakePool.connect = () => { throw new Error("phase 01 must not connect to a database"); };

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? entry.name === "test" ? [] : sourceFiles(path)
      : /\.[jt]sx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [path] : [];
  });
}

function frontendPathShapes() {
  const paths = new Set<string>();
  for (const file of sourceFiles(resolve(root, "frontend/src"))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      let text = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
      if (ts.isTemplateExpression(node)) {
        text = node.head.text;
        for (const span of node.templateSpans) {
          const querySuffix = ts.isConditionalExpression(span.expression)
            && span.expression.getText(source).includes("?")
            && [span.expression.whenTrue, span.expression.whenFalse].some(value =>
              ts.isStringLiteral(value) && value.text.startsWith("?") || ts.isTemplateExpression(value) && value.head.text.startsWith("?"));
          const queryFunction = ts.isCallExpression(span.expression)
            && ts.isIdentifier(span.expression.expression) && span.expression.expression.text === "reportQueryString";
          if (querySuffix || queryFunction) break;
          text += ":parameter" + span.literal.text;
        }
      }
      if (text?.startsWith("/api/") || text && /^(copilot-usage|official-usage|agent-inventory)\//.test(text)) {
        const path = (text.startsWith("/api/") ? text : `/api/${text}`).split("?")[0];
        if (path !== "/api/:parameter") paths.add(path);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...paths].sort();
}

function compatiblePath(shape: string, registered: string) {
  const left = shape.split("/"), right = registered.split("/");
  return left.length === right.length && left.every((part, index) => part.startsWith(":")
    || right[index].startsWith(":") || part === right[index]);
}

function frontendHttpOperations() {
  const operations: { file: string; method: string; path: string }[] = [];
  function pathShape(node: ts.Node): string | undefined {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "agentHuntingUrl") {
      return pathShape(node.arguments[0]);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.split("?")[0];
    if (!ts.isTemplateExpression(node)) return undefined;
    let text = node.head.text;
    for (const span of node.templateSpans) {
      if (text.includes("?") || ts.isCallExpression(span.expression)
        && ts.isIdentifier(span.expression.expression) && span.expression.expression.text === "reportQueryString"
        || ts.isConditionalExpression(span.expression)
        && [span.expression.whenTrue, span.expression.whenFalse].some(value =>
          ts.isStringLiteral(value) && value.text.startsWith("?")
          || ts.isTemplateExpression(value) && value.head.text.startsWith("?"))) break;
      text += ":parameter" + span.literal.text;
    }
    return text.split("?")[0];
  }
  function methods(node?: ts.Expression): string[] {
    if (!node) return ["GET"];
    if (ts.isStringLiteral(node)) return [node.text];
    if (ts.isConditionalExpression(node)) return [...methods(node.whenTrue), ...methods(node.whenFalse)];
    throw new Error(`Unclassified frontend HTTP method: ${node.getText()}`);
  }
  for (const file of sourceFiles(resolve(root, "frontend/src"))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments[0]) {
        const name = node.expression.text;
        if (["request", "post", "readReportPage", "readReportDetail", "readReportFacet"].includes(name)) {
          let path = pathShape(node.arguments[0]);
          if (path && /^(copilot-usage|official-usage|agent-inventory)\//.test(path)) path = `/api/${path}`;
          if (path?.startsWith("/api/") && path !== "/api/:parameter") {
            if (name === "readReportFacet") path += "/facets";
            const init = node.arguments[1];
            const method = init && ts.isObjectLiteralExpression(init) ? init.properties.find(property =>
              ts.isPropertyAssignment(property) && property.name.getText(source) === "method") : undefined;
            for (const value of name === "post" ? ["POST"] : methods(method && ts.isPropertyAssignment(method) ? method.initializer : undefined)) {
              operations.push({ file: file.slice(root.length), method: value, path });
            }
          }
        }
        if (node.expression.text === "fetch" && file.slice(root.length) !== "frontend/src/api/client.ts") {
          expect(file.slice(root.length)).toBe("frontend/src/App.tsx");
          expect(pathShape(node.arguments[0])).toBe("/api/auth/status");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return operations;
}

function syntheticSdkClient(input: { oid: string; uid: string; utid: string; clientInfo: boolean; idToken: boolean }) {
  const url = `https://login.microsoftonline.com/${tenant}`;
  const posts: URLSearchParams[] = [];
  const network: INetworkModule = {
    sendGetRequestAsync: async () => { throw new Error("unexpected discovery/network request"); },
    sendPostRequestAsync: async <T>(_url: string, options?: { body?: string }) => {
      posts.push(new URLSearchParams(options?.body));
      const now = Math.floor(Date.now() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const jwt = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
        aud: apiClient, iss: `${url}/v2.0`, tid: tenant, oid: input.oid, sub: "application-specific-subject",
        preferred_username: "alex@example.invalid", name: "Synthetic Alex", iat: now, exp: now + 3600,
      })}.synthetic-signature`;
      return {
        status: 200, headers: {}, body: {
          token_type: "Bearer", access_token: "synthetic-opaque-provider-token", expires_in: 3600,
          scope: "User.ReadBasic.All openid profile",
          ...(input.idToken ? { id_token: jwt } : {}),
          ...(input.clientInfo ? { client_info: encode({ uid: input.uid, utid: input.utid }) } : {}),
        } as T,
      };
    },
  };
  const client = new ConfidentialClientApplication({
    auth: {
      clientId: apiClient, clientSecret: "synthetic-client-secret-not-production", authority: url,
      cloudDiscoveryMetadata: JSON.stringify({ metadata: [{
        preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net",
        aliases: ["login.microsoftonline.com", "login.windows.net"],
      }] }),
      authorityMetadata: JSON.stringify({
        issuer: `${url}/v2.0`, authorization_endpoint: `${url}/oauth2/v2.0/authorize`,
        token_endpoint: `${url}/oauth2/v2.0/token`, end_session_endpoint: `${url}/oauth2/v2.0/logout`,
      }),
    },
    system: { networkClient: network, loggerOptions: { loggerCallback: () => {} } },
  });
  return { client, posts };
}

function agent(index: number, created?: string, modified?: string): UnifiedAgentRecord {
  return {
    id: `agent:${fixtureId("10000000", index)}`, displayName: "Shared name", presence: "graph_packages",
    environmentId: null, packages: [{
      id: `T_pkg_${String(index).padStart(3, "0")}`, displayName: "Shared name",
      ...(created ? { createdDateTime: created } : {}), ...(modified ? { lastModifiedDateTime: modified } : {}),
    }], powerPlatformResource: null,
    identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
    observations: { graphPackages: null, packageSnapshots: {}, powerPlatform: null },
  };
}

describe("phase 01 canonical contract feasibility (synthetic, no DB/provider/listener)", () => {
  it("maps current routes exactly once without retired compatibility endpoints", async () => {
    const { store } = createApp();
    try {
      const registered = [...declaredRoutePolicies.keys()].map(route => {
        const [method, path] = route.split(" ");
        return `${method} ${path.startsWith("/api/") || path === "/{*path}" ? path : `/api${path}`}`;
      });
      expect(new Set(currentRoutes).size).toBe(currentRoutes.length);
      expect(currentRoutes).toHaveLength(163);
      expect(currentRoutes).not.toContain("GET /security");
      expect(currentRoutes).not.toContain("POST /api/auth/consent");
      expect(currentRoutes).toEqual(expect.arrayContaining([
        "GET /api/copilot-usage/users/resolve",
        "GET /api/copilot-usage/users/:objectId/agent-relationships",
        "GET /api/copilot-usage/adoption/champions",
        "GET /api/agent-inventory/:recordId/about",
      ]));
      expect(currentRoutes.toSorted()).toEqual(registered.toSorted());
      expect(document).toContain("[strict verifier](../backend/src/db/schema.ts)");
      expect(document).not.toMatch(/`[a-f0-9]{64}`/);
      for (const row of routeRows) {
        const raw = `${row[1]} ${row[2]}`;
        const policy = declaredRoutePolicies.get(raw) ?? declaredRoutePolicies.get(raw.replace(" /api/", " /"));
        const policyText = row[3].split("|").at(-2)?.trim();
        expect(policy).toBeDefined();
        if (policy?.access === "public") expect(policyText).toBe("P");
        else if (policy?.roles?.includes("AgentControl.Viewer")) expect(policyText).toMatch(/^V(?:;|$)/);
        else if (policy?.roles?.includes("AgentControl.Admin")) expect(policyText).toMatch(/^A(?:;|$)/);
        else expect(policyText).toBe("S");
        if (policy?.access === "authenticated" && policy.capabilityId) expect(row[3]).toContain(policy.capabilityId);
      }
    } finally { await store.close(); }
  });

  it("covers all current frontend literal/template API path shapes and report consumers", () => {
    const registered = currentRoutes.map(route => route.split(" ")[1]);
    const paths = frontendPathShapes();
    expect(paths.length).toBeGreaterThan(80);
    expect(paths.filter(path => !registered.some(route => compatiblePath(path, route)))).toEqual([]);
    expect(paths).toContain("/api/copilot-usage/adoption");
    expect(paths).toContain("/api/official-usage/history/options");
    expect(paths).toContain("/api/audit/events/export.csv");
  });

  it("binds frontend HTTP methods to actual canonical registrations, not just matching URLs", () => {
    const operations = frontendHttpOperations();
    expect(operations.length).toBeGreaterThan(100);
    expect(operations.filter(operation => !currentRoutes.some(route => {
      const [method, path] = route.split(" ");
      return method === operation.method && compatiblePath(operation.path, path);
    }))).toEqual([]);
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "POST", path: "/api/official-usage/staging" }),
      expect.objectContaining({ method: "DELETE", path: "/api/data-exports/:parameter" }),
      expect.objectContaining({ method: "POST", path: "/api/audit-search/jobs" }),
      expect.objectContaining({ method: "POST", path: "/api/hunting/jobs" }),
    ]));
  });

  it("keeps every current workbench page in the sole regression/manual map with no MCP transport", () => {
    const featureMap = document.split("## Web regression and manual handoff")[1]?.split("## Synthetic workflow corpus and test isolation")[0];
    expect(featureMap).toBeDefined();
    for (const page of ["agents", "users", "sync", "audit", "permissions"]) expect(featureMap).toContain(`\`${page}\``);
    for (const file of sourceFiles(resolve(root, "frontend/src"))) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/from\s+["'][^"']*(?:fastmcp|modelcontextprotocol)|https?:\/\/[^"'\s]*(?:\/mcp|graph\.microsoft\.com)/i);
    }
  });

  it.each([
    { oid: native, uid: native, utid: tenant },
    { oid: guest, uid: guestHome, utid: guestTenant },
  ])("real MSAL maps code and OBO client_info to the same private home key: $oid", async fixture => {
    const { client, posts } = syntheticSdkClient({ ...fixture, clientInfo: true, idToken: true });
    const result: AuthenticationResult = await client.acquireTokenByCode({
      code: "synthetic-one-use-code", redirectUri: "https://example.invalid/api/auth/callback", scopes: ["openid", "profile"],
    });
    const exchanged = await client.acquireTokenOnBehalfOf({
      oboAssertion: "synthetic-api-audience-assertion", scopes: ["https://graph.microsoft.com/User.ReadBasic.All"],
    });
    expect(result.account?.homeAccountId).toBe(`${fixture.uid}.${fixture.utid}`);
    expect(exchanged?.account?.homeAccountId).toBe(result.account?.homeAccountId);
    expect(exchanged?.account?.localAccountId).toBe(fixture.oid);
    expect(exchanged?.account?.tenantId).toBe(tenant);
    expect(posts).toHaveLength(2);
    expect(posts[1].get("client_info")).toBe("1");
    expect(posts[1].get("requested_token_use")).toBe("on_behalf_of");
    expect(posts[1].get("assertion")).toBe("synthetic-api-audience-assertion");
    if (fixture.oid === guest) expect(exchanged?.account?.homeAccountId).not.toBe(`${guest}.${tenant}`);
  });

  it("exposes sub-only fallback as non-equivalent, not an admitted home identity", async () => {
    const { client } = syntheticSdkClient({ oid: guest, uid: guestHome, utid: guestTenant, clientInfo: false, idToken: true });
    const result = await client.acquireTokenOnBehalfOf({
      oboAssertion: "synthetic-api-audience-assertion", scopes: ["https://graph.microsoft.com/User.ReadBasic.All"],
    });
    expect(result?.account?.homeAccountId).toBe("application-specific-subject");
    expect(result?.account?.homeAccountId).not.toBe(`${guestHome}.${guestTenant}`);
    expect(document).toContain("Reject absent account/client info, sub-only fallback");
  });

  it("does not pretend every OBO response supplies an SDK account", async () => {
    const { client } = syntheticSdkClient({ oid: guest, uid: guestHome, utid: guestTenant, clientInfo: true, idToken: false });
    const result = await client.acquireTokenOnBehalfOf({
      oboAssertion: "synthetic-api-audience-assertion", scopes: ["https://graph.microsoft.com/User.ReadBasic.All"],
    });
    expect(result?.account).toBeNull();
  });

  it("case A corpus requires a second page and does not resolve duplicated names as identity", () => {
    const agents = Array.from({ length: 103 }, (_, index) => agent(index + 1));
    const pages = [agents.slice(0, 100), agents.slice(100)];
    expect(pages.map(page => page.length)).toEqual([100, 3]);
    expect(new Set(pages.flat().map(item => item.id)).size).toBe(103);
    expect(new Set(agents.map(item => item.displayName)).size).toBe(1);
    const exact = unifiedAgentRecordId({ source: "graph_packages", packageId: "T_Package/Case%Sensitive" });
    expect(parseUnifiedAgentRecordId(exact)).toEqual({ source: "graph_packages", packageId: "T_Package/Case%Sensitive" });
    expect(() => parseUnifiedAgentRecordId("agent:Shared name")).toThrow();
    expect(Buffer.byteLength("Résumé 世界 ".repeat(7000))).toBeGreaterThan(100000);
  });

  it.each(["tenantId", "principalId", "authorizationHash", "sessionEpoch"] as const)(
    "case A continuation rejects a changed %s rather than changing private authority", field => {
      const codec = new CursorCodec(secret);
      const cursor = codec.encode({ ...selected, direction: "next", boundary: { key: "shared name", id: "100", nullRank: 0 } });
      expect(codec.decode(cursor, selected).selectionId).toBe(selected.selectionId);
      expect(() => codec.decode(cursor, {
        ...selected, identity: { ...identity, [field]: "different-synthetic-authority" },
      })).toThrow(expect.objectContaining({ code: "invalid_cursor", status: 400 }));
    },
  );

  it("case A continuation pins selection/revision/filter and rejects tampering", () => {
    const codec = new CursorCodec(secret);
    const cursor = codec.encode({ ...selected, direction: "next", boundary: { key: "shared name", id: "100", nullRank: 0 } });
    for (const field of ["selectionId", "revision", "queryHash"] as const) {
      expect(() => codec.decode(cursor, { ...selected, [field]: "changed" })).toThrow();
    }
    expect(() => codec.decode(`${cursor}tampered`, selected)).toThrow();
  });

  it("case B pins actual SQL ranking and distinguishes group relationships from champions-only", () => {
    const reports = new LargeTenantUsersReports(fakePool, secret, 7);
    const context = {
      identity, query: reportQuery("adoption"), endpoint: "adoption", queryHash: "synthetic",
      report: { setId: null, lineages: [] },
      metadata: { directory: { generationId: null }, app_activity: { generationId: null } },
      selection: { id: selected.selectionId, revision: selected.revision }, evaluatedAt: new Date("2026-01-31T00:00:00Z"),
    } as ReportReadContext;
    const dataset = adoptionDataset(reports, context);
    expect(dataset.relations).toContain("user_agents AS");
    expect(dataset.relations).not.toContain("creators");
    expect(dataset.relations).not.toContain("current_agents");
    expect(dataset.relations).toContain("WHERE r.kind='userAgents' AND r.responses>0");
    expect(dataset.relations).toContain('responses DESC NULLS LAST,agents DESC,lower(name) COLLATE "C",identity');
    expect(dataset.relations).toContain("rank<=3 AND (coalesce(responses,0)>0 OR agents>0)");
    expect(document).toContain("p1=(3,10,2),p2=(2,50,2),p3=(2,20,7)");
    expect(document).toContain("Jan->Mar comparable50%");
    expect(document).toContain("Jan->overlap/Jan->Apr/undated not growth");
  });

  it("keeps report defaults, exact identities and meaningful-filter rejection in the current API parser", () => {
    expect(reportQuery("official_agents")).toEqual({
      lowResponseThreshold: 5, inactiveDays: 30, activityWindowDays: 30, sort: "responses", order: "desc",
    });
    expect(reportQuery("history").sort).toBe("reportingPeriod");
    expect(reportQuery("copilot_users", { username: "Alex@Example.invalid" }).username).toBe("Alex@Example.invalid");
    expect(() => reportQuery("history", { username: "alex@example.invalid" })).toThrow();
    expect(() => reportQuery("copilot_users", { startDate: "2026-02-30" })).toThrow();
    expect(() => reportQuery("official_agents", { company: "Example Company" })).toThrow();
  });

  it("freezes the actual streaming import and inventory parser bounds, not old draft limits", () => {
    expect(officialReportLimits.fileBytes).toBe(256 * 1024 * 1024);
    expect(officialReportLimits.rows).toEqual({ users: 100000, agents: 200000, userAgents: 1000000 });
    expect(unifiedAgentInventoryQuery({})).toMatchObject({
      inventoryScope: "all", source: "all", sortBy: "displayName", sortDirection: "asc", limit: 50,
    });
    expect(() => unifiedAgentInventoryQuery({ limit: "101" })).toThrow();
    expect(() => unifiedAgentInventoryQuery({ createdWithinDays: "0" })).toThrow();
    expect(() => unifiedAgentInventoryQuery({ search: ["a", "b"] })).toThrow();
  });

  it("case C projects only true source creation, preserving the inclusive frozen SQL cutoff", () => {
    const cutoff = Date.parse("2026-01-01T00:00:00.000Z");
    const inputs = [
      agent(1, "2026-01-01T00:00:00.000Z"), agent(2, "2025-12-31T23:59:59.999Z", "2026-01-31T00:00:00Z"),
      agent(3, undefined, "2026-01-31T00:00:00Z"),
      ...Array.from({ length: 100 }, (_, index) => agent(index + 4, "2026-01-15T00:00:00Z")),
    ];
    const records = inputs.map(record => canonicalRecord(record.id.slice(6), record));
    const eligible = records.filter(record => record.facts.some(fact => fact.kind === "created" && fact.number_value! >= cutoff));
    expect(eligible).toHaveLength(101);
    expect([eligible.slice(0, 100).length, eligible.slice(100).length]).toEqual([100, 1]);
    expect(records[0].facts.filter(fact => fact.kind === "created")).toHaveLength(1);
    expect(records[2].facts.filter(fact => fact.kind === "created")).toEqual([]);
    const queries = new InventoryQueries(fakePool, secret);
    const values: unknown[] = [];
    const predicate = queries["filter"]({ createdWithinDays: 30 }, values);
    expect(predicate).toContain("x.kind='created'");
    expect(predicate).toContain("x.number_value>=extract(epoch FROM $9::timestamptz)*1000-");
    expect(predicate).not.toContain("x.number_value<=");
    expect(values).toEqual([30]);
  });

  it("case C uses true native creation and verified Studio bot/environment identity, not package guessing", () => {
    const resource: PowerPlatformResource = {
      tenantId: tenant, nativeId: "studio-agent-001", type: "microsoft.copilotstudio/agents",
      location: null, displayName: "Shared name", environmentId: "40000000-0000-4000-8000-000000000001",
      createdAt: "2026-01-01T00:00:00.000Z", createdBy: native, lastPublishedAt: "2026-01-31T00:00:00Z",
      sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown", agentKind: "copilot_studio_agent",
      lifecycle: "unknown", identityConfidence: "partial", unknownFieldCount: 0, provenance: {}, details: {},
      identifiers: [
        { kind: "cds_bot_id", value: "50000000-0000-4000-8000-000000000001" },
        { kind: "environment_id", value: "40000000-0000-4000-8000-000000000001" },
      ],
    };
    const record = { ...agent(1), packages: [], powerPlatformResource: resource, presence: "power_platform" as const };
    const projected = canonicalRecord(record.id.slice(6), record);
    expect(projected.facts.find(fact => fact.kind === "created")?.number_value)
      .toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(projected.facts.find(fact => fact.kind === "control:quarantine")?.payload).toMatchObject({
      botId: "50000000-0000-4000-8000-000000000001", environmentId: resource.environmentId,
    });
    const unknown = canonicalRecord(record.id.slice(6), {
      ...record, powerPlatformResource: { ...resource, createdAt: null, identifiers: [] },
    });
    expect(unknown.facts.filter(fact => fact.kind === "created" || fact.kind === "control:quarantine")).toEqual([]);
  });

  it("preserves implemented MCP origin trust and excludes credential-bearing audit fields", () => {
    expect(document).toContain("Context.client_id");
    expect(document).toContain("remains reported meta");
    expect(document).toContain("The API still assigns **reported**");
    expect(document).toContain("124 named tools");
    expect(document).toContain("request-local invocation owner");
    expect(document).toContain("POST/PATCH/DELETE submissions are never automatically replayed");
    expect(document).toContain("Do not retain protocol session IDs");
    expect(document).toContain("first **accepted execution submission**");
    expect(document).toContain("Same idempotency key returns original origin");
    expect(document).toContain("no automatic double dispatch");
    const tools = routeRows.map(row => row[3].split("|").at(-3)?.trim()).filter(tool => tool !== "—" && tool !== "HTTP only");
    expect(new Set(tools).size).toBe(tools.length);
  });
});
