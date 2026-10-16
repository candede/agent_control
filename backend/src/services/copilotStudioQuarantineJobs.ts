import { randomUUID } from "node:crypto";
import { acquireAuthorizedToken, revalidateAuthorizedUser } from "../auth/msal.js";
import {
  CopilotStudioQuarantineRepository,
  type QuarantineItemRow,
  type QuarantineJobRow,
  type QuarantineLease,
  type QuarantineScope,
} from "../db/copilotStudioQuarantine.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError, errorTelemetry } from "../errors.js";
import type { QuarantineAuthority, QuarantineReconciliationResult } from "../types/copilotStudioQuarantine.js";
import { capabilities } from "./capabilities.js";
import { CopilotStudioQuarantineClient, verifyCopilotStudioQuarantineConverged } from "./copilotStudioQuarantine.js";
import { maintenanceActive } from "./maintenance.js";
import { requireProviderAdmissions } from "./operationalState.js";
import { operationalLog } from "./telemetry.js";
import { InventoryRuntime } from "./inventoryRuntime.js";

type QuarantineAuthorization = { accessToken: string; authority: QuarantineAuthority };
type QuarantineAuthorizer = (scope: QuarantineScope, signal?: AbortSignal) => Promise<QuarantineAuthorization>;
type QuarantineProvider = Pick<CopilotStudioQuarantineClient, "getStatus" | "setQuarantine">;

export const copilotStudioQuarantineJobs = new CopilotStudioQuarantineRepository();
const processOwner = randomUUID();
const executionDeadlineMs = 30_000;
const reconciliationDeadlineMs = 15_000;
const maximumActiveJobs = 2;
const active = new Map<Promise<void>, { jobId: string; scope: QuarantineScope; controller: AbortController }>();

export function launchCopilotStudioQuarantineJob(id: string, scope: QuarantineScope, resume = false) {
  requireProviderAdmissions();
  if ([...active.values()].some(value => value.jobId === id.toLowerCase()
    && value.scope.tenantId === scope.tenantId && value.scope.principalId === scope.principalId)) return;
  if (active.size >= maximumActiveJobs) throw new AppError(429, "workers_busy", "Two quarantine jobs are already running; retry after they finish.");
  const controller = new AbortController();
  const operation = runCopilotStudioQuarantineJob(id, scope, resume, copilotStudioQuarantineJobs, new CopilotStudioQuarantineClient(), authorizeQuarantine, controller.signal)
    .finally(() => active.delete(operation));
  void operation.catch(error => operationalLog("error", "quarantine_job_stopped", {
    jobId: id, outcome: "requires_review", ...errorTelemetry(error),
  }));
  active.set(operation, { jobId: id.toLowerCase(), scope, controller });
}

export async function runTrackedCopilotStudioQuarantineJob(
  id: string,
  scope: QuarantineScope,
  repository = copilotStudioQuarantineJobs,
  provider: QuarantineProvider = new CopilotStudioQuarantineClient(),
  authorize: QuarantineAuthorizer = authorizeQuarantine,
) {
  requireProviderAdmissions();
  if (active.size >= maximumActiveJobs) throw new AppError(429, "workers_busy", "Two quarantine jobs are already running; retry after they finish.");
  const controller = new AbortController();
  const operation = runCopilotStudioQuarantineJob(id, scope, false, repository, provider, authorize, controller.signal)
    .finally(() => active.delete(operation));
  active.set(operation, { jobId: id.toLowerCase(), scope, controller });
  return operation;
}

export async function runCopilotStudioQuarantineJob(
  id: string,
  scope: QuarantineScope,
  resume = false,
  repository = copilotStudioQuarantineJobs,
  provider: QuarantineProvider = new CopilotStudioQuarantineClient(),
  authorize: QuarantineAuthorizer = authorizeQuarantine,
  externalSignal?: AbortSignal,
) {
  requireProviderAdmissions();
  const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
  const principal = { tenantId: scope.tenantId, homeAccountId: scope.principalId };
  const assertAuthority = capabilities.beginOperationValidation("powerPlatform.quarantine.manage", principal);
  const assertCurrent = () => {
    requireProviderAdmissions();
    externalSignal?.throwIfAborted();
    assertAccountSessionValidation(validation);
    assertAuthority();
  };
  const authorizeJob = async (owner: QuarantineScope, signal = AbortSignal.timeout(executionDeadlineMs)) => {
    const authorizationSignal = externalSignal ? AbortSignal.any([externalSignal, signal]) : signal;
    assertCurrent();
    const result = await interruptibleAuthorization(() => authorize(owner, authorizationSignal), authorizationSignal);
    assertCurrent();
    return result;
  };
  const currentJob = await repository.get(scope, id);
  if (!currentJob) throw new AppError(404, "not_found", "Quarantine job was not found.");
  if (resume && currentJob.isCanary) throw new AppError(409, "not_resumable", "Quarantine canary jobs can run only within their original approval-controlled cycle.");
  let authorization: QuarantineAuthorization;
  try {
    authorization = await capabilities.observeOperation("powerPlatform.quarantine.manage", principal,
      () => authorizeJob(scope), { signal: externalSignal, clearOnSuccess: false });
    assertCurrent();
  }
  catch (error) {
    await persistFailure(id, "authorization_wait", error, () => repository.waitForAuthorization(scope, id));
    if (externalSignal?.aborted) return;
    throw error;
  }
  const lease = await repository.claim(scope, id, processOwner, resume);
  if (!lease) return;
  const inventory = new InventoryRuntime(repository.database, async (owner, signal) => {
    signal.throwIfAborted();
    await authorizeJob(owner, signal);
    signal.throwIfAborted();
  }, assertCurrent);
  let executionFailed = false;
  try {
    for (let index = 0; index < 25 && !maintenanceActive() && !externalSignal?.aborted; index += 1) {
      requireProviderAdmissions();
      try {
        authorization = await capabilities.observeOperation("powerPlatform.quarantine.manage", principal,
          () => authorizeJob(scope), { signal: externalSignal, clearOnSuccess: false });
        assertCurrent();
      }
      catch (error) {
        await persistFailure(id, "authorization_wait", error, () => repository.waitForAuthorization(scope, id));
        return;
      }
      const publicationSignal = externalSignal
        ? AbortSignal.any([externalSignal, AbortSignal.timeout(executionDeadlineMs)])
        : AbortSignal.timeout(executionDeadlineMs);
      await inventory.settleControls(scope, publicationSignal);
      assertCurrent();
      publicationSignal.throwIfAborted();
      const current = await repository.beginItem(lease);
      if (!current) break;
      const { job, item } = current;
      const itemSignal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(executionDeadlineMs)]) : AbortSignal.timeout(executionDeadlineMs);
      let signal = itemSignal;
      const requireCurrentItem = () => {
        requireProviderAdmissions();
        signal.throwIfAborted();
        assertAccountSessionValidation(validation);
        assertAuthority();
      };
      const getStatus = async (...args: Parameters<QuarantineProvider["getStatus"]>) => {
        requireCurrentItem();
        const observed = await provider.getStatus(args[0], args[1], { ...args[2], assertCurrent: requireCurrentItem });
        requireCurrentItem();
        return observed;
      };
      let sent = false, finished = false;
      try {
        requireAuthority(job, authorization.authority);
        const executeItem = () => capabilities.observeOperation("powerPlatform.quarantine.manage", principal, () => repository.withTargetLock(lease, item, async lockSignal => {
          signal = AbortSignal.any([itemSignal, lockSignal]);
          const target = { environmentId: item.environment_id, botId: item.bot_id };
          const options = { correlationId: item.correlation_id!, signal };
          await repository.assertDispatchReady(lease, item, authorization.authority);
          const before = await getStatus(authorization.accessToken, target, options);
          if (before.isBotQuarantined === item.requested_state) {
            await finishAuthorized(repository, lease, job, item, "skipped", { observed: before, readbackCount: 1 }, scope, authorizeJob, signal, validation, requireCurrentItem, inventory);
            finished = true;
            return;
          }
          requireFrozenPrestate(item, before);
          const dispatchAuthorization = await authorizeJob(scope, signal);
          requireAuthority(job, dispatchAuthorization.authority);
          await repository.assertDispatchReady(lease, item, dispatchAuthorization.authority);
          const immediate = await getStatus(dispatchAuthorization.accessToken, target, options);
          if (immediate.isBotQuarantined === item.requested_state) {
            await finishAuthorized(repository, lease, job, item, "skipped", { observed: immediate, readbackCount: 1 }, scope, authorizeJob, signal, validation, requireCurrentItem, inventory);
            finished = true;
            return;
          }
          requireFrozenPrestate(item, immediate);
          signal.throwIfAborted();
          await commitAccountSessionValidation(validation, async () => {
            requireProviderAdmissions();
            signal.throwIfAborted();
            await repository.markSent(lease, item, dispatchAuthorization.authority, signal, requireCurrentItem);
          });
          sent = true;
          requireCurrentItem();
          await provider.setQuarantine(dispatchAuthorization.accessToken, target, item.requested_state, options);
          const verified = await verifyCopilotStudioQuarantineConverged({ getStatus }, dispatchAuthorization.accessToken, target, item.requested_state, options);
          await finishAuthorized(repository, lease, job, item, "succeeded", { observed: verified.status, readbackCount: verified.readbackCount }, scope, authorizeJob, signal, validation, requireCurrentItem, inventory);
          finished = true;
        }), { signal: itemSignal, clearOnSuccess: () => sent });
        for (let publicationAttempt = 0; ; publicationAttempt++) {
          try {
            await executeItem();
            break;
          } catch (error) {
            if (sent || publicationAttempt >= 2 || !(error instanceof AppError) || error.code !== "quarantine_target_unavailable") throw error;
            requireCurrentItem();
            await inventory.settleControls(scope, itemSignal);
            requireCurrentItem();
          }
        }
      } catch (caught) {
        if (finished) throw caught;
        if (caught instanceof AppError && caught.code === "lease_lost") throw caught;
        const error: unknown = signal.aborted ? signal.reason : caught;
        if (!sent && (isAuthorizationFailure(error) || isAdmissionFailure(error))) {
          await persistFailure(id, "authorization_pause", error, () => repository.pauseItemForAuthorization(lease, item));
          return;
        }
        if (sent) {
          operationalLog("error", "quarantine_write_uncertain", { jobId: id, outcome: "requires_reconciliation" });
        } else if (isDeadlineExceeded(error)) {
          operationalLog("error", "quarantine_job_stopped", { jobId: id, outcome: "deadline_exceeded" });
        }
        const failure = failureEvidence(error);
        const outcome = sent ? "inconclusive" : error instanceof AppError && ["cancelled", "shutdown", "maintenance"].includes(error.code) ? "cancelled" : "failed";
        const evidence = {
          errorCode: isDeadlineExceeded(error) ? "provider_timeout" : error instanceof AppError ? error.code : "provider_error",
          message: sent ? "Provider write outcome is inconclusive; use GET reconciliation and never replay this item." : "The quarantine item stopped before provider dispatch.",
          ...failure,
        };
        await persistFailure(id, "terminal_item", error, () => failure.observed
          ? repository.finishItem(lease, item, outcome, evidence, signal, requireCurrentItem)
          : repository.finishItem(lease, item, outcome, evidence));
        if (isAdmissionFailure(error) || externalSignal?.aborted) return;
      }
    }
  } catch (error) {
    executionFailed = true;
    throw error;
  } finally {
    try { await repository.release(lease); }
    catch (error) {
      if (!(error instanceof AppError && error.code === "lease_lost")) {
        if (!executionFailed) throw error;
        operationalLog("error", "quarantine_job_cleanup_failed", { jobId: id, stage: "release", outcome: "requires_review", ...errorTelemetry(error) });
      }
    }
  }
}

export async function reconcileCopilotStudioQuarantineJob(
  id: string,
  scope: QuarantineScope,
  repository = copilotStudioQuarantineJobs,
  provider: Pick<CopilotStudioQuarantineClient, "getStatus"> = new CopilotStudioQuarantineClient(),
  authorize: QuarantineAuthorizer = authorizeQuarantine,
): Promise<QuarantineReconciliationResult> {
  requireProviderAdmissions();
  const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
  const assertAuthority = capabilities.beginOperationValidation("powerPlatform.quarantine.manage",
    { tenantId: scope.tenantId, homeAccountId: scope.principalId });
  const assertCurrent = () => {
    requireProviderAdmissions();
    assertAccountSessionValidation(validation);
    assertAuthority();
  };
  const context = await repository.reconciliationItems(scope, id);
  assertCurrent();
  if (!context) throw new AppError(404, "not_found", "Quarantine job was not found.");
  const authorizeJob = async (owner: QuarantineScope, signal = AbortSignal.timeout(reconciliationDeadlineMs)) => {
    assertCurrent();
    const authorization = await interruptibleAuthorization(() => authorize(owner, signal), signal);
    assertCurrent();
    requireAuthority(context.job, authorization.authority);
    return authorization;
  };
  const inventory = new InventoryRuntime(repository.database, async (owner, signal) => {
    await authorizeJob(owner, signal);
    signal.throwIfAborted();
  }, assertCurrent);
  const errors: Array<{ resourceNativeId: string; message: string }> = [];
  for (const item of context.items) {
    requireProviderAdmissions();
    assertAccountSessionValidation(validation);
    assertAuthority();
    let published = false;
    try {
      const deadline = AbortSignal.timeout(reconciliationDeadlineMs);
      const authorization = await authorizeJob(scope, deadline);
      await inventory.settleControls(scope, deadline);
      await repository.withReconciliationLock(scope, item, async lockSignal => {
        const signal = AbortSignal.any([deadline, lockSignal]);
        const assertPublication = () => {
          requireProviderAdmissions();
          signal.throwIfAborted();
          assertAccountSessionValidation(validation);
          assertAuthority();
        };
        await repository.assertReconciliationTarget(scope, item);
        assertPublication();
        const observed = await provider.getStatus(authorization.accessToken, { environmentId: item.environment_id, botId: item.bot_id },
          { correlationId: item.correlation_id ?? randomUUID(), signal, assertCurrent: assertPublication });
        assertPublication();
        await authorizeJob(scope, signal);
        signal.throwIfAborted();
        await commitAccountSessionValidation(validation, async () => {
          assertPublication();
          if (observed.isBotQuarantined === item.requested_state) {
            await repository.recordReconciliation(scope, context.job, item, "verified_applied", observed, "Provider GET reconciliation verified that the confirmed quarantine mutation was applied.", signal, assertPublication);
          } else if (observed.isBotQuarantined === item.prestate && observed.lastUpdateTimeUtc === item.prestate_provider_updated_at) {
            await repository.recordReconciliation(scope, context.job, item, "verified_not_applied", observed, "Provider GET reconciliation verified the exact original state and timestamp. A new explicit confirmation is required before retry.", signal, assertPublication);
          } else {
            await repository.recordReconciliation(scope, context.job, item, "conflict", observed, "Provider GET reconciliation found an intervening external change. Automatic retry or inversion is prohibited.", signal, assertPublication);
          }
        });
        published = true;
      });
    } catch (error) {
      if (published) throw error;
      errors.push({ resourceNativeId: item.resource_native_id, message: "GET reconciliation could not be completed; no provider state was published." });
    }
  }
  await authorizeJob(scope);
  await inventory.settleControls(scope, AbortSignal.timeout(reconciliationDeadlineMs));
  assertCurrent();
  const current = await repository.get(scope, id);
  assertCurrent();
  if (!current) throw new AppError(404, "not_found", "Quarantine job was not found.");
  return { ...current, reconciliation: { attempted: context.items.length, failed: errors.length, errors } };
}

export async function cancelCopilotStudioQuarantineJob(
  scope: QuarantineScope,
  id: string,
  repository = copilotStudioQuarantineJobs,
) {
  const job = await repository.cancel(scope, id);
  if (job) {
    for (const running of active.values()) {
      if (running.jobId === id.toLowerCase() && running.scope.tenantId === scope.tenantId && running.scope.principalId === scope.principalId) {
        running.controller.abort(new AppError(409, "cancelled", "The quarantine job was cancelled."));
      }
    }
  }
  return job;
}

export async function pauseCopilotStudioQuarantineForPrincipal(scope: QuarantineScope) {
  for (const value of active.values()) {
    if (value.scope.tenantId === scope.tenantId && value.scope.principalId === scope.principalId) value.controller.abort(new AppError(401, "interaction_required", "The signed-in account changed during quarantine work."));
  }
  await copilotStudioQuarantineJobs.waitForAuthorization(scope);
}

export async function drainCopilotStudioQuarantineJobs() {
  const current = [...active.entries()];
  for (const [, value] of current) value.controller.abort(new AppError(503, "shutdown", "Application shutdown stopped quarantine work."));
  const results = await Promise.allSettled(current.map(([operation]) => operation));
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

async function authorizeQuarantine(scope: QuarantineScope, signal?: AbortSignal): Promise<QuarantineAuthorization> {
  const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
  const assertAuthority = capabilities.beginOperationValidation("powerPlatform.quarantine.manage",
    { tenantId: scope.tenantId, homeAccountId: scope.principalId });
  const assertCurrent = () => {
    signal?.throwIfAborted();
    requireProviderAdmissions();
    assertAccountSessionValidation(validation);
    assertAuthority();
  };
  assertCurrent();
  const user = await revalidateAuthorizedUser(scope.tenantId, scope.principalId);
  assertCurrent();
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The quarantine actor no longer matches the signed-in account.");
  await capabilities.requireAvailable("powerPlatform.quarantine.manage", user);
  assertCurrent();
  const authority = await capabilities.quarantineAuthorityContext(user);
  assertCurrent();
  const accessToken = await acquireAuthorizedToken(scope.tenantId, scope.principalId, "powerPlatform.quarantine.manage");
  assertCurrent();
  return { accessToken, authority };
}

async function interruptibleAuthorization<T>(authorize: () => Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const authorization = await Promise.race([authorize(), interrupted]);
    signal.throwIfAborted();
    return authorization;
  } finally { signal.removeEventListener("abort", abort); }
}

async function persistFailure(id: string, stage: string, primaryError: unknown, persist: () => Promise<unknown>) {
  try { await persist(); }
  catch (error) {
    operationalLog("error", "quarantine_job_cleanup_failed", { jobId: id, stage, outcome: "requires_review", ...errorTelemetry(error) });
    throw primaryError;
  }
}

async function finishAuthorized(
  repository: CopilotStudioQuarantineRepository,
  lease: QuarantineLease,
  job: QuarantineJobRow,
  item: QuarantineItemRow,
  outcome: "succeeded" | "skipped",
  evidence: Parameters<CopilotStudioQuarantineRepository["finishItem"]>[3],
  scope: QuarantineScope,
  authorize: QuarantineAuthorizer,
  signal: AbortSignal,
  validation: ReturnType<typeof beginAccountSessionValidation>,
  assertPublication: () => void,
  inventory: InventoryRuntime,
) {
  for (let publicationAttempt = 0; ; publicationAttempt++) {
    assertPublication();
    const authorization = await authorize(scope, signal);
    requireAuthority(job, authorization.authority);
    signal.throwIfAborted();
    try {
      await commitAccountSessionValidation(validation, async () => {
        assertPublication();
        await repository.finishItem(lease, item, outcome, evidence, signal, assertPublication);
      });
      return;
    } catch (error) {
      if (publicationAttempt >= 2 || !(error instanceof AppError) || error.code !== "quarantine_target_unavailable") throw error;
      await inventory.settleControls(scope, signal);
    }
  }
}

function requireAuthority(job: QuarantineJobRow, authority: QuarantineAuthority) {
  if (job.contract_revision !== authority.contractRevision || job.permission_revision !== authority.permissionRevision || Number(job.configuration_revision) !== authority.configurationRevision) {
    throw new AppError(409, "quarantine_authority_changed", "Quarantine contract, permission, or configuration authority changed after confirmation.");
  }
}

function requireFrozenPrestate(item: QuarantineItemRow, observed: { isBotQuarantined: boolean; lastUpdateTimeUtc: string }) {
  if (observed.isBotQuarantined !== item.prestate || observed.lastUpdateTimeUtc !== item.prestate_provider_updated_at) {
    throw new AppError(409, "quarantine_prestate_conflict", "The direct provider quarantine state or provider timestamp changed after confirmation. No write was dispatched.");
  }
}

function failureEvidence(error: unknown) {
  const details = error instanceof AppError && error.details && typeof error.details === "object" ? error.details as { lastStatus?: unknown; readbackCount?: unknown } : undefined;
  return {
    ...(isStatus(details?.lastStatus) ? { observed: details.lastStatus } : {}),
    ...(typeof details?.readbackCount === "number" ? { readbackCount: details.readbackCount } : {}),
  };
}

function isStatus(value: unknown): value is Parameters<CopilotStudioQuarantineRepository["recordObservation"]>[2] {
  if (!value || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  return typeof status.environmentId === "string" && typeof status.botId === "string" && typeof status.isBotQuarantined === "boolean"
    && typeof status.lastUpdateTimeUtc === "string" && typeof status.observedAt === "string" && typeof status.correlationId === "string";
}

function isAuthorizationFailure(error: unknown) {
  return error instanceof AppError && (error.status === 401 || error.status === 403 || ["interaction_required", "authorization_expired", "missing_permission", "missing_internal_role", "missing_role", "capability_unavailable", "unauthorized", "quarantine_authority_changed"].includes(error.code));
}

function isAdmissionFailure(error: unknown) {
  return error instanceof AppError && error.code === "maintenance";
}

function isDeadlineExceeded(error: unknown) {
  return error instanceof Error && error.name === "TimeoutError"
    || error instanceof AppError && error.code === "provider_timeout";
}