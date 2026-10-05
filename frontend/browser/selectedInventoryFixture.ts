import { randomUUID } from "node:crypto";
import type { Page, Request, Route } from "@playwright/test";
import type { InventoryMember, UnifiedAgentInventoryPage, UnifiedAgentRecord } from "../src/api/client";
import { decodeInventoryFacet } from "../../backend/src/types/inventoryFacets";

type Capture = {
  query: Readonly<Record<string, string>>;
  selection: UnifiedAgentInventoryPage["selection"];
  records: Map<string, UnifiedAgentRecord>;
};
const captures = new WeakMap<Page, Map<string, Capture>>();

export function isInventorySelectionRequest(request: Request) {
  return request.method() === "POST" && new URL(request.url()).pathname === "/api/agent-inventory/selections";
}

function selected(route: Route) {
  const id = new URL(route.request().url()).searchParams.get("selectionId");
  const capture = id ? captures.get(route.request().frame().page())?.get(id) : undefined;
  if (!capture) throw new Error(`Unknown synthetic inventory selection: ${id}`);
  return capture;
}

export async function captureInventorySelection(route: Route, metadata: UnifiedAgentInventoryPage["selection"]) {
  if (route.request().method() !== "POST") return route.fulfill({ status: 405, json: { code: "method_not_allowed" } });
  if (!route.request().headers()["x-csrf-token"]) return route.fulfill({ status: 403, json: { code: "csrf_required" } });
  const body = route.request().postDataJSON() as { query?: Record<string, unknown> };
  if (!body.query || Object.values(body.query).some(value => typeof value !== "string")
    || ["selectionId", "limit", "cursor"].some(key => Object.hasOwn(body.query!, key))) {
    throw new Error("Invalid synthetic inventory selection capture");
  }
  const page = route.request().frame().page();
  let selections = captures.get(page);
  if (!selections) { selections = new Map(); captures.set(page, selections); }
  const selection = { ...metadata, id: randomUUID() };
  selections.set(selection.id, { selection, query: Object.freeze({ ...body.query }) as Readonly<Record<string, string>>, records: new Map() });
  return route.fulfill({ status: 201, json: selection });
}

export function inventoryFixtureQuery(route: Route) {
  const query = new URLSearchParams(selected(route).query);
  for (const [key, value] of new URL(route.request().url()).searchParams) query.set(key, value);
  return query;
}

export function inventoryFixtureFacet(query: URLSearchParams, field: string) {
  const wire = query.get(field);
  if (wire === null) return undefined;
  const value = decodeInventoryFacet(wire);
  if (value !== null && typeof value !== "string") throw new Error("Expected a literal synthetic inventory facet");
  return value;
}

export function fulfillInventoryPage(route: Route, data: UnifiedAgentInventoryPage) {
  const capture = selected(route);
  for (const record of data.value) capture.records.set(record.id, structuredClone(record));
  return route.fulfill({ json: { ...data, selection: capture.selection,
    inventoryScope: capture.query.inventoryScope ?? data.inventoryScope,
    page: { ...data.page, limit: Number(new URL(route.request().url()).searchParams.get("limit") ?? 50) } } });
}

export function fulfillInventoryDetail(route: Route, recordId: string) {
  const record = selected(route).records.get(recordId);
  return record ? route.fulfill({ json: record }) : route.fulfill({ status: 404, json: { code: "inventory_record_unavailable" } });
}

export function fulfillInventoryMembers(route: Route, recordId: string) {
  const capture = selected(route), record = capture.records.get(recordId);
  if (!record) return route.fulfill({ status: 404, json: { code: "inventory_record_unavailable" } });
  if (record.packagesComplete === false || record.packages.length > 20 || new URL(route.request().url()).searchParams.has("cursor")) {
    throw new Error("Large synthetic member collections require an explicit paged fixture");
  }
  const value: InventoryMember[] = record.packages.map(item => ({
    source_scope_id: "synthetic-graph-scope", source_identity: item.id, source_generation_id: capture.selection.id,
    domain: "packages", native_id: item.id, environment_id: null, display_name: item.displayName,
    observed_at: capture.selection.evaluatedAt, expires_at: capture.selection.expiresAt,
  }));
  if (record.powerPlatformResource) value.push({
    source_scope_id: "synthetic-native-scope", source_identity: record.powerPlatformResource.nativeId,
    source_generation_id: capture.selection.id, domain: "power_platform", native_id: record.powerPlatformResource.nativeId,
    environment_id: record.powerPlatformResource.environmentId, display_name: record.powerPlatformResource.displayName ?? "",
    observed_at: capture.selection.evaluatedAt, expires_at: capture.selection.expiresAt,
  });
  return route.fulfill({ json: { value, total: value.length, nextCursor: null } });
}
