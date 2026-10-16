import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { config } from "../config.js";
import { activateAccountSession, clearAccountSessionMutationsForTest, revokeAccountSessionMutations } from "../db/sessions.js";
import * as msal from "./msal.js";
import { createBearerCredentials, createBrowserCredentials, DelegatedCredentialStore, boundedClaimsChallenge } from "./delegatedCredentials.js";
import { account, browserAuthenticationResult, browserSession, epochAuthority, guest, guestHome, guestTenant, native, oboFetcher, sdkResponse, tenant, verifiedBearer } from "./authFoundationTestSupport.js";
import { authExchangeTimeoutMs } from "./boundedAuth.js";
import { browserRequestPrincipal } from "./requestPrincipal.js";
import { withAuthority } from "./authorityContext.js";
import { AppError } from "../errors.js";
import { CapabilityRepository, type CapabilityEvidence } from "../db/capabilities.js";
import { CapabilityService } from "../services/capabilities.js";

const originalTenants = config.tenants;
beforeEach(async () => {
  clearAccountSessionMutationsForTest();
  config.tenants = [tenant];
  await activateAccountSession(tenant.tenantId, account().homeAccountId, async () => undefined);
  await activateAccountSession(tenant.tenantId, account(guest, guestHome, guestTenant).homeAccountId, async () => undefined);
});
afterEach(() => { config.tenants = originalTenants; vi.useRealTimers(); vi.restoreAllMocks(); });

describe("ephemeral exact-principal delegated credentials", () => {
  it.each(["interaction_required", "authorization_expired"])("keeps browser authority current after capability-specific %s", async code => {
    const epochs = epochAuthority();
    const source = createBrowserCredentials(await browserRequestPrincipal(browserSession(), account(), epochs), epochs);
    vi.spyOn(msal, "acquireDelegatedTokenResult")
      .mockRejectedValueOnce(new AppError(401, code, "Synthetic provider authorization required."))
      .mockResolvedValue(browserAuthenticationResult());

    await expect(source.acquire("powerPlatform.inventory.read")).rejects.toMatchObject({ status: 401, code });
    expect(() => source.assertCurrent()).not.toThrow();
    await expect(source.acquire("graph.package.read.delegated")).resolves.toBe("synthetic-revalidation-access");
  });

  it.each(["interaction_required", "authorization_expired"])("reports %s as capability evidence without invalidating a valid browser session", async code => {
    const epochs = epochAuthority();
    const source = createBrowserCredentials(await browserRequestPrincipal(browserSession(), account(), epochs), epochs);
    const acquire = vi.spyOn(msal, "acquireDelegatedTokenResult").mockImplementation(async (_tenant, _principal, capabilityId) => {
      if (capabilityId === "powerPlatform.inventory.read") throw new AppError(401, code, "Synthetic provider authorization required.");
      return browserAuthenticationResult();
    });
    const repository = new CapabilityRepository();
    const evidence = new Map<string, CapabilityEvidence>();
    vi.spyOn(repository, "configuration").mockResolvedValue({ enabled: false, sharedDataScope: false, previewQualified: false, revision: 1 });
    vi.spyOn(repository, "evidence").mockImplementation(async key => evidence.get(JSON.stringify(key)));
    vi.spyOn(repository, "recordEvidence").mockImplementation(async (key, status, details, ttl, publicationFence) => {
      publicationFence();
      const now = new Date();
      const value = { status, details, observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl).toISOString(),
        lastSuccessAt: status === "available" ? now.toISOString() : undefined };
      evidence.set(JSON.stringify(key), value);
      return value;
    });
    const checks = new CapabilityService(repository, {
      packageProbe: vi.fn(async () => []), directoryProbe: vi.fn(async () => []), inventoryProbe: vi.fn(async () => []),
    });
    const result = await withAuthority(source, () => checks.check(browserSession().user!));

    expect(result.find(view => view.definition.id === "powerPlatform.inventory.read")?.decision)
      .toMatchObject({ status: "unknown", evidence: { category: code } });
    expect(result.find(view => view.definition.id === "graph.package.read.delegated")?.decision.status).toBe("available");
    expect(acquire).toHaveBeenCalled();
    expect(() => source.assertCurrent()).not.toThrow();
  });

  it.each(["interaction_required", "authorization_expired"])("still revokes browser authority when identity revalidation returns %s", async code => {
    const epochs = epochAuthority();
    const source = createBrowserCredentials(await browserRequestPrincipal(browserSession(), account(), epochs), epochs);
    vi.spyOn(msal, "revalidateAuthenticatedUserResult").mockRejectedValue(new AppError(401, code, "Synthetic identity authorization required."));
    await expect(source.revalidate()).rejects.toMatchObject({ status: 401, code });
    expect(() => source.assertCurrent()).toThrow(expect.objectContaining({ code: "authorization_required" }));
  });

  it.each([
    { oid: native, uid: native, utid: tenant.tenantId },
    { oid: guest, uid: guestHome, utid: guestTenant },
  ])("reauthorizes only new native/guest issuance and leaves stale assertions, grants and worker references fenced %j", async ({ oid, uid, utid }) => {
    const epochs = epochAuthority(), fetcher = oboFetcher({ oid, uid, utid });
    const oldAssertion = await verifiedBearer({ oid });
    const old = await createBearerCredentials(oldAssertion, epochs, { fetcher });
    const store = new DelegatedCredentialStore();
    const oldReference = store.retain(old);
    const cutoff = Date.now();
    await revokeAccountSessionMutations(tenant.tenantId, `${uid}.${utid}`, async () => {
      epochs.sessionEpoch.mockResolvedValue("2");
      epochs.bearerAuthority.mockResolvedValue({ epoch: "2", issuedAfter: String(cutoff) });
    });
    await expect(createBearerCredentials(oldAssertion, epochs, { fetcher })).rejects.toMatchObject({ code: "unauthorized" });
    vi.spyOn(Date, "now").mockReturnValue(cutoff + 2000);
    const freshAssertion = await verifiedBearer({ oid });
    const [first, second] = await Promise.all([
      createBearerCredentials(freshAssertion, epochs, { fetcher: oboFetcher({ oid, uid, utid, accessToken: "first-independent-grant" }) }),
      createBearerCredentials(freshAssertion, epochs, { fetcher: oboFetcher({ oid, uid, utid, accessToken: "second-independent-grant" }) }),
    ]);
    expect(first.principal.sessionEpoch).toBe("2");
    expect(first.reference.id).not.toBe(second.reference.id);
    await expect(first.acquire("graph.package.read.delegated")).resolves.toBe("first-independent-grant");
    await expect(second.acquire("graph.package.read.delegated")).resolves.toBe("second-independent-grant");
    await expect(createBearerCredentials(oldAssertion, epochs, { fetcher })).rejects.toMatchObject({ code: "unauthorized" });
    expect(() => old.assertCurrent()).toThrow(expect.objectContaining({ code: "unauthorized" }));
    await expect(old.acquire("graph.package.read.delegated")).rejects.toMatchObject({ code: "unauthorized" });
    expect(() => store.reauthorize(oldReference, first)).toThrow(expect.objectContaining({ code: "authorization_required" }));
    first.assertCurrent(); second.assertCurrent();
  });

  it("refuses assertions verified before revocation while their actual SDK bootstrap is pending", async () => {
    const epochs = epochAuthority(), verified = await verifiedBearer();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const fetcher = oboFetcher();
    fetcher.mockImplementationOnce(async (_url, request) => { entered(); await blocked; return sdkResponse({}, request); });
    const pending = createBearerCredentials(verified, epochs, { fetcher });
    const rejected = expect(pending).rejects.toMatchObject({ code: "unauthorized" });
    await started;
    await revokeAccountSessionMutations(tenant.tenantId, account().homeAccountId, async () => {
      epochs.sessionEpoch.mockResolvedValue("2");
      epochs.bearerAuthority.mockResolvedValue({ epoch: "2", issuedAfter: String(Date.now()) });
    });
    release();
    await rejected;
    expect(epochs.bearerAuthority).not.toHaveBeenCalled();
  });

  it("serializes revocation during durable bootstrap and never adopts the later epoch", async () => {
    const epochs = epochAuthority(), verified = await verifiedBearer();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    epochs.bearerAuthority.mockImplementationOnce(async () => { entered(); await blocked; return { epoch: "1", issuedAfter: "0" }; });
    const pending = createBearerCredentials(verified, epochs, { fetcher: oboFetcher() });
    const rejected = expect(pending).rejects.toMatchObject({ code: "unauthorized" });
    await started;
    const cutoff = Date.now();
    const revoking = revokeAccountSessionMutations(tenant.tenantId, account().homeAccountId, async () => {
      epochs.sessionEpoch.mockResolvedValue("2");
      epochs.bearerAuthority.mockResolvedValue({ epoch: "2", issuedAfter: String(cutoff) });
    });
    release();
    await rejected; await revoking;
    vi.spyOn(Date, "now").mockReturnValue(cutoff + 2000);
    const fresh = await createBearerCredentials(await verifiedBearer(), epochs, { fetcher: oboFetcher() });
    expect(fresh.principal.sessionEpoch).toBe("2");
  });

  it("releases cancelled bootstrap serialization and rejects its eventual late epoch result", async () => {
    const epochs = epochAuthority(), verified = await verifiedBearer();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    epochs.bearerAuthority.mockImplementationOnce(async () => { entered(); await blocked; return { epoch: "1", issuedAfter: "0" }; });
    const controller = new AbortController();
    const pending = createBearerCredentials(verified, epochs, { fetcher: oboFetcher(), signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: "authentication_cancelled" });
    await started; controller.abort(); await rejected;
    const fresh = await createBearerCredentials(verified, epochs, { fetcher: oboFetcher() });
    fresh.assertCurrent();
    release();
    await Promise.resolve();
    fresh.assertCurrent();
  });

  it("cannot use another principal's source or a reconstructed assertion to reopen a revoked account", async () => {
    const epochs = epochAuthority();
    const verified = await verifiedBearer();
    const other = await createBearerCredentials(await verifiedBearer({ oid: guest }), epochs, {
      fetcher: oboFetcher({ oid: guest, uid: guestHome, utid: guestTenant }),
    });
    const cutoff = Date.now();
    await revokeAccountSessionMutations(tenant.tenantId, account().homeAccountId, async () => undefined);
    vi.spyOn(Date, "now").mockReturnValue(cutoff + 2000);
    await expect(createBearerCredentials({ ...verified, issuedAt: Date.now() }, epochs, { fetcher: oboFetcher() }))
      .rejects.toMatchObject({ code: "invalid_bearer" });
    const fresh = await verifiedBearer();
    await expect(withAuthority(other, () => createBearerCredentials(fresh, epochs, { fetcher: oboFetcher() })))
      .rejects.toMatchObject({ code: "unauthorized" });
    other.assertCurrent();
    await expect(createBearerCredentials(verified, epochs, { fetcher: oboFetcher() })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("uses supported actual SDK OBO with exact provider audiences and no provider data request or browser cache", async () => {
    const fetcher = oboFetcher();
    const browser = vi.spyOn(msal, "acquireDelegatedTokenResult");
    const source = await createBearerCredentials(await verifiedBearer({ roles: ["AgentControl.Admin"] }), epochAuthority(), { fetcher });
    await expect(source.acquire("graph.package.read.delegated")).resolves.toBe("synthetic-opaque-provider-access");
    await expect(source.acquire("powerPlatform.inventory.read")).resolves.toBe("synthetic-opaque-provider-access");
    expect(browser).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [url, request] of fetcher.mock.calls) {
      const endpoint = new URL(String(url));
      expect(`${endpoint.origin}${endpoint.pathname}`).toBe(`https://login.microsoftonline.com/${tenant.tenantId}/oauth2/v2.0/token`);
      expect([...endpoint.searchParams.keys()]).toEqual(["client-request-id"]);
      const body = new URLSearchParams(String(request?.body));
      expect(body.get("client_id")).toBe(tenant.clientId);
      expect(body.get("requested_token_use")).toBe("on_behalf_of");
      expect(body.get("client_info")).toBe("1");
      expect(body.get("assertion")).toBeTruthy();
    }
    const scopes = fetcher.mock.calls.map(([, request]) => new URLSearchParams(String(request?.body)).get("scope")!);
    expect(scopes[0]).toContain("https://graph.microsoft.com/User.ReadBasic.All");
    expect(scopes[1]).toContain("https://graph.microsoft.com/CopilotPackages.Read.All");
    expect(scopes[2]).toContain("https://api.powerplatform.com/");
    expect(scopes[2]).not.toContain("graph.microsoft.com");
  });

  it("coalesces concurrent acquisition only within exact source/capability; grants never cross accounts or connections", async () => {
    const firstFetcher = oboFetcher();
    const secondFetcher = oboFetcher({ oid: guest, uid: guestHome, utid: guestTenant, accessToken: "second-private-grant" });
    const first = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: firstFetcher });
    const second = await createBearerCredentials(await verifiedBearer({ oid: guest }), epochAuthority(), { fetcher: secondFetcher });
    const [one, two, other] = await Promise.all([
      first.acquire("graph.package.read.delegated"), first.acquire("graph.package.read.delegated"),
      second.acquire("graph.package.read.delegated"),
    ]);
    expect(one).toBe(two);
    expect(other).toBe("second-private-grant");
    expect(firstFetcher).toHaveBeenCalledTimes(2);
    expect(secondFetcher).toHaveBeenCalledTimes(2);
    const anotherConnection = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: oboFetcher() });
    expect(anotherConnection.reference.id).not.toBe(first.reference.id);
  });

  it("bounds worker references, survives request cancellation through retained authority, but restart requires same-principal reauthorization", async () => {
    const controller = new AbortController();
    const source = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: oboFetcher(), signal: controller.signal });
    const store = new DelegatedCredentialStore(2);
    const reference = store.retain(source);
    controller.abort();
    await expect(store.resolve(reference, source.principal).acquire("graph.package.read.delegated")).resolves.toBe("synthetic-opaque-provider-access");
    const restarted = new DelegatedCredentialStore();
    expect(() => restarted.resolve(reference, source.principal)).toThrow(expect.objectContaining({ code: "authorization_required" }));
    const other = await createBearerCredentials(await verifiedBearer({ oid: guest }), epochAuthority(), { fetcher: oboFetcher({ oid: guest, uid: guestHome, utid: guestTenant }) });
    expect(() => store.resolve(reference, other.principal)).toThrow(expect.objectContaining({ code: "authorization_required" }));
    expect(() => restarted.reauthorize(reference, other)).toThrow(expect.objectContaining({ code: "authorization_required" }));
    const fresh = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: oboFetcher() });
    const renewed = restarted.reauthorize(reference, fresh);
    expect(restarted.reauthorize(renewed, fresh).id).toBe(renewed.id);
    expect(() => fresh.assertCurrent()).not.toThrow();
    expect(renewed.id).not.toBe(reference.id);
    expect(restarted.resolve(renewed, fresh.principal).principal.principalId).toBe(source.principal.principalId);
    expect(() => restarted.resolve({ ...renewed, authorizationHash: "tampered" }, fresh.principal)).toThrow(expect.objectContaining({ code: "authorization_required" }));
    expect(() => restarted.resolve(renewed, { ...fresh.principal })).toThrow(expect.objectContaining({ code: "unauthorized" }));
  });

  it("rejects reauthorization of a substituted reference without revoking another principal", async () => {
    const source = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: oboFetcher() });
    const other = await createBearerCredentials(await verifiedBearer({ oid: guest }), epochAuthority(), {
      fetcher: oboFetcher({ oid: guest, uid: guestHome, utid: guestTenant }),
    });
    const store = new DelegatedCredentialStore();
    const reference = store.retain(source);
    const otherReference = store.retain(other);
    const fresh = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: oboFetcher() });
    expect(() => store.reauthorize({ ...reference, id: otherReference.id }, fresh))
      .toThrow(expect.objectContaining({ code: "authorization_required" }));
    expect(() => other.assertCurrent()).not.toThrow();
    expect(store.resolve(otherReference, other.principal)).toBe(other);
    expect(store.resolve(reference, source.principal)).toBe(source);
  });

  it("separates connection disconnect from account-wide existing generation revocation", async () => {
    const first = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: oboFetcher() });
    const second = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: oboFetcher() });
    const store = new DelegatedCredentialStore();
    const one = store.retain(first), two = store.retain(second);
    store.disconnect(one.id);
    expect(() => store.resolve(one, first.principal)).toThrow();
    expect(store.resolve(two, second.principal)).toBe(second);
    await revokeAccountSessionMutations(tenant.tenantId, account().homeAccountId, async () => undefined);
    expect(() => second.assertCurrent()).toThrow(expect.objectContaining({ code: "unauthorized" }));
    await activateAccountSession(tenant.tenantId, account().homeAccountId, async () => undefined);
    expect(() => second.assertCurrent()).toThrow(expect.objectContaining({ code: "unauthorized" }));
    const other = await createBearerCredentials(await verifiedBearer({ oid: guest }), epochAuthority(), { fetcher: oboFetcher({ oid: guest, uid: guestHome, utid: guestTenant }) });
    store.retain(other);
    store.revokePrincipal(tenant.tenantId, account().homeAccountId);
    expect(() => second.assertCurrent()).toThrow();
    other.assertCurrent();
  });

  it("fences durable epoch changes before token acquisition and after awaited exchange", async () => {
    const epochs = epochAuthority();
    const fetcher = oboFetcher();
    const source = await createBearerCredentials(await verifiedBearer(), epochs, { fetcher });
    epochs.sessionEpoch.mockResolvedValue("2");
    await expect(source.acquire("graph.package.read.delegated")).rejects.toMatchObject({ code: "authorization_required" });
    expect(fetcher).toHaveBeenCalledOnce();
    const secondEpochs = epochAuthority();
    const secondFetcher = oboFetcher();
    const second = await createBearerCredentials(await verifiedBearer(), secondEpochs, { fetcher: secondFetcher });
    secondFetcher.mockImplementationOnce(async (_url, request) => {
      secondEpochs.sessionEpoch.mockResolvedValue("2");
      secondEpochs.bearerAuthority.mockResolvedValue({ epoch: "2", issuedAfter: "0" });
      return sdkResponse({}, request);
    });
    await expect(second.acquire("graph.package.read.delegated")).rejects.toMatchObject({ code: "principal_mapping_unavailable" });
  });

  it("rejects changed provider identity, wrong audience, permissions and app-only responses without returning tokens", async () => {
    for (const options of [
      { oid: guest }, { clientInfo: false },
      { accessToken: `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ aud: "https://attacker.invalid" })).toString("base64url")}.sig` },
      { scope: "openid profile" },
      { accessToken: `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ idtyp: "app" })).toString("base64url")}.sig` },
    ]) {
      const fetcher = oboFetcher();
      const source = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher });
      fetcher.mockImplementationOnce(async (_url, request) => sdkResponse(options, request));
      await expect(source.acquire("graph.package.read.delegated")).rejects.toBeInstanceOf(Error);
    }
  });

  it("preserves actual claims challenge as bounded reauthorization, revokes the source and never retries writes", async () => {
    const fetcher = oboFetcher();
    const source = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher });
    const claims = JSON.stringify({ access_token: { polids: { essential: true, values: [guestHome] } } });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: "interaction_required", error_description: "private error body",
      claims, access_token: "private-body-token" }), { status: 400 }));
    const error = await source.acquire("graph.package.read.delegated").catch(error => error);
    expect(error).toMatchObject({ status: 401, code: "claims_challenge", details: { claims } });
    expect(JSON.stringify(error)).not.toMatch(/private-body-token|private error body/);
    expect(() => source.assertCurrent()).toThrow(expect.objectContaining({ code: "authorization_required" }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized or malformed claims challenges instead of reflecting raw response data", () => {
    for (const value of ["not-json", "x".repeat(4097), JSON.stringify({ access_token: {}, secret: "raw" }),
      JSON.stringify({ access_token: { polids: { arbitrary: "private" } } })]) expect(boundedClaimsChallenge(value)).toBeUndefined();
  });

  it("honors throttling cooldown and permits only explicit bounded subsequent token retries", async () => {
    vi.useFakeTimers();
    const fetcher = oboFetcher();
    const source = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher });
    fetcher.mockResolvedValueOnce(new Response("private throttle body", { status: 429, headers: { "retry-after": "60" } }));
    await expect(source.acquire("graph.package.read.delegated")).rejects.toMatchObject({ code: "provider_throttled", retryAfterSeconds: 60 });
    await expect(source.acquire("graph.package.read.delegated")).rejects.toMatchObject({ code: "provider_throttled", retryAfterSeconds: 60 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(source.acquire("graph.package.read.delegated")).resolves.toBe("synthetic-opaque-provider-access");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("cancels only departing waiters and rejects late results after all waiters cancel", async () => {
    const fetcher = oboFetcher();
    const source = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fetcher.mockImplementationOnce(async (_url, request) => { await gate; return sdkResponse({}, request); });
    const controller = new AbortController();
    const first = source.acquire("graph.package.read.delegated", controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ code: "authentication_cancelled" });
    const second = source.acquire("graph.package.read.delegated");
    controller.abort(); release();
    await rejected;
    await expect(second).resolves.toBe("synthetic-opaque-provider-access");
    const all = new AbortController();
    const never = new Promise<Response>(() => {});
    fetcher.mockImplementationOnce(async () => never);
    const pending = source.acquire("graph.package.read.delegated", all.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ code: "authentication_cancelled" });
    all.abort();
    await cancelled;
    source.revoke();
  });

  it("bounds the whole exchange including stalled networking and enforces provider expiry before assertion expiry", async () => {
    vi.useFakeTimers();
    const fetcher = oboFetcher();
    const source = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher });
    fetcher.mockImplementationOnce(async () => new Promise(() => {}));
    const pending = source.acquire("graph.package.read.delegated");
    const timeout = expect(pending).rejects.toMatchObject({ code: "authentication_timeout" });
    await vi.advanceTimersByTimeAsync(authExchangeTimeoutMs);
    await timeout;
    source.revoke();
    const short = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: oboFetcher({ expiresIn: 30 }) });
    await short.acquire("graph.package.read.delegated");
    expect(short.expiresAt).toBeLessThan(short.principal.expiresAt);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(() => short.assertCurrent()).toThrow(expect.objectContaining({ code: "authorization_required" }));
  });

  it("bounds bootstrap epoch reads and rejects expired/malformed metadata or redirected token exchanges", async () => {
    vi.useFakeTimers();
    const verified = await verifiedBearer();
    const epochs = epochAuthority();
    epochs.bearerAuthority.mockImplementationOnce(async () => new Promise(() => {}));
    const pending = createBearerCredentials(verified, epochs, { fetcher: oboFetcher() });
    const rejected = expect(pending).rejects.toMatchObject({ code: "authentication_timeout" });
    await vi.advanceTimersByTimeAsync(authExchangeTimeoutMs);
    await rejected;
    const metadata = await sdkResponse().json();
    for (const response of [
      sdkResponse({ expiresIn: 0 }), sdkResponse({ scope: "" }), new Response("invalid-json"),
      new Response(JSON.stringify({ ...metadata, expires_in: "30junk" })),
      new Response(JSON.stringify({ ...metadata, expires_in: null })),
      new Response(JSON.stringify({ ...metadata, expires_in: 48 * 3600 + 1 })),
      new Response(JSON.stringify({ ...metadata, scope: undefined })),
      new Response(null, { status: 302, headers: { location: "https://attacker.invalid" } }),
      new Response("x".repeat(128 * 1024 + 1)),
    ]) {
      await expect(createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: vi.fn<typeof fetch>(async () => response) })).rejects.toBeInstanceOf(Error);
    }
  });

  it("revalidates bearer metadata without relabeling API role evidence or accepting lost bootstrap grants", async () => {
    const fetcher = oboFetcher();
    const source = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher });
    const issuedAt = source.principal.rolesValidatedAt;
    expect((await source.revalidate()).rolesValidatedAt).toBe(issuedAt);
    fetcher.mockImplementationOnce(async (_url, request) => sdkResponse({ scope: "openid profile" }, request));
    await expect(source.revalidate()).rejects.toMatchObject({ code: "missing_permission" });
  });

  it("does not refresh old bearer role evidence and preserves browser revalidation through the existing MSAL adapter", async () => {
    vi.useFakeTimers();
    const fetcher = oboFetcher();
    const source = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher });
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(source.revalidate()).rejects.toMatchObject({ code: "authorization_stale" });
    expect(fetcher).toHaveBeenCalledOnce();
    const session = browserSession();
    const principal = await browserRequestPrincipal(session, account(), epochAuthority());
    const browser = createBrowserCredentials(principal, epochAuthority());
    vi.spyOn(msal, "revalidateAuthenticatedUserResult").mockResolvedValue(browserAuthenticationResult());
    await vi.advanceTimersByTimeAsync(300_000);
    const refreshed = await browser.revalidate();
    expect(refreshed.roles).toEqual(["AgentControl.Admin"]);
    expect(refreshed.authorizationHash).not.toBe(principal.authorizationHash);
    expect(msal.revalidateAuthenticatedUserResult).toHaveBeenCalledExactlyOnceWith(tenant.tenantId, account().homeAccountId);
  });

  it("rejects browser local-account substitution and fences late MSAL results after cancellation", async () => {
    const source = createBrowserCredentials(await browserRequestPrincipal(browserSession(), account(), epochAuthority()), epochAuthority());
    vi.spyOn(msal, "revalidateAuthenticatedUserResult").mockResolvedValue({ ...browserAuthenticationResult(), account: account(guest) });
    await expect(source.revalidate()).rejects.toMatchObject({ code: "unauthorized" });
    const fresh = createBrowserCredentials(await browserRequestPrincipal(browserSession(), account(), epochAuthority()), epochAuthority());
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(msal.revalidateAuthenticatedUserResult).mockImplementation(async () => { await gate; return browserAuthenticationResult(); });
    const original = fresh.principal;
    const pending = fresh.revalidate(controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "authentication_cancelled" });
    controller.abort(); release();
    await rejected;
    expect(fresh.principal).toBe(original);
  });

  it("enforces capacity and rejects application/local modes or absent API roles before provider dispatch", async () => {
    const fetcher = oboFetcher();
    const source = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher });
    const store = new DelegatedCredentialStore(1);
    store.retain(source);
    const second = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: oboFetcher() });
    expect(() => store.retain(second)).toThrow(expect.objectContaining({ code: "credential_capacity" }));
    await expect(source.acquire("graph.package.read.application")).rejects.toMatchObject({ code: "invalid_token_mode" });
    await expect(source.acquire("graph.package.block.manage")).rejects.toMatchObject({ code: "missing_internal_role" });
    expect(fetcher).toHaveBeenCalledOnce();
    const failure = new Error("unexpected authority failure");
    const assertion = vi.spyOn(source, "assertCurrent").mockImplementation(() => { throw failure; });
    expect(() => store.retain(second)).toThrow(failure);
    assertion.mockRestore();
    expect(store.resolve(source.reference, source.principal)).toBe(source);
  });

  it("serializes only bounded non-secret provenance and remains unregistered on every production route", async () => {
    const assertion = await verifiedBearer();
    const source = await createBearerCredentials(assertion, epochAuthority(), { fetcher: oboFetcher() });
    await source.acquire("graph.package.read.delegated");
    const serialized = JSON.stringify({ principal: source.principal, reference: source.reference, source });
    expect(serialized).not.toMatch(/synthetic-opaque-provider-access|synthetic-foundation-secret|accessToken|clientSecret|oboAssertion/);
    expect(inspect(source, { depth: 10 })).not.toMatch(/synthetic-opaque-provider-access|synthetic-foundation-secret|accessToken|clientSecret|oboAssertion/);
    expect(source.principal.localAccountId).toBe(native);
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    for (const path of ["src/app.ts", "src/middleware/auth.ts", "src/routes/policy.ts"]) {
      expect(readFileSync(resolve(root, "backend", path), "utf8")).not.toMatch(/mcpBearer|delegatedCredentials|requestPrincipal/);
    }
  });
});
