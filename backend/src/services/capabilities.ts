import type { AuthenticatedUser } from "../types/session.js";
import { hasAppRole, type CapabilityDecision, type CapabilityDefinition, type CapabilityId, type CapabilityStatus } from "../types/capability.js";
import { AppError } from "../errors.js";
import { config } from "../config.js";
import { acquireApplicationToken, acquireDelegatedToken } from "../auth/msal.js";
import { CapabilityRepository, capabilityContractRevision, capabilityPermissionRevision, type CapabilityConfiguration, type CapabilityEvidence, type EvidenceKey } from "../db/capabilities.js";
import { capabilityDefinitions, getCapabilityDefinition, hasAnyRole } from "./capabilityRegistry.js";
import { DirectoryPrincipalsClient } from "./directoryPrincipals.js";
import { packageReadTimeoutMs, GraphPackagesClient } from "./graphPackages.js";
import { PowerPlatformResourceQueryClient } from "./powerPlatformResourceQuery.js";
import type { AuditAction } from "../types/audit.js";

const evidenceTtlMs = 5 * 60 * 1000;
const automaticCheckDeadlineMs = 10_000;
const automaticCapabilityIds = new Set<CapabilityId>([
  "graph.package.read.delegated",
  "graph.package.access.manage",
  "graph.package.block.manage",
  "graph.directory.read",
  "powerPlatform.inventory.read",
  "powerPlatform.quarantine.read",
  "powerPlatform.quarantine.manage",
  "purview.audit.search.delegated",
  "defender.hunting.delegated",
]);

type ProbeDependencies = {
  delegatedToken: typeof acquireDelegatedToken;
  applicationToken: typeof acquireApplicationToken;
  packageProbe: (token: string, signal?: AbortSignal) => Promise<unknown>;
  directoryProbe: (token: string, signal?: AbortSignal) => Promise<unknown>;
  inventoryProbe: (token: string, signal?: AbortSignal) => Promise<unknown>;
};

const defaultProbeDependencies: ProbeDependencies = {
  delegatedToken: acquireDelegatedToken,
  applicationToken: acquireApplicationToken,
  packageProbe: (token, signal) => new GraphPackagesClient().checkCatalogAccess(token, signal),
  directoryProbe: (token, signal) => new DirectoryPrincipalsClient().search(token, "agent-control-permission-check", 1, signal),
  inventoryProbe: (token, signal) => new PowerPlatformResourceQueryClient().checkAccess(token, signal),
};

export class CapabilityService {
  private readonly inFlight = new Map<string, Promise<CapabilityDecision>>();
  private readonly automaticInFlight = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly repository = new CapabilityRepository(), private readonly probes: ProbeDependencies = defaultProbeDependencies) {}

  async list(user: AuthenticatedUser) {
    return Promise.all(capabilityDefinitions.map(async definition => {
      const [current, configuration] = await Promise.all([
        this.decision(definition, user),
        definition.mode === "application" ? this.repository.configuration(user.tenantId!, definition.id) : undefined,
      ]);
      return {
        definition,
        decision: current,
        enabled: configuration?.enabled ?? true,
        ...(configuration ? { configuration: { enabled: configuration.enabled, sharedDataScope: configuration.sharedDataScope } } : {}),
      };
    }));
  }

  async check(user: AuthenticatedUser, options: { retryFailed?: boolean } = {}) {
    if (!user.tenantId) throw AppError.unauthorized("Capability checks require a tenant scope.");
    const generation = this.generations.get(this.principalGenerationKey(user.tenantId, user.homeAccountId)) ?? 0;
    const key = `${user.tenantId}\0${user.homeAccountId}\0${generation}\0${hasAppRole(user.roles, "AgentControl.Admin")}\0${Boolean(options.retryFailed)}`;
    const current = this.automaticInFlight.get(key);
    if (current) {
      await current;
      return this.automaticViews(user, generation);
    }
    const operation = this.runAutomaticCheck(user, generation, Boolean(options.retryFailed));
    const shared: Promise<void> = operation.finally(() => {
      if (this.automaticInFlight.get(key) === shared) this.automaticInFlight.delete(key);
    });
    this.automaticInFlight.set(key, shared);
    await shared;
    return this.automaticViews(user, generation);
  }

  async decision(capability: CapabilityId | CapabilityDefinition, user: AuthenticatedUser): Promise<CapabilityDecision> {
    const definition = typeof capability === "string" ? requiredDefinition(capability) : capability;
    if (!hasAnyRole(user.roles, definition.internalRoles)) return decision(definition, "missing_internal_role", undefined, definition.maturity === "preview" ? "unqualified" : "not_required");
    if (definition.mode === "local") return decision(definition, "available", undefined, "not_required");
    if (!definition.probe.adapterRegistered) return decision(definition, "not_configured", undefined, definition.maturity === "preview" ? "unqualified" : "not_required");
    const configuration = await this.repository.configuration(user.tenantId!, definition.id);
    if (definition.mode === "application" && (!configuration.enabled || !configuration.sharedDataScope)) {
      return decision(definition, "not_configured", undefined, previewState(definition, configuration));
    }
    const evidence = await this.repository.evidence(this.evidenceKey(definition, user, configuration));
    if (definition.probe.kind === "on_demand" && !evidence) {
      return {
        capabilityId: definition.id, status: "available", authorized: true, fresh: true,
        verification: "on_demand", previewQualification: "not_required",
        remediation: ["Choose a target and confirm the operation. Microsoft validates delegated permissions when the request runs."],
      };
    }
    if (!evidence || !(Date.parse(evidence.expiresAt) > Date.now())) return decision(definition, "unknown", evidence, previewState(definition, configuration));
    return decision(definition, evidence.status, evidence, previewState(definition, configuration));
  }

  async requireAvailable(capabilityId: CapabilityId, user: AuthenticatedUser) {
    const definition = requiredDefinition(capabilityId);
    const generation = this.generation(definition.id, user);
    let current = await this.decision(definition, user);
    this.requireGeneration(definition.id, user, generation);
    if (!current.authorized && !current.fresh && automaticCapabilityIds.has(capabilityId)) {
      current = await this.refreshAtGeneration(definition, user, generation);
    }
    if (!current.authorized) throw new AppError(403, "capability_unavailable", "The capability is not currently authorized.", current);
    return current;
  }

  async requireApplicationDataScope(capabilityId: CapabilityId, user: AuthenticatedUser) {
    const definition = requiredDefinition(capabilityId);
    if (definition.mode !== "application" || !hasAnyRole(user.roles, definition.internalRoles)) {
      throw new AppError(403, "missing_internal_role", "The application data scope is not authorized for this role.");
    }
    const configuration = await this.repository.configuration(user.tenantId!, definition.id);
    if (!configuration.enabled || !configuration.sharedDataScope) {
      throw new AppError(403, "not_configured", "Application package reads require an enabled, administrator-approved shared data scope.");
    }
    return configuration;
  }

  async auditQualificationContext(capabilityId: "purview.audit.search.delegated" | "purview.audit.search.application", user: AuthenticatedUser) {
    const definition = requiredDefinition(capabilityId);
    if (!user.tenantId || !hasAnyRole(user.roles, definition.internalRoles)) throw new AppError(403, "missing_internal_role", "Audit Search qualification requires the Viewer role.");
    const configuration = await this.repository.configuration(user.tenantId, capabilityId);
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

  async recordAuditQualificationEvidence(capabilityId: "purview.audit.search.delegated" | "purview.audit.search.application", user: AuthenticatedUser, status: CapabilityStatus, details: Record<string, unknown>) {
    const definition = requiredDefinition(capabilityId);
    if (definition.probe.kind !== "live_qualification") throw new AppError(400, "invalid_qualification", "This capability does not use live lifecycle qualification.");
    const configuration = await this.repository.configuration(user.tenantId!, capabilityId);
    const key = this.evidenceKey(definition, user, configuration);
    const generation = this.generation(definition.id, user);
    await this.mutate(async () => {
      if (generation === this.generation(definition.id, user)) await this.repository.recordEvidence(key, status, safeEvidenceDetails({ ...details, verification: "provider" }), evidenceTtlMs);
    });
    return this.decision(definition, user);
  }

  async huntingQualificationContext(capabilityId: "defender.hunting.delegated" | "defender.hunting.application", user: AuthenticatedUser) {
    const definition = requiredDefinition(capabilityId);
    if (!user.tenantId || !hasAnyRole(user.roles, definition.internalRoles)) throw new AppError(403, "missing_internal_role", "Hunting qualification requires the Viewer role.");
    const configuration = await this.repository.configuration(user.tenantId, capabilityId);
    if (definition.mode === "application" && (!configuration.enabled || !configuration.sharedDataScope)) {
      throw new AppError(403, "not_configured", "Application hunting requires an enabled, administrator-approved shared data scope.");
    }
    return { capabilityId, contractRevision: capabilityContractRevision(definition), permissionRevision: capabilityPermissionRevision(definition),
      configurationRevision: configuration.revision };
  }

  async recordHuntingQualificationEvidence(capabilityId: "defender.hunting.delegated" | "defender.hunting.application", user: AuthenticatedUser, status: CapabilityStatus, details: Record<string, unknown>) {
    const definition = requiredDefinition(capabilityId);
    if (definition.probe.kind !== "live_qualification") throw new AppError(400, "invalid_qualification", "This capability does not use live hunting qualification.");
    const configuration = await this.repository.configuration(user.tenantId!, capabilityId);
    const key = this.evidenceKey(definition, user, configuration);
    const generation = this.generation(definition.id, user);
    await this.mutate(async () => {
      if (generation === this.generation(definition.id, user)) await this.repository.recordEvidence(key, status, safeEvidenceDetails({ ...details, verification: "provider" }), evidenceTtlMs);
    });
    return this.decision(definition, user);
  }

  async packageQualificationIdentity(action: AuditAction, user: AuthenticatedUser) {
    if (!user.tenantId) throw AppError.unauthorized("Package qualification requires a tenant scope.");
    if (!hasAppRole(user.roles, "AgentControl.Admin")) throw new AppError(403, "missing_internal_role", "Package mutation qualification requires the Admin role.");
    const capabilityId: CapabilityId = action === "block" || action === "unblock"
      ? "graph.package.block.manage"
      : action === "reassign" ? "graph.package.reassign.manage" : "graph.package.access.manage";
    const definition = requiredDefinition(capabilityId);
    if (definition.mode !== "delegated") throw new AppError(409, "invalid_token_mode", "Package mutation qualification requires delegated authorization.");
    const configuration = await this.repository.configuration(user.tenantId, capabilityId);
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
    const configuration = await this.repository.configuration(user.tenantId, definition.id);
    return { contractRevision: capabilityContractRevision(definition), permissionRevision: capabilityPermissionRevision(definition), configurationRevision: configuration.revision };
  }

  async quarantineApprovalAuthorityContext(user: AuthenticatedUser) {
    const definition = requiredDefinition("powerPlatform.quarantine.manage");
    if (!user.tenantId || !hasAppRole(user.roles, "AgentControl.Admin")) throw new AppError(403, "missing_internal_role", "Admin is required to approve quarantine canaries.");
    const configuration = await this.repository.configuration(user.tenantId, definition.id);
    return { contractRevision: capabilityContractRevision(definition), permissionRevision: capabilityPermissionRevision(definition), configurationRevision: configuration.revision };
  }

  async refresh(capabilityId: CapabilityId, user: AuthenticatedUser) {
    const definition = requiredDefinition(capabilityId);
    const generation = this.generation(definition.id, user);
    return this.refreshAtGeneration(definition, user, generation);
  }

  private async refreshAtGeneration(definition: CapabilityDefinition, user: AuthenticatedUser, generation: string) {
    this.requireGeneration(definition.id, user, generation);
    if (!hasAnyRole(user.roles, definition.internalRoles)) return this.decision(definition, user);
    if (definition.mode === "local" || !definition.probe.adapterRegistered ||
      !["provider_read", "live_qualification", "on_demand"].includes(definition.probe.kind) ||
      definition.probe.kind === "live_qualification" && definition.mode !== "delegated") return this.decision(definition, user);
    const configuration = await this.repository.configuration(user.tenantId!, definition.id);
    this.requireGeneration(definition.id, user, generation);
    if (definition.mode === "application" && (!configuration.enabled || !configuration.sharedDataScope)) return this.decision(definition, user);
    const key = this.evidenceKey(definition, user, configuration);
    const serializedKey = `${JSON.stringify(key)}\0${generation}`;
    const current = this.inFlight.get(serializedKey);
    if (current) return current;
    const operation = this.runProbe(definition, user, key, generation);
    const shared = operation.finally(() => {
      if (this.inFlight.get(serializedKey) === shared) this.inFlight.delete(serializedKey);
    });
    this.inFlight.set(serializedKey, shared);
    return shared;
  }

  private async runProbe(definition: CapabilityDefinition, user: AuthenticatedUser, key: EvidenceKey, generation: string) {
    let status: CapabilityStatus = "available";
    let details: Record<string, unknown> = { contract: definition.probe.description, verification: defaultVerification(definition) };
    let phase: "token_acquisition" | "provider_read" = "token_acquisition";
    let timeoutMs = automaticCheckDeadlineMs;
    let signal = AbortSignal.timeout(timeoutMs);
    this.requireGeneration(definition.id, user, generation);
    try {
      const token = definition.mode === "delegated"
        ? await abortable(this.probes.delegatedToken(user.homeAccountId, definition.id), signal)
        : await abortable(this.probes.applicationToken(definition.id), signal);
      this.requireGeneration(definition.id, user, generation);
      phase = "provider_read";
      timeoutMs = definition.id.startsWith("graph.package.read.") ? packageReadTimeoutMs : automaticCheckDeadlineMs;
      signal = AbortSignal.timeout(timeoutMs);
      if (definition.id.startsWith("graph.package.read.")) await abortable(this.probes.packageProbe(token, signal), signal);
      else if (definition.id === "graph.directory.read") await abortable(this.probes.directoryProbe(token, signal), signal);
      else if (definition.id === "powerPlatform.inventory.read") await abortable(this.probes.inventoryProbe(token, signal), signal);
    } catch (error) {
      this.requireGeneration(definition.id, user, generation);
      status = probeStatus(error);
      details = { ...safeProbeDetails(error), phase, timeoutMs, verification: defaultVerification(definition) };
    }
    this.requireGeneration(definition.id, user, generation);
    await this.mutate(async () => {
      this.requireGeneration(definition.id, user, generation);
      await this.repository.recordEvidence(key, status, details, evidenceTtlMs);
    });
    this.requireGeneration(definition.id, user, generation);
    const current = await this.decision(definition, user);
    this.requireGeneration(definition.id, user, generation);
    return current;
  }

  private async runAutomaticCheck(user: AuthenticatedUser, generation: number, retryFailed: boolean) {
    const eligible = capabilityDefinitions
      .filter(definition => automaticCapabilityIds.has(definition.id) && hasAnyRole(user.roles, definition.internalRoles))
      .map(definition => ({ definition, refreshGeneration: this.generation(definition.id, user) }));
    await Promise.all(eligible.map(async ({ definition, refreshGeneration }) => {
      const current = await this.decision(definition, user);
      const reuseFresh = current.fresh && current.verification !== "on_demand"
        && (!retryFailed || current.authorized || current.evidence?.category === "provider_throttled");
      if (reuseFresh || generation !== (this.generations.get(this.principalGenerationKey(user.tenantId!, user.homeAccountId)) ?? 0)) return;
      await this.refreshAtGeneration(definition, user, refreshGeneration);
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
    this.bump(this.principalGenerationKey(user.tenantId!, user.homeAccountId));
    await this.mutate(() => this.repository.invalidatePrincipal(user.tenantId!, user.homeAccountId));
  }

  private evidenceKey(definition: CapabilityDefinition, user: AuthenticatedUser, configuration: CapabilityConfiguration): EvidenceKey {
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

  private generation(capabilityId: CapabilityId, user: AuthenticatedUser) {
    return `${this.generations.get(this.principalGenerationKey(user.tenantId!, user.homeAccountId)) ?? 0}:${this.generations.get(this.capabilityGenerationKey(user.tenantId!, capabilityId)) ?? 0}`;
  }

  private requireGeneration(capabilityId: CapabilityId, user: AuthenticatedUser, generation: string) {
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
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export const capabilities = new CapabilityService();

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
    previewQualification, remediation: remediation(definition.id, status,
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

const evidenceCategories = new Set(["provider_error", "interaction_required", "authorization_expired", "missing_permission", "unsupported",
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
      : code && evidenceCategories.has(code) ? code
        : error instanceof AppError && (error.status === 429 || details.throttled === true) ? "provider_throttled" : "provider_error";
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

function remediation(capabilityId: CapabilityId, status: CapabilityStatus, category?: string) {
  if (category === "interaction_required") return ["Sign in again or complete delegated consent before retrying."];
  if (category === "authorization_expired") return ["Sign in again before retrying."];
  if (category === "authorization_not_yet_valid") return ["The Microsoft token is not yet valid. Check the application host clock and time synchronization before retrying; additional consent is not indicated."];
  if (category === "identity_provider_error") return ["Microsoft Entra ID could not complete valid token acquisition. Retry and use the sanitized error code and correlation ID for identity-provider troubleshooting; this does not establish missing consent."];
  if (category === "provider_timeout") return ["The bounded provider check timed out. Retry; a timeout does not establish missing permissions, roles, or licensing."];
  if (category === "provider_network_error") return ["The provider could not be reached. Check service connectivity and retry the bounded check without broadening consent."];
  if (category === "provider_throttled") return ["The provider throttled the bounded check. Wait before retrying without changing permissions."];
  if (category === "provider_schema" || category === "provider_result_limit") return ["The provider response did not satisfy the bounded adapter contract. Check the documented endpoint and sanitized diagnostics before retrying."];
  if (capabilityId.startsWith("purview.audit.search.")) {
    const auditValues: Partial<Record<CapabilityStatus, string[]>> = {
      missing_internal_role: ["Assign the AgentControl.Viewer role."],
      not_configured: ["Enable application mode and its shared data scope before approving an application qualification."],
      missing_permission: ["Grant only AuditLogsQuery.Read.All, then retry the bounded search."],
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
      missing_permission: ["Grant only ThreatHunting.Read.All, then retry the bounded investigation."],
      provider_error: ["Check Defender XDR RBAC/data-source scope, licensing, Agent 365 connectivity and table rollout separately, then retry the bounded investigation."],
      unsupported: ["Verify the Graph v1.0 hunting endpoint and AgentsInfo or CloudAppEvents rollout for this tenant."],
      unknown: ["Run the automatic delegated readiness check or submit one explicit bounded investigation."],
    };
    return huntingValues[status] ?? [];
  }
  const values: Partial<Record<CapabilityStatus, string[]>> = {
    missing_internal_role: ["Ask an administrator to assign the required Agent Control app role."],
    missing_permission: ["Grant consent for this capability using the signed-in account."],
    missing_role: ["Verify the documented provider role without broadening API consent."],
    missing_license: ["Verify the documented service license for the same account or application scope."],
    not_configured: ["Complete the listed configuration. An unregistered adapter remains unavailable until its documented contract and required safety controls are implemented."],
    provider_error: ["Retry the bounded probe; an ambiguous provider failure does not identify a missing role or license."],
    unsupported: ["Verify the documented cloud, endpoint, and resource support."],
    unknown: ["Run the automatic non-mutating readiness check after consent and configuration are complete."],
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