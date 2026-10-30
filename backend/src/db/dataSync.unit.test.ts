import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { DataSyncRepository } from "./dataSync.js";
import { activateAccountSession, assertAccountSessionValidation, beginAccountSessionValidation } from "./sessions.js";

afterEach(() => vi.restoreAllMocks());

describe("data sync run completion", () => {
  it.each([
    { status: "succeeded", aggregate: "completed", terminal: true },
    { status: "failed", aggregate: "partial", terminal: true },
    { status: "waiting_authorization", aggregate: "waiting", terminal: false },
    { status: "permission_required", aggregate: "waiting", terminal: false },
  ] as const)(
    "reconciles a retained upload without reopening provider work that is $status", async ({ status, aggregate, terminal }) => {
      const database = new pg.Pool({ max: 4 });
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      vi.spyOn(database, "connect").mockImplementation(async () => client);
      vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not access a database."));
      const repository = new DataSyncRepository(database);
      vi.spyOn(repository, "getRun").mockResolvedValue(undefined);
      const runId = randomUUID();
      const scope = { tenantId: "synthetic-run-completion", principalId: "synthetic-viewer" };
      const acceptedAt = new Date("2026-09-15T10:00:00.000Z");
      const query = vi.spyOn(client, "query").mockImplementation(async sql => {
        if (typeof sql !== "string") throw new Error("Unexpected query shape.");
        const rows = sql.startsWith("SELECT status FROM data_sync_run_sources")
          ? [{ status: "succeeded" }, { status }]
          : sql.startsWith("UPDATE data_sync_run_sources source")
            ? [{ count: 0, last_success_at: acceptedAt }] : [];
        return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
      });

      try {
        await repository.updateSource(scope, runId, "usage_reports", {
          status: "succeeded", count: 0, lastSuccessAt: acceptedAt.toISOString(),
          message: "Accepted a complete zero-row usage bundle.", canRetry: false,
        });
        const publication = query.mock.calls.find(([sql]) => typeof sql === "string" && sql.startsWith("UPDATE data_sync_run_sources source"));
        expect(publication?.[0]).toContain(
          "OR run.status='partial' AND source.source_id='usage_reports' AND source.status='awaiting_upload' AND $5='succeeded'",
        );
        expect(query).toHaveBeenCalledWith(
          expect.stringContaining("INSERT INTO data_sync_success_markers"),
          [scope.tenantId, "usage_reports", 0, acceptedAt],
        );
        expect(query).toHaveBeenCalledWith(
          expect.stringContaining("completed_at=CASE WHEN $5"),
          [runId, scope.tenantId, scope.principalId, aggregate, terminal],
        );
        const finalization = query.mock.calls.find(([sql]) => typeof sql === "string" && sql.startsWith("UPDATE data_sync_runs SET status=$4"));
        expect(finalization?.[0]).toContain(
          "AND (status IN ('running','waiting') OR status='partial' AND $4='completed')",
        );
        expect(finalization?.[0]).toContain(
          "CASE WHEN status='partial' THEN clock_timestamp() ELSE COALESCE(completed_at,clock_timestamp()) END",
        );
        expect(query).toHaveBeenCalledWith("COMMIT");
        expect(client.release).toHaveBeenCalledOnce();
      } finally { await database.end(); }
    },
  );
});

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

describe("tenant source collection conflicts", () => {
  it("joins an equivalent active run without readmitting a source another account is collecting", async () => {
    const f = admissionFixture();
    const input = { mode: "initial", sources: ["users", "graph_packages"] } as const;
    f.existingRequestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    f.collectorSources.add("graph_packages");
    f.sourceRows[0].status = "running";
    f.sourceRows.push({ ...f.sourceRows[0], source_id: "graph_packages", status: "failed", can_retry: true });
    try {
      await expect(f.repository.submit(f.scope, { ...input, sources: [...input.sources] })).resolves.toMatchObject({
        created: false, run: { id: f.runId, status: "running" },
      });
      expect(f.query.mock.calls.some(([sql]) => typeof sql === "string" && sql.startsWith("INSERT INTO"))).toBe(false);
      expect(f.query.mock.calls.some(([sql]) => typeof sql === "string" && sql.startsWith("SELECT 1 FROM data_sync_runs run"))).toBe(false);
      expect(f.query).toHaveBeenCalledWith("COMMIT");
    } finally { await f.database.end(); }
  });

  it.each([
    { source: "users", conflict: true },
    { source: "graph_packages", conflict: false },
  ])("checks new work against the other account's $source collection", async ({ source, conflict }) => {
    const f = admissionFixture();
    f.collectorSources.add(source);
    try {
      const admission = f.repository.submit(f.scope, { mode: "incremental", sources: ["users"] });
      if (conflict) {
        await expect(admission).rejects.toMatchObject({ status: 409, code: "data_sync_active" });
        expect(f.query).toHaveBeenCalledWith("ROLLBACK");
        expect(f.query.mock.calls.some(([sql]) => typeof sql === "string" && sql.startsWith("INSERT INTO"))).toBe(false);
      } else {
        await expect(admission).resolves.toMatchObject({ created: true });
        expect(f.query).toHaveBeenCalledWith("COMMIT");
      }
    } finally { await f.database.end(); }
  });

  it.each([{ requested: undefined }, { requested: ["users"] }] as const)(
    "checks only the actual retry selection ($requested)", async ({ requested }) => {
      const f = admissionFixture();
      f.collectorSources.add("graph_packages");
      f.sourceRows.push({ ...f.sourceRows[0], source_id: "graph_packages", status: "succeeded", can_retry: false });
      try {
        await expect(f.repository.retry(f.scope, f.runId, requested)).resolves.toEqual(["users"]);
        expect(f.query).toHaveBeenCalledWith(
          expect.stringContaining("SELECT 1 FROM data_sync_runs run"),
          [f.scope.tenantId, f.scope.principalId, ["users"]],
        );
        expect(f.query).toHaveBeenCalledWith(
          expect.stringContaining("attempt=attempt+1"),
          [f.runId, f.scope.tenantId, f.scope.principalId, ["users"]],
        );
        expect(f.query).toHaveBeenCalledWith("COMMIT");
      } finally { await f.database.end(); }
    },
  );

  it.each([{ requested: undefined }, { requested: ["users"] }] as const)(
    "still rejects an overlapping retry selection ($requested)", async ({ requested }) => {
      const f = admissionFixture();
      f.collectorSources.add("users");
      try {
        await expect(f.repository.retry(f.scope, f.runId, requested)).rejects.toMatchObject({
          status: 409, code: "data_sync_active",
        });
        expect(f.query.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("attempt=attempt+1"))).toBe(false);
        expect(f.query).toHaveBeenCalledWith("ROLLBACK");
      } finally { await f.database.end(); }
    },
  );
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
    existingRequestHash: undefined as string | undefined, collectorSources: new Set<string>(),
    sourceRows: [{
      run_id: runId, source_id: "users", status: "failed", job_id: null, attempt: 1, count: null,
      last_success_at: null, updated_at: now, message: "Retry required.", can_retry: true,
    }],
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
      return statement.includes("AND status IN") && !f.existingRequestHash ? result() : result([{
        id: statement.includes("AND status IN") ? runId : Array.isArray(values) ? values[0] : runId,
        mode: "full", status: f.existingRequestHash ? "running" : "partial",
        started_at: now, updated_at: now, completed_at: f.existingRequestHash ? null : now, automatic: false,
      }]);
    }
    if (statement.startsWith("SELECT request_hash FROM data_sync_runs")) return result([{ request_hash: f.existingRequestHash }]);
    if (statement.startsWith("SELECT * FROM data_sync_run_sources") || statement.startsWith("SELECT run_id,source_id")) {
      return result(f.sourceRows);
    }
    if (statement.startsWith("SELECT 1 FROM data_sync_runs run")) {
      if (!Array.isArray(values) || !Array.isArray(values[2])) throw new Error("Missing collector source selection.");
      const requested = values[2];
      return result([...f.collectorSources].some(source => requested.includes(source)) ? [{}] : []);
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
