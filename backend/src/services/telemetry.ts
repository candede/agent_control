const allowedFields = new Set([
  "requestId", "jobId", "capabilityId", "provider", "outcome", "status",
  "durationMs", "ageMs", "attempt", "count", "mode", "source", "schemaVersion",
]);

export function safeTelemetry(fields: Record<string, unknown> = {}) {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowedFields.has(key)) continue;
    if (typeof value === "string" && value.length <= 128 && !/[\r\n\0]/.test(value)) result[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "boolean") result[key] = value;
  }
  return result;
}

export function operationalLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(event)) throw new Error("Telemetry event name is invalid.");
  const entry = JSON.stringify({ event, ...safeTelemetry(fields) });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

export function observeDatabasePool(waitingCount: number) {
  if (Number.isInteger(waitingCount) && waitingCount > 0) {
    operationalLog("error", "database_pool_saturated", { count: waitingCount });
  }
}

export const httpTelemetry: RequestHandler = (request, response, next) => {
  const startedAt = performance.now();
  response.once("finish", () => operationalLog(
    response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "warn" : "info",
    "http_request",
    {
      requestId: response.locals.requestId,
      status: response.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
      mode: request.method,
    },
  ));
  next();
};
import type { RequestHandler } from "express";
