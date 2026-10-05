import { expect, type Page } from "@playwright/test";
import type { CombinedUser, ReportPage, ReportQuery } from "../../backend/src/types/officialReportData";
import type { UserSourcePlan } from "../../backend/src/types/userSources";
import { reportPage } from "../src/test/reportDataFixture";
import { selectedFixtureLicensedRows, selectedFixtureQuery, selectedFixtureRead, selectedFixtureWindow, selectedPlansPage, selectedUsersPage } from "../src/test/selectedUsageFixture";

export async function mockSelectedPaidUsers(page: Page, source = selectedUsersPage(), plans = new Map<string, UserSourcePlan[]>()) {
  source.sources.directory = { ...source.sources.directory, rowCount: source.value.length, attemptObservedCount: source.value.length };
  const captures = new Map<string, ReportQuery>(), reads: Array<{ path: string; query: URLSearchParams; rows: number; bytes: number }> = [];
  await page.route(url => url.pathname.startsWith("/api/copilot-usage/users"), route => {
    expect(route.request().method()).toBe("GET");
    const url = new URL(route.request().url()), requested = url.searchParams.get("selectionId");
    if (requested && !captures.has(requested)) return route.fulfill({ status: 409, json: { code: "selection_invalidated", detail: "Unknown synthetic selected source." } });
    if (!requested && url.pathname !== "/api/copilot-usage/users") throw new Error("An exact synthetic child requires a captured selection");
    const id = requested ?? `90000000-0000-4000-8000-${String(captures.size + 1).padStart(12, "0")}`;
    if (!requested) {
      if (captures.size >= 128) throw new Error("Synthetic capture limit exceeded");
      captures.set(id, selectedFixtureQuery(url.href));
    }
    const licensed = selectedFixtureLicensedRows(source, { cohort: "licensed" }), current = source.sources.directory.state === "available";
    const reportsCurrent = source.reports.availability === "active";
    const directory: ReportPage<CombinedUser> = { ...source, selection: { ...source.selection, id },
      counts: { total: licensed.length, filtered: licensed.length },
      summary: { ...source.summary, checkedUsers: source.value.length, licensedUsers: current ? licensed.length : null,
        usingAgentsUsers: current && reportsCurrent ? licensed.filter(row => row.agentActivityState === "active").length : null,
        needsAttentionUsers: current && reportsCurrent ? selectedFixtureLicensedRows(source, { cohort: "needs_attention", lowResponseThreshold: captures.get(id)?.lowResponseThreshold }).length : null,
        noAgentActivityUsers: current && reportsCurrent ? licensed.filter(row => row.agentActivityState === "none").length : null,
        unknownMetricsUsers: licensed.filter(row => row.agentActivityState === "unknown").length } };
    let body = selectedFixtureRead(url.href, directory);
    if (url.pathname.endsWith("/facets")) {
      const field = url.searchParams.get("field"), query = { ...captures.get(id) };
      if (field !== "company" && field !== "department") throw new Error("Unexpected paid-user facet");
      delete query[field];
      const rows = selectedFixtureLicensedRows(directory, query), groups = new Map<string | null, number>();
      for (const row of rows) {
        const value = (field === "company" ? row.directory.companyName : row.directory.department)?.trim() || null;
        if (!url.searchParams.get("search") || (value ?? "").toLowerCase().includes(url.searchParams.get("search")!.toLowerCase())) {
          groups.set(value, (groups.get(value) ?? 0) + 1);
        }
      }
      const values = [...groups].sort(([a], [b]) => a === null ? 1 : b === null ? -1 : a.localeCompare(b)).map(([value, count]) => ({ value, count }));
      const result = selectedFixtureWindow(url.href, values, reportPage(values, { selection: directory.selection, counts: { total: values.length, filtered: values.length } }));
      body = { value: result.value, counts: result.counts, selection: result.selection, page: result.page };
    } else if (url.pathname.endsWith("/service-plans")) {
      const objectId = decodeURIComponent(url.pathname.split("/")[4]);
      const rows = plans.get(objectId) ?? selectedPlansPage().value;
      body = selectedFixtureWindow(url.href, rows, reportPage(rows, {
        reports: directory.reports, selection: directory.selection, sources: directory.sources, counts: { total: rows.length, filtered: rows.length },
      }));
    }
    if (!body) return route.fulfill({ status: 404, json: { code: "synthetic_exact_not_found", detail: "No exact selected user." } });
    const json = JSON.stringify(body), count = Array.isArray(body.value) ? body.value.length : 1;
    expect(count).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(1024 * 1024);
    reads.push({ path: url.pathname, query: url.searchParams, rows: count, bytes: Buffer.byteLength(json) });
    return route.fulfill({ contentType: "application/json", body: json });
  });
  return { reads, captures, source };
}
