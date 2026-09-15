import express from "express";
import session from "express-session";
import { request as httpRequest, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { config } from "../config.js";
import { errorHandler } from "../errors.js";
import { createCopilotUsageRouter } from "./copilotUsage.js";
import { declaredRoutePolicies } from "./policy.js";

vi.hoisted(() => {
  process.env.TENANT_ID = "11111111-1111-1111-1111-111111111111";
  process.env.CLIENT_ID = "22222222-2222-4222-8222-222222222222";
  process.env.SESSION_SECRET = "copilot-usage-route-test-session-secret";
});

describe("Copilot usage route policy", () => {
  it("is read-only and requires the Viewer role (with Admin inheritance handled by shared auth)", () => {
    createCopilotUsageRouter({} as pg.Pool, { users: async () => { throw new Error("not called"); } } as never);
    expect(declaredRoutePolicies.get("GET /copilot-usage/users")).toEqual({
      access: "authenticated",
      dataClass: "licensed_copilot_usage",
      roles: ["AgentControl.Viewer"],
    });
    expect([...declaredRoutePolicies.keys()]).not.toContain("POST /copilot-usage/users");
  });

  it("denies unassigned users and permits Viewer and inherited Admin", async () => {
    const service = { users: async () => ({ ok: true }) };
    const app = authorizedApp();
    app.use("/api", createCopilotUsageRouter({} as pg.Pool, service as never));
    app.use(errorHandler);
    const server = await listen(app);
    try {
      expect((await get(server, undefined)).status).toBe(403);
      expect(await get(server, "viewer")).toMatchObject({ status: 200, cacheControl: "no-store" });
      expect((await get(server, "admin")).status).toBe(200);
      expect((await get(server, "viewer", "?search=typing")).status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("cancels provider work when a completed GET connection is closed", async () => {
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const aborted = new Promise<void>(resolve => { markAborted = resolve; });
    const app = authorizedApp();
    app.use("/api", createCopilotUsageRouter({} as pg.Pool, {
      users: async (_user, signal) => new Promise<never>((_resolve, reject) => {
        signal!.addEventListener("abort", () => {
          markAborted();
          reject(signal!.reason);
        }, { once: true });
        markStarted();
      }),
    }));
    app.use(errorHandler);
    const server = await listen(app);
    const port = (server.address() as { port: number }).port;
    const request = httpRequest({ host: "127.0.0.1", port, path: "/api/copilot-usage/users", headers: { "x-test-role": "viewer" } });
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") throw error;
    });
    request.end();
    try {
      await started;
      request.destroy();
      await aborted;
    } finally {
      request.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

function authorizedApp() {
  const app = express();
  app.use(session({ secret: "copilot-usage-route-test-session-secret", resave: false, saveUninitialized: false }));
  app.use((request, _response, next) => {
    const supplied = request.get("x-test-role");
    request.session.accountId = "principal";
    request.session.tenantId = config.tenantId!;
    request.session.rolesValidatedAt = Date.now();
    request.session.user = {
      tenantId: config.tenantId!, homeAccountId: "principal", username: "principal@example.com",
      displayName: "Principal",
      roles: supplied === "viewer" ? ["AgentControl.Viewer"] : supplied === "admin" ? ["AgentControl.Admin"] : [],
    };
    next();
  });
  return app;
}

function listen(app: express.Express) {
  return new Promise<Server>(resolve => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function get(server: Server, role: string | undefined, query = "") {
  const port = (server.address() as { port: number }).port;
  return new Promise<{ status: number; body: string; cacheControl?: string }>((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: `/api/copilot-usage/users${query}`,
      headers: role ? { "x-test-role": role } : {},
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body, cacheControl: response.headers["cache-control"] }));
    });
    request.on("error", reject);
    request.end();
  });
}
