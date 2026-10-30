import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "./config.js";
import { AppError, errorHandler, errorTelemetry, normalizeError } from "./errors.js";
import { graphResponseError } from "./services/graphPackages.js";

const originalNodeEnv = config.nodeEnv;

afterEach(() => {
  config.nodeEnv = originalNodeEnv;
  vi.restoreAllMocks();
});

describe("error telemetry", () => {
  it("logs and delegates a failure after headers without rewriting the response", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new AppError(503, "data_queue_full", "Synthetic stream failure.");
    error.retryAfterSeconds = 5;
    const response = {
      headersSent: true, locals: { requestId: "request-stream" },
      setHeader: vi.fn(), status: vi.fn(), type: vi.fn(), json: vi.fn(),
    };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    const next = vi.fn();
    errorHandler(error, { route: { path: "/fixture" } } as Request, response as unknown as Response, next);
    expect(next).toHaveBeenCalledExactlyOnceWith(error);
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalled();
    expect(response.type).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      event: "request_error", requestId: "request-stream", status: 503, errorCode: "data_queue_full",
    });
  });

  it("preserves bounded admission Retry-After without changing other error contracts", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new AppError(503, "data_queue_full", "data_queue_full");
    error.retryAfterSeconds = 5;
    const response = { locals: {}, status: vi.fn(), type: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    errorHandler(error, { route: { path: "/fixture" } } as Request, response as unknown as Response, vi.fn());
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "5");
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it.each([429, 503])("preserves a received Graph HTTP %i cooldown in the problem response", status => {
    vi.spyOn(console, status >= 500 ? "error" : "warn").mockImplementation(() => undefined);
    const error = graphResponseError(new globalThis.Response(null, {
      status, headers: { "Retry-After": "17" },
    }));
    const response = { locals: { requestId: "request-provider" }, status: vi.fn(), type: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    errorHandler(error, { route: { path: "/fixture" } } as Request, response as unknown as Response, vi.fn());
    expect(response.setHeader).toHaveBeenCalledExactlyOnceWith("Retry-After", "17");
    expect(response.json).toHaveBeenCalledWith({
      type: "https://agent-control.invalid/problems/graph_error",
      title: status === 429 ? "Request limit reached" : "Service unavailable",
      status, detail: `Microsoft Graph request failed with status ${status}.`,
      code: "graph_error", requestId: "request-provider",
      details: { httpStatus: status, retryAfterMs: 17_000, ...(status === 429 ? { throttled: true } : {}) },
    });
  });

  it.each([
    [1, "1"], [999, "1"], [1_000, "1"], [1_001, "2"],
    [Number.MAX_SAFE_INTEGER, "9007199254741"],
  ])("rounds a %i-millisecond provider cooldown up to %s seconds", (retryAfterMs, seconds) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = new AppError(429, "provider_throttled", "Try later.", { retryAfterMs });
    const response = { locals: {}, status: vi.fn(), type: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    errorHandler(error, {} as Request, response as unknown as Response, vi.fn());
    expect(response.setHeader).toHaveBeenCalledExactlyOnceWith("Retry-After", seconds);
  });

  it.each([undefined, null, -1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1000"])(
    "does not turn invalid provider cooldown %s into a Retry-After header", retryAfterMs => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const error = new AppError(429, "provider_throttled", "Try later.", { retryAfterMs });
      const response = { locals: {}, status: vi.fn(), type: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
      response.status.mockReturnValue(response);
      response.type.mockReturnValue(response);
      errorHandler(error, {} as Request, response as unknown as Response, vi.fn());
      expect(response.setHeader).not.toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(429);
    },
  );

  it("keeps an explicit retry delay authoritative over provider diagnostics", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new AppError(503, "provider_error", "Try later.", { retryAfterMs: 120_000 });
    error.retryAfterSeconds = 5;
    const response = { locals: {}, status: vi.fn(), type: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    errorHandler(error, {} as Request, response as unknown as Response, vi.fn());
    expect(response.setHeader).toHaveBeenCalledExactlyOnceWith("Retry-After", "5");
  });

  it("does not evaluate a provider cooldown accessor", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getter = vi.fn(() => { throw new Error("private cooldown metadata"); });
    const details = Object.defineProperty({}, "retryAfterMs", { get: getter });
    const error = new AppError(429, "provider_throttled", "Try later.", details);
    const response = { locals: {}, status: vi.fn(), type: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    errorHandler(error, {} as Request, response as unknown as Response, vi.fn());
    expect(getter).not.toHaveBeenCalled();
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(429);
  });

  it("serves a generic problem instead of throwing while URI-encoding a malformed code", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new AppError(502, "provider_\uD800", "Provider failed.", { private: "metadata" });
    const response = { locals: { requestId: "request-invalid-code" }, status: vi.fn(), type: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    const next = vi.fn();
    errorHandler(error, {} as Request, response as unknown as Response, next);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.type).toHaveBeenCalledWith("application/problem+json");
    expect(response.json).toHaveBeenCalledExactlyOnceWith({
      type: "https://agent-control.invalid/problems/internal_error",
      title: "Request failed", status: 500, detail: "An unexpected error occurred",
      code: "internal_error", requestId: "request-invalid-code",
    });
    expect(next).not.toHaveBeenCalled();
  });

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

  it("classifies hostile error evidence without evaluating accessors or proxy traps", () => {
    const getter = vi.fn(() => { throw new Error("private accessor failure"); });
    const error = new AppError(502, "provider_error", "private message");
    Object.defineProperties(error, { name: { get: getter }, code: { get: getter }, status: { get: getter } });
    expect(errorTelemetry(error)).toEqual({ errorCode: "internal_error", errorKind: "application" });
    const revoked = Proxy.revocable(new Error("private error"), {});
    revoked.revoke();
    expect(errorTelemetry(revoked.proxy)).toEqual({ errorCode: "internal_error", errorKind: "unexpected" });
    const prototype = new Proxy(Error.prototype, { getPrototypeOf: getter });
    expect(errorTelemetry(Object.setPrototypeOf(new Error("private"), prototype)))
      .toEqual({ errorCode: "internal_error", errorKind: "unexpected" });
    expect(getter).not.toHaveBeenCalled();
    expect(errorTelemetry(new AppError(-1, "private invalid code", "private"))).toEqual({
      errorCode: "internal_error", errorKind: "application",
    });
  });

  it("preserves an application failure without evaluating optional diagnostic accessors", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getter = vi.fn(() => { throw new Error("private optional metadata"); });
    const error = Object.defineProperties(new AppError(502, "provider_error", "Provider failed."), {
      retryAfterSeconds: { get: getter }, details: { get: getter },
    });
    const response = { locals: { requestId: "request-original" }, status: vi.fn(), type: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    errorHandler(error, { route: { path: "/fixture" } } as Request, response as unknown as Response, vi.fn());
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 502, code: "provider_error", detail: "Provider failed.", requestId: "request-original",
    }));
    expect(response.json.mock.calls[0][0]).not.toHaveProperty("details");
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["frozen", "field_accessor", "locals_accessor"] as const)("serves the original problem when diagnostic locals are %s", kind => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const accessor = vi.fn(() => { throw new Error("private local metadata"); });
    const locals = { requestId: "request-original" };
    if (kind === "frozen") Object.freeze(locals);
    if (kind === "field_accessor") Object.defineProperty(locals, "errorCode", { get: accessor, set: accessor });
    const response = { locals, status: vi.fn(), type: vi.fn(), json: vi.fn() };
    if (kind === "locals_accessor") Object.defineProperty(response, "locals", { get: accessor });
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    expect(() => errorHandler(new AppError(502, "provider_error", "Provider failed."), {
      route: { path: "/fixture" },
    } as Request, response as unknown as Response, vi.fn())).not.toThrow();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 502, code: "provider_error", detail: "Provider failed.",
      requestId: kind === "locals_accessor" ? "unavailable" : "request-original",
    }));
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: "request_error", errorCode: "provider_error", status: 502 });
    expect(accessor).not.toHaveBeenCalled();
  });

  it("keeps arbitrary provider codes out of request and terminal HTTP telemetry labels", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new AppError(502, "private_provider_value", "Provider failed.", {
      httpStatus: 502, providerErrorCode: "private_provider_value",
    });
    const response = { locals: {}, status: vi.fn(), type: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    errorHandler(error, { route: { path: "/fixture" } } as Request, response as unknown as Response, vi.fn());
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ errorCode: "provider_error", status: 502 });
    expect(log.mock.calls[0][0]).not.toContain("private_provider_value");
    expect(response.locals).toHaveProperty("errorCode", "provider_error");
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: "private_provider_value" }));
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
  it.each([400, 403, 404, 413, 415])("preserves HTTP dependency errors with inherited data status %i", status => {
    const prototype = Object.assign(Object.create(Error.prototype), { status });
    const error = Object.setPrototypeOf(new Error("Synthetic HTTP failure"), prototype);
    expect(normalizeError(error)).toMatchObject({ status, code: "request_rejected" });
  });

  it("normalizes accessor and proxy exceptions without running their metadata", () => {
    const getter = vi.fn(() => { throw new Error("private normalization getter"); });
    const error = Object.defineProperties(new Error("private message"), { status: { get: getter }, message: { get: getter } });
    expect(normalizeError(error)).toMatchObject({ status: 500, code: "internal_error", message: "An unexpected error occurred" });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(normalizeError(revoked.proxy)).toMatchObject({ status: 500, code: "internal_error" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("preserves intentional application errors", () => {
    const error = new AppError(400, "invalid_request", "Invalid request");

    expect(normalizeError(error)).toBe(error);
  });

  it.each(["provider_\uD800", "provider_\uDC00", "provider_\uDC00\uD800"])(
    "rejects application codes that cannot be URI-encoded", code => {
      expect(normalizeError(new AppError(502, code, "Provider failed."))).toMatchObject({
        status: 500, code: "internal_error", message: "An unexpected error occurred",
      });
    },
  );

  it("preserves URI-encodable application codes, including valid surrogate pairs", () => {
    const error = new AppError(502, "provider_\uD83D\uDE00", "Provider failed.");
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
