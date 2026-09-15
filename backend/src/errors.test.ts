import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "./config.js";
import { AppError, errorHandler, errorTelemetry, normalizeError } from "./errors.js";

const originalNodeEnv = config.nodeEnv;

afterEach(() => {
  config.nodeEnv = originalNodeEnv;
  vi.restoreAllMocks();
});

describe("error telemetry", () => {
  it("classifies timeouts and cancellation without serializing exception text or details", () => {
    expect(errorTelemetry(new DOMException("private-token", "TimeoutError"), "provider_error"))
      .toEqual({ errorCode: "provider_error", errorKind: "timeout" });
    expect(errorTelemetry(new DOMException("private-token", "AbortError")))
      .toEqual({ errorCode: "internal_error", errorKind: "aborted" });
    expect(errorTelemetry(new AppError(502, "provider_schema", "private-row", { token: "private-token" })))
      .toEqual({ errorCode: "provider_schema", errorKind: "application", status: 502 });
    expect(errorTelemetry(new AppError(504, "provider_timeout", "private-timeout")))
      .toEqual({ errorCode: "provider_timeout", errorKind: "timeout", status: 504 });
  });

  it("logs known authorization rejections with request correlation and no sensitive content", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = {
      locals: { requestId: "request-a" }, status: vi.fn(), type: vi.fn(), json: vi.fn(),
    };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    errorHandler(new AppError(401, "interaction_required", "private-error-message", { token: "private-token" }), {
      originalUrl: "/api/inventory/refresh-jobs/private-id?code=private-code",
      route: { path: "/inventory/refresh-jobs/:id/resume" },
    } as Request, response as unknown as Response, vi.fn());
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      event: "request_rejected", requestId: "request-a", route: "/inventory/refresh-jobs/:id/resume",
      status: 401, errorCode: "interaction_required",
    });
    expect(log.mock.calls[0][0]).not.toContain("private-");
    expect(response.locals).toHaveProperty("errorCode", "interaction_required");
  });
});

describe("normalizeError", () => {
  it("preserves intentional application errors", () => {
    const error = new AppError(400, "invalid_request", "Invalid request");

    expect(normalizeError(error)).toBe(error);
  });

  it("hides unexpected error details in production", () => {
    config.nodeEnv = "production";

    expect(
      normalizeError(new Error("database path /private/data")),
    ).toMatchObject({
      status: 500,
      code: "internal_error",
      message: "An unexpected error occurred",
    });
  });

  it("keeps unexpected error details available during development", () => {
    config.nodeEnv = "development";

    expect(normalizeError(new Error("development details"))).toMatchObject({
      status: 500,
      code: "internal_error",
      message: "development details",
    });
  });
});
