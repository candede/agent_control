import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { usageOverviewFixture } from "../test/usageInsightsFixture";
import { CumulativeAgentActivity } from "./CumulativeAgentActivity";
import { AgentInventoryOverview } from "./AgentInventoryOverview";

beforeEach(() => {
  vi.spyOn(api, "getOfficialUsageOverview").mockImplementation(async query => usageOverviewFixture(query));
});
afterEach(() => vi.restoreAllMocks());

describe("cumulative retained agent activity", () => {
  it("distinguishes no imported evidence from a known empty set of agents", async () => {
    const data = usageOverviewFixture();
    data.summary = { ...data.summary, retainedSets: 0, reportedAgents: 0, usedAgents: 0, activeAgents30Days: 0 };
    data.agents = { ...data.agents, value: [], count: 0 };
    vi.mocked(api.getOfficialUsageOverview).mockResolvedValue(data);
    const { rerender } = render(<CumulativeAgentActivity revision={0} onSnapshot={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "No retained reports" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Retained activity summary" })).not.toBeInTheDocument();
    vi.mocked(api.getOfficialUsageOverview).mockResolvedValue({ ...data, summary: { ...data.summary, retainedSets: 1 } });
    rerender(<CumulativeAgentActivity revision={1} onSnapshot={vi.fn()} />);
    expect(await screen.findByRole("region", { name: "Retained activity summary" })).toHaveTextContent("Reported agents0");
    expect(screen.getByText(/Missing evidence is not zero activity/)).toBeVisible();
  });

  it("shows retained agent evidence, not summed responses, and opens the exact source snapshot", async () => {
    const data = usageOverviewFixture();
    const older = {
      ...data.agents.value[0], agentId: "june-only", agentName: "June-only agent",
      latestSetId: "33333333-3333-4333-8333-333333333333", lastActivityDateUtc: "2026-06-01",
    };
    data.agents.value.push(older);
    data.agents.count += 1;
    data.summary.retainedSets = 2;
    vi.mocked(api.getOfficialUsageOverview).mockResolvedValue(data);
    const onSnapshot = vi.fn();
    render(<CumulativeAgentActivity revision={0} onSnapshot={onSnapshot} />);
    expect(await screen.findByRole("row", { name: /June-only agent/ })).toBeVisible();
    expect(screen.getByText(/Overlapping response totals are not added/)).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "Responses" })).not.toBeInTheDocument();
    expect(screen.getByText(/Last-activity dates are not complete daily coverage/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "View source snapshot for June-only agent" }));
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(older.latestSetId);
    expect(api.getOfficialUsageOverview).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25, offset: 0, sortBy: "lastActivity", sortDirection: "desc" }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("pages on the server, resets search to page one, and keeps summary counts history-wide", async () => {
    vi.mocked(api.getOfficialUsageOverview).mockImplementation(async query => {
      const data = usageOverviewFixture(query);
      data.agents.count = 53;
      return data;
    });
    render(<CumulativeAgentActivity revision={0} onSnapshot={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next retained agents" }));
    await waitFor(() => expect(api.getOfficialUsageOverview).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25 }), expect.anything()));
    expect(await screen.findByRole("heading", { name: "No retained agents on this page" })).toBeVisible();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search retained agents" }), "Helpdesk");
    await waitFor(() => expect(api.getOfficialUsageOverview).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, search: "Helpdesk" }), expect.anything()));
    expect(await screen.findByRole("row", { name: /Helpdesk/ })).toBeVisible();
    expect(screen.getByRole("region", { name: "Retained activity summary" })).toHaveTextContent("Reported agents2");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Order retained agents" }), "name");
    await waitFor(() => expect(api.getOfficialUsageOverview).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, sortBy: "agentName", sortDirection: "asc" }), expect.anything()));
  });

  it("stops reversed-date reads without stale rows or a false busy state", async () => {
    render(<CumulativeAgentActivity revision={0} onSnapshot={vi.fn()} />);
    await screen.findByRole("region", { name: "Retained agent activity rows" });
    fireEvent.change(screen.getByLabelText("Observed activity on or after (UTC)"), { target: { value: "2026-09-12" } });
    await screen.findByRole("region", { name: "Retained agent activity rows" });
    const before = vi.mocked(api.getOfficialUsageOverview).mock.calls.length;
    fireEvent.change(screen.getByLabelText("Observed activity on or before (UTC)"), { target: { value: "2026-09-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("start date must be on or before");
    expect(screen.getByRole("region", { name: "Cumulative agent activity" })).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByRole("region", { name: "Retained agent activity rows" })).not.toBeInTheDocument();
    expect(api.getOfficialUsageOverview).toHaveBeenCalledTimes(before);
    await userEvent.click(screen.getByRole("button", { name: "Clear activity filters" }));
    expect(await screen.findByRole("region", { name: "Retained agent activity rows" })).toBeVisible();
  });

  it("does not revive A-to-B-to-A reads when transports ignore abort", async () => {
    let resolve!: (value: api.OfficialUsageOverviewView) => void;
    vi.mocked(api.getOfficialUsageOverview)
      .mockResolvedValueOnce(usageOverviewFixture())
      .mockReturnValueOnce(new Promise(done => { resolve = done; }))
      .mockResolvedValueOnce(usageOverviewFixture());
    render(<CumulativeAgentActivity revision={0} onSnapshot={vi.fn()} />);
    await screen.findByRole("region", { name: "Retained agent activity rows" });
    const search = screen.getByRole("searchbox", { name: "Search retained agents" });
    fireEvent.change(search, { target: { value: "B" } });
    expect(screen.queryByRole("region", { name: "Retained agent activity rows" })).not.toBeInTheDocument();
    const signal = vi.mocked(api.getOfficialUsageOverview).mock.calls[1][1]?.signal;
    fireEvent.change(search, { target: { value: "" } });
    expect(await screen.findByRole("row", { name: /Researcher/ })).toBeVisible();
    expect(signal?.aborted).toBe(true);
    const obsolete = usageOverviewFixture();
    obsolete.agents.value[0].agentName = "Obsolete response";
    await act(async () => resolve(obsolete));
    expect(screen.queryByText("Obsolete response")).not.toBeInTheDocument();
  });

  it("clears retained rows on denied refresh, then recovers through retry", async () => {
    const { rerender } = render(<CumulativeAgentActivity revision={0} onSnapshot={vi.fn()} />);
    await screen.findByRole("region", { name: "Retained agent activity rows" });
    vi.mocked(api.getOfficialUsageOverview).mockRejectedValueOnce(new api.ApiError(403, "forbidden", "Activity access denied."));
    rerender(<CumulativeAgentActivity revision={1} onSnapshot={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Activity access denied.");
    expect(screen.queryByRole("region", { name: "Retained activity summary" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry retained activity" }));
    expect(await screen.findByRole("region", { name: "Retained agent activity rows" })).toBeVisible();
  });
});

describe("inventory dashboard source boundaries", () => {
  it("keeps absent inventory unknown while independently loading retained report evidence", async () => {
    vi.mocked(api.getOfficialUsageOverview).mockRejectedValueOnce(new Error("History unavailable."));
    render(<AgentInventoryOverview revision={0} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable.");
    const overview = screen.getByRole("region", { name: "Agent inventory overview" });
    expect(within(overview).getAllByText("Unknown")).toHaveLength(4);
    expect(within(overview).queryByRole("link")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry activity evidence" }));
    await waitFor(() => expect(within(overview).getByText("Reported used agents").parentElement).toHaveTextContent("2"));
    expect(within(overview).getByText("Agents in repository").parentElement).toHaveTextContent("Unknown");
    expect(overview).not.toHaveTextContent("not additive");
    expect(overview).not.toHaveTextContent("Old imports");
  });
});
