import { Router } from "express";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import { assertAccountSessionValidation, beginAccountSessionValidation } from "../db/sessions.js";
import { requestScope } from "../middleware/auth.js";
import { LiveInventory } from "../db/liveInventory.js";
import { pool } from "../db/pool.js";
import { AgentIdentityRepository } from "../db/agentIdentity.js";
import { PurviewAuditRepository } from "../db/purviewAudit.js";
import type { UnifiedAgentInventoryQuery } from "../types/unifiedAgents.js";
import {
  parseUnifiedAgentRecordId, unifiedAgentRecordId, unifiedAgentInventoryScopes, unifiedAgentSortKeys, unifiedAgentViews,
  unifiedAgentAccessFilters, unifiedAgentUsageFilters, unifiedAgentManagementFilters, unifiedAgentRelevanceFilters,
} from "../types/unifiedAgents.js";
import { isAuditOperationPrefix } from "../types/audit.js";
import { policyRoute } from "./policy.js";
import { AuditLog } from "../services/auditLog.js";
import { AgentPeopleService } from "../services/agentPeople.js";
import { SavedAgentPeopleService } from "../services/savedAgentPeople.js";
import { isDirectoryObjectId } from "../types/copilotPackage.js";
import type { AgentResponsibilityQuery } from "../types/agentResponsibility.js";
import { AgentInvestigationsService, investigationRecordId } from "../services/agentInvestigations.js";
import { PurviewAuditService } from "../services/purviewAudit.js";
import { purviewAuditPresets } from "../types/purviewAudit.js";
import type { AgentPurviewQuery } from "../types/agentInvestigations.js";
import { AgentIdentityResolutionService } from "../services/agentIdentityResolution.js";
import { decodeInventoryFacet } from "../types/inventoryFacets.js";

export function createUnifiedAgentsRouter(database: pg.Pool = pool, dependencies: Partial<{
  inventory: LiveInventory; investigations: Pick<AgentInvestigationsService, "resolve">;
  identities: Pick<AgentIdentityResolutionService, "resolve">; people: Pick<AgentPeopleService, "generation" | "resolve">;
  savedPeople: Pick<SavedAgentPeopleService, "read">; purview: Pick<PurviewAuditService, "agentRecords">;
}> = {}) {
const unifiedAgentsRouter = Router();
const liveInventory = dependencies.inventory ?? new LiveInventory(database);
const mappings = new AgentIdentityRepository(database);
const agentInvestigations = dependencies.investigations ?? new AgentInvestigationsService(liveInventory, liveInventory, mappings);
const agentIdentityResolution = dependencies.identities ?? new AgentIdentityResolutionService({ inventory: agentInvestigations, repository: mappings });
const agentPeople = dependencies.people ?? new AgentPeopleService(database);
const savedAgentPeople = dependencies.savedPeople ?? new SavedAgentPeopleService(database);
const purviewAudit = dependencies.purview ?? new PurviewAuditService(new PurviewAuditRepository(database));

policyRoute(unifiedAgentsRouter, "post", "/agent-inventory/investigations/resolve", {
  access: "authenticated", dataClass: "directory", roles: ["AgentControl.Viewer"], csrf: true,
  capabilityId: "graph.agentIdentity.read",
}, async (request, response) => {
  response.setHeader("Cache-Control", "private, no-store");
  if (Object.keys(request.query).length || !request.body || typeof request.body !== "object" || Array.isArray(request.body)
    || Object.keys(request.body).some(key => key !== "recordId")) {
    throw new AppError(400, "invalid_agent_investigation", "Identity resolution accepts only a saved recordId.");
  }
  const recordId = investigationRecordId(request.body.recordId);
  const controller = new AbortController();
  const abort = () => { controller.abort(); };
  response.once("close", abort);
  try { response.json(await agentIdentityResolution.resolve(request.session.user!, recordId, controller.signal)); }
  finally { response.removeListener("close", abort); }
});

policyRoute(unifiedAgentsRouter, "get", "/agent-inventory/investigations/context", {
  access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
}, async (request, response) => {
  response.setHeader("Cache-Control", "private, no-store");
  if (Object.keys(request.query).some(key => key !== "recordId")) throw new AppError(400, "invalid_agent_investigation", "Select an exact saved agent record.");
  response.json((await agentInvestigations.resolve(requestScope(request), investigationRecordId(request.query.recordId))).context);
});

policyRoute(unifiedAgentsRouter, "get", "/agent-inventory/investigations/purview", {
  access: "authenticated", dataClass: "private_provider_audit", roles: ["AgentControl.Viewer"],
}, async (request, response) => {
  response.setHeader("Cache-Control", "private, no-store");
  const { recordId, query } = agentPurviewQuery(request.query);
  const audit = new AuditLog(requestScope(request), database);
  const event = await audit.startEvent({ operationId: `view-audit-search:${randomUUID()}`, scope: "single", action: "view-audit-search", agentId: recordId,
    actor: request.session.user!, requestPath: request.path, metadata: { source: "microsoft_purview_audit" } });
  try {
    const result = await purviewAudit.agentRecords(request.session.user!, recordId, query, agentInvestigations.resolve.bind(agentInvestigations));
    await audit.completeEvent(event.id, { status: "succeeded", metadata: { source: "microsoft_purview_audit", resultingCount: result.count } });
    response.json(result);
  } catch (error) {
    await audit.completeEvent(event.id, { status: "failed", errorCode: error instanceof AppError ? error.code : "audit_read_failed" });
    throw error;
  }
});

policyRoute(unifiedAgentsRouter, "post", "/agent-inventory/people/resolve", {
  access: "authenticated", dataClass: "directory", roles: ["AgentControl.Viewer"],
  capabilityId: "graph.directory.read", csrf: true,
}, async (request, response) => {
  const input = agentPeopleResolveInput(request.body);
  const scope = requestScope(request);
  const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
  const controller = new AbortController();
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    assertAccountSessionValidation(validation);
  };
  const disconnected = () => { if (!response.writableEnded) controller.abort(); };
  response.once("close", disconnected);
  try {
    assertCurrent();
    const generation = await agentPeople.generation(scope);
    assertCurrent();
    const record = await liveInventory.record(scope, input.recordId);
    assertCurrent();
    const ids = Object.values(record.people)
      .filter((id): id is string => typeof id === "string" && isDirectoryObjectId(id));
    const result = await agentPeople.resolve(request.session.user!, ids, { generation, force: input.force, signal: controller.signal });
    assertCurrent();
    await liveInventory.assertCurrent(scope, record.id, record.revision);
    const evidence = await savedAgentPeople.read(scope, ids);
    assertCurrent();
    response.json({ people: Object.fromEntries(Object.entries(record.people).flatMap(([role, objectId]) => {
      const person = evidence.get(objectId.toLowerCase());
      return person ? [[role, person]] : [];
    })), changed: result.changed });
  } finally {
    response.off("close", disconnected);
  }
});

return unifiedAgentsRouter;
}

export function agentPurviewQuery(value: Record<string, unknown>): { recordId: string; query: AgentPurviewQuery } {
  const invalid = () => new AppError(400, "invalid_agent_investigation", "Use bounded saved-agent Purview paging, search and operations.");
  if (Object.keys(value).some(key => !["recordId", "limit", "offset", "search", "operation"].includes(key))) throw invalid();
  const integer = (key: "limit" | "offset", fallback: number, maximum: number) => {
    if (value[key] === undefined) return fallback;
    if (typeof value[key] !== "string" || !/^\d+$/.test(value[key])) throw invalid();
    const number = Number(value[key]);
    if (!Number.isSafeInteger(number) || number > maximum || number < (key === "limit" ? 1 : 0)) throw invalid();
    return number;
  };
  if (value.search !== undefined && (typeof value.search !== "string" || value.search.length > 256 || /[\r\n\0]/.test(value.search))) throw invalid();
  if (value.operation !== undefined && (typeof value.operation !== "string" || value.operation.length > 128
    || !purviewAuditPresets.copilot_studio_admin.operationFilters.includes(value.operation))) throw invalid();
  return { recordId: investigationRecordId(value.recordId), query: { limit: integer("limit", 50, 100), offset: integer("offset", 0, 100_000),
    ...(typeof value.search === "string" && value.search.trim() ? { search: value.search.trim() } : {}),
    ...(typeof value.operation === "string" ? { operation: value.operation } : {}) } };
}

export function agentResponsibilityQuery(value: Record<string, unknown>): AgentResponsibilityQuery {
  const invalid = () => new AppError(400, "invalid_responsibility_query", "Use an exact directory object ID and bounded responsibility paging/search.");
  if (Object.keys(value).some(key => !["objectId", "search", "selectionId", "cursor", "limit"].includes(key))) throw invalid();
  if (value.objectId !== undefined && (typeof value.objectId !== "string" || !isDirectoryObjectId(value.objectId))) throw invalid();
  if (value.search !== undefined && (typeof value.search !== "string" || value.search.length > 256 || /[\r\n\0]/.test(value.search))) throw invalid();
  if (value.selectionId !== undefined && (typeof value.selectionId !== "string" || !isDirectoryObjectId(value.selectionId))) throw invalid();
  if (value.cursor !== undefined && (typeof value.cursor !== "string" || !value.cursor.length || value.cursor.length > 4096
    || !value.selectionId || /[\0\r\n]/.test(value.cursor))) throw invalid();
  const integer = (key: string, maximum: number, fallback: number) => {
    if (value[key] === undefined) return fallback;
    if (typeof value[key] !== "string" || !/^\d+$/.test(value[key])) throw invalid();
    const number = Number(value[key]);
    if (!Number.isSafeInteger(number) || number > maximum || (key === "limit" && number < 1)) throw invalid();
    return number;
  };
  return { objectId: typeof value.objectId === "string" ? value.objectId.toLowerCase() : undefined,
    search: value.search as string | undefined, selectionId: value.selectionId as string | undefined,
    cursor: value.cursor as string | undefined, limit: integer("limit", 100, 50) };
}

export function agentPeopleResolveInput(value: unknown): { recordId: string; force: boolean } {
  if (!isRecord(value) || Object.keys(value).some(key => !["recordId", "force"].includes(key))
    || typeof value.recordId !== "string" || !value.recordId
    || value.force !== undefined && typeof value.force !== "boolean") {
    throw new AppError(400, "invalid_agent_people", "Agent people require an exact saved record ID and an optional refresh flag.");
  }
  return { recordId: exactRecordId(value.recordId)!, force: value.force === true };
}


export function unifiedAgentInventoryQuery(query: Record<string, unknown>): UnifiedAgentInventoryQuery {
  if (Object.values(query).some(value => value !== undefined && typeof value !== "string")) {
    return invalidQuery("Inventory query parameters must be single string values.");
  }
  const blocked = first(query.blocked);
  return {
    inventoryScope: oneOf(first(query.inventoryScope), "inventoryScope", unifiedAgentInventoryScopes) ?? "all",
    type: literalFacet(query.type, "type", 4096),
    view: filterValue(query.view, "view", unifiedAgentViews),
    endUserAccess: filterValue(query.endUserAccess, "endUserAccess", unifiedAgentAccessFilters),
    reportedUsage: filterValue(query.reportedUsage, "reportedUsage", unifiedAgentUsageFilters),
    management: filterValue(query.management, "management", unifiedAgentManagementFilters),
    relevance: filterValue(query.relevance, "relevance", unifiedAgentRelevanceFilters),
    recordId: exactRecordId(first(query.recordId)),
    operationIdPrefix: operationReference(first(query.operationIdPrefix)),
    search: optionalText(first(query.search), "search", 256),
    source: oneOf(first(query.source), "source", ["all", "graph_packages", "power_platform", "both"] as const) ?? "all",
    linkState: oneOf(first(query.linkState), "linkState", ["matched", "unmatched", "ambiguous", "conflicting"] as const),
    environmentId: literalFacet(query.environmentId, "environmentId", 512),
    blocked: blocked === undefined || blocked === "" ? undefined
      : blocked === "true" ? true
        : blocked === "false" ? false
          : invalidQuery("blocked must be true or false."),
    publisher: literalFacet(query.publisher, "publisher", 4096),
    availableTo: query.availableTo === "~some-or-all" ? { kind: "some-or-all" } : literalFacet(query.availableTo, "availableTo", 4096),
    host: literalFacet(query.host, "host", 4096),
    platform: literalFacet(query.platform, "platform", 4096),
    createdWithinDays: optionalPositiveInteger(first(query.createdWithinDays), "createdWithinDays", 3650),
    sortBy: oneOf(first(query.sortBy), "sortBy", unifiedAgentSortKeys) ?? "displayName",
    sortDirection: oneOf(first(query.sortDirection), "sortDirection", ["asc", "desc"] as const) ?? "asc",
    limit: positiveInteger(first(query.limit), "limit", 50, 100),
  };
}

function literalFacet(value: unknown, field: string, maximum: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum + 8 || /[\r\n\0]/.test(value)) {
    return invalidQuery(`${field} requires one bounded tagged facet value.`);
  }
  try {
    const decoded = decodeInventoryFacet(value);
    if (decoded === null || typeof decoded === "string" && decoded.length > 0) return decoded;
  } catch { /* Invalid wire tags are rejected, never treated as provider literals. */ }
  return invalidQuery(`${field} requires a tagged string or unknown value.`);
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

function filterValue<const T extends readonly string[]>(value: unknown, name: string, values: T): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value)) {
    return invalidQuery(`${name} must be one of: ${values.join(", ")}.`);
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
