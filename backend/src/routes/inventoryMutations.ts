import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import type pg from "pg";
import { acquireDelegatedToken } from "../auth/msal.js";
import { InventoryMutationStages } from "../db/inventoryMutationStages.js";
import { JobRepository } from "../db/jobs.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { launchBulkJob, requireWorkerCapacity } from "../services/bulkJobs.js";
import { reportIdentity } from "../services/reportIdentity.js";
import type { AuditAction } from "../types/audit.js";
import { hasAppRole } from "../types/capability.js";
import type { PackageAccessUpdate } from "../types/copilotPackage.js";
import { confirmationHash, exactId, packageMutationAction, parseActionGroupId, parseIds,
  parseMutationScope, parsePackageAccessUpdate, requireResolvedPrincipals } from "./agents.js";
import { policyRoute, type RoutePolicy } from "./policy.js";

export function createInventoryMutationsRouter(database: pg.Pool) {
  const router = Router(), stages = new InventoryMutationStages(database), jobs = new JobRepository(database);
  policyRoute(router, "post", "/agents/mutation-selection",
    { access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Admin"], csrf: true }, async (request, response) => {
      const targets = selectedTargets(request, 5000);
      if (!targets.selectionId) throw new AppError(400, "invalid_selection", "Selection counts require the currently displayed inventory selection.");
      response.json(await stages.count(await reportIdentity(database, request.session.user!), targets.selectionId, targets.ids, targets.recordIds));
    });
  policyRoute(router, "post", "/agents/mutation-preview",
    { access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Admin"], csrf: true }, async (request, response) => {
      const action = packageMutationAction(request.body?.action);
      const accessUpdate = action === "update-availability" || action === "update-installation" ? parsePackageAccessUpdate(request.body) : undefined;
      const targets = selectedTargets(request, accessUpdate ? 100 : 5000);
      const scope = parseMutationScope(request.body?.mutationScope), owner = requestScope(request);
      const validation = beginAccountSessionValidation(owner.tenantId, owner.principalId);
      if (accessUpdate) await requireResolvedPrincipals(request, accessUpdate);
      const identity = await reportIdentity(database, request.session.user!);
      const selected = targets.selectionId ?? await stages.currentSelection(identity);
      const preview = await commitAccountSessionValidation(validation, () => stages.preview(identity, selected,
        { action, scope, accessUpdate, actor: request.session.user!, requestPath: request.path }, targets.ids, targets.recordIds));
      response.json(preview);
    });

  for (const action of ["block", "unblock"] as const) {
    const policy: RoutePolicy = { access: "authenticated", dataClass: "package_control", roles: ["AgentControl.Admin"],
      capabilityId: "graph.package.block.manage", csrf: true };
    policyRoute(router, "post", `/agents/${action}`, policy, async (request, response) => {
      response.status(202).json(await submit(request, action, selectedTargets(request, 5000), undefined, "bulk"));
    });
    policyRoute(router, "post", `/agents/${action}-all`, policy, async (request, response) => {
      if (Object.keys(request.body ?? {}).some(key => !["selectionId", "confirmationHash"].includes(key))
        || !request.body?.selectionId) throw new AppError(400, "invalid_request", "An all-matching mutation requires its reviewed server selection.");
      response.status(202).json(await submit(request, action, selectedTargets(request, 5000), undefined, "bulk"));
    });
    policyRoute(router, "post", `/agents/:id/${action}`, policy, async (request, response) => {
      response.status(202).json(await submit(request, action, { ids: [exactId(String(request.params.id))], selectionId: selectionId(request) }, undefined, "single"));
    });
  }
  const accessPolicy: RoutePolicy = { access: "authenticated", dataClass: "package_control", roles: ["AgentControl.Admin"],
    capabilityId: "graph.package.access.manage", csrf: true };
  policyRoute(router, "post", "/agents/access", accessPolicy, async (request, response) => {
    const update = parsePackageAccessUpdate(request.body);
    response.status(202).json(await submit(request, update.target === "availability" ? "update-availability" : "update-installation",
      selectedTargets(request, 100), update, "bulk"));
  });
  policyRoute(router, "patch", "/agents/:id/access", accessPolicy, async (request, response) => {
    const update = parsePackageAccessUpdate(request.body);
    if (update.mode !== "replace") throw new AppError(400, "invalid_access_update", "Single-agent access updates use replace mode.");
    response.status(202).json(await submit(request, update.target === "availability" ? "update-availability" : "update-installation",
      { ids: [exactId(String(request.params.id))], selectionId: selectionId(request) }, update, "single"));
  });

  async function submit(request: Request, action: AuditAction, targets: { ids?: string[]; recordIds?: string[]; selectionId?: string },
    accessUpdate: PackageAccessUpdate | undefined, scope: "single" | "bulk") {
    const owner = requestScope(request), validation = beginAccountSessionValidation(owner.tenantId, owner.principalId);
    const capabilityId = action === "block" || action === "unblock" ? "graph.package.block.manage" : "graph.package.access.manage";
    const confirmedHash = confirmationHash(request), idempotencyKey = request.get("Idempotency-Key") ?? randomUUID();
    const intent = { action, accessUpdate, requestPath: request.path, scope };
    const existing = await jobs.getByIdempotency(owner, capabilityId, idempotencyKey, { ...intent, targetIds: targets.ids });
    assertAccountSessionValidation(validation);
    if (existing) {
      if (existing.confirmationHash !== confirmedHash) throw new AppError(409, "idempotency_mismatch", "This key belongs to another reviewed mutation.");
      if (existing.status === "queued") await commitAccountSessionValidation(validation, async () => launchBulkJob(existing.id, owner));
      return existing;
    }
    requireWorkerCapacity();
    parseActionGroupId(request.get("x-agent-control-action-group-id"));
    if (accessUpdate) await requireResolvedPrincipals(request, accessUpdate);
    await acquireDelegatedToken(owner.tenantId, owner.principalId, capabilityId);
    const identity = await reportIdentity(database, request.session.user!);
    const job = await commitAccountSessionValidation(validation, () => stages.submit(identity,
      { ...intent, ...targets, idempotencyKey, confirmationHash: confirmedHash }));
    if (job.status === "queued") await commitAccountSessionValidation(validation, async () => launchBulkJob(job.id, owner));
    return job;
  }
  return router;
}

function selectionId(request: Request) {
  const value = request.body?.selectionId;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))
    throw new AppError(400, "invalid_selection", "Use a current server-issued inventory selection.");
  return value;
}
function selectedTargets(request: Request, limit: number) {
  const selected = selectionId(request), ids = request.body?.ids === undefined ? undefined : parseIds(request.body.ids, limit);
  const recordIds = request.body?.recordIds === undefined ? undefined : parseIds(request.body.recordIds, limit);
  if (recordIds?.some(id => !/^agent:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))) {
    throw new AppError(400, "invalid_targets", "Use exact canonical agent group IDs.");
  }
  if (!ids && !recordIds && !selected) throw new AppError(400, "invalid_targets", "Select exact native IDs or all matching records in a current server selection.");
  if (!ids && !hasAppRole(request.session.user!.roles, "AgentControl.Viewer"))
    throw new AppError(403, "missing_internal_role", "All-matching operations require Viewer catalog scope in addition to Admin authority.");
  return { ids, recordIds, selectionId: selected };
}
