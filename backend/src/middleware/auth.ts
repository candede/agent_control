import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { AppError } from "../errors.js";
import { revalidateAuthenticatedUser } from "../auth/msal.js";
import { beginAccountSessionValidation, commitAccountSessionValidation, getValidatedSessionIdentity } from "../db/sessions.js";
import { capabilities } from "../services/capabilities.js";
import { hasAppRole, type AppRole, type CapabilityId } from "../types/capability.js";

export const roleRevalidationIntervalMs = 5 * 60 * 1000;

export const requireSession: RequestHandler = async (request, _response, next) => {
  const identity = getValidatedSessionIdentity(request.session);
  if (!identity) {
    request.session.destroy(error => next(error ?? AppError.unauthorized()));
    return;
  }

  try {
    const validatedAt = request.session.rolesValidatedAt;
    if (typeof validatedAt !== "number" || !Number.isFinite(validatedAt) || validatedAt > Date.now() || Date.now() - validatedAt >= roleRevalidationIntervalMs) {
      const validation = beginAccountSessionValidation(identity.tenantId, identity.accountId);
      const user = await revalidateAuthenticatedUser(identity.tenantId, identity.accountId);
      await commitAccountSessionValidation(validation, async () => {
        await reloadSession(request);
        const current = getValidatedSessionIdentity(request.session);
        if (!current || current.tenantId !== identity.tenantId || current.accountId !== identity.accountId || current.clientId !== identity.clientId
          || user.tenantId !== identity.tenantId || user.homeAccountId !== identity.accountId) {
          throw AppError.unauthorized("Microsoft Entra ID returned a different signed-in account.");
        }
        request.session.user = user;
        request.session.rolesValidatedAt = Date.now();
        if (current.user.roles.join("\0") !== user.roles.join("\0") || (current.user.providerRoleIds ?? []).join("\0") !== (user.providerRoleIds ?? []).join("\0")) await capabilities.invalidatePrincipal(user);
        await saveSession(request);
      });
    }
    next();
  } catch (error) {
    request.session.destroy(destroyError => next(destroyError ?? error));
  }
};

function reloadSession(request: Request) {
  return new Promise<void>((resolve, reject) => request.session.reload(error => error ? reject(AppError.unauthorized("The session was revoked.")) : resolve()));
}

function saveSession(request: Request) {
  return new Promise<void>((resolve, reject) => request.session.save(error => error ? reject(error) : resolve()));
}

export function requireRoles(...roles: AppRole[]): RequestHandler {
  return (request, _response, next) => {
    if (!request.session.user || !roles.some(role => hasAppRole(request.session.user!.roles, role))) {
      next(new AppError(403, "missing_internal_role", "The required Agent Control app role is not assigned."));
      return;
    }
    next();
  };
}

export function requireCapability(capabilityId: CapabilityId): RequestHandler {
  return async (request, _response, next) => {
    try {
      if (!request.session.user) throw AppError.unauthorized();
      await capabilities.requireAvailable(capabilityId, request.session.user);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const requireCsrf: RequestHandler = (request, _response, next) => {
  const supplied = request.get("x-csrf-token");
  const expected = request.session.csrfToken;
  const left = Buffer.from(supplied ?? "");
  const right = Buffer.from(expected ?? "");
  if (!supplied || !expected || left.length !== right.length || !timingSafeEqual(left, right)) {
    next(new AppError(403, "invalid_csrf", "A valid CSRF token is required."));
    return;
  }
  next();
};

export function requestScope(request: Request) {
  const identity = getValidatedSessionIdentity(request.session);
  if (!identity) throw AppError.unauthorized();
  return { tenantId: identity.tenantId, principalId: identity.accountId };
}
