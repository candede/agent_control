import { operationalLog, withTelemetryContext } from "./telemetry.js";

const stages = ["record_gc", "inventory_gc", "generation", "selection", "export", "admission"] as const;
type Stage = typeof stages[number];
type Measurement = { rows?: number; bytes?: number; pins?: number; queueDepth?: number; backlogRoots?: number; durationMs?: number; oldestAgeMs?: number };
const measurements = new Map<Stage, Measurement & { count: number }>();

export function observeDataWork(stage: Stage, fields: Measurement) {
  if (!stages.includes(stage)) return;
  const current = measurements.get(stage) ?? { count: 0 };
  current.count = Math.min(Number.MAX_SAFE_INTEGER, current.count + 1);
  for (const key of ["rows", "bytes", "pins", "queueDepth", "backlogRoots", "durationMs", "oldestAgeMs"] as const) {
    const value = fields[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) current[key] = Math.max(current[key] ?? 0, value);
  }
  measurements.set(stage, current);
}

export function flushDataWorkMetrics() {
  const values = [...measurements].map(([stage, fields]) => ({ stage, ...fields }));
  measurements.clear();
  if (values.length) withTelemetryContext({ requestId: undefined, jobId: undefined, route: undefined }, () => {
    for (const value of values) operationalLog("info", "data_lifecycle_metrics", value);
  });
  return values;
}
