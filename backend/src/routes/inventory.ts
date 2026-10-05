import { Router } from "express";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { NativeInventory } from "../db/nativeInventory.js";
import { PowerPlatformRefreshJobs } from "../db/powerPlatformRefreshJobs.js";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { powerPlatformInventory } from "../services/powerPlatformInventory.js";
import { purviewAudit } from "../services/purviewAudit.js";
import { powerPlatformResourceTypes, type PowerPlatformResourceType } from "../types/powerPlatformInventory.js";
import type { InventorySourceAwareDetail, RelatedSource } from "../types/workbench.js";
import { hasAppRole } from "../types/capability.js";
import { policyRoute } from "./policy.js";

export const inventoryRouter = Router();
const refreshJobs = new PowerPlatformRefreshJobs();

policyRoute(inventoryRouter, "post", "/inventory/refresh-jobs", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], capabilityId: "powerPlatform.inventory.read", csrf: true }, async (request, response) => {
  const job = await powerPlatformInventory.submit(request.session.user!, {
    idempotencyKey: request.get("Idempotency-Key") ?? randomUUID(),
    environmentScope: optionalText(request.body?.environmentId, 512),
    requestedTypes: parseTypes(request.body?.types),
  });
  response.locals.jobId = job.id;
  const current = job.status === "waiting_authorization" ? await startOrWaiting(request.session.user!, job.id) : job;
  response.status(202).json(current);
});

policyRoute(inventoryRouter, "get", "/inventory/refresh-jobs", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.json(await refreshJobs.listJobs(requestScope(request), positiveInteger(first(request.query.limit), 20, 50)));
});

policyRoute(inventoryRouter, "get", "/inventory/refresh-jobs/:id", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  const id = jobId(request.params.id);
  response.locals.jobId = id;
  response.json(await powerPlatformInventory.get(request.session.user!, id));
});

policyRoute(inventoryRouter, "post", "/inventory/refresh-jobs/:id/resume", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], capabilityId: "powerPlatform.inventory.read", csrf: true }, async (request, response) => {
  const id = jobId(request.params.id);
  response.locals.jobId = id;
  response.status(202).json(await startOrWaiting(request.session.user!, id));
});
policyRoute(inventoryRouter, "post", "/inventory/refresh-jobs/:id/cancel", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const id = jobId(request.params.id);
  response.locals.jobId = id;
  response.json(await powerPlatformInventory.cancel(request.session.user!, id));
});

export function createInventoryReadRouter(database: pg.Pool) {
const router = Router();
const inventoryRepository = new NativeInventory(database);
policyRoute(router, "get", "/inventory/resources/:nativeId/related", {
  access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
}, async (request, response) => {
  const snapshotId = optionalUuid(first(request.query.snapshotId));
  if (!snapshotId) throw new AppError(400, "snapshot_required", "Source-aware detail requires the exact saved snapshot.");
  if (request.query.type !== undefined) throw new AppError(400, "invalid_inventory_query", "Agent activity does not accept a resource type.");
  const environmentId = optionalText(first(request.query.environmentId), 512) ?? "";
  const exact = await inventoryRepository.getResource(requestScope(request), snapshotId, "microsoft.copilotstudio/agents", environmentId, exactNativeId(request.params.nativeId));
  const identifierValues = (kind: string) => exact.resource.identifiers.filter(identifier => identifier.kind === kind).map(identifier => identifier.value);
  const botIds = identifierValues("cds_bot_id");
  const hasSecurityRole = hasAppRole(request.session.user!.roles, "AgentControl.Viewer");
  const audit: InventorySourceAwareDetail["audit"] = !hasSecurityRole
    ? { status: "unauthorized", reason: "Viewer is required; no audit lookup or count was performed." }
    : !exact.resource.environmentId || botIds.length !== 1
      ? { status: "unmatched", reason: "No single exact CDS bot ID plus environment association is available." }
      : await sourceResult(() => purviewAudit.relatedInventoryRecords(request.session.user!, { environmentId: exact.resource.environmentId!, botId: botIds[0] }));
  const security: InventorySourceAwareDetail["security"] = !hasSecurityRole
    ? { status: "unauthorized", reason: "Viewer is required; no Defender lookup or count was performed." }
    : { status: "unmatched", reason: "Saved Entra agent metadata does not establish the enterprise-application object ID required for a Defender inventory association." };
  const body: InventorySourceAwareDetail = {
    source: "power_platform", nativeId: exact.resource.nativeId, resourceType: exact.resource.type,
    environmentId: exact.resource.environmentId, snapshotId: exact.snapshot.id, observedAt: exact.snapshot.observedAt,
    expiresAt: exact.snapshot.expiresAt, identifiers: exact.resource.identifiers,
    audit, security,
  };
  response.json(body);
});

policyRoute(router, "get", "/inventory/quarantine-selection", {
  access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
}, async (request, response) => {
  const snapshotId = optionalUuid(first(request.query.snapshotId));
  if (!snapshotId) throw new AppError(400, "snapshot_required", "Selection resolution requires the exact saved snapshot.");
  const selected = Array.isArray(request.query.selected) ? request.query.selected.map(value => exactNativeId(typeof value === "string" ? value : undefined))
    : request.query.selected === undefined ? [] : [exactNativeId(first(request.query.selected))];
  response.json(await inventoryRepository.getQuarantineSelection(requestScope(request), snapshotId, selected));
});
return router;
}

function parseTypes(value: unknown): PowerPlatformResourceType[] {
  if (value === undefined) return [...powerPlatformResourceTypes];
  if (!Array.isArray(value) || !value.length || value.some(type => typeof type !== "string" || !powerPlatformResourceTypes.includes(type as PowerPlatformResourceType))) throw new AppError(400, "invalid_inventory_scope", "Inventory types must use the supported resource allowlist.");
  return [...new Set(value)] as PowerPlatformResourceType[];
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AppError(400, "invalid_inventory_query", "Inventory job limit is outside the supported range.");
  }
  return parsed;
}

function optionalText(value: unknown, maximum: number) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maximum || /[\r\n\0]/.test(value)) throw new AppError(400, "invalid_inventory_query", "Inventory query text is invalid.");
  return value;
}

function exactNativeId(value: string | string[] | undefined) {
  const current = Array.isArray(value) ? value[0] : value;
  if (!current || current.length > 512 || /[\r\n\0]/.test(current)) throw new AppError(400, "invalid_native_id", "A valid exact native ID is required.");
  return current;
}

async function sourceResult<T>(load: () => Promise<{ count: number; value: T[] }>): Promise<RelatedSource<T>> {
  try { return { status: "available", ...await load() }; }
  catch { return { status: "unavailable", reason: "The authorized retained source is temporarily unavailable; no other source was substituted." }; }
}

function optionalUuid(value: string | undefined) {
  return value === undefined ? undefined : jobId(value);
}

function jobId(value: unknown) {
  const id = String(value);
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new AppError(400, "invalid_job_id", "Invalid inventory job ID.");
  return id;
}

function first(value: unknown) {
  return Array.isArray(value) ? typeof value[0] === "string" ? value[0] : undefined : typeof value === "string" ? value : undefined;
}

async function startOrWaiting(user: NonNullable<Express.Request["session"]["user"]>, id: string) {
  try { return await powerPlatformInventory.start(user, id); }
  catch (error) {
    if (error instanceof AppError && (error.status === 401 || error.status === 403 || ["interaction_required", "authorization_expired", "missing_permission"].includes(error.code))) return powerPlatformInventory.get(user, id);
    throw error;
  }
}