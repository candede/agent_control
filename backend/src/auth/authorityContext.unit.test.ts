import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { activateAccountSession, clearAccountSessionMutationsForTest } from "../db/sessions.js";
import { AppError } from "../errors.js";
import { withAuthority, withReadAuthorityRefresh } from "./authorityContext.js";
import { account, browserAuthenticationResult, browserSession, epochAuthority, tenant } from "./authFoundationTestSupport.js";
import { createBrowserCredentials } from "./delegatedCredentials.js";
import { authorizationFreshnessMs } from "./mcpBearer.js";
import * as msal from "./msal.js";
import { browserRequestPrincipal } from "./requestPrincipal.js";

const originalTenants = config.tenants;
const refreshIntervalMs = authorizationFreshnessMs / 2;

beforeEach(async () => {
  vi.useFakeTimers();
  clearAccountSessionMutationsForTest();
  config.tenants = [tenant];
  await activateAccountSession(tenant.tenantId, account().homeAccountId, async () => undefined);
});

afterEach(() => {
  config.tenants = originalTenants;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function browserSource(expiresInMs?: number) {
  const session = browserSession();
  if (expiresInMs !== undefined) session.cookie.expires = new Date(Date.now() + expiresInMs);
  const epochs = epochAuthority();
  return createBrowserCredentials(await browserRequestPrincipal(session, account(), epochs), epochs);
}

describe("browser read authority boundaries", () => {
  it("does not dispatch a read whose controller was already aborted", async () => {
    const source = await browserSource();
    const controller = new AbortController();
    const cancellation = new Error("Read cancelled before dispatch.");
    controller.abort(cancellation);
    const operation = vi.fn(async () => "published");

    await expect(withAuthority(source, () => withReadAuthorityRefresh(controller, operation))).rejects.toBe(cancellation);
    expect(operation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detects changed authorization from a concurrent renewal before postponing its own renewal", async () => {
    const source = await browserSource();
    const revalidate = vi.spyOn(msal, "revalidateAuthenticatedUserResult").mockResolvedValue(browserAuthenticationResult());
    const controller = new AbortController();
    const work = Promise.withResolvers<string>();
    const reading = withAuthority(source, () => withReadAuthorityRefresh(controller, () => work.promise));
    const rejected = expect(reading).rejects.toMatchObject({
      code: "unauthorized", message: "The initiating authorization changed.",
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await source.revalidate();
    await vi.advanceTimersByTimeAsync(refreshIntervalMs - 60_000);
    work.resolve("published");

    await rejected;
    expect(controller.signal.aborted).toBe(true);
    expect(revalidate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("postpones a redundant renewal when concurrent renewal preserved the initiating authorization", async () => {
    const source = await browserSource();
    const result = browserAuthenticationResult();
    const revalidate = vi.spyOn(msal, "revalidateAuthenticatedUserResult").mockResolvedValue({
      ...result, idTokenClaims: { ...result.idTokenClaims, roles: ["AgentControl.Viewer"] },
    });
    const controller = new AbortController();
    const work = Promise.withResolvers<string>();
    const reading = withAuthority(source, () => withReadAuthorityRefresh(controller, () => work.promise));

    await vi.advanceTimersByTimeAsync(60_000);
    await source.revalidate();
    await vi.advanceTimersByTimeAsync(refreshIntervalMs - 1);
    expect(revalidate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(revalidate).toHaveBeenCalledTimes(2);
    work.resolve("published");

    await expect(reading).resolves.toBe("published");
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not postpone revocation checks after concurrent renewal preserved the authorization", async () => {
    const source = await browserSource();
    const result = browserAuthenticationResult();
    const revalidate = vi.spyOn(msal, "revalidateAuthenticatedUserResult").mockResolvedValue({
      ...result, idTokenClaims: { ...result.idTokenClaims, roles: ["AgentControl.Viewer"] },
    });
    const controller = new AbortController();
    const work = Promise.withResolvers<string>();
    const reading = withAuthority(source, () => withReadAuthorityRefresh(controller, () => work.promise));
    const rejected = expect(reading).rejects.toMatchObject({ code: "authorization_required" });

    await vi.advanceTimersByTimeAsync(60_000);
    await source.revalidate();
    source.revoke();
    await vi.advanceTimersByTimeAsync(refreshIntervalMs - 60_000);
    work.resolve("published");

    await rejected;
    expect(controller.signal.aborted).toBe(true);
    expect(revalidate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject"] as const)("preserves an unchanged authority's %s outcome", async outcome => {
    const source = await browserSource();
    const failure = new AppError(502, "provider_error", "Synthetic provider failure.");
    const operation = () => outcome === "resolve" ? Promise.resolve("published") : Promise.reject(failure);
    const reading = withAuthority(source, () => withReadAuthorityRefresh(new AbortController(), operation));

    if (outcome === "resolve") await expect(reading).resolves.toBe("published");
    else await expect(reading).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe.each(["revocation", "expiry", "stale-roles", "role-change"] as const)("%s during a read", invalidation => {
    it.each(["resolve", "reject"] as const)("fences an operation that later %ss", async outcome => {
      const source = await browserSource(invalidation === "expiry" ? 60_000 : undefined);
      const controller = new AbortController();
      const work = Promise.withResolvers<string>();
      const reading = withAuthority(source, () => withReadAuthorityRefresh(controller, () => work.promise));
      const expectedCode = invalidation === "revocation" || invalidation === "expiry" ? "authorization_required"
        : invalidation === "stale-roles" ? "authorization_stale" : "unauthorized";
      const rejected = expect(reading).rejects.toMatchObject({ status: 401, code: expectedCode });

      if (invalidation === "revocation") source.revoke();
      else if (invalidation === "role-change") {
        vi.spyOn(msal, "revalidateAuthenticatedUserResult").mockResolvedValue(browserAuthenticationResult());
        await source.revalidate();
      } else {
        vi.setSystemTime(Date.now() + (invalidation === "expiry" ? 60_000 : authorizationFreshnessMs));
      }
      if (outcome === "resolve") work.resolve("published");
      else work.reject(new AppError(502, "provider_error", "Synthetic provider failure."));

      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
