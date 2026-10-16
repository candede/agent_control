import type { Request, RequestHandler } from "express";
import type pg from "pg";
import { AppError } from "../errors.js";
import { McpBearerVerifier } from "../auth/mcpBearer.js";
import { createBearerCredentials, createBrowserCredentials } from "../auth/delegatedCredentials.js";
import { browserRequestPrincipal, principalEpochAuthority } from "../auth/requestPrincipal.js";
import { getMsalClient } from "../auth/msal.js";
import { authorityUser, withAuthority } from "../auth/authorityContext.js";
import { getValidatedSessionIdentity } from "../db/sessions.js";
import type { DelegatedCredentialSource } from "../types/requestPrincipal.js";
import type { AuthenticatedUser } from "../types/session.js";
import { deriveActionOrigin, mcpContextHeader, withActionOrigin } from "../services/actionOrigin.js";

declare global {
  namespace Express {
    interface Request {
      authentication?: DelegatedCredentialSource;
      bindBrowserAuthority?: RequestHandler;
    }
  }
}

export function requestAuthentication(database: pg.Pool, fetcher: typeof fetch = fetch): RequestHandler {
  const verifier = new McpBearerVerifier(fetcher);
  const epochs = principalEpochAuthority(database);
  return async (request, response, next) => {
    try {
      const header = request.get("authorization");
      if (header !== undefined && /(?:^|;)\s*agent-control\.sid\s*=/.test(request.get("cookie") ?? "")) {
        throw new AppError(400, "ambiguous_authentication", "Cookie and bearer authentication cannot be combined.");
      }
      if (header !== undefined) {
        if (!/^Bearer [^\s,]+$/i.test(header) || request.rawHeaders.filter(value => value.toLowerCase() === "authorization").length !== 1) {
          throw AppError.unauthorized("Use one delegated bearer credential.");
        }
        const controller = new AbortController();
        const aborted = () => controller.abort();
        const disconnected = () => { if (!response.writableEnded) controller.abort(); };
        request.once("aborted", aborted);
        response.once("close", disconnected);
        try {
          request.authentication = await createBearerCredentials(await verifier.verify(header.slice(7), controller.signal),
            epochs, { signal: controller.signal, fetcher });
        } finally {
          request.removeListener("aborted", aborted);
          response.removeListener("close", disconnected);
        }
        const origin = deriveActionOrigin(request.authentication.principal, response.locals.requestId, contextHeader(request));
        withAuthority(request.authentication, () => withActionOrigin(origin, next));
        return;
      }
      request.bindBrowserAuthority = async (browserRequest, browserResponse, browserNext) => {
        try {
          const identity = getValidatedSessionIdentity(browserRequest.session);
          if (!identity) throw AppError.unauthorized();
          const account = await getMsalClient(identity.tenantId).getTokenCache().getAccountByHomeId(identity.accountId);
          const principal = await browserRequestPrincipal(browserRequest.session, account, epochs);
          browserRequest.authentication = createBrowserCredentials(principal, epochs);
          const origin = deriveActionOrigin(principal, browserResponse.locals.requestId, contextHeader(browserRequest));
          withAuthority(browserRequest.authentication, () => withActionOrigin(origin, browserNext));
        } catch (error) { browserNext(error); }
      };
      next();
    } catch (error) { next(error); }
  };
}

export const bindRequestAuthority: RequestHandler = (request, response, next) => {
  if (request.authentication) {
    const origin = deriveActionOrigin(request.authentication.principal, response.locals.requestId, contextHeader(request));
    withAuthority(request.authentication, () => withActionOrigin(origin, next)); return;
  }
  if (request.bindBrowserAuthority) { void request.bindBrowserAuthority(request, response, next); return; }
  next();
};

function contextHeader(request: Request) {
  const matches = request.rawHeaders.filter(value => value.toLowerCase() === mcpContextHeader.toLowerCase()).length;
  if (matches > 1) throw new AppError(400, "invalid_action_origin", "Use one bounded action attribution header.");
  return request.get(mcpContextHeader);
}

export function requestUser(request: Request): AuthenticatedUser {
  if (request.authentication) return authorityUser(request.authentication);
  // Standalone browser routers still use the validated browser adapter.
  if (request.headers?.authorization) throw AppError.unauthorized();
  const identity = getValidatedSessionIdentity(request.session);
  if (!identity) throw AppError.unauthorized();
  return identity.user;
}

export function requestAuthenticatedAt(request: Request) {
  return request.authentication?.principal.authenticatedAt ?? request.session.signedInAt;
}
