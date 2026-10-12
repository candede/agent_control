import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { DataConnections } from "../db/dataConnections.js";
import { DataGenerations, type GenerationLease } from "../db/dataGenerations.js";
import { DataSelections } from "./dataSelections.js";
import { dataWorkMetricScope, flushDataWorkMetrics, observeDataWork } from "./dataMetrics.js";
import { admitGeneration } from "../db/generationAdmission.js";
import { observeTransactionResult } from "./peakMemory.js";
import { withTelemetryContext } from "./telemetry.js";

afterEach(() => { observeTransactionResult(); flushDataWorkMetrics(); vi.restoreAllMocks(); });
it("aggregates bounded numeric observations without inherited identity or arbitrary labels", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  flushDataWorkMetrics(); log.mockClear();
  withTelemetryContext({ jobId: "private-job", requestId: "private-request", route: "/private" }, () => {
    observeDataWork("record_gc", { rows: 250, bytes: 1_048_000, backlogRoots: 17, oldestAgeMs: 60_000 });
    observeDataWork("record_gc", { rows: 10, bytes: -1 });
    observeDataWork("private-label" as never, { bytes: 1 });
    expect(flushDataWorkMetrics()).toEqual([{ stage: "record_gc", count: 2, rows: 250, bytes: 1_048_000, backlogRoots: 17, oldestAgeMs: 60_000 }]);
  });
  expect(log).toHaveBeenCalledTimes(1);
  const payload = String(log.mock.calls[0][0]);
  expect(payload).not.toMatch(/private|jobId|requestId|route/);
  expect(JSON.parse(payload)).toMatchObject({ event: "data_lifecycle_metrics", stage: "record_gc", rows: 250, bytes: 1_048_000,
    backlogRoots: 17, oldestAgeMs: 60_000 });
  expect(flushDataWorkMetrics()).toEqual([]);
});

it("keeps sequential scope phases private and rejects an unfinished or closed scope commit/reuse", async () => {
  const scope = dataWorkMetricScope();
  const held = Promise.withResolvers<void>();
  const running = scope.run(async () => {
    observeDataWork("generation", { rows: 2 });
    await held.promise;
    observeDataWork("generation", { rows: 3 });
  });
  try {
    expect(() => scope.commit()).toThrow("data_metric_scope_active");
    expect(flushDataWorkMetrics()).toEqual([]);
  } finally { held.resolve(); await running; }
  await scope.run(async () => { observeDataWork("generation", { rows: 0 }); });
  expect(flushDataWorkMetrics()).toEqual([]);
  scope.commit();
  expect(flushDataWorkMetrics()).toEqual([{ stage: "generation", count: 3, rows: 3 }]);
  scope.commit();
  expect(flushDataWorkMetrics()).toEqual([]);
  await expect(scope.run(async () => { observeDataWork("generation", { rows: 999 }); }))
    .rejects.toThrow("data_metric_scope_closed");
});

it.each(["commit", "discard"] as const)("drops detached observations after a scope's %s", async finish => {
  const scope = dataWorkMetricScope();
  const held = Promise.withResolvers<void>();
  let detached!: Promise<void>;
  await scope.run(async () => {
    observeDataWork("generation", { rows: 2 });
    detached = (async () => {
      await held.promise;
      observeDataWork("generation", { rows: 999 });
    })();
  });
  scope[finish]();
  expect(flushDataWorkMetrics()).toEqual(finish === "commit" ? [{ stage: "generation", count: 1, rows: 2 }] : []);
  held.resolve();
  await detached;
  scope.commit();
  expect(flushDataWorkMetrics()).toEqual([]);
});

it("reports an in-memory queue admission even when its enclosing SQL metric scope is discarded", async () => {
  const scope = dataWorkMetricScope();
  await scope.run(async () => {
    observeDataWork("generation", { rows: 99 });
    await admitGeneration({} as pg.Pool, async () => ({ id: "lease" } as GenerationLease), async () => {},
      new Date(Date.now() + 60_000));
  });
  scope.discard();
  expect(flushDataWorkMetrics()).toEqual([{ stage: "admission", count: 1, queueDepth: 1 }]);
});

it("retains only safe integer maxima and zeroes without retaining mutable fields or arbitrary keys", () => {
  const fields = { rows: 0, bytes: Number.MAX_SAFE_INTEGER, pins: Infinity, queueDepth: -1, backlogRoots: 0.5,
    durationMs: Number.MAX_SAFE_INTEGER + 1, oldestAgeMs: NaN, count: 999, tenantId: "private" };
  observeDataWork("generation", fields);
  fields.rows = 999;
  fields.bytes = 0;
  observeDataWork("generation", { rows: -Infinity, bytes: 20, durationMs: 0 });
  observeDataWork("private-stage" as never, { rows: 999 });
  expect(flushDataWorkMetrics()).toEqual([{ stage: "generation", count: 2, rows: 0,
    bytes: Number.MAX_SAFE_INTEGER, durationMs: 0 }]);
});

it("never lets accessor or proxy measurement inputs change transaction work", async () => {
  const getter = vi.fn(() => { throw new Error("private metric getter"); });
  const fields = Object.defineProperty({ rows: 2 }, "bytes", { get: getter, enumerable: true });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const scope = dataWorkMetricScope();
  await expect(scope.run(async () => {
    observeDataWork("generation", fields);
    observeDataWork("generation", revoked.proxy);
    return "business-result";
  })).resolves.toBe("business-result");
  scope.commit();
  expect(flushDataWorkMetrics()).toEqual([{ stage: "generation", count: 2, rows: 2 }]);
  expect(getter).not.toHaveBeenCalled();
});

it("keeps a commit made during emission for the next flush without aliasing either snapshot", async () => {
  const scope = dataWorkMetricScope();
  await scope.run(async () => { observeDataWork("export", { bytes: 20 }); });
  observeDataWork("export", { bytes: 10 });
  vi.spyOn(console, "log").mockImplementationOnce(() => { scope.commit(); });
  const first = flushDataWorkMetrics();
  expect(first).toEqual([{ stage: "export", count: 1, bytes: 10 }]);
  first[0].bytes = 999;
  expect(flushDataWorkMetrics()).toEqual([{ stage: "export", count: 1, bytes: 20 }]);
  expect(flushDataWorkMetrics()).toEqual([]);
});

it("closes a failed merge without replaying observations that already reached the committed aggregate", async () => {
  const scope = dataWorkMetricScope();
  await scope.run(async () => {
    observeDataWork("generation", { rows: 2 });
    observeDataWork("selection", { pins: 1 });
  });
  const failure = new Error("Synthetic aggregate merge failure.");
  const set = Map.prototype.set;
  const broken = vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key, value) {
    if (key === "selection") throw failure;
    return set.call(this, key, value);
  });
  let caught: unknown;
  try { scope.commit(); }
  catch (error) { caught = error; }
  finally { broken.mockRestore(); }
  expect(caught).toBe(failure);
  scope.commit();
  expect(flushDataWorkMetrics()).toEqual([{ stage: "generation", count: 1, rows: 2 }]);
  await expect(scope.run(async () => {})).rejects.toThrow("data_metric_scope_closed");
});

function databaseFixture() {
  const database = new pg.Pool({ max: 4 });
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const result = (rows: object[] = [], command = "") => ({ command, oid: 0, fields: [], rowCount: rows.length, rows });
  vi.spyOn(database, "connect").mockImplementation(async () => client);
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query."));
  const query = vi.spyOn(client, "query").mockImplementation(async statement =>
    result(typeof statement === "string" && statement.includes("pg_advisory_unlock") ? [{ unlocked: true }] : [],
      statement === "COMMIT" ? "COMMIT" : ""));
  return { database, client, query, result, connections: new DataConnections(database) };
}

it.each(["run", "selectedRead"] as const)("does not accept a resolved %s COMMIT that actually reports ROLLBACK", async operation => {
  const { connections, query, result } = databaseFixture();
  query.mockImplementation(async statement => ({ ...result(), command: statement === "COMMIT" ? "ROLLBACK" : "" }));
  await expect(connections[operation](async () => { observeDataWork("generation", { rows: 99 }); }))
    .rejects.toThrow("data_transaction_not_committed");
  expect(flushDataWorkMetrics()).toEqual([]);
});

it.each(["inner", "outer"] as const)("retains only durable nested transactions after the %s transaction fails", async failed => {
  const outer = databaseFixture(), inner = databaseFixture();
  const failure = new Error("Synthetic nested transaction failure.");
  const transaction = outer.connections.run(async () => {
    observeDataWork("generation", { rows: 1 });
    const nested = inner.connections.run(async () => {
      observeDataWork("generation", { rows: 3 });
      if (failed === "inner") throw failure;
    });
    if (failed === "inner") await expect(nested).rejects.toBe(failure);
    else await nested;
    observeDataWork("generation", { rows: 2 });
    if (failed === "outer") throw failure;
  });
  if (failed === "outer") await expect(transaction).rejects.toBe(failure);
  else await transaction;
  expect(flushDataWorkMetrics()).toEqual([{ stage: "generation", count: failed === "outer" ? 1 : 2,
    rows: failed === "outer" ? 3 : 2 }]);
});

it.each(["work", "cancellation", "authority", "commit"] as const)(
  "discards transactional observations after %s failure", async boundary => {
    const { connections, query, result } = databaseFixture();
    const failure = new Error("Synthetic transaction failure.");
    const controller = new AbortController();
    if (boundary === "commit") query.mockImplementation(async statement => {
      if (statement === "COMMIT") throw failure;
      return result();
    });
    const beforeCommit = () => { if (boundary === "authority") throw failure; };
    await expect(connections.run(async () => {
      observeDataWork("generation", { rows: 100, bytes: 200 });
      observeDataWork("record_gc", { rows: 250, bytes: 512, backlogRoots: 2 });
      observeDataWork("inventory_gc", { rows: 50, durationMs: 10 });
      if (boundary === "work") throw failure;
      if (boundary === "cancellation") controller.abort(failure);
    }, false, controller.signal, undefined, beforeCommit)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(flushDataWorkMetrics()).toEqual([]);
  },
);

it("keeps pending transactions out of a flush and merges concurrent commits only once", async () => {
  const first = databaseFixture(), second = databaseFixture();
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = first.connections.run(async () => {
    observeDataWork("generation", { rows: 250, bytes: Number.MAX_SAFE_INTEGER });
    observeDataWork("generation", { rows: 0, bytes: Infinity });
    started();
    await held;
  });
  await entered;
  try {
    expect(flushDataWorkMetrics()).toEqual([]);
    await second.connections.run(async () => { observeDataWork("generation", { rows: 10, bytes: 20 }); });
    const snapshot = flushDataWorkMetrics();
    expect(snapshot).toEqual([{ stage: "generation", count: 1, rows: 10, bytes: 20 }]);
    snapshot[0].rows = 999;
  } finally { release(); await pending; }
  await second.connections.run(async () => { observeDataWork("generation", { rows: 10, bytes: 0 }); });
  expect(flushDataWorkMetrics()).toEqual([{ stage: "generation", count: 3, rows: 250, bytes: Number.MAX_SAFE_INTEGER }]);
  expect(flushDataWorkMetrics()).toEqual([]);
});

it("retains confirmed committed observations when later connection cleanup fails", async () => {
  const { connections, query, result } = databaseFixture();
  query.mockImplementation(async statement => result(
    typeof statement === "string" && statement.includes("pg_advisory_unlock") ? [{ unlocked: false }] : [],
    statement === "COMMIT" ? "COMMIT" : "",
  ));
  await expect(connections.run(async () => {
    observeDataWork("export", { rows: 1, bytes: 10 });
  }, false, undefined, "export")).rejects.toThrow("data_serialization_unlock_failed");
  expect(query).toHaveBeenCalledWith("COMMIT");
  expect(flushDataWorkMetrics()).toEqual([{ stage: "export", count: 1, rows: 1, bytes: 10 }]);
});

it("does not roll back a confirmed COMMIT when its post-commit diagnostic callback throws", async () => {
  const { connections, query, result } = databaseFixture();
  const failure = new Error("Synthetic post-commit callback failure.");
  observeTransactionResult(async () => () => { throw failure; });
  query.mockImplementation(async statement => {
    if (statement === "ROLLBACK") throw new Error("Rollback cannot undo a durable commit.");
    return result([], statement === "COMMIT" ? "COMMIT" : "");
  });
  await expect(connections.run(async () => { observeDataWork("export", { bytes: 10 }); })).rejects.toBe(failure);
  expect(query).toHaveBeenCalledWith("COMMIT");
  expect(query).not.toHaveBeenCalledWith("ROLLBACK");
  expect(flushDataWorkMetrics()).toEqual([{ stage: "export", count: 1, bytes: 10 }]);
});

it("releases admission slots after client release throws without losing committed observations", async () => {
  const { connections, client } = databaseFixture();
  const failure = new Error("Synthetic client release failure.");
  client.release.mockImplementation(() => { throw failure; });
  for (let bytes = 1; bytes <= 3; bytes++) {
    await expect(connections.run(async () => { observeDataWork("export", { bytes }); })).rejects.toBe(failure);
  }
  client.release.mockReset();
  await expect(connections.run(async () => { observeDataWork("export", { bytes: 4 }); },
    false, AbortSignal.timeout(100))).resolves.toBeUndefined();
  expect(flushDataWorkMetrics()).toEqual([{ stage: "export", count: 4, bytes: 4 }]);
});

it.each(["work", "unlock"] as const)("preserves a %s failure when client release also throws", async boundary => {
  const { connections, client, query, result } = databaseFixture();
  const workFailure = new Error("Synthetic transaction work failure.");
  const releaseFailure = new Error("Synthetic client release failure.");
  client.release.mockImplementation(() => { throw releaseFailure; });
  query.mockImplementation(async statement => result(
    typeof statement === "string" && statement.includes("pg_advisory_unlock") ? [{ unlocked: false }] : [],
    statement === "COMMIT" ? "COMMIT" : "",
  ));
  await expect(connections.run(async () => {
    observeDataWork("export", { bytes: 10 });
    if (boundary === "work") throw workFailure;
  }, false, undefined, boundary === "unlock" ? "export" : undefined)).rejects.toMatchObject({
    message: "data_transaction_cleanup_failed",
    errors: [boundary === "work" ? workFailure : expect.objectContaining({ message: "data_serialization_unlock_failed" }), releaseFailure],
  });
  expect(flushDataWorkMetrics()).toEqual(boundary === "work" ? [] : [{ stage: "export", count: 1, bytes: 10 }]);
});

it.each(["publish", "renew"] as const)("does not report a generation %s whose COMMIT fails", async operation => {
  const { database, query, result } = databaseFixture();
  const failure = new Error("Synthetic commit failure.");
  query.mockImplementation(async statement => {
    if (statement === "COMMIT") throw failure;
    return result([{ revision: "1", generation_id: null, age: "123" }]);
  });
  const generations = new DataGenerations(database);
  vi.spyOn(generations, "fence").mockResolvedValue({
    row_count: 5, byte_count: "100", job_kind: "fixture", state: "validating", validated: true,
  });
  const lease: GenerationLease = { id: "generation", scopeId: "scope", tenantId: "tenant", owner: "owner",
    version: 1, epoch: "1", sessionEpoch: "1", expectedRevision: "0", schemaVersion: 1 };
  await expect(generations[operation](lease)).rejects.toBe(failure);
  expect(flushDataWorkMetrics()).toEqual([]);
});

it("does not count invalid selections or their unpersisted pins", async () => {
  const { database, query, result } = databaseFixture();
  query.mockImplementation(async statement => {
    if (typeof statement === "string" && statement.startsWith("SELECT epoch")) return result([{ epoch: "1" }]);
    if (statement === "SELECT clock_timestamp() AS now") return result([{ now: new Date() }]);
    if (typeof statement === "string" && statement.includes("pg_advisory_unlock")) return result([{ unlocked: true }]);
    return result();
  });
  const selections = new DataSelections(database);
  await expect(selections.capture({ tenantId: "tenant", principalId: "principal", authorizationHash: "viewer", sessionEpoch: "1" },
    "/users", { values: {}, allowed: [] }, [])).rejects.toThrow("data_selection_roots");
  expect(flushDataWorkMetrics()).toEqual([]);
});

it.each([false, true])("reports captured pins only when selection persistence commits (failure=%s)", async failed => {
  const { database, query, result } = databaseFixture();
  const identity = { tenantId: "tenant", principalId: "principal", authorizationHash: "viewer", sessionEpoch: "1" };
  query.mockImplementation(async statement => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape.");
    if (statement === "COMMIT") return result([], "COMMIT");
    if (statement.startsWith("SELECT epoch")) return result([{ epoch: "1" }]);
    if (statement === "SELECT clock_timestamp() AS now") return result([{ now: new Date() }]);
    if (statement.startsWith("SELECT count(*)::int AS tenant")) return result([{ tenant: 0, principal: 0 }]);
    if (statement.startsWith("SELECT * FROM data_scope_epochs")) return result([{ principal_id: identity.principalId, epoch: "1", session_epoch: "1" }]);
    if (statement.startsWith("SELECT g.id")) return result([{ id: "generation" }]);
    if (statement.includes("pg_advisory_unlock")) return result([{ unlocked: true }]);
    return result();
  });
  const failure = new Error("Synthetic selection persistence failure.");
  const selections = new DataSelections(database);
  const capture = selections.captureWith(identity, "/users", { values: {}, allowed: [] }, async () => ({
    roots: [{ kind: "generation", scopeId: "scope", generationId: "generation", revision: "1", expiresAt: new Date(Date.now() + 600_000) }],
    persist: async () => { if (failed) throw failure; },
  }));
  if (failed) await expect(capture).rejects.toBe(failure);
  else await expect(capture).resolves.toMatchObject({ endpoint: "/users" });
  expect(flushDataWorkMetrics()).toEqual(failed ? [] : [{ stage: "selection", count: 1, pins: 1 }]);
});

it("still returns and resets all stage snapshots when a telemetry sink fails", () => {
  const log = vi.spyOn(console, "log").mockImplementationOnce(() => { throw new Error("Synthetic log sink failure."); });
  observeDataWork("export", { rows: 0, bytes: 10 });
  observeDataWork("admission", { queueDepth: 0 });
  expect(flushDataWorkMetrics()).toEqual([
    { stage: "export", count: 1, rows: 0, bytes: 10 },
    { stage: "admission", count: 1, queueDepth: 0 },
  ]);
  expect(log).toHaveBeenCalledTimes(2);
  expect(flushDataWorkMetrics()).toEqual([]);
});
