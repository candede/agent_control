import { describe, expect, it, vi } from "vitest";
import type { DefenderHuntingRepository } from "../db/defenderHunting.js";
import { AppError } from "../errors.js";
import type { DefenderHuntingFilters, DefenderHuntingJob, DefenderHuntingQueryResult, DefenderHuntingRetainedScope } from "../types/defenderHunting.js";
import type { AuthenticatedUser } from "../types/session.js";
import { DefenderHuntingService } from "./defenderHunting.js";
import type { GraphHuntingClient } from "./graphHunting.js";

const user: AuthenticatedUser = { homeAccountId: "security-a", tenantId: "tenant-a", username: "security@example.invalid", displayName: "Security Reader",
  roles: ["AgentControl.Viewer"], providerRoleIds: [] };
const filters: DefenderHuntingFilters = { templateId: "agents_inventory", startDateTime: new Date(Date.now() - 30 * 60_000).toISOString(),
  endDateTime: new Date().toISOString(), agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [] };
const qualification = { capabilityId: "defender.hunting.delegated" as const, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: user.homeAccountId };
const retainedScope = { id: "44444444-4444-4444-8444-444444444444", authority: {
  capabilityId: "defender.hunting.delegated" as const, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1,
} };

function job(overrides: Partial<DefenderHuntingJob> = {}): DefenderHuntingJob {
  return { id: "11111111-1111-4111-8111-111111111111", authorizationPrincipalId: user.homeAccountId,
    resultScope: { kind: "principal", scopeId: user.homeAccountId, configurationRevision: null }, tokenMode: "delegated", status: "waiting_authorization",
    filters, queryVersion: 3, retainedScopeId: retainedScope.id, localRequestId: "22222222-2222-4222-8222-222222222222", providerRequestId: null, providerRequestCount: 0,
    activationCount: 0, providerRowCount: 0, storedRowCount: 0, byteCount: 0, complete: false, noData: false, partialReason: null,
    observedRange: null, unobservedRange: null, snapshotId: null, priorSuccessfulJobId: null, qualification: null, cancelRequested: false, createdAt: new Date().toISOString(),
    attemptedAt: null, updatedAt: new Date().toISOString(), finishedAt: null, expiresAt: new Date(Date.now() + 60_000).toISOString(), canResume: true, ...overrides };
}

const emptyResult: DefenderHuntingQueryResult = { rows: [], providerRowCount: 0, storedRowCount: 0, byteCount: 2, complete: true, partialReason: null };

function retained(overrides: Partial<DefenderHuntingRetainedScope> = {}): DefenderHuntingRetainedScope {
  return { ...retainedScope.authority, id: retainedScope.id, tokenMode: "delegated",
    resultScope: { kind: "principal", scopeId: user.homeAccountId, configurationRevision: null },
    templateId: filters.templateId, targetScopeHash: "c".repeat(64),
    approvedScope: { templateId: filters.templateId, agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [] },
    queryVersion: 3, approvedBy: user.homeAccountId, sourceQualificationJobId: job().id,
    approvedAt: new Date().toISOString(), qualifiedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null, ...overrides };
}

function setup(overrides: Record<string, unknown> = {}) {
  let current = job();
  const execution = { owner: "33333333-3333-4333-8333-333333333333", version: 1 };
  const audit = { startEvent: vi.fn(async () => ({ id: "audit-event" })), completeEvent: vi.fn(async () => undefined) };
  const repository = {
    getJob: vi.fn(async () => current), begin: vi.fn(async () => { current = { ...current, status: "running", activationCount: current.activationCount + 1 }; return { ...execution, job: current }; }),
    requireQualifiedScope: vi.fn(async (_scope, _filters, authority) => ({ id: retainedScope.id, authority })),
    listQualificationEvidence: vi.fn(async () => []), listRetainedScopes: vi.fn<DefenderHuntingRepository["listRetainedScopes"]>(async () => []),
    authorizeProviderRequest: vi.fn(async () => undefined), recordProviderResponse: vi.fn(async () => undefined),
    publish: vi.fn(async () => { current = { ...current, status: "succeeded", complete: true, noData: true }; return current; }),
    markWaitingAuthorization: vi.fn(async () => { current = { ...current, status: "waiting_authorization" }; return current; }),
    fail: vi.fn(async (_scope, _id, _execution, code) => { current = { ...current, status: "inconclusive", errorCode: code }; return current; }),
    submit: vi.fn(async () => current), listJobs: vi.fn<DefenderHuntingRepository["listJobs"]>(async () => ({ value: [current], count: 1, limit: 20, offset: 0 })),
    listRows: vi.fn(), cancel: vi.fn(async () => { current = { ...current, status: "cancelled" }; return current; }), delete: vi.fn(),
    revokeRetainedScope: vi.fn(async () => ({ id: retainedScope.id })), recoverInterrupted: vi.fn(async () => 0),
  };
  const dependencies = { delegatedToken: vi.fn(async () => "delegated-token"), applicationToken: vi.fn(async () => "application-token"),
    observeOperation: vi.fn(async (_id, _user, operation: (reportFailure: (error: unknown) => void) => Promise<unknown>) => operation(() => undefined)),
    revalidateUser: vi.fn(async () => user),
    requireAvailable: vi.fn(async () => ({ authorized: true })),
    requireApplicationDataScope: vi.fn(async () => ({ enabled: true, sharedDataScope: true, revision: 1 })), applicationIdentity: () => undefined,
    qualificationContext: vi.fn(async (capabilityId: "defender.hunting.delegated" | "defender.hunting.application") => ({ capabilityId, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 })),
    recordProviderEvidence: vi.fn(async () => ({ authorized: true })), auditLog: vi.fn(() => audit), runQuery: vi.fn(async () => emptyResult), ...overrides };
  return { repository, dependencies, service: new DefenderHuntingService(repository as never, dependencies as never), current: () => current,
    setCurrent: (value: DefenderHuntingJob) => { current = value; }, audit };
}

describe("Defender hunting worker", () => {
  it("binds runtime client IDs separately and hides jobs that used the enterprise-object namespace", async () => {
    const agentRecordId = "agent:11111111-1111-4111-8111-111111111111";
    const applicationId = "22222222-2222-4222-8222-222222222222";
    const fixture = setup({ agentScope: vi.fn(async () => ({ recordId: agentRecordId, entraAgentIds: [], entraAgentApplicationIds: [applicationId] })) });
    const runtimeFilters = { ...filters, templateId: "agent_activity" as const, operations: ["InvokeAgent"] };
    await fixture.service.submit(user, { tokenMode: "delegated", filters: runtimeFilters, agentRecordId, idempotencyKey: "runtime-client" });
    expect(fixture.repository.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      filters: { ...runtimeFilters, entraAgentApplicationIds: [applicationId] },
    }));
    fixture.setCurrent(job({ filters: { ...runtimeFilters, entraAgentIds: [applicationId] } }));
    await expect(fixture.service.get(user, job().id, agentRecordId)).rejects.toMatchObject({ status: 404 });
    await expect(fixture.service.start(user, job().id, "delegated", agentRecordId)).rejects.toMatchObject({ status: 404 });
    expect(fixture.dependencies.runQuery).not.toHaveBeenCalled();
    fixture.setCurrent(job({ filters: { ...runtimeFilters, entraAgentApplicationIds: [applicationId] } }));
    await expect(fixture.service.get(user, job().id, agentRecordId)).resolves.toMatchObject({ filters: { entraAgentApplicationIds: [applicationId] } });
    await fixture.service.list(user, 10, 0, agentRecordId);
    expect(fixture.repository.listJobs).toHaveBeenCalledWith(expect.objectContaining({ entraAgentIds: [], entraAgentApplicationIds: [applicationId] }), 10, 0);
  });

  it("derives scoped submission filters from current inventory and preserves qualification bounds", async () => {
    const agentRecordId = "agent:11111111-1111-4111-8111-111111111111";
    const entraAgentIds = ["22222222-2222-4222-8222-222222222222"];
    const agentScope = vi.fn(async () => ({ recordId: agentRecordId, entraAgentIds }));
    const fixture = setup({ agentScope });
    const { agentIds: _ids, blueprintIds: _blueprints, ...input } = filters;
    await fixture.service.submit(user, { tokenMode: "delegated", filters: input, idempotencyKey: "agent-scoped", agentRecordId });
    expect(agentScope).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, agentRecordId);
    expect(fixture.repository.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ filters: { ...filters, entraAgentIds } }));
    await fixture.service.approveQualification(user, { tokenMode: "delegated", filters: input, agentRecordId });
    expect(fixture.repository.submit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ filters: { ...filters, entraAgentIds }, qualification }));
    await expect(fixture.service.approveQualification(user, { tokenMode: "delegated", agentRecordId,
      filters: { ...input, startDateTime: new Date(Date.now() - 2 * 3_600_000).toISOString() } })).rejects.toMatchObject({ code: "invalid_hunting_range" });
    await fixture.service.submit(user, { tokenMode: "delegated", filters: { ...filters, entraAgentIds }, idempotencyKey: "exact-context", agentRecordId });
    await expect(fixture.service.submit(user, { tokenMode: "delegated", filters: { ...filters, agentIds: entraAgentIds }, idempotencyKey: "override", agentRecordId }))
      .rejects.toMatchObject({ code: "agent_identity_override" });
    expect(fixture.dependencies.delegatedToken).not.toHaveBeenCalled();
  });

  it("denies broad, foreign and multi-agent jobs on scoped lifecycle access before side effects", async () => {
    const agentRecordId = "agent:11111111-1111-4111-8111-111111111111";
    const selected = "22222222-2222-4222-8222-222222222222";
    for (const entraAgentIds of [undefined, [], ["33333333-3333-4333-8333-333333333333"], [selected, "33333333-3333-4333-8333-333333333333"]]) {
      const fixture = setup({ agentScope: vi.fn(async () => ({ recordId: agentRecordId, entraAgentIds: [selected] })) });
      fixture.setCurrent(job({ filters: { ...filters, ...(entraAgentIds ? { entraAgentIds } : {}) } }));
      await expect(fixture.service.get(user, job().id, agentRecordId)).rejects.toMatchObject({ status: 404 });
      await expect(fixture.service.start(user, job().id, "delegated", agentRecordId)).rejects.toMatchObject({ status: 404 });
      await expect(fixture.service.startQualification(user, job().id, agentRecordId)).rejects.toMatchObject({ status: 404 });
      await expect(fixture.service.cancel(user, job().id, agentRecordId)).rejects.toMatchObject({ status: 404 });
      await expect(fixture.service.delete(user, job().id, agentRecordId)).rejects.toMatchObject({ status: 404 });
      expect(fixture.repository.begin).not.toHaveBeenCalled();
      expect(fixture.repository.cancel).not.toHaveBeenCalled();
      expect(fixture.repository.delete).not.toHaveBeenCalled();
      expect(fixture.dependencies.runQuery).not.toHaveBeenCalled();
    }
  });

  it("scopes history, rows and catalog in the repository without running or authorizing a provider query", async () => {
    const agentRecordId = "agent:11111111-1111-4111-8111-111111111111";
    const entraAgentIds = ["22222222-2222-4222-8222-222222222222"];
    const fixture = setup({ agentScope: vi.fn(async () => ({ recordId: agentRecordId, entraAgentIds })) });
    await fixture.service.list(user, 10, 30, agentRecordId);
    await fixture.service.rows(user, job().id, 10, 30, agentRecordId);
    await fixture.service.qualificationEvidence(user, agentRecordId);
    await fixture.service.retainedScopes(user, agentRecordId);
    for (const method of [fixture.repository.listJobs, fixture.repository.listRows, fixture.repository.listQualificationEvidence, fixture.repository.listRetainedScopes]) {
      expect(method).toHaveBeenCalledWith(expect.objectContaining({ entraAgentIds, tenantId: user.tenantId, authorizationPrincipalId: user.homeAccountId }), ...(
        method === fixture.repository.listJobs ? [10, 30] : method === fixture.repository.listRows ? [job().id, 10, 30] : []));
    }
    expect(fixture.dependencies.runQuery).not.toHaveBeenCalled();
    expect(fixture.dependencies.delegatedToken).not.toHaveBeenCalled();
    expect(fixture.dependencies.applicationToken).not.toHaveBeenCalled();
    expect(fixture.dependencies.requireAvailable).not.toHaveBeenCalled();
  });

  it("revalidates current saved identities before provider work and before publishing scoped results", async () => {
    const agentRecordId = "agent:11111111-1111-4111-8111-111111111111";
    const entraAgentIds = ["22222222-2222-4222-8222-222222222222"];
    let changed = false;
    const agentScope = vi.fn(async () => {
      if (changed) throw new AppError(409, "agent_investigation_unavailable", "Saved identity expired.");
      return { recordId: agentRecordId, entraAgentIds };
    });
    const fixture = setup({ agentScope, runQuery: vi.fn(async () => { changed = true; return emptyResult; }) });
    fixture.setCurrent(job({ filters: { ...filters, entraAgentIds } }));
    await fixture.service.start(user, job().id, "delegated", agentRecordId);
    await vi.waitFor(() => expect(fixture.repository.fail).toHaveBeenCalled());
    expect(fixture.repository.publish).not.toHaveBeenCalled();
    expect(agentScope.mock.calls.length).toBeGreaterThan(2);
  });

  it("binds saved inventory associations to the current Viewer even without directory-role claims", async () => {
    const fixture = setup();
    await fixture.service.list(user);
    expect(fixture.repository.listJobs.mock.calls[0][0]).toMatchObject({
      authorizationPrincipalId: user.homeAccountId,
      inventoryIdentityScope: { principalId: user.homeAccountId, resourceTypes: expect.arrayContaining(["microsoft.copilotstudio/agents"]) },
    });
    await expect(fixture.service.list({ ...user, roles: [] })).rejects.toMatchObject({ status: 403 });
    expect(fixture.repository.listJobs).toHaveBeenCalledOnce();
    expect(fixture.dependencies.delegatedToken).not.toHaveBeenCalled();
  });

  it("returns the durable running job promptly and completes the one fixed query in the background", async () => {
    let release!: (value: AuthenticatedUser) => void;
    const pendingUser = new Promise<AuthenticatedUser>(resolve => { release = resolve; });
    const fixture = setup({ revalidateUser: vi.fn(() => pendingUser) });
    await expect(fixture.service.start(user, job().id, "delegated")).resolves.toMatchObject({ status: "running" });
    expect(fixture.dependencies.runQuery).not.toHaveBeenCalled();
    release(user);
    await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
    expect(fixture.dependencies.delegatedToken).toHaveBeenCalledWith(user.homeAccountId, "defender.hunting.delegated");
    expect(fixture.dependencies.applicationToken).not.toHaveBeenCalled();
  });

  it("moves held delegated work to waiting_authorization on logout without application fallback or late publication", async () => {
    let release!: (value: string) => void;
    const token = new Promise<string>(resolve => { release = resolve; });
    const fixture = setup({ delegatedToken: vi.fn(() => token) });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.dependencies.delegatedToken).toHaveBeenCalledOnce());
    await fixture.service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
    await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    release("late-token");
    await fixture.service.drain();
    expect(fixture.dependencies.applicationToken).not.toHaveBeenCalled();
    expect(fixture.dependencies.runQuery).not.toHaveBeenCalled();
    expect(fixture.repository.publish).not.toHaveBeenCalled();
  });

  it("revalidates the application data-scope revision before publication", async () => {
    let revision = 7;
    let release!: (value: DefenderHuntingQueryResult) => void;
    const pending = new Promise<DefenderHuntingQueryResult>(resolve => { release = resolve; });
    const fixture = setup({ applicationIdentity: () => "application-client",
      requireApplicationDataScope: vi.fn(async () => ({ enabled: true, sharedDataScope: true, revision })), runQuery: vi.fn(() => pending) });
    fixture.setCurrent(job({ tokenMode: "application", resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 7 } }));
    await fixture.service.start(user, job().id, "application");
    await vi.waitFor(() => expect(fixture.dependencies.runQuery).toHaveBeenCalledOnce());
    revision = 8;
    release(emptyResult);
    await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    expect(fixture.repository.publish).not.toHaveBeenCalled();
  });

  it("publishes provider-verified readiness after an explicit bounded query", async () => {
    const fixture = setup();
    fixture.setCurrent(job({ qualification }));
    await fixture.service.startQualification(user, job().id);
    await vi.waitFor(() => expect(fixture.dependencies.recordProviderEvidence).toHaveBeenCalledOnce());
    expect(fixture.dependencies.recordProviderEvidence).toHaveBeenCalledWith(
      "defender.hunting.delegated",
      user,
      "available",
      expect.objectContaining({ providerRequestId: null }),
    );
  });

  it("does not audit a provider query as successful before publication commits", async () => {
    let release!: () => void;
    const publication = new Promise<void>(resolve => { release = resolve; });
    const fixture = setup();
    fixture.repository.publish.mockImplementationOnce(async () => {
      await publication;
      return job({ status: "succeeded", complete: true, noData: true, providerRequestCount: 1 });
    });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
    expect(fixture.audit.startEvent).toHaveBeenCalledWith({
      operationId: `query-hunting:${job().id}:${job().localRequestId}`, scope: "single", action: "query-hunting", agentId: job().id,
      actor: user, requestPath: `/api/hunting/jobs/${job().id}`,
      metadata: { source: "microsoft_defender_hunting", template: "agents_inventory", mode: "delegated", correlationId: job().localRequestId },
    });
    expect(fixture.audit.completeEvent).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(fixture.audit.completeEvent).toHaveBeenCalledWith("audit-event", expect.objectContaining({ status: "succeeded" })));
  });

  it("classifies ambiguous Defender access denial as provider_error evidence without inventing role or license", async () => {
    const fixture = setup({ runQuery: vi.fn<GraphHuntingClient["runQuery"]>(async (_token, _filters, options) => {
      await options?.beforeRequest?.();
      throw new AppError(403, "hunting_access_denied", "ambiguous");
    }) });
    fixture.setCurrent(job({ qualification }));
    await fixture.service.startQualification(user, job().id);
    await vi.waitFor(() => expect(fixture.dependencies.recordProviderEvidence).toHaveBeenCalledOnce());
    expect(fixture.dependencies.recordProviderEvidence).toHaveBeenCalledWith(
      "defender.hunting.delegated",
      user,
      "provider_error",
      expect.objectContaining({ category: "hunting_access_denied" }),
    );
    expect(fixture.dependencies.runQuery).toHaveBeenCalledOnce();
    expect(fixture.dependencies.observeOperation).toHaveBeenCalledTimes(2);
    await expect(fixture.dependencies.observeOperation.mock.results[1].value).rejects.toMatchObject({ code: "hunting_access_denied" });
  });

  it("allows Viewer delegated qualification and reserves application qualification for Admin", async () => {
    const fixture = setup();
    const unassigned = { ...user, roles: [] as AuthenticatedUser["roles"] };
    expect(() => fixture.service.start(unassigned, job().id, "delegated")).toThrowError(expect.objectContaining({ code: "missing_internal_role" }));
    await expect(fixture.service.approveQualification(user, { tokenMode: "delegated", filters })).resolves.toBeDefined();

    const application = setup({ applicationIdentity: () => "application-client" });
    await expect(application.service.approveQualification(user, { tokenMode: "application", filters }))
      .rejects.toMatchObject({ code: "missing_internal_role" });
    const admin: AuthenticatedUser = { ...user, roles: ["AgentControl.Admin"] };
    await expect(application.service.approveQualification(admin, { tokenMode: "application", filters })).resolves.toBeDefined();
    application.setCurrent(job({
      tokenMode: "application",
      resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 1 },
      qualification: { ...qualification, capabilityId: "defender.hunting.application" },
    }));
    await expect(application.service.startQualification(user, job().id)).rejects.toMatchObject({ code: "missing_internal_role" });
  });

  it("submits an ordinary bounded delegated investigation without retained-scope qualification", async () => {
    const fixture = setup();
    await expect(fixture.service.submit(user, { tokenMode: "delegated", filters, idempotencyKey: "ordinary-delegated" }))
      .resolves.toMatchObject({ tokenMode: "delegated" });
    expect(fixture.dependencies.requireAvailable).toHaveBeenCalledWith("defender.hunting.delegated", user);
    expect(fixture.dependencies.qualificationContext).not.toHaveBeenCalled();
    expect(fixture.repository.requireQualifiedScope).not.toHaveBeenCalled();
    expect(fixture.repository.submit).toHaveBeenCalledWith(expect.objectContaining({
      tokenMode: "delegated",
      resultScope: { kind: "principal", scopeId: user.homeAccountId, configurationRevision: null },
    }), { idempotencyKey: "ordinary-delegated", filters });
  });

  it("uses current exact-scope evidence for ordinary submissions and exact configuration for shared application results", async () => {
    const fixture = setup({ applicationIdentity: () => "application-client",
      requireApplicationDataScope: vi.fn(async () => ({ enabled: true, sharedDataScope: true, revision: 5 })),
      qualificationContext: vi.fn(async (capabilityId: "defender.hunting.delegated" | "defender.hunting.application") => ({
        capabilityId, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: capabilityId.endsWith(".application") ? 5 : 1,
      })) });
    fixture.repository.submit.mockResolvedValue(job({ tokenMode: "application" }));
    await fixture.service.submit(user, { tokenMode: "application", filters, idempotencyKey: "shared-hunt" });
    expect(fixture.dependencies.qualificationContext).toHaveBeenCalledWith("defender.hunting.application", user);
    expect(fixture.repository.requireQualifiedScope).toHaveBeenCalledWith(expect.objectContaining({ tokenMode: "application" }), filters,
      expect.objectContaining({ capabilityId: "defender.hunting.application" }));
    expect(fixture.repository.submit).toHaveBeenCalledWith(expect.objectContaining({ tokenMode: "application",
      resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 5 } }),
    { idempotencyKey: "shared-hunt", filters, retainedScope: { id: retainedScope.id, authority: expect.objectContaining({
      capabilityId: "defender.hunting.application", configurationRevision: 5,
    }) } });
  });

  it("lets Viewer revoke its exact retained read scope", async () => {
    const fixture = setup();
    fixture.repository.listRetainedScopes.mockResolvedValue([retained()]);
    await expect(fixture.service.revokeRetainedScope({ ...user, roles: [] }, retainedScope.id))
      .rejects.toMatchObject({ code: "missing_internal_role" });
    await expect(fixture.service.revokeRetainedScope(user, retainedScope.id)).resolves.toMatchObject({ id: retainedScope.id });
    expect(fixture.repository.revokeRetainedScope).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a" }), retainedScope.id, "delegated", user.homeAccountId);
  });

  it("does not let Viewer revoke a shared application retained scope", async () => {
    const fixture = setup({ applicationIdentity: () => "application-client" });
    fixture.repository.listRetainedScopes.mockResolvedValue([retained({
      capabilityId: "defender.hunting.application",
      tokenMode: "application",
      resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 1 },
    })]);
    await expect(fixture.service.revokeRetainedScope(user, retainedScope.id)).rejects.toMatchObject({ code: "missing_internal_role" });
    await expect(fixture.service.revokeRetainedScope({ ...user, roles: ["AgentControl.Admin"] }, retainedScope.id)).resolves.toMatchObject({ id: retainedScope.id });
  });

  it("reuses one active reservation and fences a held lookup during drain", async () => {
    const pendingUser = new Promise<AuthenticatedUser>(() => undefined);
    const duplicate = setup({ revalidateUser: vi.fn(() => pendingUser) });
    await duplicate.service.start(user, job().id, "delegated");
    await duplicate.service.start(user, job().id, "delegated");
    expect(duplicate.repository.begin).toHaveBeenCalledOnce();
    await duplicate.service.drain();

    let release!: (value: DefenderHuntingJob) => void;
    const pendingJob = new Promise<DefenderHuntingJob>(resolve => { release = resolve; });
    const held = setup();
    held.repository.getJob.mockImplementationOnce(() => pendingJob);
    const starting = held.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(held.repository.getJob).toHaveBeenCalledOnce());
    await held.service.drain();
    await expect(starting).rejects.toMatchObject({ code: "interaction_required" });
    release(job());
    expect(held.repository.begin).not.toHaveBeenCalled();
  });

  it("releases a database activation that commits after shutdown cancellation", async () => {
    const fixture = setup();
    const begin = fixture.repository.begin.getMockImplementation()!;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    fixture.repository.begin.mockImplementationOnce(async () => { await pending; return begin(); });
    const starting = fixture.service.start(user, job().id, "delegated");
    const rejected = expect(starting).rejects.toMatchObject({ code: "interaction_required" });
    await vi.waitFor(() => expect(fixture.repository.begin).toHaveBeenCalledOnce());
    const draining = fixture.service.drain();
    release();
    await rejected;
    await draining;
    expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce();
    expect(fixture.current().status).toBe("waiting_authorization");
    expect(fixture.dependencies.runQuery).not.toHaveBeenCalled();
  });

  it.each(["delegated", "application"] as const)("revalidates %s retained authority before every physical provider request", async mode => {
    const fixture = setup({ applicationIdentity: () => "application-client",
      runQuery: vi.fn<GraphHuntingClient["runQuery"]>(async (_token, _filters, options) => {
      await options?.beforeRequest?.();
      fixture.repository.requireQualifiedScope.mockRejectedValueOnce(new AppError(403, "hunting_scope_unqualified", "Revoked."));
      await options?.beforeRequest?.();
      return emptyResult;
    }) });
    if (mode === "application") fixture.setCurrent(job({ tokenMode: mode,
      resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 1 } }));
    await fixture.service.start(user, job().id, mode);
    await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    await fixture.service.drain();
    expect(fixture.repository.authorizeProviderRequest).toHaveBeenCalledOnce();
    expect(fixture.repository.publish).not.toHaveBeenCalled();
    expect(fixture.dependencies.recordProviderEvidence).not.toHaveBeenCalled();
  });

  it("does not send after the Viewer role is lost while acquiring a token", async () => {
    const fixture = setup({
      delegatedToken: vi.fn(async () => {
        fixture.dependencies.revalidateUser.mockResolvedValue({ ...user, roles: [] });
        return "delegated-token";
      }),
      runQuery: vi.fn<GraphHuntingClient["runQuery"]>(async (_token, _filters, options) => {
        await options?.beforeRequest?.();
        return emptyResult;
      }),
    });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    await fixture.service.drain();
    expect(fixture.repository.authorizeProviderRequest).not.toHaveBeenCalled();
    expect(fixture.repository.publish).not.toHaveBeenCalled();
  });

  it.each(["lookup", "record"] as const)("cancels a held failure-evidence %s without a stuck worker", async stage => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const fixture = setup({ runQuery: vi.fn<GraphHuntingClient["runQuery"]>(async (_token, _filters, options) => {
      await options?.beforeRequest?.();
      if (stage === "lookup") fixture.dependencies.revalidateUser.mockImplementationOnce(async () => { await pending; return user; });
      else fixture.dependencies.recordProviderEvidence.mockImplementationOnce(async () => { await pending; return { authorized: true }; });
      throw new AppError(403, "hunting_access_denied", "Denied.");
    }) });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await fixture.service.start(user, job().id, "delegated");
      await vi.waitFor(() => expect(fixture.repository.fail).toHaveBeenCalledOnce());
      if (stage === "record") await vi.waitFor(() => expect(fixture.dependencies.recordProviderEvidence).toHaveBeenCalledOnce());
      const draining = fixture.service.drain();
      let drained = false;
      void draining.then(() => { drained = true; });
      await vi.waitFor(() => expect(drained).toBe(true));
      release();
      await draining;
      expect(fixture.dependencies.recordProviderEvidence).toHaveBeenCalledTimes(stage === "lookup" ? 0 : 1);
      expect(fixture.audit.completeEvent).toHaveBeenCalledWith("audit-event", expect.objectContaining({ status: "inconclusive" }));
    } finally {
      release();
      await fixture.service.drain();
      warning.mockRestore();
    }
  });

  it("does not attribute failed provider evidence to a changed account", async () => {
    const fixture = setup({ runQuery: vi.fn<GraphHuntingClient["runQuery"]>(async (_token, _filters, options) => {
      await options?.beforeRequest?.();
      fixture.dependencies.revalidateUser.mockResolvedValue({ ...user, tenantId: "another-tenant" });
      throw new AppError(403, "hunting_access_denied", "Denied.");
    }) });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await fixture.service.start(user, job().id, "delegated");
      await vi.waitFor(() => expect(fixture.audit.completeEvent).toHaveBeenCalledOnce());
      expect(fixture.dependencies.recordProviderEvidence).not.toHaveBeenCalled();
    } finally {
      await fixture.service.drain();
      warning.mockRestore();
    }
  });

  it.each(["audit", "publication"] as const)("does not turn a local %s failure into provider evidence", async stage => {
    const fixture = setup({ runQuery: vi.fn<GraphHuntingClient["runQuery"]>(async (_token, _filters, options) => {
      await options?.beforeRequest?.();
      return emptyResult;
    }) });
    if (stage === "audit") fixture.audit.startEvent.mockRejectedValueOnce(new Error("Local audit write failed."));
    else fixture.repository.publish.mockRejectedValueOnce(new Error("Local snapshot write failed."));
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.repository.fail).toHaveBeenCalledOnce());
    await fixture.service.drain();
    expect(fixture.dependencies.recordProviderEvidence).not.toHaveBeenCalled();
  });

  it("logs unexpected worker persistence failures without leaking error messages", async () => {
    const fixture = setup({ revalidateUser: vi.fn(async () => { throw new Error("private-error-detail"); }) });
    fixture.repository.fail.mockRejectedValueOnce(new Error("private-database-detail"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await fixture.service.start(user, job().id, "delegated");
      await vi.waitFor(() => expect(fixture.repository.fail).toHaveBeenCalledOnce());
      await fixture.service.drain();
      expect(logged).toHaveBeenCalledOnce();
      expect(JSON.parse(logged.mock.calls[0][0])).toMatchObject({
        event: "hunting_worker_failed", jobId: job().id, errorCode: "hunting_worker_failed",
      });
      expect(logged.mock.calls[0][0]).not.toContain("private-");
    } finally {
      await fixture.service.drain();
      logged.mockRestore();
    }
  });

  it("preserves the owner's active reservation when another reader tries to start it", async () => {
    let release!: (value: AuthenticatedUser) => void;
    const pending = new Promise<AuthenticatedUser>(resolve => { release = resolve; });
    const fixture = setup({ revalidateUser: vi.fn(() => pending) });
    try {
      await fixture.service.start(user, job().id, "delegated");
      await expect(fixture.service.start({ ...user, homeAccountId: "other-reader" }, job().id, "delegated"))
        .rejects.toMatchObject({ code: "not_found" });
      await expect(fixture.service.start(user, job().id, "application")).rejects.toMatchObject({ code: "not_found" });
      const draining = fixture.service.drain();
      release(user);
      await draining;
      await vi.waitFor(() => expect(fixture.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
      expect(fixture.repository.begin).toHaveBeenCalledOnce();
      expect(fixture.dependencies.runQuery).not.toHaveBeenCalled();
    } finally {
      release(user);
      await fixture.service.drain();
    }
  });

  it("closes the query audit when durable execution ownership is lost", async () => {
    const fixture = setup({ runQuery: vi.fn(async () => {
      throw new AppError(409, "hunting_execution_lost", "Cancelled or replaced.");
    }) });
    await fixture.service.start(user, job().id, "delegated");
    await vi.waitFor(() => expect(fixture.dependencies.runQuery).toHaveBeenCalledOnce());
    await fixture.service.drain();
    expect(fixture.repository.publish).not.toHaveBeenCalled();
    expect(fixture.repository.fail).not.toHaveBeenCalled();
    expect(fixture.audit.completeEvent).toHaveBeenCalledWith("audit-event", {
      status: "inconclusive", errorCode: "hunting_execution_lost",
    });
  });
});