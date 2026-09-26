import type { Request, Response } from "express";
import type { SessionData } from "express-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, type TenantConfiguration } from "../config.js";
import * as msal from "../auth/msal.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { capabilities } from "../services/capabilities.js";
import type { AuthenticatedUser } from "../types/session.js";
import { requestScope, requireSession, roleRevalidationIntervalMs } from "./auth.js";

const tenant: TenantConfiguration = {
  tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222",
  clientSecret: "fixture", domains: ["example.invalid"], displayName: "First tenant",
};
const otherTenant: TenantConfiguration = {
  tenantId: "99999999-9999-9999-9999-999999999999", clientId: "88888888-8888-8888-8888-888888888888",
  clientSecret: "fixture", domains: ["other.invalid"], displayName: "Second tenant",
};
const originalTenants = config.tenants;
const accountId = "same-home-account";

function user(selected = tenant): AuthenticatedUser {
  return { tenantId: selected.tenantId, homeAccountId: accountId, username: `viewer@${selected.domains[0]}`, displayName: "Viewer", roles: ["AgentControl.Viewer"] };
}

function sessionRequest(selected = tenant, changes: Partial<SessionData> = {}) {
  const data = {
    tenantId: selected.tenantId, clientId: selected.clientId, accountId, user: user(selected), rolesValidatedAt: Date.now(),
    save: vi.fn((callback: (error?: Error) => void) => callback()),
    reload: vi.fn((callback: (error?: Error) => void) => callback()),
    destroy: vi.fn((callback: (error?: Error) => void) => callback()),
    ...changes,
  };
  const request = { session: data, params: { tenantId: otherTenant.tenantId }, query: { tenantId: otherTenant.tenantId }, body: { tenantId: otherTenant.tenantId } } as unknown as Request;
  return { request, data };
}

async function authorize(request: Request) {
  const next = vi.fn();
  await requireSession(request, {} as Response, next);
  return next;
}

beforeEach(async () => {
  config.tenants = [tenant, otherTenant];
  vi.spyOn(msal, "revalidateAuthenticatedUser").mockImplementation(async tenantId => user(tenantId === otherTenant.tenantId ? otherTenant : tenant));
  vi.spyOn(capabilities, "invalidatePrincipal").mockResolvedValue(undefined);
  await Promise.all([tenant, otherTenant].map(value => activateAccountSession(value.tenantId, accountId, async () => undefined)));
});
afterEach(() => { config.tenants = originalTenants; vi.restoreAllMocks(); });

describe("tenant-bound session middleware", () => {
  it.each([tenant, otherTenant])("uses only the configured session identity for $displayName", async selected => {
    const { request, data } = sessionRequest(selected);
    expect(requestScope(request)).toEqual({ tenantId: selected.tenantId, principalId: accountId });
    const next = await authorize(request);
    expect(next).toHaveBeenCalledWith();
    expect(data.destroy).not.toHaveBeenCalled();
    expect(msal.revalidateAuthenticatedUser).not.toHaveBeenCalled();
  });

  it.each([
    { clientId: undefined }, { clientId: otherTenant.clientId }, { tenantId: otherTenant.tenantId },
    { tenantId: "unconfigured" }, { accountId: "other-account" }, { user: undefined },
    { user: { ...user(), tenantId: otherTenant.tenantId } },
    { user: { ...user(), roles: undefined } },
  ])("rejects unbound or tampered session identities: %j", async change => {
    const { request, data } = sessionRequest(tenant, change as Partial<SessionData>);
    expect(() => requestScope(request)).toThrow(expect.objectContaining({ code: "unauthorized" }));
    const next = await authorize(request);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "unauthorized" }));
    expect(data.destroy).toHaveBeenCalledOnce();
    expect(msal.revalidateAuthenticatedUser).not.toHaveBeenCalled();
  });

  it.each([tenant, otherTenant])("revalidates only the exact tenant/account for $displayName", async selected => {
    const { request, data } = sessionRequest(selected, { rolesValidatedAt: Date.now() - roleRevalidationIntervalMs });
    const next = await authorize(request);
    expect(msal.revalidateAuthenticatedUser).toHaveBeenCalledExactlyOnceWith(selected.tenantId, accountId);
    expect(data.reload).toHaveBeenCalledOnce();
    expect(data.save).toHaveBeenCalledOnce();
    expect(data.destroy).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it("invalidates only the principal whose roles changed", async () => {
    const changed = { ...user(otherTenant), roles: [] };
    vi.mocked(msal.revalidateAuthenticatedUser).mockResolvedValue(changed);
    const { request } = sessionRequest(otherTenant, { rolesValidatedAt: undefined });
    expect(await authorize(request)).toHaveBeenCalledWith();
    expect(capabilities.invalidatePrincipal).toHaveBeenCalledExactlyOnceWith(changed);
    expect(request.session.user).toEqual(changed);
  });

  it.each([
    user(otherTenant),
    { ...user(), homeAccountId: "different-account" },
  ])("rejects refreshed identities that switch tenants or accounts: %j", async changed => {
    vi.mocked(msal.revalidateAuthenticatedUser).mockResolvedValue(changed);
    const { request, data } = sessionRequest(tenant, { rolesValidatedAt: undefined });
    expect(await authorize(request)).toHaveBeenCalledWith(expect.objectContaining({ code: "unauthorized" }));
    expect(data.destroy).toHaveBeenCalledOnce();
    expect(data.save).not.toHaveBeenCalled();
    expect(capabilities.invalidatePrincipal).not.toHaveBeenCalled();
  });

  it("accepts a canonical UPN change when revalidation preserves tenant and home account ID", async () => {
    const changed = { ...user(), username: "canonical@tenant.onmicrosoft.com" };
    vi.mocked(msal.revalidateAuthenticatedUser).mockResolvedValue(changed);
    const { request, data } = sessionRequest(tenant, { rolesValidatedAt: undefined });
    expect(await authorize(request)).toHaveBeenCalledWith();
    expect(request.session.user).toEqual(changed);
    expect(data.save).toHaveBeenCalledOnce();
    expect(data.destroy).not.toHaveBeenCalled();
    expect(requestScope(request)).toEqual({ tenantId: tenant.tenantId, principalId: accountId });
  });

  it("rejects a client change while role validation reloads the session", async () => {
    const { request, data } = sessionRequest(tenant, { rolesValidatedAt: undefined });
    data.reload.mockImplementation(callback => {
      config.tenants = [{ ...tenant, clientId: otherTenant.clientId }, otherTenant];
      callback();
    });
    expect(await authorize(request)).toHaveBeenCalledWith(expect.objectContaining({ code: "unauthorized" }));
    expect(data.save).not.toHaveBeenCalled();
    expect(data.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a removed tenant but preserves a second tenant with the same account ID", async () => {
    const first = sessionRequest();
    const second = sessionRequest(otherTenant);
    config.tenants = [otherTenant];
    expect(await authorize(first.request)).toHaveBeenCalledWith(expect.objectContaining({ code: "unauthorized" }));
    expect(await authorize(second.request)).toHaveBeenCalledWith();
    expect(requestScope(second.request)).toEqual({ tenantId: otherTenant.tenantId, principalId: accountId });
  });

  it("does not publish an in-flight role refresh after logout in that tenant", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(msal.revalidateAuthenticatedUser).mockImplementation(async () => { await gate; return user(); });
    const first = sessionRequest(tenant, { rolesValidatedAt: undefined });
    const pending = authorize(first.request);
    await revokeAccountSessionMutations(tenant.tenantId, accountId, async () => undefined);
    release();
    expect(await pending).toHaveBeenCalledWith(expect.objectContaining({ code: "unauthorized" }));
    expect(first.data.save).not.toHaveBeenCalled();
    const second = sessionRequest(otherTenant);
    expect(await authorize(second.request)).toHaveBeenCalledWith();
    expect(second.data.destroy).not.toHaveBeenCalled();
  });
});
