import { randomUUID } from "node:crypto";
import { acquireApplicationToken, acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { findTenantConfiguration } from "../config.js";
import { DefenderHuntingRepository, type DefenderHuntingExecution, type DefenderHuntingReadScope, type DefenderHuntingScope } from "../db/defenderHunting.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { DefenderHuntingJob, DefenderHuntingQualificationBinding, DefenderHuntingTokenMode } from "../types/defenderHunting.js";
import type { AuthenticatedUser } from "../types/session.js";
import { powerPlatformResourceTypes } from "../types/powerPlatformInventory.js";
import { hasAppRole, type CapabilityStatus } from "../types/capability.js";
import { capabilities } from "./capabilities.js";
import { getAuditLog } from "./auditLog.js";
import { GraphHuntingClient, validateDefenderHuntingFilters } from "./graphHunting.js";
import { operationalLog } from "./telemetry.js";
import { requireProviderAdmissions } from "./operationalState.js";
import { agentInvestigations, assertAgentHuntingScope, bindAgentHuntingFilters } from "./agentInvestigations.js";

type CapabilityId = "defender.hunting.delegated" | "defender.hunting.application";
type Dependencies = {
  delegatedToken: typeof acquireDelegatedToken;
  applicationToken: typeof acquireApplicationToken;
  revalidateUser: typeof revalidateAuthenticatedUser;
  requireAvailable: typeof capabilities.requireAvailable;
  observeOperation: typeof capabilities.observeOperation;
  requireApplicationDataScope: typeof capabilities.requireApplicationDataScope;
  applicationIdentity: (tenantId: string) => string | undefined;
  qualificationContext: typeof capabilities.huntingQualificationContext;
  recordProviderEvidence: typeof capabilities.recordHuntingQualificationEvidence;
  auditLog: typeof getAuditLog;
  runQuery: GraphHuntingClient["runQuery"];
  agentScope: typeof agentInvestigations.defenderScope;
};

const graphHunting = new GraphHuntingClient();
const defaultDependencies: Dependencies = {
  delegatedToken: acquireDelegatedToken,
  applicationToken: acquireApplicationToken,
  revalidateUser: revalidateAuthenticatedUser,
  requireAvailable: capabilities.requireAvailable.bind(capabilities),
  observeOperation: capabilities.observeOperation.bind(capabilities),
  requireApplicationDataScope: capabilities.requireApplicationDataScope.bind(capabilities),
  applicationIdentity: tenantId => findTenantConfiguration(tenantId)?.clientId,
  qualificationContext: capabilities.huntingQualificationContext.bind(capabilities),
  recordProviderEvidence: capabilities.recordHuntingQualificationEvidence.bind(capabilities),
  auditLog: getAuditLog,
  runQuery: graphHunting.runQuery.bind(graphHunting),
  agentScope: agentInvestigations.defenderScope.bind(agentInvestigations),
};

type SessionValidation = ReturnType<typeof beginAccountSessionValidation>;
type ActiveHunt = { actor: { tenantId: string; principalId: string }; tokenMode: DefenderHuntingTokenMode | undefined; qualificationOnly: boolean;
  controller: AbortController; started: Promise<DefenderHuntingJob>; operation: Promise<void> };
const maximumActiveHunts = 4;
const activationDeadlineMs = 60_000;

export class DefenderHuntingService {
  private readonly active = new Map<string, ActiveHunt>();
  private draining = false;

  constructor(private readonly repository = new DefenderHuntingRepository(), private readonly dependencies: Dependencies = defaultDependencies) {}

  async submit(user: AuthenticatedUser, input: { tokenMode: DefenderHuntingTokenMode; filters: unknown; idempotencyKey: string; agentRecordId?: string }) {
    requireViewer(user);
    const agent = input.agentRecordId === undefined ? undefined : await this.dependencies.agentScope(actorScope(user), input.agentRecordId);
    const filters = validateDefenderHuntingFilters(agent ? bindAgentHuntingFilters(input.filters, agent) : input.filters);
    const capabilityId = capabilityForMode(input.tokenMode);
    const applicationConfiguration = input.tokenMode === "application"
      ? await this.dependencies.requireApplicationDataScope(capabilityId, user) : undefined;
    const scope = scopeFor(user, input.tokenMode, applicationConfiguration?.revision, this.dependencies.applicationIdentity(user.tenantId!));
    if (input.tokenMode === "delegated") {
      await this.dependencies.requireAvailable(capabilityId, user);
      return this.repository.submit(scope, { idempotencyKey: input.idempotencyKey, filters });
    }
    const authority = await this.dependencies.qualificationContext(capabilityId, user);
    const retainedScope = await this.repository.requireQualifiedScope(scope, filters, authority);
    return this.repository.submit(scope, { idempotencyKey: input.idempotencyKey, filters, retainedScope });
  }

  async approveQualification(user: AuthenticatedUser, input: { tokenMode: DefenderHuntingTokenMode; filters: unknown; agentRecordId?: string }) {
    requireQualificationRole(user, input.tokenMode);
    const agent = input.agentRecordId === undefined ? undefined : await this.dependencies.agentScope(actorScope(user), input.agentRecordId);
    const filters = validateDefenderHuntingFilters(agent ? bindAgentHuntingFilters(input.filters, agent) : input.filters, { qualification: true });
    const capabilityId = capabilityForMode(input.tokenMode);
    const applicationConfiguration = input.tokenMode === "application"
      ? await this.dependencies.requireApplicationDataScope(capabilityId, user) : undefined;
    const context = await this.dependencies.qualificationContext(capabilityId, user);
    return this.repository.submit(scopeFor(user, input.tokenMode, applicationConfiguration?.revision, this.dependencies.applicationIdentity(user.tenantId!)), {
      idempotencyKey: `qualification_${randomUUID().replaceAll("-", "")}`,
      filters,
      qualification: { ...context, approvedBy: user.homeAccountId },
    });
  }

  async startQualification(user: AuthenticatedUser, id: string, agentRecordId?: string) {
    requireViewer(user);
    return this.startAuthorized(user, id, undefined, agentRecordId, true);
  }

  start(user: AuthenticatedUser, id: string, tokenMode: DefenderHuntingTokenMode, agentRecordId?: string): Promise<DefenderHuntingJob> {
    requireViewer(user);
    return this.startAuthorized(user, id, tokenMode, agentRecordId);
  }

  private startAuthorized(user: AuthenticatedUser, id: string, tokenMode: DefenderHuntingTokenMode | undefined,
    agentRecordId?: string, qualificationOnly = false): Promise<DefenderHuntingJob> {
    id = id.toLowerCase();
    if (this.draining) throw new AppError(503, "hunting_shutdown", "Hunting is stopping for application shutdown.");
    requireProviderAdmissions();
    const actor = actorScope(user);
    const validation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
    assertAccountSessionValidation(validation);
    const existing = this.active.get(id);
    if (existing) {
      return existing.actor.tenantId === actor.tenantId && existing.actor.principalId === actor.principalId
        && existing.tokenMode === tokenMode && existing.qualificationOnly === qualificationOnly && agentRecordId === undefined
        ? existing.started : this.currentJobForStart(user, id, tokenMode, agentRecordId, qualificationOnly);
    }
    if (this.active.size >= maximumActiveHunts) return this.currentJobForStart(user, id, tokenMode, agentRecordId, qualificationOnly);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(activationDeadlineMs)]);
    const prepared = this.prepareStart(user, actor, id, tokenMode, signal, controller.signal, validation, agentRecordId, qualificationOnly);
    const started = prepared.then(value => value.job);
    let operation: Promise<void>;
    operation = prepared.then(value => value.run?.(), error => {
      if (signal.aborted && error !== signal.reason) throw error;
    })
      .finally(() => { if (this.active.get(id)?.operation === operation) this.active.delete(id); });
    void operation.catch(error => {
      operationalLog("error", "hunting_worker_failed", { jobId: id,
        errorCode: error instanceof AppError ? error.code : "hunting_worker_failed" });
    });
    this.active.set(id, { actor, tokenMode, qualificationOnly, controller, started, operation });
    return started;
  }

  async get(user: AuthenticatedUser, id: string, agentRecordId?: string) {
    requireViewer(user);
    const scope = await this.readScope(user, agentRecordId);
    const job = await this.repository.getJob(scope, id);
    if (!job) throw new AppError(404, "not_found", "Hunting job was not found.");
    if (scope.entraAgentIds) assertAgentHuntingScope(job.filters, { recordId: agentRecordId!, entraAgentIds: scope.entraAgentIds, entraAgentApplicationIds: scope.entraAgentApplicationIds });
    return job;
  }

  async list(user: AuthenticatedUser, limit = 20, offset = 0, agentRecordId?: string) {
    requireViewer(user);
    return this.repository.listJobs(await this.readScope(user, agentRecordId), limit, offset);
  }

  async qualificationEvidence(user: AuthenticatedUser, agentRecordId?: string) {
    requireViewer(user);
    return this.repository.listQualificationEvidence(await this.readScope(user, agentRecordId));
  }

  async retainedScopes(user: AuthenticatedUser, agentRecordId?: string) {
    requireViewer(user);
    return this.repository.listRetainedScopes(await this.readScope(user, agentRecordId));
  }

  async revokeRetainedScope(user: AuthenticatedUser, id: string, agentRecordId?: string) {
    requireViewer(user);
    const readScope = await this.readScope(user, agentRecordId);
    const retained = (await this.repository.listRetainedScopes(readScope)).find(scope => scope.id === id);
    if (retained && readScope.entraAgentIds) assertAgentHuntingScope(retained.approvedScope, { recordId: agentRecordId!, entraAgentIds: readScope.entraAgentIds, entraAgentApplicationIds: readScope.entraAgentApplicationIds });
    if (!retained || (retained.tokenMode === "delegated" &&
      (retained.resultScope.kind !== "principal" || retained.resultScope.scopeId !== user.homeAccountId))) {
      throw new AppError(404, "not_found", "Current retained hunting scope was not found.");
    }
    requireQualificationRole(user, retained.tokenMode);
    return this.repository.revokeRetainedScope(readScope, id, retained.tokenMode, user.homeAccountId);
  }

  async rows(user: AuthenticatedUser, id: string, limit = 100, offset = 0, agentRecordId?: string) {
    requireViewer(user);
    return this.repository.listRows(await this.readScope(user, agentRecordId), id, limit, offset);
  }

  async cancel(user: AuthenticatedUser, id: string, agentRecordId?: string) {
    requireViewer(user);
    const readScope = await this.readScope(user, agentRecordId);
    const job = await this.repository.getJob(readScope, id);
    if (!job) throw new AppError(404, "not_found", "Hunting job was not found.");
    if (readScope.entraAgentIds) assertAgentHuntingScope(job.filters, { recordId: agentRecordId!, entraAgentIds: readScope.entraAgentIds, entraAgentApplicationIds: readScope.entraAgentApplicationIds });
    this.active.get(job.id.toLowerCase())?.controller.abort(new AppError(409, "hunting_cancelled", "Hunting was cancelled locally."));
    return this.repository.cancel(readScope, id);
  }

  async delete(user: AuthenticatedUser, id: string, agentRecordId?: string) {
    requireViewer(user);
    const readScope = await this.readScope(user, agentRecordId);
    const job = await this.repository.getJob(readScope, id);
    if (!job) throw new AppError(404, "not_found", "Hunting job was not found.");
    if (readScope.entraAgentIds) assertAgentHuntingScope(job.filters, { recordId: agentRecordId!, entraAgentIds: readScope.entraAgentIds, entraAgentApplicationIds: readScope.entraAgentApplicationIds });
    this.active.get(job.id.toLowerCase())?.controller.abort(new AppError(409, "hunting_cancelled", "Hunting local cache was deleted."));
    await this.repository.delete(readScope, id);
  }

  recover() { return this.repository.recoverInterrupted(); }

  async drain() {
    this.draining = true;
    const active = [...this.active.values()];
    for (const hunt of active) hunt.controller.abort(new AppError(401, "interaction_required", "Application shutdown requires explicit hunting resume."));
    const results = await Promise.allSettled(active.map(hunt => hunt.operation));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  async waitForPrincipalAuthorization(scope: { tenantId: string; principalId: string }) {
    for (const hunt of this.active.values()) {
      if (hunt.actor.tenantId === scope.tenantId && hunt.actor.principalId === scope.principalId) {
        hunt.controller.abort(new AppError(401, "interaction_required", "The signed-in account changed during hunting."));
      }
    }
  }

  private async prepareStart(user: AuthenticatedUser, actor: { tenantId: string; principalId: string }, id: string,
    tokenMode: DefenderHuntingTokenMode | undefined, signal: AbortSignal, cancellationSignal: AbortSignal,
    validation: SessionValidation, agentRecordId?: string, qualificationOnly = false) {
    const current = await abortable(this.currentJobForStart(user, id, tokenMode, agentRecordId, qualificationOnly, signal), signal);
    assertCurrent(validation, signal);
    if (current.status !== "waiting_authorization") return { job: current };
    const scope = scopeFromResult(user, current.tokenMode, current.resultScope);
    // Activation commits durable ownership; settle it before handling cancellation.
    const execution = await commitAccountSessionValidation(validation, async () => {
      assertCurrent(validation, signal);
      return this.repository.begin(scope, id);
    });
    try { assertCurrent(validation, signal); }
    catch (error) {
      try { await this.repository.markWaitingAuthorization(scope, id, execution); } catch (error) {
        if (!(error instanceof AppError && error.code === "hunting_execution_lost")) throw error;
      }
      throw error;
    }
    return { job: execution.job, run: () => this.run(actor, scope, execution.job, execution, signal, cancellationSignal, validation, agentRecordId) };
  }

  private async currentJobForStart(user: AuthenticatedUser, id: string, tokenMode: DefenderHuntingTokenMode | undefined,
    agentRecordId?: string, qualificationOnly = false, signal?: AbortSignal) {
    const readScope = await abortable(this.readScope(user, agentRecordId), signal);
    signal?.throwIfAborted();
    const current = await abortable(this.repository.getJob(readScope, id), signal);
    if (!current || current.authorizationPrincipalId !== user.homeAccountId || tokenMode !== undefined && current.tokenMode !== tokenMode
      || qualificationOnly && !current.qualification) throw new AppError(404, "not_found", "Hunting job was not found.");
    if (readScope.entraAgentIds) assertAgentHuntingScope(current.filters, { recordId: agentRecordId!,
      entraAgentIds: readScope.entraAgentIds, entraAgentApplicationIds: readScope.entraAgentApplicationIds });
    if (current.qualification) {
      requireQualificationRole(user, current.tokenMode);
      await this.validateQualification(current.qualification, user, signal);
    }
    return current;
  }

  private async run(actor: { tenantId: string; principalId: string }, scope: DefenderHuntingScope, current: DefenderHuntingJob,
    execution: DefenderHuntingExecution, signal: AbortSignal, cancellationSignal: AbortSignal, validation: SessionValidation, agentRecordId?: string) {
    let auditEvent: Awaited<ReturnType<ReturnType<typeof getAuditLog>["startEvent"]>> | undefined;
    let providerRequestAuthorized = false;
    let providerCompleted = false;
    let phaseSignal = signal;
    const pendingAdmissions: Promise<void>[] = [];
    try {
      const { user: freshUser, capabilityId } = await this.validateCurrentAuthority(actor, scope, current, signal, validation, agentRecordId);
      const token = await abortable(this.dependencies.observeOperation(capabilityId, freshUser, () => {
        assertCurrent(validation, signal);
        return abortable(scope.tokenMode === "delegated" ? this.dependencies.delegatedToken(actor.tenantId, actor.principalId, capabilityId)
          : this.dependencies.applicationToken(actor.tenantId, capabilityId), signal);
      }, { signal, clearOnSuccess: false }), signal);
      if (scope.tokenMode === "application") await this.requireExactApplicationScope(scope, freshUser, capabilityId, signal);
      if (current.qualification) await this.validateQualification(current.qualification, freshUser, signal);
      await abortable(commitAccountSessionValidation(validation, async () => {
        assertCurrent(validation, signal);
        requireSamePrincipal(actor, freshUser);
        current.qualification ? requireQualificationRole(freshUser, scope.tokenMode) : requireViewer(freshUser);
      }), signal);
      const audit = this.dependencies.auditLog(actor);
      auditEvent = await audit.startEvent({ operationId: `query-hunting:${current.id}:${current.localRequestId}`, scope: "single",
        action: "query-hunting", agentId: current.id, actor: freshUser, requestPath: `/api/hunting/jobs/${current.id}`,
        metadata: { source: "microsoft_defender_hunting", template: current.filters.templateId, mode: current.tokenMode, correlationId: current.localRequestId } });
      assertCurrent(validation, signal);
      const result = await abortable(this.dependencies.observeOperation(capabilityId, freshUser, () => this.dependencies.runQuery(token, current.filters, {
        signal, correlationId: current.localRequestId, tenantId: actor.tenantId,
        beforeRequest: async (requestSignal = signal) => {
          await this.validateCurrentAuthority(actor, scope, current, requestSignal, validation, agentRecordId);
          const admission = commitAccountSessionValidation(validation, async () => {
            assertCurrent(validation, requestSignal);
            await this.repository.authorizeProviderRequest(scope, current.id, execution);
            assertCurrent(validation, requestSignal);
          });
          pendingAdmissions.push(admission);
          await abortable(admission, requestSignal);
          assertCurrent(validation, requestSignal);
          providerRequestAuthorized = true;
        },
        onResponse: providerRequestId => this.repository.recordProviderResponse(scope, current.id, execution, providerRequestId),
      }), { signal }), signal);
      providerCompleted = true;
      signal.throwIfAborted();
      const publicationSignal = AbortSignal.any([cancellationSignal, AbortSignal.timeout(10_000)]);
      phaseSignal = publicationSignal;
      const { user: publicationUser } = await this.validateCurrentAuthority(actor, scope, current, publicationSignal, validation, agentRecordId);
      // Keep durable writes joined until their commit fence and transaction cleanup settle.
      const job = await commitAccountSessionValidation(validation, async () => {
        assertCurrent(validation, publicationSignal);
        requireSamePrincipal(actor, publicationUser);
        current.qualification ? requireQualificationRole(publicationUser, scope.tokenMode) : requireViewer(publicationUser);
        return this.repository.publish(scope, current.id, execution, result, () => assertCurrent(validation, publicationSignal));
      });
      if (scope.tokenMode === "delegated" && ["succeeded", "partial"].includes(job.status)) {
        try {
          assertCurrent(validation, publicationSignal);
          await abortable(this.dependencies.recordProviderEvidence(capabilityId, publicationUser, "available", {
            providerRequestId: job.providerRequestId,
          }), publicationSignal);
        } catch {
          operationalLog("warn", "capability_evidence_record_failed", { capabilityId, outcome: "provider_success" });
        }
      }
      await audit.completeEvent(auditEvent.id, { status: job.status === "partial" ? "inconclusive" : "succeeded",
        metadata: { source: "microsoft_defender_hunting", template: current.filters.templateId, mode: current.tokenMode,
          correlationId: current.localRequestId, rowCount: job.storedRowCount, requestCount: job.providerRequestCount } });
    } catch (error) {
      if (error instanceof AppError && error.code === "hunting_execution_lost") {
        if (auditEvent) await this.dependencies.auditLog(actor).completeEvent(auditEvent.id, {
          status: phaseSignal.aborted ? "cancelled" : "inconclusive", errorCode: error.code });
        return;
      }
      if (phaseSignal.aborted || isLocalAuthorizationFailure(error)) {
        try { await this.repository.markWaitingAuthorization(scope, current.id, execution); } catch (markError) {
          if (!(markError instanceof AppError && markError.code === "hunting_execution_lost")) throw markError;
        }
        if (auditEvent) await this.dependencies.auditLog(actor).completeEvent(auditEvent.id, {
          status: phaseSignal.aborted ? "cancelled" : "inconclusive", errorCode: error instanceof AppError ? error.code : "interaction_required" });
        return;
      }
      const inconclusive = error instanceof AppError && ["provider_schema", "provider_error", "provider_throttled", "invalid_provider_link", "hunting_access_denied",
        "hunting_provider_request_limit", "hunting_job_expired"].includes(error.code);
      let failed: DefenderHuntingJob | undefined;
      try {
        failed = await this.repository.fail(scope, current.id, execution, error instanceof AppError ? error.code : "provider_error", safeFailureMessage(error), inconclusive);
      } catch (failure) {
        if (!(failure instanceof AppError && failure.code === "hunting_execution_lost")) throw failure;
        if (auditEvent) await this.dependencies.auditLog(actor).completeEvent(auditEvent.id, {
          status: phaseSignal.aborted ? "cancelled" : "inconclusive", errorCode: failure.code });
        return;
      }
      if (scope.tokenMode === "delegated" && providerRequestAuthorized && !providerCompleted
        && error instanceof AppError && ["missing_permission", "unsupported", "provider_schema", "provider_error",
          "provider_throttled", "invalid_provider_link", "hunting_access_denied"].includes(error.code)) {
        try {
          const evidenceUser = await abortable(this.dependencies.revalidateUser(actor.tenantId, actor.principalId), signal);
          assertCurrent(validation, signal);
          requireSamePrincipal(actor, evidenceUser);
          requireViewer(evidenceUser);
          await abortable(this.dependencies.recordProviderEvidence(capabilityForMode(scope.tokenMode), evidenceUser, providerEvidenceStatus(error), {
            category: error.code,
            providerRequestId: failed?.providerRequestId ?? null,
          }), signal);
        } catch {
          operationalLog("warn", "capability_evidence_record_failed", { capabilityId: capabilityForMode(scope.tokenMode), outcome: "provider_failure" });
        }
      }
      if (auditEvent) await this.dependencies.auditLog(actor).completeEvent(auditEvent.id, { status: inconclusive ? "inconclusive" : "failed",
        errorCode: error instanceof AppError ? error.code : "provider_error", metadata: { source: "microsoft_defender_hunting",
          template: current.filters.templateId, mode: current.tokenMode, correlationId: current.localRequestId, requestCount: failed?.providerRequestCount ?? 0 } });
    } finally { await Promise.allSettled(pendingAdmissions); }
  }

  private async validateCurrentAuthority(actor: { tenantId: string; principalId: string }, scope: DefenderHuntingScope,
    current: DefenderHuntingJob, signal: AbortSignal, validation: SessionValidation, agentRecordId?: string) {
    assertCurrent(validation, signal);
    const freshUser = await abortable(this.dependencies.revalidateUser(actor.tenantId, actor.principalId), signal);
    assertCurrent(validation, signal);
    requireSamePrincipal(actor, freshUser);
    current.qualification ? requireQualificationRole(freshUser, scope.tokenMode) : requireViewer(freshUser);
    const capabilityId = capabilityForMode(scope.tokenMode);
    if (scope.tokenMode === "application") await this.requireExactApplicationScope(scope, freshUser, capabilityId, signal);
    if (current.qualification) await this.validateQualification(current.qualification, freshUser, signal);
    else if (current.retainedScopeId) {
      const authority = await abortable(this.dependencies.qualificationContext(capabilityId, freshUser), signal);
      await abortable(this.repository.requireQualifiedScope(scope, current.filters, authority, current.retainedScopeId), signal);
    } else if (scope.tokenMode === "delegated") {
      await abortable(this.dependencies.requireAvailable(capabilityId, freshUser), signal);
    } else {
      throw new AppError(403, "hunting_scope_unqualified", "Application hunting requires an exact current retained-scope qualification.");
    }
    assertCurrent(validation, signal);
    if (agentRecordId !== undefined) {
      const agent = await abortable(this.dependencies.agentScope(actorScope(freshUser), agentRecordId), signal);
      assertAgentHuntingScope(current.filters, agent);
    }
    assertCurrent(validation, signal);
    return { user: freshUser, capabilityId };
  }

  private async validateQualification(qualification: DefenderHuntingQualificationBinding, user: AuthenticatedUser, signal?: AbortSignal) {
    const context = await abortable(this.dependencies.qualificationContext(qualification.capabilityId, user), signal);
    if (qualification.contractRevision !== context.contractRevision || qualification.permissionRevision !== context.permissionRevision
      || qualification.configurationRevision !== context.configurationRevision) throw new AppError(409, "qualification_superseded", "Hunting permission, contract, or configuration changed after approval.");
  }

  private async requireExactApplicationScope(scope: DefenderHuntingScope, user: AuthenticatedUser, capabilityId: CapabilityId, signal: AbortSignal) {
    const configuration = await abortable(this.dependencies.requireApplicationDataScope(capabilityId, user), signal);
    const current = scopeFor(user, "application", configuration.revision, this.dependencies.applicationIdentity(user.tenantId!)).resultScope;
    if (!resultScopeMatches(scope.resultScope, current)) throw new AppError(409, "application_scope_changed", "Application hunting configuration changed after this job was submitted.");
  }

  private async resultScopeForMode(user: AuthenticatedUser, tokenMode: DefenderHuntingTokenMode, signal?: AbortSignal) {
    if (tokenMode === "delegated") return scopeFor(user, tokenMode).resultScope;
    const configuration = await abortable(this.dependencies.requireApplicationDataScope(capabilityForMode(tokenMode), user), signal);
    return scopeFor(user, tokenMode, configuration?.revision, this.dependencies.applicationIdentity(user.tenantId!)).resultScope;
  }

  private async readScope(user: AuthenticatedUser, agentRecordId?: string): Promise<DefenderHuntingReadScope> {
    if (!user.tenantId) throw AppError.unauthorized("Hunting requires a tenant scope.");
    const agent = agentRecordId === undefined ? undefined : await this.dependencies.agentScope(actorScope(user), agentRecordId);
    const delegatedScope = scopeFor(user, "delegated").resultScope;
    const delegatedAuthority = await this.dependencies.qualificationContext("defender.hunting.delegated", user);
    const resultScopes = [delegatedScope];
    const qualifications = [{ resultScope: delegatedScope, authority: delegatedAuthority }];
    try {
      const applicationScope = await this.resultScopeForMode(user, "application");
      resultScopes.push(applicationScope);
      qualifications.push({ resultScope: applicationScope, authority: await this.dependencies.qualificationContext("defender.hunting.application", user) });
    }
    catch (error) { if (!(error instanceof AppError && error.code === "not_configured")) throw error; }
    return { tenantId: user.tenantId, authorizationPrincipalId: user.homeAccountId, resultScopes, qualifications,
      ...(agent ? { entraAgentIds: agent.entraAgentIds, entraAgentApplicationIds: agent.entraAgentApplicationIds } : {}),
      ...(hasAppRole(user.roles, "AgentControl.Viewer") ? { inventoryIdentityScope: {
        principalId: user.homeAccountId, resourceTypes: [...powerPlatformResourceTypes],
      } } : {}) };
  }
}

export const defenderHunting = new DefenderHuntingService();

function capabilityForMode(mode: DefenderHuntingTokenMode): CapabilityId {
  return mode === "delegated" ? "defender.hunting.delegated" : "defender.hunting.application";
}

function scopeFor(user: AuthenticatedUser, tokenMode: DefenderHuntingTokenMode, applicationRevision?: number, applicationId?: string): DefenderHuntingScope {
  if (!user.tenantId) throw AppError.unauthorized("Hunting requires a tenant scope.");
  if (tokenMode === "application") {
    if (!applicationId || !applicationRevision) throw new AppError(503, "not_configured", "Application hunting requires configured tenant and client identity.");
    return { tenantId: user.tenantId, authorizationPrincipalId: user.homeAccountId,
      resultScope: { kind: "application", scopeId: applicationId, configurationRevision: applicationRevision }, tokenMode };
  }
  return { tenantId: user.tenantId, authorizationPrincipalId: user.homeAccountId,
    resultScope: { kind: "principal", scopeId: user.homeAccountId, configurationRevision: null }, tokenMode };
}

function scopeFromResult(user: AuthenticatedUser, tokenMode: DefenderHuntingTokenMode, resultScope: DefenderHuntingScope["resultScope"]): DefenderHuntingScope {
  if (!user.tenantId) throw AppError.unauthorized("Hunting requires a tenant scope.");
  return { tenantId: user.tenantId, authorizationPrincipalId: user.homeAccountId, resultScope, tokenMode };
}

function resultScopeMatches(left: DefenderHuntingScope["resultScope"], right: DefenderHuntingScope["resultScope"]) {
  return left.kind === right.kind && left.scopeId === right.scopeId && left.configurationRevision === right.configurationRevision;
}

function actorScope(user: AuthenticatedUser) {
  if (!user.tenantId) throw AppError.unauthorized("Hunting requires a tenant scope.");
  return { tenantId: user.tenantId, principalId: user.homeAccountId };
}

function requireViewer(user: AuthenticatedUser) {
  if (!hasAppRole(user.roles, "AgentControl.Viewer")) throw new AppError(403, "missing_internal_role", "Hunting requires the Viewer role.");
}

function requireQualificationRole(user: AuthenticatedUser, tokenMode: DefenderHuntingTokenMode) {
  requireViewer(user);
  if (tokenMode === "application" && !hasAppRole(user.roles, "AgentControl.Admin")) {
    throw new AppError(403, "missing_internal_role", "Application hunting qualification approval requires the Admin role.");
  }
}

function requireSamePrincipal(scope: { tenantId: string; principalId: string }, user: AuthenticatedUser) {
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The signed-in account changed during hunting.");
}

function isLocalAuthorizationFailure(error: unknown) {
  return error instanceof AppError && (error.status === 401 || ["interaction_required", "authorization_expired", "missing_internal_role", "capability_unavailable", "not_configured",
    "application_scope_changed", "qualification_superseded", "hunting_scope_unqualified", "maintenance", "provider_requalification_required"].includes(error.code));
}

function assertCurrent(validation: SessionValidation, signal: AbortSignal) {
  signal.throwIfAborted();
  assertAccountSessionValidation(validation);
  requireProviderAdmissions();
}

function providerEvidenceStatus(error: unknown): CapabilityStatus {
  if (error instanceof AppError && error.code === "missing_permission") return "missing_permission";
  if (error instanceof AppError && error.code === "unsupported") return "unsupported";
  return "provider_error";
}

function safeFailureMessage(error: unknown) {
  if (error instanceof AppError && ["provider_error", "provider_schema", "provider_throttled", "invalid_provider_link", "hunting_access_denied"].includes(error.code)) return error.message.slice(0, 1024);
  return "Hunting stopped before complete minimized result publication.";
}

function abortable<T>(work: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  const promise = Promise.resolve(work);
  if (!signal) return promise;
  if (signal.aborted) { promise.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", onAbort); resolve(value); }, error => {
      signal.removeEventListener("abort", onAbort); reject(error);
    });
  });
}