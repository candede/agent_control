import { acquireApplicationToken, acquireAuthorizedToken, isRetryableIdentityProviderError, revalidateAuthorizedUser } from "../auth/msal.js";
import { setTimeout as delay } from "node:timers/promises";
import { findTenantConfiguration } from "../config.js";
import { PackageRefreshJobs, type PackageDataScope, type PackageRefreshInput } from "../db/packageRefreshJobs.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError, isTimeoutError } from "../errors.js";
import { hasAppRole, type CapabilityId } from "../types/capability.js";
import type { AuthenticatedUser } from "../types/session.js";
import { dataSyncFailureStatus } from "../types/dataSync.js";
import type { PackageDetailSyncState } from "../types/dataSync.js";
import { capabilities } from "./capabilities.js";
import { graphErrorTelemetry, graphResponseDiagnostics, packageReadTimeoutMs } from "./graphPackages.js";
import { packageRefreshExecutionDeadlineMs } from "./packageRefreshPolicy.js";
import { createRefreshExecutionSignal, type RefreshCancellationReason } from "./refreshExecution.js";
import { operationalLog, withTelemetryContext } from "./telemetry.js";
import { requireProviderAdmissions } from "./operationalState.js";
import { StreamedInventory } from "./streamedInventory.js";
import { completeInventoryJob, inventoryJobInput, inventoryRuntime } from "./inventoryRuntime.js";
import { PackageScanDiagnostics } from "./packageScanDiagnostics.js";
import { withReadAuthorityRefresh } from "../auth/authorityContext.js";

type PackageRefreshDependencies = {
  delegatedToken: typeof acquireAuthorizedToken;
  applicationToken: typeof acquireApplicationToken;
  revalidateUser: typeof revalidateAuthorizedUser;
  requireAvailable: typeof capabilities.requireAvailable;
  observeOperation: typeof capabilities.observeOperation;
  requireApplicationDataScope: typeof capabilities.requireApplicationDataScope;
  beginOperationValidation: typeof capabilities.beginOperationValidation;
  streams: (database: ConstructorParameters<typeof StreamedInventory>[0]) => Pick<StreamedInventory, "exactJob" | "graphCatalog">;
  applicationPrincipalId: (tenantId: string) => string | undefined;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

const defaultDependencies: PackageRefreshDependencies = {
  delegatedToken: acquireAuthorizedToken,
  applicationToken: acquireApplicationToken,
  revalidateUser: revalidateAuthorizedUser,
  requireAvailable: capabilities.requireAvailable.bind(capabilities),
  observeOperation: capabilities.observeOperation.bind(capabilities),
  requireApplicationDataScope: capabilities.requireApplicationDataScope.bind(capabilities),
  beginOperationValidation: capabilities.beginOperationValidation.bind(capabilities),
  streams: database => new StreamedInventory(database),
  applicationPrincipalId: tenantId => findTenantConfiguration(tenantId)?.clientId,
  wait: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
};

type RefreshInput = Omit<PackageRefreshInput, "authorizationPrincipalId">;
type RefreshAuthority = {
  validation: ReturnType<typeof beginAccountSessionValidation>;
  validateCapability: () => void;
};
type ActiveRefresh = { actor: PackageDataScope; controller: AbortController; operation: Promise<void>; autoDetails: boolean };
type StartingRefresh = Omit<ActiveRefresh, "operation" | "autoDetails"> & {
  autoDetails?: boolean;
  operation: Promise<NonNullable<Awaited<ReturnType<PackageRefreshJobs["getJob"]>>>>;
};
type DetailCollection = { actor: PackageDataScope; controller: AbortController; operation: Promise<void> };
const maximumActiveRefreshes = 4;
const maximumAutomaticRefreshes = 2;

export class PackageInventoryService {
  private readonly active = new Map<string, ActiveRefresh>();
  private readonly starting = new Map<string, StartingRefresh>();
  private readonly detailCollections = new Map<string, DetailCollection>();
  private readonly detailFailures = new Map<string, { code: string; message: string }>();
  private readonly detailCancelledAt = new Map<string, number>();
  private draining = false;

  constructor(
    private readonly repository = new PackageRefreshJobs(),
    private readonly dependencies: PackageRefreshDependencies = defaultDependencies,
  ) {}

  async submit(user: AuthenticatedUser, input: RefreshInput) {
    requireRefreshRole(user);
    const actor = actorScope(user);
    const validation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
    const validateCapability = this.dependencies.beginOperationValidation(capabilityForMode(input.tokenMode), user);
    const assertCurrent = () => {
      assertAccountSessionValidation(validation);
      validateCapability();
      requireProviderAdmissions();
    };
    assertCurrent();
    if (input.tokenMode === "application") await currentPackageWork(
      () => this.dependencies.requireApplicationDataScope("graph.package.read.application", user),
      new AbortController().signal, assertCurrent);
    const scope = dataScope(user, input.tokenMode, this.dependencies.applicationPrincipalId(user.tenantId!));
    return commitAccountSessionValidation(validation, async () => {
      assertCurrent();
      const job = await this.repository.submit(scope, { ...input, authorizationPrincipalId: user.homeAccountId }, assertCurrent);
      assertCurrent();
      return job;
    });
  }

  async refreshDueDetails(user: AuthenticatedUser, signedInAt?: number, signal?: AbortSignal) {
    requireRefreshRole(user);
    const scope = dataScope(user, "delegated", this.dependencies.applicationPrincipalId(user.tenantId!));
    const collectionKey = detailCollectionKey(scope);
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    signal?.throwIfAborted();
    assertAccountSessionValidation(validation);
    if (!this.draining) await inventoryRuntime(this.repository.database).enqueue(scope, true, signal);
    const validateCapability = this.dependencies.beginOperationValidation("graph.package.read.delegated", user);
    if (this.detailCancelledAt.has(collectionKey)) {
      signal?.throwIfAborted();
      assertAccountSessionValidation(validation);
      validateCapability();
      const latest = await this.repository.latestAutomaticDetailsJob(scope, user.homeAccountId);
      signal?.throwIfAborted();
      assertAccountSessionValidation(validation);
      validateCapability();
      return latest;
    }
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (this.detailCancelledAt.has(collectionKey)) throw new AppError(409, "read_job_cancelled", "Package detail collection was cancelled.");
      assertAccountSessionValidation(validation);
      validateCapability();
      requireProviderAdmissions();
    };
    const latestCurrentJob = async () => {
      const latest = await this.repository.latestAutomaticDetailsJob(scope, user.homeAccountId);
      assertCurrent();
      return latest;
    };
    assertCurrent();
    if (this.draining || this.laneCount(true) >= maximumAutomaticRefreshes) {
      return latestCurrentJob();
    }
    const history = await latestCurrentJob();
    if (history?.status === "cancelled"
      && (!signal || this.detailCollections.get(collectionKey)?.controller.signal !== signal)) return history;
    const job = await commitAccountSessionValidation(validation, async () => {
      assertCurrent();
      return this.repository.claimDueDetails(scope, user.homeAccountId, signedInAt);
    });
    if (!job) return latestCurrentJob();
    const abort = () => {
      this.starting.get(job.id)?.controller.abort(signal?.reason);
      this.active.get(job.id)?.controller.abort(signal?.reason);
    };
    try {
      assertCurrent();
      signal?.addEventListener("abort", abort, { once: true });
      const started = await this.startWithAuthority(user, job.id, "delegated", {}, { validation, validateCapability });
      assertCurrent();
      return started;
    } catch (error) {
      if (error instanceof AppError && error.code === "read_job_cancelled") {
        const cancelled = await this.repository.cancel(scope, job.id, user.homeAccountId);
        if (!cancelled) throw new AppError(409, "package_refresh_expired", "The cancelled detail batch expired before its status could be saved.");
        throw error;
      }
      operationalLog("warn", "package_detail_admission_failed", { jobId: job.id, ...graphErrorTelemetry(error) });
      const failed = await this.repository.markFailed(scope, job.id, syncFailureCode(error),
        isAuthorizationFailure(error) && !isAdmissionPause(error) ? "Automatic detail enrichment requires renewed Microsoft authorization. Sign in again."
          : safeFailureMessage(error), job.resultRevision);
      assertCurrent();
      if (failed) return failed;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async detailSyncState(user: AuthenticatedUser): Promise<PackageDetailSyncState> {
    requireRefreshRole(user);
    const scope = actorScope(user);
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    assertAccountSessionValidation(validation);
    const [coverage, latest] = await Promise.all([
      this.repository.detailCoverage(scope),
      this.repository.latestAutomaticDetailsJob(scope, scope.principalId),
    ]);
    assertAccountSessionValidation(validation);
    const key = detailCollectionKey(scope);
    const pending = coverage.total - coverage.fresh;
    const failure = this.detailFailures.get(key);
    let status: PackageDetailSyncState["status"];
    let message: string;
    if (!coverage.catalog_available) {
      status = "not_collected";
      message = "Sync the Graph package catalog before collecting package details.";
    } else if (!pending) {
      status = "complete";
      message = "Exact package details are fresh for every package in the current saved catalog.";
    } else if (this.detailCancelledAt.has(key)) {
      const stopping = latest && ["running", "waiting_authorization"].includes(latest.status) && !latest.errorCode;
      status = stopping ? "running" : "paused";
      message = stopping ? "Cancellation was requested. Waiting for the current detail batch to confirm it has stopped."
        : "Package detail collection was cancelled. Start it again to collect the remaining packages.";
    } else if (this.detailCollections.has(key) || latest && ["running", "waiting_authorization"].includes(latest.status) && !latest.errorCode) {
      status = "running";
      message = "Collecting exact package details in paced batches of at most 20. This includes matching metadata and sharing recipients.";
    } else if (failure || latest?.status === "failed" || latest?.status === "waiting_authorization") {
      status = dataSyncFailureStatus(failure?.code ?? latest?.errorCode ?? "interaction_required");
      message = failure?.message ?? latest?.message ?? "Package detail collection needs renewed Microsoft authorization.";
    } else if (latest?.status === "cancelled") {
      status = "paused";
      message = "Package detail collection was cancelled. Previously collected details remain saved.";
    } else {
      status = "ready";
      message = coverage.eligible ? "Package details still need collection; catalog sync alone does not collect them."
        : "Some details are waiting for the existing retry backoff. New eligible packages can be collected on the next authorized check.";
    }
    return { status, total: coverage.total, fresh: coverage.fresh, pending, eligible: coverage.eligible, message,
      job: latest ? { id: latest.id, status: latest.status, observedCount: latest.observedCount, targetCount: latest.targetCount,
        updatedAt: latest.updatedAt, ...(latest.errorCode ? { errorCode: latest.errorCode } : {}),
        ...(latest.message ? { message: latest.message } : {}) } : null };
  }

  async startDetailSync(user: AuthenticatedUser, signedInAt?: number, requestedAt?: number) {
    requireRefreshRole(user);
    requireProviderAdmissions();
    if (this.draining) throw new AppError(503, "package_refresh_shutdown", "Package refreshes are stopping for application shutdown.");
    const actor = actorScope(user), key = detailCollectionKey(actor);
    // A catalog run admitted before cancellation must not restart detail collection.
    if (requestedAt !== undefined && (this.detailCancelledAt.get(key) ?? -1) >= requestedAt) return this.detailSyncState(user);
    this.detailCancelledAt.delete(key);
    if (this.detailCollections.has(key)) return this.detailSyncState(user);
    if (this.detailCollections.size >= maximumAutomaticRefreshes) throw refreshCapacityError();
    const controller = new AbortController();
    const validation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      assertAccountSessionValidation(validation);
      requireProviderAdmissions();
    };
    assertCurrent();
    this.detailFailures.delete(key);
    const admitted = Promise.resolve().then(() => this.refreshDueDetails(user, signedInAt, controller.signal));
    const collection: DetailCollection = { actor, controller, operation: Promise.resolve() };
    this.detailCollections.set(key, collection);
    collection.operation = admitted.then(async first => {
      let current = first, previousId: string | undefined;
      while (current) {
        assertCurrent();
        if (current.id === previousId) return;
        previousId = current.id;
        let batch: NonNullable<Awaited<ReturnType<PackageRefreshJobs["getJob"]>>> = current;
        while (["running", "waiting_authorization"].includes(batch.status) && !batch.errorCode) {
          await this.dependencies.wait(250, controller.signal);
          assertCurrent();
          const jobId = batch.id;
          const next = await currentPackageWork(() => this.repository.getJob(actor, jobId), controller.signal, assertCurrent);
          assertCurrent();
          if (!next) throw new AppError(409, "package_refresh_expired", "The package detail job expired. Recheck status before retrying.");
          batch = next;
        }
        if (batch.status !== "succeeded") return;
        assertCurrent();
        current = await this.refreshDueDetails(user, signedInAt, controller.signal);
      }
    }).catch(error => {
      if (controller.signal.aborted && controller.signal.reason instanceof AppError
        && controller.signal.reason.code === "read_job_cancelled") return;
      this.detailFailures.set(key, { code: syncFailureCode(error), message: safeFailureMessage(error) });
      operationalLog("error", "package_detail_collection_failed", graphErrorTelemetry(error));
    }).finally(() => {
      if (this.detailCollections.get(key) === collection) this.detailCollections.delete(key);
    });
    await admitted;
    return this.detailSyncState(user);
  }

  async cancelDetailSync(user: AuthenticatedUser) {
    requireRefreshRole(user);
    const actor = actorScope(user), key = detailCollectionKey(actor);
    const validation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
    assertAccountSessionValidation(validation);
    const collection = this.detailCollections.get(key);
    this.detailCancelledAt.set(key, Date.now());
    collection?.controller.abort(new AppError(409, "read_job_cancelled", "Package detail collection was cancelled."));
    const latest = await this.repository.latestAutomaticDetailsJob(actor, actor.principalId);
    assertAccountSessionValidation(validation);
    if (latest && ["running", "waiting_authorization"].includes(latest.status)) await this.cancel(user, latest.id, "delegated");
    if (collection) await collection.operation;
    this.detailFailures.delete(key);
    return this.detailSyncState(user);
  }

  async start(user: AuthenticatedUser, id: string, tokenMode: RefreshInput["tokenMode"], options: { retryFailed?: boolean } = {}) {
    return this.startWithAuthority(user, id, tokenMode, options);
  }

  private async startWithAuthority(user: AuthenticatedUser, id: string, tokenMode: RefreshInput["tokenMode"],
    options: { retryFailed?: boolean }, authority?: RefreshAuthority) {
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
    const { validation, validateCapability } = authority ?? {
      validation: beginAccountSessionValidation(actor.tenantId, actor.principalId),
      validateCapability: this.dependencies.beginOperationValidation(capabilityForMode(tokenMode), user),
    };
    const starting: StartingRefresh = {
      actor, controller,
      operation: Promise.resolve().then(() => this.startRefresh(user, actor, scope, id, tokenMode, controller, validation, validateCapability, options))
        .finally(() => { if (this.starting.get(id) === starting) this.starting.delete(id); }),
    };
    this.starting.set(id, starting);
    return starting.operation;
  }

  private laneCount(autoDetails: boolean) {
    return [...new Map<string, Pick<StartingRefresh, "autoDetails">>([...this.starting, ...this.active]).values()]
      .filter(value => value.autoDetails === autoDetails).length;
  }

  private async startRefresh(user: AuthenticatedUser, actor: PackageDataScope, scope: PackageDataScope, id: string, tokenMode: RefreshInput["tokenMode"], controller: AbortController, validation: ReturnType<typeof beginAccountSessionValidation>, validateCapability: () => void, options: { retryFailed?: boolean }) {
    const signal = controller.signal;
    const assertCurrent = () => {
      signal.throwIfAborted();
      assertAccountSessionValidation(validation);
      validateCapability();
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
      const freshUser = await currentPackageWork(() => this.dependencies.revalidateUser(actor.tenantId, actor.principalId), signal, assertCurrent);
      assertCurrent();
      requireSamePrincipal(actor, freshUser);
      requireRefreshRole(freshUser);
      const capabilityId = capabilityForMode(tokenMode);
      if (tokenMode === "application") await currentPackageWork(() => this.dependencies.requireApplicationDataScope(capabilityId, freshUser), signal, assertCurrent);
      assertCurrent();
      await currentPackageWork(() => this.dependencies.requireAvailable(capabilityId, freshUser, options), signal, assertCurrent, 120_000);
      assertCurrent();
      token = await currentPackageWork(() => this.dependencies.observeOperation(capabilityId, freshUser, () => tokenMode === "delegated"
        ? this.dependencies.delegatedToken(actor.tenantId, actor.principalId, capabilityId)
        : this.dependencies.applicationToken(actor.tenantId, capabilityId), { signal, clearOnSuccess: false }), signal, assertCurrent);
      assertCurrent();
      // Fence the admission write without making sign-out wait for provider calls.
      await commitAccountSessionValidation(validation, async () => {
        assertCurrent();
        markedRunning = await this.repository.markRunning(scope, id, current!.autoDetails, assertCurrent);
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
    const executionDuration = current.autoDetails ? 5 * 60_000 : packageRefreshExecutionDeadlineMs;
    const executionDeadlineAt = Date.now() + executionDuration;
    const execution = createRefreshExecutionSignal(signal, executionDuration);
    const operation = withTelemetryContext({ jobId: id }, () => withReadAuthorityRefresh(controller,
      () => this.run(actor, scope, current, id, token, execution.signal, executionDeadlineAt, validation, validateCapability)))
      .finally(() => {
        execution.dispose();
        if (this.active.get(id)?.operation === operation) this.active.delete(id);
      });
    this.active.set(id, { actor, controller, operation, autoDetails: Boolean(current.autoDetails) });
    void operation.catch(error => {
      operationalLog("error", "package_refresh_status_failed", { jobId: id, ...graphErrorTelemetry(error) });
    });
    const result = await this.repository.getJob(scope, id);
    assertCurrent();
    if (!result) throw new AppError(409, "package_refresh_expired", "The package refresh expired before its status could be returned.");
    return result;
  }

  async get(user: AuthenticatedUser, id: string, tokenMode: RefreshInput["tokenMode"]) {
    requireRefreshRole(user);
    const actor = actorScope(user);
    const validation = beginAccountSessionValidation(actor.tenantId, actor.principalId);
    assertAccountSessionValidation(validation);
    try {
      const job = await this.repository.getJob(dataScope(user, tokenMode, this.dependencies.applicationPrincipalId(user.tenantId!)), id);
      assertAccountSessionValidation(validation);
      if (!job || job.authorizationPrincipalId !== user.homeAccountId) throw new AppError(404, "not_found", "Package refresh job was not found.");
      return job;
    } catch (error) {
      assertAccountSessionValidation(validation);
      throw error;
    }
  }

  async cancel(user: AuthenticatedUser, id: string, tokenMode: RefreshInput["tokenMode"], cancellationReason: RefreshCancellationReason = "requested") {
    requireRefreshRole(user);
    const actor = actorScope(user);
    const validation = cancellationReason === "requested" ? beginAccountSessionValidation(actor.tenantId, actor.principalId) : undefined;
    const assertCurrent = () => { if (validation) assertAccountSessionValidation(validation); };
    assertCurrent();
    const scope = dataScope(user, tokenMode, this.dependencies.applicationPrincipalId(user.tenantId!));
    id = id.toLowerCase();
    const job = await this.repository.getJob(scope, id);
    assertCurrent();
    if (!job || job.authorizationPrincipalId !== user.homeAccountId) throw new AppError(404, "not_found", "Package refresh job was not found.");
    const cancelled = await this.repository.cancel(scope, id, user.homeAccountId, cancellationReason);
    const reason = new AppError(409, "read_job_cancelled", "Package refresh was cancelled.");
    this.starting.get(id)?.controller.abort(reason);
    this.active.get(id)?.controller.abort(reason);
    assertCurrent();
    if (!cancelled) throw new AppError(409, "package_refresh_expired", "The package refresh expired before its cancellation status could be returned.");
    return cancelled;
  }

  recover() {
    return this.repository.recoverInterrupted();
  }

  async drain() {
    this.draining = true;
    const refreshes = [...this.starting.values(), ...this.active.values()];
    const reason = new AppError(401, "interaction_required", "Application shutdown requires explicit package refresh authorization.");
    const collections = [...this.detailCollections.values()];
    for (const collection of collections) collection.controller.abort(reason);
    for (const refresh of refreshes) refresh.controller.abort(reason);
    const results = await Promise.allSettled(refreshes.map(refresh => refresh.operation));
    await Promise.all(collections.map(collection => collection.operation));
    const failure = results.find((result, index) => result.status === "rejected"
      && result.reason !== refreshes[index].controller.signal.reason);
    if (failure?.status === "rejected") throw failure.reason;
  }

  async waitForPrincipalAuthorization(scope: PackageDataScope) {
    for (const collection of this.detailCollections.values()) {
      if (collection.actor.tenantId === scope.tenantId && collection.actor.principalId === scope.principalId) {
        collection.controller.abort(new AppError(401, "interaction_required", "The signed-in account changed during package detail collection."));
      }
    }
    for (const refresh of [...this.starting.values(), ...this.active.values()]) {
      if (refresh.actor.tenantId === scope.tenantId && refresh.actor.principalId === scope.principalId) {
        refresh.controller.abort(new AppError(401, "interaction_required", "The signed-in account changed during package refresh."));
      }
    }
  }

  private async run(actor: PackageDataScope, scope: PackageDataScope, current: Awaited<ReturnType<PackageRefreshJobs["getJob"]>> & {}, id: string, token: string, signal: AbortSignal, executionDeadlineAt: number, validation: ReturnType<typeof beginAccountSessionValidation>, validateCapability: () => void) {
    const startedAt = performance.now();
    let executionDeadline = startedAt + Math.max(0, executionDeadlineAt - Date.now());
    let persistedExecution: ReturnType<typeof createRefreshExecutionSignal> | undefined;
    let stage = "inventory_collection";
    let sourceAuthorized = false;
    let committed = false;
    const diagnostics = new PackageScanDiagnostics(current.scopeKind);
    if (current.scopeKind === "exact") diagnostics.startDetails(current.targetCount);
    let progress: { pages: number; observedCount: number; totalRecords: number | null } = {
      pages: 0, observedCount: 0, totalRecords: null,
    };
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (performance.now() >= executionDeadline) throw new DOMException("Package execution deadline expired.", "TimeoutError");
      assertAccountSessionValidation(validation);
      validateCapability();
      requireProviderAdmissions();
    };
    try {
      assertCurrent();
      operationalLog("info", "package_refresh_started", { mode: current.scopeKind });
      const input = await inventoryJobInput(this.repository.database, scope, "packages", id);
      if (input.deadlineAt.getTime() < executionDeadlineAt) {
        executionDeadlineAt = input.deadlineAt.getTime();
        const remainingMs = Math.max(0, executionDeadlineAt - Date.now());
        executionDeadline = Math.min(executionDeadline, performance.now() + remainingMs);
        persistedExecution = createRefreshExecutionSignal(signal, remainingMs);
        signal = persistedExecution.signal;
      }
      assertCurrent();
      const streams = this.dependencies.streams(this.repository.database);
      const options = {
        signal, executionDeadlineAt, assertCurrent, diagnostics, retryThrottlingUntilAborted: !current.autoDetails,
        onProgress: async (value: { pages: number; observedCount: number; totalRecords?: number | null }) => {
          assertCurrent();
          progress = { pages: value.pages, observedCount: value.observedCount,
            totalRecords: current.scopeKind === "exact" ? current.targetCount : value.totalRecords ?? null };
          await currentPackageWork(() => this.repository.recordProgress(scope, id, progress.pages, progress.observedCount,
            progress.totalRecords), signal, assertCurrent);
          assertCurrent();
        },
        onRetry: async (notice: { retryDelayMs: number; throttled: boolean }) => {
          assertCurrent();
          await this.repository.recordProgress(scope, id, progress.pages, progress.observedCount, progress.totalRecords,
            `${notice.throttled ? "Microsoft Graph is throttling package reads." : "Microsoft Graph is retrying a package read."} Waiting ${Math.ceil(notice.retryDelayMs / 1_000)} seconds before retrying (${progress.observedCount} ${current.scopeKind === "exact" ? "targets checked" : "packages observed"}).`);
          assertCurrent();
        },
        authorize: async (publicationSignal: AbortSignal) => {
          if (sourceAuthorized) diagnostics.finish("collected");
          stage = sourceAuthorized ? "publication_authorization" : "collection_authorization";
          for (let attempt = 1; ; attempt++) {
          publicationSignal.throwIfAborted();
          try {
          assertCurrent();
          const freshUser = await currentPackageWork(() => this.dependencies.revalidateUser(actor.tenantId, actor.principalId), publicationSignal, assertCurrent);
          assertCurrent();
          requireSamePrincipal(actor, freshUser);
          requireRefreshRole(freshUser);
          const capabilityId = capabilityForMode(current.tokenMode);
          if (current.tokenMode === "application") await currentPackageWork(() => this.dependencies.requireApplicationDataScope(capabilityId, freshUser), publicationSignal, assertCurrent);
          assertCurrent();
          await currentPackageWork(() => this.dependencies.requireAvailable(capabilityId, freshUser, { retryFailed: true }), publicationSignal, assertCurrent, 120_000);
          assertCurrent();
          stage = sourceAuthorized ? "publication" : "inventory_collection";
          sourceAuthorized = true;
          return;
          } catch (error) {
            if (!transientPublicationReadinessFailure(error)) throw error;
            await currentPackageWork(() => this.repository.recordProgress(scope, id, progress.pages, progress.observedCount, progress.totalRecords,
              sourceAuthorized
                ? "Collection is complete. Waiting for current Microsoft read authorization before publication; no packages are being downloaded again."
                : "Waiting for current Microsoft read authorization before collection. No provider reads are running."), publicationSignal, assertCurrent);
            assertCurrent();
            const retryDelay = publicationReadinessRetryDelay(error, attempt);
            if (sourceAuthorized) operationalLog("warn", "package_publication_readiness_retry", {
              stage: "publication_authorization", count: progress.observedCount, attempt, retryDelayMs: retryDelay,
              ...graphErrorTelemetry(error),
            });
            await currentPackageWork(() => this.dependencies.wait(retryDelay, publicationSignal), publicationSignal, assertCurrent, retryDelay + packageReadTimeoutMs);
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
        onCommitted: () => { committed = true; },
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
        }, { signal });
    } catch (error) {
      if (committed) {
        diagnostics.finish("collected");
        operationalLog("warn", "package_inventory_followup_failed", { stage, ...graphErrorTelemetry(error) });
        return;
      }
      let failure = error;
      try { assertCurrent(); } catch (currentError) { failure = currentError; }
      const timedOut = signal.aborted ? isTimeoutError(signal.reason) : performance.now() >= executionDeadline;
      diagnostics.finish(timedOut ? "timed_out" : signal.aborted ? "cancelled" : "failed");
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
      const code = timedOut ? "package_refresh_timeout" : syncFailureCode(failure);
      await this.repository.markFailed(scope, id, code,
        timedOut ? current.autoDetails
          ? "Automatic detail enrichment reached its five-minute deadline. Saved details are unchanged; a later authorized check may retry after backoff."
          : "Package refresh reached its four-hour execution deadline. The previous complete inventory is unchanged; retry from Sync."
          : safeFailureMessage(failure));
      operationalLog("error", "package_refresh_failed", { stage, ...graphErrorTelemetry(failure), errorCode: code });
    } finally {
      if (committed) {
        diagnostics.finish("collected");
        try {
          await currentPackageWork(
            followupSignal => inventoryRuntime(this.repository.database).enqueue(actor, true, followupSignal), signal, assertCurrent);
        } catch (error) {
          operationalLog("warn", "package_inventory_followup_failed", { stage: "canonical_reconciliation", ...graphErrorTelemetry(error) });
        }
        operationalLog("info", "package_refresh_succeeded", {
          status: "succeeded", durationMs: Math.round(performance.now() - startedAt),
        });
      }
      persistedExecution?.dispose();
    }
  }
}

export const packageInventory = new PackageInventoryService();

function detailCollectionKey(scope: PackageDataScope) {
  return `${scope.tenantId}\0${scope.principalId}`;
}

async function currentPackageWork<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, assertCurrent: () => void,
  timeoutMs = packageReadTimeoutMs): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([parent, timeout]);
  let removeAbort = () => {};
  try {
    assertCurrent();
    signal.throwIfAborted();
    const work = operation(signal);
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
    });
    const result = await Promise.race([work, aborted]);
    assertCurrent();
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new DOMException("Package authorization deadline expired.", "TimeoutError");
    return result;
  } catch (error) {
    assertCurrent();
    parent.throwIfAborted();
    if (timeout.aborted || performance.now() >= deadline) throw new AppError(504, "provider_timeout", "Microsoft package authorization did not complete within its bounded deadline.");
    throw error;
  } finally { removeAbort(); }
}

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
  const response = graphResponseDiagnostics(error);
  if (response) return response.status === 401;
  return error instanceof AppError && (dataSyncFailureStatus(error.code, error.status) === "waiting_authorization"
    || isAdmissionPause(error));
}

function isAdmissionPause(error: unknown): error is AppError {
  return error instanceof AppError && !graphResponseDiagnostics(error)
    && error.code === "maintenance";
}

function syncFailureCode(error: unknown) {
  const response = graphResponseDiagnostics(error);
  if (response) return response.status === 401 ? "interaction_required" : `graph_http_${response.status}`;
  if (!(error instanceof AppError)) return "provider_error";
  if (dataSyncFailureStatus(error.code) !== "failed") return error.code;
  return error.status === 401 ? "interaction_required" : error.status === 403 ? "missing_permission" : error.code;
}

function safeFailureMessage(error: unknown) {
  const diagnostics = graphResponseDiagnostics(error);
  if (isAdmissionPause(error)) return `${error.message} Saved package data is unchanged.`;
  if (!diagnostics && error instanceof AppError && error.code === "identity_provider_error") {
    return "Microsoft Entra ID could not renew authorization for package refresh. The previous complete inventory is unchanged; retry from Sync. If this persists, review the Entra sign-in logs and application configuration.";
  }
  if (diagnostics?.status === 403
    || !diagnostics && error instanceof AppError && dataSyncFailureStatus(error.code, error.status) === "permission_required") {
    return "Required Microsoft read permission or provider role is unavailable. Review Permissions; signing in again does not grant permissions. Saved data is unchanged.";
  }
  if (diagnostics) {
    return `${diagnostics.throttled ? "Microsoft Graph is throttling package reads" : "Microsoft Graph package read failed"} (HTTP ${diagnostics.status}${diagnostics.providerCode ? `, ${diagnostics.providerCode}` : ""}). The previous complete inventory is unchanged; ${diagnostics.throttled ? "allow the provider cooldown to finish, then retry" : "retry"} from Sync.${diagnostics.requestId ? ` Graph request ID: ${diagnostics.requestId}.` : ""}`;
  }
  if (error instanceof AppError && ["provider_error", "provider_schema", "provider_result_limit", "provider_timeout", "provider_throttled", "provider_network_error",
    "invalid_provider_link", "incomplete_package_coverage", "package_scope_mismatch", "target_mismatch"].includes(error.code)) {
    return `${error.message.slice(0, 800)} The previous complete inventory is unchanged; retry from Sync.`;
  }
  return "Package refresh failed before complete publication. The previous complete inventory is unchanged; retry from Sync.";
}