import { Router } from "express";
import type pg from "pg";
import { AppError } from "../errors.js";
import { requestUser } from "../middleware/requestAuthentication.js";
import { AdoptionContent, contentId } from "../services/adoptionContent.js";
import { policyRoute } from "./policy.js";

export function createAdoptionContentRouter(database: pg.Pool, service = new AdoptionContent(database)) {
  const router = Router();
  const read = { access: "authenticated" as const, dataClass: "adoption_content", roles: ["AgentControl.Viewer" as const] };
  policyRoute(router, "get", "/adoption-content", read, async (request, response) => {
    const { limit, ...query } = request.query;
    response.json(await service.list(requestUser(request), { ...query, ...(limit === undefined ? {} : { limit: Number(limit) }) }));
  });
  policyRoute(router, "get", "/adoption-content/:id", read, async (request, response) =>
    response.json(await service.detail(requestUser(request), contentId(request.params.id))));
  policyRoute(router, "post", "/adoption-content", { ...read, csrf: true }, async (request, response) => {
    if (Object.keys(request.query).length || !request.body || typeof request.body !== "object" || Array.isArray(request.body)
      || Object.keys(request.body).some(key => !["requestId", "draft"].includes(key))) throw new AppError(400, "invalid_adoption_content", "Use requestId and draft.");
    response.json(await service.create(requestUser(request), request.body.requestId, request.body.draft));
  });
  policyRoute(router, "patch", "/adoption-content/:id", { ...read, csrf: true }, async (request, response) =>
    response.json(await service.update(requestUser(request), contentId(request.params.id), request.body)));
  policyRoute(router, "delete", "/adoption-content/:id", { ...read, csrf: true }, async (request, response) =>
    response.json(await service.delete(requestUser(request), contentId(request.params.id), request.body)));
  policyRoute(router, "post", "/adoption-content/:id/follow-up", { ...read, csrf: true }, async (request, response) =>
    response.json(await service.followUp(requestUser(request), contentId(request.params.id), request.body)));
  return router;
}
