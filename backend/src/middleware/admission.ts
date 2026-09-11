import type { RequestHandler } from "express";
import { AppError } from "../errors.js";

const windowMilliseconds = 60_000;
const maximumEntries = 10_000;
const entries = new Map<string, { startedAt: number; count: number }>();

export const apiAdmission: RequestHandler = (request, response, next) => {
  if (["/health", "/ready", "/auth/status"].includes(request.path)) {
    next();
    return;
  }
  const now = Date.now();
  const operation = ["GET", "HEAD", "OPTIONS"].includes(request.method) ? "read" : "write";
  const principal = request.session?.accountId;
  try {
    admit(`ip:${request.ip}:${operation}`, operation === "read" ? 1_200 : 300, now, response);
    if (principal) admit(`principal:${principal}:${operation}`, operation === "read" ? 600 : 200, now, response);
    next();
  } catch (error) {
    next(error);
  }
};

function admit(key: string, maximum: number, now: number, response: Parameters<RequestHandler>[1]) {
  let entry = entries.get(key);
  if (!entry || now - entry.startedAt >= windowMilliseconds) {
    if (entries.size >= maximumEntries) prune(now);
    if (entries.size >= maximumEntries) entries.delete(entries.keys().next().value!);
    entry = { startedAt: now, count: 0 };
    entries.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > maximum) {
    response.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.startedAt + windowMilliseconds - now) / 1000))));
    throw new AppError(429, "request_admission_limit", "The bounded request rate was exceeded; retry later.");
  }
}

function prune(now: number) {
  for (const [key, entry] of entries) if (now - entry.startedAt >= windowMilliseconds) entries.delete(key);
}

export function clearAdmissionForTest() {
  if (process.env.NODE_ENV !== "test") throw new Error("Admission reset is available only in tests.");
  entries.clear();
}
