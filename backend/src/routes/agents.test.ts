import { request as expressRequest, type Request, type RequestHandler, type Response, type Router } from "express";
import session from "express-session";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bulkJobs, launchBulkJob, requireWorkerCapacity } from "../services/bulkJobs.js";
import { acquireDelegatedToken } from "../auth/msal.js";
import { PackageInventoryRepository } from "../db/packageInventory.js";
import { packageInventory } from "../services/packageInventory.js";
import { createJobConfirmation } from "../db/jobs.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import { capabilities } from "../services/capabilities.js";
import { DirectoryPrincipalsClient } from "../services/directoryPrincipals.js";
import type { FetchLike } from "../services/graphPackages.js";
import * as operationalState from "../services/operationalState.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import type { RoutePolicy } from "./policy.js";
import type { PackageAccessMutationState } from "../services/packageMutationState.js";
import {
  parseBulkActionIds,
  parseDirectorySearchLimit,
  parseActionGroupId,
  parsePackageAccessUpdate,
  parseMutationScope,
  inventoryPackageDetail,
  parsePackageRefreshIds,
  submitCanaryJob,
  canaryFailureCompletion,
} from "./agents.js";

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: vi.fn((name: string) => name === "TENANT_ID" ? "11111111-1111-4111-8111-111111111111" : undefined),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));
const handlers = vi.hoisted(() => new Map<string, RequestHandler>());
vi.mock("./policy.js", () => ({
  policyRoute: (_router: Router, method: string, path: string, _policy: RoutePolicy, handler: RequestHandler) => {
    handlers.set(`${method} ${path}`, handler);
  },
}));
vi.mock("../services/bulkJobs.js", async original => ({
  ...await original<typeof import("../services/bulkJobs.js")>(),
  launchBulkJob: vi.fn(),
  requireWorkerCapacity: vi.fn(),
}));
vi.mock("../auth/msal.js", async original => ({
  ...await original<typeof import("../auth/msal.js")>(),
  acquireDelegatedToken: vi.fn(async () => "token"),
}));

afterEach(() => vi.restoreAllMocks());

const groupId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

describe("package refresh admission responses", () => {
  it.each(["/agents/refresh-jobs", "/agents/:id/refresh-jobs", "/agents/refresh-jobs/:id/resume"])(
    "returns saved permission diagnostics from %s rather than a sign-in-only waiting response", async path => {
      const user = { tenantId: groupId, homeAccountId: "package-reader", displayName: "Reader",
        username: "reader@example.invalid", roles: ["AgentControl.Viewer" as const] };
      const waiting = {
        id: groupId, authorizationPrincipalId: user.homeAccountId, tokenMode: "delegated" as const,
        scopeKind: "broad" as const, requestedIds: [], catalogOnly: false, autoDetails: false,
        status: "waiting_authorization" as const, pageCount: 0, observedCount: 0, totalRecords: null,
        snapshotId: null, createdAt: "2026-09-09T00:00:00.000Z", attemptedAt: null,
        updatedAt: "2026-09-09T00:00:00.000Z", finishedAt: null,
      };
      const failed = { ...waiting, status: "failed" as const, errorCode: "missing_permission",
        message: "Review Permissions; signing in again does not grant permissions." };
      vi.spyOn(packageInventory, "submit").mockResolvedValue(waiting);
      vi.spyOn(packageInventory, "start").mockRejectedValue(new AppError(403, "missing_permission", "Consent required."));
      vi.spyOn(packageInventory, "get").mockResolvedValue(failed);
      const request: Partial<Request> = { body: { mode: "delegated" }, params: { id: groupId }, get: vi.fn() };
      new session.MemoryStore().createSession(request as Request, {
        cookie: new session.Cookie(), accountId: user.homeAccountId, tenantId: user.tenantId, user,
      });
      const response = { json: vi.fn<Response["json"]>(), status: vi.fn<Response["status"]>().mockReturnThis() };
      const handler = handlers.get(`post ${path}`);
      if (!handler) throw new Error("Package refresh handler was not registered.");
      await handler(request as Request, response as Response, error => { if (error) throw error; });
      expect(response.status).toHaveBeenCalledWith(202);
      expect(response.json).toHaveBeenCalledWith(failed);
    },
  );
});

describe("directory request lifecycle", () => {
  const resolvePrincipals = DirectoryPrincipalsClient.prototype.resolve;
  const scope = { tenantId: "11111111-1111-4111-8111-111111111111", principalId: "directory-reader" };
  const user = { tenantId: scope.tenantId, homeAccountId: scope.principalId,
    username: "reader@example.invalid", displayName: "Reader", roles: ["AgentControl.Viewer" as const] };
  const principal = { resourceType: "user", resourceId: userId, displayName: "Person", principalKind: "user" as const };

  function startRequest(method: "get" | "post") {
    const path = method === "get" ? "/directory/principals" : "/directory/principals/resolve";
    const handler = handlers.get(`${method} ${path}`);
    if (!handler) throw new Error("Directory handler was not registered.");
    const json = vi.fn<Response["json"]>();
    const response = Object.assign(new EventEmitter(), { json, writableEnded: false });
    const request: Partial<Request> = {
      path, query: { search: "person" }, body: { principals: [{ resourceType: "user", resourceId: userId }] },
      sessionID: "directory-session",
    };
    new session.MemoryStore().createSession(request as Request, {
      cookie: new session.Cookie(), accountId: scope.principalId, tenantId: scope.tenantId, user,
    });
    const pending = Promise.resolve(handler(request as Request, response as Response, error => { if (error) throw error; }));
    return { pending, response, json };
  }

  async function replaceSession() {
    await revokeAccountSessionMutations(scope.tenantId, scope.principalId, async () => undefined);
    await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
  }

  beforeEach(async () => {
    await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
    vi.mocked(acquireDelegatedToken).mockReset().mockResolvedValue("token");
    vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => undefined);
    vi.spyOn(capabilities, "requireAvailable").mockResolvedValue({
      capabilityId: "graph.directory.read", status: "available", authorized: true, fresh: true,
      verification: "provider", previewQualification: "not_required", remediation: [],
    });
    vi.spyOn(DirectoryPrincipalsClient.prototype, "search").mockResolvedValue([principal]);
    vi.spyOn(DirectoryPrincipalsClient.prototype, "resolve").mockResolvedValue([principal]);
  });

  it.each(["get", "post"] as const)("returns unchanged %s directory payloads and removes connection listeners", async method => {
    const { pending, response, json } = startRequest(method);
    await pending;
    expect(json).toHaveBeenCalledExactlyOnceWith({ value: [principal] });
    expect(response.listenerCount("close")).toBe(0);
  });

  it.each((["get", "post"] as const).flatMap(method =>
    (["capability", "token", "lookup"] as const).map(stage => ({ method, stage })),
  ))("rejects a replaced session during $method $stage", async ({ method, stage }) => {
    const lookup = method === "get" ? DirectoryPrincipalsClient.prototype.search : DirectoryPrincipalsClient.prototype.resolve;
    if (stage === "capability") vi.mocked(capabilities.requireAvailable).mockImplementationOnce(async () => {
      await replaceSession();
      return { capabilityId: "graph.directory.read", status: "available", authorized: true, fresh: true,
        verification: "provider", previewQualification: "not_required", remediation: [] };
    });
    if (stage === "token") vi.mocked(acquireDelegatedToken).mockImplementationOnce(async () => {
      await replaceSession();
      return "token";
    });
    if (stage === "lookup") vi.mocked(lookup).mockImplementationOnce(async () => {
      await replaceSession();
      return [principal];
    });
    const { pending, response, json } = startRequest(method);
    await expect(pending).rejects.toMatchObject({ code: "unauthorized" });
    if (stage !== "lookup") expect(lookup).not.toHaveBeenCalled();
    if (stage === "capability") expect(acquireDelegatedToken).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(response.listenerCount("close")).toBe(0);
  });

  it.each(["get", "post"] as const)("does not dispatch %s directory work after admissions close during token acquisition", async method => {
    vi.mocked(acquireDelegatedToken).mockImplementationOnce(async () => {
      vi.mocked(operationalState.requireProviderAdmissions).mockImplementation(() => {
        throw new AppError(503, "maintenance", "Provider work paused.");
      });
      return "token";
    });
    const { pending, json } = startRequest(method);
    await expect(pending).rejects.toMatchObject({ code: "maintenance" });
    expect(DirectoryPrincipalsClient.prototype.search).not.toHaveBeenCalled();
    expect(DirectoryPrincipalsClient.prototype.resolve).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it.each(["get", "post"] as const)("does not dispatch %s directory work after disconnection during token acquisition", async method => {
    const token = Promise.withResolvers<string>();
    vi.mocked(acquireDelegatedToken).mockReturnValueOnce(token.promise);
    const { pending, response, json } = startRequest(method);
    const observed = pending.catch(error => error);
    await setImmediate();
    response.emit("close");
    token.resolve("token");
    expect(await observed).toMatchObject({ code: "request_cancelled" });
    expect(DirectoryPrincipalsClient.prototype.search).not.toHaveBeenCalled();
    expect(DirectoryPrincipalsClient.prototype.resolve).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(response.listenerCount("close")).toBe(0);
  });

  it.each((["get", "post"] as const).flatMap(method =>
    (["disconnect", "deadline"] as const).flatMap(reason =>
      (["token", "lookup"] as const).map(stage => ({ method, reason, stage }))),
  ))("bounds a non-cooperative $method $stage on $reason and ignores its late result", async ({ method, reason, stage }) => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const token = Promise.withResolvers<string>();
    const result = Promise.withResolvers<typeof principal[]>();
    let lookupSignal: AbortSignal | undefined;
    vi.mocked(acquireDelegatedToken).mockReturnValueOnce(stage === "token" ? token.promise : Promise.resolve("token"));
    if (method === "get") vi.mocked(DirectoryPrincipalsClient.prototype.search).mockImplementationOnce(
      async (_token, _query, _limit, signal) => { lookupSignal = signal; return result.promise; },
    );
    else vi.mocked(DirectoryPrincipalsClient.prototype.resolve).mockImplementationOnce(
      async (_token, _principals, signal) => { lookupSignal = signal; return result.promise; },
    );
    const { pending, response, json } = startRequest(method);
    const observed = pending.catch(error => error);
    await setImmediate();
    if (reason === "disconnect") response.emit("close");
    else timeout.abort(new DOMException("Fixture deadline", "TimeoutError"));
    try {
      expect(await Promise.race([observed, setImmediate("still pending")])).toMatchObject({
        status: reason === "disconnect" ? 499 : 504,
        code: reason === "disconnect" ? "request_cancelled" : "provider_timeout",
      });
      expect(AbortSignal.timeout).toHaveBeenCalledWith(120_000);
      if (stage === "lookup") expect(lookupSignal?.aborted).toBe(true);
    } finally {
      token.resolve("late token");
      result.resolve([principal]);
      await observed;
      await setImmediate();
    }
    if (stage === "token") {
      expect(DirectoryPrincipalsClient.prototype.search).not.toHaveBeenCalled();
      expect(DirectoryPrincipalsClient.prototype.resolve).not.toHaveBeenCalled();
    }
    expect(json).not.toHaveBeenCalled();
    expect(response.listenerCount("close")).toBe(0);
  });

  it("fences each queued resolution and cancels peers when the initiating session is replaced", async () => {
    const responses = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<FetchLike>(async (input, init) => {
      if (!init?.signal) throw new Error("Expected directory cancellation.");
      signals.push(init.signal);
      await responses.promise;
      return Response.json({ id: new URL(input).pathname.split("/").at(-1), displayName: "Person" });
    });
    const entities = Array.from({ length: 16 }, (_, index) => ({
      resourceType: "user", resourceId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    vi.mocked(DirectoryPrincipalsClient.prototype.resolve).mockImplementationOnce((token, _principals, signal, assertCurrent) =>
      resolvePrincipals.call(new DirectoryPrincipalsClient(fetcher), token, entities, signal, assertCurrent));
    const { pending, json } = startRequest("post");
    const observed = pending.catch(error => error);
    await setImmediate();
    expect(fetcher).toHaveBeenCalledTimes(8);
    await replaceSession();
    responses.resolve();
    expect(await observed).toMatchObject({ code: "unauthorized" });
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(json).not.toHaveBeenCalled();
  });
});

describe("package mutation worker admission", () => {
  const scope = { tenantId: "11111111-1111-4111-8111-111111111111", principalId: "operator" };
  const actor = { tenantId: scope.tenantId, homeAccountId: scope.principalId,
    username: "operator@example.invalid", displayName: "Operator", roles: ["AgentControl.Admin" as const] };
  const intent = {
    action: "block" as const, scope: "bulk" as const, actor, requestPath: "/agents/block",
    targets: [{ id: "package", displayName: "Package", prestate: { kind: "block" as const, isBlocked: false } }],
  };
  const confirmed = createJobConfirmation(intent);
  const savedPackage = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false });
  const receipt: NonNullable<Awaited<ReturnType<typeof bulkJobs.get>>> = {
    id: "33333333-3333-4333-8333-333333333333", capabilityId: "graph.package.block.manage",
    tokenMode: "delegated", status: "queued", action: "block", targetBlockedState: true,
    confirmationHash: confirmed.confirmationHash, confirmation: confirmed.summary, confirmedAt: "2026-09-24T12:00:00.000Z",
    total: 1, completed: 0, succeeded: 0, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0,
    results: [], result: undefined, currentAgentName: undefined,
    createdAt: "2026-09-24T12:00:00.000Z", updatedAt: "2026-09-24T12:00:00.000Z", canResume: false,
  };
  async function requestMutation(path = "/agents/block", body: unknown = { ids: ["package"], confirmationHash: confirmed.confirmationHash }) {
    const handler = handlers.get(`post ${path}`);
    if (!handler) throw new Error("Mutation handler was not registered.");
    const json = vi.fn<Response["json"]>();
    const response: Partial<Response> = { status: vi.fn<Response["status"]>().mockReturnThis(), json };
    const request: Partial<Request> = {
      path, body, params: { id: receipt.id }, sessionID: "test-session",
      headers: { "idempotency-key": "retry" }, get: expressRequest.get,
    };
    new session.MemoryStore().createSession(request as Request, {
      cookie: new session.Cookie(), accountId: scope.principalId, tenantId: scope.tenantId, user: actor,
    });
    await handler(request as Request, response as Response, error => { if (error) throw error; });
    return json;
  }
  async function replaceSession() {
    await revokeAccountSessionMutations(scope.tenantId, scope.principalId, async () => undefined);
    await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
  }

  beforeEach(async () => {
    await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
    vi.mocked(launchBulkJob).mockReset();
    vi.mocked(requireWorkerCapacity).mockReset();
    vi.mocked(acquireDelegatedToken).mockReset().mockResolvedValue("token");
    vi.spyOn(bulkJobs, "getByIdempotency").mockResolvedValue(undefined);
    vi.spyOn(bulkJobs, "submit").mockResolvedValue(receipt);
    vi.spyOn(PackageInventoryRepository.prototype, "getMany").mockResolvedValue([{
      id: "package", package: savedPackage,
    }]);
    vi.spyOn(capabilities, "requireAvailable").mockResolvedValue({
      capabilityId: receipt.capabilityId, status: "available", authorized: true, fresh: true,
      verification: "on_demand", previewQualification: "not_required", remediation: [],
    });
  });

  it("relaunches the same queued receipt after the final capacity check rejected its first launch", async () => {
    vi.mocked(launchBulkJob).mockImplementationOnce(() => {
      throw new AppError(429, "workers_busy", "Two jobs are already running.");
    });
    await expect(requestMutation()).rejects.toMatchObject({ code: "workers_busy" });
    vi.mocked(bulkJobs.getByIdempotency).mockResolvedValue(receipt);

    expect(await requestMutation()).toHaveBeenCalledWith(receipt);
    expect(launchBulkJob).toHaveBeenCalledTimes(2);
    expect(launchBulkJob).toHaveBeenLastCalledWith(receipt.id, scope);
    expect(bulkJobs.submit).toHaveBeenCalledOnce();
    expect(PackageInventoryRepository.prototype.getMany).toHaveBeenCalledOnce();
  });

  it.each(["running", "waiting_authorization", "partial", "succeeded", "failed", "cancelled"] as const)(
    "returns an existing %s receipt without automatic replay", async status => {
      vi.mocked(bulkJobs.getByIdempotency).mockResolvedValue({ ...receipt, status });
      expect(await requestMutation()).toHaveBeenCalledWith(expect.objectContaining({ status }));
      expect(launchBulkJob).not.toHaveBeenCalled();
      expect(bulkJobs.submit).not.toHaveBeenCalled();
    },
  );

  it("does not relaunch an idempotent receipt with a different confirmation", async () => {
    vi.mocked(bulkJobs.getByIdempotency).mockResolvedValue({ ...receipt, confirmationHash: "f".repeat(64) });
    await expect(requestMutation()).rejects.toMatchObject({ code: "idempotency_mismatch" });
    expect(launchBulkJob).not.toHaveBeenCalled();
  });

  it.each(["lookup", "inventory", "token"] as const)("fences submission after session replacement during %s", async stage => {
    if (stage === "lookup") vi.mocked(bulkJobs.getByIdempotency).mockImplementation(async () => {
      await replaceSession();
      return receipt;
    });
    if (stage === "inventory") vi.mocked(PackageInventoryRepository.prototype.getMany).mockImplementation(async () => {
      await replaceSession();
      return [{ id: "package", package: savedPackage }];
    });
    if (stage === "token") vi.mocked(acquireDelegatedToken).mockImplementation(async () => {
      await replaceSession();
      return "token";
    });

    await expect(requestMutation()).rejects.toMatchObject({ code: "unauthorized" });
    expect(bulkJobs.submit).not.toHaveBeenCalled();
    expect(launchBulkJob).not.toHaveBeenCalled();
  });

  it("does not launch after session replacement during durable submission", async () => {
    let replacement: Promise<void> | undefined;
    vi.mocked(bulkJobs.submit).mockImplementation(async () => {
      replacement = replaceSession();
      return receipt;
    });

    await expect(requestMutation()).rejects.toMatchObject({ code: "unauthorized" });
    await replacement;
    expect(bulkJobs.submit).toHaveBeenCalledOnce();
    expect(launchBulkJob).not.toHaveBeenCalled();
  });

  it.each(["capability", "token", "lookup"] as const)("fences access-principal validation during %s before reading package state", async stage => {
    vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => undefined);
    const principal = { resourceType: "user", resourceId: userId, displayName: "Person", principalKind: "user" as const };
    const resolve = vi.spyOn(DirectoryPrincipalsClient.prototype, "resolve").mockResolvedValue([principal]);
    if (stage === "capability") vi.mocked(capabilities.requireAvailable).mockImplementationOnce(async () => {
      await replaceSession();
      return { capabilityId: "graph.directory.read", status: "available", authorized: true, fresh: true,
        verification: "provider", previewQualification: "not_required", remediation: [] };
    });
    if (stage === "token") vi.mocked(acquireDelegatedToken).mockImplementationOnce(async () => {
      await replaceSession();
      return "token";
    });
    if (stage === "lookup") resolve.mockImplementationOnce(async () => {
      await replaceSession();
      return [principal];
    });

    await expect(requestMutation("/agents/mutation-preview", {
      action: "update-availability", ids: ["package"], target: "availability", mode: "replace", scope: "specific",
      principals: [{ resourceType: "user", resourceId: userId }], mutationScope: "single",
    })).rejects.toMatchObject({ code: "unauthorized" });
    if (stage !== "lookup") expect(resolve).not.toHaveBeenCalled();
    expect(PackageInventoryRepository.prototype.getMany).not.toHaveBeenCalled();
    expect(bulkJobs.submit).not.toHaveBeenCalled();
    expect(launchBulkJob).not.toHaveBeenCalled();
  });

  it("still refuses access confirmation for unresolved directory identities", async () => {
    vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => undefined);
    vi.spyOn(DirectoryPrincipalsClient.prototype, "resolve").mockResolvedValue([{
      resourceType: "user", resourceId: userId, displayName: userId, principalKind: "unknown",
    }]);
    await expect(requestMutation("/agents/mutation-preview", {
      action: "update-availability", ids: ["package"], target: "availability", mode: "replace", scope: "specific",
      principals: [{ resourceType: "user", resourceId: userId }], mutationScope: "single",
    })).rejects.toMatchObject({ code: "unresolved_principal" });
    expect(PackageInventoryRepository.prototype.getMany).not.toHaveBeenCalled();
  });

  it("fences the block-all catalog read before rebuilding its target selection", async () => {
    vi.spyOn(PackageInventoryRepository.prototype, "list").mockImplementation(async () => {
      await replaceSession();
      return {
        value: [savedPackage], count: 1, snapshot: null,
        summary: { total: 1, allowed: 1, blocked: 0 }, filteredSummary: { total: 1, allowed: 1, blocked: 0 },
        facets: { publishers: [], availability: [], hosts: [], platforms: [] },
      };
    });

    await expect(requestMutation("/agents/block-all", { confirmationHash: confirmed.confirmationHash }))
      .rejects.toMatchObject({ code: "unauthorized" });
    expect(PackageInventoryRepository.prototype.getMany).not.toHaveBeenCalled();
    expect(bulkJobs.submit).not.toHaveBeenCalled();
    expect(launchBulkJob).not.toHaveBeenCalled();
  });

  it("uses the recovered receipt rather than the pre-recovery state when resuming", async () => {
    vi.spyOn(bulkJobs, "get").mockResolvedValueOnce(receipt)
      .mockResolvedValue({ ...receipt, status: "waiting_authorization", canResume: true });
    vi.spyOn(bulkJobs, "recover").mockResolvedValue(undefined);

    expect(await requestMutation("/agents/bulk-jobs/:id/resume", { confirmed: true }))
      .toHaveBeenCalledWith(expect.objectContaining({ id: receipt.id, status: "queued" }));
    expect(launchBulkJob).toHaveBeenCalledWith(receipt.id, scope, true);
  });

  it.each(["token", "recovery"] as const)("does not resume after session replacement during %s", async stage => {
    vi.spyOn(bulkJobs, "get").mockResolvedValue({ ...receipt, status: "waiting_authorization", canResume: true });
    vi.spyOn(bulkJobs, "recover").mockImplementation(async () => {
      if (stage === "recovery") await replaceSession();
    });
    if (stage === "token") vi.mocked(acquireDelegatedToken).mockImplementation(async () => {
      await replaceSession();
      return "token";
    });

    await expect(requestMutation("/agents/bulk-jobs/:id/resume", { confirmed: true }))
      .rejects.toMatchObject({ code: "unauthorized" });
    expect(launchBulkJob).not.toHaveBeenCalled();
  });
});

describe("package canary failure completion", () => {
  const scope = { tenantId: "tenant", principalId: "operator" };
  const job: NonNullable<Awaited<ReturnType<typeof bulkJobs.get>>> = {
    id: "original-job", capabilityId: "graph.package.block.manage", tokenMode: "delegated",
    status: "running", action: "block", targetBlockedState: true,
    confirmationHash: null, confirmation: null, confirmedAt: null,
    total: 1, completed: 0, succeeded: 0, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0,
    results: [], result: undefined, currentAgentName: "Canary",
    createdAt: "2026-09-22T12:00:00.000Z", updatedAt: "2026-09-22T12:00:00.000Z", canResume: false,
  };

  it.each(["original", "restoration"] as const)("keeps an unavailable %s job result inconclusive", async stage => {
    const get = vi.spyOn(bulkJobs, "get").mockResolvedValueOnce({ ...job, status: "succeeded" });
    if (stage === "original") get.mockReset();
    get.mockRejectedValueOnce(new Error("Fixture result could not be loaded."));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(canaryFailureCompletion(scope, "original-job", stage === "restoration" ? "restoration-job" : undefined))
      .resolves.toMatchObject({ status: "inconclusive", errorCode: "canary_result_unavailable" });
    expect(get).toHaveBeenLastCalledWith(`${stage}-job`, scope);
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"event":"package_canary_result_unavailable"'));
    expect(log.mock.calls[0][0]).not.toContain("Fixture result");
  });

  it.each(["original", "restoration"] as const)("does not treat a missing or still-running %s job as a definite failure", async stage => {
    const get = vi.spyOn(bulkJobs, "get");
    for (const unresolved of [undefined, job]) {
      get.mockReset();
      if (stage === "restoration") get.mockResolvedValueOnce({ ...job, status: "succeeded" });
      get.mockResolvedValueOnce(unresolved);
      await expect(canaryFailureCompletion(scope, "original-job", stage === "restoration" ? "restoration-job" : undefined))
        .resolves.toMatchObject({ status: "inconclusive", errorCode: "canary_result_unavailable" });
    }
  });

  it("retains known pre-dispatch failures and exact restoration conflicts", async () => {
    const get = vi.spyOn(bulkJobs, "get").mockResolvedValue({ ...job, status: "failed", completed: 1, failed: 1 });
    await expect(canaryFailureCompletion(scope)).resolves.toMatchObject({ status: "failed" });
    expect(get).not.toHaveBeenCalled();
    await expect(canaryFailureCompletion(scope, "original-job")).resolves.toMatchObject({ status: "failed" });
    get.mockResolvedValueOnce({ ...job, status: "succeeded", completed: 1, succeeded: 1 });
    await expect(canaryFailureCompletion(scope, "original-job", "restoration-job")).resolves.toMatchObject({ status: "restoration_conflict" });
  });
});

describe("access canary job submission", () => {
  it.each(["update-availability", "update-installation"] as const)("submits both %s directions with their approved access payload", async action => {
    const before: PackageAccessMutationState = {
      kind: "access", availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [],
    };
    const after: PackageAccessMutationState = action === "update-availability"
      ? { ...before, availableTo: "some", allowedUsersAndGroups: [{ resourceType: "user", resourceId: userId }] }
      : { ...before, deployedTo: "some", acquireUsersAndGroups: [{ resourceType: "group", resourceId: groupId }] };
    const actor = { tenantId: "tenant", homeAccountId: "operator", displayName: "Operator", username: "operator@example.invalid", roles: ["AgentControl.Admin" as const] };
    const stoppedAtStorage = new Error("Captured submission without database access.");
    const submit = vi.spyOn(bulkJobs, "submit").mockRejectedValue(stoppedAtStorage);
    try {
      for (const stage of ["original", "restoration"] as const) {
        const approval = {
          id: `${stage}-approval`, targetId: "package", action,
          prestate: stage === "original" ? before : after,
          poststate: stage === "original" ? after : before,
        };
        await expect(submitCanaryJob(actor, approval, "cycle", stage)).rejects.toBe(stoppedAtStorage);
        expect(submit).toHaveBeenLastCalledWith({ tenantId: actor.tenantId, principalId: actor.homeAccountId }, expect.objectContaining({
          action,
          accessUpdate: {
            target: action === "update-availability" ? "availability" : "installation",
            mode: "replace", scope: stage === "original" ? "specific" : "none",
            principals: stage === "restoration" ? [] : action === "update-availability" ? after.allowedUsersAndGroups : after.acquireUsersAndGroups,
          },
          targets: [{ id: approval.targetId, displayName: "Approved package canary", prestate: approval.prestate }],
          confirmationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          idempotencyKey: `canary-${approval.id}-${stage}`,
        }));
      }
      expect(submit).toHaveBeenCalledTimes(2);
    } finally {
      submit.mockRestore();
    }
  });
});

describe("package identity refresh targets", () => {
  it("retains the broad scan only when exact IDs are omitted", () => {
    expect(parsePackageRefreshIds(undefined)).toBeUndefined();
    expect(parsePackageRefreshIds(["package-a", "package-b"])).toEqual(["package-a", "package-b"]);
  });

  it("rejects empty, duplicate, malformed and oversized selections", () => {
    for (const input of [[], null, ["same", "same"], [1], Array.from({ length: 101 }, (_, index) => `package-${index}`)]) {
      expect(() => parsePackageRefreshIds(input)).toThrow();
    }
  });
});

describe("parsePackageAccessUpdate", () => {
  it("parses a specific principal update", () => {
    expect(
      parsePackageAccessUpdate({
        target: "availability",
        mode: "add",
        scope: "specific",
        principals: [
          { resourceType: "group", resourceId: groupId },
          { resourceType: "user", resourceId: userId },
        ],
      }),
    ).toEqual({
      target: "availability",
      mode: "add",
      scope: "specific",
      principals: [
        { resourceType: "group", resourceId: groupId },
        { resourceType: "user", resourceId: userId },
      ],
    });
  });

  it("rejects duplicate principals instead of silently deduplicating", () => {
    expect(() => parsePackageAccessUpdate({
      target: "availability", mode: "replace", scope: "specific",
      principals: [
        { resourceType: "group", resourceId: groupId },
        { resourceType: "group", resourceId: groupId.toUpperCase() },
      ],
    })).toThrow("Duplicate package access principals");
  });

  it("accepts replacing a target with no users", () => {
    expect(
      parsePackageAccessUpdate({
        target: "installation",
        mode: "replace",
        scope: "none",
        principals: [],
      }),
    ).toMatchObject({
      target: "installation",
      mode: "replace",
      scope: "none",
      principals: [],
    });
  });

  it("rejects all users while Graph has no documented write payload", () => {
    expect(() =>
      parsePackageAccessUpdate({
        target: "availability",
        mode: "replace",
        scope: "all",
        principals: [],
      }),
    ).toThrow("does not document a supported write payload");
  });

  it("rejects add mode with no users", () => {
    expect(() =>
      parsePackageAccessUpdate({
        target: "availability",
        mode: "add",
        scope: "none",
        principals: [],
      }),
    ).toThrow("No users requires replace mode");
  });
});

describe("parseBulkActionIds", () => {
  it("trims unique string IDs", () => {
    expect(parseBulkActionIds({ ids: [" P_1 ", "P_2"] })).toEqual(["P_1", "P_2"]);
  });

  it("rejects duplicate IDs after normalization", () => {
    expect(() => parseBulkActionIds({ ids: [" P_1 ", "P_1"] })).toThrow(
      "Duplicate package IDs",
    );
  });

  it("rejects non-string IDs", () => {
    expect(() => parseBulkActionIds({ ids: ["P_1", { id: "P_2" }] })).toThrow(
      "Each id must be a non-empty string",
    );
  });
});

describe("parseMutationScope", () => {
  it("keeps mutation cardinality separate from package access scope", () => {
    expect(parseMutationScope("single")).toBe("single");
    expect(parseMutationScope("bulk")).toBe("bulk");
    expect(() => parseMutationScope("specific")).toThrowError(
      expect.objectContaining({ code: "invalid_mutation_scope" }),
    );
  });
});

describe("parseDirectorySearchLimit", () => {
  it("accepts positive integer limits", () => {
    expect(parseDirectorySearchLimit("40")).toBe(40);
    expect(parseDirectorySearchLimit(undefined)).toBeUndefined();
  });

  it("rejects partial, zero, and unsafe limits", () => {
    expect(() => parseDirectorySearchLimit("10abc")).toThrow(
      "positive integer",
    );
    expect(() => parseDirectorySearchLimit("0")).toThrow("positive integer");
    expect(() => parseDirectorySearchLimit("999999999999999999999")).toThrow(
      "positive integer",
    );
  });
});

describe("parseActionGroupId", () => {
  it("accepts a trimmed alphanumeric identifier", () => {
    expect(parseActionGroupId(" a5331a93-1111 ")).toBe("a5331a93-1111");
    expect(parseActionGroupId(undefined)).toBeUndefined();
  });

  it("rejects unqueryable or oversized identifiers", () => {
    expect(() => parseActionGroupId("{a5331a93}")).toThrow(
      "Action group ID is invalid",
    );
    expect(() => parseActionGroupId("a".repeat(65))).toThrow(
      "Action group ID is invalid",
    );
  });
});

describe("inventoryPackageDetail", () => {
  it("removes exact assignment principals from Reader inventory", () => {
    expect(inventoryPackageDetail(allowlistedPackage({
      id: "package-1", displayName: "Fixture", isBlocked: false,
      allowedUsersAndGroups: [{ resourceType: "user", resourceId: "sensitive-user" }],
      acquireUsersAndGroups: [{ resourceType: "group", resourceId: "sensitive-group" }],
    }))).toEqual(allowlistedPackage({ id: "package-1", displayName: "Fixture", isBlocked: false }));
  });
});
