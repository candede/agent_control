import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdoptionHistoryPage } from "../../../backend/src/types/adoptionDashboard";
import { ApiError } from "../api/client";
import { adoptionSnapshot, reportPage, reportSelection } from "../test/reportDataFixture";
import { deferred } from "../test/deferred";
import { AdoptionDashboard } from "./AdoptionDashboard";

vi.mock("./DashboardInsights", async original => ({
  ...await original<typeof import("./DashboardInsights")>(), DashboardInsights: () => null,
}));

const first = adoptionSnapshot(1, { reportingStart: "2026-08-14", reportingEnd: "2026-09-12" });
const second = adoptionSnapshot(2, { reportingStart: "2026-09-09", reportingEnd: "2026-10-08", activeUsers: 344, activeAgents: 325 });
const latest = adoptionSnapshot(3, { reportingStart: "2026-09-27", reportingEnd: "2026-10-26", activeUsers: 306, activeAgents: 317,
  responses: 11616, userReportActiveUsers: 306, relationshipActiveUsers: 304, userReportResponses: 11642, relationshipResponses: 11616 });
const all = [latest, second, first];
const renderDashboard = (baselineId?: string) => render(<AdoptionDashboard revision={0} baselineId={baselineId}
  onBaselineChange={vi.fn()} onCompanyChange={vi.fn()} />);
const usersCard = () => within(screen.getByRole("region", { name: "Active users" }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("adoption dashboard", () => {
  it.each([false, true])("shows only complete history when the first response arrives after expiry (complete=%s)", async complete => {
    vi.useFakeTimers();
    const selection = reportSelection(2, Date.now());
    selection.expiresAt = new Date(Date.now() + 1000).toISOString();
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(pending.promise);
    vi.stubGlobal("fetch", fetcher);
    renderDashboard();
    await act(() => vi.advanceTimersByTimeAsync(1001));
    await act(async () => {
      pending.resolve(Response.json(reportPage(complete ? all : [latest], {
        selection, counts: { total: 3, filtered: 3 },
        page: { limit: 100, nextCursor: complete ? null : "older", previousCursor: null },
      })));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    if (complete) {
      expect(usersCard().getByText("306")).toBeVisible();
      expect(screen.getByText(/Showing previously loaded saved data/)).toBeVisible();
    } else {
      expect(screen.queryByRole("region", { name: "Active users" })).not.toBeInTheDocument();
      expect(screen.getByText(/This selection expired/)).toBeVisible();
      expect(screen.queryByText(/Showing previously loaded saved data/)).not.toBeInTheDocument();
    }
    fetcher.mockResolvedValueOnce(Response.json(reportPage(all, { selection: reportSelection(3, Date.now()) })));
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(usersCard().getByText("306")).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new URL(fetcher.mock.calls[1][0], "http://localhost").searchParams.has("selectionId")).toBe(false);
    expect(screen.queryByRole("button", { name: "Restart selection" })).not.toBeInTheDocument();
  });

  it("keeps comparisons when a replacement history's final page arrives after expiry while offline", async () => {
    vi.useFakeTimers();
    const initial = reportPage(all, { selection: reportSelection(2, Date.now()) });
    initial.selection.expiresAt = new Date(Date.now() + 1000).toISOString();
    const pending = deferred<Response>(), older = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(initial))
      .mockReturnValueOnce(pending.promise).mockReturnValueOnce(older.promise);
    vi.stubGlobal("fetch", fetcher);
    renderDashboard();
    await act(() => vi.advanceTimersByTimeAsync(1));
    const card = screen.getByRole("region", { name: "Active users" });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    const selection = reportSelection(3, Date.now());
    selection.expiresAt = new Date(Date.now() + 1000).toISOString();
    await act(async () => {
      pending.resolve(Response.json(reportPage([latest], { selection, counts: { total: 3, filtered: 3 },
        page: { limit: 100, nextCursor: "older", previousCursor: null } })));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    fireEvent.offline(window);
    await act(() => vi.advanceTimersByTimeAsync(1001));
    await act(async () => {
      older.resolve(Response.json(reportPage([second, first], { selection, counts: { total: 3, filtered: 3 },
        page: { limit: 100, nextCursor: null, previousCursor: "newer" } })));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("region", { name: "Active users" })).toBe(card);
    expect(usersCard().getByText("+6 (+2%)")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockResolvedValueOnce(Response.json(reportPage([{ ...latest, activeUsers: 500 }, second, first], {
      selection: reportSelection(4, Date.now()),
    })));
    online.mockReturnValue(true);
    fireEvent.online(window);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("region", { name: "Active users" })).toBe(card);
    expect(usersCard().getByText("500")).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(new URL(fetcher.mock.calls[3][0], "http://localhost").searchParams.has("selectionId")).toBe(false);
  });

  it.each([false, true])("keeps complete comparisons mounted while an idle history selection renews (multiple pages=%s)", async multiplePages => {
    vi.useFakeTimers();
    const initial = reportPage(all, { selection: reportSelection(2, Date.now()) });
    initial.selection.expiresAt = new Date(Date.now() + 1000).toISOString();
    const pending = deferred<Response>(), older = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(initial)).mockReturnValueOnce(pending.promise).mockReturnValueOnce(older.promise);
    vi.stubGlobal("fetch", fetcher);
    renderDashboard();
    await act(() => vi.advanceTimersByTimeAsync(1));
    const card = screen.getByRole("region", { name: "Active users" });
    const baseline = screen.getByRole("combobox", { name: "Compare latest with baseline" });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("region", { name: "Active users" })).toBe(card);
    expect(screen.getByRole("combobox", { name: "Compare latest with baseline" })).toBe(baseline);
    expect(usersCard().getByText("306")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Restart selection" })).not.toBeInTheDocument();
    const selection = reportSelection(3, Date.now());
    await act(async () => {
      pending.resolve(Response.json(reportPage(multiplePages ? [latest] : all, { selection,
        counts: { total: 3, filtered: 3 },
        page: { limit: 100, nextCursor: multiplePages ? "older" : null, previousCursor: null } })));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("region", { name: "Active users" })).toBe(card);
    if (multiplePages) {
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(usersCard().getByText("+6 (+2%)")).toBeVisible();
      await act(async () => {
        older.resolve(Response.json(reportPage([second, first], { selection, counts: { total: 3, filtered: 3 },
          page: { limit: 100, nextCursor: null, previousCursor: "newer" } })));
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByRole("region", { name: "Active users" })).toBe(card);
      expect(usersCard().getByText("+6 (+2%)")).toBeVisible();
    }
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([401, 403, 409])("withdraws retained comparisons when history revalidation returns %s", async status => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(reportPage(all)))
      .mockResolvedValueOnce(Response.json({ code: status === 409 ? "selection_invalidated" : "access_denied", detail: "History unavailable." }, { status }));
    vi.stubGlobal("fetch", fetcher);
    renderDashboard();
    await screen.findByRole("region", { name: "Active users" });
    fireEvent.focus(window);
    await screen.findByRole("alert");
    expect(screen.queryByRole("region", { name: "Active users" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No saved usage reports yet" })).not.toBeInTheDocument();
  });

  it("shows baseline, latest, recent direction, independent source totals, and inspect links", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(reportPage(all))));
    renderDashboard();
    expect(await screen.findByRole("region", { name: "Active users" })).toBeVisible();
    expect(usersCard().getByText("306")).toBeVisible();
    expect(usersCard().getByText("+6 (+2%)")).toBeVisible();
    expect(usersCard().getByText("-38 (-11%)")).toBeVisible();
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.queryByText(/Snapshot comparison: observed activity dates/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Users 306; Users & agents 304/)).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Inspect report" })[0]).toHaveAttribute("href", `/sync?reports=snapshot&snapshot=${latest.id}`);
    expect(screen.queryByText(/per week|per month|forecast:/i)).not.toBeInTheDocument();
  });

  it("changes the baseline locally without changing or fetching a selected shared report", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(reportPage(all)));
    vi.stubGlobal("fetch", fetcher);
    const onBaselineChange = vi.fn();
    const view = render(<AdoptionDashboard revision={0} onBaselineChange={onBaselineChange} onCompanyChange={vi.fn()} />);
    const selector = await screen.findByRole("combobox", { name: "Compare latest with baseline" });
    fireEvent.change(selector, { target: { value: second.id } });
    expect(onBaselineChange).toHaveBeenCalledWith(second.id);
    view.rerender(<AdoptionDashboard revision={0} baselineId={second.id} onBaselineChange={onBaselineChange} onCompanyChange={vi.fn()} />);
    expect(usersCard().getAllByText("-38 (-11%)")).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("link", { name: "Inspect report" })).toHaveLength(2);
  });

  it("collects every cursor page before presenting a baseline or direction", async () => {
    let finish: (value: Response) => void = () => {};
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const selection = reportSelection();
    const fetcher = vi.fn((input: string) => new URL(input, "http://localhost").searchParams.has("cursor") ? pending
      : Promise.resolve(Response.json(reportPage([latest], { counts: { total: 3, filtered: 3 }, selection,
        page: { limit: 100, nextCursor: "older", previousCursor: null } }))));
    vi.stubGlobal("fetch", fetcher);
    renderDashboard();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const query = new URL(fetcher.mock.calls[1][0], "http://localhost").searchParams;
    expect(query.get("selectionId")).toBe(selection.id);
    expect(query.get("cursor")).toBe("older");
    expect(screen.queryByRole("region", { name: "Active users" })).not.toBeInTheDocument();
    finish(Response.json(reportPage([second, first], { counts: { total: 3, filtered: 3 }, selection,
      page: { limit: 100, nextCursor: null, previousCursor: "newer" } })));
    await screen.findByRole("region", { name: "Active users" });
    expect(usersCard().getByText("+6 (+2%)")).toBeVisible();
    expect(screen.getByText("3 saved report snapshots")).toBeVisible();
  });

  it("does not truncate a year of history at the page-size boundary", async () => {
    const snapshots = Array.from({ length: 101 }, (_, index) => {
      const end = new Date(Date.UTC(2025, 0, 1 + index * 7)).toISOString().slice(0, 10);
      return adoptionSnapshot(index + 1, { reportingStart: end, reportingEnd: end, activeUsers: index + 100 });
    }).reverse();
    const fetcher = vi.fn((input: string) => {
      const older = new URL(input, "http://localhost").searchParams.has("cursor");
      return Promise.resolve(Response.json(reportPage(older ? snapshots.slice(100) : snapshots.slice(0, 100), {
        counts: { total: 101, filtered: 101 },
        page: { limit: 100, nextCursor: older ? null : "older", previousCursor: older ? "newer" : null },
      })));
    });
    vi.stubGlobal("fetch", fetcher);
    renderDashboard();
    await screen.findByRole("region", { name: "Active users" });
    expect(usersCard().getByText("200")).toBeVisible();
    expect(usersCard().getByText("+100 (+100%)")).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Inspect report" })).toHaveLength(101);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("offers a saved-only retry and never presents partial history as a complete trend", async () => {
    let failed = true;
    const fetcher = vi.fn((input: string) => {
      if (!new URL(input, "http://localhost").searchParams.has("cursor")) return Promise.resolve(Response.json(reportPage([latest], {
        counts: { total: 3, filtered: 3 }, page: { limit: 100, nextCursor: "older", previousCursor: null },
      })));
      return failed ? Promise.resolve(Response.json({ code: "temporarily_unavailable", detail: "Saved history could not be read." }, { status: 503 }))
        : Promise.resolve(Response.json(reportPage([second, first], { counts: { total: 3, filtered: 3 },
          page: { limit: 100, nextCursor: null, previousCursor: "newer" } })));
    });
    vi.stubGlobal("fetch", fetcher);
    renderDashboard();
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved history could not be read.");
    expect(screen.queryByRole("region", { name: "Active users" })).not.toBeInTheDocument();
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    await screen.findByRole("region", { name: "Active users" });
    expect(usersCard().getByText("+6 (+2%)")).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("withdraws invalidated history and permits a fresh capture", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ code: "selection_invalidated", detail: "Report deleted." }, { status: 409 }))
      .mockResolvedValueOnce(Response.json(reportPage(all)));
    vi.stubGlobal("fetch", fetcher);
    renderDashboard();
    expect(await screen.findByRole("alert")).toHaveTextContent("This selection changed or expired.");
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    await screen.findByRole("region", { name: "Active users" });
    expect(new URL(fetcher.mock.calls[1][0], "http://localhost").searchParams.has("selectionId")).toBe(false);
  });

  it("shows an empty state without requiring inventory, licensing, or provider permissions", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(reportPage([])));
    vi.stubGlobal("fetch", fetcher);
    renderDashboard();
    expect(await screen.findByRole("heading", { name: "No saved usage reports yet" })).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText("0", { exact: true })).not.toBeInTheDocument();
    expect(fetcher.mock.calls.every(([input]) => new URL(input, "http://localhost").pathname === "/api/official-usage/history/adoption")).toBe(true);
  });

  it("keeps undated counts visible without making them the latest usage observation", async () => {
    const undated = adoptionSnapshot(4, { reportingStart: null, reportingEnd: null, activeUsers: 99999 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(reportPage([undated, ...all]))));
    renderDashboard();
    await screen.findByRole("region", { name: "Active users" });
    expect(usersCard().getByText("306")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Reports without activity dates" })).toBeVisible();
    expect(screen.getByText("99,999")).toBeVisible();
  });

  it("keeps undated-only history readable without inferring chronology from imports", async () => {
    const snapshots = [
      adoptionSnapshot(4, { reportingStart: null, reportingEnd: null, activeUsers: 99999 }),
      adoptionSnapshot(5, { reportingStart: null, reportingEnd: null, activeUsers: 88888 }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(reportPage(snapshots))));
    renderDashboard();
    const table = within(await screen.findByRole("region", { name: "Reports without activity dates" }));
    expect(table.getByText("99,999")).toBeVisible();
    expect(table.getByText("88,888")).toBeVisible();
    expect(table.getAllByRole("link", { name: "Inspect report" })).toHaveLength(2);
    expect(screen.getByText("No dated observations")).toBeVisible();
    expect(screen.getByText(/Import order is not usage chronology/)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Active users" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it.each([
    { reportingStart: "2026-09-01", reportingEnd: "2026-09-31" },
    { reportingStart: "2026-11-02", reportingEnd: "2026-11-01" },
  ])("excludes invalid activity ranges %j from the latest observation", async dates => {
    const invalid = adoptionSnapshot(4, { ...dates, activeUsers: 99999 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(reportPage([invalid, ...all]))));
    renderDashboard();
    await screen.findByRole("region", { name: "Active users" });
    expect(usersCard().getByText("306")).toBeVisible();
    expect(usersCard().getByText("+6 (+2%)")).toBeVisible();
    const undated = within(screen.getByRole("region", { name: "Reports without activity dates" }));
    expect(undated.getByText("99,999")).toBeVisible();
    expect(undated.getByRole("link", { name: "Inspect report" })).toHaveAttribute("href", `/sync?reports=snapshot&snapshot=${invalid.id}`);
  });

  it("plots measured zero but neither plots nor bridges an unavailable count", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(reportPage([
      { ...latest, activeUsers: 0 }, { ...second, activeUsers: NaN }, first,
    ]))));
    renderDashboard();
    await screen.findByRole("region", { name: "Active users" });
    expect(usersCard().getByText("0")).toBeVisible();
    expect(usersCard().getByText("-300 (-100%)")).toBeVisible();
    expect(usersCard().getByText("Count unavailable")).toBeVisible();
    const chart = screen.getByRole("img", { name: "Active users over saved reports" });
    const points = chart.querySelectorAll("circle.dashboard-trend-point");
    expect(points).toHaveLength(2);
    expect(points[1]).toHaveAttribute("cy", "154");
    expect(chart.querySelectorAll("line.dashboard-trend-line")).toHaveLength(0);
  });

  it("withdraws completed comparisons when focus revalidation fails and recovers on saved-only retry", async () => {
    let failed = false;
    const fetcher = vi.fn(() => Promise.resolve(failed
      ? Response.json({ code: "temporarily_unavailable", detail: "Saved history could not be refreshed." }, { status: 503 })
      : Response.json(reportPage(all))));
    vi.stubGlobal("fetch", fetcher);
    renderDashboard();
    await screen.findByRole("region", { name: "Active users" });
    failed = true;
    fireEvent.focus(window);
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved history could not be refreshed.");
    expect(screen.queryByRole("region", { name: "Active users" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No saved usage reports yet" })).not.toBeInTheDocument();
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    await screen.findByRole("region", { name: "Active users" });
    expect(usersCard().getByText("+6 (+2%)")).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("shows only a baseline, not a directional conclusion, for one dated report", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(reportPage([latest]))));
    renderDashboard();
    await screen.findByRole("region", { name: "Active users" });
    expect(usersCard().getAllByText("No earlier report")).toHaveLength(2);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getAllByText(/One observation is not a trend/)).toHaveLength(2);
  });

  it("surfaces stale bookmarks instead of silently switching the baseline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(reportPage(all))));
    renderDashboard("10000000-0000-4000-8000-999999999999");
    expect(await screen.findByText(/bookmarked baseline is not available/)).toBeVisible();
    expect(usersCard().getByText("+6 (+2%)")).toBeVisible();
  });

  it("rejects inconsistent paginated results rather than showing success-shaped counts", async () => {
    const bad: AdoptionHistoryPage = reportPage([latest], { counts: { total: 3, filtered: 3 } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(bad)));
    renderDashboard();
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved report history is inconsistent.");
    expect(screen.queryByRole("region", { name: "Active users" })).not.toBeInTheDocument();
  });

  it("does not turn a network failure into a zero-adoption result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new ApiError(0, "network_error", "Network unavailable.", { kind: "network" })));
    renderDashboard();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Network/);
    expect(screen.queryByRole("heading", { name: "No saved usage reports yet" })).not.toBeInTheDocument();
  });
});
