import type {
  CombinedUser, ReportAgent, ReportAnalytics, ReportHistorySet, ReportListPage, ReportMetadata, ReportOverviewAgent, ReportPage, ReportQuery, ReportRelationship, ReportRow, ReportUser, UnresolvedReportIdentity,
} from "../../../backend/src/types/officialReportData";
import type { OfficialReportDetail, OfficialReportFacetPage } from "../../../backend/src/types/officialReportApi";
import type { UserSourcePlan } from "../../../backend/src/types/userSources";
import { normalizeReportSearch as normalized } from "../api/reportData";
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
function sortFixtureRows<T>(rows: T[], query: ReportQuery, value: (row: T) => string | number | null): T[] {
  return rows.sort((a, b) => {
    const left = value(a), right = value(b);
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    return (query.order === "desc" ? -1 : 1) * (typeof left === "number" && typeof right === "number"
      ? left - right : normalized(String(left)).localeCompare(normalized(String(right))));
  });
}
export function latestDate(dates: Array<string | null>): string | null {
  return dates.reduce<string | null>((latest, date) => date && (!latest || date > latest) ? date : latest, null);
}
export function matchesActivity(date: string | null, query: ReportQuery, anchor: string | null): boolean {
  const day = date?.slice(0, 10);
  if (query.startDate && (!day || day < query.startDate) || query.endDate && (!day || day > query.endDate)) return false;
  if (!query.reportActivity || query.reportActivity === "all") return true;
  if (query.reportActivity === "no-activity") return !day;
  if (!day || !anchor) return false;
  const since = new Date(Date.parse(anchor.slice(0, 10)) - ((query.inactiveDays ?? 30) - 1) * 86_400_000).toISOString().slice(0, 10);
  return query.reportActivity === "recent" ? day >= since : day < since;
}
function matchesLink(row: ReportAgent | ReportRelationship, query: ReportQuery): boolean {
  return (query.agentId === undefined || row.agentId === query.agentId)
    && (query.creatorType === undefined || row.creatorType === query.creatorType) && (!query.responsesOnly || row.responses > 0);
}
function responseCohort(responses: number | null, threshold: number): ReportUser["reviewCohort"] {
  return responses === null ? "unknown" : responses === 0 ? "zero" : responses <= threshold ? "low" : "outside";
}
export function responseAnalytics(values: Array<number | null>, threshold?: number):
  Pick<ReportAnalytics, "rowCount" | "responses" | "zeroResponses" | "unknownResponses" | "review"> {
  const zero = values.filter(value => value === 0).length, unknown = values.filter(value => value === null).length;
  return { rowCount: values.length, responses: values.reduce<number | null>((sum, value) => value === null ? sum : (sum ?? 0) + value, null),
    zeroResponses: zero, unknownResponses: unknown,
    review: threshold === undefined ? null : { zero, unknown, low: values.filter(value => value !== null && value > 0 && value <= threshold).length } };
}
function fixturePage<T>(value: T[], query: ReportQuery = {}): ReportPage<T> {
  const result = reportPage(structuredClone(value));
  return { ...result, reports: { ...structuredClone(selectedFixtureReports), setId: query.setId ?? reportSetId }, filters: structuredClone(query),
    counts: { total: value.length, filtered: value.length }, summary: { ...result.summary,
      reportedResponses: 270, bridgeResponses: 267, userReportedResponses: 267, distinctActiveReportUsers: 3,
      licensedOccurrences: 4, unlicensedOccurrences: 1, activeWithoutPaidUsers: 1 },
    analytics: { ...result.analytics, rowCount: value.length, responses: null, zeroResponses: null, unknownResponses: null, review: null },
  };
}
export function selectedAgentsPage(query: ReportQuery = {}): ReportPage<ReportAgent> {
  const search = normalized(query.search ?? ""), anchor = latestDate(agents.map(row => row.lastActivityDateUtc));
  const rows = agents.filter(row => (!search || normalized(`${row.agentName} ${row.agentId} ${row.creatorType}`).includes(search))
    && matchesLink(row, query) && matchesActivity(row.lastActivityDateUtc, query, anchor));
  sortFixtureRows(rows, { ...query, order: query.order ?? "desc" }, row => query.sort === "name" ? row.agentName
    : query.sort === "activeUsers" ? row.activeUsers : query.sort === "licensedUsers" ? row.licensedUserOccurrences
      : query.sort === "unlicensedUsers" ? row.unlicensedUserOccurrences : query.sort === "lastActivity" ? row.lastActivityDateUtc : row.responses);
  const window = rows.filter(row => matchesActivity(row.lastActivityDateUtc, {
    reportActivity: "recent", inactiveDays: query.activityWindowDays ?? 30,
  }, anchor));
  const windowIds = new Set(window.map(row => row.agentId));
  const inactiveBefore = new Date(selectedFixtureNow.getTime() - (query.inactiveDays ?? 30) * 86_400_000).toISOString().slice(0, 10);
  const ranked = [...rows].sort((a, b) => b.responses - a.responses || a.agentId.localeCompare(b.agentId));
  const rank = (values: ReportAgent[]) => values.slice(0, 10).map(row => ({ agentId: row.agentId, name: row.agentName, responses: row.responses }));
  const result = fixturePage(rows, query);
  return { ...result, counts: { total: agents.length, filtered: rows.length }, analytics: { ...result.analytics,
    ...responseAnalytics(rows.map(row => row.responses)), agents: {
      inactive: rows.filter(row => row.lastActivityDateUtc !== null && row.lastActivityDateUtc < inactiveBefore).length,
      neverUsed: rows.filter(row => row.lastActivityDateUtc === null).length, anchorDateUtc: anchor,
      windowDays: query.activityWindowDays ?? 30, windowAgents: window.length,
      windowResponses: responseAnalytics(window.map(row => row.responses)).responses,
      windowDistinctActiveUsers: new Set(relationships.filter(row => windowIds.has(row.agentId) && row.responses > 0).map(row => row.username)).size,
      mostResponses: rank(ranked),
      leastResponses: rank([...rows].sort((a, b) => a.responses - b.responses || a.agentId.localeCompare(b.agentId))),
    } } };
}
export function selectedReportUsersPage(query: ReportQuery = {}): ReportPage<ReportUser> {
  const rows = [["Ada", "ada@example.invalid", 215, 2], ["Ben", "ben@example.invalid", 0, 1],
    ["Cleo", "cleo@example.invalid", 40, 1], ["Concealed report user", "concealed-user", 12, 1]].map(([name, username, responses, count], index) =>
    reportUser(index + 1, { username: String(username), displayName: String(name),
      objectId: index === 3 ? null : selectedLicensedUser(index + 1, String(name), Number(responses)).directory.objectId,
      company: index === 3 ? null : "Contoso Health", department: index === 3 ? null : "Operations",
      entitlement: index === 3 ? "unknown" : index === 0 ? "paid_active" : "no_paid", reportedResponses: Number(responses),
      reportedAgentsUsed: Number(count), bridgeResponses: Number(responses),
      relationshipCount: Number(count), responseProducingAgentCount: Number(responses) ? Number(count) : 0,
      userLastActivityDateUtc: index === 0 ? "2026-09-09" : null, lastActivityDateUtc: index === 2 ? "2026-09-11" : "2026-09-12",
      missingUserReport: false, hasReportMismatch: false,
      reviewCohort: responseCohort(Number(responses), query.lowResponseThreshold ?? 5),
      hasActivity: Boolean(Number(responses)) }));
  const search = normalized(query.search ?? ""), anchor = latestDate(rows.map(row => row.userLastActivityDateUtc));
  const selected = rows.filter(row => {
    const links = relationships.filter(link => link.username === row.username && matchesLink(link, query));
    return (!query.licenseCohort || row.hasActivity && ["no_paid", "paid_inactive"].includes(row.entitlement ?? "unknown"))
      && (!search || normalized(`${row.displayName} ${row.username} ${row.company ?? ""} ${row.department ?? ""} ${links.map(link => `${link.agentName} ${link.agentId}`).join(" ")}`).includes(search))
      && (query.username === undefined || row.username === query.username)
      && (query.company === undefined || (row.company?.trim() || null) === query.company)
      && (query.department === undefined || (row.department?.trim() || null) === query.department)
      && (query.entitlement === undefined || row.entitlement === query.entitlement)
      && (!(query.agentId !== undefined || query.creatorType !== undefined || query.responsesOnly) || links.length > 0)
      && (!query.cohort || query.cohort === "all" || query.cohort === row.reviewCohort || query.cohort === "review" && ["zero", "low"].includes(row.reviewCohort))
      && matchesActivity(row.userLastActivityDateUtc, query, anchor);
  });
  sortFixtureRows(selected, query, row => query.sort === "responses" ? row.reportedResponses : query.sort === "agentsUsed" ? row.reportedAgentsUsed
    : query.sort === "lastActivity" ? row.userLastActivityDateUtc : row.displayName);
  const result = fixturePage(selected, query);
  return { ...result,
    counts: { total: rows.length, filtered: selected.length },
    analytics: { ...result.analytics, ...responseAnalytics(selected.map(row => row.reportedResponses), query.lowResponseThreshold ?? 5) } };
}
export function selectedRelationshipsPage(query: ReportQuery = {}, owner: Pick<ReportQuery, "agentId" | "username"> = query): ReportPage<ReportRelationship> {
  const scoped = relationships.filter(row => (owner.agentId === undefined || row.agentId === owner.agentId)
    && (owner.username === undefined || row.username === owner.username));
  const search = normalized(query.search ?? ""), anchor = latestDate(scoped.map(row => row.lastActivityDateUtc));
  const rows = scoped.filter(row => matchesLink(row, query) && (query.username === undefined || row.username === query.username)
    && matchesActivity(row.lastActivityDateUtc, query, anchor)
    && (!search || normalized(`${row.agentName} ${row.agentId} ${row.creatorType} ${row.username}`).includes(search)));
  sortFixtureRows(rows, query, row => query.sort === "responses" ? row.responses : query.sort === "lastActivity" ? row.lastActivityDateUtc
    : query.sort === "creatorType" ? row.creatorType : row.agentName);
  const result = fixturePage(rows, query);
  return { ...result, counts: { total: scoped.length, filtered: rows.length },
    analytics: { ...result.analytics, ...responseAnalytics(rows.map(row => row.responses)) } };
}
export function selectedAgentDetail(agentId = agents[0].agentId): OfficialReportDetail<ReportAgent> {
  const value = agents.find(row => row.agentId === agentId);
  if (!value) throw new Error(`Unknown selected fixture agent: ${agentId}`);
  const page = fixturePage([]);
  return { value: structuredClone(value), selection: page.selection, reports: page.reports, sources: page.sources };
}
export function selectedOverviewPage(query: ReportQuery = {}): ReportPage<ReportOverviewAgent> {
  const selected = selectedAgentsPage({ ...query, sort: query.sort ?? "name", order: query.order ?? "asc" });
  const result = fixturePage(selected.value.map((row, index) => overviewAgent(index + 1, {
    agentId: row.agentId, agentName: row.agentName, observationCount: 2, creatorTypeCount: 1,
    earliestActivityDateUtc: row.lastActivityDateUtc, lastActivityDateUtc: row.lastActivityDateUtc,
    latestSetId: reportSetId, latestAcceptedAt: selectedFixtureReports.acceptedAt!,
  })), query);
  const dates = result.value.map(row => row.lastActivityDateUtc).filter((date): date is string => date !== null).sort();
  return { ...result, counts: selected.counts, analytics: { ...result.analytics, overview: {
    retainedSets: 1, reportedAgents: result.value.length, usedAgents: result.value.filter(row => row.hasResponses).length,
    active30Days: result.value.filter(row => row.active30Days).length, undatedAgents: result.value.length - dates.length,
    earliestActivityDateUtc: dates[0] ?? null, latestActivityDateUtc: dates.at(-1) ?? null,
    asOf: selectedFixtureNow.toISOString(), activeSinceDateUtc: "2026-08-20",
  } } };
}
export function selectedHistoryPage(sets: ReportHistorySet[] = [historySet(1, {
  reportingStart: "2026-08-14", reportingEnd: "2026-09-12", acceptedAt: selectedFixtureReports.acceptedAt!,
})], activeSetId: string | null = reportSetId, query: ReportQuery = {}): ReportPage<ReportHistorySet> {
  const search = normalized(query.search ?? "");
  const rows = sets.filter(row => !search || normalized(`${row.id} ${row.acceptedAt}`).includes(search));
  rows.sort((a, b) => a.id.localeCompare(b.id) * (query.order === "asc" ? 1 : -1));
  sortFixtureRows(rows, { ...query, order: query.order ?? "desc" }, row => query.sort === "acceptedAt" ? row.acceptedAt
    : row.reportingEnd === null ? null : `${row.reportingEnd}/${row.reportingStart ?? ""}/${row.acceptedAt}`);
  const result = fixturePage(rows, query);
  const accepted = rows.map(row => row.acceptedAt).sort();
  const known = rows.filter((row): row is ReportHistorySet & { reportingStart: string; reportingEnd: string } =>
    row.periodProvenance !== "activity_range" && row.reportingStart !== null && row.reportingEnd !== null);
  const starts = known.map(row => row.reportingStart).sort(), ends = known.map(row => row.reportingEnd).sort();
  return { ...result, counts: { total: sets.length, filtered: rows.length }, reports: { ...result.reports, activeSetId }, analytics: { ...result.analytics, history: {
    imports: rows.length, uniqueObservations: rows.length * 3, observationRows: rows.length * 11, uniquePayloads: rows.length * 11, repeatedRowsReused: 0,
    earliestAcceptedAt: accepted[0] ?? null, latestAcceptedAt: accepted.at(-1) ?? null,
    earliestActivityDateUtc: rows.length ? "2026-09-09" : null, latestActivityDateUtc: rows.length ? "2026-09-12" : null,
    earliestReportingStart: starts[0] ?? null, latestReportingEnd: ends.at(-1) ?? null,
    knownWindows: known.length, unknownWindows: rows.length - known.length,
    overlappingKnownWindows: known.filter(row => known.some(other => other.id !== row.id
      && other.reportingStart <= row.reportingEnd && other.reportingEnd >= row.reportingStart)).length,
    additive: false, activityRangeProvesCoverage: false,
  } } };
}

export function selectedFixtureQuery(input: string): ReportQuery {
  const url = new URL(input, "http://localhost"), params = url.searchParams;
  const history = url.pathname === "/api/official-usage/history" || url.pathname === "/api/official-usage/history/options";
  const aggregate = url.pathname === "/api/official-usage/aggregate";
  for (const key of params.keys()) {
    if (params.getAll(key).length !== 1) throw new Error("Expected one synthetic query value per field");
  }
  function choice<T extends string>(key: string, values: readonly T[]): T | undefined {
    const value = params.get(key);
    if (value === null) return undefined;
    const match = values.find(option => option === value);
    if (match === undefined) throw new Error(`Invalid synthetic query ${key}`);
    return match;
  }
  function number(key: string, maximum: number, fallback: number): number {
    const value = params.has(key) ? Number(params.get(key)) : fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid synthetic query ${key}`);
    return value;
  }
  function date(key: string): string | undefined {
    const value = params.get(key);
    if (value === null) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString().slice(0, 10) !== value) throw new Error(`Invalid synthetic query ${key}`);
    return value;
  }
  const search = params.get("search"), startDate = date("startDate"), endDate = date("endDate");
  if (search !== null && (search.length > 256 || normalized(search).length > 256 || /[\p{Cc}\p{Cs}]/u.test(search))) {
    throw new Error("Invalid synthetic query search");
  }
  if (startDate && endDate && startDate > endDate) throw new Error("Invalid synthetic query date range");
  function organization(field: "company" | "department") {
    const value = params.get(field);
    if (value === null) return undefined;
    if (value === "~null") return null;
    if (!value.startsWith("~string:")) throw new Error("Expected the frozen nullable organization encoding");
    return value.slice("~string:".length);
  }
  const query: ReportQuery = { setId: params.get("setId")?.toLowerCase(), search: search === null ? undefined : normalized(search),
    scope: choice("scope", ["history", "selected"]),
    company: organization("company"), department: organization("department"),
    entitlement: choice("entitlement", ["paid_active", "paid_inactive", "no_paid", "unknown"]),
    serviceState: choice("serviceState", ["enabled", "warning", "partially_enabled", "disabled", "suspended", "locked_out", "unknown"]),
    appActivity: choice("appActivity", ["active", "inactive", "unknown"]),
    creatorType: params.get("creatorType") ?? undefined,
    responsesOnly: params.has("responsesOnly") ? choice("responsesOnly", ["true", "false"]) === "true" : undefined,
    startDate, endDate,
    agentId: params.get("agentId") ?? undefined, username: params.get("username") ?? undefined,
    licenseCohort: choice("licenseCohort", ["active_without_paid"]),
    cohort: choice("cohort", ["all", "zero", "low", "review", "licensed", "using_agents", "no_agent_activity", "needs_attention", "unknown_metrics"]),
    reportActivity: choice("reportActivity", ["all", "recent", "inactive", "no-activity"]),
    lowResponseThreshold: number("lowResponseThreshold", 100000000, 5),
    inactiveDays: number("inactiveDays", 365, 30),
    activityWindowDays: number("activityWindowDays", 365, 30),
    sort: choice("sort", ["name", "upn", "company", "department", "service", "appActivity", "responses", "agentsUsed", "lastActivity", "creatorType", "activeUsers", "licensedUsers", "unlicensedUsers", "acceptedAt", "reportingPeriod"])
      ?? (history ? "reportingPeriod" : aggregate ? "responses" : "name"),
    order: choice("order", ["asc", "desc"]) ?? (history || aggregate ? "desc" : "asc"),
  };
  const allowed = [...Object.keys(query), "selectionId", "cursor", "limit", "field"];
  for (const [key, value] of params) {
    if (!allowed.includes(key)) throw new Error(`Unsupported synthetic query ${key}`);
    if (key === "company" || key === "department" || key === "creatorType" || key === "agentId" || key === "username") {
      const maximum = key === "agentId" || key === "username" ? 512 : 256;
      const text = key === "company" || key === "department" ? query[key] : value;
      if (text !== null && text !== undefined && (text.length > maximum || /[\0\r\n]/.test(text)
        || (key === "agentId" || key === "username") && !text.trim())) throw new Error(`Invalid synthetic query ${key}`);
    }
  }
  if (query.setId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(query.setId)) {
    throw new Error("Invalid synthetic query setId");
  }
  return query;
}
export function selectedFixtureWindow<T>(input: string, rows: T[], base: ReportPage<T>): ReportPage<T> {
  const params = new URL(input, "http://localhost").searchParams;
  const cursor = params.get("cursor"), text = params.get("limit") ?? "50";
  const start = cursor === null ? 0 : Number(cursor.slice("fixture:".length)), limit = Number(text);
  if (cursor !== null && !/^fixture:\d+$/.test(cursor) || !/^\d{1,3}$/.test(text)
    || !Number.isSafeInteger(start) || start < 0 || limit < 1 || limit > 100) throw new Error("Invalid synthetic cursor page");
  return structuredClone({ ...base, value: rows.slice(start, start + limit), counts: { ...base.counts, filtered: rows.length },
    selection: { ...base.selection, id: params.get("selectionId") ?? base.selection.id },
    page: { limit, nextCursor: start + limit < rows.length ? `fixture:${start + limit}` : null,
      previousCursor: start > 0 ? `fixture:${Math.max(0, start - limit)}` : null } });
}
export function selectedFixtureLicensedRows(directory: ReportPage<CombinedUser>, query: ReportQuery): CombinedUser[] {
  const threshold = query.lowResponseThreshold ?? 5, search = normalized(query.search ?? "");
  const anchor = latestDate(directory.value.map(row => row.userLastActivityDateUtc));
  const value = directory.value.filter(row => {
    const links = relationships.filter(link => row.reportMatch === "matched" && link.username === row.reportedUsername && matchesLink(link, query));
    const review = responseCohort(row.reportedResponses, threshold);
    return row.entitlement === "paid_active"
      && (!search || normalized(`${row.directory.displayName ?? ""} ${row.directory.userPrincipalName ?? ""} ${row.directory.companyName ?? ""} ${row.directory.department ?? ""} ${links.map(link => `${link.agentName} ${link.agentId}`).join(" ")}`).includes(search))
      && (query.company === undefined || (row.directory.companyName?.trim() || null) === query.company)
      && (query.department === undefined || (row.directory.department?.trim() || null) === query.department)
      && (query.entitlement === undefined || row.entitlement === query.entitlement)
      && (query.serviceState === undefined || row.copilotServiceState === query.serviceState)
      && (query.appActivity === undefined || row.activityState === query.appActivity)
      && (query.username === undefined || row.reportedUsername === query.username)
      && (!query.licenseCohort)
      && (!(query.agentId !== undefined || query.creatorType !== undefined || query.responsesOnly) || links.length > 0)
      && matchesActivity(row.userLastActivityDateUtc, query, anchor)
      && (!query.cohort || ["all", "licensed"].includes(query.cohort) || query.cohort === review
        || query.cohort === "review" && ["zero", "low"].includes(review)
        || query.cohort === "using_agents" && row.agentActivityState === "active"
        || query.cohort === "no_agent_activity" && row.agentActivityState === "none"
        || query.cohort === "needs_attention" && directory.sources.directory.state === "available" && (
          row.agentActivityState === "none" || row.agentActivityState === "active" && review === "low"
          || row.activityState === "inactive" || row.copilotServiceState !== "enabled")
        || query.cohort === "unknown_metrics" && (row.agentActivityState === "unknown" || row.activityState === "unknown"));
  });
  const sortValue = (row: CombinedUser) => query.sort === "upn" ? row.directory.userPrincipalName : query.sort === "company" ? row.directory.companyName
    : query.sort === "department" ? row.directory.department : query.sort === "service" ? row.copilotServiceState
      : query.sort === "agentsUsed" ? row.reportedAgentsUsed : query.sort === "lastActivity" ? row.userLastActivityDateUtc
        : query.sort === "appActivity" ? row.appActivity?.lastActivityDate ?? null : query.sort === "responses" ? row.reportedResponses : row.directory.displayName;
  return sortFixtureRows(value, query, sortValue);
}
export function selectedFixtureRead(input: string, directory = selectedUsersPage()):
  ReportListPage<ReportRow> | OfficialReportDetail<CombinedUser | ReportUser | ReportAgent> | OfficialReportFacetPage | undefined {
  const url = new URL(input, "http://localhost"), path = url.pathname;
  if (!/^\/api\/(?:copilot-usage\/users|official-usage\/(?:history|overview|aggregate|agents|users))(?:\/|$)/.test(path)) return undefined;
  const query = selectedFixtureQuery(input);
  const selectedReports = { ...structuredClone(directory.reports), setId: query.setId ?? directory.reports.setId };
  const selection = { ...directory.selection, id: url.searchParams.get("selectionId") ?? directory.selection.id };
  const selected = <T>(page: ReportPage<T>): ReportPage<T> => selectedFixtureWindow(input, page.value,
    { ...page, selection, reports: selectedReports, sources: directory.sources });
  if (path.endsWith("/facets") && ["/api/copilot-usage/users/facets", "/api/official-usage/users/facets", "/api/official-usage/aggregate/facets"].includes(path)) {
    const field = url.searchParams.get("field"), aggregate = path === "/api/official-usage/aggregate/facets";
    if (aggregate ? field !== "creatorType" : field !== "company" && field !== "department") throw new Error("Unexpected selected fixture facet");
    if (field !== "company" && field !== "department" && field !== "creatorType") throw new Error("Unexpected selected fixture facet");
    const facetQuery = { ...query, search: undefined };
    delete facetQuery[field];
    const facetValues = (query: ReportQuery) => field === "creatorType" ? selectedAgentsPage(query).value.map(row => row.creatorType)
      : path === "/api/copilot-usage/users/facets" ? selectedFixtureLicensedRows(directory, query)
        .map(row => field === "company" ? row.directory.companyName : row.directory.department)
        : selectedReportUsersPage(query).value.map(row => row[field]);
    const values = new Map<string | null, number>(), search = normalized(query.search ?? "");
    for (const option of facetValues(facetQuery)) {
      const value = option?.trim() || null;
      if (!search || normalized(value ?? "").includes(search)) values.set(value, (values.get(value) ?? 0) + 1);
    }
    const rows = [...values].sort(([a], [b]) => a === null ? 1 : b === null ? -1 : a.localeCompare(b)).map(([value, count]) => ({ value, count }));
    const total = new Set(facetValues({}).map(value => value?.trim() || null)).size;
    const page = selectedFixtureWindow(input, rows, reportPage(rows, { counts: { total, filtered: rows.length } }));
    return { value: page.value, counts: page.counts, page: page.page, selection: structuredClone(selection) };
  }
  if (path === "/api/copilot-usage/users") {
    const value = selectedFixtureLicensedRows(directory, query);
    return selected({ ...directory, value, filters: query,
      analytics: { ...directory.analytics, ...responseAnalytics(value.map(row => row.reportedResponses), query.lowResponseThreshold ?? 5) } });
  }
  if (path === "/api/copilot-usage/users/unresolved-identities") return selected(fixturePage<UnresolvedReportIdentity>([{
    username: "hidden-identity", reason: "not_found", responses: 12, hasActivity: true,
  }]));
  if (path.startsWith("/api/copilot-usage/users/")) {
    const [objectId, child, extra] = path.slice("/api/copilot-usage/users/".length).split("/");
    if (extra !== undefined) return undefined;
    const row = directory.value.find(user => user.directory.objectId.toLowerCase() === decodeURIComponent(objectId).toLowerCase());
    if (!row) return undefined;
    if (child === "service-plans") return selected(row.servicePlanCount ? selectedPlansPage()
      : reportPage<UserSourcePlan>([], { counts: { total: 0, filtered: 0 } }));
    if (child === "agents") return selected(row.reportMatch === "matched" && row.reportedUsername !== null
      ? selectedRelationshipsPage(query, { username: row.reportedUsername }) : fixturePage<ReportRelationship>([], query));
    if (!child) return structuredClone({ value: row, selection, reports: selectedReports, sources: directory.sources });
  }
  if (path === "/api/official-usage/history") return selected(selectedHistoryPage(undefined, directory.reports.activeSetId, query));
  if (path === "/api/official-usage/history/options") {
    const { value, page, counts, selection, reports } = selected(selectedHistoryPage(undefined, directory.reports.activeSetId, query));
    return { value, page, counts, selection, reports };
  }
  if (path === "/api/official-usage/overview") return selected(selectedOverviewPage(query));
  if (path === "/api/official-usage/aggregate") return selected(selectedAgentsPage(query));
  if (path === "/api/official-usage/users") return selected(selectedReportUsersPage(query));
  if (path.startsWith("/api/official-usage/agents/")) {
    const [encodedId, child, extra] = path.slice("/api/official-usage/agents/".length).split("/"), agentId = decodeURIComponent(encodedId);
    if (extra !== undefined || !agents.some(row => row.agentId === agentId)) return undefined;
    if (child === "users") return selected(selectedRelationshipsPage(query, { agentId }));
    if (!child) return structuredClone({ ...selectedAgentDetail(agentId), selection, reports: selectedReports, sources: directory.sources });
  }
  if (path.startsWith("/api/official-usage/users/")) {
    const [encodedId, child, extra] = path.slice("/api/official-usage/users/".length).split("/"), username = decodeURIComponent(encodedId);
    if (extra !== undefined || !selectedReportUsersPage().value.some(row => row.username === username)) return undefined;
    if (child === "agents") return selected(selectedRelationshipsPage(query, { username }));
    const value = selectedReportUsersPage(query).value.find(row => row.username === username);
    if (child === "service-plans" && value?.objectId) {
      const user = directory.value.find(row => row.directory.objectId === value.objectId);
      if (user) return selected(user.servicePlanCount ? selectedPlansPage() : reportPage<UserSourcePlan>([], { counts: { total: 0, filtered: 0 } }));
    }
    if (child === "directory" && value?.objectId) {
      const user = directory.value.find(row => row.directory.objectId === value.objectId);
      if (user) return structuredClone({ value: user, selection, reports: selectedReports, sources: directory.sources });
    }
    if (!child && value) return structuredClone({ value, selection, reports: selectedReports, sources: directory.sources });
  }
  return undefined;
}
