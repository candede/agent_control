import { Router } from "express";
import type pg from "pg";
import { pool } from "../db/pool.js";
import { AppError } from "../errors.js";
import { CopilotUsageService } from "../services/copilotUsage.js";
import { policyRoute } from "./policy.js";

export function createCopilotUsageRouter(database: pg.Pool = pool, service: Pick<CopilotUsageService, "users"> = new CopilotUsageService(database)) {
  const router = Router();
  policyRoute(router, "get", "/copilot-usage/users", {
    access: "authenticated",
    dataClass: "licensed_copilot_usage",
    roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (Object.keys(request.query).length > 0) {
      throw new AppError(400, "invalid_copilot_usage_query", "The Copilot usage snapshot does not accept query parameters.");
    }
    response.json(await service.users(request.session.user!));
  });
  return router;
}
