import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { BoundedPool } from "../db/boundedPool.js";
import { checkpointQueries, measurePublication, observePeakMemory, observePublicationWork, observeQueryWork } from "./peakMemory.js";

afterEach(() => {
  observePeakMemory();
  observeQueryWork();
  observePublicationWork();
  vi.restoreAllMocks();
});

const result = { command: "SELECT", oid: 0, fields: [], rowCount: 1, rows: [{ value: 1 }] };
function clientWithQuery(query: (...args: unknown[]) => unknown) {
  return Object.assign(new pg.Client(), { release: vi.fn(), query: query as pg.PoolClient["query"] });
}

it("observes query-only pool work through the driver's callback API without losing release or results", async () => {
  const observations: unknown[] = [];
  observeQueryWork(value => observations.push(value));
  const client = clientWithQuery((...args) => {
    const callback = args[2] as (error: null, value: typeof result) => void;
    queueMicrotask(() => callback(null, result));
  });
  const release = client.release;
  vi.spyOn(pg.Pool.prototype, "connect").mockImplementation(async () => client);
  const database = new BoundedPool({ max: 4 });
  try {
    expect(await database.query("SELECT $1", [1])).toBe(result);
    expect(release).toHaveBeenCalledOnce();
    expect(observations).toEqual([expect.objectContaining({ sql: "SELECT $1", parameters: [1], rows: 1, failed: false })]);
    expect(database.admissionState).toEqual({ foreground: 0, queue: 0 });
  } finally { await database.end(); }
});

it.each(["argument", "config"] as const)("preserves %s callback receivers, config parameters and multi-statement row counts", mode => {
  const observations: unknown[] = [], checkpoints: unknown[] = [];
  observeQueryWork(value => observations.push(value));
  observePeakMemory(point => checkpoints.push(point));
  const receiver = {};
  const results = [result, { ...result, rowCount: null, rows: [{}, {}] }];
  const callback = vi.fn(function (this: unknown, error, value) {
    expect(this).toBe(receiver);
    expect(error).toBeNull();
    expect(value).toBe(results);
  });
  const client = clientWithQuery((...args) => {
    const config = args[0] as { callback: (...args: unknown[]) => void };
    Reflect.apply(mode === "argument" ? args[1] as (...args: unknown[]) => void : config.callback, receiver, [null, results]);
  });
  checkpointQueries(client);
  const config = { text: "SELECT $1;SELECT 2", values: [1], ...(mode === "config" ? { callback } : {}) };
  expect(mode === "argument" ? client.query(config, callback) : client.query(config)).toBeUndefined();
  expect(callback).toHaveBeenCalledOnce();
  expect(checkpoints).toHaveLength(1);
  expect(observations).toEqual([expect.objectContaining({ sql: "SELECT $1;SELECT 2", parameters: [1], rows: 3 })]);
});

it("releases callback pool clients even when query failure observation also fails", async () => {
  const failure = new Error("synthetic query failure"), sink = new Error("synthetic sink failure");
  observeQueryWork(() => { throw sink; });
  const client = clientWithQuery((...args) => {
    queueMicrotask(() => Reflect.apply(args[2] as (...args: unknown[]) => void, undefined, [failure]));
  });
  const release = client.release;
  vi.spyOn(pg.Pool.prototype, "connect").mockImplementation(async () => client);
  const database = new BoundedPool({ max: 4 });
  try {
    await expect(database.query("SELECT broken")).rejects.toMatchObject({ errors: [failure, sink] });
    expect(release).toHaveBeenCalledOnce();
    expect(database.admissionState).toEqual({ foreground: 0, queue: 0 });
  } finally { await database.end(); }
});

it("keeps concurrent query observations in their submitting operation contexts", () => {
  const context = new AsyncLocalStorage<string>(), operations: Array<string | undefined> = [];
  observeQueryWork(() => operations.push(context.getStore()));
  const callbacks: Array<(...args: unknown[]) => void> = [];
  const client = clientWithQuery((...args) => {
    if (typeof args[1] === "function") callbacks.push(args[1] as (...args: unknown[]) => void);
    else return args[0];
  });
  checkpointQueries(client);
  context.run("callback", () => client.query("SELECT 1", () => {}));
  const query = new pg.Query("SELECT 2");
  context.run("event", () => client.query(query));
  context.run("driver", () => {
    query.emit("end", result);
    callbacks[0](null, result);
  });
  expect(operations).toEqual(["event", "callback"]);
});

it("observes pg.Query end/error without changing its return identity or swallowing unhandled errors", () => {
  const observations: unknown[] = [];
  observeQueryWork(value => observations.push(value));
  const client = clientWithQuery(value => value);
  checkpointQueries(client);
  const query = new pg.Query({ text: "SELECT $1", values: [1] });
  expect(client.query(query)).toBe(query);
  query.emit("end", result);
  expect(query.eventNames()).toEqual([]);
  const failed = new pg.Query("SELECT broken");
  client.query(failed);
  const failure = new Error("synthetic SQL failure");
  expect(() => failed.emit("error", failure)).toThrow(failure);
  expect(failed.eventNames()).toEqual([]);
  expect(observations).toEqual([
    expect.objectContaining({ sql: "SELECT $1", parameters: [1], rows: 1, failed: false }),
    expect.objectContaining({ sql: "SELECT broken", rows: 0, failed: true }),
  ]);
});

it("preserves non-event submittables rather than requiring every driver extension to be pg.Query", () => {
  observeQueryWork(() => {});
  const client = clientWithQuery(value => value), submitted = { submit: () => {} };
  checkpointQueries(client);
  expect(client.query(submitted)).toBe(submitted);
});

it("preserves the real driver's synchronous invalid-callback validation without connecting", () => {
  observeQueryWork(() => {});
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  checkpointQueries(client);
  const config = { text: "SELECT 1", callback: "not a function" };
  expect(() => client.query(config)).toThrow("callback is not a function");
});

it("does not attribute in-flight query/publication work to replacement observers", async () => {
  const first = vi.fn(), second = vi.fn(), oldPeak = vi.fn(), newPeak = vi.fn();
  observeQueryWork(first);
  observePublicationWork(first);
  observePeakMemory(oldPeak);
  const held = Promise.withResolvers<typeof result>();
  const client = clientWithQuery(() => held.promise);
  checkpointQueries(client);
  const query = client.query("SELECT 1");
  const publication = measurePublication("test", () => held.promise);
  observeQueryWork(second);
  observePublicationWork(second);
  observePeakMemory(newPeak);
  held.resolve(result);
  expect(await query).toBe(result);
  expect(await publication).toBe(result);
  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  expect(oldPeak).not.toHaveBeenCalled();
  expect(newPeak).not.toHaveBeenCalled();
});

it("provides ownership-safe cleanup and bypasses dormant query instrumentation", async () => {
  observePeakMemory(() => {});
  const original = vi.fn(() => Promise.resolve(result));
  const client = clientWithQuery(original);
  checkpointQueries(client);
  const installed = client.query;
  checkpointQueries(client);
  expect(client.query).toBe(installed);
  const dispose = observeQueryWork(() => {});
  const current = vi.fn();
  observeQueryWork(current);
  expect(dispose).toBeTypeOf("function");
  dispose();
  await client.query("SELECT 1");
  expect(current).toHaveBeenCalledOnce();
  observePeakMemory();
  observeQueryWork();
  const pending = client.query("SELECT 2");
  expect(pending).toBe(original.mock.results.at(-1)!.value);
  await pending;
});

it.each(["throw", "reject"] as const)("retains failed config query evidence and original %s failures", async mode => {
  const observed: unknown[] = [], failure = new Error("synthetic query failure");
  observeQueryWork(value => observed.push(value));
  const client = clientWithQuery(() => {
    if (mode === "throw") throw failure;
    return Promise.reject(failure);
  });
  checkpointQueries(client);
  const work = () => client.query({ text: "SELECT broken", values: [7] });
  if (mode === "throw") expect(work).toThrow(failure);
  else await expect(work()).rejects.toBe(failure);
  expect(observed).toEqual([expect.objectContaining({ sql: "SELECT broken", parameters: [7], rows: 0, failed: true })]);
});

it("retains both the business failure and a failing publication observer", async () => {
  const workFailure = new Error("cancelled"), observerFailure = new Error("synthetic sink failure");
  observePublicationWork(() => { throw observerFailure; });
  const outcome = measurePublication("test", async () => { throw workFailure; });
  await expect(outcome).rejects.toMatchObject({ errors: [workFailure, observerFailure] });
});
