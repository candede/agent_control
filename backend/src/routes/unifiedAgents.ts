import { Router } from "express";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { unifiedAgents } from "../services/unifiedAgents.js";
import type { UnifiedAgentInventoryQuery } from "../types/unifiedAgents.js";
import { parseUnifiedAgentRecordId, unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { isAuditOperationPrefix } from "../types/audit.js";
import { policyRoute } from "./policy.js";

export const unifiedAgentsRouter = Router();

policyRoute(unifiedAgentsRouter, "get", "/agent-inventory", {
  access: "authenticated",
  dataClass: "private_inventory",
  roles: ["AgentControl.Viewer"],
}, async (request, response) => {
  response.json(await unifiedAgents.list(requestScope(request), unifiedAgentInventoryQuery(request.query)));
});

export function unifiedAgentInventoryQuery(query: Record<string, unknown>): UnifiedAgentInventoryQuery {
  const blocked = first(query.blocked);
  return {
    recordId: exactRecordId(first(query.recordId)),
    operationIdPrefix: operationReference(first(query.operationIdPrefix)),
    search: optionalText(first(query.search), "search", 256),
    source: oneOf(first(query.source), "source", ["all", "graph_packages", "power_platform", "both"] as const) ?? "all",
    linkState: oneOf(first(query.linkState), "linkState", ["matched", "unmatched", "ambiguous", "conflicting"] as const),
    environmentId: optionalText(first(query.environmentId), "environmentId", 512),
    blocked: blocked === undefined || blocked === "" ? undefined
      : blocked === "true" ? true
        : blocked === "false" ? false
          : invalidQuery("blocked must be true or false."),
    publisher: optionalText(first(query.publisher), "publisher", 256),
    availableTo: optionalText(first(query.availableTo), "availableTo", 128),
    host: optionalText(first(query.host), "host", 256),
    platform: optionalText(first(query.platform), "platform", 256),
    createdWithinDays: optionalPositiveInteger(first(query.createdWithinDays), "createdWithinDays", 3650),
    sortBy: oneOf(first(query.sortBy), "sortBy", ["displayName", "environment", "source", "lastModifiedAt"] as const) ?? "displayName",
    sortDirection: oneOf(first(query.sortDirection), "sortDirection", ["asc", "desc"] as const) ?? "asc",
    limit: positiveInteger(first(query.limit), "limit", 50, 250),
    offset: positiveInteger(first(query.offset), "offset", 0, 100_000, true),
  };
}

function operationReference(value: unknown) {
  if (value === undefined) return undefined;
  if (!isAuditOperationPrefix(value)) return invalidQuery("operation reference is invalid");
  return value;
}

function exactRecordId(value: unknown) {
  const text = optionalText(value, "recordId", 10_000);
  if (!text) return undefined;
  try {
    const target = parseUnifiedAgentRecordId(text);
    if (!target) return invalidQuery("recordId must be a source-qualified unified agent identity.");
    return unifiedAgentRecordId(target);
  } catch (error) {
    if (error instanceof URIError || error instanceof RangeError) return invalidQuery("recordId contains an invalid native identity.");
    throw error;
  }
}

function first(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

function optionalText(value: unknown, name: string, maximumLength: number) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength || /[\r\n\0]/.test(value)) {
    throw invalidQuery(`${name} must be non-empty text of at most ${maximumLength} characters.`);
  }
  return value.trim();
}

function oneOf<const T extends readonly string[]>(value: unknown, name: string, values: T): T[number] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !values.includes(value)) {
    throw invalidQuery(`${name} must be one of: ${values.join(", ")}.`);
  }
  return value as T[number];
}

function positiveInteger(value: unknown, name: string, fallback: number, maximum: number, allowZero = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed > maximum || parsed < (allowZero ? 0 : 1)) {
    throw invalidQuery(`${name} must be an integer from ${allowZero ? 0 : 1} to ${maximum}.`);
  }
  return parsed;
}

function optionalPositiveInteger(value: unknown, name: string, maximum: number) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw invalidQuery(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return parsed;
}

function invalidQuery(message: string): never {
  throw new AppError(400, "invalid_agent_inventory_query", message);
}
