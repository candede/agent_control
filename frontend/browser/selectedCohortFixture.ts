import type { OfficialReportDetail, OfficialReportFacetPage } from "../../backend/src/types/officialReportApi";
import type { CombinedUser, ReportPage, ReportQuery, ReportRelationship, ReportRow, ReportUser } from "../../backend/src/types/officialReportData";
import type { UserSourcePlan } from "../../backend/src/types/userSources";
import { reportPage } from "../src/test/reportDataFixture";
import {
  selectedFixtureNow, selectedFixtureQuery, selectedFixtureWindow, selectedLicensedUser, selectedPlansPage,
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
export function captureSelectedCohort(input: string, source: SelectedCohortData) {
  const query = new URL(input, "http://localhost").searchParams, data = structuredClone(source);
  const selectedQuery = selectedFixtureQuery(input);
  return {
    query, source: data,
    read(request: string) {
      const url = new URL(request, "http://localhost");
      if (!url.pathname.endsWith("/facets") && !url.pathname.endsWith("/agents")
        && Object.keys(selectedQuery).some(key => url.searchParams.has(key))
        && JSON.stringify(selectedFixtureQuery(request)) !== JSON.stringify(selectedQuery)) {
        throw new Error("Synthetic selection filters are immutable");
      }
      return selectedCohortRead(request, data, selectedQuery);
    },
  };
}

export function selectedCohortExportRows(capture: ReturnType<typeof captureSelectedCohort>) {
  const url = new URL("/api/official-usage/users?limit=100", "http://localhost");
  const rows: Array<Record<string, unknown>> = [];
  for (;;) {
    const page = capture.read(url.href);
    if (!page || !("filters" in page)) throw new Error("Expected a frozen reported-user page");
    for (const user of page.value) {
      if (!("username" in user) || !("reportedResponses" in user)) throw new Error("Expected scalar reported-user facts");
      const relationships = capture.source.relationships.filter(row => row.username === user.username);
      rows.push(...(relationships.length ? relationships : [null]).map(row => ({
        username: user.username, displayName: user.displayName, reportedResponsesReceived: user.reportedResponses,
        licenseAssignmentStatus: "no_active_paid_license", entitlement: user.entitlement,
        agentId: row?.agentId, responsesSentToUsers: row?.responses, reportSetId: capture.source.directory.reports.setId,
      })));
    }
    if (!page.page.nextCursor) return rows;
    url.searchParams.set("cursor", page.page.nextCursor);
  }
}

export function selectedCohortRead(input: string, data: SelectedCohortData, selectionQuery?: ReportQuery):
  ReportPage<ReportRow> | OfficialReportDetail<CombinedUser | ReportUser> | OfficialReportFacetPage | undefined {
  const url = new URL(input, "http://localhost"), requestQuery = selectedFixtureQuery(input), path = url.pathname;
  const query = selectionQuery ?? requestQuery;
  const reports = { ...data.directory.reports, setId: query.setId ?? data.directory.reports.setId };
  const selection = { ...data.directory.selection, id: url.searchParams.get("selectionId") ?? data.directory.selection.id };
  const current = data.directory.sources.directory.state === "available";
  const users = data.users.map((row): ReportUser => {
    const matches = data.directory.value.filter(user => user.directory.userPrincipalName === row.username);
    const identity = current && matches.length === 1 ? matches[0] : undefined;
    const links = data.relationships.filter(link => link.username === row.username);
    const bridge = links.reduce((total, link) => total + link.responses, 0), threshold = query.lowResponseThreshold ?? 5;
    return { ...row, objectId: identity?.directory.objectId ?? null, entitlement: identity?.entitlement ?? "unknown",
      company: identity?.directory.companyName ?? null, department: identity?.directory.department ?? null,
      bridgeResponses: bridge, relationshipCount: links.length, responseProducingAgentCount: links.filter(link => link.responses > 0).length,
      hasActivity: (row.reportedResponses ?? 0) > 0 || bridge > 0, hasReportMismatch: row.reportedResponses !== null && row.reportedResponses !== bridge,
      reviewCohort: row.reportedResponses === null ? "unknown" : row.reportedResponses === 0 ? "zero" : row.reportedResponses <= threshold ? "low" : "outside" };
  });
  const unpaid = users.filter(row => row.hasActivity && (row.entitlement === "no_paid" || row.entitlement === "paid_inactive"));
  const activeSince = new Date(selectedFixtureNow.getTime() - (query.activityWindowDays ?? 30) * 86_400_000).toISOString().slice(0, 10);
  const selectUsers = (query: ReportQuery) => (query.licenseCohort ? unpaid : users).filter(row => {
    const links = data.relationships.filter(link => link.username === row.username);
    return (!query.search || `${row.displayName} ${row.username} ${links.map(link => `${link.agentName} ${link.agentId}`).join(" ")}`.toLowerCase().includes(query.search.toLowerCase()))
      && (!query.agentId || links.some(link => link.agentId === query.agentId))
      && (!query.creatorType || links.some(link => link.creatorType === query.creatorType))
      && (!query.responsesOnly || links.some(link => link.responses > 0))
      && (query.company === undefined || (row.company?.trim() || null) === query.company)
      && (query.department === undefined || (row.department?.trim() || null) === query.department)
      && (!query.cohort || query.cohort === "all" || query.cohort === row.reviewCohort || query.cohort === "review" && ["zero", "low"].includes(row.reviewCohort))
      && (!query.startDate || Boolean(row.userLastActivityDateUtc && row.userLastActivityDateUtc >= query.startDate))
      && (!query.endDate || Boolean(row.userLastActivityDateUtc && row.userLastActivityDateUtc <= query.endDate))
      && (!query.reportActivity || query.reportActivity === "all" || query.reportActivity === "recent" && Boolean(row.userLastActivityDateUtc && row.userLastActivityDateUtc >= activeSince)
        || query.reportActivity === "inactive" && Boolean(row.userLastActivityDateUtc && row.userLastActivityDateUtc < activeSince)
        || query.reportActivity === "no-activity" && !row.userLastActivityDateUtc);
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
    const search = url.searchParams.get("search")?.normalize("NFKC").toLowerCase();
    const valueOf = (row: ReportUser) => row[field]?.trim() || null;
    for (const row of selectUsers(facetQuery)) {
      const value = valueOf(row);
      if (search && !(value ?? "").normalize("NFKC").toLowerCase().includes(search)) continue;
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
    return { ...base, analytics: { ...base.analytics, rowCount: selected.length, responses: selected.reduce((total, row) => total + (row.reportedResponses ?? 0), 0),
      review: { zero: selected.filter(row => row.reviewCohort === "zero").length, low: selected.filter(row => row.reviewCohort === "low").length,
        unknown: selected.filter(row => row.reviewCohort === "unknown").length } } };
  }
  if (path.startsWith("/api/official-usage/users/")) {
    const [encoded, child] = path.slice("/api/official-usage/users/".length).split("/"), username = decodeURIComponent(encoded);
    const value = (selectionQuery ? selected : users).find(row => row.username === username);
    if (!value) return undefined;
    if (!child) return { value, reports, selection, sources: data.directory.sources };
    if (child === "agents") {
      const rows = data.relationships.filter(row => row.username === username && (!requestQuery.agentId || row.agentId === requestQuery.agentId)
        && (!requestQuery.creatorType || row.creatorType === requestQuery.creatorType) && (!requestQuery.responsesOnly || row.responses > 0)
        && (!requestQuery.search || `${row.agentName} ${row.agentId} ${row.creatorType}`.toLowerCase().includes(requestQuery.search.toLowerCase())));
      sortRows(rows, requestQuery, row => requestQuery.sort === "name" ? row.agentName : requestQuery.sort === "creatorType" ? row.creatorType
        : requestQuery.sort === "lastActivity" ? row.lastActivityDateUtc : row.responses);
      return selectedPage(rows);
    }
    const identity = current && data.directory.value.find(row => row.directory.objectId === value.objectId);
    if (identity && child === "directory") return { value: identity, selection, reports, sources: data.directory.sources };
    if (identity && child === "service-plans") return selectedPage<UserSourcePlan>(identity.servicePlanCount ? selectedPlansPage().value : []);
  }
  return undefined;
}
