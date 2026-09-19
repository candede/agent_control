import { Router } from "express";
import type pg from "pg";
import { parseRecordId } from "../db/agentUsage.js";
import { pool } from "../db/pool.js";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { AgentUsageService } from "../services/agentUsage.js";
import {
  agentUsageAssociationInput, agentUsageAssociationRemoval, agentUsageCandidateQuery,
} from "../services/agentUsageValidation.js";
import { policyRoute } from "./policy.js";

export function createAgentUsageRouter(database: pg.Pool = pool) {
  const router = Router();
  const service = new AgentUsageService(database);

  policyRoute(router, "get", "/agent-inventory/:recordId/usage-candidates", {
    access: "authenticated", dataClass: "official_usage_association_candidates", roles: ["AgentControl.Admin"],
  }, async (request, response) => {
    const recordId = reference(request.params.recordId);
    response.json(await service.candidates(requestScope(request), recordId, agentUsageCandidateQuery(request.query)));
  });

  policyRoute(router, "post", "/agent-inventory/:recordId/usage-associations", {
    access: "authenticated", dataClass: "official_usage_association", roles: ["AgentControl.Admin"], csrf: true,
  }, async (request, response) => {
    noQuery(request.query);
    const recordId = reference(request.params.recordId);
    const input = agentUsageAssociationInput(request.body);
    response.json(await service.attach(requestScope(request), recordId, input, {
      actor: request.session.user!, requestPath: request.path,
    }));
  });

  policyRoute(router, "delete", "/agent-inventory/:recordId/usage-associations", {
    access: "authenticated", dataClass: "official_usage_association", roles: ["AgentControl.Admin"], csrf: true,
  }, async (request, response) => {
    noQuery(request.query);
    const recordId = reference(request.params.recordId);
    const input = agentUsageAssociationRemoval(request.body);
    response.json(await service.remove(requestScope(request), recordId, input, {
      actor: request.session.user!, requestPath: request.path,
    }));
  });
  return router;
}

function reference(value: unknown) {
  if (typeof value !== "string") throw new AppError(400, "invalid_agent_usage_record", "Select one exact agent reference.");
  parseRecordId(value);
  return value;
}

function noQuery(value: Record<string, unknown>) {
  if (Object.keys(value).length) throw new AppError(400, "invalid_agent_usage_input", "Association mutations do not accept query parameters.");
}
