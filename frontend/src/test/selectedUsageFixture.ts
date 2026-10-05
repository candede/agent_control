import type {
  CombinedUser, ReportAgent, ReportHistorySet, ReportMetadata, ReportOverviewAgent, ReportPage, ReportQuery, ReportRelationship, ReportRow, ReportUser, UnresolvedReportIdentity,
} from "../../../backend/src/types/officialReportData";
import type { OfficialReportDetail, OfficialReportFacetPage } from "../../../backend/src/types/officialReportApi";
import type { UserSourcePlan } from "../../../backend/src/types/userSources";
import { combinedUser, historySet, overviewAgent, reportAgent, reportPage, reports, reportSetId, reportUser } from "./reportDataFixture";

export const selectedFixtureNow = new Date("2026-09-18T10:00:00.000Z");
export const selectedFixtureReports: ReportMetadata = {
  ...reports, reportingPeriod: { startDate: "2026-08-14", endDate: "2026-09-12", days: 30, provenance: "operator_asserted" },
  acceptedAt: "2026-09-12T10:00:00.000Z", periodAgeDays: 6, acceptedAgeDays: 6, staleAfterDays: 35,
  lineages: reports.lineages.map(lineage => ({ ...lineage, rowCount: lineage.kind === "agents" ? 2 : lineage.kind === "users" ? 4 : 5,
    sourceAsOf: null, sourceAsOfProvenance: "absent", sourceFreshness: "unknown" })),
};
export function selectedLicensedUser(index: number, name: string, responses: number | null): CombinedUser {
  const row = combinedUser(index), username = `${name.toLowerCase()}@example.invalid`;
  return { ...row,
    directory: { ...row.directory, objectId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      displayName: name, userPrincipalName: username, companyName: "Contoso Health", department: "Operations", employeeType: null },
    servicePlanCount: 1, activityState: "active",
    appActivity: { reportRefreshDate: "2026-09-12", lastActivityDate: "2026-09-11", copilotChatLastActivityDate: "2026-09-10",
      microsoftTeamsCopilotLastActivityDate: "2026-09-09", wordCopilotLastActivityDate: "2026-09-11", excelCopilotLastActivityDate: null,
      powerpointCopilotLastActivityDate: null, outlookCopilotLastActivityDate: "2026-09-10", onenoteCopilotLastActivityDate: null, loopCopilotLastActivityDate: null },
    reportedUsername: responses === null ? null : username, reportedResponses: responses,
    reportedAgentsUsed: responses === null ? null : responses ? 1 : 0,
    bridgeResponses: responses, relationshipCount: responses ? 1 : 0, agentActivityState: responses === null ? "unknown" : responses ? "active" : "none",
    reportMatch: responses === null ? "missing" : "matched", userLastActivityDateUtc: responses ? "2026-09-11" : null,
    attention: responses === null ? ["agent_usage_unknown"] : responses === 0 ? ["agent_usage_zero"] : responses <= 5 ? ["agent_usage_low"] : [],
  };
}
export function selectedUsersPage(): ReportPage<CombinedUser> {
  const result = reportPage([selectedLicensedUser(1, "Ada", 200), selectedLicensedUser(2, "Ben", 3),
    selectedLicensedUser(3, "Cleo", 0), selectedLicensedUser(4, "Drew", null)]);
  return { ...result, reports: structuredClone(selectedFixtureReports), counts: { total: 4, filtered: 4 },
    sources: { directory: { ...result.sources.directory, rowCount: 4, attemptObservedCount: 4, observedAt: "2026-09-12T10:00:00.000Z" },
      app_activity: { ...result.sources.app_activity, rowCount: 4, attemptObservedCount: 4, reportRefreshDate: "2026-09-12", observedAt: "2026-09-12T10:00:00.000Z" } },
    summary: { ...result.summary, checkedUsers: 4, licensedUsers: 4, measuredActivityUsers: 4, needsAttentionUsers: 2,
      usingAgentsUsers: 2, noAgentActivityUsers: 1, unknownMetricsUsers: 1, unresolvedIdentities: 1 },
    analytics: { ...result.analytics, rowCount: 4, responses: 203, zeroResponses: 1, unknownResponses: 1, review: { zero: 1, low: 1, unknown: 1 } },
  };
}
export function selectedPlansPage(): ReportPage<UserSourcePlan> {
  return reportPage([{ servicePlanId: "a62f8878-de10-42f3-b68f-6149a25ceb97", service: "M365_COPILOT_APPS",
    displayName: "Microsoft 365 Copilot in Productivity Apps", state: "enabled", assignedDateTime: "2026-08-01T00:00:00.000Z", capabilityStatus: "Enabled" }],
  { reports: structuredClone(selectedFixtureReports), counts: { total: 1, filtered: 1 } });
}
const agents: ReportAgent[] = [
  reportAgent(1, { agentId: "synthetic-researcher", agentName: "Researcher", creatorType: "Microsoft", responses: 215,
    reportResponses: 215, bridgeResponses: 212, responseComparison: "mismatch", activeUsers: 2,
    licensedUserOccurrences: 2, unlicensedUserOccurrences: 1, lastActivityDateUtc: "2026-09-12", relationshipCount: 3 }),
  reportAgent(2, { agentId: "helpdesk/report:2", agentName: "Helpdesk", creatorType: "Your org", responses: 55,
    reportResponses: 55, bridgeResponses: 55, activeUsers: 2, licensedUserOccurrences: 2,
    unlicensedUserOccurrences: 0, lastActivityDateUtc: "2026-09-11", relationshipCount: 2 }),
];
const relationships: ReportRelationship[] = ([
  ["synthetic-researcher", "Researcher", "Microsoft", "ada@example.invalid", 200, "2026-09-12"],
  ["synthetic-researcher", "Researcher", "Microsoft", "ben@example.invalid", 0, "2026-09-12"],
  ["synthetic-researcher", "Researcher", "Microsoft", "concealed-user", 12, "2026-09-12"],
  ["helpdesk/report:2", "Helpdesk", "Your org", "ada@example.invalid", 15, "2026-09-11"],
  ["helpdesk/report:2", "Helpdesk", "Your org", "cleo@example.invalid", 40, "2026-09-11"],
] satisfies Array<[string, string, string, string, number, string]>).map(([agentId, agentName, creatorType, username, responses, lastActivityDateUtc], index) => ({
  id: `relationship-${index}`, agentId, agentName, creatorType, username, responses, lastActivityDateUtc, identityStatus: "unresolved",
}));
function fixturePage<T>(value: T[], query: ReportQuery = {}): ReportPage<T> {
  const result = reportPage(structuredClone(value));
  return { ...result, reports: { ...structuredClone(selectedFixtureReports), setId: query.setId ?? reportSetId }, filters: query,
    counts: { total: value.length, filtered: value.length }, summary: { ...result.summary,
      reportedResponses: 270, bridgeResponses: 267, userReportedResponses: 267, distinctActiveReportUsers: 3,
      licensedOccurrences: 4, unlicensedOccurrences: 1, activeWithoutPaidUsers: 1 },
    analytics: { ...result.analytics, rowCount: value.length },
  };
}
export function selectedAgentsPage(query: ReportQuery = {}): ReportPage<ReportAgent> {
  const search = query.search?.toLowerCase();
  const rows = agents.filter(row => (!search || `${row.agentName} ${row.agentId} ${row.creatorType}`.toLowerCase().includes(search))
    && (!query.startDate || Boolean(row.lastActivityDateUtc && row.lastActivityDateUtc >= query.startDate))
    && (!query.endDate || Boolean(row.lastActivityDateUtc && row.lastActivityDateUtc <= query.endDate)));
  rows.sort((a, b) => (query.order === "asc" ? 1 : -1) * (query.sort === "name" ? a.agentName.localeCompare(b.agentName)
    : query.sort === "activeUsers" ? (a.activeUsers ?? 0) - (b.activeUsers ?? 0)
      : query.sort === "lastActivity" ? (a.lastActivityDateUtc ?? "").localeCompare(b.lastActivityDateUtc ?? "") : a.responses - b.responses));
  const result = fixturePage(rows, query);
  return { ...result, counts: { total: agents.length, filtered: rows.length }, analytics: { ...result.analytics,
    responses: rows.reduce((sum, row) => sum + row.responses, 0), agents: {
      inactive: 0, neverUsed: 0, anchorDateUtc: "2026-09-12", windowDays: query.activityWindowDays ?? 30, windowAgents: rows.length,
      windowResponses: rows.reduce((sum, row) => sum + row.responses, 0), windowDistinctActiveUsers: 3,
      mostResponses: rows.map(row => ({ agentId: row.agentId, name: row.agentName, responses: row.responses })),
      leastResponses: [...rows].reverse().map(row => ({ agentId: row.agentId, name: row.agentName, responses: row.responses })),
    } } };
}
export function selectedReportUsersPage(query: ReportQuery = {}): ReportPage<ReportUser> {
  const rows = [["Ada", "ada@example.invalid", 215, 2], ["Ben", "ben@example.invalid", 0, 1],
    ["Cleo", "cleo@example.invalid", 40, 1], ["Concealed report user", "concealed-user", 12, 1]].map(([name, username, responses, count], index) =>
    reportUser(index + 1, { username: String(username), displayName: String(name),
      objectId: index === 3 ? null : selectedLicensedUser(index + 1, String(name), Number(responses)).directory.objectId,
      company: index === 3 ? null : "Contoso Health", department: index === 3 ? null : "Operations",
      entitlement: index === 3 ? "unknown" : index === 0 ? "paid_active" : "no_paid", reportedResponses: Number(responses),
      reportedAgentsUsed: Number(count), bridgeResponses: query.licenseCohort && index === 1 ? 3 : Number(responses),
      relationshipCount: Number(count), responseProducingAgentCount: Number(responses) ? Number(count) : query.licenseCohort && index === 1 ? 1 : 0,
      userLastActivityDateUtc: index === 0 ? "2026-09-09" : null, lastActivityDateUtc: index === 2 ? "2026-09-11" : "2026-09-12",
      missingUserReport: false, hasReportMismatch: Boolean(query.licenseCohort && index === 1), reviewCohort: Number(responses) === 0 ? "zero" : "outside",
      hasActivity: Boolean(Number(responses) || query.licenseCohort && index === 1) }));
  const search = query.search?.toLowerCase();
  const selected = rows.filter(row => (!query.licenseCohort || row.hasActivity && ["no_paid", "paid_inactive"].includes(row.entitlement ?? "unknown"))
    && (!search || `${row.displayName} ${row.username}`.toLowerCase().includes(search))
    && (!query.agentId || relationships.some(link => link.agentId === query.agentId && link.username === row.username)));
  const result = fixturePage(selected, query);
  return { ...result, summary: { ...result.summary, activeWithoutPaidUsers: query.licenseCohort ? 2 : 1 },
    counts: { total: rows.length, filtered: selected.length } };
}
export function selectedRelationshipsPage(query: ReportQuery = {}): ReportPage<ReportRelationship> {
  return fixturePage(relationships.filter(row => (!query.agentId || row.agentId === query.agentId)
    && (!query.username || row.username === query.username) && (!query.search || row.username.toLowerCase().includes(query.search.toLowerCase()))), query);
}
export function selectedAgentDetail(agentId = agents[0].agentId): OfficialReportDetail<ReportAgent> {
  const value = agents.find(row => row.agentId === agentId);
  if (!value) throw new Error(`Unknown selected fixture agent: ${agentId}`);
  const page = fixturePage([]);
  return { value: structuredClone(value), selection: page.selection, reports: page.reports, sources: page.sources };
}
export function selectedOverviewPage(query: ReportQuery = {}): ReportPage<ReportOverviewAgent> {
  const selected = selectedAgentsPage(query);
  const result = fixturePage(selected.value.map((row, index) => overviewAgent(index + 1, {
    agentId: row.agentId, agentName: row.agentName, observationCount: 2, creatorTypeCount: 1,
    earliestActivityDateUtc: row.lastActivityDateUtc, lastActivityDateUtc: row.lastActivityDateUtc,
    latestSetId: reportSetId, latestAcceptedAt: selectedFixtureReports.acceptedAt!,
  })), query);
  return { ...result, counts: selected.counts, analytics: { ...result.analytics, overview: {
    retainedSets: 1, reportedAgents: 2, usedAgents: 2, active30Days: 2, undatedAgents: 0,
    earliestActivityDateUtc: "2026-09-11", latestActivityDateUtc: "2026-09-12", asOf: selectedFixtureNow.toISOString(), activeSinceDateUtc: "2026-08-20",
  } } };
}
export function selectedHistoryPage(sets: ReportHistorySet[] = [historySet(1, {
  reportingStart: "2026-08-14", reportingEnd: "2026-09-12", acceptedAt: selectedFixtureReports.acceptedAt!,
})], activeSetId: string | null = reportSetId): ReportPage<ReportHistorySet> {
  const result = fixturePage(sets);
  return { ...result, reports: { ...result.reports, activeSetId }, analytics: { ...result.analytics, history: {
    imports: sets.length, uniqueObservations: sets.length * 3, observationRows: sets.length * 11, uniquePayloads: sets.length * 3, repeatedRowsReused: 0,
    earliestAcceptedAt: sets.at(-1)?.acceptedAt ?? null, latestAcceptedAt: sets[0]?.acceptedAt ?? null,
    earliestActivityDateUtc: sets.length ? "2026-09-09" : null, latestActivityDateUtc: sets.length ? "2026-09-12" : null,
    earliestReportingStart: sets.length ? "2026-08-14" : null, latestReportingEnd: sets.length ? "2026-09-12" : null,
    knownWindows: sets.length, unknownWindows: 0, overlappingKnownWindows: Math.max(0, sets.length - 1),
    additive: false, activityRangeProvesCoverage: false,
  } } };
}

export function selectedFixtureQuery(input: string): ReportQuery {
  const params = new URL(input, "http://localhost").searchParams;
  function organization(field: "company" | "department") {
    const value = params.get(field);
    if (value === null) return undefined;
    if (value === "~null") return null;
    if (!value.startsWith("~string:")) throw new Error("Expected the frozen nullable organization encoding");
    return value.slice("~string:".length);
  }
  return { setId: params.get("setId") ?? undefined, search: params.get("search") ?? undefined,
    scope: params.get("scope") === "history" ? "history" : params.get("scope") === "selected" ? "selected" : undefined,
    company: organization("company"), department: organization("department"),
    creatorType: params.get("creatorType") ?? undefined, responsesOnly: params.get("responsesOnly") === "true" || undefined,
    startDate: params.get("startDate") ?? undefined, endDate: params.get("endDate") ?? undefined,
    agentId: params.get("agentId") ?? undefined, username: params.get("username") ?? undefined,
    licenseCohort: params.get("licenseCohort") === "active_without_paid" ? "active_without_paid" : undefined,
    cohort: (["all", "zero", "low", "review", "licensed", "using_agents", "no_agent_activity", "needs_attention", "unknown_metrics"] as const).find(value => value === params.get("cohort")),
    reportActivity: (["all", "recent", "inactive", "no-activity"] as const).find(value => value === params.get("reportActivity")),
    lowResponseThreshold: params.has("lowResponseThreshold") ? Number(params.get("lowResponseThreshold")) : undefined,
    activityWindowDays: params.has("activityWindowDays") ? Number(params.get("activityWindowDays")) : undefined,
    sort: (["name", "upn", "company", "department", "service", "appActivity", "responses", "agentsUsed", "lastActivity", "creatorType", "activeUsers", "licensedUsers", "unlicensedUsers", "acceptedAt"] as const).find(value => value === params.get("sort")),
    order: params.get("order") === "asc" ? "asc" : "desc",
  };
}
export function selectedFixtureWindow<T>(input: string, rows: T[], base: ReportPage<T>): ReportPage<T> {
  const params = new URL(input, "http://localhost").searchParams;
  const cursor = params.get("cursor"), start = cursor ? Number(cursor.replace(/^fixture:/, "")) : 0;
  const limit = Math.min(100, Number(params.get("limit") ?? 50));
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid synthetic cursor page");
  return { ...base, value: rows.slice(start, start + limit), counts: { ...base.counts, filtered: rows.length },
    selection: { ...base.selection, id: params.get("selectionId") ?? base.selection.id },
    page: { limit, nextCursor: start + limit < rows.length ? `fixture:${start + limit}` : null,
      previousCursor: start > 0 ? `fixture:${Math.max(0, start - limit)}` : null } };
}
export function selectedFixtureLicensedRows(directory: ReportPage<CombinedUser>, query: ReportQuery): CombinedUser[] {
  const threshold = query.lowResponseThreshold ?? 5;
  const value = directory.value.filter(row => row.entitlement === "paid_active"
    && (!query.search || `${row.directory.displayName} ${row.directory.userPrincipalName} ${relationships.filter(link =>
      link.username === row.directory.userPrincipalName).map(link => `${link.agentName} ${link.agentId}`).join(" ")}`.toLowerCase().includes(query.search.toLowerCase()))
    && (query.company === undefined || (row.directory.companyName?.trim() || null) === query.company)
    && (query.department === undefined || (row.directory.department?.trim() || null) === query.department)
    && (!query.cohort || ["all", "licensed"].includes(query.cohort)
      || query.cohort === "using_agents" && row.agentActivityState === "active"
      || query.cohort === "no_agent_activity" && row.agentActivityState === "none"
      || query.cohort === "needs_attention" && directory.sources.directory.state === "available" && (
        row.reportedResponses !== null && row.reportedResponses <= threshold || ["warning", "partially_enabled"].includes(row.copilotServiceState))
      || query.cohort === "unknown_metrics" && row.agentActivityState === "unknown"));
  const sortValue = (row: CombinedUser) => query.sort === "name" ? row.directory.displayName : query.sort === "company" ? row.directory.companyName
    : query.sort === "department" ? row.directory.department : query.sort === "service" ? row.copilotServiceState
      : query.sort === "agentsUsed" ? row.reportedAgentsUsed : query.sort === "lastActivity" ? row.userLastActivityDateUtc : row.reportedResponses;
  return value.sort((a, b) => {
    const left = sortValue(a), right = sortValue(b);
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    return (query.order === "asc" ? 1 : -1) * (typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right)));
  });
}
export function selectedFixtureRead(input: string, directory = selectedUsersPage()):
  ReportPage<ReportRow> | OfficialReportDetail<CombinedUser | ReportUser | ReportAgent> | OfficialReportFacetPage | undefined {
  const url = new URL(input, "http://localhost"), query = selectedFixtureQuery(input), path = url.pathname;
  const selectedReports = { ...structuredClone(directory.reports), setId: query.setId ?? directory.reports.setId };
  const selection = { ...directory.selection, id: url.searchParams.get("selectionId") ?? directory.selection.id };
  const selected = <T>(page: ReportPage<T>): ReportPage<T> => ({ ...page, selection, reports: selectedReports, sources: directory.sources });
  if (path.endsWith("/facets") && ["/api/copilot-usage/users/facets", "/api/official-usage/users/facets", "/api/official-usage/aggregate/facets"].includes(path)) {
    const field = url.searchParams.get("field");
    if (path === "/api/copilot-usage/users/facets") {
      const values = new Map<string | null, number>(), search = url.searchParams.get("search")?.toLowerCase();
      for (const row of directory.value.filter(row => row.entitlement === "paid_active")) {
        const value = (field === "company" ? row.directory.companyName : row.directory.department)?.trim() || null;
        if (!search || (value ?? "").toLowerCase().includes(search)) values.set(value, (values.get(value) ?? 0) + 1);
      }
      const rows = [...values].sort(([a], [b]) => a === null ? 1 : b === null ? -1 : a.localeCompare(b)).map(([value, count]) => ({ value, count }));
      const page = selectedFixtureWindow(input, rows, reportPage(rows, { counts: { total: rows.length, filtered: rows.length } }));
      return { value: page.value, counts: page.counts, page: page.page, selection };
    }
    return { value: [{ value: field === "company" ? "Contoso Health" : field === "department" ? "Operations" : "Microsoft", count: 4 }],
      selection, counts: { total: 1, filtered: 1 }, page: { limit: 50, nextCursor: null, previousCursor: null } };
  }
  if (path === "/api/copilot-usage/users") {
    const value = selectedFixtureLicensedRows(directory, query);
    return selected(selectedFixtureWindow(input, value, { ...directory, filters: query }));
  }
  if (path === "/api/copilot-usage/users/unresolved-identities") return selected(fixturePage<UnresolvedReportIdentity>([{
    username: "hidden-identity", reason: "not_found", responses: 12, hasActivity: true,
  }]));
  if (path.startsWith("/api/copilot-usage/users/")) {
    const [objectId, child] = path.slice("/api/copilot-usage/users/".length).split("/");
    const row = directory.value.find(user => user.directory.objectId === decodeURIComponent(objectId));
    if (!row) return undefined;
    if (child === "service-plans") return selected(row.servicePlanCount ? selectedPlansPage()
      : reportPage<UserSourcePlan>([], { counts: { total: 0, filtered: 0 } }));
    if (child === "agents") return selected(selectedRelationshipsPage({ ...query, username: row.directory.userPrincipalName ?? undefined }));
    if (!child) return { value: row, selection, reports: selectedReports, sources: directory.sources };
  }
  if (path === "/api/official-usage/history") return selected(selectedHistoryPage());
  if (path === "/api/official-usage/overview") return selected(selectedOverviewPage(query));
  if (path === "/api/official-usage/aggregate") return selected(selectedAgentsPage(query));
  if (path === "/api/official-usage/users") return selected(selectedReportUsersPage(query));
  if (path.startsWith("/api/official-usage/agents/")) {
    const [encodedId, child] = path.slice("/api/official-usage/agents/".length).split("/"), agentId = decodeURIComponent(encodedId);
    if (child === "users") return selected(selectedRelationshipsPage({ ...query, agentId }));
    if (!child) return { ...selectedAgentDetail(agentId), selection, reports: selectedReports };
  }
  if (path.startsWith("/api/official-usage/users/")) {
    const [encodedId, child] = path.slice("/api/official-usage/users/".length).split("/"), username = decodeURIComponent(encodedId);
    if (child === "agents") return selected(selectedRelationshipsPage({ ...query, username }));
    const value = selectedReportUsersPage(query).value.find(row => row.username === username);
    if (child === "service-plans" && value?.objectId) {
      const user = directory.value.find(row => row.directory.objectId === value.objectId);
      if (user) return selected(user.servicePlanCount ? selectedPlansPage() : reportPage<UserSourcePlan>([], { counts: { total: 0, filtered: 0 } }));
    }
    if (child === "directory" && value?.objectId) {
      const user = directory.value.find(row => row.directory.objectId === value.objectId);
      if (user) return { value: user, selection, reports: selectedReports, sources: directory.sources };
    }
    if (!child && value) return { value, selection, reports: selectedReports, sources: directory.sources };
  }
  return undefined;
}
