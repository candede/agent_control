import { describe, expect, it, vi } from "vitest";
import { migrations, migrationChecksum, verifySchema } from "./schema.js";

function migrationHistory(): Array<{ version: number; checksum: string }> {
  return migrations.map(step => ({ version: step.version, checksum: migrationChecksum(step.sql) }));
}

const usageContract = {
  associations: "agent_usage_associations", revision: "agent_usage_state", triggers: 3, cascade: true,
};

function databaseWithResults(...rows: unknown[][]) {
  const query = vi.fn();
  for (const result of rows) query.mockResolvedValueOnce({ rows: result });
  return { query };
}

describe("migration source contracts", () => {
  it("keeps a contiguous migration history and preserves all pre-repair checksums", () => {
    expect(migrations.map(step => step.version)).toEqual(migrations.map((_step, index) => index + 1));
    const prior = migrationHistory().filter(step => step.version <= 39);
    expect(migrationChecksum(prior.map(step => `${step.version}:${step.checksum}`).join("\n")))
      .toBe("6b4abf664e09f778975af1f9c7908201da1e3e0bf7583b589ae7f1ba7ba622ba");
  });

  it("hashes the exact SQL bytes rather than normalized text", () => {
    expect(migrationChecksum("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(migrationChecksum("SELECT 1")).not.toBe(migrationChecksum("SELECT 1\n"));
  });

  it("repairs only legacy activity payloads without relabeling them as current projections", () => {
    expect(migrations.find(step => step.version === 40)?.sql.trim()).toBe(`
UPDATE defender_hunting_rows
SET row_data=(row_data-'actorUserKey'-'actorUserId') || '{"projectionVersion":2}'::jsonb
WHERE source_table='CloudAppEvents' AND projection_version=2;
    `.trim());
  });
});

describe("schema verification without a database", () => {
  it("accepts matching history, usage structures and runtime grants using read-only queries", async () => {
    const database = databaseWithResults(migrationHistory(), [usageContract], [{ valid: true }]);
    await expect(verifySchema(database)).resolves.toBeUndefined();
    expect(database.query).toHaveBeenCalledTimes(3);
    for (const [sql] of database.query.mock.calls) expect(sql.trim()).toMatch(/^SELECT /);
  });

  it.each(["missing", "modified", "newer", "gap"] as const)("rejects %s migration history before checking structures", async mismatch => {
    const history = migrationHistory();
    if (mismatch === "missing") history.pop();
    if (mismatch === "modified") history[0].checksum = "modified";
    if (mismatch === "newer") history.push({ version: 999, checksum: "unknown" });
    if (mismatch === "gap") history[0].version = 0;
    const database = databaseWithResults(history);
    await expect(verifySchema(database)).rejects.toThrow("Database schema is missing, modified or newer");
    expect(database.query).toHaveBeenCalledOnce();
  });

  it.each([
    [],
    [{ ...usageContract, associations: null }],
    [{ ...usageContract, revision: null }],
    [{ ...usageContract, triggers: 2 }],
    [{ ...usageContract, cascade: false }],
  ])("rejects incomplete usage structures: %j", async (...contract) => {
    const database = databaseWithResults(migrationHistory(), contract);
    await expect(verifySchema(database)).rejects.toThrow("Database usage association schema is missing or incomplete");
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it.each([[], [{ valid: false }]])("rejects missing or invalid runtime grants: %j", async (...permissions) => {
    const database = databaseWithResults(migrationHistory(), [usageContract], permissions);
    await expect(verifySchema(database)).rejects.toThrow("Database usage association runtime grants are invalid");
  });

  it.each([0, 1, 2])("propagates a query failure at step %i without returning success", async failedQuery => {
    const results = [migrationHistory(), [usageContract], [{ valid: true }]];
    const database = databaseWithResults(...results.slice(0, failedQuery));
    const failure = new Error("Database query failed");
    database.query.mockRejectedValueOnce(failure);
    await expect(verifySchema(database)).rejects.toBe(failure);
    expect(database.query).toHaveBeenCalledTimes(failedQuery + 1);
  });
});
