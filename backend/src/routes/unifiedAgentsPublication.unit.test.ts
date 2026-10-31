import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { response as expressResponse, type Request, type RequestHandler, type Response } from "express";
import session from "express-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { withAuthority } from "../auth/authorityContext.js";
import { account, browserSession, epochAuthority, oboFetcher, tenant, verifiedBearer } from "../auth/authFoundationTestSupport.js";
import { createBearerCredentials, createBrowserCredentials } from "../auth/delegatedCredentials.js";
import { browserRequestPrincipal } from "../auth/requestPrincipal.js";
import { activateAccountSession, clearAccountSessionMutationsForTest, revokeAccountSessionMutations } from "../db/sessions.js";
import { LiveInventory } from "../db/liveInventory.js";
import { requestScope } from "../middleware/auth.js";
import { capabilities } from "../services/capabilities.js";
import * as operationalState from "../services/operationalState.js";
import type { PurviewAuditService } from "../services/purviewAudit.js";
import type { AgentInvestigationContext, AgentPurviewRecordPage } from "../types/agentInvestigations.js";
import type { RoutePolicy } from "./policy.js";
import { createUnifiedAgentsRouter } from "./unifiedAgents.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, { handler: RequestHandler; policy: RoutePolicy }>(),
  context: vi.fn(), identity: vi.fn(), purview: vi.fn(), labels: vi.fn(),
  generation: vi.fn(), resolvePeople: vi.fn(), startEvent: vi.fn(), completeEvent: vi.fn(),
  query: vi.fn(),
}));
vi.mock("../db/pool.js", () => ({ pool: { query: mocks.query }, secretValue: vi.fn() }));
vi.mock("./policy.js", () => ({
  policyRoute: (_router: unknown, method: string, path: string, policy: RoutePolicy, handler: RequestHandler) => {
    mocks.handlers.set(`${method} ${path}`, { handler, policy });
  },
}));
vi.mock("../services/auditLog.js", () => ({
  AuditLog: class { startEvent = mocks.startEvent; completeEvent = mocks.completeEvent; },
}));

const originalTenants = config.tenants;
const selected = account();
const recordId = "agent:55555555-5555-4555-8555-555555555555";
const objectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const context: AgentInvestigationContext = {
  recordId, displayName: "Saved agent",
  defender: { status: "unavailable", entraAgentIds: [] },
  purview: { status: "available", mode: "search", presets: ["copilot_studio_admin"] },
};
const savedPurview: AgentPurviewRecordPage = {
  recordId, mode: "saved_only", count: 0, limit: 50, offset: 0, value: [],
};
const person = { objectId, displayName: "Saved owner", userPrincipalName: null, observedAt: "2026-10-30T00:00:00Z" };
const results = {
  context: { context, inventoryRevision: "saved-revision" }, identity: context, purview: savedPurview,
  labels: new Map([[objectId, person]]),
};
const routes = [
  { route: "get /agent-inventory/investigations/context", phase: "context", result: context },
  { route: "post /agent-inventory/investigations/resolve", phase: "identity", result: context },
  { route: "get /agent-inventory/investigations/purview", phase: "purview", result: savedPurview },
  { route: "post /agent-inventory/people/resolve", phase: "labels", result: { people: { owner: person }, changed: true } },
] satisfies { route: string; phase: keyof typeof results; result: unknown }[];
const sockets: Socket[] = [];

beforeEach(() => {
  config.tenants = [tenant];
  clearAccountSessionMutationsForTest();
  vi.resetAllMocks();
  mocks.query.mockRejectedValue(new Error("Unexpected database request"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected application/provider request")));
  vi.spyOn(capabilities, "beginOperationValidation").mockReturnValue(() => undefined);
  vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => undefined);
  mocks.context.mockResolvedValue(results.context);
  mocks.identity.mockResolvedValue(results.identity);
  mocks.purview.mockImplementation(async (...parameters: Parameters<PurviewAuditService["agentRecords"]>) => {
    await parameters[4]?.(savedPurview);
    return savedPurview;
  });
  mocks.labels.mockResolvedValue(results.labels);
  mocks.generation.mockResolvedValue({ sessionEpoch: "1", scopeEpoch: "0", scopeId: "saved-scope" });
  mocks.resolvePeople.mockResolvedValue({ changed: true, resolved: 1, notFound: 0, failed: 0 });
  mocks.startEvent.mockResolvedValue({ id: "saved-audit-event" });
  mocks.completeEvent.mockResolvedValue(undefined);
  const inventory = new LiveInventory();
  vi.spyOn(inventory, "record").mockResolvedValue({
    id: recordId, revision: "saved-revision", displayName: "Saved agent", environmentId: null,
    identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
    people: { owner: objectId }, native: null,
  });
  vi.spyOn(inventory, "assertCurrent").mockResolvedValue();
  createUnifiedAgentsRouter(undefined, {
    inventory, investigations: { resolve: mocks.context }, identities: { resolve: mocks.identity },
    purview: { agentRecords: mocks.purview }, savedPeople: { read: mocks.labels },
    people: { generation: mocks.generation, resolve: mocks.resolvePeople },
  });
});

afterEach(() => {
  try {
    expect(mocks.query).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    sockets.forEach(socket => socket.destroy());
    sockets.length = 0;
    config.tenants = originalTenants;
    clearAccountSessionMutationsForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

async function transport(spec: typeof routes[number], kind: "standalone" | "browser" | "bearer" = "standalone") {
  const socket = new Socket();
  sockets.push(socket);
  const request = new IncomingMessage(socket) as Request;
  Object.defineProperty(request, "query", { value: spec.route.startsWith("get ") ? { recordId } : {} });
  request.body = { recordId };
  request.get = vi.fn();
  request.sessionID = "synthetic-unified-agent-session";
  const data = browserSession(selected);
  new session.MemoryStore().createSession(request, data);
  if (kind === "browser") {
    const epochs = epochAuthority();
    request.authentication = createBrowserCredentials(await browserRequestPrincipal(data, null, epochs), epochs);
  } else if (kind === "bearer") {
    request.authentication = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: oboFetcher() });
  }
  const response = Object.assign(new ServerResponse(request), expressResponse, { json: vi.fn<Response["json"]>() });
  const run = async () => {
    const handler = mocks.handlers.get(spec.route)!.handler;
    const next = (error?: unknown) => { if (error) throw error; };
    return request.authentication
      ? withAuthority(request.authentication, () => handler(request, response, next))
      : handler(request, response, next);
  };
  return { request, response, run };
}

describe("unified agent response publication", () => {
  it.each(routes)("preserves current Viewer responses: $route", async spec => {
    for (const kind of ["standalone", "browser", "bearer"] as const) {
      const { response, run } = await transport(spec, kind);
      await run();
      expect(response.json).toHaveBeenCalledExactlyOnceWith(spec.result);
      expect(response.listenerCount("close")).toBe(0);
    }
    expect(mocks.handlers.get(spec.route)?.policy).toMatchObject({
      access: "authenticated", roles: ["AgentControl.Viewer"],
      ...spec.route.startsWith("post ") ? { csrf: true } : {},
    });
  });

  it.each(routes)("withholds JSON after logout during $phase: $route", async spec => {
    const { request, response, run } = await transport(spec);
    const scope = requestScope(request);
    mocks[spec.phase].mockImplementationOnce(async () => {
      await revokeAccountSessionMutations(scope.tenantId, scope.principalId, async () => undefined);
      return results[spec.phase];
    });
    await expect(run()).rejects.toMatchObject({ status: 401 });
    expect(response.json).not.toHaveBeenCalled();
    expect(response.listenerCount("close")).toBe(0);
  });

  it.each(routes)("withholds JSON after superseding sign-in during $phase: $route", async spec => {
    const { request, response, run } = await transport(spec);
    const scope = requestScope(request);
    mocks[spec.phase].mockImplementationOnce(async () => {
      await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
      return results[spec.phase];
    });
    await expect(run()).rejects.toMatchObject({ status: 401 });
    expect(response.json).not.toHaveBeenCalled();
  });

  it.each(routes)("checks the current Viewer role and request scope: $route", async spec => {
    for (const change of ["role removal", "scope replacement"] as const) {
      const { request, response, run } = await transport(spec);
      mocks[spec.phase].mockImplementationOnce(async () => {
        if (change === "role removal") request.session.user!.roles = [];
        else {
          request.session.accountId = "another-account";
          request.session.user!.homeAccountId = "another-account";
        }
        return results[spec.phase];
      });
      await expect(run()).rejects.toMatchObject({ status: 401 });
      expect(response.json).not.toHaveBeenCalled();
    }
  });

  it.each(routes)("fences publication to the initiating browser and bearer credentials: $route", async spec => {
    for (const kind of ["browser", "bearer"] as const) {
      const { request, response, run } = await transport(spec, kind);
      mocks[spec.phase].mockImplementationOnce(async () => {
        request.authentication!.revoke();
        return results[spec.phase];
      });
      await expect(run()).rejects.toMatchObject({ status: 401 });
      expect(response.json).not.toHaveBeenCalled();
    }
  });

  it.each(routes)("propagates read failures without publishing JSON: $route", async spec => {
    const { response, run } = await transport(spec);
    const failure = new Error("Synthetic saved read failed");
    mocks[spec.phase].mockRejectedValueOnce(failure);
    await expect(run()).rejects.toBe(failure);
    expect(response.json).not.toHaveBeenCalled();
    expect(response.listenerCount("close")).toBe(0);
  });

  it("rechecks Viewer authority after Purview audit completion", async () => {
    const { request, response, run } = await transport(routes[2]);
    mocks.completeEvent.mockImplementationOnce(async () => { request.session.user!.roles = []; });
    await expect(run()).rejects.toMatchObject({ status: 401 });
    expect(response.json).not.toHaveBeenCalled();
    expect(mocks.completeEvent).toHaveBeenLastCalledWith("saved-audit-event", expect.objectContaining({ status: "failed" }));
  });
});
