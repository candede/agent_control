import { randomUUID } from "node:crypto";
import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { CopilotStudioQuarantineCanaryRepository, type QuarantineCanaryApproval } from "../db/copilotStudioQuarantineCanaries.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation, type QuarantineScope } from "../db/copilotStudioQuarantine.js";
import { PowerPlatformInventoryRepository } from "../db/powerPlatformInventory.js";
import { beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { CopilotStudioQuarantineStatus, InventoryQuarantineTarget, QuarantineAction, QuarantineAuthority, QuarantineJob } from "../types/copilotStudioQuarantine.js";
import type { AuthenticatedUser } from "../types/session.js";
import { hasAppRole } from "../types/capability.js";
import { capabilities } from "./capabilities.js";
import { CopilotStudioQuarantineClient } from "./copilotStudioQuarantine.js";
import { runTrackedCopilotStudioQuarantineJob } from "./copilotStudioQuarantineJobs.js";

type CanaryDependencies = {
  revalidateUser: typeof revalidateAuthenticatedUser;
  delegatedToken: typeof acquireDelegatedToken;
  requireAvailable: typeof capabilities.requireAvailable;
  authorityContext: typeof capabilities.quarantineAuthorityContext;
  approvalAuthorityContext: typeof capabilities.quarantineApprovalAuthorityContext;
};

const defaultDependencies: CanaryDependencies = {
  revalidateUser: revalidateAuthenticatedUser,
  delegatedToken: acquireDelegatedToken,
  requireAvailable: capabilities.requireAvailable.bind(capabilities),
  authorityContext: capabilities.quarantineAuthorityContext.bind(capabilities),
  approvalAuthorityContext: capabilities.quarantineApprovalAuthorityContext.bind(capabilities),
};

export class CopilotStudioQuarantineCanaryService {
  constructor(
    private readonly canaries = new CopilotStudioQuarantineCanaryRepository(),
    private readonly jobs = new CopilotStudioQuarantineRepository(),
    private readonly inventory = new PowerPlatformInventoryRepository(),
    private readonly provider = new CopilotStudioQuarantineClient(),
    private readonly dependencies: CanaryDependencies = defaultDependencies,
  ) {}

  async createApproval(user: AuthenticatedUser, input: {
    snapshotId: string; resourceNativeId: string; action: QuarantineAction; prestate: boolean; prestateProviderUpdatedAt: string | null; poststate: boolean;
  }) {
    const tenantId = requireTenant(user);
    const target = (await this.inventory.resolveQuarantineTargets({ tenantId, principalId: user.homeAccountId }, input.snapshotId, [input.resourceNativeId]))[0];
    const authority = await this.dependencies.approvalAuthorityContext(user);
    return this.canaries.createApproved(user, { target, action: input.action, prestate: input.prestate, prestateProviderUpdatedAt: input.prestateProviderUpdatedAt, poststate: input.poststate, authority });
  }

  async execute(user: AuthenticatedUser, originalId: string, restorationId: string) {
    const scope = executionScope(user);
    const claimValidation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    const initial = await this.authorize(scope);
    let claimed!: Awaited<ReturnType<CopilotStudioQuarantineCanaryRepository["claimCycle"]>>;
    await commitAccountSessionValidation(claimValidation, async () => {
      claimed = await this.canaries.claimCycle(initial.user, originalId, restorationId, initial.authority);
    });

    let originalJob: QuarantineJob | undefined;
    let restorationJob: QuarantineJob | undefined;
    try {
      const originalStatus = approvalPrestate(claimed.original);
      originalJob = await this.submitCanaryJob(initial.user, claimed.original, originalStatus, originalId, "original");
      await runTrackedCopilotStudioQuarantineJob(originalJob.id, scope, this.jobs, this.provider, this.canaryAuthorizer(claimed.original.id, originalJob.id));
      originalJob = await this.jobs.get(scope, originalJob.id);
      const originalResult = requireVerifiedCanaryJob(originalJob, "canary_original_unverified");

      const restorationStatus: CopilotStudioQuarantineStatus = {
        environmentId: claimed.restoration.environmentId,
        botId: claimed.restoration.botId,
        isBotQuarantined: originalResult.observedState!,
        lastUpdateTimeUtc: originalResult.observedProviderUpdatedAt!,
        observedAt: originalResult.observedAt!,
        correlationId: originalResult.correlationId!,
      };
      restorationJob = await this.submitCanaryJob(initial.user, claimed.restoration, restorationStatus, originalId, "restoration");
      await runTrackedCopilotStudioQuarantineJob(restorationJob.id, scope, this.jobs, this.provider, this.canaryAuthorizer(claimed.restoration.id, restorationJob.id));
      restorationJob = await this.jobs.get(scope, restorationJob.id);
      requireVerifiedCanaryJob(restorationJob, "canary_restoration_unverified");

      const publicationValidation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
      const current = await this.authorize(scope);
      let completed!: Awaited<ReturnType<CopilotStudioQuarantineCanaryRepository["completeCycle"]>>;
      await commitAccountSessionValidation(publicationValidation, async () => {
        completed = await this.canaries.completeCycle(current.user, claimed.original.id, claimed.restoration.id, { status: "qualified" }, current.authority);
      });
      return { ...completed, jobs: { original: originalJob, restoration: restorationJob }, qualification: { qualified: true, expiresInDays: 30 } };
    } catch (error) {
      const completion = canaryFailure(originalJob, restorationJob, error);
      await this.canaries.completeCycle(initial.user, claimed.original.id, claimed.restoration.id, completion).catch(() => undefined);
      throw error;
    }
  }

  private async submitCanaryJob(user: AuthenticatedUser, approval: QuarantineCanaryApproval, status: CopilotStudioQuarantineStatus, cycleId: string, stage: "original" | "restoration") {
    const authority = await this.dependencies.authorityContext(user);
    if (!sameAuthority(authority, approval.authority)) throw new AppError(409, "qualification_invalidated", "Quarantine authority changed after canary approval.");
    const target = targetFromApproval(approval);
    const input = { action: approval.action, targets: [{ ...target, directStatus: status }], actor: userActor(user), authority,
      requestPath: `/api/quarantine/canary-approvals/${cycleId}/execute/${stage}`, canaryApprovalId: approval.id };
    const confirmation = createQuarantineConfirmation(input);
    return this.jobs.submit({ tenantId: user.tenantId!, principalId: user.homeAccountId }, {
      ...input,
      idempotencyKey: `quarantine-canary-${approval.id}-${stage}`,
      confirmationHash: confirmation.confirmationHash,
    });
  }

  private canaryAuthorizer(approvalId: string, jobId: string) {
    return async (scope: QuarantineScope) => {
      const authorization = await this.authorize(scope);
      await this.canaries.authorizeJob(authorization.user, approvalId, jobId, authorization.authority);
      return { accessToken: authorization.accessToken, authority: authorization.authority };
    };
  }

  private async authorize(scope: QuarantineScope) {
    const user = await this.dependencies.revalidateUser(scope.principalId);
    if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId || !hasAppRole(user.roles, "AgentControl.Admin")) throw AppError.unauthorized("The quarantine canary Admin changed or lost authority.");
    await this.dependencies.requireAvailable("powerPlatform.quarantine.manage", user);
    const authority = await this.dependencies.authorityContext(user);
    const accessToken = await this.dependencies.delegatedToken(scope.principalId, "powerPlatform.quarantine.manage");
    return { user, authority, accessToken };
  }
}

export const copilotStudioQuarantineCanaries = new CopilotStudioQuarantineCanaryService();
export const copilotStudioQuarantineCanaryRepository = new CopilotStudioQuarantineCanaryRepository();

function approvalPrestate(approval: QuarantineCanaryApproval): CopilotStudioQuarantineStatus {
  if (!approval.prestateProviderUpdatedAt) throw new AppError(409, "canary_cycle_mismatch", "The original quarantine canary approval requires exact provider timestamp evidence.");
  return { environmentId: approval.environmentId, botId: approval.botId, isBotQuarantined: approval.prestate,
    lastUpdateTimeUtc: approval.prestateProviderUpdatedAt, observedAt: approval.approvedAt, correlationId: randomUUID() };
}

function requireVerifiedCanaryJob(job: QuarantineJob | undefined, code: string) {
  const result = job?.results[0];
  if (!job || job.status !== "succeeded" || job.results.length !== 1 || result?.status !== "succeeded" || result.observedState === null
    || !result.observedProviderUpdatedAt || !result.observedAt || !result.correlationId) {
    throw new AppError(409, code, "The quarantine canary direction did not produce one durable verified provider readback.");
  }
  return result;
}

function canaryFailure(original: QuarantineJob | undefined, restoration: QuarantineJob | undefined, error: unknown) {
  const code = error instanceof AppError ? error.code : "provider_error";
  if (restoration?.results.some(result => result.errorCode === "quarantine_prestate_conflict")) return { status: "conflict" as const, errorCode: code };
  if (original?.results.some(result => result.status === "inconclusive") || restoration?.results.some(result => result.status === "inconclusive")
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
  if (!user.tenantId || !hasAppRole(user.roles, "AgentControl.Admin")) throw new AppError(403, "missing_internal_role", "Admin is required for a full quarantine canary cycle.");
  return { tenantId: user.tenantId, principalId: user.homeAccountId };
}

function requireTenant(user: AuthenticatedUser) {
  if (!user.tenantId) throw AppError.unauthorized("Quarantine canary approval requires a tenant scope.");
  return user.tenantId;
}

function userActor(user: AuthenticatedUser) {
  return { tenantId: user.tenantId!, homeAccountId: user.homeAccountId, displayName: user.displayName, username: user.username };
}