import { describe, expect, it, vi } from "vitest";
import type { PurviewAuditRepository } from "../db/purviewAudit.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { PurviewAuditFilters, PurviewAuditJob, PurviewAuditQualification, PurviewAuditResult, PurviewProviderQuery } from "../types/purviewAudit.js";
import { GraphAuditSearchClient, createProviderQueryBody } from "./graphAuditSearch.js";
import { PurviewAuditService } from "./purviewAudit.js";
import * as operationalState from "./operationalState.js";

vi.mock("connect-pg-simple", () => ({
  default: () => class {
    constructor() { throw new Error("Database session stores are outside the worker unit-test boundary."); }
  },
}));
vi.mock("../config.js", () => ({ config: { nodeEnv: "test" }, authConfigured: false, loginScopes: ["openid", "profile"] }));
vi.mock("../db/pool.js", () => ({
  pool: {},
  transaction: vi.fn(() => { throw new Error("Database access is outside the worker unit-test boundary."); }),
}));

const user: AuthenticatedUser = { homeAccountId: "reader-a", tenantId: "tenant-a", username: "reader@example.invalid", displayName: "Reader", roles: ["AgentControl.Viewer"], providerRoleIds: [] };
const filters: PurviewAuditFilters = { presetId: "copilot_interactions", operations: ["CopilotInteraction"], startDateTime: new Date(Date.now() - 30 * 60_000).toISOString(), endDateTime: new Date().toISOString(), userPrincipalNames: [], ipAddresses: [], objectIds: [], administrativeUnitIds: [] };

function job(overrides: Partial<PurviewAuditJob> = {}): PurviewAuditJob {
  return { id: "11111111-1111-4111-8111-111111111111", authorizationPrincipalId: user.homeAccountId,
    resultScope: { kind: "principal", scopeId: user.homeAccountId, configurationRevision: null }, tokenMode: "delegated", status: "waiting_authorization", filters,
    displayName: "agent-control-audit:11111111-1111-4111-8111-111111111111", providerQueryId: null, providerStatus: null,
    localRequestId: "22222222-2222-4222-8222-222222222222", providerRequestId: null, projectionVersion: 1, providerRequestCount: 0, activationCount: 0,
    pageCount: 0, providerRowCount: 0, storedRowCount: 0, byteCount: 0, unknownFieldCount: 0, pageComplete: false, observedRange: null, unobservedRange: null,
    qualificationId: null, cancelRequested: false, createdAt: new Date().toISOString(), attemptedAt: null, updatedAt: new Date().toISOString(), finishedAt: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), canResume: true, remoteWorkMayContinue: false, ...overrides };
}

function query(status: PurviewProviderQuery["status"]): PurviewProviderQuery {
  return { id: "provider-a", status, ...createProviderQueryBody(job().displayName, filters) };
}

function setup(overrides: Record<string, unknown> = {}) {
  let current = job();
  const execution: Pick<Awaited<ReturnType<PurviewAuditRepository["begin"]>>, "owner" | "version"> = { owner: "33333333-3333-4333-8333-333333333333", version: 1 };
  const repository = {
    getJob: vi.fn<PurviewAuditRepository["getJob"]>(async () => current), begin: vi.fn<PurviewAuditRepository["begin"]>(async () => {
      const action = current.providerQueryId ? "poll" : current.attemptedAt ? "reconcile" : "create";
      current = { ...current, status: action === "poll" ? "running" : "reconciling_create", activationCount: current.activationCount + 1 };
      return { ...execution, action, job: current };
    }), recordProviderQuery: vi.fn<PurviewAuditRepository["recordProviderQuery"]>(async (_scope, _id, _execution, id, status) => { current = { ...current, status: "running", providerQueryId: id, providerStatus: status }; }),
    recordProviderStatus: vi.fn<PurviewAuditRepository["recordProviderStatus"]>(async (_scope, _id, _execution, status) => { current = { ...current, providerStatus: status }; }),
    markWaitingAuthorization: vi.fn<PurviewAuditRepository["markWaitingAuthorization"]>(async () => {
      if (!["running", "reconciling_create"].includes(current.status)) throw new AppError(409, "audit_execution_lost", "The worker no longer owns this activation.");
      current = { ...current, status: "waiting_authorization" }; return current;
    }),
    publish: vi.fn<PurviewAuditRepository["publish"]>(async (_scope, _id, _execution, result) => { current = { ...current, status: result.complete ? "succeeded" : "partial", pageComplete: result.complete }; return current; }),
    fail: vi.fn<PurviewAuditRepository["fail"]>(async (_scope, _id, _execution, errorCode, message, inconclusive = false) => { current = { ...current, status: inconclusive ? "inconclusive" : "failed", errorCode, message }; return current; }),
    authorizeProviderRequest: vi.fn(async () => undefined), recordProviderResponse: vi.fn(async () => undefined),
    recoverInterrupted: vi.fn(async () => 0), getQualification: vi.fn<PurviewAuditRepository["getQualification"]>(async () => undefined), submit: vi.fn(), approveQualification: vi.fn(),
    listJobs: vi.fn<PurviewAuditRepository["listJobs"]>(async () => ({ value: [current], count: 1, limit: 20, offset: 0 })),
    listRecords: vi.fn(async () => ({ value: [], count: 0, limit: 100, offset: 0, job: current })),
    agentRecords: vi.fn(async () => ({ value: [], count: 0, limit: 25, offset: 50 })),
    cancel: vi.fn(async () => { current = { ...current, status: "cancelled" }; return current; }),
    delete: vi.fn(async () => {
      if (["running", "reconciling_create"].includes(current.status)) throw new AppError(409, "audit_job_state", "Stop an active Audit Search before deleting its local cache.");
    }),
  };
  const dependencies = {
    observeOperation: vi.fn(async (_id, _user, operation: (reportFailure: (error: unknown) => void) => Promise<unknown>) => operation(() => undefined)),
    delegatedToken: vi.fn(async () => "token"), applicationToken: vi.fn(async () => "application-token"), revalidateUser: vi.fn(async () => user),
    requireAvailable: vi.fn(async () => ({ authorized: true })), requireApplicationDataScope: vi.fn(async () => ({ enabled: true, sharedDataScope: true, revision: 1 })),
    applicationIdentity: () => undefined,
    qualificationContext: vi.fn(async () => ({ capabilityId: "purview.audit.search.delegated" as const, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 })),
    recordQualificationEvidence: vi.fn(async () => ({ authorized: true })), createQuery: vi.fn(async () => query("running")), getQuery: vi.fn(async () => query("succeeded")),
    listQueries: vi.fn(async () => ({ value: [query("running")], complete: true, nextLink: null })), listRecords: vi.fn(async () => ({ records: [], pageCount: 1, providerRowCount: 0, storedRowCount: 0, byteCount: 2, unknownFieldCount: 0, complete: true, nextLink: null, partialReason: null })),
    wait: vi.fn(async () => undefined), random: () => 0,
    ...overrides,
  };
  return { repository, dependencies, service: new PurviewAuditService(repository as never, dependencies as never), current: () => current, setCurrent: (value: PurviewAuditJob) => { current = value; } };
}

describe("Purview audit worker", () => {
  it.each(["create", "reconcile", "records"] as const)(
    "rechecks admission around durable %s request accounting without dispatch or partial publication", async action => {
      let closed = false;
      const admission = vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => {
        if (closed) throw new AppError(503, "maintenance", "Provider admissions are closed.");
      });
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        closed = true;
        return Response.json({ value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/security/auditLog/queries/provider-a/records?$skiptoken=next" });
      });
      const client = new GraphAuditSearchClient({ fetch, wait: vi.fn(), random: () => 0 });
      const fixture = setup({
        ...(action === "create" ? { createQuery: client.createQuery.bind(client) } : {}),
        ...(action === "reconcile" ? { listQueries: client.listQueries.bind(client) } : {}),
        ...(action === "records" ? { listRecords: client.listRecords.bind(client) } : {}),
      });
      if (action === "reconcile") fixture.setCurrent(job({ attemptedAt: new Date().toISOString() }));
      if (action !== "records") fixture.repository.authorizeProviderRequest.mockImplementationOnce(async () => { closed = true; });
      try {
        await fixture.service.start(user, job().id, "delegated");
        await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
        expect(fixture.repository.authorizeProviderRequest).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledTimes(action === "records" ? 1 : 0);
        expect(fixture.repository.publish).not.toHaveBeenCalled();
        expect(fixture.repository.fail).not.toHaveBeenCalled();
        expect(fixture.dependencies.recordQualificationEvidence).not.toHaveBeenCalled();
      } finally {
        await fixture.service.drain();
        admission.mockRestore();
      }
    },
  );

  it.each(["maintenance", "provider_requalification_required"])(
    "fences Audit Search resume and publication when admissions close: %s", async code => {
      for (const stage of ["start", "activation", "authorization", "collection"]) {
        const fixture = setup();
        let closed = stage === "start";
        const admission = vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => {
          if (closed) throw new AppError(503, code, "Provider admissions are closed.");
        });
        if (stage === "activation") {
          const begin = fixture.repository.begin.getMockImplementation()!;
          fixture.repository.begin.mockImplementationOnce(async (...args) => {
            const activation = await begin(...args);
            closed = true;
            return activation;
          });
        }
        if (stage === "authorization") fixture.dependencies.revalidateUser.mockImplementationOnce(async () => { closed = true; return user; });
        if (stage === "collection") {
          const records = fixture.dependencies.listRecords.getMockImplementation()!;
          fixture.dependencies.listRecords.mockImplementationOnce(async () => { closed = true; return records(); });
        }
        try {
          if (stage === "start" || stage === "activation") {
            await expect(async () => fixture.service.start(user, job().id, "delegated")).rejects.toMatchObject({ status: 503, code });
            if (stage === "start") expect(fixture.repository.begin).not.toHaveBeenCalled();
            else expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce();
          } else {
            await fixture.service.start(user, job().id, "delegated");
            await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
          }
          if (stage !== "collection") expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
          expect(fixture.repository.publish).not.toHaveBeenCalled();
          expect(fixture.repository.fail).not.toHaveBeenCalled();
          expect(fixture.dependencies.recordQualificationEvidence).not.toHaveBeenCalled();
          await expect(fixture.service.get(user, job().id)).resolves.toMatchObject({ id: job().id });
        } finally {
          await fixture.service.drain();
          admission.mockRestore();
        }
      }
    },
  );

  it("passes an exact user history filter to saved reads without querying Microsoft", async () => {
    const fixture = setup();
    await fixture.service.list(user, 20, 40, "employee+test@example.invalid");
    expect(fixture.repository.listJobs).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: user.tenantId, resultScopes: [{ kind: "principal", scopeId: user.homeAccountId, configurationRevision: null }],
    }), 20, 40, "employee+test@example.invalid");
    expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
    expect(fixture.dependencies.delegatedToken).not.toHaveBeenCalled();
  });

  it.each(["", "concealed", "a @example.invalid", "a@example.invalid\n", ["a@example.invalid"], "a".repeat(321) + "@x"])(
    "rejects malformed user history scope %j instead of widening the query", async userPrincipalName => {
    const fixture = setup();
    await expect(fixture.service.list(user, 20, 0, userPrincipalName)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    expect(fixture.repository.listJobs).not.toHaveBeenCalled();
  });

  it("exposes the actual provider denial to operation reporting before job error conversion and never replays create", async () => {
    const denied = new AppError(403, "provider_denied", "Microsoft denied the operation");
    const fixture = setup({ createQuery: vi.fn(async () => { throw denied; }) });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.fail.mock.calls.length + fixture.repository.markWaitingAuthorization.mock.calls.length).toBe(1));
    expect(fixture.dependencies.createQuery).toHaveBeenCalledOnce();
    expect(fixture.dependencies.getQuery).not.toHaveBeenCalled();
    expect(fixture.dependencies.observeOperation).toHaveBeenCalledTimes(2);
    await expect(fixture.dependencies.observeOperation.mock.results[1].value).rejects.toBe(denied);
  });

  it("reconciles a create cancelled after JSON completion without replaying the POST", async () => {
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds =>
      milliseconds === 1_337 ? deadline.signal : timeout(milliseconds));
    const body = new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode(JSON.stringify(query("succeeded")))); },
      pull(stream) {
        stream.close();
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => queueMicrotask(() =>
          deadline.abort(new DOMException("attempt expired", "TimeoutError"))))));
      },
    }, { highWaterMark: 0 });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { status: 201 }));
    const client = new GraphAuditSearchClient({ fetch: fetcher, wait: vi.fn(), random: () => 0, requestTimeoutMs: 1_337 });
    const fixture = setup({ createQuery: client.createQuery.bind(client) });
    fixture.dependencies.listQueries.mockImplementationOnce(async () => {
      expect(fixture.repository.recordProviderQuery).not.toHaveBeenCalled();
      return { value: [query("succeeded")], complete: true, nextLink: null };
    });
    try {
      await fixture.service.start(user, job().id, "delegated");
      await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
      expect(fixture.dependencies.listQueries).toHaveBeenCalledOnce();
      expect(fixture.repository.recordProviderQuery).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
      expect(body.locked).toBe(false);
    } finally {
      await fixture.service.drain();
      timeoutSpy.mockRestore();
    }
  });

  it.each(["authorizeProviderRequest", "recordProviderResponse"] as const)(
    "never publishes partial provider evidence when %s exceeds the adapter deadline", async hook => {
      const stalled = Promise.withResolvers<void>();
      const client = new GraphAuditSearchClient({
        fetch: vi.fn(async () => Response.json({
          value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/security/auditLog/queries/provider-a/records?$skiptoken=next",
        })),
        wait: vi.fn(), random: () => 0, requestTimeoutMs: 20,
      });
      const fixture = setup({
        createQuery: vi.fn(async () => query("succeeded")),
        listRecords: client.listRecords.bind(client),
      });
      fixture.repository[hook].mockResolvedValueOnce(undefined).mockImplementation(() => stalled.promise);
      try {
        await fixture.service.start(user, job().id, "delegated");
        await vi.waitFor(() => expect(fixture.repository.fail).toHaveBeenCalledOnce());
        expect(fixture.current()).toMatchObject({ status: "failed", errorCode: "internal_error" });
        expect(fixture.repository.publish).not.toHaveBeenCalled();
        expect(fixture.dependencies.recordQualificationEvidence).toHaveBeenCalledWith(
          "purview.audit.search.delegated", user, "provider_error", { category: "internal_error", providerRequestId: null }, undefined,
        );
      } finally { stalled.resolve(); }
    },
  );

  it("reads saved agent Purview records using only server-resolved environment/bot and current authorized scopes", async () => {
    const recordId = "agent:11111111-1111-4111-8111-111111111111";
    const target = { environmentId: "environment-a", botId: "22222222-2222-4222-8222-222222222222" };
    const agentContext = vi.fn(async () => ({ context: { recordId, purview: { status: "available", mode: "saved_only" } }, purviewTarget: target }));
    const fixture = setup({ agentContext });
    await expect(fixture.service.agentRecords(user, recordId, { limit: 25, offset: 50, search: "actor" }))
      .resolves.toEqual({ recordId, mode: "saved_only", value: [], count: 0, limit: 25, offset: 50 });
    expect(fixture.repository.agentRecords).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: user.tenantId, resultScopes: [{ kind: "principal", scopeId: user.homeAccountId, configurationRevision: null }],
    }), target, { limit: 25, offset: 50, search: "actor" });
    expect(agentContext).toHaveBeenCalledTimes(2);
    for (const provider of [fixture.dependencies.createQuery, fixture.dependencies.getQuery, fixture.dependencies.listRecords,
      fixture.dependencies.delegatedToken, fixture.dependencies.applicationToken, fixture.dependencies.requireAvailable]) {
      expect(provider).not.toHaveBeenCalled();
    }
    await expect(fixture.service.agentRecords({ ...user, roles: [] }, recordId, { limit: 25, offset: 0 })).rejects.toMatchObject({ status: 403 });
  });

  it("fails closed when saved Purview identity is missing or changes while reading", async () => {
    const recordId = "agent:11111111-1111-4111-8111-111111111111";
    const unavailable = { context: { recordId, purview: { status: "unavailable", reason: "No exact bot identity", mode: "saved_only" } } };
    const agentContext = vi.fn(async () => unavailable);
    const fixture = setup({ agentContext });
    await expect(fixture.service.agentRecords(user, recordId, { limit: 25, offset: 0 })).rejects.toMatchObject({ code: "agent_investigation_unavailable" });
    expect(fixture.repository.agentRecords).not.toHaveBeenCalled();
    agentContext.mockResolvedValueOnce({ ...unavailable, purviewTarget: { environmentId: "environment-a", botId: "bot-a" } } as never);
    await expect(fixture.service.agentRecords(user, recordId, { limit: 25, offset: 0 })).rejects.toMatchObject({ code: "agent_identity_changed" });
    expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
  });

  it("withholds agent Purview results if the authorized application retained scope changes during the read", async () => {
    const recordId = "agent:11111111-1111-4111-8111-111111111111";
    let revision = 1;
    const fixture = setup({
      applicationIdentity: () => "application-client",
      requireApplicationDataScope: vi.fn(async () => ({ enabled: true, sharedDataScope: true, revision })),
      agentContext: vi.fn(async () => ({ context: { recordId, purview: { status: "available", mode: "saved_only" } },
        purviewTarget: { environmentId: "environment-a", botId: "22222222-2222-4222-8222-222222222222" } })),
    });
    fixture.repository.agentRecords.mockImplementation(async () => {
      revision = 2;
      return { value: [], count: 0, limit: 25, offset: 50 };
    });
    await expect(fixture.service.agentRecords(user, recordId, { limit: 25, offset: 50 })).rejects.toMatchObject({ code: "audit_scope_changed" });
    expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
    expect(fixture.dependencies.delegatedToken).not.toHaveBeenCalled();
  });

  it("binds saved inventory associations to the current Viewer even without directory-role claims", async () => {
    const fixture = setup();
    await fixture.service.list(user);
    expect(fixture.repository.listJobs.mock.calls[0][0]).toMatchObject({
      inventoryIdentityScope: { principalId: user.homeAccountId, resourceTypes: expect.arrayContaining(["microsoft.copilotstudio/agents"]) },
    });
    await expect(fixture.service.list({ ...user, roles: [] })).rejects.toMatchObject({ status: 403 });
    expect(fixture.repository.listJobs).toHaveBeenCalledOnce();
    expect(fixture.dependencies.delegatedToken).not.toHaveBeenCalled();
  });

  it("returns a durable job promptly and completes create, poll, records and publication in the background", async () => {
    const fixture = setup();
    await expect(fixture.service.start(user, job().id, "delegated")).resolves.toMatchObject({ id: job().id });
    await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
    expect(fixture.dependencies.createQuery).toHaveBeenCalledOnce();
    expect(fixture.dependencies.getQuery).toHaveBeenCalledOnce();
    expect(fixture.dependencies.listRecords).toHaveBeenCalledOnce();
    expect(fixture.current().providerStatus).toBe("succeeded");
    expect(fixture.dependencies.delegatedToken).toHaveBeenCalledWith(user.homeAccountId, "purview.audit.search.delegated");
    expect(fixture.dependencies.recordQualificationEvidence).toHaveBeenCalledWith(
      "purview.audit.search.delegated",
      user,
      "available",
      expect.objectContaining({ providerRequestId: null }),
      undefined,
    );
  });

  it.each(["create", "reconcile"] as const)(
    "verifies the delegated single-query GET before qualifying an immediately successful %s", async action => {
      const fixture = setup({
        createQuery: vi.fn(async () => query("succeeded")),
        listQueries: vi.fn(async () => ({ value: [query("succeeded")], complete: true, nextLink: null })),
      });
      fixture.setCurrent(job({ attemptedAt: action === "reconcile" ? new Date().toISOString() : null }));
      await fixture.service.start(user, job().id, "delegated");
      await vi.waitFor(() => expect(fixture.dependencies.recordQualificationEvidence).toHaveBeenCalledOnce());
      await fixture.service.drain();
      expect(fixture.dependencies.getQuery).toHaveBeenCalledOnce();
      expect(fixture.repository.recordProviderStatus).toHaveBeenCalledWith(
        expect.anything(), job().id, expect.anything(), "succeeded",
      );
      expect(fixture.dependencies.recordQualificationEvidence).toHaveBeenCalledWith(
        "purview.audit.search.delegated", user, "available", expect.anything(), undefined,
      );
    },
  );

  it("does not qualify an immediately completed delegated query when its single-query GET is denied", async () => {
    const fixture = setup({
      createQuery: vi.fn(async () => query("succeeded")),
      getQuery: vi.fn(async () => { throw new AppError(403, "provider_denied", "Single-query GET was denied."); }),
    });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    await fixture.service.drain();
    expect(fixture.dependencies.listRecords).not.toHaveBeenCalled();
    expect(fixture.repository.publish).not.toHaveBeenCalled();
    expect(fixture.dependencies.recordQualificationEvidence).not.toHaveBeenCalled();
  });

  it("keeps a completed provider query resumable when final publication authorization times out", async () => {
    const publicationDeadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds =>
      milliseconds === 10_000 ? publicationDeadline.signal : timeout(milliseconds));
    let releaseUser!: (value: AuthenticatedUser) => void;
    const pendingUser = new Promise<AuthenticatedUser>(resolve => { releaseUser = resolve; });
    const fixture = setup({
      revalidateUser: vi.fn(async () => user).mockResolvedValueOnce(user).mockReturnValueOnce(pendingUser),
    });
    try {
      await fixture.service.start(user, job().id, "delegated");
      await vi.waitFor(() => expect(fixture.dependencies.revalidateUser).toHaveBeenCalledTimes(2));
      publicationDeadline.abort(new DOMException("publication authorization expired", "TimeoutError"));
      await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
      expect(fixture.current()).toMatchObject({ status: "waiting_authorization", providerQueryId: "provider-a", providerStatus: "succeeded" });
      expect(fixture.repository.fail).not.toHaveBeenCalled();
      expect(fixture.repository.publish).not.toHaveBeenCalled();
      expect(fixture.dependencies.recordQualificationEvidence).not.toHaveBeenCalled();
      releaseUser(user);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(fixture.repository.publish).not.toHaveBeenCalled();
      timeoutSpy.mockRestore();
      await fixture.service.start(user, job().id, "delegated");
      await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
      expect(fixture.dependencies.createQuery).toHaveBeenCalledOnce();
      expect(fixture.dependencies.getQuery).toHaveBeenCalledTimes(2);
      expect(fixture.current()).toMatchObject({ status: "succeeded" });
    } finally {
      releaseUser(user);
      await fixture.service.drain();
      timeoutSpy.mockRestore();
    }
  });

  it("returns the activated durable job while account revalidation is still pending", async () => {
    let release!: (value: AuthenticatedUser) => void;
    const pendingUser = new Promise<AuthenticatedUser>(resolve => { release = resolve; });
    const fixture = setup({ revalidateUser: vi.fn(() => pendingUser) });
    try {
      await expect(fixture.service.start(user, job().id, "delegated")).resolves.toMatchObject({ id: job().id, status: "reconciling_create" });
      expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
    } finally {
      release(user);
      await fixture.service.drain();
    }
  });

  it("publishes retained partial rows after the activation deadline using fresh bounded authorization", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const partial: PurviewAuditResult = { records: [], pageCount: 1, providerRowCount: 0, storedRowCount: 0, byteCount: 2,
      unknownFieldCount: 0, complete: false, nextLink: "https://graph.microsoft.com/v1.0/security/auditLog/queries/provider-a/records?$skiptoken=next", partialReason: "audit_activation_timeout" };
    const fixture = setup({ listRecords: vi.fn(async () => {
      deadline.abort(new DOMException("activation expired", "TimeoutError"));
      return partial;
    }) });
    try {
      await fixture.service.start(user, job().id, "delegated");
      await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledWith(expect.anything(), job().id, expect.anything(), partial));
      expect(fixture.current()).toMatchObject({ status: "partial", pageComplete: false });
      expect(fixture.dependencies.recordQualificationEvidence).not.toHaveBeenCalled();
      expect(fixture.dependencies.revalidateUser).toHaveBeenCalledTimes(2);
      expect(fixture.repository.markWaitingAuthorization).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      await fixture.service.drain();
    }
  });

  it.each(["cancel", "delete"] as const)("does not abort another principal's active worker on rejected %s", async action => {
    let release!: (value: string) => void;
    const fixture = setup({ delegatedToken: vi.fn(() => new Promise<string>(resolve => { release = resolve; })) });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.dependencies.delegatedToken).toHaveBeenCalledOnce());
    fixture.repository.getJob.mockResolvedValueOnce(undefined);
    await expect(fixture.service[action]({ ...user, homeAccountId: "other-reader" }, job().id)).rejects.toMatchObject({ code: "not_found" });
    expect(fixture.repository[action]).not.toHaveBeenCalled();
    release("token");
    await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
    await fixture.service.drain();
  });

  it("registers a held repository lookup before drain and fences its late completion", async () => {
    let release!: (value: PurviewAuditJob) => void;
    const pendingJob = new Promise<PurviewAuditJob>(resolve => { release = resolve; });
    const fixture = setup();
    fixture.repository.getJob.mockImplementationOnce(() => pendingJob);
    const starting = fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.getJob).toHaveBeenCalledOnce());
    await expect(fixture.service.drain()).resolves.toBeUndefined();
    await expect(starting).rejects.toMatchObject({ code: "interaction_required" });
    release(job());
    expect(fixture.repository.begin).not.toHaveBeenCalled();
  });

  it("cancels a held native token acquisition without publishing late work", async () => {
    let release!: (value: string) => void;
    const pendingToken = new Promise<string>(resolve => { release = resolve; });
    const fixture = setup({ delegatedToken: vi.fn(() => pendingToken) });
    await expect(fixture.service.start(user, job().id, "delegated")).resolves.toMatchObject({ status: "reconciling_create" });
    await vi.waitFor(() => expect(fixture.dependencies.delegatedToken).toHaveBeenCalledOnce());
    await fixture.service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
    await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    release("late-token");
    await fixture.service.drain();
    expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
    expect(fixture.repository.publish).not.toHaveBeenCalled();
  });

  it("rejects application publication after the configured application scope revision changes", async () => {
    let revision = 7;
    let releaseRecords!: (value: PurviewAuditResult) => void;
    const pendingRecords = new Promise<PurviewAuditResult>(resolve => { releaseRecords = resolve; });
    const fixture = setup({
      applicationIdentity: () => "application-client",
      requireApplicationDataScope: vi.fn(async () => ({ enabled: true, sharedDataScope: true, revision })),
      applicationToken: vi.fn(async () => "application-token"),
      createQuery: vi.fn(async () => query("succeeded")),
      listRecords: vi.fn(() => pendingRecords),
    });
    fixture.setCurrent(job({ tokenMode: "application", resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 7 } }));
    await expect(fixture.service.start(user, job().id, "application")).resolves.toMatchObject({ status: "reconciling_create" });
    await vi.waitFor(() => expect(fixture.dependencies.listRecords).toHaveBeenCalledOnce());
    revision = 8;
    releaseRecords({ records: [], pageCount: 1, providerRowCount: 0, storedRowCount: 0, byteCount: 2, unknownFieldCount: 0, complete: true, nextLink: null, partialReason: null });
    await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    expect(fixture.repository.publish).not.toHaveBeenCalled();
  });

  it("fences logout before a starting repository lookup can enter execution", async () => {
    let release!: (value: PurviewAuditJob) => void;
    const pendingJob = new Promise<PurviewAuditJob>(resolve => { release = resolve; });
    const fixture = setup();
    fixture.repository.getJob.mockImplementationOnce(() => pendingJob);
    const starting = fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.getJob).toHaveBeenCalledOnce());
    await fixture.service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
    await expect(starting).rejects.toMatchObject({ code: "interaction_required" });
    release(job());
    expect(fixture.repository.begin).not.toHaveBeenCalled();
  });

  it("keeps shutdown pending until an interrupted activation commits and its release finishes", async () => {
    const fixture = setup();
    const activation: Awaited<ReturnType<PurviewAuditRepository["begin"]>> = { action: "create", owner: "33333333-3333-4333-8333-333333333333", version: 1,
      job: job({ status: "reconciling_create", activationCount: 1 }) };
    const reservation = Promise.withResolvers<typeof activation>();
    const cleanup = Promise.withResolvers<void>();
    fixture.repository.begin.mockReturnValueOnce(reservation.promise);
    const markWaiting = fixture.repository.markWaitingAuthorization.getMockImplementation()!;
    fixture.repository.markWaitingAuthorization.mockImplementationOnce(async (...args) => {
      await cleanup.promise;
      return markWaiting(...args);
    });
    const starting = fixture.service.start(user, job().id, "delegated");
    const rejected = expect(starting).rejects.toMatchObject({ code: "interaction_required" });
    let drained = false;
    let draining: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(fixture.repository.begin).toHaveBeenCalledOnce());
      draining = fixture.service.drain().then(() => { drained = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(drained).toBe(false);
      fixture.setCurrent(activation.job);
      reservation.resolve(activation);
      await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledWith(expect.anything(), job().id, activation));
      expect(drained).toBe(false);
      cleanup.resolve();
      await rejected;
      await draining;
      expect(drained).toBe(true);
      expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
    } finally {
      fixture.setCurrent(activation.job);
      reservation.resolve(activation);
      cleanup.resolve();
      await rejected;
      await draining;
    }
  });

  it("rejects new starts once shutdown has begun", async () => {
    const fixture = setup();
    await fixture.service.drain();
    await expect(async () => fixture.service.start(user, job().id, "delegated")).rejects.toMatchObject({ code: "audit_shutdown" });
    expect(fixture.repository.getJob).not.toHaveBeenCalled();
    expect(fixture.repository.begin).not.toHaveBeenCalled();
  });

  it("reports failure to persist a shutdown pause instead of swallowing it", async () => {
    const fixture = setup({ delegatedToken: vi.fn(() => new Promise<string>(() => undefined)) });
    const failure = new Error("Pause persistence failed");
    fixture.repository.markWaitingAuthorization.mockRejectedValueOnce(failure);
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.dependencies.delegatedToken).toHaveBeenCalledOnce());
    await expect(fixture.service.drain()).rejects.toBe(failure);
    expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
  });

  it("reports failure to release an activation that committed during shutdown", async () => {
    const fixture = setup();
    const activation: Awaited<ReturnType<PurviewAuditRepository["begin"]>> = { action: "create", owner: "33333333-3333-4333-8333-333333333333", version: 1,
      job: job({ status: "reconciling_create", activationCount: 1 }) };
    const reservation = Promise.withResolvers<typeof activation>();
    const failure = new Error("Activation release failed");
    fixture.repository.begin.mockReturnValueOnce(reservation.promise);
    fixture.repository.markWaitingAuthorization.mockRejectedValueOnce(failure);
    const starting = fixture.service.start(user, job().id, "delegated");
    const startedResult = Promise.allSettled([starting]);
    await vi.waitFor(() => expect(fixture.repository.begin).toHaveBeenCalledOnce());
    const draining = expect(fixture.service.drain()).rejects.toBe(failure);
    fixture.setCurrent(activation.job);
    reservation.resolve(activation);
    await draining;
    expect(await startedResult).toEqual([{ status: "rejected", reason: failure }]);
    expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
  });

  it("retains publication ownership until an in-flight write settles during shutdown", async () => {
    const fixture = setup({ createQuery: vi.fn(async () => query("succeeded")) });
    const publication = Promise.withResolvers<PurviewAuditJob>();
    fixture.repository.publish.mockReturnValueOnce(publication.promise);
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
    let drained = false;
    const draining = fixture.service.drain().then(() => { drained = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(drained).toBe(false);
      expect(fixture.repository.markWaitingAuthorization).not.toHaveBeenCalled();
    } finally {
      fixture.setCurrent(job({ status: "succeeded" }));
      publication.resolve(fixture.current());
      await draining;
    }
    expect(drained).toBe(true);
    expect(fixture.dependencies.recordQualificationEvidence).not.toHaveBeenCalled();
  });

  it.each(["available", "provider_error"] as const)(
    "joins an already-started %s capability-evidence write during shutdown", async status => {
      let releaseEvidence!: () => void;
      const evidence = new Promise<void>(resolve => { releaseEvidence = resolve; });
      const fixture = setup({
        createQuery: vi.fn(async () => {
          if (status === "provider_error") throw new AppError(502, "provider_error", "Provider unavailable.");
          return query("succeeded");
        }),
        recordQualificationEvidence: vi.fn(async () => { await evidence; return { authorized: true }; }),
      });
      await fixture.service.start(user, job().id, "delegated");
      await vi.waitFor(() => expect(fixture.dependencies.recordQualificationEvidence).toHaveBeenCalledOnce());
      let drained = false;
      const draining = fixture.service.drain().then(() => { drained = true; });
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(drained).toBe(false);
      } finally {
        releaseEvidence();
        await draining;
      }
      expect(drained).toBe(true);
    },
  );

  it("does not restore capability evidence after session revocation races with result persistence", async () => {
    let releasePublication!: (value: PurviewAuditJob) => void;
    const publication = new Promise<PurviewAuditJob>(resolve => { releasePublication = resolve; });
    const fixture = setup();
    fixture.repository.publish.mockReturnValueOnce(publication);
    let revocation: Promise<void> | undefined;
    try {
      await fixture.service.start(user, job().id, "delegated");
      await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
      revocation = revokeAccountSessionMutations(user.tenantId!, user.homeAccountId, async () => undefined);
      fixture.setCurrent(job({ status: "succeeded" }));
      releasePublication(fixture.current());
      await revocation;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(fixture.dependencies.recordQualificationEvidence).not.toHaveBeenCalled();
    } finally {
      releasePublication(fixture.current());
      await revocation;
      await fixture.service.drain();
      await activateAccountSession(user.tenantId!, user.homeAccountId, async () => undefined);
    }
  });

  it.each([
    { ...user, homeAccountId: "other-reader" },
    { ...user, roles: [] },
  ])("does not record failure evidence under changed authority: %j", async changedUser => {
    const fixture = setup({
      createQuery: vi.fn(async () => { throw new AppError(502, "provider_error", "Provider unavailable."); }),
      revalidateUser: vi.fn(async () => user).mockResolvedValueOnce(user).mockResolvedValueOnce(changedUser),
    });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.dependencies.revalidateUser).toHaveBeenCalledTimes(2));
    await new Promise<void>(resolve => setImmediate(resolve));
    await fixture.service.drain();
    expect(fixture.repository.fail).toHaveBeenCalledOnce();
    expect(fixture.dependencies.recordQualificationEvidence).not.toHaveBeenCalled();
  });

  it("releases an activation when its deadline races with reservation handoff", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const fixture = setup();
    const activation: Awaited<ReturnType<PurviewAuditRepository["begin"]>> = { action: "create", owner: "33333333-3333-4333-8333-333333333333", version: 1,
      job: job({ status: "reconciling_create", activationCount: 1 }) };
    let release!: (value: typeof activation) => void;
    fixture.repository.begin.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const starting = Promise.allSettled([fixture.service.start(user, job().id, "delegated")]);
    try {
      await vi.waitFor(() => expect(fixture.repository.begin).toHaveBeenCalledOnce());
      fixture.setCurrent(activation.job);
      release(activation);
      queueMicrotask(() => deadline.abort(new DOMException("activation expired", "TimeoutError")));
      await starting;
      await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
      expect(fixture.current().status).toBe("waiting_authorization");
      expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
    } finally {
      release(activation);
      timeout.mockRestore();
      await fixture.service.drain();
      await starting;
    }
  });

  it("returns an existing terminal job without reserving another activation", async () => {
    const fixture = setup();
    fixture.setCurrent(job({ status: "succeeded", canResume: false, finishedAt: new Date().toISOString() }));
    await expect(fixture.service.start(user, job().id, "delegated")).resolves.toMatchObject({ status: "succeeded" });
    expect(fixture.repository.begin).not.toHaveBeenCalled();
  });

  it("reuses one active reservation for duplicate starts of the same running job", async () => {
    const pendingUser = new Promise<AuthenticatedUser>(() => undefined);
    const fixture = setup({ revalidateUser: vi.fn(() => pendingUser) });
    const first = await fixture.service.start(user, job().id, "delegated");
    const second = await fixture.service.start(user, job().id, "delegated");
    expect(first.id).toBe(second.id);
    expect(fixture.repository.begin).toHaveBeenCalledOnce();
    await fixture.service.drain();
  });

  it.each([
    { actor: { ...user, homeAccountId: "other-reader" }, tokenMode: "delegated" as const },
    { actor: user, tokenMode: "application" as const },
  ])("preserves the active reservation after a start with different authority: %j", async ({ actor, tokenMode }) => {
    let release!: (value: string) => void;
    const fixture = setup({ delegatedToken: vi.fn(() => new Promise<string>(resolve => { release = resolve; })) });
    try {
      await fixture.service.start(user, job().id, "delegated");
      await vi.waitFor(() => expect(fixture.dependencies.delegatedToken).toHaveBeenCalledOnce());
      await expect(fixture.service.start(actor, job().id, tokenMode)).rejects.toMatchObject({ code: "not_found" });
      await fixture.service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
      await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
      expect(fixture.repository.begin).toHaveBeenCalledOnce();
      expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
    } finally {
      release("token");
      await fixture.service.drain();
    }
  });

  it("uses one activation for either casing of a durable UUID", async () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const fixture = setup({ revalidateUser: vi.fn(() => new Promise<AuthenticatedUser>(() => undefined)) });
    fixture.setCurrent(job({ id }));
    const first = fixture.service.start(user, id.toUpperCase(), "delegated");
    const second = fixture.service.start(user, id, "delegated");
    const settled = Promise.allSettled([first, second]);
    try {
      expect(second).toBe(first);
      await first;
      expect(fixture.repository.begin).toHaveBeenCalledOnce();
    } finally {
      await fixture.service.drain();
      await settled;
    }
  });

  it.each(["cancel", "delete"] as const)("does not stop an active worker when %s is rejected by persistence", async action => {
    let release!: (value: string) => void;
    const fixture = setup({ delegatedToken: vi.fn(() => new Promise<string>(resolve => { release = resolve; })) });
    if (action === "cancel") fixture.repository.cancel.mockRejectedValueOnce(new AppError(503, "database_unavailable", "Cancellation did not commit."));
    try {
      await fixture.service.start(user, job().id, "delegated");
      await vi.waitFor(() => expect(fixture.dependencies.delegatedToken).toHaveBeenCalledOnce());
      await expect(fixture.service[action](user, job().id)).rejects.toMatchObject({ code: action === "cancel" ? "database_unavailable" : "audit_job_state" });
      release("token");
      await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
      expect(fixture.repository.markWaitingAuthorization).not.toHaveBeenCalled();
    } finally {
      release("token");
      await fixture.service.drain();
    }
  });

  it("cancels the canonical activation when addressed with an uppercase UUID", async () => {
    let release!: (value: string) => void;
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const fixture = setup({ delegatedToken: vi.fn(() => new Promise<string>(resolve => { release = resolve; })) });
    fixture.setCurrent(job({ id }));
    try {
      await fixture.service.start(user, id, "delegated");
      await vi.waitFor(() => expect(fixture.dependencies.delegatedToken).toHaveBeenCalledOnce());
      await expect(fixture.service.cancel(user, id.toUpperCase())).resolves.toMatchObject({ status: "cancelled" });
      await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
      release("token");
      await fixture.service.drain();
      expect(fixture.current().status).toBe("cancelled");
      expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
    } finally {
      release("token");
      await fixture.service.drain();
    }
  });

  it("returns the fifth durable waiting job when all four activation slots are occupied", async () => {
    const pendingUser = new Promise<AuthenticatedUser>(() => undefined);
    const fixture = setup({ revalidateUser: vi.fn(() => pendingUser) });
    fixture.repository.getJob.mockImplementation(async (_scope, id: string) => job({ id }));
    fixture.repository.begin.mockImplementation(async (_scope, id: string) => ({ action: "create" as const,
      owner: "33333333-3333-4333-8333-333333333333", version: 1, job: job({ id, status: "reconciling_create", activationCount: 1 }) }));
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
    ];
    for (const id of ids.slice(0, 4)) await expect(fixture.service.start(user, id, "delegated")).resolves.toMatchObject({ id, status: "reconciling_create" });
    await expect(fixture.service.start(user, ids[4], "delegated")).resolves.toMatchObject({ id: ids[4], status: "waiting_authorization" });
    expect(fixture.repository.begin).toHaveBeenCalledTimes(4);
    await fixture.service.drain();
  });

  it("contains a pre-provider background failure and persists it", async () => {
    const fixture = setup({ revalidateUser: vi.fn(async () => { throw new Error("validation unavailable"); }) });
    await expect(fixture.service.start(user, job().id, "delegated")).resolves.toMatchObject({ id: job().id });
    await expect(fixture.service.drain()).resolves.toBeUndefined();
    expect(fixture.repository.fail).toHaveBeenCalledOnce();
    expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
  });

  it("persists application searches in the configured shared result scope", async () => {
    const fixture = setup({
      applicationIdentity: () => "application-client",
      requireApplicationDataScope: vi.fn(async () => ({ enabled: true, sharedDataScope: true, revision: 7 })),
    });
    fixture.repository.submit.mockResolvedValue(job({ tokenMode: "application" }));

    await fixture.service.submit(user, { tokenMode: "application", filters, idempotencyKey: "shared-search" });

    expect(fixture.repository.submit).toHaveBeenCalledWith({
      tenantId: user.tenantId,
      authorizationPrincipalId: user.homeAccountId,
      resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 7 },
      tokenMode: "application",
    }, { idempotencyKey: "shared-search", filters });
  });

  it("reconciles an ambiguous create by exact durable marker without a second POST", async () => {
    const fixture = setup({ createQuery: vi.fn(async () => { throw new AppError(409, "audit_create_inconclusive", "unknown"); }) });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
    expect(fixture.dependencies.createQuery).toHaveBeenCalledOnce();
    expect(fixture.dependencies.listQueries).toHaveBeenCalledOnce();
    expect(fixture.repository.recordProviderQuery).toHaveBeenCalledWith(expect.anything(), job().id, expect.objectContaining({ version: 1 }), "provider-a", "running");
  });

  it("leaves a still-running provider query resumable after bounded polls", async () => {
    const fixture = setup({ getQuery: vi.fn(async () => query("running")) });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    expect(fixture.dependencies.getQuery).toHaveBeenCalledTimes(6);
    expect(fixture.repository.publish).not.toHaveBeenCalled();
  });

  it("counts the initial resume GET toward the activation poll limit", async () => {
    const fixture = setup({ getQuery: vi.fn(async () => query("running")) });
    fixture.setCurrent(job({ providerQueryId: "provider-a", providerStatus: "running" }));
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    expect(fixture.dependencies.getQuery).toHaveBeenCalledTimes(6);
    expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
    await fixture.service.drain();
  });

  it.each(["succeeded", "failed", "cancelled", "unknownFutureValue"] as const)("persists terminal provider status %s on the final allowed poll", async status => {
    let polls = 0;
    const fixture = setup({ getQuery: vi.fn(async () => query(++polls === 6 ? status : "running")) });
    await fixture.service.start(user, job().id, "delegated");
    if (status === "succeeded") {
      await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
      expect(fixture.repository.fail).not.toHaveBeenCalled();
      expect(fixture.dependencies.listRecords).toHaveBeenCalledOnce();
    } else {
      await vi.waitFor(() => expect(fixture.repository.fail).toHaveBeenCalledWith(
        expect.anything(), job().id, expect.anything(), "provider_query_failed", expect.any(String), false,
      ));
      expect(fixture.dependencies.listRecords).not.toHaveBeenCalled();
    }
    expect(fixture.current()).toMatchObject({ status: status === "succeeded" ? "succeeded" : "failed", providerStatus: status });
    expect(fixture.dependencies.getQuery).toHaveBeenCalledTimes(6);
    expect(fixture.repository.markWaitingAuthorization).not.toHaveBeenCalled();
    await fixture.service.drain();
  });

  it("rejects create responses outside the durable filters before binding their ID", async () => {
    const fixture = setup({ createQuery: vi.fn(async () => ({ ...query("succeeded"), operationFilters: ["Other"] })) });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.fail).toHaveBeenCalledWith(expect.anything(), job().id, expect.anything(), "provider_schema", expect.any(String), true));
    expect(fixture.repository.recordProviderQuery).not.toHaveBeenCalled();
    expect(fixture.dependencies.listRecords).not.toHaveBeenCalled();
  });

  it.each([
    { id: "different-query" },
    { displayName: "agent-control-audit:99999999-9999-4999-8999-999999999999" },
    { operationFilters: ["Other"] },
  ])("rejects polling identity or filter changes: %j", async changes => {
    const fixture = setup({ getQuery: vi.fn(async () => ({ ...query("succeeded"), ...changes })) });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.fail).toHaveBeenCalledWith(expect.anything(), job().id, expect.anything(), "provider_schema", expect.any(String), true));
    expect(fixture.repository.recordProviderStatus).not.toHaveBeenCalled();
    expect(fixture.dependencies.listRecords).not.toHaveBeenCalled();
    expect(fixture.repository.publish).not.toHaveBeenCalled();
  });

  it("does not bind a create marker from an incomplete query listing", async () => {
    const fixture = setup({
      createQuery: vi.fn(async () => { throw new AppError(409, "audit_create_inconclusive", "unknown"); }),
      listQueries: vi.fn(async () => ({ value: [query("running")], complete: false, nextLink: "https://graph.microsoft.com/v1.0/security/auditLog/queries?$skiptoken=unseen" })),
    });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    expect(fixture.dependencies.createQuery).toHaveBeenCalledOnce();
    expect(fixture.repository.recordProviderQuery).not.toHaveBeenCalled();
    expect(fixture.dependencies.listRecords).not.toHaveBeenCalled();
    expect(fixture.repository.publish).not.toHaveBeenCalled();
  });

  it("publishes qualification evidence only after the approved complete lifecycle", async () => {
    const qualification: PurviewAuditQualification = { id: "33333333-3333-4333-8333-333333333333", capabilityId: "purview.audit.search.delegated", tokenMode: "delegated",
      authorizationPrincipalId: user.homeAccountId, resultScope: { kind: "principal", scopeId: user.homeAccountId, configurationRevision: null }, filters,
      status: "approved", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64),
      configurationRevision: 1, approvedBy: user.homeAccountId, approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), jobId: job().id };
    const fixture = setup();
    fixture.setCurrent(job({ qualificationId: qualification.id }));
    fixture.repository.getQualification.mockResolvedValue(qualification);
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.dependencies.recordQualificationEvidence).toHaveBeenCalledWith("purview.audit.search.delegated", user, "available", expect.anything(), 1));
    expect(fixture.dependencies.requireAvailable).not.toHaveBeenCalled();
  });

  it.each((["create", "reconcile"] as const).flatMap(action =>
    (["failed", "cancelled", "unknownFutureValue"] as const).map(status => ({ action, status })),
  ))("preserves a terminal $status query during qualification $action", async ({ action, status }) => {
    const qualification: PurviewAuditQualification = {
      id: "33333333-3333-4333-8333-333333333333", capabilityId: "purview.audit.search.delegated", tokenMode: "delegated",
      authorizationPrincipalId: user.homeAccountId, resultScope: { kind: "principal", scopeId: user.homeAccountId, configurationRevision: null },
      filters, status: "approved", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1,
      approvedBy: user.homeAccountId, approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), jobId: job().id,
    };
    const fixture = setup({
      createQuery: vi.fn(async () => query(status)),
      listQueries: vi.fn(async () => ({ value: [query(status)], complete: true, nextLink: null })),
    });
    fixture.setCurrent(job({ qualificationId: qualification.id, attemptedAt: action === "reconcile" ? new Date().toISOString() : null }));
    fixture.repository.getQualification.mockResolvedValue(qualification);
    try {
      await fixture.service.start(user, job().id, "delegated");
      await vi.waitFor(() => expect(fixture.repository.fail).toHaveBeenCalledWith(
        expect.anything(), job().id, expect.anything(), "provider_query_failed", expect.any(String), false,
      ));
      expect(fixture.current()).toMatchObject({ status: "failed", providerStatus: status });
      expect(fixture.dependencies.getQuery).not.toHaveBeenCalled();
      expect(fixture.dependencies.listRecords).not.toHaveBeenCalled();
      expect(fixture.repository.publish).not.toHaveBeenCalled();
      expect(fixture.dependencies.recordQualificationEvidence).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), "available", expect.anything(), expect.anything(),
      );
    } finally {
      await fixture.service.drain();
    }
  });

  it.each(["available", "provider_error"] as const)("binds application %s evidence to its approved configuration", async status => {
    const admin: AuthenticatedUser = { ...user, roles: ["AgentControl.Admin"] };
    const qualification: PurviewAuditQualification = {
      id: "33333333-3333-4333-8333-333333333333", capabilityId: "purview.audit.search.application", tokenMode: "application",
      authorizationPrincipalId: user.homeAccountId, resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 7 },
      filters, status: "approved", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 7,
      approvedBy: user.homeAccountId, approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), jobId: job().id,
    };
    const fixture = setup({
      applicationIdentity: () => "application-client",
      revalidateUser: vi.fn(async () => admin),
      requireApplicationDataScope: vi.fn(async () => ({ enabled: true, sharedDataScope: true, revision: 7 })),
      qualificationContext: vi.fn(async () => ({ capabilityId: qualification.capabilityId, contractRevision: qualification.contractRevision,
        permissionRevision: qualification.permissionRevision, configurationRevision: 7 })),
      createQuery: vi.fn(async () => {
        if (status === "provider_error") throw new AppError(502, "provider_error", "Provider unavailable");
        return query("succeeded");
      }),
    });
    fixture.setCurrent(job({ tokenMode: "application", resultScope: qualification.resultScope, qualificationId: qualification.id }));
    fixture.repository.getQualification.mockResolvedValue(qualification);
    await fixture.service.start(admin, job().id, "application");
    await vi.waitFor(() => expect(fixture.dependencies.recordQualificationEvidence).toHaveBeenCalledOnce());
    await fixture.service.drain();
    expect(fixture.dependencies.recordQualificationEvidence).toHaveBeenCalledWith(
      qualification.capabilityId, admin, status, expect.any(Object), 7,
    );
  });

  it("requires current Viewer authority at qualification dispatch and publication", async () => {
    const qualification: PurviewAuditQualification = { id: "33333333-3333-4333-8333-333333333333", capabilityId: "purview.audit.search.delegated", tokenMode: "delegated",
      authorizationPrincipalId: user.homeAccountId, resultScope: { kind: "principal", scopeId: user.homeAccountId, configurationRevision: null }, filters,
      status: "approved", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: user.homeAccountId,
      approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), jobId: job().id };
    const dispatch = setup({ revalidateUser: vi.fn(async () => ({ ...user, roles: [] })) });
    dispatch.setCurrent(job({ qualificationId: qualification.id }));
    dispatch.repository.getQualification.mockResolvedValue(qualification);
    await dispatch.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(dispatch.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    expect(dispatch.dependencies.createQuery).not.toHaveBeenCalled();

    const publication = setup({ revalidateUser: vi.fn()
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce({ ...user, roles: [] }) });
    publication.setCurrent(job({ qualificationId: qualification.id }));
    publication.repository.getQualification.mockResolvedValue(qualification);
    await publication.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(publication.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    expect(publication.repository.publish).not.toHaveBeenCalled();
    expect(publication.dependencies.recordQualificationEvidence).not.toHaveBeenCalled();
  });

  it("returns an already-qualified terminal job without renewing capability evidence", async () => {
    const qualification: PurviewAuditQualification = { id: "33333333-3333-4333-8333-333333333333", capabilityId: "purview.audit.search.delegated", tokenMode: "delegated",
      authorizationPrincipalId: user.homeAccountId, resultScope: { kind: "principal", scopeId: user.homeAccountId, configurationRevision: null }, filters,
      status: "qualified", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: user.homeAccountId,
      approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), jobId: job().id };
    const fixture = setup();
    fixture.setCurrent(job({ status: "succeeded", qualificationId: qualification.id, canResume: false, finishedAt: new Date().toISOString() }));
    fixture.repository.getQualification.mockResolvedValue(qualification);
    await expect(fixture.service.startQualification(user, qualification.id)).resolves.toMatchObject({ status: "succeeded" });
    expect(fixture.repository.begin).not.toHaveBeenCalled();
    expect(fixture.dependencies.recordQualificationEvidence).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "running"] as const)("counts the mandatory qualification GET within the poll limit: %s", async status => {
    const qualification: PurviewAuditQualification = { id: "33333333-3333-4333-8333-333333333333", capabilityId: "purview.audit.search.delegated", tokenMode: "delegated",
      authorizationPrincipalId: user.homeAccountId, resultScope: { kind: "principal", scopeId: user.homeAccountId, configurationRevision: null }, filters,
      status: "approved", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: user.homeAccountId,
      approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), jobId: job().id };
    const fixture = setup({ createQuery: vi.fn(async () => query("succeeded")), getQuery: vi.fn(async () => query(status)) });
    fixture.setCurrent(job({ qualificationId: qualification.id }));
    fixture.repository.getQualification.mockResolvedValue(qualification);
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(status === "succeeded" ? fixture.repository.publish : fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    await fixture.service.drain();
    expect(fixture.dependencies.getQuery).toHaveBeenCalledTimes(status === "succeeded" ? 1 : 6);
    if (status === "running") {
      expect(fixture.repository.publish).not.toHaveBeenCalled();
      expect(fixture.dependencies.recordQualificationEvidence).not.toHaveBeenCalled();
    }
  });

  it("accounts for each provider request and persists provider request IDs through adapter hooks", async () => {
    const fixture = setup({
      createQuery: vi.fn(async (_token, _marker, _filters, options) => {
        await options.beforeRequest?.();
        await options.onResponse?.("provider-request-a");
        return query("succeeded");
      }),
    });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
    await fixture.service.drain();
    expect(fixture.repository.authorizeProviderRequest).toHaveBeenCalledOnce();
    expect(fixture.repository.recordProviderResponse).toHaveBeenCalledWith(expect.anything(), job().id, expect.objectContaining({ version: 1 }), "provider-request-a");
  });

  it("aborts on account change and fences publication", async () => {
    const records = vi.fn((_token, _id, _tenant, options: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })));
    const fixture = setup({ createQuery: vi.fn(async () => query("succeeded")), listRecords: records });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(records).toHaveBeenCalledOnce());
    await fixture.service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
    await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    expect(fixture.repository.publish).not.toHaveBeenCalled();
  });

  it("recovers database state without creating, polling, or downloading provider work", async () => {
    const fixture = setup();
    await expect(fixture.service.recover()).resolves.toBe(0);
    expect(fixture.dependencies.createQuery).not.toHaveBeenCalled();
    expect(fixture.dependencies.getQuery).not.toHaveBeenCalled();
    expect(fixture.dependencies.listRecords).not.toHaveBeenCalled();
  });

  it("reads authorized saved jobs and records without requiring live provider availability", async () => {
    const fixture = setup({ requireAvailable: vi.fn(async () => { throw new Error("must not be called"); }) });
    await expect(fixture.service.get(user, job().id)).resolves.toMatchObject({ id: job().id });
    await expect(fixture.service.list(user)).resolves.toMatchObject({ count: 1 });
    await expect(fixture.service.records(user, job().id)).resolves.toMatchObject({ count: 0 });
    expect(fixture.dependencies.requireAvailable).not.toHaveBeenCalled();
  });

  it("allows Viewer delegated qualification and reserves application qualification for Admin", async () => {
    const fixture = setup();
    await expect(fixture.service.approveQualification({ ...user, roles: [] }, { tokenMode: "delegated", filters })).rejects.toMatchObject({ code: "missing_internal_role" });
    await expect(fixture.service.approveQualification(user, { tokenMode: "delegated", filters })).resolves.toBeUndefined();
    expect(fixture.repository.approveQualification).toHaveBeenCalledOnce();

    const application = setup({
      applicationIdentity: () => "application-client",
      qualificationContext: vi.fn(async () => ({ capabilityId: "purview.audit.search.application" as const, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 })),
    });
    await expect(application.service.approveQualification(user, { tokenMode: "application", filters }))
      .rejects.toMatchObject({ code: "missing_internal_role" });
    const admin: AuthenticatedUser = { ...user, roles: ["AgentControl.Admin"] };
    await expect(application.service.approveQualification(admin, { tokenMode: "application", filters })).resolves.toBeUndefined();

    const qualification: PurviewAuditQualification = {
      id: "33333333-3333-4333-8333-333333333333", capabilityId: "purview.audit.search.application", tokenMode: "application",
      authorizationPrincipalId: user.homeAccountId, resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 1 }, filters,
      status: "approved", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1,
      approvedBy: user.homeAccountId, approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), jobId: null,
    };
    application.repository.getQualification.mockResolvedValue(qualification);
    await expect(application.service.startQualification(user, qualification.id)).rejects.toMatchObject({ code: "missing_internal_role" });
  });
});