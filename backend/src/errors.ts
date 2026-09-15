import type { ErrorRequestHandler } from "express";
import { config } from "./config.js";
import { operationalLog, requestRouteTemplate } from "./services/telemetry.js";

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

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
  response.locals.errorCode = appError.code;
  const event = appError.code === "provider_throttled" ? "provider_throttled"
    : appError.status >= 500 ? "request_error" : "request_rejected";
  operationalLog(appError.status >= 500 ? "error" : "warn", event, {
    requestId: response.locals.requestId, jobId: response.locals.jobId,
    route: requestRouteTemplate(request), ...errorTelemetry(error), errorCode: appError.code, status: appError.status,
  });

  const requestId = typeof response.locals.requestId === "string"
    ? response.locals.requestId
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
      ...(appError.details === undefined ? {} : { details: appError.details }),
    });
};

export function errorTelemetry(error: unknown, fallbackCode = "internal_error") {
  const errorKind = isTimeoutError(error) || error instanceof AppError && error.code === "provider_timeout" ? "timeout"
    : error instanceof Error && error.name === "AbortError" ? "aborted"
      : error instanceof AppError ? "application" : "unexpected";
  return {
    errorCode: error instanceof AppError ? error.code : fallbackCode,
    errorKind,
    ...(error instanceof AppError ? { status: error.status } : {}),
  };
}

export function isTimeoutError(error: unknown): error is Error {
  return error instanceof Error && error.name === "TimeoutError";
}

export function normalizeError(error: unknown) {
  if (error instanceof AppError) {
    return error;
  }

  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number" && [400,403,404,413].includes(status)) return new AppError(status, "request_rejected", "The request could not be served.");

  if (error instanceof Error) {
    return new AppError(
      500,
      "internal_error",
      config.nodeEnv === "production"
        ? "An unexpected error occurred"
        : error.message,
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
