import session, { type SessionData } from "express-session";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, type TenantConfiguration } from "../config.js";
import { assertCurrentStoredSession, createSessionStore, getValidatedSessionIdentity, revokeAccountSessions } from "./sessions.js";

vi.mock("connect-pg-simple", async () => {
  const { default: sessions } = await import("express-session");
  return { default: () => class extends sessions.MemoryStore {} };
});

const tenant: TenantConfiguration = {
  tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222",
  clientSecret: "fixture", domains: ["example.invalid"], displayName: "First tenant",
};
const otherTenant: TenantConfiguration = {
  tenantId: "99999999-9999-9999-9999-999999999999", clientId: "88888888-8888-8888-8888-888888888888",
  clientSecret: "fixture", domains: ["other.invalid"], displayName: "Second tenant",
};
const originalTenants = config.tenants;
const database = { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) } as unknown as pg.Pool;

function data(selected = tenant): SessionData {
  return {
    cookie: new session.Cookie({ maxAge: 60_000 }), tenantId: selected.tenantId, clientId: selected.clientId, accountId: "same-account",
    user: { tenantId: selected.tenantId, homeAccountId: "same-account", username: `viewer@${selected.domains[0]}`, displayName: "Viewer", roles: ["AgentControl.Viewer"] },
    csrfToken: "fixture-csrf", rolesValidatedAt: Date.now(), signedInAt: Date.now(),
  };
}

function set(store: ReturnType<typeof createSessionStore>, id: string, value: SessionData) {
  return new Promise<void>((resolve, reject) => store.set(id, value, error => error ? reject(error) : resolve()));
}

function get(store: ReturnType<typeof createSessionStore>, id: string) {
  return new Promise<SessionData | null | undefined>((resolve, reject) => store.get(id, (error, value) => error ? reject(error) : resolve(value)));
}

beforeEach(() => { config.tenants = [tenant, otherTenant]; vi.clearAllMocks(); });
afterEach(() => { config.tenants = originalTenants; vi.restoreAllMocks(); });

describe("configured tenant session persistence", () => {
  it("preserves anonymous sessions without inventing a tenant or app binding", async () => {
    const store = createSessionStore(database);
    await set(store, "anonymous", { cookie: new session.Cookie({ maxAge: 60_000 }), authFlowHandle: "a".repeat(43) });
    expect(await get(store, "anonymous")).toMatchObject({ authFlowHandle: "a".repeat(43) });
    expect(await get(store, "anonymous")).not.toHaveProperty("tenantId");
    expect(await get(store, "anonymous")).not.toHaveProperty("clientId");
  });

  it("accepts every configured tenant and derives a missing client only for a trusted set", async () => {
    const store = createSessionStore(database);
    const first = data();
    delete first.clientId;
    await set(store, "first", first);
    await set(store, "second", data(otherTenant));
    expect(await get(store, "first")).toMatchObject({ tenantId: tenant.tenantId, clientId: tenant.clientId, accountId: "same-account" });
    expect(await get(store, "second")).toMatchObject({ tenantId: otherTenant.tenantId, clientId: otherTenant.clientId, accountId: "same-account" });
    expect(getValidatedSessionIdentity(first)).toBeUndefined();
  });

  it.each([
    { tenantId: undefined }, { tenantId: "unconfigured" }, { tenantId: otherTenant.tenantId },
    { clientId: otherTenant.clientId }, { accountId: "different-account" }, { user: undefined },
    { user: { ...data().user!, tenantId: otherTenant.tenantId } },
  ])("refuses inconsistent writes: %j", async change => {
    const store = createSessionStore(database);
    await expect(set(store, "invalid", { ...data(), ...change })).rejects.toThrow("tenant/principal/client mismatch");
    expect(await get(store, "invalid")).toBeNull();
  });

  it.each([
    { clientId: undefined }, { clientId: otherTenant.clientId }, { tenantId: undefined }, { tenantId: otherTenant.tenantId },
    { accountId: undefined }, { accountId: "another-account" }, { user: undefined },
    { user: { ...data().user!, tenantId: otherTenant.tenantId } },
    { user: { ...data().user!, homeAccountId: "another-account" } },
  ])("rejects legacy or tampered persisted sessions without repairing their identity: %j", async change => {
    const store = createSessionStore(database);
    const persisted = store as unknown as { sessions: Record<string, string> };
    persisted.sessions.invalid = JSON.stringify({ ...data(), ...change });
    expect(await get(store, "invalid")).toBeNull();
    expect(persisted.sessions).not.toHaveProperty("invalid");
  });

  it("deletes a legacy session without a role-bearing user shape", async () => {
    const store = createSessionStore(database);
    const persisted = store as unknown as { sessions: Record<string, string> };
    persisted.sessions.legacy = JSON.stringify({ ...data(), user: { ...data().user, roles: undefined } });
    await set(store, "other", data(otherTenant));
    expect(await get(store, "legacy")).toBeNull();
    expect(persisted.sessions).not.toHaveProperty("legacy");
    expect(await get(store, "other")).toMatchObject({ tenantId: otherTenant.tenantId, accountId: "same-account" });
  });

  it("propagates storage read failures without attempting deletion", async () => {
    const failure = new Error("Read failed.");
    vi.spyOn(session.MemoryStore.prototype, "get").mockImplementation((_id, callback) => callback(failure));
    const destroy = vi.spyOn(session.MemoryStore.prototype, "destroy");
    const store = createSessionStore(database);
    await expect(get(store, "unread")).rejects.toBe(failure);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("propagates invalid-session deletion failures rather than reporting a successful expiration", async () => {
    const failure = new Error("Delete failed.");
    const destroy = vi.spyOn(session.MemoryStore.prototype, "destroy").mockImplementation((_id, callback) => callback?.(failure));
    const store = createSessionStore(database);
    const persisted = store as unknown as { sessions: Record<string, string> };
    persisted.sessions.invalid = JSON.stringify({ ...data(), clientId: undefined });
    await expect(get(store, "invalid")).rejects.toBe(failure);
    expect(destroy).toHaveBeenCalledWith("invalid", expect.any(Function));
    expect(persisted.sessions).toHaveProperty("invalid");
  });

  it("invalidates removed and reconfigured tenants without affecting a second tenant", async () => {
    const store = createSessionStore(database);
    await set(store, "first", data());
    await set(store, "second", data(otherTenant));
    config.tenants = [{ ...tenant, clientId: "33333333-3333-3333-3333-333333333333" }, otherTenant];
    expect(await get(store, "first")).toBeNull();
    expect(await get(store, "second")).toMatchObject({ tenantId: otherTenant.tenantId, clientId: otherTenant.clientId });
    config.tenants = [otherTenant];
    expect(await get(store, "first")).toBeNull();
    expect(await get(store, "second")).toMatchObject({ accountId: "same-account" });
    config.tenants = [tenant, otherTenant];
    expect(await get(store, "first")).toBeNull();
  });

  it("does not persist raw credentials, provider tokens or flow state", async () => {
    const store = createSessionStore(database);
    await set(store, "first", {
      ...data(), authFlowHandle: "a".repeat(43), accessToken: "private-token", clientSecret: "private-secret",
      authFlow: { username: "private-username", state: "private-state", codeVerifier: "private-verifier" },
    } as SessionData);
    const serialized = JSON.stringify(await get(store, "first"));
    for (const privateValue of ["private-token", "private-secret", "private-username", "private-state", "private-verifier"]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(serialized).toContain("a".repeat(43));
  });

  it("revokes only the exact tenant and principal, even for a shared account ID", async () => {
    await revokeAccountSessions(database, otherTenant.tenantId, "same-account");
    expect(database.query).toHaveBeenCalledExactlyOnceWith(
      "DELETE FROM sessions WHERE tenant_id=$1 AND principal_id=$2", [otherTenant.tenantId, "same-account"],
    );
  });

  it("binds current-session publication checks to the configured client and stored principal", async () => {
    await assertCurrentStoredSession(database, "second", otherTenant.tenantId, "same-account", "AgentControl.Viewer");
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("sess->>'clientId'=$5 AND sess->'user'->>'tenantId'=$2 AND sess->'user'->>'homeAccountId'=$3"),
      ["second", otherTenant.tenantId, "same-account", "AgentControl.Viewer", otherTenant.clientId],
    );
    vi.mocked(database.query).mockResolvedValueOnce({ rowCount: 0, rows: [] } as never);
    await expect(assertCurrentStoredSession(database, "second", otherTenant.tenantId, "same-account", "AgentControl.Viewer")).rejects.toMatchObject({ code: "unauthorized" });
    vi.mocked(database.query).mockClear();
    config.tenants = [tenant];
    await expect(assertCurrentStoredSession(database, "second", otherTenant.tenantId, "same-account", "AgentControl.Viewer")).rejects.toMatchObject({ code: "unauthorized" });
    expect(database.query).not.toHaveBeenCalled();
  });
});
