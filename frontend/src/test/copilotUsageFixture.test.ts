import { describe, expect, it } from "vitest";
import { buildOfficialUsageUserView } from "../../../backend/src/services/officialUsageViews";
import { copilotUsageFixture, licensedUser } from "./copilotUsageFixture";
import { usageFixtureNow, usageInsightsPublished } from "./usageInsightsFixture";

const importedSummaries = [
  ...copilotUsageFixture.users.flatMap(user => user.importedUsage ? [user.importedUsage] : []),
  ...copilotUsageFixture.unresolvedImportedIdentities.map(identity => identity.importedUsage),
];

describe("Copilot usage fixture contracts", () => {
  it.each(importedSummaries)("matches the backend imported-user projection for $username", summary => {
    const { activeSet, reports } = usageInsightsPublished;
    if (!activeSet || !reports.users || !reports.userAgents) {
      throw new Error("Expected complete synthetic user reports.");
    }
    const projected = buildOfficialUsageUserView({
      ...usageInsightsPublished,
      activeSet: { ...activeSet, id: "synthetic-set" },
      reports: {
        ...reports,
        users: {
          ...reports.users,
          lineage: { ...reports.users.lineage, versionId: "synthetic-users", rowCount: 1 },
          rows: [{
            username: summary.username,
            displayName: summary.displayName,
            numberOfAgentsUsed: summary.reportedAgentsUsed,
            agentResponsesReceived: summary.reportedResponsesReceived,
            lastActivityDateUtc: summary.userLastActivityDateUtc,
          }],
        },
        userAgents: {
          ...reports.userAgents,
          lineage: { ...reports.userAgents.lineage, versionId: "synthetic-bridge", rowCount: summary.rows.length },
          rows: summary.rows.map(({ agentId, agentName, creatorType, username, responsesSentToUsers, lastActivityDateUtc }) => ({
            agentId, agentName, creatorType, username, responsesSentToUsers, lastActivityDateUtc,
          })),
        },
      },
    }, { staleAfterDays: 35, now: usageFixtureNow });

    expect(projected.users.value).toEqual([summary]);
  });

  it("counts recent app activity independently of zero or missing agent usage", () => {
    expect(copilotUsageFixture.sources.appActivity).toMatchObject({
      state: "available", reportRefreshDate: "2026-09-12",
    });
    for (const user of copilotUsageFixture.users) {
      expect(user.appActivity).toMatchObject({
        reportRefreshDate: "2026-09-12", lastActivityDate: "2026-09-11",
      });
    }
    expect(copilotUsageFixture.users.map(user => user.importedUsage?.reportedResponsesReceived ?? null))
      .toEqual([200, 3, 0, null]);
    expect(copilotUsageFixture.counts).toEqual({
      licensedUsers: 4,
      measuredActivityUsers: 4,
      needsAttentionUsers: 2,
      unknownMetricsUsers: 1,
      unresolvedImportedIdentities: 1,
    });
  });

  it.each([
    [null, null, ["agent_usage_unknown"]],
    [0, "zero_responses", ["agent_usage_zero"]],
    [1, "low_responses", ["agent_usage_low"]],
    [5, "low_responses", ["agent_usage_low"]],
    [6, "outside_threshold", []],
  ] as const)("preserves the response-count boundary %s", (count, cohort, attention) => {
    const user = licensedUser(42, "Sample", count);
    expect(user.attention).toEqual(attention);
    if (count === null) {
      expect(user.importedUsage).toBeNull();
    } else {
      expect(user.importedUsage).toMatchObject({
        reportedResponsesReceived: count,
        reviewCohort: cohort,
        reviewCandidate: count <= 5,
      });
    }
    expect(user.appActivity?.lastActivityDate).toBe("2026-09-11");
    expect(user.copilotServiceState).toBe("enabled");
    expect(user.servicePlans).toEqual([expect.objectContaining({
      service: "M365_COPILOT_APPS", state: "enabled", capabilityStatus: "Enabled",
    })]);
    expect(user).not.toHaveProperty("licenses");
  });
});
