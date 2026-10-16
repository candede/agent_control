import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PackageRefreshJobs } from "./packageRefreshJobs.js";
import { pool } from "./pool.js";
import { activateAccountSession, revokeAccountSessionMutations } from "./sessions.js";
import { dataConnections } from "./dataConnections.js";

vi.mock("./pool.js", () => ({
  pool: { options: { max: 4 }, query: vi.fn(),
    connect: vi.fn(async () => { throw new Error("Unit tests must not connect to a database."); }) },
  secretValue: vi.fn((name: string) => name === "SESSION_SECRET" ? "synthetic-package-admission-session-secret" : undefined),
  transaction: vi.fn(async (database, operation, _signal, beforeCommit) => {
    const result = await operation(database);
    beforeCommit?.();
    return result;
  }),
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
  target_count: 0,
  result_revision: "2026-09-22 00:00:00+00",
  auto_details: false,
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

beforeEach(async () => {
  await activateAccountSession(scope.tenantId, scope.principalId, async () => {});
  query.mockReset().mockRejectedValue(new Error("Unexpected database query in package admission unit test."));
});
afterEach(() => vi.restoreAllMocks());

describe("package refresh admission", () => {
  it("materializes scoped recent detail targets once instead of rescanning job history per catalog row", async () => {
    query.mockResolvedValue(emptyResult);
    await expect(new PackageRefreshJobs().claimDueDetails(scope, scope.principalId)).resolves.toBeNull();
    const candidate = query.mock.calls.find(([sql]) => String(sql).includes("AS catalog_revision_hash"));
    expect(candidate).toBeDefined();
    const statement = String(candidate![0]);
    expect(statement).toContain("WITH recent_detail_attempts AS MATERIALIZED");
    expect(statement).toContain("SELECT DISTINCT t.target_id,t.catalog_revision_hash");
    expect(statement).toContain("attempted.tenant_id=$1 AND attempted.principal_id=$2 AND attempted.auto_details");
    expect(statement).toContain("LEFT JOIN recent_detail_attempts attempted ON attempted.target_id=r.native_id");
    expect(statement).toContain("attempted.catalog_revision_hash=");
    expect(statement).toContain("r.native_id=ANY($3::text[]) OR attempted.target_id IS NULL");
    expect(statement).not.toContain("OR NOT EXISTS");
    expect(statement).toContain('THEN 0 ELSE 1 END,r.native_id COLLATE "C" LIMIT 20');
    expect(candidate![1]).toEqual([scope.tenantId, scope.principalId, []]);
  });

  it("rejects an expired idempotent replay instead of returning an undefined job", async () => {
    query.mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [{ ...job, request_hash: requestHash }] })
      .mockResolvedValueOnce(emptyResult);

    await expect(new PackageRefreshJobs().submit(scope, input))
      .rejects.toMatchObject({ status: 409, code: "package_refresh_expired" });
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.some(([statement]) => String(statement).includes("INSERT"))).toBe(false);
    expect(query.mock.calls[3][0]).toContain("job.expires_at>clock_timestamp()");
  });

  it("returns a retained idempotent job without creating another refresh", async () => {
    query.mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [{ ...job, request_hash: requestHash }] })
      .mockResolvedValueOnce({ ...emptyResult, rows: [job] });

    await expect(new PackageRefreshJobs().submit(scope, input))
      .resolves.toMatchObject({ id: job.id, status: "waiting_authorization" });
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("keeps rejecting mismatched idempotent requests before reading the job", async () => {
    query.mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [{ ...job, request_hash: "different-request" }] });

    await expect(new PackageRefreshJobs().submit(scope, input))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("settles expired authorization handoffs instead of leaving them running without a worker", async () => {
    query.mockResolvedValueOnce({ ...emptyResult, rowCount: 1 })
      .mockResolvedValueOnce({ ...emptyResult, rows: [job] });
    await new PackageRefreshJobs().markWaitingAuthorization(scope, job.id);

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
    await expect(new PackageRefreshJobs().markRunning(scope, job.id)).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toContain("deadline_at=clock_timestamp()+($4::int*interval '1 millisecond')");
    expect(query.mock.calls[0][0]).toContain("deadline_at>clock_timestamp()");
    expect(query.mock.calls[0][0]).toContain("expires_at>clock_timestamp()");
    expect(query.mock.calls[0][0]).toContain("page_count=0,observed_count=0,total_records=NULL");
    expect(query.mock.calls[0][1]).toEqual([job.id, scope.tenantId, scope.principalId, 4 * 60 * 60_000]);
  });

  it.each(["later", "same"] as const)("retains automatic authorization backoff when the latest attempt is %s relative to sign-in", async timing => {
    const signedInAt = Date.parse("2026-09-22T00:01:00.000Z");
    query.mockResolvedValueOnce(emptyResult).mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce(emptyResult).mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [{
        created_at: job.created_at, attempted_at: new Date(signedInAt + (timing === "later" ? 1 : 0)),
        cooling_down: true, error_code: "interaction_required", requested_ids: ["Exact-Package"],
      }] });

    await expect(new PackageRefreshJobs().claimDueDetails(scope, scope.principalId, signedInAt)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(5);
  });

  it.each([null, new Date("2026-09-22T00:00:30.000Z")])(
    "allows renewed sign-in to retry older automatic authorization failures (attempt=%s)", async attemptedAt => {
      query.mockResolvedValueOnce(emptyResult).mockResolvedValueOnce(emptyResult)
        .mockResolvedValueOnce(emptyResult).mockResolvedValueOnce(emptyResult)
        .mockResolvedValueOnce({ ...emptyResult, rows: [{
          created_at: job.created_at, attempted_at: attemptedAt,
          cooling_down: true, error_code: "interaction_required", requested_ids: ["Exact-Package"],
        }] }).mockResolvedValueOnce(emptyResult);

      await expect(new PackageRefreshJobs().claimDueDetails(scope, scope.principalId,
        Date.parse("2026-09-22T00:01:00.000Z"))).resolves.toBeNull();
      expect(query).toHaveBeenCalledTimes(6);
      expect(query.mock.calls[5][1]).toEqual([scope.tenantId, scope.principalId, ["Exact-Package"]]);
    },
  );

  it("cleans up only the unchanged automatic claim after stale admission", async () => {
    const automatic = { ...job, auto_details: true, status: "failed", error_code: "authorization_expired" };
    query.mockResolvedValueOnce({ ...emptyResult, rowCount: 1 })
      .mockResolvedValueOnce({ ...emptyResult, rows: [automatic] });

    await expect(new PackageRefreshJobs().markFailed(scope, job.id, "authorization_expired", "Renew authorization.", job.result_revision))
      .resolves.toMatchObject({ id: job.id, status: "failed", errorCode: "authorization_expired" });

    const statement = String(query.mock.calls[0][0]);
    expect(statement).toContain("id=$1 AND tenant_id=$2 AND principal_id=$3");
    expect(statement).toContain("auto_details AND status='waiting_authorization' AND attempted_at IS NULL");
    expect(statement).toContain("updated_at::text=$6");
    expect(query.mock.calls[0][1]).toEqual([
      job.id, scope.tenantId, scope.principalId, "authorization_expired", "Renew authorization.", job.result_revision,
    ]);
  });

  it.each(["waiting_authorization", "running", "failed"])("does not overwrite saved %s work after automatic claim cleanup loses ownership", async status => {
    const replacement = { ...job, auto_details: true, status, attempted_at: new Date("2026-09-22T00:01:00.000Z"),
      result_revision: "2026-09-22 00:01:00+00" };
    query.mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [replacement] });

    await expect(new PackageRefreshJobs().markFailed(scope, job.id, "authorization_expired", "Renew authorization.", job.result_revision))
      .resolves.toMatchObject({ id: job.id, status, resultRevision: replacement.result_revision });
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0][0])).toContain("auto_details AND status='waiting_authorization' AND attempted_at IS NULL");
    expect(String(query.mock.calls[0][0])).toContain("updated_at::text=$6");
    expect(String(query.mock.calls[1][0])).toMatch(/^SELECT /);
  });

  it("counts only retained jobs still within their dispatch deadline under the scope lock", async () => {
    query.mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [{ count: 0 }] })
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [job] });
    const repository = new PackageRefreshJobs();

    await expect(repository.submit(scope, input)).resolves.toMatchObject({ status: "waiting_authorization" });

    expect(query.mock.calls[0][0]).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[0][1]).toEqual([`data-sync:${scope.tenantId}:${scope.principalId}`]);
    expect(query.mock.calls[1][1]).toEqual([`package-refresh:${scope.tenantId}:${scope.principalId}`]);
    const outstanding = query.mock.calls[3];
    expect(outstanding[0]).toContain("status IN ('waiting_authorization','running')");
    expect(outstanding[0]).toContain("expires_at>clock_timestamp()");
    expect(outstanding[0]).toContain("deadline_at>clock_timestamp()");
    expect(outstanding[1]).toEqual([scope.tenantId, scope.principalId]);
    expect(query.mock.calls[4][0]).toContain("INSERT INTO package_refresh_jobs");
    expect(query.mock.calls[5][1]).toEqual([expect.any(String), scope.tenantId, scope.principalId]);
  });

  it("still rejects five unexpired unfinished jobs before creating another job", async () => {
    query.mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [{ count: 5 }] });
    const repository = new PackageRefreshJobs();

    await expect(repository.submit(scope, input)).rejects.toMatchObject({ code: "job_limit" });
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("fences submission before commit when the initiating authority changes during the insert", async () => {
    let current = true;
    query.mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rows: [{ count: 0 }] })
      .mockImplementationOnce(async () => { current = false; return emptyResult; });
    const assertCurrent = () => { if (!current) throw new Error("Submission authority changed."); };
    await expect(new PackageRefreshJobs().submit(scope, input, assertCurrent))
      .rejects.toThrow("Submission authority changed.");
    expect(query).toHaveBeenCalledTimes(5);
    expect(String(query.mock.calls.at(-1)?.[0])).toContain("INSERT INTO package_refresh_jobs");
  });

  it("rejects saved history after account revocation during its summary read", async () => {
    query.mockResolvedValueOnce({ ...emptyResult, rows: [job] })
      .mockImplementationOnce(async () => {
        await revokeAccountSessionMutations(scope.tenantId, scope.principalId, async () => {});
        return { ...emptyResult, rows: [{ last_attempt_at: null, last_success_at: null }] };
      });
    await expect(new PackageRefreshJobs().listJobs(scope, scope.principalId)).rejects.toMatchObject({ code: "unauthorized" });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects target pages after account revocation during the selected read", async () => {
    const read = vi.spyOn(dataConnections(pool), "selectedRead").mockImplementationOnce(async () => {
      await revokeAccountSessionMutations(scope.tenantId, scope.principalId, async () => {});
      return { value: [], revision: job.result_revision, counts: { total: 0, filtered: 0 },
        page: { limit: 50, nextCursor: null, previousCursor: null } } as never;
    });
    await expect(new PackageRefreshJobs().targets(scope, {
      ...scope, authorizationHash: "viewer", sessionEpoch: "0",
    }, job.id, {})).rejects.toMatchObject({ code: "unauthorized" });
    expect(read).toHaveBeenCalledOnce();
  });

  it("fences selected idempotent submission before commit when its initiating authority changes", async () => {
    const selectionId = job.id;
    const selectedQueryHash = createHash("sha256").update(JSON.stringify({ selectionId, ids: null, recordIds: null })).digest("hex");
    const selectedRequestHash = createHash("sha256").update(JSON.stringify({
      authorizationPrincipalId: scope.principalId, queryHash: selectedQueryHash, tokenMode: "delegated", scopeKind: "exact",
    })).digest("hex");
    let current = true;
    query.mockResolvedValueOnce(emptyResult).mockResolvedValueOnce(emptyResult).mockImplementationOnce(async () => {
      current = false;
      return { ...emptyResult, rows: [{ id: job.id, request_hash: selectedRequestHash }] };
    });
    await expect(new PackageRefreshJobs().submitSelected(scope, {
      ...scope, authorizationHash: "viewer", sessionEpoch: "0",
    }, { selectionId, idempotencyKey: "selected-refresh" }, () => {
      if (!current) throw new Error("Selected submission authority changed.");
    })).rejects.toThrow("Selected submission authority changed.");
    expect(query).toHaveBeenCalledTimes(3);
  });
});
