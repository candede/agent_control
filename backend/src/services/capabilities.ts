import type { AuthenticatedUser } from "../types/session.js";
import { hasAppRole, supportsAutomaticCapabilityCheck, type CapabilityCheckProgress, type CapabilityDecision, type CapabilityDefinition, type CapabilityId, type CapabilityOperationFailure, type CapabilityStatus } from "../types/capability.js";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../errors.js";
import { config } from "../config.js";
import { acquireApplicationToken, acquireDelegatedToken } from "../auth/msal.js";
import { adminManagedPermissionsMessage } from "../auth/flows.js";
import { CapabilityRepository, capabilityContractRevision, capabilityPermissionRevision, type CapabilityConfiguration, type CapabilityEvidence, type EvidenceKey } from "../db/capabilities.js";
import { capabilityDefinitions, getCapabilityDefinition, hasAnyRole } from "./capabilityRegistry.js";
import { DirectoryPrincipalsClient } from "./directoryPrincipals.js";
import { packageReadTimeoutMs, GraphPackagesClient } from "./graphPackages.js";
import { PowerPlatformResourceQueryClient } from "./powerPlatformResourceQuery.js";
import type { AuditAction } from "../types/audit.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { operationalLog } from "./telemetry.js";

const evidenceTtlMs = 5 * 60 * 1000;
const operationEvidenceTtlMs = 24 * 60 * 60 * 1000;
const automaticCheckDeadlineMs = 10_000;
type OperationPrincipal = Pick<AuthenticatedUser, "tenantId" | "homeAccountId">;
type ProbeDependencies = {
  delegatedToken: typeof acquireDelegatedToken;
  applicationToken: typeof acquireApplicationToken;
  packageProbe: (token: string, signal?: AbortSignal) => Promise<unknown>;
  directoryProbe: (token: string, signal?: AbortSignal) => Promise<unknown>;
  inventoryProbe: (token: string, signal?: AbortSignal) => Promise<unknown>;
};
type SharedCheck<T> = { completion: Promise<T>; controller: AbortController; waiters: number };

const defaultProbeDependencies: ProbeDependencies = {
  delegatedToken: acquireDelegatedToken,
  applicationToken: acquireApplicationToken,
  packageProbe: (token, signal) => new GraphPackagesClient(undefined, { maxAttempts: 1 }).checkCatalogAccess(token, signal),
  directoryProbe: (token, signal) => new DirectoryPrincipalsClient().search(token, "agent-control-permission-check", 1, signal),
  inventoryProbe: (token, signal) => new PowerPlatformResourceQueryClient(undefined, { maxAttempts: 1 }).checkAccess(token, signal),
};

export class CapabilityService {
  private readonly probes: ProbeDependencies;
  private readonly inFlight = new Map<string, SharedCheck<CapabilityDecision>>();
  private readonly automaticInFlight = new Map<string, SharedCheck<void> & { progress: CapabilityCheckProgress }>();
  private readonly generations = new Map<string, number>();
  private readonly pendingPrincipalInvalidations = new Map<string, number>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly repository = new CapabilityRepository(), probes: Partial<ProbeDependencies> = {}) {
    this.probes = { ...defaultProbeDependencies, ...probes };
  }

  async list(user: AuthenticatedUser) {
    if (!user.tenantId || !user.homeAccountId) throw AppError.unauthorized("Capability reporting requires an exact account.");
    const validation = beginAccountSessionValidation(user.tenantId, user.homeAccountId);
    const entries = capabilityDefinitions.map(definition => ({ definition, generation: this.generation(definition.id, user) }));
    const views = await Promise.all(entries.map(async ({ definition, generation }) => {
      const [current, configuration, operationFailure] = await Promise.all([
        this.decision(definition, user),
        definition.mode === "application" ? this.currentConfiguration(definition, user, generation) : undefined,
        this.operationFailure(definition, user, generation),
      ]);
      return {
        definition,
        decision: current,
        enabled: configuration?.enabled ?? true,
        ...(operationFailure ? { operationFailure } : {}),
        ...(configuration ? { configuration: { enabled: configuration.enabled, sharedDataScope: configuration.sharedDataScope } } : {}),
      };
    }));
    for (const { definition, generation } of entries) this.requireGeneration(definition.id, user, generation);
    assertAccountSessionValidation(validation);
    return views;
  }

  async check(user: AuthenticatedUser, options: { retryFailed?: boolean; signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted();
    const key = this.automaticCheckKey(user, Boolean(options.retryFailed));
    const generation = this.generations.get(this.principalGenerationKey(user.tenantId!, user.homeAccountId)) ?? 0;
    let current = this.automaticInFlight.get(key);
    if (!current) {
      const progress: CapabilityCheckProgress = { checks: capabilityDefinitions
        .filter(definition => supportsAutomaticCapabilityCheck(definition.id) && hasAnyRole(user.roles, definition.internalRoles))
        .map(definition => ({ capabilityId: definition.id, state: "reviewing" })) };
      const controller = new AbortController();
      const shared = {
        controller, progress, waiters: 0,
        completion: this.runAutomaticCheck(user, generation, Boolean(options.retryFailed), progress, controller.signal).finally(() => {
          if (this.automaticInFlight.get(key) === shared) this.automaticInFlight.delete(key);
        }),
      };
      this.automaticInFlight.set(key, shared);
      current = shared;
    }
    await waitForSharedCheck(current, options.signal, () => {
      if (this.automaticInFlight.get(key) === current) this.automaticInFlight.delete(key);
    });
    options.signal?.throwIfAborted();
    const views = await this.automaticViews(user, generation);
    options.signal?.throwIfAborted();
    return views;
  }

  checkProgress(user: AuthenticatedUser, retryFailed = false): CapabilityCheckProgress | null {
    const active = this.automaticInFlight.get(this.automaticCheckKey(user, retryFailed));
    return active ? { checks: active.progress.checks.map(check => ({ ...check })) } : null;
  }

  private automaticCheckKey(user: AuthenticatedUser, retryFailed: boolean) {
    if (!user.tenantId || !user.homeAccountId) throw AppError.unauthorized("Capability checks require an exact account.");
    if (!hasAppRole(user.roles, "AgentControl.Viewer")) throw new AppError(403, "missing_internal_role", "Viewer role is required.");
    const generation = this.generations.get(this.principalGenerationKey(user.tenantId, user.homeAccountId)) ?? 0;
    return `${user.tenantId}\0${user.homeAccountId}\0${generation}\0${hasAppRole(user.roles, "AgentControl.Admin")}\0${retryFailed}`;
  }

  async observeOperation<T>(capabilityId: CapabilityId, user: OperationPrincipal, operation: (reportFailure: (error: unknown) => void) => Promise<T>,
    options: { signal?: AbortSignal; clearOnSuccess?: boolean | ((result: T) => boolean); shouldRecordError?: () => boolean } = {}): Promise<T> {
    const context = this.operationContext(capabilityId, { tenantId: user.tenantId, homeAccountId: user.homeAccountId }).catch(error => {
      logOperationEvidenceFailure(capabilityId, error);
      return undefined;
    });
    let captured: ReturnType<typeof operationError>;
    const reportFailure = (error: unknown) => { captured = operationError(error) ?? captured; };
    try {
      const result = await operation(reportFailure);
      const clear = typeof options.clearOnSuccess === "function" ? options.clearOnSuccess(result) : options.clearOnSuccess !== false;
      if (captured) await this.publishOperation(await context, captured.status, captured.details, options.signal);
      else if (clear) await this.publishOperation(await context, "available", {}, options.signal);
      return result;
    } catch (error) {
      const failure = operationError(error) ?? captured;
      if (failure && options.shouldRecordError?.() !== false) await this.publishOperation(await context, failure.status, failure.details, options.signal);
      throw error;
    }
  }

  private async operationContext(capabilityId: CapabilityId, user: OperationPrincipal) {
    const definition = requiredDefinition(capabilityId);
    if (!user.tenantId || !user.homeAccountId || definition.mode === "local" || !definition.probe.adapterRegistered) {
      throw new AppError(400, "invalid_operation_evidence", "Operation evidence requires an implemented provider capability and exact account.");
    }
    const generation = this.generation(definition.id, user);
    const validation = beginAccountSessionValidation(user.tenantId, user.homeAccountId);
    const configuration = await this.currentConfiguration(definition, user, generation);
    assertAccountSessionValidation(validation);
    return { key: operationKey(this.evidenceKey(definition, user, configuration)), definition, generation, validation, user };
  }

  private async publishOperation(context: Awaited<ReturnType<CapabilityService["operationContext"]>> | undefined,
    status: CapabilityStatus, details: Record<string, unknown>, signal?: AbortSignal) {
    if (!context || signal?.aborted) return;
    try {
      await commitAccountSessionValidation(context.validation, () => this.mutate(async () => {
        signal?.throwIfAborted();
        this.requireGeneration(context.definition.id, context.user, context.generation);
        assertAccountSessionValidation(context.validation);
        await this.repository.recordEvidence(context.key, status, safeEvidenceDetails(details), operationEvidenceTtlMs);
      }));
    } catch (error) { logOperationEvidenceFailure(context.definition.id, error); }
  }

  private async operationFailure(definition: CapabilityDefinition, user: AuthenticatedUser, generation: string): Promise<CapabilityOperationFailure | undefined> {
    if (definition.mode === "local" || !definition.probe.adapterRegistered || !hasAnyRole(user.roles, definition.internalRoles)) return undefined;
    const configuration = await this.currentConfiguration(definition, user, generation);
    if (definition.mode === "application" && (!configuration.enabled || !configuration.sharedDataScope)) return undefined;
    const saved = await this.repository.evidence(operationKey(this.evidenceKey(definition, user, configuration)));
    this.requireGeneration(definition.id, user, generation);
    if (!saved || !Number.isFinite(Date.parse(saved.expiresAt)) || Date.parse(saved.expiresAt) <= Date.now()
      || !Number.isFinite(Date.parse(saved.observedAt))) return undefined;
    const evidence = safeEvidenceView(saved.details);
    if (!isOperationFailure(saved.status, evidence)) return undefined;
    return { status: saved.status, checkedAt: saved.observedAt, expiresAt: saved.expiresAt, evidence,
      remediation: saved.status === "provider_error"
        ? ["Microsoft denied this operation. The response does not establish whether authentication, API permissions, provider role, licensing, or target access caused the denial. Use the safe provider diagnostics to investigate."]
        : remediation(definition, saved.status, evidence?.category) };
  }

  async decision(capability: CapabilityId | CapabilityDefinition, user: AuthenticatedUser): Promise<CapabilityDecision> {
    const definition = typeof capability === "string" ? requiredDefinition(capability) : capability;
    const generation = this.generation(definition.id, user);
    if (!hasAnyRole(user.roles, definition.internalRoles)) return decision(definition, "missing_internal_role", undefined, definition.maturity === "preview" ? "unqualified" : "not_required");
    if (definition.mode === "local") return decision(definition, "available", undefined, "not_required");
    if (!definition.probe.adapterRegistered) return decision(definition, "not_configured", undefined, definition.maturity === "preview" ? "unqualified" : "not_required");
    const configuration = await this.currentConfiguration(definition, user, generation);
    if (definition.mode === "application" && (!configuration.enabled || !configuration.sharedDataScope)) {
      return decision(definition, "not_configured", undefined, previewState(definition, configuration));
    }
    const evidence = await this.repository.evidence(this.evidenceKey(definition, user, configuration));
    this.requireGeneration(definition.id, user, generation);
    if (definition.probe.kind === "on_demand" && !evidence) {
      return {
        capabilityId: definition.id, status: "available", authorized: true, fresh: true,
        verification: "on_demand", previewQualification: "not_required",
        remediation: [definition.dataClass === "package_control"
          ? "Choose a target and confirm the operation. Microsoft validates delegated permissions when the request runs."
          : "Request the read from its feature. Microsoft validates delegated permissions when the request runs."],
      };
    }
    if (!evidence || !(Date.parse(evidence.expiresAt) > Date.now())) return decision(definition, "unknown", evidence, previewState(definition, configuration));
    return decision(definition, evidence.status, evidence, previewState(definition, configuration));
  }

  async requireAvailable(capabilityId: CapabilityId, user: AuthenticatedUser, options: { retryFailed?: boolean } = {}) {
    const definition = requiredDefinition(capabilityId);
    const generation = this.generation(definition.id, user);
    let current = await this.decision(definition, user);
    this.requireGeneration(definition.id, user, generation);
    if (!current.authorized && !reuseCapabilityCheck(current, Boolean(options.retryFailed))
      && (supportsAutomaticCapabilityCheck(capabilityId) || definition.probe.kind === "on_demand")) {
      current = await this.refreshAtGeneration(definition, user, generation);
    }
    if (!current.authorized) throw unavailableCapabilityError(current);
    return current;
  }

  async requireApplicationDataScope(capabilityId: CapabilityId, user: AuthenticatedUser) {
    const definition = requiredDefinition(capabilityId);
    if (definition.mode !== "application" || !hasAnyRole(user.roles, definition.internalRoles)) {
      throw new AppError(403, "missing_internal_role", "The application data scope is not authorized for this role.");
    }
    const configuration = await this.currentConfiguration(definition, user);
    if (!configuration.enabled || !configuration.sharedDataScope) {
      throw new AppError(403, "not_configured", "Application package reads require an enabled, administrator-approved shared data scope.");
    }
    return configuration;
  }

  async auditQualificationContext(capabilityId: "purview.audit.search.delegated" | "purview.audit.search.application", user: AuthenticatedUser) {
    const definition = requiredDefinition(capabilityId);
    if (!user.tenantId || !hasAnyRole(user.roles, definition.internalRoles)) throw new AppError(403, "missing_internal_role", "Audit Search qualification requires the Viewer role.");
    const configuration = await this.currentConfiguration(definition, user);
    if (definition.mode === "application" && (!configuration.enabled || !configuration.sharedDataScope)) {
      throw new AppError(403, "not_configured", "Application Audit Search requires an enabled, administrator-approved shared data scope.");
    }
    return {
      capabilityId,
      contractRevision: capabilityContractRevision(definition),
      permissionRevision: capabilityPermissionRevision(definition),
      configurationRevision: configuration.revision,
    };
  }

  async recordAuditQualificationEvidence(capabilityId: "purview.audit.search.delegated" | "purview.audit.search.application", user: AuthenticatedUser, status: CapabilityStatus, details: Record<string, unknown>, approvedConfigurationRevision?: number) {
    const definition = requiredDefinition(capabilityId);
    if (definition.probe.kind !== "live_qualification") throw new AppError(400, "invalid_qualification", "This capability does not use live lifecycle qualification.");
    return this.recordQualificationEvidence(definition, user, status, details, approvedConfigurationRevision);
  }

  async huntingQualificationContext(capabilityId: "defender.hunting.delegated" | "defender.hunting.application", user: AuthenticatedUser) {
    const definition = requiredDefinition(capabilityId);
    if (!user.tenantId || !hasAnyRole(user.roles, definition.internalRoles)) throw new AppError(403, "missing_internal_role", "Hunting qualification requires the Viewer role.");
    const configuration = await this.currentConfiguration(definition, user);
    if (definition.mode === "application" && (!configuration.enabled || !configuration.sharedDataScope)) {
      throw new AppError(403, "not_configured", "Application hunting requires an enabled, administrator-approved shared data scope.");
    }
    return { capabilityId, contractRevision: capabilityContractRevision(definition), permissionRevision: capabilityPermissionRevision(definition),
      configurationRevision: configuration.revision };
  }

  async recordHuntingQualificationEvidence(capabilityId: "defender.hunting.delegated" | "defender.hunting.application", user: AuthenticatedUser, status: CapabilityStatus, details: Record<string, unknown>, approvedConfigurationRevision?: number) {
    const definition = requiredDefinition(capabilityId);
    if (definition.probe.kind !== "live_qualification") throw new AppError(400, "invalid_qualification", "This capability does not use live hunting qualification.");
    return this.recordQualificationEvidence(definition, user, status, details, approvedConfigurationRevision);
  }

  async packageQualificationIdentity(action: AuditAction, user: AuthenticatedUser) {
    if (!user.tenantId) throw AppError.unauthorized("Package qualification requires a tenant scope.");
    if (!hasAppRole(user.roles, "AgentControl.Admin")) throw new AppError(403, "missing_internal_role", "Package mutation qualification requires the Admin role.");
    const capabilityId: CapabilityId = action === "block" || action === "unblock"
      ? "graph.package.block.manage"
      : action === "reassign" ? "graph.package.reassign.manage" : "graph.package.access.manage";
    const definition = requiredDefinition(capabilityId);
    if (definition.mode !== "delegated") throw new AppError(409, "invalid_token_mode", "Package mutation qualification requires delegated authorization.");
    const configuration = await this.currentConfiguration(definition, user);
    return {
      capabilityId,
      contractRevision: capabilityContractRevision(definition),
      configurationRevision: configuration.revision,
      authMode: "delegated" as const,
    };
  }

  async quarantineAuthorityContext(user: AuthenticatedUser) {
    const definition = requiredDefinition("powerPlatform.quarantine.manage");
    if (!user.tenantId || !hasAnyRole(user.roles, definition.internalRoles)) throw new AppError(403, "missing_internal_role", "Quarantine control requires the Admin role.");
    const configuration = await this.currentConfiguration(definition, user);
    return { contractRevision: capabilityContractRevision(definition), permissionRevision: capabilityPermissionRevision(definition), configurationRevision: configuration.revision };
  }

  async quarantineApprovalAuthorityContext(user: AuthenticatedUser) {
    const definition = requiredDefinition("powerPlatform.quarantine.manage");
    if (!user.tenantId || !hasAppRole(user.roles, "AgentControl.Admin")) throw new AppError(403, "missing_internal_role", "Admin is required to approve quarantine canaries.");
    const configuration = await this.currentConfiguration(definition, user);
    return { contractRevision: capabilityContractRevision(definition), permissionRevision: capabilityPermissionRevision(definition), configurationRevision: configuration.revision };
  }

  async refresh(capabilityId: CapabilityId, user: AuthenticatedUser, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const definition = requiredDefinition(capabilityId);
    const generation = this.generation(definition.id, user);
    const current = await this.decision(definition, user);
    signal?.throwIfAborted();
    this.requireGeneration(definition.id, user, generation);
    if (current.fresh && current.evidence?.category === "provider_throttled") return current;
    const refreshed = await this.refreshAtGeneration(definition, user, generation, signal);
    signal?.throwIfAborted();
    return refreshed;
  }

  private async refreshAtGeneration(definition: CapabilityDefinition, user: AuthenticatedUser, generation: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.requireGeneration(definition.id, user, generation);
    if (!hasAnyRole(user.roles, definition.internalRoles)) return this.decision(definition, user);
    if (definition.mode === "local" || !definition.probe.adapterRegistered ||
      !["provider_read", "live_qualification", "on_demand"].includes(definition.probe.kind) ||
      definition.probe.kind === "live_qualification" && definition.mode !== "delegated") return this.decision(definition, user);
    const configuration = await this.currentConfiguration(definition, user, generation);
    if (definition.mode === "application" && (!configuration.enabled || !configuration.sharedDataScope)) return this.decision(definition, user);
    const key = this.evidenceKey(definition, user, configuration);
    const saved = await this.repository.evidence(key);
    signal?.throwIfAborted();
    this.requireGeneration(definition.id, user, generation);
    const cooldown = boundedRetryAfter(saved?.details.retryAfterMs);
    if (saved && cooldown !== undefined && Date.parse(saved.observedAt) + cooldown > Date.now()) return this.decision(definition, user);
    const serializedKey = `${JSON.stringify(key)}\0${generation}`;
    let current = this.inFlight.get(serializedKey);
    if (!current) {
      const controller = new AbortController();
      const shared: SharedCheck<CapabilityDecision> = {
        controller, waiters: 0,
        completion: this.runProbe(definition, user, key, generation, controller.signal).finally(() => {
          if (this.inFlight.get(serializedKey) === shared) this.inFlight.delete(serializedKey);
        }),
      };
      this.inFlight.set(serializedKey, shared);
      current = shared;
    }
    return waitForSharedCheck(current, signal, () => {
      if (this.inFlight.get(serializedKey) === current) this.inFlight.delete(serializedKey);
    });
  }

  private async runProbe(definition: CapabilityDefinition, user: AuthenticatedUser, key: EvidenceKey, generation: string, cancellation?: AbortSignal) {
    let status: CapabilityStatus = "available";
    let details: Record<string, unknown> = { contract: definition.probe.description, verification: defaultVerification(definition) };
    let phase: "token_acquisition" | "provider_read" = "token_acquisition";
    let timeoutMs = automaticCheckDeadlineMs;
    const validation = beginAccountSessionValidation(user.tenantId!, user.homeAccountId);
    const beforeRequest = () => {
      cancellation?.throwIfAborted();
      this.requireGeneration(definition.id, user, generation);
      assertAccountSessionValidation(validation);
    };
    this.requireGeneration(definition.id, user, generation);
    try {
      const token = await retryReadiness(() => definition.mode === "delegated"
        ? this.probes.delegatedToken(user.homeAccountId, definition.id)
        : this.probes.applicationToken(definition.id), timeoutMs, cancellation, beforeRequest);
      this.requireGeneration(definition.id, user, generation);
      phase = "provider_read";
      timeoutMs = definition.id.startsWith("graph.package.read.") ? packageReadTimeoutMs : automaticCheckDeadlineMs;
      if (definition.id.startsWith("graph.package.read.")) await retryReadiness(signal => this.probes.packageProbe(token, signal), timeoutMs, cancellation, beforeRequest);
      else if (definition.id === "graph.directory.read") await retryReadiness(signal => this.probes.directoryProbe(token, signal), timeoutMs, cancellation, beforeRequest);
      else if (definition.id === "powerPlatform.inventory.read") await retryReadiness(signal => this.probes.inventoryProbe(token, signal), timeoutMs, cancellation, beforeRequest);
    } catch (error) {
      beforeRequest();
      status = probeStatus(error);
      details = { ...safeProbeDetails(error), phase, timeoutMs, verification: defaultVerification(definition),
        ...(retryAfter(error) === undefined ? {} : { retryAfterMs: retryAfter(error) }) };
    }
    beforeRequest();
    await this.mutate(async () => {
      this.requireGeneration(definition.id, user, generation);
      beforeRequest();
      const cooldown = boundedRetryAfter(details.retryAfterMs) ?? 0;
      await this.repository.recordEvidence(key, status, details, Math.max(evidenceTtlMs, cooldown));
    });
    beforeRequest();
    const current = await this.decision(definition, user);
    beforeRequest();
    return current;
  }

  private async runAutomaticCheck(user: AuthenticatedUser, generation: number, retryFailed: boolean, progress: CapabilityCheckProgress, signal?: AbortSignal) {
    const eligible = progress.checks.map(check => ({
      check, definition: requiredDefinition(check.capabilityId), refreshGeneration: this.generation(check.capabilityId, user),
    }));
    await Promise.all(eligible.map(async ({ check, definition, refreshGeneration }) => {
      const current = await this.decision(definition, user);
      const reuseFresh = reuseCapabilityCheck(current, retryFailed);
      if (generation !== (this.generations.get(this.principalGenerationKey(user.tenantId!, user.homeAccountId)) ?? 0)) return;
      if (!reuseFresh) {
        check.state = "checking";
        await this.refreshAtGeneration(definition, user, refreshGeneration, signal);
      }
      check.state = "complete";
    }));
    if (generation !== (this.generations.get(this.principalGenerationKey(user.tenantId!, user.homeAccountId)) ?? 0)) {
      throw new AppError(401, "authorization_expired", "The signed-in account changed during automatic capability checks.");
    }
  }

  private async automaticViews(user: AuthenticatedUser, generation: number) {
    const views = await this.list(user);
    if (generation !== (this.generations.get(this.principalGenerationKey(user.tenantId!, user.homeAccountId)) ?? 0)) {
      throw new AppError(401, "authorization_expired", "The signed-in account changed while capability decisions were assembled.");
    }
    return views;
  }

  async configureApplication(capabilityId: CapabilityId, user: AuthenticatedUser, enabled: boolean, sharedDataScope: boolean) {
    const definition = requiredDefinition(capabilityId);
    if (!hasAppRole(user.roles, "AgentControl.Admin")) throw new AppError(403, "missing_internal_role", "Admin role is required.");
    if (definition.mode !== "application") throw new AppError(400, "invalid_configuration", "Only application-mode capabilities use this configuration.");
    this.bump(this.capabilityGenerationKey(user.tenantId!, definition.id));
    return this.mutate(() => this.repository.setApplicationConfiguration(user.tenantId!, definition.id, enabled, sharedDataScope, user.homeAccountId));
  }

  async invalidatePrincipal(user: AuthenticatedUser) {
    const key = this.principalGenerationKey(user.tenantId!, user.homeAccountId);
    const generation = this.bump(key);
    this.pendingPrincipalInvalidations.set(key, generation);
    await this.mutate(async () => {
      await this.repository.invalidatePrincipal(user.tenantId!, user.homeAccountId);
      if (this.pendingPrincipalInvalidations.get(key) === generation) this.pendingPrincipalInvalidations.delete(key);
    });
  }

  private async currentConfiguration(definition: CapabilityDefinition, user: OperationPrincipal, generation = this.generation(definition.id, user)) {
    await this.mutationTail;
    this.requireGeneration(definition.id, user, generation);
    if (this.pendingPrincipalInvalidations.has(this.principalGenerationKey(user.tenantId!, user.homeAccountId))) {
      throw new AppError(503, "capability_invalidation_failed", "Capability evidence could not be invalidated. Retry after account authorization cleanup succeeds.");
    }
    const configuration = await this.repository.configuration(user.tenantId!, definition.id);
    this.requireGeneration(definition.id, user, generation);
    return configuration;
  }

  private async recordQualificationEvidence(definition: CapabilityDefinition, user: AuthenticatedUser, status: CapabilityStatus, details: Record<string, unknown>, approvedConfigurationRevision?: number) {
    const generation = this.generation(definition.id, user);
    const configuration = await this.currentConfiguration(definition, user, generation);
    if (definition.mode === "application" && (!configuration.enabled || !configuration.sharedDataScope
      || configuration.revision !== approvedConfigurationRevision)) {
      throw new AppError(409, "qualification_superseded", "Application qualification evidence no longer matches the approved configuration.");
    }
    const key = this.evidenceKey(definition, user, configuration);
    await this.mutate(async () => {
      this.requireGeneration(definition.id, user, generation);
      await this.repository.recordEvidence(key, status, safeEvidenceDetails({ ...details, verification: "provider" }), evidenceTtlMs);
    });
    this.requireGeneration(definition.id, user, generation);
    const current = await this.decision(definition, user);
    this.requireGeneration(definition.id, user, generation);
    return current;
  }

  private evidenceKey(definition: CapabilityDefinition, user: OperationPrincipal, configuration: CapabilityConfiguration): EvidenceKey {
    return {
      tenantId: user.tenantId!,
      principalId: definition.mode === "application" ? config.clientId! : user.homeAccountId,
      authorizationPrincipalId: user.homeAccountId,
      capabilityId: definition.id,
      resourceAudience: definition.audience,
      environmentId: definition.cloud,
      tokenMode: definition.mode as "delegated" | "application",
      permissionRevision: capabilityPermissionRevision(definition),
      contractRevision: capabilityContractRevision(definition),
      configurationRevision: configuration.revision,
    };
  }

  private generation(capabilityId: CapabilityId, user: OperationPrincipal) {
    return `${this.generations.get(this.principalGenerationKey(user.tenantId!, user.homeAccountId)) ?? 0}:${this.generations.get(this.capabilityGenerationKey(user.tenantId!, capabilityId)) ?? 0}`;
  }

  private requireGeneration(capabilityId: CapabilityId, user: OperationPrincipal, generation: string) {
    if (generation !== this.generation(capabilityId, user)) {
      throw new AppError(401, "authorization_expired", "The signed-in account changed during capability verification.");
    }
  }

  private principalGenerationKey(tenantId: string, principalId: string) {
    return `principal\0${tenantId}\0${principalId}`;
  }

  private capabilityGenerationKey(tenantId: string, capabilityId: CapabilityId) {
    return `capability\0${tenantId}\0${capabilityId}`;
  }

  private bump(key: string) {
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    return generation;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export const capabilities = new CapabilityService();

function operationKey(key: EvidenceKey): EvidenceKey {
  return { ...key, contractRevision: `operation-v1:${key.contractRevision}` };
}

function logOperationEvidenceFailure(capabilityId: CapabilityId, error: unknown) {
  operationalLog("warn", "capability_operation_evidence_failed", {
    capabilityId, errorCode: error instanceof AppError ? error.code : "evidence_storage_failed",
  });
}

function isOperationFailure(status: CapabilityStatus, evidence: CapabilityDecision["evidence"]): status is CapabilityOperationFailure["status"] {
  return ["missing_permission", "missing_role", "missing_license"].includes(status)
    || status === "unknown" && ["interaction_required", "authorization_expired"].includes(evidence?.category ?? "")
    || status === "provider_error" && [401, 403].includes(evidence?.httpStatus ?? 0);
}

function operationError(error: unknown): { status: CapabilityOperationFailure["status"]; details: Record<string, unknown> } | undefined {
  if (!(error instanceof AppError)) return undefined;
  if (error.details && typeof error.details === "object" && "capabilityId" in error.details && "authorized" in error.details) return undefined;
  const details = { ...safeProbeDetails(error) };
  const explicit = error.code === "missing_provider_scope" ? "missing_permission"
    : error.code === "missing_provider_role" ? "missing_role"
      : error.code === "conditional_access_required" ? "interaction_required" : error.code;
  if (["missing_permission", "missing_role", "missing_license"].includes(explicit)) {
    const status = explicit === "missing_permission" ? "missing_permission" : explicit === "missing_role" ? "missing_role" : "missing_license";
    return { status, details: { ...details, category: status } };
  }
  if (explicit === "interaction_required" || explicit === "authorization_expired") {
    return { status: "unknown", details: { ...details, category: explicit } };
  }
  if (["provider_authorization_error", "agent_identity_permission_required", "hunting_access_denied", "provider_denied"].includes(error.code)
    && [401, 403].includes(error.status)) details.httpStatus = error.status;
  if ([401, 403].includes(details.httpStatus ?? 0)) return { status: "provider_error", details: { ...details, category: "provider_error" } };
  return undefined;
}

function probeSignal(timeoutMs: number, cancellation?: AbortSignal) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return cancellation ? AbortSignal.any([deadline, cancellation]) : deadline;
}

function retryAfter(error: unknown) {
  if (!(error instanceof AppError) || !error.details || typeof error.details !== "object" || !("retryAfterMs" in error.details)) return undefined;
  return boundedRetryAfter(error.details.retryAfterMs);
}

function boundedRetryAfter(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : undefined;
}

function readinessRetryDelay(error: unknown) {
  if (error instanceof AppError && (["missing_permission", "missing_provider_scope", "missing_role", "missing_provider_role", "missing_license",
    "interaction_required", "authorization_expired", "unsupported", "provider_schema", "provider_result_limit", "auth_not_configured"].includes(error.code)
    || [400, 401, 403, 404].includes(error.status))) return undefined;
  const cooldown = retryAfter(error);
  if (cooldown !== undefined && cooldown > 1_000) return undefined;
  if (error instanceof AppError && safeProbeDetails(error)?.category === "provider_throttled") return cooldown === undefined ? undefined : Math.max(10, cooldown);
  const tokenTransient = error instanceof AppError && error.code === "identity_provider_error"
    && error.details !== null && typeof error.details === "object" && "retryable" in error.details && error.details.retryable === true;
  const transient = error instanceof TypeError || error instanceof Error && error.name === "TimeoutError"
    || error instanceof AppError && (["provider_network_error", "provider_timeout"].includes(error.code)
      || tokenTransient || [500, 502, 503, 504].includes(error.status) && error.code !== "identity_provider_error"
        && (error.code === "provider_error" || safeProbeDetails(error)?.httpStatus === error.status));
  return transient ? Math.max(10, cooldown ?? 100) : undefined;
}

async function retryReadiness<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number,
  cancellation: AbortSignal | undefined, beforeRequest: () => void): Promise<T> {
  const attempt = () => {
    cancellation?.throwIfAborted();
    beforeRequest();
    const signal = probeSignal(timeoutMs, cancellation);
    signal.throwIfAborted();
    return abortable(operation(signal), signal);
  };
  try { return await attempt(); }
  catch (error) {
    cancellation?.throwIfAborted();
    beforeRequest();
    const waitMs = readinessRetryDelay(error);
    if (waitMs === undefined) throw error;
    await delay(waitMs, undefined, { signal: cancellation });
    return attempt();
  }
}

function reuseCapabilityCheck(current: CapabilityDecision, retryFailed: boolean) {
  return current.fresh && current.verification !== "on_demand"
    && (!retryFailed || current.authorized || current.evidence?.category === "provider_throttled");
}

function unavailableCapabilityError(current: CapabilityDecision) {
  const category = current.evidence?.category;
  if (current.status === "provider_error") {
    if (category === "provider_timeout") {
      return new AppError(504, "provider_timeout", "The Microsoft readiness check timed out. This does not establish missing permissions. Retry the readiness check.", current);
    }
    if (category === "provider_throttled") {
      return new AppError(429, "provider_throttled", "Microsoft throttled the readiness check. Wait for the provider cooldown before retrying; no permission change is indicated.", current);
    }
    return new AppError(503, "provider_error", "The Microsoft readiness check failed. This does not establish missing permissions. Retry the readiness check.", current);
  }
  if (current.status === "unknown" && (category === "interaction_required" || category === "authorization_expired")) {
    return new AppError(401, category, "Explicit resume with renewed Microsoft authorization is required.", current);
  }
  return new AppError(403, "capability_unavailable", "The capability is not currently authorized.", current);
}

function requiredDefinition(capabilityId: CapabilityId) {
  const definition = getCapabilityDefinition(capabilityId);
  if (!definition) throw new AppError(404, "capability_not_found", "Capability was not found.");
  return definition;
}

function decision(definition: CapabilityDefinition, status: CapabilityStatus, evidence: CapabilityEvidence | undefined, previewQualification: CapabilityDecision["previewQualification"]): CapabilityDecision {
  return {
    capabilityId: definition.id, status, authorized: status === "available", fresh: Boolean(evidence && Date.parse(evidence.expiresAt) > Date.now()),
    verification: evidenceVerification(definition, status, evidence),
    checkedAt: evidence?.observedAt, expiresAt: evidence?.expiresAt, lastSuccessAt: evidence?.lastSuccessAt,
    evidence: evidence ? safeEvidenceView(evidence.details) : undefined,
    previewQualification, remediation: remediation(definition, status,
      typeof evidence?.details.category === "string" ? evidence.details.category : undefined),
  };
}

function safeEvidenceView(details: Record<string, unknown>): CapabilityDecision["evidence"] {
  const httpStatus = typeof details.httpStatus === "string" && /^[1-5][0-9]{2}$/.test(details.httpStatus)
    ? Number(details.httpStatus) : details.httpStatus;
  return {
    ...(typeof details.category === "string" && evidenceCategories.has(details.category) ? { category: details.category } : {}),
    ...(typeof details.correlationId === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(details.correlationId) ? { correlationId: details.correlationId } : {}),
    ...(typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(typeof details.providerErrorCode === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(details.providerErrorCode) ? { providerErrorCode: details.providerErrorCode } : {}),
    ...(details.phase === "token_acquisition" || details.phase === "provider_read" ? { phase: details.phase } : {}),
    ...(typeof details.timeoutMs === "number" && Number.isInteger(details.timeoutMs) && details.timeoutMs > 0 && details.timeoutMs <= 60_000 ? { timeoutMs: details.timeoutMs } : {}),
  };
}

const evidenceCategories = new Set(["provider_error", "interaction_required", "authorization_expired", "missing_permission", "missing_role", "missing_license", "unsupported",
  "authorization_not_yet_valid", "identity_provider_error",
  "provider_timeout", "provider_network_error", "provider_throttled", "provider_schema", "provider_result_limit"]);

function previewState(definition: CapabilityDefinition, configuration: CapabilityConfiguration): CapabilityDecision["previewQualification"] {
  return definition.maturity !== "preview" || definition.probe.kind === "on_demand" ? "not_required" : configuration.previewQualified ? "qualified" : "unqualified";
}

function probeStatus(error: unknown): CapabilityStatus {
  if (error instanceof AppError) {
    if (error.code === "interaction_required" || error.code === "authorization_expired") return "unknown";
    if (error.code === "missing_permission") return "missing_permission";
    if (error.status === 404 || error.code === "unsupported") return "unsupported";
    if (error.status === 401 || error.status === 403) return "provider_error";
  }
  return "provider_error";
}

function safeProbeDetails(error: unknown) {
  const details = error instanceof AppError && error.details && typeof error.details === "object"
    ? error.details as Record<string, unknown> : {};
  const code = error instanceof AppError ? error.code : undefined;
  const category = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    ? "provider_timeout"
    : error instanceof TypeError ? "provider_network_error"
      : error instanceof AppError && (error.status === 429 || details.throttled === true) ? "provider_throttled"
        : code && evidenceCategories.has(code) ? code : "provider_error";
  return safeEvidenceView({
    category,
    correlationId: details.correlationId ?? details.providerRequestId ?? (error as { correlationId?: unknown })?.correlationId,
    httpStatus: details.httpStatus,
    providerErrorCode: details.providerErrorCode ?? (code && code !== "graph_error" && !evidenceCategories.has(code) ? code : undefined),
  });
}

function safeEvidenceDetails(details: Record<string, unknown>) {
  return {
    ...safeEvidenceView({ ...details, correlationId: details.correlationId ?? details.providerRequestId }),
    ...(["token", "provider", "local"].includes(String(details.verification)) ? { verification: details.verification } : {}),
  };
}

function remediation(definition: CapabilityDefinition, status: CapabilityStatus, category?: string) {
  const capabilityId = definition.id;
  if (definition.mode === "application" && ["interaction_required", "authorization_expired"].includes(category ?? "")) {
    return ["An administrator must verify the existing app registration's credentials and previously granted application API permissions. User sign-in does not repair app-only authorization."];
  }
  if (category === "interaction_required") return ["Sign in again to complete MFA or account verification. Contact your administrator if Conditional Access blocks sign-in; API permission grants are a separate admin prerequisite."];
  if (category === "authorization_expired") return ["Sign in again before retrying."];
  if (category === "authorization_not_yet_valid") return ["The Microsoft token is not yet valid. Check the application host clock and time synchronization before retrying; additional consent is not indicated."];
  if (category === "identity_provider_error") return ["Microsoft Entra ID could not complete valid token acquisition. Retry and use the sanitized error code and correlation ID for identity-provider troubleshooting; this does not establish missing consent."];
  if (category === "provider_timeout") return ["The bounded provider check timed out. Retry; a timeout does not establish missing permissions, roles, or licensing."];
  if (category === "provider_network_error") return ["The provider could not be reached. Check service connectivity and retry the bounded check without broadening consent."];
  if (category === "provider_throttled") return ["The provider throttled the bounded check. Wait before retrying without changing permissions."];
  if (category === "provider_schema" || category === "provider_result_limit") return ["The provider response did not satisfy the bounded adapter contract. Check the documented endpoint and sanitized diagnostics before retrying."];
  if (status === "missing_permission") return [
    `${adminManagedPermissionsMessage} Required ${definition.mode} permissions: ${definition.permissions.join(", ")}.`,
  ];
  if (status === "unknown" && !supportsAutomaticCapabilityCheck(capabilityId)) {
    if (definition.mode === "application") return [definition.probe.kind === "live_qualification"
      ? "An Admin must explicitly approve a bounded application-scope operation; automatic delegated checks do not verify application access."
      : "After an Admin enables application mode and approves its shared data scope, request an explicit bounded application-scope read; automatic delegated checks do not verify application access."];
    if (definition.probe.kind === "on_demand") return ["Retry the read from the dashboard; automatic permission checks do not run this capability."];
  }
  if (capabilityId.startsWith("purview.audit.search.")) {
    const auditValues: Partial<Record<CapabilityStatus, string[]>> = {
      missing_internal_role: ["Assign the AgentControl.Viewer role."],
      not_configured: ["Enable application mode and its shared data scope before approving an application qualification."],
      provider_error: ["Verify Purview Audit entitlement, unified auditing, and Audit Logs or View-Only Audit Logs role for delegated use, then retry the bounded search."],
      unsupported: ["Verify tenant rollout for the selected Microsoft Graph v1.0 Audit Search lifecycle."],
      unknown: ["Run the automatic delegated readiness check or submit one explicit bounded search."],
    };
    return auditValues[status] ?? [];
  }
  if (capabilityId.startsWith("defender.hunting.")) {
    const huntingValues: Partial<Record<CapabilityStatus, string[]>> = {
      missing_internal_role: ["Assign AgentControl.Viewer."],
      not_configured: ["Enable application mode and approve its shared data scope before application qualification."],
      provider_error: ["Check Defender XDR RBAC/data-source scope, licensing, Agent 365 connectivity and table rollout separately, then retry the bounded investigation."],
      unsupported: ["Verify the Graph v1.0 hunting endpoint and AgentsInfo or CloudAppEvents rollout for this tenant."],
      unknown: ["Run the automatic delegated readiness check or submit one explicit bounded investigation."],
    };
    return huntingValues[status] ?? [];
  }
  const values: Partial<Record<CapabilityStatus, string[]>> = {
    missing_internal_role: ["Ask an administrator to assign the required Agent Control app role."],
    missing_role: ["Verify the documented provider role without broadening API consent."],
    missing_license: ["Verify the documented service license for the same account or application scope."],
    not_configured: ["Complete the listed configuration. An unregistered adapter remains unavailable until its documented contract and required safety controls are implemented."],
    provider_error: ["Retry the bounded probe; an ambiguous provider failure does not identify a missing role or license."],
    unsupported: ["Verify the documented cloud, endpoint, and resource support."],
    unknown: ["Run the automatic non-mutating readiness check after an administrator has configured API permissions and granted admin consent in the existing Entra app registration."],
  };
  return values[status] ?? [];
}

function defaultVerification(definition: CapabilityDefinition): NonNullable<CapabilityDecision["verification"]> {
  if (definition.mode === "local") return "local";
  if (definition.probe.kind === "live_qualification" || definition.probe.kind === "on_demand" || definition.id.startsWith("powerPlatform.quarantine.")) return "token";
  return "provider";
}

function evidenceVerification(definition: CapabilityDefinition, status: CapabilityStatus, evidence: CapabilityEvidence | undefined): CapabilityDecision["verification"] {
  if (status !== "available") return undefined;
  if (definition.mode === "local") return "local";
  if (!evidence || evidence.status !== "available" || !(Date.parse(evidence.expiresAt) > Date.now())) return undefined;
  const value = evidence.details.verification;
  if (definition.probe.kind === "live_qualification") return value === "token" || value === "provider" ? value : undefined;
  const expected = defaultVerification(definition);
  return value === expected ? expected : undefined;
}

function waitForSharedCheck<T>(work: SharedCheck<T>, signal: AbortSignal | undefined, abandoned: () => void): Promise<T> {
  work.waiters += 1;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      work.waiters -= 1;
      complete();
    };
    const abort = () => {
      if (settled) return;
      finish(() => reject(signal!.reason));
      if (work.waiters === 0) {
        // Evict synchronously so an immediate replacement cannot join cancelled work.
        abandoned();
        work.controller.abort(signal!.reason);
      }
    };
    work.completion.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}