import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pool } from "../db/pool.js";
import { httpTelemetry, observeDatabasePool, operationalLog, safeTelemetry, withTelemetryContext } from "./telemetry.js";

afterEach(() => vi.restoreAllMocks());

describe("operational telemetry", () => {
  it("retains only bounded allowlisted metadata", () => {
    expect(safeTelemetry({
      requestId: "request-1", status: 429, token: "secret", cookie: "secret",
      source: "official_usage", providerBody: { sensitive: true }, outcome: "failed",
    })).toEqual({ requestId: "request-1", status: 429, source: "official_usage", outcome: "failed" });
  });

  it("retains queried-type counts without allowing resource types or unbounded values", () => {
    expect(safeTelemetry({ queriedTypeCount: 2, queriedTypes: ["must-not-log"] }))
      .toEqual({ queriedTypeCount: 2 });
    for (const value of [Infinity, -Infinity, NaN, null, {}, [], "a".repeat(129), "private\nvalue"]) {
      expect(safeTelemetry({ queriedTypeCount: value })).toEqual({});
    }
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
      official_usage_upload_cleanup_failed: "backend/src/routes/officialUsage.ts",
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
