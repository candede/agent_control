import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors.js";
import type { AuthFlow } from "../types/session.js";

export const authFlowLifetimeMs = 10 * 60 * 1000;
const maximumAuthFlows = 10_000;
type StoredFlow = { sessionId: string; flow: AuthFlow };
const authFlows = new Map<string, StoredFlow>();

export function storeAuthFlow(sessionId: string, previousHandle: string | undefined, flow: AuthFlow, now = Date.now()) {
  if (previousHandle) authFlows.delete(previousHandle);
  pruneAuthFlows(now);
  while (authFlows.size >= maximumAuthFlows) authFlows.delete(authFlows.keys().next().value!);
  let handle: string;
  do { handle = randomBytes(32).toString("base64url"); } while (authFlows.has(handle));
  authFlows.set(handle, { sessionId, flow });
  return handle;
}

export function consumeAuthFlow(sessionId: string, handle: string | undefined, state: string | undefined, now = Date.now()) {
  const stored = handle ? authFlows.get(handle) : undefined;
  if (handle) authFlows.delete(handle);
  if (!stored || stored.sessionId !== sessionId) throw new AppError(400, "invalid_auth_state", "The sign-in state did not match this session.");
  if (now - stored.flow.createdAt > authFlowLifetimeMs) throw new AppError(400, "expired_auth_state", "The authentication request expired. Start again.");
  if (!state || !matches(stored.flow.state, state)) throw new AppError(400, "invalid_auth_state", "The sign-in state did not match this session.");
  return stored.flow;
}

export function clearAuthFlowsForTest() {
  if (process.env.NODE_ENV !== "test") throw new Error("Auth flow reset is unavailable outside tests.");
  authFlows.clear();
}

function pruneAuthFlows(now: number) {
  for (const [handle, stored] of authFlows) if (now - stored.flow.createdAt > authFlowLifetimeMs) authFlows.delete(handle);
}

function matches(expected: string, actual: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}