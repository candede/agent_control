import { Router, type Request } from "express";
import type pg from "pg";
import { config, getTenantConfiguration } from "../config.js";
import { InventoryQueries, type InventoryQuery } from "../db/inventoryQueries.js";
import type { SelectionIdentity } from "../services/dataSelections.js";
import { AppError } from "../errors.js";
import { reportIdentity } from "../services/reportIdentity.js";
import { policyRoute } from "./policy.js";
import { agentResponsibilityQuery, unifiedAgentInventoryQuery } from "./unifiedAgents.js";
import { inventoryPresentation, inventorySourceStatuses } from "../services/inventoryPresentation.js";
import { dataLimitError } from "../db/dataBounds.js";
import { capabilities } from "../services/capabilities.js";
import { randomUUID } from "node:crypto";
import { PackageRefreshJobs } from "../db/packageRefreshJobs.js";
import type { UnifiedAgentInventoryUnavailable } from "../types/unifiedAgents.js";

function scalar(value: unknown, name: string, maximum = 4096) {
  if (typeof value !== "string" || !value || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new AppError(400, "invalid_inventory_query", `Use one bounded ${name}.`);
  }
  return value;
}

export function createInventoryDataRouter(database: pg.Pool) {
  const router = Router();
  const inventory = new InventoryQueries(database, config.sessionSecret, config.officialUsageStaleDays, undefined,
    { source: "inventory_canonical", tokenMode: "delegated" });
  const filterFields = ["inventoryScope", "type", "view", "endUserAccess", "reportedUsage", "management", "relevance", "recordId",
    "operationIdPrefix", "search", "source", "linkState", "environmentId", "blocked", "publisher", "availableTo", "host", "platform",
    "createdWithinDays", "sortBy", "sortDirection"];
  const facetFields = ["type", "publisher", "availableTo", "host", "platform"];
  async function capture(identity: SelectionIdentity, query: InventoryQuery) {
    const root = (await database.query(`SELECT s.id,EXISTS(SELECT 1 FROM inventory_roots r
      WHERE r.scope_id=s.id AND r.current) AS published FROM data_scope_epochs s
      WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.source='inventory_canonical'
        AND s.token_mode='delegated' AND s.selector='complete'`, [identity.tenantId, identity.principalId])).rows[0];
    if (!root || !root.published) {
      const unavailable: UnifiedAgentInventoryUnavailable = root
        ? { state: "preparing", message: "The first saved agent inventory is being prepared. Results will appear when it is ready. Open Sync to review collection progress." }
        : { state: "not_collected", message: "No saved agent inventory is available yet. Automatic collection will populate it when authorized, or open Sync to collect it." };
      return unavailable;
    }
    return inventory.capture(identity, root.id, Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)));
  }
  function capturedQuery(request: Request, extraBodyFields: string[] = []) {
    const body = request.body;
    if (Object.keys(request.query).length || !body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(key => key !== "query" && !extraBodyFields.includes(key))
      || !body.query || typeof body.query !== "object" || Array.isArray(body.query)) {
      throw new AppError(400, "invalid_inventory_query", "Capture one bounded inventory query.");
    }
    for (const [key, value] of Object.entries(body.query)) {
      if (!filterFields.includes(key)) throw new AppError(400, "invalid_inventory_query", `Unsupported inventory query field: ${key}.`);
      scalar(value, key, facetFields.includes(key) ? 4104 : 4096);
    }
    const { limit: _limit, ...query } = unifiedAgentInventoryQuery(body.query);
    return query;
  }
  async function packageReader(request: Request, requestedMode: unknown) {
    const mode = requestedMode ?? "delegated";
    if (mode !== "delegated" && mode !== "application") throw new AppError(400, "invalid_token_mode", "Use delegated or application mode.");
    const identity = await reportIdentity(database, request.session.user!);
    let applicationScope;
    if (mode === "application") {
      await capabilities.requireApplicationDataScope("graph.package.read.application", request.session.user!);
      applicationScope = { tenantId: identity.tenantId, principalId: getTenantConfiguration(identity.tenantId).clientId };
    }
    const packages = new InventoryQueries(database, config.sessionSecret, config.officialUsageStaleDays, applicationScope,
      { source: "inventory_packages", tokenMode: mode });
    return { mode, identity, applicationScope, packages } as const;
  }
  async function capturePackages(read: Awaited<ReturnType<typeof packageReader>>, query: InventoryQuery) {
    const { identity, applicationScope, mode, packages } = read;
    const root = (await database.query(`SELECT id FROM data_scope_epochs WHERE tenant_id=$1 AND principal_id=$2
      AND source='inventory_packages' AND token_mode=$3 AND selector='complete'`,
    [identity.tenantId, applicationScope?.principalId ?? identity.principalId, mode])).rows[0];
    if (!root) throw new AppError(409, "inventory_unavailable", "Refresh the package source before reading it.");
    return packages.capture(identity, root.id, Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)), mode);
  }
  policyRoute(router, "post", "/agent-inventory/selections", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"], csrf: true,
  }, async (request, response) => {
    const query = capturedQuery(request);
    const result = await capture(await reportIdentity(database, request.session.user!), query);
    response.status("state" in result ? 200 : 201).json(result);
  });
  policyRoute(router, "post", "/agents/selections", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"], csrf: true,
  }, async (request, response) => {
    const query = capturedQuery(request, ["mode"]);
    response.status(201).json(await capturePackages(await packageReader(request, request.body.mode), query));
  });
  policyRoute(router, "post", "/agents/refresh-selection", {
    access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], csrf: true,
  }, async (request, response) => {
    const body = request.body;
    if (Object.keys(request.query).length || !body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(key => !["selectionId", "ids", "recordIds"].includes(key))) {
      throw new AppError(400, "invalid_inventory_query", "Select current inventory targets without a client-expanded target list.");
    }
    const identity = await reportIdentity(database, request.session.user!);
    response.status(202).json(await new PackageRefreshJobs(database).submitSelected(
      { tenantId: identity.tenantId, principalId: identity.principalId, tokenMode: "delegated" }, identity, {
        selectionId: scalar(body.selectionId, "selectionId", 36), ids: body.ids, recordIds: body.recordIds,
        idempotencyKey: request.get("Idempotency-Key") ?? randomUUID(),
      }));
  });
  async function selected(request: Request, dependent = false, extra: string[] = [], unfiltered = false) {
    const identity = await reportIdentity(database, request.session.user!);
    const allowed = ["selectionId", "limit", "cursor", ...extra, ...dependent ? [] : filterFields];
    for (const [key, value] of Object.entries(request.query)) {
      if (!allowed.includes(key)) throw new AppError(400, "invalid_inventory_query", `Unsupported inventory query field: ${key}.`);
      scalar(value, key, facetFields.includes(key) ? 4104 : 4096);
    }
    const query = unifiedAgentInventoryQuery(unfiltered ? {} : request.query);
    if (request.query.offset !== undefined) throw new AppError(400, "invalid_inventory_query", "Use selectionId and cursor, not offset.");
    const limit = request.query.limit === undefined ? 50 : Number(scalar(request.query.limit, "limit", 3));
    if (request.query.limit !== undefined && !/^[1-9]\d{0,2}$/.test(String(request.query.limit))
      || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, "invalid_inventory_query", "Page limit must be 1..100.");
    const cursor = request.query.cursor === undefined ? undefined : scalar(request.query.cursor, "cursor");
    let id = request.query.selectionId === undefined ? undefined : scalar(request.query.selectionId, "selectionId", 64);
    if (id && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
      || !id && dependent) throw new AppError(400, "invalid_inventory_query", "This read requires an exact inventory selection.");
    if (!id) {
      if (cursor) throw new AppError(400, "invalid_inventory_query", "A cursor requires its selection.");
      const { limit: _limit, ...filters } = query;
      const result = await capture(identity, filters);
      if ("state" in result) throw new AppError(409, "inventory_unavailable", result.message);
      id = result.id;
    }
    const expectedQuery = Object.fromEntries(Object.entries(query).filter(([key]) => filterFields.includes(key) && Object.hasOwn(request.query, key)));
    return { identity, id, options: { limit, cursor, ...dependent ? {} : { expectedQuery } } };
  }
  policyRoute(router, "get", "/agent-inventory", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const read = await selected(request);
    response.json(inventoryPresentation(await inventory.page(read.id, read.identity, read.options)));
  });
  policyRoute(router, "get", "/agent-inventory/summary", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const read = await selected(request, true);
    response.json(await inventory.summary(read.id, read.identity));
  });
  policyRoute(router, "get", "/agent-responsibility", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const query = agentResponsibilityQuery(request.query);
    const read = await selected(request, false, ["objectId"], true);
    const { sourceRows, selected: person, ...result } = await inventory.responsibility(read.id, read.identity, query);
    const sources = inventorySourceStatuses(sourceRows);
    response.json({ ...result, sources, selected: person ? { ...person,
      state: sources.powerPlatform.state === "unavailable" ? "unavailable" : person.count ? "reported" : "no_reported_relationships" } : null });
  });
  policyRoute(router, "get", "/agent-inventory/facets", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const read = await selected(request, true, ["field", "search", "selected"]);
    if (request.query.selected !== undefined && request.query.selected !== "true" && request.query.selected !== "false") {
      throw new AppError(400, "invalid_inventory_query", "Use a boolean selected facet flag.");
    }
    const field = scalar(request.query.field, "field", 32) as Parameters<InventoryQueries["facets"]>[2];
    response.json(await inventory.facets(read.id, read.identity, field, { ...read.options,
      search: request.query.search === undefined ? undefined : scalar(request.query.search, "search", 256),
      selected: request.query.selected === "true" }));
  });
  policyRoute(router, "get", "/agents/:id/detail", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    for (const key of Object.keys(request.query)) {
      if (!["selectionId", "mode"].includes(key)) throw new AppError(400, "invalid_inventory_query", `Unsupported detail field: ${key}.`);
    }
    const selectionId = scalar(request.query.selectionId, "selectionId", 36);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(selectionId)
      || request.query.mode !== undefined && !["delegated", "application"].includes(String(request.query.mode))) {
      throw new AppError(400, "invalid_inventory_query", "Use the exact saved inventory selection and token mode.");
    }
    const identity = await reportIdentity(database, request.session.user!);
    let applicationScope;
    if (request.query.mode === "application") {
      await capabilities.requireApplicationDataScope("graph.package.read.application", request.session.user!);
      applicationScope = { tenantId: identity.tenantId, principalId: getTenantConfiguration(identity.tenantId).clientId };
    }
    const selectedPackages = new InventoryQueries(database, config.sessionSecret, config.officialUsageStaleDays, applicationScope);
    response.json(await selectedPackages.packageDetail(selectionId, identity, scalar(request.params.id, "package ID", 512)));
  });
  policyRoute(router, "get", "/agent-inventory/:recordId/detail", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const read = await selected(request, true);
    const page = inventoryPresentation(await inventory.page(read.id, read.identity, {
      limit: 2, recordId: scalar(request.params.recordId, "recordId", 8192),
    }));
    if (!page.value.length) throw new AppError(404, "inventory_record_not_found", "The selected inventory record is unavailable.");
    if (page.value.length > 1 || page.page?.nextCursor) throw new AppError(409, "inventory_identity_ambiguous", "The exact source reference has multiple selected memberships.");
    const record = page.value[0], bytes = Buffer.byteLength(JSON.stringify(record));
    if (bytes > 524288) throw dataLimitError("inventory_detail_bytes", 524288, bytes);
    response.json(record);
  });
  policyRoute(router, "get", "/agent-inventory/:recordId/children", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const read = await selected(request, true, ["kind", "sourceScopeId", "sourceIdentity", "value"]);
    if (request.query.sourceScopeId !== undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(request.query.sourceScopeId))) {
      throw new AppError(400, "invalid_inventory_query", "Source scope must be a UUID.");
    }
    response.json(await inventory.children(read.id, read.identity, scalar(request.params.recordId, "recordId", 512).replace(/^agent:/, ""),
      { ...read.options, kind: scalar(request.query.kind, "kind", 128),
        sourceScopeId: request.query.sourceScopeId === undefined ? undefined : scalar(request.query.sourceScopeId, "sourceScopeId", 36),
        sourceIdentity: request.query.sourceIdentity === undefined ? undefined : scalar(request.query.sourceIdentity, "sourceIdentity", 512),
        value: request.query.value === undefined ? undefined : scalar(request.query.value, "value", 512) }));
  });
  policyRoute(router, "get", "/agent-inventory/:recordId/members", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const read = await selected(request, true);
    response.json(await inventory.members(read.id, read.identity, scalar(request.params.recordId, "recordId", 512).replace(/^agent:/, ""), read.options));
  });
  policyRoute(router, "get", "/agent-inventory/:recordId/sections", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const read = await selected(request, true, ["sourceScopeId", "sourceIdentity"]);
    const sourceScopeId = scalar(request.query.sourceScopeId, "sourceScopeId", 36);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceScopeId)) throw new AppError(400, "invalid_inventory_query", "Source scope must be a UUID.");
    response.json(await inventory.sections(read.id, read.identity, scalar(request.params.recordId, "recordId", 512).replace(/^agent:/, ""),
      { ...read.options, sourceScopeId, sourceIdentity: scalar(request.query.sourceIdentity, "sourceIdentity", 512) }));
  });
  policyRoute(router, "get", "/agents", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const allowed = ["mode", "selectionId", "cursor", "limit", ...filterFields];
    for (const [key, value] of Object.entries(request.query)) {
      if (!allowed.includes(key)) throw new AppError(400, "invalid_inventory_query", `Unsupported package query field: ${key}.`);
      scalar(value, key, facetFields.includes(key) ? 4104 : 4096);
    }
    const read = await packageReader(request, request.query.mode);
    const { mode, identity, packages } = read;
    const parsed = unifiedAgentInventoryQuery(request.query);
    const { limit: _limit, ...filters } = parsed;
    let id = request.query.selectionId === undefined ? undefined : scalar(request.query.selectionId, "selectionId", 36);
    const cursor = request.query.cursor === undefined ? undefined : scalar(request.query.cursor, "cursor");
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    if (request.query.limit !== undefined && !/^[1-9]\d{0,2}$/.test(String(request.query.limit))
      || limit > 100 || limit < 1 || !Number.isInteger(limit)
      || id !== undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
      || cursor && !id) throw new AppError(400, "invalid_inventory_query", "Use a selected package page and bounded cursor.");
    if (!id) {
      id = (await capturePackages(read, filters)).id;
    }
    const page = await packages.page(id, identity, { limit, cursor,
      expectedQuery: Object.fromEntries(Object.entries(filters).filter(([key]) => Object.hasOwn(request.query, key))) });
    response.json({ value: page.value.map(row => ({ ...row.residual, columns: row.columns, sourceIdentity: row.id })),
      selection: page.selection, counts: page.counts, page: page.page, freshness: page.freshness, mode });
  });
  return router;
}
