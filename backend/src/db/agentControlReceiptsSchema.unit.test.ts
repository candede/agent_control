import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { agentControlReceiptsSql, verifyAgentControlReceiptsSchema } from "./agentControlReceiptsSchema.js";

function databaseWithRows(rows: pg.QueryResultRow[]) {
  const database = new pg.Pool();
  const query = vi.spyOn(database, "query").mockImplementation(async () => ({
    command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows,
  }));
  return { database, query };
}

describe("control receipt schema verification without a database", () => {
  it("requires string actor identities without blocking unaccepted previews", () => {
    expect(agentControlReceiptsSql).toMatch(
      /CONSTRAINT agent_control_receipts_actor_identity_check CHECK \(initiating_actor IS NULL\s+OR \(jsonb_typeof\(initiating_actor->'tenantId'\)='string'\s+AND jsonb_typeof\(initiating_actor->'homeAccountId'\)='string'\) IS TRUE\)/,
    );
  });

  it("verifies the validated actor identity expression alongside the existing exact constraints and grants", async () => {
    const { database, query } = databaseWithRows([{ valid: true }]);
    await expect(verifyAgentControlReceiptsSchema(database)).resolves.toBeUndefined();
    const [statement, values] = query.mock.calls[0];
    expect(statement).toContain("count(*)=8 AND bool_and(convalidated)");
    expect(statement).toContain("AND conname<>'agent_control_receipts_actor_identity_check'");
    expect(statement).toContain("AND conname='agent_control_receipts_actor_identity_check' AND contype='c' AND convalidated");
    expect(statement).toContain("AND pg_get_expr(conbin,conrelid)=$3");
    expect(values?.[2]).toBe(
      "((initiating_actor IS NULL) OR (((jsonb_typeof((initiating_actor -> 'tenantId'::text)) = 'string'::text) AND (jsonb_typeof((initiating_actor -> 'homeAccountId'::text)) = 'string'::text)) IS TRUE))",
    );
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(statement).toContain(`has_table_privilege(current_user,'agent_control_receipts','${privilege}')`);
    }
    expect(statement).not.toContain("'SELECT,INSERT,UPDATE,DELETE'");
    expect(values?.[1]).toBe(agentControlReceiptsSql.split("AS $$")[1].split("$$;")[0]);
  });

  it.each([{ rows: [] }, { rows: [{ valid: false }] }, { rows: [{ valid: null }] }])("rejects missing or invalid schema evidence: $rows", async ({ rows }) => {
    await expect(verifyAgentControlReceiptsSchema(databaseWithRows(rows).database)).rejects.toThrow("agent_control_receipt_schema_invalid");
  });

  it("does not conceal database verification failures", async () => {
    const { database, query } = databaseWithRows([]);
    query.mockImplementationOnce(async () => { throw new Error("synthetic_catalog_failure"); });
    await expect(verifyAgentControlReceiptsSchema(database)).rejects.toThrow("synthetic_catalog_failure");
  });
});
