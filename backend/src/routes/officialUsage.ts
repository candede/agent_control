import { createHash, randomUUID } from "node:crypto";
import { Router, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import type pg from "pg";
import { config } from "../config.js";
import { OfficialUsageRepository } from "../db/officialUsage.js";
import { PackageInventoryRepository } from "../db/packageInventory.js";
import { pool } from "../db/pool.js";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { parseOfficialUsageReport, OfficialUsageValidationError } from "../services/officialUsageParser.js";
import { buildOfficialUsageAggregateView, buildOfficialUsageUserView } from "../services/officialUsageViews.js";
import { getAuditLog } from "../services/auditLog.js";
import { buildBoundedCsv, createExportPublicationValidator, publishBoundedCsv } from "../services/csvExport.js";
import type { AppRole } from "../types/capability.js";
import type { ReportExportAction } from "../types/audit.js";
import type { OfficialUsageAggregateView, OfficialUsageMetadata, OfficialUsageUserView } from "../types/officialUsage.js";
import { policyRoute } from "./policy.js";
import { operationalLog } from "../services/telemetry.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 8, fieldSize: 4_096, parts: 9 },
});
const uploadRequestState = Symbol("officialUsageUploadState");
const uploadDeadlineMilliseconds = 15_000;
const maxConcurrentUploads = 2;
let activeUploads = 0;

type UploadRequest = Request & {
  [uploadRequestState]?: {
    deadlineAt: number;
    disconnected: boolean;
    timedOut: boolean;
    signal: AbortSignal;
    settleParser: () => void;
    startWork: () => void;
    settleWork: () => void;
    release: () => void;
  };
};

const reserveUpload: RequestHandler = (request: UploadRequest, response, next) => {
  if (activeUploads >= maxConcurrentUploads) {
    return next(new AppError(429, "upload_admission_full", "Two official usage uploads are already being processed; retry after one finishes."));
  }
  activeUploads += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    activeUploads -= 1;
  };
  let parserSettled = false;
  let workStarted = false;
  let workSettled = false;
  const maybeRelease = () => {
    if (parserSettled && (!workStarted || workSettled)) release();
  };
  const controller = new AbortController();
  const timeoutError = new AppError(408, "upload_deadline", "The official usage upload exceeded its processing deadline and was cancelled.");
  const disconnectError = new AppError(400, "upload_disconnected", "The official usage upload was disconnected and was not retained.");
  const abort = (reason: AppError) => {
    if (!controller.signal.aborted) controller.abort(reason);
    clearUploadBuffer(request);
  };
  const timer = setTimeout(() => {
    const state = request[uploadRequestState];
    if (!state || released) return;
    state.timedOut = true;
    abort(timeoutError);
    if (!response.headersSent && !response.writableEnded && !response.destroyed) {
      response.setHeader("Connection", "close");
      response.status(timeoutError.status).json({ error: { code: timeoutError.code, message: timeoutError.message } });
    }
    if (!request.complete && !request.destroyed) {
      if (response.writableFinished) request.destroy();
      else response.once("finish", () => request.destroy());
    }
  }, uploadDeadlineMilliseconds);
  timer.unref();
  request[uploadRequestState] = {
    deadlineAt: Date.now() + uploadDeadlineMilliseconds,
    disconnected: false,
    timedOut: false,
    signal: controller.signal,
    settleParser: () => { parserSettled = true; maybeRelease(); },
    startWork: () => { workStarted = true; },
    settleWork: () => { workSettled = true; maybeRelease(); },
    release,
  };
  const markDisconnected = () => {
    const state = request[uploadRequestState];
    if (!state || request.complete || state.timedOut) return;
    state.disconnected = true;
    abort(disconnectError);
    state.settleParser();
  };
  request.once("aborted", markDisconnected);
  request.once("close", markDisconnected);
  response.once("close", () => {
    const state = request[uploadRequestState];
    if (!state || response.writableEnded || state.timedOut) return;
    state.disconnected = true;
    abort(disconnectError);
  });
  next();
};

const csvUpload: RequestHandler = (request: UploadRequest, response, next) => {
  upload.single("file")(request, response, error => {
    const state = request[uploadRequestState];
    if (state?.signal.aborted) {
      state.settleParser();
      clearUploadBuffer(request);
      return;
    }
    if (!error) {
      state?.startWork();
      state?.settleParser();
      return next();
    }
    state?.settleParser();
    clearUploadBuffer(request);
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      return next(new AppError(tooLarge ? 413 : 400, tooLarge ? "report_too_large" : "invalid_multipart", tooLarge
        ? "The report exceeds the 8 MiB upload limit."
        : "The multipart report upload exceeds the supported file or field limits."));
    }
    next(new AppError(400, "invalid_multipart", "The multipart report upload is invalid."));
  });
};

export function createOfficialUsageRouter(database: pg.Pool = pool) {
  const router = Router();
  const repository = new OfficialUsageRepository(database);
  const packageRepository = new PackageInventoryRepository(database);

  policyRoute(router, "post", "/official-usage/staging", {
    access: "authenticated", dataClass: "official_usage_import", roles: ["AgentControl.Administrator"], csrf: true,
  }, reserveUpload, csvUpload, async (request: UploadRequest, response) => {
    const uploadState = request[uploadRequestState];
    const file = request.file;
    let stagedId: string | undefined;
    try {
      if (!file) throw new AppError(400, "missing_report", "Select one CSV report file.");
      assertUploadActive(request);
      const input = parseStageFields(request.body);
      let report;
      try {
        report = parseOfficialUsageReport(file.buffer, input.metadata);
      } catch (error) {
        if (error instanceof OfficialUsageValidationError) throw new AppError(400, error.code, error.message);
        throw error;
      }
      assertUploadActive(request);
      const preview = await repository.stage(requestScope(request), {
        report,
        fileHash: createHash("sha256").update(file.buffer).digest("hex"),
        bundleId: input.bundleId,
        correctionOfSetId: input.correctionOfSetId,
        signal: uploadState?.signal,
      });
      stagedId = preview.id;
      assertUploadActive(request);
      response.status(201).json(preview);
    } catch (error) {
      if (stagedId) {
        try {
          await repository.discardStaging(requestScope(request), stagedId);
        } catch {
          operationalLog("error", "official_usage_upload_cleanup_failed");
          if (!response.headersSent && !response.destroyed) {
            throw new AppError(500, "upload_cleanup_failed", "The cancelled upload cleanup could not be verified; inspect retained staging before retrying.");
          }
          return;
        }
      }
      if (!response.headersSent && !response.destroyed) throw error;
    } finally {
      clearUploadBuffer(request);
      uploadState?.settleWork();
    }
  });

  policyRoute(router, "get", "/official-usage/admin", {
    access: "authenticated", dataClass: "official_usage_metadata", roles: ["AgentControl.Administrator"],
  }, async (request, response) => {
    response.json(await repository.getAdminState(requestScope(request)));
  });

  policyRoute(router, "delete", "/official-usage/staging/:id", {
    access: "authenticated", dataClass: "official_usage_import", roles: ["AgentControl.Administrator"], csrf: true,
  }, async (request, response) => {
    await repository.discardStaging(requestScope(request), uuid(request.params.id));
    response.status(204).end();
  });

  policyRoute(router, "post", "/official-usage/bundles/:id/preview", {
    access: "authenticated", dataClass: "official_usage_import", roles: ["AgentControl.Administrator"], csrf: true,
  }, async (request, response) => {
    response.json(await repository.previewBundle(requestScope(request), uuid(request.params.id)));
  });

  policyRoute(router, "post", "/official-usage/bundles/:id/accept", {
    access: "authenticated", dataClass: "official_usage_import", roles: ["AgentControl.Administrator"], csrf: true,
  }, async (request, response) => {
    response.json(await repository.acceptBundle(requestScope(request), uuid(request.params.id), {
      bundleHash: hash(request.body?.bundleHash, "bundle hash"),
      expectedActiveRevision: positiveInteger(request.body?.expectedActiveRevision, "active revision"),
    }));
  });

  policyRoute(router, "post", "/official-usage/sets/:id/preview", {
    access: "authenticated", dataClass: "official_usage_metadata", roles: ["AgentControl.Administrator"], csrf: true,
  }, async (request, response) => {
    response.json(await repository.previewSetOperation(requestScope(request), operation(request.body?.operation), uuid(request.params.id)));
  });

  policyRoute(router, "post", "/official-usage/confirmations/:id", {
    access: "authenticated", dataClass: "official_usage_metadata", roles: ["AgentControl.Administrator"], csrf: true,
  }, async (request, response) => {
    response.json(await repository.confirmSetOperation(requestScope(request), uuid(request.params.id), {
      operation: operation(request.body?.operation),
      setId: uuid(request.body?.setId),
      expectedRevision: positiveInteger(request.body?.expectedRevision, "active revision"),
      confirmationHash: hash(request.body?.confirmationHash, "confirmation hash"),
    }));
  });

  policyRoute(router, "post", "/official-usage/legacy-cleanup-acknowledgements", {
    access: "authenticated", dataClass: "official_usage_metadata", roles: ["AgentControl.Administrator"], csrf: true,
  }, async (request, response) => {
    if (!request.body || !["reimported", "discarded"].includes(request.body.disposition) || Object.keys(request.body).some(key => key !== "disposition")) {
      throw new AppError(400, "invalid_legacy_acknowledgement", "Acknowledge either successful re-import or explicit discard without sending legacy report content.");
    }
    await repository.acknowledgeLegacyCleanup(requestScope(request));
    response.status(204).end();
  });

  policyRoute(router, "get", "/official-usage/aggregate", {
    access: "authenticated", dataClass: "official_usage_aggregate", roles: ["AgentControl.Reader"],
  }, async (request, response) => {
    const scope = requestScope(request);
    const [published, packages] = await Promise.all([
      repository.getPublished(scope.tenantId),
      packageRepository.list(scope, { limit: 5_000, offset: 0 }),
    ]);
    response.json(buildOfficialUsageAggregateView(published, packages.value, aggregateOptions(request.query)));
  });

  policyRoute(router, "get", "/official-usage/aggregate.csv", {
    access: "authenticated", dataClass: "official_usage_aggregate_export", roles: ["AgentControl.Reader"],
  }, async (request, response) => {
    await sendOfficialCsv(request, response, {
      role: "AgentControl.Reader",
      action: "export-official-usage-aggregate",
      filename: "official-agent-usage.csv",
      load: async () => {
        const scope = requestScope(request);
        const [published, packages] = await Promise.all([
          repository.getPublished(scope.tenantId),
          packageRepository.list(scope, { limit: 5_000, offset: 0 }),
        ]);
        const view = buildOfficialUsageAggregateView(published, packages.value, { ...aggregateOptions(request.query), limit: 100_000, offset: 0 });
        const datasetKey = officialDatasetKey(published);
        return {
          columns: ["agentId", "agentName", "creatorType", "creatorTypeSource", "activeUsersLicensed", "activeUsersUnlicensed", "activeUsersTotal", "activeUsersTotalBasis", "activeUsersIdentityCount", "responsesSentToUsers", "responseComparisonStatus", "responsesAgentsReport", "responsesUsersAndAgentsReport", "lastActivityDateUtc", "sourceReports", "identityStatus", "reportSetId", "reportingStart", "reportingEnd", "agentsVersionId", "agentsPeriodProvenance", "agentsSourceFreshness", "userAgentsVersionId", "userAgentsPeriodProvenance", "userAgentsSourceFreshness"] as const,
          rows: agentExportRows(view),
          metadata: { source: "official_usage", reportSetId: view.activeSet?.id ?? null,
            reportingStart: view.activeSet?.reportingPeriod.startDate ?? null, reportingEnd: view.activeSet?.reportingPeriod.endDate ?? null },
          validateSource: async () => {
            if (officialDatasetKey(await repository.getPublished(scope.tenantId)) !== datasetKey) {
              throw new AppError(409, "dataset_invalidated", "The official usage dataset changed or was deleted before export publication completed.");
            }
          },
        };
      },
    });
  });

  policyRoute(router, "get", "/official-usage/users", {
    access: "authenticated", dataClass: "official_usage_user", roles: ["AgentControl.SecurityReader"],
  }, async (request, response) => {
    const scope = requestScope(request);
    response.json(buildOfficialUsageUserView(await repository.getPublished(scope.tenantId), userViewOptions(request.query)));
  });

  policyRoute(router, "get", "/official-usage/users.csv", {
    access: "authenticated", dataClass: "official_usage_user_export", roles: ["AgentControl.SecurityReader"],
  }, async (request, response) => {
    await sendOfficialCsv(request, response, {
      role: "AgentControl.SecurityReader",
      action: "export-official-usage-users",
      filename: "official-user-usage.csv",
      load: async () => {
        const scope = requestScope(request);
        const published = await repository.getPublished(scope.tenantId);
        const view = buildOfficialUsageUserView(published, {
          ...userViewOptions(request.query), limit: 100_000, offset: 0,
        });
        const datasetKey = officialDatasetKey(published);
        return {
          columns: ["username", "displayName", "userMetricSource", "reportedAgentsUsed", "reportedResponsesReceived", "userLastActivityDateUtc", "agentId", "agentName", "creatorType", "creatorTypeSource", "responsesSentToUsers", "agentLastUsedByAnyoneDateUtc", "reportSetId", "reportingStart", "reportingEnd", "usersVersionId", "usersPeriodProvenance", "usersSourceFreshness", "userAgentsVersionId", "userAgentsPeriodProvenance", "userAgentsSourceFreshness", "identityStatus"] as const,
          rows: userExportRows(view),
          metadata: { source: "official_usage", reportSetId: view.activeSet?.id ?? null,
            reportingStart: view.activeSet?.reportingPeriod.startDate ?? null, reportingEnd: view.activeSet?.reportingPeriod.endDate ?? null },
          validateSource: async () => {
            if (officialDatasetKey(await repository.getPublished(scope.tenantId)) !== datasetKey) {
              throw new AppError(409, "dataset_invalidated", "The official usage dataset changed or was deleted before export publication completed.");
            }
          },
        };
      },
    });
  });

  return router;
}

function parseStageFields(body: unknown): { bundleId: string; correctionOfSetId?: string; metadata: OfficialUsageMetadata } {
  if (!body || typeof body !== "object") throw new AppError(400, "invalid_metadata", "Explicit report metadata is required.");
  const fields = body as Record<string, unknown>;
  const allowed = new Set(["bundleId", "correctionOfSetId", "reportingStart", "reportingEnd", "periodProvenance", "sourceAsOf", "sourceAsOfProvenance", "downloadedAt"]);
  if (Object.keys(fields).some(key => !allowed.has(key))) throw new AppError(400, "invalid_metadata", "The report metadata contains an unsupported field.");
  const periodProvenance = provenance(fields.periodProvenance, "period provenance");
  const sourceAsOf = optionalText(fields.sourceAsOf, 128);
  const sourceProvenance = fields.sourceAsOfProvenance === undefined ? undefined : provenance(fields.sourceAsOfProvenance, "source as-of provenance");
  if (Boolean(sourceAsOf) !== Boolean(sourceProvenance)) throw new AppError(400, "invalid_metadata", "Source as-of value and provenance must be supplied together.");
  return {
    bundleId: uuid(fields.bundleId),
    correctionOfSetId: fields.correctionOfSetId ? uuid(fields.correctionOfSetId) : undefined,
    metadata: {
      reportingPeriod: {
        startDate: text(fields.reportingStart, "reporting period start", 10),
        endDate: text(fields.reportingEnd, "reporting period end", 10),
        provenance: periodProvenance,
      },
      ...(sourceAsOf && sourceProvenance ? { sourceAsOf: { value: sourceAsOf, provenance: sourceProvenance } } : {}),
      ...(fields.downloadedAt ? { downloadedAt: text(fields.downloadedAt, "download time", 128) } : {}),
    },
  };
}

function aggregateOptions(query: Record<string, unknown>) {
  return {
    staleAfterDays: config.officialUsageStaleDays,
    inactiveDays: queryInteger(first(query.inactiveDays), 30, 365, true),
    activityWindowDays: queryInteger(first(query.activityWindowDays), 30, 365, true),
    limit: queryInteger(first(query.limit), 5_000, 5_000, true),
    offset: queryInteger(first(query.offset), 0, 100_000, false),
  };
}

function userViewOptions(query: Record<string, unknown>) {
  const activity = first(query.activity);
  if (activity !== undefined && !["all", "recent", "inactive", "no-activity"].includes(activity)) {
    throw new AppError(400, "invalid_usage_query", "The official usage activity filter is invalid.");
  }
  const responsesOnly = first(query.responsesOnly);
  if (responsesOnly !== undefined && responsesOnly !== "true" && responsesOnly !== "false") {
    throw new AppError(400, "invalid_usage_query", "The official usage response filter is invalid.");
  }
  return {
    staleAfterDays: config.officialUsageStaleDays,
    search: queryText(first(query.search), 256),
    creatorType: queryText(first(query.creatorType), 128),
    activity: activity as "all" | "recent" | "inactive" | "no-activity" | undefined,
    responsesOnly: responsesOnly === "true",
    inactiveDays: queryInteger(first(query.inactiveDays), 30, 365, true),
    limit: queryInteger(first(query.limit), 100, 500, true),
    offset: queryInteger(first(query.offset), 0, 100_000, false),
  };
}

function operation(value: unknown) {
  if (value !== "select" && value !== "delete") throw new AppError(400, "invalid_operation", "Official usage operation must be select or delete.");
  return value;
}

function provenance(value: unknown, label: string): "operator_asserted" {
  if (value !== "operator_asserted") throw new AppError(400, "invalid_metadata", `The ${label} must be operator_asserted because the supported CSV schemas contain no source metadata fields.`);
  return value;
}

function positiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new AppError(400, "invalid_revision", `The ${label} must be a positive integer.`);
  return Number(value);
}

function queryInteger(value: string | undefined, fallback: number, maximum: number, positive: boolean) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < (positive ? 1 : 0) || parsed > maximum) throw new AppError(400, "invalid_usage_query", "Official usage paging or window value is outside the supported range.");
  return parsed;
}

function text(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value || value.length > maximum || /[\r\n\0]/.test(value)) throw new AppError(400, "invalid_metadata", `The ${label} is invalid.`);
  return value;
}

function optionalText(value: unknown, maximum: number) {
  return value === undefined || value === "" ? undefined : text(value, "optional metadata", maximum);
}

function queryText(value: string | undefined, maximum: number) {
  if (value === undefined || value === "") return undefined;
  if (value.length > maximum || /[\r\n\0]/.test(value)) throw new AppError(400, "invalid_usage_query", "The official usage text filter is invalid.");
  return value;
}

function uuid(value: unknown) {
  if (typeof value !== "string") throw new AppError(400, "invalid_identifier", "The official usage identifier is invalid.");
  const id = value;
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new AppError(400, "invalid_identifier", "The official usage identifier is invalid.");
  return id;
}

function assertUploadActive(request: UploadRequest) {
  const state = request[uploadRequestState];
  if (state?.signal.aborted) {
    throw state.signal.reason instanceof Error ? state.signal.reason : new AppError(400, "upload_disconnected", "The official usage upload was cancelled.");
  }
  if (!state || state.disconnected || request.aborted) {
    throw new AppError(400, "upload_disconnected", "The official usage upload was disconnected and was not retained.");
  }
  if (Date.now() > state.deadlineAt) {
    throw new AppError(408, "upload_deadline", "The official usage upload exceeded its processing deadline and was not retained.");
  }
}

function clearUploadBuffer(request: Request) {
  if (!request.file) return;
  request.file.buffer = Buffer.alloc(0);
  request.file = undefined;
}

function hash(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new AppError(400, "invalid_hash", `The ${label} is invalid.`);
  return value;
}

function first(value: unknown) {
  return Array.isArray(value) ? typeof value[0] === "string" ? value[0] : undefined : typeof value === "string" ? value : undefined;
}

function* agentExportRows(view: OfficialUsageAggregateView) {
  const agentsLineage = view.lineages.find(lineage => lineage.kind === "agents");
  const userAgentsLineage = view.lineages.find(lineage => lineage.kind === "userAgents");
  for (const agent of view.agents.value) yield {
    ...agent,
    activeUsersLicensed: agent.activeUsersLicensed ?? "Unknown",
    activeUsersUnlicensed: agent.activeUsersUnlicensed ?? "Unknown",
    activeUsersTotal: agent.activeUsersTotal ?? "Unknown",
    activeUsersIdentityCount: agent.activeUsersIdentityCount ?? "Unknown",
    sourceReports: agent.sourceReports.join(" | "),
    responseComparisonStatus: agent.responseComparison.status,
    responsesAgentsReport: agent.responseComparison.sourceValues.agents ?? "Unknown",
    responsesUsersAndAgentsReport: agent.responseComparison.sourceValues.userAgents ?? "Unknown",
    reportSetId: view.activeSet?.id,
    reportingStart: view.activeSet?.reportingPeriod.startDate,
    reportingEnd: view.activeSet?.reportingPeriod.endDate,
    agentsVersionId: agentsLineage?.versionId,
    agentsPeriodProvenance: agentsLineage?.reportingPeriod.provenance,
    agentsSourceFreshness: agentsLineage?.sourceFreshness,
    userAgentsVersionId: userAgentsLineage?.versionId,
    userAgentsPeriodProvenance: userAgentsLineage?.reportingPeriod.provenance,
    userAgentsSourceFreshness: userAgentsLineage?.sourceFreshness,
  };
}

function* userExportRows(view: OfficialUsageUserView) {
  const usersLineage = view.lineages.find(lineage => lineage.kind === "users");
  const userAgentsLineage = view.lineages.find(lineage => lineage.kind === "userAgents");
  for (const user of view.users.value) {
    const accessRows = user.rows.length ? user.rows : [{
      agentId: "", displayAgentName: "", creatorType: "", responsesSentToUsers: null,
      lastActivityDateUtc: null, identityStatus: "unresolved" as const,
    }];
    for (const row of accessRows) yield {
      username: user.username,
      displayName: user.displayName,
      userMetricSource: user.missingUserReport ? "users_and_agents_report" : "users_report",
      reportedAgentsUsed: user.missingUserReport ? "Unknown" : user.reportedAgentsUsed,
      reportedResponsesReceived: user.missingUserReport ? "Unknown" : user.reportedResponsesReceived,
      userLastActivityDateUtc: user.userLastActivityDateUtc ?? "Unknown",
      agentId: row.agentId,
      agentName: row.displayAgentName,
      creatorType: row.creatorType,
      creatorTypeSource: "creatorTypeSource" in row ? row.creatorTypeSource : "Unknown",
      responsesSentToUsers: row.responsesSentToUsers ?? "Unknown",
      agentLastUsedByAnyoneDateUtc: row.lastActivityDateUtc ?? "Unknown",
      reportSetId: user.datasetScope.reportSetId,
      reportingStart: view.activeSet?.reportingPeriod.startDate,
      reportingEnd: view.activeSet?.reportingPeriod.endDate,
      usersVersionId: user.datasetScope.usersVersionId,
      usersPeriodProvenance: usersLineage?.reportingPeriod.provenance,
      usersSourceFreshness: usersLineage?.sourceFreshness,
      userAgentsVersionId: user.datasetScope.userAgentsVersionId,
      userAgentsPeriodProvenance: userAgentsLineage?.reportingPeriod.provenance,
      userAgentsSourceFreshness: userAgentsLineage?.sourceFreshness,
      identityStatus: row.identityStatus,
    };
  }
}

async function sendOfficialCsv(
  request: Request,
  response: Response,
  input: {
    role: AppRole;
    action: ReportExportAction;
    filename: string;
    load: () => Promise<{
      columns: readonly string[];
      rows: Iterable<Record<string, unknown>>;
      metadata: Record<string, unknown>;
      validateSource: () => Promise<void>;
    }>;
  },
) {
  const deadlineAt = Date.now() + 15_000;
  const scope = requestScope(request);
  const validatePublication = createExportPublicationValidator(request, input.role);
  const audit = getAuditLog(scope);
  const event = await audit.startEvent({
    operationId: `${input.action}:${randomUUID()}`, scope: "bulk", action: input.action,
    agentId: "official-usage", actor: request.session.user!, requestPath: request.path,
    metadata: { source: "official_usage" },
  });
  try {
    await validatePublication();
    const loaded = await input.load();
    const csv = buildBoundedCsv(loaded.columns, loaded.rows, {
      maximumRows: 100_000, maximumBytes: 8_000_000, deadlineAt,
    });
    await publishBoundedCsv(request, response, input.filename, csv.buffer, {
      deadlineAt, validate: async () => {
        await validatePublication();
        await loaded.validateSource();
      },
      beforeEnd: () => audit.completeEvent(event.id, { status: "succeeded", metadata: {
        ...loaded.metadata, resultingCount: csv.rowCount, resultingBytes: csv.byteCount,
      } }).then(() => undefined),
    });
  } catch (error) {
    await audit.completeEvent(event.id, {
      status: "failed", errorCode: error instanceof AppError ? error.code : "official_usage_export_failed",
    });
    if (response.headersSent) {
      if (!response.destroyed) response.destroy();
      return;
    }
    throw error;
  }
}

function officialDatasetKey(published: Awaited<ReturnType<OfficialUsageRepository["getPublished"]>>) {
  return JSON.stringify([
    published.activeRevision,
    published.activeSet?.id ?? null,
    published.reports.agents?.lineage.versionId ?? null,
    published.reports.userAgents?.lineage.versionId ?? null,
    published.reports.users?.lineage.versionId ?? null,
  ]);
}
