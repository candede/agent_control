import express from "express";
import session from "express-session";
import { request as httpRequest, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { AppError, errorHandler } from "../errors.js";
import { AuditLog } from "../services/auditLog.js";
import type { AppRole } from "../types/capability.js";
import { auditRouter, parseAuditEventsQuery } from "./audit.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{
    tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
    clientSecret: "synthetic-audit-route-secret", domains: ["example.invalid"],
  }]);
});
vi.mock("../db/pool.js", () => ({ pool: {}, secretValue: (name: string) => process.env[name] }));

describe("local audit routes", () => {
  it("parses valid audit event filters", () => {
    expect(
      parseAuditEventsQuery({
        limit: "25",
        offset: "50",
        agentId: "agent-1",
        actorUsername: "admin@example.com",
        scope: "bulk",
        action: "block",
        status: "failed",
        operationIdPrefix: "a5331a93",
        search: "Research Agent",
      }),
    ).toEqual({
      limit: 25,
      offset: 50,
      agentId: "agent-1",
      actorUsername: "admin@example.com",
      scope: "bulk",
      action: "block",
      status: "failed",
      operationIdPrefix: "a5331a93",
      search: "Research Agent",
    });
  });

  describe("administrative audit authorization", () => {
    let server: Server;
    let roles: AppRole[] = [];

    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      app.use(session({ secret: config.sessionSecret, resave: false, saveUninitialized: false }));
      app.use((request, _response, next) => {
        request.session.accountId = "audit-reader";
        request.session.tenantId = config.tenants[0].tenantId;
        request.session.clientId = config.tenants[0].clientId;
        request.session.rolesValidatedAt = Date.now();
        request.session.csrfToken = "fixture-csrf";
        request.session.user = { tenantId: config.tenants[0].tenantId, homeAccountId: "audit-reader",
          username: "reader@example.invalid", displayName: "Reader", roles };
        next();
      });
      app.use("/api", auditRouter);
      app.use(errorHandler);
      server = await new Promise<Server>(resolve => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
      });
    });

    beforeEach(() => {
      roles = [];
      vi.spyOn(AuditLog.prototype, "listEvents").mockResolvedValue([]);
      vi.spyOn(AuditLog.prototype, "countEvents").mockResolvedValue(0);
      vi.spyOn(AuditLog.prototype, "startEvent").mockRejectedValue(new Error("Unexpected audit write"));
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    function request(method: "GET" | "POST", path: string, csrf = true):
      Promise<{ status: number; body: Record<string, unknown> }> {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing audit fixture address");
      return new Promise((resolve, reject) => {
        const message = httpRequest({ host: "127.0.0.1", port: address.port, method, path: `/api${path}`,
          headers: csrf ? { "x-csrf-token": "fixture-csrf" } : {},
        }, response => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { text += chunk; });
          response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
        });
        message.once("error", reject);
        message.end();
      });
    }

    it.each(["AgentControl.Viewer", "AgentControl.UsageReportUploader"] as const)(
      "denies reads and exports to %s before accessing audit data", async role => {
        roles = [role];
        for (const [method, path] of [["GET", "/audit/events"], ["POST", "/audit/events/export.csv"]] as const) {
          const response = await request(method, path);
          expect(response.status).toBe(403);
          expect(response.body.code).toBe("missing_internal_role");
        }
        expect(AuditLog.prototype.listEvents).not.toHaveBeenCalled();
        expect(AuditLog.prototype.countEvents).not.toHaveBeenCalled();
        expect(AuditLog.prototype.startEvent).not.toHaveBeenCalled();
      },
    );

    it("allows Admin to read saved audit events without provider access", async () => {
      roles = ["AgentControl.Admin"];
      expect(await request("GET", "/audit/events")).toEqual({ status: 200, body: { value: [], count: 0 } });
      expect(AuditLog.prototype.listEvents).toHaveBeenCalledOnce();
      expect(AuditLog.prototype.countEvents).toHaveBeenCalledOnce();
    });

    it("retains CSRF and exact-selection validation for Admin exports", async () => {
      roles = ["AgentControl.Admin"];
      expect(await request("POST", "/audit/events/export.csv", false)).toMatchObject({
        status: 403, body: { code: "invalid_csrf" },
      });
      expect(await request("POST", "/audit/events/export.csv")).toMatchObject({
        status: 400, body: { code: "invalid_export_selection" },
      });
      expect(AuditLog.prototype.startEvent).not.toHaveBeenCalled();
    });
  });

  it.each([
    "requested", "started", "succeeded", "failed", "skipped", "inconclusive", "cancelled",
  ])("accepts the persisted %s audit status", status => {
    expect(parseAuditEventsQuery({ status })).toMatchObject({ status });
  });

  it("rejects malformed limits", () => {
    expect(() => parseAuditEventsQuery({ limit: "10abc" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ limit: "-1" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ limit: "0" })).toThrow(AppError);
  });

  it("rejects malformed offsets", () => {
    expect(() => parseAuditEventsQuery({ offset: "10abc" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ offset: "-1" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ offset: "100001" })).toThrow(AppError);
    expect(parseAuditEventsQuery({ offset: "100000" }).offset).toBe(100000);
  });

  it("rejects unsupported actions, statuses, and scopes", () => {
    expect(() => parseAuditEventsQuery({ action: "delete" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ status: "done" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ scope: "team" })).toThrow(AppError);
  });

  it("rejects invalid operation id prefixes", () => {
    expect(() =>
      parseAuditEventsQuery({ operationIdPrefix: "a5331a93%" }),
    ).toThrow(AppError);
  });

  it("accepts the same literal operation prefix grammar as inventory reference filters", () => {
    expect(parseAuditEventsQuery({ operationIdPrefix: " REF_CASE-1 " }).operationIdPrefix).toBe("REF_CASE-1");
  });

  it("rejects overlong search values", () => {
    expect(parseAuditEventsQuery({ search: "a".repeat(200) }).search).toHaveLength(200);
    expect(() => parseAuditEventsQuery({ search: "a".repeat(201) })).toThrow(
      AppError,
    );
  });
});
