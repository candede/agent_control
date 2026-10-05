import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { threadId } from "node:worker_threads";
import { createHash } from "node:crypto";
import type pg from "pg";
import { currentCapacityOperation } from "./capacityOperation.js";
import { observePeakMemory, observeQueryWork, observePublicationWork, peakCheckpoint, type PeakCheckpoint, type PeakStage } from "../src/services/peakMemory.js";

export const MiB = 1024 ** 2;
export const requiredStages: PeakStage[] = ["provider.parse", "batch.stringify", "sql.result", "import.transform", "response.serialize", "export.encode"];
export function parseGcNvp(line: string) {
  const identity = /^\[(\d+):([^\]]+)\]\s+([\d.]+)\s+ms:/.exec(line);
  if (!identity || !/\bgc=/.test(line)) return null;
  const fields = Object.fromEntries([...line.matchAll(/\b([a-z_]+)=([0-9.e+-]+)(?=\s|$)/g)].map(match => [match[1], Number(match[2])]));
  const before = fields.start_object_size ?? fields.total_size_before;
  const after = fields.end_object_size ?? fields.total_size_after;
  if (![before, after, fields.allocated].every(Number.isFinite)) {
    return { pid: Number(identity[1]), isolate: identity[2], at: Number(identity[3]), complete: false as const };
  }
  return { pid: Number(identity[1]), isolate: identity[2], at: Number(identity[3]), complete: true as const,
    before, after, allocated: fields.allocated };
}

export class CapacityTelemetry {
  readonly fd: number;
  readonly delay = monitorEventLoopDelay({ resolution: 20 });
  readonly stages = new Map<string, { count: number; max: number }>();
  readonly queries = new Map<string, { count: number; maxMs: number; rows: number; failures: number; sql: string }>();
  readonly explainQueries = new Map<string, { sql: string; parameters: unknown[];planningOnly?: boolean;nestedLoop?: boolean }>();
  sampledHeapUsedMax = 0;
  stageCheckpointHeapUsedMax = 0;
  sampledRssMax = 0;
  kernelChargedMemoryPeak: number | null = null;
  samples = 0;
  dropped = 0;
  bytes = 0;
  private requestWindow?: { startedAt: number; sampledHeapUsedMax: number; stageCheckpointHeapUsedMax: number; stages: Set<PeakStage> };
  private timer?: NodeJS.Timeout;
  constructor(path: string, readonly pool: () => unknown = () => null) {
    this.fd = openSync(path, "wx");
    this.write({ event: "identity", pid: process.pid, isolate: threadId, node: process.versions.node, v8: process.versions.v8,
      wallTime: Date.now(), timeOrigin: performance.timeOrigin,
      execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? null, heap: getHeapStatistics(),
      resourceCoverage: "The independent 250ms continuous-cgroup capture retains full memory.stat/cpu.stat; Node samples retain scalar limits, charge, events and swap without duplicating those blocks." });
    observePeakMemory(point => this.checkpoint(point));
    observePublicationWork(value => this.write({ event: "publication",at: performance.now(),...value,
      scope: "Final transaction including acquisition; not ingestion duration." }));
    observeQueryWork(value => {
      const hash = createHash("sha256").update(value.sql).digest("hex");
      const previous = this.queries.get(hash);
      const operation = currentCapacityOperation();
      if (operation?.startsWith("probe-")) this.write({ event: "probe-sql",operation,hash,
        milliseconds: value.milliseconds,rows: value.rows,failed: value.failed });
      if (value.failed && !value.sql.startsWith("EXPLAIN") && value.sql.includes("FROM seeds seed JOIN roots own")
        && this.explainQueries.size<8 && value.parameters && value.parameters.length<=32
        && JSON.stringify(value.parameters).length<=16384) {
        this.explainQueries.set(hash,{ sql: value.sql,parameters: value.parameters,planningOnly: true });
      }
      if (!value.sql.startsWith("EXPLAIN") && (value.sql.includes("UPDATE inventory_memberships m SET valid_to_revision")
        || value.sql.includes("WITH seeds AS MATERIALIZED") || value.sql.includes("INSERT INTO inventory_changes(")
        || value.sql.includes("INSERT INTO inventory_memberships(baseline_id,")) && this.explainQueries.size<8
        && value.parameters && value.parameters.length<=32 && JSON.stringify(value.parameters).length<=16384) {
        this.explainQueries.set(hash,{ sql: value.sql,parameters: value.parameters,planningOnly: true });
      }
      if (this.explainQueries.size < 8 && !value.sql.startsWith("EXPLAIN")
        && (value.sql.includes("matching AS ") || value.sql.includes("summary_facts AS MATERIALIZED")
          || value.sql.includes("options AS (SELECT") || value.sql.includes("length(r.sort_key)<=64")
          || value.sql.includes("AS count_primary_complete") || value.sql.startsWith("WITH candidates AS (SELECT r.identity,r.generation_id,r.residual"))
        && value.parameters && value.parameters.length <= 32 && JSON.stringify(value.parameters).length <= 16384) {
        this.explainQueries.set(hash, { sql: value.sql, parameters: value.parameters,
          planningOnly: value.failed,nestedLoop: value.sql.includes("length(r.sort_key)<=64")
            || value.sql.includes("selected_report_keys AS MATERIALIZED") || value.sql.includes("selected_directory AS MATERIALIZED")
            || value.sql.startsWith("WITH candidates AS (SELECT r.identity,r.generation_id,r.residual") });
      }
      if (!previous && this.queries.size >= 2048) { this.dropped++; return; }
      this.queries.set(hash, { count: (previous?.count ?? 0) + 1, maxMs: Math.max(previous?.maxMs ?? 0, value.milliseconds),
        rows: (previous?.rows ?? 0) + value.rows, failures: (previous?.failures ?? 0) + Number(value.failed), sql: value.sql });
      if (!previous) this.write({ event: "sql-template",hash,sql: value.sql.slice(0,65536),truncated: value.sql.length>65536 });
      if (!previous || value.milliseconds > previous.maxMs) this.write({ event: "sql", hash, ...value, sql: undefined, parameters: undefined });
    });
  }
  async capturePlans(database: pg.Pool, labels: { count?: number;profile?: string }) {
    const { dataConnections } = await import("../src/db/dataConnections.js");
    const plans = [...this.explainQueries];
    this.explainQueries.clear();
    for (const [hash,query] of plans) {
      try {
        const plan = await dataConnections(database).selectedRead(async client => {
          await client.query("SELECT set_config('jit','off',true),set_config('plan_cache_mode','force_custom_plan',true)");
          if (query.nestedLoop!==undefined || !query.planningOnly) {
            await client.query("SELECT set_config('enable_nestloop',$1,true)",[query.nestedLoop ? "on" : "off"]);
          }
          return client.query(`EXPLAIN (${query.planningOnly ? "" : "ANALYZE,BUFFERS,WAL,"}SETTINGS,FORMAT JSON) `+query.sql,query.parameters);
        });
        this.write({ event: "explain",...labels,hash,analyzed: !query.planningOnly,plan: plan.rows });
      } catch (error) { this.write({ event: "explain-failed",...labels,hash,error: String(error) }); }
    }
  }
  write(value: unknown) {
    const line = JSON.stringify(value) + "\n";
    if (this.bytes + Buffer.byteLength(line) > 256 * MiB) { this.dropped++; return; }
    try { this.bytes += writeSync(this.fd, line); } catch { this.dropped++; }
  }
  checkpoint(point: PeakCheckpoint) {
    if (this.requestWindow) {
      this.requestWindow.stageCheckpointHeapUsedMax = Math.max(this.requestWindow.stageCheckpointHeapUsedMax,point.heapUsed);
      this.requestWindow.stages.add(point.stage);
    }
    this.stageCheckpointHeapUsedMax = Math.max(this.stageCheckpointHeapUsedMax, point.heapUsed);
    const old = this.stages.get(point.stage);
    this.stages.set(point.stage, { count: (old?.count ?? 0) + 1, max: Math.max(old?.max ?? 0, point.heapUsed) });
    // Every checkpoint is measured; only new high water and the first sample are serialized.
    if (!old || point.heapUsed > old.max) this.write({ event: "checkpoint", ...point });
  }
  sample() {
    const memory = process.memoryUsage();
    if (this.requestWindow) this.requestWindow.sampledHeapUsedMax = Math.max(this.requestWindow.sampledHeapUsedMax,memory.heapUsed);
    this.samples++;
    this.sampledHeapUsedMax = Math.max(this.sampledHeapUsedMax, memory.heapUsed);
    this.sampledRssMax = Math.max(this.sampledRssMax, memory.rss);
    let cgroup: Record<string, string> | null = {};
    try {
      for (const key of ["memory.current", "memory.peak", "memory.max", "memory.events",
        "memory.swap.current", "memory.swap.max", "cpu.max"]) cgroup[key] = readFileSync(`/sys/fs/cgroup/${key}`, "utf8").trim();
      const peak = Number(cgroup["memory.peak"]);
      if (Number.isFinite(peak)) this.kernelChargedMemoryPeak = Math.max(this.kernelChargedMemoryPeak ?? 0, peak);
    } catch { cgroup = null; }
    this.write({ event: "sample", at: performance.now(), pid: process.pid, isolate: threadId, ...memory,
      eventLoopMaxMs: this.delay.max / 1e6, pool: this.pool(), cgroup });
    this.delay.reset();
  }
  start() { this.delay.enable(); this.sample(); this.timer = setInterval(() => this.sample(), 250); }
  beginRequestWindow() {
    if (this.requestWindow) throw new Error("capacity_request_window_overlap");
    this.requestWindow = { startedAt: performance.now(),sampledHeapUsedMax: 0,stageCheckpointHeapUsedMax: 0,stages: new Set() };
  }
  endRequestWindow() {
    if (!this.requestWindow) throw new Error("capacity_request_window_missing");
    const value = { ...this.requestWindow,stages: [...this.requestWindow.stages],finishedAt: performance.now() };
    this.requestWindow = undefined; return value;
  }
  stop() {
    clearInterval(this.timer); this.sample(); this.delay.disable(); observePeakMemory(); observeQueryWork(); observePublicationWork();
    const result = { event: "summary", pid: process.pid, isolate: threadId, sampledHeapUsedMax: this.sampledHeapUsedMax,
      stageCheckpointHeapUsedMax: this.stageCheckpointHeapUsedMax, sampledRssMax: this.sampledRssMax,
      kernelChargedMemoryPeak: this.kernelChargedMemoryPeak, stages: Object.fromEntries(this.stages),
      missingStages: requiredStages.filter(stage => !this.stages.has(stage)), samples: this.samples, dropped: this.dropped, bytes: this.bytes };
    for (const [hash, value] of this.queries) this.write({ event: "query-summary", hash, ...value });
    for (const [hash, value] of this.explainQueries) this.write({ event: "explain-input", hash, ...value });
    result.dropped = this.dropped; result.bytes = this.bytes;
    this.write(result); closeSync(this.fd); return result;
  }
}

export function onCapacityWorkerTermination(stop: () => unknown) {
  const terminate = () => {
    try { stop(); }
    catch { try { writeSync(2,"CAPACITY_WORKER_TELEMETRY_INCOMPLETE\n"); } catch { /* The original termination still wins. */ } }
    finally { process.removeListener("SIGTERM",terminate);process.kill(process.pid,"SIGTERM"); }
  };
  process.once("SIGTERM",terminate);
}

export async function transientHeapProbe() {
  if (!global.gc) throw new Error("transient_probe_requires_expose_gc");
  // Packed double arrays retain eight bytes per element without millions of small objects.
  for (let pass = 0; pass < 4; pass++) JSON.parse(JSON.stringify(Array.from({ length: 100_000 }, (_, i) => i + 0.25)));
  global.gc();
  await new Promise(resolve => setTimeout(resolve, 260));
  const baseline = process.memoryUsage().heapUsed;
  const tripwire = baseline + 16 * MiB;
  const timerSamples: number[] = [];
  const timer = setInterval(() => timerSamples.push(process.memoryUsage().heapUsed), 250);
  const started = performance.now();
  let values: number[] | null = new Array<number>(2_100_000).fill(1.25);
  let encoded: string | null = JSON.stringify(values);
  let parsed: number[] | null = JSON.parse(encoded) as number[];
  const live = process.memoryUsage().heapUsed;
  peakCheckpoint("probe.live");
  const checksum = parsed.length + values.length + encoded.length;
  values = null; encoded = null; parsed = null;
  global.gc();
  const durationMs = performance.now() - started;
  await new Promise(resolve => setTimeout(resolve, 270));
  clearInterval(timer);
  const timerMaximum = Math.max(...timerSamples);
  return { status: live - baseline >= 32 * MiB && durationMs < 250 && live > tripwire && timerMaximum < tripwire ? "passed" : "inconclusive",
    baseline, live, retainedBytes: live - baseline, tripwire, durationMs, timerMaximum, timerSamples, checksum };
}
