import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { schemaFingerprint } from "../src/db/schema.js";
import { preflightSchema } from "./database.js";
import { preflightAzureDatabase } from "./azure-database.js";

vi.mock("./database.js", () => ({ preflightSchema: vi.fn(), databaseOperatorFailure: vi.fn() }));

function databaseFixture(currentFingerprint: string | null) {
  const database = new pg.Pool();
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [{ user_name: "agentcontrol_admin", database_name: "agentcontrol" }] })
    .mockResolvedValueOnce({ rows: [{ count: currentFingerprint === null ? 0 : 1 }] });
  database.query = query;
  vi.mocked(preflightSchema).mockReset().mockResolvedValue(currentFingerprint === null
    ? { state: "fresh", currentFingerprint: null, targetFingerprint: schemaFingerprint }
    : { state: "current", currentFingerprint, targetFingerprint: schemaFingerprint });
  return { database, query };
}

describe("Azure database installation modes without database access", () => {
  it.each(["upgrade", "unknown", ""])("rejects unsupported mode %j before any query", async mode => {
    const { database, query } = databaseFixture(schemaFingerprint);
    await expect(preflightAzureDatabase(database, mode)).rejects.toThrow("installation mode must be fresh or existing");
    expect(query).not.toHaveBeenCalled();
    expect(preflightSchema).not.toHaveBeenCalled();
  });

  it("accepts an explicitly empty fresh database without writes", async () => {
    const { database, query } = databaseFixture(null);
    await expect(preflightAzureDatabase(database, "fresh")).resolves.toEqual({
      mode: "fresh", database: "agentcontrol", currentFingerprint: null, targetFingerprint: schemaFingerprint, tableCount: 0,
    });
    expect(preflightSchema).toHaveBeenCalledExactlyOnceWith(database);
    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql] of query.mock.calls) expect(sql).toMatch(/^SELECT /);
  });

  it("accepts only the verified current schema for an existing installation", async () => {
    const { database, query } = databaseFixture(schemaFingerprint);
    await expect(preflightAzureDatabase(database, "existing")).resolves.toEqual({
      mode: "existing", database: "agentcontrol", currentFingerprint: schemaFingerprint, targetFingerprint: schemaFingerprint, tableCount: 1,
    });
    expect(preflightSchema).toHaveBeenCalledExactlyOnceWith(database);
    for (const [sql] of query.mock.calls) expect(sql).toMatch(/^SELECT /);
  });

  it("refuses fresh initialization over a saved schema", async () => {
    await expect(preflightAzureDatabase(databaseFixture(schemaFingerprint).database, "fresh")).rejects.toThrow("never replaced");
  });

  it("refuses existing installation when its schema is missing", async () => {
    await expect(preflightAzureDatabase(databaseFixture(null).database, "existing"))
      .rejects.toThrow("initialization fallback is forbidden");
  });

  it("propagates explicit schema-reset requirements without an initialization fallback", async () => {
    const { database, query } = databaseFixture(schemaFingerprint);
    const failure = Object.assign(new Error("Explicitly reset the owned development database"), { code: "database_schema_reset_required" });
    vi.mocked(preflightSchema).mockRejectedValueOnce(failure);
    await expect(preflightAzureDatabase(database, "existing")).rejects.toBe(failure);
    expect(query).toHaveBeenCalledOnce();
  });
});
