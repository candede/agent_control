import type { RequestHandler, Router } from "express";
import { requireCapability, requireCsrf, requireRoles, requireSession } from "../middleware/auth.js";
import type { AppRole, CapabilityId } from "../types/capability.js";
import { operationalLog, withTelemetryContext } from "../services/telemetry.js";
import { bindRequestAuthority } from "../middleware/requestAuthentication.js";
import { AppError } from "../errors.js";

export type RoutePolicy =
  | { access: "public"; dataClass: "public" | "identity" }
  | { access: "authenticated"; dataClass: string; roles?: AppRole[]; capabilityId?: CapabilityId; csrf?: boolean; browserOnly?: boolean };

export type RouteMethod = "get" | "post" | "put" | "patch" | "delete";
export const declaredRoutePolicies = new Map<string, RoutePolicy>();

export function policyRoute(router: Router, method: RouteMethod, path: string, policy: RoutePolicy, ...handlers: RequestHandler[]) {
  const key = `${method.toUpperCase()} ${path}`;
  const previous = declaredRoutePolicies.get(key);
  if (previous && JSON.stringify(previous) !== JSON.stringify(policy)) throw new Error(`Conflicting route policy: ${key}`);
  declaredRoutePolicies.set(key, policy);
  const middleware: RequestHandler[] = [(_request, _response, next) => withTelemetryContext({ route: path }, () => {
    if (method !== "get") operationalLog("info", "http_request_started", { mode: method.toUpperCase() });
    next();
  })];
  if (policy.access === "public") middleware.push((request, _response, next) =>
    request.authentication ? next(new AppError(403, "browser_only_operation", "This endpoint does not accept bearer authentication.")) : next());
  if (policy.access === "authenticated") {
    if (policy.browserOnly) middleware.push((request, _response, next) =>
      request.authentication?.principal.transport === "bearer"
        ? next(new AppError(403, "browser_only_operation", "This operation requires browser authentication.")) : next());
    middleware.push(requireSession);
    middleware.push(bindRequestAuthority);
    if (policy.roles?.length) middleware.push(requireRoles(...policy.roles));
    if (policy.csrf) middleware.push(requireCsrf);
    if (policy.capabilityId) middleware.push(requireCapability(policy.capabilityId));
  }
  const stack = [...middleware, ...handlers];
  if (method === "get") router.get(path, ...stack);
  else if (method === "post") router.post(path, ...stack);
  else if (method === "put") router.put(path, ...stack);
  else if (method === "patch") router.patch(path, ...stack);
  else router.delete(path, ...stack);
}