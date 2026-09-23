import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchJobSummary, WorkbenchJobsResponse } from "../api/client";
import { SyncHistoryTable } from "./SyncHistoryTable";

function job(index: number, overrides: Partial<WorkbenchJobSummary> = {}): WorkbenchJobSummary {
  return {
    id: `run-${index}`, source: "data-sync", label: `Sync ${index}`, target: "1 source",
    status: "completed", total: 1, completed: 1, partial: false,
    canResume: false, canCancel: false, canReconcile: false,
    startedAt: `2026-09-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
    completedAt: `2026-09-${String(index + 1).padStart(2, "0")}T10:01:05.000Z`,
    updatedAt: "2026-09-20T12:00:00.000Z",
    syncSources: ["users"], href: `/sync?syncRun=run-${index}`, ...overrides,
  };
}

function projection(value: WorkbenchJobSummary[]): WorkbenchJobsResponse {
  return { value, polledAt: "2026-09-20T12:00:00.000Z", requestId: "history-request", unavailableSources: [] };
}

describe("SyncHistoryTable", () => {
  it("separates runs, source jobs, report drafts, and investigations and keeps recovery out of rows", async () => {
    const onOpenSyncRun = vi.fn();
    render(<SyncHistoryTable state={projection([
      job(1, { status: "partial", canResume: true, canCancel: true }),
      job(2, { source: "package-refresh", label: "Old Graph refresh", href: "/sync?refreshJob=old-job" }),
      job(3, { source: "official-usage", label: "Report draft" }),
      job(4, { source: "purview", label: "Audit search" }),
    ])} error="" onRefresh={vi.fn()} onOpenSyncRun={onOpenSyncRun} />);
    const table = screen.getByRole("table", { name: "Sync run history" });
    expect(within(table).getByText("Users")).toBeVisible();
    expect(within(table).getByText("1m 5s")).toBeVisible();
    expect(screen.queryByText("Old Graph refresh")).not.toBeInTheDocument();
    expect(screen.queryByText("Report draft")).not.toBeInTheDocument();
    expect(screen.queryByText("Audit search")).not.toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: /Retry|Cancel|Resume/ })).not.toBeInTheDocument();
    await userEvent.click(within(table).getByRole("link", { name: /View details/ }));
    expect(onOpenSyncRun).toHaveBeenCalledExactlyOnceWith("run-1");
    await userEvent.click(screen.getByRole("button", { name: "Source jobs" }));
    expect(screen.getByRole("table", { name: "Source job history" })).toHaveTextContent("Old Graph refresh");
    expect(screen.queryByText("Report draft")).not.toBeInTheDocument();
  });

  it("sorts by original start, paginates the bounded history, and resets the page on outcome changes", async () => {
    render(<SyncHistoryTable state={projection(Array.from({ length: 13 }, (_, index) => job(index, {
      ...(index === 1 ? { updatedAt: "2026-09-30T10:00:00.000Z", status: "failed" } : {}),
    })))} error="" onRefresh={vi.fn()} />);
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(11);
    expect(rows[1]).toHaveTextContent("Sync 12");
    expect(screen.getByText(/1-10 of 13 recent records/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/11-13 of 13 recent records/)).toBeVisible();
    await userEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "Sort by Started" }));
    expect(screen.getByText(/1-10 of 13 recent records/)).toBeVisible();
    expect(within(screen.getByRole("table")).getAllByRole("row")[1]).toHaveTextContent("Sync 0");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Outcome" }), "incomplete");
    expect(screen.getByText(/1-1 of 1 recent records/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Previous" })).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("Sync 1");
  });

  it("does not invent durations for older metadata and surfaces partial history failures", async () => {
    const state = projection([job(1, { startedAt: undefined, completedAt: undefined, syncSources: undefined })]);
    state.unavailableSources = [{ source: "data-sync", code: "source_unavailable" }, { source: "defender", code: "source_unavailable" }];
    const onRefresh = vi.fn();
    render(<SyncHistoryTable state={state} error="History reload failed." onRefresh={onRefresh} />);
    expect(screen.getByText("Not recorded")).toBeVisible();
    expect(screen.getByText("Last update; start not recorded")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("History reload failed.");
    expect(screen.getByRole("status")).toHaveTextContent("History is temporarily unavailable for sync runs.");
    expect(screen.getByRole("status")).not.toHaveTextContent("defender");
    await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("does not present an unavailable history source as a successful empty history", () => {
    render(<SyncHistoryTable state={{
      ...projection([]), unavailableSources: [{ source: "data-sync", code: "source_unavailable" }],
    }} error="" onRefresh={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("History is temporarily unavailable");
    expect(screen.queryByText(/No retained sync runs yet/)).not.toBeInTheDocument();
  });

  it("sorts numeric source results rather than their localized count labels", async () => {
    render(<SyncHistoryTable state={projection([
      job(1, { source: "package-refresh", label: "Zero", status: "succeeded", completed: 0, total: 0 }),
      job(2, { source: "package-refresh", label: "Twenty", status: "succeeded", completed: 20, total: 20 }),
      job(3, { source: "power-platform", label: "Thousand", status: "succeeded", completed: 1_000, total: 1_000 }),
      job(4, { source: "power-platform", label: "Unknown", status: "failed", completed: null, total: null }),
    ])} error="" onRefresh={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Source jobs" }));
    const table = screen.getByRole("table", { name: "Source job history" });
    const labels = () => within(table).getAllByRole("row").slice(1).map(row => row.querySelector("strong")?.textContent);
    await userEvent.click(within(table).getByRole("button", { name: "Sort by Result" }));
    expect(labels()).toEqual(["Zero", "Twenty", "Thousand", "Unknown"]);
    await userEvent.click(within(table).getByRole("button", { name: "Sort by Result" }));
    expect(labels()).toEqual(["Thousand", "Twenty", "Zero", "Unknown"]);
  });

  it.each(["package-refresh", "power-platform"] as const)(
    "uses reported completed counts, not totals, to render and sort %s results", async source => {
      render(<SyncHistoryTable state={projection([
        job(1, { source, label: "Zero", status: "succeeded", completed: 0, total: null }),
        job(2, { source, label: "Seven", status: "succeeded", completed: 7, total: 100 }),
        job(3, { source, label: "Twenty", status: "succeeded", completed: 20, total: 20 }),
        job(4, { source, label: "Unknown", status: "succeeded", completed: null, total: 1 }),
      ])} error="" onRefresh={vi.fn()} />);
      await userEvent.click(screen.getByRole("button", { name: "Source jobs" }));
      const table = screen.getByRole("table", { name: "Source job history" });
      expect(screen.getByText("Zero").closest("tr")).toHaveTextContent("0 records saved");
      expect(screen.getByText("Seven").closest("tr")).toHaveTextContent("7 records saved");
      expect(screen.getByText("Twenty").closest("tr")).toHaveTextContent("20 records saved");
      expect(screen.getByText("Unknown").closest("tr")).toHaveTextContent("Count not reported");
      const labels = () => within(table).getAllByRole("row").slice(1).map(row => row.querySelector("strong")?.textContent);
      await userEvent.click(within(table).getByRole("button", { name: "Sort by Result" }));
      expect(labels()).toEqual(["Zero", "Seven", "Twenty", "Unknown"]);
      await userEvent.click(within(table).getByRole("button", { name: "Sort by Result" }));
      expect(labels()).toEqual(["Twenty", "Seven", "Zero", "Unknown"]);
    },
  );

  it("preserves known completed-source counts when the sync total is unknown", async () => {
    render(<SyncHistoryTable state={projection([
      job(1, { completed: 0, total: null }),
      job(2, { completed: 2, total: null }),
      job(3, { completed: null, total: 3 }),
    ])} error="" onRefresh={vi.fn()} />);
    expect(screen.getByText("Sync 1").closest("tr")).toHaveTextContent("0 sources complete");
    expect(screen.getByText("Sync 2").closest("tr")).toHaveTextContent("2 sources complete");
    expect(screen.getByText("Sync 3").closest("tr")).toHaveTextContent("Count not reported");
    const table = screen.getByRole("table");
    const labels = () => within(table).getAllByRole("row").slice(1).map(row => row.querySelector(".sync-history-scope small")?.textContent);
    await userEvent.click(within(table).getByRole("button", { name: "Sort by Result" }));
    expect(labels()).toEqual(["Sync 1", "Sync 2", "Sync 3"]);
    await userEvent.click(within(table).getByRole("button", { name: "Sort by Result" }));
    expect(labels()).toEqual(["Sync 2", "Sync 1", "Sync 3"]);
  });

  it("describes source history limits per Graph authorization mode", async () => {
    const values = Array.from({ length: 20 }, (_, index) => [
      job(index, { source: "package-refresh", tokenMode: "delegated" }),
      job(index, { id: `application-${index}`, source: "package-refresh", tokenMode: "application" }),
      job(index, { source: "power-platform" }),
    ]).flat();
    render(<SyncHistoryTable state={projection(values)} error="" onRefresh={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Source jobs" }));
    expect(screen.getByText(/1-10 of 60 recent records/)).toHaveTextContent(
      "Up to 20 recent Graph jobs per authorization mode and 20 Power Platform jobs.",
    );
  });

  it("distinguishes original run durations from the latest source-job attempt", async () => {
    render(<SyncHistoryTable state={projection([
      job(1),
      job(2, {
        source: "package-refresh", label: "Retried source job",
        createdAt: "2026-09-01T10:00:00.000Z",
      }),
    ])} error="" onRefresh={vi.fn()} />);
    expect(screen.getByRole("columnheader", { name: "Duration" })).toHaveAttribute(
      "title", "Time since the original start, including waits and retries",
    );
    await userEvent.click(screen.getByRole("button", { name: "Source jobs" }));
    expect(screen.getByRole("columnheader", { name: "Duration" })).toHaveAttribute(
      "title", "Time from the latest source-job attempt to completion",
    );
    expect(screen.getByText("Retried source job").closest("tr")).toHaveTextContent("1m 5s");
  });

  it("keeps partial successful statuses out of complete outcomes and never calls their counts saved", async () => {
    render(<SyncHistoryTable state={projection([
      job(1, { source: "package-refresh", label: "Partial refresh", status: "succeeded", partial: true, completed: 7, total: 10 }),
      job(2, { source: "package-refresh", label: "Complete refresh", status: "succeeded", completed: 0, total: 0 }),
    ])} error="" onRefresh={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Source jobs" }));
    const partial = screen.getByText("Partial refresh").closest("tr")!;
    expect(partial).toHaveTextContent("Complete with partial results");
    expect(partial.querySelector(".status-badge")).toHaveClass("status-partial");
    expect(partial).toHaveTextContent("7 reported so far");
    expect(partial).not.toHaveTextContent("10 records saved");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Outcome" }), "complete");
    expect(screen.getByRole("table")).toHaveTextContent("Complete refresh");
    expect(screen.queryByText("Partial refresh")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Outcome" }), "incomplete");
    expect(screen.getByRole("table")).toHaveTextContent("Partial refresh");
    expect(screen.queryByText("Complete refresh")).not.toBeInTheDocument();
  });

  it("keeps missing and backwards dates unknown and sorts equal dates deterministically", async () => {
    render(<SyncHistoryTable state={projection([
      job(2, { startedAt: "2026-09-10T10:00:00.000Z", completedAt: "2026-09-09T10:00:00.000Z" }),
      job(1, { startedAt: "2026-09-10T10:00:00.000Z", completedAt: "2026-09-10T10:01:00.000Z" }),
      job(0, { startedAt: undefined, updatedAt: "", completedAt: undefined, completed: null, total: null }),
    ])} error="" onRefresh={vi.fn()} />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Sync 1");
    expect(screen.getByText("Sync 2").closest("tr")).toHaveTextContent("Not recorded");
    expect(screen.getByText("Sync 0").closest("tr")).toHaveTextContent("Count not reported");
    expect(screen.getByText("Sync 0").closest("tr")).not.toHaveTextContent("0s");
    await userEvent.click(within(table).getByRole("button", { name: "Sort by Duration" }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Sync 1");
    await userEvent.click(within(table).getByRole("button", { name: "Sort by Duration" }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Sync 1");
  });
});
