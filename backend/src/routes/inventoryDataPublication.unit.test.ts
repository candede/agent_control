import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { Request, RequestHandler, Response } from "express";
import session from "express-session";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { withAuthority } from "../auth/authorityContext.js";
import { account, browserSession, epochAuthority, oboFetcher, tenant, verifiedBearer } from "../auth/authFoundationTestSupport.js";
import { createBearerCredentials, createBrowserCredentials } from "../auth/delegatedCredentials.js";
import { browserRequestPrincipal } from "../auth/requestPrincipal.js";
import { activateAccountSession, clearAccountSessionMutationsForTest, revokeAccountSessionMutations } from "../db/sessions.js";
import { requestScope } from "../middleware/auth.js";
import { capabilities } from "../services/capabilities.js";
import * as operationalState from "../services/operationalState.js";
import type { RoutePolicy } from "./policy.js";
import { createInventoryDataRouter } from "./inventoryData.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, { handler: RequestHandler; policy: RoutePolicy }>(),
  capture: vi.fn(), page: vi.fn(), summary: vi.fn(), responsibility: vi.fn(), facets: vi.fn(),
  packageDetail: vi.fn(), children: vi.fn(), members: vi.fn(), sections: vi.fn(), about: vi.fn(), invalidate: vi.fn(),
  submitSelected: vi.fn(),
}));

vi.mock("../db/pool.js", () => ({ pool: {}, secretValue: vi.fn() }));
vi.mock("./policy.js", () => ({
  policyRoute: (_router: unknown, method: string, path: string, policy: RoutePolicy, ...handlers: RequestHandler[]) => {
    mocks.handlers.set(`${method} ${path}`, { handler: handlers[handlers.length - 1], policy });
  },
}));
vi.mock("../db/inventoryQueries.js", () => ({
  InventoryQueries: class {
    selections = { invalidate: mocks.invalidate };
    capture = mocks.capture;
    page = mocks.page;
    summary = mocks.summary;
    responsibility = mocks.responsibility;
    facets = mocks.facets;
    packageDetail = mocks.packageDetail;
    children = mocks.children;
    members = mocks.members;
    sections = mocks.sections;
    about = mocks.about;
  },
}));
vi.mock("../db/packageRefreshJobs.js", () => ({
  PackageRefreshJobs: class { submitSelected = mocks.submitSelected; },
}));
vi.mock("../services/reportIdentity.js", async original => ({
  ...await original<typeof import("../services/reportIdentity.js")>(),
  reportIdentity: vi.fn<typeof import("../services/reportIdentity.js").reportIdentity>(async (_database, user) => ({ tenantId: user.tenantId, principalId: user.homeAccountId,
    sessionEpoch: "1", authorizationHash: "synthetic-viewer" })),
}));
vi.mock("../services/inventoryPresentation.js", () => ({
  inventoryPresentation: (page: unknown) => page,
  inventorySourceStatuses: () => ({ powerPlatform: { state: "available" } }),
}));

const database = new pg.Pool({ max: 4 });
const originalTenants = config.tenants;
const selected = account();
const selectionId = "33333333-3333-4333-8333-333333333333";
const sourceScopeId = "44444444-4444-4444-8444-444444444444";
const recordId = "agent:55555555-5555-4555-8555-555555555555";
const savedSelection = { id: selectionId, evaluatedAt: "2026-10-30T00:00:00Z" };
const savedPage = {
  value: [{ id: recordId, residual: { id: "package-id" }, columns: [] }], selection: savedSelection,
  freshness: { state: "idle" }, summary: { total: 1 }, verification: {}, identityCollection: {},
  sources: {}, partial: false, errors: [], counts: { total: 1 }, page: { nextCursor: null },
};
const defaults = {
  capture: savedSelection, page: savedPage, summary: { total: 1 },
  responsibility: { ...savedPage, sourceRows: [], selected: null },
  facets: { value: [], total: 0, nextCursor: null }, packageDetail: { id: "package-id" },
  children: { value: [], nextCursor: null }, members: { value: [], total: 0, nextCursor: null },
  sections: { value: [], nextCursor: null }, about: { text: "saved description" }, invalidate: undefined,
  submitSelected: { id: "refresh-job", status: "waiting_authorization" },
};
const routes = [
  { route: "post /agent-inventory/selections", phase: "capture", body: { query: {} }, status: 201 },
  { route: "post /agents/selections", phase: "capture", body: { query: {} }, status: 201 },
  { route: "get /agent-inventory/health", phase: "invalidate" },
  { route: "get /agent-inventory", phase: "page" },
  { route: "get /agent-inventory/summary", phase: "summary" },
  { route: "get /agent-responsibility", phase: "responsibility" },
  { route: "get /agent-inventory/facets", phase: "facets", query: { field: "publisher" } },
  { route: "get /agents/:id/detail", phase: "packageDetail" },
  { route: "get /agent-inventory/:recordId/detail", phase: "page" },
  { route: "get /agent-inventory/:recordId/children", phase: "children", query: { kind: "element" } },
  { route: "get /agent-inventory/:recordId/members", phase: "members" },
  { route: "get /agent-inventory/:recordId/sections", phase: "sections", query: { sourceScopeId, sourceIdentity: "saved-source" } },
  { route: "get /agent-inventory/:recordId/about", phase: "about", query: { sourceScopeId, sourceIdentity: "saved-source", field: "long" } },
  { route: "get /agents", phase: "page" },
  { route: "post /agents/refresh-selection", phase: "submitSelected", body: { selectionId }, status: 202 },
] satisfies { route: string; phase: keyof typeof defaults; body?: unknown; status?: number; query?: Record<string, string> }[];
const sockets: Socket[] = [];

beforeEach(() => {
  config.tenants = [tenant];
  clearAccountSessionMutationsForTest();
  vi.resetAllMocks();
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
  vi.spyOn(database, "query").mockResolvedValue({
    command: "SELECT", rowCount: 1, oid: 0, fields: [],
    rows: [{ id: sourceScopeId, published: true, previously_published: true, preparing: false }],
  });
  vi.spyOn(capabilities, "beginOperationValidation").mockReturnValue(() => undefined);
  vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => undefined);
  for (const phase of Object.keys(defaults) as (keyof typeof defaults)[]) {
    mocks[phase].mockResolvedValue(defaults[phase]);
  }
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected application/provider request")));
  createInventoryDataRouter(database);
});

afterEach(() => {
  try {
    expect(database.connect).not.toHaveBeenCalled();
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

afterAll(async () => { await database.end(); });

async function transport(spec: typeof routes[number], kind: "standalone" | "browser" | "bearer" = "standalone") {
  const socket = new Socket();
  sockets.push(socket);
  const request = new IncomingMessage(socket) as Request;
  const query = spec.route === "get /agent-inventory/health" || spec.route.startsWith("post ") ? {} : { selectionId };
  Object.defineProperty(request, "query", { value: { ...query, ...spec.query } });
  request.params = { recordId, id: "package-id" };
  request.body = spec.body;
  request.get = vi.fn();
  const data = browserSession(selected);
  request.session = new session.Session(request, data);
  if (kind === "browser") {
    const epochs = epochAuthority();
    request.authentication = createBrowserCredentials(await browserRequestPrincipal(data, null, epochs), epochs);
  } else if (kind === "bearer") {
    request.authentication = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: oboFetcher() });
  }
  const response = Object.assign(new ServerResponse(request), {
    json: vi.fn(), status: vi.fn().mockReturnThis(),
  }) as Response;
  const run = async () => {
    const handler = mocks.handlers.get(spec.route)!.handler;
    const next = (error?: unknown) => { if (error) throw error; };
    return request.authentication
      ? withAuthority(request.authentication, () => handler(request, response, next))
      : handler(request, response, next);
  };
  return { request, response, run };
}

describe("saved inventory JSON publication", () => {
  it.each(routes)("preserves current Viewer reads: $route", async spec => {
    const { response, run } = await transport(spec);
    await run();
    expect(response.json).toHaveBeenCalledOnce();
    if (spec.status) expect(response.status).toHaveBeenCalledWith(spec.status);
    expect(mocks.handlers.get(spec.route)?.policy).toMatchObject({
      access: "authenticated", roles: ["AgentControl.Viewer"],
      ...spec.route.startsWith("post ") ? { csrf: true } : {},
    });
  });

  it.each(["browser", "bearer"] as const)("publishes every reader for a current %s Viewer", async kind => {
    for (const spec of routes) {
      const { response, run } = await transport(spec, kind);
      await run();
      expect(response.json).toHaveBeenCalledOnce();
    }
  });

  it("keeps selected refresh admission and collection on tenant application authority", async () => {
    const { response, run } = await transport(routes[routes.length - 1]);
    await run();
    expect(capabilities.beginOperationValidation).toHaveBeenCalledWith("graph.package.read.application",
      expect.objectContaining({ tenantId: tenant.tenantId, homeAccountId: selected.homeAccountId }));
    expect(mocks.submitSelected).toHaveBeenCalledWith({
      tenantId: tenant.tenantId, principalId: tenant.clientId, tokenMode: "application",
    }, expect.objectContaining({ principalId: selected.homeAccountId }), expect.objectContaining({ selectionId }),
    expect.any(Function));
    expect(response.status).toHaveBeenCalledWith(202);
  });

  it.each(routes)("withholds JSON after logout during $phase: $route", async spec => {
    const { request, response, run } = await transport(spec);
    const scope = requestScope(request);
    let revoked: Promise<void> | undefined;
    mocks[spec.phase].mockImplementationOnce(async () => {
      revoked = revokeAccountSessionMutations(scope.tenantId, scope.principalId, async () => undefined);
      return defaults[spec.phase];
    });
    await expect(run()).rejects.toMatchObject({ status: 401 });
    await revoked;
    expect(response.json).not.toHaveBeenCalled();
  });

  it.each(routes)("withholds JSON after superseding sign-in during $phase: $route", async spec => {
    const { request, response, run } = await transport(spec);
    const scope = requestScope(request);
    let activated: Promise<void> | undefined;
    mocks[spec.phase].mockImplementationOnce(async () => {
      activated = activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
      return defaults[spec.phase];
    });
    await expect(run()).rejects.toMatchObject({ status: 401 });
    await activated;
    expect(response.json).not.toHaveBeenCalled();
  });

  it.each(["browser", "bearer"] as const)("fences every reader to the initiating %s credential", async kind => {
    for (const spec of routes) {
      const { request, response, run } = await transport(spec, kind);
      mocks[spec.phase].mockImplementationOnce(async () => {
        request.authentication!.revoke();
        return defaults[spec.phase];
      });
      await expect(run()).rejects.toMatchObject({ status: 401 });
      expect(response.json).not.toHaveBeenCalled();
    }
  });

  it.each(["role removal", "scope replacement"] as const)("withholds JSON after %s during a saved read", async change => {
    const { request, response, run } = await transport(routes[3]);
    mocks.page.mockImplementationOnce(async () => {
      if (change === "role removal") request.session.user!.roles = [];
      else {
        request.session.accountId = "another-account";
        request.session.user!.homeAccountId = "another-account";
      }
      return savedPage;
    });
    await expect(run()).rejects.toMatchObject({ status: 401 });
    expect(response.json).not.toHaveBeenCalled();
  });

  it("withholds availability JSON when logout occurs during the root read", async () => {
    const { request, response, run } = await transport(routes[0]);
    const scope = requestScope(request);
    vi.mocked(database.query).mockImplementationOnce(async () => {
      await revokeAccountSessionMutations(scope.tenantId, scope.principalId, async () => undefined);
      return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
    });
    await expect(run()).rejects.toMatchObject({ status: 401 });
    expect(response.json).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it.each([
    { published: false, previously_published: false, preparing: false, state: "not_collected" },
    { published: false, previously_published: true, preparing: false, state: "unavailable" },
    { published: false, previously_published: true, preparing: true, state: "preparing" },
  ])("preserves automatic first-collection availability: $state", async ({ state, ...root }) => {
    vi.mocked(database.query).mockResolvedValue({
      command: "SELECT", rowCount: 1, oid: 0, fields: [], rows: [{ id: sourceScopeId, ...root }],
    });
    for (const spec of [routes[0], routes[2]]) {
      const { response, run } = await transport(spec);
      await run();
      expect(response.status).toHaveBeenCalledWith(200);
      expect(response.json).toHaveBeenCalledWith({ state, message: expect.any(String) });
      expect(mocks.capture).not.toHaveBeenCalled();
    }
  });

  it("invalidates the temporary health selection even when its reader fails", async () => {
    const { response, run } = await transport(routes[2]);
    const failure = new Error("Synthetic saved inventory failure");
    mocks.page.mockRejectedValueOnce(failure);
    await expect(run()).rejects.toBe(failure);
    expect(mocks.invalidate).toHaveBeenCalledWith(selectionId, expect.objectContaining({ principalId: selected.homeAccountId }));
    expect(response.json).not.toHaveBeenCalled();
  });

  it.each(routes)("propagates saved read failures without JSON: $route", async spec => {
    const { response, run } = await transport(spec);
    const failure = new Error("Synthetic saved inventory failure");
    mocks[spec.phase].mockRejectedValueOnce(failure);
    await expect(run()).rejects.toBe(failure);
    expect(response.json).not.toHaveBeenCalled();
  });
});
