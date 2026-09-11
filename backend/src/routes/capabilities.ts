import { Router } from "express";
import { AppError } from "../errors.js";
import { capabilities } from "../services/capabilities.js";
import { getCapabilityDefinition } from "../services/capabilityRegistry.js";
import { operationalLog } from "../services/telemetry.js";
import { policyRoute } from "./policy.js";

export const capabilitiesRouter = Router();
const recognizedRoles = ["AgentControl.Reader", "AgentControl.Operator", "AgentControl.SecurityReader", "AgentControl.Administrator"] as const;

policyRoute(capabilitiesRouter, "get", "/capabilities", { access: "authenticated", dataClass: "configuration" }, async (request, response) => {
  response.json({ value: await capabilities.list(request.session.user!) });
});

policyRoute(capabilitiesRouter, "post", "/capabilities/:id/probe", { access: "authenticated", dataClass: "configuration", roles: [...recognizedRoles], csrf: true }, async (request, response) => {
  const definition = getCapabilityDefinition(String(request.params.id));
  if (!definition) throw new AppError(404, "capability_not_found", "Capability was not found.");
  response.json(await capabilities.refresh(definition.id, request.session.user!));
});

policyRoute(capabilitiesRouter, "put", "/capabilities/:id/configuration", { access: "authenticated", dataClass: "configuration", roles: ["AgentControl.Administrator"], csrf: true }, async (request, response) => {
  const definition = getCapabilityDefinition(String(request.params.id));
  if (!definition) throw new AppError(404, "capability_not_found", "Capability was not found.");
  if (typeof request.body?.enabled !== "boolean" || typeof request.body?.sharedDataScope !== "boolean") throw new AppError(400, "invalid_configuration", "enabled and sharedDataScope must be booleans.");
  const result=await capabilities.configureApplication(definition.id, request.session.user!, request.body.enabled, request.body.sharedDataScope);
  operationalLog("info", "capability_configuration_changed", { capabilityId: definition.id, outcome: "updated" });
  response.json(result);
});