import { Router } from "express";
import { AppError } from "../errors.js";
import { requireSession } from "../middleware/auth.js";
import { getAuditLog } from "../services/auditLog.js";
import type { AuditAction, AuditScope, AuditStatus } from "../types/audit.js";

export const auditRouter = Router();

const auditActions = new Set<AuditAction>(["block", "unblock"]);
const auditStatuses = new Set<AuditStatus>([
  "started",
  "succeeded",
  "failed",
  "skipped",
]);
const auditScopes = new Set<AuditScope>(["single", "bulk"]);

auditRouter.use(requireSession);

auditRouter.get("/audit/events", (request, response, next) => {
  try {
    const auditLog = getAuditLog();

    if (!auditLog) {
      response.json({ value: [] });
      return;
    }

    response.json({
      value: auditLog.listEvents(parseAuditEventsQuery(request.query)),
    });
  } catch (error) {
    next(error);
  }
});

export function parseAuditEventsQuery(query: Record<string, unknown>) {
  return {
    limit: parseLimit(firstQueryValue(query.limit)),
    agentId: firstQueryValue(query.agentId),
    actorUsername: firstQueryValue(query.actorUsername),
    scope: parseScope(firstQueryValue(query.scope)),
    action: parseAction(firstQueryValue(query.action)),
    status: parseStatus(firstQueryValue(query.status)),
    operationIdPrefix: parseOperationIdPrefix(
      firstQueryValue(query.operationIdPrefix),
    ),
  };
}

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

function parseAction(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  if (!auditActions.has(value as AuditAction)) {
    throw new AppError(400, "invalid_audit_action", "Audit action is invalid.");
  }

  return value as AuditAction;
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
