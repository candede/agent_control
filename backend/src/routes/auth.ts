import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { activateAccountSession, beginAccountSessionValidation, commitAccountSessionValidation, revokeAccountSessionMutations, revokeAccountSessions } from "../db/sessions.js";
import { AppError } from "../errors.js";
import { consumeAuthFlow, storeAuthFlow } from "../auth/flows.js";
import {
  createAuthFlow,
  createAuthorizationUrl,
  evictAccount,
  redeemAuthorizationCode,
  toAuthenticatedUser,
} from "../auth/msal.js";
import { getCapabilityDefinition, hasAnyRole } from "../services/capabilityRegistry.js";
import { capabilities } from "../services/capabilities.js";
import { pauseCopilotStudioQuarantineForPrincipal } from "../services/copilotStudioQuarantineJobs.js";
import { defenderHunting } from "../services/defenderHunting.js";
import { pauseBulkJobsForPrincipal } from "../services/bulkJobs.js";
import { packageInventory } from "../services/packageInventory.js";
import { powerPlatformInventory } from "../services/powerPlatformInventory.js";
import { purviewAudit } from "../services/purviewAudit.js";
import { policyRoute } from "./policy.js";
export const authRouter = Router();

policyRoute(authRouter, "get", "/auth/login", { access: "public", dataClass: "identity" }, async (request, response, next) => {
  try {
    const setup = firstQueryValue(request.query.setup);
    if (setup !== undefined && setup !== "defer") throw new AppError(400, "invalid_auth_setup", "Provider setup may only be explicitly deferred.");
    const flow = createAuthFlow("login", { returnTo: firstQueryValue(request.query.returnTo), providerConsent: setup !== "defer" });
    request.session.authFlowHandle = storeAuthFlow(request.sessionID, request.session.authFlowHandle, flow);
    await saveSession(request);
    const loginUrl = await createAuthorizationUrl(flow);
    response.redirect(loginUrl);
  } catch (error) {
    next(error);
  }
});

policyRoute(authRouter, "post", "/auth/consent", { access: "authenticated", dataClass: "identity", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response, next) => {
  try {
    const capabilityId = request.body?.capabilityId;
    const definition = typeof capabilityId === "string" ? getCapabilityDefinition(capabilityId) : undefined;
    if (!definition || definition.mode !== "delegated" || !definition.probe.adapterRegistered) throw new AppError(400, "invalid_capability", "Select an implemented delegated capability.");
    if (!hasAnyRole(request.session.user!.roles, definition.internalRoles)) throw new AppError(403, "missing_internal_role", "The capability is not assigned to this Agent Control role.");
    const flow = createAuthFlow("consent", { capabilityId: definition.id, accountId: request.session.accountId, returnTo: request.body?.returnTo });
    request.session.authFlowHandle = storeAuthFlow(request.sessionID, request.session.authFlowHandle, flow);
    await saveSession(request);
    response.json({ authorizationUrl: await createAuthorizationUrl(flow) });
  } catch (error) {
    next(error);
  }
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
      const outcome = error === "access_denied" ? "cancelled" : ["interaction_required", "login_required", "consent_required"].includes(error) ? "interaction_required" : "failed";
      const target = new URL(flow.returnTo, config.frontendOrigin);
      target.searchParams.set("view", "permissions");
      target.searchParams.set("authorization", outcome);
      response.redirect(`${target.pathname}${target.search}${target.hash}`);
      return;
    }
    if (typeof code !== "string") throw new AppError(400, "invalid_auth_callback", "The sign-in callback was missing code.");
    const previousUser = request.session.user;
    const previousTenantId = request.session.tenantId;
    const previousAccountId = request.session.accountId;
    const sessionValidation = flow.kind === "consent" ? beginAccountSessionValidation(previousTenantId!, previousAccountId!) : undefined;
    const result = await redeemAuthorizationCode(code, flow);
    const user = toAuthenticatedUser(result);
    if (user.tenantId !== config.tenantId) throw AppError.unauthorized("The account belongs to a different tenant.");

    if (flow.kind === "login") {
      if (previousUser && previousTenantId && previousAccountId) {
        const cleanup = await Promise.allSettled([
          capabilities.invalidatePrincipal(previousUser),
          ...(previousAccountId !== user.homeAccountId || previousTenantId !== user.tenantId ? [
            evictAccount(previousAccountId),
            pauseBulkJobsForPrincipal({ tenantId: previousTenantId, principalId: previousAccountId }),
            pauseCopilotStudioQuarantineForPrincipal({ tenantId: previousTenantId, principalId: previousAccountId }),
            packageInventory.waitForPrincipalAuthorization({ tenantId: previousTenantId, principalId: previousAccountId }),
            powerPlatformInventory.waitForPrincipalAuthorization({ tenantId: previousTenantId, principalId: previousAccountId }),
            purviewAudit.waitForPrincipalAuthorization({ tenantId: previousTenantId, principalId: previousAccountId }),
            defenderHunting.waitForPrincipalAuthorization({ tenantId: previousTenantId, principalId: previousAccountId }),
          ] : []),
        ]);
        const failure = cleanup.find(value => value.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      await capabilities.invalidatePrincipal(user);
      await activateAccountSession(user.tenantId!, user.homeAccountId, async () => {
        await regenerateSession(request);
        request.session.accountId = user.homeAccountId;
        request.session.tenantId = user.tenantId;
        request.session.user = user;
        request.session.csrfToken = randomBytes(32).toString("base64url");
        request.session.rolesValidatedAt = Date.now();
        await saveSession(request);
      });
    } else {
      await commitAccountSessionValidation(sessionValidation!, async () => {
        await reloadSession(request);
        if (request.session.tenantId !== user.tenantId || request.session.accountId !== user.homeAccountId) throw AppError.unauthorized("Consent must return to the initiating account.");
        request.session.user = user;
        request.session.rolesValidatedAt = Date.now();
        await capabilities.invalidatePrincipal(user);
        await saveSession(request);
      });
    }

    response.redirect(flow.returnTo);
  } catch (error) {
    next(error);
  }
});

policyRoute(authRouter, "post", "/auth/logout", { access: "authenticated", dataClass: "identity", csrf: true }, async (request, response, next) => {
  try {
    const tenantId = request.session.tenantId;
    const accountId = request.session.accountId;
    const cleanup = await revokeAccountSessionMutations(tenantId!, accountId!, () => Promise.allSettled([
        evictAccount(accountId!),
        pauseBulkJobsForPrincipal({ tenantId: tenantId!, principalId: accountId! }),
        pauseCopilotStudioQuarantineForPrincipal({ tenantId: tenantId!, principalId: accountId! }),
        packageInventory.waitForPrincipalAuthorization({ tenantId: tenantId!, principalId: accountId! }),
        powerPlatformInventory.waitForPrincipalAuthorization({ tenantId: tenantId!, principalId: accountId! }),
        purviewAudit.waitForPrincipalAuthorization({ tenantId: tenantId!, principalId: accountId! }),
        defenderHunting.waitForPrincipalAuthorization({ tenantId: tenantId!, principalId: accountId! }),
        capabilities.invalidatePrincipal(request.session.user!),
        revokeAccountSessions(pool, tenantId!, accountId!),
      ]));
    const failure = cleanup.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    response.clearCookie("agent-control.sid");
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

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

function reloadSession(request: Request) {
  return new Promise<void>((resolve, reject) => request.session.reload(error => error ? reject(AppError.unauthorized("The session was revoked.")) : resolve()));
}

function firstQueryValue(value: unknown) {
  return Array.isArray(value) ? typeof value[0] === "string" ? value[0] : undefined : typeof value === "string" ? value : undefined;
}
