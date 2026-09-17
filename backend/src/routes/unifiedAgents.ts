import { Router } from "express";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { unifiedAgents } from "../services/unifiedAgents.js";
import type { UnifiedAgentInventoryQuery } from "../types/unifiedAgents.js";
import { parseUnifiedAgentRecordId, unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { isAuditOperationPrefix } from "../types/audit.js";
import { policyRoute } from "./policy.js";
import { getAuditLog } from "../services/auditLog.js";
import { createExportPublicationValidator, publishBoundedCsv } from "../services/csvExport.js";
import { buildUnifiedAgentCsv } from "../services/unifiedAgentExport.js";

export const unifiedAgentsRouter = Router();

policyRoute(unifiedAgentsRouter, "get", "/agent-inventory", {
  access: "authenticated",
  dataClass: "private_inventory",
  roles: ["AgentControl.Viewer"],
}, async (request, response) => {
  response.json(await unifiedAgents.list(requestScope(request), unifiedAgentInventoryQuery(request.query)));
});

policyRoute(unifiedAgentsRouter, "post", "/agent-inventory/export.csv", {
  access: "authenticated", dataClass: "private_inventory_export", roles: ["AgentControl.Viewer"], csrf: true,
}, async (request, response) => {
  const input = unifiedAgentExportInput(request.body);
  const scope = requestScope(request);
  const deadlineAt = Date.now() + 15_000;
  const validateSession = createExportPublicationValidator(request, "AgentControl.Viewer");
  const audit = getAuditLog(scope);
  const event = await audit.startEvent({
    operationId: `export-agent-inventory:${randomUUID()}`, scope: "bulk", action: "export-agent-inventory",
    agentId: "unified-agent-inventory", actor: request.session.user!, requestPath: request.path,
    metadata: { source: "unified_agents", revision: input.revision, selection: input.recordIds ? "exact" : "filtered" },
  });
  try {
    await validateSession();
    const inventory = await unifiedAgents.forExport(scope, input.revision, input.query, input.recordIds);
    const referenceSelection = input.query.operationIdPrefix ? JSON.stringify(inventory.value.map(record => record.id)) : undefined;
    const validate = async () => {
      await validateSession();
      await unifiedAgents.assertRevision(scope, input.revision);
      if (referenceSelection !== undefined) {
        const current = await unifiedAgents.forExport(scope, input.revision, input.query, input.recordIds);
        if (JSON.stringify(current.value.map(record => record.id)) !== referenceSelection) {
          throw new AppError(409, "dataset_invalidated", "The authorized operation-reference selection changed before export publication.");
        }
      }
    };
    const csv = buildUnifiedAgentCsv(inventory, deadlineAt);
    await publishBoundedCsv(request, response, "agents.csv", csv.buffer, {
      deadlineAt, validate,
      beforeEnd: () => audit.completeEvent(event.id, {
        status: "succeeded", metadata: {
          source: "unified_agents", revision: input.revision, resultingCount: csv.rowCount,
          resultingBytes: csv.byteCount, partial: inventory.partial, selection: input.recordIds ? "exact" : "filtered",
        },
      }).then(() => undefined),
    });
  } catch (error) {
    await audit.completeEvent(event.id, { status: "failed", errorCode: error instanceof AppError ? error.code : "agent_export_failed" });
    if (response.headersSent) {
      if (!response.destroyed) response.destroy();
      return;
    }
    throw error;
  }
});

export function unifiedAgentExportInput(value: unknown): { revision: string; query: UnifiedAgentInventoryQuery; recordIds?: string[] } {
  if (!isRecord(value) || Object.keys(value).some(key => !["revision", "query", "recordIds"].includes(key))) {
    throw new AppError(400, "invalid_export_selection", "Agent export requires a saved revision and either filters or exact agent references.");
  }
  if (typeof value.revision !== "string" || value.revision.length !== 64 || !/^[a-f0-9]{64}$/i.test(value.revision)) {
    throw new AppError(400, "invalid_export_selection", "Refresh Agents before exporting its exact saved revision.");
  }
  const query = value.query === undefined ? {} : value.query;
  if (!isRecord(query)) throw new AppError(400, "invalid_export_selection", "Export filters must be an object.");
  const allowed = new Set([
    "recordId", "operationIdPrefix", "search", "source", "linkState", "environmentId", "blocked", "publisher",
    "availableTo", "host", "platform", "createdWithinDays", "sortBy", "sortDirection",
  ]);
  const normalized: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(query)) {
    if (!allowed.has(key)) throw new AppError(400, "invalid_export_selection", "Export filters contain an unsupported field.");
    if (field === undefined) continue;
    if (typeof field === "string" || key === "blocked" && typeof field === "boolean"
      || key === "createdWithinDays" && typeof field === "number" && Number.isFinite(field)) {
      normalized[key] = String(field);
    } else throw new AppError(400, "invalid_export_selection", "Export filter values have invalid types.");
  }
  let recordIds: string[] | undefined;
  if (value.recordIds !== undefined) {
    if (!Array.isArray(value.recordIds) || !value.recordIds.length || value.recordIds.length > 5_000
      || Object.keys(normalized).some(key => key !== "sortBy" && key !== "sortDirection")) {
      throw new AppError(400, "invalid_export_selection", "Export either 1-5,000 exact agent references or one filtered inventory.");
    }
    recordIds = value.recordIds.map(value => {
      if (typeof value !== "string" || !value || value.length > 10_000) {
        throw new AppError(400, "invalid_export_selection", "Each agent reference must be an exact canonical or source-qualified identity.");
      }
      return exactRecordId(value)!;
    });
    recordIds = [...new Set(recordIds)];
  }
  return { revision: value.revision.toLowerCase(), query: unifiedAgentInventoryQuery(normalized), ...(recordIds ? { recordIds } : {}) };
}

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
    if (!target) return invalidQuery("recordId must be a canonical or source-qualified unified agent identity.");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
