import { getHeapStatistics } from "node:v8";
import { threadId } from "node:worker_threads";
import type pg from "pg";

export type PeakStage = "provider.parse" | "batch.stringify" | "sql.result" | "import.transform"
  | "response.serialize" | "export.encode" | "probe.live";
export type PeakCheckpoint = ReturnType<typeof process.memoryUsage> & {
  pid: number; isolate: number; at: number; stage: PeakStage; heapLimit: number;
};
let observer: ((point: PeakCheckpoint) => void) | undefined;
let transactionObserver: ((client: pg.PoolClient) => Promise<void>) | undefined;
let transactionResultObserver: ((client: pg.PoolClient) => Promise<(() => void) | undefined>) | undefined;
let publicationObserver: ((value: { kind: string; milliseconds: number; committed: boolean }) => void) | undefined;
let sqlObserver: ((value: { sql: string; milliseconds: number; rows: number; failed: boolean; parameters?: unknown[] }) => void) | undefined;

/** Inert unless an explicitly installed, bounded observer owns this isolate. */
export function observePeakMemory(value?: typeof observer) { observer = value; }
export function observeQueryWork(value?: typeof sqlObserver) { sqlObserver = value; }
export function observeTransactionStart(value?: typeof transactionObserver) { transactionObserver = value; }
export function observeTransactionResult(value?: typeof transactionResultObserver) { transactionResultObserver = value; }
export function observePublicationWork(value?: typeof publicationObserver) { publicationObserver = value; }
export async function measurePublication<T>(kind: string | (() => string), work: () => Promise<T>): Promise<T> {
  if (!publicationObserver) return work();
  const started = performance.now();
  let committed = false;
  try { const result = await work(); committed = true; return result; }
  finally { publicationObserver?.({ kind: typeof kind==="function" ? kind() : kind,milliseconds: performance.now()-started,committed }); }
}
export function transactionCheckpoint(client: pg.PoolClient) { return transactionObserver?.(client); }
export function transactionResultCheckpoint(client: pg.PoolClient) { return transactionResultObserver?.(client); }
const instrumented = new WeakSet<pg.PoolClient>();
export function checkpointQueries(client: pg.PoolClient) {
  if (!observer || instrumented.has(client)) return;
  instrumented.add(client);
  const query = client.query.bind(client);
  client.query = ((...args: Parameters<typeof query>) => {
    const started = performance.now();
    const result = (query as (...input: unknown[]) => unknown)(...args);
    if (!result || typeof (result as Promise<unknown>).then !== "function") return result;
    return (result as Promise<pg.QueryResult>).then(value => {
      peakCheckpoint("sql.result");
      sqlObserver?.({ sql: typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string }).text ?? ""),
        milliseconds: performance.now() - started,
        rows: Array.isArray(value) ? value.reduce((sum, part: pg.QueryResult) => sum + (part.rowCount ?? part.rows?.length ?? 0), 0)
          : value.rowCount ?? value.rows?.length ?? 0, failed: false,
        parameters: Array.isArray(args[1]) ? args[1] : undefined });
      return value;
    }, error => {
      sqlObserver?.({ sql: typeof args[0] === "string" ? args[0] : "",
        milliseconds: performance.now() - started, rows: 0, failed: true,
        parameters: Array.isArray(args[1]) ? args[1] : undefined });
      throw error;
    });
  }) as typeof client.query;
}
export function peakCheckpoint(stage: PeakStage) {
  if (observer) observer({ ...process.memoryUsage(), pid: process.pid, isolate: threadId,
    at: performance.now(), stage, heapLimit: getHeapStatistics().heap_size_limit });
}
