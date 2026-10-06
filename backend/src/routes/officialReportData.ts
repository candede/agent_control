import { Router, type Request, type RequestHandler } from "express";
import { once } from "node:events";
import { requestScope } from "../middleware/auth.js";
import { policyRoute, type RouteMethod } from "./policy.js";
import { AppError } from "../errors.js";
import { OfficialReportImports, reportUuid, type ReportConfirmation } from "../db/officialReportImports.js";
import { LargeTenantUsersReports, reportQuery, reportQueryFields } from "../services/largeTenantUsersReports.js";
import { OfficialReportExports, type OfficialExportKind } from "../services/officialReportExports.js";
import { OfficialAgentUsage } from "../services/officialAgentUsage.js";
import { officialAgentUsageMutation } from "../services/officialAgentUsageInput.js";
import { parseRecordId } from "../services/agentUsageIdentity.js";
import { canonicalQuery, SelectionError, type SelectionIdentity } from "../services/dataSelections.js";
import type { ReportUser, ReportEndpoint, ReportQuery } from "../types/officialReportData.js";
import { officialReportMultipart } from "./officialReportMultipart.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { config } from "../config.js";

export type ReportHandlerIdentity = { identity: SelectionIdentity; tokenMode: "delegated" | "application" };
export type ReportHandlerOptions = {
  reports: LargeTenantUsersReports;
  inventory?: InventoryQueries;
  identity: (request: Request) => Promise<ReportHandlerIdentity>;
  enqueueExport: (job: { id: string; identity: SelectionIdentity; kind: OfficialExportKind; producer: OfficialReportExports }) => Promise<void>;
};

function scalar(value: unknown, maximum = 4096) {
  if (typeof value !== "string" || !value || value.length > maximum || /[\0\r\n]/.test(value)) throw new AppError(400, "invalid_usage_query", "Expected one bounded scalar.");
  return value;
}
function reportIdentifier(value: unknown) {
  const id = scalar(value, 512);
  if (!id.trim()) throw new AppError(400, "invalid_usage_query", "Expected one nonblank report identity.");
  return id;
}
function pageOptions(query: Record<string, unknown>) {
  const text = query.limit === undefined ? "50" : scalar(query.limit, 3);
  if (!/^\d{1,3}$/.test(text)) throw new AppError(400, "invalid_usage_query", "Page limit must be a decimal integer.");
  const limit = Number(text);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, "invalid_usage_query", "Page limit must be 1..100.");
  return { limit, ...(query.cursor === undefined ? {} : { cursor: scalar(query.cursor) }) };
}
function requestQuery(endpoint: ReportEndpoint, query: Record<string, unknown>): ReportQuery {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (["selectionId", "cursor", "limit"].includes(key)) continue;
    if (!reportQueryFields.includes(key as typeof reportQueryFields[number])) throw new AppError(400, "invalid_usage_query", "Unsupported query parameter.");
    const text = key === "creatorType" && value === "" ? "" : scalar(value);
    values[key] = ["inactiveDays", "activityWindowDays", "lowResponseThreshold"].includes(key) ? Number(text)
      : key === "responsesOnly" ? text === "true" ? true : text === "false" ? false : text
        : (key === "company" || key === "department") ? text === "~null" ? null : text.startsWith("~string:") ? text.slice(8) : text : text;
  }
  return reportQuery(endpoint, values as ReportQuery);
}

// The app supplies identity and dispatch; authentication policy is not injectable.
export function createOfficialReportDataRouter(options: ReportHandlerOptions) {
  const identify = options.identity;
  options = { ...options, identity: async request => {
    const who = await identify(request), authorized = requestScope(request);
    if (who.identity.tenantId !== authorized.tenantId || who.identity.principalId !== authorized.principalId
      || !["delegated", "application"].includes(who.tokenMode)) throw AppError.unauthorized();
    return who;
  } };
  const router = Router(), reports = options.reports, imports = new OfficialReportImports(reports.database), usage = new OfficialAgentUsage(reports);
  const inventoryUsage = new OfficialAgentUsage(reports, options.inventory ?? new InventoryQueries(reports.database,
    config.sessionSecret, reports.staleAfterDays, undefined, { source: "inventory_canonical", tokenMode: "delegated" }));
  router.use((_request, response, next) => { response.setHeader("Cache-Control", "private, no-store"); next(); });
  const route = (method: RouteMethod, path: string, access: "read" | "admin", ...handlers: RequestHandler[]) => {
    const dataClass = path.startsWith("/copilot-usage/") ? "licensed_copilot_usage"
      : path.startsWith("/data-exports") ? "data_export"
        : path.startsWith("/agent-inventory/") ? path.endsWith("/usage-candidates") ? "official_usage_association_candidates" : "official_usage_association"
          : path.startsWith("/official-usage/history") ? "official_usage_history"
            : path.startsWith("/official-usage/overview") ? "official_usage_overview"
              : path.startsWith("/official-usage/aggregate") ? "official_usage_aggregate"
                : /^\/official-usage\/(?:staging|bundles)(?:\/|$)/.test(path) ? "official_usage_import"
                  : /^\/official-usage\/(?:sets|confirmations)\//.test(path) ? "official_usage_metadata" : "official_usage_user";
    policyRoute(router, method, path, { access: "authenticated", dataClass,
      roles: [access === "read" ? "AgentControl.Viewer" : "AgentControl.Admin"], ...(method === "get" ? {} : { csrf: true }) }, ...handlers);
  };
  const failSafe = (handler: RequestHandler): RequestHandler => async (request, response, next) => {
    try { response.setHeader("Cache-Control", "private, no-store"); await handler(request, response, next); }
    catch (error) {
      const known: Record<string, number> = { export_not_found: 404, export_expired: 409, export_not_ready: 409, export_not_queued: 409, export_fenced: 409 };
      const mapped = error instanceof Error && Object.hasOwn(known, error.message) ? new AppError(known[error.message], error.message, "Export is unavailable.") : error;
      if (response.headersSent) response.destroy(mapped instanceof Error ? mapped : undefined); else next(mapped);
    }
  };
  async function selected(request: Request, endpoint: ReportEndpoint, facet = false, candidate = false, child = false, localReport = false) {
    pageOptions(request.query);
    const who = await options.identity(request);
    const raw = { ...request.query };
    if (localReport && (raw.selectionId !== undefined || raw.cursor !== undefined)) delete raw.setId;
    if (facet) { delete raw.search; delete raw.field; }
    if (candidate) delete raw.inventoryRevision;
    let childQuery: ReportQuery | undefined;
    if (child) {
      const { setId: _setId, ...filters } = raw;
      childQuery = requestQuery("relationships", filters);
      for (const key of reportQueryFields) if (key !== "setId") delete raw[key];
    }
    const query = requestQuery(endpoint, raw);
    let selection = request.query.selectionId;
    if (selection === undefined && request.query.cursor !== undefined) {
      try { selection = JSON.parse(Buffer.from(scalar(request.query.cursor).split(".")[0], "base64url").toString()).selectionId; reportUuid(selection); }
      catch { throw new SelectionError("invalid_cursor"); }
    }
    const id = selection === undefined ? (await reports.capture(who.identity, who.tokenMode, endpoint, query)).id : reportUuid(selection);
    if (selection !== undefined) await reports.read(id, who.identity, async (_client, context) => {
      if (context.endpoint !== endpoint) throw new AppError(400, "invalid_cursor", "Selection endpoint mismatch.");
      const keys = Object.keys(raw).filter(key => reportQueryFields.includes(key as typeof reportQueryFields[number]));
      const mismatch = child
        ? query.setId !== undefined && query.setId.toLowerCase() !== context.report.setId?.toLowerCase()
        : keys.length > 0 && canonicalQuery(query, reportQueryFields) !== context.queryHash;
      if (mismatch) throw new AppError(400, "invalid_cursor", "Selection filters are immutable.");
    });
    return { ...who, id, childQuery };
  }
  async function selectedAgentUsage(request: Request, users = false) {
    const setId = request.query.setId === undefined ? undefined : reportUuid(request.query.setId);
    if (request.query.inventorySelectionId === undefined) return { ...await selected(request, "official_agents", false, false, users, true), reader: usage, setId };
    const allowed = ["inventorySelectionId", "selectionId", "cursor", "limit", "setId", ...(users ? ["search"] : [])];
    if (Object.keys(request.query).some(key => !allowed.includes(key))) throw new AppError(400, "invalid_usage_query", "Unsupported selected inventory usage query.");
    pageOptions(request.query);
    const who = await options.identity(request), id = reportUuid(request.query.inventorySelectionId);
    if (who.tokenMode !== "delegated") throw new AppError(403, "agent_usage_scope_unavailable", "Agent usage requires delegated inventory.");
    if (request.query.selectionId !== undefined && reportUuid(request.query.selectionId) !== id) throw new SelectionError("invalid_cursor");
    const childQuery = users ? requestQuery("relationships", request.query.search === undefined ? {} : { search: request.query.search }) : undefined;
    return { ...who, id, childQuery, reader: inventoryUsage, setId };
  }
  const lists: Array<[string, ReportEndpoint]> = [
    ["/copilot-usage/users", "copilot_users"], ["/official-usage/aggregate", "official_agents"], ["/official-usage/users", "official_users"],
    ["/official-usage/agent-users", "relationships"], ["/official-usage/history", "history"], ["/official-usage/overview", "overview"],
  ];
  route("get", "/official-usage/history/options", "read", failSafe(async (request, response) => {
    const context = await selected(request, "history");
    response.json(await reports.historyOptions(context.id, context.identity, pageOptions(request.query)));
  }));
  for (const [path, endpoint] of lists) route("get", path, "read", failSafe(async (request, response) => {
    const context = await selected(request, endpoint); response.json(await reports.page(context.id, context.identity, pageOptions(request.query)));
  }));
  for (const [path, endpoint] of lists.filter(([, endpoint]) => ["copilot_users", "official_users", "official_agents"].includes(endpoint))) {
    route("get", `${path}/facets`, "read", failSafe(async (request, response) => {
      const context = await selected(request, endpoint, true);
      response.json(await reports.facets(context.id, context.identity, { ...pageOptions(request.query),
        field: scalar(request.query.field) as "company" | "department" | "creatorType",
        ...(request.query.search === undefined ? {} : { search: scalar(request.query.search, 256) }) }));
    }));
  }
  route("get", "/copilot-usage/users/unresolved-identities", "read", failSafe(async (request, response) => {
    const context = await selected(request, "copilot_users");
    response.json(await reports.page(context.id, context.identity, { ...pageOptions(request.query), endpoint: "unresolved" }));
  }));
  route("get", "/copilot-usage/users/:objectId", "read", failSafe(async (request, response) => {
    const context = await selected(request, "copilot_users");
    response.json(await reports.exact(context.id, context.identity, reportUuid(request.params.objectId)));
  }));
  route("get", "/copilot-usage/users/:objectId/service-plans", "read", failSafe(async (request, response) => {
    const context = await selected(request, "copilot_users"), child = reportUuid(request.params.objectId);
    await reports.exact(context.id, context.identity, child);
    response.json(await reports.page(context.id, context.identity, { ...pageOptions(request.query), endpoint: "plans", child }));
  }));
  route("get", "/official-usage/agents/:agentId", "read", failSafe(async (request, response) => {
    const id = reportIdentifier(request.params.agentId);
    const context = await selected(request, "official_agents");
    response.json(await reports.exact(context.id, context.identity, id));
  }));
  route("get", "/official-usage/users/:username", "read", failSafe(async (request, response) => {
    const id = reportIdentifier(request.params.username);
    const context = await selected(request, "official_users");
    response.json(await reports.exact(context.id, context.identity, id));
  }));
  for (const child of ["directory", "service-plans"] as const) {
    route("get", `/official-usage/users/:username/${child}`, "read", failSafe(async (request, response) => {
      const id = reportIdentifier(request.params.username);
      const context = await selected(request, "official_users");
      const detail = await reports.exact(context.id, context.identity, id);
      const user = detail.value as ReportUser;
      if (!user.objectId) throw new AppError(404, "data_record_not_found", "No exact directory identity is linked.");
      if (child === "service-plans") response.json(await reports.page(context.id, context.identity, {
        ...pageOptions(request.query), endpoint: "plans", child: user.objectId,
      }));
      else response.json(await reports.read(context.id, context.identity, async (client, read) => {
        const row = await reports.rowsInRead(client, read, { endpoint: "copilot_users", exactIds: [user.objectId!], limit: 1 });
        if (!row.value.length) throw new AppError(404, "data_record_not_found", "Exact directory identity is unavailable.");
        return { ...detail, value: row.value[0] };
      }));
    }));
  }
  route("get", "/copilot-usage/users/:objectId/agents", "read", failSafe(async (request, response) => {
    const context = await selected(request, "copilot_users", false, false, true);
    const objectId = reportUuid(request.params.objectId);
    response.json(await reports.read(context.id, context.identity, async (client, read) => {
      await reports.exactInRead(client, read, objectId);
      return reports.pageInRead(client, read, { ...pageOptions(request.query), endpoint: "relationships",
        child: objectId, childQuery: context.childQuery });
    }));
  }));
  route("get", "/official-usage/history/:setId/observations", "read", failSafe(async (request, response) => {
    const context = await selected(request, "history"), child = reportUuid(request.params.setId);
    await reports.exact(context.id, context.identity, child);
    response.json(await reports.page(context.id, context.identity, { ...pageOptions(request.query), endpoint: "observations", child }));
  }));
  for (const [path, endpoint, parameter] of [
    ["/official-usage/agents/:agentId/users", "official_agents", "agentId"],
    ["/official-usage/users/:username/agents", "official_users", "username"],
  ] as const) route("get", path, "read", failSafe(async (request, response) => {
    const child = reportIdentifier(request.params[parameter]), context = await selected(request, endpoint, false, false, true);
    await reports.exact(context.id, context.identity, child);
    response.json(await reports.page(context.id, context.identity, { ...pageOptions(request.query), endpoint: "relationships", child,
      childQuery: context.childQuery }));
  }));

  route("post", "/official-usage/staging", "admin",
    officialReportMultipart(imports, async request => (await options.identity(request)).identity));
  route("get", "/official-usage/staging/:id", "admin", failSafe(async (request, response) => {
    response.json(await imports.preview((await options.identity(request)).identity, reportUuid(request.params.id)));
  }));
  route("post", "/official-usage/bundles/:id/preview", "admin", failSafe(async (request, response) => {
    response.json(await imports.bundle((await options.identity(request)).identity, reportUuid(request.params.id)));
  }));
  route("post", "/official-usage/bundles/:id/accept", "admin", failSafe(async (request, response) => {
    response.json(await imports.acceptBundle((await options.identity(request)).identity, reportUuid(request.params.id), request.body));
  }));
  route("post", "/official-usage/staging/:id/accept", "admin", failSafe(async (request, response) => {
    response.json(await imports.accept((await options.identity(request)).identity, { ...request.body, stagingId: reportUuid(request.params.id) }));
  }));
  route("delete", "/official-usage/staging/:id", "admin", failSafe(async (request, response) => {
    const who = await options.identity(request);
    const id = reportUuid(request.params.id);
    await imports.discard(who.identity, id);
    response.status(204).end();
  }));
  route("get", "/official-usage/staging/:id/diagnostics", "admin", failSafe(async (request, response) => {
    response.json(await imports.diagnostics((await options.identity(request)).identity, reportUuid(request.params.id), pageOptions(request.query), reports.codec));
  }));
  route("post", "/official-usage/sets/:id/preview", "admin", failSafe(async (request, response) => {
    response.json(await imports.confirmPreview((await options.identity(request)).identity, reportUuid(request.params.id), request.body?.operation));
  }));
  route("post", "/official-usage/confirmations/:id", "admin", failSafe(async (request, response) => {
    if (request.body?.id !== request.params.id) throw new AppError(400, "invalid_identifier", "Confirmation ID mismatch.");
    response.json(await imports.confirm((await options.identity(request)).identity, request.body as ReportConfirmation));
  }));
  route("get", "/agent-inventory/:recordId/usage", "read", failSafe(async (request, response) => {
    const recordId = scalar(request.params.recordId, 10000); parseRecordId(recordId);
    const who = await selectedAgentUsage(request);
    response.json((await who.reader.summaries(who.id, who.identity, [recordId], who.setId))[0]);
  }));
  route("get", "/agent-inventory/:recordId/usage-history", "read", failSafe(async (request, response) => {
    if (Object.keys(request.query).some(key => !["inventorySelectionId", "selectionId", "cursor", "limit"].includes(key))) {
      throw new AppError(400, "invalid_usage_query", "Unsupported agent history query parameter.");
    }
    const recordId = scalar(request.params.recordId, 10000); parseRecordId(recordId);
    const who = await selectedAgentUsage(request);
    response.json(await who.reader.history(who.id, who.identity, recordId, pageOptions(request.query)));
  }));
  route("get", "/agent-inventory/:recordId/usage-candidates", "admin", failSafe(async (request, response) => {
    const recordId = scalar(request.params.recordId, 10000); parseRecordId(recordId);
    const inventoryRevision = request.query.inventoryRevision === undefined ? undefined : scalar(request.query.inventoryRevision, 64);
    if (inventoryRevision !== undefined && !/^[a-f0-9]{64}$/.test(inventoryRevision)) throw new AppError(400, "invalid_usage_query", "Invalid inventory revision.");
    const who = await selected(request, "official_agents", false, true);
    response.json(await usage.candidates(who.id, who.identity, recordId, { ...pageOptions(request.query),
      ...(inventoryRevision ? { inventoryRevision } : {}) }));
  }));
  route("get", "/agent-inventory/:recordId/usage-associations", "read", failSafe(async (request, response) => {
    const recordId = scalar(request.params.recordId, 10000); parseRecordId(recordId);
    const who = await selectedAgentUsage(request);
    response.json(await who.reader.associations(who.id, who.identity, recordId,
      { ...pageOptions(request.query), ...(who.setId ? { setId: who.setId } : {}) }));
  }));
  route("get", "/agent-inventory/:recordId/usage-users", "read", failSafe(async (request, response) => {
    if (Object.keys(request.query).some(key => !["inventorySelectionId", "selectionId", "cursor", "limit", "search", "setId"].includes(key))) {
      throw new AppError(400, "invalid_usage_query", "Unsupported agent users query parameter.");
    }
    const recordId = scalar(request.params.recordId, 10000); parseRecordId(recordId);
    const who = await selectedAgentUsage(request, true);
    response.json(await who.reader.users(who.id, who.identity, recordId, { ...pageOptions(request.query), search: who.childQuery?.search,
      ...(who.setId ? { setId: who.setId } : {}) }));
  }));
  for (const method of ["post", "delete"] as const) route(method, "/agent-inventory/:recordId/usage-associations", "admin", failSafe(async (request, response) => {
    const input = officialAgentUsageMutation(request.body);
    if (Object.keys(request.query).some(key => key !== "inventorySelectionId") || method === "post" && !input.target || method === "delete" && input.target) throw new AppError(400, "invalid_agent_usage", "Association action mismatch.");
    const inventoryId = request.query.inventorySelectionId === undefined ? undefined : reportUuid(request.query.inventorySelectionId);
    if (inventoryId && (method !== "delete" || inventoryId !== input.selectionId)) throw new SelectionError("invalid_cursor");
    const recordId = scalar(request.params.recordId, 10000); parseRecordId(recordId);
    response.json(await (inventoryId ? inventoryUsage : usage).mutate((await options.identity(request)).identity, recordId, input, request.session.user!));
  }));
  const producer = (request: Request) => new OfficialReportExports(reports, request.session.user!);
  route("post", "/data-exports", "read", failSafe(async (request, response) => {
    const who = await options.identity(request), exports = producer(request);
    const id = await exports.create(who.identity, request.body);
    try { await options.enqueueExport({ id, identity: who.identity, kind: request.body.kind, producer: exports }); }
    catch (error) { await exports.engine.cancel(id, who.identity); throw error; }
    response.status(202).json({ id });
  }));
  route("get", "/data-exports/:id", "read", failSafe(async (request, response) => {
    response.json(await producer(request).status(reportUuid(request.params.id), (await options.identity(request)).identity));
  }));
  route("delete", "/data-exports/:id", "read", failSafe(async (request, response) => {
    await producer(request).engine.cancel(reportUuid(request.params.id), (await options.identity(request)).identity); response.status(204).end();
  }));
  route("get", "/data-exports/:id/download", "read", failSafe(async (request, response) => {
    const who = await options.identity(request), exports = producer(request), id = reportUuid(request.params.id);
    const status = await exports.engine.status(id, who.identity);
    if (status.status !== "ready") throw new AppError(409, "export_not_ready", "Export is not ready.");
    const filename = await exports.engine.connections.selectedRead(async client => {
      const row = (await client.query("SELECT selection_id,filename FROM data_exports WHERE id=$1 AND tenant_id=$2 AND principal_id=$3",
        [id, who.identity.tenantId, who.identity.principalId])).rows[0];
      if (!row) throw new AppError(404, "export_not_found", "Export is unavailable.");
      await exports.engine.selections.assert(client, row.selection_id, who.identity, id);
      return row.filename as string;
    });
    response.set(exports.engine.downloadHeaders(filename, status.bytes));
    const controller = new AbortController(), abort = () => { if (!response.writableFinished) controller.abort(); };
    response.once("close", abort);
    try {
      let finalChunk: Buffer | undefined;
      for await (const bytes of exports.engine.download(id, who.identity, controller.signal)) {
        if (finalChunk && !response.write(finalChunk)) await once(response, "drain", { signal: controller.signal });
        finalChunk = bytes;
      }
      // Do not satisfy Content-Length until the final checksum, authority and audit checks succeed.
      controller.signal.throwIfAborted();
      response.end(finalChunk);
    } catch (error) {
      if (!response.headersSent) {
        for (const header of ["Content-Disposition", "Content-Length", "Content-Type"]) response.removeHeader(header);
      }
      throw error;
    } finally { response.removeListener("close", abort); }
  }));
  return router;
}
