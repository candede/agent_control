import { beforeEach, describe, expect, it, vi } from "vitest";
import { PackageInventoryRepository } from "./packageInventory.js";
import { pool } from "./pool.js";

vi.mock("./pool.js", () => ({
  pool: { query: vi.fn() },
  secretValue: vi.fn(),
  transaction: vi.fn(async (database, operation) => operation(database)),
}));
vi.mock("../services/operationalState.js", () => ({ requireProviderAdmissions: vi.fn() }));

const scope = { tenantId: "tenant-package-admission", principalId: "reader-package-admission" };
const input = { authorizationPrincipalId: scope.principalId, tokenMode: "delegated" as const, idempotencyKey: "new-refresh" };
const emptyResult = { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
const query = vi.mocked(pool.query);
const job = {
  id: "11111111-1111-4111-8111-111111111111",
  authorization_principal_id: scope.principalId,
  token_mode: "delegated",
  scope_kind: "broad",
  requested_ids: [],
  status: "waiting_authorization",
  page_count: 0,
  observed_count: 0,
  total_records: null,
  snapshot_id: null,
  error_code: null,
  message: null,
  created_at: new Date("2026-09-22T00:00:00.000Z"),
  attempted_at: null,
  updated_at: new Date("2026-09-22T00:00:00.000Z"),
  finished_at: null,
};

beforeEach(() => {
  query.mockReset().mockRejectedValue(new Error("Unexpected database query in package admission unit test."));
});

describe("package refresh admission", () => {
  it("counts only retained jobs still within their dispatch deadline under the scope lock", async () => {
    query.mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [{ count: 0 }] })
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [job] });
    const repository = new PackageInventoryRepository();

    await expect(repository.submit(scope, input)).resolves.toMatchObject({ status: "waiting_authorization" });

    expect(query.mock.calls[0][0]).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[0][1]).toEqual([`package-refresh:${scope.tenantId}:${scope.principalId}`]);
    const outstanding = query.mock.calls[2];
    expect(outstanding[0]).toContain("status IN ('waiting_authorization','running')");
    expect(outstanding[0]).toContain("expires_at>clock_timestamp()");
    expect(outstanding[0]).toContain("deadline_at>clock_timestamp()");
    expect(outstanding[1]).toEqual([scope.tenantId, scope.principalId]);
    expect(query.mock.calls[3][0]).toContain("INSERT INTO package_refresh_jobs");
    expect(query.mock.calls[4][1]).toEqual([expect.any(String), scope.tenantId, scope.principalId]);
  });

  it("still rejects five unexpired unfinished jobs before creating another job", async () => {
    query.mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [{ count: 5 }] });
    const repository = new PackageInventoryRepository();

    await expect(repository.submit(scope, input)).rejects.toMatchObject({ code: "job_limit" });
    expect(query).toHaveBeenCalledTimes(3);
  });
});
