import { randomUUID } from "node:crypto";
import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { JobRepository, type Lease } from "../db/jobs.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { DataScope } from "./auditLog.js";
import { GraphPackagesClient, updatePackageAccess, verifyPackageMutationConverged } from "./graphPackages.js";
import { maintenanceActive } from "./maintenance.js";
import { requireProviderAdmissions } from "./operationalState.js";
import { hasAppRole, type CapabilityId } from "../types/capability.js";
import { capabilities } from "./capabilities.js";
import { capturePackageMutationState, expectedPackageMutationState, packageMutationStateHash, packageMutationStatesEqual, type PackageMutationState } from "./packageMutationState.js";
import { operationalLog } from "./telemetry.js";

export const bulkJobs = new JobRepository();
const processOwner = randomUUID();
const itemExecutionDeadlineMs = 90_000;
const reconciliationDeadlineMs = 30_000;
const work = new Map<Promise<void>, { jobId: string; controller: AbortController; scope: DataScope }>();
type BulkJobExecutionRepository = Pick<JobRepository,
  "get" | "waitForAuthorization" | "claim" | "pauseForAuthorization" | "beginItem" |
  "withTargetLock" | "markSent" | "finishItem" | "pauseItemForAuthorization" | "release"
>;

export function requireWorkerCapacity() {
  requireProviderAdmissions();
  if (work.size >= 2) throw new AppError(429, "workers_busy", "Two jobs are already running; retry after they finish.");
}

export function launchBulkJob(id: string, scope: DataScope, resume = false) {
  if ([...work.values()].some(active => active.jobId === id.toLowerCase()
    && active.scope.tenantId === scope.tenantId && active.scope.principalId === scope.principalId)) return;
  requireWorkerCapacity();
  const controller = new AbortController();
  const execution = runBulkJob(id, scope, resume, bulkJobs, new GraphPackagesClient(), authorizeDelegatedJob, controller.signal).finally(() => work.delete(execution));
  void execution.catch(() => {
    operationalLog("error", "job_execution_stopped", { jobId: id, outcome: "requires_review" });
  });
  work.set(execution, { jobId: id.toLowerCase(), controller, scope });
}

export async function runTrackedBulkJob(
  id: string,
  scope: DataScope,
  repository: BulkJobExecutionRepository = bulkJobs,
  provider = new GraphPackagesClient(),
  authorize: (scope: DataScope, capabilityId: CapabilityId) => Promise<string> = authorizeDelegatedJob,
) {
  requireWorkerCapacity();
  const controller = new AbortController();
  const execution = runBulkJob(id, scope, false, repository, provider, authorize, controller.signal).finally(() => work.delete(execution));
  work.set(execution, { jobId: id.toLowerCase(), controller, scope });
  return execution;
}

export async function drainBulkJobs() {
  const active = [...work.entries()];
  for (const [, value] of active) value.controller.abort(new AppError(503, "shutdown", "Application shutdown stopped package work."));
  const outcomes = await Promise.allSettled(active.map(([operation]) => operation));
  const failure = outcomes.find(outcome => outcome.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
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
  repository: BulkJobExecutionRepository = bulkJobs, provider = new GraphPackagesClient(),
  authorize: (scope: DataScope, capabilityId: CapabilityId) => Promise<string> = authorizeDelegatedJob,
  externalSignal?: AbortSignal,
) {
  requireProviderAdmissions();
  const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
  const authorizeJob = async (owner: DataScope, capabilityId: CapabilityId) => {
    externalSignal?.throwIfAborted();
    assertAccountSessionValidation(validation);
    const token = await authorize(owner, capabilityId);
    externalSignal?.throwIfAborted();
    assertAccountSessionValidation(validation);
    return token;
  };
  const jobSummary = await repository.get(id, scope);
  if (!jobSummary) throw new AppError(404, "not_found", "Job was not found.");
  if (jobSummary.tokenMode !== "delegated") throw new AppError(409, "invalid_token_mode", "The delegated worker cannot execute an application-mode job.");
  const principal = { tenantId: scope.tenantId, homeAccountId: scope.principalId };
  let accessToken: string;
  try {
    requireProviderAdmissions();
    accessToken = await capabilities.observeOperation(jobSummary.capabilityId, principal,
      () => authorizeJob(scope, jobSummary.capabilityId), { signal: externalSignal, clearOnSuccess: false });
  }
  catch (error) {
    await repository.waitForAuthorization(id, scope);
    if (externalSignal?.aborted) return;
    throw error;
  }
  const lease = await repository.claim(id, scope, processOwner, resume);
  if (!lease) return;
  try {
    for (let index = 0; index < 5000 && !maintenanceActive() && !externalSignal?.aborted; index += 1) {
      try { accessToken = await capabilities.observeOperation(jobSummary.capabilityId, principal,
        () => authorizeJob(scope, jobSummary.capabilityId), { signal: externalSignal, clearOnSuccess: false }); }
      catch {
        await repository.pauseForAuthorization(lease);
        return;
      }
      const current = await repository.beginItem(lease);
      if (!current) break;
      const { item, job, inventoryGeneration } = current;
      const signal = externalSignal
        ? AbortSignal.any([externalSignal, AbortSignal.timeout(itemExecutionDeadlineMs)])
        : AbortSignal.timeout(itemExecutionDeadlineMs);
      const requireCurrentItem = () => {
        requireProviderAdmissions();
        signal.throwIfAborted();
        assertAccountSessionValidation(validation);
      };
      const getPackageDetails = async (...args: Parameters<GraphPackagesClient["getPackageDetails"]>) => {
        requireCurrentItem();
        const details = await provider.getPackageDetails(...args);
        requireCurrentItem();
        return details;
      };
      let sent = false;
      try {
        await capabilities.observeOperation(job.capability, principal, () => repository.withTargetLock(lease, item, async () => {
          const readOptions = { correlationId: item.correlation_id!, signal };
          const before = await getPackageDetails(accessToken, item.target_id, readOptions);
          if (before.id !== item.target_id) throw new AppError(502,"target_mismatch","Provider returned a different package identity.");
          const beforeState = capturePackageMutationState(before, job.action);
          requireFrozenPrestate(item.prestate_hash, beforeState);
          let readbackToken = accessToken;
          const dispatch = async () => {
            const dispatchToken = await authorizeJob(scope, job.capability);
            const immediate = await getPackageDetails(dispatchToken, item.target_id, readOptions);
            if (immediate.id !== item.target_id) throw new AppError(502,"target_mismatch","Provider returned a different package identity.");
            const immediateState = capturePackageMutationState(immediate, job.action);
            requireFrozenPrestate(item.prestate_hash, immediateState);
            signal.throwIfAborted();
            await commitAccountSessionValidation(validation, async () => {
              requireProviderAdmissions();
              signal.throwIfAborted();
              await repository.markSent(lease, item.id, packageMutationStateHash(immediateState));
            });
            sent = true;
            requireCurrentItem();
            readbackToken = dispatchToken;
            return dispatchToken;
          };
          if (job.access_update) {
            const accessAction = job.action;
            if (accessAction !== "update-availability" && accessAction !== "update-installation") throw new AppError(409, "mutation_state_mismatch", "The durable package access action does not match its payload.");
            const result = await updatePackageAccess({
              getPackageDetails,
              patchPackageAccess: (...args) => {
                requireCurrentItem();
                return provider.patchPackageAccess(...args);
              },
            }, accessToken, item.target_id, job.access_update, before, dispatch, readOptions);
            requireProviderAdmissions();
            if (!result.changed) {
              await finishAuthorized(repository, lease, item.id, "skipped", { poststate: beforeState, readbackCount: 1, readback: before, inventoryGeneration }, scope, job.capability, authorizeJob, signal);
              return;
            }
            const expected = expectedPackageMutationState(beforeState, accessAction, job.access_update);
            const verified = await verifyPackageMutationConverged({ getPackageDetails }, readbackToken, item.target_id, accessAction, expected, readOptions);
            await finishAuthorized(repository, lease, item.id, "succeeded", { poststate: verified.state, readbackCount: verified.readbackCount, readback: verified.details, inventoryGeneration }, scope, job.capability, authorizeJob, signal);
            return;
          }
          const blockAction = job.action;
          if (blockAction === "reassign" || blockAction === "update-availability" || blockAction === "update-installation") throw new AppError(409, "mutation_state_mismatch", "The durable package action does not match its payload.");
          const expected = expectedPackageMutationState(beforeState, blockAction);
          if (packageMutationStateHash(beforeState) === packageMutationStateHash(expected)) {
            await finishAuthorized(repository, lease, item.id, "skipped", { poststate: beforeState, readbackCount: 1, readback: before, inventoryGeneration }, scope, job.capability, authorizeJob, signal);
            return;
          }
          const dispatchToken = await dispatch();
          requireCurrentItem();
          if (blockAction === "block") await provider.blockPackage(dispatchToken, item.target_id, readOptions);
          else await provider.unblockPackage(dispatchToken, item.target_id, readOptions);
          requireProviderAdmissions();
          const verified = await verifyPackageMutationConverged({ getPackageDetails }, dispatchToken, item.target_id, blockAction, expected, readOptions);
          await finishAuthorized(repository, lease, item.id, "succeeded", { poststate: verified.state, readbackCount: verified.readbackCount, readback: verified.details, inventoryGeneration }, scope, job.capability, authorizeJob, signal);
        }), { signal, clearOnSuccess: () => sent });
      } catch (caught) {
        if (caught instanceof AppError && caught.code === "lease_lost") throw caught;
        const error: unknown = signal.aborted ? signal.reason : caught;
        if (!sent && (isAuthorizationFailure(error) || isAdmissionFailure(error) || error instanceof AppError && [401, 403].includes(error.status))) {
          await repository.pauseItemForAuthorization(lease, item.id);
          return;
        }
        if (sent) {
          operationalLog("error", "job_write_uncertain", { jobId: id, outcome: "requires_reconciliation" });
        } else if (isDeadlineExceeded(error)) {
          operationalLog("error", "job_execution_stopped", { jobId: id, outcome: "deadline_exceeded" });
        }
        await repository.finishItem(lease, item.id,
          sent ? "inconclusive" : error instanceof AppError && ["cancelled","shutdown","maintenance"].includes(error.code) ? "cancelled" : "failed",
          {
            message: sent ? "Provider write outcome is inconclusive; do not retry without reconciliation." : "The item stopped before provider dispatch.",
            errorCode: failureCode(error),
            ...failureEvidence(error),
          });
        if (isAdmissionFailure(error) || externalSignal?.aborted) return;
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
  requireProviderAdmissions();
  const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
  const summary = await repository.get(id, scope);
  assertAccountSessionValidation(validation);
  if (!summary) throw new AppError(404, "not_found", "Job was not found.");
  if (summary.tokenMode !== "delegated") throw new AppError(409, "invalid_token_mode", "Package reconciliation requires the original delegated authorization mode.");
  const context = await repository.reconciliationContext(id, scope);
  assertAccountSessionValidation(validation);
  if (!context) throw new AppError(404, "not_found", "Job was not found.");
  const errors: Array<{ id: string; message: string }> = [];
  for (const item of context.items) {
    requireProviderAdmissions();
    assertAccountSessionValidation(validation);
    try {
      const token = await authorize(scope, "graph.package.read.delegated");
      assertAccountSessionValidation(validation);
      const signal = AbortSignal.timeout(reconciliationDeadlineMs);
      await repository.withReconciliationLock(scope, item, async () => {
        const action = context.job.action;
        if (action === "reassign") throw new AppError(409, "reassign_verification_unavailable", "Reassign owner cannot be reconciled because Microsoft Graph does not expose owner state.");
        const inventoryGeneration = await repository.inventoryGeneration(scope);
        requireProviderAdmissions();
        assertAccountSessionValidation(validation);
        const details = await provider.getPackageDetails(token, item.target_id, { correlationId: item.correlation_id ?? randomUUID(), signal });
        if (details.id !== item.target_id) throw new AppError(502, "target_mismatch", "Provider returned a different package identity.");
        const observed = capturePackageMutationState(details, action);
        const expected = expectedPackageMutationState(item.prestate, action, context.job.access_update ?? undefined);
        requireProviderAdmissions();
        assertAccountSessionValidation(validation);
        await authorize(scope, "graph.package.read.delegated");
        signal.throwIfAborted();
        await commitAccountSessionValidation(validation, async () => {
          signal.throwIfAborted();
          requireProviderAdmissions();
          if (packageMutationStatesEqual(observed, expected)) {
            await repository.recordReconciliation(scope, item.id, "verified_applied", observed, "Provider reconciliation verified that the confirmed mutation was applied.", { details, inventoryGeneration });
          } else if (packageMutationStatesEqual(observed, item.prestate)) {
            await repository.recordReconciliation(scope, item.id, "verified_not_applied", observed, "Provider reconciliation verified that the confirmed mutation was not applied. A new explicit confirmation is required before any retry.", { details, inventoryGeneration });
          } else {
            await repository.recordReconciliation(scope, item.id, "conflict", observed, "Provider reconciliation found an intervening external change. Automatic restoration or retry is prohibited.", { details, inventoryGeneration });
          }
        });
      });
    } catch (error) {
      errors.push({ id: item.target_id, message: "Reconciliation could not be completed; no provider state was published." });
    }
  }
  requireProviderAdmissions();
  await authorize(scope, "graph.package.read.delegated");
  assertAccountSessionValidation(validation);
  const current = await repository.get(id, scope);
  requireProviderAdmissions();
  assertAccountSessionValidation(validation);
  if (!current) throw new AppError(404, "not_found", "Job was not found.");
  return { ...current, reconciliation: { attempted: context.items.length, failed: errors.length, errors } };
}

async function releaseIfOwned(repository: BulkJobExecutionRepository, lease: Lease) {
  try { await repository.release(lease); }
  catch (error) { if (!(error instanceof AppError && error.code === "lease_lost")) throw error; }
}

async function authorizeDelegatedJob(scope: DataScope, capabilityId: CapabilityId) {
  const user = await revalidateAuthenticatedUser(scope.tenantId, scope.principalId);
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The job initiator no longer matches the signed-in account.");
  await capabilities.requireAvailable(capabilityId, user);
  return acquireDelegatedToken(scope.tenantId, scope.principalId, capabilityId);
}

async function authorizeReconciliation(scope: DataScope, capabilityId: CapabilityId) {
  const user = await revalidateAuthenticatedUser(scope.tenantId, scope.principalId);
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The reconciliation actor no longer matches the signed-in account.");
  if (!hasAppRole(user.roles, "AgentControl.Admin")) throw new AppError(403, "missing_internal_role", "AgentControl.Admin is required to reconcile package mutations.");
  await capabilities.requireAvailable(capabilityId, user);
  return acquireDelegatedToken(scope.tenantId, scope.principalId, capabilityId);
}

async function finishAuthorized(
  repository: BulkJobExecutionRepository,
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
  requireProviderAdmissions();
  signal.throwIfAborted();
  await commitAccountSessionValidation(validation, async () => {
    requireProviderAdmissions();
    signal.throwIfAborted();
    await repository.finishItem(lease, itemId, outcome, evidence);
  });
}

function isAuthorizationFailure(error: unknown) {
  return error instanceof AppError && ["interaction_required", "authorization_expired", "missing_permission", "missing_internal_role", "capability_unavailable", "unauthorized", "invalid_token_mode"].includes(error.code);
}

function isAdmissionFailure(error: unknown) {
  return error instanceof AppError && ["maintenance", "provider_requalification_required"].includes(error.code);
}

function isDeadlineExceeded(error: unknown) {
  return error instanceof Error && error.name === "TimeoutError"
    || error instanceof AppError && error.code === "provider_timeout";
}

function failureCode(error: unknown) {
  if (error instanceof AppError) return error.code;
  return isDeadlineExceeded(error) ? "provider_timeout" : "provider_error";
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