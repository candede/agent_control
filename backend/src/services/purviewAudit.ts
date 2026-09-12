import { acquireApplicationToken, acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { config } from "../config.js";
import { PurviewAuditRepository, type PurviewAuditExecution, type PurviewAuditReadScope, type PurviewAuditScope } from "../db/purviewAudit.js";
import { beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import { hasAppRole, type CapabilityStatus } from "../types/capability.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { PurviewAuditJob, PurviewAuditTokenMode, PurviewProviderQuery } from "../types/purviewAudit.js";
import { capabilities } from "./capabilities.js";
import { GraphAuditSearchClient, providerQueryMatches, validatePurviewAuditFilters } from "./graphAuditSearch.js";
import { inventoryRoleScope, resourceTypesForInventoryScope } from "./inventoryRoleScope.js";
import { operationalLog } from "./telemetry.js";

type CapabilityId = "purview.audit.search.delegated" | "purview.audit.search.application";
type AuditDependencies = {
  delegatedToken: typeof acquireDelegatedToken;
  applicationToken: typeof acquireApplicationToken;
  revalidateUser: typeof revalidateAuthenticatedUser;
  requireAvailable: typeof capabilities.requireAvailable;
  requireApplicationDataScope: typeof capabilities.requireApplicationDataScope;
  applicationIdentity: () => string | undefined;
  qualificationContext: typeof capabilities.auditQualificationContext;
  recordQualificationEvidence: typeof capabilities.recordAuditQualificationEvidence;
  createQuery: GraphAuditSearchClient["createQuery"];
  getQuery: GraphAuditSearchClient["getQuery"];
  listQueries: GraphAuditSearchClient["listQueries"];
  listRecords: GraphAuditSearchClient["listRecords"];
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
};

const graphAudit = new GraphAuditSearchClient();
const defaultDependencies: AuditDependencies = {
  delegatedToken: acquireDelegatedToken,
  applicationToken: acquireApplicationToken,
  revalidateUser: revalidateAuthenticatedUser,
  requireAvailable: capabilities.requireAvailable.bind(capabilities),
  requireApplicationDataScope: capabilities.requireApplicationDataScope.bind(capabilities),
  applicationIdentity: () => config.clientId,
  qualificationContext: capabilities.auditQualificationContext.bind(capabilities),
  recordQualificationEvidence: capabilities.recordAuditQualificationEvidence.bind(capabilities),
  createQuery: graphAudit.createQuery.bind(graphAudit),
  getQuery: graphAudit.getQuery.bind(graphAudit),
  listQueries: graphAudit.listQueries.bind(graphAudit),
  listRecords: graphAudit.listRecords.bind(graphAudit),
  wait: (milliseconds, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  }),
  random: Math.random,
};

type ActiveSearch = { actor: { tenantId: string; principalId: string }; controller: AbortController; started: Promise<PurviewAuditJob>; operation: Promise<void> };
const maximumActiveSearches = 4;
const activationDeadlineMs = 60_000;
const maximumPollsPerActivation = 6;

export class PurviewAuditService {
  private readonly active = new Map<string, ActiveSearch>();

  constructor(
    private readonly repository = new PurviewAuditRepository(),
    private readonly dependencies: AuditDependencies = defaultDependencies,
  ) {}

  async submit(user: AuthenticatedUser, input: { tokenMode: PurviewAuditTokenMode; filters: unknown; idempotencyKey: string }) {
    requireViewer(user);
    const filters = validatePurviewAuditFilters(input.filters);
    const capabilityId = capabilityForMode(input.tokenMode);
    const applicationConfiguration = input.tokenMode === "application"
      ? await this.dependencies.requireApplicationDataScope(capabilityId, user)
      : undefined;
    await this.dependencies.requireAvailable(capabilityId, user);
    return this.repository.submit(scopeFor(user, input.tokenMode, applicationConfiguration?.revision, this.dependencies.applicationIdentity()), { idempotencyKey: input.idempotencyKey, filters });
  }

  async approveQualification(user: AuthenticatedUser, input: { tokenMode: PurviewAuditTokenMode; filters: unknown }) {
    requireQualificationRole(user, input.tokenMode);
    const filters = validatePurviewAuditFilters(input.filters, { qualification: true });
    const capabilityId = capabilityForMode(input.tokenMode);
    const applicationConfiguration = input.tokenMode === "application"
      ? await this.dependencies.requireApplicationDataScope(capabilityId, user)
      : undefined;
    const context = await this.dependencies.qualificationContext(capabilityId, user);
    return this.repository.approveQualification(scopeFor(user, input.tokenMode, applicationConfiguration?.revision, this.dependencies.applicationIdentity()), { filters, ...context, approvedBy: user.homeAccountId });
  }

  async startQualification(user: AuthenticatedUser, qualificationId: string) {
    requireViewer(user);
    if (!user.tenantId) throw AppError.unauthorized();
    const qualification = await this.repository.getQualification(user.tenantId, qualificationId);
    if (!qualification || qualification.authorizationPrincipalId !== user.homeAccountId) throw new AppError(404, "not_found", "Audit Search qualification was not found.");
    requireQualificationRole(user, qualification.tokenMode);
    if (!resultScopeMatches(qualification.resultScope, await this.resultScopeForMode(user, qualification.tokenMode))) {
      throw new AppError(404, "not_found", "Audit Search qualification was not found.");
    }
    const context = await this.dependencies.qualificationContext(qualification.capabilityId, user);
    if (qualification.contractRevision !== context.contractRevision || qualification.permissionRevision !== context.permissionRevision || qualification.configurationRevision !== context.configurationRevision) {
      throw new AppError(409, "qualification_superseded", "Audit Search permission, contract, or configuration changed after approval.");
    }
    if (qualification.jobId) {
      const job = await this.repository.getJob(await this.readScope(user), qualification.jobId);
      if (!job) throw new AppError(404, "not_found", "Audit Search qualification job was not found.");
      return job.status === "waiting_authorization" ? this.start(user, job.id, qualification.tokenMode) : job;
    }
    const job = await this.repository.submit(scopeFromResult(user, qualification.tokenMode, qualification.resultScope),
      { idempotencyKey: `qualification_${qualification.id.replaceAll("-", "")}`, filters: qualification.filters, qualificationId });
    return this.start(user, job.id, qualification.tokenMode);
  }

  start(user: AuthenticatedUser, id: string, tokenMode: PurviewAuditTokenMode): Promise<PurviewAuditJob> {
    requireViewer(user);
    const actor = actorScope(user);
    const existing = this.active.get(id);
    if (existing && existing.actor.tenantId === actor.tenantId && existing.actor.principalId === actor.principalId) return existing.started;
    if (this.active.size >= maximumActiveSearches) return this.currentJobForStart(user, id, tokenMode);
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

  private async prepareStart(user: AuthenticatedUser, actor: { tenantId: string; principalId: string }, id: string, tokenMode: PurviewAuditTokenMode, signal: AbortSignal, cancellationSignal: AbortSignal) {
    const readScope = await abortable(this.readScope(user), signal);
    const current = await abortable(this.repository.getJob(readScope, id), signal);
    if (!current || current.authorizationPrincipalId !== user.homeAccountId || current.tokenMode !== tokenMode) throw new AppError(404, "not_found", "Audit Search job was not found.");
    if (current.status !== "waiting_authorization") return { job: current };
    const scope = scopeFromResult(user, tokenMode, current.resultScope);
    const qualification = current.qualificationId
      ? await abortable(this.repository.getQualification(actor.tenantId, current.qualificationId), signal)
      : undefined;
    const activation = await abortable(this.repository.begin(scope, id), signal);
    signal.throwIfAborted();
    return { job: activation.job, run: () => this.run(actor, scope, activation.job, qualification, activation.action, activation, signal, cancellationSignal) };
  }

  private async currentJobForStart(user: AuthenticatedUser, id: string, tokenMode: PurviewAuditTokenMode) {
    const current = await this.repository.getJob(await this.readScope(user), id);
    if (!current || current.authorizationPrincipalId !== user.homeAccountId || current.tokenMode !== tokenMode) {
      throw new AppError(404, "not_found", "Audit Search job was not found.");
    }
    return current;
  }

  async get(user: AuthenticatedUser, id: string) {
    requireViewer(user);
    const job = await this.repository.getJob(await this.readScope(user), id);
    if (!job) throw new AppError(404, "not_found", "Audit Search job was not found.");
    return job;
  }

  async list(user: AuthenticatedUser, limit = 20, offset = 0) {
    requireViewer(user);
    return this.repository.listJobs(await this.readScope(user), limit, offset);
  }

  async records(user: AuthenticatedUser, id: string, limit = 100, offset = 0) {
    requireViewer(user);
    return this.repository.listRecords(await this.readScope(user), id, limit, offset);
  }

  async relatedInventoryRecords(user: AuthenticatedUser, target: { environmentId: string; botId: string }, limit = 20) {
    requireViewer(user);
    return this.repository.relatedInventoryRecords(await this.readScope(user), target, limit);
  }

  async cancel(user: AuthenticatedUser, id: string) {
    requireViewer(user);
    const readScope = await this.readScope(user);
    if (!await this.repository.getJob(readScope, id)) throw new AppError(404, "not_found", "Audit Search job was not found.");
    this.active.get(id)?.controller.abort(new AppError(409, "audit_cancelled", "Audit Search was cancelled locally."));
    return this.repository.cancel(readScope, id);
  }

  async delete(user: AuthenticatedUser, id: string) {
    requireViewer(user);
    const readScope = await this.readScope(user);
    if (!await this.repository.getJob(readScope, id)) throw new AppError(404, "not_found", "Audit Search job was not found.");
    this.active.get(id)?.controller.abort(new AppError(409, "audit_cancelled", "Audit Search local cache was deleted."));
    await this.repository.delete(readScope, id);
  }

  recover() {
    return this.repository.recoverInterrupted();
  }

  async drain() {
    const active = [...this.active.values()];
    for (const search of active) search.controller.abort(new AppError(401, "interaction_required", "Application shutdown requires explicit Audit Search resume."));
    await Promise.allSettled(active.map(search => search.operation));
  }

  async waitForPrincipalAuthorization(scope: { tenantId: string; principalId: string }) {
    for (const search of this.active.values()) {
      if (search.actor.tenantId === scope.tenantId && search.actor.principalId === scope.principalId) {
        search.controller.abort(new AppError(401, "interaction_required", "The signed-in account changed during Audit Search."));
      }
    }
  }

  private async run(
    actor: { tenantId: string; principalId: string },
    scope: PurviewAuditScope,
    current: NonNullable<Awaited<ReturnType<PurviewAuditRepository["getJob"]>>>,
    qualification: Awaited<ReturnType<PurviewAuditRepository["getQualification"]>>,
    action: "create" | "reconcile" | "poll",
    execution: PurviewAuditExecution,
    signal: AbortSignal,
    cancellationSignal: AbortSignal,
  ) {
    try {
      const validation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
      const { user: freshUser, capabilityId } = await this.validateCurrentAuthority(actor, scope, qualification, signal);
      const token = await abortable(scope.tokenMode === "delegated"
        ? this.dependencies.delegatedToken(actor.principalId, capabilityId)
        : this.dependencies.applicationToken(capabilityId), signal);
      if (scope.tokenMode === "application") await this.requireExactApplicationScope(scope, freshUser, capabilityId, signal);
      if (qualification) await this.validateCurrentQualification(qualification, freshUser, signal);
      await abortable(commitAccountSessionValidation(validation, async () => {
        signal.throwIfAborted();
        requireSamePrincipal(actor, freshUser);
        if (qualification) requireQualificationRole(freshUser, scope.tokenMode);
        else requireViewer(freshUser);
      }), signal);
      const providerOptions = {
        signal,
        correlationId: current.localRequestId,
        beforeRequest: () => this.repository.authorizeProviderRequest(scope, current.id, execution),
        onResponse: (providerRequestId: string | null) => this.repository.recordProviderResponse(scope, current.id, execution, providerRequestId),
      };
      let query: PurviewProviderQuery | undefined;
      if (action === "create") {
        try {
          query = await this.dependencies.createQuery(token, current.displayName, current.filters, providerOptions);
          requireBoundQuery(query, current);
          await this.repository.recordProviderQuery(scope, current.id, execution, query.id, query.status);
        } catch (error) {
          if (!(error instanceof AppError && error.code === "audit_create_inconclusive")) throw error;
          query = await this.reconcile(token, scope, current, execution, signal);
          if (!query) { await this.repository.markWaitingAuthorization(scope, current.id, execution); return; }
          await this.repository.recordProviderQuery(scope, current.id, execution, query.id, query.status);
        }
      } else if (action === "reconcile") {
        query = await this.reconcile(token, scope, current, execution, signal);
        if (!query) { await this.repository.markWaitingAuthorization(scope, current.id, execution); return; }
        await this.repository.recordProviderQuery(scope, current.id, execution, query.id, query.status);
      } else {
        if (!current.providerQueryId) throw new AppError(409, "audit_job_state", "Audit Search lost its provider query identity.");
        query = await this.dependencies.getQuery(token, current.providerQueryId, providerOptions);
        requireBoundQuery(query, current, current.providerQueryId);
        await this.repository.recordProviderStatus(scope, current.id, execution, query.status);
      }

      if (qualification && action !== "poll") {
        const providerQueryId = query.id;
        query = await this.dependencies.getQuery(token, providerQueryId, providerOptions);
        requireBoundQuery(query, current, providerQueryId);
        await this.repository.recordProviderStatus(scope, current.id, execution, query.status);
      }

      for (let poll = 0; query.status !== "succeeded" && poll < maximumPollsPerActivation; poll += 1) {
        if (["failed", "cancelled", "unknownFutureValue"].includes(query.status)) throw new AppError(502, "provider_query_failed", `Microsoft Graph Audit Search ended with status ${query.status}.`);
        await this.dependencies.wait(1_000 + Math.floor(this.dependencies.random() * 2_000), signal);
        const providerQueryId = query.id;
        query = await this.dependencies.getQuery(token, providerQueryId, providerOptions);
        requireBoundQuery(query, current, providerQueryId);
        await this.repository.recordProviderStatus(scope, current.id, execution, query.status);
      }
      if (query.status !== "succeeded") { await this.repository.markWaitingAuthorization(scope, current.id, execution); return; }
      const result = await this.dependencies.listRecords(token, query.id, actor.tenantId, providerOptions);
      throwIfCancelled(signal);
      if (signal.aborted) {
        result.complete = false;
        result.partialReason = "audit_activation_timeout";
      }
      const publicationSignal = AbortSignal.any([cancellationSignal, AbortSignal.timeout(10_000)]);
      const publicationValidation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
      const { user: publicationUser } = await this.validateCurrentAuthority(actor, scope, qualification, publicationSignal);
      const job = await abortable(commitAccountSessionValidation(publicationValidation, async () => {
        publicationSignal.throwIfAborted();
        requireSamePrincipal(actor, publicationUser);
        if (qualification) requireQualificationRole(publicationUser, scope.tokenMode);
        else requireViewer(publicationUser);
        return this.repository.publish(scope, current.id, execution, result);
      }), publicationSignal);
      const evidenceCapabilityId = qualification?.capabilityId ??
        (scope.tokenMode === "delegated" ? capabilityForMode(scope.tokenMode) : undefined);
      if (evidenceCapabilityId && job.status === "succeeded") {
        try {
          await abortable(this.dependencies.recordQualificationEvidence(evidenceCapabilityId, publicationUser, "available", { providerRequestId: job.providerRequestId }), publicationSignal);
        } catch {
          operationalLog("warn", "capability_evidence_record_failed", { capabilityId: evidenceCapabilityId, outcome: "provider_success" });
        }
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "audit_execution_lost") return;
      if (signal.aborted || isAuthorizationFailure(error)) {
        await this.repository.markWaitingAuthorization(scope, current.id, execution);
        return;
      }
      const inconclusive = error instanceof AppError && ["audit_create_inconclusive", "provider_schema", "provider_error", "invalid_provider_link", "audit_provider_request_limit", "audit_job_expired"].includes(error.code);
      const job = await this.repository.fail(scope, current.id, execution, error instanceof AppError ? error.code : "provider_error", safeFailureMessage(error), inconclusive);
      const evidenceCapabilityId = qualification?.capabilityId ??
        (scope.tokenMode === "delegated" ? capabilityForMode(scope.tokenMode) : undefined);
      if (evidenceCapabilityId) {
        try {
          const evidenceSignal = AbortSignal.any([cancellationSignal, AbortSignal.timeout(10_000)]);
          const evidenceUser = await abortable(this.dependencies.revalidateUser(actor.principalId), evidenceSignal);
          await abortable(this.dependencies.recordQualificationEvidence(evidenceCapabilityId, evidenceUser, qualificationEvidenceStatus(error), {
            category: error instanceof AppError ? error.code : "provider_error", providerRequestId: job?.providerRequestId ?? null,
          }), evidenceSignal);
        } catch {
          operationalLog("warn", "capability_evidence_record_failed", { capabilityId: evidenceCapabilityId, outcome: "provider_failure" });
        }
      }
    }
  }

  private async validateCurrentAuthority(
    actor: { tenantId: string; principalId: string },
    scope: PurviewAuditScope,
    qualification: Awaited<ReturnType<PurviewAuditRepository["getQualification"]>>,
    signal: AbortSignal,
  ) {
    const freshUser = await abortable(this.dependencies.revalidateUser(actor.principalId), signal);
    signal.throwIfAborted();
    requireSamePrincipal(actor, freshUser);
    if (qualification) requireQualificationRole(freshUser, scope.tokenMode);
    else requireViewer(freshUser);
    const capabilityId = capabilityForMode(scope.tokenMode);
    if (scope.tokenMode === "application") await this.requireExactApplicationScope(scope, freshUser, capabilityId, signal);
    if (qualification) await this.validateCurrentQualification(qualification, freshUser, signal);
    else await abortable(this.dependencies.requireAvailable(capabilityId, freshUser), signal);
    signal.throwIfAborted();
    return { user: freshUser, capabilityId };
  }

  private async requireExactApplicationScope(scope: PurviewAuditScope, user: AuthenticatedUser, capabilityId: CapabilityId, signal: AbortSignal) {
    const configuration = await abortable(this.dependencies.requireApplicationDataScope(capabilityId, user), signal);
    const current = scopeFor(user, "application", configuration?.revision, this.dependencies.applicationIdentity()).resultScope;
    if (!resultScopeMatches(scope.resultScope, current)) {
      throw new AppError(409, "application_scope_changed", "Application Audit Search configuration changed after this job was submitted.");
    }
  }

  private async reconcile(token: string, scope: PurviewAuditScope, current: NonNullable<Awaited<ReturnType<PurviewAuditRepository["getJob"]>>>, execution: PurviewAuditExecution, signal: AbortSignal) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const listed = await this.dependencies.listQueries(token, { signal, correlationId: current.localRequestId, maximumPages: 5,
        beforeRequest: () => this.repository.authorizeProviderRequest(scope, current.id, execution),
        onResponse: (providerRequestId: string | null) => this.repository.recordProviderResponse(scope, current.id, execution, providerRequestId) });
      const matches = listed.value.filter(query => providerQueryMatches(query, current.displayName, current.filters));
      if (matches.length > 1) throw new AppError(409, "audit_create_ambiguous", "More than one provider query matched the durable Audit Search operation marker.");
      if (listed.complete && matches[0]) return matches[0];
      if (attempt < 2) await this.dependencies.wait(500 + Math.floor(this.dependencies.random() * 500), signal);
    }
    return undefined;
  }

  private async validateCurrentQualification(qualification: NonNullable<Awaited<ReturnType<PurviewAuditRepository["getQualification"]>>>, user: AuthenticatedUser, signal?: AbortSignal) {
    if (!qualification || !["approved", "running"].includes(qualification.status) || qualification.authorizationPrincipalId !== user.homeAccountId
      || !resultScopeMatches(qualification.resultScope, await this.resultScopeForMode(user, qualification.tokenMode, signal)) || Date.parse(qualification.expiresAt) <= Date.now()) {
      throw new AppError(409, "qualification_mismatch", "Audit Search qualification is not current for this principal.");
    }
    const current = await abortable(this.dependencies.qualificationContext(qualification.capabilityId, user), signal);
    if (qualification.contractRevision !== current.contractRevision || qualification.permissionRevision !== current.permissionRevision || qualification.configurationRevision !== current.configurationRevision) {
      throw new AppError(409, "qualification_superseded", "Audit Search qualification no longer matches current permission, contract, and configuration revisions.");
    }
  }

  private async resultScopeForMode(user: AuthenticatedUser, tokenMode: PurviewAuditTokenMode, signal?: AbortSignal) {
    if (tokenMode === "delegated") return scopeFor(user, tokenMode).resultScope;
    const configuration = await abortable(this.dependencies.requireApplicationDataScope(capabilityForMode(tokenMode), user), signal);
    return scopeFor(user, tokenMode, configuration?.revision, this.dependencies.applicationIdentity()).resultScope;
  }

  private async readScope(user: AuthenticatedUser): Promise<PurviewAuditReadScope> {
    if (!user.tenantId) throw AppError.unauthorized("Audit Search requires a tenant scope.");
    const resultScopes = [scopeFor(user, "delegated").resultScope];
    try {
      resultScopes.push(await this.resultScopeForMode(user, "application"));
    } catch (error) {
      if (!(error instanceof AppError && error.code === "not_configured")) throw error;
    }
    const roleScope = inventoryRoleScope(user);
    return { tenantId: user.tenantId, resultScopes,
      ...(hasAppRole(user.roles, "AgentControl.Viewer") && roleScope !== "unknown" ? { inventoryIdentityScope: {
        principalId: user.homeAccountId, roleScope, resourceTypes: [...resourceTypesForInventoryScope(roleScope)],
      } } : {}) };
  }
}

export const purviewAudit = new PurviewAuditService();

function requireBoundQuery(query: PurviewProviderQuery, job: { displayName: string; filters: Parameters<typeof providerQueryMatches>[2] }, providerQueryId?: string) {
  if (providerQueryId !== undefined && query.id !== providerQueryId || !providerQueryMatches(query, job.displayName, job.filters)) {
    throw new AppError(502, "provider_schema", "Microsoft Graph returned an Audit Search query outside the durable approved identity and filters.");
  }
}

function capabilityForMode(mode: PurviewAuditTokenMode): CapabilityId {
  return mode === "delegated" ? "purview.audit.search.delegated" : "purview.audit.search.application";
}

function scopeFor(user: AuthenticatedUser, tokenMode: PurviewAuditTokenMode, applicationConfigurationRevision?: number, applicationId?: string): PurviewAuditScope {
  if (!user.tenantId) throw AppError.unauthorized("Audit Search requires a tenant scope.");
  if (tokenMode === "application") {
    if (!applicationId || !applicationConfigurationRevision) throw new AppError(503, "not_configured", "Application Audit Search requires configured tenant and client identity.");
    return { tenantId: user.tenantId, authorizationPrincipalId: user.homeAccountId,
      resultScope: { kind: "application", scopeId: applicationId, configurationRevision: applicationConfigurationRevision }, tokenMode };
  }
  return { tenantId: user.tenantId, authorizationPrincipalId: user.homeAccountId,
    resultScope: { kind: "principal", scopeId: user.homeAccountId, configurationRevision: null }, tokenMode };
}

function scopeFromResult(user: AuthenticatedUser, tokenMode: PurviewAuditTokenMode, resultScope: PurviewAuditScope["resultScope"]): PurviewAuditScope {
  if (!user.tenantId) throw AppError.unauthorized("Audit Search requires a tenant scope.");
  return { tenantId: user.tenantId, authorizationPrincipalId: user.homeAccountId, resultScope, tokenMode };
}

function resultScopeMatches(left: PurviewAuditScope["resultScope"], right: PurviewAuditScope["resultScope"]) {
  return left.kind === right.kind && left.scopeId === right.scopeId && left.configurationRevision === right.configurationRevision;
}

function actorScope(user: AuthenticatedUser) {
  if (!user.tenantId) throw AppError.unauthorized("Audit Search requires a tenant scope.");
  return { tenantId: user.tenantId, principalId: user.homeAccountId };
}

function requireViewer(user: AuthenticatedUser) {
  if (!hasAppRole(user.roles, "AgentControl.Viewer")) throw new AppError(403, "missing_internal_role", "Audit Search requires the Viewer role.");
}

function requireQualificationRole(user: AuthenticatedUser, tokenMode: PurviewAuditTokenMode) {
  requireViewer(user);
  if (tokenMode === "application" && !hasAppRole(user.roles, "AgentControl.Admin")) {
    throw new AppError(403, "missing_internal_role", "Application Audit Search qualification approval requires the Admin role.");
  }
}

function requireSamePrincipal(scope: { tenantId: string; principalId: string }, user: AuthenticatedUser) {
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The signed-in account changed during Audit Search.");
}

function isAuthorizationFailure(error: unknown) {
  return error instanceof AppError && (error.status === 401 || ["interaction_required", "authorization_expired", "provider_denied", "missing_internal_role", "capability_unavailable", "not_configured", "application_scope_changed", "qualification_mismatch", "qualification_superseded"].includes(error.code));
}

function qualificationEvidenceStatus(error: unknown): CapabilityStatus {
  if (error instanceof AppError && error.code === "missing_permission") return "missing_permission";
  if (error instanceof AppError && error.code === "unsupported") return "unsupported";
  return "provider_error";
}

function safeFailureMessage(error: unknown) {
  if (error instanceof AppError && ["provider_error", "provider_schema", "provider_result_limit", "provider_query_failed", "provider_denied", "invalid_provider_link", "audit_create_ambiguous"].includes(error.code)) return error.message.slice(0, 1024);
  return "Audit Search stopped before complete minimized result publication.";
}

function throwIfCancelled(signal: AbortSignal) {
  if (signal.aborted && !(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError")) throw signal.reason;
}

function abortable<T>(work: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  const promise = Promise.resolve(work);
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, error => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}