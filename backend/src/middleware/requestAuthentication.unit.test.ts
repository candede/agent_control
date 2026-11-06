import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import express from "express";
import session from "express-session";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { currentAuthority } from "../auth/authorityContext.js";
import { account, apiToken, browserAuthenticationResult, browserSession, jwk, native, sdkResponse, tenant } from "../auth/authFoundationTestSupport.js";
import { replaceMsalClientForTest } from "../auth/msal.js";
import { DataGenerations } from "../db/dataGenerations.js";
import { activateAccountSession, clearAccountSessionMutationsForTest } from "../db/sessions.js";
import { currentActionOrigin, mcpContextHeader } from "../services/actionOrigin.js";
import { requestAuthentication } from "./requestAuthentication.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{ tenantId: "11111111-1111-1111-1111-111111111111",
    clientId: "22222222-2222-2222-2222-222222222222", clientSecret: "synthetic-only",
    domains: ["example.invalid"], integration: { clientId: "33333333-3333-3333-3333-333333333333",
      audience: "22222222-2222-2222-2222-222222222222", scope: "AgentControl.Access" } }]);
});

const originalTenants = config.tenants;
const database = new pg.Pool({ max: 4 });
const sessionStore = new session.MemoryStore();
const sockets: Socket[] = [];
const getAccount = vi.fn(async (_id: string) => account());
const unexpectedFetch = vi.fn<typeof fetch>(async () => { throw new Error("Unexpected external request."); });
const identityFetch = vi.fn<typeof fetch>(async (url, options) => {
  const parsed = new URL(String(url));
  if (parsed.hostname === "login.microsoftonline.com" && parsed.pathname.endsWith("/discovery/v2.0/keys")) {
    return Response.json({ keys: [jwk] });
  }
  if (parsed.hostname === "login.microsoftonline.com" && parsed.pathname.endsWith("/oauth2/v2.0/token")) {
    return sdkResponse({}, options);
  }
  if (parsed.hostname === "graph.microsoft.com" && parsed.pathname === `/v1.0/users/${native}`) {
    return Response.json({ id: native, accountEnabled: true, userType: "Member" });
  }
  throw new Error("Unexpected mocked identity endpoint.");
});
const defaultIdentityFetch = identityFetch.getMockImplementation()!;

beforeEach(async () => {
  config.tenants = [tenant];
  clearAccountSessionMutationsForTest();
  await activateAccountSession(tenant.tenantId, account().homeAccountId, async () => {});
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected database request."));
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database connection."));
  vi.spyOn(DataGenerations.prototype, "sessionEpoch").mockResolvedValue("1");
  vi.spyOn(DataGenerations.prototype, "bearerAuthority").mockResolvedValue({ epoch: "1", issuedAfter: "0" });
  identityFetch.mockReset().mockImplementation(defaultIdentityFetch);
  unexpectedFetch.mockClear();
  vi.stubGlobal("fetch", unexpectedFetch);
  getAccount.mockReset().mockResolvedValue(account());
  const unsupported = async () => { throw new Error("Unexpected MSAL operation."); };
  replaceMsalClientForTest(tenant.tenantId, {
    getAuthCodeUrl: unsupported, acquireTokenByCode: unsupported, acquireTokenSilent: unsupported,
    acquireTokenByClientCredential: async () => ({ ...browserAuthenticationResult(), account: null,
      scopes: ["https://graph.microsoft.com/.default"], accessToken: "synthetic-employee-read" }),
    getTokenCache: () => ({ getAccountByHomeId: getAccount, removeAccount: async () => {} }),
  });
});

afterEach(() => {
  try {
    expect(database.query).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
    expect(unexpectedFetch).not.toHaveBeenCalled();
  } finally {
    for (const socket of sockets.splice(0)) socket.destroy();
    replaceMsalClientForTest(tenant.tenantId, undefined);
    config.tenants = originalTenants;
    clearAccountSessionMutationsForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
afterAll(async () => { await database.end(); });

function exchange(rawHeaders: string[] = []) {
  const socket = new Socket();
  sockets.push(socket);
  const request: express.Request = Object.setPrototypeOf(new IncomingMessage(socket), express.request);
  request.rawHeaders = rawHeaders;
  request.headers = {};
  for (let index = 0; index < rawHeaders.length; index += 2) {
    request.headers[rawHeaders[index].toLowerCase()] ??= rawHeaders[index + 1];
  }
  request.sessionID = randomUUID();
  request.session = sessionStore.createSession(request, browserSession());
  const response: express.Response = Object.setPrototypeOf(new ServerResponse(request), express.response);
  response.locals = { requestId: randomUUID() };
  return { request, response };
}

async function bindBrowser({ request, response }: ReturnType<typeof exchange>, next: express.NextFunction) {
  const configured = vi.fn();
  await requestAuthentication(database, identityFetch)(request, response, configured);
  expect(configured).toHaveBeenCalledExactlyOnceWith();
  const bind = request.bindBrowserAuthority;
  if (!bind) throw new Error("Browser authority was not installed.");
  return bind(request, response, next);
}

describe("server-free request authentication boundaries", () => {
  it("does not mistake another header's value for an Authorization header", async () => {
    const { request, response } = exchange(["Authorization", `Bearer ${apiToken()}`, "X-Selected-Header", "authorization"]);
    const next = vi.fn(() => {
      expect(currentAuthority()).toBe(request.authentication);
      expect(currentActionOrigin().channel).toBe("mcp");
    });
    await requestAuthentication(database, identityFetch)(request, response, next);
    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(identityFetch).toHaveBeenCalledTimes(2);
    expect(request.listenerCount("aborted")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });

  it("still rejects duplicate Authorization names before identity work", async () => {
    const token = apiToken();
    const { request, response } = exchange(["Authorization", `Bearer ${token}`, "AUTHORIZATION", `Bearer ${token}`]);
    const next = vi.fn();
    await requestAuthentication(database, identityFetch)(request, response, next);
    expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401, code: "unauthorized" }));
    expect(identityFetch).not.toHaveBeenCalled();
    expect(DataGenerations.prototype.bearerAuthority).not.toHaveBeenCalled();
  });

  it("does not mistake another header's value for duplicate MCP attribution", async () => {
    const context = Buffer.from(JSON.stringify({ version: 1, client: { name: "Synthetic client" } })).toString("base64url");
    const { request, response } = exchange(["Authorization", `Bearer ${apiToken()}`,
      mcpContextHeader, context, "X-Selected-Header", mcpContextHeader.toLowerCase()]);
    const next = vi.fn(() => {
      expect(currentActionOrigin().client.name).toEqual({ value: "Synthetic client", evidence: "reported" });
    });
    await requestAuthentication(database, identityFetch)(request, response, next);
    expect(next).toHaveBeenCalledExactlyOnceWith();
  });

  it("still rejects duplicate MCP attribution names", async () => {
    const context = Buffer.from(JSON.stringify({ version: 1 })).toString("base64url");
    const { request, response } = exchange(["Authorization", `Bearer ${apiToken()}`,
      mcpContextHeader, context, mcpContextHeader.toLowerCase(), context]);
    const next = vi.fn();
    await requestAuthentication(database, identityFetch)(request, response, next);
    expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: 400, code: "invalid_action_origin", message: "Use one bounded action attribution header.",
    }));
  });

  it.each(["aborted", "destroyed"] as const)("rejects an already %s bearer exchange without provider work", async state => {
    const pair = exchange(["Authorization", `Bearer ${apiToken()}`]);
    if (state === "aborted") pair.request.aborted = true;
    else pair.response.destroyed = true;
    const next = vi.fn();
    await requestAuthentication(database, identityFetch)(pair.request, pair.response, next);
    expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "authentication_cancelled" }));
    expect(identityFetch).not.toHaveBeenCalled();
    expect(pair.request.listenerCount("aborted")).toBe(0);
    expect(pair.response.listenerCount("close")).toBe(0);
  });

  it("remembers a browser disconnect during the awaited epoch lookup", async () => {
    const started = Promise.withResolvers<void>(), epoch = Promise.withResolvers<string>();
    vi.mocked(DataGenerations.prototype.sessionEpoch).mockImplementationOnce(() => {
      started.resolve();
      return epoch.promise;
    });
    const pair = exchange(), next = vi.fn();
    const pending = bindBrowser(pair, next);
    await started.promise;
    pair.response.emit("close");
    epoch.resolve("1");
    await pending;
    expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "authentication_cancelled" }));
    expect(pair.request.authentication).toBeUndefined();
    expect(identityFetch).not.toHaveBeenCalled();
    expect(pair.request.listenerCount("aborted")).toBe(0);
    expect(pair.response.listenerCount("close")).toBe(0);
  });

  it("cancels employee verification when a browser request is aborted", async () => {
    const started = Promise.withResolvers<AbortSignal>();
    identityFetch.mockImplementation(async (_url, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error("Employee verification requires cancellation.");
      started.resolve(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Synthetic cancellation.")), { once: true });
      });
    });
    const pair = exchange(), next = vi.fn();
    pair.request.session.user!.roles = [];
    const pending = bindBrowser(pair, next);
    const signal = await started.promise;
    pair.request.emit("aborted");
    await pending;
    expect(signal.aborted).toBe(true);
    expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "authentication_cancelled" }));
    expect(pair.request.listenerCount("aborted")).toBe(0);
    expect(pair.response.listenerCount("close")).toBe(0);
  });

  it.each(["aborted", "destroyed"] as const)("rejects an already %s browser exchange before account lookup", async state => {
    const pair = exchange(), next = vi.fn();
    if (state === "aborted") pair.request.aborted = true;
    else pair.response.destroyed = true;
    await bindBrowser(pair, next);
    expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "authentication_cancelled" }));
    expect(getAccount).not.toHaveBeenCalled();
    expect(identityFetch).not.toHaveBeenCalled();
    expect(pair.request.listenerCount("aborted")).toBe(0);
    expect(pair.response.listenerCount("close")).toBe(0);
  });

  it("still admits active roleless browser employees and supplies verified request context", async () => {
    const pair = exchange();
    pair.request.session.user!.roles = [];
    const next = vi.fn(() => {
      expect(currentAuthority()).toBe(pair.request.authentication);
      expect(currentAuthority()?.principal.roles).toEqual([]);
      expect(currentActionOrigin().channel).toBe("webapp");
    });
    await bindBrowser(pair, next);
    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(identityFetch).toHaveBeenCalledOnce();
    expect(pair.request.listenerCount("aborted")).toBe(0);
    expect(pair.response.listenerCount("close")).toBe(0);
  });
});
