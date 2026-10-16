import { Router } from "express";
import type pg from "pg";
import { AppError } from "../errors.js";
import { requestUser } from "../middleware/requestAuthentication.js";
import { AgentControls } from "../services/agentControls.js";
import { parseUnifiedAgentRecordId, unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { policyRoute } from "./policy.js";

export function createSharedAgentControlsRouter(database: pg.Pool) {
  const router = Router(), controls = new AgentControls(database);
  const policy = { access: "authenticated" as const, dataClass: "agent_control", roles: ["AgentControl.Admin" as const], csrf: true };
  policyRoute(router, "post", "/agent-controls/preview", policy, async (request, response) => {
    const input = object(request.body, ["selectionId", "recordIds", "action"]);
    if (input.action !== "block" && input.action !== "unblock") invalid();
    if (!Array.isArray(input.recordIds) || !input.recordIds.length || input.recordIds.length > 100) invalid();
    const recordIds = input.recordIds.map((id: unknown) => {
      if (typeof id !== "string" || id.length > 512) return invalid();
      // Report-only records are explicitly ineligible, never guessed native targets.
      if (id.startsWith("report:") && id.length > 7 && !/[\r\n\0]/.test(id)) return id;
      try {
        const target = parseUnifiedAgentRecordId(id);
        if (target?.source === "canonical") return unifiedAgentRecordId(target);
      } catch { /* Return the canonical typed input error below. */ }
      return invalid();
    }).sort();
    if (new Set(recordIds).size !== recordIds.length) invalid();
    response.json(await controls.preview(requestUser(request), uuid(input.selectionId), recordIds, input.action));
  });
  policyRoute(router, "post", "/agent-controls/execute", policy, async (request, response) => {
    const input = object(request.body, ["receiptId", "confirmationHash"]);
    if (typeof input.confirmationHash !== "string" || !/^[a-f0-9]{64}$/.test(input.confirmationHash)) invalid();
    const key = request.get("Idempotency-Key");
    if (!key || key.length > 200 || /[\u0000-\u0020\u007f]/.test(key)) throw new AppError(400, "invalid_idempotency_key", "Use a bounded stable Idempotency-Key.");
    response.status(202).json(await controls.execute(requestUser(request), uuid(input.receiptId), input.confirmationHash, key));
  });
  policyRoute(router,"get","/agent-controls/:receiptId",{...policy,csrf:false},async(request,response)=>{
    response.json(await controls.status(requestUser(request),uuid(request.params.receiptId)));
  });
  return router;
}
function object(input: unknown, fields: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) invalid();
  return input as Record<string, unknown>;
}
function uuid(input: unknown) {
  if (typeof input !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input)) invalid();
  return input.toLowerCase();
}
function invalid(): never { throw new AppError(400, "invalid_control_request", "Use an exact current selection, canonical target IDs and block or unblock action."); }
