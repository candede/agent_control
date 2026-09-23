import { createHash } from "node:crypto";
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
const queryHash = createHash("sha256").update(JSON.stringify({
  tokenMode: input.tokenMode, scopeKind: "broad", requestedIds: [],
})).digest("hex");
const requestHash = createHash("sha256").update(JSON.stringify({
  authorizationPrincipalId: input.authorizationPrincipalId, queryHash,
})).digest("hex");

beforeEach(() => {
  query.mockReset().mockRejectedValue(new Error("Unexpected database query in package admission unit test."));
});

describe("package refresh admission", () => {
  it("rejects an expired idempotent replay instead of returning an undefined job", async () => {
    query.mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [{ ...job, request_hash: requestHash }] })
      .mockResolvedValueOnce(emptyResult);

    await expect(new PackageInventoryRepository().submit(scope, input))
      .rejects.toMatchObject({ status: 409, code: "package_refresh_expired" });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.some(([statement]) => String(statement).includes("INSERT"))).toBe(false);
    expect(query.mock.calls[2][0]).toContain("job.expires_at>clock_timestamp()");
  });

  it("returns a retained idempotent job without creating another refresh", async () => {
    query.mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [{ ...job, request_hash: requestHash }] })
      .mockResolvedValueOnce({ ...emptyResult, rows: [job] });

    await expect(new PackageInventoryRepository().submit(scope, input))
      .resolves.toMatchObject({ id: job.id, status: "waiting_authorization" });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("keeps rejecting mismatched idempotent requests before reading the job", async () => {
    query.mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [{ ...job, request_hash: "different-request" }] });

    await expect(new PackageInventoryRepository().submit(scope, input))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("settles expired authorization handoffs instead of leaving them running without a worker", async () => {
    query.mockResolvedValueOnce({ ...emptyResult, rowCount: 1 })
      .mockResolvedValueOnce({ ...emptyResult, rows: [job] });
    await new PackageInventoryRepository().markWaitingAuthorization(scope, job.id);

    const statement = query.mock.calls[0][0];
    expect(typeof statement).toBe("string");
    if (typeof statement !== "string") throw new Error("Expected an authorization transition SQL statement.");
    const predicate = statement.slice(statement.lastIndexOf("WHERE"));
    expect(predicate).toContain("status='running'");
    expect(predicate).not.toContain("expires_at");
    expect(predicate).not.toContain("deadline_at");
    expect(statement).toContain("THEN 'waiting_authorization' ELSE 'failed' END");
    expect(statement).toContain("THEN 'interaction_required' ELSE 'package_refresh_expired' END");
    expect(statement).toContain("THEN NULL ELSE clock.checked_at END");
    expect(statement).toContain("expires_at>clock.checked_at AND deadline_at>clock.checked_at");
    expect(statement).toContain("FROM (SELECT clock_timestamp() AS checked_at) AS clock");
    expect(query.mock.calls[0][1]).toEqual([job.id, scope.tenantId, scope.principalId]);
  });

  it("starts a four-hour execution window without reviving an expired dispatch", async () => {
    query.mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ id: job.id }] });
    await expect(new PackageInventoryRepository().markRunning(scope, job.id)).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toContain("deadline_at=clock_timestamp()+($4::int*interval '1 millisecond')");
    expect(query.mock.calls[0][0]).toContain("deadline_at>clock_timestamp()");
    expect(query.mock.calls[0][0]).toContain("expires_at>clock_timestamp()");
    expect(query.mock.calls[0][1]).toEqual([job.id, scope.tenantId, scope.principalId, 4 * 60 * 60_000]);
  });

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
