import type { ErrorRequestHandler } from "express";
import { config } from "./config.js";

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
  if (!(error instanceof AppError)) {
    console.error("Unexpected request error", error);
  }

  const appError = normalizeError(error);

  response.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      details: appError.details,
    },
  });
};

export function normalizeError(error: unknown) {
  if (error instanceof AppError) {
    return error;
  }

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
