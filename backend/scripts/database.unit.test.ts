import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { initializeSchema, preflightSchema } from "./database.js";

vi.mock("../src/db/schema.js", () => ({
  schemaFingerprint: "a".repeat(64), schemaSql: "synthetic-schema", verifySchema: vi.fn(),
}));

afterEach(() => { vi.restoreAllMocks(); });

it.each(["preflight", "initialize"] as const)(
  "rejects an unmarked schema containing only a collation without writing schema data (%s)", async operation => {
    const database = new pg.Pool();
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query."));
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
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query."));
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
    vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query."));
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
