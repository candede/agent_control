import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { PowerPlatformInventoryRepository, type InventoryDataScope, type InventoryRefreshInput } from "../db/powerPlatformInventory.js";
import { beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError, errorTelemetry, isTimeoutError } from "../errors.js";
import type { AuthenticatedUser } from "../types/session.js";
import { hasAppRole } from "../types/capability.js";
import type { InventoryRefreshJob } from "../types/powerPlatformInventory.js";
import { capabilities } from "./capabilities.js";
import { inventoryQueryTypes, inventoryRoleScope } from "./inventoryRoleScope.js";
import { PowerPlatformResourceQueryClient, powerPlatformInventoryQueryDeadlineMs } from "./powerPlatformResourceQuery.js";
import { operationalLog, withTelemetryContext } from "./telemetry.js";

type InventoryRefreshDependencies = {
  delegatedToken: typeof acquireDelegatedToken;
  revalidateUser: typeof revalidateAuthenticatedUser;
  requireAvailable: typeof capabilities.requireAvailable;
  query: PowerPlatformResourceQueryClient["query"];
};

const resourceQuery = new PowerPlatformResourceQueryClient();
const defaultDependencies: InventoryRefreshDependencies = {
  delegatedToken: acquireDelegatedToken,
  revalidateUser: revalidateAuthenticatedUser,
  requireAvailable: capabilities.requireAvailable.bind(capabilities),
  query: resourceQuery.query.bind(resourceQuery),
};

type ActiveRefresh = { scope: InventoryDataScope; controller: AbortController; operation: Promise<void> };
const maximumActiveRefreshes = 4;
const refreshExecutionDeadlineMs = powerPlatformInventoryQueryDeadlineMs + 30_000;

export class PowerPlatformInventoryService {
  private readonly active = new Map<string, ActiveRefresh>();
  private starting = 0;

  constructor(
    private readonly repository = new PowerPlatformInventoryRepository(),
    private readonly dependencies: InventoryRefreshDependencies = defaultDependencies,
  ) {}

  async submit(user: AuthenticatedUser, input: Omit<InventoryRefreshInput, "roleScope">) {
    requireReader(user);
    const scope = dataScope(user);
    const roleScope = inventoryRoleScope(user);
    const job = await this.repository.submit(scope, { ...input, roleScope });
    operationalLog("info", "inventory_refresh_submitted", {
      jobId: job.id, status: job.status, requestedTypeCount: job.requestedTypes.length,
      environmentScoped: Boolean(job.environmentScope),
    });
    return job;
  }

  async start(user: AuthenticatedUser, id: string) {
    requireReader(user);
    if (this.active.size + this.starting >= maximumActiveRefreshes) throw new AppError(429, "inventory_capacity", "At most four Power Platform inventory refreshes can run at once.");
    this.starting += 1;
    const scope = dataScope(user);
    const startedAt = performance.now();
    let stage = "load_job";
    try {
      const current = await this.repository.getJob(scope, id);
      if (!current) throw new AppError(404, "not_found", "Inventory refresh job was not found.");
      if (current.status !== "waiting_authorization") throw new AppError(409, "inventory_job_state", "Only a waiting inventory refresh can be started.");
      const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
      stage = "revalidate_user";
      const freshUser = await this.dependencies.revalidateUser(scope.principalId);
      let token = "";
      await commitAccountSessionValidation(validation, async () => {
        stage = "authorization";
        requireSamePrincipal(scope, freshUser);
        requireReader(freshUser);
        requireSameQueryScope(current, freshUser);
        await this.dependencies.requireAvailable("powerPlatform.inventory.read", freshUser);
        stage = "delegated_token";
        token = await this.dependencies.delegatedToken(scope.principalId, "powerPlatform.inventory.read");
        stage = "mark_running";
        if (!await this.repository.markRunning(scope, id)) throw new AppError(409, "inventory_job_state", "Inventory refresh was already started or expired.");
      });
      operationalLog("info", "inventory_refresh_started", {
        jobId: id, durationMs: Math.round(performance.now() - startedAt),
        requestedTypeCount: current.requestedTypes.length, environmentScoped: Boolean(current.environmentScope),
      });
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(refreshExecutionDeadlineMs)]);
      stage = "dispatch";
      const operation = withTelemetryContext({ jobId: id }, () => this.run(scope, current, id, token, signal))
        .finally(() => { if (this.active.get(id)?.operation === operation) this.active.delete(id); });
      this.active.set(id, { scope, controller, operation });
      return (await this.repository.getJob(scope, id))!;
    } catch (error) {
      operationalLog("warn", "inventory_refresh_start_failed", {
        jobId: id, stage, durationMs: Math.round(performance.now() - startedAt), ...errorTelemetry(error),
      });
      throw error;
    } finally {
      this.starting -= 1;
    }
  }

  async get(user: AuthenticatedUser, id: string) {
    const job = await this.repository.getJob(dataScope(user), id);
    if (!job) throw new AppError(404, "not_found", "Inventory refresh job was not found.");
    return job;
  }

  async cancel(user: AuthenticatedUser, id: string) {
    requireReader(user);
    const scope = dataScope(user);
    const job = await this.repository.getJob(scope, id);
    if (!job) throw new AppError(404, "not_found", "Inventory refresh job was not found.");
    const cancelled = await this.repository.cancel(scope, id);
    operationalLog("info", "inventory_refresh_cancel_requested", { jobId: id, status: cancelled?.status });
    this.active.get(id)?.controller.abort(new AppError(409, "read_job_cancelled", "Inventory refresh was cancelled."));
    return cancelled!;
  }

  async recover() {
    const count = await this.repository.recoverInterrupted();
    if (count) operationalLog("warn", "inventory_refresh_recovered", { count });
    return count;
  }

  async drain() {
    const active = [...this.active.values()];
    for (const refresh of active) refresh.controller.abort(new AppError(401, "interaction_required", "Application shutdown requires explicit inventory reauthorization."));
    const results = await Promise.allSettled(active.map(refresh => refresh.operation));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  async waitForPrincipalAuthorization(scope: InventoryDataScope) {
    const active = [...this.active.values()].filter(refresh => refresh.scope.tenantId === scope.tenantId && refresh.scope.principalId === scope.principalId);
    for (const refresh of active) refresh.controller.abort(new AppError(401, "interaction_required", "The signed-in account changed during inventory refresh."));
  }

  private async run(scope: InventoryDataScope, current: InventoryRefreshJob, id: string, token: string, signal: AbortSignal) {
    const startedAt = performance.now();
    let stage = "query";
    try {
      const queryTypes = inventoryQueryTypes(current.roleScope, current.requestedTypes);
      const result = await this.dependencies.query(token, queryTypes, {
        signal,
        expectedTenantId: scope.tenantId,
        environmentId: current.environmentScope ?? undefined,
        onProgress: async progress => {
          await this.repository.recordProgress(scope, id, progress.pages, progress.observedCount, progress.totalRecords);
          operationalLog("info", "inventory_refresh_progress", { jobId: id, ...progress });
        },
      });
      stage = "publication_authorization";
      signal.throwIfAborted();
      const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
      const freshUser = await this.dependencies.revalidateUser(scope.principalId);
      signal.throwIfAborted();
      await commitAccountSessionValidation(validation, async () => {
        signal.throwIfAborted();
        requireSamePrincipal(scope, freshUser);
        requireReader(freshUser);
        requireSameQueryScope(current, freshUser);
        await this.dependencies.requireAvailable("powerPlatform.inventory.read", freshUser);
        signal.throwIfAborted();
        stage = "publication";
        await this.repository.publish(scope, id, result);
      });
      operationalLog("info", "inventory_refresh_succeeded", {
        jobId: id, status: "succeeded", pages: result.pages, observedCount: result.resources.length,
        totalRecords: result.totalRecords, queriedTypeCount: result.queriedTypes.length,
        environmentScoped: result.environmentScope !== null, durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      const failure = isTimeoutError(error) ? new AppError(504, "provider_timeout",
        `Power Platform inventory refresh exceeded its ${refreshExecutionDeadlineMs / 1_000}-second execution limit before complete publication. Retry the refresh.`) : error;
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
      const code = failure instanceof AppError ? failure.code : "provider_error";
      await this.repository.markFailed(scope, id, code, safeFailureMessage(failure));
      operationalLog("error", "inventory_refresh_failed", { jobId: id, status: "failed", errorCode: code, stage });
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
  return error instanceof AppError && (error.status === 401 || error.status === 403 || ["interaction_required", "authorization_expired", "missing_internal_role", "missing_permission"].includes(error.code));
}

function safeFailureMessage(error: unknown) {
  if (error instanceof AppError && ["provider_error", "provider_timeout", "provider_schema", "provider_result_limit", "incomplete_inventory_coverage", "scope_mismatch", "inventory_scope_changed"].includes(error.code)) return error.message.slice(0, 1024);
  return "Power Platform inventory refresh failed before complete publication.";
}