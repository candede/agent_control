import { AsyncLocalStorage } from "node:async_hooks";
import { operationalLog, safeTelemetry, withTelemetryContext } from "./telemetry.js";

const stages = ["record_gc", "inventory_gc", "generation", "selection", "export", "admission"] as const;
type Stage = typeof stages[number];
type Measurement = { rows?: number; bytes?: number; pins?: number; queueDepth?: number; backlogRoots?: number; durationMs?: number; oldestAgeMs?: number };
type Measurements = Map<Stage, Measurement & { count: number }>;
const measurements: Measurements = new Map();
type MetricScope = { pending: Measurements; closed: boolean };
const transactionMeasurements = new AsyncLocalStorage<MetricScope>();

function aggregate(target: Measurements, stage: Stage, fields: Measurement, count: number) {
  const current = target.get(stage) ?? { count: 0 };
  const safe = safeTelemetry(fields);
  current.count = Math.min(Number.MAX_SAFE_INTEGER, current.count + count);
  for (const key of ["rows", "bytes", "pins", "queueDepth", "backlogRoots", "durationMs", "oldestAgeMs"] as const) {
    const value = safe[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) current[key] = Math.max(current[key] ?? 0, value);
  }
  target.set(stage, current);
}

export function observeDataWork(stage: Stage, fields: Measurement) {
  if (!stages.includes(stage)) return;
  const scope = stage === "admission" ? undefined : transactionMeasurements.getStore();
  if (scope?.closed) return;
  aggregate(scope?.pending ?? measurements, stage, fields, 1);
}

/** Keep bounded observations private until the transaction owner confirms COMMIT. */
export function dataWorkMetricScope() {
  const scope: MetricScope = { pending: new Map(), closed: false };
  let active = 0;
  return {
    run: async <T>(operation: () => T | Promise<T>): Promise<T> => {
      if (scope.closed) throw new Error("data_metric_scope_closed");
      active++;
      try { return await transactionMeasurements.run(scope, operation); }
      finally { active--; }
    },
    commit: () => {
      if (scope.closed) return;
      if (active) throw new Error("data_metric_scope_active");
      scope.closed = true;
      try {
        for (const [stage, fields] of scope.pending) aggregate(measurements, stage, fields, fields.count);
      } finally { scope.pending.clear(); }
    },
    discard: () => { scope.closed = true; scope.pending.clear(); },
  };
}

export function flushDataWorkMetrics() {
  const values = [...measurements].map(([stage, fields]) => ({ stage, ...fields }));
  measurements.clear();
  if (values.length) withTelemetryContext({ requestId: undefined, jobId: undefined, route: undefined }, () => {
    for (const value of values) operationalLog("info", "data_lifecycle_metrics", value);
  });
  return values;
}
