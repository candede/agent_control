import { acquireApplicationToken, acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { config } from "../config.js";
import { PackageInventoryRepository, type PackageDataScope, type PackageRefreshInput, type PackageScanResult } from "../db/packageInventory.js";
import { beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import { hasAppRole, type CapabilityId } from "../types/capability.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import type { AuthenticatedUser } from "../types/session.js";
import { capabilities } from "./capabilities.js";
import { GraphPackagesClient, graphErrorTelemetry, graphResponseDiagnostics, packageInventoryReadPolicy } from "./graphPackages.js";
import { createRefreshExecutionSignal, type RefreshCancellationReason } from "./refreshExecution.js";
import { operationalLog, withTelemetryContext } from "./telemetry.js";

type PackageRefreshProgress = (pages: number, observedCount: number, totalRecords: number, message?: string) => Promise<void>;

type PackageRefreshDependencies = {
  delegatedToken: typeof acquireDelegatedToken;
  applicationToken: typeof acquireApplicationToken;
  revalidateUser: typeof revalidateAuthenticatedUser;
  requireAvailable: typeof capabilities.requireAvailable;
  requireApplicationDataScope: typeof capabilities.requireApplicationDataScope;
  scan: (token: string, requestedIds: readonly string[], signal: AbortSignal, onProgress: PackageRefreshProgress) => Promise<PackageScanResult>;
  applicationPrincipalId: () => string | undefined;
};

const graphPackages = new GraphPackagesClient(fetch, packageInventoryReadPolicy);
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
type StartingRefresh = Omit<ActiveRefresh, "operation"> & {
  operation: Promise<NonNullable<Awaited<ReturnType<PackageInventoryRepository["getJob"]>>>>;
};
const maximumActiveRefreshes = 4;
const refreshExecutionDeadlineMs = 45_000;
const identityRefreshExecutionDeadlineMs = 120_000;
const completeInventoryExecutionDeadlineMs = 15 * 60_000;
const exactReadConcurrency = 4;

export class PackageInventoryService {
  private readonly active = new Map<string, ActiveRefresh>();
  private readonly starting = new Map<string, StartingRefresh>();
  private draining = false;

  constructor(
    private readonly repository = new PackageInventoryRepository(),
    private readonly dependencies: PackageRefreshDependencies = defaultDependencies,
  ) {}

  async submit(user: AuthenticatedUser, input: RefreshInput) {
    requireRefreshRole(user);
    if (input.tokenMode === "application") await this.dependencies.requireApplicationDataScope("graph.package.read.application", user);
    const scope = dataScope(user, input.tokenMode, this.dependencies.applicationPrincipalId());
    return this.repository.submit(scope, { ...input, authorizationPrincipalId: user.homeAccountId });
  }

  async start(user: AuthenticatedUser, id: string, tokenMode: RefreshInput["tokenMode"], options: { retryFailed?: boolean } = {}) {
    const actor = actorScope(user);
    const scope = dataScope(user, tokenMode, this.dependencies.applicationPrincipalId());
    id = id.toLowerCase();
    if (this.draining) throw new AppError(503, "package_refresh_shutdown", "Package refreshes are stopping for application shutdown.");
    const reserved = this.active.get(id) ?? this.starting.get(id);
    if (reserved) {
      if (reserved.actor.tenantId !== actor.tenantId || reserved.actor.principalId !== actor.principalId) {
        throw new AppError(404, "not_found", "Package refresh job was not found.");
      }
      throw new AppError(409, "package_refresh_state", "Package refresh is already starting or running.");
    }
    if (new Set([...this.active.keys(), ...this.starting.keys()]).size >= maximumActiveRefreshes) {
      throw new AppError(429, "package_refresh_capacity", "At most four package refreshes can run at once.");
    }
    const controller = new AbortController();
    const starting: StartingRefresh = {
      actor, controller,
      operation: Promise.resolve().then(() => this.startRefresh(user, actor, scope, id, tokenMode, controller, options))
        .finally(() => { if (this.starting.get(id) === starting) this.starting.delete(id); }),
    };
    this.starting.set(id, starting);
    return starting.operation;
  }

  private async startRefresh(user: AuthenticatedUser, actor: PackageDataScope, scope: PackageDataScope, id: string, tokenMode: RefreshInput["tokenMode"], controller: AbortController, options: { retryFailed?: boolean }) {
    const signal = controller.signal;
    signal.throwIfAborted();
    const current = await this.repository.getJob(scope, id);
    signal.throwIfAborted();
    if (!current || current.authorizationPrincipalId !== user.homeAccountId) throw new AppError(404, "not_found", "Package refresh job was not found.");
    if (current.status !== "waiting_authorization") throw new AppError(409, "package_refresh_state", "Only a waiting package refresh can be started.");
    requireRefreshRole(user);
    let token = "";
    let markedRunning = false;
    try {
      const validation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
      const freshUser = await this.dependencies.revalidateUser(actor.principalId);
      signal.throwIfAborted();
      await commitAccountSessionValidation(validation, async () => {
        signal.throwIfAborted();
        requireSamePrincipal(actor, freshUser);
        requireRefreshRole(freshUser);
        const capabilityId = capabilityForMode(tokenMode);
        if (tokenMode === "application") await this.dependencies.requireApplicationDataScope(capabilityId, freshUser);
        signal.throwIfAborted();
        await this.dependencies.requireAvailable(capabilityId, freshUser, options);
        signal.throwIfAborted();
        token = tokenMode === "delegated"
          ? await this.dependencies.delegatedToken(actor.principalId, capabilityId)
          : await this.dependencies.applicationToken(capabilityId);
        signal.throwIfAborted();
        markedRunning = await this.repository.markRunning(scope, id);
        if (!markedRunning) throw new AppError(409, "package_refresh_state", "Package refresh was already started or expired.");
      });
      signal.throwIfAborted();
    } catch (error) {
      if (markedRunning && signal.aborted) {
        if (signal.reason instanceof AppError && signal.reason.code === "read_job_cancelled") {
          await this.repository.cancel(scope, id, actor.principalId);
        } else {
          await this.repository.markWaitingAuthorization(scope, id);
        }
      }
      throw error;
    }
    const executionDeadlineMs = current.requestedIds.length === 0 ? completeInventoryExecutionDeadlineMs
      : current.requestedIds.length > 1 ? identityRefreshExecutionDeadlineMs : refreshExecutionDeadlineMs;
    const execution = createRefreshExecutionSignal(signal, executionDeadlineMs);
    const operation = withTelemetryContext({ jobId: id }, () => this.run(actor, scope, current, id, token, execution.signal))
      .finally(() => {
        execution.dispose();
        if (this.active.get(id)?.operation === operation) this.active.delete(id);
      });
    this.active.set(id, { actor, controller, operation });
    void operation.catch(error => {
      operationalLog("error", "package_refresh_status_failed", { jobId: id, ...graphErrorTelemetry(error) });
    });
    return (await this.repository.getJob(scope, id))!;
  }

  async get(user: AuthenticatedUser, id: string, tokenMode: RefreshInput["tokenMode"]) {
    const job = await this.repository.getJob(dataScope(user, tokenMode, this.dependencies.applicationPrincipalId()), id);
    if (!job || job.authorizationPrincipalId !== user.homeAccountId) throw new AppError(404, "not_found", "Package refresh job was not found.");
    return job;
  }

  async cancel(user: AuthenticatedUser, id: string, tokenMode: RefreshInput["tokenMode"], cancellationReason: RefreshCancellationReason = "requested") {
    requireRefreshRole(user);
    const scope = dataScope(user, tokenMode, this.dependencies.applicationPrincipalId());
    id = id.toLowerCase();
    const job = await this.repository.getJob(scope, id);
    if (!job || job.authorizationPrincipalId !== user.homeAccountId) throw new AppError(404, "not_found", "Package refresh job was not found.");
    const cancelled = await this.repository.cancel(scope, id, user.homeAccountId, cancellationReason);
    const reason = new AppError(409, "read_job_cancelled", "Package refresh was cancelled.");
    this.starting.get(id)?.controller.abort(reason);
    this.active.get(id)?.controller.abort(reason);
    return cancelled!;
  }

  recover() {
    return this.repository.recoverInterrupted();
  }

  async drain() {
    this.draining = true;
    const refreshes = [...this.starting.values(), ...this.active.values()];
    const reason = new AppError(401, "interaction_required", "Application shutdown requires explicit package refresh authorization.");
    for (const refresh of refreshes) refresh.controller.abort(reason);
    const results = await Promise.allSettled(refreshes.map(refresh => refresh.operation));
    const failure = results.find((result, index) => result.status === "rejected"
      && result.reason !== refreshes[index].controller.signal.reason);
    if (failure?.status === "rejected") throw failure.reason;
  }

  async waitForPrincipalAuthorization(scope: PackageDataScope) {
    for (const refresh of [...this.starting.values(), ...this.active.values()]) {
      if (refresh.actor.tenantId === scope.tenantId && refresh.actor.principalId === scope.principalId) {
        refresh.controller.abort(new AppError(401, "interaction_required", "The signed-in account changed during package refresh."));
      }
    }
  }

  private async run(actor: PackageDataScope, scope: PackageDataScope, current: Awaited<ReturnType<PackageInventoryRepository["getJob"]>> & {}, id: string, token: string, signal: AbortSignal) {
    const startedAt = performance.now();
    let stage = "inventory_collection";
    try {
      operationalLog("info", "package_refresh_started", { mode: current.scopeKind });
      const result = await this.dependencies.scan(token, current.requestedIds, signal,
        (pages, observedCount, totalRecords, message) => this.repository.recordProgress(scope, id, pages, observedCount, totalRecords, message));
      signal.throwIfAborted();
      stage = "publication_authorization";
      const validation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
      const freshUser = await this.dependencies.revalidateUser(actor.principalId);
      signal.throwIfAborted();
      await commitAccountSessionValidation(validation, async () => {
        signal.throwIfAborted();
        requireSamePrincipal(actor, freshUser);
        requireRefreshRole(freshUser);
        const capabilityId = capabilityForMode(current.tokenMode);
        if (current.tokenMode === "application") await this.dependencies.requireApplicationDataScope(capabilityId, freshUser);
        await this.dependencies.requireAvailable(capabilityId, freshUser);
        signal.throwIfAborted();
        stage = "publication";
        await this.repository.publish(scope, id, result);
      });
      operationalLog("info", "package_refresh_succeeded", {
        status: "succeeded", count: result.packages.length, pages: result.pages,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      const failure = signal.aborted ? signal.reason : error;
      operationalLog("warn", "package_refresh_execution_failed", {
        stage, ...graphErrorTelemetry(failure), durationMs: Math.round(performance.now() - startedAt),
      });
      if (failure instanceof AppError && failure.code === "read_job_cancelled") {
        await this.repository.cancel(scope, id, actor.principalId);
        return;
      }
      if (isAuthorizationFailure(failure)) {
        await this.repository.markWaitingAuthorization(scope, id);
        return;
      }
      const timedOut = signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError";
      const diagnostics = graphResponseDiagnostics(failure);
      const code = timedOut ? "package_refresh_timeout" : diagnostics ? `graph_http_${diagnostics.status}`
        : failure instanceof AppError ? failure.code : "provider_error";
      await this.repository.markFailed(scope, id, code,
        timedOut ? "Agent identity collection reached its bounded execution deadline. The previous complete inventory is unchanged; retry from Sync." : safeFailureMessage(failure));
      operationalLog("error", "package_refresh_failed", { stage, ...graphErrorTelemetry(failure), errorCode: code });
    }
  }
}

export const packageInventory = new PackageInventoryService();

export async function scanPackages(
  token: string,
  requestedIds: readonly string[],
  signal: AbortSignal,
  onProgress: PackageRefreshProgress,
  client: Pick<GraphPackagesClient, "listCopilotAgents" | "getPackageDetails"> = graphPackages,
): Promise<PackageScanResult> {
  const broad = requestedIds.length === 0;
  let listPages = 0;
  let ids = requestedIds;
  const summaries = new Map<string, CopilotPackageDetail>();
  if (broad) {
    const listed = await client.listCopilotAgents(token, {
      signal,
      onProgress: async progress => {
        listPages = progress.pages;
        await onProgress(progress.pages, progress.observedCount, progress.observedCount, "Reading the agent list before identity collection.");
      },
    });
    for (const value of listed) {
      if (summaries.has(value.id)) throw new AppError(502, "provider_schema", "The package list contains duplicate native identities.");
      summaries.set(value.id, value);
    }
    ids = [...summaries.keys()];
    await onProgress(Math.max(1, listPages), 0, ids.length, `Matching agent records (0/${ids.length} identities checked).`);
  }
  if (!broad && ids.length > 100) throw new AppError(400, "invalid_targets", "An exact package refresh accepts at most 100 native IDs.");
  const packages: CopilotPackageDetail[] = [];
  let completed = 0;
  for (let offset = 0; offset < ids.length; offset += exactReadConcurrency) {
    signal.throwIfAborted();
    const batch = ids.slice(offset, offset + exactReadConcurrency);
    const results = await Promise.allSettled(batch.map(async id => {
      try {
        const detail = await client.getPackageDetails(token, id, {
          signal,
          onRetry: retry => onProgress(
            broad ? Math.max(1, listPages) : completed,
            broad ? completed : packages.length,
            broad ? ids.length : packages.length,
            `${retry.throttled ? "Microsoft Graph is throttling package reads." : "Microsoft Graph package read needs a retry."} Waiting ${Math.ceil(retry.retryDelayMs / 1000)} seconds before retrying (${completed}/${ids.length} identities checked).`,
          ),
        });
        if (detail.id !== id) throw new AppError(502, "target_mismatch", "Provider returned a different package identity.");
        const summary = summaries.get(id);
        return {
          ...summary, ...detail, identityDetailsCollected: true as const,
          authoringTool: detail.authoringTool ?? summary?.authoringTool ?? null,
          provenance: { ...summary?.provenance, ...detail.provenance },
        };
      } catch (error) {
        if (error instanceof AppError && error.status === 404) return null;
        throw error;
      }
    }));
    signal.throwIfAborted();
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      if (result.value) packages.push(result.value);
    }
    completed += batch.length;
    if (broad) {
      await onProgress(Math.max(1, listPages), completed, ids.length, `Matching agent records (${completed}/${ids.length} identities checked).`);
    } else {
      await onProgress(completed, packages.length, packages.length);
    }
  }
  return { packages, totalRecords: packages.length, pages: Math.max(1, broad ? listPages : completed) };
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

function requireRefreshRole(user: AuthenticatedUser) {
  if (!hasAppRole(user.roles, "AgentControl.Viewer")) throw new AppError(403, "missing_internal_role", "Package refresh requires Viewer.");
}

function requireSamePrincipal(scope: PackageDataScope, user: AuthenticatedUser) {
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The signed-in account changed during package refresh.");
}

function isAuthorizationFailure(error: unknown) {
  return error instanceof AppError && (error.status === 401 || error.status === 403 || ["interaction_required", "authorization_expired", "missing_internal_role", "missing_permission", "capability_unavailable", "not_configured"].includes(error.code));
}

function safeFailureMessage(error: unknown) {
  const diagnostics = graphResponseDiagnostics(error);
  if (diagnostics) {
    return `${diagnostics.throttled ? "Microsoft Graph is throttling package reads" : "Microsoft Graph package read failed"} (HTTP ${diagnostics.status}${diagnostics.providerCode ? `, ${diagnostics.providerCode}` : ""}). The previous complete inventory is unchanged; ${diagnostics.throttled ? "allow the provider cooldown to finish, then retry" : "retry"} from Sync.${diagnostics.requestId ? ` Graph request ID: ${diagnostics.requestId}.` : ""}`;
  }
  if (error instanceof AppError && ["provider_error", "provider_schema", "provider_result_limit", "provider_timeout", "provider_throttled", "provider_network_error",
    "invalid_provider_link", "incomplete_package_coverage", "package_scope_mismatch", "target_mismatch"].includes(error.code)) {
    return `${error.message.slice(0, 800)} The previous complete inventory is unchanged; retry from Sync.`;
  }
  return "Package refresh failed before complete publication. The previous complete inventory is unchanged; retry from Sync.";
}