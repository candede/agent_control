import type { CopilotPackage } from "./api/client";
import { getBuiltWithLabel } from "./agentDisplay";
import type {
  AgentUsageReport,
  AgentUsageRow,
  UserAgentUsageReport,
  UserAgentUsageRow,
  UserUsageReport,
} from "./reportImports";
import { buildUserAccessSummaries } from "./usageModels";

export type ReportingUsageReports = {
  agents?: AgentUsageReport;
  userAgents?: UserAgentUsageReport;
  users?: UserUsageReport;
};

export type ReportingValue = {
  name: string;
  value: number;
};

export type ReportingTopAgent = {
  id: string;
  name: string;
  publisher?: string;
  status: "Allowed" | "Blocked" | "Report only";
  responses: number;
  activeUsers: number;
  lastActivityDateUtc?: string;
};

export type ReportingTopUser = {
  username: string;
  displayName: string;
  responses: number;
  agentsUsed: number;
  latestActivityDateUtc?: string;
};

export type ReportingSummary = {
  catalog: {
    totalAgents: number;
    allowedAgents: number;
    blockedAgents: number;
    inactiveAgents: number;
    noImportedUsageAgents: number;
    statusDistribution: ReportingValue[];
    availabilityDistribution: ReportingValue[];
    hostDistribution: ReportingValue[];
    publisherDistribution: ReportingValue[];
    platformDistribution: ReportingValue[];
    typeDistribution: ReportingValue[];
  };
  usage: {
    hasAgentUsage: boolean;
    hasUserUsage: boolean;
    totalResponses: number;
    totalActiveUsers: number;
    licensedActiveUsers: number;
    unlicensedActiveUsers: number;
    creatorTypeDistribution: ReportingValue[];
    topAgentsByResponses: ReportingTopAgent[];
    topAgentsByActiveUsers: ReportingTopAgent[];
    lastActivityRange?: DateRange;
  };
  activityWindow: {
    anchorDateUtc?: string;
    activeAgents: number;
    totalAgents: number;
    activeUsers: number;
    totalActiveUsers: number;
    responses: number;
    totalResponses: number;
    agentDistribution: ReportingValue[];
    activeUserDistribution: ReportingValue[];
    creatorTypeDistribution: ReportingValue[];
    topAgentsByResponses: ReportingTopAgent[];
  };
  users: {
    importedUsers: number;
    usersWithAccessRows: number;
    totalResponsesReceived: number;
    reportOnlyRows: number;
    mismatchCount: number;
    topUsersByResponses: ReportingTopUser[];
  };
};

type AgentUsageSummary = AgentUsageRow & {
  sourceReport: "agents" | "userAgents";
  userRows: UserAgentUsageRow[];
};

type DateRange = {
  earliest: string;
  latest: string;
};

const unknownLabel = "Unknown";
const topChartItemCount = 8;
const topTableItemCount = 8;

export function buildReportingSummary({
  activityWindowDays,
  agents,
  inactiveDays,
  reports,
}: {
  activityWindowDays: number;
  agents: CopilotPackage[];
  inactiveDays: number;
  reports: ReportingUsageReports;
}): ReportingSummary {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const userAgentRowsByAgentId = groupUserAgentRowsByAgentId(
    reports.userAgents?.rows ?? [],
  );
  const usageByAgentId = buildUsageByAgentId(reports, userAgentRowsByAgentId);
  const userSummaries = buildUserAccessSummaries(
    {
      users: reports.users,
      userAgents: reports.userAgents,
    },
    agents,
  );
  const usageRows = [...usageByAgentId.values()];
  const inactiveAgents = agents.filter((agent) =>
    isInactiveUsage(usageByAgentId.get(agent.id), inactiveDays),
  ).length;
  const activityWindowAnchor = latestDate(
    usageRows.map((row) => row.lastActivityDateUtc),
  );
  const activityWindowRows = usageRows.filter((row) =>
    isActiveUsageInWindow(row, activityWindowDays, activityWindowAnchor),
  );
  const totalResponses = usageRows.reduce(
    (total, row) => total + row.responsesSentToUsers,
    0,
  );
  const totalActiveUsers = usageRows.reduce(
    (total, row) => total + row.activeUsersTotal,
    0,
  );
  const licensedActiveUsers = usageRows.reduce(
    (total, row) => total + row.activeUsersLicensed,
    0,
  );
  const unlicensedActiveUsers = usageRows.reduce(
    (total, row) => total + row.activeUsersUnlicensed,
    0,
  );
  const activityWindowResponses = activityWindowRows.reduce(
    (total, row) => total + row.responsesSentToUsers,
    0,
  );
  const activityWindowActiveUsers = activityWindowRows.reduce(
    (total, row) => total + row.activeUsersTotal,
    0,
  );
  const reportOnlyRows = userSummaries.reduce(
    (total, summary) =>
      total +
      summary.rows.filter((row) => row.packageStatus === "report-only").length,
    0,
  );

  return {
    catalog: {
      totalAgents: agents.length,
      allowedAgents: agents.filter((agent) => !agent.isBlocked).length,
      blockedAgents: agents.filter((agent) => agent.isBlocked).length,
      inactiveAgents,
      noImportedUsageAgents: agents.filter(
        (agent) => !usageByAgentId.has(agent.id),
      ).length,
      statusDistribution: compactDistribution([
        {
          name: "Allowed",
          value: agents.filter((agent) => !agent.isBlocked).length,
        },
        {
          name: "Blocked",
          value: agents.filter((agent) => agent.isBlocked).length,
        },
      ]),
      availabilityDistribution: topDistribution(
        countBy(agents, (agent) => formatDetailLabel(agent.availableTo)),
        topChartItemCount,
      ),
      hostDistribution: topDistribution(
        countNested(agents, (agent) =>
          agent.supportedHosts?.map(formatDetailLabel),
        ),
        topChartItemCount,
      ),
      publisherDistribution: topDistribution(
        countBy(agents, (agent) => agent.publisher),
        topChartItemCount,
      ),
      platformDistribution: topDistribution(
        countBy(agents, (agent) => getBuiltWithLabel(agent)),
        topChartItemCount,
      ),
      typeDistribution: topDistribution(
        countBy(agents, (agent) => formatDetailLabel(agent.type)),
        topChartItemCount,
      ),
    },
    usage: {
      hasAgentUsage: usageRows.length > 0,
      hasUserUsage: Boolean(reports.users || reports.userAgents),
      totalResponses,
      totalActiveUsers,
      licensedActiveUsers,
      unlicensedActiveUsers,
      creatorTypeDistribution: topDistribution(
        countBy(usageRows, (row) => row.creatorType),
        topChartItemCount,
      ),
      topAgentsByResponses: topAgents(
        usageRows,
        agentsById,
        (row) => row.responsesSentToUsers,
      ),
      topAgentsByActiveUsers: topAgents(
        usageRows,
        agentsById,
        (row) => row.activeUsersTotal,
      ),
      lastActivityRange: dateRange(
        usageRows.map((row) => row.lastActivityDateUtc),
      ),
    },
    activityWindow: {
      anchorDateUtc: activityWindowAnchor,
      activeAgents: activityWindowRows.length,
      totalAgents: usageRows.length,
      activeUsers: activityWindowActiveUsers,
      totalActiveUsers,
      responses: activityWindowResponses,
      totalResponses,
      agentDistribution: ratioDistribution(
        "Active in window",
        activityWindowRows.length,
        "Outside window",
        usageRows.length - activityWindowRows.length,
      ),
      activeUserDistribution: ratioDistribution(
        "On active-window agents",
        activityWindowActiveUsers,
        "Remaining imported usage",
        totalActiveUsers - activityWindowActiveUsers,
      ),
      creatorTypeDistribution: topDistribution(
        countBy(activityWindowRows, (row) => row.creatorType),
        topChartItemCount,
      ),
      topAgentsByResponses: topAgents(
        activityWindowRows,
        agentsById,
        (row) => row.responsesSentToUsers,
      ),
    },
    users: {
      importedUsers: reports.users?.rows.length ?? 0,
      usersWithAccessRows: userSummaries.filter(
        (summary) => summary.agentsAccessedTotal > 0,
      ).length,
      totalResponsesReceived: userSummaries.reduce(
        (total, summary) => total + summary.reportedResponsesReceived,
        0,
      ),
      reportOnlyRows,
      mismatchCount: userSummaries.filter(
        (summary) => summary.hasReportMismatch,
      ).length,
      topUsersByResponses: userSummaries
        .map((summary) => ({
          username: summary.username,
          displayName: summary.displayName,
          responses: Math.max(
            summary.reportedResponsesReceived,
            summary.bridgeResponsesSentToUsers,
          ),
          agentsUsed: Math.max(
            summary.reportedAgentsUsed,
            summary.responseProducingAgentCount,
          ),
          latestActivityDateUtc: summary.latestActivityDateUtc,
        }))
        .filter((summary) => summary.responses > 0 || summary.agentsUsed > 0)
        .sort((first, second) => second.responses - first.responses)
        .slice(0, topTableItemCount),
    },
  };
}

function groupUserAgentRowsByAgentId(rows: UserAgentUsageRow[]) {
  const rowsByAgentId = new Map<string, UserAgentUsageRow[]>();

  for (const row of rows) {
    if (!row.agentId) {
      continue;
    }

    const agentRows = rowsByAgentId.get(row.agentId) ?? [];
    agentRows.push(row);
    rowsByAgentId.set(row.agentId, agentRows);
  }

  return rowsByAgentId;
}

function buildUsageByAgentId(
  reports: ReportingUsageReports,
  userAgentRowsByAgentId: Map<string, UserAgentUsageRow[]>,
) {
  const usageByAgentId = new Map<string, AgentUsageSummary>();

  if (reports.agents) {
    for (const row of reports.agents.rows) {
      if (!row.agentId) {
        continue;
      }

      usageByAgentId.set(row.agentId, {
        ...row,
        sourceReport: "agents",
        userRows: userAgentRowsByAgentId.get(row.agentId) ?? [],
      });
    }

    return usageByAgentId;
  }

  for (const [agentId, rows] of userAgentRowsByAgentId) {
    const firstRow = rows[0];
    const usernames = new Set(rows.map((row) => row.username).filter(Boolean));

    usageByAgentId.set(agentId, {
      agentId,
      agentName: firstRow?.agentName ?? "",
      creatorType: firstRow?.creatorType ?? "",
      activeUsersLicensed: 0,
      activeUsersUnlicensed: 0,
      activeUsersTotal: usernames.size,
      responsesSentToUsers: rows.reduce(
        (total, row) => total + row.responsesSentToUsers,
        0,
      ),
      lastActivityDateUtc: latestDate(
        rows.map((row) => row.lastActivityDateUtc),
      ),
      sourceReport: "userAgents",
      userRows: rows,
    });
  }

  return usageByAgentId;
}

function topAgents(
  rows: AgentUsageSummary[],
  agentsById: Map<string, CopilotPackage>,
  getValue: (row: AgentUsageSummary) => number,
) {
  return [...rows]
    .filter((row) => getValue(row) > 0)
    .sort((first, second) => getValue(second) - getValue(first))
    .slice(0, topTableItemCount)
    .map((row) => {
      const agent = agentsById.get(row.agentId);

      return {
        id: row.agentId,
        name: agent?.displayName || row.agentName || row.agentId,
        publisher: agent?.publisher,
        status: agent
          ? agent.isBlocked
            ? "Blocked"
            : "Allowed"
          : "Report only",
        responses: row.responsesSentToUsers,
        activeUsers: row.activeUsersTotal,
        lastActivityDateUtc: row.lastActivityDateUtc,
      } satisfies ReportingTopAgent;
    });
}

function countBy<T>(items: T[], getLabel: (item: T) => string | undefined) {
  const counts = new Map<string, number>();

  for (const item of items) {
    const label = getLabel(item) || unknownLabel;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return counts;
}

function countNested<T>(
  items: T[],
  getLabels: (item: T) => Array<string | undefined> | undefined,
) {
  const counts = new Map<string, number>();

  for (const item of items) {
    const labels = getLabels(item)?.filter((label): label is string =>
      Boolean(label),
    );

    if (!labels?.length) {
      counts.set(unknownLabel, (counts.get(unknownLabel) ?? 0) + 1);
      continue;
    }

    for (const label of labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  return counts;
}

function topDistribution(counts: Map<string, number>, limit: number) {
  const rows = compactDistribution(
    [...counts].map(([name, value]) => ({ name, value })),
  );

  if (rows.length <= limit) {
    return rows;
  }

  const visibleRows = rows.slice(0, limit - 1);
  const otherValue = rows
    .slice(limit - 1)
    .reduce((total, row) => total + row.value, 0);

  return [...visibleRows, { name: "Other", value: otherValue }];
}

function compactDistribution(rows: ReportingValue[]) {
  return rows
    .filter((row) => row.value > 0)
    .sort(
      (first, second) =>
        second.value - first.value || first.name.localeCompare(second.name),
    );
}

function ratioDistribution(
  activeLabel: string,
  activeValue: number,
  remainingLabel: string,
  remainingValue: number,
) {
  return compactDistribution([
    { name: activeLabel, value: activeValue },
    { name: remainingLabel, value: Math.max(0, remainingValue) },
  ]);
}

function isInactiveUsage(
  usage: AgentUsageSummary | undefined,
  inactiveDays: number,
) {
  if (!usage?.lastActivityDateUtc) {
    return false;
  }

  const today = startOfUtcDay(new Date());
  const activityDate = startOfUtcDay(new Date(usage.lastActivityDateUtc));
  const elapsedDays = Math.floor(
    (today.getTime() - activityDate.getTime()) / 86_400_000,
  );

  return elapsedDays > inactiveDays;
}

function isActiveUsageInWindow(
  usage: AgentUsageSummary | undefined,
  inactiveDays: number,
  anchorDateUtc: string | undefined,
) {
  if (!usage?.lastActivityDateUtc || !anchorDateUtc) {
    return false;
  }

  const anchorDate = startOfUtcDay(new Date(anchorDateUtc));
  const activityDate = startOfUtcDay(new Date(usage.lastActivityDateUtc));
  const elapsedDays = Math.floor(
    (anchorDate.getTime() - activityDate.getTime()) / 86_400_000,
  );

  return elapsedDays >= 0 && elapsedDays <= inactiveDays;
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function latestDate(values: Array<string | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((first, second) => Date.parse(second) - Date.parse(first))[0];
}

function dateRange(values: Array<string | undefined>): DateRange | undefined {
  const dates = values
    .filter((value): value is string => Boolean(value))
    .sort((first, second) => Date.parse(first) - Date.parse(second));

  if (!dates.length) {
    return undefined;
  }

  return {
    earliest: dates[0],
    latest: dates[dates.length - 1],
  };
}

function formatDetailLabel(value?: string) {
  if (!value) {
    return undefined;
  }

  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}
