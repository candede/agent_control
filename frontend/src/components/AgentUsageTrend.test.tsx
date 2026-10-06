import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentUsageHistoryPoint } from "../../../backend/src/types/officialReportApi";
import { snapshotChange } from "../agentUsageTrends";
import { agentUsageHistoryFixture } from "../test/automaticAgentUsageFixture";
import { reports, selectionId } from "../test/reportDataFixture";
import { AgentUsageTrend } from "./AgentUsageTrend";

const context = { selectionId, reportSetId: reports.setId, usageRevision: "a", inventoryRevision: "b", reports };
function point(responses: number | null, end = "2026-10-01", overrides: Partial<AgentUsageHistoryPoint> = {}): AgentUsageHistoryPoint {
  return { setId: `report-${end}`, reportingStart: "2026-09-01", reportingEnd: end, periodProvenance: "activity_range",
    acceptedAt: `${end}T12:00:00Z`, responses, lastActivityDateUtc: null,
    associationCount: responses === null ? 0 : 1, status: responses === null ? "unlinked" : "linked", ...overrides };
}
afterEach(cleanup);

describe("reported snapshot comparisons", () => {
  it("compares overlapping observed ranges without requiring proven coverage or adding totals", () => {
    expect(snapshotChange(point(210, "2026-10-04", { reportingStart: "2026-09-05" }), point(200)))
      .toMatchObject({ difference: 10, percentage: 5, label: "+10 responses (+5%)", comparable: true });
    expect(snapshotChange(point(195, "2026-10-08"), point(210, "2026-10-04")))
      .toMatchObject({ difference: -15, label: "-15 responses (-7.1%)" });
  });
  it("distinguishes zero baselines, no change, and missing reports", () => {
    expect(snapshotChange(point(10, "2026-10-04"), point(0))).toMatchObject({ label: "New activity (+10 responses)", difference: 10 });
    expect(snapshotChange(point(10, "2026-10-04"), point(0)).percentage).toBeUndefined();
    expect(snapshotChange(point(0, "2026-10-04"), point(0))).toMatchObject({ label: "No change", percentage: 0 });
    expect(snapshotChange(point(0, "2026-10-04"), point(200))).toMatchObject({ percentage: -100 });
    expect(snapshotChange(point(null, "2026-10-04"), point(200)).comparable).toBe(false);
    expect(snapshotChange(point(210, "2026-10-04"), point(null)).comparable).toBe(false);
  });
  it("does not suggest growth for different known windows, identical end dates or unknown dates", () => {
    expect(snapshotChange(point(210, "2026-10-04", { periodProvenance: "operator_asserted", reportingStart: "2026-09-05" }),
      point(200, "2026-10-01", { periodProvenance: "operator_asserted", reportingStart: "2026-09-25" })))
      .toMatchObject({ comparable: false, label: "Different reporting windows" });
    expect(snapshotChange(point(210), point(200)).label).toBe("Same report end date");
    expect(snapshotChange(point(210, "2026-10-04", { reportingEnd: null }), point(200)).comparable).toBe(false);
  });
});

describe("usage trend chart", () => {
  it("renders read-only chronological comparisons without selectable dates, points or viewing markers", () => {
    const points = [point(230, "2026-10-12"), point(195, "2026-10-08"), point(210, "2026-10-04"), point(200)];
    const data = agentUsageHistoryFixture(context, "agent", points);
    const view = render(<AgentUsageTrend data={data} sharedSetId={points[0].setId}
      onPage={vi.fn()} loading={false} />);
    expect(screen.getByText("Increasing: +35 responses (+17.9%)")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Report snapshots and changes (4)" })).toBeVisible();
    expect(view.container.querySelector("details")).toBeNull();
    const table = screen.getByRole("table");
    expect(table).toBeVisible();
    expect(within(table).getAllByRole("columnheader").map(header => header.textContent)).toEqual(["Report dates", "Responses", "Change"]);
    const rows = within(table).getAllByRole("row").slice(1);
    rows.forEach((row, index) => expect(within(row).getAllByRole("cell")[0]).toHaveAccessibleName(["200", "210", "195", "230"][index]));
    expect(within(table).getByText("-15 responses (-7.1%)")).toBeVisible();
    expect(view.container.querySelectorAll(".trend-line")).toHaveLength(3);
    expect(screen.queryByText("835")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Reported responses by report end date" })).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText("Viewing")).not.toBeInTheDocument();
    expect(screen.queryByText(/Select a report date/)).not.toBeInTheDocument();
    expect(view.container.querySelector("[tabindex], [aria-pressed], [data-selected]")).toBeNull();
    expect(within(table).getByText("Sep 1, 2026 to Oct 1, 2026")).toBeVisible();
  });
  it("leaves missing usage as a gap and keeps zero points on the graph", () => {
    const data = agentUsageHistoryFixture(context, "agent", [point(210, "2026-10-08"), point(null, "2026-10-04"), point(0)]);
    const view = render(<AgentUsageTrend data={data} onPage={vi.fn()} loading={false} />);
    expect(screen.getByRole("heading", { name: "Report snapshots and changes (3)" })).toBeVisible();
    expect(view.container.querySelectorAll(".trend-line")).toHaveLength(0);
    expect(view.container.querySelectorAll(".trend-dot")).toHaveLength(2);
    expect(view.container.querySelectorAll(".trend-missing")).toHaveLength(1);
    expect(within(screen.getByRole("table")).getByText("Not reported")).toBeVisible();
    expect(screen.queryByText(/Increasing:/)).not.toBeInTheDocument();
  });
  it("keeps history pagination and disables navigation while revalidating", () => {
    const onPage = vi.fn();
    const data = { ...agentUsageHistoryFixture(context, "agent", [point(200)]),
      page: { limit: 50, nextCursor: "older", previousCursor: "newer" } };
    const view = render(<AgentUsageTrend data={data} onPage={onPage} loading />);
    expect(screen.getByRole("button", { name: "Older reports" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Newer reports" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Older reports" }));
    expect(onPage).not.toHaveBeenCalled();
    view.rerender(<AgentUsageTrend data={data} onPage={onPage} loading={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Older reports" }));
    expect(onPage).toHaveBeenLastCalledWith("older");
    fireEvent.click(screen.getByRole("button", { name: "Newer reports" }));
    expect(onPage).toHaveBeenLastCalledWith("newer");
  });
});
