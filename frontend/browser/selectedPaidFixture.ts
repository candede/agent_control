import { expect, type Page } from "@playwright/test";
import type { CombinedUser, ReportPage, ReportQuery } from "../../backend/src/types/officialReportData";
import type { UserSourcePlan } from "../../backend/src/types/userSources";
import { reportPage } from "../src/test/reportDataFixture";
import { normalizeReportSearch, reportQueryString } from "../src/api/reportData";
import { selectedFixtureLicensedRows, selectedFixtureQuery, selectedFixtureRead, selectedFixtureWindow, selectedPlansPage, selectedUsersPage } from "../src/test/selectedUsageFixture";

export async function mockSelectedPaidUsers(page: Pick<Page, "route">, source = selectedUsersPage(), plans = new Map<string, UserSourcePlan[]>()) {
  source.sources.directory = { ...source.sources.directory, rowCount: source.value.length, attemptObservedCount: source.value.length };
  const captures = new Map<string, ReportQuery>(), reads: Array<{ path: string; query: URLSearchParams; rows: number; bytes: number }> = [];
  const snapshots = new Map<string, { source: ReportPage<CombinedUser>; plans: Map<string, UserSourcePlan[]> }>();
  const cursors = new Map<string, { selectionId: string; scope: string; offset: string }>();
  await page.route(url => url.pathname.startsWith("/api/copilot-usage/users"), route => {
    expect(route.request().method()).toBe("GET");
    const url = new URL(route.request().url()), cursor = url.searchParams.get("cursor");
    const boundary = cursor === null ? undefined : cursors.get(cursor);
    if (cursor !== null && !boundary) return route.fulfill({ status: 400, json: { code: "invalid_cursor", detail: "Unknown synthetic cursor." } });
    const requested = url.searchParams.get("selectionId")?.toLowerCase() ?? boundary?.selectionId;
    if (requested !== undefined && !captures.has(requested)) return route.fulfill({ status: 409, json: { code: "selection_invalidated", detail: "Unknown synthetic selected source." } });
    if (requested === undefined && url.pathname !== "/api/copilot-usage/users") throw new Error("An exact synthetic child requires a captured selection");
    let query: ReportQuery;
    try { query = selectedFixtureQuery(url.href); }
    catch { return route.fulfill({ status: 400, json: { code: "invalid_usage_query", detail: "Invalid synthetic report query." } }); }
    const id = requested ?? crypto.randomUUID();
    if (requested === undefined) {
      if (query.setId !== undefined && query.setId !== source.reports.setId?.toLowerCase()) {
        return route.fulfill({ status: 404, json: { code: "official_usage_set_not_found", detail: "Unknown synthetic report set." } });
      }
      if (captures.size >= 128) throw new Error("Synthetic capture limit exceeded");
      captures.set(id, query);
      snapshots.set(id, structuredClone({ source, plans }));
    }
    const saved = snapshots.get(id)!, selectedQuery = captures.get(id)!;
    const list = url.pathname === "/api/copilot-usage/users";
    if (!(Date.parse(saved.source.selection.expiresAt) > Date.now()) || source.reports.historyEpoch !== saved.source.reports.historyEpoch) {
      return route.fulfill({ status: 409, json: { code: "selection_invalidated", detail: "The synthetic capture expired or its history was invalidated." } });
    }
    if (query.setId !== undefined && query.setId !== saved.source.reports.setId?.toLowerCase()) {
      return route.fulfill({ status: 400, json: { code: "invalid_cursor", detail: "The synthetic report set is immutable." } });
    }
    const relationships = url.pathname.endsWith("/agents"), facet = url.pathname.endsWith("/facets");
    if (!relationships && requested && Object.keys(selectedQuery).some(key => (!facet || key !== "search") && url.searchParams.has(key))
      && JSON.stringify(facet ? { ...query, search: selectedQuery.search } : query) !== JSON.stringify(selectedQuery)) {
      return route.fulfill({ status: 400, json: { code: "invalid_cursor", detail: "Synthetic selection filters are immutable." } });
    }
    const scope = JSON.stringify([url.pathname, relationships ? { ...query, setId: undefined } : null,
      facet ? [url.searchParams.get("field"), normalizeReportSearch(url.searchParams.get("search") ?? "")] : null]);
    if (boundary && (boundary.selectionId !== id || boundary.scope !== scope)) {
      return route.fulfill({ status: 400, json: { code: "invalid_cursor", detail: "Synthetic cursor owner or filters changed." } });
    }
    const licensed = selectedFixtureLicensedRows(saved.source, { cohort: "licensed" }), current = saved.source.sources.directory.state === "available";
    const reportsCurrent = saved.source.reports.availability === "active";
    const directory: ReportPage<CombinedUser> = { ...saved.source, selection: { ...saved.source.selection, id, revision: id },
      counts: { total: licensed.length, filtered: licensed.length },
      summary: { ...saved.source.summary, checkedUsers: saved.source.value.length, licensedUsers: current ? licensed.length : null,
        usingAgentsUsers: current && reportsCurrent ? licensed.filter(row => row.agentActivityState === "active").length : null,
        needsAttentionUsers: current && reportsCurrent ? selectedFixtureLicensedRows(saved.source, { cohort: "needs_attention", lowResponseThreshold: selectedQuery.lowResponseThreshold }).length : null,
        noAgentActivityUsers: current && reportsCurrent ? licensed.filter(row => row.agentActivityState === "none").length : null,
        unknownMetricsUsers: licensed.filter(row => row.agentActivityState === "unknown").length } };
    if (!list && !url.pathname.endsWith("/facets") && !url.pathname.endsWith("/unresolved-identities")) {
      const objectId = decodeURIComponent(url.pathname.split("/")[4]).toLowerCase();
      if (!selectedFixtureLicensedRows(directory, selectedQuery).some(row => row.directory.objectId === objectId)) {
        return route.fulfill({ status: 404, json: { code: "synthetic_exact_not_found", detail: "No exact selected user." } });
      }
    }
    const input = new URL(url);
    input.searchParams.set("selectionId", id);
    if (boundary) input.searchParams.set("cursor", boundary.offset);
    if (list) {
      for (const [key, value] of new URLSearchParams(reportQueryString(selectedQuery))) input.searchParams.set(key, value);
    }
    let body = selectedFixtureRead(input.href, directory);
    if (url.pathname.endsWith("/facets")) {
      const field = url.searchParams.get("field"), query = { ...captures.get(id) };
      if (field !== "company" && field !== "department") throw new Error("Unexpected paid-user facet");
      delete query[field];
      const rows = selectedFixtureLicensedRows(directory, query), groups = new Map<string | null, number>();
      const search = normalizeReportSearch(url.searchParams.get("search") ?? "");
      const valueOf = (row: CombinedUser) => (field === "company" ? row.directory.companyName : row.directory.department)?.trim() || null;
      for (const row of rows) {
        const value = valueOf(row);
        if (!search || normalizeReportSearch(value ?? "").includes(search)) {
          groups.set(value, (groups.get(value) ?? 0) + 1);
        }
      }
      const values = [...groups].sort(([a], [b]) => a === null ? 1 : b === null ? -1 : a.localeCompare(b)).map(([value, count]) => ({ value, count }));
      const result = selectedFixtureWindow(input.href, values, reportPage(values, {
        selection: directory.selection, counts: { total: new Set(licensed.map(valueOf)).size, filtered: values.length },
      }));
      body = { value: result.value, counts: result.counts, selection: result.selection, page: result.page };
    } else if (url.pathname.endsWith("/service-plans")) {
      const objectId = decodeURIComponent(url.pathname.split("/")[4]).toLowerCase();
      const rows = saved.plans.get(objectId) ?? (directory.value.find(row => row.directory.objectId === objectId)?.servicePlanCount ? selectedPlansPage().value : []);
      body = selectedFixtureWindow(input.href, rows, reportPage(rows, {
        reports: directory.reports, selection: directory.selection, sources: directory.sources, counts: { total: rows.length, filtered: rows.length },
      }));
    }
    if (!body) return route.fulfill({ status: 404, json: { code: "synthetic_exact_not_found", detail: "No exact selected user." } });
    if ("page" in body) for (const key of ["nextCursor", "previousCursor"] as const) {
      const offset = body.page[key];
      if (offset === null) continue;
      const token = `paid:${Buffer.from(JSON.stringify([id, scope, offset])).toString("base64url")}`;
      cursors.set(token, { selectionId: id, scope, offset });
      body.page[key] = token;
    }
    const json = JSON.stringify(body), count = Array.isArray(body.value) ? body.value.length : 1;
    expect(count).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(1024 * 1024);
    reads.push({ path: url.pathname, query: url.searchParams, rows: count, bytes: Buffer.byteLength(json) });
    return route.fulfill({ contentType: "application/json", body: json });
  });
  return { reads, get captures() { return structuredClone(captures); }, source };
}
