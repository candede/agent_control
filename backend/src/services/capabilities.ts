import type { AuthenticatedUser } from "../types/session.js";
import type { CapabilityDecision, CapabilityDefinition, CapabilityId, CapabilityStatus } from "../types/capability.js";
import { AppError } from "../errors.js";
import { config } from "../config.js";
import { acquireApplicationToken, acquireDelegatedToken } from "../auth/msal.js";
import { CapabilityRepository, capabilityContractRevision, capabilityPermissionRevision, type CapabilityConfiguration, type CapabilityEvidence, type EvidenceKey } from "../db/capabilities.js";
import { PackageMutationQualificationRepository } from "../db/packageMutationQualifications.js";
import { capabilityDefinitions, getCapabilityDefinition, hasAnyRole } from "./capabilityRegistry.js";
import { DirectoryPrincipalsClient } from "./directoryPrincipals.js";
import { GraphPackagesClient } from "./graphPackages.js";
import { quarantineProviderRoleAuthorized } from "./inventoryRoleScope.js";
import { PowerPlatformResourceQueryClient } from "./powerPlatformResourceQuery.js";
import { packageMutationOperationSafe } from "./packageMutationSafety.js";
import type { AuditAction } from "../types/audit.js";

const evidenceTtlMs = 5 * 60 * 1000;

type ProbeDependencies = {
  delegatedToken: typeof acquireDelegatedToken;
  applicationToken: typeof acquireApplicationToken;
  packageProbe: (token: string) => Promise<unknown>;
  directoryProbe: (token: string) => Promise<unknown>;
  inventoryProbe: (token: string) => Promise<unknown>;
};

const defaultProbeDependencies: ProbeDependencies = {
  delegatedToken: acquireDelegatedToken,
  applicationToken: acquireApplicationToken,
  packageProbe: token => new GraphPackagesClient().listCopilotAgents(token),
  directoryProbe: token => new DirectoryPrincipalsClient().search(token, "agent-control-permission-probe", 1),
  inventoryProbe: token => new PowerPlatformResourceQueryClient().query(token, ["microsoft.powerplatform/environments"]),
};

export class CapabilityService {
  private readonly inFlight = new Map<string, Promise<CapabilityDecision>>();
  private readonly generations = new Map<string, number>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly repository = new CapabilityRepository(), private readonly probes: ProbeDependencies = defaultProbeDependencies, private readonly qualifications = new PackageMutationQualificationRepository()) {}

  async list(user: AuthenticatedUser) {
    return Promise.all(capabilityDefinitions.map(async definition => ({ definition, decision: await this.decision(definition, user) })));
  }

  async decision(capability: CapabilityId | CapabilityDefinition, user: AuthenticatedUser): Promise<CapabilityDecision> {
    const definition = typeof capability === "string" ? requiredDefinition(capability) : capability;
    if (!hasAnyRole(user.roles, definition.internalRoles)) return decision(definition.id, "missing_internal_role", undefined, definition.maturity === "preview" ? "unqualified" : "not_required");
    if (definition.id === "powerPlatform.quarantine.manage" && !quarantineProviderRoleAuthorized(user)) return decision(definition.id, "missing_role", undefined, "unqualified");
    if (definition.mode === "local") return decision(definition.id, "available", undefined, "not_required");
    if (!definition.probe.adapterRegistered) return decision(definition.id, "not_configured", undefined, definition.maturity === "preview" ? "unqualified" : "not_required");
    const configuration = await this.repository.configuration(user.tenantId!, definition.id);
    if (definition.mode === "application" && (!configuration.enabled || !configuration.sharedDataScope)) {
      return decision(definition.id, "not_configured", undefined, previewState(definition, configuration));
    }
    if (definition.probe.kind === "qualification_only") {
      if (definition.id === "graph.package.access.manage" && (!packageMutationOperationSafe("update-availability") || !packageMutationOperationSafe("update-installation"))) {
        return decision(definition.id, "preview_disabled", undefined, "unqualified");
      }
      const qualified = await this.packagePreviewQualified(definition, user.tenantId!, configuration.revision);
      return qualified ? decision(definition.id, "available", undefined, "qualified") : decision(definition.id, "preview_disabled", undefined, "unqualified");
    }
    const evidence = await this.repository.evidence(this.evidenceKey(definition, user, configuration));
    if (!evidence || Date.parse(evidence.expiresAt) <= Date.now()) return decision(definition.id, "unknown", evidence, previewState(definition, configuration));
    return decision(definition.id, evidence.status, evidence, previewState(definition, configuration));
  }

  async requireAvailable(capabilityId: CapabilityId, user: AuthenticatedUser) {
    const current = await this.decision(capabilityId, user);
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
    if (!user.tenantId || !hasAnyRole(user.roles, definition.internalRoles)) throw new AppError(403, "missing_internal_role", "Audit Search qualification requires the SecurityReader role.");
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
      if (generation === this.generation(definition.id, user)) await this.repository.recordEvidence(key, status, safeEvidenceDetails(details), evidenceTtlMs);
    });
    return this.decision(definition, user);
  }

  async huntingQualificationContext(capabilityId: "defender.hunting.delegated" | "defender.hunting.application", user: AuthenticatedUser) {
    const definition = requiredDefinition(capabilityId);
    if (!user.tenantId || !hasAnyRole(user.roles, definition.internalRoles)) throw new AppError(403, "missing_internal_role", "Hunting qualification requires the SecurityReader role.");
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
      if (generation === this.generation(definition.id, user)) await this.repository.recordEvidence(key, status, safeEvidenceDetails(details), evidenceTtlMs);
    });
    return this.decision(definition, user);
  }

  async packageQualificationIdentity(action: AuditAction, user: AuthenticatedUser) {
    if (!user.tenantId) throw AppError.unauthorized("Package qualification requires a tenant scope.");
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
    if (!user.tenantId || !hasAnyRole(user.roles, definition.internalRoles)) throw new AppError(403, "missing_internal_role", "Quarantine control requires the Operator role.");
    if (!quarantineProviderRoleAuthorized(user)) throw new AppError(403, "missing_role", "Quarantine control requires Global Administrator, AI Administrator, or Power Platform Administrator.");
    const configuration = await this.repository.configuration(user.tenantId, definition.id);
    return { contractRevision: capabilityContractRevision(definition), permissionRevision: capabilityPermissionRevision(definition), configurationRevision: configuration.revision };
  }

  async quarantineApprovalAuthorityContext(user: AuthenticatedUser) {
    const definition = requiredDefinition("powerPlatform.quarantine.manage");
    if (!user.tenantId || !user.roles.includes("AgentControl.Administrator")) throw new AppError(403, "missing_internal_role", "Administrator is required to approve quarantine canaries.");
    const configuration = await this.repository.configuration(user.tenantId, definition.id);
    return { contractRevision: capabilityContractRevision(definition), permissionRevision: capabilityPermissionRevision(definition), configurationRevision: configuration.revision };
  }

  async refresh(capabilityId: CapabilityId, user: AuthenticatedUser) {
    const definition = requiredDefinition(capabilityId);
    if (!hasAnyRole(user.roles, definition.internalRoles)) return this.decision(definition, user);
    if (definition.id === "powerPlatform.quarantine.manage" && !quarantineProviderRoleAuthorized(user)) return this.decision(definition, user);
    if (definition.mode === "local" || !definition.probe.adapterRegistered || definition.probe.kind !== "provider_read") return this.decision(definition, user);
    const configuration = await this.repository.configuration(user.tenantId!, definition.id);
    if (definition.mode === "application" && (!configuration.enabled || !configuration.sharedDataScope)) return this.decision(definition, user);
    const key = this.evidenceKey(definition, user, configuration);
    const generation = this.generation(definition.id, user);
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
    let details: Record<string, unknown> = { contract: definition.probe.description };
    try {
      const token = definition.mode === "delegated"
        ? await this.probes.delegatedToken(user.homeAccountId, definition.id)
        : await this.probes.applicationToken(definition.id);
      if (definition.id.startsWith("graph.package.read.")) await this.probes.packageProbe(token);
      else if (definition.id === "graph.directory.read") await this.probes.directoryProbe(token);
      else if (definition.id === "powerPlatform.inventory.read") await this.probes.inventoryProbe(token);
    } catch (error) {
      status = probeStatus(error);
      details = safeProbeDetails(error);
    }
    await this.mutate(async () => {
      if (generation === this.generation(definition.id, user)) await this.repository.recordEvidence(key, status, details, evidenceTtlMs);
    });
    return this.decision(definition, user);
  }

  async configureApplication(capabilityId: CapabilityId, user: AuthenticatedUser, enabled: boolean, sharedDataScope: boolean) {
    const definition = requiredDefinition(capabilityId);
    if (!user.roles.includes("AgentControl.Administrator")) throw new AppError(403, "missing_internal_role", "Administrator role is required.");
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

  private async packagePreviewQualified(definition: CapabilityDefinition, tenantId: string, configurationRevision: number) {
    const actions = definition.id === "graph.package.block.manage" ? ["block", "unblock"] as const
      : definition.id === "graph.package.access.manage" ? ["update-availability", "update-installation"] as const
        : [];
    if (!actions.length) return false;
    const revision = capabilityContractRevision(definition);
    const records = await Promise.all(actions.map(action => this.qualifications.current(tenantId, action, revision, configurationRevision)));
    return records.every(Boolean);
  }

  private generation(capabilityId: CapabilityId, user: AuthenticatedUser) {
    return `${this.generations.get(this.principalGenerationKey(user.tenantId!, user.homeAccountId)) ?? 0}:${this.generations.get(this.capabilityGenerationKey(user.tenantId!, capabilityId)) ?? 0}`;
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

function decision(capabilityId: CapabilityId, status: CapabilityStatus, evidence: CapabilityEvidence | undefined, previewQualification: CapabilityDecision["previewQualification"]): CapabilityDecision {
  return {
    capabilityId, status, authorized: status === "available", fresh: Boolean(evidence && Date.parse(evidence.expiresAt) > Date.now()),
    checkedAt: evidence?.observedAt, expiresAt: evidence?.expiresAt, lastSuccessAt: evidence?.lastSuccessAt,
    evidence: evidence ? safeEvidenceView(evidence.details) : undefined,
    previewQualification, remediation: remediation(capabilityId, status),
  };
}

function safeEvidenceView(details: Record<string, unknown>): CapabilityDecision["evidence"] {
  const categories = ["provider_error", "interaction_required", "authorization_expired", "missing_permission", "unsupported"];
  return {
    ...(typeof details.category === "string" && categories.includes(details.category) ? { category: details.category } : {}),
    ...(typeof details.correlationId === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(details.correlationId) ? { correlationId: details.correlationId } : {}),
  };
}

function previewState(definition: CapabilityDefinition, configuration: CapabilityConfiguration): CapabilityDecision["previewQualification"] {
  return definition.maturity !== "preview" ? "not_required" : configuration.previewQualified ? "qualified" : "unqualified";
}

function probeStatus(error: unknown): CapabilityStatus {
  if (error instanceof AppError) {
    if (["interaction_required", "authorization_expired", "missing_permission"].includes(error.code)) return "missing_permission";
    if (error.status === 404 || error.code === "unsupported") return "unsupported";
    if (error.status === 401 || error.status === 403) return "provider_error";
  }
  return "provider_error";
}

function safeProbeDetails(error: unknown) {
  const code = error instanceof AppError ? error.code : "provider_error";
  const correlationId = (error as { correlationId?: unknown })?.correlationId;
  return { category: code, ...(typeof correlationId === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(correlationId) ? { correlationId } : {}) };
}

function safeEvidenceDetails(details: Record<string, unknown>) {
  return {
    ...(typeof details.category === "string" ? { category: details.category.slice(0, 128) } : {}),
    ...(typeof details.correlationId === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(details.correlationId) ? { correlationId: details.correlationId } : {}),
  };
}

function remediation(capabilityId: CapabilityId, status: CapabilityStatus) {
  if (capabilityId.startsWith("purview.audit.search.")) {
    const auditValues: Partial<Record<CapabilityStatus, string[]>> = {
      missing_internal_role: ["Assign the AgentControl.SecurityReader role. Qualification approval also requires AgentControl.Administrator."],
      not_configured: ["Enable application mode and its shared data scope before approving an application qualification."],
      missing_permission: ["Grant only AuditLogsQuery.Read.All, then rerun one explicitly approved narrow qualification."],
      provider_error: ["Verify Purview Audit entitlement, unified auditing, and Audit Logs or View-Only Audit Logs role for delegated use, then approve a new qualification."],
      unsupported: ["Verify tenant rollout for the selected Microsoft Graph v1.0 Audit Search lifecycle."],
      unknown: ["Approve and run one narrow create, poll, and records qualification. Routine capability refresh never creates a query."],
    };
    return auditValues[status] ?? [];
  }
  if (capabilityId.startsWith("defender.hunting.")) {
    const huntingValues: Partial<Record<CapabilityStatus, string[]>> = {
      missing_internal_role: ["Assign AgentControl.SecurityReader. Qualification approval also requires AgentControl.Administrator."],
      not_configured: ["Enable application mode and approve its shared data scope before application qualification."],
      missing_permission: ["Grant only ThreatHunting.Read.All, then approve one narrow fixed-template qualification."],
      provider_error: ["Check Defender XDR RBAC/data-source scope, licensing, Agent 365 connectivity and table rollout separately, then approve a new bounded qualification."],
      unsupported: ["Verify the Graph v1.0 hunting endpoint and AgentsInfo or CloudAppEvents rollout for this tenant."],
      unknown: ["Approve and run one narrow fixed-template qualification. Routine capability refresh never sends hunting queries."],
    };
    return huntingValues[status] ?? [];
  }
  const values: Partial<Record<CapabilityStatus, string[]>> = {
    missing_internal_role: ["Ask an administrator to assign the required Agent Control app role."],
    missing_permission: ["Grant consent for this capability using the signed-in account."],
    missing_role: ["Verify the documented provider role without broadening API consent."],
    missing_license: ["Verify the documented service license for the same account or application scope."],
    not_configured: ["Complete the listed configuration or wait for the owning integration phase to register its adapter."],
    preview_disabled: ["Keep this preview operation disabled until its separate read/write canary is qualified."],
    provider_error: ["Retry the bounded probe; an ambiguous provider failure does not identify a missing role or license."],
    unsupported: ["Verify the documented cloud, endpoint, and resource support."],
    unknown: ["Run an explicit non-mutating probe after consent and configuration are complete."],
  };
  return values[status] ?? [];
}