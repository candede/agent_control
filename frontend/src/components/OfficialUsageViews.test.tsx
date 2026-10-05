import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportAgent, ReportPage } from "../../../backend/src/types/officialReportData";
import * as api from "../api/reportData";
import { ApiError } from "../api/client";
import { reportAgent, reportPage, reports, reportSetId, selectionId } from "../test/reportDataFixture";
import { deferred } from "../test/deferred";
import { ReportingView } from "./ReportingView";

vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(),
  readReportPage: vi.fn(), readReportFacet: vi.fn(), readReportDetail: vi.fn(),
  createReportExport: vi.fn(), reportExportStatus: vi.fn(), cancelReportExport: vi.fn(),
}));
const first = reportAgent(1, { agentName: "Researcher", responses: 270, reportResponses: 270, bridgeResponses: 269, responseComparison: "mismatch" });
function page(overrides: Partial<ReportPage<ReportAgent>> = {}) {
  return reportPage([first, reportAgent(2, { agentName: "Helpdesk" })], overrides);
}
beforeEach(() => {
  vi.mocked(api.readReportPage).mockResolvedValue(page());
  vi.mocked(api.readReportFacet).mockResolvedValue({ value: [{ value: "Your org", count: 40000 }], selection: page().selection,
    counts: { total: 500, filtered: 500 }, page: { limit: 50, nextCursor: "creator-next", previousCursor: null } });
  vi.mocked(api.readReportDetail).mockResolvedValue({ value: first, reports, sources: page().sources, selection: page().selection });
  vi.mocked(api.cancelReportExport).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("focused selected official agent reporting", () => {
  it("retains a keyboard-scrollable exact-identity relationship table and server counts", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/users") ? reportPage([{
      id: "relationship-1", agentId: "agent-1", agentName: "Researcher", creatorType: "Your org",
      username: "exact@example.invalid", responses: 12, lastActivityDateUtc: "2026-01-31", identityStatus: "unresolved",
    }], { counts: { total: 10000, filtered: 5000 } }) : page());
    render(<ReportingView />);
    fireEvent.click(await screen.findByRole("button", { name: "Researcher" }));
    const users = screen.getByRole("region", { name: "Agent users" });
    const table = within(users).getByRole("region", { name: "Reported agent users" });
    expect(table).toHaveAttribute("tabindex", "0");
    expect(table).toHaveClass("copilot-users-table-shell");
    expect(await within(table).findByRole("rowheader", { name: "exact@example.invalid" })).toHaveAttribute("scope", "row");
    expect(within(users).getByRole("navigation", { name: "relationships pages" })).toHaveTextContent("5,000 matching relationships; 1 on this page");
  });
  it("rejects a different exact agent identity and explicitly restarts its parent selection without fetching child rows", async () => {
    vi.mocked(api.readReportDetail).mockResolvedValue({ value: reportAgent(99), reports, sources: page().sources, selection: page().selection });
    render(<ReportingView />);
    fireEvent.click(await screen.findByRole("button", { name: "Researcher" }));
    const detail = screen.getByRole("region", { name: "Exact reported agent details" });
    expect(await within(detail).findByRole("alert")).toHaveTextContent("Exact agent evidence does not match");
    expect(vi.mocked(api.readReportPage).mock.calls.some(call => call[0].endsWith("/users"))).toBe(false);
    fireEvent.click(within(detail).getByRole("button", { name: "Restart selection" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.selectionId).toBeUndefined();
  });
  it("preserves exact tenant totals separately from filtered totals and never derives either from this page", async () => {
    render(<ReportingView />);
    await screen.findByRole("button", { name: "Researcher" });
    const totals = screen.getByRole("region", { name: "Snapshot tenant totals" });
    expect(totals).toHaveTextContent("1,000,000");
    expect(totals).toHaveTextContent("80,000");
    expect(screen.getByText("Reported agents").parentElement).toHaveTextContent("100,000");
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "agents pages" })).toHaveTextContent("50,000 matching agents; 2 on this page");
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });

  it("keeps stale evidence, observed-date limitations, discrepancy and technical provenance visible without claiming freshness", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(page({ reports: { ...reports, availability: "stale",
      reportingPeriod: { startDate: "2026-01-01", endDate: "2026-01-31", days: 31, provenance: "activity_range" } } }));
    render(<ReportingView />);
    await screen.findByRole("button", { name: "Researcher" });
    expect(screen.getByText(/Reports are out of date/)).toBeVisible();
    expect(screen.getByText(/Observed dates are last-activity dates/)).toBeVisible();
    expect(screen.getByText(/Users\/bridge reconciliation: mismatch/)).toBeVisible();
    fireEvent.click(screen.getByText("Report sources"));
    const provenance = screen.getByRole("region", { name: "Report provenance" });
    expect(provenance).toHaveTextContent("source as of Jan 31, 2026");
    expect(provenance).toHaveTextContent("Import time does not establish source freshness");
    expect(provenance).toHaveTextContent("Activity dates do not prove continuous coverage");
  });

  it("loads only the chosen exact agent plus a separate bounded relationship page and preserves overlapping license categories", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/users") ? reportPage([]) : page());
    render(<ReportingView />);
    expect(api.readReportDetail).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Researcher" }));
    const detail = screen.getByRole("region", { name: "Exact reported agent details" });
    await within(detail).findByText(/Exact report identity: agent-1/);
    expect(detail).toHaveTextContent("Licensed occurrences: 4");
    expect(detail).toHaveTextContent("Unlicensed occurrences: 7");
    expect(detail).toHaveTextContent("can overlap and are never added");
    expect(api.readReportDetail).toHaveBeenCalledWith("official-usage/agents/agent-1", selectionId, expect.any(AbortSignal));
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/agents/agent-1/users",
      expect.objectContaining({ selectionId, limit: 50 }), expect.any(AbortSignal)));
    vi.mocked(api.readReportDetail).mockResolvedValue({ value: reportAgent(2, { agentName: "Helpdesk" }), reports, sources: page().sources, selection: page().selection });
    fireEvent.click(screen.getByRole("button", { name: "Helpdesk" }));
    const next = screen.getByRole("region", { name: "Exact reported agent details" });
    await within(next).findByRole("heading", { name: "Helpdesk" });
    expect(within(next).queryByText(/Exact report identity: agent-1/)).not.toBeInTheDocument();
  });

  it("labels bridge-only totals, unknown reach and true zero independently", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(page({ value: [reportAgent(1, { agentName: "Bridge only", responseSource: "userAgents",
      responses: 0, activeUsers: null, reportResponses: null, bridgeResponses: 0, lastActivityDateUtc: null })] }));
    render(<ReportingView />);
    const row = await screen.findByRole("row", { name: /Bridge only/ });
    expect(within(row).getByText("Users & agents only")).toBeVisible();
    expect(within(row).getByText("0", { selector: "td" })).toBeVisible();
    expect(within(row).getByText("Unknown", { selector: "td" })).toBeVisible();
    expect(within(row).getByText("Not reported")).toBeVisible();
  });

  it.each((["responses", "activeUsers", "lastActivity", "name"] as const).flatMap(sort =>
    (["asc", "desc"] as const).map(order => ({ sort, order }))))("applies server $sort $order without local reordering", async ({ sort, order }) => {
    render(<ReportingView />);
    await screen.findByRole("button", { name: "Researcher" });
    fireEvent.change(screen.getByLabelText("Sort agents"), { target: { value: `${sort}:${order}` } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/aggregate",
      expect.objectContaining({ sort, order, limit: 50 }), expect.any(AbortSignal)));
    await screen.findByRole("button", { name: "Researcher" });
    expect(screen.getAllByRole("row").slice(1).map(row => within(row).getAllByRole("cell")[0].textContent))
      .toEqual(["Researcheragent-1", "Helpdeskagent-2"]);
  });

  it.each([false, true])("keeps mounted sort controls and preserves the user's focus choice during slow requests; moved=%s", async moved => {
    const pending = deferred<ReportPage<ReportAgent>>();
    render(<ReportingView />);
    await screen.findByRole("button", { name: "Researcher" });
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const sort = screen.getByRole("button", { name: "Responses" });
    sort.focus(); await userEvent.keyboard("{Enter}");
    expect(sort).toBeInTheDocument();
    expect(sort.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search agents" });
    if (moved) search.focus();
    await act(async () => pending.resolve(page()));
    await screen.findByRole("button", { name: "Researcher" });
    expect(screen.getByRole("button", { name: "Responses" })).toBe(sort);
    expect(moved ? search : sort).toHaveFocus();
  });

  it("uses cursor presence on byte-short pages, withholds old rows during navigation, and preserves pinned snapshot totals", async () => {
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page({ value: [first], page: { limit: 50, nextCursor: "agent-next", previousCursor: null } }));
    render(<ReportingView />);
    await screen.findByRole("button", { name: "Researcher" });
    const pending = deferred<ReportPage<ReportAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Next agents" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/aggregate",
      expect.objectContaining({ selectionId, cursor: "agent-next" }), expect.any(AbortSignal)));
    expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("1,000,000");
    await act(async () => pending.resolve(page({ value: [], page: { limit: 50, nextCursor: null, previousCursor: "agent-previous" } })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous agents" })).toBeEnabled());
    expect(screen.getByRole("searchbox", { name: "Search agents" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous agents" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/aggregate",
      expect.objectContaining({ cursor: "agent-previous", selectionId }), expect.any(AbortSignal)));
  });

  it.each([true, false])("distinguishes known empty data from missing report evidence; known=%s", async known => {
    vi.mocked(api.readReportPage).mockResolvedValue(page({ value: [], counts: { total: 0, filtered: 0 },
      reports: known ? reports : { ...reports, setId: null, activeSetId: null, lineages: [], availability: "never_imported" } }));
    render(<ReportingView />);
    expect(await screen.findByRole("heading", { name: known ? "No reported agents" : "Reports not imported" })).toBeVisible();
    if (!known) {
      expect(screen.getByText("Missing reports are not zero activity.")).toBeVisible();
      expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
    }
  });

  it("explains last-activity filters, rejects reversed dates without requesting or exporting them, and clears filters", async () => {
    render(<ReportingView />);
    await screen.findByRole("button", { name: "Researcher" });
    expect(screen.getByText(/Responses remain full-snapshot totals/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Activity start date"), { target: { value: "2026-02-01" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText("Activity end date"), { target: { value: "2026-01-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("start date must be on or before the end date");
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("region", { name: "Reported agent activity" })).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByText("Loading saved data...")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await screen.findByRole("button", { name: "Researcher" });
    expect(screen.getByLabelText("Activity start date")).toHaveValue("");
  });

  it("keeps tenant summary distinct while server search, creator and date filters update", async () => {
    render(<ReportingView setId={reportSetId} />);
    await screen.findByRole("button", { name: "Researcher" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents" }), { target: { value: "not on this page" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/aggregate",
      expect.objectContaining({ search: "not on this page", setId: reportSetId }), expect.any(AbortSignal)));
    await screen.findByRole("button", { name: "Researcher" });
    expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("80,000");
    const creator = screen.getByRole("group", { name: "Creator type" });
    await within(creator).findByRole("option", { name: "Your org (40,000)" });
    fireEvent.change(within(creator).getByRole("combobox"), { target: { value: "~string:Your org" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/aggregate",
      expect.objectContaining({ creatorType: "Your org", search: "not on this page" }), expect.any(AbortSignal)));
  });

  it.each([401, 403, 503])("hides failed evidence and exact details on status %s, offering a real read retry", async status => {
    vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/users") ? reportPage([]) : page());
    render(<ReportingView />);
    fireEvent.click(await screen.findByRole("button", { name: "Researcher" }));
    await screen.findByText(/Exact report identity: agent-1/);
    vi.mocked(api.readReportPage).mockRejectedValue(new ApiError(status, "read_failed", "Read denied"));
    fireEvent.focus(window);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
    expect(screen.queryByText("Loading saved data...")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
    vi.mocked(api.readReportPage).mockResolvedValue(page());
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    await screen.findByRole("button", { name: "Researcher" });
    expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
  });

  it("closes details immediately across historical A-B-A selections and aborts stale requests", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/users") ? reportPage([]) : page());
    const view = render(<ReportingView setId={reportSetId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Researcher" }));
    await screen.findByText(/Exact report identity: agent-1/);
    vi.mocked(api.readReportPage).mockReturnValue(new Promise(() => {}));
    view.rerender(<ReportingView setId="10000000-0000-4000-8000-000000000008" />);
    expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.setId).toContain("000000000008"));
    const stale = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    vi.mocked(api.readReportPage).mockResolvedValue(page());
    view.rerender(<ReportingView setId={reportSetId} />);
    await screen.findByRole("button", { name: "Researcher" });
    expect(stale?.aborted).toBe(true);
    expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
  });
});

describe("selected agent durable CSV boundaries", () => {
  const queued = { id: "queued-agents", status: "queued" as const, rows: 0, bytes: 0,
    expiresAt: "2030-01-01T00:00:00.000Z", error: null, limit: null, observed: null };
  it("exports the exact displayed selection, not its page, and polls only metadata before a native download", async () => {
    vi.mocked(api.createReportExport).mockResolvedValue(queued);
    vi.mocked(api.reportExportStatus).mockResolvedValue({ ...queued, status: "ready", rows: 50000, bytes: 5000000 });
    render(<ReportingView setId={reportSetId} />);
    await screen.findByRole("button", { name: "Researcher" });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Export agent CSV" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.createReportExport).toHaveBeenCalledWith({ kind: "official_agents", selectionId }, expect.any(AbortSignal));
    expect(api.reportExportStatus).toHaveBeenCalledWith("queued-agents", expect.any(AbortSignal));
    expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", "/api/data-exports/queued-agents/download");
  });
  it("surfaces failed export creation and permits an explicit retry without downloading", async () => {
    vi.mocked(api.createReportExport).mockRejectedValueOnce(new Error("Export unavailable")).mockResolvedValue(queued);
    render(<ReportingView />);
    await screen.findByRole("button", { name: "Researcher" });
    fireEvent.click(screen.getByRole("button", { name: "Export agent CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Export unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Export agent CSV" }));
    await waitFor(() => expect(api.createReportExport).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
  });
  it("allows a fresh export after A-B-A filters while aborted creation remains unsettled", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => page({ selection: { ...page().selection,
      id: query?.search ? "selection-b" : selectionId } }));
    vi.mocked(api.createReportExport).mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce(queued);
    render(<ReportingView />);
    await screen.findByRole("button", { name: "Researcher" });
    fireEvent.click(screen.getByRole("button", { name: "Export agent CSV" }));
    await waitFor(() => expect(api.createReportExport).toHaveBeenCalledOnce());
    const old = vi.mocked(api.createReportExport).mock.calls[0][1];
    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents" }), { target: { value: "b" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeEnabled());
    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents" }), { target: { value: "" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeEnabled());
    expect(old?.aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Export agent CSV" }));
    await waitFor(() => expect(api.createReportExport).toHaveBeenCalledTimes(2));
  });
});
