import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { DataSyncRepository } from "./dataSync.js";
import { activateAccountSession, assertAccountSessionValidation, beginAccountSessionValidation } from "./sessions.js";

afterEach(() => vi.restoreAllMocks());

describe("Users sync transaction authority", () => {
  it.each((["progress", "success", "attach"] as const).flatMap(operation =>
    (["session", "cancelled", "admission"] as const).map(boundary => ({ operation, boundary })),
  ))("rolls back $operation publication superseded during SQL by $boundary", async ({ operation, boundary }) => {
    const database = new pg.Pool({ max: 4 });
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not access a database."));
    const repository = new DataSyncRepository(database);
    const read = vi.spyOn(repository, "getRun").mockResolvedValue(undefined);
    const scope = { tenantId: `synthetic-sync-${randomUUID()}`, principalId: "synthetic-viewer" };
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    const controller = new AbortController();
    const reason = new AppError(503, "provider_admissions_disabled", "Provider admissions closed.");
    let closed = false;
    const fence = () => {
      controller.signal.throwIfAborted();
      assertAccountSessionValidation(validation);
      if (closed) throw reason;
    };
    const query = vi.spyOn(client, "query").mockImplementation(async sql => {
      if (typeof sql !== "string") throw new Error("Unexpected query shape.");
      if (sql.trimStart().startsWith("UPDATE data_sync_run_sources")) {
        if (boundary === "session") await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
        else if (boundary === "cancelled") controller.abort(reason);
        else closed = true;
      }
      return { command: "UPDATE", rowCount: 1, oid: 0, fields: [], rows: [{
        attempt: 1, status: "succeeded", count: 2, last_success_at: new Date(),
      }] };
    });

    try {
      const jobId = randomUUID(), runId = randomUUID();
      const publication = operation === "attach"
        ? repository.attachJob(scope, runId, "users", jobId, fence)
        : repository.updateSource(scope, runId, "users", {
          status: operation === "success" ? "succeeded" : "running", jobId, count: 2,
          message: "Synthetic Users progress.", canRetry: false,
        }, fence);
      await expect(publication).rejects.toMatchObject({ status: boundary === "session" ? 401 : 503 });
      const statements = query.mock.calls.map(([sql]) => sql);
      expect(statements).toContain("ROLLBACK");
      expect(statements).not.toContain("COMMIT");
      expect(read).not.toHaveBeenCalled();
      expect(client.release).toHaveBeenCalledOnce();
    } finally { await database.end(); }
  });
});

describe("data sync durable admission", () => {
  it.each((["submit", "automatic", "retry"] as const).flatMap(operation =>
    (["session", "cancelled", "admission"] as const).map(boundary => ({ operation, boundary })),
  ))("rolls back $operation admission superseded during SQL by $boundary", async ({ operation, boundary }) => {
    const f = admissionFixture();
    const validation = beginAccountSessionValidation(f.scope.tenantId, f.scope.principalId);
    const controller = new AbortController();
    const reason = new AppError(503, "maintenance", "Provider admissions closed.");
    let closed = false;
    f.onWrite = async () => {
      if (boundary === "session") await activateAccountSession(f.scope.tenantId, f.scope.principalId, async () => undefined);
      else if (boundary === "cancelled") controller.abort(reason);
      else closed = true;
    };
    const fence = () => {
      controller.signal.throwIfAborted();
      assertAccountSessionValidation(validation);
      if (closed) throw reason;
    };
    try {
      await expect(admit(f, operation, fence)).rejects.toMatchObject({ status: boundary === "session" ? 401 : 503 });
      expect(f.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
      expect(f.query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
      expect(f.client.release).toHaveBeenCalledOnce();
    } finally { await f.database.end(); }
  });

  it.each(["submit", "automatic"] as const)("rolls back %s rather than stranding committed work when admission readback fails", async operation => {
    const f = admissionFixture();
    const failure = new Error("Admitted run readback failed.");
    f.readFailure = failure;
    try {
      await expect(admit(f, operation)).rejects.toBe(failure);
      expect(f.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
      expect(f.query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
      expect(f.client.release).toHaveBeenCalledOnce();
    } finally { await f.database.end(); }
  });

  it.each(["submit", "automatic", "retry"] as const)("retires expired active rows before %s claims the unique active slot", async operation => {
    const f = admissionFixture();
    f.expiredActive = true;
    try {
      await admit(f, operation);
      expect(f.expiredActive).toBe(false);
      expect(f.query.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
      expect(f.client.release).toHaveBeenCalledOnce();
    } finally { await f.database.end(); }
  });
});

function admissionFixture() {
  const database = new pg.Pool({ max: 4 });
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockImplementation(async () => client);
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not access a database."));
  const scope = { tenantId: `synthetic-admission-${randomUUID()}`, principalId: "synthetic-viewer" };
  const runId = randomUUID(), now = new Date();
  const f = {
    database, client, scope, runId, repository: new DataSyncRepository(database),
    expiredActive: false, readFailure: undefined as Error | undefined,
    onWrite: async () => {},
  };
  const result = (rows: object[] = [], rowCount = rows.length): pg.QueryResult => ({
    command: "SELECT", rowCount, oid: 0, fields: [], rows,
  });
  const query = vi.spyOn(client, "query").mockImplementation(async (sql, values) => {
    if (typeof sql !== "string") throw new Error("Unexpected query shape.");
    const statement = sql.trimStart();
    if (statement.startsWith("UPDATE data_sync_runs") && statement.includes("expires_at<=clock_timestamp()")) {
      f.expiredActive = false;
      return result([], 1);
    }
    if (statement.startsWith("INSERT INTO data_sync_runs") || statement.startsWith("UPDATE data_sync_runs SET status='running'")) {
      if (f.expiredActive) throw Object.assign(new Error("Expired run still owns the active slot."), { code: "23505" });
    }
    if (statement.startsWith("INSERT INTO data_sync_runs") || statement.startsWith("UPDATE data_sync_run_sources")) await f.onWrite();
    if (statement.startsWith("SELECT requested.source_id")) return result([{ source_id: "users" }]);
    if (statement.startsWith("SELECT 1 FROM official_usage_state report")) return result();
    if (statement.startsWith("SELECT id,mode,status,started_at,updated_at,completed_at")) {
      if (statement.includes(",automatic") && f.readFailure) throw f.readFailure;
      return statement.includes("AND status IN") ? result() : result([{
        id: Array.isArray(values) ? values[0] : runId, mode: "full", status: "partial",
        started_at: now, updated_at: now, completed_at: now, automatic: false,
      }]);
    }
    if (statement.startsWith("SELECT * FROM data_sync_run_sources") || statement.startsWith("SELECT run_id,source_id")) {
      return result([{
        run_id: runId, source_id: "users", status: "failed", job_id: null, attempt: 1, count: null,
        last_success_at: null, updated_at: now, message: "Retry required.", can_retry: true,
      }]);
    }
    if (statement.startsWith("SELECT id FROM data_sync_runs")) return result();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement) || statement.startsWith("SELECT pg_advisory_xact_lock")
      || statement.startsWith("INSERT INTO") || statement.startsWith("UPDATE")) return result([], 1);
    throw new Error(`Unexpected synthetic admission statement: ${statement.slice(0, 80)}`);
  });
  return Object.assign(f, { query });
}

function admit(f: ReturnType<typeof admissionFixture>, operation: "submit" | "automatic" | "retry", beforeCommit?: () => void) {
  if (operation === "submit") return f.repository.submit(f.scope, { mode: "full", clearSavedData: true }, beforeCommit);
  if (operation === "automatic") return f.repository.submitDue(f.scope, undefined, beforeCommit);
  return f.repository.retry(f.scope, f.runId, ["users"], beforeCommit);
}
