import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { config } from "../config.js";
import { createJobConfirmation, type JobIntentInput } from "../db/jobs.js";
import { PackageInventoryRepository, type PackageDataScope, type PackageListQuery } from "../db/packageInventory.js";
import { PackageMutationQualificationRepository } from "../db/packageMutationQualifications.js";
import { beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { bulkJobs, launchBulkJob, reconcileBulkJob, requireWorkerCapacity, runTrackedBulkJob } from "../services/bulkJobs.js";
import { capabilities } from "../services/capabilities.js";
import { getAuditLog } from "../services/auditLog.js";
import { buildBoundedCsv, createExportPublicationValidator, publishBoundedCsv } from "../services/csvExport.js";
import { DirectoryPrincipalsClient } from "../services/directoryPrincipals.js";
import { packageInventory } from "../services/packageInventory.js";
import { capturePackageMutationState } from "../services/packageMutationState.js";
import { GraphPackagesClient } from "../services/graphPackages.js";
import type { CopilotPackageDetail, PackageAccessEntity, PackageAccessUpdate } from "../types/copilotPackage.js";
import type { AuditAction } from "../types/audit.js";
import { hasAppRole } from "../types/capability.js";
import { policyRoute } from "./policy.js";

export const agentsRouter = Router();
const directory = new DirectoryPrincipalsClient();
const packageRepository = new PackageInventoryRepository();
const mutationQualifications = new PackageMutationQualificationRepository();
const graphPackages = new GraphPackagesClient();

policyRoute(agentsRouter, "get", "/agents", { access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  const query = authorizePackageFilters(request, packageListQuery(request.query));
  const result = await packageRepository.list(await savedPackageScope(request, packageMode(firstQueryValue(request.query.mode))), query);
  response.json({ ...result, value: result.value.map(inventoryPackageDetail) });
});
policyRoute(agentsRouter, "get", "/directory/principals", { access: "authenticated", dataClass: "directory", roles: ["AgentControl.Viewer"], capabilityId: "graph.directory.read" }, async (request, response) => {
  const token = await acquireDelegatedToken(request.session.accountId!, "graph.directory.read");
  response.json({ value: await directory.search(token, firstQueryValue(request.query.search) ?? "", parseDirectorySearchLimit(firstQueryValue(request.query.limit))) });
});
policyRoute(agentsRouter, "post", "/directory/principals/resolve", { access: "authenticated", dataClass: "directory", roles: ["AgentControl.Viewer"], capabilityId: "graph.directory.read", csrf: true }, async (request, response) => {
  const principals = parsePackageAccessEntities(request.body?.principals, true);
  response.json({ value: await directory.resolve(await acquireDelegatedToken(request.session.accountId!, "graph.directory.read"), principals) });
});

policyRoute(agentsRouter, "post", "/agents/refresh-jobs", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const tokenMode = packageMode(request.body?.mode);
  const job = await packageInventory.submit(request.session.user!, { tokenMode, idempotencyKey: request.get("Idempotency-Key") ?? randomUUID() });
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
policyRoute(agentsRouter, "post", "/agents/refresh-jobs/:id/resume", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  response.status(202).json(await startPackageRefreshOrWaiting(request, jobId(request), packageMode(request.body?.mode)));
});
policyRoute(agentsRouter, "post", "/agents/refresh-jobs/:id/cancel", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  response.json(await packageInventory.cancel(request.session.user!, jobId(request), packageMode(request.body?.mode)));
});
policyRoute(agentsRouter, "get", "/agents/snapshots", { access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.json(await packageRepository.listSnapshots(await savedPackageScope(request, packageMode(firstQueryValue(request.query.mode))), positiveInteger(firstQueryValue(request.query.limit), 50, 50)));
});
policyRoute(agentsRouter, "get", "/agents/export.csv", { access: "authenticated", dataClass: "private_inventory_export", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  await sendPackageExport(request, response, { ...packageListQuery(request.query), limit: 5_000, offset: 0 });
});
policyRoute(agentsRouter, "post", "/agents/export.csv", { access: "authenticated", dataClass: "private_inventory_export", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const ids = request.body?.ids === undefined ? undefined : parseIds(request.body.ids, 5_000);
  const snapshotId = optionalUuid(typeof request.body?.snapshotId === "string" ? request.body.snapshotId : undefined);
  if (!snapshotId) throw new AppError(400, "snapshot_required", "Package export requires the exact saved snapshot selection.");
  const filters = request.body?.filters === undefined ? {} : packageListQueryBody(request.body.filters);
  if (ids && Object.keys(filters).length) throw new AppError(400, "invalid_export_selection", "Export either exact package IDs or one filtered snapshot selection.");
  await sendPackageExport(request, response, { snapshotId, ...(ids ? { ids } : filters), limit: 5_000, offset: 0 });
});
policyRoute(agentsRouter, "post", "/agents/details", { access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const ids = parseIds(request.body?.ids, 100);
  const scope = await savedPackageScope(request, packageMode(request.body?.mode));
  const results = await Promise.all(ids.map(async id => {
    const observed = await packageRepository.get(scope, id);
    return observed?.package ? { id, status: "succeeded" as const, package: observed.package } : { id, status: "failed" as const, message: "The saved package target is absent or stale; run an explicit exact refresh." };
  }));
  response.json({
    total: results.length,
    succeeded: results.filter(item => item.status === "succeeded").length,
    failed: results.filter(item => item.status === "failed").length,
    results,
  });
});
policyRoute(agentsRouter, "get", "/agents/bulk-jobs/:id", { access: "authenticated", dataClass: "private_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  const scope = requestScope(request);
  await bulkJobs.recover(scope.tenantId);
  const job = await bulkJobs.get(jobId(request), scope);
  if (!job) throw new AppError(404,"not_found","Job was not found.");
  response.json(job);
});
policyRoute(agentsRouter, "get", "/agents/bulk-jobs", { access: "authenticated", dataClass: "private_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  const scope = requestScope(request);
  await bulkJobs.recover(scope.tenantId);
  response.json(await bulkJobs.list(scope, positiveInteger(firstQueryValue(request.query.limit), 20, 50)));
});
policyRoute(agentsRouter, "post", "/agents/bulk-jobs/:id/cancel", { access: "authenticated", dataClass: "private_job", roles: ["AgentControl.Admin"], csrf: true }, async (request, response) => {
  const job = await bulkJobs.cancel(jobId(request), requestScope(request));
  if (!job) throw new AppError(404,"not_found","Job was not found.");
  response.json(job);
});
policyRoute(agentsRouter, "post", "/agents/bulk-jobs/:id/resume", { access: "authenticated", dataClass: "private_job", roles: ["AgentControl.Admin"], csrf: true }, async (request, response) => {
  if (request.body?.confirmed !== true) throw new AppError(400,"confirmation_required","Explicit confirmation is required to resume unsent work.");
  const scope = requestScope(request);
  const id = jobId(request);
  const job = await bulkJobs.get(id, scope);
  if (!job) throw new AppError(404,"not_found","Job was not found.");
  if (job.tokenMode !== "delegated") throw new AppError(409,"invalid_token_mode","This route can resume delegated jobs only.");
  await capabilities.requireAvailable(job.capabilityId, request.session.user!);
  await acquireDelegatedToken(scope.principalId, job.capabilityId);
  await bulkJobs.recover(scope.tenantId, true);
  if (!job.canResume) throw new AppError(409,"not_resumable","No authorized unsent work can be resumed.");
  launchBulkJob(id, scope, true);
  response.status(202).json({ ...job, status: "queued" });
});
policyRoute(agentsRouter, "post", "/agents/bulk-jobs/:id/reconcile", { access: "authenticated", dataClass: "private_job", roles: ["AgentControl.Admin"], csrf: true }, async (request, response) => {
  response.json(await reconcileBulkJob(jobId(request), requestScope(request)));
});
policyRoute(agentsRouter, "get", "/agents/:id", { access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  const id = exactId(String(request.params.id));
  const observed = await packageRepository.get(await savedPackageScope(request, packageMode(firstQueryValue(request.query.mode))), id);
  if (!observed?.package) throw new AppError(409, "package_target_stale_or_absent", "The exact native package target is absent from the selected saved observation. Refresh this target; another source ID will never be substituted.", observed);
  response.json({
    ...observed.package,
    observation: { observedAt: observed.observedAt, expiresAt: observed.expiresAt, scopeKind: observed.scopeKind, source: "Microsoft Graph package catalog", apiMaturity: "v1.0 read; preview controls" },
  });
});

policyRoute(agentsRouter, "post", "/agents/mutation-preview", { access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Admin"], csrf: true }, async (request, response) => {
  const action = packageMutationAction(request.body?.action);
  const ids = parseIds(request.body?.ids, action === "update-availability" || action === "update-installation" ? 100 : 5000);
  const accessUpdate = action === "update-availability" || action === "update-installation" ? parsePackageAccessUpdate(request.body) : undefined;
  const intent = await buildMutationIntent(request, action, ids, accessUpdate, parseMutationScope(request.body?.mutationScope));
  const preview = createJobConfirmation(intent);
  response.json({ confirmationHash: preview.confirmationHash, summary: preview.summary });
});
policyRoute(agentsRouter, "post", "/agents/mutation-canaries", { access: "authenticated", dataClass: "package_control_qualification", roles: ["AgentControl.Admin"], csrf: true }, async (request, response) => {
  const approval = parseCanaryApproval(request.body);
  const identity = await capabilities.packageQualificationIdentity(approval.action, request.session.user!);
  const record = await mutationQualifications.createApproved(request.session.user!, { ...approval, ...identity });
  response.status(201).json(canaryRecordView(record));
});
policyRoute(agentsRouter, "post", "/agents/mutation-canaries/:id/execute", { access: "authenticated", dataClass: "package_control_qualification", roles: ["AgentControl.Admin"], csrf: true }, async (request, response) => {
  const executionRequest = parseCanaryExecution(request.body);
  const originalApproved = await mutationQualifications.getApproved(request.session.user!, String(request.params.id));
  const restorationApproved = await mutationQualifications.getApproved(request.session.user!, executionRequest.restorationApprovalId);
  if (!originalApproved || !restorationApproved) throw new AppError(409, "canary_cycle_not_approved", "Both exact canary directions require current, unused approvals.");
  const owner = requestScope(request);
  const claimValidation = beginAccountSessionValidation(owner.tenantId, owner.principalId);
  const operator = await revalidateCanaryAdmin(owner);
  const originalIdentity = await capabilities.packageQualificationIdentity(originalApproved.action, operator);
  const restorationIdentity = await capabilities.packageQualificationIdentity(restorationApproved.action, operator);
  let claimed!: Awaited<ReturnType<PackageMutationQualificationRepository["claimCycle"]>>;
  await commitAccountSessionValidation(claimValidation, async () => {
    claimed = await mutationQualifications.claimCycle(operator, originalApproved.id, restorationApproved.id, originalIdentity, restorationIdentity);
  });
  let originalJobId: string | undefined;
  let restorationJobId: string | undefined;
  try {
    const originalJob = await submitCanaryJob(operator, claimed.original, originalApproved.id, "original");
    originalJobId = originalJob.id;
    await mutationQualifications.recordCycleJob(operator, claimed.original.id, originalJob.id);
    await runTrackedBulkJob(originalJob.id, owner, bulkJobs, graphPackages, canaryJobAuthorizer(operator, claimed.original, originalJob.id));
    const originalResult = await bulkJobs.get(originalJob.id, owner);
    if (originalResult?.status !== "succeeded") throw new AppError(409, "canary_original_unverified", "The original canary direction was not durably verified; restoration was not dispatched automatically.");

    const restorationJob = await submitCanaryJob(operator, claimed.restoration, originalApproved.id, "restoration");
    restorationJobId = restorationJob.id;
    await mutationQualifications.recordCycleJob(operator, claimed.restoration.id, restorationJob.id);
    await runTrackedBulkJob(restorationJob.id, owner, bulkJobs, graphPackages, canaryJobAuthorizer(operator, claimed.restoration, restorationJob.id));
    const restorationResult = await bulkJobs.get(restorationJob.id, owner);
    if (restorationResult?.status !== "succeeded") throw new AppError(409, "canary_restoration_unverified", "The restoration direction was not durably verified; no qualification was published.");

    const publicationValidation = beginAccountSessionValidation(owner.tenantId, owner.principalId);
    const currentAdmin = await revalidateCanaryAdmin(owner);
    const currentOriginalIdentity = await capabilities.packageQualificationIdentity(claimed.original.action, currentAdmin);
    const currentRestorationIdentity = await capabilities.packageQualificationIdentity(claimed.restoration.action, currentAdmin);
    let completed!: Awaited<ReturnType<PackageMutationQualificationRepository["completeCycle"]>>;
    await commitAccountSessionValidation(publicationValidation, async () => {
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
    await mutationQualifications.completeCycle(operator, claimed.original.id, claimed.restoration.id, completion).catch(() => undefined);
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

for (const action of ["block","unblock"] as const) {
  policyRoute(agentsRouter, "post", `/agents/${action}-all`, { access: "authenticated", dataClass: "package_control", roles: ["AgentControl.Admin"], capabilityId: "graph.package.block.manage", csrf: true }, async (request, response) => {
    requireExactBlockAllBody(request.body);
    const confirmedHash = confirmationHash(request);
    const existing = await existingMutationJob(request, action, confirmedHash, undefined, undefined, "bulk");
    if (existing) return response.status(202).json(existing);
    requireWorkerCapacity();
    if (!hasAppRole(request.session.user!.roles, "AgentControl.Viewer")) throw new AppError(403, "missing_internal_role", "Block-all requires Viewer catalog scope in addition to Admin control authority.");
    const packages = await packageRepository.list(requestScope(request), { limit: 5_000, offset: 0 });
    if (!packages.value.length) throw new AppError(409,"no_targets","There is no current saved broad package snapshot to operate on.");
    response.status(202).json(await submit(request, action, packages.value.map(item => item.id), undefined, "bulk", confirmedHash));
  });
  policyRoute(agentsRouter, "post", `/agents/${action}`, { access: "authenticated", dataClass: "package_control", roles: ["AgentControl.Admin"], capabilityId: "graph.package.block.manage", csrf: true }, async (request, response) => {
    response.status(202).json(await submit(request, action, parseBulkActionIds(request.body), undefined, "bulk", confirmationHash(request)));
  });
  policyRoute(agentsRouter, "post", `/agents/:id/${action}`, { access: "authenticated", dataClass: "package_control", roles: ["AgentControl.Admin"], capabilityId: "graph.package.block.manage", csrf: true }, async (request, response) => {
    response.status(202).json(await submit(request, action, [exactId(String(request.params.id))], undefined, "single", confirmationHash(request)));
  });
}
policyRoute(agentsRouter, "post", "/agents/access", { access: "authenticated", dataClass: "package_control", roles: ["AgentControl.Admin"], capabilityId: "graph.package.access.manage", csrf: true }, async (request, response) => {
  const update = parsePackageAccessUpdate(request.body);
  response.status(202).json(await submit(request, update.target === "availability" ? "update-availability" : "update-installation", parseIds(request.body?.ids, 100), update, "bulk", confirmationHash(request)));
});
policyRoute(agentsRouter, "patch", "/agents/:id/access", { access: "authenticated", dataClass: "package_control", roles: ["AgentControl.Admin"], capabilityId: "graph.package.access.manage", csrf: true }, async (request, response) => {
  const update = parsePackageAccessUpdate(request.body);
  if (update.mode !== "replace") throw new AppError(400,"invalid_access_update","Single-agent access updates use replace mode.");
  response.status(202).json(await submit(request, update.target === "availability" ? "update-availability" : "update-installation", [exactId(String(request.params.id))], update, "single", confirmationHash(request)));
});

async function submit(request: Request, action: AuditAction, ids: string[], accessUpdate: PackageAccessUpdate | undefined, scope: "single" | "bulk", confirmedHash: string) {
  const existing = await existingMutationJob(request, action, confirmedHash, ids, accessUpdate, scope);
  if (existing) return existing;
  requireWorkerCapacity();
  parseActionGroupId(request.get("x-agent-control-action-group-id"));
  const owner = requestScope(request);
  const capabilityId = action === "block" || action === "unblock" ? "graph.package.block.manage" : "graph.package.access.manage";
  const intent = await buildMutationIntent(request, action, ids, accessUpdate, scope);
  if (createJobConfirmation(intent).confirmationHash !== confirmedHash) throw new AppError(409, "confirmation_mismatch", "The confirmed package selection or current state changed. Review and confirm the mutation again.");
  await acquireDelegatedToken(owner.principalId, capabilityId);
  const job = await bulkJobs.submit(owner, { ...intent, confirmationHash: confirmedHash, idempotencyKey: request.get("Idempotency-Key") ?? randomUUID() });
  if (job.status === "queued") launchBulkJob(job.id, owner);
  return job;
}

async function existingMutationJob(request: Request, action: AuditAction, confirmedHash: string, targetIds: string[] | undefined, accessUpdate: PackageAccessUpdate | undefined, scope: "single" | "bulk") {
  const idempotencyKey = request.get("Idempotency-Key");
  if (!idempotencyKey) return undefined;
  const capabilityId = action === "block" || action === "unblock" ? "graph.package.block.manage"
    : action === "reassign" ? "graph.package.reassign.manage" : "graph.package.access.manage";
  const existing = await bulkJobs.getByIdempotency(requestScope(request), capabilityId, idempotencyKey, {
    action,
    accessUpdate,
    requestPath: request.path,
    scope,
    targetIds,
  });
  if (existing && existing.confirmationHash !== confirmedHash) {
    throw new AppError(409, "idempotency_mismatch", "This idempotency key already belongs to a different request.");
  }
  return existing;
}

async function buildMutationIntent(request: Request, action: AuditAction, ids: string[], accessUpdate: PackageAccessUpdate | undefined, scope: "single" | "bulk"): Promise<JobIntentInput> {
  if (accessUpdate) await requireResolvedPrincipals(request, accessUpdate);
  const owner = requestScope(request);
  const packages = await packageRepository.getMany(owner, ids);
  const targets = packages.map(({ id, package: value }) => {
    if (!value) throw new AppError(409, "package_target_stale_or_absent", "A selected native package target is absent from the current saved observation. Refresh that exact target; another source ID will never be substituted.", { id });
    return { id, displayName: value.displayName, prestate: capturePackageMutationState(value, action) };
  });
  return { action, targets, accessUpdate, actor: request.session.user!, requestPath: request.path, scope };
}

async function requireResolvedPrincipals(request: Request, update: PackageAccessUpdate) {
  if (!update.principals.length) return;
  await capabilities.requireAvailable("graph.directory.read", request.session.user!);
  const resolved = await directory.resolve(await acquireDelegatedToken(request.session.accountId!, "graph.directory.read"), update.principals);
  if (resolved.length !== update.principals.length || resolved.some(principal => principal.principalKind === "unknown")) {
    throw new AppError(409, "unresolved_principal", "Every package access principal must resolve to a current user, security group, or Microsoft 365 group before confirmation.");
  }
}

function confirmationHash(request: Request) {
  const value = request.body?.confirmationHash;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new AppError(400, "confirmation_required", "Submit the confirmation hash from a current package mutation preview.");
  return value;
}
function requireExactBlockAllBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("confirmationHash" in value)) {
    throw new AppError(400, "invalid_request", "Block-all accepts only the confirmation hash for the server-frozen catalog selection.");
  }
}
function jobId(request: Request) {
  const value = String(request.params.id);
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new AppError(400,"invalid_job_id","Invalid job ID.");
  return value;
}
function exactId(value: string) {
  if (!value.trim() || value.length > 512) throw new AppError(400,"invalid_request","Each id must be a non-empty string of at most 512 characters.");
  return value.trim();
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
export function parseBulkActionIds(body: unknown) { return parseIds((body as { ids?: unknown })?.ids, 5000); }
function parseIds(value: unknown, limit: number) {
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

export function inventoryPackageDetail(detail: CopilotPackageDetail): CopilotPackageDetail {
  const { allowedUsersAndGroups: _allowed, acquireUsersAndGroups: _acquire, ...inventory } = detail;
  return inventory;
}

async function savedPackageScope(request: Request, mode: "delegated" | "application"): Promise<PackageDataScope> {
  const owner = requestScope(request);
  if (mode === "delegated") return owner;
  await capabilities.requireApplicationDataScope("graph.package.read.application", request.session.user!);
  if (!config.clientId) throw new AppError(503, "not_configured", "Application package reads require configured tenant and client identity.");
  return { tenantId: owner.tenantId, principalId: config.clientId };
}

function packageMode(value: unknown) {
  if (value === undefined || value === null || value === "") return "delegated" as const;
  if (value !== "delegated" && value !== "application") throw new AppError(400, "invalid_token_mode", "Package read mode must be delegated or application.");
  return value;
}

function packageListQuery(query: Record<string, unknown>): PackageListQuery {
  const blocked = firstQueryValue(query.blocked);
  return {
    snapshotId: optionalUuid(firstQueryValue(query.snapshotId)),
    search: optionalText(firstQueryValue(query.search), 256),
    operationIdPrefix: optionalOperationIdPrefix(firstQueryValue(query.operationIdPrefix)),
    blocked: blocked === undefined ? undefined : blocked === "true" ? true : blocked === "false" ? false : invalidPackageQuery("blocked must be true or false"),
    publisher: optionalText(firstQueryValue(query.publisher), 256),
    availableTo: optionalText(firstQueryValue(query.availableTo), 128),
    deployedTo: optionalText(firstQueryValue(query.deployedTo), 128),
    host: optionalText(firstQueryValue(query.host), 256),
    platform: optionalText(firstQueryValue(query.platform), 256),
    createdWithinDays: optionalPositiveInteger(firstQueryValue(query.createdWithinDays), 3650),
    sortBy: packageSort(firstQueryValue(query.sortBy)),
    sortDirection: firstQueryValue(query.sortDirection) === "desc" ? "desc" : "asc",
    limit: positiveInteger(firstQueryValue(query.limit), 50, 250),
    offset: positiveInteger(firstQueryValue(query.offset), 0, 100_000, true),
  };
}

function authorizePackageFilters(request: Request, query: PackageListQuery): PackageListQuery {
  if (!query.operationIdPrefix) return query;
  if (!request.session.user || !hasAppRole(request.session.user.roles, "AgentControl.Viewer")) {
    throw new AppError(403, "missing_internal_role", "Viewer is required for audit operation reference filters.");
  }
  return { ...query, auditPrincipalId: requestScope(request).principalId };
}

function packageListQueryBody(value: unknown): PackageListQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidPackageQuery("export filters are invalid");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["search", "operationIdPrefix", "blocked", "publisher", "availableTo", "deployedTo", "host", "platform", "createdWithinDays", "sortBy", "sortDirection"]);
  if (Object.keys(input).some(key => !allowed.has(key))) return invalidPackageQuery("export filters contain an unsupported field");
  const blocked = input.blocked;
  return {
    search: optionalText(input.search, 256),
    operationIdPrefix: optionalOperationIdPrefix(typeof input.operationIdPrefix === "string" ? input.operationIdPrefix : undefined),
    blocked: blocked === undefined ? undefined : typeof blocked === "boolean" ? blocked : invalidPackageQuery("blocked must be true or false"),
    publisher: optionalText(input.publisher, 256),
    availableTo: optionalText(input.availableTo, 128),
    deployedTo: optionalText(input.deployedTo, 128),
    host: optionalText(input.host, 256),
    platform: optionalText(input.platform, 256),
    createdWithinDays: input.createdWithinDays === undefined ? undefined : optionalPositiveInteger(String(input.createdWithinDays), 3650),
    sortBy: packageSort(typeof input.sortBy === "string" ? input.sortBy : undefined),
    sortDirection: input.sortDirection === "desc" ? "desc" : "asc",
  };
}

function packageSort(value: string | undefined) {
  const allowed = ["displayName", "publisher", "lastModifiedAt"] as const;
  return allowed.includes(value as typeof allowed[number]) ? value as typeof allowed[number] : "displayName";
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number, allowZero = false) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1) || parsed > maximum) return invalidPackageQuery("paging value is outside the supported range");
  return parsed;
}

function optionalText(value: unknown, maximum: number) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maximum || /[\r\n\0]/.test(value)) return invalidPackageQuery("query text is invalid");
  return value;
}

function optionalOperationIdPrefix(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) return invalidPackageQuery("operation reference is invalid");
  return value;
}

function optionalPositiveInteger(value: string | undefined, maximum: number) {
  if (value === undefined || value === "") return undefined;
  return positiveInteger(value, 1, maximum);
}

function optionalUuid(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) return invalidPackageQuery("snapshot ID is invalid");
  return value;
}

function invalidPackageQuery(message: string): never {
  throw new AppError(400, "invalid_package_query", `Package ${message}.`);
}

function packageMutationAction(value: unknown): AuditAction {
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

async function submitCanaryJob(
  operator: Awaited<ReturnType<typeof revalidateAuthenticatedUser>>,
  approval: Awaited<ReturnType<PackageMutationQualificationRepository["getApproved"]>> & {},
  cycleId: string,
  stage: "original" | "restoration",
) {
  const intent: JobIntentInput = {
    action: approval.action,
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
) {
  return async (scope: ReturnType<typeof requestScope>, capabilityId: Parameters<typeof acquireDelegatedToken>[1]) => {
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    const current = await revalidateCanaryAdmin(scope);
    const identity = await capabilities.packageQualificationIdentity(approval.action, current);
    if (identity.capabilityId !== capabilityId || current.homeAccountId !== operator.homeAccountId) throw AppError.unauthorized("The canary job no longer matches its exact approval actor or capability.");
    const token = await acquireDelegatedToken(scope.principalId, capabilityId);
    await commitAccountSessionValidation(validation, () => mutationQualifications.authorizeCycleJob(current, approval.id, jobId, identity));
    return token;
  };
}

async function revalidateCanaryAdmin(scope: ReturnType<typeof requestScope>) {
  const user = await revalidateAuthenticatedUser(scope.principalId);
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) throw AppError.unauthorized("The canary Admin no longer matches the signed-in account.");
  if (!hasAppRole(user.roles, "AgentControl.Admin")) throw new AppError(403, "missing_internal_role", "AgentControl.Admin is required for the full canary cycle.");
  return user;
}

async function canaryFailureCompletion(scope: ReturnType<typeof requestScope>, originalJobId?: string, restorationJobId?: string) {
  const original = originalJobId ? await bulkJobs.get(originalJobId, scope) : undefined;
  const restoration = restorationJobId ? await bulkJobs.get(restorationJobId, scope) : undefined;
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

async function sendPackageExport(request: Request, response: Response, query: PackageListQuery) {
  query = authorizePackageFilters(request, query);
  if (!query.snapshotId) throw new AppError(400, "snapshot_required", "Package export requires the exact saved snapshot selection.");
  const deadlineAt = Date.now() + 15_000;
  const owner = requestScope(request);
  const validateSession = createExportPublicationValidator(request, "AgentControl.Viewer");
  const validateAuditSession = query.operationIdPrefix ? createExportPublicationValidator(request, "AgentControl.Viewer") : undefined;
  const mode = packageMode(firstQueryValue(request.query.mode));
  const sourceScope = await savedPackageScope(request, mode);
  let auditedSelection: string | undefined;
  const validatePublication = async () => {
    await validateSession();
    await validateAuditSession?.();
    const currentScope = await savedPackageScope(request, mode);
    await packageRepository.assertSnapshotCurrent(currentScope, query.snapshotId!);
    if (auditedSelection !== undefined) {
      const current = await packageRepository.list(currentScope, query);
      if (JSON.stringify(current.value.map(value => value.id)) !== auditedSelection) {
        throw new AppError(409, "dataset_invalidated", "The authorized audit reference selection changed before export publication completed.");
      }
    }
  };
  const audit = getAuditLog(owner);
  const event = await audit.startEvent({
    operationId: `export-package-inventory:${randomUUID()}`,
    scope: "bulk",
    action: "export-package-inventory",
    agentId: query.snapshotId ?? "current-package-inventory",
    actor: request.session.user!,
    requestPath: request.path,
    metadata: { source: "graph_packages", snapshotId: query.snapshotId ?? "current" },
  });
  try {
    await validatePublication();
    const result = await packageRepository.list(sourceScope, query);
    if (query.operationIdPrefix) auditedSelection = JSON.stringify(result.value.map(value => value.id));
    if (!result.snapshot) throw new AppError(409, "snapshot_unavailable", "The exact package snapshot is no longer available.");
    if (result.count > 5_000 || result.value.length !== result.count) {
      throw new AppError(413, "export_row_limit", "The filtered package selection exceeds the 5,000 row export limit.");
    }
    if (query.ids && result.count !== query.ids.length) {
      throw new AppError(409, "export_selection_changed", "One or more exact package export targets are no longer members of the selected snapshot.");
    }
    const columns = ["id", "displayName", "publisher", "isBlocked", "availableTo", "deployedTo", "lastModifiedDateTime", "sourceSystem", "snapshotId", "snapshotObservedAt", "snapshotExpiresAt"] as const;
    const rows = result.value.map(value => ({
      ...value,
      snapshotId: result.snapshot!.id,
      snapshotObservedAt: result.snapshot!.observedAt,
      snapshotExpiresAt: result.snapshot!.expiresAt,
    }));
    const csv = buildBoundedCsv(columns, rows, { maximumRows: 5_000, maximumBytes: 8_000_000, deadlineAt });
    await publishBoundedCsv(request, response, "package-inventory.csv", csv.buffer, {
      deadlineAt, validate: validatePublication, beforeEnd: () => audit.completeEvent(event.id, {
        status: "succeeded", metadata: {
        source: "graph_packages",
        snapshotId: result.snapshot?.id ?? null,
        resultingCount: csv.rowCount,
        resultingBytes: csv.byteCount,
        },
      }).then(() => undefined),
    });
  } catch (error) {
    await audit.completeEvent(event.id, {
      status: "failed",
      errorCode: error instanceof AppError ? error.code : "package_export_failed",
    });
    if (response.headersSent) {
      if (!response.destroyed) response.destroy();
      return;
    }
    throw error;
  }
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