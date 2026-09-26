import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import { config, resolveTenantForUsername } from "../config.js";
import { pool } from "../db/pool.js";
import { activateAccountSession, getValidatedSessionIdentity, revokeAccountSessionMutations, revokeAccountSessions } from "../db/sessions.js";
import { AppError } from "../errors.js";
import { adminManagedPermissionsError, adminManagedPermissionsMessage, assertLoginAuthFlow, consumeAuthFlow, storeAuthFlow } from "../auth/flows.js";
import {
  createAuthFlow,
  createAuthorizationUrl,
  evictAccount,
  redeemAuthorizationCode,
  safeReturnPath,
  toAuthenticatedUser,
} from "../auth/msal.js";
import { capabilities } from "../services/capabilities.js";
import { pauseCopilotStudioQuarantineForPrincipal } from "../services/copilotStudioQuarantineJobs.js";
import { defenderHunting } from "../services/defenderHunting.js";
import { dataSync } from "../services/dataSync.js";
import { pauseBulkJobsForPrincipal } from "../services/bulkJobs.js";
import { packageInventory } from "../services/packageInventory.js";
import { powerPlatformInventory } from "../services/powerPlatformInventory.js";
import { purviewAudit } from "../services/purviewAudit.js";
import { policyRoute } from "./policy.js";
import type { AuthenticatedUser } from "../types/session.js";
export const authRouter = Router();

policyRoute(authRouter, "post", "/auth/login", { access: "public", dataClass: "identity" }, async (request, response, next) => {
  try {
    const { username, tenant } = resolveTenantForUsername(request.body?.username);
    const returnTo = safeReturnPath(request.body?.returnTo);
    response.json({ authorizationUrl: await startLogin(request, tenant.tenantId, username, returnTo) });
  } catch (error) {
    next(error);
  }
});

policyRoute(authRouter, "get", "/auth/login", { access: "public", dataClass: "identity" }, async (request, response, next) => {
  try {
    const returnTo = safeReturnPath(firstQueryValue(request.query.returnTo));
    const identity = getValidatedSessionIdentity(request.session);
    if (identity) {
      response.redirect(await startLogin(request, identity.tenantId, identity.user.username, returnTo));
      return;
    }
    if (request.query.username !== undefined) {
      const { username, tenant } = resolveTenantForUsername(request.query.username);
      response.redirect(await startLogin(request, tenant.tenantId, username, returnTo));
      return;
    }
    if (request.session.user || request.session.accountId || request.session.tenantId || request.session.clientId) {
      await new Promise<void>((resolve, reject) => request.session.destroy(error => error ? reject(error) : resolve()));
    }
    response.redirect(returnTo);
  } catch (error) {
    next(error);
  }
});

policyRoute(authRouter, "post", "/auth/consent", { access: "authenticated", dataClass: "identity", roles: ["AgentControl.Viewer"], csrf: true }, (_request, _response, next) => {
  next(adminManagedPermissionsError());
});

policyRoute(authRouter, "get", "/auth/callback", { access: "public", dataClass: "identity" }, async (request, response, next) => {
  try {
    const {
      code,
      state,
      error,
    } = request.query;

    let flow: ReturnType<typeof createAuthFlow> | undefined;
    let flowError: unknown;
    try { flow = consumeAuthFlow(request.sessionID, request.session.authFlowHandle, typeof state === "string" ? state : undefined); }
    catch (caught) { flowError = caught; }
    delete request.session.authFlowHandle;
    await saveSession(request);
    if (flowError) throw flowError;
    if (!flow) throw new AppError(400, "invalid_auth_state", "The sign-in state did not match this session.");
    if (typeof error === "string") {
      if (error === "consent_required") throw new AppError(403, "missing_permission", adminManagedPermissionsMessage);
      const outcome = error === "access_denied" ? "cancelled" : ["interaction_required", "login_required"].includes(error) ? "interaction_required" : "failed";
      const target = new URL(flow.returnTo, config.frontendOrigin);
      target.searchParams.set("view", "permissions");
      target.searchParams.set("authorization", outcome);
      response.redirect(`${target.pathname}${target.search}${target.hash}`);
      return;
    }
    if (typeof code !== "string") throw new AppError(400, "invalid_auth_callback", "The sign-in callback was missing code.");
    const previous = getValidatedSessionIdentity(request.session);
    const result = await redeemAuthorizationCode(code, flow);
    const user = toAuthenticatedUser(result);
    if (user.tenantId !== flow.tenantId) throw AppError.unauthorized("Microsoft Entra ID returned an account for a different tenant.");

    if (previous && (previous.accountId !== user.homeAccountId || previous.tenantId !== flow.tenantId)) {
      await revokePrincipalAuthorization(previous.tenantId, previous.accountId, previous.user);
    }
    await capabilities.invalidatePrincipal(user);
    await activateAccountSession(user.tenantId!, user.homeAccountId, async () => {
      assertLoginAuthFlow(flow);
      await regenerateSession(request);
      assertLoginAuthFlow(flow);
      request.session.accountId = user.homeAccountId;
      request.session.tenantId = user.tenantId;
      request.session.clientId = flow.clientId;
      request.session.user = user;
      request.session.csrfToken = randomBytes(32).toString("base64url");
      request.session.rolesValidatedAt = Date.now();
      request.session.signedInAt = Date.now();
      await saveSession(request);
    });

    response.redirect(flow.returnTo);
  } catch (error) {
    next(error);
  }
});

policyRoute(authRouter, "post", "/auth/logout", { access: "authenticated", dataClass: "identity", csrf: true }, async (request, response, next) => {
  try {
    const identity = getValidatedSessionIdentity(request.session);
    if (!identity) throw AppError.unauthorized();
    await revokePrincipalAuthorization(identity.tenantId, identity.accountId, identity.user);
    response.clearCookie("agent-control.sid");
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

async function startLogin(request: Request, tenantId: string, username: string, returnTo: string) {
  const flow = createAuthFlow("login", { tenantId, username, returnTo });
  const authorizationUrl = await createAuthorizationUrl(flow);
  request.session.authFlowHandle = storeAuthFlow(request.sessionID, request.session.authFlowHandle, flow);
  await saveSession(request);
  return authorizationUrl;
}

async function revokePrincipalAuthorization(tenantId: string, accountId: string, user: AuthenticatedUser) {
  const scope = { tenantId, principalId: accountId };
  const cleanup = await revokeAccountSessionMutations(tenantId, accountId, () => Promise.allSettled([
    evictAccount(tenantId, accountId),
    pauseBulkJobsForPrincipal(scope),
    pauseCopilotStudioQuarantineForPrincipal(scope),
    packageInventory.waitForPrincipalAuthorization(scope),
    powerPlatformInventory.waitForPrincipalAuthorization(scope),
    purviewAudit.waitForPrincipalAuthorization(scope),
    defenderHunting.waitForPrincipalAuthorization(scope),
    capabilities.invalidatePrincipal(user),
    revokeAccountSessions(pool, tenantId, accountId),
  ]));
  // Coordinator operations can await session validation; release the account mutation lock first.
  const coordinatorCleanup = await Promise.allSettled([dataSync.waitForPrincipalAuthorization(scope)]);
  const failure = [...cleanup, ...coordinatorCleanup].find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

policyRoute(authRouter, "get", "/me", { access: "authenticated", dataClass: "identity" }, (request, response) => {
  response.json({ user: request.session.user, csrfToken: request.session.csrfToken, roleAssignmentRequired: request.session.user!.roles.length === 0 });
});

function regenerateSession(request: Request) {
  return new Promise<void>((resolve, reject) => {
    request.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function saveSession(request: Request) {
  return new Promise<void>((resolve, reject) => request.session.save(error => error ? reject(error) : resolve()));
}

function firstQueryValue(value: unknown) {
  return Array.isArray(value) ? typeof value[0] === "string" ? value[0] : undefined : typeof value === "string" ? value : undefined;
}
