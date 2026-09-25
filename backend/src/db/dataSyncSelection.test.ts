import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { DataSyncRepository } from "./dataSync.js";
import { pool } from "./pool.js";

const scope = { tenantId: "sync-selection-tenant", principalId: "sync-selection-reader" };
const query = vi.spyOn(pool, "query");
const emptyResult = { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };

beforeEach(() => {
  query.mockReset();
  query.mockRejectedValue(new Error("Unexpected database query in sync-selection unit test."));
});

afterAll(() => {
  query.mockRestore();
});

describe("data sync current-run selection", () => {
  it("selects latest activity with deterministic ties while preserving ownership and retention", async () => {
    query.mockResolvedValueOnce(emptyResult);

    expect(await new DataSyncRepository().getLatestRun(scope)).toBeUndefined();
    expect(query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("ORDER BY updated_at DESC,started_at DESC,id DESC LIMIT 1"),
      [scope.tenantId, scope.principalId],
    );
    expect(query.mock.calls[0][0]).toContain("tenant_id=$1 AND principal_id=$2 AND expires_at>clock_timestamp()");
  });

  it.each(["running", "completed"] as const)("projects a %s historical retry selected as latest activity", async status => {
    const id = "11111111-1111-4111-8111-111111111111";
    const startedAt = new Date("2026-09-15T10:00:00.000Z");
    const updatedAt = new Date("2026-09-16T10:00:00.000Z");
    query
      .mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ id }] })
      .mockResolvedValueOnce({
        ...emptyResult, rowCount: 1,
        rows: [{
          id, mode: "incremental", status, started_at: startedAt, updated_at: updatedAt,
          completed_at: status === "completed" ? updatedAt : null,
        }],
      })
      .mockResolvedValueOnce({
        ...emptyResult, rowCount: 1,
        rows: [{
          run_id: id, source_id: "users", status: status === "completed" ? "succeeded" : "running",
          job_id: null, attempt: 1, count: 0,
          last_success_at: status === "completed" ? updatedAt : startedAt, updated_at: updatedAt,
          message: "Retry observation.", can_retry: false,
        }],
      });

    expect(await new DataSyncRepository().getLatestRun(scope)).toMatchObject({
      id, status, startedAt: startedAt.toISOString(), updatedAt: updatedAt.toISOString(),
      sources: [{ source: "users", count: 0, status: status === "completed" ? "succeeded" : "running" }],
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][1]).toEqual([id, scope.tenantId, scope.principalId]);
    expect(query.mock.calls[2][1]).toEqual([id, scope.tenantId, scope.principalId]);
  });

  it("keeps retained history ordered by original start time", async () => {
    query.mockResolvedValueOnce(emptyResult);

    expect(await new DataSyncRepository().listRuns(scope, 12)).toEqual([]);
    expect(query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("ORDER BY started_at DESC,id DESC LIMIT $3"),
      [scope.tenantId, scope.principalId, 12],
    );
  });

  it("ignores expired running or waiting rows during automatic admission", async () => {
    const execute = vi.fn(async () => emptyResult);
    const client = { query: execute, release: vi.fn() };
    const database = { query: execute, connect: vi.fn(async () => client) } as unknown as pg.Pool;
    expect(await new DataSyncRepository(database).submitDue(scope)).toEqual({ run: null, created: false });
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/status IN \('running','waiting'\)\s+AND expires_at>clock_timestamp\(\)/),
      [scope.tenantId, scope.principalId],
    );
    expect(execute).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("limits interrupted-admission pausing to the run that admission changed", async () => {
    const execute = vi.fn(async () => emptyResult);
    const client = { query: execute, release: vi.fn() };
    const database = { query: execute, connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const id = "11111111-1111-4111-8111-111111111111";
    await new DataSyncRepository(database).pausePrincipal(scope, "Interrupted admission.", id);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("AND ($4::uuid IS NULL OR run.id=$4::uuid)"),
      [scope.tenantId, scope.principalId, "Interrupted admission.", id],
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("AND ($3::uuid IS NULL OR id=$3::uuid)"),
      [scope.tenantId, scope.principalId, id],
    );
    expect(execute).toHaveBeenCalledWith("COMMIT");
  });

  it.each(["cancelled", "completed", "partial"] as const)("only accepts an idempotent cancellation for a %s terminal run", async status => {
    const execute = vi.fn(async (text: string) => text.startsWith("SELECT status")
      ? { ...emptyResult, rowCount: 1, rows: [{ status }] } : emptyResult);
    const client = { query: execute, release: vi.fn() };
    const database = { query: execute, connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const repository = new DataSyncRepository(database);
    const get = vi.spyOn(repository, "getRun").mockResolvedValue(undefined);
    const id = "11111111-1111-4111-8111-111111111111";
    if (status === "cancelled") {
      await repository.cancel(scope, id);
      expect(get).toHaveBeenCalledWith(scope, id);
      expect(execute).toHaveBeenCalledWith("COMMIT");
    } else {
      await expect(repository.cancel(scope, id)).rejects.toMatchObject({ code: "data_sync_run_state" });
      expect(get).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith("ROLLBACK");
    }
    expect(client.release).toHaveBeenCalledOnce();
  });
});
