import { buildOfficialUsageAggregateView, buildOfficialUsageUserView } from "../../../backend/src/services/officialUsageViews";
import type { OfficialUsageLineage, PublishedOfficialUsage } from "../../../backend/src/types/officialUsage";
import type { OfficialUsageAgentDetailView, OfficialUsageOverviewQuery, OfficialUsageOverviewView, OfficialUsageUserQuery } from "../api/client";
import { licensedUser } from "./copilotUsageFixture";

const period = { startDate: "2026-08-14", endDate: "2026-09-12", days: 30, provenance: "operator_asserted" as const };
const acceptedAt = "2026-09-12T10:00:00.000Z";
export const usageFixtureSetId = "11111111-1111-4111-8111-111111111111";
export const usageFixtureNow = new Date("2026-09-18T10:00:00.000Z");

function lineage(kind: OfficialUsageLineage["kind"], rowCount: number): OfficialUsageLineage {
  return {
    kind, versionId: `insights-${kind}`, fileHash: "a".repeat(64), parserVersion: "1", schemaVersion: "observed-v1",
    reportingPeriod: period, sourceAsOfProvenance: "absent", sourceFreshness: "unknown",
    acceptedAt, rowCount, warnings: [], reconciliation: {}, supersedesVersionId: null,
  };
}

const base = { parserVersion: "1", schemaVersion: "observed-v1", reportingPeriod: period, sourceAsOfProvenance: "absent" as const, sourceFreshness: "unknown" as const, warnings: [] };
export const usageInsightsPublished: PublishedOfficialUsage = {
  activeRevision: 1,
  activeSet: {
    id: usageFixtureSetId, bundleId: "22222222-2222-4222-8222-222222222222",
    reportingPeriod: period, supersedesSetId: null, complete: true, kinds: ["agents", "userAgents", "users"],
    acceptedAt, deletedAt: null, createdAt: acceptedAt, expiresAt: null,
  },
  retainedCompleteSets: 1, retainedIncompleteSets: 0, hasImportHistory: true, activeSelectionIncomplete: false,
  reports: {
    agents: {
      ...base, kind: "agents", lineage: lineage("agents", 2),
      rows: [
        { agentId: "synthetic-researcher", agentName: "Researcher", creatorType: "Microsoft", activeUsersLicensed: 2, activeUsersUnlicensed: 1, responsesSentToUsers: 215, lastActivityDateUtc: "2026-09-12T00:00:00.000Z" },
        { agentId: "helpdesk/report:2", agentName: "Helpdesk", creatorType: "Your org", activeUsersLicensed: 2, activeUsersUnlicensed: 0, responsesSentToUsers: 55, lastActivityDateUtc: "2026-09-11T00:00:00.000Z" },
      ],
    },
    userAgents: {
      ...base, kind: "userAgents", lineage: lineage("userAgents", 5),
      rows: [
        { agentId: "synthetic-researcher", agentName: "Researcher", creatorType: "Microsoft", username: "ada@example.invalid", responsesSentToUsers: 200, lastActivityDateUtc: "2026-09-12T00:00:00.000Z" },
        { agentId: "synthetic-researcher", agentName: "Researcher", creatorType: "Microsoft", username: "ben@example.invalid", responsesSentToUsers: 0, lastActivityDateUtc: "2026-09-12T00:00:00.000Z" },
        { agentId: "synthetic-researcher", agentName: "Researcher", creatorType: "Microsoft", username: "concealed-user", responsesSentToUsers: 12, lastActivityDateUtc: "2026-09-12T00:00:00.000Z" },
        { agentId: "helpdesk/report:2", agentName: "Helpdesk", creatorType: "Your org", username: "ada@example.invalid", responsesSentToUsers: 15, lastActivityDateUtc: "2026-09-11T00:00:00.000Z" },
        { agentId: "helpdesk/report:2", agentName: "Helpdesk", creatorType: "Your org", username: "cleo@example.invalid", responsesSentToUsers: 40, lastActivityDateUtc: "2026-09-11T00:00:00.000Z" },
      ],
    },
    users: {
      ...base, kind: "users", lineage: lineage("users", 4),
      rows: [
        { username: "ada@example.invalid", displayName: "Ada", numberOfAgentsUsed: 2, agentResponsesReceived: 215, lastActivityDateUtc: "2026-09-09T00:00:00.000Z" },
        { username: "ben@example.invalid", displayName: "Ben", numberOfAgentsUsed: 1, agentResponsesReceived: 0 },
        { username: "cleo@example.invalid", displayName: "Cleo", numberOfAgentsUsed: 1, agentResponsesReceived: 40 },
        { username: "concealed-user", displayName: "Concealed report user", numberOfAgentsUsed: 1, agentResponsesReceived: 12 },
      ],
    },
  },
};

export function usageAggregateFixture(query: Parameters<typeof buildOfficialUsageAggregateView>[2] = { staleAfterDays: 35 }) {
  return buildOfficialUsageAggregateView(structuredClone(usageInsightsPublished), [], { now: usageFixtureNow, ...query });
}

export function usageUsersFixture(query: Parameters<typeof buildOfficialUsageUserView>[1] = { staleAfterDays: 35 }) {
  return buildOfficialUsageUserView(structuredClone(usageInsightsPublished), { now: usageFixtureNow, ...query });
}

export function reportLicenseDirectory(published = usageInsightsPublished, paidUsernames: string[] = []) {
  const identities = [...new Set([
    ...published.reports.users?.rows.map(user => user.username) ?? [],
    ...published.reports.userAgents?.rows.map(user => user.username) ?? [],
  ])].filter(username => username !== "concealed-user");
  const value = identities.map((username, index) => {
    const user = licensedUser(index + 1, username, null);
    const state = paidUsernames.includes(username) ? "enabled" as const : "disabled" as const;
    return {
      serviceEvidenceVersion: 1 as const,
      identity: { ...user.directory, userPrincipalName: username },
      copilotServiceState: state,
      servicePlans: user.servicePlans.map(plan => ({ ...plan, state })),
    };
  });
  return {
    source: "directory" as const, attemptStatus: "available" as const, message: null,
    attemptedAt: acceptedAt, lastSuccessAt: acceptedAt,
    rowCount: value.length, observedAt: acceptedAt, value,
  };
}

export function activeWithoutPaidUsersFixture(query: OfficialUsageUserQuery = {}) {
  const published = structuredClone(usageInsightsPublished);
  published.reports.userAgents!.rows.find(row => row.username === "ben@example.invalid")!.responsesSentToUsers = 3;
  return buildOfficialUsageUserView(published, {
    staleAfterDays: 35, now: usageFixtureNow, ...query, userSortBy: query.sortBy, licenseCohort: "active_without_paid",
    licenseDirectory: reportLicenseDirectory(published, ["ada@example.invalid"]),
  });
}

export function usageOverviewFixture(query: OfficialUsageOverviewQuery = {}): OfficialUsageOverviewView {
  const agents = usageAggregateFixture().agents.value.map(agent => ({
    agentId: agent.agentId, agentName: agent.agentName, creatorTypes: [agent.creatorType],
    hasResponses: agent.responsesSentToUsers > 0, lastActivityDateUtc: agent.lastActivityDateUtc ?? null,
    observationCount: 2, latestSetId: usageFixtureSetId, latestAcceptedAt: acceptedAt,
  }));
  const search = query.search?.toLowerCase();
  const matching = agents.filter(agent => (!search || `${agent.agentName} ${agent.agentId} ${agent.creatorTypes.join(" ")}`.toLowerCase().includes(search))
    && (!query.startDate || Boolean(agent.lastActivityDateUtc && agent.lastActivityDateUtc.slice(0, 10) >= query.startDate))
    && (!query.endDate || Boolean(agent.lastActivityDateUtc && agent.lastActivityDateUtc.slice(0, 10) <= query.endDate)));
  const sortBy = query.sortBy ?? "lastActivity";
  const sortDirection = query.sortDirection ?? "desc";
  matching.sort((a, b) => {
    const left = sortBy === "agentName" ? a.agentName : a.lastActivityDateUtc;
    const right = sortBy === "agentName" ? b.agentName : b.lastActivityDateUtc;
    if (left === null || right === null) return left === right ? a.agentId.localeCompare(b.agentId) : left === null ? 1 : -1;
    return (sortDirection === "asc" ? 1 : -1) * left.localeCompare(right) || a.agentId.localeCompare(b.agentId);
  });
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 25;
  return {
    revision: 1,
    summary: {
      retainedSets: 1, reportedAgents: 2, usedAgents: 2, activeAgents30Days: 2, undatedAgents: 0,
      earliestActivityDateUtc: "2026-09-11", latestActivityDateUtc: "2026-09-12",
      asOf: usageFixtureNow.toISOString(), activeSinceDateUtc: "2026-08-20",
    },
    agents: { value: matching.slice(offset, offset + limit), count: matching.length, limit, offset },
    filters: { search: query.search ?? null, startDate: query.startDate ?? null, endDate: query.endDate ?? null, sortBy, sortDirection },
  };
}

export function usageAgentDetailFixture(agentId = "synthetic-researcher"): OfficialUsageAgentDetailView {
  const aggregate = usageAggregateFixture();
  const agent = aggregate.agents.value.find(row => row.agentId === agentId);
  if (!agent) throw new Error(`Unknown fixture report agent: ${agentId}`);
  const users = usageUsersFixture().users.value.flatMap(user => user.rows.filter(row => row.agentId === agentId).map(row => ({
    username: user.username, displayName: user.displayName, responsesSentToUsers: row.responsesSentToUsers,
  })));
  return {
    authority: aggregate.authority, availability: aggregate.availability, staleAfterDays: aggregate.staleAfterDays,
    periodAgeDays: aggregate.periodAgeDays, acceptedAgeDays: aggregate.acceptedAgeDays, activeSet: aggregate.activeSet,
    lineages: aggregate.lineages, missingKinds: aggregate.missingKinds, agent,
    summary: {
      reportedUsers: users.length, responseProducingUsers: agent.activeUsersIdentityCount,
      zeroResponseUsers: users.filter(user => user.responsesSentToUsers === 0).length,
      userBreakdownResponses: users.reduce((sum, user) => sum + user.responsesSentToUsers, 0),
    },
    filters: { sortBy: "responses", sortDirection: "desc" },
    users: { value: users.sort((a, b) => b.responsesSentToUsers - a.responsesSentToUsers), count: users.length, limit: 20, offset: 0 },
  };
}
