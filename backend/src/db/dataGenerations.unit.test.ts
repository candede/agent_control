import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataGenerations, type BeginGeneration, type GenerationLease } from "./dataGenerations.js";
import { dataLimits } from "./dataBounds.js";

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
    if (statement.includes("count(DISTINCT writer)::int AS active")) return result([{ active: 0, tenant_active: 0, related_active: 0, scope_active: 0 }]);
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
  it.each(["office_app_adoption", "office_history"].flatMap(source =>
    [false, true].map(existingScope => ({ source, existingScope })),
  ))(
    "locks tenant sync before global admission or source locks for $source, existingScope=$existingScope", async ({ source, existingScope }) => {
      const { store, query, input } = fixture({ existingScope });
      await store.begin({
        ...input,
        scope: { ...input.scope, kind: "tenant", principalId: null, tokenMode: "tenant", source,
          selector: source === "office_app_adoption" ? "current" : "2026-10-26:D28:v2" },
        sessionEpoch: "0",
      });

      const statements = query.mock.calls;
      const sync = statements.findIndex(([statement, values]) => typeof statement === "string"
        && statement.includes("pg_advisory_xact_lock")
        && (values?.[0] === `data-sync:${lease.tenantId}` || statement.includes("'data-sync:'||s.tenant_id")));
      const admission = statements.findIndex(([statement]) => typeof statement === "string"
        && statement.includes("pg_advisory_xact_lock(3650147)"));
      const scope = statements.findIndex(([statement]) => typeof statement === "string"
        && statement.includes("INSERT INTO data_scope_epochs"));
      expect(sync).toBeGreaterThanOrEqual(0);
      expect(admission).toBeGreaterThan(sync);
      expect(scope).toBeGreaterThan(admission);
      expect(query).toHaveBeenCalledWith("COMMIT");
    },
  );

  it("includes both Office scopes in the tenant sync fence", async () => {
    const { store, query, client } = fixture();
    await store.fence(client, lease);
    const sync = query.mock.calls.find(([statement]) => typeof statement === "string"
      && statement.includes("'data-sync:'||s.tenant_id"))?.[0];
    expect(sync).toContain("'office_app_adoption'");
    expect(sync).toContain("'office_history'");
  });

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

  it.each([false, true])("shares Office writer admission without exempting its byte reservation (overQuota=%s)", async overQuota => {
    const { store, query, input } = fixture();
    const execute = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      if (String(statement).includes("count(DISTINCT writer)::int AS active")) {
        return result([{ active: 4, tenant_active: 2, related_active: 1, scope_active: 0 }]);
      }
      if (String(statement).includes("FROM data_generation_charges")) {
        return result([{ bytes: overQuota ? String(dataLimits.tenantBytes) : "0" }]);
      }
      return execute(statement, values);
    });
    const pending = store.begin({
      ...input, sessionEpoch: "0",
      scope: { ...input.scope, kind: "tenant", principalId: null, tokenMode: "tenant",
        source: "office_history", selector: "2026-10-26:D28:v2" },
    });
    if (overQuota) {
      await expect(pending).rejects.toMatchObject({ status: 413, code: "data_tenant_bytes" });
      expect(query.mock.calls.some(([statement]) => String(statement).includes("INSERT INTO data_generations"))).toBe(false);
    } else await expect(pending).resolves.toMatchObject({ tenantId: lease.tenantId });
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

describe("related generation publication completion", () => {
  function publication(weeklyScopeId: string, invalidWeekly = false) {
    const { store, query, input } = fixture();
    const weekly = { ...lease, id: "55555555-5555-4555-8555-555555555555", scopeId: weeklyScopeId };
    const published = new Set<string>(), retired = new Set<string>();
    const execute = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape");
      const id = String(values?.[0]);
      if (statement.startsWith("SELECT job_id FROM data_generations")) return result([{ job_id: "office-job" }]);
      if (statement.includes("SELECT g.* FROM selected_generation")) return result([{
        id, job_id: "office-job", job_kind: "derived", run_id: null, state: "validating",
        validated: !(invalidWeekly && id === weekly.id), row_count: 10, byte_count: "100",
      }]);
      if (statement.startsWith("SELECT generation_id FROM data_generation_heads")) return result([{ generation_id: `old:${id}` }]);
      if (statement.startsWith("UPDATE data_generation_heads")) return result([{ revision: "5" }], "UPDATE");
      if (statement.startsWith("UPDATE data_generations SET state='published'")) published.add(id);
      if (statement.startsWith("UPDATE data_generations SET state='retired'")) retired.add(id);
      return execute(statement, values);
    });
    return { store, query, input, weekly, published, retired };
  }

  it.each([
    "00000000-0000-4000-8000-000000000000",
    "99999999-9999-4999-8999-999999999999",
  ])("completes the Office job after both heads and retirement states advance with weekly scope %s", async weeklyScopeId => {
    const { store, query, weekly, published, retired } = publication(weeklyScopeId);
    const completeJob = vi.fn(async (_client: pg.PoolClient, completed: { jobId: string; rows: number; bytes: number }) => {
      expect(published).toEqual(new Set([lease.id, weekly.id]));
      expect(retired).toEqual(new Set([`old:${lease.scopeId}`, `old:${weekly.scopeId}`]));
      expect(completed).toEqual({ jobId: "office-job", runId: null, rows: 10, bytes: 100 });
      expect(query).not.toHaveBeenCalledWith("COMMIT");
    });

    await expect(store.publish(lease, {
      relatedLeases: [weekly], validateInputs: async () => {}, completeJob,
    })).resolves.toBe("5");

    expect(completeJob).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith("COMMIT");
  });

  it("does not invoke completion when a later related lease cannot publish", async () => {
    const { store, query, weekly } = publication("99999999-9999-4999-8999-999999999999", true);
    const completeJob = vi.fn(async () => {});

    await expect(store.publish(lease, {
      relatedLeases: [weekly], validateInputs: async () => {}, completeJob,
    })).rejects.toThrow("data_not_validated");

    expect(completeJob).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("keeps managed cancellation armed through job completion after renewal is paused", async () => {
    const { store, query, input } = publication("99999999-9999-4999-8999-999999999999");
    vi.spyOn(store, "begin").mockResolvedValue(lease);
    const abort = vi.spyOn(store, "abort");
    const parent = new AbortController(), reason = new Error("cancel-during-completion");
    const onCommitted = vi.fn();

    await expect(store.execute(input, active => store.publish(active, {
      validateInputs: async () => {}, completeJob: async () => { parent.abort(reason); }, onCommitted,
    }), parent.signal)).rejects.toBe(reason);

    expect(onCommitted).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith(lease, true);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("does not cancel a managed generation when its parent aborts after the durable commit", async () => {
    const { store, input } = publication("99999999-9999-4999-8999-999999999999");
    vi.spyOn(store, "begin").mockResolvedValue(lease);
    const abort = vi.spyOn(store, "abort");
    const parent = new AbortController();
    const onCommitted = vi.fn(() => parent.abort(new Error("after-commit")));

    await expect(store.execute(input, active => store.publish(active, {
      validateInputs: async () => {}, completeJob: async () => {}, onCommitted,
    }), parent.signal)).resolves.toBe("5");

    expect(onCommitted).toHaveBeenCalledExactlyOnceWith("5");
    expect(abort).not.toHaveBeenCalled();
  });
});
