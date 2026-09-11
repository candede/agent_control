import { Router } from "express";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { getAuditLog } from "../services/auditLog.js";
import { buildBoundedCsv, createExportPublicationValidator, publishBoundedCsv } from "../services/csvExport.js";
import type { AuditScope, AuditStatus, LocalAuditAction } from "../types/audit.js";
import { policyRoute } from "./policy.js";

export const auditRouter = Router();

const auditActions = new Set<LocalAuditAction>([
  "block",
  "unblock",
  "update-availability",
  "update-installation",
  "reassign",
  "view-audit-search",
  "export-audit-search",
  "view-hunting",
  "export-hunting",
  "approve-hunting",
  "qualify-hunting",
  "submit-hunting",
  "query-hunting",
  "cancel-hunting",
  "delete-hunting",
  "revoke-hunting-scope",
  "export-package-inventory",
  "export-power-platform-inventory",
  "export-official-usage-aggregate",
  "export-official-usage-users",
  "export-administrative-audit",
]);
const auditStatuses = new Set<AuditStatus>([
  "started",
  "succeeded",
  "failed",
  "skipped",
  "inconclusive",
  "cancelled",
]);
const auditScopes = new Set<AuditScope>(["single", "bulk"]);

policyRoute(auditRouter, "get", "/audit/events", { access: "authenticated", dataClass: "local_audit", roles: ["AgentControl.SecurityReader"] }, async (request, response, next) => {
  try {
    const auditLog = getAuditLog(requestScope(request));
    const query = parseAuditEventsQuery(request.query);

    if (!auditLog) {
      response.json({ value: [], count: 0 });
      return;
    }

    response.json({
      value: await auditLog.listEvents(query),
      count: await auditLog.countEvents(query),
    });
  } catch (error) {
    next(error);
  }
});

export function parseAuditEventsQuery(query: Record<string, unknown>) {
  return {
    limit: parseLimit(firstQueryValue(query.limit)),
    offset: parseOffset(firstQueryValue(query.offset)),
    agentId: firstQueryValue(query.agentId),
    actorUsername: firstQueryValue(query.actorUsername),
    scope: parseScope(firstQueryValue(query.scope)),
    action: parseAction(firstQueryValue(query.action)),
    status: parseStatus(firstQueryValue(query.status)),
    operationIdPrefix: parseOperationIdPrefix(
      firstQueryValue(query.operationIdPrefix),
    ),
    search: parseSearch(firstQueryValue(query.search)),
  };
}

policyRoute(auditRouter, "post", "/audit/events/export.csv", {
  access: "authenticated", dataClass: "local_audit_export", roles: ["AgentControl.SecurityReader"], csrf: true,
}, async (request, response) => {
  const ids: unknown = request.body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100
    || ids.some(id => typeof id !== "string" || !id || id.length > 256 || /[\0\r\n]/.test(id))
    || new Set(ids).size !== ids.length) {
    throw new AppError(400, "invalid_export_selection", "Select 1-100 unique exact administrative audit event IDs.");
  }
  const deadlineAt = Date.now() + 15_000;
  const audit = getAuditLog(requestScope(request));
  const validateSession = createExportPublicationValidator(request, "AgentControl.SecurityReader");
  const receipt = await audit.startEvent({ operationId: `export-administrative-audit:${randomUUID()}`, action: "export-administrative-audit",
    scope: "bulk", agentId: "local-administrative-audit", actor: request.session.user!, requestPath: request.path,
    metadata: { source: "local_administrative_audit" } });
  try {
    await validateSession();
    const events = await audit.getExportEvents(ids);
    if (events.length !== ids.length) throw new AppError(404, "not_found", "An audit export event is absent, expired or outside the current source scope.");
    const selected = JSON.stringify(events);
    const columns = ["sourceSystem", "eventId", "startedAt", "completedAt", "agentId", "agentName", "action", "status", "message",
      "errorCode", "actorName", "actorUsername", "operationId"] as const;
    const csv = buildBoundedCsv(columns, events.map(event => ({
      sourceSystem: "local_administrative_audit", eventId: event.id, startedAt: event.startedAt, completedAt: event.completedAt,
      agentId: event.agentId, agentName: event.agentDisplayName, action: event.action, status: event.status,
      message: event.message, errorCode: event.errorCode, actorName: event.actor.displayName, actorUsername: event.actor.username,
      operationId: event.operationId,
    })), { maximumRows: 100, maximumBytes: 1_000_000, deadlineAt });
    await publishBoundedCsv(request, response, "administrative-audit.csv", csv.buffer, {
      deadlineAt, validate: async () => {
        await validateSession();
        if (JSON.stringify(await audit.getExportEvents(ids)) !== selected) throw new AppError(409, "dataset_invalidated", "The exact audit selection changed or was deleted.");
      },
      beforeEnd: () => audit.completeEvent(receipt.id, { status: "succeeded",
        metadata: { source: "local_administrative_audit", resultingCount: csv.rowCount, resultingBytes: csv.byteCount } }).then(() => undefined),
    });
  } catch (error) {
    await audit.completeEvent(receipt.id, { status: "failed", errorCode: error instanceof AppError ? error.code : "audit_export_failed" });
    if (response.headersSent) { if (!response.destroyed) response.destroy(); return; }
    throw error;
  }
});

function firstQueryValue(value: unknown) {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }

  return typeof value === "string" ? value : undefined;
}

function parseLimit(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new AppError(400, "invalid_audit_limit", "Audit limit is invalid.");
  }

  const limit = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new AppError(400, "invalid_audit_limit", "Audit limit is invalid.");
  }

  return limit;
}

function parseOffset(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new AppError(400, "invalid_audit_offset", "Audit offset is invalid.");
  }

  const offset = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(offset)) {
    throw new AppError(400, "invalid_audit_offset", "Audit offset is invalid.");
  }

  return offset;
}

function parseAction(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  if (!auditActions.has(value as LocalAuditAction)) {
    throw new AppError(400, "invalid_audit_action", "Audit action is invalid.");
  }

  return value as LocalAuditAction;
}

function parseScope(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  if (!auditScopes.has(value as AuditScope)) {
    throw new AppError(400, "invalid_audit_scope", "Audit scope is invalid.");
  }

  return value as AuditScope;
}

function parseStatus(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  if (!auditStatuses.has(value as AuditStatus)) {
    throw new AppError(400, "invalid_audit_status", "Audit status is invalid.");
  }

  return value as AuditStatus;
}

function parseOperationIdPrefix(value: string | undefined) {
  const normalized = value?.trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized.length > 64 || !/^[a-zA-Z0-9-]+$/.test(normalized)) {
    throw new AppError(
      400,
      "invalid_operation_id_prefix",
      "Operation ID prefix is invalid.",
    );
  }

  return normalized;
}

function parseSearch(value: string | undefined) {
  const normalized = value?.trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized.length > 200) {
    throw new AppError(400, "invalid_audit_search", "Audit search is invalid.");
  }

  return normalized;
}
