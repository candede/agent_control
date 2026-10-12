import { acquireApplicationToken, acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { findTenantConfiguration } from "../config.js";
import { PurviewAuditRepository, type PurviewAuditExecution, type PurviewAuditReadScope, type PurviewAuditScope } from "../db/purviewAudit.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError, errorTelemetry } from "../errors.js";
import { hasAppRole, type CapabilityStatus } from "../types/capability.js";
import type { AuthenticatedUser } from "../types/session.js";
import { powerPlatformResourceTypes } from "../types/powerPlatformInventory.js";
import type { PurviewAuditJob, PurviewAuditTokenMode, PurviewProviderQuery, PurviewAuditFilters } from "../types/purviewAudit.js";
import { capabilities } from "./capabilities.js";
import { GraphAuditSearchClient, providerQueryMatches, scopePurviewAuditResult, validatePurviewAuditFilters } from "./graphAuditSearch.js";
import { operationalLog } from "./telemetry.js";
import { agentInvestigations, investigationRecordId } from "./agentInvestigations.js";
import type { AgentPurviewQuery, AgentPurviewRecordPage } from "../types/agentInvestigations.js";
import { requireProviderAdmissions } from "./operationalState.js";

type CapabilityId = "purview.audit.search.delegated" | "purview.audit.search.application";
type AuditDependencies = {
  delegatedToken: typeof acquireDelegatedToken;
  applicationToken: typeof acquireApplicationToken;
  revalidateUser: typeof revalidateAuthenticatedUser;
  requireAvailable: typeof capabilities.requireAvailable;
  beginOperationValidation: typeof capabilities.beginOperationValidation;
  observeOperation: typeof capabilities.observeOperation;
  requireApplicationDataScope: typeof capabilities.requireApplicationDataScope;
  applicationIdentity: (tenantId: string) => string | undefined;
  qualificationContext: typeof capabilities.auditQualificationContext;
  recordQualificationEvidence: typeof capabilities.recordAuditQualificationEvidence;
  createQuery: GraphAuditSearchClient["createQuery"];
  getQuery: GraphAuditSearchClient["getQuery"];
  listQueries: GraphAuditSearchClient["listQueries"];
  listRecords: GraphAuditSearchClient["listRecords"];
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  agentContext?: typeof agentInvestigations.resolve;
};

const graphAudit = new GraphAuditSearchClient();
const defaultDependencies: AuditDependencies = {
  delegatedToken: acquireDelegatedToken,
  applicationToken: acquireApplicationToken,
  revalidateUser: revalidateAuthenticatedUser,
  requireAvailable: capabilities.requireAvailable.bind(capabilities),
  beginOperationValidation: capabilities.beginOperationValidation.bind(capabilities),
  observeOperation: capabilities.observeOperation.bind(capabilities),
  requireApplicationDataScope: capabilities.requireApplicationDataScope.bind(capabilities),
  applicationIdentity: tenantId => findTenantConfiguration(tenantId)?.clientId,
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
  agentContext: agentInvestigations.resolve.bind(agentInvestigations),
};

type ActiveSearch = { actor: { tenantId: string; principalId: string }; tokenMode: PurviewAuditTokenMode; controller: AbortController; started: Promise<PurviewAuditJob>; operation: Promise<void> };
type AuditAuthority = { validation: ReturnType<typeof beginAccountSessionValidation>; assertCurrent: () => void };
const maximumActiveSearches = 4;
const activationDeadlineMs = 60_000;
const maximumPollsPerActivation = 6;

export class PurviewAuditService {
  private readonly active = new Map<string, ActiveSearch>();
  private draining = false;

  constructor(
    private readonly repository = new PurviewAuditRepository(),
    private readonly dependencies: AuditDependencies = defaultDependencies,
  ) {}

  async submit(user: AuthenticatedUser, input: { tokenMode: PurviewAuditTokenMode; filters: unknown; idempotencyKey: string; agentRecordId?: unknown }) {
    requireViewer(user);
    requireProviderAdmissions();
    const authority = this.initiatingAuthority(user, [input.tokenMode]);
    const assertCurrent = () => { authority.assertCurrent(); requireProviderAdmissions(); };
    const filters = validatePurviewAuditFilters(input.filters);
    const capabilityId = capabilityForMode(input.tokenMode);
    const applicationConfiguration = input.tokenMode === "application"
      ? await this.dependencies.requireApplicationDataScope(capabilityId, user)
      : undefined;
    await this.dependencies.requireAvailable(capabilityId, user);
    return commitAccountSessionValidation(authority.validation, async () => {
      assertCurrent();
      return this.repository.submit(scopeFor(user, input.tokenMode, applicationConfiguration?.revision, this.dependencies.applicationIdentity(user.tenantId!)),
        { idempotencyKey: input.idempotencyKey, filters }, assertCurrent);
    });
  }

  async approveQualification(user: AuthenticatedUser, input: { tokenMode: PurviewAuditTokenMode; filters: unknown; agentRecordId?: unknown }) {
    requireQualificationRole(user, input.tokenMode);
    requireProviderAdmissions();
    const authority = this.initiatingAuthority(user, [input.tokenMode]);
    const assertCurrent = () => { authority.assertCurrent(); requireProviderAdmissions(); requireQualificationRole(user, input.tokenMode); };
    const filters = validatePurviewAuditFilters(input.filters, { qualification: true });
    const capabilityId = capabilityForMode(input.tokenMode);
    const applicationConfiguration = input.tokenMode === "application"
      ? await this.dependencies.requireApplicationDataScope(capabilityId, user)
      : undefined;
    const context = await this.dependencies.qualificationContext(capabilityId, user);
    return commitAccountSessionValidation(authority.validation, async () => {
      assertCurrent();
      return this.repository.approveQualification(scopeFor(user, input.tokenMode, applicationConfiguration?.revision, this.dependencies.applicationIdentity(user.tenantId!)),
        { filters, ...context, approvedBy: user.homeAccountId }, assertCurrent);
    });
  }

  async startQualification(user: AuthenticatedUser, qualificationId: string) {
    requireViewer(user);
    const authority = this.initiatingAuthority(user, ["delegated", "application"]);
    if (!user.tenantId) throw AppError.unauthorized();
    const qualification = await this.repository.getQualification(user.tenantId, qualificationId);
    authority.assertCurrent();
    if (!qualification || qualification.authorizationPrincipalId !== user.homeAccountId) throw new AppError(404, "not_found", "Audit Search qualification was not found.");
    requireQualificationRole(user, qualification.tokenMode);
    if (!resultScopeMatches(qualification.resultScope, await this.resultScopeForMode(user, qualification.tokenMode))) {
      throw new AppError(404, "not_found", "Audit Search qualification was not found.");
    }
    const context = await this.dependencies.qualificationContext(qualification.capabilityId, user);
    authority.assertCurrent();
    if (qualification.contractRevision !== context.contractRevision || qualification.permissionRevision !== context.permissionRevision || qualification.configurationRevision !== context.configurationRevision) {
      throw new AppError(409, "qualification_superseded", "Audit Search permission, contract, or configuration changed after approval.");
    }
    if (qualification.jobId) {
      const job = await this.repository.getJob(await this.readScope(user), qualification.jobId);
      authority.assertCurrent();
      if (!job) throw new AppError(404, "not_found", "Audit Search qualification job was not found.");
      return job.status === "waiting_authorization" ? this.start(user, job.id, qualification.tokenMode) : job;
    }
    const assertCurrent = () => { authority.assertCurrent(); requireProviderAdmissions(); requireQualificationRole(user, qualification.tokenMode); };
    const job = await commitAccountSessionValidation(authority.validation, async () => {
      assertCurrent();
      return this.repository.submit(scopeFromResult(user, qualification.tokenMode, qualification.resultScope),
        { idempotencyKey: `qualification_${qualification.id.replaceAll("-", "")}`, filters: qualification.filters, qualificationId }, assertCurrent);
    });
    authority.assertCurrent();
    return this.start(user, job.id, qualification.tokenMode);
  }

  start(user: AuthenticatedUser, id: string, tokenMode: PurviewAuditTokenMode): Promise<PurviewAuditJob> {
    requireViewer(user);
    if (this.draining) throw new AppError(503, "audit_shutdown", "Audit Search is stopping for application shutdown.");
    requireProviderAdmissions();
    id = id.toLowerCase();
    const actor = actorScope(user);
    const initiating = this.initiatingAuthority(user, [tokenMode]);
    const authority: AuditAuthority = { validation: initiating.validation, assertCurrent: () => {
      initiating.assertCurrent();
      requireProviderAdmissions();
    } };
    authority.assertCurrent();
    const existing = this.active.get(id);
    if (existing) {
      if (existing.actor.tenantId === actor.tenantId && existing.actor.principalId === actor.principalId && existing.tokenMode === tokenMode) return existing.started;
      return this.currentJobForStart(user, id, tokenMode);
    }
    if (this.active.size >= maximumActiveSearches) return this.currentJobForStart(user, id, tokenMode);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(activationDeadlineMs)]);
    const prepared = this.prepareStart(user, actor, id, tokenMode, signal, controller.signal, authority);
    const started = prepared.then(value => value.job);
    let operation: Promise<void>;
    operation = prepared.then(value => value.run?.(), error => {
      if (signal.aborted && error !== signal.reason) throw error;
    }).then(() => undefined).catch(error => {
      if (!(error instanceof AppError && error.code === "audit_execution_lost")) throw error;
    })
      .finally(() => { if (this.active.get(id)?.operation === operation) this.active.delete(id); });
    void operation.catch(error => operationalLog("error", "audit_worker_failed", { jobId: id, ...errorTelemetry(error, "audit_worker_failed") }));
    this.active.set(id, { actor, tokenMode, controller, started, operation });
    return started;
  }

  private async prepareStart(user: AuthenticatedUser, actor: { tenantId: string; principalId: string }, id: string, tokenMode: PurviewAuditTokenMode, signal: AbortSignal, cancellationSignal: AbortSignal, authority: AuditAuthority) {
    const readScope = await abortable(this.readScope(user), signal);
    authority.assertCurrent();
    const current = await abortable(this.repository.getJob(readScope, id), signal);
    authority.assertCurrent();
    if (!current || current.authorizationPrincipalId !== user.homeAccountId || current.tokenMode !== tokenMode) throw new AppError(404, "not_found", "Audit Search job was not found.");
    if (current.status !== "waiting_authorization") return { job: current };
    const scope = scopeFromResult(user, tokenMode, current.resultScope);
    const qualification = current.qualificationId
      ? await abortable(this.repository.getQualification(actor.tenantId, current.qualificationId), signal)
      : undefined;
    signal.throwIfAborted();
    authority.assertCurrent();
    // Activation owns a database write; cancellation must join it and its release.
    const activation = await this.repository.begin(scope, id);
    try {
      signal.throwIfAborted();
      authority.assertCurrent();
    } catch (error) {
      try { await this.repository.markWaitingAuthorization(scope, id, activation); }
      catch (cleanupError) {
        if (!(cleanupError instanceof AppError && cleanupError.code === "audit_execution_lost")) throw cleanupError;
      }
      throw error;
    }
    return { job: activation.job, run: () => this.run(actor, scope, activation.job, qualification, activation.action, activation, signal, cancellationSignal, authority) };
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

  async list(user: AuthenticatedUser, limit = 20, offset = 0, userPrincipalName?: unknown, agentRecordId?: unknown) {
    requireViewer(user);
    if (userPrincipalName !== undefined && (typeof userPrincipalName !== "string"
      || !userPrincipalName.includes("@") || userPrincipalName.length > 320 || /[\s\u0000-\u001f\u007f-\u009f]/.test(userPrincipalName))) {
      throw new AppError(400, "invalid_request", "A single valid user principal name is required for user-scoped Audit Search history.");
    }
    return this.repository.listJobs(await this.readScope(user), limit, offset, userPrincipalName,
      agentRecordId === undefined ? undefined : investigationRecordId(agentRecordId));
  }

  async records(user: AuthenticatedUser, id: string, limit = 100, offset = 0) {
    requireViewer(user);
    return this.repository.listRecords(await this.readScope(user), id, limit, offset);
  }

  private async bindFilters(user: AuthenticatedUser, input: unknown, recordId: unknown, qualification = false) {
    if (input && typeof input === "object" && "agent" in input) {
      throw new AppError(400, "invalid_audit_filters", "Agent audit identities are selected from the saved agent, not supplied by the caller.");
    }
    if (recordId === undefined) return validatePurviewAuditFilters(input, { qualification });
    if (!input || typeof input !== "object" || Array.isArray(input)) return validatePurviewAuditFilters(input, { qualification });
    const resolve = this.dependencies.agentContext ?? agentInvestigations.resolve.bind(agentInvestigations);
    const current = await resolve(actorScope(user), investigationRecordId(recordId));
    if (!current.purviewTarget) throw new AppError(409, "agent_investigation_unavailable", current.context.purview.reason!);
    const { botId, environmentId, applicationId } = current.purviewTarget;
    return validatePurviewAuditFilters({ ...input, agent: { recordId: current.context.recordId, botId, environmentId,
      ...("presetId" in input && input.presetId === "copilot_interactions" && applicationId ? { applicationId } : {}) } }, { qualification });
  }

  async relatedInventoryRecords(user: AuthenticatedUser, target: { environmentId: string; botId: string }, limit = 20) {
    requireViewer(user);
    return this.repository.relatedInventoryRecords(await this.readScope(user), target, limit);
  }

  async agentRecords(user: AuthenticatedUser, recordId: string, query: AgentPurviewQuery,
    context = this.dependencies.agentContext ?? agentInvestigations.resolve.bind(agentInvestigations),
    beforeReturn?: (result: AgentPurviewRecordPage) => Promise<void>): Promise<AgentPurviewRecordPage> {
    requireViewer(user);
    const actor = actorScope(user);
    const { assertCurrent } = this.initiatingAuthority(user, ["delegated", "application"]);
    assertCurrent();
    const resolve = context;
    const current = await resolve(actor, recordId);
    assertCurrent();
    if (!current.purviewTarget) throw new AppError(409, "agent_investigation_unavailable", current.context.purview.reason!);
    const readScope = await this.readScope(user);
    assertCurrent();
    const result = await this.repository.agentRecords(readScope, current.purviewTarget, query);
    assertCurrent();
    const page: AgentPurviewRecordPage = { ...result, recordId: current.context.recordId, mode: "saved_only" };
    await beforeReturn?.(page);
    assertCurrent();
    if (JSON.stringify((await this.readScope(user)).resultScopes) !== JSON.stringify(readScope.resultScopes)) {
      throw new AppError(409, "audit_scope_changed", "Authorized saved Audit Search scopes changed during this read. Refresh the investigation.");
    }
    assertCurrent();
    const latest = await resolve(actor, recordId);
    assertCurrent();
    if (!latest.purviewTarget || latest.context.recordId !== current.context.recordId || latest.inventoryRevision !== current.inventoryRevision
      || JSON.stringify(latest.purviewTarget) !== JSON.stringify(current.purviewTarget)) {
      throw new AppError(409, "agent_identity_changed", "The saved agent identity changed during this read. Refresh Agents.");
    }
    return page;
  }

  async cancel(user: AuthenticatedUser, id: string) {
    requireViewer(user);
    const authority = this.initiatingAuthority(user, ["delegated", "application"]);
    id = id.toLowerCase();
    const readScope = await this.readScope(user);
    authority.assertCurrent();
    if (!await this.repository.getJob(readScope, id)) throw new AppError(404, "not_found", "Audit Search job was not found.");
    const job = await commitAccountSessionValidation(authority.validation, () => {
      authority.assertCurrent();
      return this.repository.cancel(readScope, id, authority.assertCurrent);
    });
    this.active.get(id)?.controller.abort(new AppError(409, "audit_cancelled", "Audit Search was cancelled locally."));
    return job;
  }

  async delete(user: AuthenticatedUser, id: string) {
    requireViewer(user);
    const authority = this.initiatingAuthority(user, ["delegated", "application"]);
    id = id.toLowerCase();
    const readScope = await this.readScope(user);
    authority.assertCurrent();
    if (!await this.repository.getJob(readScope, id)) throw new AppError(404, "not_found", "Audit Search job was not found.");
    await commitAccountSessionValidation(authority.validation, () => {
      authority.assertCurrent();
      return this.repository.delete(readScope, id, authority.assertCurrent);
    });
    this.active.get(id)?.controller.abort(new AppError(409, "audit_cancelled", "Audit Search local cache was deleted."));
  }

  recover() {
    return this.repository.recoverInterrupted();
  }

  async drain() {
    this.draining = true;
    const active = [...this.active.values()];
    for (const search of active) search.controller.abort(new AppError(401, "interaction_required", "Application shutdown requires explicit Audit Search resume."));
    const results = await Promise.allSettled(active.map(search => search.operation));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
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
    authority: AuditAuthority,
  ) {
    let qualificationDeadline: AbortSignal | undefined;
    const assertCurrent = () => {
      authority.assertCurrent();
      if (qualification) requireUnexpiredQualification(qualification);
    };
    let authorizationSignal = signal;
    try {
      const validation = authority.validation;
      assertCurrent();
      if (qualification) {
        qualificationDeadline = AbortSignal.timeout(Math.max(1, Date.parse(qualification.expiresAt) - Date.now()));
        signal = AbortSignal.any([signal, qualificationDeadline]);
        authorizationSignal = signal;
      }
      const { user: freshUser, capabilityId } = await this.validateCurrentAuthority(actor, scope, qualification, signal);
      const token = await this.dependencies.observeOperation(capabilityId, freshUser, () => abortable(scope.tokenMode === "delegated"
        ? this.dependencies.delegatedToken(actor.tenantId, actor.principalId, capabilityId)
        : this.dependencies.applicationToken(actor.tenantId, capabilityId), signal), { signal, clearOnSuccess: false });
      if (scope.tokenMode === "application") await this.requireExactApplicationScope(scope, freshUser, capabilityId, signal);
      if (qualification) await this.validateCurrentQualification(qualification, freshUser, signal);
      await abortable(commitAccountSessionValidation(validation, async () => {
        signal.throwIfAborted();
        assertCurrent();
        requireSamePrincipal(actor, freshUser);
        if (qualification) requireQualificationRole(freshUser, scope.tokenMode);
        else requireViewer(freshUser);
      }), signal);
      const providerOptions = {
        signal,
        correlationId: current.localRequestId,
        assertCurrent,
        beforeRequest: () => this.authorizeProviderRequest(scope, current.id, execution, signal),
        onResponse: (providerRequestId: string | null) => this.repository.recordProviderResponse(scope, current.id, execution, providerRequestId),
      };
      let query: PurviewProviderQuery | undefined;
      let pollCount = 0;
      if (action === "create") {
        try {
          query = await this.dependencies.observeOperation(capabilityId, freshUser,
            () => this.dependencies.createQuery(token, current.displayName, current.filters, providerOptions), { signal, clearOnSuccess: false });
          requireBoundQuery(query, current);
          await this.repository.recordProviderQuery(scope, current.id, execution, query.id, query.status);
        } catch (error) {
          if (!(error instanceof AppError && error.code === "audit_create_inconclusive")) throw error;
          query = await this.dependencies.observeOperation(capabilityId, freshUser,
            () => this.reconcile(token, scope, current, execution, signal, assertCurrent), { signal, clearOnSuccess: false });
          if (!query) { await this.repository.markWaitingAuthorization(scope, current.id, execution); return; }
          await this.repository.recordProviderQuery(scope, current.id, execution, query.id, query.status);
        }
      } else if (action === "reconcile") {
        query = await this.dependencies.observeOperation(capabilityId, freshUser,
          () => this.reconcile(token, scope, current, execution, signal, assertCurrent), { signal, clearOnSuccess: false });
        if (!query) { await this.repository.markWaitingAuthorization(scope, current.id, execution); return; }
        await this.repository.recordProviderQuery(scope, current.id, execution, query.id, query.status);
      } else {
        if (!current.providerQueryId) throw new AppError(409, "audit_job_state", "Audit Search lost its provider query identity.");
        const providerQueryId = current.providerQueryId;
        query = await this.dependencies.observeOperation(capabilityId, freshUser,
          () => this.dependencies.getQuery(token, providerQueryId, providerOptions), { signal, clearOnSuccess: false });
        pollCount += 1;
        requireBoundQuery(query, current, current.providerQueryId);
        await this.repository.recordProviderStatus(scope, current.id, execution, query.status);
      }

      let lifecyclePollRequired = Boolean((qualification || scope.tokenMode === "delegated") && action !== "poll");
      while (query.status !== "succeeded" || lifecyclePollRequired) {
        if (["failed", "cancelled", "unknownFutureValue"].includes(query.status)) throw new AppError(502, "provider_query_failed", `Microsoft Graph Audit Search ended with status ${query.status}.`);
        if (pollCount >= maximumPollsPerActivation) { await this.repository.markWaitingAuthorization(scope, current.id, execution); return; }
        if (!lifecyclePollRequired) await abortable(this.dependencies.wait(1_000 + Math.floor(this.dependencies.random() * 2_000), signal), signal);
        signal.throwIfAborted();
        assertCurrent();
        lifecyclePollRequired = false;
        const providerQueryId: string = query.id;
        query = await this.dependencies.observeOperation(capabilityId, freshUser,
          () => this.dependencies.getQuery(token, providerQueryId, providerOptions), { signal, clearOnSuccess: false });
        pollCount += 1;
        requireBoundQuery(query, current, providerQueryId);
        await this.repository.recordProviderStatus(scope, current.id, execution, query.status);
      }
      const completedQueryId = query.id;
      const providerResult = await this.dependencies.observeOperation(capabilityId, freshUser,
        () => this.dependencies.listRecords(token, completedQueryId, actor.tenantId, providerOptions),
        { signal, clearOnSuccess: result => result.complete && !query.isRecordCountLimitExceeded });
      const result = scopePurviewAuditResult(providerResult, current.filters);
      if (query.isRecordCountLimitExceeded) {
        result.complete = false;
        result.partialReason = "provider_result_limit";
      }
      throwIfCancelled(signal);
      if (signal.aborted) {
        result.complete = false;
        result.partialReason = "audit_activation_timeout";
      }
      const publicationSignal = AbortSignal.any([cancellationSignal, AbortSignal.timeout(10_000), ...(qualificationDeadline ? [qualificationDeadline] : [])]);
      authorizationSignal = publicationSignal;
      const publicationValidation = authority.validation;
      const { user: publicationUser } = await this.validateCurrentAuthority(actor, scope, qualification, publicationSignal);
      const job = await commitAccountSessionValidation(publicationValidation, async () => {
        publicationSignal.throwIfAborted();
        assertCurrent();
        requireSamePrincipal(actor, publicationUser);
        if (qualification) requireQualificationRole(publicationUser, scope.tokenMode);
        else requireViewer(publicationUser);
        return this.repository.publish(scope, current.id, execution, result, () => {
          publicationSignal.throwIfAborted();
          assertCurrent();
        });
      });
      const evidenceCapabilityId = qualification?.capabilityId ??
        (scope.tokenMode === "delegated" ? capabilityForMode(scope.tokenMode) : undefined);
      if (evidenceCapabilityId && job.status === "succeeded") {
        try {
          await commitAccountSessionValidation(publicationValidation, async () => {
            publicationSignal.throwIfAborted();
            assertCurrent();
            await this.dependencies.recordQualificationEvidence(evidenceCapabilityId, publicationUser, "available",
              { providerRequestId: job.providerRequestId }, qualification?.configurationRevision, publicationSignal);
          });
        } catch {
          operationalLog("warn", "capability_evidence_record_failed", { capabilityId: evidenceCapabilityId, outcome: "provider_success" });
        }
      }
    } catch (error) {
      try { assertCurrent(); } catch (authorityError) { error = authorityError; }
      if (error instanceof AppError && error.code === "audit_execution_lost") return;
      const qualificationExpired = error instanceof AppError && error.code === "qualification_expired";
      if (!qualificationExpired && (signal.aborted || authorizationSignal.aborted || isAuthorizationFailure(error))) {
        await this.repository.markWaitingAuthorization(scope, current.id, execution);
        return;
      }
      const inconclusive = qualificationExpired || error instanceof AppError && ["audit_create_inconclusive", "provider_schema", "provider_error", "invalid_provider_link", "audit_provider_request_limit", "audit_job_expired"].includes(error.code);
      const failureSignal = qualificationExpired ? cancellationSignal : signal;
      let job: PurviewAuditJob | undefined;
      try {
        job = await this.repository.fail(scope, current.id, execution, error instanceof AppError ? error.code : "provider_error", safeFailureMessage(error), inconclusive,
          () => {
            failureSignal.throwIfAborted();
            if (qualificationExpired) authority.assertCurrent();
            else assertCurrent();
          });
      } catch (publicationError) {
        if (failureSignal.aborted || isAuthorizationFailure(publicationError)) {
          await this.repository.markWaitingAuthorization(scope, current.id, execution);
          return;
        }
        throw publicationError;
      }
      if (qualificationExpired) return;
      const evidenceCapabilityId = qualification?.capabilityId ??
        (scope.tokenMode === "delegated" ? capabilityForMode(scope.tokenMode) : undefined);
      if (evidenceCapabilityId) {
        try {
          const evidenceSignal = AbortSignal.any([cancellationSignal, AbortSignal.timeout(10_000), ...(qualificationDeadline ? [qualificationDeadline] : [])]);
          evidenceSignal.throwIfAborted();
          const evidenceValidation = authority.validation;
          const evidenceUser = await abortable(this.dependencies.revalidateUser(actor.tenantId, actor.principalId), evidenceSignal);
          await commitAccountSessionValidation(evidenceValidation, async () => {
            evidenceSignal.throwIfAborted();
            assertCurrent();
            requireSamePrincipal(actor, evidenceUser);
            if (qualification) requireQualificationRole(evidenceUser, scope.tokenMode);
            else requireViewer(evidenceUser);
            await this.dependencies.recordQualificationEvidence(evidenceCapabilityId, evidenceUser, qualificationEvidenceStatus(error), {
              category: error instanceof AppError ? error.code : "provider_error", providerRequestId: job?.providerRequestId ?? null,
            }, qualification?.configurationRevision, evidenceSignal);
          });
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
    filters: PurviewAuditFilters,
  ) {
    signal.throwIfAborted();
    requireProviderAdmissions();
    const freshUser = await abortable(this.dependencies.revalidateUser(actor.tenantId, actor.principalId), signal);
    signal.throwIfAborted();
    requireProviderAdmissions();
    requireSamePrincipal(actor, freshUser);
    if (qualification) requireQualificationRole(freshUser, scope.tokenMode);
    else requireViewer(freshUser);
    const capabilityId = capabilityForMode(scope.tokenMode);
    if (scope.tokenMode === "application") await this.requireExactApplicationScope(scope, freshUser, capabilityId, signal);
    if (qualification) await this.validateCurrentQualification(qualification, freshUser, signal);
    else await abortable(this.dependencies.requireAvailable(capabilityId, freshUser), signal);
    await this.validateAgentTarget(freshUser, filters, signal);
    signal.throwIfAborted();
    requireProviderAdmissions();
    return { user: freshUser, capabilityId };
  }

  private async validateAgentTarget(user: AuthenticatedUser, filters: PurviewAuditFilters, signal: AbortSignal) {
    if (!filters.agent) return;
    const resolve = this.dependencies.agentContext ?? agentInvestigations.resolve.bind(agentInvestigations);
    const current = await abortable(resolve(actorScope(user), filters.agent.recordId), signal);
    const target = current.purviewTarget;
    if (!target || current.context.recordId !== filters.agent.recordId || target.botId !== filters.agent.botId
      || target.environmentId !== filters.agent.environmentId
      || filters.presetId === "copilot_interactions" && target.applicationId !== filters.agent.applicationId) {
      throw new AppError(409, "agent_identity_changed", "The selected agent identity changed. Start a new search from the current agent.");
    }
  }

  private async authorizeProviderRequest(scope: PurviewAuditScope, id: string, execution: PurviewAuditExecution, signal: AbortSignal) {
    signal.throwIfAborted();
    requireProviderAdmissions();
    await this.repository.authorizeProviderRequest(scope, id, execution);
    signal.throwIfAborted();
    requireProviderAdmissions();
  }

  private async requireExactApplicationScope(scope: PurviewAuditScope, user: AuthenticatedUser, capabilityId: CapabilityId, signal: AbortSignal) {
    const configuration = await abortable(this.dependencies.requireApplicationDataScope(capabilityId, user), signal);
    const current = scopeFor(user, "application", configuration?.revision, this.dependencies.applicationIdentity(user.tenantId!)).resultScope;
    if (!resultScopeMatches(scope.resultScope, current)) {
      throw new AppError(409, "application_scope_changed", "Application Audit Search configuration changed after this job was submitted.");
    }
  }

  private async reconcile(token: string, scope: PurviewAuditScope, current: NonNullable<Awaited<ReturnType<PurviewAuditRepository["getJob"]>>>, execution: PurviewAuditExecution, signal: AbortSignal, assertCurrent: () => void) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const listed = await this.dependencies.listQueries(token, { signal, correlationId: current.localRequestId, maximumPages: 5,
        assertCurrent,
        beforeRequest: () => this.authorizeProviderRequest(scope, current.id, execution, signal),
        onResponse: (providerRequestId: string | null) => this.repository.recordProviderResponse(scope, current.id, execution, providerRequestId) });
      const matches = listed.value.filter(query => providerQueryMatches(query, current.displayName, current.filters));
      if (matches.length > 1) throw new AppError(409, "audit_create_ambiguous", "More than one provider query matched the durable Audit Search operation marker.");
      if (listed.complete && matches[0]) return matches[0];
      if (attempt < 2) await abortable(this.dependencies.wait(500 + Math.floor(this.dependencies.random() * 500), signal), signal);
      signal.throwIfAborted();
      assertCurrent();
    }
    return undefined;
  }

  private async validateCurrentQualification(qualification: NonNullable<Awaited<ReturnType<PurviewAuditRepository["getQualification"]>>>, user: AuthenticatedUser, signal?: AbortSignal) {
    if (!qualification || !["approved", "running"].includes(qualification.status) || qualification.authorizationPrincipalId !== user.homeAccountId
      || !resultScopeMatches(qualification.resultScope, await this.resultScopeForMode(user, qualification.tokenMode, signal))) {
      throw new AppError(409, "qualification_mismatch", "Audit Search qualification is not current for this principal.");
    }
    requireUnexpiredQualification(qualification);
    const current = await abortable(this.dependencies.qualificationContext(qualification.capabilityId, user), signal);
    requireUnexpiredQualification(qualification);
    if (qualification.contractRevision !== current.contractRevision || qualification.permissionRevision !== current.permissionRevision || qualification.configurationRevision !== current.configurationRevision) {
      throw new AppError(409, "qualification_superseded", "Audit Search qualification no longer matches current permission, contract, and configuration revisions.");
    }
  }

  private async resultScopeForMode(user: AuthenticatedUser, tokenMode: PurviewAuditTokenMode, signal?: AbortSignal) {
    if (tokenMode === "delegated") return scopeFor(user, tokenMode).resultScope;
    const configuration = await abortable(this.dependencies.requireApplicationDataScope(capabilityForMode(tokenMode), user), signal);
    return scopeFor(user, tokenMode, configuration?.revision, this.dependencies.applicationIdentity(user.tenantId!)).resultScope;
  }

  private async readScope(user: AuthenticatedUser): Promise<PurviewAuditReadScope> {
    if (!user.tenantId) throw AppError.unauthorized("Audit Search requires a tenant scope.");
    const resultScopes = [scopeFor(user, "delegated").resultScope];
    try {
      resultScopes.push(await this.resultScopeForMode(user, "application"));
    } catch (error) {
      if (!(error instanceof AppError && error.code === "not_configured")) throw error;
    }
    return { tenantId: user.tenantId, resultScopes,
      ...(hasAppRole(user.roles, "AgentControl.Viewer") ? { inventoryIdentityScope: {
        principalId: user.homeAccountId, resourceTypes: [...powerPlatformResourceTypes],
      } } : {}) };
  }

  private initiatingAuthority(user: AuthenticatedUser, modes: readonly PurviewAuditTokenMode[]): AuditAuthority {
    const actor = actorScope(user);
    const validation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
    const validators = modes.map(mode => this.dependencies.beginOperationValidation(capabilityForMode(mode), user));
    return { validation, assertCurrent: () => {
      assertAccountSessionValidation(validation);
      validators.forEach(validate => validate());
      requireViewer(user);
    } };
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

function requireUnexpiredQualification(qualification: { expiresAt: string }) {
  if (!(Date.parse(qualification.expiresAt) > Date.now())) {
    throw new AppError(409, "qualification_expired", "Audit Search qualification approval expired. Approve a new bounded qualification.");
  }
}

function isAuthorizationFailure(error: unknown) {
  return error instanceof AppError && (error.status === 401 || ["interaction_required", "authorization_expired", "provider_denied", "missing_internal_role", "capability_unavailable", "capability_invalidation_failed", "not_configured", "application_scope_changed", "qualification_mismatch", "qualification_superseded", "maintenance", "provider_requalification_required"].includes(error.code));
}

function qualificationEvidenceStatus(error: unknown): CapabilityStatus {
  if (error instanceof AppError && error.code === "missing_permission") return "missing_permission";
  if (error instanceof AppError && error.code === "unsupported") return "unsupported";
  return "provider_error";
}

function safeFailureMessage(error: unknown) {
  if (error instanceof AppError && ["provider_error", "provider_not_found", "provider_schema", "provider_result_limit", "provider_query_failed", "provider_denied", "invalid_provider_link", "audit_create_ambiguous", "qualification_expired"].includes(error.code)) return error.message.slice(0, 1024);
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