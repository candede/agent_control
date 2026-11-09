import { createServer, type Server } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import { createApp } from "../app.js";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { activateAccountSession, clearAccountSessionMutationsForTest } from "../db/sessions.js";
import { replaceMsalClientForTest } from "../auth/msal.js";
import { apiToken, account, browserAuthenticationResult, browserFixtureCookie, browserSession, jwk, sdkResponse, tenant } from "../auth/authFoundationTestSupport.js";
import { loadOperationalState } from "../services/operationalState.js";
import { clearAdmissionForTest } from "../middleware/admission.js";
import type { AppRole } from "../types/capability.js";
import { dataSync } from "../services/dataSync.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{ tenantId: "11111111-1111-1111-1111-111111111111",
    clientId: "22222222-2222-2222-2222-222222222222", clientSecret: "synthetic-only", domains: ["example.invalid"],
    integration: { clientId: "33333333-3333-3333-3333-333333333333", audience: "22222222-2222-2222-2222-222222222222", scope: "AgentControl.Access" } }]);
});
const originalTenants = config.tenants, roles: Array<"AgentControl.Viewer" | "AgentControl.Admin"> = ["AgentControl.Viewer", "AgentControl.Admin"];
const context = Buffer.from(JSON.stringify({ version: 1, client: { id: "synthetic-client", name: "=1+1" },
  callingAgent: { id: "synthetic-caller", name: "<script>inert</script>" }, mcpCallId: "same-call" })).toString("base64url");
let fixture: Awaited<ReturnType<typeof testDatabase>> | undefined, application: ReturnType<typeof createApp> | undefined, server: Server | undefined;

// The same real createApp/RSA/JWKS/MSAL/browser-cookie harness used by phase03A.
export async function setupAuditOriginHttp(transport: "webapp" | "mcp", selected = account(), integrationClientId = tenant.integration!.clientId,
  actorRoles: AppRole[] = roles) {
  fixture = await testDatabase();
  vi.spyOn(pool, "query").mockImplementation(fixture.runtime.query.bind(fixture.runtime));
  vi.spyOn(pool, "connect").mockImplementation(fixture.runtime.connect.bind(fixture.runtime));
  config.tenants = [{ ...tenant, integration: { ...tenant.integration!, clientId: integrationClientId } }];
  clearAccountSessionMutationsForTest(); clearAdmissionForTest();
  const roles = actorRoles;
  const identityAccounts = new Map([[selected.localAccountId, { account: selected, roles }]]);
  const authentication = { ...browserAuthenticationResult(), account: selected, uniqueId: selected.localAccountId, scopes: ["openid", "profile"],
    idTokenClaims: { ...browserAuthenticationResult().idTokenClaims, oid: selected.localAccountId, roles } };
  replaceMsalClientForTest(tenant.tenantId, {
    getAuthCodeUrl: async () => { throw new Error("No live browser login"); },
    acquireTokenByCode: async () => { throw new Error("No live browser login"); },
    acquireTokenByClientCredential: async () => ({ ...browserAuthenticationResult(), account: null, idTokenClaims: {},
      scopes: ["https://graph.microsoft.com/.default"], accessToken: "synthetic-application-membership-token" }),
    acquireTokenSilent: async request => {
      const member = identityAccounts.get(request.account.localAccountId);
      if (!member) throw new Error("Unregistered synthetic account.");
      return { ...authentication, account: member.account, uniqueId: member.account.localAccountId,
        idTokenClaims: { ...authentication.idTokenClaims, oid: member.account.localAccountId, roles: member.roles },
        scopes: Array.isArray(request.scopes) ? request.scopes : [] };
    },
    getTokenCache: () => ({ getAccountByHomeId: async id =>
      [...identityAccounts.values()].find(member => member.account.homeAccountId === id)?.account ?? null,
    removeAccount: async () => undefined }),
  });
  await activateAccountSession(tenant.tenantId, selected.homeAccountId, async () => undefined);
  await loadOperationalState(fixture.runtime);
  const providerWork = { requests: 0, bootstrapRequests: 0, bootstrapAdmissions: 0 };
  const bootstrap = new AsyncLocalStorage<boolean>();
  const authenticatedEntry = dataSync.authenticatedEntry.bind(dataSync);
  vi.spyOn(dataSync, "authenticatedEntry").mockImplementation((...args) => {
    providerWork.bootstrapAdmissions++;
    return bootstrap.run(true, () => authenticatedEntry(...args));
  });
  const providerRequest = () => {
    if (bootstrap.getStore()) providerWork.bootstrapRequests++;
    else providerWork.requests++;
  };
  const liveFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    const target = new URL(String(url));
    if (target.protocol === "http:" && target.hostname === "127.0.0.1") return liveFetch(url, init);
    providerRequest(); throw new Error("Saved HTTP fixtures forbid provider data requests.");
  });
  const identityFetch: typeof fetch = async (url, request) => {
    const target = new URL(String(url));
    if (target.hostname === "graph.microsoft.com" && target.pathname.startsWith("/v1.0/users/")) {
      const member = identityAccounts.get(target.pathname.slice("/v1.0/users/".length));
      if (member) return Response.json({ id: member.account.localAccountId, userType: "Member", accountEnabled: true });
    }
    if (target.hostname !== "login.microsoftonline.com" || !target.pathname.startsWith(`/${tenant.tenantId}/`)) {
      providerRequest(); throw new Error("Unexpected identity authority.");
    }
    if (target.pathname.endsWith("/discovery/v2.0/keys")) return Response.json({ keys: [jwk, { ...jwk, kid: "sdk-api-fixture" }] });
    if (!target.pathname.endsWith("/oauth2/v2.0/token")) { providerRequest(); throw new Error("Unexpected identity operation."); }
    const assertion = new URLSearchParams(String(request?.body ?? "")).get("assertion");
    const oid = assertion ? JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString("utf8")).oid : selected.localAccountId;
    const identity = identityAccounts.get(oid);
    if (!identity) throw new Error("Unregistered synthetic same-user identity.");
    return sdkResponse({ oid: identity.account.localAccountId, uid: identity.account.homeAccountId.split(".")[0], utid: identity.account.homeAccountId.split(".")[1],
      claims: { roles: identity.roles } }, request);
  };
  application = createApp(fixture.runtime, undefined, identityFetch);
  server = createServer(application.app);
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const session = browserSession(selected); session.user!.roles = roles; session.user!.localAccountId = selected.localAccountId;
  session.csrfToken = "synthetic-csrf";
  const cookie = await browserFixtureCookie(application.store, config.sessionSecret, session);
  const headers = transport === "mcp"
    ? { authorization: `Bearer ${apiToken({ roles, oid: selected.localAccountId, azp: integrationClientId })}`, "X-Agent-Control-Mcp-Context": context }
    : { cookie, Origin: config.frontendOrigin, "X-CSRF-Token": "synthetic-csrf" };
  const request = (path: string, options: RequestInit = {}) => fetch(`${base}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const requestAs = (kind: "webapp" | "mcp", path: string, options: RequestInit = {}) => fetch(`${base}${path}`, { ...options,
    headers: { ...(kind === "mcp"
      ? { authorization: `Bearer ${apiToken({ roles, oid: selected.localAccountId, azp: integrationClientId })}`, "X-Agent-Control-Mcp-Context": context }
      : { cookie, Origin: config.frontendOrigin, "X-CSRF-Token": "synthetic-csrf" }), ...options.headers } });
  const browserRequestFor = async (member: typeof selected, memberRoles: AppRole[]) => {
    identityAccounts.set(member.localAccountId, { account: member, roles: memberRoles });
    await activateAccountSession(tenant.tenantId, member.homeAccountId, async () => undefined);
    const memberSession = browserSession(member);
    memberSession.user!.roles = memberRoles; memberSession.user!.localAccountId = member.localAccountId;
    memberSession.csrfToken = "synthetic-csrf";
    const memberCookie = await browserFixtureCookie(application!.store, config.sessionSecret, memberSession, `synthetic-auth-${randomUUID()}`);
    return (path: string, options: RequestInit = {}) => fetch(`${base}${path}`, { ...options,
      headers: { cookie: memberCookie, Origin: config.frontendOrigin, "X-CSRF-Token": "synthetic-csrf", ...options.headers } });
  };
  return { base, integrationClientId, database: fixture.runtime, providerWork, identityAccounts, actor: session.user!, scope: { tenantId: tenant.tenantId, principalId: selected.homeAccountId }, request, requestAs, browserRequestFor };
}

export async function closeAuditOriginHttp() {
  server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  application?.store.close(); server = undefined; application = undefined;
  vi.restoreAllMocks(); replaceMsalClientForTest(tenant.tenantId, undefined); config.tenants = originalTenants;
  await fixture?.close(); fixture = undefined;
}
