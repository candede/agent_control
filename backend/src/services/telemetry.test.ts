import { errorMonitor, EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pool } from "../db/pool.js";
import { httpTelemetry, observeDatabasePool, observeRuntimeResources, operationalLog, requestRouteTemplate, safeTelemetry, withTelemetryContext } from "./telemetry.js";

afterEach(() => vi.restoreAllMocks());

describe("operational telemetry", () => {
  it("samples actual heap and pool gauges including idle zeros without credentials", () => {
    vi.spyOn(process, "memoryUsage").mockReturnValue({ rss: 100, heapUsed: 20, heapTotal: 30, external: 4, arrayBuffers: 2 });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    observeRuntimeResources({ totalCount: 2, idleCount: 2, waitingCount: 0, admissionState: { foreground: 0, queue: 0 } });
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      timestamp: expect.any(String), level: "info", event: "runtime_resource_sample",
      rssBytes: 100, heapUsedBytes: 20, heapTotalBytes: 30, externalBytes: 4, arrayBufferBytes: 2,
      poolTotal: 2, poolIdle: 2, poolWaiting: 0, poolForeground: 0, poolQueue: 0,
    });
    for (const field of ["rssBytes", "heapUsedBytes", "heapTotalBytes", "externalBytes", "arrayBufferBytes", "poolTotal", "poolIdle", "poolWaiting", "poolForeground", "poolQueue"]) {
      for (const value of [-1, 0.5, Infinity, "secret", true, {}]) expect(safeTelemetry({ [field]: value })).toEqual({});
    }
    observeRuntimeResources({ totalCount: 2, idleCount: 2, waitingCount: 0 });
    expect(JSON.parse(log.mock.calls[1][0])).not.toHaveProperty("poolQueue");
  });

  it("contains resource sampling failures without inventing a healthy sample", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process, "memoryUsage").mockImplementationOnce(() => { throw new Error("synthetic memory failure"); });
    expect(() => observeRuntimeResources({ totalCount: 1, idleCount: 0, waitingCount: 0 })).not.toThrow();
    expect(log).not.toHaveBeenCalled();
    observeRuntimeResources({ totalCount: 1, idleCount: 0, waitingCount: 0 });
    expect(log).toHaveBeenCalledOnce();
  });

  it("retains only bounded allowlisted metadata", () => {
    expect(safeTelemetry({
      requestId: "request-1", status: 429, token: "secret", cookie: "secret",
      source: "official_usage", providerBody: { sensitive: true }, outcome: "failed",
    })).toEqual({ requestId: "request-1", status: 429, source: "official_usage", outcome: "failed" });
  });

  it("retains the sharing field label without logging recipient identities or collections", () => {
    expect(safeTelemetry({
      field: "sharedWithUsersAndGroups", count: 2,
      resourceId: "private-user-id", sharedWithUsersAndGroups: [{ resourceId: "private-group-id", resourceType: "group" }],
    })).toEqual({ field: "sharedWithUsersAndGroups", count: 2 });
  });

  it("enforces numeric, boolean and finite diagnostic-label contracts", () => {
    for (const field of ["count", "queriedTypeCount", "page", "attempt", "schemaVersion", "length"]) {
      for (const value of ["private-value", true, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(safeTelemetry({ [field]: value })).toEqual({});
      }
    }
    for (const field of ["durationMs", "ageMs", "deadlineMs", "retryDelayMs"]) {
      for (const value of ["private-value", true, -1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(safeTelemetry({ [field]: value })).toEqual({});
      }
    }
    for (const field of ["hasContinuation", "resultTruncated", "environmentScoped"]) {
      for (const value of ["private-value", 0, 1]) expect(safeTelemetry({ [field]: value })).toEqual({});
    }
    for (const field of ["provider", "source", "stage", "mode", "outcome", "status", "reason", "field", "actualType", "resourceType", "capabilityId", "errorKind"]) {
      expect(safeTelemetry({ [field]: "private_provider_value" })).toEqual({});
    }
    for (const value of [99, 600, -1, 200.5, true]) expect(safeTelemetry({ status: value })).toEqual({});
    expect(safeTelemetry({
      status: "waiting_authorization", mode: "POST", source: "directory", actualType: "undefined",
      reason: "identity_too_long", durationMs: 0.5, count: Number.MAX_SAFE_INTEGER,
    })).toEqual({
      status: "waiting_authorization", mode: "POST", source: "directory", actualType: "undefined",
      reason: "identity_too_long", durationMs: 0.5, count: Number.MAX_SAFE_INTEGER,
    });
  });

  it("reads only bounded own data fields without evaluating getters or enumerating provider keys", () => {
    const getter = vi.fn(() => { throw new Error("private getter failure"); });
    const fields = Object.create({ jobId: "inherited-job" }, {
      count: { value: 2, enumerable: true },
      requestId: { get: getter, enumerable: true },
      token: { get: getter, enumerable: true },
      toJSON: { get: getter, enumerable: true },
    });
    const proxy = new Proxy(fields, { ownKeys: () => { throw new Error("private enumeration failure"); } });
    expect(safeTelemetry(fields)).toEqual({ count: 2 });
    expect(safeTelemetry(proxy)).toEqual({});
    expect(getter).not.toHaveBeenCalled();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(safeTelemetry(revoked.proxy)).toEqual({});
  });

  it("does not traverse repeated, cyclic, accessor or coercible metadata values", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const coerce = vi.fn(() => { throw new Error("private coercion failure"); });
    const value = { toJSON: coerce, toString: coerce };
    Object.assign(value, { self: value });
    operationalLog("info", "metadata_sample", {
      count: value, durationMs: value, requestId: value, token: value, jobId: value, page: 2,
    });
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: "metadata_sample", page: 2 });
    expect(coerce).not.toHaveBeenCalled();
  });

  it("contains serialization failures as well as sink failures without replacing business outcomes", async () => {
    const failure = new Error("original business failure");
    vi.spyOn(JSON, "stringify").mockImplementationOnce(() => { throw new Error("private serialization failure"); });
    await expect(withTelemetryContext({ requestId: "request-a" }, async () => {
      try { throw failure; }
      finally { operationalLog("error", "work_failed", { errorCode: "internal_error" }); }
    })).rejects.toBe(failure);
    vi.spyOn(Date.prototype, "toISOString").mockImplementationOnce(() => { throw new RangeError("invalid clock"); });
    expect(() => operationalLog("info", "work_succeeded")).not.toThrow();
  });

  it("preserves primitive boundary values while excluding unsafe or nonprimitive values", () => {
    expect(safeTelemetry({
      requestId: "a".repeat(128), count: 0, durationMs: 0.5, hasContinuation: false,
    })).toEqual({
      requestId: "a".repeat(128), count: 0, durationMs: 0.5, hasContinuation: false,
    });
    for (const value of [
      "a".repeat(129), "private\nvalue", "private\rvalue", "private\0value",
      Infinity, -Infinity, NaN, undefined, null, {}, [], 1n, Symbol("private"),
    ]) {
      expect(safeTelemetry({ requestId: value })).toEqual({});
    }
  });

  it("retains queried-type counts without allowing resource types or unbounded values", () => {
    expect(safeTelemetry({ queriedTypeCount: 2, queriedTypes: ["must-not-log"] }))
      .toEqual({ queriedTypeCount: 2 });
    for (const value of [Infinity, -Infinity, NaN, null, {}, [], "a".repeat(129), "private\nvalue"]) {
      expect(safeTelemetry({ queriedTypeCount: value })).toEqual({});
    }
  });

  it("retains package diagnostic counters and fixed retry sources without accepting provider values", () => {
    const fields = [
      "missingCount", "nullCount", "emptyCount", "nonemptyCount", "invalidCount",
      "matchingCount", "differingCount", "listOnlyCount", "detailOnlyCount", "bothMissingCount",
      "requestCount", "retryCount", "throttleCount", "requestDurationMs", "maxRequestDurationMs",
      "admissionWaitMs", "retryWaitMs", "readIntervalMs", "retryAfterMs",
    ];
    for (const field of fields) {
      expect(safeTelemetry({ [field]: 0 })).toEqual({ [field]: 0 });
      expect(safeTelemetry({ [field]: 30_000 })).toEqual({ [field]: 30_000 });
      for (const value of ["private-provider-value", -1, 0.5, Infinity, NaN, null, {}, [], true]) {
        expect(safeTelemetry({ [field]: value })).toEqual({});
      }
    }
    for (const source of ["retry_after", "fallback"]) {
      expect(safeTelemetry({ retryDelaySource: source })).toEqual({ retryDelaySource: source });
    }
    expect(safeTelemetry({ retryDelaySource: "private-provider-value", packageId: "private-id", definition: "private-body" })).toEqual({});
  });

  it("retains data-sync run correlation without relaxing metadata bounds", () => {
    const runId = "11111111-1111-1111-1111-111111111111";
    expect(safeTelemetry({ runId, token: "never-log" })).toEqual({ runId });
    for (const value of ["a".repeat(129), "run\nprivate", "run\rprivate", "run\0private", {}, null]) {
      expect(safeTelemetry({ runId: value })).toEqual({});
    }
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    operationalLog("error", "data_sync_worker_status_failed", { runId, errorCode: "internal_error", token: "never-log" });
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      timestamp: expect.any(String), level: "error", event: "data_sync_worker_status_failed",
      runId, errorCode: "internal_error",
    });
  });

  it("never serializes unknown sensitive fields", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    operationalLog("warn", "provider_throttled", { provider: "graph", token: "Bearer secret", count: 1 });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      timestamp: expect.any(String), level: "warn", event: "provider_throttled", provider: "graph", count: 1,
    });
    log.mockRestore();
  });

  it.each([
    ["info", "log"], ["warn", "warn"], ["error", "error"],
  ] as const)("writes %s entries to console.%s without accepting envelope overrides", (level, method) => {
    const log = vi.spyOn(console, method).mockImplementation(() => undefined);
    const event = "a".repeat(64);
    operationalLog(level, event, {
      timestamp: "private-timestamp", level: "private-level", event: "private-event", count: 0,
    });
    expect(log).toHaveBeenCalledOnce();
    const entry = JSON.parse(log.mock.calls[0][0]);
    expect(entry).toEqual({ timestamp: expect.any(String), level, event, count: 0 });
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  it("rejects invalid event names before emitting any log entry", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const event of [
      "", "Uppercase", "1event", "_event", "event-name", "event name",
      "event\n", "event\r", "event\0", "event\u2028", "a".repeat(65),
    ]) {
      expect(() => operationalLog("info", event)).toThrow("Telemetry event name is invalid.");
    }
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["info", "log"], ["warn", "warn"], ["error", "error"],
  ] as const)("does not propagate a %s log sink failure into application work", (level, method) => {
    const log = vi.spyOn(console, method).mockImplementation(() => { throw new Error("Synthetic sink failure."); });
    expect(() => operationalLog(level, "data_lifecycle_metrics", { stage: "export", rows: 10 })).not.toThrow();
    expect(log).toHaveBeenCalledOnce();
    expect(() => operationalLog(level, "invalid-event")).toThrow("Telemetry event name is invalid.");
  });

  it("never substitutes a native URL when the route template is unavailable or unsupported", () => {
    for (const path of [undefined, null, 42, ["/inventory/:id"], /^\/inventory\/(.+)$/]) {
      const request = {
        method: "GET", route: { path },
        originalUrl: "/inventory/private-id?token=private-token", baseUrl: "/private-mount",
      } as Request;
      expect(requestRouteTemplate(request)).toBe("unmatched");
    }
    expect(requestRouteTemplate({ originalUrl: "/private-id" } as Request)).toBe("unmatched");
    expect(requestRouteTemplate({ route: { path: "/inventory/:id" } } as Request)).toBe("/inventory/:id");
  });

  it("does not evaluate route-template or response-local accessors for HTTP evidence", () => {
    const getter = vi.fn(() => { throw new Error("private HTTP metadata getter"); });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const request = Object.defineProperty({ method: "GET" }, "route", { get: getter }) as Request;
    expect(requestRouteTemplate(request)).toBe("unmatched");
    expect(requestRouteTemplate({ route: Object.defineProperty({}, "path", { get: getter }) } as Request)).toBe("unmatched");
    const locals = Object.defineProperty({ requestId: "request-original" }, "jobId", { get: getter, enumerable: true });
    const response = Object.assign(new EventEmitter(), { statusCode: 200, locals }) as Response;
    httpTelemetry(request, response, vi.fn());
    locals.requestId = "request-mutated";
    response.emit("finish");
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ requestId: "request-original", route: "unmatched" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("logs denied requests with code-owned route templates, not native paths, bodies or headers", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = Object.assign(new EventEmitter(), {
      statusCode: 429,
      locals: { requestId: "request-throttled", jobId: "job-1", errorCode: "provider_throttled" },
    }) as unknown as Response;
    const request = {
      method: "POST",
      originalUrl: "/api/private?code=never-log",
      route: { path: "/inventory/refresh-jobs/:id" },
      headers: { authorization: "Bearer never-log", cookie: "never-log" },
      body: { reportRows: ["never-log"] },
    } as unknown as Request;
    const next=vi.fn();
    httpTelemetry(request,response,next);
    (response as unknown as EventEmitter).emit("finish");
    expect(next).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      event: "http_request", requestId: "request-throttled", status: 429, mode: "POST",
      route: "/inventory/refresh-jobs/:id", jobId: "job-1", errorCode: "provider_throttled",
    });
    expect(log.mock.calls[0][0]).not.toContain("never-log");
    log.mockRestore();
  });

  it.each([
    [200, "info"], [399, "info"], [400, "warn"], [499, "warn"], [500, "error"], [599, "error"],
  ] as const)("logs a completed %i response exactly once at %s severity", (statusCode, level) => {
    const logs = {
      info: vi.spyOn(console, "log").mockImplementation(() => undefined),
      warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
      error: vi.spyOn(console, "error").mockImplementation(() => undefined),
    };
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(142.6);
    const response = Object.assign(new EventEmitter(), {
      statusCode, locals: { requestId: "request-finished" },
    }) as Response;
    httpTelemetry({ method: "POST", route: { path: "/inventory/refresh-jobs" } } as Request, response, () => {
      response.locals.jobId = "job-created";
    });
    response.emit("finish");
    response.emit("close");
    expect(logs[level]).toHaveBeenCalledOnce();
    expect(Object.values(logs).flatMap(log => log.mock.calls)).toHaveLength(1);
    expect(JSON.parse(logs[level].mock.calls[0][0])).toEqual({
      timestamp: expect.any(String), level, event: "http_request", status: statusCode,
      requestId: "request-finished", jobId: "job-created", route: "/inventory/refresh-jobs",
      durationMs: 43, mode: "POST",
    });
  });

  it("keeps concurrent asynchronous request and job contexts isolated", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = withTelemetryContext({ requestId: "request-a", route: "/inventory/refresh-jobs" }, () =>
      withTelemetryContext({ jobId: "job-a" }, async () => {
        await held;
        operationalLog("info", "inventory_refresh_succeeded");
      }));
    await withTelemetryContext({ requestId: "request-b", jobId: "job-b" }, async () => {
      await Promise.resolve();
      operationalLog("info", "inventory_refresh_succeeded");
    });
    release();
    await first;
    operationalLog("info", "outside_request");
    const entries = log.mock.calls.map(([entry]) => JSON.parse(entry));
    expect(entries[0]).toMatchObject({ requestId: "request-b", jobId: "job-b" });
    expect(entries[0]).not.toHaveProperty("route");
    expect(entries[1]).toMatchObject({ requestId: "request-a", jobId: "job-a", route: "/inventory/refresh-jobs" });
    expect(entries[2]).not.toHaveProperty("requestId");
    expect(entries[2]).not.toHaveProperty("jobId");
  });

  it("snapshots context fields without running accessors and supports explicit context clearing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fields = { requestId: "request-original", jobId: "job-original" };
    const getter = vi.fn(() => { throw new Error("private context getter"); });
    await withTelemetryContext(fields, async () => {
      fields.jobId = "job-mutated";
      await Promise.resolve();
      operationalLog("info", "before_clear");
      withTelemetryContext(Object.defineProperty({ requestId: undefined, route: "/fixture" }, "jobId", { get: getter }), () => {
        operationalLog("info", "cleared_context");
      });
      operationalLog("info", "restored_context");
    });
    const entries = log.mock.calls.map(([entry]) => JSON.parse(entry));
    expect(entries[0]).toMatchObject({ requestId: "request-original", jobId: "job-original" });
    expect(entries[1]).toMatchObject({ route: "/fixture" });
    expect(entries[1]).not.toHaveProperty("requestId");
    expect(entries[1]).not.toHaveProperty("jobId");
    expect(entries[2]).toMatchObject({ requestId: "request-original", jobId: "job-original" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not resurrect inherited correlation when an explicit log field is cleared or rejected", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    withTelemetryContext({ requestId: "request-parent", jobId: "job-parent", route: "/parent" }, () => {
      operationalLog("info", "uncorrelated_sample", {
        requestId: undefined, jobId: "private@example.invalid", route: "/private?token=never-log",
      });
    });
    const entry = JSON.parse(log.mock.calls[0][0]);
    expect(entry).not.toHaveProperty("requestId");
    expect(entry).not.toHaveProperty("jobId");
    expect(entry).not.toHaveProperty("route");
  });

  it("binds HTTP terminal events to their request rather than the emitter's context", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200, locals: { requestId: "request-a" },
    }) as Response;
    withTelemetryContext({ requestId: "request-parent", jobId: "job-parent", route: "/parent" }, () => {
      httpTelemetry({ method: "GET", route: { path: "/fixture" } } as Request, response, () => {
        operationalLog("info", "inside_request");
      });
    });
    withTelemetryContext({ requestId: "request-b", jobId: "job-b" }, () => response.emit("finish"));
    const entries = log.mock.calls.map(([entry]) => JSON.parse(entry));
    expect(entries[0]).toMatchObject({ requestId: "request-a" });
    expect(entries[0]).not.toHaveProperty("route");
    expect(entries[0]).not.toHaveProperty("jobId");
    expect(entries[1]).toMatchObject({ requestId: "request-a", route: "/fixture" });
    expect(entries[1]).not.toHaveProperty("jobId");
    expect(response.listenerCount("close")).toBe(0);
  });

  it("settles an aborted response only once even if a late finish follows", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200, locals: { requestId: "request-a" },
    }) as Response;
    httpTelemetry({ method: "GET", route: { path: "/fixture" } } as Request, response, vi.fn());
    response.emit("close");
    response.emit("finish");
    expect(warn).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    expect(response.listenerCount("finish")).toBe(0);
  });

  it("recognizes a fully written close and releases both terminal listeners", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200, writableFinished: true, locals: { requestId: "request-finished" },
    }) as Response;
    httpTelemetry({ method: "GET", route: { path: "/fixture" } } as Request, response, vi.fn());
    response.emit("close");
    response.emit("finish");
    expect(log).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });

  it.each([false, true])("settles response errors without handling them or accepting a late finish (handled: %s)", handled => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200, writableFinished: false, locals: { requestId: "request-error", jobId: "job-running" },
    }) as Response;
    const failure = new Error("private response failure");
    const listener = vi.fn();
    if (handled) response.on("error", listener);
    httpTelemetry({ method: "GET", route: { path: "/fixture" } } as Request, response, vi.fn());
    withTelemetryContext({ requestId: "other-request", jobId: "other-job" }, () => {
      if (handled) expect(() => response.emit("error", failure)).not.toThrow();
      else expect(() => response.emit("error", failure)).toThrow(failure);
    });
    expect(warn).toHaveBeenCalledOnce();
    response.emit("finish");
    response.emit("close");
    expect(warn).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({
      event: "http_request_aborted", requestId: "request-error", jobId: "job-running", route: "/fixture",
    });
    expect(warn.mock.calls[0][0]).not.toContain("private response failure");
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(response.listenerCount(errorMonitor)).toBe(0);
    expect(listener).toHaveBeenCalledTimes(handled ? 1 : 0);
    expect(response.listenerCount("error")).toBe(handled ? 1 : 0);
  });

  it("classifies only numeric HTTP statuses without coercing diagnostic values", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const coerce = vi.fn(() => { throw new Error("private status coercion"); });
    for (const statusCode of ["503", "failed", true, { [Symbol.toPrimitive]: coerce }]) {
      const response = Object.assign(new EventEmitter(), { statusCode, locals: {} }) as unknown as Response;
      httpTelemetry({ method: "GET", route: { path: "/fixture" } } as Request, response, vi.fn());
      expect(() => response.emit("finish")).not.toThrow();
    }
    expect(log).toHaveBeenCalledTimes(4);
    for (const [entry] of log.mock.calls) {
      expect(JSON.parse(entry)).toMatchObject({ event: "http_request", level: "info" });
      expect(JSON.parse(entry)).not.toHaveProperty("status");
    }
    expect(coerce).not.toHaveBeenCalled();
  });

  it.each(["finish", "close"] as const)("contains terminal %s clock failures and releases telemetry listeners", terminal => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = Object.assign(new EventEmitter(), { statusCode: 200, locals: {} }) as Response;
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(100)
      .mockImplementation(() => { throw new Error("private clock failure"); });
    httpTelemetry({ method: "GET", route: { path: "/fixture" } } as Request, response, vi.fn());
    expect(() => response.emit(terminal)).not.toThrow();
    clock.mockRestore();
    response.emit("finish");
    response.emit("close");
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(response.listenerCount(errorMonitor)).toBe(0);
    expect([...log.mock.calls, ...warn.mock.calls]).toHaveLength(0);
  });

  it.each([false, true])("does not let initial response-locals accessors or clock failure stop the request (clock failed: %s)", clockFailed => {
    const getter = vi.fn(() => { throw new Error("private response locals"); });
    const response = Object.defineProperty(Object.assign(new EventEmitter(), { statusCode: 200 }), "locals", {
      get: getter,
    }) as Response;
    const request = { method: "GET", route: { path: "/fixture" } } as Request;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const clock = vi.spyOn(performance, "now").mockImplementation(() => {
      if (clockFailed) throw new Error("private clock failure");
      return 100;
    });
    const next = vi.fn();
    expect(() => httpTelemetry(request, response, next)).not.toThrow();
    expect(next).toHaveBeenCalledOnce();
    clock.mockRestore();
    expect(() => response.emit("finish")).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(clockFailed ? 0 : 1);
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(response.listenerCount(errorMonitor)).toBe(0);
  });

  it("keeps completed response errors unhandled without relogging or retaining the monitor", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = Object.assign(new EventEmitter(), { statusCode: 200, locals: {} }) as Response;
    httpTelemetry({ method: "GET", route: { path: "/fixture" } } as Request, response, vi.fn());
    response.emit("finish");
    const failure = new Error("private late transport error");
    expect(() => response.emit("error", failure)).toThrow(failure);
    expect(log).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    expect(response.listenerCount(errorMonitor)).toBe(0);
  });

  it("restores the parent context after synchronous throws and asynchronous rejection", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const failure = new Error("expected failure");
    await withTelemetryContext({ requestId: "request-parent", route: "/inventory/refresh-jobs" }, async () => {
      expect(() => withTelemetryContext({ requestId: "request-child", jobId: "job-sync" }, () => {
        throw failure;
      })).toThrow(failure);
      operationalLog("info", "after_sync_failure");
      await expect(withTelemetryContext({ requestId: "request-child", jobId: "job-async" }, async () => {
        await Promise.resolve();
        throw failure;
      })).rejects.toBe(failure);
      operationalLog("info", "after_async_failure");
    });
    operationalLog("info", "outside_request");
    const entries = log.mock.calls.map(([entry]) => JSON.parse(entry));
    expect(entries).toHaveLength(3);
    for (const entry of entries.slice(0, 2)) {
      expect(entry).toMatchObject({ requestId: "request-parent", route: "/inventory/refresh-jobs" });
      expect(entry).not.toHaveProperty("jobId");
    }
    expect(entries[2]).not.toHaveProperty("requestId");
    expect(entries[2]).not.toHaveProperty("jobId");
    expect(entries[2]).not.toHaveProperty("route");
  });

  it("reports incomplete HTTP responses without claiming the background job was cancelled", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200, locals: { requestId: "request-a", jobId: "job-a" },
    }) as unknown as Response;
    httpTelemetry({ method: "POST", route: { path: "/inventory/refresh-jobs" } } as Request, response, vi.fn());
    (response as unknown as EventEmitter).emit("close");
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      event: "http_request_aborted", requestId: "request-a", jobId: "job-a", route: "/inventory/refresh-jobs",
    });
    expect(JSON.parse(log.mock.calls[0][0])).not.toHaveProperty("status");
  });

  it("retains safe diagnostics but never arbitrary provider headers, URLs or error objects", () => {
    expect(safeTelemetry({
      page: 2, resourceIndex: 7, field: "name", length: 513, maximumLength: 512,
      providerRequestId: "11111111-1111-1111-1111-111111111111",
      providerCorrelationId: "private-provider-header", errorCode: "private error text",
      route: "/api/private?token=private-token", rawError: new Error("private-error"),
      tenantId: "private-tenant", nativeId: "private-native-id", skipToken: "private-continuation",
    })).toEqual({
      page: 2, resourceIndex: 7, field: "name", length: 513, maximumLength: 512,
      providerRequestId: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("keeps every managed log-alert event aligned with a real redacted producer", () => {
    const root=existsSync(join(process.cwd(),"infra","main.bicep")) ? process.cwd() : join(process.cwd(),"..");
    const bicep=readFileSync(join(root,"infra","main.bicep"),"utf8");
    const producers: Record<string,string> = {
      listening: "backend/src/server.ts",
      provider_throttled: "backend/src/errors.ts",
      provider_schema_omission: "backend/src/services/packageObservation.ts",
      request_error: "backend/src/errors.ts",
      job_execution_stopped: "backend/src/services/bulkJobs.ts",
      quarantine_job_stopped: "backend/src/services/copilotStudioQuarantineJobs.ts",
      job_write_uncertain: "backend/src/services/bulkJobs.ts",
      quarantine_write_uncertain: "backend/src/services/copilotStudioQuarantineJobs.ts",
      official_usage_upload_cleanup_failed: "backend/src/routes/officialReportMultipart.ts",
      database_pool_error: "backend/src/db/pool.ts",
      database_pool_saturated: "backend/src/services/telemetry.ts",
      session_store_error: "backend/src/db/sessions.ts",
    };
    expect(bicep.match(/parse_json\(ResultDescription\)\.event/g)).toHaveLength(3);
    expect(bicep).not.toMatch(/ResultDescription\s+has(?:_any|_cs)?/);
    for (const [event,filename] of Object.entries(producers)) {
      expect(bicep,`${event} is not filtered by a managed alert`).toContain(`"${event}"`);
      expect(readFileSync(join(root,filename),"utf8"),`${event} has no runtime producer`).toContain(`"${event}"`);
    }
    for (const event of ["database_pool_error", "session_store_error"]) {
      expect(readFileSync(join(root, producers[event]), "utf8"))
        .toContain(`operationalLog("error", "${event}")`);
    }
  });

  it("emits structured database errors without connection or exception details", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    pool.emit("error", new Error("never-log-connection-details"));
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      timestamp: expect.any(String), level: "error", event: "database_pool_error",
    });
  });

  it("emits the pool-pressure observation only when the finite pool has waiters", () => {
    const log=vi.spyOn(console,"error").mockImplementation(() => undefined);
    observeDatabasePool(0);
    observeDatabasePool(2);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ timestamp: expect.any(String), level: "error", event: "database_pool_saturated", count: 2 });
    log.mockRestore();
  });
});
