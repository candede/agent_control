import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { getTenantConfiguration } from "../config.js";
import { createJobConfirmation, JobRepository, type JobIntentInput } from "../db/jobs.js";
import { PackageRefreshJobs, type PackageDataScope } from "../db/packageRefreshJobs.js";
import { packageCanaryMutation, PackageMutationQualificationRepository } from "../db/packageMutationQualifications.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError, errorTelemetry, isTimeoutError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { bulkJobs, launchBulkJob, reconcileBulkJob, runTrackedBulkJob } from "../services/bulkJobs.js";
import { capabilities } from "../services/capabilities.js";
import { DirectoryPrincipalsClient } from "../services/directoryPrincipals.js";
import { packageInventory } from "../services/packageInventory.js";
import { GraphPackagesClient } from "../services/graphPackages.js";
import { requireProviderAdmissions } from "../services/operationalState.js";
import { operationalLog } from "../services/telemetry.js";
import type { PackageAccessEntity, PackageAccessUpdate } from "../types/copilotPackage.js";
import type { AuditAction } from "../types/audit.js";
import { hasAppRole } from "../types/capability.js";
import { policyRoute } from "./policy.js";
import { reportIdentity } from "../services/reportIdentity.js";
import { SelectionError } from "../services/dataSelections.js";

export const agentsRouter = Router();
const directory = new DirectoryPrincipalsClient();
const packageRepository = new PackageRefreshJobs();
const mutationQualifications = new PackageMutationQualificationRepository();
const graphPackages = new GraphPackagesClient();

policyRoute(agentsRouter, "get", "/directory/principals", { access: "authenticated", dataClass: "directory", roles: ["AgentControl.Viewer"], capabilityId: "graph.directory.read" }, async (request, response) => {
  const search = firstQueryValue(request.query.search) ?? "";
  const limit = parseDirectorySearchLimit(firstQueryValue(request.query.limit));
  await withDirectoryRequest(request, response, async (token, signal, assertCurrent) => {
    const value = await directory.search(token, search, limit, signal, assertCurrent);
    assertCurrent();
    response.json({ value });
  });
});
policyRoute(agentsRouter, "post", "/directory/principals/resolve", { access: "authenticated", dataClass: "directory", roles: ["AgentControl.Viewer"], capabilityId: "graph.directory.read", csrf: true }, async (request, response) => {
  const principals = parsePackageAccessEntities(request.body?.principals, true);
  await withDirectoryRequest(request, response, async (token, signal, assertCurrent) => {
    const value = await directory.resolve(token, principals, signal, assertCurrent);
    assertCurrent();
    response.json({ value });
  });
});

policyRoute(agentsRouter, "post", "/agents/refresh-jobs", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const tokenMode = packageMode(request.body?.mode);
  const requestedIds = parsePackageRefreshIds(request.body?.ids);
  const job = await packageInventory.submit(request.session.user!, { tokenMode, requestedIds, idempotencyKey: request.get("Idempotency-Key") ?? randomUUID() });
  response.status(202).json(job.status === "waiting_authorization" ? await startPackageRefreshOrWaiting(request, job.id, tokenMode) : job);
});
policyRoute(agentsRouter, "post", "/agents/:id/refresh-jobs", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const tokenMode = packageMode(request.body?.mode);
  const id = exactId(String(request.params.id));
  const job = await packageInventory.submit(request.session.user!, { tokenMode, idempotencyKey: request.get("Idempotency-Key") ?? randomUUID(), requestedIds: [id] });
  response.status(202).json(job.status === "waiting_authorization" ? await startPackageRefreshOrWaiting(request, job.id, tokenMode) : job);
});
policyRoute(agentsRouter, "get", "/agents/refresh-jobs", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  const mode = packageMode(firstQueryValue(request.query.mode));
  const scope = await savedPackageScope(request, mode);
  response.json(await packageRepository.listJobs(scope, request.session.user!.homeAccountId, positiveInteger(firstQueryValue(request.query.limit), 20, 50)));
});
policyRoute(agentsRouter, "get", "/agents/refresh-jobs/:id", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.json(await packageInventory.get(request.session.user!, jobId(request), packageMode(firstQueryValue(request.query.mode))));
});
export function createAgentRefreshTargetsRouter(database: pg.Pool) {
  const router = Router(), repository = new PackageRefreshJobs(database);
  policyRoute(router, "get", "/agents/refresh-jobs/:id/targets", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
    const mode = packageMode(firstQueryValue(request.query.mode));
    if (Object.keys(request.query).some(key => !["mode", "limit", "revision", "cursor"].includes(key))
      || request.query.limit !== undefined && (typeof request.query.limit !== "string" || !/^[1-9]\d{0,2}$/.test(request.query.limit))) throw new SelectionError("invalid_cursor");
    response.json(await repository.targets(await savedPackageScope(request, mode), await reportIdentity(database, request.session.user!), jobId(request),
      { limit: request.query.limit === undefined ? 50 : Number(request.query.limit), revision: firstQueryValue(request.query.revision), cursor: firstQueryValue(request.query.cursor) }));
  });
  return router;
}
policyRoute(agentsRouter, "post", "/agents/refresh-jobs/:id/resume", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  response.status(202).json(await startPackageRefreshOrWaiting(request, jobId(request), packageMode(request.body?.mode)));
});
policyRoute(agentsRouter, "post", "/agents/refresh-jobs/:id/cancel", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  response.json(await packageInventory.cancel(request.session.user!, jobId(request), packageMode(request.body?.mode)));
});
export function createAgentJobReadRouter(database: pg.Pool) {
const router = Router(), repository = new JobRepository(database);
policyRoute(router, "get", "/agents/bulk-jobs/:id", { access: "authenticated", dataClass: "private_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  const scope = requestScope(request);
  const job = await repository.get(jobId(request), scope);
  if (!job) throw new AppError(404,"not_found","Job was not found.");
  response.json(job);
});
policyRoute(router, "get", "/agents/bulk-jobs/:id/items", { access: "authenticated", dataClass: "private_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.setHeader("Cache-Control", "private, no-store");
  if (Object.keys(request.query).some(key => !["revision", "cursor", "limit"].includes(key))
    || Object.values(request.query).some(value => typeof value !== "string")) throw new SelectionError("invalid_cursor");
  const query = request.query as Record<string, string>;
  if (query.limit !== undefined && !/^[1-9]\d*$/.test(query.limit)
    || query.revision !== undefined && !/^\d+$/.test(query.revision)) throw new SelectionError("invalid_cursor");
  response.json(await repository.items(jobId(request), await reportIdentity(database, request.session.user!), {
    revision: query.revision, cursor: query.cursor, limit: query.limit === undefined ? 50 : Number(query.limit),
  }));
});
policyRoute(router, "get", "/agents/bulk-jobs", { access: "authenticated", dataClass: "private_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  const scope = requestScope(request);
  response.json(await repository.list(scope, positiveInteger(firstQueryValue(request.query.limit), 20, 50)));
});
return router;
}
policyRoute(agentsRouter, "post", "/agents/bulk-jobs/:id/cancel", { access: "authenticated", dataClass: "private_job", roles: ["AgentControl.Admin"], csrf: true }, async (request, response) => {
  const job = await bulkJobs.cancel(jobId(request), requestScope(request));
  if (!job) throw new AppError(404,"not_found","Job was not found.");
  response.json(job);
});
policyRoute(agentsRouter, "post", "/agents/bulk-jobs/:id/resume", { access: "authenticated", dataClass: "private_job", roles: ["AgentControl.Admin"], csrf: true }, async (request, response) => {
  if (request.body?.confirmed !== true) throw new AppError(400,"confirmation_required","Explicit confirmation is required to resume unsent work.");
  const scope = requestScope(request);
  const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
  const id = jobId(request);
  let job = await bulkJobs.get(id, scope);
  if (!job) throw new AppError(404,"not_found","Job was not found.");
  if (job.tokenMode !== "delegated") throw new AppError(409,"invalid_token_mode","This route can resume delegated jobs only.");
  await capabilities.requireAvailable(job.capabilityId, request.session.user!);
  await acquireDelegatedToken(scope.tenantId, scope.principalId, job.capabilityId);
  await bulkJobs.recover(scope.tenantId, true, id);
  job = await bulkJobs.get(id, scope);
  if (!job) throw new AppError(404,"not_found","Job was not found.");
  if (!job.canResume) throw new AppError(409,"not_resumable","No authorized unsent work can be resumed.");
  await commitAccountSessionValidation(validation, async () => launchBulkJob(id, scope, true));
  response.status(202).json({ ...job, status: "queued", canResume: false });
});
policyRoute(agentsRouter, "post", "/agents/bulk-jobs/:id/reconcile", { access: "authenticated", dataClass: "private_job", roles: ["AgentControl.Admin"], csrf: true }, async (request, response) => {
  response.json(await reconcileBulkJob(jobId(request), requestScope(request)));
});
policyRoute(agentsRouter, "post", "/agents/mutation-canaries", { access: "authenticated", dataClass: "package_control_qualification", roles: ["AgentControl.Admin"], csrf: true }, async (request, response) => {
  const approval = parseCanaryApproval(request.body);
  const owner = requestScope(request);
  const validation = beginAccountSessionValidation(owner.tenantId, owner.principalId);
  const administrator = await revalidateCanaryAdmin(owner);
  const identity = await capabilities.packageQualificationIdentity(approval.action, administrator);
  const record = await commitAccountSessionValidation(validation, () => mutationQualifications.createApproved(administrator, { ...approval, ...identity }));
  response.status(201).json(canaryRecordView(record));
});
policyRoute(agentsRouter, "post", "/agents/mutation-canaries/:id/execute", { access: "authenticated", dataClass: "package_control_qualification", roles: ["AgentControl.Admin"], csrf: true }, async (request, response) => {
  const executionRequest = parseCanaryExecution(request.body);
  const owner = requestScope(request);
  const validation = beginAccountSessionValidation(owner.tenantId, owner.principalId);
  const originalApproved = await mutationQualifications.getApproved(request.session.user!, String(request.params.id));
  const restorationApproved = await mutationQualifications.getApproved(request.session.user!, executionRequest.restorationApprovalId);
  if (!originalApproved || !restorationApproved) throw new AppError(409, "canary_cycle_not_approved", "Both exact canary directions require current, unused approvals.");
  assertAccountSessionValidation(validation);
  const operator = await revalidateCanaryAdmin(owner);
  const originalIdentity = await capabilities.packageQualificationIdentity(originalApproved.action, operator);
  const restorationIdentity = await capabilities.packageQualificationIdentity(restorationApproved.action, operator);
  let claimed!: Awaited<ReturnType<PackageMutationQualificationRepository["claimCycle"]>>;
  await commitAccountSessionValidation(validation, async () => {
    claimed = await mutationQualifications.claimCycle(operator, originalApproved.id, restorationApproved.id, originalIdentity, restorationIdentity);
  });
  let originalJobId: string | undefined;
  let restorationJobId: string | undefined;
  try {
    const originalJob = await commitAccountSessionValidation(validation, () => submitCanaryJob(operator, claimed.original, originalApproved.id, "original"));
    originalJobId = originalJob.id;
    await mutationQualifications.recordCycleJob(operator, claimed.original.id, originalJob.id);
    assertAccountSessionValidation(validation);
    await runTrackedBulkJob(originalJob.id, owner, bulkJobs, graphPackages, canaryJobAuthorizer(operator, claimed.original, originalJob.id, validation));
    const originalResult = await bulkJobs.get(originalJob.id, owner);
    if (originalResult?.status !== "succeeded") throw new AppError(409, "canary_original_unverified", "The original canary direction was not durably verified; restoration was not dispatched automatically.");

    const restorationJob = await commitAccountSessionValidation(validation, () => submitCanaryJob(operator, claimed.restoration, originalApproved.id, "restoration"));
    restorationJobId = restorationJob.id;
    await mutationQualifications.recordCycleJob(operator, claimed.restoration.id, restorationJob.id);
    assertAccountSessionValidation(validation);
    await runTrackedBulkJob(restorationJob.id, owner, bulkJobs, graphPackages, canaryJobAuthorizer(operator, claimed.restoration, restorationJob.id, validation));
    const restorationResult = await bulkJobs.get(restorationJob.id, owner);
    if (restorationResult?.status !== "succeeded") throw new AppError(409, "canary_restoration_unverified", "The restoration direction was not durably verified; no qualification was published.");

    assertAccountSessionValidation(validation);
    const currentAdmin = await revalidateCanaryAdmin(owner);
    const currentOriginalIdentity = await capabilities.packageQualificationIdentity(claimed.original.action, currentAdmin);
    const currentRestorationIdentity = await capabilities.packageQualificationIdentity(claimed.restoration.action, currentAdmin);
    let completed!: Awaited<ReturnType<PackageMutationQualificationRepository["completeCycle"]>>;
    await commitAccountSessionValidation(validation, async () => {
      completed = await mutationQualifications.completeCycle(currentAdmin, claimed.original.id, claimed.restoration.id, { status: "qualified" }, currentOriginalIdentity, currentRestorationIdentity);
    });
    response.json({
      status: "qualified",
      original: canaryRecordView(completed.original),
      restoration: canaryRecordView(completed.restoration),
      jobs: { originalId: originalJob.id, restorationId: restorationJob.id },
    });
  } catch {
    const completion = await canaryFailureCompletion(owner, originalJobId, restorationJobId);
    await mutationQualifications.completeCycle(operator, claimed.original.id, claimed.restoration.id, completion).catch(error => {
      operationalLog("error", "package_canary_completion_failed", {
        jobId: restorationJobId ?? originalJobId, outcome: "requires_review", ...errorTelemetry(error),
      });
    });
    throw new AppError(409, "canary_cycle_incomplete", completion.status === "restoration_conflict"
      ? "The original canary effect was verified, but exact restoration was not; stop for operator review."
      : "The full canary cycle was not verified, so no qualification was published.",
    { originalJobId, restorationJobId });
  }
});
export function parseMutationScope(value: unknown): "single" | "bulk" {
  if (value !== "single" && value !== "bulk") throw new AppError(400, "invalid_mutation_scope", "Mutation preview requires a single or bulk mutationScope.");
  return value;
}

export async function requireResolvedPrincipals(request: Request, update: PackageAccessUpdate) {
  if (!update.principals.length) return;
  await withDirectoryRequest(request, request.res, async (token, signal, assertCurrent) => {
    const resolved = await directory.resolve(token, update.principals, signal, assertCurrent);
    assertCurrent();
    if (resolved.length !== update.principals.length || resolved.some(principal => principal.principalKind === "unknown")) {
      throw new AppError(409, "unresolved_principal", "Every package access principal must resolve to a current user, security group, or Microsoft 365 group before confirmation.");
    }
  });
}

async function withDirectoryRequest(
  request: Request,
  response: Response | undefined,
  operation: (token: string, signal: AbortSignal, assertCurrent: () => void) => Promise<void>,
) {
  const scope = requestScope(request);
  const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
  const assertCurrent = () => {
    signal.throwIfAborted();
    assertAccountSessionValidation(validation);
    requireProviderAdmissions();
  };
  const disconnected = () => {
    if (!response?.writableEnded) controller.abort(new AppError(499, "request_cancelled", "Directory request was cancelled."));
  };
  response?.once("close", disconnected);
  if (response?.destroyed) disconnected();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const work = async () => {
      assertCurrent();
      await capabilities.requireAvailable("graph.directory.read", request.session.user!);
      assertCurrent();
      const token = await acquireDelegatedToken(scope.tenantId, scope.principalId, "graph.directory.read");
      assertCurrent();
      await operation(token, signal, assertCurrent);
    };
    await Promise.race([work(), aborted]);
  } catch (error) {
    if (isTimeoutError(error)) throw new AppError(504, "provider_timeout", "Directory request exceeded its bounded deadline.");
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    response?.off("close", disconnected);
  }
}

export function confirmationHash(request: Request) {
  const value = request.body?.confirmationHash;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new AppError(400, "confirmation_required", "Submit the confirmation hash from a current package mutation preview.");
  return value;
}
function jobId(request: Request) {
  const value = String(request.params.id);
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new AppError(400,"invalid_job_id","Invalid job ID.");
  return value;
}
export function exactId(value: string) {
  if (!value.trim() || value.length > 512) throw new AppError(400,"invalid_request","Each id must be a non-empty string of at most 512 characters.");
  return value;
}
function firstQueryValue(value: unknown) { return Array.isArray(value) ? typeof value[0] === "string" ? value[0] : undefined : typeof value === "string" ? value : undefined; }
export function parseActionGroupId(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 64 || !/^[a-zA-Z0-9-]+$/.test(normalized)) throw new AppError(400,"invalid_action_group_id","Action group ID is invalid.");
  return normalized;
}
export function parseDirectorySearchLimit(value: string | undefined) {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new AppError(400,"invalid_directory_limit","Directory search limit must be a positive integer up to 50.");
  return limit;
}
export function parseIds(value: unknown, limit: number) {
  if (!Array.isArray(value) || !value.length || value.length > limit) throw new AppError(400,"invalid_request",`Expected 1-${limit} ids.`);
  const result = value.map(id => {
    if (typeof id !== "string") throw new AppError(400,"invalid_request","Each id must be a non-empty string.");
    return exactId(id);
  });
  if (new Set(result).size !== result.length) throw new AppError(400, "duplicate_target", "Duplicate package IDs are not allowed.");
  return result;
}
function parsePackageAccessEntities(value: unknown, required = false): PackageAccessEntity[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > 500) throw new AppError(400,"invalid_principals","Expected at most 500 principals.");
  const unique = new Map<string, PackageAccessEntity>();
  for (const item of value) {
    if (!["user","group"].includes(item?.resourceType) || typeof item?.resourceId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item.resourceId.trim())) throw new AppError(400,"invalid_principal","Each principal requires a user or group resourceType and native Microsoft Entra object ID.");
    const key = `${item.resourceType}:${item.resourceId.trim().toLowerCase()}`;
    if (unique.has(key)) throw new AppError(400, "duplicate_principal", "Duplicate package access principals are not allowed.");
    unique.set(key, { resourceType: item.resourceType, resourceId: item.resourceId.trim() });
  }
  if (required && !unique.size) throw new AppError(400,"invalid_principals","At least one principal is required.");
  return [...unique.values()];
}
export function parsePackageAccessUpdate(body: unknown): PackageAccessUpdate {
  const candidate = body as { target?: unknown; mode?: unknown; scope?: unknown; principals?: unknown };
  const { target, mode, scope } = candidate ?? {};
  if (target !== "availability" && target !== "installation") throw new AppError(400,"invalid_access_target","Access target must be availability or installation.");
  if (mode !== "add" && mode !== "replace") throw new AppError(400,"invalid_access_mode","Access mode must be add or replace.");
  if (scope === "all") throw new AppError(400,"all_users_unverified","Microsoft Graph does not document a supported write payload for All users.");
  if (scope !== "specific" && scope !== "none") throw new AppError(400,"invalid_access_scope","Access scope must be specific or none.");
  const principals = parsePackageAccessEntities(candidate.principals);
  if (scope === "none") {
    if (mode !== "replace" || principals.length) throw new AppError(400,"invalid_access_update","No users requires replace mode and no principals.");
    return { target, mode, scope, principals: [] };
  }
  if (!principals.length) throw new AppError(400,"invalid_access_update","At least one principal is required for specific access.");
  return { target, mode, scope, principals };
}

export function parsePackageRefreshIds(value: unknown) {
  return value === undefined ? undefined : parseIds(value, 5000);
}

async function savedPackageScope(request: Request, mode: "delegated" | "application"): Promise<PackageDataScope> {
  const owner = requestScope(request);
  if (mode === "delegated") return { ...owner, tokenMode: mode };
  await capabilities.requireApplicationDataScope("graph.package.read.application", request.session.user!);
  return { tenantId: owner.tenantId, principalId: getTenantConfiguration(owner.tenantId).clientId, tokenMode: mode };
}

function packageMode(value: unknown) {
  if (value === undefined || value === null || value === "") return "delegated" as const;
  if (value !== "delegated" && value !== "application") throw new AppError(400, "invalid_token_mode", "Package read mode must be delegated or application.");
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number, allowZero = false) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1) || parsed > maximum) return invalidPackageQuery("paging value is outside the supported range");
  return parsed;
}

function invalidPackageQuery(message: string): never {
  throw new AppError(400, "invalid_package_query", `Package ${message}.`);
}

export function packageMutationAction(value: unknown): AuditAction {
  if (!["block", "unblock", "update-availability", "update-installation", "reassign"].includes(String(value))) throw new AppError(400, "invalid_mutation_action", "Package mutation action is invalid.");
  return value as AuditAction;
}

function parseCanaryApproval(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "invalid_qualification", "Canary approval requires one exact target and typed prestate/poststate.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 4 || keys.some((key, index) => key !== ["action", "poststate", "prestate", "targetId"][index])) {
    throw new AppError(400, "invalid_qualification", "Canary approval accepts only action, targetId, prestate, and poststate.");
  }
  return { action: packageMutationAction(record.action), targetId: exactId(String(record.targetId)), prestate: record.prestate, poststate: record.poststate };
}

function parseCanaryExecution(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "confirmation_required", "Canary execution requires exact confirmation and a separate restoration approval.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "confirmed" || keys[1] !== "restorationApprovalId" || record.confirmed !== true || typeof record.restorationApprovalId !== "string") {
    throw new AppError(400, "confirmation_required", "Canary execution accepts only confirmed true and restorationApprovalId.");
  }
  return { restorationApprovalId: canaryId(record.restorationApprovalId) };
}

function canaryRecordView(record: Awaited<ReturnType<PackageMutationQualificationRepository["createApproved"]>>) {
  return {
    id: record.id,
    targetId: record.targetId,
    action: record.action,
    status: record.status,
    approvedBy: { principalId: record.approvedByPrincipalId, displayName: record.approvedBy },
    actor: record.actorPrincipalId ? { principalId: record.actorPrincipalId, displayName: record.actorName } : null,
    contractRevision: record.contractRevision,
    configurationRevision: record.configurationRevision,
    authMode: record.authMode,
    cycleStage: record.cycleStage,
    jobId: record.jobId,
    approvedAt: record.approvedAt,
    attemptedAt: record.attemptedAt,
    expiresAt: record.expiresAt,
    restoredAt: record.restoredAt,
  };
}

export async function submitCanaryJob(
  operator: Awaited<ReturnType<typeof revalidateAuthenticatedUser>>,
  approval: Pick<NonNullable<Awaited<ReturnType<PackageMutationQualificationRepository["getApproved"]>>>, "id" | "targetId" | "action" | "prestate" | "poststate">,
  cycleId: string,
  stage: "original" | "restoration",
) {
  const intent: JobIntentInput = {
    action: approval.action,
    accessUpdate: packageCanaryMutation(approval).accessUpdate,
    targets: [{ id: approval.targetId, displayName: "Approved package canary", prestate: approval.prestate }],
    actor: operator,
    requestPath: `/api/agents/mutation-canaries/${cycleId}/execute/${stage}`,
    scope: "single",
  };
  return bulkJobs.submit({ tenantId: operator.tenantId!, principalId: operator.homeAccountId }, {
    ...intent,
    confirmationHash: createJobConfirmation(intent).confirmationHash,
    idempotencyKey: `canary-${approval.id}-${stage}`,
  });
}

function canaryJobAuthorizer(
  operator: Awaited<ReturnType<typeof revalidateAuthenticatedUser>>,
  approval: Awaited<ReturnType<PackageMutationQualificationRepository["getApproved"]>> & {},
  jobId: string,
  validation: ReturnType<typeof beginAccountSessionValidation>,
) {
  return async (scope: ReturnType<typeof requestScope>, capabilityId: Parameters<typeof acquireDelegatedToken>[2]) => {
    assertAccountSessionValidation(validation);
    const current = await revalidateCanaryAdmin(scope);
    const identity = await capabilities.packageQualificationIdentity(approval.action, current);
    if (identity.capabilityId !== capabilityId || current.homeAccountId !== operator.homeAccountId) throw AppError.unauthorized("The canary job no longer matches its exact approval actor or capability.");
    const token = await acquireDelegatedToken(scope.tenantId, scope.principalId, capabilityId);
    await commitAccountSessionValidation(validation, () => mutationQualifications.authorizeCycleJob(current, approval.id, jobId, identity));
    assertAccountSessionValidation(validation);
    return token;
  };
}

async function revalidateCanaryAdmin(scope: ReturnType<typeof requestScope>) {
  const user = await revalidateAuthenticatedUser(scope.tenantId, scope.principalId);
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The canary Admin no longer matches the signed-in account.");
  if (!hasAppRole(user.roles, "AgentControl.Admin")) throw new AppError(403, "missing_internal_role", "AgentControl.Admin is required for the full canary cycle.");
  return user;
}

export async function canaryFailureCompletion(scope: ReturnType<typeof requestScope>, originalJobId?: string, restorationJobId?: string) {
  let original: Awaited<ReturnType<typeof bulkJobs.get>>;
  let restoration: Awaited<ReturnType<typeof bulkJobs.get>>;
  try {
    original = originalJobId ? await bulkJobs.get(originalJobId, scope) : undefined;
    restoration = restorationJobId ? await bulkJobs.get(restorationJobId, scope) : undefined;
  } catch (error) {
    operationalLog("error", "package_canary_result_unavailable", {
      jobId: restorationJobId ?? originalJobId, outcome: "requires_review", ...errorTelemetry(error),
    });
    return { status: "inconclusive" as const, errorCode: "canary_result_unavailable" };
  }
  if (originalJobId && (!original || original.status === "running")
    || restorationJobId && (!restoration || restoration.status === "running")) {
    return { status: "inconclusive" as const, errorCode: "canary_result_unavailable" };
  }
  if (original?.status === "succeeded" && restoration?.status !== "succeeded") {
    return restoration?.inconclusive ? { status: "inconclusive" as const, errorCode: "canary_restoration_inconclusive" }
      : { status: "restoration_conflict" as const, errorCode: "canary_restoration_unverified" };
  }
  return original?.inconclusive ? { status: "inconclusive" as const, errorCode: "canary_original_inconclusive" }
    : { status: "failed" as const, errorCode: "canary_cycle_failed" };
}

function canaryId(value: string) {
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new AppError(400, "invalid_qualification_id", "Canary qualification ID is invalid.");
  return value;
}

async function startPackageRefreshOrWaiting(request: Request, id: string, tokenMode: "delegated" | "application") {
  try {
    return await packageInventory.start(request.session.user!, id, tokenMode);
  } catch (error) {
    if (error instanceof AppError && (error.status === 401 || error.status === 403 || ["interaction_required", "authorization_expired", "missing_permission", "capability_unavailable", "not_configured"].includes(error.code))) {
      return packageInventory.get(request.session.user!, id, tokenMode);
    }
    throw error;
  }
}