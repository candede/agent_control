import { Router } from "express";
import { AppError } from "../errors.js";
import { requireSession } from "../middleware/auth.js";
import { getAuditLog } from "../services/auditLog.js";
import type { AuditAction, AuditStatus } from "../types/audit.js";

export const auditRouter = Router();

const auditActions = new Set<AuditAction>(["block", "unblock"]);
const auditStatuses = new Set<AuditStatus>([
  "started",
  "succeeded",
  "failed",
  "skipped",
]);

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
    action: parseAction(firstQueryValue(query.action)),
    status: parseStatus(firstQueryValue(query.status)),
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

function parseStatus(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  if (!auditStatuses.has(value as AuditStatus)) {
    throw new AppError(400, "invalid_audit_status", "Audit status is invalid.");
  }

  return value as AuditStatus;
}
