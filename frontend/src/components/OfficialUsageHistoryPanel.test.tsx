import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type OfficialUsageHistoryView } from "../api/client";
import { OfficialUsageHistoryPanel } from "./OfficialUsageHistoryPanel";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { reportHistoryFixture } from "./reportHistoryFixture";
import { usageInsightsPublished } from "../test/usageInsightsFixture";

const api = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(), getOfficialUsageHistory: api.history,
}));

function history(offset = 0, count = 2): OfficialUsageHistoryView {
  const data = reportHistoryFixture(Array.from({ length: Math.max(0, Math.min(25, count - offset)) }, (_, index) => ({
    ...usageInsightsPublished.activeSet!, id: `report-${index + offset}`, bundleId: `bundle-${index + offset}`,
  })), "report-0");
  data.bundles.count = count;
  data.bundles.offset = offset;
  data.summary.importCount = count;
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  api.history.mockImplementation(async ({ offset }) => history(offset));
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
    expect(screen.queryByText(/hash|Retention|Unique payloads|Report observations|Aggregate snapshots/)).not.toBeInTheDocument();
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
    let finish!: (value: OfficialUsageHistoryView) => void;
    api.history.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<SavedQueryProvider>
      <OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />
      <OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />
    </SavedQueryProvider>, { reactStrictMode: true });
    expect(await screen.findAllByRole("table")).toHaveLength(2);
    expect(api.history.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => finish(history(0, 0)));
    expect(screen.getAllByRole("button", { name: "View report" })).toHaveLength(4);
    expect(screen.queryByRole("heading", { name: "No reports yet" })).not.toBeInTheDocument();
  });

  it("isolates post-mutation reads from older shared observers", async () => {
    let finish!: (value: OfficialUsageHistoryView) => void;
    api.history.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(history(0, 0));
    const panels = (revision: number) => <SavedQueryProvider>
      <section aria-label="Current reader"><OfficialUsageHistoryPanel revision={revision} onSelect={vi.fn()} /></section>
      <section aria-label="Earlier reader"><OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} /></section>
    </SavedQueryProvider>;
    const view = render(panels(0));
    view.rerender(panels(1));
    const current = within(screen.getByRole("region", { name: "Current reader" }));
    await current.findByRole("heading", { name: "No reports yet" });
    expect(api.history.mock.calls[0][1].signal.aborted).toBe(false);
    await act(async () => finish(history()));
    expect(current.getByRole("heading", { name: "No reports yet" })).toBeVisible();
    expect(current.queryByRole("table")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Earlier reader" })).getByRole("table")).toBeVisible();
  });

  it("opens a current or historical row by its exact ID without changing selection", async () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(<OfficialUsageHistoryPanel revision={0} onSelect={onSelect} admin={{ busy: false, onDelete }} />);
    const buttons = await screen.findAllByRole("button", { name: "View report" });
    await userEvent.click(buttons[0]);
    await userEvent.click(buttons[1]);
    expect(onSelect.mock.calls).toEqual([["report-0"], ["report-1"]]);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("distinguishes observed dates, explicit reporting periods, and undated reports", async () => {
    const data = history(0, 3);
    data.bundles.value[1].reportingWindowKnown = true;
    data.bundles.value[2].reportingPeriod = { startDate: null, endDate: null, provenance: "activity_range" };
    api.history.mockResolvedValue(data);
    render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    await screen.findByRole("table");
    expect(screen.getAllByText("Observed activity")).toHaveLength(2);
    expect(screen.getByText("Reporting period")).toBeVisible();
    expect(screen.getByText("No activity dates")).toBeVisible();
    expect(screen.getByText(/Activity dates do not imply continuous coverage/)).toBeVisible();
  });

  it("reloads on returning to the window and offers Retry only if that read fails", async () => {
    render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    await screen.findByRole("table");
    api.history.mockRejectedValueOnce(new Error("History unavailable."));
    fireEvent(window, new Event("focus"));
    expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
    for (const button of screen.getAllByRole("button", { name: "View report" })) expect(button).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "View report" })[0]).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("disables report actions while reloading or performing a mutation", async () => {
    const admin = { busy: false, onDelete: vi.fn() };
    const view = render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} admin={admin} />);
    await screen.findByRole("table");
    view.rerender(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} admin={{ ...admin, busy: true }} />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    let finish!: (value: OfficialUsageHistoryView) => void;
    api.history.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    view.rerender(<OfficialUsageHistoryPanel revision={1} onSelect={vi.fn()} admin={admin} />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    await act(async () => finish(history()));
    for (const button of screen.getAllByRole("button")) expect(button).toBeEnabled();
  });

  it.each([401, 403])("clears stale report metadata on a %s denial", async status => {
    const view = render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    await screen.findByRole("table");
    api.history.mockRejectedValueOnce(new ApiError(status, "denied", "Report access denied."));
    view.rerender(<OfficialUsageHistoryPanel revision={1} onSelect={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Report access denied");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("table");
  });

  it("does not mislabel an older page as a pending or failed next page", async () => {
    api.history.mockResolvedValueOnce(history(0, 26)).mockRejectedValueOnce(new Error("Page unavailable.")).mockResolvedValueOnce(history(25, 26));
    render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Page unavailable");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "First page" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("26-26 of 26");
    expect(api.history).toHaveBeenLastCalledWith({ limit: 25, offset: 25 }, { signal: expect.any(AbortSignal) });
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("moves to the surviving last page after deletion removes the current page", async () => {
    let count = 51;
    api.history.mockImplementation(async ({ offset }) => history(offset, count));
    const view = render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next" }));
    await screen.findByText("26-50 of 51");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("51-51 of 51");
    count = 26;
    view.rerender(<OfficialUsageHistoryPanel revision={1} onSelect={vi.fn()} />);
    await screen.findByText("26-26 of 26");
    expect(api.history).toHaveBeenLastCalledWith({ limit: 25, offset: 25 }, expect.anything());
  });
});
