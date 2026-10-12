import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PowerPlatformRefreshJobs } from "./powerPlatformRefreshJobs.js";
import { transaction } from "./pool.js";

vi.mock("./pool.js", () => ({
  pool: {},
  secretValue: vi.fn(),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));
vi.mock("../services/operationalState.js", () => ({ requireProviderAdmissions: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

const scope = { tenantId: "synthetic-tenant", principalId: "synthetic-reader" };
const now = new Date("2026-10-11T14:00:00Z");
function row(status = "waiting_authorization", deadlineAt = now) {
  return {
    id: "11111111-1111-4111-8111-111111111111", role_scope: "unknown", environment_scope: "",
    requested_types: ["microsoft.copilotstudio/agents"], status, page_count: 3, observed_count: 20,
    total_records: 100, unknown_field_count: 1, error_code: null, message: null,
    created_at: new Date(now.getTime() - 1_800_000), attempted_at: new Date(now.getTime() - 1000),
    updated_at: new Date(now.getTime() - 500), finished_at: null, snapshot_id: null,
    deadline_at: deadlineAt, checked_at: now,
  };
}
function result(rows: object[], command = "SELECT"): pg.QueryResult {
  return { rows, command, rowCount: rows.length, fields: [], oid: 0 };
}
function fixture() {
  const database = new pg.Pool({ max: 4 });
  const query = vi.fn<(sql: unknown, parameters?: unknown) => Promise<pg.QueryResult>>()
    .mockRejectedValue(new Error("Unexpected unit-test query."));
  vi.spyOn(database, "query").mockImplementation(query);
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
  return { database, query, jobs: new PowerPlatformRefreshJobs(database) };
}

describe("Power Platform refresh deadline metadata", () => {
  it("hands the worker the persisted deadline without exposing an execution-only field in saved API metadata", async () => {
    const { jobs, query } = fixture();
    const deadlineAt = new Date(now.getTime() + 1000);
    const value = row("waiting_authorization", deadlineAt);
    query.mockResolvedValueOnce(result([value])).mockResolvedValueOnce(result([value]));
    expect(await jobs.getJobForExecution(scope, value.id)).toMatchObject({
      job: { id: value.id, status: "waiting_authorization" }, deadlineAt,
    });
    expect(await jobs.getJob(scope, value.id)).not.toHaveProperty("deadlineAt");
  });

  it.each(["requested", "sync_cleanup"] as const)(
    "persists %s provenance and does not let later default cleanup overwrite the terminal cancellation", async reason => {
      const { jobs, query } = fixture();
      const value = row("running", new Date(now.getTime() + 1000));
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      vi.spyOn(client, "query").mockImplementation(async (sql, parameters) => {
        expect(String(sql)).toContain("status IN ('waiting_authorization','running')");
        if (["waiting_authorization", "running"].includes(value.status)) {
          Object.assign(value, { status: "cancelled", error_code: parameters?.[3], message: parameters?.[4] });
        }
        return result([]);
      });
      const cancelTransaction = async (_database: pg.Pool, work: (client: pg.PoolClient) => Promise<unknown>) => work(client);
      vi.mocked(transaction).mockImplementationOnce(cancelTransaction).mockImplementationOnce(cancelTransaction);
      query.mockImplementation(async () => result([value]));
      const expectedCode = reason === "requested" ? "cancelled" : "data_sync_cleanup";
      const first = await jobs.cancel(scope, value.id, reason);
      expect(first).toMatchObject({ status: "cancelled", errorCode: expectedCode });
      expect(first?.message).toContain(reason === "requested" ? "requesting principal" : "original failure or interruption");
      expect(await jobs.cancel(scope, value.id)).toEqual(first);
    },
  );

  it.each(["environment-\uD83D", "environment-\uDE00"])("rejects non-storable environment scope before admission (%s)", async environmentScope => {
    const { jobs, query } = fixture();
    vi.mocked(transaction).mockClear();
    await expect(jobs.submit(scope, {
      roleScope: "unknown", idempotencyKey: "invalid-environment", environmentScope,
      requestedTypes: ["microsoft.copilotstudio/agents"],
    })).rejects.toMatchObject({ status: 400, code: "invalid_inventory_scope" });
    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("preserves supplementary Unicode environment scope through admission and idempotent reuse", async () => {
    const { jobs, query } = fixture();
    const environmentScope = "environment-😀";
    let inserted: { id: string; environment_scope: string; requested_types: string[] } | undefined;
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(client, "query").mockImplementation(async (sql, parameters) => {
      const statement = String(sql);
      if (statement.includes("SELECT id,environment_scope,requested_types")) return result(inserted ? [inserted] : []);
      if (statement.includes("count(*)::int AS count")) return result([{ count: 0 }]);
      if (statement.includes("INSERT INTO power_platform_refresh_jobs")) inserted = {
        id: String(parameters?.[0]), environment_scope: String(parameters?.[6]),
        requested_types: JSON.parse(String(parameters?.[7])),
      };
      return result([]);
    });
    vi.mocked(transaction).mockImplementationOnce(async (_database, work, _signal, beforeCommit) => {
      const value = await work(client);
      beforeCommit?.();
      return value;
    }).mockImplementationOnce(async (_database, work, _signal, beforeCommit) => {
      const value = await work(client);
      beforeCommit?.();
      return value;
    });
    query.mockImplementation(async () => result([{ ...row("waiting_authorization", new Date(now.getTime() + 1000)), ...inserted }]));
    const input = { roleScope: "unknown" as const, idempotencyKey: "unicode-environment", environmentScope,
      requestedTypes: ["microsoft.copilotstudio/agents"] as const };
    const first = await jobs.submit(scope, input);
    const reused = await jobs.submit(scope, input);
    expect(first).toMatchObject({ environmentScope });
    expect(reused).toEqual(first);
    expect(inserted?.environment_scope).toBe(environmentScope);
  });

  it.each(["waiting_authorization", "running"])("reports a retained expired %s job as terminal from both get and history", async status => {
    const { jobs, query } = fixture();
    query.mockResolvedValueOnce(result([row(status)]))
      .mockResolvedValueOnce(result([row(status)]))
      .mockResolvedValueOnce(result([{ last_attempt_at: now, last_success_at: null }]));
    const expected = { status: "failed", errorCode: "inventory_job_expired", finishedAt: now.toISOString(),
      message: expect.stringContaining("Start a new refresh") };
    expect(await jobs.getJob(scope, row().id)).toMatchObject(expected);
    expect((await jobs.listJobs(scope)).value).toEqual([expect.objectContaining(expected)]);
    for (const call of query.mock.calls.slice(0, 2)) {
      expect(call[0]).toContain("clock AS MATERIALIZED");
      expect(call[0]).toContain("job.expires_at>clock.checked_at");
    }
  });

  it.each(["waiting_authorization", "running", "succeeded", "failed", "cancelled"])(
    "preserves an unexpired or already-terminal %s status", async status => {
      const { jobs, query } = fixture();
      const value = row(status, new Date(now.getTime() + (["running", "waiting_authorization"].includes(status) ? 1 : -1)));
      query.mockResolvedValueOnce(result([value]));
      expect(await jobs.getJob(scope, value.id)).toMatchObject({ status, finishedAt: null });
    },
  );

  it("does not charge expired waiting jobs against admission quota", async () => {
    const { database, jobs, query } = fixture();
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const write = vi.spyOn(client, "query").mockImplementation(async sql => {
      const statement = String(sql);
      if (statement.includes("count(*)::int AS count")) {
        return result([{ count: statement.includes("deadline_at>clock_timestamp()") ? 0 : 5 }]);
      }
      return result([]);
    });
    vi.mocked(transaction).mockImplementationOnce(async (_database, work, _signal, beforeCommit) => {
      const value = await work(client);
      beforeCommit?.();
      return value;
    });
    query.mockResolvedValueOnce(result([row("waiting_authorization", new Date(now.getTime() + 1000))]));
    expect(await jobs.submit(scope, { roleScope: "unknown", idempotencyKey: "after-expiry",
      requestedTypes: ["microsoft.copilotstudio/agents"] })).toMatchObject({ status: "waiting_authorization" });
    expect(transaction).toHaveBeenCalledWith(database, expect.any(Function), undefined, expect.any(Function));
    expect(write.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO power_platform_refresh_jobs"))).toBe(true);
  });

  it("recovers expired authorization waits as well as interrupted running jobs", async () => {
    const { jobs, query } = fixture();
    query.mockResolvedValueOnce(result([{}], "UPDATE")).mockImplementationOnce(async sql =>
      result(String(sql).includes("status IN ('running','waiting_authorization')") ? [{}] : [], "UPDATE"));
    expect(await jobs.recoverInterrupted()).toBe(2);
  });

  it("clears previous-attempt counters only on successful waiting-to-running activation", async () => {
    const { jobs, query } = fixture();
    query.mockResolvedValueOnce(result([{}], "UPDATE"));
    expect(await jobs.markRunning(scope, row().id)).toBe(true);
    const statement = String(query.mock.calls[0][0]);
    expect(statement).toContain("page_count=0,observed_count=0,total_records=NULL,unknown_field_count=0");
    expect(statement).toContain("status='waiting_authorization'");
    expect(statement).toContain("deadline_at>clock_timestamp()");
  });
});
