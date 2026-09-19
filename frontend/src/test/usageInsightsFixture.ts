import { buildOfficialUsageAggregateView, buildOfficialUsageUserView } from "../../../backend/src/services/officialUsageViews";
import type { OfficialUsageLineage, PublishedOfficialUsage } from "../../../backend/src/types/officialUsage";
import type { OfficialUsageAgentDetailView } from "../api/client";

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
