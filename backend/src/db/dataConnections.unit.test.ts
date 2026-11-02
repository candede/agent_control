import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { BoundedPool } from "./boundedPool.js";
import { DataConnections, dataConnections, isSelectedRead } from "./dataConnections.js";
import { dataLimits } from "./dataBounds.js";
import { flushDataWorkMetrics, observeDataWork } from "../services/dataMetrics.js";
import { observeTransactionStart } from "../services/peakMemory.js";

afterEach(() => {
  observeTransactionStart();
  flushDataWorkMetrics();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(bounded = false) {
  const database = bounded ? new BoundedPool({ max: 4 }) : new pg.Pool({ max: 4 });
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const result = (command = ""): pg.QueryResult => ({
    command, rows: [{ unlocked: true }], rowCount: 1, fields: [], oid: 0,
  });
  const connect = vi.spyOn(database, "connect").mockImplementation(async () => client);
  const renewal = database instanceof BoundedPool
    ? vi.spyOn(database, "connectRenewal").mockResolvedValue(client) : undefined;
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query."));
  const query = vi.spyOn(client, "query").mockImplementation(async statement =>
    result(statement === "COMMIT" ? "COMMIT" : ""));
  return { database, client, connect, renewal, query, result, connections: dataConnections(database) };
}

it.each(["run", "selectedRead"] as const)(
  "never acquires a connection for an already cancelled %s", async operation => {
    const { connections, connect } = fixture();
    const reason = new Error("Cancelled before admission.");
    const signal = AbortSignal.abort(reason);
    const work = vi.fn(async () => {});
    const pending = operation === "run" ? connections.run(work, false, signal)
      : connections.selectedRead(work, { signal });
    await expect(pending).rejects.toBe(reason);
    expect(connect).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  },
);

it.each(["run", "selectedRead", "renewal"] as const)(
  "does not begin cancelled %s work after a delayed connection arrives", async operation => {
    const { connections, client, connect, renewal, query } = fixture(operation === "renewal");
    const acquired = Promise.withResolvers<pg.PoolClient>();
    if (renewal) renewal.mockReturnValueOnce(acquired.promise);
    else connect.mockImplementationOnce(() => acquired.promise);
    const controller = new AbortController(), reason = new Error("Cancelled during acquisition.");
    const work = vi.fn(async () => { observeDataWork("generation", { rows: 99 }); });
    const pending = operation === "selectedRead" ? connections.selectedRead(work, { signal: controller.signal })
      : connections.run(work, operation === "renewal", controller.signal);
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    acquired.resolve(client);
    await rejected;
    expect(query.mock.calls.some(([statement]) => String(statement).startsWith("BEGIN"))).toBe(false);
    expect(work).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
    expect(isSelectedRead(client)).toBe(false);
    expect(flushDataWorkMetrics()).toEqual([]);
  },
);

it.each(["run", "selectedRead"] as const)(
  "does not invoke transaction callbacks when %s is cancelled during BEGIN", async operation => {
    const { connections, client, query, result } = fixture();
    const controller = new AbortController(), reason = new Error("Cancelled during BEGIN.");
    const start = vi.fn(async () => {});
    observeTransactionStart(start);
    query.mockImplementation(async statement => {
      if (String(statement).startsWith("BEGIN")) controller.abort(reason);
      return result(statement === "COMMIT" ? "COMMIT" : "");
    });
    const work = vi.fn(async () => {});
    const pending = operation === "run" ? connections.run(work, false, controller.signal)
      : connections.selectedRead(work, { signal: controller.signal });
    await expect(pending).rejects.toBe(reason);
    expect(start).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
    expect(isSelectedRead(client)).toBe(false);
  },
);

it.each(["run", "selectedRead"] as const)(
  "does not invoke %s work when its transaction-start checkpoint is cancelled", async operation => {
    const { connections, client, query } = fixture();
    const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
    observeTransactionStart(async () => { entered.resolve(); await held.promise; });
    const controller = new AbortController(), reason = new Error("Cancelled during transaction start.");
    const work = vi.fn(async () => {});
    const pending = operation === "run" ? connections.run(work, false, controller.signal)
      : connections.selectedRead(work, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    held.resolve();
    await rejected;
    expect(work).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
    expect(isSelectedRead(client)).toBe(false);
  },
);

it.each(["run", "selectedRead"] as const)(
  "rolls back %s if the final authority callback cancels its signal", async operation => {
    const { connections, client, query } = fixture();
    const controller = new AbortController(), reason = new Error("Cancelled at the commit fence.");
    const beforeCommit = vi.fn(() => { controller.abort(reason); });
    const onCommitted = vi.fn();
    const work = async () => { observeDataWork("generation", { rows: 99 }); };
    const pending = operation === "run"
      ? connections.run(work, false, controller.signal, undefined, beforeCommit, onCommitted)
      : connections.selectedRead(work, { signal: controller.signal, beforeCommit });
    await expect(pending).rejects.toBe(reason);
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
    expect(flushDataWorkMetrics()).toEqual([]);
  },
);

it("retains a confirmed commit when acknowledgment cancels its signal", async () => {
  const { connections, query } = fixture();
  const controller = new AbortController();
  const onCommitted = vi.fn(() => { controller.abort(new Error("Cancelled after commit.")); });
  await expect(connections.run(async () => {
    observeDataWork("generation", { rows: 1 });
    return "committed";
  }, false, controller.signal, undefined, undefined, onCommitted)).resolves.toBe("committed");
  expect(onCommitted).toHaveBeenCalledOnce();
  expect(query).toHaveBeenCalledWith("COMMIT");
  expect(query).not.toHaveBeenCalledWith("ROLLBACK");
  expect(flushDataWorkMetrics()).toEqual([{ stage: "generation", count: 1, rows: 1 }]);
});

it.each(["cancel", "timeout"] as const)(
  "removes a %s admission waiter without consuming the next transaction's slot", async boundary => {
    vi.useFakeTimers();
    const { connections, client, connect } = fixture();
    connect.mockImplementation(async () => {
      const acquired = Object.assign(new pg.Client(), { release: vi.fn() });
      vi.spyOn(acquired, "query").mockImplementation(async statement => ({
        command: statement === "COMMIT" ? "COMMIT" : "", rows: [], rowCount: 0, fields: [], oid: 0,
      }));
      return acquired;
    });
    const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
    let active = 0;
    const running = Array.from({ length: 3 }, () => connections.run(async () => {
      if (++active === 3) entered.resolve();
      await held.promise;
    }));
    await entered.promise;
    const controller = new AbortController(), reason = new Error("Cancelled while queued.");
    const work = vi.fn(async () => {});
    const pending = connections.run(work, false, controller.signal);
    const rejected = boundary === "cancel" ? expect(pending).rejects.toBe(reason)
      : expect(pending).rejects.toMatchObject({ code: "data_acquisition_timeout", status: 503 });
    if (boundary === "cancel") controller.abort(reason);
    else await vi.advanceTimersByTimeAsync(dataLimits.acquireMs);
    await rejected;
    expect(work).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(3);
    held.resolve();
    await Promise.all(running);
    connect.mockImplementation(async () => client);
    await expect(connections.run(async () => "next")).resolves.toBe("next");
    expect(connect).toHaveBeenCalledTimes(4);
  },
);

it("shares the gate per pool and reserves foreground admission for exactly a four-client pool", () => {
  const { database, connections } = fixture();
  expect(dataConnections(database)).toBe(connections);
  expect(() => new DataConnections(new pg.Pool({ max: 3 }))).toThrow("data_pool_budget");
});

it("takes a selected snapshot only after both session locks and releases them after COMMIT", async () => {
  const { connections, client, query } = fixture();
  await expect(connections.selectedRead(async selected => {
    expect(selected).toBe(client);
    expect(isSelectedRead(selected)).toBe(true);
    return "selected";
  }, { serializationKey: "export", admissionTenantId: "tenant" })).resolves.toBe("selected");
  expect(query.mock.calls).toEqual([
    ["SELECT pg_advisory_lock(hashtextextended($1,149))", ["export"]],
    ["SELECT pg_advisory_lock(hashtextextended($1,147))", ["tenant"]],
    ["BEGIN ISOLATION LEVEL REPEATABLE READ"],
    ["COMMIT"],
    ["SELECT pg_advisory_unlock(hashtextextended($1,147)) AS unlocked", ["tenant"]],
    ["SELECT pg_advisory_unlock(hashtextextended($1,149)) AS unlocked", ["export"]],
  ]);
  expect(isSelectedRead(client)).toBe(false);
  expect(client.release).toHaveBeenCalledWith(undefined);
});

it.each([147, 149])("releases acquired session locks after cancellation at lock %s", async salt => {
  const { connections, client, query, result } = fixture();
  const controller = new AbortController(), reason = new Error("Cancelled while acquiring a session lock.");
  query.mockImplementation(async statement => {
    if (statement === `SELECT pg_advisory_lock(hashtextextended($1,${salt}))`) controller.abort(reason);
    return result();
  });
  const work = vi.fn(async () => {});
  await expect(connections.selectedRead(work, {
    signal: controller.signal, serializationKey: "export", admissionTenantId: "tenant",
  })).rejects.toBe(reason);
  expect(work).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalledWith("BEGIN ISOLATION LEVEL REPEATABLE READ");
  expect(query).toHaveBeenCalledWith("SELECT pg_advisory_unlock(hashtextextended($1,149)) AS unlocked", ["export"]);
  if (salt === 147) expect(query).toHaveBeenCalledWith(
    "SELECT pg_advisory_unlock(hashtextextended($1,147)) AS unlocked", ["tenant"]);
  expect(client.release).toHaveBeenCalledWith(undefined);
});

it("maps a selected serialization conflict to retryable admission without retaining its snapshot marker", async () => {
  const { connections, client, query } = fixture();
  const conflict = Object.assign(new Error("Synthetic serialization conflict."), { code: "40001" });
  await expect(connections.selectedRead(async () => { throw conflict; })).rejects.toMatchObject({
    code: "data_read_conflict", status: 503, retryAfterSeconds: 5, cause: conflict,
  });
  expect(query).toHaveBeenCalledWith("ROLLBACK");
  expect(isSelectedRead(client)).toBe(false);
  expect(client.release).toHaveBeenCalledOnce();
});

it("retains work and rollback failures while discarding the unusable connection", async () => {
  const { connections, client, query, result } = fixture();
  const failure = new Error("Synthetic work failure."), rollback = new Error("Synthetic rollback failure.");
  query.mockImplementation(async statement => {
    if (statement === "ROLLBACK") throw rollback;
    return result();
  });
  await expect(connections.run(async () => {
    observeDataWork("generation", { rows: 99 });
    throw failure;
  })).rejects.toMatchObject({ message: "data_transaction_failed", errors: [failure, rollback] });
  expect(client.release).toHaveBeenCalledWith(rollback);
  expect(flushDataWorkMetrics()).toEqual([]);
});

it("rolls back a client error before commit and releases a poisoned connection", async () => {
  const { connections, client, query } = fixture();
  const failure = new Error("Synthetic connection failure.");
  await expect(connections.run(async () => {
    observeDataWork("generation", { rows: 99 });
    client.emit("error", failure);
  })).rejects.toBe(failure);
  expect(query).toHaveBeenCalledWith("ROLLBACK");
  expect(query).not.toHaveBeenCalledWith("COMMIT");
  expect(client.release).toHaveBeenCalledWith(failure);
  expect(flushDataWorkMetrics()).toEqual([]);
});
