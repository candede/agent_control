import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { ReportHistorySet, ReportPage } from "../../../backend/src/types/officialReportData";
import { OfficialUsageHistoryPanel } from "./OfficialUsageHistoryPanel";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { historySet, reportPage, selectionId } from "../test/reportDataFixture";
import { selectedHistoryPage } from "../test/selectedUsageFixture";
import { deferred } from "../test/deferred";

type HistoryPage = ReportPage<ReportHistorySet>;

const api = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock("../api/reportData", async importOriginal => ({
  ...await importOriginal<typeof import("../api/reportData")>(), readReportPage: api.history,
}));

function history(start = 0, count = 2): HistoryPage {
  const page = reportPage(Array.from({ length: Math.max(0, Math.min(50, count - start)) }, (_, index) =>
    historySet(index + start + 1, { periodProvenance: "activity_range" })), {
    counts: { total: count, filtered: count }, page: { limit: 50,
      nextCursor: start + 50 < count ? `page-${start + 50}` : null, previousCursor: start ? `page-${Math.max(0, start - 50)}` : null },
  });
  page.analytics.history = selectedHistoryPage(page.value).analytics.history;
  return page;
}

beforeEach(() => {
  vi.resetAllMocks();
  api.history.mockImplementation(async (_path, query) => history(query.cursor ? Number(query.cursor.slice(5)) : 0));
});

describe("saved report history", () => {
  it("keeps paging focused through failure and retry without presenting the old page as current", async () => {
    const pending = deferred<HistoryPage>(), retry = deferred<HistoryPage>();
    api.history.mockResolvedValueOnce(history(0, 51)).mockReturnValueOnce(pending.promise).mockReturnValueOnce(retry.promise);
    render(<OfficialUsageHistoryPanel revision={0} />);
    await screen.findByRole("table");
    const next = screen.getByRole("button", { name: "Next report sets" });
    next.focus();
    await userEvent.keyboard("{Enter}");
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    await act(async () => pending.reject(new Error("Page unavailable.")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Page unavailable.");
    expect(next).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    expect(next).toHaveFocus();
    await act(async () => retry.resolve(history(50, 51)));
    await screen.findByText("51 matching report sets; 1 on this page");
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(api.history).toHaveBeenCalledTimes(3);
  });

  it("shows concise report rows without technical payloads, an extra current-report action, or routine refresh", async () => {
    render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    await screen.findByRole("table");
    expect(screen.getByText("2 saved report sets")).toBeVisible();
    expect(screen.getByText("Current")).toBeVisible();
    expect(screen.getByText("Saved", { exact: true })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "View report" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Refresh|View current|Make current|Load current report history|Report observations/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/hash|Retention|Unique payloads|Aggregate snapshots|pinned history|History coverage/)).not.toBeInTheDocument();
    expect(screen.queryByText(historySet(1).id)).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(document.querySelector("details")).toBeNull();
  });

  it("shows only the compact empty state even when the server includes history analytics", async () => {
    api.history.mockResolvedValue(history(0, 0));
    render(<OfficialUsageHistoryPanel revision={0} />);
    await screen.findByRole("heading", { name: "No reports yet" });
    expect(screen.getByText("Add the three Microsoft 365 CSV exports to see agent usage.")).toBeVisible();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/0 saved|matching report|pinned history|History coverage/)).not.toBeInTheDocument();
    expect(document.querySelector("details")).toBeNull();
    expect(api.history).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent reads with the shared saved-query client", async () => {
    render(<SavedQueryProvider>
      <OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />
      <OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />
    </SavedQueryProvider>);
    expect(await screen.findAllByRole("table")).toHaveLength(2);
    expect(api.history).toHaveBeenCalledOnce();
  });

  it("keeps retained history keyboard-scrollable and announces revalidation while row actions are disabled", async () => {
    const pending = deferred<HistoryPage>();
    api.history.mockResolvedValueOnce(history()).mockReturnValueOnce(pending.promise);
    render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    const table = await screen.findByRole("region", { name: "Saved report history" });
    expect(table).toHaveAttribute("tabindex", "0");
    table.focus();
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(table).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByRole("region", { name: "Saved report history" })).toBe(table);
    expect(table).toHaveFocus();
    for (const button of within(table).getAllByRole("button")) expect(button).toBeDisabled();
    await act(async () => pending.resolve(history()));
    await waitFor(() => expect(table).toHaveAttribute("aria-busy", "false"));
    expect(table).toHaveFocus();
    expect(api.history).toHaveBeenCalledTimes(2);
  });

  it("withdraws shared history when revalidation rejects its selection", async () => {
    const revalidation = deferred<HistoryPage>();
    render(<SavedQueryProvider>
      <section aria-label="Current reader"><OfficialUsageHistoryPanel revision={0} /></section>
      <section aria-label="Pinned reader"><OfficialUsageHistoryPanel revision={0} /></section>
    </SavedQueryProvider>);
    expect(await screen.findAllByRole("table")).toHaveLength(2);
    const current = within(screen.getByRole("region", { name: "Current reader" }));
    const pinned = within(screen.getByRole("region", { name: "Pinned reader" }));
    api.history.mockReturnValueOnce(revalidation.promise);
    fireEvent.focus(window);
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
    await act(async () => revalidation.reject(new ApiError(409, "selection_invalidated", "History changed.")));
    await current.findByRole("alert");
    await waitFor(() => expect(pinned.queryByRole("table")).not.toBeInTheDocument());
    expect(pinned.getByRole("button", { name: "Restart selection" })).toBeEnabled();
    expect(pinned.queryByRole("button", { name: "View report" })).not.toBeInTheDocument();
    expect(current.queryByRole("table")).not.toBeInTheDocument();
    expect(api.history).toHaveBeenCalledTimes(2);
  });

  it("cancels abandoned StrictMode reads without applying their late results", async () => {
    let finish!: (value: HistoryPage) => void;
    api.history.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<SavedQueryProvider>
      <OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />
      <OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />
    </SavedQueryProvider>, { reactStrictMode: true });
    expect(await screen.findAllByRole("table")).toHaveLength(2);
    expect(api.history.mock.calls[0][2].aborted).toBe(true);
    await act(async () => finish(history(0, 0)));
    expect(screen.getAllByRole("button", { name: "View report" })).toHaveLength(4);
    expect(screen.queryByRole("heading", { name: "No reports yet" })).not.toBeInTheDocument();
  });

  it("isolates post-mutation reads from older shared observers", async () => {
    let finish!: (value: HistoryPage) => void;
    api.history.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(history(0, 0));
    const panels = (revision: number) => <SavedQueryProvider>
      <section aria-label="Current reader"><OfficialUsageHistoryPanel revision={revision} onSelect={vi.fn()} /></section>
      <section aria-label="Earlier reader"><OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} /></section>
    </SavedQueryProvider>;
    const view = render(panels(0));
    view.rerender(panels(1));
    const current = within(screen.getByRole("region", { name: "Current reader" }));
    await current.findByRole("heading", { name: "No reports yet" });
    expect(api.history.mock.calls[0][2].aborted).toBe(false);
    await act(async () => finish(history()));
    expect(current.getByRole("heading", { name: "No reports yet" })).toBeVisible();
    expect(current.queryByRole("table")).not.toBeInTheDocument();
    expect(await within(screen.getByRole("region", { name: "Earlier reader" })).findByRole("table")).toBeVisible();
  });

  it("opens a current or historical row by its exact ID without changing selection", async () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(<OfficialUsageHistoryPanel revision={0} onSelect={onSelect} admin={{ busy: false, onDelete }} />);
    const buttons = await screen.findAllByRole("button", { name: "View report" });
    await userEvent.click(buttons[0]);
    await userEvent.click(buttons[1]);
    expect(onSelect.mock.calls).toEqual([[historySet(1).id], [historySet(2).id]]);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("distinguishes observed dates, explicit reporting periods, and undated reports", async () => {
    const data = history(0, 3);
    data.value[1].periodProvenance = "operator_asserted";
    data.value[2].reportingStart = data.value[2].reportingEnd = null;
    api.history.mockResolvedValue(data);
    render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    await screen.findByRole("table");
    expect(screen.getAllByText("Observed activity")).toHaveLength(2);
    expect(screen.getByText("Reporting period")).toBeVisible();
    expect(screen.getByText("No activity dates")).toBeVisible();
    expect(screen.queryByText(/Activity dates do not imply continuous coverage/)).not.toBeInTheDocument();
    const dates = screen.getByRole("table").querySelectorAll("time");
    expect(dates).toHaveLength(4);
    expect(dates[0]).toHaveAttribute("datetime", data.value[0].reportingStart);
    expect(dates[1]).toHaveAttribute("datetime", data.value[0].reportingEnd);
  });

  it("reloads on returning to the window and offers Retry only if that read fails", async () => {
    render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    await screen.findByRole("table");
    api.history.mockRejectedValueOnce(new Error("History unavailable."));
    fireEvent(window, new Event("focus"));
    expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
    expect(screen.queryByRole("button", { name: "View report" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "View report" })[0]).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Retry saved data" })).not.toBeInTheDocument();
  });

  it("disables report actions while reloading or performing a mutation", async () => {
    const admin = { busy: false, onDelete: vi.fn() };
    api.history.mockResolvedValueOnce(history(0, 51));
    const view = render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} admin={admin} />);
    await screen.findByRole("table");
    view.rerender(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} admin={{ ...admin, busy: true }} />);
    for (const button of screen.getAllByRole("button", { name: /View report|Delete report set/ })) expect(button).toBeDisabled();
    for (const button of within(screen.getByRole("navigation", { name: "report sets pages" })).getAllByRole("button")) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(button);
    }
    expect(api.history).toHaveBeenCalledOnce();
    let finish!: (value: HistoryPage) => void;
    api.history.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    view.rerender(<OfficialUsageHistoryPanel revision={1} onSelect={vi.fn()} admin={admin} />);
    expect(screen.getByText("Loading saved data...")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button", { name: /View report|Delete report set/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    await act(async () => finish(history()));
    await waitFor(() => {
      for (const button of screen.getAllByRole("button", { name: /View report|Delete report set/ })) expect(button).toBeEnabled();
    });
  });

  it.each([401, 403])("clears stale report metadata on a %s denial", async status => {
    const view = render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    await screen.findByRole("table");
    api.history.mockRejectedValueOnce(new ApiError(status, "denied", "Report access denied."));
    view.rerender(<OfficialUsageHistoryPanel revision={1} onSelect={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Report access denied");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    await screen.findByRole("table");
  });

  it("does not mislabel an older page as a pending or failed next page", async () => {
    api.history.mockResolvedValueOnce(history(0, 51)).mockRejectedValueOnce(new Error("Page unavailable.")).mockResolvedValueOnce(history(50, 51));
    render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next report sets" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Page unavailable");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "First page" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    await screen.findByText("51 matching report sets; 1 on this page");
    expect(api.history).toHaveBeenLastCalledWith("official-usage/history", expect.objectContaining({
      selectionId, limit: 50, cursor: "page-50",
    }), expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Next report sets" })).toHaveAttribute("aria-disabled", "true");
  });

  it("automatically captures current history after a known deletion", async () => {
    let count = 101;
    api.history.mockImplementation(async (_path, query) => {
      if (count === 51 && query.selectionId) throw new ApiError(409, "selection_invalidated", "History membership changed");
      return history(query.cursor ? Number(query.cursor.slice(5)) : 0, count);
    });
    const view = render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next report sets" }));
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next report sets" })).toHaveAttribute("aria-disabled", "false"));
    await userEvent.click(screen.getByRole("button", { name: "Next report sets" }));
    await screen.findByText("101 matching report sets; 1 on this page");
    count = 51;
    view.rerender(<OfficialUsageHistoryPanel revision={1} onSelect={vi.fn()} />);
    await screen.findByText("51 matching report sets; 50 on this page");
    expect(api.history).toHaveBeenCalledTimes(4);
    expect(api.history.mock.calls.at(-1)?.[1].selectionId).toBeUndefined();
    expect(api.history.mock.calls.at(-1)?.[1].cursor).toBeUndefined();
  });
});
