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
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("does not compare invalid response count %s as activity", responses => {
    expect(snapshotChange(point(responses, "2026-10-04"), point(200))).toMatchObject({ comparable: false, label: "Usage not reported" });
    expect(snapshotChange(point(210, "2026-10-04"), point(responses))).toMatchObject({ comparable: false, label: "Previous report not reported" });
  });
  it.each([
    { reportingStart: null }, { reportingEnd: "invalid" }, { reportingEnd: "2026-09-31" }, { reportingStart: "2026-11-01" },
  ])("does not compare partial, invalid or backwards windows %j", dates => {
    expect(snapshotChange(point(210, "2026-10-04", dates), point(200)))
      .toMatchObject({ comparable: false, label: "Report dates unavailable" });
    expect(snapshotChange(point(210, "2026-10-04"), point(200, "2026-10-01", dates)))
      .toMatchObject({ comparable: false, label: "Previous report dates unavailable" });
  });
  it("does not classify a backwards comparison as increasing activity", () => {
    expect(snapshotChange(point(210), point(200, "2026-10-04")))
      .toMatchObject({ comparable: false, label: "Report dates out of order" });
  });
});

describe("usage trend chart", () => {
  it.each([NaN, Infinity, -1, 0.5])("keeps invalid count %s as a gap without poisoning the scale", responses => {
    const data = agentUsageHistoryFixture(context, "agent", [point(responses, "2026-10-04"), point(0)]);
    const view = render(<AgentUsageTrend data={data} onPage={vi.fn()} loading={false} />);
    const chart = screen.getByRole("img"), table = screen.getByRole("table");
    expect(chart.outerHTML).not.toMatch(/NaN|Infinity/);
    expect(view.container.querySelectorAll(".trend-dot")).toHaveLength(1);
    expect(view.container.querySelectorAll(".trend-missing")).toHaveLength(1);
    expect(view.container.querySelectorAll(".trend-line")).toHaveLength(0);
    expect(within(table).getByRole("cell", { name: "Unknown" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "0" })).toBeVisible();
    expect(screen.queryByText(/Increasing:|Decreasing:/)).not.toBeInTheDocument();
  });
  it.each([
    { reportingStart: null }, { reportingEnd: "invalid" }, { reportingEnd: "2026-09-31" }, { reportingStart: "2026-11-01" },
  ])("retains counts without plotting invalid dates %j", dates => {
    const data = agentUsageHistoryFixture(context, "agent", [point(20, "2026-10-04", dates), point(0)]);
    const view = render(<AgentUsageTrend data={data} onPage={vi.fn()} loading={false} />);
    expect(screen.getByRole("img").outerHTML).not.toMatch(/NaN|Infinity/);
    expect(view.container.querySelectorAll(".trend-dot")).toHaveLength(1);
    expect(view.container.querySelectorAll(".trend-line")).toHaveLength(0);
    expect(within(screen.getByRole("table")).getByRole("cell", { name: "20" })).toBeVisible();
    expect(screen.queryByText(/Increasing:|Decreasing:/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("table")).getAllByText(/Report dates unavailable|Dates not supplied/).length).toBeGreaterThan(0);
  });
  it("distinguishes no saved reports from saved reports with no usage for this agent", () => {
    const view = render(<AgentUsageTrend data={agentUsageHistoryFixture(context, "agent", [])}
      onPage={vi.fn()} loading={false} />);
    expect(screen.getByText("No CSV reports available. Import a complete CSV report in Sync to see usage.")).toBeVisible();
    expect(screen.queryByText("No usage reported in saved reports.")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    view.rerender(<AgentUsageTrend data={agentUsageHistoryFixture(context, "agent", [point(null)])}
      onPage={vi.fn()} loading={false} />);
    expect(screen.getByText("No usage reported in saved reports.")).toBeVisible();
    expect(within(screen.getByRole("table")).getByText("Not reported")).toBeVisible();
    expect(screen.queryByText(/Import a complete CSV report/)).not.toBeInTheDocument();
  });

  it("qualifies missing usage on an older page without contradicting the latest saved report", () => {
    const newest = point(200), older = point(null, "2026-09-27");
    const data = { ...agentUsageHistoryFixture(context, "agent", [newest, older]), value: [older],
      page: { limit: 50, nextCursor: null, previousCursor: "newer" } };
    render(<AgentUsageTrend data={data} onPage={vi.fn()} loading={false} />);
    expect(screen.getByText("Latest report shown: Usage not reported")).toBeVisible();
    expect(screen.queryByText("Latest report: Usage not reported")).not.toBeInTheDocument();
    expect(screen.getByText("No reported response counts in this page's dated reports.")).toBeVisible();
    expect(screen.queryByText("No usage reported in saved reports.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Newer reports" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Older reports" })).toBeDisabled();
  });

  it("keeps reported zero counts in the table when dates cannot support a chart", () => {
    const data = agentUsageHistoryFixture(context, "agent", [
      point(0, "2026-10-01", { reportingStart: null, reportingEnd: null, periodProvenance: "unknown" }),
    ]);
    render(<AgentUsageTrend data={data} onPage={vi.fn()} loading={false} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("No reported response counts in this page's dated reports.")).toBeVisible();
    expect(screen.queryByText("No usage reported in saved reports.")).not.toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByRole("cell", { name: "0" })).toBeVisible();
    expect(within(screen.getByRole("table")).getByText("Dates not supplied")).toBeVisible();
    expect(within(screen.getByRole("table")).getByText("Report dates unavailable")).toBeVisible();
  });

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
  it.each(["loading", "disabled"])("keeps history pagination and disables navigation while %s", state => {
    const onPage = vi.fn();
    const data = { ...agentUsageHistoryFixture(context, "agent", [point(200)]),
      page: { limit: 50, nextCursor: "older", previousCursor: "newer" } };
    const view = render(<AgentUsageTrend data={data} onPage={onPage} loading={state === "loading"} disabled={state === "disabled"} />);
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
