import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, RequestHandler } from "express";

const allowedFields = new Set([
  "requestId", "jobId", "capabilityId", "provider", "outcome", "status",
  "durationMs", "ageMs", "attempt", "count", "mode", "source", "schemaVersion",
  "route", "errorCode", "errorKind", "stage", "page", "pages", "observedCount",
  "totalRecords", "returnedCount", "dataCount", "hasContinuation", "resultTruncated",
  "omittedFieldCount", "requestedTypeCount", "environmentScoped", "pageSize",
  "pageLimit", "rowLimit", "deadlineMs", "retryDelayMs", "providerRequestId",
  "providerCorrelationId", "resourceType", "field", "actualType", "length",
  "maximumLength", "resourceIndex", "firstSeenPage", "reason", "catalogScopedCount",
]);

type TelemetryContext = { requestId?: string; jobId?: string; route?: string };
const context = new AsyncLocalStorage<TelemetryContext>();

export function withTelemetryContext<T>(fields: TelemetryContext, operation: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, operation);
}

export function safeTelemetry(fields: Record<string, unknown> = {}) {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowedFields.has(key)) continue;
    if (key === "route" && (typeof value !== "string" || /[?#]/.test(value))) continue;
    if (key === "errorCode" && (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(value))) continue;
    if (["providerRequestId", "providerCorrelationId"].includes(key)
      && (typeof value !== "string" || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value))) continue;
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
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safeTelemetry({ ...context.getStore(), ...fields }) });
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
  const requestId = typeof response.locals.requestId === "string" ? response.locals.requestId : undefined;
  withTelemetryContext({ requestId }, () => {
    let finished = false;
    response.once("finish", () => {
      finished = true;
      operationalLog(response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "warn" : "info", "http_request", {
        requestId, jobId: response.locals.jobId, route: requestRouteTemplate(request),
        status: response.statusCode, errorCode: response.locals.errorCode,
        durationMs: Math.round(performance.now() - startedAt), mode: request.method,
      });
    });
    response.once("close", () => {
      if (!finished) operationalLog("warn", "http_request_aborted", {
        requestId, jobId: response.locals.jobId, route: requestRouteTemplate(request),
        durationMs: Math.round(performance.now() - startedAt), mode: request.method,
      });
    });
    next();
  });
};

export function requestRouteTemplate(request: Request) {
  const route: unknown = request.route?.path;
  return typeof route === "string" ? route : "unmatched";
}
