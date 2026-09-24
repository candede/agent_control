import { Router, type Request, type Response } from "express";
import { AppError } from "../errors.js";
import { capabilities } from "../services/capabilities.js";
import { getCapabilityDefinition } from "../services/capabilityRegistry.js";
import { operationalLog } from "../services/telemetry.js";
import { policyRoute } from "./policy.js";
import { appRoles } from "../types/capability.js";

export const capabilitiesRouter = Router();

policyRoute(capabilitiesRouter, "get", "/capabilities", { access: "authenticated", dataClass: "configuration", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.json({ value: await capabilities.list(request.session.user!) });
});

policyRoute(capabilitiesRouter, "get", "/capabilities/check-progress", { access: "authenticated", dataClass: "configuration", roles: ["AgentControl.Viewer"] }, async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ progress: capabilities.checkProgress(request.session.user!, retryFailedOption(request)) });
});

policyRoute(capabilitiesRouter, "post", "/capabilities/check", { access: "authenticated", dataClass: "configuration", roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
  if (request.body !== undefined && (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length)) {
    throw new AppError(400, "invalid_request", "Automatic capability checks do not accept request parameters.");
  }
  const retryFailed = retryFailedOption(request);
  response.json({ value: await withConnectionSignal(response, signal =>
    capabilities.check(request.session.user!, { retryFailed, signal })) });
});

policyRoute(capabilitiesRouter, "post", "/capabilities/:id/probe", { access: "authenticated", dataClass: "configuration", roles: [...appRoles], csrf: true }, async (request, response) => {
  const definition = getCapabilityDefinition(String(request.params.id));
  if (!definition) throw new AppError(404, "capability_not_found", "Capability was not found.");
  response.json(await withConnectionSignal(response, signal => capabilities.refresh(definition.id, request.session.user!, signal)));
});

policyRoute(capabilitiesRouter, "put", "/capabilities/:id/configuration", { access: "authenticated", dataClass: "configuration", roles: ["AgentControl.Admin"], csrf: true }, async (request, response) => {
  const definition = getCapabilityDefinition(String(request.params.id));
  if (!definition) throw new AppError(404, "capability_not_found", "Capability was not found.");
  if (typeof request.body?.enabled !== "boolean" || typeof request.body?.sharedDataScope !== "boolean") throw new AppError(400, "invalid_configuration", "enabled and sharedDataScope must be booleans.");
  const result=await capabilities.configureApplication(definition.id, request.session.user!, request.body.enabled, request.body.sharedDataScope);
  operationalLog("info", "capability_configuration_changed", { capabilityId: definition.id, outcome: "updated" });
  response.json(result);
});

async function withConnectionSignal<T>(response: Response, operation: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const disconnected = () => { if (!response.writableEnded) controller.abort(new AppError(499, "request_cancelled", "Capability check was cancelled.")); };
  response.once("close", disconnected);
  try { return await operation(controller.signal); }
  finally { response.off("close", disconnected); }
}

function retryFailedOption(request: Request) {
  const retry = request.query.retry;
  if (Object.keys(request.query).some(key => key !== "retry") || retry !== undefined && retry !== "failed") {
    throw new AppError(400, "invalid_request", "The only supported capability check option is retry=failed.");
  }
  return retry === "failed";
}