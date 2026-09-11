import { Router } from "express";
import { PowerPlatformInventoryRepository } from "../db/powerPlatformInventory.js";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { copilotStudioQuarantineCanaries, copilotStudioQuarantineCanaryRepository } from "../services/copilotStudioQuarantineCanaries.js";
import { copilotStudioQuarantineControl } from "../services/copilotStudioQuarantineControl.js";
import {
  cancelCopilotStudioQuarantineJob,
  copilotStudioQuarantineJobs,
  launchCopilotStudioQuarantineJob,
  reconcileCopilotStudioQuarantineJob,
} from "../services/copilotStudioQuarantineJobs.js";
import type { QuarantineAction } from "../types/copilotStudioQuarantine.js";
import { policyRoute } from "./policy.js";

export const copilotStudioQuarantineRouter = Router();
const inventoryRepository = new PowerPlatformInventoryRepository();

policyRoute(copilotStudioQuarantineRouter, "get", "/quarantine/targets", { access: "authenticated", dataClass: "copilot_studio_quarantine_target", roles: ["AgentControl.Operator"] }, async (request, response) => {
  response.json(await inventoryRepository.listQuarantineTargets(requestScope(request), {
    search: optionalSearch(first(request.query.search)),
    limit: positiveInteger(first(request.query.limit), 50, 100),
    offset: nonnegativeInteger(first(request.query.offset), 0, 100_000),
  }));
});

policyRoute(copilotStudioQuarantineRouter, "get", "/quarantine/status", { access: "authenticated", dataClass: "copilot_studio_quarantine_status", roles: ["AgentControl.Operator"], capabilityId: "powerPlatform.quarantine.manage" }, async (request, response) => {
  response.json(await copilotStudioQuarantineControl.status(request.session.user!, requiredUuid(first(request.query.snapshotId), "snapshotId"), requiredNativeId(first(request.query.nativeId)), first(request.query.force) === "true"));
});

policyRoute(copilotStudioQuarantineRouter, "post", "/quarantine/preview", { access: "authenticated", dataClass: "copilot_studio_quarantine_status", roles: ["AgentControl.Operator"], capabilityId: "powerPlatform.quarantine.manage", csrf: true }, async (request, response) => {
  response.json(await copilotStudioQuarantineControl.preview(request.session.user!, parseIntent(request.body, false)));
});

policyRoute(copilotStudioQuarantineRouter, "post", "/quarantine/jobs", { access: "authenticated", dataClass: "copilot_studio_quarantine_control", roles: ["AgentControl.Operator"], capabilityId: "powerPlatform.quarantine.manage", csrf: true }, async (request, response) => {
  const intent = parseIntent(request.body, true);
  response.status(202).json(await copilotStudioQuarantineControl.submit(request.session.user!, {
    ...intent,
    confirmationHash: requiredHash(request.body?.confirmationHash),
    idempotencyKey: requiredIdempotencyKey(request.get("Idempotency-Key")),
  }));
});

policyRoute(copilotStudioQuarantineRouter, "get", "/quarantine/jobs", { access: "authenticated", dataClass: "copilot_studio_quarantine_job", roles: ["AgentControl.Operator"] }, async (request, response) => {
  response.json(await copilotStudioQuarantineJobs.list(requestScope(request), positiveInteger(first(request.query.limit), 20, 50)));
});

policyRoute(copilotStudioQuarantineRouter, "get", "/quarantine/audit", { access: "authenticated", dataClass: "copilot_studio_quarantine_audit", roles: ["AgentControl.SecurityReader"] }, async (request, response) => {
  response.json(await copilotStudioQuarantineJobs.listAudit(requestScope(request), positiveInteger(first(request.query.limit), 100, 500)));
});

policyRoute(copilotStudioQuarantineRouter, "get", "/quarantine/jobs/:id", { access: "authenticated", dataClass: "copilot_studio_quarantine_job", roles: ["AgentControl.Operator"] }, async (request, response) => {
  await copilotStudioQuarantineJobs.recoverInterrupted();
  const job = await copilotStudioQuarantineJobs.get(requestScope(request), requiredUuid(request.params.id, "job ID"));
  if (!job) throw new AppError(404, "not_found", "Quarantine job was not found.");
  response.json(job);
});

policyRoute(copilotStudioQuarantineRouter, "post", "/quarantine/jobs/:id/cancel", { access: "authenticated", dataClass: "copilot_studio_quarantine_job", roles: ["AgentControl.Operator"], csrf: true }, async (request, response) => {
  const job = await cancelCopilotStudioQuarantineJob(requestScope(request), requiredUuid(request.params.id, "job ID"));
  if (!job) throw new AppError(404, "not_found", "Quarantine job was not found.");
  response.json(job);
});

policyRoute(copilotStudioQuarantineRouter, "post", "/quarantine/jobs/:id/resume", { access: "authenticated", dataClass: "copilot_studio_quarantine_job", roles: ["AgentControl.Operator"], capabilityId: "powerPlatform.quarantine.manage", csrf: true }, async (request, response) => {
  if (request.body?.confirmed !== true || Object.keys(request.body).length !== 1) throw new AppError(400, "confirmation_required", "Resume accepts only explicit confirmed true for unsent work.");
  const scope = requestScope(request);
  const id = requiredUuid(request.params.id, "job ID");
  await copilotStudioQuarantineJobs.recoverInterrupted();
  const job = await copilotStudioQuarantineJobs.get(scope, id);
  if (!job) throw new AppError(404, "not_found", "Quarantine job was not found.");
  if (!job.canResume) throw new AppError(409, "not_resumable", "No authorized unsent quarantine work can be resumed.");
  launchCopilotStudioQuarantineJob(id, scope, true);
  response.status(202).json(job);
});

policyRoute(copilotStudioQuarantineRouter, "post", "/quarantine/jobs/:id/reconcile", { access: "authenticated", dataClass: "copilot_studio_quarantine_job", roles: ["AgentControl.Operator"], capabilityId: "powerPlatform.quarantine.manage", csrf: true }, async (request, response) => {
  if (request.body && Object.keys(request.body).length) throw new AppError(400, "invalid_request", "Quarantine reconciliation does not accept mutation input.");
  response.json(await reconcileCopilotStudioQuarantineJob(requiredUuid(request.params.id, "job ID"), requestScope(request)));
});

policyRoute(copilotStudioQuarantineRouter, "post", "/quarantine/canary-approvals", { access: "authenticated", dataClass: "copilot_studio_quarantine_qualification", roles: ["AgentControl.Administrator"], csrf: true }, async (request, response) => {
  response.status(201).json(await copilotStudioQuarantineCanaries.createApproval(request.session.user!, parseCanaryApproval(request.body)));
});

policyRoute(copilotStudioQuarantineRouter, "get", "/quarantine/canary-approvals", { access: "authenticated", dataClass: "copilot_studio_quarantine_qualification", roles: ["AgentControl.Administrator"] }, async (request, response) => {
  response.json(await copilotStudioQuarantineCanaryRepository.list(request.session.user!, positiveInteger(first(request.query.limit), 50, 100)));
});

policyRoute(copilotStudioQuarantineRouter, "post", "/quarantine/canary-approvals/:id/execute", { access: "authenticated", dataClass: "copilot_studio_quarantine_qualification", roles: ["AgentControl.Operator"], capabilityId: "powerPlatform.quarantine.manage", csrf: true }, async (request, response) => {
  const execution = parseCanaryExecution(request.body);
  response.json(await copilotStudioQuarantineCanaries.execute(request.session.user!, requiredUuid(request.params.id, "approval ID"), execution.restorationApprovalId));
});

function parseIntent(value: unknown, includeConfirmation: boolean) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "invalid_request", "Quarantine intent must be an object.");
  const record = value as Record<string, unknown>;
  const expected = includeConfirmation ? ["action", "confirmationHash", "resourceNativeIds", "snapshotId"] : ["action", "forceStatus", "resourceNativeIds", "snapshotId"];
  const allowed = new Set(expected);
  if (Object.keys(record).some(key => !allowed.has(key))) throw new AppError(400, "invalid_request", "Quarantine intent contains unsupported fields.");
  const action = actionValue(record.action);
  const resourceNativeIds = nativeIds(record.resourceNativeIds);
  return { action, snapshotId: requiredUuid(record.snapshotId, "snapshotId"), resourceNativeIds, ...(!includeConfirmation && record.forceStatus === true ? { forceStatus: true } : {}) };
}

function parseCanaryApproval(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "invalid_qualification", "Quarantine canary approval must be an object.");
  const record = value as Record<string, unknown>;
  const expected = ["action", "nativeId", "poststate", "prestate", "prestateProviderUpdatedAt", "snapshotId"];
  if (Object.keys(record).sort().join("\0") !== expected.join("\0") || typeof record.prestate !== "boolean" || typeof record.poststate !== "boolean"
    || !(record.prestateProviderUpdatedAt === null || typeof record.prestateProviderUpdatedAt === "string")) {
    throw new AppError(400, "invalid_qualification", "Canary approval accepts only the exact target, action, semantic states, and provider timestamp evidence.");
  }
  return { snapshotId: requiredUuid(record.snapshotId, "snapshotId"), resourceNativeId: requiredNativeId(record.nativeId), action: actionValue(record.action),
    prestate: record.prestate, prestateProviderUpdatedAt: record.prestateProviderUpdatedAt, poststate: record.poststate };
}

function parseCanaryExecution(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "confirmation_required", "Canary execution requires explicit confirmation and one restoration approval.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== "confirmed\0restorationApprovalId" || record.confirmed !== true) throw new AppError(400, "confirmation_required", "Canary execution accepts only confirmed true and restorationApprovalId.");
  return { restorationApprovalId: requiredUuid(record.restorationApprovalId, "restoration approval ID") };
}

function actionValue(value: unknown): QuarantineAction {
  if (value !== "quarantine" && value !== "unquarantine") throw new AppError(400, "invalid_quarantine_action", "Quarantine action must be quarantine or unquarantine.");
  return value;
}

function nativeIds(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 25) throw new AppError(400, "invalid_quarantine_target", "Select 1-25 exact native inventory resources.");
  return value.map(requiredNativeId);
}

function requiredNativeId(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 512 || /[\r\n\0]/.test(value)) throw new AppError(400, "invalid_quarantine_target", "An exact native inventory resource ID is required.");
  return value;
}

function requiredUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new AppError(400, "invalid_quarantine_target", `A valid ${label} is required.`);
  return value;
}

function requiredHash(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new AppError(400, "confirmation_required", "The exact quarantine confirmation hash is required.");
  return value;
}

function requiredIdempotencyKey(value: unknown) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new AppError(400, "invalid_idempotency_key", "A valid Idempotency-Key header is required.");
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new AppError(400, "invalid_quarantine_query", "Quarantine paging value is outside the supported range.");
  return parsed;
}

function nonnegativeInteger(value: string | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new AppError(400, "invalid_quarantine_query", "Quarantine paging value is outside the supported range.");
  return parsed;
}

function optionalSearch(value: string | undefined) {
  if (value === undefined || value === "") return undefined;
  if (value.length > 128 || /[\r\n\0]/.test(value)) throw new AppError(400, "invalid_quarantine_query", "Quarantine target search is invalid.");
  return value;
}

function first(value: unknown) {
  return Array.isArray(value) ? typeof value[0] === "string" ? value[0] : undefined : typeof value === "string" ? value : undefined;
}