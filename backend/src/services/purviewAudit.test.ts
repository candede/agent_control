import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { PurviewAuditFilters, PurviewAuditJob, PurviewAuditQualification, PurviewAuditResult, PurviewProviderQuery } from "../types/purviewAudit.js";
import { createProviderQueryBody } from "./graphAuditSearch.js";
import { PurviewAuditService } from "./purviewAudit.js";

const user: AuthenticatedUser = { homeAccountId: "reader-a", tenantId: "tenant-a", username: "reader@example.invalid", displayName: "Reader", roles: ["AgentControl.SecurityReader", "AgentControl.Administrator"], providerRoles: [], providerRoleScope: "unknown" };
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
  const execution = { action: "create" as const, owner: "33333333-3333-4333-8333-333333333333", version: 1 };
  const repository = {
    getJob: vi.fn(async () => current), begin: vi.fn(async () => {
      current = { ...current, status: "reconciling_create", activationCount: current.activationCount + 1 };
      return { ...execution, job: current };
    }), recordProviderQuery: vi.fn(async (_scope, _id, _execution, id, status) => { current = { ...current, status: "running", providerQueryId: id, providerStatus: status }; }),
    recordProviderStatus: vi.fn(async (_scope, _id, status) => { current = { ...current, providerStatus: status }; }), markWaitingAuthorization: vi.fn(async () => { current = { ...current, status: "waiting_authorization" }; return current; }),
    publish: vi.fn(async () => { current = { ...current, status: "succeeded" }; return current; }), fail: vi.fn(async () => { current = { ...current, status: "failed" }; return current; }),
    authorizeProviderRequest: vi.fn(async () => undefined), recordProviderResponse: vi.fn(async () => undefined),
    recoverInterrupted: vi.fn(async () => 0), getQualification: vi.fn(async () => undefined), submit: vi.fn(), approveQualification: vi.fn(),
    listJobs: vi.fn(async () => ({ value: [current], count: 1, limit: 20, offset: 0 })),
    listRecords: vi.fn(async () => ({ value: [], count: 0, limit: 100, offset: 0, job: current })),
    cancel: vi.fn(async () => { current = { ...current, status: "cancelled" }; return current; }), delete: vi.fn(async () => undefined),
  };
  const dependencies = {
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
  it("returns a durable job promptly and completes create, poll, records and publication in the background", async () => {
    const fixture = setup();
    await expect(fixture.service.start(user, job().id, "delegated")).resolves.toMatchObject({ id: job().id });
    await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
    expect(fixture.dependencies.createQuery).toHaveBeenCalledOnce();
    expect(fixture.dependencies.getQuery).toHaveBeenCalledOnce();
    expect(fixture.dependencies.listRecords).toHaveBeenCalledOnce();
    expect(fixture.dependencies.delegatedToken).toHaveBeenCalledWith(user.homeAccountId, "purview.audit.search.delegated");
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
    await vi.waitFor(() => expect(fixture.dependencies.recordQualificationEvidence).toHaveBeenCalledWith("purview.audit.search.delegated", user, "available", expect.anything()));
    expect(fixture.dependencies.requireAvailable).not.toHaveBeenCalled();
  });

  it("requires current Administrator and SecurityReader roles at qualification dispatch and publication", async () => {
    const qualification: PurviewAuditQualification = { id: "33333333-3333-4333-8333-333333333333", capabilityId: "purview.audit.search.delegated", tokenMode: "delegated",
      authorizationPrincipalId: user.homeAccountId, resultScope: { kind: "principal", scopeId: user.homeAccountId, configurationRevision: null }, filters,
      status: "approved", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: user.homeAccountId,
      approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), jobId: job().id };
    const dispatch = setup({ revalidateUser: vi.fn(async () => ({ ...user, roles: ["AgentControl.SecurityReader"] })) });
    dispatch.setCurrent(job({ qualificationId: qualification.id }));
    dispatch.repository.getQualification.mockResolvedValue(qualification);
    await dispatch.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(dispatch.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    expect(dispatch.dependencies.createQuery).not.toHaveBeenCalled();

    const publication = setup({ revalidateUser: vi.fn()
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce({ ...user, roles: ["AgentControl.SecurityReader"] }) });
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

  it("proves the single-query GET during qualification even when create immediately succeeds", async () => {
    const qualification: PurviewAuditQualification = { id: "33333333-3333-4333-8333-333333333333", capabilityId: "purview.audit.search.delegated", tokenMode: "delegated",
      authorizationPrincipalId: user.homeAccountId, resultScope: { kind: "principal", scopeId: user.homeAccountId, configurationRevision: null }, filters,
      status: "approved", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: user.homeAccountId,
      approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), jobId: job().id };
    const fixture = setup({ createQuery: vi.fn(async () => query("succeeded")) });
    fixture.setCurrent(job({ qualificationId: qualification.id }));
    fixture.repository.getQualification.mockResolvedValue(qualification);
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
    await fixture.service.drain();
    expect(fixture.dependencies.getQuery).toHaveBeenCalledOnce();
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

  it("requires both internal roles for explicit qualification approval", async () => {
    const fixture = setup();
    await expect(fixture.service.approveQualification({ ...user, roles: ["AgentControl.SecurityReader"] }, { tokenMode: "delegated", filters })).rejects.toMatchObject({ code: "missing_internal_role" });
    expect(fixture.repository.approveQualification).not.toHaveBeenCalled();
  });
});