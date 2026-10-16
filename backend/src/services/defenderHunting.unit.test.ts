import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefenderHuntingRepository } from "../db/defenderHunting.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { AuditEvent } from "../types/audit.js";
import type { DefenderHuntingFilters, DefenderHuntingJob, DefenderHuntingQueryResult, DefenderHuntingTokenMode } from "../types/defenderHunting.js";
import type { AuthenticatedUser } from "../types/session.js";
import { AuditLog } from "./auditLog.js";
import { DefenderHuntingService } from "./defenderHunting.js";
import { GraphHuntingClient, expectedHuntingSchema } from "./graphHunting.js";
import { loadOperationalState } from "./operationalState.js";

vi.mock("../config.js", () => ({ config: {
  nodeEnv: "test", officialUsageStaleDays: 30, sessionSecret: "synthetic-hunting-regression-session-secret",
}, authConfigured: false, loginScopes: ["openid", "profile"] }));
vi.mock("../db/pool.js", () => ({
  pool: { options: { max: 4 } },
  transaction: vi.fn(() => { throw new Error("Database access is forbidden in hunting unit regressions."); }),
}));

const user: AuthenticatedUser = { homeAccountId: "hunting-reader", tenantId: "tenant-a", username: "reader@example.invalid",
  displayName: "Reader", roles: ["AgentControl.Admin"], providerRoleIds: [] };
const now = new Date("2026-10-10T12:00:00.000Z");
const filters: DefenderHuntingFilters = { templateId: "agents_inventory", startDateTime: "2026-10-10T11:30:00.000Z",
  endDateTime: now.toISOString(), agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [] };
const result: DefenderHuntingQueryResult = { rows: [], providerRowCount: 0, storedRowCount: 0, byteCount: 2, complete: true, partialReason: null };
const scopeId = "44444444-4444-4444-8444-444444444444";
const services: DefenderHuntingService[] = [];
type Dependencies = NonNullable<ConstructorParameters<typeof DefenderHuntingService>[1]>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await loadOperationalState({ query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{
    mode: "normal",
  }] }) });
  await activateAccountSession(user.tenantId!, user.homeAccountId, async () => undefined);
});
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.drain()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(mode: DefenderHuntingTokenMode = "delegated") {
  let current: DefenderHuntingJob = {
    id: "11111111-1111-4111-8111-111111111111", authorizationPrincipalId: user.homeAccountId,
    resultScope: mode === "delegated" ? { kind: "principal", scopeId: user.homeAccountId, configurationRevision: null }
      : { kind: "application", scopeId: "application-client", configurationRevision: 1 },
    tokenMode: mode, status: "waiting_authorization", filters, queryVersion: 3,
    localRequestId: "22222222-2222-4222-8222-222222222222", providerRequestId: null, providerRequestCount: 0,
    activationCount: 0, providerRowCount: 0, storedRowCount: 0, byteCount: 0, complete: false, noData: false, partialReason: null,
    observedRange: null, unobservedRange: null, snapshotId: null, priorSuccessfulJobId: null,
    cancelRequested: false, createdAt: now.toISOString(), attemptedAt: null, updatedAt: now.toISOString(), finishedAt: null,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(), canResume: true,
  };
  const repository = new DefenderHuntingRepository();
  const get = vi.spyOn(repository, "getJob").mockImplementation(async () => current);
  const begin = vi.spyOn(repository, "begin").mockImplementation(async () => {
    current = { ...current, status: "running", activationCount: current.activationCount + 1 };
    return { owner: "33333333-3333-4333-8333-333333333333", version: 1, job: current };
  });
  const admit = vi.spyOn(repository, "authorizeProviderRequest").mockResolvedValue(undefined);
  const publish = vi.spyOn(repository, "publish").mockImplementation(async (_scope, _id, _execution, _result, fence) => {
    fence?.();
    current = { ...current, status: "succeeded", complete: true, noData: true };
    return current;
  });
  const pause = vi.spyOn(repository, "markWaitingAuthorization").mockImplementation(async () => {
    current = { ...current, status: "waiting_authorization" };
    return current;
  });
  const fail = vi.spyOn(repository, "fail").mockImplementation(async () => {
    current = { ...current, status: "inconclusive" };
    return current;
  });
  const submit = vi.spyOn(repository, "submit").mockImplementation(async () => current);
  const audit = new AuditLog({ tenantId: user.tenantId!, principalId: user.homeAccountId });
  const event: AuditEvent = { id: "audit-event", operationId: "query-hunting:fixture", scope: "single", action: "query-hunting",
    agentId: current.id, actor: user, requestPath: "/api/hunting/jobs/fixture", status: "started", startedAt: now.toISOString() };
  vi.spyOn(audit, "startEvent").mockResolvedValue(event);
  const completeAudit = vi.spyOn(audit, "completeEvent").mockImplementation(async (_id, update) => ({ ...event, ...update }));
  let capabilityCurrent = true;
  const dispatched = vi.fn();
  const dependencies: Dependencies = {
    delegatedToken: vi.fn(async () => "fixture-token"), applicationToken: vi.fn(async () => "fixture-application-token"),
    revalidateUser: vi.fn(async () => user),
    beginOperationValidation: () => () => {
      if (!capabilityCurrent) throw new AppError(401, "authorization_expired", "Hunting capability changed.");
    },
    observeOperation: async (_id, _user, operation) => operation(() => undefined),
    requireApplicationDataScope: vi.fn(async () => ({ enabled: true, sharedDataScope: true, previewQualified: true, revision: 1 })),
    applicationIdentity: () => "application-client",
    recordProviderEvidence: vi.fn<Dependencies["recordProviderEvidence"]>(async () => ({ capabilityId: "defender.hunting.delegated", status: "available",
      authorized: true, fresh: true, previewQualification: "not_required", remediation: [] })),
    auditLog: () => audit,
    runQuery: async (_token, _filters, options) => {
      await options?.beforeRequest?.(options.signal!);
      dispatched();
      return result;
    },
    agentScope: vi.fn(async (_scope, recordId) => ({ recordId, entraAgentIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] })),
  };
  const service = new DefenderHuntingService(repository, dependencies);
  services.push(service);
  return { service, repository, current: () => current, invalidate: () => { capabilityCurrent = false; },
    begin, admit, publish, pause, fail, submit, get, dependencies, dispatched, completeAudit };
}

describe("Hunting authority and committed outcomes without services", () => {
  it.each(["cancel", "delete"] as const)("rejects foreign application %s without exposing job-state availability", async action => {
      for (const status of ["waiting_authorization", "running", "succeeded"] as const) {
        const f = setup("application");
        f.current().authorizationPrincipalId = "other-owner";
        f.current().status = status;
        const mutation = vi.spyOn(f.repository, action).mockRejectedValue(new AppError(409, "hunting_job_state", "Mutation rejected."));
        await expect(f.service.get(user, f.current().id)).resolves.toMatchObject({ authorizationPrincipalId: "other-owner" });
        await expect(f.service[action](user, f.current().id)).rejects.toMatchObject({
          status: 404, code: "not_found", message: "Hunting job was not found.",
        });
        expect(mutation).not.toHaveBeenCalled();
        expect(f.dependencies.applicationToken).not.toHaveBeenCalled();
        expect(f.dependencies.delegatedToken).not.toHaveBeenCalled();
      }
  });

  it.each(["cancel", "delete"] as const)("does not let a shared reader %s or abort the owner's provider work", async action => {
    const f = setup("application");
    const pending = Promise.withResolvers<string>();
    f.dependencies.applicationToken = vi.fn(() => pending.promise);
    const mutation = vi.spyOn(f.repository, action).mockRejectedValue(new AppError(409, "hunting_job_state", "Mutation rejected."));
    await f.service.start(user, f.current().id, "application");
    await vi.waitFor(() => expect(f.dependencies.applicationToken).toHaveBeenCalledOnce());
    const reader = { ...user, homeAccountId: "other-admin" };
    await activateAccountSession(reader.tenantId!, reader.homeAccountId, async () => undefined);
    await expect(f.service[action](reader, f.current().id)).rejects.toMatchObject({ status: 404, code: "not_found" });
    pending.resolve("fixture-application-token");
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
    expect(mutation).not.toHaveBeenCalled();
    expect(f.pause).not.toHaveBeenCalled();
  });

  it.each(["delegated", "application"] as const)("keeps owned %s cancellation and deletion available without live provider access", async mode => {
      const f = setup(mode);
      const owner = { ...user, roles: ["AgentControl.Viewer"] as AuthenticatedUser["roles"] };
      const cancel = vi.spyOn(f.repository, "cancel").mockImplementation(async (_scope, _id, fence) => {
        fence?.();
        return { ...f.current(), status: "cancelled" };
      });
      const remove = vi.spyOn(f.repository, "delete").mockImplementation(async (_scope, _id, fence) => { fence?.(); });
      await expect(f.service.cancel(owner, f.current().id)).resolves.toMatchObject({ status: "cancelled" });
      await expect(f.service.delete(owner, f.current().id)).resolves.toBeUndefined();
      expect(cancel).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledOnce();
      expect(f.dependencies.applicationToken).not.toHaveBeenCalled();
      expect(f.dependencies.delegatedToken).not.toHaveBeenCalled();
  });

  it.each(["delegated", "application"] as const)("fences %s invalidation after admission settles but before fetch", async mode => {
    const f = setup(mode);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      schema: expectedHuntingSchema(filters.templateId), results: [],
    })));
    const client = new GraphHuntingClient({ fetch: fetcher, wait: vi.fn(), random: () => 0 });
    f.dependencies.runQuery = (token, selected, options) => client.runQuery(token, selected, {
      ...options,
      beforeRequest: async signal => {
        await options?.beforeRequest?.(signal);
        queueMicrotask(f.invalidate);
      },
    });
    await f.service.start(user, f.current().id, mode);
    await vi.waitFor(() => expect(f.pause).toHaveBeenCalledOnce());
    expect(f.admit).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it.each(["delegated", "application"] as const)("keeps %s response bookkeeping joined and fenced after capability invalidation", async mode => {
    const f = setup(mode);
    const pending = Promise.withResolvers<void>();
    let committed = false;
    const bookkeeping = vi.spyOn(f.repository, "recordProviderResponse").mockImplementationOnce(async (_scope, _id, _execution, _requestId, fence) => {
      await pending.promise;
      fence?.();
      committed = true;
    });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      schema: expectedHuntingSchema(filters.templateId), results: [],
    }), { headers: { "request-id": "received-response" } }));
    const client = new GraphHuntingClient({ fetch: fetcher, wait: vi.fn(), random: () => 0 });
    f.dependencies.runQuery = client.runQuery.bind(client);
    await f.service.start(user, f.current().id, mode);
    await vi.waitFor(() => expect(bookkeeping).toHaveBeenCalledOnce());
    f.invalidate();
    let drained = false;
    const draining = f.service.drain().then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(drained).toBe(false);
    pending.resolve();
    await draining;
    expect(committed).toBe(false);
    expect(f.pause).toHaveBeenCalledOnce();
    expect(f.publish).not.toHaveBeenCalled();
    expect(bookkeeping).toHaveBeenCalledWith(expect.anything(), f.current().id, expect.anything(), "received-response", expect.any(Function));
  });

  it("does not persist provider denial when the initiating capability changes on a rejected worker await", async () => {
    const f = setup();
    f.dependencies.runQuery = async (_token, _filters, options) => {
      await options?.beforeRequest?.(options.signal!);
      f.invalidate();
      throw new AppError(403, "hunting_access_denied", "Provider denied the query.");
    };
    await f.service.start(user, f.current().id, "delegated");
    await vi.waitFor(() => expect(f.pause).toHaveBeenCalledOnce());
    expect(f.fail).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.dependencies.recordProviderEvidence).not.toHaveBeenCalled();
  });

  it.each(["provider_scope_mismatch", "provider_result_limit"])(
    "settles %s as inconclusive provider evidence, not a local failure or authorization wait", async code => {
      const f = setup();
      const message = "The bounded provider response did not satisfy the hunting contract.";
      f.dependencies.runQuery = async (_token, _filters, options) => {
        await options?.beforeRequest?.(options.signal!);
        throw new AppError(502, code, message, { httpStatus: 200, correlationId: "bounded-response" });
      };
      await f.service.start(user, f.current().id, "delegated");
      await vi.waitFor(() => expect(f.completeAudit).toHaveBeenCalledOnce());
      expect(f.fail).toHaveBeenCalledWith(expect.anything(), f.current().id, expect.anything(), code, message, true);
      expect(f.dependencies.recordProviderEvidence).toHaveBeenCalledWith("defender.hunting.delegated", user, "provider_error",
        { httpStatus: 200, correlationId: "bounded-response", category: code, providerRequestId: null }, undefined, expect.any(AbortSignal));
      expect(f.completeAudit).toHaveBeenCalledWith("audit-event", expect.objectContaining({ status: "inconclusive", errorCode: code }));
      expect(f.pause).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
    },
  );

  it.each(["cancel", "delete"] as const)("does not abort an owned worker when durable %s is rejected", async action => {
    const f = setup();
    const pending = Promise.withResolvers<string>();
    f.dependencies.delegatedToken = vi.fn(() => pending.promise);
    vi.spyOn(f.repository, action).mockRejectedValue(new AppError(409, "hunting_job_state", "Mutation rejected."));
    await f.service.start(user, f.current().id, "delegated");
    await vi.waitFor(() => expect(f.dependencies.delegatedToken).toHaveBeenCalledOnce());
    await expect(f.service[action](user, f.current().id)).rejects.toMatchObject({ code: "hunting_job_state" });
    pending.resolve("fixture-token");
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
    expect(f.pause).not.toHaveBeenCalled();
  });

  it("recovers every interrupted batch before returning to startup", async () => {
    const f = setup();
    const repository = new DefenderHuntingRepository();
    const recover = vi.spyOn(repository, "recoverInterrupted").mockResolvedValueOnce(2_000)
      .mockResolvedValueOnce(1_003).mockResolvedValueOnce(0);
    const service = new DefenderHuntingService(repository, f.dependencies);
    services.push(service);
    await expect(service.recover()).resolves.toBe(3_003);
    expect(recover).toHaveBeenCalledTimes(3);
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it.each([0, 1])("stops restart recovery after %s batches when operational admissions close", async batches => {
    const f = setup();
    const recover = vi.spyOn(f.repository, "recoverInterrupted").mockResolvedValue(2000);
    const admissionsOpen = vi.fn(async () => recover.mock.calls.length < batches);
    await expect(f.service.recover(admissionsOpen)).resolves.toBe(2000 * batches);
    expect(recover).toHaveBeenCalledTimes(batches);
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it("propagates a failed restart admission read without starting another batch", async () => {
    const f = setup();
    const recover = vi.spyOn(f.repository, "recoverInterrupted").mockResolvedValue(2000);
    const admissionsOpen = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("State unavailable"));
    await expect(f.service.recover(admissionsOpen)).rejects.toThrow("State unavailable");
    expect(recover).toHaveBeenCalledOnce();
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it.each(["cancel", "delete"] as const)("fences %s authority before its durable mutation commits", async action => {
    const f = setup();
    let committed = false;
    if (action === "cancel") vi.spyOn(f.repository, "cancel").mockImplementationOnce(async (_scope, _id, fence) => {
      f.invalidate();
      fence?.();
      committed = true;
      return { ...f.current(), status: "cancelled" };
    });
    else vi.spyOn(f.repository, "delete").mockImplementationOnce(async (_scope, _id, fence) => {
      f.invalidate();
      fence?.();
      committed = true;
    });
    await expect(f.service[action](user, f.current().id)).rejects.toMatchObject({ code: "authorization_expired" });
    expect(committed).toBe(false);
  });

  it.each(["session", "capability"] as const)("withholds a saved job when %s authority changes during the repository read", async authority => {
    const f = setup();
    f.get.mockImplementationOnce(async () => {
      if (authority === "session") await revokeAccountSessionMutations(user.tenantId!, user.homeAccountId, async () => undefined);
      else f.invalidate();
      return f.current();
    });
    await expect(f.service.get(user, f.current().id)).rejects.toMatchObject({ status: 401 });
  });

  it("rechecks the saved agent after repository reads instead of returning an obsolete association", async () => {
    const f = setup();
    f.current().filters = { ...filters, entraAgentIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] };
    f.get.mockImplementationOnce(async () => {
      f.dependencies.agentScope = vi.fn(async (_scope, recordId) => ({
        recordId, entraAgentIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      }));
      return f.current();
    });
    await expect(f.service.get(user, f.current().id, { agentRecordId: "agent:selected" })).rejects.toMatchObject({ code: "not_found" });
  });

  it.each(["delegated", "application"] as const)("fences %s capability invalidation during physical request admission", async mode => {
    const f = setup(mode);
    f.admit.mockImplementationOnce(async () => { f.invalidate(); });
    await f.service.start(user, f.current().id, mode);
    await vi.waitFor(() => expect(f.pause).toHaveBeenCalledOnce());
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it.each(["delegated", "application"] as const)("releases a %s activation committed under superseded capability authority", async mode => {
    const f = setup(mode);
    const begin = f.begin.getMockImplementation()!;
    f.begin.mockImplementationOnce(async (...args) => { const execution = await begin(...args); f.invalidate(); return execution; });
    await expect(f.service.start(user, f.current().id, mode)).rejects.toMatchObject({ code: "authorization_expired" });
    expect(f.pause).toHaveBeenCalledOnce();
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it("does not adopt capability authority replaced as the initial lookup settles", async () => {
    const f = setup();
    f.get.mockImplementationOnce(async () => {
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(f.invalidate)));
      return f.current();
    });
    await expect(f.service.start(user, f.current().id, "delegated")).rejects.toMatchObject({ code: "authorization_expired" });
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it.each(["delegated", "application"] as const)("checks the initiating %s capability in the synchronous publication fence", async mode => {
    const f = setup(mode);
    f.publish.mockImplementationOnce(async (_scope, _id, _execution, _result, fence) => {
      f.invalidate();
      fence?.();
      return f.current();
    });
    await f.service.start(user, f.current().id, mode);
    await vi.waitFor(() => expect(f.pause).toHaveBeenCalledOnce());
    expect(f.current().status).toBe("waiting_authorization");
    expect(f.dispatched).toHaveBeenCalledOnce();
    expect(f.dependencies.recordProviderEvidence).not.toHaveBeenCalled();
  });

  it("does not persist submission after capability authority changes during its saved-identity lookup", async () => {
    const f = setup();
    f.dependencies.agentScope = vi.fn(async (_scope, recordId) => {
      f.invalidate();
      return { recordId, entraAgentIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] };
    });
    const input = { tokenMode: "delegated" as const, filters, agentRecordId: "agent:selected", idempotencyKey: "fenced-submit" };
    await expect(f.service.submit(user, input))
      .rejects.toMatchObject({ code: "authorization_expired" });
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("surfaces a terminal audit failure without rewriting or pausing its committed successful hunt", async () => {
    const f = setup();
    const failure = new Error("Synthetic terminal audit unavailable.");
    const pending = Promise.withResolvers<void>();
    f.completeAudit.mockImplementationOnce(async () => { await pending.promise; throw failure; });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await f.service.start(user, f.current().id, "delegated");
    await vi.waitFor(() => expect(f.completeAudit).toHaveBeenCalledOnce());
    const draining = expect(f.service.drain()).rejects.toBe(failure);
    pending.resolve();
    await draining;
    expect(f.current().status).toBe("succeeded");
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled();
    expect(f.completeAudit).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledOnce();
  });
});
