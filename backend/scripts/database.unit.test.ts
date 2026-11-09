import pg from "pg";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initializeSchema, preflightSchema } from "./database.js";

vi.mock("../src/db/schema.js", () => ({
  schemaFingerprint: "a".repeat(64), schemaSql: "synthetic-schema", verifySchema: vi.fn(),
}));

beforeEach(() => {
  vi.spyOn(pg.Pool.prototype, "query").mockImplementation(async function(this: pg.Pool, statement) {
    if (this.options.database !== "postgres" || typeof statement !== "string"
      || !statement.startsWith("SELECT to_regclass")) throw new Error("Unexpected pool query.");
    return { rows: [{ name: null }], rowCount: 1 };
  });
});

afterEach(() => { vi.restoreAllMocks(); });

it.each(["preflight", "initialize"] as const)(
  "rejects an unmarked schema containing only a collation without writing schema data (%s)", async operation => {
    const database = new pg.Pool();
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    const query = vi.spyOn(client, "query").mockImplementation(async statement => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape.");
      if (statement.startsWith("SELECT to_regclass")) return { rows: [{ name: null }], rowCount: 1 };
      if (statement.includes("AS populated")) {
        return { rows: [{ populated: /FROM pg_collation WHERE collnamespace='public'::regnamespace/.test(statement) }], rowCount: 1 };
      }
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement) || statement.startsWith("SET TRANSACTION")
        || statement.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
      throw new Error("Unexpected schema write.");
    });
    await expect(operation === "preflight" ? preflightSchema(database) : initializeSchema(database))
      .rejects.toMatchObject({ code: "database_schema_reset_required" });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
    expect(query.mock.calls.some(([statement]) => typeof statement === "string" && /^(CREATE|INSERT|UPDATE|DELETE)\b/.test(statement))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  },
);

it.each(["preflight", "initialize"] as const)("preserves normal fresh initialization (%s)", async operation => {
  const database = new pg.Pool();
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockImplementation(async () => client);
  const query = vi.spyOn(client, "query").mockImplementation(async statement => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape.");
    if (statement.startsWith("SELECT to_regclass")) return { rows: [{ name: null }], rowCount: 1 };
    if (statement.includes("AS populated")) return { rows: [{ populated: false }], rowCount: 1 };
    if (["BEGIN", "COMMIT"].includes(statement) || statement.startsWith("SET TRANSACTION")
      || statement.includes("pg_advisory_xact_lock") || statement === "synthetic-schema"
      || statement.startsWith("INSERT INTO app_schema")) return { rows: [], rowCount: 0 };
    throw new Error("Unexpected schema query.");
  });
  if (operation === "preflight") {
    await expect(preflightSchema(database)).resolves.toEqual({
      state: "fresh", currentFingerprint: null, targetFingerprint: "a".repeat(64),
    });
    expect(query).not.toHaveBeenCalledWith("synthetic-schema");
  } else {
    await initializeSchema(database);
    expect(query).toHaveBeenCalledWith("synthetic-schema");
    expect(query).toHaveBeenCalledWith("INSERT INTO app_schema(singleton,fingerprint) VALUES (true,$1)", ["a".repeat(64)]);
  }
  expect(query).toHaveBeenCalledWith("COMMIT");
  expect(client.release).toHaveBeenCalledOnce();
});

function initializationFixture(current = false) {
  const database = new pg.Pool({ database: "agentcontrol_test_review" });
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const connect = vi.spyOn(database, "connect").mockImplementation(async () => client);
  const query = vi.spyOn(client, "query").mockImplementation(async statement => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape.");
    if (statement.startsWith("SELECT to_regclass")) return { rows: [{ name: current ? "app_schema" : null }], rowCount: 1 };
    if (statement.startsWith("SELECT fingerprint")) return { rows: [{ fingerprint: "a".repeat(64) }], rowCount: 1 };
    if (statement.includes("AS populated")) return { rows: [{ populated: false }], rowCount: 1 };
    if (["BEGIN", "COMMIT", "ROLLBACK", "synthetic-schema"].includes(statement)
      || statement.includes("pg_advisory_xact_lock") || statement.startsWith("INSERT INTO")) return { rows: [], rowCount: 0 };
    throw new Error("Unexpected initialization query.");
  });
  return { database, client, connect, query };
}

it("reads reset revocations only after acquiring the target initialization transaction", async () => {
  const { database, client, connect, query } = initializationFixture();
  let protectedRows = [{ tenant_id: "tenant", principal_id: "principal", epoch: "1", bearer_issued_after: "1000", adoption_request_cutoff: "31000" }];
  const latest = [{ tenant_id: "tenant", principal_id: "principal", epoch: "9007199254740993", bearer_issued_after: "2000", adoption_request_cutoff: "32000" }];
  vi.mocked(pg.Pool.prototype.query).mockImplementation(async function(this: pg.Pool, statement) {
    if (this.options.database !== "postgres" || typeof statement !== "string") throw new Error("Unexpected pool query.");
    if (statement.startsWith("SELECT to_regclass")) return { rows: [{ name: "agentcontrol_principal_revocations" }], rowCount: 1 };
    if (statement.includes("FROM public.agentcontrol_principal_revocations")) {
      return { rows: structuredClone(protectedRows), rowCount: protectedRows.length };
    }
    throw new Error("Unexpected maintenance query.");
  });
  connect.mockImplementation(async () => {
    // A revoke/reset completed before initialization acquired its target connection.
    protectedRows = latest;
    return client;
  });
  await initializeSchema(database);
  const insert = query.mock.calls.find(([statement]) => typeof statement === "string"
    && statement.startsWith("INSERT INTO data_principal_epochs"));
  expect(insert?.[1]).toEqual([JSON.stringify(latest)]);
  expect(insert?.[0]).toContain("adoption_request_cutoff bigint");
  expect(pg.Pool.prototype.query).toHaveBeenCalledWith(
    expect.stringContaining("WHERE database_name=$1"), ["agentcontrol_test_review"],
  );
  expect(query).toHaveBeenCalledWith("COMMIT");
  expect(client.release).toHaveBeenCalledOnce();
});

it("retries current initialization without depending on the maintenance database", async () => {
  const { database, client, query } = initializationFixture(true);
  vi.mocked(pg.Pool.prototype.query).mockRejectedValue(new Error("Maintenance is unavailable."));
  await expect(initializeSchema(database)).resolves.toBeUndefined();
  expect(pg.Pool.prototype.query).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalledWith("synthetic-schema");
  expect(query).toHaveBeenCalledWith("COMMIT");
  expect(client.release).toHaveBeenCalledOnce();
});

it("rolls back fresh initialization before DDL if protected revocations cannot be read", async () => {
  const { database, client, query } = initializationFixture();
  const failure = new Error("Protected revocations are unavailable.");
  vi.mocked(pg.Pool.prototype.query).mockRejectedValue(failure);
  await expect(initializeSchema(database)).rejects.toBe(failure);
  expect(query).toHaveBeenCalledWith("ROLLBACK");
  expect(query).not.toHaveBeenCalledWith("synthetic-schema");
  expect(query).not.toHaveBeenCalledWith("COMMIT");
  expect(client.release).toHaveBeenCalledOnce();
});

const preflightGrants = [
  ["data_principal_epochs", ["SELECT", "INSERT", "UPDATE"]],
  ["audit_events", ["SELECT", "INSERT"]],
  ["copilot_quarantine_audit", ["SELECT", "INSERT"]],
  ["official_usage_audit", ["SELECT", "INSERT"]],
] as const;

it.each([
  ...preflightGrants.flatMap(([table, privileges]) => privileges.map(privilege => ({ table, privilege }))),
  { table: "none", privilege: "none" },
])(
  "checks runtime preflight with missing $privilege on $table", async ({ table, privilege }) => {
    const database = new pg.Pool();
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    const query = vi.spyOn(client, "query").mockImplementation(async statement => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape.");
      if (statement.startsWith("SELECT to_regclass")) return { rows: [{ name: "app_schema" }], rowCount: 1 };
      if (statement.startsWith("SELECT fingerprint")) return { rows: [{ fingerprint: "a".repeat(64) }], rowCount: 1 };
      if (statement.includes("FROM pg_roles WHERE rolname='agentcontrol_app'")) {
        const required = [...statement.matchAll(
          /(?<!NOT )has_table_privilege\('agentcontrol_app','([^']+)','([^']+)'\)/g,
        )];
        // PostgreSQL accepts a privilege list when any listed privilege is held.
        const valid = required.every(([, relation, privileges]) => privileges.split(",")
          .some(held => relation !== table || held !== privilege));
        return { rows: [{ valid }], rowCount: 1 };
      }
      if (["BEGIN", "COMMIT", "ROLLBACK", "SET LOCAL ROLE agentcontrol_app", "RESET ROLE"].includes(statement)
        || statement.startsWith("SET TRANSACTION")) return { rows: [], rowCount: 0 };
      throw new Error("Unexpected preflight query.");
    });
    if (table === "none") {
      await expect(preflightSchema(database)).resolves.toEqual({
        state: "current", currentFingerprint: "a".repeat(64), targetFingerprint: "a".repeat(64),
      });
      expect(query).toHaveBeenCalledWith("SET LOCAL ROLE agentcontrol_app");
      expect(query).toHaveBeenCalledWith("RESET ROLE");
      expect(query).toHaveBeenCalledWith("COMMIT");
      expect(query).not.toHaveBeenCalledWith("ROLLBACK");
    } else {
      await expect(preflightSchema(database)).rejects.toThrow("Runtime role drift; operator recovery required.");
      expect(query).toHaveBeenCalledWith("ROLLBACK");
      expect(query).not.toHaveBeenCalledWith("SET LOCAL ROLE agentcontrol_app");
      expect(query).not.toHaveBeenCalledWith("COMMIT");
    }
    expect(client.release).toHaveBeenCalledOnce();
  },
);
