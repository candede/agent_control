import { Router } from "express";
import type pg from "pg";
import { AppError } from "../errors.js";
import { requestUser } from "../middleware/requestAuthentication.js";
import { AgentDiscovery, discoveryTextInput } from "../services/agentDiscovery.js";
import { policyRoute } from "./policy.js";
import { AdoptionContent } from "../services/adoptionContent.js";

export function createAgentDiscoveryRouter(database: pg.Pool, service = new AgentDiscovery(database)) {
  const router = Router();
  const content = new AdoptionContent(database);
  policyRoute(router, "post", "/discovery/learning", { access: "authenticated", dataClass: "employee_discovery", csrf: true },
    async (request, response) => {
      if (Object.keys(request.query).length) throw new AppError(400, "invalid_adoption_content", "Learning accepts only its typed request body.");
      const result = await content.shared(requestUser(request), request.body);
      response.setHeader("Cache-Control", "no-store");
      response.json(result);
    });
  policyRoute(router, "post", "/discovery/learning/preview", { access: "authenticated", dataClass: "employee_discovery",
    roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
    if (Object.keys(request.query).length || !request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      throw new AppError(400, "invalid_adoption_content", "Preview accepts only its typed request body.");
    }
    const { subject, ...read } = request.body;
    const result = await content.shared(requestUser(request), read, discoveryTextInput(subject, 512));
    response.setHeader("Cache-Control", "no-store");
    response.json(result);
  });
  policyRoute(router, "post", "/discovery/read", { access: "authenticated", dataClass: "employee_discovery", csrf: true },
    async (request, response) => {
      if (Object.keys(request.query).length) throw new AppError(400, "invalid_discovery_request", "Discovery accepts only its typed request body.");
      const result = await service.execute(requestUser(request), request.body);
      response.setHeader("Cache-Control", "no-store");
      response.json(result);
    });
  policyRoute(router, "post", "/discovery/preview", { access: "authenticated", dataClass: "employee_discovery",
    roles: ["AgentControl.Viewer"], csrf: true }, async (request, response) => {
    if (Object.keys(request.query).length || !request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      throw new AppError(400, "invalid_discovery_request", "Preview accepts only its typed request body.");
    }
    const { subject, ...read } = request.body;
    const result = await service.execute(requestUser(request), read, discoveryTextInput(subject, 512));
    response.setHeader("Cache-Control", "no-store");
    response.json(result);
  });
  return router;
}
