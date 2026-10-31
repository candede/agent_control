import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { Request, RequestHandler, Response } from "express";
import session from "express-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { account, browserSession, epochAuthority, oboFetcher, tenant, verifiedBearer } from "../auth/authFoundationTestSupport.js";
import { createBearerCredentials, createBrowserCredentials } from "../auth/delegatedCredentials.js";
import { browserRequestPrincipal } from "../auth/requestPrincipal.js";
import { activateAccountSession, clearAccountSessionMutationsForTest, revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { AuditEvent } from "../types/audit.js";
import { unknownOrigin } from "../types/actionOrigin.js";
import type { RoutePolicy } from "./policy.js";
import "./audit.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, { handler: RequestHandler; policy: RoutePolicy }>(),
  audit: { listEvents: vi.fn(), countEvents: vi.fn() },
}));

vi.mock("../db/pool.js", () => ({ pool: {}, secretValue: vi.fn() }));
vi.mock("../services/auditLog.js", () => ({ getAuditLog: () => mocks.audit }));
vi.mock("./policy.js", () => ({
  policyRoute: (_router: unknown, method: string, path: string, policy: RoutePolicy, ...handlers: RequestHandler[]) => {
    mocks.handlers.set(`${method} ${path}`, { handler: handlers[handlers.length - 1], policy });
  },
}));

const originalTenants = config.tenants;
const selected = account();
const event: AuditEvent = {
  id: "event-1", operationId: "operation-1", scope: "single", action: "block", targetBlockedState: true,
  agentId: "agent-1", actor: { tenantId: tenant.tenantId, homeAccountId: selected.homeAccountId,
    username: selected.username, displayName: "Synthetic Admin" },
  startedAt: "2026-10-30T00:00:00.000Z", status: "succeeded", requestPath: "/api/agents/block", origin: unknownOrigin,
};
const sockets: Socket[] = [];

beforeEach(async () => {
  config.tenants = [tenant];
  clearAccountSessionMutationsForTest();
  vi.resetAllMocks();
  mocks.audit.listEvents.mockResolvedValue([event]);
  mocks.audit.countEvents.mockResolvedValue(1);
  await activateAccountSession(tenant.tenantId, selected.homeAccountId, async () => undefined);
});

afterEach(() => {
  sockets.forEach(socket => socket.destroy());
  sockets.length = 0;
  config.tenants = originalTenants;
  clearAccountSessionMutationsForTest();
});

async function transport(kind: "standalone" | "browser" | "bearer" = "standalone") {
  const socket = new Socket();
  sockets.push(socket);
  const request = new IncomingMessage(socket) as Request;
  Object.defineProperty(request, "query", { value: { agentId: event.agentId, limit: "25" } });
  const data = browserSession(selected);
  data.user!.roles = ["AgentControl.Admin"];
  request.session = new session.Session(request, data);
  request.sessionID = "synthetic-audit-session";
  if (kind === "browser") {
    request.authentication = createBrowserCredentials(await browserRequestPrincipal(data, null, epochAuthority()), epochAuthority());
  } else if (kind === "bearer") {
    request.authentication = await createBearerCredentials(await verifiedBearer({ roles: ["AgentControl.Admin"] }),
      epochAuthority(), { fetcher: oboFetcher() });
  }
  const response = Object.assign(new ServerResponse(request), { json: vi.fn() }) as Response;
  const next = vi.fn();
  const run = () => mocks.handlers.get("get /audit/events")!.handler(request, response, next);
  return { request, response, next, run };
}

describe("administrative audit JSON publication", () => {
  it("declares Admin-only reads and browser-only CSRF-protected exports", () => {
    expect(mocks.handlers.get("get /audit/events")?.policy).toMatchObject({
      access: "authenticated", roles: ["AgentControl.Admin"], dataClass: "local_audit",
    });
    expect(mocks.handlers.get("post /audit/events/export.csv")?.policy).toMatchObject({
      access: "authenticated", roles: ["AgentControl.Admin"], browserOnly: true, csrf: true,
    });
  });

  it.each(["standalone", "browser", "bearer"] as const)("publishes saved rows for a current %s Admin", async kind => {
    const { response, next, run } = await transport(kind);
    await run();
    expect(response.json).toHaveBeenCalledExactlyOnceWith({ value: [event], count: 1 });
    expect(mocks.audit.listEvents).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentId: event.agentId, limit: 25 }));
    expect(mocks.audit.countEvents).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentId: event.agentId, limit: 25 }));
    expect(next).not.toHaveBeenCalled();
  });

  it.each(["standalone", "browser", "bearer"] as const)("allows a current %s Admin after the in-memory account cache is cleared", async kind => {
    clearAccountSessionMutationsForTest();
    const { response, next, run } = await transport(kind);
    await run();
    expect(response.json).toHaveBeenCalledExactlyOnceWith({ value: [event], count: 1 });
    expect(next).not.toHaveBeenCalled();
  });

  it.each(["listEvents", "countEvents"] as const)("forwards a failed %s read without publishing rows", async phase => {
    const { response, next, run } = await transport();
    const failure = new Error("Synthetic saved audit read failure");
    mocks.audit[phase].mockRejectedValueOnce(failure);
    await run();
    expect(next).toHaveBeenCalledExactlyOnceWith(failure);
    expect(response.json).not.toHaveBeenCalled();
  });

  it.each(["listEvents", "countEvents"] as const)("withholds JSON after logout during %s", async phase => {
    const { response, next, run } = await transport();
    mocks.audit[phase].mockImplementationOnce(async () => {
      await revokeAccountSessionMutations(tenant.tenantId, selected.homeAccountId, async () => undefined);
      return phase === "listEvents" ? [event] : 1;
    });
    await run();
    expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401, code: "unauthorized" }));
    expect(response.json).not.toHaveBeenCalled();
  });

  it.each(["superseding login", "role removal", "scope replacement"] as const)("withholds JSON after %s during the count read", async change => {
    const { request, response, next, run } = await transport();
    mocks.audit.countEvents.mockImplementationOnce(async () => {
      if (change === "superseding login") {
        await activateAccountSession(tenant.tenantId, selected.homeAccountId, async () => undefined);
      } else if (change === "role removal") {
        request.session.user!.roles = ["AgentControl.Viewer"];
      } else {
        request.session.accountId = "another-account";
        request.session.user!.homeAccountId = "another-account";
      }
      return 1;
    });
    await run();
    expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401, code: "unauthorized" }));
    expect(response.json).not.toHaveBeenCalled();
  });

  it.each(["browser", "bearer"] as const)("withholds JSON after the initiating %s credential is revoked", async kind => {
    const { request, response, next, run } = await transport(kind);
    mocks.audit.countEvents.mockImplementationOnce(async () => {
      request.authentication!.revoke();
      return 1;
    });
    await run();
    expect(next).toHaveBeenCalledExactlyOnceWith(expect.any(AppError));
    expect(response.json).not.toHaveBeenCalled();
  });
});
