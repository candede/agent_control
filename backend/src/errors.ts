import type { ErrorRequestHandler } from "express";
import { config } from "./config.js";
import { operationalLog } from "./services/telemetry.js";

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
  _request,
  response,
  _next,
) => {
  if (error instanceof AppError && error.code === "provider_throttled") {
    operationalLog("warn", "provider_throttled", { requestId: response.locals.requestId, status: error.status });
  } else if (!(error instanceof AppError)) {
    operationalLog("error", "request_error", { requestId: response.locals.requestId, outcome: "internal_error" });
  }

  const appError = normalizeError(error);

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
