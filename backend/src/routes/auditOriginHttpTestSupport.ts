import { createServer, type Server } from "node:http";
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
export async function setupAuditOriginHttp(transport: "webapp" | "mcp", selected = account(), integrationClientId = tenant.integration!.clientId) {
  fixture = await testDatabase();
  vi.spyOn(pool, "query").mockImplementation(fixture.runtime.query.bind(fixture.runtime));
  vi.spyOn(pool, "connect").mockImplementation(fixture.runtime.connect.bind(fixture.runtime));
  config.tenants = [{ ...tenant, integration: { ...tenant.integration!, clientId: integrationClientId } }];
  clearAccountSessionMutationsForTest(); clearAdmissionForTest();
  const authentication = { ...browserAuthenticationResult(), account: selected, uniqueId: selected.localAccountId, scopes: ["User.ReadBasic.All"],
    idTokenClaims: { ...browserAuthenticationResult().idTokenClaims, oid: selected.localAccountId, roles } };
  replaceMsalClientForTest(tenant.tenantId, {
    getAuthCodeUrl: async () => { throw new Error("No live browser login"); },
    acquireTokenByCode: async () => { throw new Error("No live browser login"); },
    acquireTokenByClientCredential: async () => { throw new Error("No application grant"); },
    acquireTokenSilent: async request => ({ ...authentication, scopes: Array.isArray(request.scopes) ? request.scopes : [] }),
    getTokenCache: () => ({ getAccountByHomeId: async () => selected, removeAccount: async () => undefined }),
  });
  await activateAccountSession(tenant.tenantId, selected.homeAccountId, async () => undefined);
  await loadOperationalState(fixture.runtime);
  const providerWork = { requests: 0 };
  const liveFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    const target = new URL(String(url));
    if (target.protocol === "http:" && target.hostname === "127.0.0.1") return liveFetch(url, init);
    providerWork.requests++; throw new Error("Saved HTTP fixtures forbid provider data requests.");
  });
  const identityFetch: typeof fetch = async (url, request) => {
    const target = new URL(String(url));
    if (target.hostname !== "login.microsoftonline.com" || !target.pathname.startsWith(`/${tenant.tenantId}/`)) {
      providerWork.requests++; throw new Error("Unexpected identity authority.");
    }
    if (target.pathname.endsWith("/discovery/v2.0/keys")) return Response.json({ keys: [jwk, { ...jwk, kid: "sdk-api-fixture" }] });
    if (!target.pathname.endsWith("/oauth2/v2.0/token")) { providerWork.requests++; throw new Error("Unexpected identity operation."); }
    return sdkResponse({ oid: selected.localAccountId, uid: selected.homeAccountId.split(".")[0], utid: selected.homeAccountId.split(".")[1],
      claims: { roles } }, request);
  };
  application = createApp(fixture.runtime, undefined, identityFetch);
  server = createServer(application.app);
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const session = browserSession(selected); session.user!.roles = roles; session.csrfToken = "synthetic-csrf";
  const cookie = await browserFixtureCookie(application.store, config.sessionSecret, session);
  const headers = transport === "mcp"
    ? { authorization: `Bearer ${apiToken({ roles, oid: selected.localAccountId, azp: integrationClientId })}`, "X-Agent-Control-Mcp-Context": context }
    : { cookie, Origin: config.frontendOrigin, "X-CSRF-Token": "synthetic-csrf" };
  const request = (path: string, options: RequestInit = {}) => fetch(`${base}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const requestAs = (kind: "webapp" | "mcp", path: string, options: RequestInit = {}) => fetch(`${base}${path}`, { ...options,
    headers: { ...(kind === "mcp"
      ? { authorization: `Bearer ${apiToken({ roles, oid: selected.localAccountId, azp: integrationClientId })}`, "X-Agent-Control-Mcp-Context": context }
      : { cookie, Origin: config.frontendOrigin, "X-CSRF-Token": "synthetic-csrf" }), ...options.headers } });
  return { base, integrationClientId, database: fixture.runtime, providerWork, actor: session.user!, scope: { tenantId: tenant.tenantId, principalId: selected.homeAccountId }, request, requestAs };
}

export async function closeAuditOriginHttp() {
  server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  application?.store.close(); server = undefined; application = undefined;
  vi.restoreAllMocks(); replaceMsalClientForTest(tenant.tenantId, undefined); config.tenants = originalTenants;
  await fixture?.close(); fixture = undefined;
}
