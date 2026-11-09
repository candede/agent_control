import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { preflightDatabaseReset, resetDatabase, type ProtectedPrincipalRevocation } from "./databaseReset.js";

afterEach(() => { vi.restoreAllMocks(); });

const target = "agentcontrol_test_reset_review";
const revocations: ProtectedPrincipalRevocation[] = [
  { tenant_id: "tenant", principal_id: "revoked", epoch: "9007199254740993", bearer_issued_after: "1000", adoption_request_cutoff: "31000" },
];

function resetFixture({ exists = true, principals = true, records = revocations } = {}) {
  const database = new pg.Pool({
    database: "postgres", user: "agentcontrol_admin", password: "synthetic-protected-pool-password",
  });
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const connect = vi.spyOn(database, "connect").mockImplementation(async () => client);
  const query = vi.spyOn(client, "query").mockImplementation(async statement => {
    if (typeof statement !== "string") throw new Error("Unexpected maintenance query shape.");
    if (statement.startsWith("SELECT current_user")) {
      return { rows: [{ name: "agentcontrol_admin", database: "postgres" }], rowCount: 1 };
    }
    if (statement.includes("FROM pg_database")) {
      return { rows: exists ? [{ owner: "agentcontrol_admin", template: false }] : [], rowCount: exists ? 1 : 0 };
    }
    if (["BEGIN", "COMMIT", "ROLLBACK", "SET TRANSACTION READ ONLY"].includes(statement)
      || statement.startsWith("SELECT pg_advisory_lock")
      || statement.startsWith("CREATE TABLE")
      || statement.startsWith("INSERT INTO public.agentcontrol_principal_revocations")
      || statement.startsWith("DROP DATABASE")
      || statement.startsWith("CREATE DATABASE")) return { rows: [], rowCount: 0 };
    throw new Error("Unexpected maintenance query.");
  });
  const authorities: pg.Client[] = [];
  vi.spyOn(pg.Client.prototype, "connect").mockImplementation(async function(this: pg.Client) {
    authorities.push(this);
  });
  const authorityQuery = vi.spyOn(pg.Client.prototype, "query").mockImplementation(async statement => {
    if (typeof statement !== "string") throw new Error("Unexpected authority query shape.");
    if (statement.startsWith("SELECT to_regclass")) {
      return { rows: [{ schema: "app_schema", principals: principals ? "data_principal_epochs" : null }], rowCount: 1 };
    }
    if (statement.startsWith("SELECT tenant_id")) return { rows: records, rowCount: records.length };
    if (statement === "BEGIN" || statement.startsWith("LOCK TABLE")) return { rows: [], rowCount: 0 };
    throw new Error("Unexpected authority query.");
  });
  const authorityEnd = vi.spyOn(pg.Client.prototype, "end").mockImplementation(async () => {});
  return { database, client, connect, query, authorities, authorityQuery, authorityEnd };
}

it.each([preflightDatabaseReset, resetDatabase])(
  "rejects a target exceeding PostgreSQL's identifier limit before connecting (%s)", async operation => {
    const { database, connect } = resetFixture();
    const name = `agentcontrol_test_${"a".repeat(64 - "agentcontrol_test_".length)}`;
    expect(name).toHaveLength(64);
    await expect(operation(database, name, name)).rejects.toMatchObject({
      code: "database_reset_denied", phase: "validation",
    });
    expect(connect).not.toHaveBeenCalled();
  },
);

it("keeps the maximum-length supported target and read-only preflight", async () => {
  const { database, query, client, authorities } = resetFixture({ exists: false });
  const name = `agentcontrol_test_${"a".repeat(63 - "agentcontrol_test_".length)}`;
  await expect(preflightDatabaseReset(database, name, name)).resolves.toEqual({ database: name, exists: false });
  expect(query).toHaveBeenCalledWith("SET TRANSACTION READ ONLY");
  expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM pg_database"), [name]);
  expect(query).toHaveBeenCalledWith("COMMIT");
  expect(client.release).toHaveBeenCalledOnce();
  expect(authorities).toEqual([]);
});

it("publishes exact revoked authority before DROP and retains the protected connection password", async () => {
  const { database, client, query, authorities, authorityQuery, authorityEnd } = resetFixture();
  expect(Object.getOwnPropertyDescriptor(database.options, "password")?.enumerable).toBe(false);
  await expect(resetDatabase(database, target, target)).resolves.toEqual({ database: target, state: "fresh" });
  expect(authorities).toHaveLength(1);
  expect(authorities[0].database).toBe(target);
  expect(authorities[0].password).toBe(database.options.password);
  expect(authorityQuery).toHaveBeenCalledWith("LOCK TABLE data_principal_epochs IN SHARE MODE");
  expect(authorityQuery).toHaveBeenCalledWith(expect.stringContaining(
    "coalesce((to_jsonb(saved)->>'adoption_request_cutoff')::bigint,0)::text AS adoption_request_cutoff"));
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("INSERT INTO public.agentcontrol_principal_revocations"), [target, JSON.stringify(revocations)],
  );
  expect(query).toHaveBeenCalledWith(expect.stringContaining(
    "adoption_request_cutoff=GREATEST(agentcontrol_principal_revocations.adoption_request_cutoff,EXCLUDED.adoption_request_cutoff)"),
  [target, JSON.stringify(revocations)]);
  const statements = query.mock.calls.map(([statement]) => statement);
  expect(statements.findIndex(statement => typeof statement === "string" && statement.startsWith("INSERT INTO")))
    .toBeLessThan(statements.indexOf(`DROP DATABASE "${target}" WITH (FORCE)`));
  expect(query).toHaveBeenCalledWith(`CREATE DATABASE "${target}" OWNER agentcontrol_admin TEMPLATE template0`);
  expect(authorityEnd).toHaveBeenCalledOnce();
  expect(client.release).toHaveBeenCalledWith(true);
});

it.each([
  { phase: "validation", queryFails: false },
  { phase: "drop", queryFails: false },
  { phase: "drop", queryFails: true },
  { phase: "create", queryFails: false },
  { phase: "create", queryFails: true },
] as const)(
  "handles maintenance connection errors without an uncaught event during $phase (query failure=$queryFails)", async ({ phase, queryFails }) => {
    const { database, client, query, authorityQuery, authorityEnd } = resetFixture();
    const failure = new Error("synthetic maintenance connection loss");
    let reached!: () => void, resume!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const continued = new Promise<void>(resolve => { resume = resolve; });
    if (phase === "validation") {
      const respond = authorityQuery.getMockImplementation()!;
      authorityQuery.mockImplementation(async (...args) => {
        if (args[0] === "BEGIN") { reached(); await continued; }
        return respond(...args);
      });
    } else {
      const respond = query.getMockImplementation()!;
      query.mockImplementation(async (...args) => {
        if (typeof args[0] === "string" && args[0].startsWith(`${phase.toUpperCase()} DATABASE`)) {
          reached();
          await continued;
          if (queryFails) throw failure;
        }
        return respond(...args);
      });
    }
    const completed = resetDatabase(database, target, target).catch((error: unknown) => error);
    await paused;
    let uncaught: unknown;
    try { client.emit("error", failure); }
    catch (error) { uncaught = error; }
    finally { resume(); }
    const outcome = await completed;
    expect(uncaught).toBeUndefined();
    expect(outcome).toMatchObject({
      code: phase === "validation" ? "database_reset_denied" : "database_reset_failed", phase,
    });
    if (phase === "validation") {
      expect(query.mock.calls.some(([statement]) => typeof statement === "string"
        && /^(DROP|CREATE) DATABASE/.test(statement))).toBe(false);
    } else if (phase === "drop") {
      expect(query).not.toHaveBeenCalledWith(`CREATE DATABASE "${target}" OWNER agentcontrol_admin TEMPLATE template0`);
    }
    expect(authorityEnd).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  },
);

it.each([{ records: [] }, { records: revocations }])("does not DROP after losing the principal lock connection (%j)", async ({ records }) => {
  const { database, client, query, authorities, authorityEnd } = resetFixture({ records });
  const respond = query.getMockImplementation()!;
  query.mockImplementation(async (...args) => {
    const [statement] = args;
    if (typeof statement === "string" && statement.startsWith("CREATE TABLE")) {
      authorities[0].emit("error", new Error("synthetic authority connection loss"));
    }
    return respond(...args);
  });
  await expect(resetDatabase(database, target, target)).rejects.toMatchObject({
    code: "database_reset_denied", phase: "validation",
  });
  expect(query.mock.calls.some(([statement]) => typeof statement === "string"
    && /^(DROP|CREATE) DATABASE/.test(statement))).toBe(false);
  expect(authorityEnd).toHaveBeenCalledOnce();
  expect(client.release).toHaveBeenCalledWith(true);
});

it("allows the lock connection termination caused by DROP itself", async () => {
  const { database, query, authorities, authorityEnd } = resetFixture();
  const respond = query.getMockImplementation()!;
  query.mockImplementation(async (...args) => {
    if (args[0] === `DROP DATABASE "${target}" WITH (FORCE)`) {
      authorities[0].emit("error", new Error("synthetic DROP-initiated termination"));
    }
    return respond(...args);
  });
  await expect(resetDatabase(database, target, target)).resolves.toEqual({ database: target, state: "fresh" });
  expect(query).toHaveBeenCalledWith(`CREATE DATABASE "${target}" OWNER agentcontrol_admin TEMPLATE template0`);
  expect(authorityEnd).toHaveBeenCalledOnce();
});

it("refuses deletion when the initialized canonical principal owner is missing", async () => {
  const { database, client, query, authorityEnd } = resetFixture({ principals: false });
  await expect(resetDatabase(database, target, target)).rejects.toMatchObject({ phase: "validation" });
  expect(query.mock.calls.some(([statement]) => typeof statement === "string" && statement.startsWith("DROP DATABASE"))).toBe(false);
  expect(authorityEnd).toHaveBeenCalledOnce();
  expect(client.release).toHaveBeenCalledWith(true);
});

it("recreates an absent target without opening a principal connection or dropping again", async () => {
  const { database, query, authorities } = resetFixture({ exists: false });
  await expect(resetDatabase(database, target, target)).resolves.toEqual({ database: target, state: "fresh" });
  expect(authorities).toEqual([]);
  expect(query.mock.calls.some(([statement]) => typeof statement === "string" && statement.startsWith("DROP DATABASE"))).toBe(false);
  expect(query).toHaveBeenCalledWith(`CREATE DATABASE "${target}" OWNER agentcontrol_admin TEMPLATE template0`);
});
