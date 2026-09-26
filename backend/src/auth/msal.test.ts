import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfidentialClientApplication } from "@azure/msal-node";
import { config, loginScopes, type TenantConfiguration } from "../config.js";
import { acquireApplicationToken, acquireDelegatedToken, capabilityScopes, createAuthFlow, createAuthorizationUrl, evictAccount, getMsalClient, msalNetworkClient, msalNetworkTimeoutMs, redeemAuthorizationCode, replaceMsalClientForTest, revalidateAuthenticatedUser, toAuthenticatedUser, type MsalClient } from "./msal.js";
import { inventoryProviderRoleIds } from "../services/inventoryRoleScope.js";
import { capabilityDefinitions } from "../services/capabilityRegistry.js";

const { tenant, otherTenant } = vi.hoisted(() => {
  const tenant: TenantConfiguration = { tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222", clientSecret: "fixture", domains: ["example.invalid"], displayName: "First tenant" };
  const otherTenant: TenantConfiguration = { tenantId: "99999999-9999-9999-9999-999999999999", clientId: "88888888-8888-8888-8888-888888888888", clientSecret: "other-fixture", domains: ["other.invalid"], displayName: "Second tenant" };
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([tenant, otherTenant]);
  return { tenant, otherTenant };
});
const tenantId = tenant.tenantId;
const otherTenantId = otherTenant.tenantId;
const originalTenants = config.tenants;
const account = { homeAccountId: "account-a", tenantId, environment: "login.microsoftonline.com", username: "fixture@example.invalid", localAccountId: "local" };

function jwt(payload: Record<string, unknown>) {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function futureExpiry() {
  return new Date(Date.now() + 60_000);
}

function fakeClient(overrides: Partial<MsalClient> = {}, selectedTenant = tenant) {
  const removeAccount = vi.fn(async () => undefined);
  const selectedAccount = { ...account, tenantId: selectedTenant.tenantId, username: `fixture@${selectedTenant.domains[0]}` };
  const client: MsalClient = {
    getAuthCodeUrl: vi.fn(async () => `https://login.microsoftonline.com/${selectedTenant.tenantId}/oauth2/v2.0/authorize`),
    acquireTokenByCode: vi.fn(),
    acquireTokenSilent: vi.fn(async request => {
      const scopes = request.scopes as string[];
      return { accessToken: "opaque-delegated-provider-token", scopes, account: selectedAccount, tenantId: selectedTenant.tenantId, expiresOn: futureExpiry(),
        idTokenClaims: { tid: selectedTenant.tenantId, aud: selectedTenant.clientId, roles: ["AgentControl.Viewer"] } } as never;
    }),
    acquireTokenByClientCredential: vi.fn(async () => {
      return { accessToken: jwt({ aud: "https://graph.microsoft.com", tid: selectedTenant.tenantId, idtyp: "app", azp: selectedTenant.clientId, roles: ["CopilotPackages.Read.All"], exp: Math.floor(futureExpiry().getTime() / 1000) }), scopes: ["https://graph.microsoft.com/.default"], tenantId: selectedTenant.tenantId, expiresOn: futureExpiry() } as never;
    }),
    getTokenCache: () => ({ getAccountByHomeId: vi.fn(async id => id === account.homeAccountId ? selectedAccount : null), removeAccount }),
    ...overrides,
  };
  return { client, removeAccount };
}

beforeEach(() => { config.tenants = [tenant, otherTenant]; });
afterEach(() => {
  replaceMsalClientForTest(tenantId, undefined);
  replaceMsalClientForTest(otherTenantId, undefined);
  config.tenants = originalTenants;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("authentication scopes", () => {
  it("requests only authentication scopes and leaves every API grant to administrator setup", () => {
    expect(loginScopes).toEqual(["openid", "profile"]);
    const flow = createAuthFlow("login", { tenantId, username: account.username });
    expect(flow.scopes).toEqual(["openid", "profile", "offline_access"]);
    expect(flow).not.toHaveProperty("extraScopesToConsent");
    expect(flow).not.toHaveProperty("capabilityId");
    for (const definition of capabilityDefinitions.filter(value => value.mode !== "local")) {
      for (const scope of capabilityScopes(definition.id)) expect(flow.scopes).not.toContain(scope);
    }
    expect(capabilityScopes("graph.package.read.delegated")).toEqual(["https://graph.microsoft.com/CopilotPackages.Read.All"]);
    expect(capabilityScopes("powerPlatform.inventory.read")).toEqual(["https://api.powerplatform.com/ResourceQuery.Resources.Read"]);
    expect(capabilityScopes("powerPlatform.quarantine.manage")).toEqual(["https://api.powerplatform.com/CopilotStudio.AdminActions.Invoke"]);
    expect(capabilityScopes("reports.copilotUsage.read")).toEqual(["https://graph.microsoft.com/Reports.Read.All"]);
  });

  describe("tenant-bound Microsoft authentication", () => {
    it("creates separate native client caches even when tenants share a client ID", () => {
      config.tenants = [tenant, { ...otherTenant, clientId: tenant.clientId }];
      const first = getMsalClient(tenantId);
      const second = getMsalClient(otherTenantId);
      expect(first).not.toBe(second);
      expect(first.getTokenCache()).not.toBe(second.getTokenCache());
      expect(getMsalClient(tenantId)).toBe(first);
      config.tenants = [{ ...tenant, clientId: otherTenant.clientId }, otherTenant];
      expect(getMsalClient(tenantId)).not.toBe(first);
      config.tenants = [tenant, otherTenant];
      expect(getMsalClient(tenantId)).not.toBe(first);
    });

    it("keeps delegated tokens, revalidation and eviction isolated for the same home account ID", async () => {
      const first = fakeClient();
      const second = fakeClient({}, otherTenant);
      replaceMsalClientForTest(tenantId, first.client);
      replaceMsalClientForTest(otherTenantId, second.client);
      expect(getMsalClient(tenantId)).toBe(first.client);
      expect(getMsalClient(otherTenantId)).toBe(second.client);
      await acquireDelegatedToken(tenantId, account.homeAccountId, "graph.package.read.delegated");
      await acquireDelegatedToken(otherTenantId, account.homeAccountId, "graph.package.read.delegated");
      await expect(revalidateAuthenticatedUser(otherTenantId, account.homeAccountId)).resolves.toMatchObject({
        tenantId: otherTenantId, homeAccountId: account.homeAccountId, username: "fixture@other.invalid",
      });
      expect(first.client.acquireTokenSilent).toHaveBeenCalledTimes(1);
      expect(second.client.acquireTokenSilent).toHaveBeenLastCalledWith(expect.objectContaining({
        authority: `https://login.microsoftonline.com/${otherTenantId}`,
        account: expect.objectContaining({ tenantId: otherTenantId, homeAccountId: account.homeAccountId }),
        scopes: loginScopes, forceRefresh: true,
      }));
      await evictAccount(tenantId, account.homeAccountId);
      expect(first.removeAccount).toHaveBeenCalledWith(account);
      expect(second.removeAccount).not.toHaveBeenCalled();
    });

    it("selects the authority and normalized login hint without broadening scopes", async () => {
      const first = fakeClient();
      const second = fakeClient({}, otherTenant);
      replaceMsalClientForTest(tenantId, first.client);
      replaceMsalClientForTest(otherTenantId, second.client);
      const flow = createAuthFlow("login", { tenantId: otherTenantId, username: " Fixture@OTHER.invalid ", returnTo: "/agents" });
      expect(flow).toMatchObject({ tenantId: otherTenantId, clientId: otherTenant.clientId, username: "fixture@other.invalid", returnTo: "/agents" });
      expect(JSON.stringify(flow)).not.toContain(otherTenant.clientSecret);
      await expect(createAuthorizationUrl(flow)).resolves.toContain(`/${otherTenantId}/`);
      expect(first.client.getAuthCodeUrl).not.toHaveBeenCalled();
      expect(second.client.getAuthCodeUrl).toHaveBeenCalledWith(expect.objectContaining({
        authority: `https://login.microsoftonline.com/${otherTenantId}`, loginHint: "fixture@other.invalid",
        scopes: ["openid", "profile", "offline_access"], state: flow.state, nonce: flow.nonce, codeChallengeMethod: "S256",
      }));
      vi.mocked(second.client.getAuthCodeUrl).mockResolvedValue(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
      await expect(createAuthorizationUrl(flow)).rejects.toMatchObject({ code: "invalid_authorization_url" });
    });

    it("uses an explicit configured tenant for trusted canonical hints without domain discovery", () => {
      expect(createAuthFlow("login", { tenantId, username: "Canonical@tenant.onmicrosoft.com" })).toMatchObject({
        tenantId, clientId: tenant.clientId, username: "canonical@tenant.onmicrosoft.com",
      });
      expect(() => createAuthFlow("login", { tenantId: "not-configured", username: account.username })).toThrow();
      expect(() => getMsalClient("not-configured")).toThrow();
    });

    it("shares organizational username normalization without routing canonical UPN domains", async () => {
      const flow = createAuthFlow("login", { tenantId, username: " Fixture@B\u00dcCHER.invalid " });
      expect(flow.username).toBe("fixture@xn--bcher-kva.invalid");
      const result = {
        tenantId, account: { ...account, username: "Fixture@B\u00dcCHER.invalid" },
        idTokenClaims: { tid: tenantId, aud: tenant.clientId, nonce: flow.nonce },
      };
      const { client } = fakeClient({ acquireTokenByCode: vi.fn(async () => result as never) });
      replaceMsalClientForTest(tenantId, client);
      await expect(redeemAuthorizationCode("code", flow)).resolves.toBe(result);
      expect(toAuthenticatedUser(result as never).username).toBe(flow.username);
    });

    it.each(["not-an-email", "fixture@example..invalid", ""])("rejects malformed provider usernames as authentication failures: %s", username => {
      expect(() => toAuthenticatedUser({ account: { ...account, username } } as never)).toThrow(expect.objectContaining({ code: "unauthorized" }));
    });

    it.each([
      { tenantId: otherTenantId },
      { homeAccountId: "" },
      { localAccountId: "another-local-id" },
    ])("rejects a callback account inconsistent with the selected identity: %j", async change => {
      const flow = createAuthFlow("login", { tenantId, username: account.username });
      const { client } = fakeClient({ acquireTokenByCode: vi.fn(async () => ({
        tenantId, account: { ...account, ...change },
        idTokenClaims: { tid: tenantId, aud: tenant.clientId, nonce: flow.nonce, oid: account.localAccountId },
      } as never)) });
      replaceMsalClientForTest(tenantId, client);
      await expect(redeemAuthorizationCode("code", flow)).rejects.toMatchObject({ code: "unauthorized" });
    });

    it.each([
      { tid: otherTenantId },
      { aud: otherTenant.clientId },
      { aud: undefined },
      { azp: otherTenant.clientId },
      { appid: otherTenant.clientId },
      { oid: "another-local-id" },
    ])("rejects inconsistent callback tenant/application/account claims: %j", async change => {
      const flow = createAuthFlow("login", { tenantId, username: account.username });
      const { client } = fakeClient({ acquireTokenByCode: vi.fn(async () => ({
        tenantId, account, idTokenClaims: { tid: tenantId, aud: tenant.clientId, nonce: flow.nonce, ...change },
      } as never)) });
      replaceMsalClientForTest(tenantId, client);
      await expect(redeemAuthorizationCode("code", flow)).rejects.toMatchObject({ code: "unauthorized" });
    });

    it.each([
      { accountUsername: "Fixture@EXAMPLE.invalid", canonicalUsername: "fixture@example.invalid" },
      { accountUsername: "CANONICAL@tenant.onmicrosoft.com", canonicalUsername: "Canonical@tenant.onmicrosoft.com" },
      { accountUsername: "alias@example.invalid", canonicalUsername: "canonical@tenant.onmicrosoft.com" },
    ])("accepts canonical aliases and case differences within the selected tenant: %j", async ({ accountUsername, canonicalUsername }) => {
      const flow = createAuthFlow("login", { tenantId, username: "alias@example.invalid" });
      const result = {
        tenantId, account: { ...account, username: accountUsername },
        idTokenClaims: { tid: tenantId, aud: tenant.clientId, nonce: flow.nonce, oid: account.localAccountId, preferred_username: canonicalUsername },
      };
      const { client } = fakeClient({ acquireTokenByCode: vi.fn(async () => result as never) });
      replaceMsalClientForTest(tenantId, client);
      await expect(redeemAuthorizationCode("code", flow)).resolves.toBe(result);
      expect(toAuthenticatedUser(result as never)).toMatchObject({
        tenantId, homeAccountId: account.homeAccountId, username: canonicalUsername.toLowerCase(),
      });
    });

    it("refreshes a canonical username without changing the exact tenant and home account", async () => {
      const { client } = fakeClient({ acquireTokenSilent: vi.fn(async () => ({
        tenantId, account: { ...account, username: "Canonical@tenant.onmicrosoft.com" },
        idTokenClaims: { tid: tenantId, aud: tenant.clientId, oid: account.localAccountId, preferred_username: "Canonical@tenant.onmicrosoft.com" },
      } as never)) });
      replaceMsalClientForTest(tenantId, client);
      await expect(revalidateAuthenticatedUser(tenantId, account.homeAccountId)).resolves.toMatchObject({
        tenantId, homeAccountId: account.homeAccountId, username: "canonical@tenant.onmicrosoft.com",
      });
      expect(client.acquireTokenSilent).toHaveBeenCalledWith(expect.objectContaining({ account, forceRefresh: true }));
    });

    it.each(["delegated", "application"] as const)("validates all decodeable %s tenant and client claims", async mode => {
      for (const change of [{ tid: otherTenantId }, { azp: otherTenant.clientId }, { appid: otherTenant.clientId }]) {
        const result = {
          accessToken: jwt({ tid: tenantId, aud: "https://graph.microsoft.com", azp: tenant.clientId, appid: tenant.clientId,
            ...(mode === "application" ? { roles: ["CopilotPackages.Read.All"], idtyp: "app" } : { scp: "CopilotPackages.Read.All" }), ...change }),
          tenantId, expiresOn: futureExpiry(),
          scopes: mode === "application" ? ["https://graph.microsoft.com/.default"] : capabilityScopes("graph.package.read.delegated"),
          ...(mode === "delegated" ? { account } : {}),
        };
        const { client } = fakeClient(mode === "application"
          ? { acquireTokenByClientCredential: vi.fn(async () => result as never) }
          : { acquireTokenSilent: vi.fn(async () => result as never) });
        replaceMsalClientForTest(tenantId, client);
        await expect(mode === "application" ? acquireApplicationToken(tenantId, "graph.package.read.application")
          : acquireDelegatedToken(tenantId, account.homeAccountId, "graph.package.read.delegated")).rejects.toMatchObject({ code: "unauthorized" });
      }
    });

    it("uses tenant-bound MSAL metadata for opaque application tokens and rejects contradictions", async () => {
      for (const selected of [tenant, otherTenant]) {
        const result = { accessToken: `opaque-${selected.tenantId}`, tenantId: selected.tenantId, scopes: [], expiresOn: futureExpiry() };
        const { client } = fakeClient({ acquireTokenByClientCredential: vi.fn(async () => result as never) }, selected);
        replaceMsalClientForTest(selected.tenantId, client);
        await expect(acquireApplicationToken(selected.tenantId, "graph.package.read.application")).resolves.toBe(result.accessToken);
        expect(client.acquireTokenByClientCredential).toHaveBeenCalledWith(expect.objectContaining({ authority: `https://login.microsoftonline.com/${selected.tenantId}` }));
        vi.mocked(client.acquireTokenByClientCredential).mockResolvedValue({ ...result, tenantId: "unconfigured" } as never);
        await expect(acquireApplicationToken(selected.tenantId, "graph.package.read.application")).rejects.toMatchObject({ code: "unauthorized" });
        vi.mocked(client.acquireTokenByClientCredential).mockResolvedValue({ ...result, idTokenClaims: { aud: "another-client" } } as never);
        await expect(acquireApplicationToken(selected.tenantId, "graph.package.read.application")).rejects.toMatchObject({ code: "unauthorized" });
      }
    });

    it("rejects inconsistent opaque delegated identity metadata", async () => {
      const { client } = fakeClient({ acquireTokenSilent: vi.fn(async () => ({
        accessToken: "opaque", scopes: capabilityScopes("graph.package.read.delegated"), tenantId, account,
        expiresOn: futureExpiry(), idTokenClaims: { tid: otherTenantId, aud: otherTenant.clientId },
      } as never)) });
      replaceMsalClientForTest(tenantId, client);
      await expect(acquireDelegatedToken(tenantId, account.homeAccountId, "graph.package.read.delegated")).rejects.toMatchObject({ code: "unauthorized" });
    });

    it("does not revalidate or evict a foreign cached account", async () => {
      const removeAccount = vi.fn();
      const { client } = fakeClient({ getTokenCache: () => ({
        getAccountByHomeId: vi.fn(async () => ({ ...account, tenantId: otherTenantId })), removeAccount,
      }) });
      replaceMsalClientForTest(tenantId, client);
      await expect(revalidateAuthenticatedUser(tenantId, account.homeAccountId)).rejects.toMatchObject({ code: "interaction_required" });
      await evictAccount(tenantId, account.homeAccountId);
      expect(client.acquireTokenSilent).not.toHaveBeenCalled();
      expect(removeAccount).not.toHaveBeenCalled();
    });

    it.each([{ tid: otherTenantId }, { aud: otherTenant.clientId }, { azp: otherTenant.clientId }, { appid: otherTenant.clientId }])(
      "rejects foreign cached identity claims before silent token acquisition: %j", async claims => {
        const { client } = fakeClient({ getTokenCache: () => ({
          getAccountByHomeId: vi.fn(async () => ({ ...account, idTokenClaims: claims })), removeAccount: vi.fn(),
        }) });
        replaceMsalClientForTest(tenantId, client);
        await expect(revalidateAuthenticatedUser(tenantId, account.homeAccountId)).rejects.toMatchObject({ code: "unauthorized" });
        await expect(acquireDelegatedToken(tenantId, account.homeAccountId, "graph.package.read.delegated")).rejects.toMatchObject({ code: "unauthorized" });
        expect(client.acquireTokenSilent).not.toHaveBeenCalled();
      },
    );

    it("rejects tenant configuration changes before and during code redemption", async () => {
      const flow = createAuthFlow("login", { tenantId, username: account.username });
      const { client } = fakeClient({ acquireTokenByCode: vi.fn(async () => {
        config.tenants = [{ ...tenant, clientSecret: "rotated" }, otherTenant];
        return { tenantId, account, idTokenClaims: { tid: tenantId, aud: tenant.clientId, nonce: flow.nonce } } as never;
      }) });
      replaceMsalClientForTest(tenantId, client);
      await expect(redeemAuthorizationCode("code", flow)).rejects.toMatchObject({ code: "invalid_auth_state" });
      await expect(createAuthorizationUrl(flow)).rejects.toMatchObject({ code: "invalid_auth_state" });
      expect(client.getAuthCodeUrl).not.toHaveBeenCalled();
    });
  });

  it("preserves username-bound interactive sign-in without a consent prompt or extra scopes", async () => {
    const { client } = fakeClient();
    replaceMsalClientForTest(tenantId, client);
    const flow = createAuthFlow("login", { tenantId, username: account.username });
    await createAuthorizationUrl(flow);
    expect(client.getAuthCodeUrl).toHaveBeenCalledWith(expect.objectContaining({ scopes: flow.scopes }));
    expect(vi.mocked(client.getAuthCodeUrl).mock.calls[0][0]).toMatchObject({ prompt: "login", loginHint: account.username });
    expect(vi.mocked(client.getAuthCodeUrl).mock.calls[0][0]).not.toHaveProperty("extraScopesToConsent");
  });

  it("rejects old consent constructors and dynamically supplied login permissions", () => {
    expect(() => Reflect.apply(createAuthFlow, undefined, ["consent", { capabilityId: "graph.agentIdentity.read" }]))
      .toThrow("Permissions cannot be requested or enabled");
    expect(() => Reflect.apply(createAuthFlow, undefined, ["login", { scopes: ["https://graph.microsoft.com/AgentIdentity.Read.All"] }]))
      .toThrow("Permissions cannot be requested or enabled");
  });

  it.each([
    { kind: "consent" },
    { extraScopesToConsent: ["https://graph.microsoft.com/AgentIdentity.Read.All"] },
    { capabilityId: "graph.agentIdentity.read" },
    { scopes: ["openid", "profile", "offline_access", "https://graph.microsoft.com/AgentIdentity.Read.All"] },
  ])("rejects legacy or broadened interactive flows before URL construction and redemption: %j", async change => {
    const { client } = fakeClient();
    replaceMsalClientForTest(tenantId, client);
    const flow = createAuthFlow("login", { tenantId, username: account.username });
    Object.assign(flow, change);
    await expect(createAuthorizationUrl(flow)).rejects.toMatchObject({ status: 410, code: "admin_managed_permissions" });
    await expect(redeemAuthorizationCode("code", flow)).rejects.toMatchObject({ status: 410, code: "admin_managed_permissions" });
    expect(client.getAuthCodeUrl).not.toHaveBeenCalled();
    expect(client.acquireTokenByCode).not.toHaveBeenCalled();
  });

  it("silently acquires the externally pregranted narrow agent identity permission without a broader fallback", async () => {
    const { client } = fakeClient();
    replaceMsalClientForTest(tenantId, client);
    const scope = "https://graph.microsoft.com/AgentIdentity.Read.All";
    expect(capabilityScopes("graph.agentIdentity.read")).toEqual([scope]);
    await acquireDelegatedToken(tenantId, account.homeAccountId, "graph.agentIdentity.read");
    expect(client.acquireTokenSilent).toHaveBeenCalledWith(expect.objectContaining({ scopes: [scope] }));
    vi.mocked(client.acquireTokenSilent).mockResolvedValue({ accessToken: "opaque", scopes: ["Application.Read.All"],
      account, tenantId, expiresOn: futureExpiry() } as never);
    await expect(acquireDelegatedToken(tenantId, account.homeAccountId, "graph.agentIdentity.read")).rejects.toMatchObject({ status: 403 });
    expect(client.getAuthCodeUrl).not.toHaveBeenCalled();
    expect(client.acquireTokenByCode).not.toHaveBeenCalled();
  });

  it("encodes only authentication scopes with the installed MSAL SDK without token or provider requests", async () => {
    const authority = `https://login.microsoftonline.com/${tenantId}`;
    const networkClient = {
      sendGetRequestAsync: vi.fn(async () => { throw new Error("Unexpected network request"); }),
      sendPostRequestAsync: vi.fn(async () => { throw new Error("Unexpected network request"); }),
    };
    const nativeClient = new ConfidentialClientApplication({
      auth: {
        clientId: tenant.clientId, clientSecret: "fixture", authority,
        cloudDiscoveryMetadata: JSON.stringify({
          tenant_discovery_endpoint: `${authority}/v2.0/.well-known/openid-configuration`,
          metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.microsoftonline.com", aliases: ["login.microsoftonline.com"] }],
        }),
        authorityMetadata: JSON.stringify({
          authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
          token_endpoint: `${authority}/oauth2/v2.0/token`,
          end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
          issuer: `${authority}/v2.0`,
          jwks_uri: `${authority}/discovery/v2.0/keys`,
        }),
      },
      system: { networkClient },
    });
    const flow = createAuthFlow("login", { tenantId, username: account.username });
    replaceMsalClientForTest(tenantId, nativeClient as unknown as MsalClient);
    const url = new URL(await createAuthorizationUrl(flow));
    const requestedScopes = url.searchParams.get("scope")!.split(" ");
    expect([...requestedScopes].sort()).toEqual([...flow.scopes].sort());
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("login_hint")).toBe(account.username);
    expect(url.searchParams.get("client_id")).toBe(tenant.clientId);
    expect(url.pathname).toBe(`/${tenantId}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get("state")).toBe(flow.state);
    expect(url.searchParams.get("nonce")).toBe(flow.nonce);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(networkClient.sendGetRequestAsync).not.toHaveBeenCalled();
    expect(networkClient.sendPostRequestAsync).not.toHaveBeenCalled();
  });

  it("isolates delegated requests by account, resource, and capability scopes", async () => {
    const { client } = fakeClient();
    replaceMsalClientForTest(tenantId, client);
    await acquireDelegatedToken(tenantId, "account-a", "graph.package.read.delegated");
    await acquireDelegatedToken(tenantId, "account-a", "powerPlatform.inventory.read");
    expect(client.acquireTokenSilent).toHaveBeenNthCalledWith(1, expect.objectContaining({ account, scopes: ["https://graph.microsoft.com/CopilotPackages.Read.All"] }));
    expect(client.acquireTokenSilent).toHaveBeenNthCalledWith(2, expect.objectContaining({ account, scopes: ["https://api.powerplatform.com/ResourceQuery.Resources.Read"] }));
    await expect(acquireDelegatedToken(tenantId, "missing", "graph.package.read.delegated")).rejects.toMatchObject({ code: "interaction_required" });
  });

  it("retains only bounded documented provider role-template IDs", () => {
    const user = toAuthenticatedUser({
      account,
      idTokenClaims: {
        roles: ["AgentControl.Viewer", "AgentControl.Admin", "AgentControl.Reader", "AgentControl.Operator", "AgentControl.SecurityReader", "AgentControl.Administrator"],
        wids: [inventoryProviderRoleIds.aiReader, inventoryProviderRoleIds.aiReader, "00000000-0000-0000-0000-000000000000", "secret-role-name", 42],
      },
    } as never);
    expect(user.providerRoleIds).toEqual([inventoryProviderRoleIds.aiReader]);
    expect(user.roles).toEqual(["AgentControl.Admin", "AgentControl.Viewer"]);
    const excessive = toAuthenticatedUser({ account, idTokenClaims: { wids: Array.from({ length: 65 }, () => inventoryProviderRoleIds.globalReader) } } as never);
    expect(excessive.providerRoleIds).toEqual([]);
  });

  it("requests application .default and requires the exact app role", async () => {
    const { client } = fakeClient();
    replaceMsalClientForTest(tenantId, client);
    await expect(acquireApplicationToken(tenantId, "graph.package.read.application")).resolves.toBeTruthy();
    expect(client.acquireTokenByClientCredential).toHaveBeenCalledWith({ authority: `https://login.microsoftonline.com/${tenantId}`, scopes: ["https://graph.microsoft.com/.default"] });
    expect(capabilityScopes("defender.hunting.delegated")).toEqual(["https://graph.microsoft.com/ThreatHunting.Read.All"]);
    expect(() => capabilityScopes("reports.official.import")).toThrow("does not use Microsoft authorization");
  });

  it("does not direct a missing application token to user sign-in or MFA", async () => {
    const { client } = fakeClient({ acquireTokenByClientCredential: vi.fn(async () => null) });
    replaceMsalClientForTest(tenantId, client);
    await expect(acquireApplicationToken(tenantId, "graph.package.read.application")).rejects.toMatchObject({
      code: "identity_provider_error", message: expect.stringContaining("administrator must verify the existing app registration"),
    });
    expect(client.getAuthCodeUrl).not.toHaveBeenCalled();
    expect(client.acquireTokenSilent).not.toHaveBeenCalled();
  });

  it("maps interaction, invalid-grant, conditional-access, and provider failures", async () => {
    for (const [errorCode, expectedCode] of [["consent_required", "missing_permission"], ["interaction_required", "interaction_required"], ["invalid_grant", "interaction_required"], ["request_timeout", "identity_provider_error"]]) {
      const { client } = fakeClient({ acquireTokenSilent: vi.fn(async () => { throw { errorCode }; }) });
      replaceMsalClientForTest(tenantId, client);
      await expect(acquireDelegatedToken(tenantId, "account-a", "graph.package.read.delegated")).rejects.toMatchObject({ code: expectedCode });
    }
  });

  it.each(["request_timeout", "network_error", "temporarily_unavailable", "server_error"])(
    "marks the explicit transient %s token error without exposing provider messages or starting consent", async errorCode => {
      const { client } = fakeClient({ acquireTokenSilent: vi.fn(async () => { throw { errorCode, errorMessage: "private-account@example.invalid" }; }) });
      replaceMsalClientForTest(tenantId, client);
      const result = acquireDelegatedToken(tenantId, "account-a", "graph.directory.read");
      await expect(result).rejects.toMatchObject({ code: "identity_provider_error", details: { retryable: true } });
      await result.catch(error => { expect(JSON.stringify(error)).not.toContain("private-account"); });
      expect(client.acquireTokenSilent).toHaveBeenCalledOnce();
      expect(client.getAuthCodeUrl).not.toHaveBeenCalled();
    },
  );

  it.each(["invalid_client", "invalid_scope", "invalid_request"])("does not mark %s as transient", async errorCode => {
    const { client } = fakeClient({ acquireTokenSilent: vi.fn(async () => { throw { errorCode }; }) });
    replaceMsalClientForTest(tenantId, client);
    const result = acquireDelegatedToken(tenantId, "account-a", "graph.directory.read");
    await expect(result).rejects.toMatchObject({ code: "identity_provider_error" });
    await result.catch(error => { expect(error.details).not.toHaveProperty("retryable"); });
    expect(client.getAuthCodeUrl).not.toHaveBeenCalled();
  });

  it("preserves an actual MSAL server throttle rather than immediately retrying it as a generic transient", async () => {
    const { client } = fakeClient({ acquireTokenSilent: vi.fn(async () => { throw { errorCode: "temporarily_unavailable", status: 429 }; }) });
    replaceMsalClientForTest(tenantId, client);
    await expect(acquireDelegatedToken(tenantId, "account-a", "graph.directory.read")).rejects.toMatchObject({
      status: 429, code: "provider_throttled", details: { httpStatus: 429 },
    });
    expect(client.acquireTokenSilent).toHaveBeenCalledOnce();
    expect(client.getAuthCodeUrl).not.toHaveBeenCalled();
  });

  it.each([
    { error: { errorCode: "invalid_grant", subError: "consent_required" }, expected: "missing_permission" },
    { error: { errorCode: "invalid_grant", errorNo: "65001" }, expected: "missing_permission" },
    { error: { errorCode: "invalid_grant", errorMessage: "AADSTS65001: private-account@example.invalid needs consent" }, expected: "missing_permission" },
    { error: { errorCode: "invalid_grant", subError: "additional_action" }, expected: "interaction_required" },
    { error: { errorCode: "invalid_grant", errorNo: "50076" }, expected: "interaction_required" },
    { error: { errorCode: "invalid_grant", errorNo: "53003" }, expected: "interaction_required" },
    { error: { errorCode: "invalid_grant", errorNo: "700082" }, expected: "authorization_expired" },
    { error: { errorCode: "invalid_grant", errorNo: "50173" }, expected: "authorization_expired" },
  ])("distinguishes consent, interaction and expiration for $error", async ({ error, expected }) => {
    const { client } = fakeClient({ acquireTokenSilent: vi.fn(async () => { throw { ...error, correlationId: "safe-request-id", claims: "private-claims" }; }) });
    replaceMsalClientForTest(tenantId, client);
    const result = acquireDelegatedToken(tenantId, "account-a", "graph.directory.read");
    await expect(result).rejects.toMatchObject({ code: expected, details: { correlationId: "safe-request-id" } });
    if (expected === "missing_permission") {
      await expect(result).rejects.toMatchObject({ message: expect.stringContaining("API permissions") });
      await expect(result).rejects.toMatchObject({ message: expect.stringContaining("Grant admin consent") });
    } else if (expected === "interaction_required") {
      await expect(result).rejects.toMatchObject({ message: expect.stringContaining("MFA") });
      await expect(result).rejects.toMatchObject({ message: expect.not.stringContaining("Grant admin consent") });
    }
    expect(client.getAuthCodeUrl).not.toHaveBeenCalled();
    expect(client.acquireTokenByCode).not.toHaveBeenCalled();
    await result.catch(failure => {
      expect(JSON.stringify(failure)).not.toMatch(/private-account|private-claims|errorMessage/);
    });
  });

  it("retains only a safe Entra error number and correlation ID", async () => {
    const { client } = fakeClient({ acquireTokenSilent: vi.fn(async () => { throw {
      errorCode: "invalid_grant", errorNo: "65001", correlationId: "unsafe\nheader", errorMessage: "private details",
    }; }) });
    replaceMsalClientForTest(tenantId, client);
    await expect(acquireDelegatedToken(tenantId, "account-a", "graph.directory.read")).rejects.toMatchObject({
      code: "missing_permission", details: { providerErrorCode: "AADSTS65001" },
    });
  });

  it("rejects missing delegated grants and missing application roles", async () => {
    const missingGrant = fakeClient({ acquireTokenSilent: vi.fn(async () => ({ accessToken: "opaque", scopes: [], account, tenantId, expiresOn: futureExpiry() } as never)) });
    replaceMsalClientForTest(tenantId, missingGrant.client);
    await expect(acquireDelegatedToken(tenantId, "account-a", "graph.package.read.delegated")).rejects.toMatchObject({
      code: "missing_permission", message: expect.stringContaining("Grant admin consent"),
    });

    const missingRole = fakeClient({ acquireTokenByClientCredential: vi.fn(async () => ({ accessToken: jwt({ aud: "https://graph.microsoft.com", tid: tenantId, idtyp: "app", azp: tenant.clientId, roles: [] }), scopes: ["https://graph.microsoft.com/.default"], tenantId, expiresOn: futureExpiry() } as never)) });
    replaceMsalClientForTest(tenantId, missingRole.client);
    await expect(acquireApplicationToken(tenantId, "graph.package.read.application")).rejects.toMatchObject({
      code: "missing_permission", message: expect.stringContaining("Grant admin consent"),
    });
    expect(missingRole.client.getAuthCodeUrl).not.toHaveBeenCalled();
  });

  it("rejects wrong tenant, account, audience, application, and token mode", async () => {
    const cases: Array<{ mode: "delegated" | "application"; result: Record<string, unknown>; code: string }> = [
      { mode: "delegated", result: { accessToken: "opaque", scopes: ["https://graph.microsoft.com/CopilotPackages.Read.All"], account, tenantId: otherTenantId, expiresOn: futureExpiry() }, code: "unauthorized" },
      { mode: "delegated", result: { accessToken: "opaque", scopes: ["https://graph.microsoft.com/CopilotPackages.Read.All"], account: { ...account, homeAccountId: "account-b" }, tenantId, expiresOn: futureExpiry() }, code: "unauthorized" },
      { mode: "delegated", result: { accessToken: "opaque", scopes: ["https://api.powerplatform.com/CopilotPackages.Read.All"], account, tenantId, expiresOn: futureExpiry() }, code: "unauthorized" },
      { mode: "delegated", result: { accessToken: jwt({ aud: "https://graph.microsoft.com", tid: tenantId, idtyp: "app", roles: ["CopilotPackages.Read.All"] }), scopes: ["https://graph.microsoft.com/CopilotPackages.Read.All"], account, tenantId, expiresOn: futureExpiry() }, code: "invalid_token_mode" },
      { mode: "application", result: { accessToken: "opaque", scopes: ["https://graph.microsoft.com/.default"], account, tenantId, expiresOn: futureExpiry() }, code: "invalid_token_mode" },
      { mode: "application", result: { accessToken: jwt({ aud: "https://graph.microsoft.com", tid: tenantId, scp: "CopilotPackages.Read.All" }), scopes: ["https://graph.microsoft.com/.default"], tenantId, expiresOn: futureExpiry() }, code: "invalid_token_mode" },
      { mode: "application", result: { accessToken: jwt({ aud: "https://graph.microsoft.com", tid: tenantId, idtyp: "app", azp: "33333333-3333-3333-3333-333333333333", roles: ["CopilotPackages.Read.All"] }), scopes: ["https://graph.microsoft.com/.default"], tenantId, expiresOn: futureExpiry() }, code: "unauthorized" },
    ];
    for (const value of cases) {
      const overrides = value.mode === "delegated"
        ? { acquireTokenSilent: vi.fn(async () => value.result as never) }
        : { acquireTokenByClientCredential: vi.fn(async () => value.result as never) };
      const { client } = fakeClient(overrides);
      replaceMsalClientForTest(tenantId, client);
      const operation = value.mode === "delegated"
        ? acquireDelegatedToken(tenantId, "account-a", "graph.package.read.delegated")
        : acquireApplicationToken(tenantId, "graph.package.read.application");
      await expect(operation).rejects.toMatchObject({ code: value.code });
    }
  });

  it("rejects expired response metadata and contradictory token times", async () => {
    const expired = fakeClient({ acquireTokenSilent: vi.fn(async () => ({ accessToken: "opaque", scopes: ["https://graph.microsoft.com/CopilotPackages.Read.All"], account, tenantId, expiresOn: new Date(Date.now() - 1) } as never)) });
    replaceMsalClientForTest(tenantId, expired.client);
    await expect(acquireDelegatedToken(tenantId, "account-a", "graph.package.read.delegated")).rejects.toMatchObject({ code: "authorization_expired" });

    const contradictory = fakeClient({ acquireTokenSilent: vi.fn(async () => ({ accessToken: jwt({ aud: "https://graph.microsoft.com", tid: tenantId, scp: "CopilotPackages.Read.All", exp: Math.floor(Date.now() / 1000) - 1 }), scopes: ["https://graph.microsoft.com/CopilotPackages.Read.All"], account, tenantId, expiresOn: futureExpiry() } as never)) });
    replaceMsalClientForTest(tenantId, contradictory.client);
    await expect(acquireDelegatedToken(tenantId, "account-a", "graph.package.read.delegated")).rejects.toMatchObject({ code: "authorization_expired" });
  });

  it("does not mislabel invalid expiry metadata or a future token start time as expired consent", async () => {
    for (const expiresOn of [undefined, new Date("invalid")]) {
      const { client } = fakeClient({ acquireTokenSilent: vi.fn(async () => ({
        accessToken: "opaque", scopes: capabilityScopes("graph.directory.read"), account, tenantId, expiresOn,
      } as never)) });
      replaceMsalClientForTest(tenantId, client);
      await expect(acquireDelegatedToken(tenantId, "account-a", "graph.directory.read")).rejects.toMatchObject({ code: "identity_provider_error" });
    }
    const { client } = fakeClient({ acquireTokenSilent: vi.fn(async () => ({
      accessToken: jwt({ aud: "https://graph.microsoft.com", tid: tenantId, nbf: Math.floor(Date.now() / 1000) + 60 }),
      scopes: capabilityScopes("graph.directory.read"), account, tenantId, expiresOn: futureExpiry(),
    } as never)) });
    replaceMsalClientForTest(tenantId, client);
    await expect(acquireDelegatedToken(tenantId, "account-a", "graph.directory.read")).rejects.toMatchObject({ code: "authorization_not_yet_valid" });
  });

  it("rejects inconsistent callback and refreshed-principal metadata", async () => {
    const flow = createAuthFlow("login", { tenantId, username: account.username });
    const callbackResult = { account, tenantId, idTokenClaims: { nonce: flow.nonce, tid: otherTenantId } };
    const callback = fakeClient({ acquireTokenByCode: vi.fn(async () => callbackResult as never) });
    replaceMsalClientForTest(tenantId, callback.client);
    await expect(redeemAuthorizationCode("code", flow)).rejects.toMatchObject({ code: "unauthorized" });

    const switched = fakeClient({ acquireTokenSilent: vi.fn(async () => ({ account: { ...account, homeAccountId: "account-b" }, tenantId, idTokenClaims: { tid: tenantId, roles: ["AgentControl.Viewer"] } } as never)) });
    replaceMsalClientForTest(tenantId, switched.client);
    await expect(revalidateAuthenticatedUser(tenantId, "account-a")).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("passes PKCE to native MSAL and rejects callback nonce failures", async () => {
    const flow = createAuthFlow("login", { tenantId, username: account.username });
    const getAuthCodeUrl = vi.fn(async () => `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
    const acquireTokenByCode = vi.fn(async () => ({ account, tenantId, idTokenClaims: { tid: tenantId, aud: tenant.clientId, nonce: flow.nonce } } as never));
    const { client } = fakeClient({ getAuthCodeUrl, acquireTokenByCode });
    replaceMsalClientForTest(tenantId, client);
    await createAuthorizationUrl(flow);
    expect(getAuthCodeUrl).toHaveBeenCalledWith(expect.objectContaining({ codeChallengeMethod: "S256", codeChallenge: expect.not.stringContaining(flow.codeVerifier) }));
    expect(vi.mocked(client.getAuthCodeUrl).mock.calls[0][0]).not.toHaveProperty("extraScopesToConsent");
    await redeemAuthorizationCode("authorization-code", flow);
    expect(acquireTokenByCode).toHaveBeenCalledWith(expect.objectContaining({ code: "authorization-code", codeVerifier: flow.codeVerifier }));
    expect(acquireTokenByCode).toHaveBeenCalledWith(expect.objectContaining({ scopes: flow.scopes }));
    expect(vi.mocked(client.acquireTokenByCode).mock.calls[0][0]).not.toHaveProperty("extraScopesToConsent");
    expect(flow.scopes.every(scope => !scope.startsWith("https://api.powerplatform.com/"))).toBe(true);

    const badNonce = fakeClient({ acquireTokenByCode: vi.fn(async () => ({ account, tenantId, idTokenClaims: { tid: tenantId, aud: tenant.clientId, nonce: "wrong" } } as never)) });
    replaceMsalClientForTest(tenantId, badNonce.client);
    await expect(redeemAuthorizationCode("authorization-code", flow)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("bounds identity-provider POST requests", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })));
    const pending = expect(msalNetworkClient.sendPostRequestAsync("https://login.microsoftonline.com/fixture", { body: "fixture" })).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(msalNetworkTimeoutMs);
    await pending;
  });

  it("evicts only the selected account", async () => {
    const { client, removeAccount } = fakeClient();
    replaceMsalClientForTest(tenantId, client);
    await evictAccount(tenantId, "account-a");
    await evictAccount(tenantId, "missing");
    expect(removeAccount).toHaveBeenCalledTimes(1);
    expect(removeAccount).toHaveBeenCalledWith(account);
  });

  it("generates isolated PKCE transactions and rejects unsafe returns", () => {
    const first = createAuthFlow("login", { tenantId, username: account.username, returnTo: "/settings?tab=permissions" });
    const second = createAuthFlow("login", { tenantId, username: account.username });
    expect(first.state).not.toBe(second.state);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
    expect(first.returnTo).toBe("/settings?tab=permissions");
    expect(() => createAuthFlow("login", { tenantId, username: account.username, returnTo: "//evil.invalid" })).toThrow("local application path");
  });
});