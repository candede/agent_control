import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdoptionHistoryPage } from "../../../backend/src/types/adoptionDashboard";
import { ApiError } from "../api/client";
import { adoptionSnapshot, reportPage, reportSelection } from "../test/reportDataFixture";
import { AdoptionDashboard } from "./AdoptionDashboard";

const first = adoptionSnapshot(1, { reportingStart: "2026-08-14", reportingEnd: "2026-09-12" });
const second = adoptionSnapshot(2, { reportingStart: "2026-09-09", reportingEnd: "2026-10-08", activeUsers: 344, activeAgents: 325 });
const latest = adoptionSnapshot(3, { reportingStart: "2026-09-27", reportingEnd: "2026-10-26", activeUsers: 306, activeAgents: 317,
  responses: 11616, userReportActiveUsers: 306, relationshipActiveUsers: 304, userReportResponses: 11642, relationshipResponses: 11616 });
const all = [latest, second, first];
const renderDashboard = (baselineId?: string) => render(<AdoptionDashboard revision={0} baselineId={baselineId} onBaselineChange={vi.fn()} />);
const usersCard = () => within(screen.getByRole("region", { name: "Active users" }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("adoption dashboard", () => {
  it("shows baseline, latest, recent direction, independent source totals, and inspect links", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(reportPage(all))));
    renderDashboard();
    expect(await screen.findByRole("region", { name: "Active users" })).toBeVisible();
    expect(usersCard().getByText("306")).toBeVisible();
    expect(usersCard().getByText("+6 (+2%)")).toBeVisible();
    expect(usersCard().getByText("-38 (-11%)")).toBeVisible();
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getByText(/observed activity dates are not verified reporting windows/i)).toBeVisible();
    expect(screen.getByText(/Users 306; Users & agents 304/)).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Inspect report" })[0]).toHaveAttribute("href", `/sync?reports=snapshot&snapshot=${latest.id}`);
    expect(screen.queryByText(/per week|per month|forecast:/i)).not.toBeInTheDocument();
  });

  it("changes the baseline locally without changing or fetching a selected shared report", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(reportPage(all)));
    vi.stubGlobal("fetch", fetcher);
    const onBaselineChange = vi.fn();
    const view = render(<AdoptionDashboard revision={0} onBaselineChange={onBaselineChange} />);
    const selector = await screen.findByRole("combobox", { name: "Compare latest with baseline" });
    fireEvent.change(selector, { target: { value: second.id } });
    expect(onBaselineChange).toHaveBeenCalledWith(second.id);
    view.rerender(<AdoptionDashboard revision={0} baselineId={second.id} onBaselineChange={onBaselineChange} />);
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
