import { Router, type Request, type RequestHandler } from "express";
import { AppError } from "../errors.js";
import { requestScope } from "../middleware/auth.js";
import { requestUser } from "../middleware/requestAuthentication.js";
import { reportIdentity } from "../services/reportIdentity.js";
import { officeQuery, officeQueryFields } from "../services/officeAppAdoption.js";
import { OfficeAppAdoptionReads, type OfficePaging } from "../services/officeAppAdoptionReads.js";
import type { SelectionIdentity } from "../services/dataSelections.js";
import type { OfficeQuery } from "../types/officeAppAdoption.js";
import { policyRoute } from "./policy.js";

function scalar(value: unknown, maximum = 4096, literalFacet = false) {
  const invalidText = literalFacet ? /[\0\r\n\p{Cs}]/u : /[\p{Cc}\p{Cs}]/u;
  if (typeof value !== "string" || !value || value.length>maximum || invalidText.test(value)) {
    throw new AppError(400, "invalid_office_query", "Expected one bounded scalar.");
  }
  return value;
}
export function officeRequestQuery(raw: Record<string, unknown>, paging = false, facet = false) {
  const query: Record<string, string | null> = {};
  const allowed = [...officeQueryFields, "selectionId", ...(paging ? ["limit", "cursor", "pageNumber", "anchor"] : []), ...(facet ? ["kind"] : [])];
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.includes(key)) throw new AppError(400, "invalid_office_query", "Unsupported Office query parameter.");
    if (!officeQueryFields.includes(key as typeof officeQueryFields[number])) continue;
    const literalFacet = ["company","department"].includes(key);
    const text = scalar(value, literalFacet ? 264 : 256, literalFacet);
    query[key] = literalFacet ? text === "~null" ? null : text.startsWith("~string:") ? text.slice(8) : text : text;
  }
  const options: OfficePaging = {};
  if (raw.limit !== undefined) {
    const text = scalar(raw.limit, 3);
    if (!/^\d{1,3}$/.test(text) || Number(text)<1 || Number(text)>100) throw new AppError(400, "invalid_office_query", "Page limit must be 1..100.");
    options.limit = Number(text);
  }
  if (raw.pageNumber !== undefined) {
    const text = scalar(raw.pageNumber, 16);
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new AppError(400, "invalid_office_query", "Page number must be a positive safe integer.");
    options.pageNumber = Number(text);
  }
  if (raw.cursor !== undefined) options.cursor = scalar(raw.cursor);
  if (raw.anchor !== undefined) options.anchor = scalar(raw.anchor, 64);
  const selectionId = raw.selectionId === undefined ? undefined : scalar(raw.selectionId, 36);
  if (selectionId && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(selectionId)) {
    throw new AppError(400,"invalid_office_query","Expected a selected-read UUID.");
  }
  if ((options.cursor || options.anchor) && !selectionId) throw new AppError(400,"invalid_office_query","Cursors and anchors require the same selected read.");
  return { query: officeQuery(query as OfficeQuery), selectionId, options };
}
export function createOfficeAppAdoptionRouter(reads: OfficeAppAdoptionReads,
  identify: (request: Request) => Promise<SelectionIdentity> = request => reportIdentity(reads.database, requestUser(request))) {
  const router = Router();
  const route = (path: string, handler: RequestHandler) => policyRoute(router, "get", `/office-app-adoption${path}`,
    { access: "authenticated", dataClass: "office_app_adoption", roles: ["AgentControl.Viewer"] },
    async (request, response, next) => {
      try {
        response.setHeader("Cache-Control","private, no-store");
        const identity = await identify(request), scope = requestScope(request);
        if (identity.tenantId!==scope.tenantId || identity.principalId!==scope.principalId) throw AppError.unauthorized();
        response.locals.officeIdentity = identity;
        await handler(request,response,next);
      } catch (error) { next(error); }
    });
  route("/context", async (request,response) => {
    const { query,selectionId } = officeRequestQuery(request.query);
    response.json(await reads.context(response.locals.officeIdentity,query,selectionId));
  });
  for (const path of ["/summary","/comparison"]) route(path, async (request,response) => {
    const { query,selectionId } = officeRequestQuery(request.query);
    response.json(await reads.summary(response.locals.officeIdentity,query,selectionId));
  });
  route("/history", async (request,response) => {
    const { query,selectionId,options } = officeRequestQuery(request.query,true);
    response.json(await reads.history(response.locals.officeIdentity,query,selectionId,options));
  });
  for (const path of ["/groups","/departments"]) route(path, async (request,response) => {
    const { query,selectionId,options } = officeRequestQuery(request.query,true);
    response.json(await reads.groups(response.locals.officeIdentity,query,selectionId,options,path==="/departments"));
  });
  route("/facets", async (request,response) => {
    const { query,selectionId,options } = officeRequestQuery(request.query,true,true);
    const kind = scalar(request.query.kind,16);
    if (kind!=="company" && kind!=="department") throw new AppError(400,"invalid_office_query","Expected company or department facet.");
    response.json(await reads.facets(response.locals.officeIdentity,query,kind,selectionId,options));
  });
  route("/groups/:groupId/people", async (request,response) => {
    const { query,selectionId,options } = officeRequestQuery(request.query,true);
    response.json(await reads.people(response.locals.officeIdentity,query,scalar(request.params.groupId,64),selectionId,options));
  });
  return router;
}
