import { randomUUID } from "node:crypto";
import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import {
  CopilotStudioQuarantineRepository,
  type QuarantineItemRow,
  type QuarantineJobRow,
  type QuarantineLease,
  type QuarantineScope,
} from "../db/copilotStudioQuarantine.js";
import { beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { QuarantineAuthority } from "../types/copilotStudioQuarantine.js";
import { capabilities } from "./capabilities.js";
import { CopilotStudioQuarantineClient, verifyCopilotStudioQuarantineConverged } from "./copilotStudioQuarantine.js";
import { maintenanceActive } from "./maintenance.js";
import { requireProviderAdmissions } from "./operationalState.js";
import { operationalLog } from "./telemetry.js";

export type QuarantineAuthorization = { accessToken: string; authority: QuarantineAuthority };
type QuarantineAuthorizer = (scope: QuarantineScope) => Promise<QuarantineAuthorization>;
type QuarantineProvider = Pick<CopilotStudioQuarantineClient, "getStatus" | "setQuarantine">;

export const copilotStudioQuarantineJobs = new CopilotStudioQuarantineRepository();
const processOwner = randomUUID();
const executionDeadlineMs = 30_000;
const reconciliationDeadlineMs = 15_000;
const maximumActiveJobs = 2;
const active = new Map<string, { scope: QuarantineScope; controller: AbortController; operation: Promise<void> }>();

export function launchCopilotStudioQuarantineJob(id: string, scope: QuarantineScope, resume = false) {
  requireProviderAdmissions();
  if (active.has(id)) return;
  if (active.size >= maximumActiveJobs) throw new AppError(429, "workers_busy", "Two quarantine jobs are already running; retry after they finish.");
  const controller = new AbortController();
  const operation = runCopilotStudioQuarantineJob(id, scope, resume, copilotStudioQuarantineJobs, new CopilotStudioQuarantineClient(), authorizeQuarantine, controller.signal)
    .catch(() => operationalLog("error", "quarantine_job_stopped", { jobId: id, outcome: "requires_review" }))
    .finally(() => { if (active.get(id)?.operation === operation) active.delete(id); });
  active.set(id, { scope, controller, operation });
}

export async function runTrackedCopilotStudioQuarantineJob(
  id: string,
  scope: QuarantineScope,
  repository = copilotStudioQuarantineJobs,
  provider: QuarantineProvider = new CopilotStudioQuarantineClient(),
  authorize: QuarantineAuthorizer = authorizeQuarantine,
) {
  if (active.size >= maximumActiveJobs) throw new AppError(429, "workers_busy", "Two quarantine jobs are already running; retry after they finish.");
  const controller = new AbortController();
  const operation = runCopilotStudioQuarantineJob(id, scope, false, repository, provider, authorize, controller.signal)
    .finally(() => { if (active.get(id)?.operation === operation) active.delete(id); });
  active.set(id, { scope, controller, operation });
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
  if (!await repository.get(scope, id)) throw new AppError(404, "not_found", "Quarantine job was not found.");
  let authorization: QuarantineAuthorization;
  try { authorization = await authorize(scope); }
  catch (error) { await repository.waitForAuthorization(scope, id); throw error; }
  const lease = await repository.claim(scope, id, processOwner, resume);
  if (!lease) return;
  try {
    for (let index = 0; index < 25 && !maintenanceActive(); index += 1) {
      try { authorization = await authorize(scope); }
      catch {
        await repository.waitForAuthorization(scope, id);
        return;
      }
      const current = await repository.beginItem(lease);
      if (!current) break;
      const { job, item } = current;
      const signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(executionDeadlineMs)]) : AbortSignal.timeout(executionDeadlineMs);
      let sent = false;
      try {
        requireAuthority(job, authorization.authority);
        await repository.withTargetLock(lease, item, async () => {
          const target = { environmentId: item.environment_id, botId: item.bot_id };
          const options = { correlationId: item.correlation_id!, signal };
          await repository.assertDispatchReady(lease, item, authorization.authority);
          const before = await provider.getStatus(authorization.accessToken, target, options);
          if (before.isBotQuarantined === item.requested_state) {
            await finishAuthorized(repository, lease, job, item, "skipped", { observed: before, readbackCount: 1 }, scope, authorize, signal);
            return;
          }
          requireFrozenPrestate(item, before);
          const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
          const dispatchAuthorization = await authorize(scope);
          requireAuthority(job, dispatchAuthorization.authority);
          await repository.assertDispatchReady(lease, item, dispatchAuthorization.authority);
          const immediate = await provider.getStatus(dispatchAuthorization.accessToken, target, options);
          if (immediate.isBotQuarantined === item.requested_state) {
            signal.throwIfAborted();
            await commitAccountSessionValidation(validation, () => repository.finishItem(lease, item, "skipped", { observed: immediate, readbackCount: 1 }));
            return;
          }
          requireFrozenPrestate(item, immediate);
          signal.throwIfAborted();
          await commitAccountSessionValidation(validation, async () => {
            signal.throwIfAborted();
            await repository.markSent(lease, item, dispatchAuthorization.authority);
          });
          sent = true;
          await provider.setQuarantine(dispatchAuthorization.accessToken, target, item.requested_state, options);
          const verified = await verifyCopilotStudioQuarantineConverged(provider, dispatchAuthorization.accessToken, target, item.requested_state, options);
          await finishAuthorized(repository, lease, job, item, "succeeded", { observed: verified.status, readbackCount: verified.readbackCount }, scope, authorize, signal);
        });
      } catch (error) {
        if (error instanceof AppError && error.code === "lease_lost") throw error;
        if (!sent && isAuthorizationFailure(error)) {
          await repository.pauseItemForAuthorization(lease, item);
          return;
        }
        if (sent) {
          operationalLog("error", "quarantine_write_uncertain", { jobId: id, outcome: "requires_reconciliation" });
        } else if (isDeadlineExceeded(error)) {
          operationalLog("error", "quarantine_job_stopped", { jobId: id, outcome: "deadline_exceeded" });
        }
        const failure = failureEvidence(error);
        await repository.finishItem(lease, item, sent ? "inconclusive" : error instanceof AppError && ["cancelled", "shutdown", "maintenance"].includes(error.code) ? "cancelled" : "failed", {
          errorCode: error instanceof AppError ? error.code : "provider_error",
          message: sent ? "Provider write outcome is inconclusive; use GET reconciliation and never replay this item." : "The quarantine item stopped before provider dispatch.",
          ...failure,
        });
      }
    }
  } finally {
    try { await repository.release(lease); }
    catch (error) { if (!(error instanceof AppError && error.code === "lease_lost")) throw error; }
  }
}

export async function reconcileCopilotStudioQuarantineJob(
  id: string,
  scope: QuarantineScope,
  repository = copilotStudioQuarantineJobs,
  provider: Pick<CopilotStudioQuarantineClient, "getStatus"> = new CopilotStudioQuarantineClient(),
  authorize: QuarantineAuthorizer = authorizeQuarantine,
) {
  const context = await repository.reconciliationItems(scope, id);
  if (!context) throw new AppError(404, "not_found", "Quarantine job was not found.");
  const errors: Array<{ resourceNativeId: string; message: string }> = [];
  for (const item of context.items) {
    try {
      const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
      const authorization = await authorize(scope);
      requireAuthority(context.job, authorization.authority);
      const signal = AbortSignal.timeout(reconciliationDeadlineMs);
      await repository.withReconciliationLock(scope, item, async () => {
        await repository.assertReconciliationTarget(scope, item, context.job.is_canary);
        const observed = await provider.getStatus(authorization.accessToken, { environmentId: item.environment_id, botId: item.bot_id }, { correlationId: item.correlation_id ?? randomUUID(), signal });
        const publishAuthorization = await authorize(scope);
        requireAuthority(context.job, publishAuthorization.authority);
        signal.throwIfAborted();
        await commitAccountSessionValidation(validation, async () => {
          signal.throwIfAborted();
          if (observed.isBotQuarantined === item.requested_state) {
            await repository.recordReconciliation(scope, context.job, item, "verified_applied", observed, "Provider GET reconciliation verified that the confirmed quarantine mutation was applied.");
          } else if (observed.isBotQuarantined === item.prestate && observed.lastUpdateTimeUtc === item.prestate_provider_updated_at) {
            await repository.recordReconciliation(scope, context.job, item, "verified_not_applied", observed, "Provider GET reconciliation verified the exact original state and timestamp. A new explicit confirmation is required before retry.");
          } else {
            await repository.recordReconciliation(scope, context.job, item, "conflict", observed, "Provider GET reconciliation found an intervening external change. Automatic retry or inversion is prohibited.");
          }
        });
      });
    } catch {
      errors.push({ resourceNativeId: item.resource_native_id, message: "GET reconciliation could not be completed; no provider state was published." });
    }
  }
  const finalAuthorization = await authorize(scope);
  requireAuthority(context.job, finalAuthorization.authority);
  return { ...(await repository.get(scope, id))!, reconciliation: { attempted: context.items.length, failed: errors.length, errors } };
}

export async function cancelCopilotStudioQuarantineJob(
  scope: QuarantineScope,
  id: string,
  repository = copilotStudioQuarantineJobs,
) {
  const job = await repository.cancel(scope, id);
  const running = active.get(id);
  if (job && running?.scope.tenantId === scope.tenantId && running.scope.principalId === scope.principalId) {
    running.controller.abort(new AppError(409, "cancelled", "The quarantine job was cancelled."));
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
  const current = [...active.values()];
  for (const value of current) value.controller.abort(new AppError(503, "shutdown", "Application shutdown stopped quarantine work."));
  const results = await Promise.allSettled(current.map(value => value.operation));
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

async function authorizeQuarantine(scope: QuarantineScope): Promise<QuarantineAuthorization> {
  const user = await revalidateAuthenticatedUser(scope.principalId);
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The quarantine actor no longer matches the signed-in account.");
  await capabilities.requireAvailable("powerPlatform.quarantine.manage", user);
  const authority = await capabilities.quarantineAuthorityContext(user);
  return { accessToken: await acquireDelegatedToken(scope.principalId, "powerPlatform.quarantine.manage"), authority };
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
) {
  const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
  const authorization = await authorize(scope);
  requireAuthority(job, authorization.authority);
  signal.throwIfAborted();
  await commitAccountSessionValidation(validation, async () => {
    signal.throwIfAborted();
    await repository.finishItem(lease, item, outcome, evidence);
  });
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

function isDeadlineExceeded(error: unknown) {
  return error instanceof Error && error.name === "TimeoutError";
}