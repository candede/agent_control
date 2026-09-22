import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { usageUsersFixture } from "../test/usageInsightsFixture";
import { ReportedUserAgents } from "./ReportedUserAgents";

function rows() {
  return within(screen.getByRole("region", { name: "User agent breakdown" })).getAllByRole("row").slice(1);
}

function agentIds() {
  return rows().map(row => within(row).getAllByRole("cell")[0].querySelector("small")?.textContent);
}

describe("reported user's local agent table", () => {
  it.each([false, true])("filters and sorts all 1,005 relationships locally, with unpaid-cohort navigation enabled: %s", async navigable => {
    const user = usageUsersFixture().users.value[0];
    user.rows = Array.from({ length: 1_005 }, (_, index) => ({
      ...user.rows[0], agentId: `agent-${index}`, displayAgentName: `Agent ${index}`, responsesSentToUsers: index,
    }));
    const onFocusAgent = vi.fn();
    render(<ReportedUserAgents user={user} onFocusAgent={navigable ? onFocusAgent : undefined} />);
    expect(rows()).toHaveLength(50);
    expect(agentIds()[0]).toBe("agent-1004");
    await userEvent.click(screen.getByRole("button", { name: "Next agents" }));
    expect(screen.getByLabelText("User agent pages")).toHaveTextContent("51-100 of 1,005");
    const responses = screen.getByRole("button", { name: "Sort by Responses to this user" });
    responses.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByLabelText("User agent pages")).toHaveTextContent("1-50 of 1,005");
    expect(agentIds()[0]).toBe("agent-0");
    expect(within(rows()[0]).getAllByRole("cell")[2]).toHaveTextContent(/^0$/);
    expect(responses).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Sort by Agent" }));
    expect(agentIds().slice(0, 3)).toEqual(["agent-0", "agent-1", "agent-2"]);
    await userEvent.click(screen.getByRole("button", { name: "Sort by Agent" }));
    expect(agentIds()[0]).toBe("agent-1004");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search this user's agents" }), "agent-1004");
    expect(rows()).toHaveLength(1);
    if (navigable) {
      const agent = screen.getByRole("button", { name: "Agent 1004: active users without paid Copilot" });
      expect(agent).toHaveAttribute("title", "Show active users without paid Copilot for report agent agent-1004");
      await userEvent.click(agent);
      expect(onFocusAgent).toHaveBeenCalledExactlyOnceWith("agent-1004", user.datasetScope.reportSetId);
    } else {
      const agent = within(rows()[0]).getByText("Agent 1004");
      expect(agent.closest("button, a")).toBeNull();
      expect(within(rows()[0]).queryByRole("button")).not.toBeInTheDocument();
      await userEvent.click(agent);
      expect(onFocusAgent).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["Creator", ["agent-2", "agent-10", "agent-missing"], ["agent-10", "agent-2", "agent-missing"]],
    ["Agent-wide last activity", ["agent-2", "agent-10", "agent-missing"], ["agent-10", "agent-2", "agent-missing"]],
  ] as const)("keeps missing %s values last in both directions", async (column, ascending, descending) => {
    const user = usageUsersFixture().users.value[0];
    const source = user.rows[0];
    user.rows = [
      { ...source, agentId: "agent-missing", displayAgentName: "Missing", creatorType: "", lastActivityDateUtc: undefined },
      { ...source, agentId: "agent-10", displayAgentName: "Agent10", creatorType: "Team10", lastActivityDateUtc: "2026-10-01T00:00:00.000Z" },
      { ...source, agentId: "agent-2", displayAgentName: "Agent2", creatorType: "Team2", lastActivityDateUtc: "2025-12-31T00:00:00.000Z" },
    ];
    render(<ReportedUserAgents user={user} />);
    const heading = screen.getByRole("columnheader", { name: column });
    const button = within(heading).getByRole("button", { name: `Sort by ${column}` });
    await userEvent.click(button);
    const startsDescending = column === "Agent-wide last activity";
    expect(agentIds()).toEqual(startsDescending ? descending : ascending);
    await userEvent.click(button);
    expect(agentIds()).toEqual(startsDescending ? ascending : descending);
    expect(within(rows().at(-1)!).getAllByRole("cell")[1]).toHaveTextContent(/^Unknown$/);
    expect(within(rows().at(-1)!).getAllByRole("cell")[3]).toHaveTextContent("Not reported");
  });

  it("keeps agent names plain when an unpaid detail lacks a report snapshot", () => {
    const user = usageUsersFixture().users.value[0];
    user.datasetScope.reportSetId = null;
    const onFocusAgent = vi.fn();
    render(<ReportedUserAgents user={user} onFocusAgent={onFocusAgent} />);
    for (const row of rows()) {
      expect(within(row).queryByRole("button")).not.toBeInTheDocument();
      expect(within(row).queryByRole("link")).not.toBeInTheDocument();
    }
    expect(onFocusAgent).not.toHaveBeenCalled();
  });
});
