import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportRelationship } from "../../../backend/src/types/officialReportData";
import { readReportPage } from "../api/reportData";
import { reportPage, reports, selectionId } from "../test/reportDataFixture";
import { ReportedUserAgents } from "./ReportedUserAgents";

vi.mock("../api/reportData", async original => ({ ...await original<typeof import("../api/reportData")>(), readReportPage: vi.fn() }));
const path = "official-usage/users/exact-user%40example.invalid/agents";
function relationship(index: number, changes: Partial<ReportRelationship> = {}): ReportRelationship {
  return { id: `relationship-${index}`, agentId: `agent-${index}`, agentName: `Agent ${index}`, creatorType: "Your org",
    username: "exact-user@example.invalid", responses: index, lastActivityDateUtc: "2026-01-01T00:00:00.000Z", identityStatus: "unresolved", ...changes };
}
function rows() { return within(screen.getByRole("region", { name: "User agent breakdown" })).getAllByRole("row").slice(1); }
function agentIds() { return rows().map(row => within(row).getAllByRole("cell")[0].querySelector("small")?.textContent); }
beforeEach(() => { vi.resetAllMocks(); vi.mocked(readReportPage).mockResolvedValue(reportPage([relationship(1)])); });
afterEach(cleanup);

describe("reported user's selected agent pages", () => {
  it.each([false, true])("preserves search, sort, pagination and optional cohort navigation over 1,005 relationships: %s", async navigable => {
    vi.mocked(readReportPage).mockImplementation(async (_path, query) => reportPage([
      relationship(query?.search ? 1004 : query?.sort === "name" ? 7 : query?.order === "asc" ? 0 : query?.cursor ? 954 : 1004),
    ], { counts: { total: 1005, filtered: query?.search ? 1 : 1005 },
      page: { limit: 50, nextCursor: query?.search ? null : "next-bounded-page", previousCursor: query?.cursor ? "previous" : null } }));
    const onFocusAgent = vi.fn();
    render(<ReportedUserAgents path={path} selectionId={selectionId} onFocusAgent={navigable ? onFocusAgent : undefined} />);
    await screen.findByText("1,005 matching agents; 1 on this page");
    expect(agentIds()).toEqual(["agent-1004"]); expect(readReportPage).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Next agents" }));
    await waitFor(() => expect(agentIds()).toEqual(["agent-954"]));
    expect(readReportPage).toHaveBeenLastCalledWith(path, expect.objectContaining({
      selectionId, cursor: "next-bounded-page", limit: 50,
    }), expect.any(AbortSignal));
    const responses = screen.getByRole("button", { name: "Responses to this user" });
    responses.focus(); await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(agentIds()).toEqual(["agent-0"]));
    expect(within(rows()[0]).getAllByRole("cell")[2]).toHaveTextContent(/^0$/);
    expect(responses).toHaveFocus();
    expect(vi.mocked(readReportPage).mock.calls.at(-1)![1]).toMatchObject({ selectionId, sort: "responses", order: "asc" });
    expect(vi.mocked(readReportPage).mock.calls.at(-1)![1]?.cursor).toBeUndefined();
    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    await waitFor(() => expect(agentIds()).toEqual(["agent-7"]));
    expect(readReportPage).toHaveBeenLastCalledWith(path, expect.objectContaining({ sort: "name", order: "asc" }), expect.any(AbortSignal));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search this user's agents" }), "agent-1004");
    await screen.findByText("1 matching agents; 1 on this page");
    expect(agentIds()).toEqual(["agent-1004"]);
    if (navigable) {
      const agent = screen.getByRole("button", { name: "Agent 1004: active users without paid Copilot" });
      expect(agent).toHaveAttribute("title", "Show active users without paid Copilot for report agent agent-1004");
      await userEvent.click(agent);
      expect(onFocusAgent).toHaveBeenCalledExactlyOnceWith("agent-1004", reports.setId);
    } else {
      expect(within(rows()[0]).getByText("Agent 1004").closest("button, a")).toBeNull();
      expect(onFocusAgent).not.toHaveBeenCalled();
    }
  });

  it.each([["Creator", "creatorType"], ["Agent-wide last activity", "lastActivity"]] as const)(
    "preserves server null-last %s ordering without re-sorting a returned page", async (column, sort) => {
      const missing = relationship(3, { creatorType: "", lastActivityDateUtc: null });
      vi.mocked(readReportPage).mockImplementation(async (_path, query) => reportPage([
        ...(query?.order === "asc" ? [relationship(2), relationship(10)] : [relationship(10), relationship(2)]), missing,
      ]));
      render(<ReportedUserAgents path={path} selectionId={selectionId} />);
      await screen.findByRole("region", { name: "User agent breakdown" });
      const button = screen.getByRole("button", { name: column });
      await userEvent.click(button);
      const firstOrder = column === "Creator" ? "asc" : "desc";
      await waitFor(() => expect(readReportPage).toHaveBeenLastCalledWith(path, expect.objectContaining({ sort, order: firstOrder }), expect.any(AbortSignal)));
      await waitFor(() => expect(agentIds()).toEqual(firstOrder === "asc" ? ["agent-2", "agent-10", "agent-3"] : ["agent-10", "agent-2", "agent-3"]));
      await userEvent.click(button);
      await waitFor(() => expect(agentIds()).toEqual(firstOrder === "asc" ? ["agent-10", "agent-2", "agent-3"] : ["agent-2", "agent-10", "agent-3"]));
      expect(within(rows().at(-1)!).getAllByRole("cell")[1]).toHaveTextContent(/^Unknown$/);
      expect(within(rows().at(-1)!).getAllByRole("cell")[3]).toHaveTextContent("Not reported");
    });

  it("keeps agent names plain when no report set is selected", async () => {
    vi.mocked(readReportPage).mockResolvedValue(reportPage([relationship(1)], { reports: { ...reports, setId: null } }));
    const onFocusAgent = vi.fn();
    render(<ReportedUserAgents path={path} selectionId={selectionId} onFocusAgent={onFocusAgent} />);
    await screen.findByText("Agent 1");
    expect(within(rows()[0]).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rows()[0]).queryByRole("link")).not.toBeInTheDocument();
    expect(onFocusAgent).not.toHaveBeenCalled();
  });

  it("changes child filters explicitly while preserving the parent selection", async () => {
    render(<ReportedUserAgents path={path} selectionId={selectionId} filters={{ agentId: "agent-1", responsesOnly: true }} />);
    await screen.findByText("Agent 1");
    expect(readReportPage).toHaveBeenLastCalledWith(path, expect.objectContaining({ agentId: "agent-1", responsesOnly: true, selectionId }), expect.any(AbortSignal));
    await userEvent.click(screen.getByRole("button", { name: "Show all this user's agents" }));
    await waitFor(() => expect(vi.mocked(readReportPage).mock.calls.at(-1)![1]?.agentId).toBeUndefined());
    expect(vi.mocked(readReportPage).mock.calls.at(-1)![1]?.selectionId).toBe(selectionId);
    await userEvent.click(screen.getByRole("button", { name: "Show matching relationships" }));
    await waitFor(() => expect(vi.mocked(readReportPage).mock.calls.at(-1)![1]?.agentId).toBe("agent-1"));
  });
});
