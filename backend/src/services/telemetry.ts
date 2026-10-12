import { AsyncLocalStorage } from "node:async_hooks";
import { errorMonitor } from "node:events";
import { types } from "node:util";
import type { Request, RequestHandler } from "express";
import { capabilityIds } from "../types/capability.js";
import { dataSyncSourceIds } from "../types/dataSync.js";
import { powerPlatformResourceTypes } from "../types/powerPlatformInventory.js";

const packageDiagnosticNumberFields = new Set([
  "bytes", "rows", "pins", "queueDepth", "backlogRoots", "oldestAgeMs",
  "missingCount", "nullCount", "emptyCount", "nonemptyCount", "invalidCount",
  "matchingCount", "differingCount", "listOnlyCount", "detailOnlyCount", "bothMissingCount",
  "requestCount", "retryCount", "throttleCount", "requestDurationMs", "maxRequestDurationMs",
  "admissionWaitMs", "retryWaitMs", "readIntervalMs", "retryAfterMs",
  "rssBytes", "heapUsedBytes", "heapTotalBytes", "externalBytes", "arrayBufferBytes",
  "poolTotal", "poolIdle", "poolWaiting", "poolForeground", "poolQueue",
]);

const integerFields = new Set([
  ...packageDiagnosticNumberFields, "attempt", "count", "schemaVersion", "page", "pages", "observedCount",
  "totalRecords", "returnedCount", "dataCount", "omittedFieldCount", "requestedTypeCount", "queriedTypeCount",
  "pageSize", "pageLimit", "rowLimit", "length", "maximumLength", "resourceIndex", "firstSeenPage", "catalogScopedCount", "targetIndex",
]);
const durationFields = new Set(["durationMs", "ageMs", "deadlineMs", "retryDelayMs"]);
const booleanFields = new Set(["hasContinuation", "resultTruncated", "environmentScoped"]);
const labels: Record<string, ReadonlySet<string>> = {
  capabilityId: new Set(capabilityIds),
  provider: new Set(["graph", "graph_packages", "power_platform"]),
  outcome: new Set(["updated", "failed", "cancelled", "timed_out", "collecting", "collected", "incomplete",
    "provider_success", "provider_failure", "requires_review", "requires_reconciliation", "deadline_exceeded", "throttled"]),
  status: new Set(["queued", "running", "waiting_authorization", "succeeded", "failed", "cancelled", "partial"]),
  mode: new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE", "broad", "exact", "delegated", "application", "local"]),
  source: new Set([...dataSyncSourceIds, "directory", "app_activity", "official_usage", "inventory_refresh", "capability_check",
    "local_administrative_audit", "microsoft_defender_hunting", "microsoft_purview_audit", "agent_sharing_diagnostic"]),
  apiVersion: new Set(["v1.0", "beta", "2024-10-01"]),
  errorKind: new Set(["timeout", "aborted", "application", "unexpected"]),
  stage: new Set(["record_gc", "inventory_gc", "generation", "selection", "export", "admission",
    "catalog", "identity", "pagination", "load_job", "revalidate_user", "authorization", "delegated_token", "mark_running",
    "dispatch", "query", "inventory_collection", "collection_authorization", "publication_authorization", "publication",
    "canonical_reconciliation", "reconciliation", "request", "validation", "save_page", "record_progress", "completion",
    "transport", "response_body", "release", "target_unlock", "authorization_wait", "authorization_pause", "terminal_item",
    "inventory_projection", "generation_batch", "database"]),
  resourceType: new Set(powerPlatformResourceTypes),
  field: new Set(["name", "tenantId", "type", "location", "environmentId", "totalRecords", "count", "data", "skipToken",
    "resultTruncated", "elementDetails", "allowedUsersAndGroups", "acquireUsersAndGroups", "sharedWithUsersAndGroups", "longDescription", "categories",
    "sensitivity", "retained_observation", "residual", "payload", "id", "makerSharing", "sharedWithViewers", "sharedWithEditors",
    "harness", "titleId", "instructionsCharactersCount", "componentsCounts", "distinctFlows", "flows", "triggers"]),
  actualType: new Set(["undefined", "null", "array", "object", "string", "number", "boolean", "bigint", "symbol", "function",
    "missing", "detail", "summary", "other"]),
  reason: new Set(["changed_total", "incomplete_enumeration", "oversized_access_check", "invalid_page", "invalid_total",
    "invalid_count", "invalid_page_data", "invalid_truncation", "exceeded_total", "missing_continuation",
    "inconsistent_continuation", "duplicate_identity", "scope_mismatch", "invalid_resource", "invalid_resource_type",
    "invalid_identity_type", "empty_identity", "identity_too_long", "invalid_identity_text", "invalid_location",
    "invalid_continuation", "transport", "response_body", "throttled", "server_error", "recovering", "invalid_element_details",
    "bot_application_disagreement", "invalid_bot_application_json", "invalid_bot_application_definition",
    "invalid_bot_application_identity", "metadata_limit", "invalid_json", "invalid_source_ids", "invalid_typed_identity", "empty_metadata",
    "Authorization_RequestDenied", "AccessDenied", "ErrorAccessDenied", "Forbidden", "NotFound", "ResourceNotFound",
    "TooManyRequests", "UnknownError", "InternalServerError", "ServiceUnavailable", "BadRequest", "InvalidAuthenticationToken",
    "InvalidRequest", "Request_BadRequest", "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError",
    "EvalError", "AggregateError", "AbortError", "TimeoutError"]),
  retryDelaySource: new Set(["retry_after", "fallback"]),
};
const allowedFields = new Set([
  ...integerFields, ...durationFields, ...booleanFields, ...Object.keys(labels),
  "requestId", "runId", "jobId", "route", "errorCode", "providerRequestId", "providerCorrelationId",
]);

type TelemetryContext = { requestId?: string; jobId?: string; route?: string };
const context = new AsyncLocalStorage<TelemetryContext>();
export function withTelemetryContext<T>(fields: TelemetryContext, operation: () => T): T {
  const next = { ...context.getStore() };
  const safe = safeTelemetry(fields);
  if (fields && typeof fields === "object" && !types.isProxy(fields)) {
    for (const key of ["requestId", "jobId", "route"] as const) {
      if (Object.getOwnPropertyDescriptor(fields, key)) {
        next[key] = typeof safe[key] === "string" ? safe[key] : undefined;
      }
    }
  }
  return context.run(next, operation);
}

export function safeTelemetry(fields: unknown = {}) {
  const result: Record<string, string | number | boolean> = Object.create(null);
  if (!fields || typeof fields !== "object" || types.isProxy(fields)) return result;
  // Probe only the finite contract; unknown fields and accessors must never run.
  for (const key of allowedFields) {
    const property = Object.getOwnPropertyDescriptor(fields, key);
    if (!property?.enumerable || !Object.hasOwn(property, "value")) continue;
    const value: unknown = property.value;
    if (integerFields.has(key)) {
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[key] = value;
    } else if (durationFields.has(key)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) result[key] = value;
    } else if (booleanFields.has(key)) {
      if (typeof value === "boolean") result[key] = value;
    } else if (key === "status" && typeof value === "number") {
      if (Number.isInteger(value) && value >= 100 && value <= 599) result[key] = value;
    } else if (typeof value === "string" && value.length > 0 && value.length <= 128
      && !/[\u0000-\u001F\u007F-\u009F\u2028\u2029\uD800-\uDFFF]/u.test(value)) {
      if (Object.hasOwn(labels, key)) {
        if (labels[key].has(value)) result[key] = value;
      } else if (key === "route") {
        if ((value === "unmatched" || value.startsWith("/")) && !/[?#]/.test(value)) result[key] = value;
      } else if (key === "errorCode") {
        if (/^[a-z][a-z0-9_]{0,127}$/.test(value)) result[key] = value;
      } else if (key === "providerRequestId" || key === "providerCorrelationId") {
        if (/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value)) result[key] = value;
      } else if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) result[key] = value;
    }
  }
  return result;
}

export function operationalLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) {
  if (typeof event !== "string" || event.length > 64 || !/^[a-z][a-z0-9_]*$/.test(event)
    || /[\r\n]/.test(event)) throw new Error("Telemetry event name is invalid.");
  if (!["info", "warn", "error"].includes(level)) throw new Error("Telemetry level is invalid.");
  try {
    const metadata = safeTelemetry(context.getStore());
    if (fields && typeof fields === "object" && !types.isProxy(fields)) {
      for (const key of ["requestId", "jobId", "route"] as const) {
        if (Object.getOwnPropertyDescriptor(fields, key)) delete metadata[key];
      }
    }
    const entry = JSON.stringify(Object.assign(Object.create(null),
      { timestamp: new Date().toISOString(), level, event }, metadata, safeTelemetry(fields)));
    if (level === "error") console.error(entry);
    else if (level === "warn") console.warn(entry);
    else console.log(entry);
  } catch {
    // A failed diagnostics sink must not abort business work or the runtime sampler.
  }
}

export function observeDatabasePool(waitingCount: number) {
  if (Number.isSafeInteger(waitingCount) && waitingCount > 0) {
    operationalLog("error", "database_pool_saturated", { count: waitingCount });
  }
}

export function observeRuntimeResources(database: {
  totalCount: number; idleCount: number; waitingCount: number;
  admissionState?: { foreground: number; queue: number };
}) {
  try {
    const memory = process.memoryUsage();
    const admission = database.admissionState;
    operationalLog("info", "runtime_resource_sample", {
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external, arrayBufferBytes: memory.arrayBuffers,
      poolTotal: database.totalCount, poolIdle: database.idleCount, poolWaiting: database.waitingCount,
      poolForeground: admission?.foreground, poolQueue: admission?.queue,
    });
  } catch {
    // Sampling failure must not stop the other periodic observers or runtime.
  }
}

export const httpTelemetry: RequestHandler = (request, response, next) => {
  let startedAt: number | undefined;
  try { startedAt = performance.now(); }
  catch { /* An unavailable clock must not prevent request dispatch. */ }
  const initial = safeTelemetry(telemetryDataValue(response, "locals"));
  const requestId = typeof initial.requestId === "string" ? initial.requestId : undefined;
  withTelemetryContext({ requestId, jobId: undefined, route: undefined }, () => {
    let settled = false;
    const settle = (completed: boolean) => {
      if (settled) return;
      settled = true;
      response.removeListener("finish", finished);
      response.removeListener("close", closed);
      response.removeListener(errorMonitor, closed);
      try {
        if (startedAt === undefined) return;
        const locals = safeTelemetry(telemetryDataValue(response, "locals"));
        const status = completed ? safeTelemetry({ status: response.statusCode }).status : undefined;
        const httpStatus = typeof status === "number" ? status : undefined;
        const level = !completed ? "warn" : httpStatus !== undefined && httpStatus >= 500 ? "error"
          : httpStatus !== undefined && httpStatus >= 400 ? "warn" : "info";
        operationalLog(level, completed ? "http_request" : "http_request_aborted", {
          requestId, jobId: locals.jobId, route: requestRouteTemplate(request),
          ...(completed ? { status: httpStatus, errorCode: locals.errorCode } : {}),
          durationMs: Math.round(performance.now() - startedAt), mode: request.method,
        });
      } catch {
        // Terminal diagnostics cannot interrupt another response listener.
      }
    };
    const finished = AsyncLocalStorage.bind(() => settle(true));
    const closed = AsyncLocalStorage.bind(() => {
      if (settled) return;
      let completed = false;
      try { completed = response.writableFinished === true; }
      catch { /* A failed completion probe cannot establish a finished response. */ }
      settle(completed);
    });
    response.once("finish", finished);
    response.once("close", closed);
    // Observe transport errors without handling an otherwise unhandled error.
    response.once(errorMonitor, closed);
    next();
  });
};

function telemetryDataValue(value: object, key: string): unknown {
  if (!value || types.isProxy(value)) return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && Object.hasOwn(property, "value") ? property.value : undefined;
}

export function requestRouteTemplate(request: Request) {
  if (!request || typeof request !== "object" || types.isProxy(request)) return "unmatched";
  const route: unknown = Object.getOwnPropertyDescriptor(request, "route")?.value;
  if (!route || typeof route !== "object" || types.isProxy(route)) return "unmatched";
  const path = safeTelemetry({ route: Object.getOwnPropertyDescriptor(route, "path")?.value }).route;
  return typeof path === "string" ? path : "unmatched";
}
