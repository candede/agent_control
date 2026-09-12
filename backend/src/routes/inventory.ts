import { Router } from "express";
import { randomUUID } from "node:crypto";
import { PowerPlatformInventoryRepository } from "../db/powerPlatformInventory.js";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { getAuditLog } from "../services/auditLog.js";
import { buildBoundedCsv, createExportPublicationValidator, publishBoundedCsv } from "../services/csvExport.js";
import { defenderHunting } from "../services/defenderHunting.js";
import { powerPlatformInventory } from "../services/powerPlatformInventory.js";
import { purviewAudit } from "../services/purviewAudit.js";
import { powerPlatformResourceTypes, type PowerPlatformResourceType } from "../types/powerPlatformInventory.js";
import type { InventorySourceAwareDetail, RelatedSource } from "../types/workbench.js";
import { hasAppRole } from "../types/capability.js";
import { policyRoute } from "./policy.js";

export const inventoryRouter = Router();
const inventoryRepository = new PowerPlatformInventoryRepository();

policyRoute(inventoryRouter, "post", "/inventory/refresh-jobs", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], capabilityId: "powerPlatform.inventory.read", csrf: true }, async (request, response) => {
  const job = await powerPlatformInventory.submit(request.session.user!, {
    idempotencyKey: request.get("Idempotency-Key") ?? randomUUID(),
    environmentScope: optionalText(request.body?.environmentId, 512),
    requestedTypes: parseTypes(request.body?.types),
  });
  const current = job.status === "waiting_authorization" ? await startOrWaiting(request.session.user!, job.id) : job;
  response.status(202).json(current);
});

policyRoute(inventoryRouter, "get", "/inventory/refresh-jobs", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.json(await inventoryRepository.listJobs(requestScope(request), positiveInteger(first(request.query.limit), 20, 50)));
});

policyRoute(inventoryRouter, "get", "/inventory/refresh-jobs/:id", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.json(await powerPlatformInventory.get(request.session.user!, jobId(request.params.id)));
});

policyRoute(inventoryRouter, "post", "/inventory/refresh-jobs/:id/resume", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], capabilityId: "powerPlatform.inventory.read", csrf: true }, async (request, response) => {
  response.status(202).json(await startOrWaiting(request.session.user!, jobId(request.params.id)));
});
policyRoute(inventoryRouter, "post", "/inventory/refresh-jobs/:id/cancel", { access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  response.json(await powerPlatformInventory.cancel(request.session.user!, jobId(request.params.id)));
});

policyRoute(inventoryRouter, "get", "/inventory/snapshots", { access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.json(await inventoryRepository.listSnapshots(requestScope(request), positiveInteger(first(request.query.limit), 50, 50)));
});

policyRoute(inventoryRouter, "get", "/inventory/resources", { access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.json(await inventoryRepository.list(requestScope(request), listQuery(request.query)));
});

policyRoute(inventoryRouter, "get", "/inventory/resources/:nativeId/related", {
  access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
}, async (request, response) => {
  const snapshotId = optionalUuid(first(request.query.snapshotId));
  if (!snapshotId) throw new AppError(400, "snapshot_required", "Source-aware detail requires the exact saved snapshot.");
  const resourceType = optionalType(first(request.query.type));
  if (!resourceType) throw new AppError(400, "resource_type_required", "Source-aware detail requires the exact resource type.");
  const environmentId = optionalText(first(request.query.environmentId), 512) ?? "";
  const exact = await inventoryRepository.getResource(requestScope(request), snapshotId, resourceType, environmentId, exactNativeId(request.params.nativeId));
  const identifierValues = (kind: string) => exact.resource.identifiers.filter(identifier => identifier.kind === kind).map(identifier => identifier.value);
  const botIds = identifierValues("cds_bot_id");
  const entraAgentIds = identifierValues("entra_agent_id");
  const hasSecurityRole = hasAppRole(request.session.user!.roles, "AgentControl.Viewer");
  const audit: InventorySourceAwareDetail["audit"] = !hasSecurityRole
    ? { status: "unauthorized", reason: "Viewer is required; no audit lookup or count was performed." }
    : !exact.resource.environmentId || botIds.length !== 1
      ? { status: "unmatched", reason: "No single exact CDS bot ID plus environment association is available." }
      : await sourceResult(() => purviewAudit.relatedInventoryRecords(request.session.user!, { environmentId: exact.resource.environmentId!, botId: botIds[0] }));
  const security: InventorySourceAwareDetail["security"] = !hasSecurityRole
    ? { status: "unauthorized", reason: "Viewer is required; no Defender lookup or count was performed." }
    : entraAgentIds.length !== 1
      ? { status: "unmatched", reason: "No single exact Entra agent ID association is available." }
      : await sourceResult(() => defenderHunting.relatedInventoryRows(request.session.user!, entraAgentIds[0]));
  const body: InventorySourceAwareDetail = {
    source: "power_platform", nativeId: exact.resource.nativeId, resourceType: exact.resource.type,
    environmentId: exact.resource.environmentId, snapshotId: exact.snapshot.id, observedAt: exact.snapshot.observedAt,
    expiresAt: exact.snapshot.expiresAt, identifiers: exact.resource.identifiers,
    package: { status: "unmatched", reason: "No documented package-to-Power-Platform identifier equivalence exists; names were not compared." },
    reports: { status: "unmatched", reason: "Official report agent IDs are report-only and have no documented cross-source contract." },
    audit, security,
    controls: {
      quarantineTarget: exact.resource.environmentId && botIds.length === 1 ? { environmentId: exact.resource.environmentId, botId: botIds[0] } : null,
      packageTarget: null,
    },
  };
  response.json(body);
});

policyRoute(inventoryRouter, "get", "/inventory/quarantine-selection", {
  access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
}, async (request, response) => {
  const snapshotId = optionalUuid(first(request.query.snapshotId));
  if (!snapshotId) throw new AppError(400, "snapshot_required", "Selection resolution requires the exact saved snapshot.");
  const selected = Array.isArray(request.query.selected) ? request.query.selected.map(value => exactNativeId(typeof value === "string" ? value : undefined))
    : request.query.selected === undefined ? [] : [exactNativeId(first(request.query.selected))];
  response.json(await inventoryRepository.getQuarantineSelection(requestScope(request), snapshotId, selected));
});

policyRoute(inventoryRouter, "get", "/inventory/export.csv", { access: "authenticated", dataClass: "private_inventory_export", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  const deadlineAt = Date.now() + 15_000;
  const scope = requestScope(request);
  const snapshotId = optionalUuid(first(request.query.snapshotId));
  if (!snapshotId) throw new AppError(400, "snapshot_required", "Power Platform export requires the exact saved snapshot selection.");
  const validateSession = createExportPublicationValidator(request, "AgentControl.Viewer");
  const validatePublication = async () => {
    await validateSession();
    await inventoryRepository.assertSnapshotCurrent(scope, snapshotId);
  };
  const audit = getAuditLog(scope);
  const event = await audit.startEvent({
    operationId: `export-power-platform-inventory:${randomUUID()}`,
    scope: "bulk",
    action: "export-power-platform-inventory",
    agentId: snapshotId,
    actor: request.session.user!,
    requestPath: request.path,
    metadata: { source: "power_platform", snapshotId },
  });
  try {
    await validatePublication();
    const result = await inventoryRepository.list(scope, { ...listQuery(request.query), snapshotId, limit: 5_000, offset: 0, includeAssociations: false });
    if (!result.snapshot) throw new AppError(409, "snapshot_unavailable", "The exact Power Platform snapshot is no longer available.");
    if (result.count > 5_000 || result.value.length !== result.count) {
      throw new AppError(413, "export_row_limit", "The filtered Power Platform selection exceeds the 5,000 row export limit.");
    }
    const columns = ["sourceSystem", "nativeId", "displayName", "type", "environmentId", "location", "authoringTool", "agentKind", "lifecycle", "createdAt", "lastPublishedAt", "snapshotId", "snapshotObservedAt", "snapshotExpiresAt"] as const;
    const rows = result.value.map(resource => ({
      ...resource,
      snapshotId: result.snapshot!.id,
      snapshotObservedAt: result.snapshot!.observedAt,
      snapshotExpiresAt: result.snapshot!.expiresAt,
    }));
    const csv = buildBoundedCsv(columns, rows, { maximumRows: 5_000, maximumBytes: 8_000_000, deadlineAt });
    await publishBoundedCsv(request, response, "power-platform-inventory.csv", csv.buffer, {
      deadlineAt, validate: validatePublication, beforeEnd: () => audit.completeEvent(event.id, { status: "succeeded", metadata: {
        source: "power_platform", snapshotId: result.snapshot!.id, resultingCount: csv.rowCount, resultingBytes: csv.byteCount,
      } }).then(() => undefined),
    });
  } catch (error) {
    await audit.completeEvent(event.id, { status: "failed", errorCode: error instanceof AppError ? error.code : "power_platform_export_failed" });
    if (response.headersSent) {
      if (!response.destroyed) response.destroy();
      return;
    }
    throw error;
  }
});

function listQuery(query: Record<string, unknown>) {
  return {
    snapshotId: optionalUuid(first(query.snapshotId)), type: optionalType(first(query.type)), environmentId: optionalText(first(query.environmentId), 512),
    search: optionalText(first(query.search), 256), sortBy: parseSort(first(query.sortBy)), sortDirection: first(query.sortDirection) === "desc" ? "desc" as const : "asc" as const,
    limit: positiveInteger(first(query.limit), 50, 500), offset: positiveInteger(first(query.offset), 0, 100_000, true),
  };
}

function parseTypes(value: unknown): PowerPlatformResourceType[] {
  if (value === undefined) return [...powerPlatformResourceTypes];
  if (!Array.isArray(value) || !value.length || value.some(type => typeof type !== "string" || !powerPlatformResourceTypes.includes(type as PowerPlatformResourceType))) throw new AppError(400, "invalid_inventory_scope", "Inventory types must use the supported resource allowlist.");
  return [...new Set(value)] as PowerPlatformResourceType[];
}

function parseSort(value: string | undefined) {
  const allowed = ["displayName", "type", "environmentId", "createdAt", "lastPublishedAt"] as const;
  return allowed.includes(value as typeof allowed[number]) ? value as typeof allowed[number] : "displayName";
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number, allowZero = false) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1) || parsed > maximum) throw new AppError(400, "invalid_inventory_query", "Inventory paging value is outside the supported range.");
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

function optionalType(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!powerPlatformResourceTypes.includes(value as PowerPlatformResourceType)) throw new AppError(400, "invalid_inventory_query", "Inventory type is unsupported.");
  return value as PowerPlatformResourceType;
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