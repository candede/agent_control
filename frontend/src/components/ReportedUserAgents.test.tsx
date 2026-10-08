import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportPage, ReportRelationship } from "../../../backend/src/types/officialReportData";
import { ApiError } from "../api/client";
import { readReportPage } from "../api/reportData";
import { createSavedQueryClient } from "../savedQueries";
import { reportPage, reports, selectionId } from "../test/reportDataFixture";
import { deferred } from "../test/deferred";
import { ReportedUserAgents, type UserRelationshipQuery } from "./ReportedUserAgents";
import { SavedQueryProvider } from "./SavedQueryProvider";

vi.mock("../api/reportData", async original => ({ ...await original<typeof import("../api/reportData")>(), readReportPage: vi.fn() }));
const path = "official-usage/users/exact-user%40example.invalid/agents";
function UserAgents(props: Omit<ComponentProps<typeof ReportedUserAgents>, "query" | "onQueryChange">) {
  const [query, setQuery] = useState<UserRelationshipQuery>({ search: "", showAll: false, sort: "responses", order: "desc" });
  return <ReportedUserAgents {...props} query={query} onQueryChange={setQuery} />;
}
function relationship(index: number, changes: Partial<ReportRelationship> = {}): ReportRelationship {
  return { id: `relationship-${index}`, agentId: `agent-${index}`, agentName: `Agent ${index}`, creatorType: "Your org",
    username: "exact-user@example.invalid", responses: index, lastActivityDateUtc: "2026-01-01T00:00:00.000Z", identityStatus: "unresolved", ...changes };
}
function rows() { return within(screen.getByRole("region", { name: "User agent breakdown" })).getAllByRole("row").slice(1); }
function agentIds() { return rows().map(row => within(row).getAllByRole("cell")[0].querySelector("small")?.textContent); }
beforeEach(() => { vi.resetAllMocks(); vi.mocked(readReportPage).mockResolvedValue(reportPage([relationship(1)])); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("reported user's selected agent pages", () => {
  it("describes an empty relationship page without denying the server's known matches", async () => {
    vi.mocked(readReportPage).mockResolvedValue(reportPage([], {
      counts: { total: 100, filtered: 20 }, page: { limit: 50, nextCursor: "next", previousCursor: "previous" },
    }));
    render(<UserAgents path={path} selectionId={selectionId} />);
    expect(await screen.findByRole("heading", { name: "No agent relationships on this page" })).toBeVisible();
    expect(screen.getByText("No relationships on this page. Continue to the next page.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Next agents" })).toHaveAttribute("aria-disabled", "false");
    expect(screen.queryByText("No agent relationships match")).not.toBeInTheDocument();
  });

  it.each(["Next", "Previous"].flatMap(direction => [false, true].map(fails => ({ direction, fails }))))(
    "retains keyboard focus while loading the $direction relationship page (failure=$fails)", async ({ direction, fails }) => {
    vi.mocked(readReportPage).mockResolvedValueOnce(reportPage([relationship(1)],
      { page: { limit: 50, nextCursor: "next", previousCursor: "previous" } }));
    render(<UserAgents path={path} selectionId={selectionId} />);
    await screen.findByText("Agent 1");
    const button = screen.getByRole("button", { name: `${direction} agents` });
    let pending = deferred<ReportPage<ReportRelationship>>();
    vi.mocked(readReportPage).mockReturnValueOnce(pending.promise);
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(readReportPage).toHaveBeenLastCalledWith(path, expect.objectContaining({ selectionId, cursor: direction.toLowerCase() }), expect.any(AbortSignal));
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText("Agent 1")).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(readReportPage).toHaveBeenCalledTimes(2);
    if (fails) {
      await act(async () => pending.reject(new Error("Page unavailable.")));
      expect(await screen.findByRole("alert")).toHaveTextContent("Page unavailable.");
      expect(button).toHaveFocus();
      pending = deferred<ReportPage<ReportRelationship>>();
      vi.mocked(readReportPage).mockReturnValueOnce(pending.promise);
      fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
      expect(button).toHaveFocus();
    }
    await act(async () => pending.resolve(reportPage([relationship(2)])));
    await screen.findByText("Agent 2");
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-disabled", "true");
  });

  it.each([false, true])("preserves search, sort, pagination and optional cohort navigation over 1,005 relationships: %s", async navigable => {
    vi.mocked(readReportPage).mockImplementation(async (_path, query) => reportPage([
      relationship(query?.search ? 1004 : query?.sort === "name" ? 7 : query?.order === "asc" ? 0 : query?.cursor ? 954 : 1004),
    ], { counts: { total: 1005, filtered: query?.search ? 1 : 1005 },
      page: { limit: 50, nextCursor: query?.search ? null : "next-bounded-page", previousCursor: query?.cursor ? "previous" : null } }));
    const onFocusAgent = vi.fn();
    render(<UserAgents path={path} selectionId={selectionId} onFocusAgent={navigable ? onFocusAgent : undefined} />);
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
      render(<UserAgents path={path} selectionId={selectionId} />);
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
    render(<UserAgents path={path} selectionId={selectionId} onFocusAgent={onFocusAgent} />);
    await screen.findByText("Agent 1");
    expect(within(rows()[0]).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rows()[0]).queryByRole("link")).not.toBeInTheDocument();
    expect(onFocusAgent).not.toHaveBeenCalled();
  });

  it.each(["failure", "invalidation", "expiry", "revalidation", "replacement"] as const)(
    "checks current relationship evidence before focusing an agent across a just-started %s", async boundary => {
      const client = createSavedQueryClient(), pending = deferred<ReportPage<ReportRelationship>>();
      const initial = reportPage([relationship(1)]), onFocusAgent = vi.fn(), onSelectionInvalidated = vi.fn();
      initial.selection.expiresAt = new Date(Date.now() + 20_000).toISOString();
      vi.mocked(readReportPage).mockResolvedValueOnce(initial).mockReturnValueOnce(pending.promise);
      const view = render(<SavedQueryProvider client={client}>
        <UserAgents path={path} selectionId={selectionId} onFocusAgent={onFocusAgent} onSelectionInvalidated={onSelectionInvalidated} />
      </SavedQueryProvider>);
      const agent = await screen.findByRole("button", { name: "Agent 1: active users without paid Copilot" });
      agent.focus();
      const cached = client.getQueryCache().find({ queryKey: ["saved", "record-page"], exact: false })!;
      act(() => {
        if (boundary === "failure") cached.setState({ status: "error", error: new Error("Relationships unavailable.") });
        else if (boundary === "invalidation") cached.setState({
          status: "error", error: new ApiError(409, "selection_invalidated", "Selection changed."),
        });
        else if (boundary === "expiry") vi.spyOn(performance, "now").mockReturnValue(performance.now() + Date.parse(initial.selection.expiresAt) - Date.parse(initial.selection.validatedAt) + 1);
        else if (boundary === "replacement") client.setQueryData(cached.queryKey, reportPage([relationship(2)]));
        else void client.invalidateQueries({ queryKey: cached.queryKey, exact: true });
        // The cache and clock change before React receives their observer notifications.
        fireEvent.click(agent);
      });
      expect(onFocusAgent).not.toHaveBeenCalled();
      if (boundary === "revalidation") {
        expect(readReportPage).toHaveBeenCalledTimes(2);
        await waitFor(() => expect(agent).toHaveAttribute("aria-disabled", "true"));
        expect(agent).toHaveFocus();
        expect(screen.getByRole("region", { name: "Reported agent relationships" })).toHaveAttribute("aria-busy", "true");
        fireEvent.click(agent);
        expect(onFocusAgent).not.toHaveBeenCalled();
        await act(async () => pending.resolve(reportPage([relationship(2)])));
        await userEvent.click(await screen.findByRole("button", { name: "Agent 2: active users without paid Copilot" }));
        expect(onFocusAgent).toHaveBeenCalledExactlyOnceWith("agent-2", reports.setId);
      } else {
        expect(readReportPage).toHaveBeenCalledOnce();
        if (boundary === "invalidation") {
          await waitFor(() => expect(onSelectionInvalidated).toHaveBeenCalled());
          expect(screen.queryByRole("button", { name: "Agent 1: active users without paid Copilot" })).not.toBeInTheDocument();
        } else if (boundary === "expiry") {
          expect(onSelectionInvalidated).not.toHaveBeenCalled();
          expect(screen.getByRole("button", { name: "Agent 1: active users without paid Copilot" })).toBeVisible();
        } else if (boundary === "failure") {
          expect(await screen.findByRole("alert")).toHaveTextContent("Relationships unavailable.");
          expect(screen.queryByText("Agent 1")).not.toBeInTheDocument();
          expect(screen.queryByText("No agent relationships reported")).not.toBeInTheDocument();
          expect(screen.getByRole("region", { name: "Reported agent relationships" })).toHaveAttribute("aria-busy", "false");
        }
      }
      view.unmount();
      client.clear();
    });

  it("changes child filters explicitly while preserving the parent selection", async () => {
    render(<UserAgents path={path} selectionId={selectionId} filters={{ agentId: "agent-1", responsesOnly: true }} />);
    await screen.findByText("Agent 1");
    expect(readReportPage).toHaveBeenLastCalledWith(path, expect.objectContaining({ agentId: "agent-1", responsesOnly: true, selectionId }), expect.any(AbortSignal));
    await userEvent.click(screen.getByRole("button", { name: "Show all this user's agents" }));
    await waitFor(() => expect(vi.mocked(readReportPage).mock.calls.at(-1)![1]?.agentId).toBeUndefined());
    expect(vi.mocked(readReportPage).mock.calls.at(-1)![1]?.selectionId).toBe(selectionId);
    await userEvent.click(screen.getByRole("button", { name: "Show matching relationships" }));
    await waitFor(() => expect(vi.mocked(readReportPage).mock.calls.at(-1)![1]?.agentId).toBe("agent-1"));
  });

  it("exposes the unknown-creator restriction and retires its pending page when showing all relationships", async () => {
    const pending = deferred<ReportPage<ReportRelationship>>();
    vi.mocked(readReportPage).mockResolvedValue(reportPage([relationship(1, { creatorType: "" })],
      { page: { limit: 50, nextCursor: "next", previousCursor: null } }));
    render(<UserAgents path={path} selectionId={selectionId} filters={{ creatorType: "" }} />);
    await screen.findByText("Agent 1");
    expect(readReportPage).toHaveBeenLastCalledWith(path, expect.objectContaining({ creatorType: "", selectionId }), expect.any(AbortSignal));
    expect(screen.getByText("Showing agents matching the selected filters.")).toBeVisible();
    const showAll = screen.getByRole("button", { name: "Show all this user's agents" });
    vi.mocked(readReportPage).mockReturnValueOnce(pending.promise);
    await userEvent.click(screen.getByRole("button", { name: "Next agents" }));
    const signal = vi.mocked(readReportPage).mock.lastCall![2];
    await userEvent.click(showAll);
    await screen.findByText("Agent 1");
    expect(signal?.aborted).toBe(true);
    expect(vi.mocked(readReportPage).mock.lastCall![1]).toEqual({ selectionId, search: undefined, sort: "responses", order: "desc", limit: 50 });
    expect(screen.getByText("Showing all reported agents for this user.")).toBeVisible();
    await act(async () => pending.resolve(reportPage([relationship(99)])));
    expect(screen.queryByText("Agent 99")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show matching relationships" }));
    await screen.findByText("Agent 1");
    expect(readReportPage).toHaveBeenCalledTimes(4);
    expect(vi.mocked(readReportPage).mock.lastCall![1]).toEqual({ selectionId, creatorType: "", search: undefined, sort: "responses", order: "desc", limit: 50 });
  });

  it.each(["success", "invalidation"] as const)("ignores a superseded relationship search's late %s", async outcome => {
    const obsolete = deferred<ReportPage<ReportRelationship>>(), current = deferred<ReportPage<ReportRelationship>>();
    const onSelectionInvalidated = vi.fn();
    render(<UserAgents path={path} selectionId={selectionId} onSelectionInvalidated={onSelectionInvalidated} />);
    await screen.findByText("Agent 1");
    vi.mocked(readReportPage).mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise);
    const search = screen.getByRole("searchbox", { name: "Search this user's agents" });
    fireEvent.change(search, { target: { value: "obsolete" } });
    const signal = vi.mocked(readReportPage).mock.lastCall![2];
    fireEvent.change(search, { target: { value: "current" } });
    expect(signal?.aborted).toBe(true);
    expect(readReportPage).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("Agent 1")).not.toBeInTheDocument();
    await act(async () => {
      if (outcome === "success") obsolete.resolve(reportPage([relationship(99)]));
      else obsolete.reject(new ApiError(409, "selection_invalidated", "Obsolete selection."));
    });
    expect(screen.queryByText("Agent 99")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Loading saved data...")).toBeVisible();
    expect(onSelectionInvalidated).not.toHaveBeenCalled();
    await act(async () => current.resolve(reportPage([relationship(2)])));
    await screen.findByText("Agent 2");
    expect(readReportPage).toHaveBeenCalledTimes(3);
    expect(readReportPage).toHaveBeenLastCalledWith(path, expect.objectContaining({ selectionId, search: "current" }), expect.any(AbortSignal));
  });

  it("shares active relationship reads and revalidation without letting one reader cancel its peer", async () => {
    const client = createSavedQueryClient(), pending = deferred<ReportPage<ReportRelationship>>();
    const panels = (first = true) => <SavedQueryProvider client={client}>
      {first ? <UserAgents key="first" path={path} selectionId={selectionId} /> : null}
      <UserAgents key="second" path={path} selectionId={selectionId} />
    </SavedQueryProvider>;
    const view = render(panels());
    expect(await screen.findAllByText("Agent 1")).toHaveLength(2);
    expect(readReportPage).toHaveBeenCalledOnce();
    view.rerender(panels());
    expect(readReportPage).toHaveBeenCalledOnce();
    vi.mocked(readReportPage).mockReturnValueOnce(pending.promise);
    act(() => { void client.invalidateQueries({ queryKey: ["saved", "record-page"] }); });
    expect(readReportPage).toHaveBeenCalledTimes(2);
    const signal = vi.mocked(readReportPage).mock.lastCall![2];
    view.rerender(panels(false));
    expect(signal?.aborted).toBe(false);
    expect(readReportPage).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(reportPage([relationship(2)])));
    await screen.findByText("Agent 2");
    const abandoned = deferred<ReportPage<ReportRelationship>>();
    vi.mocked(readReportPage).mockReturnValueOnce(abandoned.promise);
    fireEvent.focus(window);
    const abandonedSignal = vi.mocked(readReportPage).mock.lastCall![2];
    expect(readReportPage).toHaveBeenCalledTimes(3);
    view.unmount();
    expect(abandonedSignal?.aborted).toBe(true);
    await act(async () => abandoned.resolve(reportPage([relationship(99)])));
    expect(screen.queryByText("Agent 99")).not.toBeInTheDocument();
    client.clear();
  });

  it("shares same-batch retries and replaces the local error with loading rather than an empty success", async () => {
    const pending = deferred<ReportPage<ReportRelationship>>(), onSelectionInvalidated = vi.fn();
    vi.mocked(readReportPage).mockRejectedValueOnce(new Error("Relationships unavailable.")).mockReturnValueOnce(pending.promise);
    render(<UserAgents path={path} selectionId={selectionId} onSelectionInvalidated={onSelectionInvalidated} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Relationships unavailable.");
    expect(screen.queryByText("No agent relationships reported")).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry saved data" });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(readReportPage).mock.lastCall![2]?.aborted).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Loading saved data...")).toBeVisible();
    await act(async () => pending.resolve(reportPage([], { counts: { total: 0, filtered: 0 } })));
    expect(await screen.findByRole("heading", { name: "No agent relationships reported" })).toBeVisible();
    expect(screen.queryByText("Loading saved data...")).not.toBeInTheDocument();
    expect(onSelectionInvalidated).not.toHaveBeenCalled();
  });

  it("admits an in-flight frozen relationship page through lease end without replay or automatic replacement", async () => {
    const initial = reportPage([relationship(1)], { page: { limit: 50, nextCursor: "next", previousCursor: null } });
    initial.selection.expiresAt = new Date(Date.now() + 20_000).toISOString();
    const pending = deferred<ReportPage<ReportRelationship>>(), onRestartSelection = vi.fn();
    vi.mocked(readReportPage).mockResolvedValueOnce(initial).mockReturnValueOnce(pending.promise);
    render(<UserAgents path={path} selectionId={selectionId} onRestartSelection={onRestartSelection} />);
    await screen.findByText("Agent 1");
    await userEvent.click(screen.getByRole("button", { name: "Next agents" }));
    const signal = vi.mocked(readReportPage).mock.lastCall![2];
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + Date.parse(initial.selection.expiresAt) - Date.parse(initial.selection.validatedAt) + 1);
    fireEvent.focus(window);
    expect(signal?.aborted).toBe(false);
    expect(screen.getByText("Loading saved data...")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry saved data" })).not.toBeInTheDocument();
    await act(async () => pending.resolve(reportPage([relationship(99)], { selection: initial.selection })));
    expect(await screen.findByText("Agent 99")).toBeVisible();
    const restart = screen.getByRole("button", { name: "Restart selection" });
    act(() => { fireEvent.click(restart); fireEvent.click(restart); });
    expect(onRestartSelection).toHaveBeenCalledOnce();
    expect(readReportPage).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Agent 99")).toBeVisible();
    expect(screen.getByRole("button", { name: "Next agents" })).toHaveAttribute("aria-disabled", "true");
    expect(readReportPage).toHaveBeenCalledTimes(2);
  });

  it("keeps an equivalent search's pending cursor and sort context instead of restarting the child read", async () => {
    const pending = deferred<ReportPage<ReportRelationship>>();
    vi.mocked(readReportPage).mockResolvedValue(reportPage([relationship(1)],
      { page: { limit: 50, nextCursor: "next", previousCursor: null } }));
    render(<UserAgents path={path} selectionId={selectionId} />);
    await screen.findByText("Agent 1");
    const search = screen.getByRole("searchbox", { name: "Search this user's agents" });
    fireEvent.change(search, { target: { value: "Agent" } });
    await waitFor(() => expect(readReportPage).toHaveBeenCalledTimes(2));
    await screen.findByText("Agent 1");
    vi.mocked(readReportPage).mockReturnValueOnce(pending.promise);
    await userEvent.click(screen.getByRole("button", { name: "Next agents" }));
    expect(readReportPage).toHaveBeenCalledTimes(3);
    const signal = vi.mocked(readReportPage).mock.calls[2][2];
    fireEvent.change(search, { target: { value: " ＡＧＥＮＴ " } });
    expect(search).toHaveValue(" ＡＧＥＮＴ ");
    expect(signal?.aborted).toBe(false);
    expect(readReportPage).toHaveBeenCalledTimes(3);
    await act(async () => pending.resolve(reportPage([relationship(2)])));
    await screen.findByText("Agent 2");
    expect(readReportPage).toHaveBeenLastCalledWith(path,
      expect.objectContaining({ selectionId, search: "agent", cursor: "next" }), expect.any(AbortSignal));
    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    await waitFor(() => expect(readReportPage).toHaveBeenCalledTimes(4));
    expect(readReportPage).toHaveBeenLastCalledWith(path,
      expect.objectContaining({ selectionId, search: "agent", sort: "name", order: "asc" }), expect.any(AbortSignal));
    expect(vi.mocked(readReportPage).mock.calls[3][1]?.cursor).toBeUndefined();
    expect(search).toHaveValue(" ＡＧＥＮＴ ");
  });
});
