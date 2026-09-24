import { Router } from "express";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { dataSync, type DataSyncService } from "../services/dataSync.js";
import { dataSyncSourceIds, type DataSyncSourceId, type StartDataSyncInput } from "../types/dataSync.js";
import { policyRoute } from "./policy.js";

export function createDataSyncRouter(service: Pick<DataSyncService, "state" | "getRun" | "start" | "retry" | "cancel" | "automaticRefresh"> = dataSync) {
  const router = Router();

  policyRoute(router, "post", "/data-sync/auto-refresh", {
    access: "authenticated",
    dataClass: "private_data_sync_job",
    roles: ["AgentControl.Viewer"],
    csrf: true,
  }, async (request, response) => {
    requestScope(request);
    requireEmptyBody(request.body, "Automatic refresh does not accept options.");
    if (Object.keys(request.query).length) throw new AppError(400, "invalid_data_sync_query", "Automatic refresh does not accept query parameters.");
    response.setHeader("Cache-Control", "no-store");
    response.json(await service.automaticRefresh(request.session.user!, request.session.signedInAt));
  });

  policyRoute(router, "get", "/data-sync/state", {
    access: "authenticated",
    dataClass: "private_data_sync",
    roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    requestScope(request);
    if (Object.keys(request.query).length) throw new AppError(400, "invalid_data_sync_query", "Data sync state does not accept query parameters.");
    response.setHeader("Cache-Control", "no-store");
    response.json(await service.state(request.session.user!));
  });

  policyRoute(router, "post", "/data-sync/runs", {
    access: "authenticated",
    dataClass: "private_data_sync_job",
    roles: ["AgentControl.Viewer"],
    csrf: true,
  }, async (request, response) => {
    requestScope(request);
    const run = await service.start(request.session.user!, parseStartDataSyncInput(request.body));
    response.locals.jobId = run.id;
    response.status(202).json(run);
  });

  policyRoute(router, "get", "/data-sync/runs/:id", {
    access: "authenticated",
    dataClass: "private_data_sync_job",
    roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const scope = requestScope(request);
    if (Object.keys(request.query).length) throw new AppError(400, "invalid_data_sync_query", "A data sync run does not accept query parameters.");
    const id = parseRunId(firstPathValue(request.params.id));
    response.locals.jobId = id;
    response.setHeader("Cache-Control", "no-store");
    response.json(await service.getRun(scope, id));
  });

  policyRoute(router, "post", "/data-sync/runs/:id/retry", {
    access: "authenticated",
    dataClass: "private_data_sync_job",
    roles: ["AgentControl.Viewer"],
    csrf: true,
  }, async (request, response) => {
    requestScope(request);
    const input = parseRetryDataSyncInput(request.body);
    const run = await service.retry(request.session.user!, parseRunId(firstPathValue(request.params.id)), input.sources);
    response.locals.jobId = run.id;
    response.status(202).json(run);
  });

  policyRoute(router, "post", "/data-sync/runs/:id/cancel", {
    access: "authenticated",
    dataClass: "private_data_sync_job",
    roles: ["AgentControl.Viewer"],
    csrf: true,
  }, async (request, response) => {
    requestScope(request);
    requireEmptyBody(request.body, "Data sync cancellation does not accept a request body.");
    const run = await service.cancel(request.session.user!, parseRunId(firstPathValue(request.params.id)));
    response.locals.jobId = run.id;
    response.json(run);
  });

  return router;
}

export function parseStartDataSyncInput(value: unknown): StartDataSyncInput {
  const record = strictRecord(value, ["mode", "sources", "clearSavedData"], "Data sync start accepts only mode, optional sources, and optional clearSavedData.");
  if (record.mode !== "initial" && record.mode !== "incremental" && record.mode !== "full") {
    throw new AppError(400, "invalid_data_sync_mode", "Data sync mode must be initial, incremental, or full.");
  }
  if (record.clearSavedData !== undefined && typeof record.clearSavedData !== "boolean") {
    throw new AppError(400, "invalid_data_sync_cleanup", "clearSavedData must be a boolean.");
  }
  if (record.clearSavedData === true && (record.mode !== "full" || record.sources !== undefined)) {
    throw new AppError(400, "invalid_data_sync_cleanup", "Clearing saved data requires mode full with all sources; omit sources.");
  }
  return {
    mode: record.mode,
    ...(record.sources === undefined ? {} : { sources: parseSources(record.sources, "Data sync sources") }),
    ...(record.clearSavedData === undefined ? {} : { clearSavedData: record.clearSavedData }),
  };
}

export function parseRetryDataSyncInput(value: unknown): { sources?: DataSyncSourceId[] } {
  const record = strictRecord(value ?? {}, ["sources"], "Data sync retry accepts only optional sources.");
  return record.sources === undefined ? {} : { sources: parseSources(record.sources, "Retry sources") };
}

function parseSources(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length < 1 || value.length > dataSyncSourceIds.length) {
    throw new AppError(400, "invalid_data_sync_sources", `${label} must be a non-empty array.`);
  }
  const sources = value.map(source => {
    if (typeof source !== "string" || !dataSyncSourceIds.includes(source as DataSyncSourceId)) {
      throw new AppError(400, "invalid_data_sync_sources", `${label} contains an unsupported source.`);
    }
    return source as DataSyncSourceId;
  });
  if (new Set(sources).size !== sources.length) {
    throw new AppError(400, "invalid_data_sync_sources", `${label} must not contain duplicates.`);
  }
  return sources;
}

function parseRunId(value: string | undefined) {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError(400, "invalid_data_sync_run", "Data sync run ID is invalid.");
  }
  return value;
}

function firstPathValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function requireEmptyBody(value: unknown, message: string) {
  strictRecord(value ?? {}, [], message);
}

function strictRecord(value: unknown, allowedKeys: readonly string[], message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "invalid_data_sync_input", message);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowedKeys.includes(key))) throw new AppError(400, "invalid_data_sync_input", message);
  return record;
}
