import type { ErrorRequestHandler } from "express";
import { types } from "node:util";
import { config } from "./config.js";
import { operationalLog, requestRouteTemplate, safeTelemetry } from "./services/telemetry.js";

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;
  retryAfterSeconds?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static unauthorized(message = "Sign in is required") {
    return new AppError(401, "unauthorized", message);
  }

  static serviceUnavailable(message = "Authentication is not configured") {
    return new AppError(503, "auth_not_configured", message);
  }
}

export const errorHandler: ErrorRequestHandler = (
  error,
  request,
  response,
  _next,
) => {
  const appError = normalizeError(error);
  const retryAfter: unknown = Object.getOwnPropertyDescriptor(appError, "retryAfterSeconds")?.value;
  const details: unknown = Object.getOwnPropertyDescriptor(appError, "details")?.value;
  if (typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter > 0) {
    response.setHeader("Retry-After", String(retryAfter));
  }
  const telemetry = errorTelemetry(error, appError.code);
  const responseLocals: unknown = types.isProxy(response) ? undefined : Object.getOwnPropertyDescriptor(response, "locals")?.value;
  if (responseLocals && typeof responseLocals === "object" && !types.isProxy(responseLocals)) {
    try {
      Object.defineProperty(responseLocals, "errorCode", {
        value: telemetry.errorCode, writable: true, enumerable: true, configurable: true,
      });
    } catch {
      // A frozen or nonwritable diagnostic local must not replace the problem response.
    }
  }
  const locals = safeTelemetry(responseLocals);
  const event = appError.code === "provider_throttled" ? "provider_throttled"
    : appError.status >= 500 ? "request_error" : "request_rejected";
  operationalLog(appError.status >= 500 ? "error" : "warn", event, {
    requestId: locals.requestId, jobId: locals.jobId,
    route: requestRouteTemplate(request), ...telemetry, status: appError.status,
  });

  const requestId = typeof locals.requestId === "string"
    ? locals.requestId
    : "unavailable";
  response
    .status(appError.status)
    .type("application/problem+json")
    .json({
      type: `https://agent-control.invalid/problems/${encodeURIComponent(appError.code)}`,
      title: problemTitle(appError.status),
      status: appError.status,
      detail: appError.message,
      code: appError.code,
      requestId,
      ...(details === undefined ? {} : { details }),
    });
};

export function errorTelemetry(error: unknown, fallbackCode = "internal_error") {
  const fallback = safeTelemetry({ errorCode: fallbackCode }).errorCode;
  let errorCode = typeof fallback === "string" ? fallback : "internal_error";
  let status: number | undefined;
  const application = isApplicationError(error);
  if (application) {
    const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    const fields = safeTelemetry({
      errorCode: code,
      status: Object.getOwnPropertyDescriptor(error, "status")?.value,
    });
    if (typeof fields.errorCode === "string") errorCode = fields.errorCode;
    if (typeof fields.status === "number") status = fields.status;
    const details: unknown = Object.getOwnPropertyDescriptor(error, "details")?.value;
    if (status !== undefined && details !== null && typeof details === "object" && !types.isProxy(details)
      && Object.getOwnPropertyDescriptor(details, "httpStatus")?.value === status
      && typeof code === "string" && Object.getOwnPropertyDescriptor(details, "providerErrorCode")?.value === code) {
      errorCode = "provider_error";
    }
  }
  const name = errorName(error);
  const errorKind = name === "TimeoutError" || application && errorCode === "provider_timeout" ? "timeout"
    : name === "AbortError" ? "aborted" : application ? "application" : "unexpected";
  return {
    errorCode,
    errorKind,
    ...(status === undefined ? {} : { status }),
  };
}

export function isApplicationError(error: unknown): error is AppError {
  return hasNativeErrorPrototype(error, AppError.prototype);
}

export function hasNativeErrorPrototype(error: unknown, prototype: object): boolean {
  if (!types.isNativeError(error)) return false;
  let value: object | null = error;
  for (let depth = 0; value && depth < 8 && !types.isProxy(value); depth++) {
    if (value === prototype) return true;
    value = Object.getPrototypeOf(value);
  }
  return false;
}

function errorProperty(error: unknown, key: string): unknown {
  if (!error || typeof error !== "object") return undefined;
  let value: object | null = error;
  for (let depth = 0; value && depth < 8 && !types.isProxy(value); depth++) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property) return Object.hasOwn(property, "value") ? property.value : undefined;
    value = Object.getPrototypeOf(value);
  }
  return undefined;
}

export function errorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || types.isProxy(error)) return undefined;
  try {
    // Use the trusted DOMException brand getter, not a shadowing instance accessor.
    const name: unknown = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get?.call(error);
    if (typeof name === "string") return name;
  } catch {
    // Ordinary native errors do not carry the DOMException brand.
  }
  if (!types.isNativeError(error)) return undefined;
  const name = errorProperty(error, "name");
  return typeof name === "string" && name.length <= 128 ? name : undefined;
}

export function isTimeoutError(error: unknown): error is Error {
  return errorName(error) === "TimeoutError";
}

export function normalizeError(error: unknown) {
  const status = errorProperty(error, "status");
  const message = errorProperty(error, "message");
  if (isApplicationError(error)) {
    const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
      && typeof code === "string" && typeof message === "string") return error;
    return new AppError(500, "internal_error", "An unexpected error occurred");
  }

  if (typeof status === "number" && [400,403,404,413].includes(status)) return new AppError(status, "request_rejected", "The request could not be served.");

  if (types.isNativeError(error)) {
    return new AppError(
      500,
      "internal_error",
      config.nodeEnv === "production" || typeof message !== "string"
        ? "An unexpected error occurred"
        : message,
    );
  }

  return new AppError(500, "internal_error", "An unexpected error occurred");
}

function problemTitle(status: number) {
  if (status === 400) return "Invalid request";
  if (status === 401) return "Authentication required";
  if (status === 403) return "Access denied";
  if (status === 404) return "Not found";
  if (status === 409) return "Conflict";
  if (status === 413) return "Request too large";
  if (status === 429) return "Request limit reached";
  if (status === 503) return "Service unavailable";
  return "Request failed";
}
