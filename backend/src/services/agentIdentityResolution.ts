import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { AgentIdentityRepository, type AgentIdentityFailure } from "../db/agentIdentity.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError, isTimeoutError } from "../errors.js";
import { hasAppRole } from "../types/capability.js";
import type { AuthenticatedUser } from "../types/session.js";
import { agentInvestigations } from "./agentInvestigations.js";
import { capabilities } from "./capabilities.js";
import { GraphAgentIdentityClient } from "./graphAgentIdentity.js";
import { requireProviderAdmissions } from "./operationalState.js";
import { verifiedAgentIdentityClientIdProvenance } from "../types/agentInvestigations.js";

type Dependencies = {
  inventory: Pick<typeof agentInvestigations, "resolve">;
  repository: Pick<AgentIdentityRepository, "save" | "invalidate" | "saveFailure">;
  directory: Pick<GraphAgentIdentityClient, "resolve">;
  revalidateUser: typeof revalidateAuthenticatedUser;
  delegatedToken: typeof acquireDelegatedToken;
  requireAvailable: typeof capabilities.requireAvailable;
  observeOperation: typeof capabilities.observeOperation;
  admissions: typeof requireProviderAdmissions;
};

export class AgentIdentityResolutionService {
  private readonly dependencies: Dependencies;
  private readonly active = new Set<string>();

  constructor(dependencies: Partial<Dependencies> = {}) {
    this.dependencies = { inventory: agentInvestigations, repository: new AgentIdentityRepository(),
      directory: new GraphAgentIdentityClient(), revalidateUser: revalidateAuthenticatedUser,
      delegatedToken: acquireDelegatedToken, requireAvailable: capabilities.requireAvailable.bind(capabilities),
      observeOperation: capabilities.observeOperation.bind(capabilities),
      admissions: requireProviderAdmissions, ...dependencies };
  }

  async resolve(user: AuthenticatedUser, recordId: string, abortSignal?: AbortSignal) {
    return this.dependencies.observeOperation("graph.agentIdentity.read", user,
      () => this.resolveCurrent(user, recordId, abortSignal), { signal: abortSignal });
  }

  private async resolveCurrent(user: AuthenticatedUser, recordId: string, abortSignal?: AbortSignal) {
    const scope = userScope(user);
    const key = `${scope.tenantId}\0${scope.principalId}`;
    if (this.active.has(key) || this.active.size >= 4) throw new AppError(429, "agent_identity_resolution_busy", "An identity resolution is already running. Retry after it completes.");
    const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(abortSignal ? [abortSignal] : [])]);
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    let recordFailure: ((failure: AgentIdentityFailure) => Promise<void>) | undefined;
    this.active.add(key);
    try {
      const initial = await this.dependencies.inventory.resolve(scope, recordId);
      const source = initial.identitySource;
      if (!source || !initial.inventoryRevision) throw new AppError(409, "agent_identity_resolution_unavailable", initial.context.defender.resolution?.reason
        ?? "This current source has no supported identity candidate.", { reasonCode: initial.context.defender.resolution?.reasonCode });
      const sameSource = async () => {
        signal.throwIfAborted();
        this.dependencies.admissions();
        const latest = await this.dependencies.inventory.resolve(scope, recordId);
        signal.throwIfAborted();
        if (latest.inventoryRevision !== initial.inventoryRevision || JSON.stringify(latest.identitySource) !== JSON.stringify(source)) {
          throw new AppError(409, "agent_identity_source_changed", "The saved agent, candidate or inventory revision changed during resolution. Refresh Agents.");
        }
        return latest;
      };
      const currentUser = async () => {
        signal.throwIfAborted();
        const fresh = await this.dependencies.revalidateUser(scope.principalId);
        signal.throwIfAborted();
        const current = userScope(fresh);
        if (current.tenantId !== scope.tenantId || current.principalId !== scope.principalId) {
          throw new AppError(403, "scope_mismatch", "The account or tenant changed during identity resolution.");
        }
        return fresh;
      };
      const fresh = await currentUser();
      const publicationFence = async () => {
        signal.throwIfAborted();
        assertAccountSessionValidation(validation);
        this.dependencies.admissions();
      };
      recordFailure = failure => commitAccountSessionValidation(validation, async () => {
        await sameSource();
        await this.dependencies.repository.saveFailure(scope, source, failure, publicationFence);
      });
      const token = await commitAccountSessionValidation(validation, async () => {
        await sameSource();
        await this.dependencies.requireAvailable("graph.agentIdentity.read", fresh);
        signal.throwIfAborted();
        return this.dependencies.delegatedToken(scope.principalId, "graph.agentIdentity.read");
      });
      await commitAccountSessionValidation(validation, async () => {
        await sameSource();
        await this.dependencies.repository.invalidate(scope, source);
      });
      const result = await this.dependencies.directory.resolve(token, source.candidateId, signal, async () => {
        const current = await currentUser();
        await commitAccountSessionValidation(validation, async () => {
          await this.dependencies.requireAvailable("graph.agentIdentity.read", current);
          await sameSource();
        });
      });
      const current = await currentUser();
      await commitAccountSessionValidation(validation, async () => {
        await this.dependencies.requireAvailable("graph.agentIdentity.read", current);
        await sameSource();
        await this.dependencies.repository.save(scope, source, result, publicationFence);
      });
      const final = await commitAccountSessionValidation(validation, sameSource);
      if (final.context.defender.entraAgentIds.length !== 1 || final.context.defender.entraAgentIds[0] !== result.objectId
        || final.context.defender.entraAgentApplicationIds?.length !== 1 || final.context.defender.entraAgentApplicationIds[0] !== result.applicationId
        || final.context.defender.resolution?.runtimeProvenance !== verifiedAgentIdentityClientIdProvenance) {
        throw new AppError(409, "agent_identity_source_changed", "The verified object and client-ID mapping is no longer current. Refresh Agents.");
      }
      return final.context;
    } catch (error) {
      const surfaced = isTimeoutError(error) || signal.aborted
        ? new AppError(504, "agent_identity_resolution_timeout", "Identity resolution was interrupted or exceeded its deadline. No unverified mapping is returned.")
        : error;
      const failure = resolutionFailure(surfaced);
      if (failure && recordFailure && !signal.aborted) await recordFailure(failure);
      throw surfaced;
    } finally { this.active.delete(key); }
  }
}

function resolutionFailure(error: unknown): AgentIdentityFailure | undefined {
  if (!(error instanceof AppError)) return { status: "provider_error", code: "agent_identity_resolution_failed" };
  if (["agent_identity_permission_required", "missing_permission", "consent_required", "interaction_required", "authorization_expired"].includes(error.code)) {
    return { status: "authorization_required", code: error.code };
  }
  if (error.code === "agent_identity_not_found") return { status: "not_found", code: error.code };
  if (error.code === "auth_not_configured") return { status: "setup_required", code: error.code };
  if (error.status === 429) return { status: "provider_error", code: "provider_throttled" };
  if (error.code === "capability_unavailable" && error.details && typeof error.details === "object" && "status" in error.details) {
    if (error.details.status === "missing_permission") return { status: "authorization_required", code: error.code };
    if (error.details.status === "not_configured") return { status: "setup_required", code: error.code };
  }
  if (error.status >= 500 || error.status === 429 || error.details && typeof error.details === "object" && "httpStatus" in error.details) {
    return { status: "provider_error", code: /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(error.code) ? error.code : "agent_identity_resolution_failed" };
  }
  return undefined;
}

export const agentIdentityResolution = new AgentIdentityResolutionService();

function userScope(user: AuthenticatedUser) {
  if (!user.tenantId || !user.homeAccountId || !hasAppRole(user.roles, "AgentControl.Viewer")) {
    throw new AppError(403, "missing_internal_role", "Identity resolution requires a tenant-scoped Viewer session.");
  }
  return { tenantId: user.tenantId, principalId: user.homeAccountId };
}
