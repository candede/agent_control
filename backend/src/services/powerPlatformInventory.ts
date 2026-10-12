import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { PowerPlatformRefreshJobs, type InventoryDataScope, type InventoryRefreshInput } from "../db/powerPlatformRefreshJobs.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError, errorTelemetry, isTimeoutError } from "../errors.js";
import type { AuthenticatedUser } from "../types/session.js";
import { dataSyncFailureStatus } from "../types/dataSync.js";
import { hasAppRole } from "../types/capability.js";
import type { InventoryRefreshJob } from "../types/powerPlatformInventory.js";
import { capabilities } from "./capabilities.js";
import { inventoryQueryTypes, inventoryRoleScope } from "./inventoryRoleScope.js";
import { inventoryLimits } from "../types/inventoryRecords.js";
import { createRefreshExecutionSignal, type RefreshCancellationReason } from "./refreshExecution.js";
import { operationalLog, withTelemetryContext } from "./telemetry.js";
import { requireProviderAdmissions } from "./operationalState.js";
import { StreamedInventory } from "./streamedInventory.js";
import { completeInventoryJob, inventoryJobInput, inventoryRuntime } from "./inventoryRuntime.js";

type InventoryRefreshDependencies = {
  delegatedToken: typeof acquireDelegatedToken;
  revalidateUser: typeof revalidateAuthenticatedUser;
  requireAvailable: typeof capabilities.requireAvailable;
  observeOperation: typeof capabilities.observeOperation;
  beginOperationValidation: typeof capabilities.beginOperationValidation;
  streams: (database: ConstructorParameters<typeof StreamedInventory>[0]) => Pick<StreamedInventory, "powerPlatformCatalog">;
};

const defaultDependencies: InventoryRefreshDependencies = {
  delegatedToken: acquireDelegatedToken,
  revalidateUser: revalidateAuthenticatedUser,
  requireAvailable: capabilities.requireAvailable.bind(capabilities),
  observeOperation: capabilities.observeOperation.bind(capabilities),
  beginOperationValidation: capabilities.beginOperationValidation.bind(capabilities),
  streams: database => new StreamedInventory(database),
};

type ActiveRefresh = { scope: InventoryDataScope; controller: AbortController; operation: Promise<void> };
type StartingRefresh = Omit<ActiveRefresh, "operation"> & { operation: Promise<InventoryRefreshJob> };
const maximumActiveRefreshes = 4;
const refreshExecutionDeadlineMs = inventoryLimits.powerPlatformDeadlineMs;

export class PowerPlatformInventoryService {
  private readonly active = new Map<string, ActiveRefresh>();
  private readonly starting = new Map<string, StartingRefresh>();
  private draining = false;

  constructor(
    private readonly repository = new PowerPlatformRefreshJobs(),
    private readonly dependencies: InventoryRefreshDependencies = defaultDependencies,
  ) {}

  async submit(user: AuthenticatedUser, input: Omit<InventoryRefreshInput, "roleScope">) {
    requireReader(user);
    const scope = dataScope(user);
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    const validateCapability = this.dependencies.beginOperationValidation("powerPlatform.inventory.read", {
      tenantId: scope.tenantId, homeAccountId: scope.principalId,
    });
    const assertCurrent = () => {
      assertAccountSessionValidation(validation);
      validateCapability();
      requireProviderAdmissions();
    };
    assertCurrent();
    const roleScope = inventoryRoleScope(user);
    return commitAccountSessionValidation(validation, async () => {
      assertCurrent();
      const job = await this.repository.submit(scope, { ...input, roleScope }, assertCurrent);
      assertCurrent();
      operationalLog("info", "inventory_refresh_submitted", {
        jobId: job.id, status: job.status, requestedTypeCount: job.requestedTypes.length,
        environmentScoped: Boolean(job.environmentScope),
      });
      return job;
    });
  }

  async start(user: AuthenticatedUser, id: string, options: { retryFailed?: boolean } = {}) {
    requireReader(user);
    const scope = dataScope(user);
    id = id.toLowerCase();
    if (this.draining) throw new AppError(503, "inventory_shutdown", "Power Platform inventory refreshes are stopping for application shutdown.");
    requireProviderAdmissions();
    const reserved = this.active.get(id) ?? this.starting.get(id);
    if (reserved) {
      if (reserved.scope.tenantId !== scope.tenantId || reserved.scope.principalId !== scope.principalId) {
        throw new AppError(404, "not_found", "Inventory refresh job was not found.");
      }
      throw new AppError(409, "inventory_job_state", "Inventory refresh is already starting or running.");
    }
    if (new Set([...this.active.keys(), ...this.starting.keys()]).size >= maximumActiveRefreshes) {
      throw new AppError(429, "inventory_capacity", "At most four Power Platform inventory refreshes can run at once.");
    }
    const controller = new AbortController();
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    const validateCapability = this.dependencies.beginOperationValidation("powerPlatform.inventory.read", {
      tenantId: scope.tenantId, homeAccountId: scope.principalId,
    });
    const starting: StartingRefresh = {
      scope, controller,
      operation: Promise.resolve().then(() => this.startRefresh(scope, id, controller, validation, validateCapability, options))
        .finally(() => { if (this.starting.get(id) === starting) this.starting.delete(id); }),
    };
    this.starting.set(id, starting);
    return starting.operation;
  }

  private async startRefresh(scope: InventoryDataScope, id: string, controller: AbortController, validation: ReturnType<typeof beginAccountSessionValidation>, validateCapability: () => void, options: { retryFailed?: boolean }) {
    const startedAt = performance.now();
    let stage = "load_job";
    let ownedWaitingJob = false;
    let markedRunning = false;
    let dispatched = false;
    let signal = controller.signal;
    let execution: ReturnType<typeof createRefreshExecutionSignal> | undefined;
    let deadlineAt = Infinity;
    const assertCurrent = () => {
      signal.throwIfAborted();
      controller.signal.throwIfAborted();
      if (Date.now() >= deadlineAt) throw new DOMException("Inventory refresh deadline expired.", "TimeoutError");
      assertAccountSessionValidation(validation);
      validateCapability();
      requireProviderAdmissions();
    };
    try {
      assertCurrent();
      const admitted = await this.repository.getJobForExecution(scope, id);
      assertCurrent();
      const current = admitted?.job;
      if (!current) throw new AppError(404, "not_found", "Inventory refresh job was not found.");
      if (current.status !== "waiting_authorization") throw new AppError(409, "inventory_job_state", "Only a waiting inventory refresh can be started.");
      ownedWaitingJob = true;
      deadlineAt = admitted.deadlineAt.getTime();
      execution = createRefreshExecutionSignal(signal, Math.max(0, Math.min(refreshExecutionDeadlineMs, deadlineAt - Date.now())));
      signal = execution.signal;
      assertCurrent();
      stage = "revalidate_user";
      const freshUser = await interruptibleAuthorization(() => this.dependencies.revalidateUser(scope.tenantId, scope.principalId), signal);
      assertCurrent();
      let token = "";
      await this.dependencies.observeOperation("powerPlatform.inventory.read", freshUser, async () => {
        assertCurrent();
        stage = "authorization";
        requireSamePrincipal(scope, freshUser);
        requireReader(freshUser);
        requireSameQueryScope(current, freshUser);
        await interruptibleAuthorization(() => this.dependencies.requireAvailable("powerPlatform.inventory.read", freshUser, options), signal);
        assertCurrent();
        stage = "delegated_token";
        token = await interruptibleAuthorization(() => this.dependencies.delegatedToken(scope.tenantId, scope.principalId, "powerPlatform.inventory.read"), signal);
        assertCurrent();
        // Serialize the state change, not provider calls that would delay sign-out.
        await commitAccountSessionValidation(validation, async () => {
          assertCurrent();
          stage = "mark_running";
          markedRunning = await this.repository.markRunning(scope, id);
          if (!markedRunning) throw new AppError(409, "inventory_job_state", "Inventory refresh was already started or expired.");
        });
      }, { signal, clearOnSuccess: false });
      assertCurrent();
      operationalLog("info", "inventory_refresh_started", {
        jobId: id, durationMs: Math.round(performance.now() - startedAt),
        requestedTypeCount: current.requestedTypes.length, environmentScoped: Boolean(current.environmentScope),
      });
      stage = "dispatch";
      const operation = withTelemetryContext({ jobId: id }, () => this.run(scope, current, id, token, signal, validation, validateCapability))
        .finally(() => {
          execution?.dispose();
          if (this.active.get(id)?.operation === operation) this.active.delete(id);
        });
      this.active.set(id, { scope, controller, operation });
      dispatched = true;
      void operation.catch(error => {
        operationalLog("error", "inventory_refresh_status_failed", { jobId: id, ...errorTelemetry(error) });
      });
      const result = await this.repository.getJob(scope, id);
      assertCurrent();
      if (!result) throw new AppError(409, "inventory_job_expired", "The inventory refresh expired before its status could be returned.");
      return result;
    } catch (error) {
      let cause = error;
      try { assertCurrent(); } catch (currentError) { cause = currentError; }
      const expired = signal.aborted ? isTimeoutError(signal.reason) : !controller.signal.aborted && Date.now() >= deadlineAt;
      const failure = expired ? new AppError(409, "inventory_job_expired",
        "The inventory refresh deadline expired. Start a new refresh; saved data is unchanged.") : cause;
      operationalLog("warn", "inventory_refresh_start_failed", {
        jobId: id, stage, durationMs: Math.round(performance.now() - startedAt), ...errorTelemetry(failure),
      });
      if (markedRunning && !dispatched && (signal.aborted && !expired || isAuthorizationFailure(failure))) {
        if (signal.reason instanceof AppError && signal.reason.code === "read_job_cancelled") {
          await this.repository.cancel(scope, id);
        } else {
          await this.repository.markWaitingAuthorization(scope, id);
        }
      } else if (ownedWaitingJob && !dispatched && (!signal.aborted || expired) && !isAuthorizationFailure(failure)
        && (markedRunning || stage !== "mark_running" || expired)) {
        await this.repository.markFailed(scope, id, failureCode(failure), safeFailureMessage(failure));
      }
      if (!expired) assertCurrent();
      throw failure;
    } finally {
      if (!dispatched) execution?.dispose();
    }
  }

  async get(user: AuthenticatedUser, id: string) {
    requireReader(user);
    const scope = dataScope(user);
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    assertAccountSessionValidation(validation);
    try {
      const job = await this.repository.getJob(scope, id);
      assertAccountSessionValidation(validation);
      if (!job) throw new AppError(404, "not_found", "Inventory refresh job was not found.");
      return job;
    } catch (error) {
      assertAccountSessionValidation(validation);
      throw error;
    }
  }

  async cancel(user: AuthenticatedUser, id: string, cancellationReason: RefreshCancellationReason = "requested") {
    requireReader(user);
    const scope = dataScope(user);
    const validation = cancellationReason === "requested" ? beginAccountSessionValidation(scope.tenantId, scope.principalId) : undefined;
    const assertCurrent = () => { if (validation) assertAccountSessionValidation(validation); };
    assertCurrent();
    id = id.toLowerCase();
    try {
      const job = await this.repository.getJob(scope, id);
      assertCurrent();
      if (!job) throw new AppError(404, "not_found", "Inventory refresh job was not found.");
      // Cancellation must not queue behind a pending admission write.
      const cancelled = validation
        ? await this.repository.cancel(scope, id, cancellationReason, assertCurrent)
        : await this.repository.cancel(scope, id, cancellationReason);
      operationalLog("info", "inventory_refresh_cancel_requested", { jobId: id, status: cancelled?.status });
      const reason = new AppError(409, "read_job_cancelled", "Inventory refresh was cancelled.");
      this.starting.get(id)?.controller.abort(reason);
      this.active.get(id)?.controller.abort(reason);
      assertCurrent();
      if (!cancelled) throw new AppError(409, "inventory_job_expired", "The inventory refresh expired before its cancellation status could be returned.");
      return cancelled;
    } catch (error) {
      assertCurrent();
      throw error;
    }
  }

  async recover(admissionsOpen?: () => Promise<boolean>) {
    let count = 0;
    for (;;) {
      if (admissionsOpen && !await admissionsOpen()) break;
      const recovered = await this.repository.recoverInterrupted();
      count += recovered;
      if (!recovered) break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (count) operationalLog("warn", "inventory_refresh_recovered", { count });
    return count;
  }

  async drain() {
    this.draining = true;
    const refreshes = [...this.starting.values(), ...this.active.values()];
    const reason = new AppError(401, "interaction_required", "Application shutdown requires explicit inventory reauthorization.");
    for (const refresh of refreshes) refresh.controller.abort(reason);
    const results = await Promise.allSettled(refreshes.map(refresh => refresh.operation));
    const failure = results.find((result, index) => result.status === "rejected"
      && result.reason !== refreshes[index].controller.signal.reason);
    if (failure?.status === "rejected") throw failure.reason;
  }

  async waitForPrincipalAuthorization(scope: InventoryDataScope) {
    for (const refresh of [...this.starting.values(), ...this.active.values()]) {
      if (refresh.scope.tenantId === scope.tenantId && refresh.scope.principalId === scope.principalId) {
        refresh.controller.abort(new AppError(401, "interaction_required", "The signed-in account changed during inventory refresh."));
      }
    }
  }

  private async run(scope: InventoryDataScope, current: InventoryRefreshJob, id: string, token: string, signal: AbortSignal, validation: ReturnType<typeof beginAccountSessionValidation>, validateCapability: () => void) {
    const startedAt = performance.now();
    let stage = "query";
    let sourceAuthorized = false;
    let committed = false;
    let execution: ReturnType<typeof createRefreshExecutionSignal> | undefined;
    let deadlineAt = Infinity;
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (Date.now() >= deadlineAt) throw new DOMException("Inventory refresh deadline expired.", "TimeoutError");
      assertAccountSessionValidation(validation);
      validateCapability();
      requireProviderAdmissions();
    };
    try {
      assertCurrent();
      const queryTypes = inventoryQueryTypes(current.roleScope, current.requestedTypes);
      const input = await inventoryJobInput(this.repository.database, scope, "power_platform", id, {
        environmentId: current.environmentScope ?? undefined, resourceTypes: queryTypes,
      });
      deadlineAt = input.deadlineAt.getTime();
      execution = createRefreshExecutionSignal(signal, Math.max(0, Math.min(refreshExecutionDeadlineMs, deadlineAt - Date.now())));
      signal = execution.signal;
      assertCurrent();
      await this.dependencies.observeOperation("powerPlatform.inventory.read",
        { tenantId: scope.tenantId, homeAccountId: scope.principalId }, async () => {
        await this.dependencies.streams(this.repository.database).powerPlatformCatalog(input, token, queryTypes, {
        signal,
        assertCurrent,
        expectedTenantId: scope.tenantId,
        environmentId: current.environmentScope ?? undefined,
        roleScope: current.roleScope,
        getAccessToken: async () => {
          assertCurrent();
          const refreshed = await this.dependencies.delegatedToken(scope.tenantId, scope.principalId, "powerPlatform.inventory.read");
          assertCurrent();
          return refreshed;
        },
        onProgress: async progress => {
          assertCurrent();
          await this.repository.recordProgress(scope, id, progress.pages, progress.observedCount, progress.totalRecords);
          assertCurrent();
          operationalLog("info", "inventory_refresh_progress", { jobId: id, ...progress });
        },
        authorize: async () => {
          stage = sourceAuthorized ? "publication_authorization" : "collection_authorization";
          assertCurrent();
          const freshUser = await interruptibleAuthorization(() => this.dependencies.revalidateUser(scope.tenantId, scope.principalId), signal);
          assertCurrent();
          requireSamePrincipal(scope, freshUser);
          requireReader(freshUser);
          requireSameQueryScope(current, freshUser);
          await interruptibleAuthorization(() => this.dependencies.requireAvailable("powerPlatform.inventory.read", freshUser), signal);
          assertCurrent();
          sourceAuthorized = true;
          stage = "query";
        },
        commitPublication: operation => commitAccountSessionValidation(validation, async () => {
          assertCurrent();
          await operation();
        }),
        onCommitted: () => { committed = true; },
        completeJob: async (...args) => {
          assertCurrent();
          stage = "publication";
          await completeInventoryJob(input, "power_platform")(...args);
        },
        });
      }, { signal });
    } catch (error) {
      if (committed) {
        operationalLog("warn", "inventory_followup_failed", { jobId: id, stage, ...errorTelemetry(error, "inventory_reconciliation_pending") });
        return;
      }
      let cause = error;
      try { assertCurrent(); } catch (currentError) { cause = currentError; }
      const failure = isTimeoutError(cause) ? new AppError(504, "provider_timeout",
        `Power Platform inventory refresh exceeded its ${refreshExecutionDeadlineMs / 1_000}-second execution limit before complete publication. Retry the refresh.`) : cause;
      operationalLog("warn", "inventory_refresh_execution_failed", {
        jobId: id, stage, durationMs: Math.round(performance.now() - startedAt), ...errorTelemetry(failure, "provider_error"),
      });
      if (failure instanceof AppError && failure.code === "read_job_cancelled") {
        await this.repository.cancel(scope, id);
        operationalLog("info", "inventory_refresh_cancelled", { jobId: id, status: "cancelled" });
        return;
      }
      if (isAuthorizationFailure(failure)) {
        await this.repository.markWaitingAuthorization(scope, id);
        operationalLog("warn", "inventory_refresh_waiting_authorization", { jobId: id, ...errorTelemetry(failure), status: "waiting_authorization" });
        return;
      }
      const code = failureCode(failure);
      await this.repository.markFailed(scope, id, code, safeFailureMessage(failure));
      operationalLog("error", "inventory_refresh_failed", { jobId: id, status: "failed", errorCode: code, stage });
    } finally {
      if (committed) {
        try { await inventoryRuntime(this.repository.database).enqueue(scope); }
        catch (error) {
          operationalLog("warn", "inventory_followup_failed", { jobId: id, stage: "reconciliation", ...errorTelemetry(error, "inventory_reconciliation_pending") });
        }
        operationalLog("info", "inventory_refresh_succeeded", {
          jobId: id, status: "succeeded", queriedTypeCount: current.requestedTypes.length,
          environmentScoped: current.environmentScope !== null, durationMs: Math.round(performance.now() - startedAt),
        });
      }
      execution?.dispose();
    }
  }
}

export const powerPlatformInventory = new PowerPlatformInventoryService();

function requireSameQueryScope(job: InventoryRefreshJob, user: AuthenticatedUser) {
  const submitted = inventoryQueryTypes(job.roleScope, job.requestedTypes);
  const current = inventoryQueryTypes(inventoryRoleScope(user), job.requestedTypes);
  if (submitted.length !== current.length || submitted.some((type, index) => current[index] !== type)) {
    throw new AppError(409, "inventory_scope_changed", "The inventory resource-type scope changed. Submit a new refresh for the current scope.");
  }
}

function dataScope(user: AuthenticatedUser): InventoryDataScope {
  if (!user.tenantId) throw AppError.unauthorized("The current session does not have a tenant scope.");
  return { tenantId: user.tenantId, principalId: user.homeAccountId };
}

function requireReader(user: AuthenticatedUser) {
  if (!hasAppRole(user.roles, "AgentControl.Viewer")) throw new AppError(403, "missing_internal_role", "Power Platform inventory refresh requires the Viewer role.");
}

function requireSamePrincipal(scope: InventoryDataScope, user: AuthenticatedUser) {
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The signed-in account changed during inventory refresh.");
}

function isAuthorizationFailure(error: unknown) {
  return error instanceof AppError && (dataSyncFailureStatus(error.code, error.status) === "waiting_authorization"
    || ["maintenance", "provider_requalification_required"].includes(error.code));
}

function failureCode(error: unknown) {
  return error instanceof AppError
    ? error.status === 403 && dataSyncFailureStatus(error.code) === "failed" ? "missing_permission" : error.code
    : "provider_error";
}

function safeFailureMessage(error: unknown) {
  if (error instanceof AppError && error.code === "missing_internal_role") {
    return "The Agent Control Viewer or Admin application role is required. Review application role assignments; Microsoft provider consent does not grant this role. Saved data is unchanged.";
  }
  if (error instanceof AppError && dataSyncFailureStatus(error.code, error.status) === "permission_required") {
    return "Required Microsoft read permission or provider role is unavailable. Review Permissions; signing in again does not grant permissions. Saved data is unchanged.";
  }
  if (error instanceof AppError && ["provider_error", "provider_timeout", "provider_throttled", "provider_schema", "provider_result_limit", "incomplete_inventory_coverage", "scope_mismatch", "inventory_scope_changed", "inventory_job_expired"].includes(error.code)) return error.message.slice(0, 1024);
  return "Power Platform inventory refresh failed before complete publication.";
}

async function interruptibleAuthorization<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([operation(), cancelled]); }
  finally { signal.removeEventListener("abort", onAbort); }
}