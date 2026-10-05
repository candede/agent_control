import { acquireApplicationToken, acquireDelegatedToken, isRetryableIdentityProviderError, revalidateAuthenticatedUser } from "../auth/msal.js";
import { setTimeout as delay } from "node:timers/promises";
import { findTenantConfiguration } from "../config.js";
import { PackageRefreshJobs, type PackageDataScope, type PackageRefreshInput } from "../db/packageRefreshJobs.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import { hasAppRole, type CapabilityId } from "../types/capability.js";
import type { AuthenticatedUser } from "../types/session.js";
import { dataSyncFailureStatus } from "../types/dataSync.js";
import { capabilities } from "./capabilities.js";
import { graphErrorTelemetry, graphResponseDiagnostics } from "./graphPackages.js";
import { packageRefreshExecutionDeadlineMs } from "./packageRefreshPolicy.js";
import { createRefreshExecutionSignal, type RefreshCancellationReason } from "./refreshExecution.js";
import { operationalLog, withTelemetryContext } from "./telemetry.js";
import { requireProviderAdmissions } from "./operationalState.js";
import { StreamedInventory } from "./streamedInventory.js";
import { completeInventoryJob, inventoryJobInput, inventoryRuntime } from "./inventoryRuntime.js";
import { PackageScanDiagnostics } from "./packageScanDiagnostics.js";

type PackageRefreshDependencies = {
  delegatedToken: typeof acquireDelegatedToken;
  applicationToken: typeof acquireApplicationToken;
  revalidateUser: typeof revalidateAuthenticatedUser;
  requireAvailable: typeof capabilities.requireAvailable;
  observeOperation: typeof capabilities.observeOperation;
  requireApplicationDataScope: typeof capabilities.requireApplicationDataScope;
  streams: (database: ConstructorParameters<typeof StreamedInventory>[0]) => Pick<StreamedInventory, "exactJob" | "graphCatalog">;
  applicationPrincipalId: (tenantId: string) => string | undefined;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

const defaultDependencies: PackageRefreshDependencies = {
  delegatedToken: acquireDelegatedToken,
  applicationToken: acquireApplicationToken,
  revalidateUser: revalidateAuthenticatedUser,
  requireAvailable: capabilities.requireAvailable.bind(capabilities),
  observeOperation: capabilities.observeOperation.bind(capabilities),
  requireApplicationDataScope: capabilities.requireApplicationDataScope.bind(capabilities),
  streams: database => new StreamedInventory(database),
  applicationPrincipalId: tenantId => findTenantConfiguration(tenantId)?.clientId,
  wait: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
};

type RefreshInput = Omit<PackageRefreshInput, "authorizationPrincipalId">;
type ActiveRefresh = { actor: PackageDataScope; controller: AbortController; operation: Promise<void>; autoDetails: boolean };
type StartingRefresh = Omit<ActiveRefresh, "operation" | "autoDetails"> & {
  autoDetails?: boolean;
  operation: Promise<NonNullable<Awaited<ReturnType<PackageRefreshJobs["getJob"]>>>>;
};
const maximumActiveRefreshes = 4;
const maximumAutomaticRefreshes = 2;

export class PackageInventoryService {
  private readonly active = new Map<string, ActiveRefresh>();
  private readonly starting = new Map<string, StartingRefresh>();
  private draining = false;

  constructor(
    private readonly repository = new PackageRefreshJobs(),
    private readonly dependencies: PackageRefreshDependencies = defaultDependencies,
  ) {}

  async submit(user: AuthenticatedUser, input: RefreshInput) {
    requireRefreshRole(user);
    requireProviderAdmissions();
    if (input.tokenMode === "application") await this.dependencies.requireApplicationDataScope("graph.package.read.application", user);
    const scope = dataScope(user, input.tokenMode, this.dependencies.applicationPrincipalId(user.tenantId!));
    return this.repository.submit(scope, { ...input, authorizationPrincipalId: user.homeAccountId });
  }

  async refreshDueDetails(user: AuthenticatedUser, signedInAt?: number, signal?: AbortSignal) {
    requireRefreshRole(user);
    const scope = dataScope(user, "delegated", this.dependencies.applicationPrincipalId(user.tenantId!));
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    const assertCurrent = () => {
      signal?.throwIfAborted();
      assertAccountSessionValidation(validation);
      requireProviderAdmissions();
    };
    assertCurrent();
    if (this.draining || this.laneCount(true) >= maximumAutomaticRefreshes) {
      return this.repository.latestAutomaticDetailsJob(scope, user.homeAccountId);
    }
    const job = await commitAccountSessionValidation(validation, async () => {
      assertCurrent();
      return this.repository.claimDueDetails(scope, user.homeAccountId, signedInAt);
    });
    if (!job) return this.repository.latestAutomaticDetailsJob(scope, user.homeAccountId);
    const abort = () => {
      this.starting.get(job.id)?.controller.abort(signal?.reason);
      this.active.get(job.id)?.controller.abort(signal?.reason);
    };
    try {
      assertCurrent();
      signal?.addEventListener("abort", abort, { once: true });
      const started = await this.start(user, job.id, "delegated");
      assertCurrent();
      return started;
    } catch (error) {
      operationalLog("warn", "package_detail_admission_failed", { jobId: job.id, ...graphErrorTelemetry(error) });
      const failed = await this.repository.markFailed(scope, job.id, syncFailureCode(error),
        isAuthorizationFailure(error) && !isAdmissionPause(error) ? "Automatic detail enrichment requires renewed Microsoft authorization. Sign in again."
          : safeFailureMessage(error));
      assertCurrent();
      if (failed) return failed;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async start(user: AuthenticatedUser, id: string, tokenMode: RefreshInput["tokenMode"], options: { retryFailed?: boolean } = {}) {
    const actor = actorScope(user);
    const scope = dataScope(user, tokenMode, this.dependencies.applicationPrincipalId(user.tenantId!));
    id = id.toLowerCase();
    if (this.draining) throw new AppError(503, "package_refresh_shutdown", "Package refreshes are stopping for application shutdown.");
    requireProviderAdmissions();
    const reserved = this.active.get(id) ?? this.starting.get(id);
    if (reserved) {
      if (reserved.actor.tenantId !== actor.tenantId || reserved.actor.principalId !== actor.principalId) {
        throw new AppError(404, "not_found", "Package refresh job was not found.");
      }
      throw new AppError(409, "package_refresh_state", "Package refresh is already starting or running.");
    }
    if (new Set([...this.starting.keys(), ...this.active.keys()]).size >= maximumActiveRefreshes + maximumAutomaticRefreshes) {
      throw refreshCapacityError();
    }
    const controller = new AbortController();
    const validation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
    const starting: StartingRefresh = {
      actor, controller,
      operation: Promise.resolve().then(() => this.startRefresh(user, actor, scope, id, tokenMode, controller, validation, options))
        .finally(() => { if (this.starting.get(id) === starting) this.starting.delete(id); }),
    };
    this.starting.set(id, starting);
    return starting.operation;
  }

  private laneCount(autoDetails: boolean) {
    return [...new Map<string, Pick<StartingRefresh, "autoDetails">>([...this.starting, ...this.active]).values()]
      .filter(value => value.autoDetails === autoDetails).length;
  }

  private async startRefresh(user: AuthenticatedUser, actor: PackageDataScope, scope: PackageDataScope, id: string, tokenMode: RefreshInput["tokenMode"], controller: AbortController, validation: ReturnType<typeof beginAccountSessionValidation>, options: { retryFailed?: boolean }) {
    const signal = controller.signal;
    const assertCurrent = () => {
      signal.throwIfAborted();
      assertAccountSessionValidation(validation);
      requireProviderAdmissions();
    };
    let current: Awaited<ReturnType<PackageRefreshJobs["getJob"]>>;
    let token = "";
    let ownedWaitingJob = false;
    let markedRunning = false;
    try {
      assertCurrent();
      current = await this.repository.getJob(scope, id);
      assertCurrent();
      if (!current || current.authorizationPrincipalId !== user.homeAccountId) throw new AppError(404, "not_found", "Package refresh job was not found.");
      if (current.status !== "waiting_authorization") throw new AppError(409, "package_refresh_state", "Only a waiting package refresh can be started.");
      ownedWaitingJob = true;
      requireRefreshRole(user);
      const autoDetails = Boolean(current.autoDetails);
      if (this.laneCount(autoDetails) >= (autoDetails ? maximumAutomaticRefreshes : maximumActiveRefreshes)) {
        throw refreshCapacityError();
      }
      // Persisted mode, not a caller hint, owns the lane before provider authorization begins.
      this.starting.get(id)!.autoDetails = autoDetails;
      const freshUser = await this.dependencies.revalidateUser(actor.tenantId, actor.principalId);
      assertCurrent();
      requireSamePrincipal(actor, freshUser);
      requireRefreshRole(freshUser);
      const capabilityId = capabilityForMode(tokenMode);
      if (tokenMode === "application") await this.dependencies.requireApplicationDataScope(capabilityId, freshUser);
      assertCurrent();
      await this.dependencies.requireAvailable(capabilityId, freshUser, options);
      assertCurrent();
      token = await this.dependencies.observeOperation(capabilityId, freshUser, () => tokenMode === "delegated"
        ? this.dependencies.delegatedToken(actor.tenantId, actor.principalId, capabilityId)
        : this.dependencies.applicationToken(actor.tenantId, capabilityId), { signal, clearOnSuccess: false });
      assertCurrent();
      // Fence the admission write without making sign-out wait for provider calls.
      await commitAccountSessionValidation(validation, async () => {
        assertCurrent();
        markedRunning = current!.autoDetails ? await this.repository.markRunning(scope, id, true) : await this.repository.markRunning(scope, id);
        if (!markedRunning) throw new AppError(409, "package_refresh_state", "Package refresh was already started or expired.");
      });
      assertCurrent();
    } catch (error) {
      let failure = error;
      try { assertCurrent(); } catch (currentError) { failure = currentError; }
      if (markedRunning && (signal.aborted || isAuthorizationFailure(failure))) {
        if (signal.reason instanceof AppError && signal.reason.code === "read_job_cancelled") {
          await this.repository.cancel(scope, id, actor.principalId);
        } else {
          await this.repository.markWaitingAuthorization(scope, id);
        }
      } else if (ownedWaitingJob && failure instanceof AppError && dataSyncFailureStatus(failure.code, failure.status) === "permission_required") {
        await this.repository.markFailed(scope, id, syncFailureCode(failure), safeFailureMessage(failure));
      }
      assertCurrent();
      throw failure;
    }
    const execution = createRefreshExecutionSignal(signal, current.autoDetails ? 5 * 60_000 : packageRefreshExecutionDeadlineMs);
    const operation = withTelemetryContext({ jobId: id }, () => this.run(actor, scope, current, id, token, execution.signal, validation))
      .finally(() => {
        execution.dispose();
        if (this.active.get(id)?.operation === operation) this.active.delete(id);
      });
    this.active.set(id, { actor, controller, operation, autoDetails: Boolean(current.autoDetails) });
    void operation.catch(error => {
      operationalLog("error", "package_refresh_status_failed", { jobId: id, ...graphErrorTelemetry(error) });
    });
    return (await this.repository.getJob(scope, id))!;
  }

  async get(user: AuthenticatedUser, id: string, tokenMode: RefreshInput["tokenMode"]) {
    const job = await this.repository.getJob(dataScope(user, tokenMode, this.dependencies.applicationPrincipalId(user.tenantId!)), id);
    if (!job || job.authorizationPrincipalId !== user.homeAccountId) throw new AppError(404, "not_found", "Package refresh job was not found.");
    return job;
  }

  async cancel(user: AuthenticatedUser, id: string, tokenMode: RefreshInput["tokenMode"], cancellationReason: RefreshCancellationReason = "requested") {
    requireRefreshRole(user);
    const scope = dataScope(user, tokenMode, this.dependencies.applicationPrincipalId(user.tenantId!));
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

  private async run(actor: PackageDataScope, scope: PackageDataScope, current: Awaited<ReturnType<PackageRefreshJobs["getJob"]>> & {}, id: string, token: string, signal: AbortSignal, validation: ReturnType<typeof beginAccountSessionValidation>) {
    const startedAt = performance.now();
    let stage = "inventory_collection";
    let sourceAuthorized = false;
    let committed = false;
    let diagnosticsFinished = false;
    const diagnostics = new PackageScanDiagnostics(current.scopeKind);
    if (current.scopeKind === "exact") diagnostics.startDetails(current.targetCount);
    const finishDiagnostics = (outcome: Parameters<PackageScanDiagnostics["finish"]>[0]) => {
      if (!diagnosticsFinished) { diagnostics.finish(outcome); diagnosticsFinished = true; }
    };
    let progress = { pages: current.pageCount, observedCount: current.observedCount, totalRecords: current.totalRecords };
    const assertCurrent = () => {
      signal.throwIfAborted();
      assertAccountSessionValidation(validation);
      requireProviderAdmissions();
    };
    try {
      assertCurrent();
      operationalLog("info", "package_refresh_started", { mode: current.scopeKind });
      const input = await inventoryJobInput(this.repository.database, scope, "packages", id);
      const streams = this.dependencies.streams(this.repository.database);
      const options = {
        signal, diagnostics, retryThrottlingUntilAborted: !current.autoDetails,
        onProgress: async (value: { pages: number; observedCount: number; totalRecords?: number | null }) => {
          assertCurrent();
          progress = { pages: value.pages, observedCount: value.observedCount,
            totalRecords: current.scopeKind === "exact" ? current.targetCount : value.totalRecords ?? null };
          await this.repository.recordProgress(scope, id, progress.pages, progress.observedCount,
            progress.totalRecords);
        },
        onRetry: async (notice: { retryDelayMs: number; throttled: boolean }) => {
          assertCurrent();
          await this.repository.recordProgress(scope, id, progress.pages, progress.observedCount, progress.totalRecords,
            `${notice.throttled ? "Microsoft Graph is throttling package reads." : "Microsoft Graph is retrying a package read."} Waiting ${Math.ceil(notice.retryDelayMs / 1_000)} seconds before retrying (${progress.observedCount} targets observed).`);
          assertCurrent();
        },
        authorize: async (publicationSignal: AbortSignal) => {
          stage = sourceAuthorized ? "publication_authorization" : "collection_authorization";
          for (let attempt = 1; ; attempt++) {
          publicationSignal.throwIfAborted();
          try {
          assertCurrent();
          const freshUser = await this.dependencies.revalidateUser(actor.tenantId, actor.principalId);
          assertCurrent();
          requireSamePrincipal(actor, freshUser);
          requireRefreshRole(freshUser);
          const capabilityId = capabilityForMode(current.tokenMode);
          if (current.tokenMode === "application") await this.dependencies.requireApplicationDataScope(capabilityId, freshUser);
          assertCurrent();
          await this.dependencies.requireAvailable(capabilityId, freshUser, { retryFailed: true });
          assertCurrent();
          sourceAuthorized = true;
          stage = "inventory_collection";
          return;
          } catch (error) {
            if (!transientPublicationReadinessFailure(error)) throw error;
            await this.repository.recordProgress(scope, id, progress.pages, progress.observedCount, progress.totalRecords,
              sourceAuthorized
                ? "Collection is complete. Waiting for current Microsoft read authorization before publication; no packages are being downloaded again."
                : "Waiting for current Microsoft read authorization before collection. No provider reads are running.");
            assertCurrent();
            await this.dependencies.wait(publicationReadinessRetryDelay(error, attempt), publicationSignal);
          }
          }
        },
        getAccessToken: async () => {
          assertCurrent();
          const capabilityId = capabilityForMode(current.tokenMode);
          const value = current.tokenMode === "delegated"
            ? await this.dependencies.delegatedToken(actor.tenantId, actor.principalId, capabilityId)
            : await this.dependencies.applicationToken(actor.tenantId, capabilityId);
          assertCurrent();
          return value;
        },
        commitPublication: (operation: () => Promise<void>) => commitAccountSessionValidation(validation, async () => {
          assertCurrent();
          await operation();
        }),
        completeJob: async (...args: Parameters<ReturnType<typeof completeInventoryJob>>) => {
          assertCurrent();
          stage = "publication";
          await completeInventoryJob(input, "packages")(...args);
        },
      };
      await this.dependencies.observeOperation(capabilityForMode(current.tokenMode),
        { tenantId: actor.tenantId, homeAccountId: actor.principalId }, async () => {
          if (current.scopeKind === "exact") await streams.exactJob(input, token, current.autoDetails, options);
          else await streams.graphCatalog(input, token, options);
          committed = true;
        }, { signal });
      finishDiagnostics("collected");
      if (current.tokenMode === "delegated") await inventoryRuntime(this.repository.database).enqueue(scope);
      operationalLog("info", "package_refresh_succeeded", {
        status: "succeeded", durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      if (committed) {
        finishDiagnostics("collected");
        operationalLog("warn", "package_inventory_followup_failed", { stage, ...graphErrorTelemetry(error) });
        return;
      }
      let failure = error;
      try { assertCurrent(); } catch (currentError) { failure = currentError; }
      finishDiagnostics(signal.aborted ? signal.reason instanceof Error && signal.reason.name === "TimeoutError" ? "timed_out" : "cancelled" : "failed");
      operationalLog("warn", "package_refresh_execution_failed", {
        stage, ...graphErrorTelemetry(failure), durationMs: Math.round(performance.now() - startedAt),
      });
      if (failure instanceof AppError && failure.code === "read_job_cancelled") {
        await this.repository.cancel(scope, id, actor.principalId);
        return;
      }
      if (isAuthorizationFailure(failure)) {
        if (current.autoDetails) await this.repository.markFailed(scope, id,
          isAdmissionPause(failure) ? failure.code : "interaction_required",
          isAdmissionPause(failure) ? safeFailureMessage(failure) : "Automatic enrichment needs renewed authorization and will retry after backoff.");
        else await this.repository.markWaitingAuthorization(scope, id);
        return;
      }
      const timedOut = signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError";
      const diagnostics = graphResponseDiagnostics(failure);
      const code = timedOut ? "package_refresh_timeout"
        : failure instanceof AppError && dataSyncFailureStatus(failure.code, failure.status) === "permission_required"
          ? syncFailureCode(failure) : diagnostics ? `graph_http_${diagnostics.status}` : syncFailureCode(failure);
      await this.repository.markFailed(scope, id, code,
        timedOut ? current.autoDetails
          ? "Automatic detail enrichment reached its five-minute deadline. Saved details are unchanged; a later authorized check may retry after backoff."
          : "Package refresh reached its four-hour execution deadline. The previous complete inventory is unchanged; retry from Sync."
          : safeFailureMessage(failure));
      operationalLog("error", "package_refresh_failed", { stage, ...graphErrorTelemetry(failure), errorCode: code });
    }
  }
}

export const packageInventory = new PackageInventoryService();

function refreshCapacityError() {
  return new AppError(429, "package_refresh_capacity", "At most four foreground package refreshes and two automatic detail refreshes can run at once.");
}

function transientPublicationReadinessFailure(error: unknown): error is AppError {
  if (!(error instanceof AppError) || error.status === 401 || error.status === 403) return false;
  if (isRetryableIdentityProviderError(error)) return true;
  if (["provider_timeout", "provider_network_error", "provider_throttled"].includes(error.code)) return true;
  if (error.code !== "provider_error" || !error.details || typeof error.details !== "object" || !("evidence" in error.details)) return false;
  const evidence = error.details.evidence;
  if (!evidence || typeof evidence !== "object") return false;
  if ("httpStatus" in evidence && (evidence.httpStatus === 401 || evidence.httpStatus === 403)) return false;
  return "category" in evidence && evidence.category === "provider_network_error"
    || "httpStatus" in evidence && typeof evidence.httpStatus === "number" && [500, 502, 503, 504].includes(evidence.httpStatus);
}

function publicationReadinessRetryDelay(error: AppError, attempt: number) {
  const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
  const details = error.details;
  const expiresAt = details && typeof details === "object" && "expiresAt" in details && typeof details.expiresAt === "string"
    ? Date.parse(details.expiresAt) : NaN;
  return error.code === "provider_throttled" && Number.isFinite(expiresAt)
    ? Math.max(backoff, expiresAt - Date.now() + 1) : backoff;
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
  return error instanceof AppError && (dataSyncFailureStatus(error.code, error.status) === "waiting_authorization"
    || isAdmissionPause(error));
}

function isAdmissionPause(error: unknown): error is AppError {
  return error instanceof AppError && ["maintenance", "provider_requalification_required"].includes(error.code);
}

function syncFailureCode(error: unknown) {
  if (!(error instanceof AppError)) return "provider_error";
  if (dataSyncFailureStatus(error.code) !== "failed") return error.code;
  return error.status === 401 ? "interaction_required" : error.status === 403 ? "missing_permission" : error.code;
}

function safeFailureMessage(error: unknown) {
  if (isAdmissionPause(error)) return `${error.message} Saved package data is unchanged.`;
  if (error instanceof AppError && error.code === "identity_provider_error") {
    return "Microsoft Entra ID could not renew authorization for package refresh. The previous complete inventory is unchanged; retry from Sync. If this persists, review the Entra sign-in logs and application configuration.";
  }
  if (error instanceof AppError && dataSyncFailureStatus(error.code, error.status) === "permission_required") {
    return "Required Microsoft read permission or provider role is unavailable. Review Permissions; signing in again does not grant permissions. Saved data is unchanged.";
  }
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