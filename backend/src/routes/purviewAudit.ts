import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { PurviewAuditRepository } from "../db/purviewAudit.js";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { getAuditLog } from "../services/auditLog.js";
import { buildBoundedCsv, createExportPublicationValidator, publishBoundedCsv } from "../services/csvExport.js";
import { purviewAuditPresets } from "../types/purviewAudit.js";
import { purviewAudit } from "../services/purviewAudit.js";
import { policyRoute } from "./policy.js";

export const purviewAuditRouter = Router();
const repository = new PurviewAuditRepository();

purviewAuditRouter.use((_request, response, next) => {
  response.setHeader("Cache-Control", "private, no-store");
  next();
});

policyRoute(purviewAuditRouter, "get", "/audit-search/catalog", { access: "authenticated", dataClass: "provider_audit_metadata", roles: ["AgentControl.Viewer"] }, (_request, response) => {
  response.json({
    presets: Object.entries(purviewAuditPresets).map(([id, value]) => ({ id, label: value.label, service: value.serviceFilter, recordTypes: value.recordTypeFilters, operations: value.operationFilters })),
    limits: { maximumWindowHours: 168, qualificationWindowHours: 1, maximumPages: 20, maximumRows: 5_000, maximumBytes: 8_000_000,
      pollsPerActivation: 6, providerRequests: 64, activations: 12 },
    evidenceNotice: "Microsoft Purview Audit Search is compliance and security evidence. It is not official Microsoft 365 Copilot Agents usage.",
    contentNotice: "Content not present in Purview audit. Copilot audit records expose message identifiers and metadata, not prompt or response text.",
    retentionNotice: "Local minimized results expire after 30 days. Microsoft Purview source retention and remote query lifetime are separate provider policies.",
  });
});

policyRoute(purviewAuditRouter, "post", "/audit-search/qualifications", { access: "authenticated", dataClass: "provider_audit_qualification", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  response.status(201).json(await purviewAudit.approveQualification(request.session.user!, { tokenMode: tokenMode(request.body?.tokenMode), filters: request.body?.filters }));
});

policyRoute(purviewAuditRouter, "post", "/audit-search/qualifications/:id/start", { access: "authenticated", dataClass: "provider_audit_qualification", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  response.status(202).json(await startQualificationOrWaiting(request, uuid(request.params.id)));
});

policyRoute(purviewAuditRouter, "post", "/audit-search/jobs", { access: "authenticated", dataClass: "private_provider_audit_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const mode = tokenMode(request.body?.tokenMode);
  const job = await purviewAudit.submit(request.session.user!, { tokenMode: mode, filters: request.body?.filters, idempotencyKey: request.get("Idempotency-Key") ?? randomUUID() });
  response.status(202).json(await startOrWaiting(request, job.id, mode));
});

policyRoute(purviewAuditRouter, "get", "/audit-search/jobs", { access: "authenticated", dataClass: "private_provider_audit_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.json(await purviewAudit.list(request.session.user!, positiveInteger(first(request.query.limit), 20, 50),
    positiveInteger(first(request.query.offset), 0, 100_000, true)));
});

policyRoute(purviewAuditRouter, "get", "/audit-search/jobs/:id", { access: "authenticated", dataClass: "private_provider_audit_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.json(await purviewAudit.get(request.session.user!, uuid(request.params.id)));
});

policyRoute(purviewAuditRouter, "post", "/audit-search/jobs/:id/resume", { access: "authenticated", dataClass: "private_provider_audit_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const id = uuid(request.params.id);
  const job = await purviewAudit.get(request.session.user!, id);
  response.status(202).json(await startOrWaiting(request, id, job.tokenMode));
});

policyRoute(purviewAuditRouter, "post", "/audit-search/jobs/:id/cancel", { access: "authenticated", dataClass: "private_provider_audit_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  response.json(await purviewAudit.cancel(request.session.user!, uuid(request.params.id)));
});

policyRoute(purviewAuditRouter, "delete", "/audit-search/jobs/:id", { access: "authenticated", dataClass: "private_provider_audit_cache", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const id = uuid(request.params.id);
  confirmLocalDelete(request.body, id);
  await purviewAudit.delete(request.session.user!, id);
  response.status(204).end();
});

policyRoute(purviewAuditRouter, "get", "/audit-search/jobs/:id/records", { access: "authenticated", dataClass: "private_provider_audit", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  const id = uuid(request.params.id);
  const result = await auditedRead(request, id, "view-audit-search", () => purviewAudit.records(request.session.user!, id,
    positiveInteger(first(request.query.limit), 100, 500), positiveInteger(first(request.query.offset), 0, 100_000, true)));
  response.json(result);
});

policyRoute(purviewAuditRouter, "get", "/audit-search/jobs/:id/export.csv", { access: "authenticated", dataClass: "private_provider_audit_export", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  const deadlineAt = Date.now() + 15_000;
  const id = uuid(request.params.id);
  const scope = requestScope(request);
  const validateSession = createExportPublicationValidator(request, "AgentControl.Viewer");
  const validatePublication = async () => {
    await validateSession();
    await purviewAudit.get(request.session.user!, id);
  };
  const audit = getAuditLog(scope);
  const event = await audit.startEvent({ operationId: `export-audit-search:${id}:${randomUUID()}`, scope: "single", action: "export-audit-search", agentId: id,
    actor: request.session.user!, requestPath: request.path, metadata: { source: "microsoft_purview_audit" } });
  try {
      await validatePublication();
      const result = await purviewAudit.records(request.session.user!, id, 5_000, 0);
    if (result.count > 5_000 || result.value.length !== result.count) throw new AppError(413, "export_row_limit", "The Purview export exceeds the 5,000 row limit.");
    const columns = ["jobId", "tenantId", "providerQueryId", "providerStatus", "localRequestId", "providerRequestId", "projectionVersion", "tokenMode", "resultScopeKind", "resultScopeId",
      "resultScopeConfigurationRevision", "providerRequestCount", "activationCount", "pageComplete", "requestedStartDateTime", "requestedEndDateTime", "observedStartDateTime", "observedEndDateTime",
      "expiresAt", "finishedAt", "wrapperId", "eventDateTime", "nativeEventId", "operation", "service", "auditLogRecordType",
      "resultStatus", "actorUserPrincipalName", "actorUserId", "objectId", "clientIp", "agentId", "appIdentity", "appHost", "botId", "environmentId", "correlationId", "messageIds",
      "contentState", "associationStatus"] as const;
    const provenance = { jobId: result.job.id, tenantId: scope.tenantId, providerQueryId: result.job.providerQueryId, providerStatus: result.job.providerStatus, localRequestId: result.job.localRequestId,
      providerRequestId: result.job.providerRequestId, projectionVersion: result.job.projectionVersion, tokenMode: result.job.tokenMode, resultScopeKind: result.job.resultScope.kind,
      resultScopeId: result.job.resultScope.scopeId, resultScopeConfigurationRevision: result.job.resultScope.configurationRevision,
      providerRequestCount: result.job.providerRequestCount, activationCount: result.job.activationCount, pageComplete: result.job.pageComplete,
      requestedStartDateTime: result.job.filters.startDateTime, requestedEndDateTime: result.job.filters.endDateTime,
      observedStartDateTime: result.job.observedRange?.startDateTime ?? null, observedEndDateTime: result.job.observedRange?.endDateTime ?? null,
      expiresAt: result.job.expiresAt, finishedAt: result.job.finishedAt };
    const rows = result.value.map(record => ({ ...provenance, ...record, messageIds: record.messages.map(message => message.id).join(";"), contentState: "Content not present in Purview audit", associationStatus: record.association?.status ?? "unresolved" }));
    const csv = buildBoundedCsv(columns, rows, { maximumRows: 5_000, maximumBytes: 8_000_000, deadlineAt });
    await publishBoundedCsv(request, response, `purview-audit-${id}.csv`, csv.buffer, {
      deadlineAt, validate: validatePublication, beforeEnd: () => audit.completeEvent(event.id, { status: "succeeded", metadata: {
        source: "microsoft_purview_audit", jobId: id, resultingCount: csv.rowCount, resultingBytes: csv.byteCount,
      } }).then(() => undefined),
    });
  } catch (error) {
    await audit.completeEvent(event.id, { status: "failed", errorCode: error instanceof AppError ? error.code : "provider_audit_export_failed" });
    if (response.headersSent) {
      if (!response.destroyed) response.destroy();
      return;
    }
    throw error;
  }
});

async function auditedRead<T extends { count: number }>(request: Request, jobId: string, action: "view-audit-search" | "export-audit-search", operation: () => Promise<T>) {
  const scope = requestScope(request);
  const audit = getAuditLog(scope);
  const event = await audit.startEvent({ operationId: `${action}:${jobId}:${randomUUID()}`, scope: "single", action, agentId: jobId,
    actor: request.session.user!, requestPath: request.path, metadata: { source: "microsoft_purview_audit" } });
  try {
    const result = await operation();
    await audit.completeEvent(event.id, { status: "succeeded", metadata: { source: "microsoft_purview_audit", resultingCount: result.count } });
    return result;
  } catch (error) {
    await audit.completeEvent(event.id, { status: "failed", errorCode: error instanceof AppError ? error.code : "provider_audit_read_failed" });
    throw error;
  }
}

async function startOrWaiting(request: Request, id: string, mode: "delegated" | "application") {
  try { return await purviewAudit.start(request.session.user!, id, mode); }
  catch (error) {
    if (error instanceof AppError && (error.status === 401 || ["interaction_required", "authorization_expired"].includes(error.code))) return purviewAudit.get(request.session.user!, id);
    throw error;
  }
}

async function startQualificationOrWaiting(request: Request, id: string) {
  try { return await purviewAudit.startQualification(request.session.user!, id); }
  catch (error) {
    if (error instanceof AppError && (error.status === 401 || ["interaction_required", "authorization_expired"].includes(error.code))) {
      const qualification = await repository.getQualification(request.session.user!.tenantId!, id);
      if (qualification?.jobId) return purviewAudit.get(request.session.user!, qualification.jobId);
    }
    throw error;
  }
}

function tokenMode(value: unknown) {
  if (value !== "delegated" && value !== "application") throw new AppError(400, "invalid_token_mode", "Audit Search token mode must be delegated or application.");
  return value;
}

function confirmLocalDelete(value: unknown, id: string) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("confirmation" in value)) {
    throw new AppError(400, "confirmation_required", "Confirm the exact Audit Search job ID before deleting its local cache.");
  }
  if ((value as { confirmation?: unknown }).confirmation !== id) {
    throw new AppError(409, "confirmation_mismatch", "The local Audit Search deletion confirmation does not match this job.");
  }
}

function uuid(value: unknown) {
  const id = String(value);
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new AppError(400, "invalid_job_id", "Invalid Audit Search ID.");
  return id;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number, allowZero = false) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1) || parsed > maximum) throw new AppError(400, "invalid_audit_query", "Audit Search paging value is outside the supported range.");
  return parsed;
}

function first(value: unknown) {
  return Array.isArray(value) ? typeof value[0] === "string" ? value[0] : undefined : typeof value === "string" ? value : undefined;
}
