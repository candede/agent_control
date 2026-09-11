import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { DefenderHuntingFilters, DefenderHuntingJob, DefenderHuntingQueryResult } from "../types/defenderHunting.js";
import type { AuthenticatedUser } from "../types/session.js";
import { DefenderHuntingService } from "./defenderHunting.js";

const user: AuthenticatedUser = { homeAccountId: "security-a", tenantId: "tenant-a", username: "security@example.invalid", displayName: "Security Reader",
  roles: ["AgentControl.SecurityReader", "AgentControl.Administrator"], providerRoles: [], providerRoleScope: "unknown" };
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

function setup(overrides: Record<string, unknown> = {}) {
  let current = job();
  const execution = { owner: "33333333-3333-4333-8333-333333333333", version: 1 };
  const audit = { startEvent: vi.fn(async () => ({ id: "audit-event" })), completeEvent: vi.fn(async () => undefined) };
  const repository = {
    getJob: vi.fn(async () => current), begin: vi.fn(async () => { current = { ...current, status: "running", activationCount: current.activationCount + 1 }; return { ...execution, job: current }; }),
    requireQualifiedScope: vi.fn(async (_scope, _filters, authority) => ({ id: retainedScope.id, authority })),
    listQualificationEvidence: vi.fn(async () => []), listRetainedScopes: vi.fn(async () => []),
    authorizeProviderRequest: vi.fn(async () => undefined), recordProviderResponse: vi.fn(async () => undefined),
    publish: vi.fn(async () => { current = { ...current, status: "succeeded", complete: true, noData: true }; return current; }),
    markWaitingAuthorization: vi.fn(async () => { current = { ...current, status: "waiting_authorization" }; return current; }),
    fail: vi.fn(async (_scope, _id, _execution, code) => { current = { ...current, status: "inconclusive", errorCode: code }; return current; }),
    submit: vi.fn(async () => current), listJobs: vi.fn(async () => ({ value: [current], count: 1, limit: 20, offset: 0 })),
    listRows: vi.fn(), cancel: vi.fn(async () => { current = { ...current, status: "cancelled" }; return current; }), delete: vi.fn(),
    revokeRetainedScope: vi.fn(async () => ({ id: retainedScope.id })), recoverInterrupted: vi.fn(async () => 0),
  };
  const dependencies = { delegatedToken: vi.fn(async () => "delegated-token"), applicationToken: vi.fn(async () => "application-token"),
    revalidateUser: vi.fn(async () => user),
    requireApplicationDataScope: vi.fn(async () => ({ enabled: true, sharedDataScope: true, revision: 1 })), applicationIdentity: () => undefined,
    qualificationContext: vi.fn(async (capabilityId: "defender.hunting.delegated" | "defender.hunting.application") => ({ capabilityId, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 })),
    recordQualificationEvidence: vi.fn(async () => ({ authorized: true })), auditLog: vi.fn(() => audit), runQuery: vi.fn(async () => emptyResult), ...overrides };
  return { repository, dependencies, service: new DefenderHuntingService(repository as never, dependencies as never), current: () => current,
    setCurrent: (value: DefenderHuntingJob) => { current = value; }, audit };
}

describe("Defender hunting worker", () => {
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

  it("publishes feature-owned qualification evidence without mutating global capability evidence", async () => {
    const fixture = setup();
    fixture.setCurrent(job({ qualification }));
    await fixture.service.startQualification(user, job().id);
    await vi.waitFor(() => expect(fixture.repository.publish).toHaveBeenCalledOnce());
    expect(fixture.dependencies.recordQualificationEvidence).not.toHaveBeenCalled();
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
    const fixture = setup({ runQuery: vi.fn(async () => { throw new AppError(403, "hunting_access_denied", "ambiguous"); }) });
    fixture.setCurrent(job({ qualification }));
    await fixture.service.startQualification(user, job().id);
    await vi.waitFor(() => expect(fixture.repository.fail).toHaveBeenCalledWith(expect.anything(), job().id, expect.anything(), "hunting_access_denied", expect.any(String), true));
    expect(fixture.dependencies.recordQualificationEvidence).not.toHaveBeenCalled();
  });

  it("requires SecurityReader for data and Administrator additionally for qualification approval", async () => {
    const fixture = setup();
    const readerOnly = { ...user, roles: ["AgentControl.Reader"] as AuthenticatedUser["roles"] };
    expect(() => fixture.service.start(readerOnly, job().id, "delegated")).toThrowError(expect.objectContaining({ code: "missing_internal_role" }));
    await expect(fixture.service.approveQualification({ ...user, roles: ["AgentControl.SecurityReader"] }, { tokenMode: "delegated", filters }))
      .rejects.toMatchObject({ code: "missing_internal_role" });
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

  it("requires Administrator and SecurityReader to revoke an exact retained scope", async () => {
    const fixture = setup();
    await expect(fixture.service.revokeRetainedScope({ ...user, roles: ["AgentControl.SecurityReader"] }, retainedScope.id))
      .rejects.toMatchObject({ code: "missing_internal_role" });
    await expect(fixture.service.revokeRetainedScope(user, retainedScope.id)).resolves.toMatchObject({ id: retainedScope.id });
    expect(fixture.repository.revokeRetainedScope).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a" }), retainedScope.id, user.homeAccountId);
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
});