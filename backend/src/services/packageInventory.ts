import { acquireApplicationToken, acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { config } from "../config.js";
import { PackageInventoryRepository, type PackageDataScope, type PackageRefreshInput, type PackageScanResult } from "../db/packageInventory.js";
import { beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { CapabilityId } from "../types/capability.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import type { AuthenticatedUser } from "../types/session.js";
import { capabilities } from "./capabilities.js";
import { GraphPackagesClient } from "./graphPackages.js";

type PackageRefreshDependencies = {
  delegatedToken: typeof acquireDelegatedToken;
  applicationToken: typeof acquireApplicationToken;
  revalidateUser: typeof revalidateAuthenticatedUser;
  requireAvailable: typeof capabilities.requireAvailable;
  requireApplicationDataScope: typeof capabilities.requireApplicationDataScope;
  scan: (token: string, requestedIds: readonly string[], signal: AbortSignal, onProgress: (pages: number, observedCount: number, totalRecords: number) => Promise<void>) => Promise<PackageScanResult>;
  applicationPrincipalId: () => string | undefined;
};

const graphPackages = new GraphPackagesClient();
const defaultDependencies: PackageRefreshDependencies = {
  delegatedToken: acquireDelegatedToken,
  applicationToken: acquireApplicationToken,
  revalidateUser: revalidateAuthenticatedUser,
  requireAvailable: capabilities.requireAvailable.bind(capabilities),
  requireApplicationDataScope: capabilities.requireApplicationDataScope.bind(capabilities),
  scan: scanPackages,
  applicationPrincipalId: () => config.clientId,
};

type RefreshInput = Omit<PackageRefreshInput, "authorizationPrincipalId">;
type ActiveRefresh = { actor: PackageDataScope; controller: AbortController; operation: Promise<void> };
const maximumActiveRefreshes = 4;
const refreshExecutionDeadlineMs = 45_000;

export class PackageInventoryService {
  private readonly active = new Map<string, ActiveRefresh>();
  private starting = 0;

  constructor(
    private readonly repository = new PackageInventoryRepository(),
    private readonly dependencies: PackageRefreshDependencies = defaultDependencies,
  ) {}

  async submit(user: AuthenticatedUser, input: RefreshInput) {
    requireRefreshRole(user, input.tokenMode, Boolean(input.requestedIds?.length));
    if (input.tokenMode === "application") await this.dependencies.requireApplicationDataScope("graph.package.read.application", user);
    const scope = dataScope(user, input.tokenMode, this.dependencies.applicationPrincipalId());
    return this.repository.submit(scope, { ...input, authorizationPrincipalId: user.homeAccountId });
  }

  async start(user: AuthenticatedUser, id: string, tokenMode: RefreshInput["tokenMode"]) {
    if (this.active.size + this.starting >= maximumActiveRefreshes) throw new AppError(429, "package_refresh_capacity", "At most four package refreshes can run at once.");
    this.starting += 1;
    const actor = actorScope(user);
    const scope = dataScope(user, tokenMode, this.dependencies.applicationPrincipalId());
    try {
      const current = await this.repository.getJob(scope, id);
      if (!current || current.authorizationPrincipalId !== user.homeAccountId) throw new AppError(404, "not_found", "Package refresh job was not found.");
      if (current.status !== "waiting_authorization") throw new AppError(409, "package_refresh_state", "Only a waiting package refresh can be started.");
      requireRefreshRole(user, tokenMode, current.scopeKind === "exact");
      const validation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
      const freshUser = await this.dependencies.revalidateUser(actor.principalId);
      let token = "";
      await commitAccountSessionValidation(validation, async () => {
        requireSamePrincipal(actor, freshUser);
        requireRefreshRole(freshUser, tokenMode, current.scopeKind === "exact");
        const capabilityId = capabilityForMode(tokenMode);
        if (tokenMode === "application") await this.dependencies.requireApplicationDataScope(capabilityId, freshUser);
        await this.dependencies.requireAvailable(capabilityId, freshUser);
        token = tokenMode === "delegated"
          ? await this.dependencies.delegatedToken(actor.principalId, capabilityId)
          : await this.dependencies.applicationToken(capabilityId);
        if (!await this.repository.markRunning(scope, id)) throw new AppError(409, "package_refresh_state", "Package refresh was already started or expired.");
      });
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(refreshExecutionDeadlineMs)]);
      const operation = this.run(actor, scope, current, id, token, signal)
        .finally(() => { if (this.active.get(id)?.operation === operation) this.active.delete(id); });
      this.active.set(id, { actor, controller, operation });
      return (await this.repository.getJob(scope, id))!;
    } finally {
      this.starting -= 1;
    }
  }

  async get(user: AuthenticatedUser, id: string, tokenMode: RefreshInput["tokenMode"]) {
    const job = await this.repository.getJob(dataScope(user, tokenMode, this.dependencies.applicationPrincipalId()), id);
    if (!job || job.authorizationPrincipalId !== user.homeAccountId) throw new AppError(404, "not_found", "Package refresh job was not found.");
    return job;
  }

  recover() {
    return this.repository.recoverInterrupted();
  }

  async drain() {
    const active = [...this.active.values()];
    for (const refresh of active) refresh.controller.abort(new AppError(401, "interaction_required", "Application shutdown requires explicit package refresh authorization."));
    const results = await Promise.allSettled(active.map(refresh => refresh.operation));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  async waitForPrincipalAuthorization(scope: PackageDataScope) {
    for (const refresh of this.active.values()) {
      if (refresh.actor.tenantId === scope.tenantId && refresh.actor.principalId === scope.principalId) {
        refresh.controller.abort(new AppError(401, "interaction_required", "The signed-in account changed during package refresh."));
      }
    }
  }

  private async run(actor: PackageDataScope, scope: PackageDataScope, current: Awaited<ReturnType<PackageInventoryRepository["getJob"]>> & {}, id: string, token: string, signal: AbortSignal) {
    try {
      const result = await this.dependencies.scan(token, current.requestedIds, signal, (pages, observedCount, totalRecords) => this.repository.recordProgress(scope, id, pages, observedCount, totalRecords));
      signal.throwIfAborted();
      const validation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
      const freshUser = await this.dependencies.revalidateUser(actor.principalId);
      signal.throwIfAborted();
      await commitAccountSessionValidation(validation, async () => {
        signal.throwIfAborted();
        requireSamePrincipal(actor, freshUser);
        requireRefreshRole(freshUser, current.tokenMode, current.scopeKind === "exact");
        const capabilityId = capabilityForMode(current.tokenMode);
        if (current.tokenMode === "application") await this.dependencies.requireApplicationDataScope(capabilityId, freshUser);
        await this.dependencies.requireAvailable(capabilityId, freshUser);
        signal.throwIfAborted();
        await this.repository.publish(scope, id, result);
      });
    } catch (error) {
      if (isAuthorizationFailure(error)) {
        await this.repository.markWaitingAuthorization(scope, id);
        return;
      }
      await this.repository.markFailed(scope, id, error instanceof AppError ? error.code : "provider_error", safeFailureMessage(error));
    }
  }
}

export const packageInventory = new PackageInventoryService();

async function scanPackages(token: string, requestedIds: readonly string[], signal: AbortSignal, onProgress: (pages: number, observedCount: number, totalRecords: number) => Promise<void>): Promise<PackageScanResult> {
  if (!requestedIds.length) {
    let pages = 0;
    const packages = await graphPackages.listCopilotAgents(token, {
      signal,
      onProgress: async progress => {
        pages = progress.pages;
        await onProgress(progress.pages, progress.observedCount, progress.observedCount);
      },
    });
    return { packages, totalRecords: packages.length, pages: Math.max(1, pages) };
  }
  if (requestedIds.length > 100) throw new AppError(400, "invalid_targets", "An exact package refresh accepts at most 100 native IDs.");
  const packages: CopilotPackageDetail[] = [];
  let completed = 0;
  for (const id of requestedIds) {
    signal.throwIfAborted();
    try {
      packages.push(await graphPackages.getPackageDetails(token, id, { signal }));
    } catch (error) {
      if (!(error instanceof AppError && error.status === 404)) throw error;
    }
    completed += 1;
    await onProgress(completed, packages.length, packages.length);
  }
  return { packages, totalRecords: packages.length, pages: Math.max(1, completed) };
}

function capabilityForMode(mode: RefreshInput["tokenMode"]): CapabilityId {
  return mode === "delegated" ? "graph.package.read.delegated" : "graph.package.read.application";
}

function dataScope(user: AuthenticatedUser, mode: RefreshInput["tokenMode"], applicationPrincipalId: string | undefined): PackageDataScope {
  if (!user.tenantId) throw AppError.unauthorized("The current session does not have a tenant scope.");
  if (mode === "application" && !applicationPrincipalId) throw new AppError(503, "not_configured", "Application package reads require configured tenant and client identity.");
  return { tenantId: user.tenantId, principalId: mode === "application" ? applicationPrincipalId! : user.homeAccountId };
}

function actorScope(user: AuthenticatedUser): PackageDataScope {
  if (!user.tenantId) throw AppError.unauthorized("The current session does not have a tenant scope.");
  return { tenantId: user.tenantId, principalId: user.homeAccountId };
}

function requireRefreshRole(user: AuthenticatedUser, mode: RefreshInput["tokenMode"], exact: boolean) {
  const allowed = mode === "delegated" && exact
    ? user.roles.includes("AgentControl.Reader") || user.roles.includes("AgentControl.Operator")
    : user.roles.includes("AgentControl.Reader");
  if (!allowed) throw new AppError(403, "missing_internal_role", exact ? "Exact package refresh requires Reader or Operator." : "Broad package refresh requires Reader.");
}

function requireSamePrincipal(scope: PackageDataScope, user: AuthenticatedUser) {
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The signed-in account changed during package refresh.");
}

function isAuthorizationFailure(error: unknown) {
  return error instanceof AppError && (error.status === 401 || error.status === 403 || ["interaction_required", "authorization_expired", "missing_internal_role", "missing_permission", "capability_unavailable", "not_configured"].includes(error.code));
}

function safeFailureMessage(error: unknown) {
  if (error instanceof AppError && ["provider_error", "provider_schema", "provider_result_limit", "invalid_provider_link", "incomplete_package_coverage", "package_scope_mismatch"].includes(error.code)) return error.message.slice(0, 1024);
  return "Package refresh failed before complete publication.";
}