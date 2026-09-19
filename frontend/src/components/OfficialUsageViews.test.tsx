import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OfficialUsageAggregateView, OfficialUsageUserView } from "../api/client";
import * as usageApi from "../api/client";
import { downloadBlob } from "../agentExport";
import { ReportingView } from "./ReportingView";
import { UserAccessView } from "./UserAccessView";

vi.mock("../agentExport", () => ({ downloadBlob: vi.fn() }));

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
  reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", provenance: "operator_asserted" as const },
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
      reportedLicensedActiveUserOccurrences: 2,
      reportedUnlicensedActiveUserOccurrences: 1,
      activeUserOccurrenceNotice: "Independent non-additive categories.",
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
  filters: { sortBy: "responses", sortDirection: "desc", creatorTypes: ["Your org"] },
  rankings: { mostResponses: [topAgent], leastResponses: [topAgent], zeroResponseAgents: 0 },
  agents: {
    value: [{
      agentId: "report-agent-1",
      agentName: "Support agent",
      creatorType: "Your org",
      activeUsersLicensed: 2,
      activeUsersUnlicensed: 1,
      activeUsersTotal: 2,
      responsesSentToUsers: 9,
      lastActivityDateUtc: "2026-07-06T00:00:00.000Z",
      sourceReport: "agents",
      sourceReports: ["agents", "userAgents"],
      activeUsersIdentityCount: 2,
      activeUsersTotalBasis: "userAgents_distinct_identity",
      responseComparison: { sourceValues: { agents: 9, userAgents: 9 }, status: "matching", difference: 0 },
      creatorTypeSource: "agents_report",
      identityStatus: "unresolved",
    }],
    count: 1,
    limit: 100,
    offset: 0,
  },
};

const userView: OfficialUsageUserView = {
  authority: "Microsoft 365 admin center Copilot Agents usage exports",
  availability: "stale",
  staleAfterDays: 35,
  periodAgeDays: 40,
  acceptedAgeDays: 38,
  activeSet: { ...activeSet, kinds: [...activeSet.kinds] },
  lineages: [{ kind: "users", versionId: "version-2", fileHash: "fedcba9876543210", parserVersion: "1", schemaVersion: "m365-users-observed-v1", reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", days: 30, provenance: "operator_asserted" }, sourceAsOfProvenance: "absent", sourceFreshness: "unknown", acceptedAt: "2026-07-08T12:00:00.000Z", rowCount: 2, warnings: [], reconciliation: {}, supersedesVersionId: null }],
  filters: { creatorTypes: ["Your org"], activity: "all", responsesOnly: false, lowResponseThreshold: 5, cohort: "all", sortBy: "responses", sortDirection: "desc" },
  counts: { users: 2, filteredUsers: 2, userRows: 2, accessRows: 2, reportOnlyRows: 2, totalResponsesReceived: 9, mismatchCount: 1 },
  cohorts: { zeroResponses: 0, lowResponses: 2, reviewCandidates: 2, unknownUserMetrics: 0, missingBridgeRows: 0, threshold: 5 },
  recencyAnchorDateUtc: "2026-07-06T00:00:00.000Z",
  decisionNotice: "Confirm actual assignment and full Copilot usage before reassignment; no changes are made.",
  topUsersByResponses: [{ username: "User@example.invalid", displayName: "User", responses: 5, agentsUsed: 1, responsesSource: "users", agentsUsedSource: "users" }],
  leastUsersByResponses: [{ username: "user@example.invalid", displayName: "User 2", responses: 4, agentsUsed: 1, responsesSource: "users", agentsUsedSource: "users" }],
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
      reviewCohort: "low_responses" as const,
      reviewCandidate: true,
      licenseAssignmentStatus: "unavailable" as const,
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

describe("usage source clarity and export recovery", () => {
  it("keeps the Users report response total primary and displays discrepant agent totals separately", () => {
    const user = { ...userView.users.value[0], reportedResponsesReceived: 17, hasReportMismatch: true };
    render(<UserAccessView data={{ ...userView, users: { ...userView.users, value: [user] } }} onPageChange={vi.fn()} onQueryChange={vi.fn()} />);
    const row = within(screen.getByRole("region", { name: "Users" })).getAllByRole("row")[1];
    const responseCell = within(row).getAllByRole("cell")[3];
    expect(responseCell.querySelector("strong")).toHaveTextContent("17");
    expect(within(responseCell).getByText("Users & agents: 5")).toBeVisible();
    const detail = screen.getByRole("region", { name: "User 1 agents" });
    expect(within(detail).getByText("Responses (Users report)").parentElement).toHaveTextContent("17");
    expect(within(detail).getByText("Responses (displayed agent rows)").parentElement).toHaveTextContent("5");
  });

  it("explains missing agent details without asking users to import an already active bundle", () => {
    const user = { ...userView.users.value[0], rows: [], agentsAccessedTotal: 0, responseProducingAgentCount: 0, bridgeResponsesSentToUsers: 0, hasReportMismatch: true };
    render(<UserAccessView data={{ ...userView, users: { ...userView.users, value: [user] } }} onPageChange={vi.fn()} onQueryChange={vi.fn()} />);
    expect(screen.getByText(/imported Users & agents report contains no agent rows for this user/)).toBeVisible();
    expect(screen.queryByText(/Import and activate/)).not.toBeInTheDocument();
    const detail = screen.getByRole("region", { name: "User 1 agents" });
    expect(within(detail).getByText("Responses (Users report)").parentElement).toHaveTextContent("5");
  });

  it("surfaces export failures and makes the export action retryable", async () => {
    const download = vi.spyOn(usageApi, "downloadOfficialUsageCsv").mockRejectedValueOnce(new Error("Export exceeds the configured size limit."));
    try {
      const user = userEvent.setup();
      render(<ReportingView data={aggregate} userData={userView} activityWindowDays={30} inactiveDays={30} onActivityWindowDaysChange={vi.fn()} />);
      const button = screen.getByRole("button", { name: "Export filtered agents CSV" });
      await user.click(button);
      expect(await screen.findByRole("alert")).toHaveTextContent("Export exceeds the configured size limit.");
      expect(button).toBeEnabled();
    } finally {
      download.mockRestore();
    }
  });

  it("keeps exports pinned to the historical snapshot being viewed", async () => {
    const reportSetId = "11111111-1111-4111-8111-111111111111";
    const download = vi.spyOn(usageApi, "downloadOfficialUsageCsv").mockResolvedValue(new Blob(["csv"]));
    try {
      render(<ReportingView
        data={aggregate}
        userData={userView}
        activityWindowDays={30}
        inactiveDays={30}
        onActivityWindowDaysChange={vi.fn()}
      />);
      await userEvent.click(screen.getByRole("button", { name: "Export filtered agents CSV" }));
      expect(download).toHaveBeenCalledWith(
        "aggregate",
        expect.objectContaining({ setId: reportSetId }),
        expect.objectContaining({ aborted: false }),
      );
    } finally {
      download.mockRestore();
    }
  });

  it.each(["aggregate", "users"] as const)("pins the current %s CSV to that section's displayed report set", async kind => {
    const userSetId = "44444444-4444-4444-8444-444444444444";
    const userSnapshot: OfficialUsageUserView = {
      ...userView,
      activeSet: { ...activeSet, kinds: [...activeSet.kinds], id: userSetId },
      users: {
        ...userView.users,
        value: userView.users.value.map(row => ({
          ...row, datasetScope: { ...row.datasetScope, reportSetId: userSetId },
        })),
      },
    };
    const blob = new Blob(["csv"]);
    const download = vi.spyOn(usageApi, "downloadOfficialUsageCsv").mockResolvedValue(blob);
    try {
      render(<ReportingView
        data={aggregate}
        userData={userSnapshot}
        activityWindowDays={30}
        inactiveDays={30}
        onActivityWindowDaysChange={vi.fn()}
      />);
      await userEvent.click(screen.getByRole("button", {
        name: kind === "aggregate" ? "Export filtered agents CSV" : "Export filtered user details CSV",
      }));
      expect(download).toHaveBeenCalledWith(
        kind,
        expect.objectContaining({ setId: kind === "aggregate" ? activeSet.id : userSetId }),
        expect.objectContaining({ aborted: false }),
      );
      expect(downloadBlob).toHaveBeenLastCalledWith(
        kind === "aggregate" ? "official-agent-usage.csv" : "official-user-usage.csv", blob,
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      download.mockRestore();
    }
  });

  it.each(["aggregate", "users"] as const)("does not export %s without that section's report-set identity", async kind => {
    const download = vi.spyOn(usageApi, "downloadOfficialUsageCsv");
    try {
      render(<ReportingView
        data={kind === "aggregate" ? { ...aggregate, activeSet: null } : aggregate}
        userData={kind === "users" ? { ...userView, activeSet: null } : userView}
        activityWindowDays={30}
        inactiveDays={30}
        onActivityWindowDaysChange={vi.fn()}
      />);
      const button = screen.getByRole("button", {
        name: kind === "aggregate" ? "Export filtered agents CSV" : "Export filtered user details CSV",
      });
      await userEvent.click(button);
      expect(await screen.findByRole("alert")).toHaveTextContent("Load an accepted report set");
      expect(download).not.toHaveBeenCalled();
      expect(button).toBeEnabled();
    } finally {
      download.mockRestore();
    }
  });
});

describe("official usage views", () => {
  it("prioritizes usage while keeping stale state visible and technical lineage expandable", async () => {
    const withCatalog = { ...aggregate, summary: { ...aggregate.summary, catalog: { ...aggregate.summary.catalog, totalAgents: 1, allowedAgents: 1 } } };
    render(<ReportingView activityWindowDays={30} data={withCatalog} inactiveDays={30} onActivityWindowDaysChange={vi.fn()} />);

    expect(screen.getByText("Microsoft 365 admin center Copilot Agents usage exports")).not.toBeVisible();
    expect(screen.getAllByText("Stale", { exact: true })[0]).toBeVisible();
    expect(screen.getAllByText("Missing Users")[0]).toBeVisible();
    expect(screen.getByText("Response reconciliation")).not.toBeVisible();
    expect(screen.getByText(/Agent activity only, not a license ledger/)).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Usage summary" })).getByText("Agents in report")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Usage summary" })).getByText("Active users (positive responses)")).toBeVisible();
    expect(screen.queryByText("Imported agent rows")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("Report details", { exact: true }));
    expect(screen.getByText("Microsoft 365 admin center Copilot Agents usage exports")).toBeVisible();
    expect(screen.getByText("Response reconciliation")).toBeVisible();
    expect(screen.getByText((_text, element) => element?.tagName === "STRONG" && element.textContent?.includes("abcdef1234") === true)).toBeVisible();
    expect(screen.getAllByText("Report only", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByText("Decision support, not a license ledger.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "All agent usage" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Licensed active users" })).toBeVisible();
    const usageHeading = screen.getByRole("heading", { name: "Usage overview" });
    const catalogSummary = screen.getByText("Catalog-only analysis");
    expect(usageHeading.compareDocumentPosition(catalogSummary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(catalogSummary.closest("details")).not.toHaveAttribute("open");
  });

  it("flags source discrepancies without expanding the technical details", () => {
    const data = {
      ...aggregate,
      summary: {
        ...aggregate.summary,
        usage: { ...aggregate.summary.usage, responseReconciliation: { sourceValues: { agents: 9, userAgents: 9, users: 13 }, status: "mismatch" as const, difference: 4 } },
      },
    };
    render(<ReportingView activityWindowDays={30} data={data} inactiveDays={30} onActivityWindowDaysChange={vi.fn()} />);
    const notice = screen.getByText("Source totals differ");
    expect(notice).toBeVisible();
    expect(notice.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Response reconciliation")).not.toBeVisible();
    expect(screen.getByRole("heading", { name: "Usage overview" })).toBeVisible();
  });

  it("embeds complete user drilldown and review controls on the official usage page", () => {
    render(<ReportingView activityWindowDays={30} data={aggregate} inactiveDays={30} onActivityWindowDaysChange={vi.fn()} userData={userView} />);

    expect(screen.getByRole("heading", { name: "Every user and agent detail" })).toBeVisible();
    expect(screen.getByLabelText("Low-response threshold")).toHaveValue(5);
    expect(screen.getAllByText(/Unavailable/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Confirm actual assignment and full Copilot usage/)).toBeVisible();
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
      reviewCohort: "unknown" as const,
      reviewCandidate: false,
    };
    render(<UserAccessView data={{ ...userView, users: { ...userView.users, value: [bridgeOnly] } }} onPageChange={vi.fn()} onQueryChange={vi.fn()} />);

    expect(screen.getByText("reported Unknown", { exact: true })).toBeVisible();
    expect(screen.getByText("Users report unavailable; Users & agents total shown")).toBeVisible();
    const detail = screen.getByRole("region", { name: "Bridge only agents" });
    expect(within(detail).getByText("Responses (Users report)").parentElement).toHaveTextContent("Unknown");
    expect(within(detail).getByText("Agents used (Users report)").parentElement).toHaveTextContent("Unknown");
    expect(within(detail).getByText("User last activity").parentElement).toHaveTextContent("Unknown");
  });

  it("distinguishes an incomplete empty dataset from loading", () => {
    render(<UserAccessView data={{ ...userView, availability: "incomplete", activeSet: null, lineages: [], counts: { ...userView.counts, users: 0, filteredUsers: 0, userRows: 0 }, users: { value: [], count: 0, limit: 100, offset: 0 } }} onPageChange={vi.fn()} onQueryChange={vi.fn()} />);

    expect(screen.getByText("No published user usage rows")).toBeVisible();
    expect(screen.getByText(/Official usage is Incomplete/)).toBeVisible();
    expect(screen.queryByText(/Loading official user usage/)).not.toBeInTheDocument();
  });

  it("keeps filters usable when the filtered result is empty and resets them", async () => {
    const onQueryChange = vi.fn();
    render(<UserAccessView data={{ ...userView, counts: { ...userView.counts, filteredUsers: 0 }, users: { value: [], count: 0, limit: 100, offset: 0 } }} onPageChange={vi.fn()} onQueryChange={onQueryChange} />);

    expect(screen.getByRole("heading", { name: "No users match" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search" })).toBeVisible();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "none");
    await userEvent.click(screen.getByRole("button", { name: "Reset user filters" }));
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("");
  });

  it("keeps the embedded user dashboard and cohorts visible when server filters match no users", () => {
    const filteredEmpty = {
      ...userView,
      counts: { ...userView.counts, filteredUsers: 0 },
      topUsersByResponses: [],
      leastUsersByResponses: [],
      users: { value: [], count: 0, limit: 100, offset: 0 },
    };
    render(<ReportingView activityWindowDays={30} data={aggregate} inactiveDays={30} onActivityWindowDaysChange={vi.fn()} userData={filteredEmpty} />);

    expect(screen.getAllByText("Imported", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "No users match" })).toBeVisible();
    expect(within(screen.getByLabelText("User agent access")).getByRole("searchbox")).toBeVisible();
    expect(screen.getAllByText("Zero-response review candidates").length).toBeGreaterThan(0);
  });
});
