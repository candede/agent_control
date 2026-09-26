import type { Request, Response } from "express";
import { assertAccountSessionValidation, assertCurrentStoredSession, beginAccountSessionValidation, commitAccountSessionValidation, getValidatedSessionIdentity } from "../db/sessions.js";
import { pool } from "../db/pool.js";
import { AppError } from "../errors.js";
import { hasAppRole, type AppRole } from "../types/capability.js";

export type CsvExportBudget = {
  maximumRows: number;
  maximumBytes: number;
  deadlineAt: number;
};

export function createExportPublicationValidator(request: Request, requiredRole: AppRole) {
  const identity = getValidatedSessionIdentity(request.session);
  const sessionId = request.sessionID;
  if (!identity || !hasAppRole(identity.user.roles, requiredRole)) {
    throw AppError.unauthorized("The export requires a current authorized session.");
  }
  const { tenantId, accountId: principalId, clientId } = identity;
  const validation = beginAccountSessionValidation(tenantId, principalId);
  const assertCurrent = () => {
    assertAccountSessionValidation(validation);
    const current = getValidatedSessionIdentity(request.session);
    if (request.sessionID !== sessionId || !current || current.accountId !== principalId || current.tenantId !== tenantId
      || current.clientId !== clientId || !hasAppRole(current.user.roles, requiredRole)) {
      throw AppError.unauthorized("The export session or required role is no longer current.");
    }
  };
  return async (validateSource?: () => Promise<void>) => {
    await commitAccountSessionValidation(validation, async () => {
      assertCurrent();
      await assertCurrentStoredSession(pool, sessionId, tenantId, principalId, requiredRole);
      assertCurrent();
    });
    assertCurrent();
    // Source reads must not hold the account lock needed by logout.
    await validateSource?.();
    assertCurrent();
  };
}

export function buildBoundedCsv(
  columns: readonly string[],
  rows: Iterable<Record<string, unknown>>,
  budget: CsvExportBudget,
) {
  if (!columns.length || columns.some(column => !/^[A-Za-z][A-Za-z0-9]*$/.test(column))) {
    throw new AppError(500, "invalid_export_schema", "The export schema is invalid.");
  }
  const chunks = [Buffer.from(`\uFEFF${columns.join(",")}\r\n`, "utf8")];
  let byteCount = chunks[0].byteLength;
  let rowCount = 0;
  if (Date.now() >= budget.deadlineAt) throw publicationError(false);
  if (byteCount > budget.maximumBytes) throw new AppError(413, "export_byte_limit", "The export header exceeds its byte limit.");
  for (const row of rows) {
    if (Date.now() >= budget.deadlineAt) throw new AppError(408, "export_deadline", "The export exceeded its processing deadline.");
    rowCount += 1;
    if (rowCount > budget.maximumRows) throw new AppError(413, "export_row_limit", `The export exceeds the ${budget.maximumRows.toLocaleString("en-US")} row limit.`);
    const cells: string[] = [];
    byteCount += columns.length - 1 + 2;
    if (byteCount > budget.maximumBytes) throw new AppError(413, "export_byte_limit", `The export exceeds the ${budget.maximumBytes.toLocaleString("en-US")} byte limit.`);
    for (const column of columns) {
      const cell = csvValue(row[column]);
      if (Date.now() >= budget.deadlineAt) throw new AppError(408, "export_deadline", "The export exceeded its processing deadline.");
      byteCount += Buffer.byteLength(cell, "utf8");
      if (byteCount > budget.maximumBytes) throw new AppError(413, "export_byte_limit", `The export exceeds the ${budget.maximumBytes.toLocaleString("en-US")} byte limit.`);
      cells.push(cell);
    }
    const chunk = Buffer.from(`${cells.join(",")}\r\n`, "utf8");
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks, byteCount);
  if (Date.now() >= budget.deadlineAt) throw new AppError(408, "export_deadline", "The export exceeded its processing deadline.");
  return { buffer, rowCount, byteCount };
}

export async function publishBoundedCsv(
  request: Request,
  response: Response,
  filename: string,
  csv: Buffer,
  options: { deadlineAt: number; validate: () => Promise<void>; beforeEnd?: () => Promise<void>; chunkBytes?: number },
) {
  if (!/^[a-z0-9][a-z0-9.-]{0,126}\.csv$/i.test(filename) || filename.includes("..")) {
    throw new AppError(500, "invalid_export_filename", "The export filename is invalid.");
  }
  const chunkBytes = Math.min(Math.max(options.chunkBytes ?? 64 * 1024, 1024), 256 * 1024);
  const cancellation = new AbortController();
  const { signal } = cancellation;
  const deadline = setTimeout(() => cancellation.abort(publicationError(false)), Math.max(0, options.deadlineAt - Date.now()));
  const disconnect = () => {
    if (!response.writableFinished) cancellation.abort(publicationError(true));
  };
  request.once("aborted", disconnect);
  response.once("close", disconnect);
  response.once("error", disconnect);
  try {
    if (request.aborted || response.destroyed) disconnect();
    const assertActive = () => {
      // A ready promise or synchronous write can finish before an overdue timer runs.
      if (Date.now() >= options.deadlineAt) cancellation.abort(publicationError(false));
      signal.throwIfAborted();
    };
    const validate = async () => {
      assertActive();
      await abortableRead(options.validate(), signal);
      assertActive();
    };
    await validate();
    for (let offset = 0; offset < csv.byteLength; offset += chunkBytes) {
      await validate();
      if (offset + chunkBytes >= csv.byteLength) {
        // Let durable audit settle before recording a failed outcome; never race two writes.
        await options.beforeEnd?.();
        if (options.beforeEnd) await validate();
      }
      assertActive();
      if (offset === 0) {
        response.setHeader("Content-Type", "text/csv; charset=utf-8");
        response.setHeader("Content-Disposition", `attachment; filename=${filename}`);
        response.setHeader("Cache-Control", "private, no-store");
        response.setHeader("Content-Length", String(csv.byteLength));
      }
      if (!response.write(csv.subarray(offset, Math.min(offset + chunkBytes, csv.byteLength)))) {
        await waitForDrain(response, signal);
      }
    }
    assertActive();
    await endResponse(response, signal);
    assertActive();
  } finally {
    clearTimeout(deadline);
    request.removeListener("aborted", disconnect);
    response.removeListener("close", disconnect);
    response.removeListener("error", disconnect);
  }
}

export function csvValue(value: unknown) {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : String(value);
  if (!text) return "";
  const safe = /^[=+\-@\t\r\u2212]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function publicationError(disconnected: boolean) {
  return disconnected
    ? new AppError(499, "export_disconnected", "The export download disconnected before publication completed.")
    : new AppError(408, "export_deadline", "The export exceeded its publication deadline.");
}

function abortableRead<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    operation.then(value => { signal.removeEventListener("abort", aborted); resolve(value); },
      error => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}

function waitForDrain(response: Response, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.removeListener("drain", drained);
      response.removeListener("close", closed);
      response.removeListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(publicationError(true)); };
    const failed = () => { cleanup(); reject(publicationError(true)); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else if (response.destroyed) closed();
  });
}

function endResponse(response: Response, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.removeListener("finish", finished);
      response.removeListener("close", closed);
      response.removeListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const finished = () => { cleanup(); resolve(); };
    const closed = () => {
      if (response.writableFinished) finished();
      else { cleanup(); reject(publicationError(true)); }
    };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    response.once("finish", finished);
    response.once("close", closed);
    response.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else response.end();
  });
}
