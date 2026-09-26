import session from "express-session";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { config, type TenantConfiguration } from "../config.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { assertCurrentStoredSession, beginAccountSessionValidation, commitAccountSessionValidation, createSessionStore, revokeAccountSessionMutations } from "./sessions.js";
import { inventoryProviderRoleIds } from "../services/inventoryRoleScope.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const tenant: TenantConfiguration = {
  tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222",
  clientSecret: "fixture", domains: ["example.invalid"], displayName: "Session tenant",
};
const otherTenant: TenantConfiguration = {
  tenantId: "99999999-9999-9999-9999-999999999999", clientId: "88888888-8888-8888-8888-888888888888",
  clientSecret: "fixture", domains: ["other.invalid"], displayName: "Other tenant",
};
const originalTenants = config.tenants;
beforeAll(async () => { fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); });
beforeEach(() => { config.tenants = [tenant, otherTenant]; });
afterEach(() => { config.tenants = originalTenants; });

describe("PostgreSQL sessions", () => {
  it("honors Admin inheritance in stored-session publication checks and rejects legacy roles", async () => {
    const expires = new Date(Date.now() + 60_000);
    await fixture.operator.query("INSERT INTO sessions(sid,sess,expire) VALUES($1,$2,$3),($4,$5,$3)", [
      "admin-session", { tenantId: tenant.tenantId, clientId: tenant.clientId, accountId: "admin", user: { tenantId: tenant.tenantId, homeAccountId: "admin", roles: ["AgentControl.Admin"] } }, expires,
      "legacy-session", { tenantId: tenant.tenantId, clientId: tenant.clientId, accountId: "legacy", user: { tenantId: tenant.tenantId, homeAccountId: "legacy", roles: ["AgentControl.Administrator"] } },
    ]);
    await expect(assertCurrentStoredSession(fixture.runtime, "admin-session", tenant.tenantId, "admin", "AgentControl.Viewer")).resolves.toBeUndefined();
    await expect(assertCurrentStoredSession(fixture.runtime, "admin-session", tenant.tenantId, "admin", "AgentControl.Admin")).resolves.toBeUndefined();
    await expect(assertCurrentStoredSession(fixture.runtime, "legacy-session", tenant.tenantId, "legacy", "AgentControl.Viewer")).rejects.toMatchObject({ code: "unauthorized" });
    config.tenants = [{ ...tenant, clientId: otherTenant.clientId }, otherTenant];
    await expect(assertCurrentStoredSession(fixture.runtime, "admin-session", tenant.tenantId, "admin", "AgentControl.Viewer")).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("persists across store recreation, excludes tokens and isolates tenant reads", async () => {
    const store = createSessionStore(fixture.runtime);
    const data = { cookie: new session.Cookie({maxAge:60000}), tenantId: tenant.tenantId, accountId:"principal", authFlowHandle:"a".repeat(43), csrfToken:"fixture-csrf", rolesValidatedAt:1234, user:{tenantId:tenant.tenantId,homeAccountId:"principal",username:"fixture@example.invalid",displayName:"Fixture",roles:["AgentControl.Viewer","untrusted-role"],providerRoleIds:[inventoryProviderRoleIds.aiReader,"00000000-0000-0000-0000-000000000000","must-not-persist-role-name"]}, authFlow:{state:"must-not-persist-state",nonce:"must-not-persist-nonce",codeVerifier:"must-not-persist-verifier"}, accessToken:"must-not-persist-token", refreshToken:"must-not-persist-refresh", tokenCache:"must-not-persist-cache", code:"must-not-persist-code", clientSecret:"must-not-persist-secret" };
    await new Promise<void>((resolve,reject) => store.set("fixture-session", { ...data, signedInAt: 1000 }, error => error ? reject(error) : resolve()));
    store.close();
    const recreated = createSessionStore(fixture.runtime);
    try {
      const found = await new Promise((resolve,reject) => recreated.get("fixture-session",(error,value) => error ? reject(error) : resolve(value)));
      expect(found).toMatchObject({accountId:"principal",tenantId:tenant.tenantId,clientId:tenant.clientId,authFlowHandle:"a".repeat(43),csrfToken:"fixture-csrf",rolesValidatedAt:1234,user:{roles:["AgentControl.Viewer"],providerRoleIds:[inventoryProviderRoleIds.aiReader]}});
      expect(found).toMatchObject({ signedInAt: 1000 });
      const serialized = (await fixture.runtime.query<{ value: string }>("SELECT sess::text AS value FROM sessions WHERE sid='fixture-session'")).rows[0].value;
      for (const secret of ["must-not-persist-state","must-not-persist-nonce","must-not-persist-verifier","must-not-persist-token","must-not-persist-refresh","must-not-persist-cache","must-not-persist-code","must-not-persist-secret","must-not-persist-role-name","00000000-0000-0000-0000-000000000000"]) expect(serialized).not.toContain(secret);
      config.tenants = [otherTenant];
      expect(await new Promise(resolve => recreated.get("fixture-session",(_error,value) => resolve(value)))).toBeNull();
      config.tenants = [tenant, otherTenant];
      await fixture.operator.query("UPDATE sessions SET expire=clock_timestamp()-interval '1 second'");
      expect(await new Promise(resolve => recreated.get("fixture-session",(_error,value) => resolve(value)))).toBeNull();
      await recreated.pruneSessions();
      expect((await fixture.runtime.query("SELECT 1 FROM sessions")).rowCount).toBe(0);
    } finally { recreated.close(); }
  });

  it("deletes a legacy session without a role-bearing user shape but preserves another tenant", async () => {
    const store = createSessionStore(fixture.runtime);
    const cookie = new session.Cookie({ maxAge: 60_000 });
    const expires = new Date(Date.now() + 60_000);
    await fixture.operator.query("INSERT INTO sessions(sid,sess,expire) VALUES($1,$2,$3),($4,$5,$3)", [
      "invalid-legacy", { cookie, tenantId: tenant.tenantId, clientId: tenant.clientId, accountId: "shared",
        user: { tenantId: tenant.tenantId, homeAccountId: "shared", username: "fixture@example.invalid", displayName: "Legacy" } }, expires,
      "valid-other", { cookie, tenantId: otherTenant.tenantId, clientId: otherTenant.clientId, accountId: "shared",
        user: { tenantId: otherTenant.tenantId, homeAccountId: "shared", username: "fixture@other.invalid", displayName: "Current", roles: ["AgentControl.Viewer"] } },
    ]);
    try {
      expect(await new Promise((resolve, reject) => store.get("invalid-legacy", (error, value) => error ? reject(error) : resolve(value)))).toBeNull();
      expect((await fixture.runtime.query("SELECT 1 FROM sessions WHERE sid='invalid-legacy'")).rowCount).toBe(0);
      expect(await new Promise((resolve, reject) => store.get("valid-other", (error, value) => error ? reject(error) : resolve(value))))
        .toMatchObject({ tenantId: otherTenant.tenantId, clientId: otherTenant.clientId, accountId: "shared" });
    } finally { store.close(); }
  });

  it("orders a held role save before logout or rejects it after logout", async () => {
    const validation = beginAccountSessionValidation("tenant", "race-principal");
    let releaseSave!: () => void;
    let saveStarted!: () => void;
    const started = new Promise<void>(resolve => { saveStarted = resolve; });
    const held = new Promise<void>(resolve => { releaseSave = resolve; });
    const order: string[] = [];
    const save = commitAccountSessionValidation(validation, async () => {
      saveStarted();
      await held;
      order.push("save");
    });
    await started;
    const revoke = revokeAccountSessionMutations("tenant", "race-principal", async () => { order.push("revoke"); });
    releaseSave();
    await Promise.all([save, revoke]);
    expect(order).toEqual(["save", "revoke"]);

    const stale = beginAccountSessionValidation("tenant", "revoked-principal");
    await revokeAccountSessionMutations("tenant", "revoked-principal", async () => undefined);
    await expect(commitAccountSessionValidation(stale, async () => { throw new Error("must not save"); })).rejects.toMatchObject({ code: "unauthorized" });
  });
});