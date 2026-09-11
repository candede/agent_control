import type { CopilotPackage } from "../types/copilotPackage.js";
import type {
  AcceptedOfficialUsageReports,
  OfficialUsageAgent,
  OfficialUsageAggregateView,
  OfficialUsageAvailability,
  OfficialUsageReportingSummary,
  OfficialUsageTopAgent,
  OfficialUsageUserAgentRow,
  OfficialUsageUserSummary,
  OfficialUsageUserView,
  OfficialUsageValue,
  PublishedOfficialUsage,
  UserAgentUsageRow,
} from "../types/officialUsage.js";

const authority = "Microsoft 365 admin center Copilot Agents usage exports" as const;
const requiredKinds = ["agents", "userAgents", "users"] as const;
const topItemCount = 8;

type ViewOptions = {
  staleAfterDays: number;
  now?: Date;
  inactiveDays?: number;
  activityWindowDays?: number;
  search?: string;
  creatorType?: string;
  activity?: "all" | "recent" | "inactive" | "no-activity";
  responsesOnly?: boolean;
  limit?: number;
  offset?: number;
};

export function buildOfficialUsageAggregateView(
  published: PublishedOfficialUsage,
  packages: readonly CopilotPackage[],
  options: ViewOptions,
): OfficialUsageAggregateView {
  const viewState = availability(published, options.staleAfterDays, options.now ?? new Date());
  const usageRows = buildAgentUsage(published.reports);
  const inactiveDays = boundedDays(options.inactiveDays, 30);
  const activityWindowDays = boundedDays(options.activityWindowDays, 30);
  const summary = reportingSummary(
    packages,
    usageRows,
    published.reports,
    inactiveDays,
    activityWindowDays,
    options.now ?? new Date(),
  );
  const paging = boundedPaging(options.limit, options.offset, 100_000);
  const sortedRows = [...usageRows].sort((left, right) => ordinal(left.agentId, right.agentId));

  return {
    authority,
    availability: viewState.value,
    staleAfterDays: options.staleAfterDays,
    periodAgeDays: viewState.periodAgeDays,
    acceptedAgeDays: viewState.acceptedAgeDays,
    activeSet: published.activeSet,
    lineages: lineages(published.reports),
    missingKinds: requiredKinds.filter(kind => !published.reports[kind]),
    summary,
    agents: {
      value: sortedRows.slice(paging.offset, paging.offset + paging.limit),
      count: sortedRows.length,
      ...paging,
    },
  };
}

export function buildOfficialUsageUserView(
  published: PublishedOfficialUsage,
  options: ViewOptions,
): OfficialUsageUserView {
  const viewState = availability(published, options.staleAfterDays, options.now ?? new Date());
  const summaries = buildUserSummaries(published.reports, published.activeSet?.id ?? null);
  const filteredSummaries = filterUserSummaries(summaries, options, options.now ?? new Date());
  const paging = boundedPaging(options.limit, options.offset, 100_000);
  const accessRows = summaries.reduce((total, summary) => total + summary.rows.length, 0);

  return {
    authority,
    availability: viewState.value,
    staleAfterDays: options.staleAfterDays,
    periodAgeDays: viewState.periodAgeDays,
    acceptedAgeDays: viewState.acceptedAgeDays,
    activeSet: published.activeSet,
    lineages: lineages(published.reports),
    filters: { creatorTypes: [...new Set(summaries.flatMap(summary => summary.creatorTypes))].sort(ordinal) },
    counts: {
      users: summaries.length,
      userRows: published.reports.users?.rows.length ?? 0,
      accessRows,
      reportOnlyRows: accessRows,
      totalResponsesReceived: summaries.reduce((total, summary) => total + summary.reportedResponsesReceived, 0),
      mismatchCount: summaries.filter(summary => summary.hasReportMismatch).length,
    },
    topUsersByResponses: [...filteredSummaries]
      .map(summary => ({
        username: summary.username,
        displayName: summary.displayName,
        responses: summary.missingUserReport ? summary.bridgeResponsesSentToUsers : summary.reportedResponsesReceived,
        agentsUsed: summary.missingUserReport ? summary.responseProducingAgentCount : summary.reportedAgentsUsed,
        responsesSource: summary.missingUserReport ? "userAgents" as const : "users" as const,
        agentsUsedSource: summary.missingUserReport ? "userAgents" as const : "users" as const,
        userLastActivityDateUtc: summary.userLastActivityDateUtc,
      }))
      .filter(summary => summary.responses > 0 || summary.agentsUsed > 0)
      .sort((left, right) => right.responses - left.responses || ordinal(left.username, right.username))
      .slice(0, topItemCount),
    users: {
      value: filteredSummaries.slice(paging.offset, paging.offset + paging.limit),
      count: filteredSummaries.length,
      ...paging,
    },
  };
}

function availability(published: PublishedOfficialUsage, staleAfterDays: number, now: Date): { value: OfficialUsageAvailability; periodAgeDays: number | null; acceptedAgeDays: number | null } {
  if (published.activeSelectionIncomplete) return { value: "incomplete", periodAgeDays: null, acceptedAgeDays: null };
  if (!published.activeSet) {
    const value = published.retainedIncompleteSets > 0
      ? "incomplete"
      : published.retainedCompleteSets > 0 ? "not_selected" : published.hasImportHistory ? "deleted" : "never_imported";
    return { value, periodAgeDays: null, acceptedAgeDays: null };
  }
  const end = Date.parse(`${published.activeSet.reportingPeriod.endDate}T23:59:59.999Z`);
  const periodAgeDays = Math.max(0, Math.floor((now.getTime() - end) / 86_400_000));
  const acceptedAgeDays = Math.max(0, Math.floor((now.getTime() - Date.parse(published.activeSet.acceptedAt!)) / 86_400_000));
  return { value: periodAgeDays > staleAfterDays || acceptedAgeDays > staleAfterDays ? "stale" : "active", periodAgeDays, acceptedAgeDays };
}

function buildAgentUsage(reports: AcceptedOfficialUsageReports): OfficialUsageAgent[] {
  const byAgent = new Map<string, UserAgentUsageRow[]>();
  for (const row of reports.userAgents?.rows ?? []) {
    const rows = byAgent.get(row.agentId) ?? [];
    rows.push(row);
    byAgent.set(row.agentId, rows);
  }
  const reported = new Map(reports.agents?.rows.map(row => [row.agentId, row]) ?? []);
  const agentIds = new Set([...reported.keys(), ...byAgent.keys()]);
  return [...agentIds].map(agentId => {
    const reportRow = reported.get(agentId);
    const rows = byAgent.get(agentId) ?? [];
    const first = rows[0];
    const bridgeResponses = sum(rows, row => row.responsesSentToUsers);
    const bridgeUsers = reports.userAgents ? new Set(rows.map(row => row.username)).size : null;
    if (reportRow) {
      return {
        agentId: reportRow.agentId,
        agentName: reportRow.agentName,
        creatorType: reportRow.creatorType,
        activeUsersLicensed: reportRow.activeUsersLicensed,
        activeUsersUnlicensed: reportRow.activeUsersUnlicensed,
        activeUsersTotal: bridgeUsers,
        responsesSentToUsers: reportRow.responsesSentToUsers,
        lastActivityDateUtc: reportRow.lastActivityDateUtc,
        sourceReport: "agents" as const,
        sourceReports: rows.length ? ["agents", "userAgents"] as const : ["agents"] as const,
        activeUsersIdentityCount: bridgeUsers,
        activeUsersTotalBasis: reports.userAgents ? "userAgents_distinct_identity" as const : "unknown" as const,
        responseComparison: sourceComparison({ agents: reportRow.responsesSentToUsers, userAgents: rows.length ? bridgeResponses : null }),
        creatorTypeSource: "agents_report" as const,
        identityStatus: "unresolved" as const,
      };
    }
    return {
      agentId,
      agentName: first?.agentName ?? "",
      creatorType: first?.creatorType ?? "",
      activeUsersLicensed: null,
      activeUsersUnlicensed: null,
      activeUsersTotal: bridgeUsers,
      responsesSentToUsers: bridgeResponses,
      lastActivityDateUtc: latestDate(rows.map(row => row.lastActivityDateUtc)),
      sourceReport: "userAgents",
      sourceReports: ["userAgents"],
      activeUsersIdentityCount: bridgeUsers,
      activeUsersTotalBasis: reports.userAgents ? "userAgents_distinct_identity" : "unknown",
      responseComparison: sourceComparison({ agents: null, userAgents: bridgeResponses }),
      creatorTypeSource: "users_and_agents_report",
      identityStatus: "unresolved",
    };
  });
}

function reportingSummary(
  packages: readonly CopilotPackage[],
  usageRows: readonly OfficialUsageAgent[],
  reports: AcceptedOfficialUsageReports,
  inactiveDays: number,
  activityWindowDays: number,
  now: Date,
): OfficialUsageReportingSummary {
  const inactiveAgents = usageRows.filter(row => isInactive(row.lastActivityDateUtc, inactiveDays, now)).length;
  const anchorDateUtc = latestDate(usageRows.map(row => row.lastActivityDateUtc));
  const windowRows = usageRows.filter(row => inWindow(row.lastActivityDateUtc, anchorDateUtc, activityWindowDays));
  const totalResponses = reports.agents ? sum(reports.agents.rows, row => row.responsesSentToUsers) : null;
  const totalActiveUsers = distinctDatasetUsers(reports);
  const windowAgentIds = new Set(windowRows.map(row => row.agentId));
  const windowActiveUsers = reports.userAgents ? new Set(
    reports.userAgents.rows.filter(row => windowAgentIds.has(row.agentId)).map(row => row.username),
  ).size : null;
  const windowResponses = reports.agents
    ? sum(windowRows.filter(row => row.sourceReport === "agents"), row => row.responsesSentToUsers)
    : null;

  return {
    catalog: {
      totalAgents: packages.length,
      allowedAgents: packages.filter(agent => !agent.isBlocked).length,
      blockedAgents: packages.filter(agent => agent.isBlocked).length,
      inactiveAgents,
      noImportedUsageAgents: packages.length,
      statusDistribution: compactDistribution([
        { name: "Allowed", value: packages.filter(agent => !agent.isBlocked).length },
        { name: "Blocked", value: packages.filter(agent => agent.isBlocked).length },
      ]),
      availabilityDistribution: topDistribution(countBy(packages, agent => formatDetailLabel(agent.availableTo))),
      hostDistribution: topDistribution(countNested(packages, agent => agent.supportedHosts?.map(formatDetailLabel))),
      publisherDistribution: topDistribution(countBy(packages, agent => agent.publisher)),
      platformDistribution: topDistribution(countBy(packages, builtWithLabel)),
      typeDistribution: topDistribution(countBy(packages, agent => formatDetailLabel(agent.type))),
    },
    usage: {
      hasAgentUsage: usageRows.length > 0,
      totalResponses,
      totalResponsesBasis: reports.agents ? "agents_report" : "unknown",
      totalResponsesCoverage: "agents_report_only",
      totalActiveUsers,
      totalActiveUsersBasis: reports.users || reports.userAgents ? "users_and_users_agents_distinct_identity" : "unknown",
      responseReconciliation: sourceComparison({
        agents: reports.agents ? sum(reports.agents.rows, row => row.responsesSentToUsers) : null,
        userAgents: reports.userAgents ? sum(reports.userAgents.rows, row => row.responsesSentToUsers) : null,
        users: reports.users ? sum(reports.users.rows, row => row.agentResponsesReceived) : null,
      }),
      activeUserReconciliation: sourceComparison({
        users: reports.users ? new Set(reports.users.rows.map(row => row.username)).size : null,
        userAgents: reports.userAgents ? new Set(reports.userAgents.rows.map(row => row.username)).size : null,
      }),
      creatorTypeDistribution: topDistribution(countBy(usageRows, row => row.creatorType)),
      topAgentsByResponses: topAgents(usageRows.filter(row => row.sourceReport === "agents"), row => row.responsesSentToUsers),
      topAgentsByActiveUsers: topAgents(usageRows, row => row.activeUsersTotal),
      lastActivityRange: dateRange(usageRows.map(row => row.lastActivityDateUtc)),
      activeUsersAreNonAdditive: true,
    },
    activityWindow: {
      anchorDateUtc,
      activeAgents: windowRows.length,
      totalAgents: usageRows.length,
      activeUsers: windowActiveUsers,
      totalActiveUsers,
      responses: windowResponses,
      totalResponses,
      responseBasis: reports.agents ? "agents_report" : "unknown",
      agentDistribution: ratioDistribution("Active in window", windowRows.length, "Outside window", usageRows.length - windowRows.length),
      activeUserDistribution: windowActiveUsers === null || totalActiveUsers === null ? [] : ratioDistribution("On active-window agents", windowActiveUsers, "Remaining imported usage", totalActiveUsers - windowActiveUsers),
      creatorTypeDistribution: topDistribution(countBy(windowRows, row => row.creatorType)),
      topAgentsByResponses: topAgents(windowRows.filter(row => row.sourceReport === "agents"), row => row.responsesSentToUsers),
    },
  };
}

function distinctDatasetUsers(reports: AcceptedOfficialUsageReports) {
  if (!reports.users && !reports.userAgents) return null;
  const identities = [
    ...(reports.users?.rows.map(row => row.username) ?? []),
    ...(reports.userAgents?.rows.map(row => row.username) ?? []),
  ];
  return new Set(identities).size;
}

function buildUserSummaries(reports: AcceptedOfficialUsageReports, reportSetId: string | null): OfficialUsageUserSummary[] {
  const users = new Map((reports.users?.rows ?? []).map(row => [row.username, row]));
  const access = new Map<string, OfficialUsageUserAgentRow[]>();
  for (const row of reports.userAgents?.rows ?? []) {
    const projected: OfficialUsageUserAgentRow = {
      ...row,
      displayAgentName: row.agentName || row.agentId,
      packageStatus: "report-only",
      hasResponses: row.responsesSentToUsers > 0,
      identityStatus: "unresolved",
      creatorTypeSource: "users_and_agents_report",
    };
    const rows = access.get(row.username) ?? [];
    rows.push(projected);
    access.set(row.username, rows);
  }
  const usernames = new Set([...users.keys(), ...access.keys()]);
  return [...usernames].map(username => {
    const user = users.get(username);
    const rows = [...(access.get(username) ?? [])].sort(compareAccessRows);
    const responseProducingAgentCount = rows.filter(row => row.hasResponses).length;
    const bridgeResponsesSentToUsers = sum(rows, row => row.responsesSentToUsers);
    const displayName = user?.displayName || username;
    const creatorTypes = [...new Set(rows.map(row => row.creatorType).filter(Boolean))].sort(ordinal);
    return {
      username,
      displayName,
      reportedAgentsUsed: user?.numberOfAgentsUsed ?? 0,
      reportedResponsesReceived: user?.agentResponsesReceived ?? 0,
      userLastActivityDateUtc: user?.lastActivityDateUtc,
      agentsAccessedTotal: rows.length,
      responseProducingAgentCount,
      bridgeResponsesSentToUsers,
      missingUserReport: !user,
      hasReportMismatch: Boolean(user && (user.numberOfAgentsUsed !== responseProducingAgentCount || user.agentResponsesReceived !== bridgeResponsesSentToUsers)),
      creatorTypes,
      rows,
      searchableText: [displayName, username, ...creatorTypes, ...rows.flatMap(row => [row.displayAgentName, row.agentId])].filter(Boolean).join(" ").toLowerCase(),
      datasetScope: {
        reportSetId,
        usersVersionId: reports.users?.lineage.versionId ?? null,
        userAgentsVersionId: reports.userAgents?.lineage.versionId ?? null,
      },
    };
  }).sort(compareUserSummaries);
}

function lineages(reports: AcceptedOfficialUsageReports) {
  return requiredKinds.flatMap(kind => reports[kind]?.lineage ? [reports[kind].lineage] : []);
}

function filterUserSummaries(summaries: OfficialUsageUserSummary[], options: ViewOptions, now: Date) {
  const query = options.search?.trim().toLowerCase();
  const inactiveDays = boundedDays(options.inactiveDays, 30);
  return summaries.filter(summary => {
    if (query && !summary.searchableText.includes(query)) return false;
    if (options.creatorType && options.creatorType !== "all" && !summary.creatorTypes.includes(options.creatorType)) return false;
    if (options.responsesOnly && !summary.rows.some(row => row.hasResponses)) return false;
    if (!options.activity || options.activity === "all") return true;
    if (!summary.userLastActivityDateUtc) return options.activity === "no-activity";
    const inactive = isInactive(summary.userLastActivityDateUtc, inactiveDays, now);
    return options.activity === "inactive" ? inactive : options.activity === "recent" ? !inactive : true;
  });
}

function sourceComparison(sourceValues: Record<string, number | null>) {
  const comparable = Object.values(sourceValues).filter((value): value is number => value !== null);
  if (comparable.length < 2) return { sourceValues, status: "not_comparable" as const, difference: null };
  const difference = Math.max(...comparable) - Math.min(...comparable);
  return { sourceValues, status: difference === 0 ? "matching" as const : "mismatch" as const, difference };
}

function boundedPaging(limit: number | undefined, offset: number | undefined, maximum: number) {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit!, 1), maximum) : Math.min(maximum, 500);
  const boundedOffset = Number.isSafeInteger(offset) ? Math.min(Math.max(offset!, 0), 100_000) : 0;
  return { limit: boundedLimit, offset: boundedOffset };
}

function boundedDays(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) ? Math.min(Math.max(value!, 1), 365) : fallback;
}

function topAgents(rows: readonly OfficialUsageAgent[], getValue: (row: OfficialUsageAgent) => number | null): OfficialUsageTopAgent[] {
  return [...rows].filter(row => (getValue(row) ?? 0) > 0)
    .sort((left, right) => (getValue(right) ?? 0) - (getValue(left) ?? 0) || ordinal(left.agentId, right.agentId))
    .slice(0, topItemCount)
    .map(row => ({
      id: row.agentId,
      name: row.agentName || row.agentId,
      status: "Report only",
      responses: row.responsesSentToUsers,
      activeUsers: row.activeUsersTotal,
      activeUsersBasis: row.activeUsersTotalBasis === "userAgents_distinct_identity" ? "users_and_agents_distinct_identity" : "unknown",
      lastActivityDateUtc: row.lastActivityDateUtc,
      creatorType: row.creatorType,
      identityStatus: "unresolved",
    }));
}

function countBy<T>(items: readonly T[], label: (item: T) => string | undefined) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = label(item) || "Unknown";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function countNested<T>(items: readonly T[], labels: (item: T) => Array<string | undefined> | undefined) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const values = labels(item)?.filter((value): value is string => Boolean(value));
    if (!values?.length) counts.set("Unknown", (counts.get("Unknown") ?? 0) + 1);
    else for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function topDistribution(counts: Map<string, number>): OfficialUsageValue[] {
  const values = compactDistribution([...counts].map(([name, value]) => ({ name, value })));
  if (values.length <= topItemCount) return values;
  return [...values.slice(0, topItemCount - 1), { name: "Other", value: sum(values.slice(topItemCount - 1), row => row.value) }];
}

function compactDistribution(rows: OfficialUsageValue[]) {
  return rows.filter(row => row.value > 0).sort((left, right) => right.value - left.value || ordinal(left.name, right.name));
}

function ratioDistribution(activeLabel: string, active: number, remainingLabel: string, remaining: number) {
  return compactDistribution([{ name: activeLabel, value: active }, { name: remainingLabel, value: Math.max(0, remaining) }]);
}

function compareAccessRows(left: OfficialUsageUserAgentRow, right: OfficialUsageUserAgentRow) {
  return right.responsesSentToUsers - left.responsesSentToUsers || dateNumber(right.lastActivityDateUtc) - dateNumber(left.lastActivityDateUtc) || ordinal(left.displayAgentName, right.displayAgentName);
}

function compareUserSummaries(left: OfficialUsageUserSummary, right: OfficialUsageUserSummary) {
  return dateNumber(right.userLastActivityDateUtc) - dateNumber(left.userLastActivityDateUtc) || right.reportedResponsesReceived - left.reportedResponsesReceived || ordinal(left.displayName, right.displayName) || ordinal(left.username, right.username);
}

function inWindow(value: string | undefined, anchor: string | undefined, days: number) {
  if (!value || !anchor) return false;
  const elapsed = Math.floor((startOfUtcDay(anchor) - startOfUtcDay(value)) / 86_400_000);
  return elapsed >= 0 && elapsed <= days;
}

function isInactive(value: string | undefined, days: number, now: Date) {
  if (!value) return false;
  return Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - startOfUtcDay(value)) / 86_400_000) > days;
}

function startOfUtcDay(value: string) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function latestDate(values: Array<string | undefined>) {
  return values.filter((value): value is string => Boolean(value)).sort((left, right) => dateNumber(right) - dateNumber(left))[0];
}

function dateRange(values: Array<string | undefined>) {
  const dates = values.filter((value): value is string => Boolean(value)).sort((left, right) => dateNumber(left) - dateNumber(right));
  return dates.length ? { earliest: dates[0], latest: dates[dates.length - 1] } : undefined;
}

function dateNumber(value: string | undefined) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDetailLabel(value?: string) {
  return value?.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
}

function builtWithLabel(agent: CopilotPackage) {
  const authoritative = typeof agent.authoringTool === "string" ? agent.authoringTool : agent.platform;
  if (authoritative) return formatBuiltWithValue(authoritative);
  const hint = agent.shortDescription?.trim().match(/^built\s+using\s+(.+?)\.?$/i)?.[1]?.trim();
  return hint ? `Package hint: ${formatBuiltWithValue(hint)}` : undefined;
}

function formatBuiltWithValue(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "").includes("copilotstudio")
    ? "Copilot Studio"
    : formatDetailLabel(value) ?? value;
}

function sum<T>(items: readonly T[], value: (item: T) => number) {
  return items.reduce((total, item) => total + value(item), 0);
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
