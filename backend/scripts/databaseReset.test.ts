import pg from "pg";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { databaseSettings } from "../src/db/pool.js";
import { schemaSql, verifySchema } from "../src/db/schema.js";
import { DataGenerations } from "../src/db/dataGenerations.js";
import { bootstrap, databaseOperatorFailure, grantRuntime, initializeSchema, preflightSchema } from "./database.js";
import { DatabaseResetError, preflightDatabaseReset, resetDatabase } from "./databaseReset.js";
import { fixturePassword, testDatabase } from "./testDatabase.js";
import { config } from "../src/config.js";
import { account, oboFetcher, tenant, verifiedBearer } from "../src/auth/authFoundationTestSupport.js";
import { createBearerCredentials } from "../src/auth/delegatedCredentials.js";
import { principalEpochAuthority } from "../src/auth/requestPrincipal.js";
import { InventoryGenerations } from "../src/db/inventoryGenerations.js";
import { inventoryBaseline } from "./inventoryFixtures.js";
import { AgentDiscovery } from "../src/services/agentDiscovery.js";

const execute = promisify(execFile);
const settings = databaseSettings();
const maintenance = new pg.Pool({ ...settings, database: "postgres" });
let fixture: Awaited<ReturnType<typeof testDatabase>>;
const originalTenants = config.tenants;

async function useDatabase<T>(name: string, read: (database: pg.Pool) => Promise<T>) {
  const database = new pg.Pool({ ...settings, database: name });
  try { return await read(database); } finally { await database.end(); }
}

function command(name: string, ...args: string[]) {
  return execute(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./database.ts", import.meta.url)), ...args], {
    env: { ...process.env, PGDATABASE: name }, timeout: 15_000,
  });
}

beforeAll(async () => {
  const roles = await testDatabase();
  await roles.close();
});
beforeEach(async () => { fixture = await testDatabase(false); });
afterEach(async () => { config.tenants = originalTenants; await fixture?.close(); });
afterAll(async () => { await maintenance.end(); });

describe.sequential("explicit application database reset", () => {
  it("retains nonenumerable pool credentials for protected reset and initialization connections", async () => {
    expect(Object.getOwnPropertyDescriptor(maintenance.options, "password")?.enumerable).toBe(false);
    const inheritedPassword = process.env.PGPASSWORD;
    process.env.PGPASSWORD = "wrong-inherited-password-not-the-protected-pool-credential";
    try {
      await useDatabase(fixture.name, async database => {
        await bootstrap(database, fixturePassword);
        await initializeSchema(database);
        await grantRuntime(database);
      });
      await resetDatabase(maintenance, fixture.name, fixture.name);
      expect(await useDatabase(fixture.name, preflightSchema)).toMatchObject({ state: "fresh" });
    } finally {
      if (inheritedPassword === undefined) delete process.env.PGPASSWORD;
      else process.env.PGPASSWORD = inheritedPassword;
    }
  });
  it("admits a fresh signed backdated MCP OAuth bearer immediately after reset", async () => {
    config.tenants = [tenant];
    await useDatabase(fixture.name, async database => {
      await bootstrap(database, fixturePassword); await initializeSchema(database); await grantRuntime(database);
      await new DataGenerations(database).sessionEpoch(tenant.tenantId, account().homeAccountId);
    });
    await resetDatabase(maintenance, fixture.name, fixture.name);
    await useDatabase(fixture.name, async database => {
      await bootstrap(database, fixturePassword); await initializeSchema(database); await grantRuntime(database);
      expect((await database.query("SELECT count(*)::int AS n FROM data_principal_epochs")).rows[0].n).toBe(0);
      const iat = Math.floor(Date.now() / 1000) - 300;
      const verified = await verifiedBearer({ iat, nbf: iat, roles: [] });
      const source = await createBearerCredentials(verified, principalEpochAuthority(database), {
        fetcher: oboFetcher({ claims: { iat, nbf: iat } }),
      });
      expect(source.principal.authenticatedAt).toBe(iat * 1000);
      expect(source.principal.principalId).toBe(account().homeAccountId);
      expect(source.principal.roles).toEqual([]);
    });
  }, 15_000);
  it("retains only actual principal revocations through recreation and interrupted initialization without a second reset", async () => {
    let revoked: { epoch: string; issuedAfter: string };
    let protectedRows: unknown[];
    config.tenants = [tenant];
    const iat = Math.floor(Date.now() / 1000) - 300;
    const revokedBearer = await verifiedBearer({ iat, nbf: iat });
    const unknownOid = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const unknownBearer = await verifiedBearer({ oid: unknownOid, iat, nbf: iat });
    await useDatabase(fixture.name, async database => {
      await bootstrap(database, fixturePassword); await initializeSchema(database); await grantRuntime(database);
      const authority = new DataGenerations(database);
      await authority.sessionEpoch("reset-tenant", "revoked-principal");
      await authority.revokePrincipal("reset-tenant", "revoked-principal");
      revoked = await authority.bearerAuthority("reset-tenant", "revoked-principal");
      const epochs = principalEpochAuthority(database);
      expect((await createBearerCredentials(revokedBearer, epochs, { fetcher: oboFetcher() })).principal.principalId)
        .toBe(account().homeAccountId);
      await authority.revokePrincipal(tenant.tenantId, account().homeAccountId);
      await expect(createBearerCredentials(revokedBearer, epochs, { fetcher: oboFetcher() })).rejects.toMatchObject({ code: "unauthorized" });
      expect((await database.query("SELECT count(*)::int AS n FROM data_principal_epochs WHERE principal_id=$1",
        [account(unknownOid).homeAccountId])).rows[0].n).toBe(0);
      protectedRows = (await database.query(`SELECT tenant_id,principal_id,epoch::text,bearer_issued_after::text
        FROM data_principal_epochs WHERE bearer_issued_after>0 ORDER BY tenant_id,principal_id`)).rows;
      await inventoryBaseline(new InventoryGenerations(database), "reset-catalog-publisher", 3, new Date(), undefined, tenant.tenantId);
      await new AgentDiscovery(database).execute({ tenantId: tenant.tenantId, homeAccountId: account().homeAccountId,
        localAccountId: account().localAccountId, username: account().username, displayName: "Reset fixture", roles: ["AgentControl.Viewer"] },
      { operation: "profile" });
      expect((await database.query("SELECT count(*)::int AS n FROM inventory_keys")).rows[0].n).toBe(3);
      expect((await database.query("SELECT count(*)::int AS n FROM data_read_selections")).rows[0].n).toBe(1);
      await database.query("INSERT INTO sessions(sid,sess,expire) VALUES('discarded','{}',clock_timestamp()+interval '1 hour')");
    });
    // A denied preflight is non-destructive.
    await expect(resetDatabase(maintenance, fixture.name, "wrong")).rejects.toMatchObject({ phase: "validation" });
    expect(await useDatabase(fixture.name, async database => (await database.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n)).toBe(1);
    await resetDatabase(maintenance, fixture.name, fixture.name);
    const saved = (await maintenance.query(`SELECT tenant_id,principal_id,epoch::text,bearer_issued_after::text
      FROM agentcontrol_principal_revocations WHERE database_name=$1 ORDER BY tenant_id,principal_id`, [fixture.name])).rows;
    expect(saved).toEqual(protectedRows!);
    await useDatabase(fixture.name, async database => {
      expect(await preflightSchema(database)).toMatchObject({ state: "fresh" });
      await bootstrap(database, fixturePassword);
      const connect = database.connect.bind(database);
      const intercepted = vi.spyOn(database, "connect").mockImplementation(async () => {
        const client = await connect(), query = client.query.bind(client);
        const spy = vi.spyOn(client, "query").mockImplementation(((text: unknown, ...args: unknown[]) => {
          if (text === schemaSql) return Promise.resolve(Reflect.apply(query, client, [text, ...args]))
            .then(() => { throw new Error("synthetic interrupted initialization"); });
          return Reflect.apply(query, client, [text, ...args]);
        }) as typeof client.query);
        const release = client.release.bind(client);
        client.release = (...args) => { spy.mockRestore(); release(...args); };
        return client;
      });
      try { await expect(initializeSchema(database)).rejects.toThrow("interrupted initialization"); }
      finally { intercepted.mockRestore(); }
      expect(await preflightSchema(database)).toMatchObject({ state: "fresh" });
      await initializeSchema(database); await grantRuntime(database);
      await initializeSchema(database); // ordinary resume, not another reset
      await verifySchema(database);
      expect((await database.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n).toBe(0);
      expect((await database.query("SELECT count(*)::int AS n FROM inventory_keys")).rows[0].n).toBe(0);
      expect((await database.query("SELECT count(*)::int AS n FROM data_read_selections")).rows[0].n).toBe(0);
      const authority = new DataGenerations(database);
      expect(await authority.bearerAuthority("reset-tenant", "revoked-principal")).toEqual(revoked!);
      expect(await authority.bearerAuthority("reset-tenant", "previously-unknown-principal")).toEqual({ epoch: "0", issuedAfter: "0" });
      const epochs = principalEpochAuthority(database);
      await expect(createBearerCredentials(revokedBearer, epochs, { fetcher: oboFetcher() })).rejects.toMatchObject({ code: "unauthorized" });
      const currentIat = Math.floor(Date.now() / 1000) - 300;
      await expect(createBearerCredentials(await verifiedBearer({ iat: currentIat, nbf: currentIat }),
        epochs, { fetcher: oboFetcher() })).rejects.toMatchObject({ code: "unauthorized" });
      expect((await createBearerCredentials(unknownBearer, epochs, { fetcher: oboFetcher({ oid: unknownOid }) })).principal.authenticatedAt)
        .toBe(iat * 1000);
    });
    expect((await maintenance.query(`SELECT tenant_id,principal_id,epoch::text,bearer_issued_after::text
      FROM agentcontrol_principal_revocations WHERE database_name=$1 ORDER BY tenant_id,principal_id`, [fixture.name])).rows)
      .toEqual(protectedRows!);
    const runtime = new pg.Pool({ ...settings, database: "postgres", user: "agentcontrol_app", password: fixturePassword });
    try {
      await expect(runtime.query("SELECT * FROM agentcontrol_principal_revocations")).rejects.toMatchObject({ code: "42501" });
    } finally { await runtime.end(); }
  }, 15_000);

  it("refuses deletion when an initialized database has lost its canonical revocation owner", async () => {
    await useDatabase(fixture.name, async database => {
      await bootstrap(database, fixturePassword); await initializeSchema(database); await grantRuntime(database);
      await database.query("ALTER TABLE data_principal_epochs RENAME TO missing_principal_owner");
    });
    await expect(resetDatabase(maintenance, fixture.name, fixture.name)).rejects.toMatchObject({ phase: "validation" });
    expect((await maintenance.query("SELECT datname FROM pg_database WHERE datname=$1", [fixture.name])).rowCount).toBe(1);
    await useDatabase(fixture.name, async database => {
      await database.query("ALTER TABLE missing_principal_owner RENAME TO data_principal_epochs");
      await verifySchema(database);
    });
  });

  it("preserves the application when protected revocation publication fails before DROP", async () => {
    await useDatabase(fixture.name, async database => {
      await bootstrap(database, fixturePassword); await initializeSchema(database); await grantRuntime(database);
      await new DataGenerations(database).revokePrincipal("reset-tenant", "publication-failure");
    });
    const connect = maintenance.connect.bind(maintenance);
    const intercepted = vi.spyOn(maintenance, "connect").mockImplementation(async () => {
      const client = await connect(), query = client.query.bind(client);
      vi.spyOn(client, "query").mockImplementation(((text: unknown, ...args: unknown[]) => {
        if (typeof text === "string" && text.startsWith("INSERT INTO public.agentcontrol_principal_revocations")) {
          return Promise.reject(new Error("synthetic protected-publication failure"));
        }
        return Reflect.apply(query, client, [text, ...args]);
      }) as typeof client.query);
      return client;
    });
    try { await expect(resetDatabase(maintenance, fixture.name, fixture.name)).rejects.toMatchObject({ phase: "validation" }); }
    finally { intercepted.mockRestore(); }
    expect((await maintenance.query("SELECT datname FROM pg_database WHERE datname=$1", [fixture.name])).rowCount).toBe(1);
    await useDatabase(fixture.name, verifySchema);
  });

  it("captures a concurrently committing principal revocation before deleting the target", async () => {
    await useDatabase(fixture.name, async database => {
      database.on("error", () => {});
      await bootstrap(database, fixturePassword); await initializeSchema(database); await grantRuntime(database);
      let updated!: () => void, release!: () => void;
      const updateReached = new Promise<void>(resolve => { updated = resolve; });
      const finishUpdate = new Promise<void>(resolve => { release = resolve; });
      const connect = database.connect.bind(database);
      const intercepted = vi.spyOn(database, "connect").mockImplementation(async () => {
        const client = await connect(), query = client.query.bind(client);
        vi.spyOn(client, "query").mockImplementation(((text: unknown, ...args: unknown[]) => {
          const response = Reflect.apply(query, client, [text, ...args]);
          if (typeof text === "string" && text.startsWith("UPDATE data_principal_epochs SET epoch=epoch+1")) {
            return Promise.resolve(response).then(async value => { updated(); await finishUpdate; return value; });
          }
          return response;
        }) as typeof client.query);
        return client;
      });
      const authority = new DataGenerations(database);
      const revoke = authority.revokePrincipal("reset-tenant", "concurrent-revocation");
      await updateReached;
      let completed = false;
      const reset = resetDatabase(maintenance, fixture.name, fixture.name).then(value => { completed = true; return value; });
      try {
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(completed).toBe(false);
      } finally { release(); }
      await revoke;
      intercepted.mockRestore();
      await reset;
    });
    const saved = (await maintenance.query(`SELECT epoch::text,bearer_issued_after::text AS "issuedAfter"
      FROM agentcontrol_principal_revocations WHERE database_name=$1`, [fixture.name])).rows[0];
    expect(saved.epoch).toBe("1");
    expect(BigInt(saved.issuedAfter)).toBeGreaterThan(0n);
  });

  it("replaces an incompatible database, preserves other databases and roles, and bootstraps with the same credentials", async () => {
    const sibling = await testDatabase(false);
    try {
      await useDatabase(sibling.name, database => database.query("CREATE TABLE sibling_probe(id integer); INSERT INTO sibling_probe VALUES (9)"));
      await useDatabase(fixture.name, async database => {
        await bootstrap(database, fixturePassword);
        await initializeSchema(database);
        await grantRuntime(database);
        await database.query("CREATE TABLE reset_probe(id integer); INSERT INTO reset_probe VALUES (7)");
        await database.query("UPDATE app_schema SET fingerprint=repeat('0',64)");
      });
      const roleBefore = (await maintenance.query("SELECT oid FROM pg_roles WHERE rolname='agentcontrol_app'")).rows;
      expect(await preflightDatabaseReset(maintenance, fixture.name, fixture.name)).toEqual({ database: fixture.name, exists: true });
      expect(await useDatabase(fixture.name, async database => (await database.query("SELECT id FROM reset_probe")).rows)).toEqual([{ id: 7 }]);
      await expect(command(fixture.name, "reset")).rejects.toMatchObject({
        code: 1, stderr: expect.stringContaining('"code":"database_reset_denied"'),
      });
      const reset = await command(fixture.name, "reset", fixture.name);
      expect(JSON.parse(reset.stdout)).toEqual({
        event: "database_operator_command", command: "reset", outcome: "succeeded", database: fixture.name, state: "fresh",
      });
      await useDatabase(fixture.name, async database => {
        expect(await preflightSchema(database)).toMatchObject({ state: "fresh", currentFingerprint: null });
        expect((await database.query("SELECT count(*)::int AS count FROM pg_class WHERE relnamespace='public'::regnamespace")).rows[0].count).toBe(0);
      });
      await command(fixture.name, "initialize");
      const runtime = new pg.Pool({ ...settings, database: fixture.name, user: "agentcontrol_app", password: fixturePassword });
      try {
        await verifySchema(runtime);
        expect((await runtime.query("SELECT count(*)::int AS count FROM sessions")).rows[0].count).toBe(0);
        expect((await runtime.query("SELECT to_regclass('public.reset_probe') AS name")).rows[0].name).toBeNull();
      } finally { await runtime.end(); }
      expect((await maintenance.query("SELECT oid FROM pg_roles WHERE rolname='agentcontrol_app'")).rows).toEqual(roleBefore);
      expect(await useDatabase(sibling.name, async database => (await database.query("SELECT id FROM sibling_probe")).rows)).toEqual([{ id: 9 }]);
    } finally { await sibling.close(); }
  });

  it.each(["postgres", "template0", "agentcontrol_other", 'agentcontrol_test_bad";DROP DATABASE postgres;--'])(
    "rejects an unsupported reset target %s", async target => {
      await expect(preflightDatabaseReset(maintenance, target, target)).rejects.toMatchObject({ code: "database_reset_denied" });
      await expect(resetDatabase(maintenance, target, target)).rejects.toMatchObject({ code: "database_reset_denied" });
    },
  );

  it("rejects a confirmation for a different database", async () => {
    await expect(resetDatabase(maintenance, fixture.name, "agentcontrol")).rejects.toMatchObject({ code: "database_reset_denied" });
    expect((await maintenance.query("SELECT datname FROM pg_database WHERE datname=$1", [fixture.name])).rowCount).toBe(1);
  });

  it("rejects a connection to the application database instead of maintenance", async () => {
    await useDatabase(fixture.name, async database => {
      await expect(preflightDatabaseReset(database, fixture.name, fixture.name)).rejects.toMatchObject({ code: "database_reset_denied" });
      await expect(resetDatabase(database, fixture.name, fixture.name)).rejects.toMatchObject({ code: "database_reset_denied" });
    });
  });

  it("rejects the runtime identity", async () => {
    const runtime = new pg.Pool({ ...settings, database: "postgres", user: "agentcontrol_app", password: fixturePassword });
    try {
      await expect(preflightDatabaseReset(runtime, fixture.name, fixture.name)).rejects.toMatchObject({ code: "database_reset_denied" });
      await expect(resetDatabase(runtime, fixture.name, fixture.name)).rejects.toMatchObject({ code: "database_reset_denied" });
    } finally { await runtime.end(); }
  });

  it("refuses a database owned by another role", async () => {
    await maintenance.query(`ALTER DATABASE "${fixture.name}" OWNER TO agentcontrol_app`);
    try {
      await expect(resetDatabase(maintenance, fixture.name, fixture.name)).rejects.toMatchObject({ code: "database_reset_denied" });
      expect((await maintenance.query("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1", [fixture.name])).rows[0].owner).toBe("agentcontrol_app");
    } finally { await maintenance.query(`ALTER DATABASE "${fixture.name}" OWNER TO agentcontrol_admin`); }
  });

  it("refuses a template even with an otherwise allowed name", async () => {
    await maintenance.query(`ALTER DATABASE "${fixture.name}" IS_TEMPLATE true`);
    try {
      await expect(resetDatabase(maintenance, fixture.name, fixture.name)).rejects.toMatchObject({ code: "database_reset_denied" });
    } finally { await maintenance.query(`ALTER DATABASE "${fixture.name}" IS_TEMPLATE false`); }
  });

  it("can retry explicit initialization when a previous reset left the database absent", async () => {
    const expected = await useDatabase(fixture.name, async database => {
      await bootstrap(database, fixturePassword); await initializeSchema(database); await grantRuntime(database);
      const authority = new DataGenerations(database);
      await authority.revokePrincipal("reset-tenant", "creation-failure");
      return authority.bearerAuthority("reset-tenant", "creation-failure");
    });
    const connect = maintenance.connect.bind(maintenance);
    const intercepted = vi.spyOn(maintenance, "connect").mockImplementation(async () => {
      const client = await connect(), query = client.query.bind(client);
      vi.spyOn(client, "query").mockImplementation(((text: unknown, ...args: unknown[]) => {
        if (text === `CREATE DATABASE "${fixture.name}" OWNER agentcontrol_admin TEMPLATE template0`) {
          return Promise.reject(new Error("synthetic creation failure after DROP"));
        }
        return Reflect.apply(query, client, [text, ...args]);
      }) as typeof client.query);
      return client;
    });
    try { await expect(resetDatabase(maintenance, fixture.name, fixture.name)).rejects.toMatchObject({ phase: "create" }); }
    finally { intercepted.mockRestore(); }
    expect(await preflightDatabaseReset(maintenance, fixture.name, fixture.name)).toEqual({ database: fixture.name, exists: false });
    const fence = (await maintenance.query("SELECT epoch::text,bearer_issued_after::text AS \"issuedAfter\" FROM agentcontrol_principal_revocations WHERE database_name=$1",
      [fixture.name])).rows[0];
    expect(fence).toEqual(expected);
    expect(await resetDatabase(maintenance, fixture.name, fixture.name)).toEqual({ database: fixture.name, state: "fresh" });
    expect(await useDatabase(fixture.name, preflightSchema)).toMatchObject({ state: "fresh" });
    await useDatabase(fixture.name, async database => {
      await bootstrap(database, fixturePassword); await initializeSchema(database); await grantRuntime(database);
      expect(await new DataGenerations(database).bearerAuthority("reset-tenant", "creation-failure")).toEqual(expected);
    });
  });

  it("serializes simultaneous explicit resets of the same database", async () => {
    const results = await Promise.all([
      resetDatabase(maintenance, fixture.name, fixture.name),
      resetDatabase(maintenance, fixture.name, fixture.name),
    ]);
    expect(results).toEqual([
      { database: fixture.name, state: "fresh" },
      { database: fixture.name, state: "fresh" },
    ]);
    expect(await useDatabase(fixture.name, preflightSchema)).toMatchObject({ state: "fresh" });
  });

  it("reports destructive-phase failures without suggesting that data was preserved", () => {
    const error = databaseOperatorFailure(new DatabaseResetError("create"));
    expect(error).toMatchObject({
      code: "database_reset_failed", phase: "create", message: expect.stringContaining("data may already have been deleted"),
    });
    expect(error.message).not.toContain("No automatic reset");
  });
});
