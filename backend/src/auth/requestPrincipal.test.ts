import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { activateAccountSession, clearAccountSessionMutationsForTest, revokeAccountSessionMutations } from "../db/sessions.js";
import { inventoryProviderRoleIds } from "../services/inventoryRoleScope.js";
import { principalAuthorizationHash } from "../services/reportIdentity.js";
import { hasAppRole } from "../types/capability.js";
import { createBearerCredentials } from "./delegatedCredentials.js";
import { account, browserSession, epochAuthority, guest, guestHome, guestTenant, native, oboFetcher, tenant, verifiedBearer } from "./authFoundationTestSupport.js";
import { assertFreshPrincipal, browserRequestPrincipal } from "./requestPrincipal.js";

const originalTenants = config.tenants;
beforeEach(async () => {
  clearAccountSessionMutationsForTest();
  config.tenants = [tenant];
  for (const id of [account().homeAccountId, account(guest, guestHome, guestTenant).homeAccountId]) {
    await activateAccountSession(tenant.tenantId, id, async () => undefined);
  }
});
afterEach(() => { config.tenants = originalTenants; vi.useRealTimers(); vi.restoreAllMocks(); });

describe("one verified private request principal", () => {
  it("caps rolling browser cookies at the original sign-in ceiling without requiring a cache for saved reads", async () => {
    const session = browserSession(account());
    session.cookie.expires = new Date(session.signedInAt! + 9 * 60 * 60_000);
    const principal = await browserRequestPrincipal(session, null, epochAuthority());
    expect(principal.expiresAt).toBe(session.signedInAt! + 8 * 60 * 60_000);
    expect(principal.localAccountId).toBe("");
    expect(principal.principalId).toBe(account().homeAccountId);
  });
  it.each([
    { oid: native, uid: native, utid: tenant.tenantId },
    { oid: guest, uid: guestHome, utid: guestTenant },
  ])("preserves actual SDK browser/bearer identity parity for %j without cached browser login", async ({ oid, uid, utid }) => {
    const epochs = epochAuthority();
    const bearer = await createBearerCredentials(await verifiedBearer({ oid }), epochs, { fetcher: oboFetcher({ oid, uid, utid }) });
    const browser = await browserRequestPrincipal(browserSession(account(oid, uid, utid)), account(oid, uid, utid), epochs);
    expect(bearer.principal.principalId).toBe(`${uid}.${utid}`);
    expect(bearer.principal.principalId).toBe(browser.principalId);
    expect(bearer.principal.authorizationHash).toBe(browser.authorizationHash);
    expect(bearer.principal.sessionEpoch).toBe(browser.sessionEpoch);
    expect(bearer.principal.localAccountId).toBe(oid);
    expect(bearer.principal.transport).toBe("bearer");
    expect(browser.integrationClientId).toBe(tenant.clientId);
    expect(bearer.principal.integrationClientId).toBe(tenant.integration!.clientId);
    if (oid === guest) expect(bearer.principal.principalId).not.toBe(`${oid}.${tenant.tenantId}`);
    expect(Object.isFrozen(bearer.principal)).toBe(true);
    expect(Object.isFrozen(bearer.principal.roles)).toBe(true);
  });

  it.each([
    { clientInfo: false }, { idToken: false },
    { uid: "" }, { utid: "organizations" }, { oid: guest },
    { claims: { oid: guest } }, { claims: { tid: guestTenant } },
    { claims: { aud: tenant.integration!.clientId } },
    { claims: { iss: `https://login.microsoftonline.com/common/v2.0` } },
    { claims: { azp: tenant.integration!.clientId } },
    { claims: { preferred_username: undefined } },
    { claims: { exp: 1 } }, { claims: { iat: Math.floor(Date.now() / 1000) + 60 } },
  ])("explicitly closes admission for unsupported, sub-only or contradictory SDK mapping %j", async options => {
    const epochs = epochAuthority();
    await expect(createBearerCredentials(await verifiedBearer(), epochs, { fetcher: oboFetcher(options) }))
      .rejects.toMatchObject({ code: "principal_mapping_unavailable" });
    expect(epochs.sessionEpoch).not.toHaveBeenCalled();
    expect(epochs.bearerAuthority).not.toHaveBeenCalled();
  });

  it("keeps verified API roles and allowlisted provider-role hints separate from Graph/OIDC metadata roles", async () => {
    const source = await createBearerCredentials(await verifiedBearer({
      roles: ["AgentControl.Admin"], wids: [inventoryProviderRoleIds.aiReader, "00000000-0000-0000-0000-000000000000"],
    }), epochAuthority(), { fetcher: oboFetcher({ claims: { roles: ["Graph.Admin"], wids: [inventoryProviderRoleIds.globalAdministrator] } }) });
    expect(source.principal.roles).toEqual(["AgentControl.Admin"]);
    expect(source.principal.providerRoleIds).toEqual([inventoryProviderRoleIds.aiReader]);
    expect(hasAppRole(source.principal.roles, "AgentControl.Viewer")).toBe(true);
    expect(source.principal.authorizationHash).toBe(principalAuthorizationHash(tenant.tenantId, account().homeAccountId,
      ["AgentControl.Admin"], [inventoryProviderRoleIds.aiReader]));
  });

  it.each([
    { accountId: "other" }, { clientId: guestHome }, { tenantId: guestTenant },
    { signedInAt: undefined }, { rolesValidatedAt: Infinity }, { signedInAt: Date.now() + 60_000 },
  ])("rejects inconsistent browser metadata without manufacturing sessions %j", async changes => {
    await expect(browserRequestPrincipal({ ...browserSession(), ...changes }, account(), epochAuthority())).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("pins existing account validation across awaited epoch reads; account-wide logout cannot publish a late mapping", async () => {
    const epochs = epochAuthority();
    epochs.sessionEpoch.mockImplementationOnce(async () => {
      await revokeAccountSessionMutations(tenant.tenantId, account().homeAccountId, async () => undefined);
      return "2";
    });
    await expect(browserRequestPrincipal(browserSession(), account(), epochs)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: oboFetcher() })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("uses finite five-minute role freshness and exact auth expiry, not indefinite cached authorization", async () => {
    vi.useFakeTimers();
    const principal = await browserRequestPrincipal(browserSession(), account(), epochAuthority());
    assertFreshPrincipal(principal);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(() => assertFreshPrincipal(principal)).toThrow(expect.objectContaining({ code: "authorization_stale" }));
    expect(() => assertFreshPrincipal({ ...principal, rolesValidatedAt: Date.now() + 1 })).toThrow(expect.objectContaining({ code: "unauthorized" }));
    expect(() => assertFreshPrincipal({ ...principal, expiresAt: Date.now() })).toThrow(expect.objectContaining({ code: "unauthorized" }));
  });
});
