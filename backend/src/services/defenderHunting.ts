import { randomUUID } from "node:crypto";
import { acquireApplicationToken, acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { config } from "../config.js";
import { DefenderHuntingRepository, type DefenderHuntingExecution, type DefenderHuntingReadScope, type DefenderHuntingScope } from "../db/defenderHunting.js";
import { beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { DefenderHuntingJob, DefenderHuntingQualificationBinding, DefenderHuntingTokenMode } from "../types/defenderHunting.js";
import type { AuthenticatedUser } from "../types/session.js";
import { capabilities } from "./capabilities.js";
import { getAuditLog } from "./auditLog.js";
import { GraphHuntingClient, validateDefenderHuntingFilters } from "./graphHunting.js";
import { inventoryRoleScope, resourceTypesForInventoryScope } from "./inventoryRoleScope.js";

type CapabilityId = "defender.hunting.delegated" | "defender.hunting.application";
type Dependencies = {
  delegatedToken: typeof acquireDelegatedToken;
  applicationToken: typeof acquireApplicationToken;
  revalidateUser: typeof revalidateAuthenticatedUser;
  requireApplicationDataScope: typeof capabilities.requireApplicationDataScope;
  applicationIdentity: () => string | undefined;
  qualificationContext: typeof capabilities.huntingQualificationContext;
  auditLog: typeof getAuditLog;
  runQuery: GraphHuntingClient["runQuery"];
};

const graphHunting = new GraphHuntingClient();
const defaultDependencies: Dependencies = {
  delegatedToken: acquireDelegatedToken,
  applicationToken: acquireApplicationToken,
  revalidateUser: revalidateAuthenticatedUser,
  requireApplicationDataScope: capabilities.requireApplicationDataScope.bind(capabilities),
  applicationIdentity: () => config.clientId,
  qualificationContext: capabilities.huntingQualificationContext.bind(capabilities),
  auditLog: getAuditLog,
  runQuery: graphHunting.runQuery.bind(graphHunting),
};

type ActiveHunt = { actor: { tenantId: string; principalId: string }; controller: AbortController; started: Promise<DefenderHuntingJob>; operation: Promise<void> };
const maximumActiveHunts = 4;
const activationDeadlineMs = 60_000;

export class DefenderHuntingService {
  private readonly active = new Map<string, ActiveHunt>();

  constructor(private readonly repository = new DefenderHuntingRepository(), private readonly dependencies: Dependencies = defaultDependencies) {}

  async submit(user: AuthenticatedUser, input: { tokenMode: DefenderHuntingTokenMode; filters: unknown; idempotencyKey: string }) {
    requireSecurityReader(user);
    const filters = validateDefenderHuntingFilters(input.filters);
    const capabilityId = capabilityForMode(input.tokenMode);
    const applicationConfiguration = input.tokenMode === "application"
      ? await this.dependencies.requireApplicationDataScope(capabilityId, user) : undefined;
    const scope = scopeFor(user, input.tokenMode, applicationConfiguration?.revision, this.dependencies.applicationIdentity());
    const authority = await this.dependencies.qualificationContext(capabilityId, user);
    const retainedScope = await this.repository.requireQualifiedScope(scope, filters, authority);
    return this.repository.submit(scope, { idempotencyKey: input.idempotencyKey, filters, retainedScope });
  }

  async approveQualification(user: AuthenticatedUser, input: { tokenMode: DefenderHuntingTokenMode; filters: unknown }) {
    requireQualificationApprover(user);
    const filters = validateDefenderHuntingFilters(input.filters, { qualification: true });
    const capabilityId = capabilityForMode(input.tokenMode);
    const applicationConfiguration = input.tokenMode === "application"
      ? await this.dependencies.requireApplicationDataScope(capabilityId, user) : undefined;
    const context = await this.dependencies.qualificationContext(capabilityId, user);
    return this.repository.submit(scopeFor(user, input.tokenMode, applicationConfiguration?.revision, this.dependencies.applicationIdentity()), {
      idempotencyKey: `qualification_${randomUUID().replaceAll("-", "")}`,
      filters,
      qualification: { ...context, approvedBy: user.homeAccountId },
    });
  }

  async startQualification(user: AuthenticatedUser, id: string) {
    requireQualificationApprover(user);
    const job = await this.repository.getJob(await this.readScope(user), id);
    if (!job?.qualification || job.authorizationPrincipalId !== user.homeAccountId) throw new AppError(404, "not_found", "Hunting qualification was not found.");
    await this.validateQualification(job.qualification, user);
    return job.status === "waiting_authorization" ? this.start(user, job.id, job.tokenMode) : job;
  }

  start(user: AuthenticatedUser, id: string, tokenMode: DefenderHuntingTokenMode): Promise<DefenderHuntingJob> {
    requireSecurityReader(user);
    const actor = actorScope(user);
    const existing = this.active.get(id);
    if (existing && existing.actor.tenantId === actor.tenantId && existing.actor.principalId === actor.principalId) return existing.started;
    if (this.active.size >= maximumActiveHunts) return this.currentJobForStart(user, id, tokenMode);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(activationDeadlineMs)]);
    const prepared = this.prepareStart(user, actor, id, tokenMode, signal, controller.signal);
    const started = prepared.then(value => value.job);
    let operation: Promise<void>;
    operation = prepared.then(value => value.run?.()).then(() => undefined).catch(() => undefined)
      .finally(() => { if (this.active.get(id)?.operation === operation) this.active.delete(id); });
    this.active.set(id, { actor, controller, started, operation });
    return started;
  }

  async get(user: AuthenticatedUser, id: string) {
    requireSecurityReader(user);
    const job = await this.repository.getJob(await this.readScope(user), id);
    if (!job) throw new AppError(404, "not_found", "Hunting job was not found.");
    return job;
  }

  async list(user: AuthenticatedUser, limit = 20, offset = 0) {
    requireSecurityReader(user);
    return this.repository.listJobs(await this.readScope(user), limit, offset);
  }

  async relatedInventoryRows(user: AuthenticatedUser, entraAgentId: string, limit = 20) {
    requireSecurityReader(user);
    return this.repository.relatedInventoryRows(await this.readScope(user), entraAgentId, limit);
  }

  async qualificationEvidence(user: AuthenticatedUser) {
    requireSecurityReader(user);
    return this.repository.listQualificationEvidence(await this.readScope(user));
  }

  async retainedScopes(user: AuthenticatedUser) {
    requireSecurityReader(user);
    return this.repository.listRetainedScopes(await this.readScope(user));
  }

  async revokeRetainedScope(user: AuthenticatedUser, id: string) {
    requireQualificationApprover(user);
    return this.repository.revokeRetainedScope(await this.readScope(user), id, user.homeAccountId);
  }

  async rows(user: AuthenticatedUser, id: string, limit = 100, offset = 0) {
    requireSecurityReader(user);
    return this.repository.listRows(await this.readScope(user), id, limit, offset);
  }

  async cancel(user: AuthenticatedUser, id: string) {
    requireSecurityReader(user);
    const readScope = await this.readScope(user);
    if (!await this.repository.getJob(readScope, id)) throw new AppError(404, "not_found", "Hunting job was not found.");
    this.active.get(id)?.controller.abort(new AppError(409, "hunting_cancelled", "Hunting was cancelled locally."));
    return this.repository.cancel(readScope, id);
  }

  async delete(user: AuthenticatedUser, id: string) {
    requireSecurityReader(user);
    const readScope = await this.readScope(user);
    if (!await this.repository.getJob(readScope, id)) throw new AppError(404, "not_found", "Hunting job was not found.");
    this.active.get(id)?.controller.abort(new AppError(409, "hunting_cancelled", "Hunting local cache was deleted."));
    await this.repository.delete(readScope, id);
  }

  recover() { return this.repository.recoverInterrupted(); }

  async drain() {
    const active = [...this.active.values()];
    for (const hunt of active) hunt.controller.abort(new AppError(401, "interaction_required", "Application shutdown requires explicit hunting resume."));
    await Promise.allSettled(active.map(hunt => hunt.operation));
  }

  async waitForPrincipalAuthorization(scope: { tenantId: string; principalId: string }) {
    for (const hunt of this.active.values()) {
      if (hunt.actor.tenantId === scope.tenantId && hunt.actor.principalId === scope.principalId) {
        hunt.controller.abort(new AppError(401, "interaction_required", "The signed-in account changed during hunting."));
      }
    }
  }

  private async prepareStart(user: AuthenticatedUser, actor: { tenantId: string; principalId: string }, id: string,
    tokenMode: DefenderHuntingTokenMode, signal: AbortSignal, cancellationSignal: AbortSignal) {
    const current = await abortable(this.repository.getJob(await abortable(this.readScope(user), signal), id), signal);
    if (!current || current.authorizationPrincipalId !== user.homeAccountId || current.tokenMode !== tokenMode) throw new AppError(404, "not_found", "Hunting job was not found.");
    if (current.status !== "waiting_authorization") return { job: current };
    const scope = scopeFromResult(user, tokenMode, current.resultScope);
    const execution = await abortable(this.repository.begin(scope, id), signal);
    signal.throwIfAborted();
    return { job: execution.job, run: () => this.run(actor, scope, execution.job, execution, signal, cancellationSignal) };
  }

  private async currentJobForStart(user: AuthenticatedUser, id: string, tokenMode: DefenderHuntingTokenMode) {
    const current = await this.repository.getJob(await this.readScope(user), id);
    if (!current || current.authorizationPrincipalId !== user.homeAccountId || current.tokenMode !== tokenMode) throw new AppError(404, "not_found", "Hunting job was not found.");
    return current;
  }

  private async run(actor: { tenantId: string; principalId: string }, scope: DefenderHuntingScope, current: DefenderHuntingJob,
    execution: DefenderHuntingExecution, signal: AbortSignal, cancellationSignal: AbortSignal) {
    let auditEvent: Awaited<ReturnType<ReturnType<typeof getAuditLog>["startEvent"]>> | undefined;
    try {
      const validation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
      const { user: freshUser, capabilityId } = await this.validateCurrentAuthority(actor, scope, current, signal);
      const token = await abortable(scope.tokenMode === "delegated"
        ? this.dependencies.delegatedToken(actor.principalId, capabilityId)
        : this.dependencies.applicationToken(capabilityId), signal);
      if (scope.tokenMode === "application") await this.requireExactApplicationScope(scope, freshUser, capabilityId, signal);
      if (current.qualification) await this.validateQualification(current.qualification, freshUser, signal);
      await abortable(commitAccountSessionValidation(validation, async () => {
        signal.throwIfAborted();
        requireSamePrincipal(actor, freshUser);
        current.qualification ? requireQualificationApprover(freshUser) : requireSecurityReader(freshUser);
      }), signal);
      const audit = this.dependencies.auditLog(actor);
      auditEvent = await abortable(audit.startEvent({ operationId: `query-hunting:${current.id}:${current.localRequestId}`, scope: "single",
        action: "query-hunting", agentId: current.id, actor: freshUser, requestPath: `/api/hunting/jobs/${current.id}`,
        metadata: { source: "microsoft_defender_hunting", template: current.filters.templateId, mode: current.tokenMode, correlationId: current.localRequestId } }), signal);
      const result = await this.dependencies.runQuery(token, current.filters, {
        signal, correlationId: current.localRequestId, tenantId: actor.tenantId,
        beforeRequest: () => this.repository.authorizeProviderRequest(scope, current.id, execution),
        onResponse: providerRequestId => this.repository.recordProviderResponse(scope, current.id, execution, providerRequestId),
      });
      signal.throwIfAborted();
      const publicationSignal = AbortSignal.any([cancellationSignal, AbortSignal.timeout(10_000)]);
      const publicationValidation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
      const { user: publicationUser } = await this.validateCurrentAuthority(actor, scope, current, publicationSignal);
      const job = await abortable(commitAccountSessionValidation(publicationValidation, async () => {
        publicationSignal.throwIfAborted();
        requireSamePrincipal(actor, publicationUser);
        current.qualification ? requireQualificationApprover(publicationUser) : requireSecurityReader(publicationUser);
        return this.repository.publish(scope, current.id, execution, result);
      }), publicationSignal);
      await audit.completeEvent(auditEvent.id, { status: job.status === "partial" ? "inconclusive" : "succeeded",
        metadata: { source: "microsoft_defender_hunting", template: current.filters.templateId, mode: current.tokenMode,
          correlationId: current.localRequestId, rowCount: job.storedRowCount, requestCount: job.providerRequestCount } });
    } catch (error) {
      if (error instanceof AppError && error.code === "hunting_execution_lost") return;
      if (signal.aborted || isLocalAuthorizationFailure(error)) {
        try { await this.repository.markWaitingAuthorization(scope, current.id, execution); } catch (markError) {
          if (!(markError instanceof AppError && markError.code === "hunting_execution_lost")) throw markError;
        }
        if (auditEvent) await this.dependencies.auditLog(actor).completeEvent(auditEvent.id, {
          status: signal.aborted ? "cancelled" : "inconclusive", errorCode: error instanceof AppError ? error.code : "interaction_required" });
        return;
      }
      const inconclusive = error instanceof AppError && ["provider_schema", "provider_error", "provider_throttled", "invalid_provider_link", "hunting_access_denied",
        "hunting_provider_request_limit", "hunting_job_expired"].includes(error.code);
      const failed = await this.repository.fail(scope, current.id, execution, error instanceof AppError ? error.code : "provider_error", safeFailureMessage(error), inconclusive);
      if (auditEvent) await this.dependencies.auditLog(actor).completeEvent(auditEvent.id, { status: inconclusive ? "inconclusive" : "failed",
        errorCode: error instanceof AppError ? error.code : "provider_error", metadata: { source: "microsoft_defender_hunting",
          template: current.filters.templateId, mode: current.tokenMode, correlationId: current.localRequestId, requestCount: failed?.providerRequestCount ?? 0 } });
    }
  }

  private async validateCurrentAuthority(actor: { tenantId: string; principalId: string }, scope: DefenderHuntingScope,
    current: DefenderHuntingJob, signal: AbortSignal) {
    const freshUser = await abortable(this.dependencies.revalidateUser(actor.principalId), signal);
    signal.throwIfAborted();
    requireSamePrincipal(actor, freshUser);
    current.qualification ? requireQualificationApprover(freshUser) : requireSecurityReader(freshUser);
    const capabilityId = capabilityForMode(scope.tokenMode);
    if (scope.tokenMode === "application") await this.requireExactApplicationScope(scope, freshUser, capabilityId, signal);
    if (current.qualification) await this.validateQualification(current.qualification, freshUser, signal);
    else {
      const authority = await abortable(this.dependencies.qualificationContext(capabilityId, freshUser), signal);
      await abortable(this.repository.requireQualifiedScope(scope, current.filters, authority, current.retainedScopeId), signal);
    }
    signal.throwIfAborted();
    return { user: freshUser, capabilityId };
  }

  private async validateQualification(qualification: DefenderHuntingQualificationBinding, user: AuthenticatedUser, signal?: AbortSignal) {
    const context = await abortable(this.dependencies.qualificationContext(qualification.capabilityId, user), signal);
    if (qualification.contractRevision !== context.contractRevision || qualification.permissionRevision !== context.permissionRevision
      || qualification.configurationRevision !== context.configurationRevision) throw new AppError(409, "qualification_superseded", "Hunting permission, contract, or configuration changed after approval.");
  }

  private async requireExactApplicationScope(scope: DefenderHuntingScope, user: AuthenticatedUser, capabilityId: CapabilityId, signal: AbortSignal) {
    const configuration = await abortable(this.dependencies.requireApplicationDataScope(capabilityId, user), signal);
    const current = scopeFor(user, "application", configuration.revision, this.dependencies.applicationIdentity()).resultScope;
    if (!resultScopeMatches(scope.resultScope, current)) throw new AppError(409, "application_scope_changed", "Application hunting configuration changed after this job was submitted.");
  }

  private async resultScopeForMode(user: AuthenticatedUser, tokenMode: DefenderHuntingTokenMode, signal?: AbortSignal) {
    if (tokenMode === "delegated") return scopeFor(user, tokenMode).resultScope;
    const configuration = await abortable(this.dependencies.requireApplicationDataScope(capabilityForMode(tokenMode), user), signal);
    return scopeFor(user, tokenMode, configuration?.revision, this.dependencies.applicationIdentity()).resultScope;
  }

  private async readScope(user: AuthenticatedUser): Promise<DefenderHuntingReadScope> {
    if (!user.tenantId) throw AppError.unauthorized("Hunting requires a tenant scope.");
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
    const roleScope = inventoryRoleScope(user);
    return { tenantId: user.tenantId, authorizationPrincipalId: user.homeAccountId, resultScopes, qualifications,
      ...(user.roles.includes("AgentControl.Reader") && roleScope !== "unknown" ? { inventoryIdentityScope: {
        principalId: user.homeAccountId, roleScope, resourceTypes: [...resourceTypesForInventoryScope(roleScope)],
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

function requireSecurityReader(user: AuthenticatedUser) {
  if (!user.roles.includes("AgentControl.SecurityReader")) throw new AppError(403, "missing_internal_role", "Hunting requires the SecurityReader role.");
}

function requireQualificationApprover(user: AuthenticatedUser) {
  requireSecurityReader(user);
  if (!user.roles.includes("AgentControl.Administrator")) throw new AppError(403, "missing_internal_role", "Hunting qualification requires Administrator and SecurityReader roles.");
}

function requireSamePrincipal(scope: { tenantId: string; principalId: string }, user: AuthenticatedUser) {
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The signed-in account changed during hunting.");
}

function isLocalAuthorizationFailure(error: unknown) {
  return error instanceof AppError && ["interaction_required", "authorization_expired", "missing_internal_role", "capability_unavailable", "not_configured",
    "application_scope_changed", "qualification_superseded", "hunting_scope_unqualified"].includes(error.code);
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