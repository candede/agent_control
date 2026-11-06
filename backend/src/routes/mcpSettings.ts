import { Router } from "express";
import { config } from "../config.js";
import { currentAuthority } from "../auth/authorityContext.js";
import { assertAccountSessionValidation, beginAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import { requestUser } from "../middleware/requestAuthentication.js";
import { readMcpSettings } from "../services/mcpSettings.js";
import { mcpAccessProfile } from "../services/mcpAccess.js";
import { hasAppRole } from "../types/capability.js";
import { policyRoute } from "./policy.js";

export function createMcpSettingsRouter(reader = readMcpSettings) {
  const router = Router();
  policyRoute(router, "get", "/mcp/settings", { access: "authenticated", browserOnly: true,
    dataClass: "operational_metadata", roles: ["AgentControl.Viewer"] }, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const user = requestUser(request);
    const validation = beginAccountSessionValidation(user.tenantId!, user.homeAccountId);
    const authority = currentAuthority();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!response.writableEnded) abort(); };
    request.once("aborted", abort);
    response.once("close", close);
    if (request.aborted || response.destroyed || response.writableEnded) abort();
    try {
      controller.signal.throwIfAborted();
      assertAccountSessionValidation(validation);
      const settings = await reader(user.tenantId!, mcpAccessProfile(), controller.signal);
      controller.signal.throwIfAborted();
      authority?.assertCurrent();
      assertAccountSessionValidation(validation);
      const current = requestUser(request);
      if (current.tenantId !== user.tenantId || current.homeAccountId !== user.homeAccountId
        || !hasAppRole(current.roles, "AgentControl.Viewer")) throw AppError.unauthorized();
      response.json({ ...settings, privacy: { ...config.employeePrivacy }, privacyScope: "end_user_and_preview" });
    } finally {
      request.removeListener("aborted", abort);
      response.removeListener("close", close);
    }
  });
  return router;
}
