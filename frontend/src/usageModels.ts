import type { CopilotPackage } from "./api/client";
import { getBuiltWithLabel } from "./agentDisplay";
import type {
  UserAgentUsageReport,
  UserAgentUsageRow,
  UserUsageReport,
  UserUsageRow,
} from "./reportImports";

export type UserAccessReports = {
  userAgents?: UserAgentUsageReport;
  users?: UserUsageReport;
};

export type UserAgentAccessRow = UserAgentUsageRow & {
  displayAgentName: string;
  package?: CopilotPackage;
  packageStatus: "allowed" | "blocked" | "report-only";
  publisher?: string;
  builtWith?: string;
  availableTo?: string;
  hasResponses: boolean;
};

export type UserAccessSummary = {
  username: string;
  displayName: string;
  reportedAgentsUsed: number;
  reportedResponsesReceived: number;
  userLastActivityDateUtc?: string;
  agentsAccessedTotal: number;
  responseProducingAgentCount: number;
  bridgeResponsesSentToUsers: number;
  latestActivityDateUtc?: string;
  missingUserReport: boolean;
  hasReportMismatch: boolean;
  creatorTypes: string[];
  rows: UserAgentAccessRow[];
  searchableText: string;
};

export function buildUserAccessSummaries(
  reports: UserAccessReports,
  agents: CopilotPackage[],
) {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const usersByUsername = new Map<string, UserUsageRow>();
  const rowsByUsername = new Map<string, UserAgentAccessRow[]>();

  for (const user of reports.users?.rows ?? []) {
    if (user.username) {
      usersByUsername.set(user.username, user);
    }
  }

  for (const row of reports.userAgents?.rows ?? []) {
    if (!row.username) {
      continue;
    }

    const agentPackage = agentsById.get(row.agentId);
    const accessRow: UserAgentAccessRow = {
      ...row,
      displayAgentName:
        row.agentName || agentPackage?.displayName || row.agentId,
      package: agentPackage,
      packageStatus: agentPackage
        ? agentPackage.isBlocked
          ? "blocked"
          : "allowed"
        : "report-only",
      publisher: agentPackage?.publisher,
      builtWith: agentPackage ? getBuiltWithLabel(agentPackage) : undefined,
      availableTo: agentPackage?.availableTo,
      hasResponses: row.responsesSentToUsers > 0,
    };

    const rows = rowsByUsername.get(row.username) ?? [];
    rows.push(accessRow);
    rowsByUsername.set(row.username, rows);
  }

  const usernames = new Set([
    ...usersByUsername.keys(),
    ...rowsByUsername.keys(),
  ]);

  return [...usernames]
    .map((username) => {
      const user = usersByUsername.get(username);
      const rows = sortAccessRows(rowsByUsername.get(username) ?? []);
      const creatorTypes = [
        ...new Set(rows.map((row) => row.creatorType).filter(Boolean)),
      ].sort((first, second) => first.localeCompare(second));
      const responseProducingAgentCount = rows.filter(
        (row) => row.hasResponses,
      ).length;
      const bridgeResponsesSentToUsers = rows.reduce(
        (total, row) => total + row.responsesSentToUsers,
        0,
      );
      const latestActivityDateUtc = latestDate([
        user?.lastActivityDateUtc,
        ...rows.map((row) => row.lastActivityDateUtc),
      ]);
      const hasReportMismatch = Boolean(
        user &&
        (user.numberOfAgentsUsed !== responseProducingAgentCount ||
          user.agentResponsesReceived !== bridgeResponsesSentToUsers),
      );
      const displayName = user?.displayName || username;

      return {
        username,
        displayName,
        reportedAgentsUsed: user?.numberOfAgentsUsed ?? 0,
        reportedResponsesReceived: user?.agentResponsesReceived ?? 0,
        userLastActivityDateUtc: user?.lastActivityDateUtc,
        agentsAccessedTotal: rows.length,
        responseProducingAgentCount,
        bridgeResponsesSentToUsers,
        latestActivityDateUtc,
        missingUserReport: !user,
        hasReportMismatch,
        creatorTypes,
        rows,
        searchableText: [
          displayName,
          username,
          ...creatorTypes,
          ...rows.flatMap((row) => [row.displayAgentName, row.agentId]),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
      } satisfies UserAccessSummary;
    })
    .sort(compareUserSummaries);
}

function sortAccessRows(rows: UserAgentAccessRow[]) {
  return [...rows].sort((first, second) => {
    const responseDelta =
      second.responsesSentToUsers - first.responsesSentToUsers;

    if (responseDelta !== 0) {
      return responseDelta;
    }

    const dateDelta =
      Date.parse(second.lastActivityDateUtc ?? "") -
      Date.parse(first.lastActivityDateUtc ?? "");

    if (Number.isFinite(dateDelta) && dateDelta !== 0) {
      return dateDelta;
    }

    return first.displayAgentName.localeCompare(second.displayAgentName);
  });
}

function compareUserSummaries(
  first: UserAccessSummary,
  second: UserAccessSummary,
) {
  const dateDelta =
    Date.parse(second.latestActivityDateUtc ?? "") -
    Date.parse(first.latestActivityDateUtc ?? "");

  if (Number.isFinite(dateDelta) && dateDelta !== 0) {
    return dateDelta;
  }

  const responseDelta =
    second.reportedResponsesReceived - first.reportedResponsesReceived;

  if (responseDelta !== 0) {
    return responseDelta;
  }

  return first.displayName.localeCompare(second.displayName);
}

function latestDate(values: Array<string | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((first, second) => Date.parse(second) - Date.parse(first))[0];
}
