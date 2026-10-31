import { requestUser } from "../middleware/requestAuthentication.js";
import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { config, getTenantConfiguration } from "../config.js";
import { InventoryQueries, type InventoryQuery } from "../db/inventoryQueries.js";
import type { SelectionIdentity } from "../services/dataSelections.js";
import { AppError, errorTelemetry } from "../errors.js";
import { reportIdentity } from "../services/reportIdentity.js";
import { policyRoute } from "./policy.js";
import { agentResponsibilityQuery, unifiedAgentInventoryQuery } from "./unifiedAgents.js";
import { inventoryPresentation, inventorySourceStatuses } from "../services/inventoryPresentation.js";
import { dataLimitError } from "../db/dataBounds.js";
import { capabilities } from "../services/capabilities.js";
import { randomUUID } from "node:crypto";
import { PackageRefreshJobs } from "../db/packageRefreshJobs.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { requestScope } from "../middleware/auth.js";
import { requireProviderAdmissions } from "../services/operationalState.js";
import type { UnifiedAgentInventoryHealth, UnifiedAgentInventoryUnavailable } from "../types/unifiedAgents.js";
import { hasAppRole } from "../types/capability.js";
import { operationalLog } from "../services/telemetry.js";

function scalar(value: unknown, name: string, maximum = 4096) {
  if (typeof value !== "string" || !value || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new AppError(400, "invalid_inventory_query", `Use one bounded ${name}.`);
  }
  return value;
}

function searchScalar(value: unknown) {
  return value === "" ? value : scalar(value, "search", 256);
}

function inventoryPublication(request: Request, response: Response) {
  const scope = requestScope(request);
  const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
  return (value: unknown, status = 200) => {
    assertAccountSessionValidation(validation);
    const currentScope = requestScope(request);
    if (currentScope.tenantId !== scope.tenantId || currentScope.principalId !== scope.principalId
      || !hasAppRole(requestUser(request).roles, "AgentControl.Viewer")) {
      throw AppError.unauthorized();
    }
    response.status(status).json(value);
  };
}

export function createInventoryDataRouter(database: pg.Pool) {
  const router = Router();
  const inventory = new InventoryQueries(database, config.sessionSecret, config.officialUsageStaleDays,
    { source: "inventory_canonical" });
  const filterFields = ["setId", "inventoryScope", "type", "view", "endUserAccess", "reportedUsage", "management", "relevance", "recordId",
    "operationIdPrefix", "search", "source", "linkState", "environmentId", "blocked", "publisher", "availableTo", "host", "platform",
    "createdWithinDays", "sortBy", "sortDirection"];
  const queryFieldMaximums: Record<string, number> = {
    recordId: 10_000, type: 4104, publisher: 4104, availableTo: 4104, host: 4104, platform: 4104,
  };
  async function capture(identity: SelectionIdentity, query: InventoryQuery) {
    const root = (await database.query(`SELECT s.id,EXISTS(SELECT 1 FROM inventory_roots r
      JOIN inventory_revisions v ON v.scope_id=r.scope_id AND v.revision=r.revision
      JOIN data_generations g ON g.id=v.generation_id
      WHERE r.scope_id=s.id AND r.current AND g.state='published' AND g.validated
        AND g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch) AS published,
      EXISTS(SELECT 1 FROM inventory_roots r WHERE r.scope_id=s.id) OR
        s.epoch>0 AS previously_published,
      EXISTS(SELECT 1 FROM inventory_reconciliation work WHERE work.scope_id=s.id
        AND (work.status='running' AND work.active_until>clock_timestamp()
          OR work.status IN ('idle','catching_up') AND work.pending_inputs IS NOT NULL AND work.pending_deadline>clock_timestamp())) AS preparing
      FROM data_scope_epochs s
      WHERE s.tenant_id=$1 AND s.scope_kind='tenant' AND s.source='inventory_canonical'
        AND s.token_mode='tenant' AND s.selector='complete'`, [identity.tenantId])).rows[0];
    if (!root || !root.published) {
      const unavailable: UnifiedAgentInventoryUnavailable = root?.preparing
        ? { state: "preparing", message: "Synced agents are being published to the inventory. Results will appear automatically." }
        : root?.previously_published
          ? { state: "unavailable", message: "The saved agent inventory is no longer available. Reload saved data or open Sync to collect a new inventory." }
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
      scalar(value, key, queryFieldMaximums[key]);
    }
    const { limit: _limit, ...query } = unifiedAgentInventoryQuery(body.query);
    return query;
  }
  async function packageReader(request: Request) {
    const identity = await reportIdentity(database, requestUser(request));
    const packages = new InventoryQueries(database, config.sessionSecret, config.officialUsageStaleDays,
      { source: "inventory_packages" });
    return { identity, packages };
  }
  async function capturePackages(read: Awaited<ReturnType<typeof packageReader>>, query: InventoryQuery) {
    const { identity, packages } = read;
    const root = (await database.query(`SELECT id FROM data_scope_epochs WHERE tenant_id=$1 AND scope_kind='tenant'
      AND source='inventory_packages' AND token_mode='tenant' AND selector='complete'`,
    [identity.tenantId])).rows[0];
    if (!root) throw new AppError(409, "inventory_unavailable", "Refresh the package source before reading it.");
    return packages.capture(identity, root.id, Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)));
  }
  policyRoute(router, "post", "/agent-inventory/selections", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"], csrf: true,
  }, async (request, response) => {
    const publish = inventoryPublication(request, response);
    const query = capturedQuery(request);
    const result = await capture(await reportIdentity(database, requestUser(request)), query);
    publish(result, "state" in result ? 200 : 201);
  });
  policyRoute(router, "get", "/agent-inventory/health", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const publish = inventoryPublication(request, response);
    if (Object.keys(request.query).length) throw new AppError(400, "invalid_inventory_query", "Workspace health does not accept selection IDs or filters.");
    const identity = await reportIdentity(database, requestUser(request));
    const selected = await capture(identity, {});
    response.setHeader("Cache-Control", "no-store");
    if ("state" in selected) { publish(selected); return; }
    let receipt: UnifiedAgentInventoryHealth;
    let readFailed = false;
    try {
      const { freshness, summary, verification, identityCollection, sources, partial, errors } =
        inventoryPresentation(await inventory.page(selected.id, identity, { limit: 1 }));
      receipt = { freshness, summary, verification, identityCollection, sources, partial, errors };
    } catch (error) {
      readFailed = true;
      throw error;
    } finally {
      try { await inventory.selections.invalidate(selected.id, identity); }
      catch (error) {
        if (!readFailed) throw error;
        operationalLog("error", "inventory_health_cleanup_failed", errorTelemetry(error));
      }
    }
    publish(receipt);
  });
  policyRoute(router, "post", "/agents/selections", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"], csrf: true,
  }, async (request, response) => {
    const publish = inventoryPublication(request, response);
    const query = capturedQuery(request);
    publish(await capturePackages(await packageReader(request), query), 201);
  });
  policyRoute(router, "post", "/agents/refresh-selection", {
    access: "authenticated", dataClass: "private_inventory_job", roles: ["AgentControl.Viewer"], csrf: true,
  }, async (request, response) => {
    const publish = inventoryPublication(request, response);
    const body = request.body;
    if (Object.keys(request.query).length || !body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(key => !["selectionId", "ids", "recordIds"].includes(key))) {
      throw new AppError(400, "invalid_inventory_query", "Select current inventory targets without a client-expanded target list.");
    }
    const user = requestUser(request), owner = requestScope(request);
    const validation = beginAccountSessionValidation(owner.tenantId, owner.principalId);
    const validateCapability = capabilities.beginOperationValidation("graph.package.read.application", user);
    const assertCurrent = () => {
      assertAccountSessionValidation(validation);
      validateCapability();
      requireProviderAdmissions();
    };
    assertCurrent();
    const identity = await reportIdentity(database, requestUser(request));
    assertCurrent();
    const job = await commitAccountSessionValidation(validation, () => new PackageRefreshJobs(database).submitSelected(
      { tenantId: identity.tenantId, principalId: getTenantConfiguration(identity.tenantId).clientId, tokenMode: "application" }, identity, {
        selectionId: scalar(body.selectionId, "selectionId", 36), ids: body.ids, recordIds: body.recordIds,
        idempotencyKey: request.get("Idempotency-Key") ?? randomUUID(),
      }, assertCurrent));
    assertCurrent();
    publish(job, 202);
  });
  async function selected(request: Request, dependent = false, extra: string[] = [], unfiltered = false) {
    const identity = await reportIdentity(database, requestUser(request));
    const allowed = ["selectionId", "limit", "cursor", ...extra, ...dependent ? [] : filterFields];
    for (const [key, value] of Object.entries(request.query)) {
      if (!allowed.includes(key)) throw new AppError(400, "invalid_inventory_query", `Unsupported inventory query field: ${key}.`);
      if (key === "search" && (dependent || unfiltered)) searchScalar(value);
      else scalar(value, key, queryFieldMaximums[key]);
    }
    // Responsibility pages always order/search people; their capture owns that dependency.
    const query = unifiedAgentInventoryQuery(unfiltered ? { sortBy: "owner" } : dependent ? {} : request.query);
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
    const publish = inventoryPublication(request, response);
    const read = await selected(request);
    publish(inventoryPresentation(await inventory.page(read.id, read.identity, read.options)));
  });
  policyRoute(router, "get", "/agent-inventory/summary", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const publish = inventoryPublication(request, response);
    const read = await selected(request, true);
    publish(await inventory.summary(read.id, read.identity));
  });
  policyRoute(router, "get", "/agent-responsibility", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const publish = inventoryPublication(request, response);
    const query = agentResponsibilityQuery(request.query);
    const read = await selected(request, false, ["objectId"], true);
    const { sourceRows, selected: person, ...result } = await inventory.responsibility(read.id, read.identity, query);
    const sources = inventorySourceStatuses(sourceRows, result.selection.evaluatedAt);
    publish({ ...result, sources, selected: person ? { ...person,
      state: sources.powerPlatform.state === "unavailable" ? "unavailable" : person.count ? "reported" : "no_reported_relationships" } : null });
  });
  policyRoute(router, "get", "/agent-inventory/facets", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const publish = inventoryPublication(request, response);
    const read = await selected(request, true, ["field", "search", "selected"]);
    if (request.query.selected !== undefined && request.query.selected !== "true" && request.query.selected !== "false") {
      throw new AppError(400, "invalid_inventory_query", "Use a boolean selected facet flag.");
    }
    const field = scalar(request.query.field, "field", 32) as Parameters<InventoryQueries["facets"]>[2];
    publish(await inventory.facets(read.id, read.identity, field, { ...read.options,
      search: request.query.search === undefined ? undefined : searchScalar(request.query.search),
      selected: request.query.selected === "true" }));
  });
  policyRoute(router, "get", "/agents/:id/detail", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const publish = inventoryPublication(request, response);
    for (const key of Object.keys(request.query)) {
      if (key !== "selectionId") throw new AppError(400, "invalid_inventory_query", `Unsupported detail field: ${key}.`);
    }
    const selectionId = scalar(request.query.selectionId, "selectionId", 36);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(selectionId)) {
      throw new AppError(400, "invalid_inventory_query", "Use the exact saved inventory selection.");
    }
    const identity = await reportIdentity(database, requestUser(request));
    const selectedPackages = new InventoryQueries(database, config.sessionSecret, config.officialUsageStaleDays);
    publish(await selectedPackages.packageDetail(selectionId, identity, scalar(request.params.id, "package ID", 512)));
  });
  policyRoute(router, "get", "/agent-inventory/:recordId/detail", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const publish = inventoryPublication(request, response);
    const read = await selected(request, true);
    const page = inventoryPresentation(await inventory.page(read.id, read.identity, {
      limit: 2, recordId: scalar(request.params.recordId, "recordId", queryFieldMaximums.recordId),
    }));
    if (!page.value.length) throw new AppError(404, "inventory_record_not_found", "The selected inventory record is unavailable.");
    if (page.value.length > 1 || page.page?.nextCursor) throw new AppError(409, "inventory_identity_ambiguous", "The exact source reference has multiple selected memberships.");
    const record = page.value[0], bytes = Buffer.byteLength(JSON.stringify(record));
    if (bytes > 524288) throw dataLimitError("inventory_detail_bytes", 524288, bytes);
    publish(record);
  });
  policyRoute(router, "get", "/agent-inventory/:recordId/children", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const publish = inventoryPublication(request, response);
    const read = await selected(request, true, ["kind", "sourceScopeId", "sourceIdentity", "value"]);
    if (request.query.sourceScopeId !== undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(request.query.sourceScopeId))) {
      throw new AppError(400, "invalid_inventory_query", "Source scope must be a UUID.");
    }
    publish(await inventory.children(read.id, read.identity, scalar(request.params.recordId, "recordId", 512).replace(/^agent:/, ""),
      { ...read.options, kind: scalar(request.query.kind, "kind", 128),
        sourceScopeId: request.query.sourceScopeId === undefined ? undefined : scalar(request.query.sourceScopeId, "sourceScopeId", 36),
        sourceIdentity: request.query.sourceIdentity === undefined ? undefined : scalar(request.query.sourceIdentity, "sourceIdentity", 512),
        value: request.query.value === undefined ? undefined : scalar(request.query.value, "value", 512) }));
  });
  policyRoute(router, "get", "/agent-inventory/:recordId/members", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const publish = inventoryPublication(request, response);
    const read = await selected(request, true);
    publish(await inventory.members(read.id, read.identity, scalar(request.params.recordId, "recordId", 512).replace(/^agent:/, ""), read.options));
  });
  policyRoute(router, "get", "/agent-inventory/:recordId/sections", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const publish = inventoryPublication(request, response);
    const read = await selected(request, true, ["sourceScopeId", "sourceIdentity"]);
    const sourceScopeId = scalar(request.query.sourceScopeId, "sourceScopeId", 36);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceScopeId)) throw new AppError(400, "invalid_inventory_query", "Source scope must be a UUID.");
    publish(await inventory.sections(read.id, read.identity, scalar(request.params.recordId, "recordId", 512).replace(/^agent:/, ""),
      { ...read.options, sourceScopeId, sourceIdentity: scalar(request.query.sourceIdentity, "sourceIdentity", 512) }));
  });
  policyRoute(router, "get", "/agent-inventory/:recordId/about", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const publish = inventoryPublication(request, response);
    const read = await selected(request, true, ["sourceScopeId", "sourceIdentity", "field"]);
    const sourceScopeId = scalar(request.query.sourceScopeId, "sourceScopeId", 36);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceScopeId)) throw new AppError(400, "invalid_inventory_query", "Source scope must be a UUID.");
    const field = scalar(request.query.field, "field", 16);
    if (field !== "long" && field !== "short" && field !== "native") throw new AppError(400, "invalid_inventory_query", "Use long, native or short About text.");
    publish(await inventory.about(read.id, read.identity, scalar(request.params.recordId, "recordId", 512).replace(/^agent:/, ""),
      { sourceScopeId, sourceIdentity: scalar(request.query.sourceIdentity, "sourceIdentity", 512), field, cursor: read.options.cursor }));
  });
  policyRoute(router, "get", "/agents", {
    access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    const publish = inventoryPublication(request, response);
    const allowed = ["selectionId", "cursor", "limit", ...filterFields];
    for (const [key, value] of Object.entries(request.query)) {
      if (!allowed.includes(key)) throw new AppError(400, "invalid_inventory_query", `Unsupported package query field: ${key}.`);
      scalar(value, key, queryFieldMaximums[key]);
    }
    const read = await packageReader(request);
    const { identity, packages } = read;
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
    publish({ value: page.value.map(row => ({ ...row.residual, columns: row.columns, sourceIdentity: row.id })),
      selection: page.selection, counts: page.counts, page: page.page, freshness: page.freshness });
  });
  return router;
}
