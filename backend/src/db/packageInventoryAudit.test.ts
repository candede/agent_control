import { beforeEach, describe, expect, it, vi } from "vitest";
import { PackageInventoryRepository } from "./packageInventory.js";
import { pool } from "./pool.js";

vi.mock("./pool.js", () => ({ pool: { query: vi.fn() }, secretValue: vi.fn(), transaction: vi.fn() }));

const query = vi.mocked(pool.query);
const emptyResult = { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
const scope = { tenantId: "tenant-package-audit", principalId: "inventory-reader" };
const snapshot = {
  id: "11111111-1111-4111-8111-111111111111", token_mode: "delegated", scope_kind: "broad", requested_ids: [],
  observed_count: 0, total_records: 0, page_count: 1,
  observed_at: new Date("2026-09-24T00:00:00Z"), expires_at: new Date("2026-10-24T00:00:00Z"),
};

beforeEach(() => {
  query.mockReset().mockRejectedValue(new Error("Unexpected package audit database query."));
});

describe("package inventory operation references", () => {
  it("uses only unexpired actor-scoped audit before counting and paging saved packages", async () => {
    query.mockResolvedValueOnce({ ...emptyResult, rows: [snapshot] })
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [{ total: 0, allowed: 0, blocked: 0 }] })
      .mockResolvedValueOnce(emptyResult);
    await new PackageInventoryRepository().list(scope, { operationIdPrefix: "REF_CASE", auditPrincipalId: "audit-reader" });
    expect(query).toHaveBeenCalledTimes(4);
    for (const [statement, values] of query.mock.calls.slice(2)) {
      expect(statement).toContain("audit.tenant_id=$2 AND audit.principal_id=$4");
      expect(statement).toContain("audit.observed_at>clock_timestamp()-interval '90 days'");
      expect(statement).toContain("audit.operation_id ILIKE $5 ESCAPE '\\'");
      expect(values?.slice(0, 5)).toEqual([snapshot.id, scope.tenantId, scope.principalId, "audit-reader", "REF\\_CASE%"]);
    }
  });
});
