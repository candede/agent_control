import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataGenerations, type BeginGeneration, type GenerationLease } from "./dataGenerations.js";

afterEach(() => vi.restoreAllMocks());

const lease: GenerationLease = {
  id: "11111111-1111-4111-8111-111111111111",
  scopeId: "22222222-2222-4222-8222-222222222222",
  tenantId: "generation-tenant",
  owner: "33333333-3333-4333-8333-333333333333",
  version: 1, epoch: "3", sessionEpoch: "2", expectedRevision: "4", schemaVersion: 1,
};

function result(rows: pg.QueryResultRow[] = [], command = "SELECT"): pg.QueryResult {
  return { command, rowCount: rows.length, oid: 0, fields: [], rows };
}

function fixture({ existingScope = true } = {}) {
  const database = new pg.Pool({ max: 4 });
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockResolvedValue(client);
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query"));
  const scope = {
    id: lease.scopeId, tenant_id: lease.tenantId, principal_id: "generation-principal",
    epoch: lease.epoch, session_epoch: lease.sessionEpoch,
  };
  const generation = {
    id: lease.id, state: "staging", job_kind: "derived", run_id: null, page_count: 0,
  };
  const query = vi.fn<(statement: unknown, values?: unknown[]) => Promise<pg.QueryResult>>(async (statement, values) => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape");
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return result([], statement);
    if (statement.startsWith("SET LOCAL") || statement.includes("pg_advisory_xact_lock")) return result();
    if (statement.includes("INSERT INTO data_principal_epochs")) return result();
    if (statement.includes("SELECT epoch FROM data_principal_epochs")) return result([{ epoch: "7" }]);
    if (statement.includes("INSERT INTO data_scope_epochs")) {
      if (existingScope) return result();
      scope.session_epoch = String(values?.[7]);
      return result([scope]);
    }
    if (statement.includes("SELECT * FROM data_scope_epochs")) return result([scope]);
    if (statement.includes("INSERT INTO data_generation_heads")) return result();
    if (statement.includes("SELECT revision FROM data_generation_heads")) return result([{ revision: "4" }]);
    if (statement.includes("SELECT scope_id FROM data_generation_heads")) return result([{ scope_id: scope.id }]);
    if (statement.includes("SELECT count(*)::int AS active")) return result([{ active: 0, tenant_active: 0, scope_active: 0 }]);
    if (statement.includes("FROM data_generation_charges")) return result([{ bytes: "0" }]);
    if (statement.includes("FROM official_usage_ingestions")) return result([{ active: 0, tenant_active: 0 }]);
    if (statement.includes("INSERT INTO data_generations")) return result([], "INSERT");
    if (statement.startsWith("UPDATE data_generations")) return result([], "UPDATE");
    if (statement.includes("SELECT g.* FROM selected_generation")) return result([generation]);
    if (statement.includes("INSERT INTO data_generation_pages")) return result([], "INSERT");
    throw new Error(`Unexpected query: ${statement}`);
  });
  vi.spyOn(client, "query").mockImplementation(query);
  const input: BeginGeneration = {
    scope: {
      tenantId: lease.tenantId, kind: "principal", principalId: scope.principal_id,
      tokenMode: "delegated", source: "directory", selector: "complete",
    },
    schemaVersion: 1, jobId: "44444444-4444-4444-8444-444444444444", jobKind: "derived",
    sessionEpoch: "7", reserveBytes: 1024,
    observedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    deadlineAt: new Date(Date.now() + 5_000),
  };
  return { store: new DataGenerations(database), query, client, input };
}

describe("generation admission and retained source contracts", () => {
  it.each([false, true])("caps the initial lease at its deadline for existingScope=%s", async existingScope => {
    const { store, query, input, client } = fixture({ existingScope });

    await store.begin(input);

    const insertion = query.mock.calls.find(([statement]) =>
      typeof statement === "string" && statement.includes("INSERT INTO data_generations"));
    expect(insertion?.[0]).toContain("LEAST($12::timestamptz,clock_timestamp()+interval '60 seconds')");
    expect(insertion?.[1]?.[11]).toBe(input.deadlineAt);
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("allows a new session to refresh retained sources without changing their epochs", async () => {
    const { store, query, input } = fixture();

    await expect(store.begin(input)).resolves.toMatchObject({
      scopeId: lease.scopeId, epoch: lease.epoch, sessionEpoch: lease.sessionEpoch,
    });

    expect(query.mock.calls.some(([statement]) =>
      typeof statement === "string" && statement.startsWith("UPDATE data_scope_epochs"))).toBe(false);
    expect(query).toHaveBeenCalledWith("COMMIT");
  });

  it("rejects a stale session before creating a new generation", async () => {
    const { store, query, input } = fixture();

    await expect(store.begin({ ...input, sessionEpoch: "6" })).rejects.toThrow("data_session_fenced");

    expect(query.mock.calls.some(([statement]) =>
      typeof statement === "string" && statement.includes("INSERT INTO data_generations"))).toBe(false);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });
});

describe("duplicate generation page fencing", () => {
  it.each([undefined, new Error("page fence unavailable")])("retains the page error when fencing fails with %s", async failure => {
    const { store, query, client } = fixture();
    const duplicate = Object.assign(new Error("duplicate page token"), { code: "23505" });
    const execute = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      if (typeof statement === "string" && statement.includes("INSERT INTO data_generation_pages")) throw duplicate;
      return execute(statement, values);
    });
    const abort = vi.spyOn(store, "abort");
    if (failure) abort.mockRejectedValueOnce(failure);
    else abort.mockResolvedValueOnce(undefined);

    const observed = store.observePage(lease, "page-token", 10);
    if (failure) {
      await expect(observed).rejects.toMatchObject({
        message: "data_poison_fence_failed", errors: [duplicate, failure],
      });
    } else await expect(observed).rejects.toBe(duplicate);

    expect(abort).toHaveBeenCalledExactlyOnceWith(lease);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("does not replace unrelated page failures with an unnecessary abort", async () => {
    const { store, query } = fixture();
    const failure = new Error("page insert unavailable");
    const execute = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      if (typeof statement === "string" && statement.includes("INSERT INTO data_generation_pages")) throw failure;
      return execute(statement, values);
    });
    const abort = vi.spyOn(store, "abort");

    await expect(store.observePage(lease, "page-token", 10)).rejects.toBe(failure);

    expect(abort).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });
});
