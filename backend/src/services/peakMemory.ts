import { getHeapStatistics } from "node:v8";
import { threadId } from "node:worker_threads";
import { errorMonitor } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";

export type PeakStage = "provider.parse" | "batch.stringify" | "sql.result" | "import.transform"
  | "response.serialize" | "export.encode" | "probe.live";
export type PeakCheckpoint = ReturnType<typeof process.memoryUsage> & {
  pid: number; isolate: number; at: number; stage: PeakStage; heapLimit: number;
};
function observation<T>() {
  let current: { value: T } | undefined;
  return {
    get current() { return current; },
    set(value?: T) {
      const installed = value === undefined ? undefined : { value };
      current = installed;
      return () => { if (current === installed) current = undefined; };
    },
  };
}
const observer = observation<(point: PeakCheckpoint) => void>();
const transactionObserver = observation<(client: pg.PoolClient) => Promise<void>>();
const transactionResultObserver = observation<(client: pg.PoolClient) => Promise<(() => void) | undefined>>();
const publicationObserver = observation<(value: { kind: string; milliseconds: number; committed: boolean }) => void>();
const sqlObserver = observation<(value: { sql: string; milliseconds: number; rows: number; failed: boolean; parameters?: unknown[] }) => void>();

/** Set one bounded observer per hook/isolate; cleanup removes only that installation. */
export function observePeakMemory(value?: Parameters<typeof observer.set>[0]) { return observer.set(value); }
export function observeQueryWork(value?: Parameters<typeof sqlObserver.set>[0]) { return sqlObserver.set(value); }
export function observeTransactionStart(value?: Parameters<typeof transactionObserver.set>[0]) { return transactionObserver.set(value); }
export function observeTransactionResult(value?: Parameters<typeof transactionResultObserver.set>[0]) { return transactionResultObserver.set(value); }
export function observePublicationWork(value?: Parameters<typeof publicationObserver.set>[0]) { return publicationObserver.set(value); }
export async function measurePublication<T>(kind: string | (() => string), work: () => Promise<T>): Promise<T> {
  const installed = publicationObserver.current;
  if (!installed) return work();
  const started = performance.now();
  let committed = false, failure: unknown;
  try { const result = await work(); committed = true; return result; }
  catch (error) { failure = error; throw error; }
  finally {
    if (publicationObserver.current === installed) {
      try { installed.value({ kind: typeof kind === "function" ? kind() : kind, milliseconds: performance.now() - started, committed }); }
      catch (error) {
        if (!committed) throw new AggregateError([failure, error], "publication_observation_failed");
        throw error;
      }
    }
  }
}
export function transactionCheckpoint(client: pg.PoolClient) { return transactionObserver.current?.value(client); }
export function transactionResultCheckpoint(client: pg.PoolClient) { return transactionResultObserver.current?.value(client); }
const instrumented = new WeakSet<pg.PoolClient>();
export function checkpointQueries(client: pg.PoolClient) {
  if ((!observer.current && !sqlObserver.current) || instrumented.has(client)) return;
  const query = client.query;
  client.query = ((...args: unknown[]) => {
    const heap = observer.current, sql = sqlObserver.current;
    if (!heap && !sql) return Reflect.apply(query, client, args);
    const started = performance.now();
    const config = typeof args[0] === "object" && args[0] !== null
      ? args[0] as pg.QueryConfig & { callback?: (...args: unknown[]) => unknown; submit?: unknown } : undefined;
    const text = typeof args[0] === "string" ? args[0] : config?.text ?? "";
    const parameters = Array.isArray(args[1]) ? args[1] : config?.values;
    let completed = false, cleanup = () => {};
    // Driver callbacks/events can run in the pooled socket's context, not the submitting operation.
    const finish = AsyncLocalStorage.bind((failed: boolean, value: unknown) => {
      if (completed) return;
      completed = true;
      cleanup();
      try {
        if (!failed && heap && observer.current === heap) checkpoint("sql.result", heap.value);
        if (sql && sqlObserver.current === sql) {
          const results = (Array.isArray(value) ? value : [value]) as pg.QueryResult[];
          sql.value({ sql: text, milliseconds: performance.now() - started, failed,
            rows: failed ? 0 : results.reduce((sum, part) => sum + (part?.rowCount ?? part?.rows?.length ?? 0), 0),
            parameters: Array.isArray(parameters) ? parameters : undefined });
        }
      } catch (error) {
        if (failed) throw new AggregateError([value, error], "query_observation_failed");
        throw error;
      }
    });
    const callbackIndex = typeof args[2] === "function" ? 2 : typeof args[1] === "function" ? 1 : -1;
    const submitted = typeof config?.submit === "function";
    const events = submitted ? args[0] as pg.Query : undefined;
    const callback = submitted && config?.callback ? config.callback
      : callbackIndex !== -1 ? args[callbackIndex] as (...args: unknown[]) => unknown : config?.callback;
    if (typeof callback === "function") {
      const wrapped = function (this: unknown, ...values: unknown[]) {
        try { finish(values[0] !== null && values[0] !== undefined, values[0] ?? values[1]); }
        catch (error) { values[0] = error; }
        return Reflect.apply(callback, this, values);
      };
      if (submitted && config?.callback) {
        config.callback = wrapped;
        cleanup = () => { if (config.callback === wrapped) config.callback = callback; };
      } else if (callbackIndex !== -1) args[callbackIndex] = wrapped;
      else args[0] = { ...config, callback: wrapped };
    } else if (events && typeof events.prependOnceListener === "function"
      && typeof events.once === "function" && typeof events.removeListener === "function") {
      const ended = (value: pg.QueryResult) => finish(false, value);
      const errored = (error: Error) => finish(true, error);
      cleanup = () => { events.removeListener("end", ended); events.removeListener(errorMonitor, errored); };
      events.prependOnceListener("end", ended);
      // Observe failure without turning an otherwise unhandled error into a handled one.
      events.once(errorMonitor, errored);
    }
    let result: unknown;
    try { result = Reflect.apply(query, client, args); }
    catch (error) { finish(true, error); throw error; }
    if (typeof callback !== "function" && result && typeof (result as Promise<unknown>).then === "function") {
      return (result as Promise<pg.QueryResult>).then(value => {
        finish(false, value);
        return value;
      }, error => { finish(true, error); throw error; });
    }
    return result;
  }) as typeof client.query;
  instrumented.add(client);
}
export function peakCheckpoint(stage: PeakStage) {
  const installed = observer.current;
  if (installed) checkpoint(stage, installed.value);
}
function checkpoint(stage: PeakStage, observe: (point: PeakCheckpoint) => void) {
  observe({ ...process.memoryUsage(), pid: process.pid, isolate: threadId,
    at: performance.now(), stage, heapLimit: getHeapStatistics().heap_size_limit });
}
