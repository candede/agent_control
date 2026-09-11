import { randomUUID } from "node:crypto";
import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { JobRepository, type Lease } from "../db/jobs.js";
import { beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { DataScope } from "./auditLog.js";
import { GraphPackagesClient, updatePackageAccess, verifyPackageMutationConverged } from "./graphPackages.js";
import { maintenanceActive } from "./maintenance.js";
import { requireProviderAdmissions } from "./operationalState.js";
import type { CapabilityId } from "../types/capability.js";
import { capabilities } from "./capabilities.js";
import { capturePackageMutationState, expectedPackageMutationState, packageMutationStateHash, packageMutationStatesEqual, type PackageMutationState } from "./packageMutationState.js";
import { requirePackageMutationOperationSafe } from "./packageMutationSafety.js";
import { operationalLog } from "./telemetry.js";

export const bulkJobs = new JobRepository();
const processOwner = randomUUID();
const itemExecutionDeadlineMs = 90_000;
const reconciliationDeadlineMs = 30_000;
const work = new Map<Promise<void>, { controller: AbortController; scope: DataScope }>();

export function requireWorkerCapacity() {
  requireProviderAdmissions();
  if (work.size >= 2) throw new AppError(429, "workers_busy", "Two jobs are already running; retry after they finish.");
}

export function launchBulkJob(id: string, scope: DataScope, resume = false) {
  requireWorkerCapacity();
  const controller = new AbortController();
  const execution = runBulkJob(id, scope, resume, bulkJobs, new GraphPackagesClient(), authorizeDelegatedJob, controller.signal).catch(() => {
    operationalLog("error", "job_execution_stopped", { jobId: id, outcome: "requires_review" });
  }).finally(() => work.delete(execution));
  work.set(execution, { controller, scope });
}

export async function runTrackedBulkJob(
  id: string,
  scope: DataScope,
  repository = bulkJobs,
  provider = new GraphPackagesClient(),
  authorize: (scope: DataScope, capabilityId: CapabilityId) => Promise<string> = authorizeDelegatedJob,
) {
  requireWorkerCapacity();
  const controller = new AbortController();
  const execution = runBulkJob(id, scope, false, repository, provider, authorize, controller.signal).finally(() => work.delete(execution));
  work.set(execution, { controller, scope });
  return execution;
}

export async function drainBulkJobs() {
  const active = [...work.entries()];
  for (const [, value] of active) value.controller.abort(new AppError(503, "shutdown", "Application shutdown stopped package work."));
  await Promise.allSettled(active.map(([operation]) => operation));
}

export async function pauseBulkJobsForPrincipal(scope: DataScope) {
  for (const value of work.values()) {
    if (value.scope.tenantId === scope.tenantId && value.scope.principalId === scope.principalId) {
      value.controller.abort(new AppError(401, "interaction_required", "The signed-in account changed during package work."));
    }
  }
  await bulkJobs.waitForPrincipalAuthorization(scope);
}

export async function runBulkJob(
  id: string, scope: DataScope, resume = false,
  repository = bulkJobs, provider = new GraphPackagesClient(),
  authorize: (scope: DataScope, capabilityId: CapabilityId) => Promise<string> = authorizeDelegatedJob,
  externalSignal?: AbortSignal,
) {
  const jobSummary = await repository.get(id, scope);
  if (!jobSummary) throw new AppError(404, "not_found", "Job was not found.");
  if (jobSummary.tokenMode !== "delegated") throw new AppError(409, "invalid_token_mode", "The delegated worker cannot execute an application-mode job.");
  let accessToken: string;
  try { accessToken = await authorize(scope, jobSummary.capabilityId); }
  catch (error) { await repository.waitForAuthorization(id, scope); throw error; }
  const lease = await repository.claim(id, scope, processOwner, resume);
  if (!lease) return;
  try {
    for (let index = 0; index < 5000 && !maintenanceActive(); index += 1) {
      try { accessToken = await authorize(scope, jobSummary.capabilityId); }
      catch {
        await repository.pauseForAuthorization(lease);
        return;
      }
      const current = await repository.beginItem(lease);
      if (!current) break;
      const { item, job } = current;
      const signal = externalSignal
        ? AbortSignal.any([externalSignal, AbortSignal.timeout(itemExecutionDeadlineMs)])
        : AbortSignal.timeout(itemExecutionDeadlineMs);
      let sent = false;
      try {
        await repository.withTargetLock(lease, item, async () => {
          const readOptions = { correlationId: item.correlation_id!, signal };
          const before = await provider.getPackageDetails(accessToken, item.target_id, readOptions);
          if (before.id !== item.target_id) throw new AppError(502,"target_mismatch","Provider returned a different package identity.");
          const beforeState = capturePackageMutationState(before, job.action);
          requireFrozenPrestate(item.prestate_hash, beforeState);
          let readbackToken = accessToken;
          const dispatch = async () => {
            const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
            const dispatchToken = await authorize(scope, job.capability);
            const immediate = await provider.getPackageDetails(dispatchToken, item.target_id, readOptions);
            if (immediate.id !== item.target_id) throw new AppError(502,"target_mismatch","Provider returned a different package identity.");
            const immediateState = capturePackageMutationState(immediate, job.action);
            requireFrozenPrestate(item.prestate_hash, immediateState);
            signal.throwIfAborted();
            await commitAccountSessionValidation(validation, async () => {
              signal.throwIfAborted();
              await repository.markSent(lease, item.id, packageMutationStateHash(immediateState));
            });
            sent = true;
            readbackToken = dispatchToken;
            return dispatchToken;
          };
          if (job.access_update) {
            const accessAction = job.action;
            if (accessAction !== "update-availability" && accessAction !== "update-installation") throw new AppError(409, "mutation_state_mismatch", "The durable package access action does not match its payload.");
            requirePackageMutationOperationSafe(accessAction);
            const result = await updatePackageAccess(provider, accessToken, item.target_id, job.access_update, before, dispatch, readOptions);
            if (!result.changed) {
              await finishAuthorized(repository, lease, item.id, "skipped", { poststate: beforeState, readbackCount: 1 }, scope, job.capability, authorize, signal);
              return;
            }
            const expected = expectedPackageMutationState(beforeState, accessAction, job.access_update);
            const verified = await verifyPackageMutationConverged(provider, readbackToken, item.target_id, accessAction, expected, readOptions);
            await finishAuthorized(repository, lease, item.id, "succeeded", { poststate: verified.state, readbackCount: verified.readbackCount }, scope, job.capability, authorize, signal);
            return;
          }
          const blockAction = job.action;
          if (blockAction === "reassign" || blockAction === "update-availability" || blockAction === "update-installation") throw new AppError(409, "mutation_state_mismatch", "The durable package action does not match its payload.");
          const expected = expectedPackageMutationState(beforeState, blockAction);
          if (packageMutationStateHash(beforeState) === packageMutationStateHash(expected)) {
            await finishAuthorized(repository, lease, item.id, "skipped", { poststate: beforeState, readbackCount: 1 }, scope, job.capability, authorize, signal);
            return;
          }
          const dispatchToken = await dispatch();
          if (blockAction === "block") await provider.blockPackage(dispatchToken, item.target_id, readOptions);
          else await provider.unblockPackage(dispatchToken, item.target_id, readOptions);
          const verified = await verifyPackageMutationConverged(provider, dispatchToken, item.target_id, blockAction, expected, readOptions);
          await finishAuthorized(repository, lease, item.id, "succeeded", { poststate: verified.state, readbackCount: verified.readbackCount }, scope, job.capability, authorize, signal);
        });
      } catch (error) {
        if (error instanceof AppError && error.code === "lease_lost") throw error;
        if (!sent && (isAuthorizationFailure(error) || error instanceof AppError && [401, 403].includes(error.status))) {
          await repository.pauseItemForAuthorization(lease, item.id);
          return;
        }
        if (sent) {
          operationalLog("error", "job_write_uncertain", { jobId: id, outcome: "requires_reconciliation" });
        } else if (isDeadlineExceeded(error)) {
          operationalLog("error", "job_execution_stopped", { jobId: id, outcome: "deadline_exceeded" });
        }
        await repository.finishItem(lease, item.id,
          sent ? "inconclusive" : error instanceof AppError && ["cancelled","maintenance"].includes(error.code) ? "cancelled" : "failed",
          {
            message: sent ? "Provider write outcome is inconclusive; do not retry without reconciliation." : "The item stopped before provider dispatch.",
            errorCode: error instanceof AppError ? error.code : "provider_error",
            ...failureEvidence(error),
          });
      }
    }
  } finally { await releaseIfOwned(repository, lease); }
}

export async function reconcileBulkJob(
  id: string,
  scope: DataScope,
  repository = bulkJobs,
  provider = new GraphPackagesClient(),
  authorize: (scope: DataScope, capabilityId: CapabilityId) => Promise<string> = authorizeReconciliation,
) {
  const summary = await repository.get(id, scope);
  if (!summary) throw new AppError(404, "not_found", "Job was not found.");
  if (summary.tokenMode !== "delegated") throw new AppError(409, "invalid_token_mode", "Package reconciliation requires the original delegated authorization mode.");
  const context = await repository.reconciliationContext(id, scope);
  if (!context) throw new AppError(404, "not_found", "Job was not found.");
  const errors: Array<{ id: string; message: string }> = [];
  for (const item of context.items) {
    try {
      const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
      const token = await authorize(scope, "graph.package.read.delegated");
      const signal = AbortSignal.timeout(reconciliationDeadlineMs);
      await repository.withReconciliationLock(scope, item, async () => {
        const action = context.job.action;
        if (action === "reassign") throw new AppError(409, "reassign_verification_unavailable", "Reassign owner cannot be reconciled because Microsoft Graph does not expose owner state.");
        const details = await provider.getPackageDetails(token, item.target_id, { correlationId: item.correlation_id ?? randomUUID(), signal });
        if (details.id !== item.target_id) throw new AppError(502, "target_mismatch", "Provider returned a different package identity.");
        const observed = capturePackageMutationState(details, action);
        const expected = expectedPackageMutationState(item.prestate, action, context.job.access_update ?? undefined);
        await authorize(scope, "graph.package.read.delegated");
        signal.throwIfAborted();
        await commitAccountSessionValidation(validation, async () => {
          signal.throwIfAborted();
          if (packageMutationStatesEqual(observed, expected)) {
            await repository.recordReconciliation(scope, item.id, "verified_applied", observed, "Provider reconciliation verified that the confirmed mutation was applied.");
          } else if (packageMutationStatesEqual(observed, item.prestate)) {
            await repository.recordReconciliation(scope, item.id, "verified_not_applied", observed, "Provider reconciliation verified that the confirmed mutation was not applied. A new explicit confirmation is required before any retry.");
          } else {
            await repository.recordReconciliation(scope, item.id, "conflict", observed, "Provider reconciliation found an intervening external change. Automatic restoration or retry is prohibited.");
          }
        });
      });
    } catch (error) {
      errors.push({ id: item.target_id, message: "Reconciliation could not be completed; no provider state was published." });
    }
  }
  await authorize(scope, "graph.package.read.delegated");
  return { ...(await repository.get(id, scope))!, reconciliation: { attempted: context.items.length, failed: errors.length, errors } };
}

async function releaseIfOwned(repository: JobRepository, lease: Lease) {
  try { await repository.release(lease); }
  catch (error) { if (!(error instanceof AppError && error.code === "lease_lost")) throw error; }
}

async function authorizeDelegatedJob(scope: DataScope, capabilityId: CapabilityId) {
  const user = await revalidateAuthenticatedUser(scope.principalId);
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The job initiator no longer matches the signed-in account.");
  await capabilities.requireAvailable(capabilityId, user);
  return acquireDelegatedToken(scope.principalId, capabilityId);
}

async function authorizeReconciliation(scope: DataScope, capabilityId: CapabilityId) {
  const user = await revalidateAuthenticatedUser(scope.principalId);
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The reconciliation actor no longer matches the signed-in account.");
  if (!user.roles.includes("AgentControl.Operator")) throw new AppError(403, "missing_internal_role", "AgentControl.Operator is required to reconcile package mutations.");
  await capabilities.requireAvailable(capabilityId, user);
  return acquireDelegatedToken(scope.principalId, capabilityId);
}

async function finishAuthorized(
  repository: JobRepository,
  lease: Lease,
  itemId: string,
  outcome: "succeeded" | "skipped",
  evidence: Parameters<JobRepository["finishItem"]>[3],
  scope: DataScope,
  capabilityId: CapabilityId,
  authorize: (scope: DataScope, capabilityId: CapabilityId) => Promise<string>,
  signal: AbortSignal,
) {
  const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
  await authorize(scope, capabilityId);
  signal.throwIfAborted();
  await commitAccountSessionValidation(validation, async () => {
    signal.throwIfAborted();
    await repository.finishItem(lease, itemId, outcome, evidence);
  });
}

function isAuthorizationFailure(error: unknown) {
  return error instanceof AppError && ["interaction_required", "authorization_expired", "missing_permission", "missing_internal_role", "capability_unavailable", "unauthorized", "invalid_token_mode"].includes(error.code);
}

function isDeadlineExceeded(error: unknown) {
  return error instanceof Error && error.name === "TimeoutError";
}

function requireFrozenPrestate(expectedHash: string, observed: PackageMutationState) {
  if (packageMutationStateHash(observed) !== expectedHash) {
    throw new AppError(409, "mutation_prestate_conflict", "The provider package state changed after confirmation. No write was dispatched; review and confirm again.");
  }
}

function failureEvidence(error: unknown) {
  const details = error instanceof AppError && error.details && typeof error.details === "object" ? error.details as { lastState?: unknown; readbackCount?: unknown } : undefined;
  return {
    ...(isMutationState(details?.lastState) ? { poststate: details.lastState } : {}),
    ...(typeof details?.readbackCount === "number" ? { readbackCount: details.readbackCount } : {}),
  };
}

function isMutationState(value: unknown): value is PackageMutationState {
  return Boolean(value && typeof value === "object" && ((value as { kind?: unknown }).kind === "block" || (value as { kind?: unknown }).kind === "access"));
}