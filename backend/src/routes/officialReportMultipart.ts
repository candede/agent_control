import type { Request, RequestHandler } from "express";
import multer from "multer";
import { OfficialReportImports, reportUuid, type ReportImportIntent } from "../db/officialReportImports.js";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import type { SelectionIdentity } from "../services/dataSelections.js";
import { officialReportLimits } from "../services/officialReportStream.js";
import { operationalLog } from "../services/telemetry.js";
import type { OfficialUsageMetadata } from "../types/officialReportRecords.js";
import { hasAppRole } from "../types/capability.js";
import { requestUser } from "../middleware/requestAuthentication.js";

type Upload = Awaited<ReturnType<OfficialReportImports["open"]>>;
type UploadState = {
  controller: AbortController; intent: ReportImportIntent; upload?: Upload;
  receiving?: ReturnType<Upload["receive"]>; finishing?: ReturnType<Upload["finish"]>;
  fail?: (error: unknown) => void;
};
const uploading = Symbol("official-report-upload");
type UploadRequest = Request & { [uploading]?: UploadState };

function multipartFailure(error: unknown): unknown {
  if (error instanceof multer.MulterError) {
    return new AppError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, "invalid_multipart", "Multipart file/field limits exceeded.");
  }
  // Busboy exposes malformed wire syntax as ordinary errors, not MulterError.
  if (error instanceof Error && !(error instanceof AppError) && ([
    "Multipart: Boundary not found", "Malformed content type", "Malformed part header", "Unexpected end of form", "Unexpected end of file",
  ].includes(error.message) || error.message.startsWith("Unsupported content type: "))) {
    return new AppError(400, "invalid_multipart", "Malformed multipart upload.");
  }
  return error;
}

function metadata(fields: Record<string, unknown>): OfficialUsageMetadata {
  const allowed = ["reportingStart", "reportingEnd", "periodProvenance", "sourceAsOf", "sourceAsOfProvenance", "downloadedAt"];
  if (Object.keys(fields).some(key => !allowed.includes(key)) || Object.values(fields).some(value =>
    typeof value !== "string" || Buffer.byteLength(value) > officialReportLimits.fieldBytes)) {
    throw new AppError(400, "invalid_metadata", "Unsupported or repeated multipart field.");
  }
  const periodFields = [fields.reportingStart, fields.reportingEnd, fields.periodProvenance].filter(value => value !== undefined).length;
  if (periodFields !== 0 && periodFields !== 3 || periodFields && fields.periodProvenance !== "operator_asserted"
    || (fields.sourceAsOf !== undefined) !== (fields.sourceAsOfProvenance !== undefined)
    || fields.sourceAsOfProvenance !== undefined && fields.sourceAsOfProvenance !== "operator_asserted") {
    throw new AppError(400, "invalid_metadata", "Supply complete operator-asserted provenance.");
  }
  const text = (value: unknown, maximum: number) => {
    if (typeof value !== "string" || !value || value.length > maximum || /[\0\r\n]/.test(value)) {
      throw new AppError(400, "invalid_metadata", "Expected one bounded metadata field.");
    }
    return value;
  };
  return {
    ...(periodFields ? { reportingPeriod: { startDate: text(fields.reportingStart, 10), endDate: text(fields.reportingEnd, 10), provenance: "operator_asserted" as const } } : {}),
    ...(fields.sourceAsOf !== undefined ? { sourceAsOf: { value: text(fields.sourceAsOf, 128), provenance: "operator_asserted" as const } } : {}),
    ...(fields.downloadedAt !== undefined ? { downloadedAt: text(fields.downloadedAt, 128) } : {}),
  };
}

export function officialReportMultipart(imports: (request: Request) => OfficialReportImports, identity: (request: Request) => Promise<SelectionIdentity>): RequestHandler {
  const reservations = new Map<string, number>();
  let active = 0;
  async function cancel(state?: UploadState) {
    try { await state?.upload?.cancel(); }
    catch (error) { operationalLog("error", "official_usage_upload_cleanup_failed"); throw error; }
  }
  const storage: multer.StorageEngine = {
    _handleFile(request: UploadRequest, file, callback) {
      const state = request[uploading]!;
      let streamFailure: unknown;
      file.stream.once("error", error => { streamFailure = error; });
      state.receiving = (async () => {
        const who = await identity(request);
        state.upload = await imports(request).open(who, state.intent, state.controller.signal);
        return state.upload.receive(file.stream);
      })();
      void state.receiving.then(result => callback(null, { size: result.wireBytes }), error => {
        state.fail?.(error === streamFailure ? multipartFailure(error) : error); callback(error);
      });
    },
    _removeFile(request: UploadRequest, _file, callback) {
      void cancel(request[uploading]).then(() => callback(null), callback);
    },
  };
  const parse = multer({ storage, limits: {
    fileSize: officialReportLimits.fileBytes + 1, files: 1, fields: 6, fieldSize: officialReportLimits.fieldBytes,
    fieldNameSize: 64, parts: 8,
  } }).single("file");
  return (request: UploadRequest, response, next) => {
    let intent: ReportImportIntent;
    try {
      if (Object.keys(request.query).some(key => !["bundleId", "correctionOfSetId", "rejectDuplicateKind"].includes(key))) {
        throw new AppError(400, "invalid_usage_query", "Only immutable upload intent is allowed.");
      }
      const duplicate = request.query.rejectDuplicateKind;
      if (duplicate !== undefined && duplicate !== "true" && duplicate !== "false") {
        throw new AppError(400, "invalid_upload_intent", "Duplicate-kind guard must be a boolean.");
      }
      intent = { bundleId: reportUuid(request.query.bundleId), rejectDuplicateKind: duplicate === "true",
        ...(request.query.correctionOfSetId === undefined ? {} : { correctionOfSetId: reportUuid(request.query.correctionOfSetId) }) };
      if (intent.correctionOfSetId && !hasAppRole(requestUser(request).roles, "AgentControl.Admin")) {
        throw new AppError(403, "missing_internal_role", "AgentControl.Admin is required to correct a published report set.");
      }
    } catch (error) { next(error); return; }
    const tenant = requestScope(request).tenantId;
    if (active >= 4 || (reservations.get(tenant) ?? 0) >= 2) {
      next(new AppError(429, "upload_admission_full", "Retry after an active stream finishes.")); return;
    }
    active += 1; reservations.set(tenant, (reservations.get(tenant) ?? 0) + 1);
    const state: UploadState = { controller: new AbortController(), intent };
    request[uploading] = state;
    let completed = false;
    const timer = setTimeout(() => state.controller.abort(new AppError(408, "upload_deadline", "Upload deadline exceeded.")), 30 * 60_000);
    timer.unref();
    const disconnected = () => {
      if (!response.writableFinished) state.controller.abort(new AppError(400, "upload_disconnected", "Upload disconnected."));
    };
    const detach = () => {
      clearTimeout(timer);
      request.removeListener("aborted", disconnected); response.removeListener("close", disconnected);
      state.controller.signal.removeEventListener("abort", aborted);
    };
    const release = () => {
      active -= 1;
      const remaining = reservations.get(tenant)! - 1;
      if (remaining) reservations.set(tenant, remaining); else reservations.delete(tenant);
    };
    const stop = async (failure: unknown) => {
      if (completed) return;
      completed = true; detach(); state.controller.abort(failure);
      // A multipart parser may be waiting for EOF. Report the deadline without
      // releasing its admission slot before pending database work has settled.
      if (!response.destroyed && !response.headersSent) {
        if (!request.complete) {
          response.setHeader("Connection", "close");
          response.once("finish", () => request.destroy());
        }
        next(failure);
      }
      try {
        await state.receiving?.catch(() => undefined);
        await state.finishing?.catch(() => undefined);
        await cancel(state);
      } catch { /* cancel emits the managed cleanup-failure event */ }
      finally { release(); }
    };
    const aborted = () => { void stop(state.controller.signal.reason); };
    request.once("aborted", disconnected); response.once("close", disconnected);
    state.controller.signal.addEventListener("abort", aborted, { once: true });
    state.fail = failure => { void stop(failure); };
    parse(request, response, error => {
      if (completed) return;
      void (async () => {
        try {
          if (error) throw multipartFailure(error);
          if (!request.file || !state.upload) throw new AppError(400, "missing_report", "Select exactly one CSV file.");
          state.finishing = state.upload.finish(metadata(request.body));
          const preview = await state.finishing;
          state.controller.signal.throwIfAborted();
          completed = true; detach(); release();
          response.status(201).json(preview);
        } catch (failure) { await stop(failure); }
      })();
    });
  };
}
