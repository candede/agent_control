import { afterEach, describe, expect, it, vi } from "vitest";
import { config, loginScopes } from "../config.js";
import { acquireApplicationToken, acquireDelegatedToken, capabilityScopes, createAuthFlow, createAuthorizationUrl, evictAccount, msalNetworkClient, msalNetworkTimeoutMs, redeemAuthorizationCode, replaceMsalClientForTest, revalidateAuthenticatedUser, toAuthenticatedUser, type MsalClient } from "./msal.js";
import { inventoryProviderRoleIds } from "../services/inventoryRoleScope.js";

const tenantId = "11111111-1111-1111-1111-111111111111";
const otherTenantId = "99999999-9999-9999-9999-999999999999";
const account = { homeAccountId: "account-a", tenantId, environment: "login.microsoftonline.com", username: "fixture@example.invalid", localAccountId: "local" };

vi.hoisted(() => { process.env.TENANT_ID = "11111111-1111-1111-1111-111111111111"; process.env.CLIENT_ID = "22222222-2222-2222-2222-222222222222"; process.env.CLIENT_SECRET = "fixture"; });

function jwt(payload: Record<string, unknown>) {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function futureExpiry() {
  return new Date(Date.now() + 60_000);
}

function fakeClient(overrides: Partial<MsalClient> = {}) {
  const removeAccount = vi.fn(async () => undefined);
  const client: MsalClient = {
    getAuthCodeUrl: vi.fn(async () => "https://login.microsoftonline.com/fixture"),
    acquireTokenByCode: vi.fn(),
    acquireTokenSilent: vi.fn(async request => {
      const scopes = request.scopes as string[];
      return { accessToken: "opaque-delegated-provider-token", scopes, account, tenantId, expiresOn: futureExpiry() } as never;
    }),
    acquireTokenByClientCredential: vi.fn(async () => {
      return { accessToken: jwt({ aud: "https://graph.microsoft.com", tid: tenantId, idtyp: "app", azp: config.clientId, roles: ["CopilotPackages.Read.All"], exp: Math.floor(futureExpiry().getTime() / 1000) }), scopes: ["https://graph.microsoft.com/.default"], tenantId, expiresOn: futureExpiry() } as never;
    }),
    getTokenCache: () => ({ getAccountByHomeId: vi.fn(async id => id === account.homeAccountId ? account : null), removeAccount }),
    ...overrides,
  };
  return { client, removeAccount };
}

afterEach(() => {
  replaceMsalClientForTest(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("authentication scopes", () => {
  it("keeps the initial sign-in identity-only", () => {
    expect(loginScopes).toEqual(["openid", "profile"]);
    expect(createAuthFlow("login").scopes).toEqual(["openid", "profile"]);
    expect(capabilityScopes("graph.package.read.delegated")).toEqual(["https://graph.microsoft.com/CopilotPackages.Read.All"]);
    expect(capabilityScopes("powerPlatform.inventory.read")).toEqual(["https://api.powerplatform.com/ResourceQuery.Resources.Read"]);
    expect(capabilityScopes("powerPlatform.quarantine.manage")).toEqual(["https://api.powerplatform.com/CopilotStudio.AdminActions.Invoke"]);
  });

  it("isolates delegated requests by account, resource, and capability scopes", async () => {
    const { client } = fakeClient();
    replaceMsalClientForTest(client);
    await acquireDelegatedToken("account-a", "graph.package.read.delegated");
    await acquireDelegatedToken("account-a", "powerPlatform.inventory.read");
    expect(client.acquireTokenSilent).toHaveBeenNthCalledWith(1, expect.objectContaining({ account, scopes: ["https://graph.microsoft.com/CopilotPackages.Read.All"] }));
    expect(client.acquireTokenSilent).toHaveBeenNthCalledWith(2, expect.objectContaining({ account, scopes: ["https://api.powerplatform.com/ResourceQuery.Resources.Read"] }));
    await expect(acquireDelegatedToken("missing", "graph.package.read.delegated")).rejects.toMatchObject({ code: "interaction_required" });
  });

  it("retains only bounded documented provider role-template IDs", () => {
    const user = toAuthenticatedUser({
      account,
      idTokenClaims: {
        wids: [inventoryProviderRoleIds.aiReader, inventoryProviderRoleIds.aiReader, "00000000-0000-0000-0000-000000000000", "secret-role-name", 42],
      },
    } as never);
    expect(user.providerRoleIds).toEqual([inventoryProviderRoleIds.aiReader]);
    const excessive = toAuthenticatedUser({ account, idTokenClaims: { wids: Array.from({ length: 65 }, () => inventoryProviderRoleIds.globalReader) } } as never);
    expect(excessive.providerRoleIds).toEqual([]);
  });

  it("requests application .default and requires the exact app role", async () => {
    const { client } = fakeClient();
    replaceMsalClientForTest(client);
    await expect(acquireApplicationToken("graph.package.read.application")).resolves.toBeTruthy();
    expect(client.acquireTokenByClientCredential).toHaveBeenCalledWith({ scopes: ["https://graph.microsoft.com/.default"] });
    expect(capabilityScopes("defender.hunting.delegated")).toEqual(["https://graph.microsoft.com/ThreatHunting.Read.All"]);
    expect(() => capabilityScopes("reports.official.import")).toThrow("does not use Microsoft authorization");
  });

  it("maps interaction, invalid-grant, conditional-access, and provider failures", async () => {
    for (const [errorCode, expectedCode] of [["consent_required", "interaction_required"], ["interaction_required", "interaction_required"], ["invalid_grant", "authorization_expired"], ["request_timeout", "identity_provider_error"]]) {
      const { client } = fakeClient({ acquireTokenSilent: vi.fn(async () => { throw { errorCode }; }) });
      replaceMsalClientForTest(client);
      await expect(acquireDelegatedToken("account-a", "graph.package.read.delegated")).rejects.toMatchObject({ code: expectedCode });
    }
  });

  it("rejects missing delegated grants and missing application roles", async () => {
    const missingGrant = fakeClient({ acquireTokenSilent: vi.fn(async () => ({ accessToken: "opaque", scopes: [], account, tenantId, expiresOn: futureExpiry() } as never)) });
    replaceMsalClientForTest(missingGrant.client);
    await expect(acquireDelegatedToken("account-a", "graph.package.read.delegated")).rejects.toMatchObject({ code: "missing_permission" });

    const missingRole = fakeClient({ acquireTokenByClientCredential: vi.fn(async () => ({ accessToken: jwt({ aud: "https://graph.microsoft.com", tid: tenantId, idtyp: "app", azp: config.clientId, roles: [] }), scopes: ["https://graph.microsoft.com/.default"], tenantId, expiresOn: futureExpiry() } as never)) });
    replaceMsalClientForTest(missingRole.client);
    await expect(acquireApplicationToken("graph.package.read.application")).rejects.toMatchObject({ code: "missing_permission" });
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
      replaceMsalClientForTest(client);
      const operation = value.mode === "delegated"
        ? acquireDelegatedToken("account-a", "graph.package.read.delegated")
        : acquireApplicationToken("graph.package.read.application");
      await expect(operation).rejects.toMatchObject({ code: value.code });
    }
  });

  it("rejects expired response metadata and contradictory token times", async () => {
    const expired = fakeClient({ acquireTokenSilent: vi.fn(async () => ({ accessToken: "opaque", scopes: ["https://graph.microsoft.com/CopilotPackages.Read.All"], account, tenantId, expiresOn: new Date(Date.now() - 1) } as never)) });
    replaceMsalClientForTest(expired.client);
    await expect(acquireDelegatedToken("account-a", "graph.package.read.delegated")).rejects.toMatchObject({ code: "authorization_expired" });

    const contradictory = fakeClient({ acquireTokenSilent: vi.fn(async () => ({ accessToken: jwt({ aud: "https://graph.microsoft.com", tid: tenantId, scp: "CopilotPackages.Read.All", exp: Math.floor(Date.now() / 1000) - 1 }), scopes: ["https://graph.microsoft.com/CopilotPackages.Read.All"], account, tenantId, expiresOn: futureExpiry() } as never)) });
    replaceMsalClientForTest(contradictory.client);
    await expect(acquireDelegatedToken("account-a", "graph.package.read.delegated")).rejects.toMatchObject({ code: "authorization_expired" });
  });

  it("rejects inconsistent callback and refreshed-principal metadata", async () => {
    const flow = createAuthFlow("consent", { capabilityId: "graph.package.read.delegated", accountId: "account-a" });
    const callbackResult = { account, tenantId, idTokenClaims: { nonce: flow.nonce, tid: otherTenantId } };
    const callback = fakeClient({ acquireTokenByCode: vi.fn(async () => callbackResult as never) });
    replaceMsalClientForTest(callback.client);
    await expect(redeemAuthorizationCode("code", flow)).rejects.toMatchObject({ code: "unauthorized" });

    const switched = fakeClient({ acquireTokenSilent: vi.fn(async () => ({ account: { ...account, homeAccountId: "account-b" }, tenantId, idTokenClaims: { tid: tenantId, roles: ["AgentControl.Reader"] } } as never)) });
    replaceMsalClientForTest(switched.client);
    await expect(revalidateAuthenticatedUser("account-a")).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("passes PKCE to native MSAL and rejects callback nonce failures", async () => {
    const flow = createAuthFlow("login");
    const getAuthCodeUrl = vi.fn(async () => `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
    const acquireTokenByCode = vi.fn(async () => ({ account, tenantId, idTokenClaims: { tid: tenantId, nonce: flow.nonce } } as never));
    const { client } = fakeClient({ getAuthCodeUrl, acquireTokenByCode });
    replaceMsalClientForTest(client);
    await createAuthorizationUrl(flow);
    expect(getAuthCodeUrl).toHaveBeenCalledWith(expect.objectContaining({ codeChallengeMethod: "S256", codeChallenge: expect.not.stringContaining(flow.codeVerifier) }));
    await redeemAuthorizationCode("authorization-code", flow);
    expect(acquireTokenByCode).toHaveBeenCalledWith(expect.objectContaining({ code: "authorization-code", codeVerifier: flow.codeVerifier }));

    const badNonce = fakeClient({ acquireTokenByCode: vi.fn(async () => ({ account, tenantId, idTokenClaims: { tid: tenantId, nonce: "wrong" } } as never)) });
    replaceMsalClientForTest(badNonce.client);
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
    replaceMsalClientForTest(client);
    await evictAccount("account-a");
    await evictAccount("missing");
    expect(removeAccount).toHaveBeenCalledTimes(1);
    expect(removeAccount).toHaveBeenCalledWith(account);
  });

  it("generates isolated PKCE transactions and rejects unsafe returns", () => {
    const first = createAuthFlow("consent", { capabilityId: "graph.directory.read", accountId: "account-a", returnTo: "/settings?tab=permissions" });
    const second = createAuthFlow("consent", { capabilityId: "graph.directory.read", accountId: "account-a" });
    expect(first.state).not.toBe(second.state);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
    expect(first.returnTo).toBe("/settings?tab=permissions");
    expect(() => createAuthFlow("consent", { capabilityId: "graph.directory.read", returnTo: "//evil.invalid" })).toThrow("local application path");
  });
});