import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { usageAggregateFixture, usageAgentDetailFixture, usageFixtureSetId } from "../test/usageInsightsFixture";
import { TenantAdoptionInsights, ReportedAgentUsage } from "./TenantAdoptionInsights";

beforeEach(() => {
  vi.spyOn(api, "getOfficialUsageAggregate").mockImplementation(async query => usageAggregateFixture({ staleAfterDays: 35, ...query }));
  vi.spyOn(api, "getOfficialUsageAgentDetail").mockImplementation(async agentId => usageAgentDetailFixture(agentId));
});
afterEach(() => vi.restoreAllMocks());

describe("tenant adoption insights", () => {
  it("shows tenant metrics without automatically selecting a reported agent", async () => {
    render(<TenantAdoptionInsights />);
    const totals = await screen.findByLabelText("Tenant report totals");
    expect(within(totals).getByText("Agent responses").parentElement).toHaveTextContent("270");
    expect(within(totals).getByText("Active users").nextElementSibling).toHaveTextContent(/^3$/);
    expect(within(totals).getByText(/Distinct report identities with positive responses/)).toBeVisible();
    expect(within(totals).queryByText("Reported users")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Tenant adoption insights" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Explore report for Researcher/ })).toBeVisible();
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Tenant adoption insights" }).querySelectorAll("a")).toHaveLength(0);
    expect(api.getOfficialUsageAgentDetail).not.toHaveBeenCalled();
    expect(api.getOfficialUsageAggregate).toHaveBeenCalledWith({ search: undefined, limit: 6, offset: 0 }, { signal: expect.any(AbortSignal) });
  });

  it.each([
    { count: null, expected: "Unknown" },
    { count: 0, expected: "0" },
  ])("renders active-user evidence $count as $expected without coercion", async ({ count, expected }) => {
    const data = usageAggregateFixture();
    data.summary.usage.totalActiveUsers = count;
    vi.mocked(api.getOfficialUsageAggregate).mockResolvedValue(data);
    render(<TenantAdoptionInsights />);
    const totals = await screen.findByLabelText("Tenant report totals");
    expect(within(totals).getByText("Active users").nextElementSibling?.textContent).toBe(expected);
  });

  it("drills into an explicit report with real users, zero rows and separate mismatching totals", async () => {
    render(<TenantAdoptionInsights />);
    await userEvent.click(await screen.findByRole("button", { name: /^Explore report for Researcher/ }));
    const metrics = await screen.findByLabelText("Selected agent report metrics");
    expect(within(metrics).getByText("Responses").parentElement).toHaveTextContent("215");
    expect(within(metrics).getByText("Users with responses").parentElement).toHaveTextContent("2");
    expect(within(metrics).getByText("Reported users").parentElement).toHaveTextContent("3");
    expect(screen.queryByLabelText("Tenant report totals")).not.toBeInTheDocument();
    expect(screen.getByText(/Response totals differ: 215.*212/)).toBeVisible();
    const table = screen.getByRole("region", { name: "Users of the reported agent" });
    expect(within(table).getByRole("row", { name: /Ben/ })).toHaveTextContent("0");
    expect(within(table).getByRole("row", { name: /Ben/ })).toHaveTextContent("Zero responses reported");
    expect(within(table).getByText("Concealed report user")).toBeVisible();
    expect(within(table).queryByText(/Sep 12/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open reported user activity" })).toHaveAttribute("href", `/users?view=activity&agent=synthetic-researcher&snapshot=${usageFixtureSetId}`);
    expect(api.getOfficialUsageAgentDetail).toHaveBeenCalledWith("synthetic-researcher", {
      setId: usageFixtureSetId, search: undefined, limit: 20, offset: 0,
    }, { signal: expect.any(AbortSignal) });
    expect(screen.queryByRole("button", { name: /Block|Manage access/ })).not.toBeInTheDocument();
  });

  it("keeps tenant report search usable while requests change and can recover from no matches", async () => {
    render(<TenantAdoptionInsights />);
    const search = screen.getByRole("searchbox", { name: "Find a reported agent" });
    await userEvent.type(search, "Unreported agent");
    expect(await screen.findByText("No reported agents match this search")).toBeVisible();
    expect(screen.getByText(/This does not establish zero usage/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Browse all reported agents" }));
    await userEvent.type(search, "Helpdesk");
    expect(search).toHaveFocus();
    expect(search).toHaveValue("Helpdesk");
    await userEvent.click(await screen.findByRole("button", { name: /^Explore report for Helpdesk/ }));
    expect(await screen.findByRole("link", { name: "Open reported user activity" })).toHaveAttribute("href", `/users?view=activity&agent=helpdesk%2Freport%3A2&snapshot=${usageFixtureSetId}`);
  });

  it.each(["never_imported", "incomplete", "not_selected", "deleted"] as const)("gives recovery instead of zero metrics when reports are %s", async availability => {
    vi.mocked(api.getOfficialUsageAggregate).mockResolvedValue({ ...usageAggregateFixture(), availability, activeSet: null });
    render(<TenantAdoptionInsights compact />);
    expect(await screen.findByText(/Use Official usage in the primary navigation/)).toBeVisible();
    expect(screen.getByRole("region", { name: "Tenant adoption insights" }).querySelectorAll("a")).toHaveLength(0);
    expect(screen.queryByLabelText("Tenant report totals")).not.toBeInTheDocument();
    expect(screen.getByText(/Missing reports are not zero activity/)).toBeVisible();
    expect(api.getOfficialUsageAgentDetail).not.toHaveBeenCalled();
  });

  it("labels stale and inferred coverage without claiming a current reporting window", async () => {
    const data = usageAggregateFixture();
    data.availability = "stale";
    data.activeSet!.reportingPeriod = { ...data.activeSet!.reportingPeriod, provenance: "activity_range" };
    vi.mocked(api.getOfficialUsageAggregate).mockResolvedValue(data);
    render(<TenantAdoptionInsights />);
    expect(await screen.findByText("Out-of-date report")).toBeVisible();
    expect(screen.getByText(/Observed activity range:/)).toBeVisible();
    expect(screen.getByText(/not a proven reporting window/)).toBeVisible();
    expect(screen.getByText(/Refresh the reports before making adoption decisions/)).toBeVisible();
  });

  it("does not present recent import time as known source freshness", async () => {
    render(<TenantAdoptionInsights />);
    await screen.findByLabelText("Tenant report totals");
    expect(screen.getByText("Selected report")).toBeVisible();
    expect(screen.getByText(/Source refresh time is not supplied/)).toHaveTextContent("Import time does not establish source freshness.");
  });

  it("recovers from an empty report page after the matching result count shrinks", async () => {
    vi.mocked(api.getOfficialUsageAggregate).mockImplementation(async query => {
      const data = usageAggregateFixture();
      data.agents = { ...data.agents, count: query?.offset ? 2 : 12, offset: query?.offset ?? 0, value: query?.offset ? [] : data.agents.value };
      return data;
    });
    render(<TenantAdoptionInsights />);
    await userEvent.click(await screen.findByRole("button", { name: "Next agents" }));
    expect(await screen.findByRole("heading", { name: "No reported agents on this page" })).toBeVisible();
    expect(screen.getByLabelText("Reported agent pages")).toHaveTextContent("No reports on this page (2 matching)");
    expect(screen.getByLabelText("Reported agent pages")).not.toHaveTextContent("7-2");
    await userEvent.click(screen.getByRole("button", { name: "First agent page" }));
    expect(await screen.findByRole("button", { name: /^Explore report for Researcher/ })).toBeVisible();
    expect(api.getOfficialUsageAggregate).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }), expect.anything());
  });

  it("allows saved-read retries without replacing an error with empty success", async () => {
    vi.mocked(api.getOfficialUsageAggregate).mockRejectedValueOnce(new Error("Usage permission denied"));
    render(<TenantAdoptionInsights />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Usage permission denied");
    expect(screen.queryByLabelText("Tenant report totals")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry usage reports" }));
    expect(await screen.findByLabelText("Tenant report totals")).toBeVisible();
  });

  it("discards selected metrics when the report revision changes", async () => {
    const { rerender } = render(<TenantAdoptionInsights dataRevision={1} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Explore report for Researcher/ }));
    await screen.findByLabelText("Selected agent report metrics");
    rerender(<TenantAdoptionInsights dataRevision={2} />);
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Tenant report totals")).toBeVisible();
  });

  it("ignores a late report response after choosing a different exact agent", async () => {
    let resolve!: (value: api.OfficialUsageAgentDetailView) => void;
    vi.mocked(api.getOfficialUsageAgentDetail).mockReturnValueOnce(new Promise(result => { resolve = result; }));
    render(<TenantAdoptionInsights />);
    await userEvent.click(await screen.findByRole("button", { name: /^Explore report for Researcher/ }));
    const firstSignal = vi.mocked(api.getOfficialUsageAgentDetail).mock.calls[0][2]?.signal;
    await userEvent.click(screen.getByRole("button", { name: "Clear report selection" }));
    await userEvent.click(screen.getByRole("button", { name: /^Explore report for Helpdesk/ }));
    expect(await screen.findByRole("region", { name: "Usage report for Helpdesk" })).toBeVisible();
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => resolve(usageAgentDetailFixture()));
    expect(screen.queryByRole("region", { name: "Usage report for Researcher" })).not.toBeInTheDocument();
  });
});

describe("reported agent user drilldown", () => {
  it("pages and searches users with the retained report pinned and never reuses prior page rows", async () => {
    vi.mocked(api.getOfficialUsageAgentDetail).mockImplementation(async (agentId, query) => ({
      ...usageAgentDetailFixture(agentId),
      users: { ...usageAgentDetailFixture(agentId).users, count: 45, offset: query?.offset ?? 0 },
    }));
    render(<ReportedAgentUsage agentId="synthetic-researcher" reportSetId={usageFixtureSetId} />);
    await screen.findByLabelText("Selected agent report metrics");
    await userEvent.click(screen.getByRole("button", { name: "Next users" }));
    await waitFor(() => expect(api.getOfficialUsageAgentDetail).toHaveBeenLastCalledWith("synthetic-researcher",
      expect.objectContaining({ offset: 20, setId: usageFixtureSetId }), expect.anything()));
    const search = screen.getByRole("searchbox", { name: "Search reported users" });
    await userEvent.type(search, "Ada");
    expect(search).toHaveFocus();
    await waitFor(() => expect(api.getOfficialUsageAgentDetail).toHaveBeenLastCalledWith("synthetic-researcher",
      expect.objectContaining({ search: "Ada", offset: 0, setId: usageFixtureSetId }), expect.anything()));
  });

  it("shows missing user metrics as unknown and does not add license categories", async () => {
    const data = usageAgentDetailFixture();
    data.summary = { reportedUsers: null, responseProducingUsers: null, zeroResponseUsers: null, userBreakdownResponses: null };
    data.users = { value: [], count: 0, limit: 20, offset: 0 };
    data.agent.activeUsersIdentityCount = null;
    data.agent.activeUsersTotal = null;
    data.agent.responseComparison = { status: "not_comparable", difference: null, sourceValues: { agents: 215, userAgents: null } };
    vi.mocked(api.getOfficialUsageAgentDetail).mockResolvedValue(data);
    render(<ReportedAgentUsage agentId="synthetic-researcher" reportSetId={usageFixtureSetId} />);
    const metrics = await screen.findByLabelText("Selected agent report metrics");
    expect(within(metrics).getByText("Users with responses").parentElement).toHaveTextContent("Unknown");
    expect(screen.getByText("The user-agent breakdown is not available for this report.")).toBeVisible();
    await userEvent.click(screen.getByText("Report coverage and license categories"));
    expect(screen.getByText(/A user can appear in both categories/)).toHaveTextContent("Licensed active-user occurrences: 2. Unlicensed active-user occurrences: 1.");
  });

  it.each([
    { activeUsers: null, reportedUsers: 0, expected: "Unknown" },
    { activeUsers: 0, reportedUsers: 1, expected: "0" },
  ])("keeps active-user evidence $activeUsers separate from $reportedUsers reported rows", async ({ activeUsers, reportedUsers, expected }) => {
    const data = usageAgentDetailFixture();
    data.agent.activeUsersIdentityCount = activeUsers;
    data.agent.activeUsersTotal = activeUsers;
    const users = reportedUsers ? [{ ...data.users.value[0], responsesSentToUsers: 0 }] : [];
    data.users = { ...data.users, value: users, count: users.length };
    data.summary = {
      reportedUsers, responseProducingUsers: 0, zeroResponseUsers: reportedUsers,
      userBreakdownResponses: reportedUsers ? 0 : null,
    };
    data.agent.responseComparison = {
      status: reportedUsers ? "mismatch" : "not_comparable",
      difference: reportedUsers ? 215 : null, sourceValues: { agents: 215, userAgents: reportedUsers ? 0 : null },
    };
    vi.mocked(api.getOfficialUsageAgentDetail).mockResolvedValue(data);
    render(<ReportedAgentUsage agentId="synthetic-researcher" reportSetId={usageFixtureSetId} />);
    const metrics = await screen.findByLabelText("Selected agent report metrics");
    expect(within(metrics).getByText("Users with responses").nextElementSibling?.textContent).toBe(expected);
    expect(within(metrics).getByText("Reported users").nextElementSibling?.textContent).toBe(String(reportedUsers));
  });

  it("keeps an empty user page distinct from a report with no relationships", async () => {
    vi.mocked(api.getOfficialUsageAgentDetail).mockImplementation(async (agentId, query) => {
      const data = usageAgentDetailFixture(agentId);
      data.users = { ...data.users, count: query?.offset ? 3 : 45, offset: query?.offset ?? 0, value: query?.offset ? [] : data.users.value };
      return data;
    });
    render(<ReportedAgentUsage agentId="synthetic-researcher" reportSetId={usageFixtureSetId} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next users" }));
    expect(await screen.findByText("No reported users on this page.")).toBeVisible();
    expect(screen.getByLabelText("Reported user pages")).toHaveTextContent("No reported users on this page (3 matching)");
    expect(screen.queryByText(/No user-agent relationships were reported/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "First reported user page" }));
    expect(await screen.findByRole("region", { name: "Users of the reported agent" })).toBeVisible();
    expect(api.getOfficialUsageAgentDetail).toHaveBeenLastCalledWith("synthetic-researcher",
      expect.objectContaining({ setId: usageFixtureSetId, offset: 0 }), expect.anything());
  });
});
