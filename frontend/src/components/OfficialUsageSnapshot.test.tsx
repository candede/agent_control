import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { usageAggregateFixture } from "../test/usageInsightsFixture";
import { OfficialUsageSnapshot } from "./OfficialUsageSnapshot";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { createSavedQueryClient, readSavedQuery } from "../savedQueries";

const props = { activityWindowDays: 30, revision: 0, onBack: vi.fn(), onCurrentSnapshot: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(api, "getOfficialUsageAggregate").mockImplementation(async query => {
    const data = usageAggregateFixture({ staleAfterDays: 35, ...query, agentSortBy: query?.sortBy });
    if (query?.setId) data.activeSet!.id = query.setId;
    return data;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("controlled snapshot inspection", () => {
  it("loads the exact set and window and retains source details, tenant totals and back/current actions", async () => {
    render(<OfficialUsageSnapshot {...props} setId="retained-set" activityWindowDays={7} />);
    expect(screen.getByRole("region", { name: "Snapshot inspection" })).toHaveAttribute("tabindex", "0");
    await screen.findByRole("region", { name: "Report agent rows" });
    expect(api.getOfficialUsageAggregate).toHaveBeenCalledWith(
      expect.objectContaining({ setId: "retained-set", activityWindowDays: 7, limit: 25, offset: 0 }), { signal: expect.any(AbortSignal) });
    expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("270");
    expect(screen.getByText(/does not change the tenant's current report selection/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Researcher" }));
    expect(screen.getByRole("region", { name: "Source details for Researcher" })).toBeVisible();
    expect(screen.getByText("Showing retained set")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    await userEvent.click(screen.getByRole("button", { name: "View current snapshot" }));
    expect(props.onBack).toHaveBeenCalledOnce();
    expect(props.onCurrentSnapshot).toHaveBeenCalledOnce();
  });

  it("pages and resets the offset for search, date and sort changes", async () => {
    vi.mocked(api.getOfficialUsageAggregate).mockImplementation(async query => {
      const data = usageAggregateFixture({ staleAfterDays: 35, ...query, agentSortBy: query?.sortBy });
      data.agents.count = 40;
      return data;
    });
    render(<OfficialUsageSnapshot {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next agents" }));
    await waitFor(() => expect(api.getOfficialUsageAggregate).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25 }), expect.anything()));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Helpdesk" } });
    await waitFor(() => expect(api.getOfficialUsageAggregate).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, search: "Helpdesk" }), expect.anything()));
    expect(await screen.findByRole("button", { name: "Helpdesk" })).toBeVisible();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Order agents by" }), "agentName-asc");
    await waitFor(() => expect(api.getOfficialUsageAggregate).toHaveBeenLastCalledWith(expect.objectContaining({ sortBy: "agentName", sortDirection: "asc" }), expect.anything()));
    expect(await screen.findByRole("columnheader", { name: "Agent" })).toHaveAttribute("aria-sort", "ascending");
    fireEvent.change(screen.getByLabelText("Agent last activity on or after (UTC)"), { target: { value: "2026-09-10" } });
    await waitFor(() => expect(api.getOfficialUsageAggregate).toHaveBeenLastCalledWith(expect.objectContaining({ startDate: "2026-09-10", offset: 0 }), expect.anything()));
    const count = vi.mocked(api.getOfficialUsageAggregate).mock.calls.length;
    fireEvent.change(screen.getByLabelText("Agent last activity on or before (UTC)"), { target: { value: "2026-09-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("start date must be on or before");
    expect(api.getOfficialUsageAggregate).toHaveBeenCalledTimes(count);
    expect(screen.getByRole("button", { name: "Export agents CSV" })).toBeDisabled();
  });

  it.each([401, 403])("clears snapshot evidence on denied refresh (%s), then retries", async status => {
    const view = render(<OfficialUsageSnapshot {...props} />);
    await screen.findByRole("region", { name: "Report agent rows" });
    vi.mocked(api.getOfficialUsageAggregate).mockRejectedValueOnce(new api.ApiError(status, "denied", "Snapshot access denied."));
    view.rerender(<OfficialUsageSnapshot {...props} revision={1} />);
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Snapshot access denied.");
    expect(screen.queryByText("Report quality & sources")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry report" }));
    expect(await screen.findByRole("region", { name: "Report agent rows" })).toBeVisible();
  });

  it("withholds old snapshot evidence and ignores obsolete success/failure when set or window changes", async () => {
    let finish!: (data: api.OfficialUsageAggregateView) => void;
    vi.mocked(api.getOfficialUsageAggregate).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<OfficialUsageSnapshot {...props} setId="A" />);
    const signal = vi.mocked(api.getOfficialUsageAggregate).mock.calls[0][1]?.signal;
    view.rerender(<OfficialUsageSnapshot {...props} setId="B" activityWindowDays={7} />);
    await screen.findByRole("region", { name: "Report agent rows" });
    expect(signal?.aborted).toBe(true);
    const old = usageAggregateFixture();
    old.agents.value[0].agentName = "Obsolete agent";
    await act(async () => finish(old));
    expect(screen.queryByText("Obsolete agent")).not.toBeInTheDocument();
    let fail!: (error: Error) => void;
    vi.mocked(api.getOfficialUsageAggregate).mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    view.rerender(<OfficialUsageSnapshot {...props} setId="C" />);
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    view.rerender(<OfficialUsageSnapshot {...props} setId="B" />);
    await screen.findByRole("region", { name: "Report agent rows" });
    await act(async () => fail(new api.ApiError(403, "old", "Obsolete denial")));
    expect(screen.queryByText("Obsolete denial")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Report agent rows" })).toBeVisible();
  });

  it("deduplicates saved reads and aborts abandoned reads on unmount", async () => {
    vi.mocked(api.getOfficialUsageAggregate).mockReturnValue(new Promise(() => {}));
    const view = render(<SavedQueryProvider>
      <OfficialUsageSnapshot {...props} />
      <OfficialUsageSnapshot {...props} />
    </SavedQueryProvider>);
    expect(api.getOfficialUsageAggregate).toHaveBeenCalledOnce();
    const signal = vi.mocked(api.getOfficialUsageAggregate).mock.calls[0][1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("discards the old summary on explicit refresh and never substitutes the current set after a retained read fails", async () => {
    render(<OfficialUsageSnapshot {...props} setId="retained-set" />);
    await screen.findByRole("region", { name: "Snapshot tenant totals" });
    let reject!: (failure: Error) => void;
    vi.mocked(api.getOfficialUsageAggregate).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    expect(screen.getByText("Loading retained set")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Report agent rows" })).not.toBeInTheDocument();
    await act(async () => reject(new api.ApiError(404, "not_found", "The retained set was deleted.")));
    expect(await screen.findByText("Retained set unavailable")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("The retained set was deleted.");
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    expect(vi.mocked(api.getOfficialUsageAggregate).mock.calls.every(([query]) => query?.setId === "retained-set")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    expect(await screen.findByText("Showing retained set")).toBeVisible();
    expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("270");
  });

  it("preserves the same-generation summary on filter failure, but not stale rows or exports", async () => {
    render(<OfficialUsageSnapshot {...props} setId="retained-set" />);
    await screen.findByRole("region", { name: "Report agent rows" });
    vi.mocked(api.getOfficialUsageAggregate).mockRejectedValueOnce(new Error("Filtered rows unavailable."));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Helpdesk" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Filtered rows unavailable.");
    expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("270");
    expect(screen.queryByRole("region", { name: "Report agent rows" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agents CSV" })).toBeDisabled();
    expect(screen.getByText("Retained set unavailable")).toBeVisible();
  });

  it.each(["refresh", "revision"] as const)("isolates %s from a pre-action read kept alive by a parallel saved observer", async action => {
    const client = createSavedQueryClient();
    const renderSnapshot = (revision: number) => <SavedQueryProvider client={client}>
      <OfficialUsageSnapshot {...props} revision={revision} setId="retained-set" />
    </SavedQueryProvider>;
    const view = render(renderSnapshot(0));
    await screen.findByRole("region", { name: "Snapshot tenant totals" });
    let finishOld!: (value: api.OfficialUsageAggregateView) => void;
    let finishNew!: (value: api.OfficialUsageAggregateView) => void;
    vi.mocked(api.getOfficialUsageAggregate)
      .mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { finishNew = resolve; }));
    const request = { setId: "retained-set", activityWindowDays: 30, limit: 25, offset: 0 };
    const lease = new AbortController();
    const oldRead = readSavedQuery(client, ["official-usage-aggregate", request, 0, 0],
      signal => api.getOfficialUsageAggregate(request, { signal }), lease.signal);
    expect(api.getOfficialUsageAggregate).toHaveBeenCalledTimes(2);
    const oldSignal = vi.mocked(api.getOfficialUsageAggregate).mock.calls[1][1]?.signal;
    if (action === "refresh") await userEvent.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    else view.rerender(renderSnapshot(1));
    expect(api.getOfficialUsageAggregate).toHaveBeenCalledTimes(3);
    expect(oldSignal?.aborted).toBe(false);
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    const fresh = usageAggregateFixture();
    fresh.activeSet!.id = "retained-set";
    fresh.summary.usage.totalResponses = 1234;
    await act(async () => finishNew(fresh));
    expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("1,234");
    const obsolete = usageAggregateFixture();
    obsolete.activeSet!.id = "retained-set";
    obsolete.summary.usage.totalResponses = 9999;
    await act(async () => { finishOld(obsolete); await oldRead; });
    expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("1,234");
    expect(screen.queryByText("9,999")).not.toBeInTheDocument();
    lease.abort();
    client.clear();
  });

  it("aborts an in-flight read when the date range becomes reversed and ignores its late result", async () => {
    render(<OfficialUsageSnapshot {...props} setId="retained-set" />);
    await screen.findByRole("region", { name: "Report agent rows" });
    let finish!: (value: api.OfficialUsageAggregateView) => void;
    vi.mocked(api.getOfficialUsageAggregate).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    fireEvent.change(screen.getByLabelText("Agent last activity on or after (UTC)"), { target: { value: "2026-09-10" } });
    const signal = vi.mocked(api.getOfficialUsageAggregate).mock.calls.at(-1)?.[1]?.signal;
    fireEvent.change(screen.getByLabelText("Agent last activity on or before (UTC)"), { target: { value: "2026-09-01" } });
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("start date must be on or before");
    expect(screen.getByRole("button", { name: "Refresh snapshot" })).toBeDisabled();
    expect(screen.queryByText("Loading retained set")).not.toBeInTheDocument();
    expect(api.getOfficialUsageAggregate).toHaveBeenCalledTimes(2);
    const obsolete = usageAggregateFixture();
    obsolete.summary.usage.totalResponses = 9999;
    await act(async () => finish(obsolete));
    expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("270");
    expect(screen.queryByRole("region", { name: "Report agent rows" })).not.toBeInTheDocument();
  });

  it.each(["current", "missing"] as const)("rejects a %s response to an exact retained-set request", async response => {
    const unexpected = usageAggregateFixture();
    if (response === "missing") unexpected.activeSet = null;
    vi.mocked(api.getOfficialUsageAggregate).mockResolvedValue(unexpected);
    render(<OfficialUsageSnapshot {...props} setId="retained-set" />);
    expect(await screen.findByText("Retained set unavailable")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("No current snapshot has been substituted");
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Report agent rows" })).not.toBeInTheDocument();
    expect(api.getOfficialUsageAggregate).toHaveBeenCalledOnce();
  });
});
