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
    const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(abortSignal ? [abortSignal] : [])]);
    const scope = userScope(user);
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    try {
      const result = await awaitResolution(signal, () => this.dependencies.observeOperation("graph.agentIdentity.read", user,
        () => this.resolveCurrent(scope, recordId, signal, validation), { signal }));
      signal.throwIfAborted();
      assertAccountSessionValidation(validation);
      this.dependencies.admissions();
      return result;
    } catch (error) { throw resolutionError(error, signal); }
  }

  private async resolveCurrent(scope: ReturnType<typeof userScope>, recordId: string, signal: AbortSignal,
    validation: ReturnType<typeof beginAccountSessionValidation>) {
    const key = `${scope.tenantId}\0${scope.principalId}`;
    if (this.active.has(key) || this.active.size >= 4) throw new AppError(429, "agent_identity_resolution_busy", "An identity resolution is already running. Retry after it completes.");
    const assertCurrent = () => {
      signal.throwIfAborted();
      assertAccountSessionValidation(validation);
      this.dependencies.admissions();
    };
    const wait = <T>(operation: () => Promise<T>) => awaitResolution(signal, operation);
    const commit = <T>(operation: () => Promise<T>) => wait(() => commitAccountSessionValidation(validation, async () => {
      assertCurrent();
      // Keep writes serialized until their publication fences and transaction cleanup finish.
      const result = await operation();
      assertCurrent();
      return result;
    }));
    let recordFailure: ((failure: AgentIdentityFailure) => Promise<void>) | undefined;
    this.active.add(key);
    try {
      assertCurrent();
      const initial = await wait(() => this.dependencies.inventory.resolve(scope, recordId));
      assertCurrent();
      const source = initial.identitySource;
      if (!source || !initial.inventoryRevision) throw new AppError(409, "agent_identity_resolution_unavailable", initial.context.defender.resolution?.reason
        ?? "This current source has no supported identity candidate.", { reasonCode: initial.context.defender.resolution?.reasonCode });
      const sameSource = async () => {
        assertCurrent();
        const latest = await wait(() => this.dependencies.inventory.resolve(scope, recordId));
        assertCurrent();
        if (latest.inventoryRevision !== initial.inventoryRevision || JSON.stringify(latest.identitySource) !== JSON.stringify(source)) {
          throw new AppError(409, "agent_identity_source_changed", "The saved agent, candidate or inventory revision changed during resolution. Refresh Agents.");
        }
        return latest;
      };
      const currentUser = async () => {
        assertCurrent();
        const fresh = await wait(() => this.dependencies.revalidateUser(scope.principalId));
        assertCurrent();
        const current = userScope(fresh);
        if (current.tenantId !== scope.tenantId || current.principalId !== scope.principalId) {
          throw new AppError(403, "scope_mismatch", "The account or tenant changed during identity resolution.");
        }
        return fresh;
      };
      const fresh = await currentUser();
      const publicationFence = async () => { assertCurrent(); };
      recordFailure = failure => commit(async () => {
        await sameSource();
        await this.dependencies.repository.saveFailure(scope, source, failure, publicationFence);
      });
      const token = await commit(async () => {
        await sameSource();
        await wait(() => this.dependencies.requireAvailable("graph.agentIdentity.read", fresh));
        assertCurrent();
        return wait(() => this.dependencies.delegatedToken(scope.principalId, "graph.agentIdentity.read"));
      });
      await commit(async () => {
        await sameSource();
        await this.dependencies.repository.invalidate(scope, source);
      });
      const result = await wait(() => this.dependencies.directory.resolve(token, source.candidateId, signal, async () => {
        const current = await currentUser();
        await commit(async () => {
          await wait(() => this.dependencies.requireAvailable("graph.agentIdentity.read", current));
          await sameSource();
        });
        assertCurrent();
      }));
      const current = await currentUser();
      await commit(async () => {
        await wait(() => this.dependencies.requireAvailable("graph.agentIdentity.read", current));
        await sameSource();
        await this.dependencies.repository.save(scope, source, result, publicationFence);
      });
      const final = await commit(sameSource);
      assertCurrent();
      if (final.context.defender.entraAgentIds.length !== 1 || final.context.defender.entraAgentIds[0] !== result.objectId
        || final.context.defender.entraAgentApplicationIds?.length !== 1 || final.context.defender.entraAgentApplicationIds[0] !== result.applicationId
        || final.context.defender.resolution?.runtimeProvenance !== verifiedAgentIdentityClientIdProvenance) {
        throw new AppError(409, "agent_identity_source_changed", "The verified object and client-ID mapping is no longer current. Refresh Agents.");
      }
      return final.context;
    } catch (error) {
      const surfaced = resolutionError(error, signal);
      const failure = resolutionFailure(surfaced);
      if (failure && recordFailure && !signal.aborted) await recordFailure(failure);
      throw surfaced;
    } finally { this.active.delete(key); }
  }
}

async function awaitResolution<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const work = operation();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    work.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function resolutionError(error: unknown, signal: AbortSignal) {
  return isTimeoutError(error) || signal.aborted
    ? new AppError(504, "agent_identity_resolution_timeout", "Identity resolution was interrupted or exceeded its deadline. No unverified mapping is returned.")
    : error;
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
