import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import type { ReactNode } from "react";
import type { WorkbenchJobSummary, WorkbenchJobsResponse } from "../api/client";
import { mockNativeDialogs } from "../test/dialog";
import { JobHistoryView } from "./JobHistoryView";
import { formatJobInstant } from "./jobPresentation";

mockNativeDialogs();
vi.mock("../workbenchActionContext", () => ({
  WorkbenchActionGate: ({ children }: { children: ReactNode }) => children,
}));

function job(index: number, overrides: Partial<WorkbenchJobSummary> = {}): WorkbenchJobSummary {
  return {
    id: `job-${index}`, source: "package-refresh", label: `Refresh ${index}`,
    target: "Current principal Graph package catalog", status: "succeeded",
    total: 12, completed: 12, partial: false, canResume: false, canCancel: false, canReconcile: false,
    createdAt: new Date(Date.UTC(2026, 8, index + 1, 10)).toISOString(),
    startedAt: new Date(Date.UTC(2026, 8, index + 1, 10)).toISOString(),
    completedAt: new Date(Date.UTC(2026, 8, index + 1, 10, 1, 5)).toISOString(),
    updatedAt: "2026-09-30T10:00:00.000Z", href: `/sync?refreshJob=job-${index}`, ...overrides,
  };
}

function projection(value: WorkbenchJobSummary[]): WorkbenchJobsResponse {
  return { value, polledAt: "2026-09-30T10:00:00.000Z", unavailableSources: [], requestId: "lookup-1" };
}

const props = { error: "", loading: false, busy: "", pollingPaused: false, onRefresh: vi.fn(), onAction: vi.fn() };

describe("Job history layout", () => {
  it("separates current work from stopped history and keeps recovery out of historical rows", async () => {
    const onAction = vi.fn();
    const state = projection([
      job(1, { status: "running", canCancel: true }),
      job(2, { source: "official-usage", status: "active", label: "Pending CSV", canCancel: true }),
      job(3, { source: "data-sync", status: "partial", partial: true, canResume: true, canCancel: true }),
      job(4, { status: "failed", completed: 12, total: 12 }),
      job(5, { source: "official-usage", status: "accepted", label: "Accepted CSV" }),
    ]);
    render(<JobHistoryView {...props} state={state} onAction={onAction} />);
    const current = screen.getByRole("table", { name: "Current jobs" });
    const history = screen.getByRole("table", { name: "Job history" });
    expect(within(current).getAllByRole("columnheader").map(header => header.textContent?.trim())).toEqual(["Job / scope", "Status", "Last updated", "Progress"]);
    expect(within(history).getAllByRole("columnheader").map(header => header.textContent?.trim())).toEqual(["Job / scope", "Outcome", "Created", "Result", "Duration"]);
    expect(within(current).getAllByRole("row")[1].querySelector("time")).toHaveTextContent(formatJobInstant(state.value[0].updatedAt));
    expect(current).toHaveTextContent("Refresh 1");
    expect(current).toHaveTextContent("Pending CSV");
    expect(current).not.toHaveTextContent("Refresh 3");
    expect(history).toHaveTextContent("Refresh 3");
    expect(history).toHaveTextContent("Refresh 4");
    expect(history).toHaveTextContent("Accepted CSV");
    expect(history).toHaveTextContent("12 of 12 packages observed");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry incomplete" })).not.toBeInTheDocument();
    expect(within(history).queryByText("job-3", { exact: true })).not.toBeInTheDocument();
    await userEvent.click(within(history).getByRole("button", { name: /View details for Refresh 3/ }));
    expect(onAction).not.toHaveBeenCalled();
    const details = within(screen.getByRole("dialog", { name: "Job details" }));
    expect(details.getByText("job-3", { exact: true })).toBeVisible();
    expect(details.getByRole("heading", { name: "Recovery actions" })).toBeVisible();
    await userEvent.click(details.getByRole("button", { name: "Retry incomplete" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith(state.value[2], "resume");
  });

  it("orders original dates, paginates history, and resets pagination on filters and sort", async () => {
    render(<JobHistoryView {...props} state={projection(Array.from({ length: 32 }, (_, index) => job(index, {
      status: index === 0 ? "failed" : "succeeded",
    })))} />);
    const table = screen.getByRole("table", { name: "Job history" });
    expect(within(table).getAllByRole("row")).toHaveLength(16);
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Refresh 31");
    expect(screen.getByText("1-15 of 32 recent history records")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Next history page" }));
    expect(screen.getByText("16-30 of 32 recent history records")).toBeVisible();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Filter history by outcome" }), "failed");
    expect(screen.getByText("1-1 of 1 recent history records")).toBeVisible();
    expect(table).toHaveTextContent("Refresh 0");
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await userEvent.click(within(table).getByRole("button", { name: "Sort by Created" }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Refresh 0");
    expect(within(table).getByRole("columnheader", { name: "Created" })).toHaveAttribute("aria-sort", "ascending");
    await userEvent.click(within(table).getByRole("button", { name: "Sort by Job / scope" }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Refresh 0");
    await userEvent.click(within(table).getByRole("button", { name: "Sort by Job / scope" }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Refresh 31");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search jobs" }), "job-29");
    expect(screen.getByText("1-1 of 1 recent history records")).toBeVisible();
    expect(table).toHaveTextContent("Refresh 29");
  });

  it("keeps outcome filters scoped to history and bounds large current queues separately", async () => {
    render(<JobHistoryView {...props} state={projection([
      ...Array.from({ length: 12 }, (_, index) => job(index, { status: "waiting_authorization" })),
      job(20, { status: "running" }), job(21, { status: "failed" }),
    ])} />);
    const current = screen.getByRole("table", { name: "Current jobs" });
    expect(within(current).getAllByRole("row")).toHaveLength(11);
    expect(within(current).getAllByRole("row")[1]).toHaveTextContent("Refresh 20");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Filter history by outcome" }), "complete");
    expect(screen.getByText("No recent history matches these filters.")).toBeVisible();
    expect(current).toHaveTextContent("Refresh 20");
    await userEvent.click(screen.getByRole("button", { name: "Next current jobs page" }));
    expect(screen.getByText("11-13 of 13 current jobs")).toBeVisible();
  });

  it("sorts result counts numerically across thousands separators with unknown values last", async () => {
    render(<JobHistoryView {...props} state={projection([
      job(1, { label: "Zero", completed: 0, total: 0 }),
      job(2, { label: "Twenty", completed: 20, total: 20 }),
      job(3, { label: "Thousand", source: "official-usage", status: "accepted", completed: null, total: 1_000 }),
      job(4, { label: "Unknown", completed: null, total: null }),
    ])} />);
    const table = screen.getByRole("table", { name: "Job history" });
    const labels = () => within(table).getAllByRole("row").slice(1)
      .map(row => within(row).getByRole("button").textContent);
    await userEvent.click(within(table).getByRole("button", { name: "Sort by Result" }));
    expect(labels()).toEqual(["Zero", "Twenty", "Thousand", "Unknown"]);
    await userEvent.click(within(table).getByRole("button", { name: "Sort by Result" }));
    expect(labels()).toEqual(["Thousand", "Twenty", "Zero", "Unknown"]);
  });

  it("renders prototype-named unknown statuses in history and details", async () => {
    render(<JobHistoryView {...props} state={projection([job(1, { status: "__proto__" })])} />);
    const history = screen.getByRole("table", { name: "Job history" });
    expect(within(history).getByText("proto")).toBeVisible();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Filter history by outcome" }), "other");
    await userEvent.click(within(history).getByRole("button", { name: /View details for Refresh 1/ }));
    expect(within(screen.getByRole("dialog")).getByText("proto")).toBeVisible();
  });

  it("does not present unavailable sources as an empty complete history", () => {
    render(<JobHistoryView {...props} state={{ ...projection([]), unavailableSources: [{ source: "defender", code: "source_unavailable" }] }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Defender");
    expect(screen.getByRole("status")).toHaveTextContent("may be incomplete");
    expect(screen.queryByText(/No retained jobs are visible/)).not.toBeInTheDocument();
    expect(screen.getByText(/No records were returned by the available sources/)).toBeVisible();
  });

  it("keeps zero and unknown results distinct and never invents a historical duration", async () => {
    render(<JobHistoryView {...props} state={projection([
      job(1, { source: "defender", status: "inconclusive", completed: 0, total: null, createdAt: undefined, startedAt: undefined, completedAt: undefined }),
      job(2, { completed: null, total: null, createdAt: undefined, completedAt: undefined }),
    ])} />);
    const history = screen.getByRole("table", { name: "Job history" });
    expect(history).toHaveTextContent("0 rows retained");
    expect(history).toHaveTextContent("Count not reported");
    expect(history).toHaveTextContent("Last update; original date not recorded");
    expect(history).toHaveTextContent("Start time; creation not recorded");
    expect(within(history).getAllByText("Not recorded")).toHaveLength(2);
    await userEvent.click(within(history).getByRole("button", { name: /View details for Refresh 1/ }));
    const details = within(screen.getByRole("dialog"));
    expect(details.getByText("Finished").nextElementSibling).toHaveTextContent("Not recorded");
    expect(details.getByText("Duration (including waits)").nextElementSibling).toHaveTextContent("Not recorded");
    expect(details.getByRole("link", { name: "Open investigation" })).toHaveAttribute("href", "/sync?refreshJob=job-1");
  });

  it("opens accepted report history rather than an actionable import dialog", async () => {
    render(<JobHistoryView {...props} state={projection([job(1, {
      source: "official-usage", status: "accepted", href: "/official-usage?view=history&snapshot=accepted-set",
      startedAt: undefined,
    })])} />);
    await userEvent.click(screen.getByRole("button", { name: /View details for Refresh 1/ }));
    const details = within(screen.getByRole("dialog"));
    expect(details.getByRole("link", { name: "View report history" })).toHaveAttribute("href", "/official-usage?view=history&snapshot=accepted-set");
    expect(details.queryByRole("button", { name: "Discard draft" })).not.toBeInTheDocument();
    expect(details.getByText(/one validated CSV file/)).toBeVisible();
    expect(details.getByText(/last 24 hours/)).toBeVisible();
  });

  it("has accessible read-only history and details without nested disclosures", async () => {
    const { container } = render(<main><JobHistoryView {...props} state={projection([job(1)])} /></main>);
    expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
    const trigger = screen.getByRole("button", { name: /View details for Refresh 1/ });
    await userEvent.click(trigger);
    expect(container.querySelector("details")).toBeNull();
    expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Close job details" }));
    expect(trigger).toHaveFocus();
  });

  it("keeps unknown durations and counts last in either direction and preserves chronological ties", async () => {
    render(<JobHistoryView {...props} state={projection([
      job(2, { createdAt: "2026-09-10T10:00:00.000Z", startedAt: undefined, completedAt: undefined, completed: null, total: null }),
      job(1, { createdAt: "2026-09-10T10:00:00.000Z", completedAt: "2026-08-01T10:00:00.000Z" }),
      job(0, { createdAt: "2026-09-10T10:00:00.000Z", completed: 0, total: 0 }),
    ])} />);
    const history = screen.getByRole("table", { name: "Job history" });
    expect(within(history).getAllByRole("row")[1]).toHaveTextContent("Refresh 0");
    for (const column of ["Duration", "Result"]) {
      await userEvent.click(within(history).getByRole("button", { name: `Sort by ${column}` }));
      expect(within(history).getAllByRole("row").at(-1)).toHaveTextContent("Refresh 2");
      await userEvent.click(within(history).getByRole("button", { name: `Sort by ${column}` }));
      expect(within(history).getAllByRole("row").at(-1)).toHaveTextContent("Refresh 2");
    }
    await userEvent.click(within(history).getByRole("button", { name: "Sort by Duration" }));
    await userEvent.click(within(history).getByRole("button", { name: "Sort by Duration" }));
    expect(within(history).getAllByRole("row")[1]).toHaveTextContent("Refresh 0");
    expect(screen.getByText("Refresh 1").closest("tr")).toHaveTextContent("Not recorded");
  });
});
