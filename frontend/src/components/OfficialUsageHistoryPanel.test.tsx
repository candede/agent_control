import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { ReportHistorySet, ReportPage } from "../../../backend/src/types/officialReportData";
import { OfficialUsageHistoryPanel } from "./OfficialUsageHistoryPanel";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { historySet, reportPage, selectionId } from "../test/reportDataFixture";

type HistoryPage = ReportPage<ReportHistorySet>;

const api = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock("../api/reportData", async importOriginal => ({
  ...await importOriginal<typeof import("../api/reportData")>(), readReportPage: api.history,
}));

function history(start = 0, count = 2): HistoryPage {
  return reportPage(Array.from({ length: Math.max(0, Math.min(50, count - start)) }, (_, index) =>
    historySet(index + start + 1, { periodProvenance: "activity_range" })), {
    counts: { total: count, filtered: count }, page: { limit: 50,
      nextCursor: start + 50 < count ? `page-${start + 50}` : null, previousCursor: start ? `page-${Math.max(0, start - 50)}` : null },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  api.history.mockImplementation(async (_path, query) => history(query.cursor ? Number(query.cursor.slice(5)) : 0));
});

describe("saved report history", () => {
  it("shows concise report rows without technical payloads, an extra current-report action, or routine refresh", async () => {
    render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    await screen.findByRole("table");
    expect(screen.getByText("2 saved report sets")).toBeVisible();
    expect(screen.getByText("Current")).toBeVisible();
    expect(screen.getByText("Saved", { exact: true })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "View report" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Refresh|View current|Make current/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/hash|Retention|Unique payloads|Aggregate snapshots/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Report observations" })).toHaveLength(2);
    expect(document.querySelector("details")).toBeNull();
  });

  it("deduplicates concurrent reads with the shared saved-query client", async () => {
    render(<SavedQueryProvider>
      <OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />
      <OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />
    </SavedQueryProvider>);
    expect(await screen.findAllByRole("table")).toHaveLength(2);
    expect(api.history).toHaveBeenCalledOnce();
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
    expect(screen.getByText(/Activity dates do not imply continuous coverage/)).toBeVisible();
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
    const view = render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} admin={admin} />);
    await screen.findByRole("table");
    view.rerender(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} admin={{ ...admin, busy: true }} />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    let finish!: (value: HistoryPage) => void;
    api.history.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    view.rerender(<OfficialUsageHistoryPanel revision={1} onSelect={vi.fn()} admin={admin} />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    await act(async () => finish(history()));
    await waitFor(() => {
      for (const button of screen.getAllByRole("button", { name: /View report|Report observations|Delete report set|Load current report history/ })) expect(button).toBeEnabled();
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
    expect(screen.getByRole("button", { name: "Next report sets" })).toBeDisabled();
  });

  it("requires an explicit new selection after deletion invalidates the current page", async () => {
    let count = 101;
    api.history.mockImplementation(async (_path, query) => {
      if (count === 51 && query.selectionId) throw new ApiError(409, "selection_invalidated", "History membership changed");
      return history(query.cursor ? Number(query.cursor.slice(5)) : 0, count);
    });
    const view = render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next report sets" }));
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next report sets" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Next report sets" }));
    await screen.findByText("101 matching report sets; 1 on this page");
    count = 51;
    view.rerender(<OfficialUsageHistoryPanel revision={1} onSelect={vi.fn()} />);
    await screen.findByRole("button", { name: "Restart selection" });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(api.history).toHaveBeenCalledTimes(4);
    await userEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    await screen.findByText("51 matching report sets; 50 on this page");
    expect(api.history.mock.calls.at(-1)?.[1].selectionId).toBeUndefined();
    expect(api.history.mock.calls.at(-1)?.[1].cursor).toBeUndefined();
  });
});
