import type { OfficialReportDetail, OfficialReportFacetPage } from "../../backend/src/types/officialReportApi";
import type { CombinedUser, ReportPage, ReportQuery, ReportRelationship, ReportRow, ReportUser } from "../../backend/src/types/officialReportData";
import type { UserSourcePlan } from "../../backend/src/types/userSources";
import { normalizeReportSearch } from "../src/api/reportData";
import { reportPage } from "../src/test/reportDataFixture";
import {
  latestDate, matchesActivity, responseAnalytics, selectedFixtureQuery, selectedFixtureWindow, selectedLicensedUser, selectedPlansPage,
  selectedRelationshipsPage, selectedReportUsersPage, selectedUsersPage,
} from "../src/test/selectedUsageFixture";

export type SelectedCohortData = { users: ReportUser[]; relationships: ReportRelationship[]; directory: ReportPage<CombinedUser> };
export function selectedCohortData(): SelectedCohortData {
  const users = selectedReportUsersPage().value, relationships = selectedRelationshipsPage().value, directory = selectedUsersPage();
  for (const [sourceName, name, index] of [["Ada", "Emery", 20], ["Cleo", "Finley", 21]] as const) {
    const source = users.find(row => row.displayName === sourceName)!, username = `${name.toLowerCase()}@example.invalid`;
    const identity = selectedLicensedUser(index, name, source.reportedResponses);
    identity.copilotServiceState = "disabled"; identity.entitlement = "no_paid"; identity.servicePlanCount = 0;
    if (name === "Finley") { identity.directory.companyName = null; identity.directory.department = null; }
    directory.value.push(identity);
    users.push({ ...source, displayName: name, username, objectId: identity.directory.objectId, entitlement: "no_paid",
      company: identity.directory.companyName, department: identity.directory.department });
    relationships.push(...relationships.filter(row => row.username === source.username).map(row => ({ ...row, id: `${row.id}-${index}`, username })));
  }
  directory.sources.directory = { ...directory.sources.directory, rowCount: directory.value.length, attemptObservedCount: directory.value.length };
  directory.reports = { ...directory.reports, lineages: directory.reports.lineages.map(lineage => ({
    ...lineage, rowCount: lineage.kind === "users" ? users.length : lineage.kind === "userAgents" ? relationships.length : 2,
  })) };
  return { users, relationships, directory };
}
function sortRows<T>(rows: T[], query: ReportQuery, value: (row: T) => string | number | null) {
  return rows.sort((a, b) => {
    const left = value(a), right = value(b);
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    return (query.order === "asc" ? 1 : -1) * (typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right)));
  });
}
function cohortQuery(input: string): ReportQuery {
  const query = selectedFixtureQuery(input);
  return { ...query, setId: query.setId?.toLowerCase(), search: query.search === undefined ? undefined : normalizeReportSearch(query.search),
    lowResponseThreshold: query.lowResponseThreshold ?? 5, inactiveDays: query.inactiveDays ?? 30, activityWindowDays: query.activityWindowDays ?? 30 };
}
export function captureSelectedCohort(input: string, source: SelectedCohortData) {
  const query = new URL(input, "http://localhost").searchParams, data = structuredClone(source);
  const selectedQuery = cohortQuery(input);
  return {
    get query() { return new URLSearchParams(query); },
    get source() { return structuredClone(data); },
    read(request: string) {
      const url = new URL(request, "http://localhost"), requestedId = url.searchParams.get("selectionId");
      if (requestedId !== null && requestedId.toLowerCase() !== data.directory.selection.id.toLowerCase()) {
        throw new Error("Synthetic selection context mismatch");
      }
      const facet = url.pathname.endsWith("/facets"), child = url.pathname.endsWith("/agents"), requestedQuery = cohortQuery(request);
      if (facet) requestedQuery.search = selectedQuery.search;
      if (child && requestedQuery.setId !== undefined && requestedQuery.setId !== data.directory.reports.setId?.toLowerCase()) {
        throw new Error("Synthetic selection context mismatch");
      }
      if (!child && Object.keys(selectedQuery).some(key => (!facet || key !== "search") && url.searchParams.has(key))
        && JSON.stringify(requestedQuery) !== JSON.stringify(selectedQuery)) {
        throw new Error("Synthetic selection filters are immutable");
      }
      return structuredClone(selectedCohortRead(request, data, selectedQuery));
    },
  };
}

export function selectedCohortExportRows(capture: ReturnType<typeof captureSelectedCohort>) {
  const url = new URL("/api/official-usage/users?limit=100", "http://localhost");
  const rows: Array<Record<string, unknown>> = [], source = capture.source;
  const links = source.directory.reports.lineages.some(lineage => lineage.kind === "userAgents") ? source.relationships : [];
  for (;;) {
    const page = capture.read(url.href);
    if (!page || !("filters" in page)) throw new Error("Expected a frozen reported-user page");
    for (const user of page.value) {
      if (!("username" in user) || !("reportedResponses" in user)) throw new Error("Expected scalar reported-user facts");
      const relationships = links.filter(row => row.username === user.username);
      rows.push(...(relationships.length ? relationships : [null]).map(row => ({
        username: user.username, displayName: user.displayName, reportedResponsesReceived: user.reportedResponses,
        licenseAssignmentStatus: user.entitlement === "no_paid" || user.entitlement === "paid_inactive" ? "no_active_paid_license" : "unavailable",
        entitlement: user.entitlement, agentId: row?.agentId, responsesSentToUsers: row?.responses, reportSetId: source.directory.reports.setId,
      })));
    }
    if (!page.page.nextCursor) return rows;
    url.searchParams.set("cursor", page.page.nextCursor);
  }
}

export function selectedCohortRead(input: string, data: SelectedCohortData, selectionQuery?: ReportQuery):
  ReportPage<ReportRow> | OfficialReportDetail<CombinedUser | ReportUser> | OfficialReportFacetPage | undefined {
  const url = new URL(input, "http://localhost"), requestQuery = cohortQuery(input), path = url.pathname;
  const query = selectionQuery ?? requestQuery;
  const reports = data.directory.reports;
  if (query.setId !== undefined && query.setId.toLowerCase() !== reports.setId?.toLowerCase()) throw new Error("Synthetic report set mismatch");
  const selection = { ...data.directory.selection, id: url.searchParams.get("selectionId") ?? data.directory.selection.id };
  const current = data.directory.sources.directory.state === "available";
  const hasUsers = reports.setId && reports.lineages.some(lineage => lineage.kind === "users");
  const relationships = reports.setId && reports.lineages.some(lineage => lineage.kind === "userAgents") ? data.relationships : [];
  const recordedUsers = reports.setId ? data.users.filter(row => hasUsers || relationships.some(link => link.username === row.username)) : [];
  const users = recordedUsers.map((source): ReportUser => {
    const row = hasUsers ? source : { ...source, reportedResponses: null, reportedAgentsUsed: null, userLastActivityDateUtc: null, missingUserReport: true };
    const matches = data.directory.value.filter(user => user.directory.userPrincipalName === row.username);
    const identity = current && matches.length === 1 ? matches[0] : undefined;
    const links = relationships.filter(link => link.username === row.username);
    const bridge = links.length ? links.reduce((total, link) => total + link.responses, 0) : null, threshold = query.lowResponseThreshold ?? 5;
    return { ...row, objectId: identity?.directory.objectId ?? null, entitlement: identity?.entitlement ?? "unknown",
      company: identity?.directory.companyName ?? null, department: identity?.directory.department ?? null,
      bridgeResponses: bridge, relationshipCount: links.length, responseProducingAgentCount: links.filter(link => link.responses > 0).length,
      hasActivity: (row.reportedResponses ?? 0) > 0 || (bridge ?? 0) > 0,
      hasReportMismatch: row.reportedResponses !== null && bridge !== null && (row.reportedResponses !== bridge || row.reportedAgentsUsed !== links.length),
      reviewCohort: row.reportedResponses === null ? "unknown" : row.reportedResponses === 0 ? "zero" : row.reportedResponses <= threshold ? "low" : "outside" };
  });
  const unpaid = users.filter(row => row.hasActivity && (row.entitlement === "no_paid" || row.entitlement === "paid_inactive"));
  const anchor = latestDate(users.map(row => row.userLastActivityDateUtc));
  const selectUsers = (query: ReportQuery) => (query.licenseCohort ? unpaid : users).filter(row => {
    const links = relationships.filter(link => link.username === row.username);
    const matchingLinks = links.filter(link => (query.agentId === undefined || link.agentId === query.agentId)
      && (query.creatorType === undefined || link.creatorType === query.creatorType) && (!query.responsesOnly || link.responses > 0));
    return (!query.search || normalizeReportSearch(`${row.displayName} ${row.username} ${row.company ?? ""} ${row.department ?? ""} ${matchingLinks.map(link => `${link.agentName} ${link.agentId}`).join(" ")}`)
      .includes(normalizeReportSearch(query.search)))
      && (query.username === undefined || row.username === query.username)
      && (query.entitlement === undefined || row.entitlement === query.entitlement)
      && (query.serviceState === undefined || data.directory.value.find(user => user.directory.objectId === row.objectId)?.copilotServiceState === query.serviceState)
      && (!(query.agentId !== undefined || query.creatorType !== undefined || query.responsesOnly) || matchingLinks.length > 0)
      && (query.company === undefined || (row.company?.trim() || null) === query.company)
      && (query.department === undefined || (row.department?.trim() || null) === query.department)
      && (!query.cohort || query.cohort === "all" || query.cohort === row.reviewCohort || query.cohort === "review" && ["zero", "low"].includes(row.reviewCohort))
      && matchesActivity(row.userLastActivityDateUtc, query, anchor);
  });
  const selected = selectUsers(query);
  const selectedPage = <T>(rows: T[], total = rows.length): ReportPage<T> => {
    const base = reportPage(rows, { reports, selection, sources: data.directory.sources, filters: query,
      counts: { total, filtered: rows.length } });
    return selectedFixtureWindow(input, rows, { ...base, summary: { ...base.summary, activeWithoutPaidUsers: current ? unpaid.length : null,
      unknownLicenseActiveReportUsers: users.filter(row => row.hasActivity && row.entitlement === "unknown").length },
    });
  };
  if (path === "/api/official-usage/users/facets") {
    const field = url.searchParams.get("field"), groups = new Map<string | null, number>();
    if (field !== "company" && field !== "department") throw new Error("Unexpected reported-user facet");
    const facetQuery = { ...query };
    delete facetQuery[field];
    if (!selectionQuery) {
      delete facetQuery.search;
      facetQuery.licenseCohort ??= "active_without_paid";
    }
    const search = normalizeReportSearch(url.searchParams.get("search") ?? "");
    const valueOf = (row: ReportUser) => row[field]?.trim() || null;
    for (const row of selectUsers(facetQuery)) {
      const value = valueOf(row);
      if (search && !normalizeReportSearch(value ?? "").includes(search)) continue;
      groups.set(value, (groups.get(value) ?? 0) + 1);
    }
    const values = [...groups].sort(([a], [b]) => a === null ? 1 : b === null ? -1 : a.localeCompare(b))
      .map(([value, count]) => ({ value, count }));
    const page = selectedPage(values, new Set(users.map(valueOf)).size);
    return { value: page.value, counts: page.counts, page: page.page, selection };
  }
  if (path === "/api/official-usage/users") {
    sortRows(selected, query, row => query.sort === "name" ? row.displayName : query.sort === "agentsUsed" ? row.reportedAgentsUsed
      : query.sort === "lastActivity" ? row.userLastActivityDateUtc : row.reportedResponses);
    const base = selectedPage(selected, users.length);
    return { ...base, analytics: { ...base.analytics, ...responseAnalytics(selected.map(row => row.reportedResponses), query.lowResponseThreshold ?? 5) } };
  }
  if (path.startsWith("/api/official-usage/users/")) {
    const [encoded, child, extra] = path.slice("/api/official-usage/users/".length).split("/"), username = decodeURIComponent(encoded);
    if (extra !== undefined) return undefined;
    const value = (selectionQuery ? selected : users).find(row => row.username === username);
    if (!value) return undefined;
    if (!child) return { value, reports, selection, sources: data.directory.sources };
    if (child === "agents") {
      const links = relationships.filter(row => row.username === username), anchor = latestDate(links.map(row => row.lastActivityDateUtc));
      const rows = links.filter(row => (requestQuery.username === undefined || row.username === requestQuery.username)
        && (requestQuery.agentId === undefined || row.agentId === requestQuery.agentId)
        && (requestQuery.creatorType === undefined || row.creatorType === requestQuery.creatorType) && (!requestQuery.responsesOnly || row.responses > 0)
        && matchesActivity(row.lastActivityDateUtc, requestQuery, anchor)
        && (!requestQuery.search || normalizeReportSearch(`${row.agentName} ${row.agentId} ${row.creatorType} ${row.username}`).includes(requestQuery.search)));
      sortRows(rows, requestQuery, row => requestQuery.sort === "name" ? row.agentName : requestQuery.sort === "creatorType" ? row.creatorType
        : requestQuery.sort === "lastActivity" ? row.lastActivityDateUtc : row.responses);
      return selectedPage(rows, links.length);
    }
    const identity = current && data.directory.value.find(row => row.directory.objectId === value.objectId);
    if (identity && child === "directory") return { value: identity, selection, reports, sources: data.directory.sources };
    if (identity && child === "service-plans") return selectedPage<UserSourcePlan>(identity.servicePlanCount ? selectedPlansPage().value : []);
  }
  return undefined;
}
