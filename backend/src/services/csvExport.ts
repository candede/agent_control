import type { Request, Response } from "express";
import type pg from "pg";
import { assertAccountSessionValidation, assertCurrentStoredSession, beginAccountSessionValidation, commitAccountSessionValidation, getValidatedSessionIdentity } from "../db/sessions.js";
import { pool } from "../db/pool.js";
import { AppError } from "../errors.js";
import { hasAppRole, type AppRole } from "../types/capability.js";

export function createExportPublicationValidator(request: Request, requiredRole: AppRole, database: pg.Pool = pool) {
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
  const validateStoredSession = () => commitAccountSessionValidation(validation, async () => {
    assertCurrent();
    await assertCurrentStoredSession(database, sessionId, tenantId, principalId, requiredRole);
    assertCurrent();
  });
  return async (validateSource?: () => Promise<void>) => {
    await validateStoredSession();
    assertCurrent();
    // Source reads must not hold the account lock needed by logout.
    if (validateSource) {
      await validateSource();
      assertCurrent();
      await validateStoredSession();
    }
    assertCurrent();
    return assertCurrent;
  };
}

export async function publishBoundedCsv(
  request: Request,
  response: Response,
  filename: string,
  csv: Buffer,
  options: { deadlineAt: number; validate: () => Promise<void | (() => void)>; beforeEnd?: () => Promise<void>; chunkBytes?: number },
) {
  if (!/^[a-z0-9][a-z0-9.-]{0,126}\.csv$/i.test(filename) || filename.includes("..")) {
    throw new AppError(500, "invalid_export_filename", "The export filename is invalid.");
  }
  const chunkBytes = Math.min(Math.max(options.chunkBytes ?? 64 * 1024, 1024), 256 * 1024);
  const cancellation = new AbortController();
  const { signal } = cancellation;
  const terminatePartialResponse = () => {
    if (response.headersSent && !response.destroyed && !response.writableFinished) response.destroy();
  };
  signal.addEventListener("abort", terminatePartialResponse, { once: true });
  const deadline = setTimeout(() => cancellation.abort(publicationError(false)), Math.max(0, options.deadlineAt - Date.now()));
  const disconnect = () => {
    if (!response.writableFinished) cancellation.abort(publicationError(true));
  };
  const transportFailed = (error: Error) => cancellation.abort(error);
  request.once("aborted", disconnect);
  response.once("close", disconnect);
  response.once("error", transportFailed);
  let headersInstalled = false;
  try {
    const assertActive = (ended = false) => {
      // A ready promise or synchronous write can finish before an overdue timer runs.
      if (Date.now() >= options.deadlineAt) cancellation.abort(publicationError(false));
      if (!ended && (request.aborted || response.destroyed || response.writableEnded)) cancellation.abort(publicationError(true));
      signal.throwIfAborted();
    };
    const validate = async () => {
      assertActive();
      const assertCurrent = await abortableRead(options.validate(), signal);
      assertActive();
      return assertCurrent;
    };
    await validate();
    for (let offset = 0; offset === 0 || offset < csv.byteLength; offset += chunkBytes) {
      let assertCurrent = await validate();
      const finalChunk = offset + chunkBytes >= csv.byteLength;
      if (finalChunk && options.beforeEnd) {
        // Let durable audit settle before recording a failed outcome; never race two writes.
        await options.beforeEnd();
        assertCurrent = await validate();
      }
      assertActive();
      // Promise continuations can revoke authority after the asynchronous reads settle.
      if (assertCurrent) assertCurrent();
      if (offset === 0) {
        headersInstalled = true;
        response.setHeader("Content-Type", "text/csv; charset=utf-8");
        response.setHeader("Content-Disposition", `attachment; filename=${filename}`);
        response.setHeader("Cache-Control", "private, no-store");
        response.setHeader("Content-Length", String(csv.byteLength));
      }
      // end() flushes the final accepted write; awaiting drain here would leave
      // an unchecked authorization gap after releasing the complete payload.
      const chunk = csv.subarray(offset, Math.min(offset + chunkBytes, csv.byteLength));
      if (chunk.byteLength && !response.write(chunk) && !finalChunk) {
        await waitForDrain(response, signal);
      }
    }
    assertActive();
    await endResponse(response, signal, () => {
      assertActive(true);
      clearTimeout(deadline);
    });
  } catch (error) {
    const failure = signal.aborted ? signal.reason : error;
    terminatePartialResponse();
    if (headersInstalled && !response.headersSent) {
      response.removeHeader("Content-Type");
      response.removeHeader("Content-Disposition");
      response.removeHeader("Content-Length");
    }
    throw failure;
  } finally {
    clearTimeout(deadline);
    request.removeListener("aborted", disconnect);
    response.removeListener("close", disconnect);
    response.removeListener("error", transportFailed);
    signal.removeEventListener("abort", terminatePartialResponse);
  }
}

function publicationError(disconnected: boolean) {
  return disconnected
    ? new AppError(499, "export_disconnected", "The export download disconnected before publication completed.")
    : new AppError(408, "export_deadline", "The export exceeded its publication deadline.");
}

export function abortableRead<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
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
    const closed = () => { cleanup(); reject(signal.aborted ? signal.reason : publicationError(true)); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else if (response.destroyed) closed();
  });
}

function endResponse(response: Response, signal: AbortSignal, onFinished: () => void) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.removeListener("finish", finished);
      response.removeListener("close", closed);
      response.removeListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const finished = () => {
      cleanup();
      try { onFinished(); resolve(); }
      catch (error) { reject(error); }
    };
    const closed = () => {
      if (response.writableFinished) finished();
      else { cleanup(); reject(signal.aborted ? signal.reason : publicationError(true)); }
    };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    response.once("finish", finished);
    response.once("close", closed);
    response.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else {
      try { response.end(); }
      catch (error) { cleanup(); reject(error); }
    }
  });
}
