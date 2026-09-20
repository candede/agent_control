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
    expect(within(table).queryByRole("button")).not.toBeInTheDocument();
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
});
