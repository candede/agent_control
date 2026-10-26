import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectionIdentity } from "../services/dataSelections.js";
import { currentInventorySourcesSql, lockInventorySelection, lockInventorySources } from "./inventoryAuthority.js";

const identity: SelectionIdentity = {
  tenantId: "authority-tenant", principalId: "authority-principal", authorizationHash: "a".repeat(64), sessionEpoch: "0",
};

afterEach(() => vi.restoreAllMocks());

function result(rows: pg.QueryResultRow[] = []): pg.QueryResult {
  return { command: "SELECT", oid: 0, fields: [], rowCount: rows.length, rows };
}

function fixture() {
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const query = vi.spyOn(client, "query").mockImplementation(async (statement: unknown, values?: unknown[]) => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape");
    if (statement === "SELECT pg_advisory_xact_lock(hashtextextended($1,0))") return result();
    if (statement.startsWith("SELECT epoch FROM data_principal_epochs")) return result([{ epoch: identity.sessionEpoch }]);
    if (statement.startsWith("WITH inventory AS")) return result([{ scope_id: "a" }, { scope_id: "z" }]);
    if (statement.startsWith("SELECT * FROM data_scope_epochs")) return result([{ id: values?.[0] }]);
    throw new Error(`Unexpected inventory authority query: ${statement}`);
  });
  return { client, query };
}

describe("inventory authority fences", () => {
  it.each([false, true])("locks synchronization, principal and scopes in order (selected=%s)", async selected => {
    const { client, query } = fixture();
    if (selected) await lockInventorySelection(client, identity, "selected");
    else await lockInventorySources(client, identity);

    expect(query).toHaveBeenCalledTimes(5);
    expect(query).toHaveBeenNthCalledWith(1, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`data-sync:${identity.tenantId}:${identity.principalId}`]);
    expect(query).toHaveBeenNthCalledWith(2,
      "SELECT epoch FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2 FOR SHARE",
      [identity.tenantId, identity.principalId]);
    expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining("WITH inventory AS"),
      [identity.tenantId, identity.principalId, selected ? "selected" : null, selected ? identity.authorizationHash : null]);
    for (const [index, scopeId] of ["a", "z"].entries()) {
      expect(query).toHaveBeenNthCalledWith(index + 4,
        "SELECT * FROM data_scope_epochs WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [scopeId, identity.tenantId]);
    }
    const sql = query.mock.calls[2][0];
    expect(sql).toContain("selection.tenant_id=$1 AND selection.principal_id=$2 AND selection.authorization_hash=$4");
    expect(sql).toContain("scope.source='inventory_canonical' AND scope.token_mode='delegated' AND scope.selector='complete'");
    expect(sql).toContain("UNION SELECT scope_id FROM inventory");
    expect(sql).toContain('UNION SELECT input."scopeId" FROM inventory');
    expect(sql).toContain("allowed.tenant_id=$1 AND (allowed.scope_kind='tenant' OR allowed.principal_id=$2)");
    expect(sql).toContain("ORDER BY scopes.scope_id");
  });

  it.each([1, 2, 3, 4, 5])("propagates a failure at locking step %s without continuing", async failedStep => {
    const { client, query } = fixture();
    const original = query.getMockImplementation()!;
    const failure = new Error("inventory authority lock failed");
    let calls = 0;
    query.mockImplementation(async (statement, values) => {
      if (++calls === failedStep) throw failure;
      return original(statement, values);
    });

    await expect(lockInventorySelection(client, identity, "selected")).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(failedStep);
  });

  it("rejects a scope that disappears before its row lock", async () => {
    const { client, query } = fixture();
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      if (typeof statement === "string" && statement.startsWith("SELECT * FROM data_scope_epochs")) return result();
      return original(statement, values);
    });

    await expect(lockInventorySources(client, identity)).rejects.toThrow("data_scope_missing");
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("requires live tenant/principal authority after both the selected time and the wall clock", () => {
    expect(currentInventorySourcesSql).toContain("FROM inventory_live_sources");
    expect(currentInventorySourcesSql).toContain("tenant_id=$1 AND principal_id=$2");
    expect(currentInventorySourcesSql).toContain("($3::text IS NULL OR agent_id=$3)");
    expect(currentInventorySourcesSql).toContain("authority_expires_at>GREATEST($4::timestamptz,clock_timestamp())");
  });
});
