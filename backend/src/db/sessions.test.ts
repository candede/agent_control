import session from "express-session";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { beginAccountSessionValidation, commitAccountSessionValidation, createSessionStore, revokeAccountSessionMutations } from "./sessions.js";
import { inventoryProviderRoleIds } from "../services/inventoryRoleScope.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); });

describe("PostgreSQL sessions", () => {
  it("persists across store recreation, excludes tokens and isolates tenant reads", async () => {
    const store = createSessionStore(fixture.runtime,"tenant");
    const data = { cookie: new session.Cookie({maxAge:60000}), accountId:"principal", authFlowHandle:"a".repeat(43), csrfToken:"fixture-csrf", rolesValidatedAt:1234, user:{tenantId:"tenant",homeAccountId:"principal",username:"fixture@example.invalid",displayName:"Fixture",roles:["AgentControl.Reader","untrusted-role"],providerRoleIds:[inventoryProviderRoleIds.aiReader,"00000000-0000-0000-0000-000000000000","must-not-persist-role-name"]}, authFlow:{state:"must-not-persist-state",nonce:"must-not-persist-nonce",codeVerifier:"must-not-persist-verifier"}, accessToken:"must-not-persist-token", refreshToken:"must-not-persist-refresh", tokenCache:"must-not-persist-cache", code:"must-not-persist-code", clientSecret:"must-not-persist-secret" };
    await new Promise<void>((resolve,reject) => store.set("fixture-session",data,error => error ? reject(error) : resolve()));
    store.close();
    const recreated = createSessionStore(fixture.runtime,"tenant");
    const other = createSessionStore(fixture.runtime,"other");
    try {
      const found = await new Promise((resolve,reject) => recreated.get("fixture-session",(error,value) => error ? reject(error) : resolve(value)));
      expect(found).toMatchObject({accountId:"principal",tenantId:"tenant",authFlowHandle:"a".repeat(43),csrfToken:"fixture-csrf",rolesValidatedAt:1234,user:{roles:["AgentControl.Reader"],providerRoleIds:[inventoryProviderRoleIds.aiReader]}});
      const serialized = (await fixture.runtime.query<{ value: string }>("SELECT sess::text AS value FROM sessions WHERE sid='fixture-session'")).rows[0].value;
      for (const secret of ["must-not-persist-state","must-not-persist-nonce","must-not-persist-verifier","must-not-persist-token","must-not-persist-refresh","must-not-persist-cache","must-not-persist-code","must-not-persist-secret","must-not-persist-role-name","00000000-0000-0000-0000-000000000000"]) expect(serialized).not.toContain(secret);
      expect(await new Promise(resolve => other.get("fixture-session",(_error,value) => resolve(value)))).toBeNull();
      await fixture.operator.query("UPDATE sessions SET expire=clock_timestamp()-interval '1 second'");
      expect(await new Promise(resolve => recreated.get("fixture-session",(_error,value) => resolve(value)))).toBeNull();
      await recreated.pruneSessions();
      expect((await fixture.runtime.query("SELECT 1 FROM sessions")).rowCount).toBe(0);
    } finally { recreated.close(); other.close(); }
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