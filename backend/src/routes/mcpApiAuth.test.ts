import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import session from "express-session";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { config } from "../config.js";
import { DataGenerations } from "../db/dataGenerations.js";
import { activateAccountSession, clearAccountSessionMutationsForTest, revokeAccountSessionMutations } from "../db/sessions.js";
import { getMsalClient, replaceMsalClientForTest } from "../auth/msal.js";
import { currentAuthority, withAuthority } from "../auth/authorityContext.js";
import { apiToken, account, browserAuthenticationResult, browserFixtureCookie, browserSession, guest, guestHome, guestTenant, jwk, native, sdkResponse, tenant } from "../auth/authFoundationTestSupport.js";
import { capabilities } from "../services/capabilities.js";
import { DirectoryPrincipalsClient } from "../services/directoryPrincipals.js";
import { declaredRoutePolicies } from "./policy.js";
import { acquireAuthorizedToken, acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import type { DelegatedCredentialSource } from "../types/requestPrincipal.js";
import { readFileSync } from "node:fs";
import { clearAdmissionForTest } from "../middleware/admission.js";
import { loadOperationalState } from "../services/operationalState.js";
import { bulkJobs, drainBulkJobs } from "../services/bulkJobs.js";
import { AppError } from "../errors.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{ tenantId: "11111111-1111-1111-1111-111111111111",
    clientId: "22222222-2222-2222-2222-222222222222", clientSecret: "synthetic-only",
    domains: ["example.invalid"], integration: { clientId: "33333333-3333-3333-3333-333333333333",
      audience: "22222222-2222-2222-2222-222222222222", scope: "AgentControl.Access" } }]);
});

const database = new pg.Pool({ max: 4, host: "127.0.0.1", port: 1, password: "synthetic-unused", connectionTimeoutMillis: 10 });
const originalTenants = config.tenants;
const store = new session.MemoryStore();
let server: Server, origin: string, application: ReturnType<typeof createApp>;
let selected = account(), epoch = "1", issuedAfter = "0";
const sql: { text: string; values: unknown[] }[] = [];
const exchanges: string[] = [];
const defaultIdentityFetch: typeof fetch = async (url, request) => {
  if (String(url).endsWith("/discovery/v2.0/keys")) return new Response(JSON.stringify({ keys: [jwk] }));
  exchanges.push(String(new URLSearchParams(String(request?.body)).get("scope")));
  return sdkResponse({ oid: selected.localAccountId, uid: selected.homeAccountId.split(".")[0],
    utid: selected.homeAccountId.split(".")[1] }, request);
};
const identityFetch = vi.fn(defaultIdentityFetch);

beforeAll(async () => {
  config.tenants = [tenant];
  application = createApp(database, undefined, identityFetch);
  server = createServer(application.app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  clearAccountSessionMutationsForTest();
  selected = account(); epoch = "1"; issuedAfter = "0"; sql.length = 0; exchanges.length = 0;
  identityFetch.mockReset().mockImplementation(defaultIdentityFetch); clearAdmissionForTest();
  config.tenants = [tenant];
  vi.spyOn(application.store, "get").mockImplementation(store.get.bind(store));
  vi.spyOn(application.store, "set").mockImplementation(store.set.bind(store));
  vi.spyOn(application.store, "destroy").mockImplementation(store.destroy.bind(store));
  vi.spyOn(application.store, "touch").mockImplementation(store.touch.bind(store));
  vi.spyOn(DataGenerations.prototype, "sessionEpoch").mockImplementation(async () => epoch);
  vi.spyOn(DataGenerations.prototype, "bearerAuthority").mockImplementation(async () => ({ epoch, issuedAfter }));
  vi.spyOn(database, "query").mockImplementation(async (text, values) => {
    if (String(text).includes("FROM operational_state")) return {
      rows: [{ mode: "normal" }],
      rowCount: 1, command: "SELECT", oid: 0, fields: [],
    };
    sql.push({ text: String(text), values: Array.isArray(values) ? values : [] });
    return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
  });
  replaceMsalClientForTest(tenant.tenantId, {
    getAuthCodeUrl: async () => { throw new Error("No browser login"); },
    acquireTokenByCode: async () => { throw new Error("No browser login"); },
    acquireTokenByClientCredential: async () => { throw new Error("No application grant"); },
    acquireTokenSilent: async request => ({ ...browserAuthenticationResult(), account: selected,
      uniqueId: selected.localAccountId, scopes: Array.isArray(request.scopes) ? request.scopes : [],
      idTokenClaims: { ...browserAuthenticationResult().idTokenClaims, roles: ["AgentControl.Viewer"] } }),
    getTokenCache: () => ({ getAccountByHomeId: async () => selected, removeAccount: async () => undefined }),
  });
  await activateAccountSession(tenant.tenantId, selected.homeAccountId, async () => undefined);
  await loadOperationalState(database);
});
afterEach(() => { vi.restoreAllMocks(); replaceMsalClientForTest(tenant.tenantId, undefined); });
afterAll(async () => {
  config.tenants = originalTenants;
  server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  application?.store.close(); await database.end();
});
async function cookie() {
  const data = { ...browserSession(selected), csrfToken: "synthetic-csrf" };
  return browserFixtureCookie(store, config.sessionSecret, data);
}
function call(path: string, token = apiToken(), options: RequestInit = {}) {
  return fetch(`${origin}/api${path}`, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });
}
async function problem(response: Response) { return { status: response.status, body: await response.json() }; }

describe("registered canonical HTTP authentication", () => {
  it.each(["GET", "POST"])("cancels bearer bootstrap when a completed %s disconnects before its response", async method => {
    let started!: () => void, release!: () => void;
    let tokenSignal: AbortSignal | undefined;
    const reachedExchange = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    identityFetch.mockImplementation(async (url, request) => {
      if (String(url).endsWith("/discovery/v2.0/keys")) return new Response(JSON.stringify({ keys: [jwk] }));
      tokenSignal = request?.signal ?? undefined;
      started();
      await blocked;
      return sdkResponse({}, request);
    });
    const controller = new AbortController();
    const pending = call(method === "GET" ? "/agent-inventory/health" : "/agent-inventory/selections", apiToken(), {
      signal: controller.signal, method,
      ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    try {
      await reachedExchange;
      controller.abort();
      await rejected;
      await vi.waitFor(() => { expect(tokenSignal?.aborted).toBe(true); });
      expect(sql).toEqual([]);
    } finally { release(); }
  });

  it("requires a newly issued bearer after account revocation without requiring a portal login", async () => {
    const original = apiToken();
    await revokeAccountSessionMutations(tenant.tenantId, selected.homeAccountId, async () => { epoch = "2"; });
    expect((await call("/agent-inventory/health", original)).status).toBe(401);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2000);
    expect((await call("/agent-inventory/health", apiToken())).status).toBe(200);
    expect(sql[0].values).toEqual([tenant.tenantId]);
  });

  it.each([
    { oid: native, uid: native, utid: tenant.tenantId },
    { oid: guest, uid: guestHome, utid: guestTenant },
  ])("keeps pre-revocation assertions closed after fresh native/guest recovery %j", async ({ oid, uid, utid }) => {
    selected = account(oid, uid, utid);
    const client = getMsalClient(tenant.tenantId), cache = client.getTokenCache();
    vi.spyOn(client, "getTokenCache").mockReturnValue(cache);
    const portalCache = vi.spyOn(cache, "getAccountByHomeId").mockResolvedValue(null);
    const original = apiToken({ oid });
    expect((await call("/agent-inventory/health", original)).status).toBe(200);
    await revokeAccountSessionMutations(tenant.tenantId, selected.homeAccountId, async () => {
      epoch = "2"; issuedAfter = String(Date.now());
    });
    expect((await call("/agent-inventory/health", original)).status).toBe(401);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2000);
    const fresh = apiToken({ oid });
    expect((await call("/agent-inventory/health", fresh)).status).toBe(200);
    expect((await call("/agent-inventory/health", original)).status).toBe(401);
    expect((await call("/agent-inventory/health", fresh)).status).toBe(200);
    expect(sql).toHaveLength(3);
    for (const query of sql) expect(query.values).toEqual([tenant.tenantId]);
    expect(portalCache).not.toHaveBeenCalled();
  });

  it.each(["native", "guest"])("keeps %s tenant saved-read scope identical without a portal cache or provider-data read", async kind => {
    if (kind === "guest") selected = account(guest, guestHome, guestTenant);
    await activateAccountSession(tenant.tenantId, selected.homeAccountId, async () => undefined);
    const browser = await fetch(`${origin}/api/agent-inventory/health`, { headers: { cookie: await cookie() } });
    const browserBody = await browser.json(), browserSql = [...sql]; sql.length = 0;
    replaceMsalClientForTest(tenant.tenantId, {
      getAuthCodeUrl: async () => { throw new Error("No portal"); }, acquireTokenByCode: async () => { throw new Error("No portal"); },
      acquireTokenSilent: async () => { throw new Error("No portal cache"); }, acquireTokenByClientCredential: async () => null,
      getTokenCache: () => ({ getAccountByHomeId: async () => { throw new Error("No portal cache"); }, removeAccount: async () => undefined }),
    });
    const bearer = await call("/agent-inventory/health", apiToken({ oid: selected.localAccountId }));
    expect(browser.status).toBe(200); expect(bearer.status).toBe(200);
    expect(await bearer.json()).toEqual(browserBody);
    expect(sql).toEqual(browserSql);
    expect(sql[0].values).toEqual([tenant.tenantId]);
    expect(exchanges).toHaveLength(1); // Identity metadata bootstrap, never Graph data.
    expect(identityFetch.mock.calls.every(([url]) => String(url).startsWith("https://login.microsoftonline.com/"))).toBe(true);
  });

  it("uses identical POST defaults, validation and domain results on one registered handler", async () => {
    const input = JSON.stringify({ query: {} });
    const browser = await fetch(`${origin}/api/agent-inventory/selections`, { method: "POST",
      headers: { cookie: await cookie(), origin: config.frontendOrigin, "x-csrf-token": "synthetic-csrf", "content-type": "application/json" }, body: input });
    const baseline = await browser.json(), browserSql = [...sql]; sql.length = 0;
    const bearer = await call("/agent-inventory/selections", apiToken(), { method: "POST", headers: { "content-type": "application/json" }, body: input });
    expect(browser.status).toBe(200); expect(bearer.status).toBe(200);
    expect(await bearer.json()).toEqual(baseline); expect(sql).toEqual(browserSql);
    const bad = JSON.stringify({ query: { unexpected: "x" } });
    const left = await problem(await fetch(`${origin}/api/agent-inventory/selections`, { method: "POST",
      headers: { cookie: await cookie(), origin: config.frontendOrigin, "x-csrf-token": "synthetic-csrf", "content-type": "application/json" }, body: bad }));
    const right = await problem(await call("/agent-inventory/selections", apiToken(), { method: "POST", headers: { "content-type": "application/json" }, body: bad }));
    expect(left.status).toBe(400); expect(right.status).toBe(400);
    expect(right.body).toMatchObject({ code: left.body.code, detail: left.body.detail });
    expect([...declaredRoutePolicies.keys()].filter(key => key === "POST /agent-inventory/selections")).toHaveLength(1);
  });

  it.each([{ aud: "wrong" }, { azp: tenant.clientId }, { roles: [] }, { scp: "wrong" }, { tid: guestTenant },
    { iat: Math.floor(Date.now() / 1000) - 300 }, { exp: Math.floor(Date.now() / 1000) - 1 }])("denies wrong or stale bearer authority %j without fallback", async changes => {
    const response = await call("/agent-inventory/health", apiToken(changes));
    expect(response.status).toBe(401); expect(sql).toHaveLength(0);
  });

  it("rejects mixed credentials before any exchange or SQL", async () => {
    const response = await call("/agent-inventory/health", apiToken(), { headers: { cookie: await cookie() } });
    expect(await response.json()).toMatchObject({ code: "ambiguous_authentication" });
    expect(response.status).toBe(400); expect(identityFetch).not.toHaveBeenCalled(); expect(sql).toHaveLength(0);
  });

  it("retains cookie Origin/CSRF and browser-only boundaries", async () => {
    const headers = { cookie: await cookie(), "content-type": "application/json" }, body = JSON.stringify({ query: {} });
    expect((await fetch(`${origin}/api/agent-inventory/selections`, { method: "POST", headers, body })).status).toBe(403);
    const response = await fetch(`${origin}/api/agent-inventory/selections`, { method: "POST", headers: { ...headers, origin: config.frontendOrigin }, body });
    expect(await response.json()).toMatchObject({ code: "invalid_csrf" });
    for (const path of ["/me", "/workbench/metadata", "/diagnostics"]) {
      expect(await (await call(path)).json()).toMatchObject({ code: "browser_only_operation" });
    }
    expect(await (await call("/auth/login", apiToken(), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json())
      .toMatchObject({ code: "browser_only_operation" });
  });

  it("keeps admission disabled when integration is omitted", async () => {
    const browserClient = getMsalClient(tenant.tenantId);
    config.tenants = [{ ...tenant, integration: undefined }];
    replaceMsalClientForTest(tenant.tenantId, browserClient);
    expect((await call("/agent-inventory/health")).status).toBe(401);
    expect((await fetch(`${origin}/api/auth/status`)).status).toBe(200);
    expect((await fetch(`${origin}/api/agent-inventory/health`, { headers: { cookie: await cookie() } })).status).toBe(200);
  });

  it("preserves browser saved reads across an empty process-local MSAL cache", async () => {
    const client = getMsalClient(tenant.tenantId);
    const silent = vi.fn(async () => { throw new Error("Saved reads cannot acquire provider tokens."); });
    replaceMsalClientForTest(tenant.tenantId, { ...client, acquireTokenSilent: silent,
      getTokenCache: () => ({ getAccountByHomeId: async () => null, removeAccount: async () => undefined }) });
    expect((await fetch(`${origin}/api/agent-inventory/health`, { headers: { cookie: await cookie() } })).status).toBe(200);
    expect(silent).not.toHaveBeenCalled();
    expect(exchanges).toHaveLength(0);
  });

  it("retains verified client evidence and immutable issuance through nested adapters, then admits only a newer assertion", async () => {
    let source: DelegatedCredentialSource | undefined;
    vi.spyOn(database, "query").mockImplementation(async () => {
      source = currentAuthority();
      return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
    });
    expect((await call("/agent-inventory/health", apiToken(), { headers: { "x-integration-client": "untrusted" } })).status).toBe(200);
    expect(source?.principal).toMatchObject({ transport: "bearer", integrationClientId: tenant.integration!.clientId });
    if (!source) throw new Error("The canonical handler did not carry its initiating source.");
    const initiating = source, issuedAt = initiating.principal.rolesValidatedAt;
    await withAuthority(initiating, () => revalidateAuthenticatedUser(tenant.tenantId, selected.homeAccountId));
    await withAuthority(initiating, () => acquireDelegatedToken(tenant.tenantId, selected.homeAccountId, "graph.directory.read"));
    expect(initiating.principal.rolesValidatedAt).toBe(issuedAt);
    vi.spyOn(Date, "now").mockReturnValue(issuedAt + 300_000);
    expect(() => withAuthority(initiating, () => undefined)).toThrow(expect.objectContaining({ code: "authorization_stale" }));
    expect((await call("/agent-inventory/health", apiToken({ iat: issuedAt / 1000 }))).status).toBe(401);
    expect((await call("/agent-inventory/health", apiToken())).status).toBe(200);
  });

  it("pins concurrent initiating sources and fails closed when restart work has no source", async () => {
    const sources: DelegatedCredentialSource[] = [];
    vi.spyOn(database, "query").mockImplementation(async () => {
      const source = currentAuthority();
      if (source) sources.push(source);
      return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
    });
    const responses = await Promise.all([call("/agent-inventory/health", apiToken({ jti: "one" })), call("/agent-inventory/health", apiToken({ jti: "two" }))]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(sources).toHaveLength(2);
    expect(sources[0].reference.id).not.toBe(sources[1].reference.id);
    sources[0].revoke();
    await withAuthority(sources[1], async () => {
      await Promise.resolve();
      expect(currentAuthority()).toBe(sources[1]);
      expect(() => sources[0].assertCurrent()).toThrow(expect.objectContaining({ code: "authorization_required" }));
    });
    await expect(acquireAuthorizedToken(tenant.tenantId, selected.homeAccountId, "graph.directory.read"))
      .rejects.toMatchObject({ code: "authorization_required" });
  });

  it("pins real nested service revalidation and provider dispatch to the initiating bearer", async () => {
    vi.spyOn(capabilities, "requireAvailable").mockImplementation(async capabilityId => ({
      capabilityId, status: "available", authorized: true, fresh: true, previewQualification: "not_required", remediation: [],
    }));
    const search = vi.spyOn(DirectoryPrincipalsClient.prototype, "search").mockImplementation(async (token, _query, _limit, _signal, assertCurrent) => {
      expect(token).toBe("synthetic-opaque-provider-access");
      expect(currentAuthority()?.principal.transport).toBe("bearer");
      assertCurrent?.();
      return [];
    });
    const response = await call("/directory/principals?search=alex&limit=1");
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ value: [] });
    expect(search).toHaveBeenCalledOnce(); expect(exchanges.length).toBeGreaterThan(1);
  });

  it("fences an in-flight provider result after internal revocation", async () => {
    vi.spyOn(capabilities, "requireAvailable").mockImplementation(async capabilityId => ({
      capabilityId, status: "available", authorized: true, fresh: true, previewQualification: "not_required", remediation: [],
    }));
    vi.spyOn(DirectoryPrincipalsClient.prototype, "search").mockImplementation(async (_token, _query, _limit, _signal, assertCurrent) => {
      await revokeAccountSessionMutations(tenant.tenantId, selected.homeAccountId, async () => undefined);
      assertCurrent?.(); return [];
    });
    expect((await call("/directory/principals?search=alex&limit=1")).status).toBe(401);
  });

  it("launches the real worker from an explicit Admin HTTP resume and pauses if authority ends during its saved-job await", async () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const job: NonNullable<Awaited<ReturnType<typeof bulkJobs.get>>> = {
      id, tokenMode: "delegated", capabilityId: "graph.package.block.manage", status: "waiting_authorization",
      action: "block", targetBlockedState: true, confirmationHash: null, confirmation: null, confirmedAt: null,
      total: 1, completed: 0, succeeded: 0, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0,
      queued: 1, reconciliationRequired: 0, retryEligible: 0, resultRevision: "1", currentAgentName: undefined,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), canResume: true,
    };
    let calls = 0, initiating: DelegatedCredentialSource | undefined, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(bulkJobs, "get").mockImplementation(async (_id, scope) => {
      expect(scope).toEqual({ tenantId: tenant.tenantId, principalId: selected.homeAccountId });
      if (++calls === 3) { initiating = currentAuthority(); await held; }
      return job;
    });
    vi.spyOn(bulkJobs, "recover").mockResolvedValue();
    vi.spyOn(capabilities, "requireAvailable").mockImplementation(async capabilityId => ({
      capabilityId, status: "available", authorized: true, fresh: true, previewQualification: "not_required", remediation: [],
    }));
    const wait = vi.spyOn(bulkJobs, "waitForAuthorization").mockResolvedValue();
    const claim = vi.spyOn(bulkJobs, "claim");
    try {
      const response = await call(`/agents/bulk-jobs/${id}/resume`, apiToken({ roles: ["AgentControl.Admin"] }),
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(initiating?.principal.transport).toBe("bearer"));
      initiating?.revoke(); release();
      await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(id, { tenantId: tenant.tenantId, principalId: selected.homeAccountId }));
      expect(claim).not.toHaveBeenCalled();
    } finally { release(); await drainBulkJobs().catch(error => { if (!(error instanceof AppError) || error.status !== 401) throw error; }); }
  });

  it("classifies every current operation from the sole contract, with no bearer aliases", () => {
    const document = readFileSync(new URL("../../../docs/mcp-integration.md", import.meta.url), "utf8");
    for (const line of document.split("\n").filter(line => /^\| `[A-Z]+ \/api\//.test(line))) {
      const match = /^\| `([A-Z]+) (\/api\/[^`]+)`/.exec(line)!;
      const key = `${match[1]} ${match[2].slice(4)}`;
      const policy = declaredRoutePolicies.get(key) ?? declaredRoutePolicies.get(`${match[1]} ${match[2]}`);
      if (!policy) continue; // Future 04/04A contracts are explicitly not registered.
      if (policy.access === "authenticated") expect(Boolean(policy.browserOnly), key).toBe(line.includes("| — |"));
    }
  });
});
