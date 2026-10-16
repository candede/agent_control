import { randomUUID } from "node:crypto";
import { acquireAuthorizedToken, revalidateAuthorizedUser } from "../auth/msal.js";
import { CopilotStudioQuarantineCanaryRepository, type QuarantineCanaryApproval } from "../db/copilotStudioQuarantineCanaries.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation, type QuarantineScope } from "../db/copilotStudioQuarantine.js";
import { NativeInventory } from "../db/nativeInventory.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError, errorTelemetry } from "../errors.js";
import type { CopilotStudioQuarantineStatus, InventoryQuarantineTarget, QuarantineAction, QuarantineAuthority, QuarantineJob } from "../types/copilotStudioQuarantine.js";
import { sameQuarantineTarget } from "../types/copilotStudioQuarantine.js";
import type { AuthenticatedUser } from "../types/session.js";
import { hasAppRole } from "../types/capability.js";
import { capabilities } from "./capabilities.js";
import { CopilotStudioQuarantineClient } from "./copilotStudioQuarantine.js";
import { runTrackedCopilotStudioQuarantineJob } from "./copilotStudioQuarantineJobs.js";
import { operationalLog } from "./telemetry.js";
import { requireProviderAdmissions } from "./operationalState.js";

type CanaryDependencies = {
  revalidateUser: typeof revalidateAuthorizedUser;
  delegatedToken: typeof acquireAuthorizedToken;
  requireAvailable: typeof capabilities.requireAvailable;
  authorityContext: typeof capabilities.quarantineAuthorityContext;
  approvalAuthorityContext: typeof capabilities.quarantineApprovalAuthorityContext;
};

const defaultDependencies: CanaryDependencies = {
  revalidateUser: revalidateAuthorizedUser,
  delegatedToken: acquireAuthorizedToken,
  requireAvailable: capabilities.requireAvailable.bind(capabilities),
  authorityContext: capabilities.quarantineAuthorityContext.bind(capabilities),
  approvalAuthorityContext: capabilities.quarantineApprovalAuthorityContext.bind(capabilities),
};

export class CopilotStudioQuarantineCanaryService {
  constructor(
    private readonly canaries = new CopilotStudioQuarantineCanaryRepository(),
    private readonly jobs = new CopilotStudioQuarantineRepository(),
    private readonly inventory = new NativeInventory(),
    private readonly provider = new CopilotStudioQuarantineClient(),
    private readonly dependencies: CanaryDependencies = defaultDependencies,
  ) {}

  async createApproval(user: AuthenticatedUser, input: {
    snapshotId: string; resourceNativeId: string; action: QuarantineAction; prestate: boolean; prestateProviderUpdatedAt: string | null; poststate: boolean;
  }) {
    const scope = executionScope(user);
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    const target = (await this.inventory.resolveQuarantineTargets(scope, input.snapshotId, [input.resourceNativeId]))[0];
    const current = await this.revalidateAdmin(scope, validation);
    const authority = await this.dependencies.approvalAuthorityContext(current);
    return commitAccountSessionValidation(validation, () => this.canaries.createApproved(current, {
      target, action: input.action, prestate: input.prestate, prestateProviderUpdatedAt: input.prestateProviderUpdatedAt, poststate: input.poststate, authority,
    }, () => assertAccountSessionValidation(validation)));
  }

  async execute(user: AuthenticatedUser, originalId: string, restorationId: string) {
    const scope = executionScope(user);
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    const initial = await this.authorize(scope, validation);
    let claimed!: Awaited<ReturnType<CopilotStudioQuarantineCanaryRepository["claimCycle"]>>;
    await commitAccountSessionValidation(validation, async () => {
      claimed = await this.canaries.claimCycle(initial.user, originalId, restorationId, initial.authority, () => assertExecutionPublication(validation));
    });

    let originalJob: QuarantineJob | undefined;
    let restorationJob: QuarantineJob | undefined;
    let executionUnverified = false;
    try {
      const originalStatus = approvalPrestate(claimed.original);
      originalJob = await this.submitCanaryJob(scope, validation, claimed.original, originalStatus, originalId, "original");
      executionUnverified = true;
      await runTrackedCopilotStudioQuarantineJob(originalJob.id, scope, this.jobs, this.provider, this.canaryAuthorizer(claimed.original.id, originalJob.id, validation));
      originalJob = await this.jobs.get(scope, originalJob.id);
      executionUnverified = needsVerifiedResult(originalJob);
      const originalResult = requireVerifiedCanaryJob(originalJob, claimed.original, originalStatus, "canary_original_unverified");
      executionUnverified = false;

      const restorationStatus: CopilotStudioQuarantineStatus = {
        environmentId: claimed.restoration.environmentId,
        botId: claimed.restoration.botId,
        isBotQuarantined: originalResult.observedState!,
        lastUpdateTimeUtc: originalResult.observedProviderUpdatedAt!,
        observedAt: originalResult.observedAt!,
        correlationId: originalResult.correlationId!,
      };
      restorationJob = await this.submitCanaryJob(scope, validation, claimed.restoration, restorationStatus, originalId, "restoration");
      executionUnverified = true;
      await runTrackedCopilotStudioQuarantineJob(restorationJob.id, scope, this.jobs, this.provider, this.canaryAuthorizer(claimed.restoration.id, restorationJob.id, validation));
      restorationJob = await this.jobs.get(scope, restorationJob.id);
      executionUnverified = needsVerifiedResult(restorationJob);
      requireVerifiedCanaryJob(restorationJob, claimed.restoration, restorationStatus, "canary_restoration_unverified");
      executionUnverified = false;

      assertAccountSessionValidation(validation);
      const current = await this.authorize(scope, validation);
      let completed!: Awaited<ReturnType<CopilotStudioQuarantineCanaryRepository["completeCycle"]>>;
      await commitAccountSessionValidation(validation, async () => {
        completed = await this.canaries.completeCycle(current.user, claimed.original.id, claimed.restoration.id, { status: "qualified" }, current.authority, () => assertExecutionPublication(validation));
      });
      return { ...completed, jobs: { original: originalJob, restoration: restorationJob }, qualification: { qualified: true, expiresInDays: 30 } };
    } catch (error) {
      const completion = canaryFailure(originalJob, restorationJob, error, executionUnverified);
      await this.canaries.completeCycle(initial.user, claimed.original.id, claimed.restoration.id, completion).catch(completionError => {
        operationalLog("error", "quarantine_canary_completion_failed", {
          jobId: restorationJob?.id ?? originalJob?.id, outcome: "requires_review", ...errorTelemetry(completionError),
        });
      });
      throw error;
    }
  }

  private async submitCanaryJob(scope: QuarantineScope, validation: ReturnType<typeof beginAccountSessionValidation>, approval: QuarantineCanaryApproval, status: CopilotStudioQuarantineStatus, cycleId: string, stage: "original" | "restoration") {
    assertAccountSessionValidation(validation);
    const { user, authority } = await this.authorize(scope, validation);
    if (!sameAuthority(authority, approval.authority)) throw new AppError(409, "qualification_invalidated", "Quarantine authority changed after canary approval.");
    const target = targetFromApproval(approval);
    const input = { action: approval.action, targets: [{ ...target, directStatus: status }], actor: userActor(user), authority,
      requestPath: `/api/quarantine/canary-approvals/${cycleId}/execute/${stage}`, canaryApprovalId: approval.id };
    const confirmation = createQuarantineConfirmation(input);
    return commitAccountSessionValidation(validation, () => this.jobs.submit(scope, {
      ...input,
      idempotencyKey: `quarantine-canary-${approval.id}-${stage}`,
      confirmationHash: confirmation.confirmationHash,
    }, () => assertExecutionPublication(validation)));
  }

  private canaryAuthorizer(approvalId: string, jobId: string, validation: ReturnType<typeof beginAccountSessionValidation>) {
    return async (scope: QuarantineScope, signal?: AbortSignal) => {
      assertExecutionPublication(validation, signal);
      const authorization = await this.authorize(scope, validation, signal);
      assertExecutionPublication(validation, signal);
      await this.canaries.authorizeJob(authorization.user, approvalId, jobId, authorization.authority);
      assertExecutionPublication(validation, signal);
      return { accessToken: authorization.accessToken, authority: authorization.authority };
    };
  }

  private async authorize(scope: QuarantineScope, validation: ReturnType<typeof beginAccountSessionValidation>, signal?: AbortSignal) {
    const assertAuthority = capabilities.beginOperationValidation("powerPlatform.quarantine.manage",
      { tenantId: scope.tenantId, homeAccountId: scope.principalId });
    const assertCurrent = () => { assertExecutionPublication(validation, signal); assertAuthority(); };
    assertCurrent();
    const user = await this.revalidateAdmin(scope, validation);
    assertCurrent();
    await this.dependencies.requireAvailable("powerPlatform.quarantine.manage", user);
    assertCurrent();
    const authority = await this.dependencies.authorityContext(user);
    assertCurrent();
    const accessToken = await this.dependencies.delegatedToken(scope.tenantId, scope.principalId, "powerPlatform.quarantine.manage");
    assertCurrent();
    return { user, authority, accessToken };
  }

  private async revalidateAdmin(scope: QuarantineScope, validation: ReturnType<typeof beginAccountSessionValidation>) {
    assertAccountSessionValidation(validation);
    const user = await this.dependencies.revalidateUser(scope.tenantId, scope.principalId);
    assertAccountSessionValidation(validation);
    if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId || !hasAppRole(user.roles, "AgentControl.Admin")) throw AppError.unauthorized("The quarantine canary Admin changed or lost authority.");
    return user;
  }
}

export const copilotStudioQuarantineCanaries = new CopilotStudioQuarantineCanaryService();
export const copilotStudioQuarantineCanaryRepository = new CopilotStudioQuarantineCanaryRepository();

function assertExecutionPublication(validation: ReturnType<typeof beginAccountSessionValidation>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  requireProviderAdmissions();
  assertAccountSessionValidation(validation);
}

function approvalPrestate(approval: QuarantineCanaryApproval): CopilotStudioQuarantineStatus {
  if (!approval.prestateProviderUpdatedAt) throw new AppError(409, "canary_cycle_mismatch", "The original quarantine canary approval requires exact provider timestamp evidence.");
  return { environmentId: approval.environmentId, botId: approval.botId, isBotQuarantined: approval.prestate,
    lastUpdateTimeUtc: approval.prestateProviderUpdatedAt, observedAt: approval.approvedAt, correlationId: randomUUID() };
}

function needsVerifiedResult(job: QuarantineJob | undefined) {
  return !job || ["queued", "running", "waiting_authorization", "succeeded"].includes(job.status);
}

function requireVerifiedCanaryJob(job: QuarantineJob | undefined, approval: QuarantineCanaryApproval, prestate: CopilotStudioQuarantineStatus, code: string) {
  const result = job?.results[0];
  if (!job || !job.isCanary || job.action !== approval.action || job.status !== "succeeded" || job.results.length !== 1 || result?.status !== "succeeded"
    || result.resourceNativeId !== approval.resourceNativeId || !sameQuarantineTarget(result, approval)
    || result.requestedState !== approval.poststate || result.observedState !== approval.poststate
    || !result.observedProviderUpdatedAt || result.observedProviderUpdatedAt === prestate.lastUpdateTimeUtc || !result.observedAt || !result.correlationId) {
    throw new AppError(409, code, "The quarantine canary direction did not produce one durable verified provider readback.");
  }
  return result;
}

function canaryFailure(original: QuarantineJob | undefined, restoration: QuarantineJob | undefined, error: unknown, executionUnverified: boolean) {
  const code = error instanceof AppError ? error.code : "provider_error";
  if (restoration?.results.some(result => result.errorCode === "quarantine_prestate_conflict")) return { status: "conflict" as const, errorCode: code };
  if (executionUnverified || original?.results.some(result => result.status === "inconclusive") || restoration?.results.some(result => result.status === "inconclusive")
    || original?.results[0]?.status === "succeeded" && restoration?.results[0]?.status !== "succeeded") return { status: "inconclusive" as const, errorCode: code };
  return { status: "failed" as const, errorCode: code };
}

function targetFromApproval(approval: QuarantineCanaryApproval): InventoryQuarantineTarget {
  return { resourceNativeId: approval.resourceNativeId, displayName: approval.displayName, snapshotId: approval.snapshotId,
    inventoryObservedAt: approval.inventoryObservedAt, inventoryExpiresAt: approval.approvalExpiresAt, environmentId: approval.environmentId,
    botId: approval.botId, inventoryQuarantineState: null, inventoryQuarantinedAt: null };
}

function sameAuthority(left: QuarantineAuthority, right: QuarantineAuthority) {
  return left.contractRevision === right.contractRevision && left.permissionRevision === right.permissionRevision && left.configurationRevision === right.configurationRevision;
}

function executionScope(user: AuthenticatedUser): QuarantineScope {
  if (!user.tenantId || !hasAppRole(user.roles, "AgentControl.Admin")) throw new AppError(403, "missing_internal_role", "Admin is required to approve or execute a quarantine canary cycle.");
  return { tenantId: user.tenantId, principalId: user.homeAccountId };
}

function userActor(user: AuthenticatedUser) {
  return { tenantId: user.tenantId!, homeAccountId: user.homeAccountId, displayName: user.displayName, username: user.username };
}