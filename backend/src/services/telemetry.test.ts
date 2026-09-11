import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { httpTelemetry, observeDatabasePool, operationalLog, safeTelemetry } from "./telemetry.js";

describe("operational telemetry", () => {
  it("retains only bounded allowlisted metadata", () => {
    expect(safeTelemetry({
      requestId: "request-1", status: 429, token: "secret", cookie: "secret",
      source: "official_usage", providerBody: { sensitive: true }, outcome: "failed",
    })).toEqual({ requestId: "request-1", status: 429, source: "official_usage", outcome: "failed" });
  });

  it("never serializes unknown sensitive fields", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    operationalLog("warn", "provider_throttled", { provider: "graph", token: "Bearer secret", count: 1 });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toBe('{"event":"provider_throttled","provider":"graph","count":1}');
    log.mockRestore();
  });

  it("logs denied throttled requests without paths, bodies or headers", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = Object.assign(new EventEmitter(), {
      statusCode: 429,
      locals: { requestId: "request-throttled" },
    }) as unknown as Response;
    const request = {
      method: "POST",
      originalUrl: "/api/private?code=never-log",
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
    });
    expect(log.mock.calls[0][0]).not.toContain("never-log");
    log.mockRestore();
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
  });

  it("emits the pool-pressure observation only when the finite pool has waiters", () => {
    const log=vi.spyOn(console,"error").mockImplementation(() => undefined);
    observeDatabasePool(0);
    observeDatabasePool(2);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ event: "database_pool_saturated", count: 2 });
    log.mockRestore();
  });
});
