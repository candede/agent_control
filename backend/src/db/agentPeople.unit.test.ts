import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeTransactionResult } from "../services/peakMemory.js";
import { AgentPeopleRepository, type AgentPersonObservation } from "./agentPeople.js";

afterEach(() => vi.restoreAllMocks());

const scope = { tenantId: "people-tenant", principalId: "people-principal" };
const generation = { sessionEpoch: "7", scopeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", scopeEpoch: "3" };
const objectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const observation: AgentPersonObservation = {
  objectId, status: "resolved", displayName: "Saved person", userPrincipalName: null,
  checkedAt: "2026-10-01T12:00:00.000Z",
};

function result(rows: pg.QueryResultRow[] = [], command = "SELECT"): pg.QueryResult {
  return { command, rowCount: rows.length, oid: 0, fields: [], rows };
}

function fixture() {
  const database = new pg.Pool({ max: 4 });
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockResolvedValue(client);
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query"));
  const query = vi.fn<(statement: unknown, values?: unknown[]) => Promise<pg.QueryResult>>(async statement => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape");
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return result([], statement);
    if (statement.includes("pg_advisory_xact_lock")) return result();
    if (statement.includes("SELECT epoch FROM data_principal_epochs")) return result([{ epoch: generation.sessionEpoch }]);
    if (statement.includes("SELECT id FROM data_scope_epochs WHERE id=$1")) return result([{ id: generation.scopeId }]);
    if (statement.includes("SELECT id FROM data_scope_epochs WHERE tenant_id=$1")) return result();
    if (statement.includes("SELECT count(*)::text AS n FROM agent_people_cache")) return result([{ n: "0" }]);
    if (statement.includes("INSERT INTO agent_people_cache")) return result([], "INSERT");
    throw new Error(`Unexpected query: ${statement}`);
  });
  vi.spyOn(client, "query").mockImplementation(query);
  return { repository: new AgentPeopleRepository(database), database, client, query };
}

describe("agent people publication transaction fences", () => {
  it("does not acquire a connection for an already cancelled save", async () => {
    const { repository, database, query } = fixture();
    const controller = new AbortController();
    const failure = new Error("Cancelled before acquisition");
    controller.abort(failure);

    await expect(repository.save(scope, [observation], { generation, signal: controller.signal })).rejects.toBe(failure);
    expect(database.connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["cancellation", "authority"] as const)("rolls back %s during the final database fence", async boundary => {
    const { repository, client, query } = fixture();
    const controller = new AbortController();
    const failure = new Error("Publication no longer authorized");
    let fenceQueries = 0, revoked = false;
    const execute = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      const response = await execute(statement, values);
      if (typeof statement === "string" && statement.includes("SELECT id FROM data_scope_epochs WHERE id=$1")
        && ++fenceQueries === 2) {
        if (boundary === "cancellation") controller.abort(failure);
        else revoked = true;
      }
      return response;
    });

    await expect(repository.save(scope, [observation], {
      generation, signal: controller.signal, fence: () => { if (revoked) throw failure; },
    })).rejects.toBe(failure);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO agent_people_cache"), expect.any(Array));
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each(["cancellation", "authority"] as const)("rechecks %s after transaction-result bookkeeping", async boundary => {
    const { repository, query } = fixture();
    const controller = new AbortController();
    const failure = new Error("Publication invalidated before commit");
    let revoked = false;
    const stop = observeTransactionResult(async () => {
      if (boundary === "cancellation") controller.abort(failure);
      else revoked = true;
      return undefined;
    });
    try {
      await expect(repository.save(scope, [observation], {
        generation, signal: controller.signal, fence: () => { if (revoked) throw failure; },
      })).rejects.toBe(failure);
      expect(query).toHaveBeenCalledWith("ROLLBACK");
      expect(query).not.toHaveBeenCalledWith("COMMIT");
    } finally {
      stop();
    }
  });

  it("commits an authorized observation without requiring a Users publication", async () => {
    const { repository, query, client } = fixture();
    const fence = vi.fn();

    await repository.save(scope, [observation], { generation, fence });

    expect(query).toHaveBeenCalledWith(expect.stringContaining("AND epoch=$4 AND session_epoch=$5 FOR UPDATE"),
      [generation.scopeId, scope.tenantId, scope.principalId, generation.scopeEpoch, generation.sessionEpoch]);
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(fence).toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });
});
