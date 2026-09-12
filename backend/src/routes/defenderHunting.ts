import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { getAuditLog } from "../services/auditLog.js";
import { buildBoundedCsv, createExportPublicationValidator, publishBoundedCsv } from "../services/csvExport.js";
import { defenderHunting } from "../services/defenderHunting.js";
import { defenderHuntingTemplates, type DefenderHuntingRow, type DefenderHuntingTokenMode } from "../types/defenderHunting.js";
import { policyRoute } from "./policy.js";

export const defenderHuntingRouter = Router();

defenderHuntingRouter.use((_request, response, next) => { response.setHeader("Cache-Control", "private, no-store"); next(); });

policyRoute(defenderHuntingRouter, "get", "/hunting/catalog", { access: "authenticated", dataClass: "hunting_metadata", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.json({ templates: Object.entries(defenderHuntingTemplates).map(([id, value]) => ({ id, ...value })),
    qualifications: await defenderHunting.qualificationEvidence(request.session.user!),
    retainedScopes: await defenderHunting.retainedScopes(request.session.user!),
    limits: { maximumWindowHours: 168, qualificationWindowHours: 1, maximumRows: 200, maximumBytes: 2_000_000, providerRequests: 12, activations: 4 },
    scopeNotice: "Microsoft Graph selects the Defender hunting scope. Agent Control neither accepts workspaceId nor promises requested-workspace isolation.",
    contentNotice: "Input/output messages and tool arguments or results are not retained or reconstructed. An observed root span does not prove complete telemetry or admin-center ingestion; child-only spans do not establish a root.",
    readinessNotice: "A successful empty response is no_data, not proof of complete tenant coverage. Check license, Defender RBAC/data-source scope, Microsoft 365 activities connectivity and table rollout separately.",
    retentionNotice: "Provider qualification expires after 24 hours. Exact retained-scope approval and minimized local jobs expire after 30 days; revocation or current configuration change hides saved data immediately.",
    defenderPortalUrl: "https://security.microsoft.com/v2/advanced-hunting",
  });
});

policyRoute(defenderHuntingRouter, "post", "/hunting/qualifications", { access: "authenticated", dataClass: "hunting_qualification", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const mode = tokenMode(request.body?.tokenMode);
  response.status(201).json(await auditedLifecycle(request, "approve-hunting", "qualification", mode,
    () => defenderHunting.approveQualification(request.session.user!, { tokenMode: mode, filters: request.body?.filters })));
});

policyRoute(defenderHuntingRouter, "post", "/hunting/qualifications/:id/start", { access: "authenticated", dataClass: "hunting_qualification", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const id = uuid(request.params.id);
  response.status(202).json(await auditedLifecycle(request, "qualify-hunting", id, undefined, () => startQualificationOrWaiting(request, id)));
});

policyRoute(defenderHuntingRouter, "post", "/hunting/retained-scopes/:id/revoke", { access: "authenticated", dataClass: "hunting_qualification", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const id = uuid(request.params.id);
  confirmExactId(request.body, id, "retained hunting scope");
  response.json(await auditedLifecycle(request, "revoke-hunting-scope", id, undefined,
    () => defenderHunting.revokeRetainedScope(request.session.user!, id)));
});

policyRoute(defenderHuntingRouter, "post", "/hunting/jobs", { access: "authenticated", dataClass: "private_hunting_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const mode = tokenMode(request.body?.tokenMode);
  const result = await auditedLifecycle(request, "submit-hunting", "submission", mode, async () => {
    const job = await defenderHunting.submit(request.session.user!, { tokenMode: mode, filters: request.body?.filters, idempotencyKey: request.get("Idempotency-Key") ?? randomUUID() });
    return startOrWaiting(request, job.id, mode);
  });
  response.status(202).json(result);
});

policyRoute(defenderHuntingRouter, "get", "/hunting/jobs", { access: "authenticated", dataClass: "private_hunting_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.json(await defenderHunting.list(request.session.user!, positiveInteger(first(request.query.limit), 20, 50), positiveInteger(first(request.query.offset), 0, 100_000, true)));
});

policyRoute(defenderHuntingRouter, "get", "/hunting/jobs/:id", { access: "authenticated", dataClass: "private_hunting_job", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.json(await defenderHunting.get(request.session.user!, uuid(request.params.id)));
});

policyRoute(defenderHuntingRouter, "post", "/hunting/jobs/:id/resume", { access: "authenticated", dataClass: "private_hunting_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const id = uuid(request.params.id);
  const job = await defenderHunting.get(request.session.user!, id);
  response.status(202).json(await startOrWaiting(request, id, job.tokenMode));
});

policyRoute(defenderHuntingRouter, "post", "/hunting/jobs/:id/cancel", { access: "authenticated", dataClass: "private_hunting_job", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const id = uuid(request.params.id);
  response.json(await auditedLifecycle(request, "cancel-hunting", id, undefined, () => defenderHunting.cancel(request.session.user!, id)));
});

policyRoute(defenderHuntingRouter, "delete", "/hunting/jobs/:id", { access: "authenticated", dataClass: "private_hunting_cache", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  const id = uuid(request.params.id);
  confirmLocalDelete(request.body, id);
  await auditedLifecycle(request, "delete-hunting", id, undefined, () => defenderHunting.delete(request.session.user!, id));
  response.status(204).end();
});

policyRoute(defenderHuntingRouter, "get", "/hunting/jobs/:id/rows", { access: "authenticated", dataClass: "private_hunting", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  const id = uuid(request.params.id);
  response.json(await auditedRead(request, id, "view-hunting", () => defenderHunting.rows(request.session.user!, id,
    positiveInteger(first(request.query.limit), 100, 200), positiveInteger(first(request.query.offset), 0, 100_000, true))));
});

policyRoute(defenderHuntingRouter, "get", "/hunting/jobs/:id/export.csv", { access: "authenticated", dataClass: "private_hunting_export", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  const deadlineAt = Date.now() + 15_000;
  const id = uuid(request.params.id);
  const scope = requestScope(request);
  const validateSession = createExportPublicationValidator(request, "AgentControl.Viewer");
  const validatePublication = async () => {
    await validateSession();
    await defenderHunting.get(request.session.user!, id);
  };
  const audit = getAuditLog(scope);
  const event = await audit.startEvent({ operationId: `export-hunting:${id}:${randomUUID()}`, scope: "single", action: "export-hunting", agentId: id,
    actor: request.session.user!, requestPath: request.path, metadata: { source: "microsoft_defender_hunting" } });
  try {
      await validatePublication();
      const result = await defenderHunting.rows(request.session.user!, id, 200, 0);
    if (result.count > 200 || result.value.length !== result.count) throw new AppError(413, "export_row_limit", "The Defender export exceeds the 200 row source limit.");
    const columns = ["jobId", "tenantId", "tokenMode", "resultScopeKind", "resultScopeId", "queryVersion", "templateId", "sourceTable",
      "requestedStartDateTime", "requestedEndDateTime", "observedStartDateTime", "observedEndDateTime", "observationTime", "complete", "noData",
      "partialReason", "providerRequestId", "providerRowCount", "storedRowCount", "expiresAt", "eventTime", "actionType", "operation", "agentId",
      "agentName", "entraAgentObjectId", "blueprintId", "actorObjectId", "application", "applicationId", "objectId", "reportId", "correlationId",
      "parentCorrelationId", "toolName", "toolType", "errorType", "contentAvailable", "associationStatus"] as const;
    const rows = result.value.map(row => exportRow(result, scope.tenantId, row));
    const csv = buildBoundedCsv(columns, rows, { maximumRows: 200, maximumBytes: 2_000_000, deadlineAt });
    await publishBoundedCsv(request, response, `defender-hunting-${id}.csv`, csv.buffer, {
      deadlineAt, validate: validatePublication, beforeEnd: () => audit.completeEvent(event.id, { status: "succeeded", metadata: {
        source: "microsoft_defender_hunting", jobId: id, resultingCount: csv.rowCount, resultingBytes: csv.byteCount,
      } }).then(() => undefined),
    });
  } catch (error) {
    await audit.completeEvent(event.id, { status: "failed", errorCode: error instanceof AppError ? error.code : "hunting_export_failed" });
    if (response.headersSent) {
      if (!response.destroyed) response.destroy();
      return;
    }
    throw error;
  }
});

function exportRow(result: Awaited<ReturnType<typeof defenderHunting.rows>>, tenantId: string, row: DefenderHuntingRow) {
  const inventory = row.sourceTable === "AgentsInfo";
  return { jobId: result.job.id, tenantId, tokenMode: result.job.tokenMode, resultScopeKind: result.job.resultScope.kind,
    resultScopeId: result.job.resultScope.scopeId, queryVersion: result.job.queryVersion, templateId: result.job.filters.templateId,
    sourceTable: row.sourceTable, requestedStartDateTime: result.snapshot.requestedRange.startDateTime,
    requestedEndDateTime: result.snapshot.requestedRange.endDateTime, observedStartDateTime: result.snapshot.observedRange?.startDateTime ?? null,
    observedEndDateTime: result.snapshot.observedRange?.endDateTime ?? null, observationTime: result.snapshot.observationTime,
    complete: result.snapshot.complete, noData: result.snapshot.noData, partialReason: result.snapshot.partialReason,
    providerRequestId: result.job.providerRequestId, providerRowCount: result.snapshot.providerRowCount, storedRowCount: result.snapshot.storedRowCount,
    expiresAt: result.snapshot.expiresAt, eventTime: inventory ? row.observationTime : row.timestamp,
    actionType: inventory ? null : row.actionType, operation: inventory ? null : row.operation, agentId: inventory ? row.agentId : row.targetAgentId ?? row.agentId,
    agentName: inventory ? row.agentName : row.targetAgentName ?? row.agentName, entraAgentObjectId: inventory ? row.entraAgentObjectId : null,
    blueprintId: inventory ? row.entraBlueprintId : row.targetAgentBlueprintId ?? row.agentBlueprintId,
    actorObjectId: inventory ? null : row.actorAccountObjectId, application: inventory ? row.platform : row.cloudApplication,
    applicationId: inventory ? null : row.cloudApplicationId, objectId: inventory ? row.sourceAgentId : row.objectId, reportId: inventory ? null : row.reportId,
    correlationId: inventory ? row.observabilityId : row.spanId, parentCorrelationId: inventory ? null : row.parentSpanId,
    toolName: inventory ? null : row.toolName, toolType: inventory ? null : row.toolType, errorType: inventory ? null : row.errorType,
    contentAvailable: inventory ? false : row.contentAvailable, associationStatus: row.association?.status ?? "unresolved" };
}

async function auditedRead<T extends { count: number }>(request: Request, jobId: string, action: "view-hunting" | "export-hunting", operation: () => Promise<T>) {
  const scope = requestScope(request);
  const audit = getAuditLog(scope);
  const event = await audit.startEvent({ operationId: `${action}:${jobId}:${randomUUID()}`, scope: "single", action, agentId: jobId,
    actor: request.session.user!, requestPath: request.path, metadata: { source: "microsoft_defender_hunting" } });
  try {
    const result = await operation();
    await audit.completeEvent(event.id, { status: "succeeded", metadata: { source: "microsoft_defender_hunting", resultingCount: result.count } });
    return result;
  } catch (error) {
    await audit.completeEvent(event.id, { status: "failed", errorCode: error instanceof AppError ? error.code : "hunting_read_failed" });
    throw error;
  }
}

async function auditedLifecycle<T>(request: Request, action: "approve-hunting" | "qualify-hunting" | "submit-hunting" | "cancel-hunting" | "delete-hunting" | "revoke-hunting-scope", target: string,
  mode: DefenderHuntingTokenMode | undefined, operation: () => Promise<T>) {
  const scope = requestScope(request);
  const audit = getAuditLog(scope);
  const event = await audit.startEvent({ operationId: `${action}:${target}:${randomUUID()}`, scope: "single", action, agentId: target,
    actor: request.session.user!, requestPath: request.path, metadata: { source: "microsoft_defender_hunting", ...(mode ? { mode } : {}) } });
  try {
    const result = await operation();
    await audit.completeEvent(event.id, { status: "succeeded", metadata: { source: "microsoft_defender_hunting", ...(mode ? { mode } : {}) } });
    return result;
  } catch (error) {
    await audit.completeEvent(event.id, { status: "failed", errorCode: error instanceof AppError ? error.code : "hunting_action_failed" });
    throw error;
  }
}

async function startOrWaiting(request: Request, id: string, mode: DefenderHuntingTokenMode) {
  try { return await defenderHunting.start(request.session.user!, id, mode); }
  catch (error) {
    if (error instanceof AppError && (error.status === 401 || ["interaction_required", "authorization_expired"].includes(error.code))) return defenderHunting.get(request.session.user!, id);
    throw error;
  }
}

async function startQualificationOrWaiting(request: Request, id: string) {
  try { return await defenderHunting.startQualification(request.session.user!, id); }
  catch (error) {
    if (error instanceof AppError && (error.status === 401 || ["interaction_required", "authorization_expired"].includes(error.code))) return defenderHunting.get(request.session.user!, id);
    throw error;
  }
}

function tokenMode(value: unknown): DefenderHuntingTokenMode {
  if (value !== "delegated" && value !== "application") throw new AppError(400, "invalid_token_mode", "Hunting token mode must be delegated or application.");
  return value;
}

function confirmExactId(value: unknown, id: string, subject: string) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("confirmation" in value)) throw new AppError(400, "confirmation_required", `Confirm the exact ${subject} ID.`);
  if ((value as { confirmation?: unknown }).confirmation !== id) throw new AppError(409, "confirmation_mismatch", `The confirmation does not match the exact ${subject} ID.`);
}

function confirmLocalDelete(value: unknown, id: string) {
  confirmExactId(value, id, "hunting job before deleting its local cache");
}

function uuid(value: unknown) {
  const id = String(value);
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new AppError(400, "invalid_job_id", "Invalid hunting job ID.");
  return id;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number, allowZero = false) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1) || parsed > maximum) throw new AppError(400, "invalid_hunting_query", "Hunting paging value is outside the supported range.");
  return parsed;
}

function first(value: unknown) {
  return Array.isArray(value) ? typeof value[0] === "string" ? value[0] : undefined : typeof value === "string" ? value : undefined;
}
