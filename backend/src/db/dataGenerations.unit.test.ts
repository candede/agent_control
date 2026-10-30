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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
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

describe("principal revocation lock ordering", () => {
  it("still cancels tenant-owned work when the actor has no principal-owned scopes", async () => {
    const { store, query, input } = fixture();
    const execute = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape");
      if (statement.startsWith("UPDATE data_principal_epochs")) return result([{ epoch: "8" }]);
      if (statement.startsWith("SELECT id FROM data_scope_epochs")) return result();
      return execute(statement, values);
    });

    await expect(store.revokePrincipal(lease.tenantId, input.scope.principalId!, { preserveSources: true })).resolves.toBe("8");

    const cancellation = query.mock.calls.find(([statement]) =>
      typeof statement === "string" && statement.startsWith("UPDATE data_generations"));
    expect(cancellation?.[0]).toContain("WHERE tenant_id=$1 AND actor_principal_id=$2 AND state IN ('staging','validating')");
    expect(cancellation?.[1]).toEqual([lease.tenantId, input.scope.principalId]);
    expect(query.mock.calls.some(([statement]) =>
      typeof statement === "string" && /UPDATE data_(scope_epochs|generation_heads)/.test(statement))).toBe(false);
    expect(query).toHaveBeenCalledWith("COMMIT");
  });

  it.each([false, true])("does not deadlock an in-flight writer with preserveSources=%s", async preserveSources => {
    const { store, query, input } = fixture();
    const writerHasScope = deferred();
    const continueWriter = deferred();
    const writerReleased = deferred();
    const revokerNeedsScope = deferred();
    let revokerHasGeneration = false;
    const execute = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape");
      if (statement.startsWith("UPDATE data_principal_epochs")) return result([{ epoch: "8" }]);
      if (statement.startsWith("SELECT id FROM data_scope_epochs")) {
        if (values?.[2] !== null) return result();
        revokerNeedsScope.resolve();
        await writerReleased.promise;
        return result([{ id: lease.scopeId }]);
      }
      if (statement.startsWith("UPDATE data_scope_epochs")) return result([], "UPDATE");
      if (statement.startsWith("UPDATE data_generations")) revokerHasGeneration = true;
      return execute(statement, values);
    });
    const writerClient = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(writerClient, "query").mockImplementation(async (statement: unknown) => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape");
      if (statement.startsWith("SET LOCAL") || statement.includes("pg_advisory_xact_lock")) return result();
      if (statement.includes("SELECT * FROM data_scope_epochs")) {
        writerHasScope.resolve();
        await continueWriter.promise;
        return result([{ id: lease.scopeId }]);
      }
      if (statement.includes("SELECT scope_id FROM data_generation_heads")) return result([{ scope_id: lease.scopeId }]);
      if (statement.includes("SELECT g.* FROM selected_generation")) {
        if (revokerHasGeneration) throw new Error("generation_scope_lock_cycle");
        return result([{ id: lease.id, job_kind: "derived", run_id: null }]);
      }
      throw new Error(`Unexpected writer query: ${statement}`);
    });

    const writer = store.fence(writerClient, lease).finally(() => writerReleased.resolve());
    await writerHasScope.promise;
    const revoked = store.revokePrincipal(lease.tenantId, input.scope.principalId!, { preserveSources });
    const outcomes = Promise.allSettled([writer, revoked]);
    await revokerNeedsScope.promise;
    continueWriter.resolve();

    expect(await outcomes).toEqual([
      { status: "fulfilled", value: { id: lease.id, job_kind: "derived", run_id: null } },
      { status: "fulfilled", value: "8" },
    ]);
    expect(query).toHaveBeenCalledWith("COMMIT");
    const scopeChanges = query.mock.calls.filter(([statement]) =>
      typeof statement === "string" && statement.startsWith("UPDATE data_scope_epochs"));
    expect(scopeChanges).toHaveLength(preserveSources ? 0 : 1);
    expect(query.mock.calls.some(([statement, values]) =>
      typeof statement === "string" && statement.includes("WHERE tenant_id=$1 AND actor_principal_id=$2")
      && values?.[0] === lease.tenantId && values[1] === input.scope.principalId)).toBe(true);
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
