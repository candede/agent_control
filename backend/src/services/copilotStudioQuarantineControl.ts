import { randomUUID } from "node:crypto";
import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { createQuarantineConfirmation, type QuarantineScope } from "../db/copilotStudioQuarantine.js";
import { PowerPlatformInventoryRepository } from "../db/powerPlatformInventory.js";
import { beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { FrozenQuarantineTarget, InventoryQuarantineTarget, QuarantineAction } from "../types/copilotStudioQuarantine.js";
import type { AuthenticatedUser } from "../types/session.js";
import { hasAppRole, type CapabilityId } from "../types/capability.js";
import { capabilities } from "./capabilities.js";
import { CopilotStudioQuarantineClient } from "./copilotStudioQuarantine.js";
import { copilotStudioQuarantineJobs, launchCopilotStudioQuarantineJob } from "./copilotStudioQuarantineJobs.js";

type ControlDependencies = {
  revalidateUser: typeof revalidateAuthenticatedUser;
  delegatedToken: typeof acquireDelegatedToken;
  requireAvailable: typeof capabilities.requireAvailable;
  authorityContext: typeof capabilities.quarantineAuthorityContext;
  launch: typeof launchCopilotStudioQuarantineJob;
};

const defaultDependencies: ControlDependencies = {
  revalidateUser: revalidateAuthenticatedUser,
  delegatedToken: acquireDelegatedToken,
  requireAvailable: capabilities.requireAvailable.bind(capabilities),
  authorityContext: capabilities.quarantineAuthorityContext.bind(capabilities),
  launch: launchCopilotStudioQuarantineJob,
};

export class CopilotStudioQuarantineControlService {
  constructor(
    private readonly repository = copilotStudioQuarantineJobs,
    private readonly inventory = new PowerPlatformInventoryRepository(),
    private readonly provider = new CopilotStudioQuarantineClient(),
    private readonly dependencies: ControlDependencies = defaultDependencies,
  ) {}

  async status(user: AuthenticatedUser, snapshotId: string, resourceNativeId: string, force = false) {
    const scope = controlScope(user, "AgentControl.Viewer");
    const targets = await this.inventory.resolveQuarantineTargets(scope, snapshotId, [resourceNativeId]);
    const observed = await this.observe(user, targets, force, "powerPlatform.quarantine.read");
    return statusView(targets[0], observed[0].directStatus, observed[0].source);
  }

  async preview(user: AuthenticatedUser, input: { action: QuarantineAction; snapshotId: string; resourceNativeIds: string[]; forceStatus?: boolean }) {
    const scope = controlScope(user, "AgentControl.Admin");
    const targets = await this.inventory.resolveQuarantineTargets(scope, input.snapshotId, input.resourceNativeIds);
    const frozen = (await this.observe(user, targets, Boolean(input.forceStatus), "powerPlatform.quarantine.manage")).map(value => ({ ...value.target, directStatus: value.directStatus }));
    const authority = await this.dependencies.authorityContext(user);
    const confirmation = createQuarantineConfirmation({ action: input.action, targets: frozen, actor: userActor(user), authority, requestPath: "/api/quarantine/jobs" });
    return {
      confirmationHash: confirmation.confirmationHash,
      summary: confirmation.summary,
      statuses: frozen.map(target => statusView(target, target.directStatus, "direct")),
    };
  }

  async submit(user: AuthenticatedUser, input: { action: QuarantineAction; snapshotId: string; resourceNativeIds: string[]; confirmationHash: string; idempotencyKey: string }) {
    const scope = controlScope(user, "AgentControl.Admin");
    const existing = await this.repository.existingSubmission(scope, input);
    if (existing) return existing;
    const targets = await this.inventory.resolveQuarantineTargets(scope, input.snapshotId, input.resourceNativeIds);
    const frozen = (await this.observe(user, targets, false, "powerPlatform.quarantine.manage")).map(value => ({ ...value.target, directStatus: value.directStatus }));
    const authority = await this.dependencies.authorityContext(user);
    const job = await this.repository.submit(scope, {
      action: input.action,
      targets: frozen,
      actor: userActor(user),
      authority,
      requestPath: "/api/quarantine/jobs",
      idempotencyKey: input.idempotencyKey,
      confirmationHash: input.confirmationHash,
    });
    this.dependencies.launch(job.id, scope);
    return job;
  }

  private async observe(user: AuthenticatedUser, targets: InventoryQuarantineTarget[], force: boolean, capabilityId: CapabilityId) {
    const scope = controlScope(user, capabilityId === "powerPlatform.quarantine.read" ? "AgentControl.Viewer" : "AgentControl.Admin");
    const results: Array<{ target: InventoryQuarantineTarget; directStatus: FrozenQuarantineTarget["directStatus"]; source: "cache" | "provider" } | undefined> = [];
    const missing: Array<{ target: InventoryQuarantineTarget; index: number }> = [];
    for (const [index, target] of targets.entries()) {
      const cached = force ? undefined : await this.repository.latestObservation(scope, target, 60_000);
      if (cached) results[index] = { target, directStatus: cached, source: "cache" };
      else missing.push({ target, index });
    }
    if (!missing.length) return results as Array<NonNullable<typeof results[number]>>;

    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    const current = await this.authorize(scope, capabilityId);
    const token = await this.dependencies.delegatedToken(scope.principalId, capabilityId);
    const providerResults: Array<FrozenQuarantineTarget["directStatus"]> = [];
    for (const value of missing) {
      providerResults.push(await this.provider.getStatus(token, value.target, { correlationId: randomUUID() }));
    }
    const publishUser = await this.authorize(scope, capabilityId);
    if (publishUser.homeAccountId !== current.homeAccountId) throw AppError.unauthorized("The quarantine status actor changed before publication.");
    await commitAccountSessionValidation(validation, async () => {
      for (const [resultIndex, value] of missing.entries()) {
        const directStatus = providerResults[resultIndex];
        await this.repository.recordObservation(scope, value.target, directStatus);
        results[value.index] = { target: value.target, directStatus, source: "provider" };
      }
    });
    return results as Array<NonNullable<typeof results[number]>>;
  }

  private async authorize(scope: QuarantineScope, capabilityId: CapabilityId) {
    const user = await this.dependencies.revalidateUser(scope.principalId);
    if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The quarantine status actor changed accounts.");
    await this.dependencies.requireAvailable(capabilityId, user);
    return user;
  }
}

export const copilotStudioQuarantineControl = new CopilotStudioQuarantineControlService();

function controlScope(user: AuthenticatedUser, role: "AgentControl.Viewer" | "AgentControl.Admin"): QuarantineScope {
  if (!user.tenantId || !hasAppRole(user.roles, role)) throw new AppError(403, "missing_internal_role", `Copilot Studio quarantine requires the ${role === "AgentControl.Admin" ? "Admin" : "Viewer"} role.`);
  return { tenantId: user.tenantId, principalId: user.homeAccountId };
}

function userActor(user: AuthenticatedUser) {
  return { tenantId: user.tenantId!, homeAccountId: user.homeAccountId, displayName: user.displayName, username: user.username };
}

function statusView(target: InventoryQuarantineTarget, directStatus: FrozenQuarantineTarget["directStatus"], source: "cache" | "provider" | "direct") {
  return {
    target: { resourceNativeId: target.resourceNativeId, displayName: target.displayName, environmentId: target.environmentId, botId: target.botId },
    direct: { isBotQuarantined: directStatus.isBotQuarantined, providerUpdatedAt: directStatus.lastUpdateTimeUtc, observedAt: directStatus.observedAt, correlationId: directStatus.correlationId, source },
    inventory: { isQuarantined: target.inventoryQuarantineState, quarantinedAt: target.inventoryQuarantinedAt, observedAt: target.inventoryObservedAt, snapshotId: target.snapshotId },
    disagreesWithInventory: target.inventoryQuarantineState !== null && target.inventoryQuarantineState !== directStatus.isBotQuarantined,
  };
}