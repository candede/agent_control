import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OfficialUsageAggregateView, OfficialUsageUserView } from "../api/client";
import { ReportingView } from "./ReportingView";
import { UserAccessView } from "./UserAccessView";

vi.mock("recharts", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Empty = () => null;
  return {
    Bar: Empty,
    BarChart: Container,
    CartesianGrid: Empty,
    Cell: Empty,
    Legend: Empty,
    Pie: Container,
    PieChart: Container,
    ResponsiveContainer: Container,
    Tooltip: Empty,
    XAxis: Empty,
    YAxis: Empty,
  };
});

const activeSet = {
  id: "11111111-1111-4111-8111-111111111111",
  bundleId: "22222222-2222-4222-8222-222222222222",
  reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06" },
  supersedesSetId: "33333333-3333-4333-8333-333333333333",
  complete: true,
  kinds: ["agents", "userAgents", "users"] as const,
  acceptedAt: "2026-07-08T12:00:00.000Z",
  deletedAt: null,
  createdAt: "2026-07-08T12:00:00.000Z",
  expiresAt: "2027-01-04T12:00:00.000Z",
};

const topAgent = {
  id: "report-agent-1",
  name: "Support agent",
  publisher: "Reported publisher",
  status: "Report only" as const,
  responses: 9,
  activeUsers: 2,
  activeUsersBasis: "users_and_agents_distinct_identity" as const,
  lastActivityDateUtc: "2026-07-06T00:00:00.000Z",
  creatorType: "Your org",
  creatorTypeSource: "agents_report" as const,
  identityStatus: "unresolved" as const,
};

const aggregate: OfficialUsageAggregateView = {
  authority: "Microsoft 365 admin center Copilot Agents usage exports",
  availability: "stale",
  staleAfterDays: 35,
  periodAgeDays: 40,
  acceptedAgeDays: 38,
  activeSet: { ...activeSet, kinds: [...activeSet.kinds] },
  lineages: [{ kind: "agents", versionId: "version-1", fileHash: "abcdef1234567890", parserVersion: "1", schemaVersion: "m365-agents-observed-v1", reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", days: 30, provenance: "operator_asserted" }, sourceAsOfProvenance: "absent", sourceFreshness: "unknown", acceptedAt: "2026-07-08T12:00:00.000Z", rowCount: 1, warnings: [], reconciliation: {}, supersedesVersionId: null }],
  missingKinds: ["users"],
  summary: {
    catalog: {
      totalAgents: 0,
      allowedAgents: 0,
      blockedAgents: 0,
      inactiveAgents: 1,
      noImportedUsageAgents: 0,
      statusDistribution: [],
      availabilityDistribution: [],
      hostDistribution: [],
      publisherDistribution: [],
      platformDistribution: [],
      typeDistribution: [],
    },
    usage: {
      hasAgentUsage: true,
      totalResponses: 9,
      totalResponsesBasis: "agents_report",
      totalResponsesCoverage: "agents_report_only",
      totalActiveUsers: 2,
      totalActiveUsersBasis: "users_and_users_agents_distinct_identity",
      responseReconciliation: { sourceValues: { agents: 9, userAgents: 9, users: 9 }, status: "matching", difference: 0 },
      activeUserReconciliation: { sourceValues: { users: 2, userAgents: 2 }, status: "matching", difference: 0 },
      creatorTypeDistribution: [{ name: "Your org", value: 1 }],
      topAgentsByResponses: [topAgent],
      topAgentsByActiveUsers: [topAgent],
      lastActivityRange: { earliest: "2026-07-06T00:00:00.000Z", latest: "2026-07-06T00:00:00.000Z" },
      activeUsersAreNonAdditive: true,
    },
    activityWindow: {
      anchorDateUtc: "2026-07-06T00:00:00.000Z",
      activeAgents: 1,
      totalAgents: 1,
      activeUsers: 2,
      totalActiveUsers: 2,
      responses: 9,
      totalResponses: 9,
      responseBasis: "agents_report",
      agentDistribution: [{ name: "Active", value: 1 }],
      activeUserDistribution: [{ name: "Active", value: 2 }],
      creatorTypeDistribution: [{ name: "Your org", value: 1 }],
      topAgentsByResponses: [topAgent],
    },
  },
  agents: { value: [], count: 1, limit: 100, offset: 0 },
};

const userView: OfficialUsageUserView = {
  authority: "Microsoft 365 admin center Copilot Agents usage exports",
  availability: "stale",
  staleAfterDays: 35,
  periodAgeDays: 40,
  acceptedAgeDays: 38,
  activeSet: { ...activeSet, kinds: [...activeSet.kinds] },
  lineages: [{ kind: "users", versionId: "version-2", fileHash: "fedcba9876543210", parserVersion: "1", schemaVersion: "m365-users-observed-v1", reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", days: 30, provenance: "operator_asserted" }, sourceAsOfProvenance: "absent", sourceFreshness: "unknown", acceptedAt: "2026-07-08T12:00:00.000Z", rowCount: 2, warnings: [], reconciliation: {}, supersedesVersionId: null }],
  filters: { creatorTypes: ["Your org"] },
  counts: { users: 2, userRows: 2, accessRows: 2, reportOnlyRows: 2, totalResponsesReceived: 9, mismatchCount: 1 },
  topUsersByResponses: [{ username: "User@example.invalid", displayName: "User", responses: 5, agentsUsed: 1, responsesSource: "users", agentsUsedSource: "users" }],
  users: {
    count: 101,
    limit: 100,
    offset: 0,
    value: ["User@example.invalid", "user@example.invalid"].map((username, index) => ({
      username,
      displayName: `User ${index + 1}`,
      reportedAgentsUsed: 1,
      reportedResponsesReceived: index ? 4 : 5,
      userLastActivityDateUtc: "2026-07-06T00:00:00.000Z",
      agentsAccessedTotal: 1,
      responseProducingAgentCount: 1,
      bridgeResponsesSentToUsers: index ? 4 : 5,
      missingUserReport: false,
      hasReportMismatch: index === 1,
      creatorTypes: ["Your org"],
      rows: [{
        agentId: `report-agent-${index + 1}`,
        agentName: "Support agent",
        creatorType: "Your org",
        username,
        responsesSentToUsers: index ? 4 : 5,
        lastActivityDateUtc: "2026-07-06T00:00:00.000Z",
        displayAgentName: "Support agent",
        packageStatus: "report-only" as const,
        hasResponses: true,
        identityStatus: "unresolved" as const,
        creatorTypeSource: "users_and_agents_report" as const,
      }],
      searchableText: `${username.toLowerCase()} support agent`,
      datasetScope: {
        reportSetId: activeSet.id,
        usersVersionId: "version-2",
        userAgentsVersionId: "version-bridge",
      },
    })),
  },
};

describe("official usage views", () => {
  it("shows stale lineage, missing companions, and unresolved report-only agents", () => {
    render(<ReportingView activityWindowDays={30} data={aggregate} inactiveDays={30} onActivityWindowDaysChange={vi.fn()} />);

    expect(screen.getByText("Microsoft 365 admin center Copilot Agents usage exports")).toBeVisible();
    expect(screen.getByText("Stale", { exact: true })).toBeVisible();
    expect(screen.getByText("Missing Users")).toBeVisible();
    expect(screen.getByText((_text, element) => element?.tagName === "STRONG" && element.textContent?.includes("abcdef1234") === true)).toBeVisible();
    expect(screen.getAllByText("Report only", { exact: true }).length).toBeGreaterThan(0);
  });

  it("keeps case-distinct pseudonyms and exposes paging without guessing identity", async () => {
    const onPageChange = vi.fn();
    render(<UserAccessView data={userView} onPageChange={onPageChange} onQueryChange={vi.fn()} />);

    expect(screen.getByText("Dataset-scoped; exact IDs unresolved")).toBeVisible();
    expect(screen.getAllByText("User@example.invalid", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("user@example.invalid", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByText("Report only / unresolved ID")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(100);
  });

  it("shows unknown Users-report metrics for a bridge-only identity", () => {
    const bridgeOnly = {
      ...userView.users.value[0],
      username: "bridge-only@example.invalid",
      displayName: "Bridge only",
      reportedAgentsUsed: 0,
      reportedResponsesReceived: 0,
      userLastActivityDateUtc: undefined,
      missingUserReport: true,
    };
    render(<UserAccessView data={{ ...userView, users: { ...userView.users, value: [bridgeOnly] } }} onPageChange={vi.fn()} onQueryChange={vi.fn()} />);

    expect(screen.getAllByText("reported Unknown", { exact: true })).toHaveLength(2);
    expect(screen.getAllByText("Unknown", { exact: true })).toHaveLength(2);
  });

  it("distinguishes an incomplete empty dataset from loading", () => {
    render(<UserAccessView data={{ ...userView, availability: "incomplete", activeSet: null, lineages: [], users: { value: [], count: 0, limit: 100, offset: 0 } }} onPageChange={vi.fn()} onQueryChange={vi.fn()} />);

    expect(screen.getByText("No published user usage rows")).toBeVisible();
    expect(screen.getByText(/Official usage is Incomplete/)).toBeVisible();
    expect(screen.queryByText(/Loading official user usage/)).not.toBeInTheDocument();
  });
});
