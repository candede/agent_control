import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportAgent, ReportPage } from "../../../backend/src/types/officialReportData";
import * as api from "../api/reportData";
import { ApiError } from "../api/client";
import { reportAgent, reportPage, reports, reportSetId, selectionId } from "../test/reportDataFixture";
import { deferred } from "../test/deferred";
import { createSavedQueryClient } from "../savedQueries";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { ReportAgentDetail, ReportingView } from "./ReportingView";

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
  vi.mocked(api.readReportFacet).mockImplementation(async (_path, id) => ({
    value: [{ value: "Your org", count: 40000 }], selection: { ...page().selection, id },
    counts: { total: 500, filtered: 500 }, page: { limit: 50, nextCursor: "creator-next", previousCursor: null },
  }));
  vi.mocked(api.readReportDetail).mockResolvedValue({ value: first, reports, sources: page().sources, selection: page().selection });
  vi.mocked(api.cancelReportExport).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("focused selected official agent reporting", () => {
  it("withdraws the report and export when creator options reject its selection", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.readReportFacet>>>();
    vi.mocked(api.readReportFacet).mockReturnValueOnce(pending.promise);
    render(<ReportingView />);
    await screen.findByRole("button", { name: "Researcher" });
    await act(async () => pending.reject(new ApiError(409, "selection_invalidated", "Creator selection expired")));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("This selection changed or expired.");
    expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    await screen.findByRole("button", { name: "Researcher" });
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]).not.toHaveProperty("selectionId");
  });
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
  it("rejects a different exact agent identity and retires its parent selection without fetching child rows", async () => {
    vi.mocked(api.readReportDetail).mockResolvedValue({ value: reportAgent(99), reports, sources: page().sources, selection: page().selection });
    render(<ReportingView />);
    fireEvent.click(await screen.findByRole("button", { name: "Researcher" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This selection changed or expired");
    expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
    expect(vi.mocked(api.readReportPage).mock.calls.some(call => call[0].endsWith("/users"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.selectionId).toBeUndefined();
  });
  it.each(["revision", "search", "dates"] as const)("permanently retires open agent details across a %s boundary", async boundary => {
    vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/users") ? reportPage([]) : page());
    const view = render(<ReportingView setId={reportSetId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Researcher" }));
    await screen.findByText(/Exact report identity: agent-1/);
    const pending = deferred<ReportPage<ReportAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    if (boundary === "revision") view.rerender(<ReportingView setId={reportSetId} revision={1} />);
    else fireEvent.change(screen.getByLabelText(boundary === "search" ? "Search agents" : "Activity start date"),
      { target: { value: boundary === "search" ? "changed" : "2026-01-01" } });
    expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
    if (boundary === "revision") expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    await act(async () => pending.resolve(page()));
    await screen.findByRole("button", { name: "Researcher" });
    expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
    expect(api.readReportDetail).toHaveBeenCalledOnce();
  });
  it("does not reload or close exact details for report UUID casing or surrounding search whitespace", async () => {
    const setId = "abcdefab-1234-4567-8901-abcdefabcdef";
    vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/users") ? reportPage([])
      : page({ reports: { ...reports, setId } }));
    const view = render(<ReportingView setId={setId} />);
    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "Researcher" } });
    fireEvent.click(await screen.findByRole("button", { name: "Researcher" }));
    await screen.findByText(/Exact report identity: agent-1/);
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(3));
    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: " Researcher " } });
    view.rerender(<ReportingView setId={setId.toUpperCase()} />);
    expect(screen.getByRole("region", { name: "Exact reported agent details" })).toBeVisible();
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(api.readReportDetail).toHaveBeenCalledOnce();
  });
  it("preserves details, facet paging and an admitted export for case- and Unicode-equivalent searches", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/users") ? reportPage([]) : page());
    vi.mocked(api.createReportExport).mockReturnValue(new Promise(() => {}));
    render(<ReportingView setId={reportSetId} />);
    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "Researcher" } });
    fireEvent.click(await screen.findByRole("button", { name: "Researcher" }));
    await screen.findByText(/Exact report identity: agent-1/);
    fireEvent.change(screen.getByLabelText("Search reported agent users"), { target: { value: "Exact@Example.invalid" } });
    await waitFor(() => expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]).toMatchObject({ search: "exact@example.invalid" }));
    const options = screen.getByLabelText("Search creator type options");
    fireEvent.change(options, { target: { value: "Your org" } });
    await waitFor(() => expect(screen.getByLabelText("Creator type")).toHaveAttribute("aria-disabled", "false"));
    fireEvent.click(screen.getByRole("button", { name: "Next creator type options" }));
    await waitFor(() => expect(screen.getByLabelText("Creator type")).toHaveAttribute("aria-disabled", "false"));
    fireEvent.click(screen.getByRole("button", { name: "Export agent CSV" }));
    const exportSignal = vi.mocked(api.createReportExport).mock.lastCall?.[1];
    const pageReads = vi.mocked(api.readReportPage).mock.calls.length;
    const facetReads = vi.mocked(api.readReportFacet).mock.calls.length;

    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: " ＲＥＳＥＡＲＣＨＥＲ " } });
    expect(screen.getByRole("region", { name: "Exact reported agent details" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Search reported agent users"), { target: { value: " ＥＸＡＣＴ＠ＥＸＡＭＰＬＥ．ＩＮＶＡＬＩＤ " } });
    fireEvent.change(options, { target: { value: " ＹＯＵＲ　ＯＲＧ " } });
    expect(api.readReportPage).toHaveBeenCalledTimes(pageReads);
    expect(api.readReportFacet).toHaveBeenCalledTimes(facetReads);
    expect(api.readReportDetail).toHaveBeenCalledOnce();
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/aggregate", selectionId, "creatorType",
      expect.objectContaining({ search: "your org", cursor: "creator-next" }));
    expect(screen.getByLabelText("Search agents")).toHaveValue(" ＲＥＳＥＡＲＣＨＥＲ ");
    expect(screen.getByRole("button", { name: "Preparing export..." })).toBeDisabled();
    expect(exportSignal?.aborted).toBe(false);
    expect(api.createReportExport).toHaveBeenCalledOnce();
  });
  it("clears private report filters and pending details on account changes", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.readReportDetail>>>();
    vi.mocked(api.readReportDetail).mockReturnValue(pending.promise);
    const capability: ReturnType<typeof useCapabilityContext> = {
      user: { tenantId: "tenant", homeAccountId: "first", username: "viewer@example.invalid", displayName: "Viewer", roles: ["AgentControl.Viewer"] },
      now: Date.now(), views: [], loading: false, pending: false, error: undefined, reload: vi.fn(async () => {}), openPermissions: vi.fn(),
    };
    const panel = (account: string) => <CapabilityContext value={{ ...capability, user: { ...capability.user!, homeAccountId: account } }}><ReportingView /></CapabilityContext>;
    const view = render(panel("first"));
    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "private search" } });
    fireEvent.click(await screen.findByRole("button", { name: "Researcher" }));
    const signal = vi.mocked(api.readReportDetail).mock.lastCall?.[2];
    view.rerender(panel("second"));
    expect(signal?.aborted).toBe(true);
    expect(screen.getByLabelText("Search agents")).toHaveValue("");
    await screen.findByRole("button", { name: "Researcher" });
    expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
    await act(async () => pending.resolve({ value: first, reports, sources: page().sources, selection: page().selection }));
    expect(api.readReportDetail).toHaveBeenCalledOnce();
  });
  it("keeps a pending exact agent read alive during same-selection parent paging and propagates its invalidation", async () => {
    const exact = deferred<Awaited<ReturnType<typeof api.readReportDetail<ReportAgent>>>>(), next = deferred<ReportPage<ReportAgent>>();
    vi.mocked(api.readReportDetail).mockReturnValueOnce(exact.promise);
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page({ page: { limit: 50, nextCursor: "next", previousCursor: null } }))
      .mockReturnValueOnce(next.promise);
    render(<ReportingView />);
    fireEvent.click(await screen.findByRole("button", { name: "Researcher" }));
    const signal = vi.mocked(api.readReportDetail).mock.calls[0][2];
    fireEvent.click(screen.getByRole("button", { name: "Next agents" }));
    const pageSignal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    expect(signal?.aborted).toBe(false);
    expect(screen.getByRole("region", { name: "Exact reported agent details" })).toBeVisible();
    await act(async () => exact.reject(new ApiError(409, "selection_invalidated", "Retired exact evidence")));
    expect(await screen.findByRole("alert")).toHaveTextContent("This selection changed or expired");
    expect(pageSignal?.aborted).toBe(true);
    await act(async () => next.resolve(page()));
    expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    expect(api.readReportDetail).toHaveBeenCalledOnce();
  });
  it.each([false, true])("keeps ordinary relationship errors local but retires invalidated report selections; invalidated=%s", async invalidated => {
    vi.mocked(api.readReportPage).mockImplementation(async path => {
      if (path.endsWith("/users")) throw new ApiError(invalidated ? 409 : 503,
        invalidated ? "selection_invalidated" : "read_failed", "Relationships unavailable");
      return page();
    });
    render(<ReportingView />);
    fireEvent.click(await screen.findByRole("button", { name: "Researcher" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(invalidated ? "This selection changed or expired" : "Relationships unavailable");
    expect(screen.queryByRole("region", { name: "Exact reported agent details" }) !== null).toBe(!invalidated);
    expect(screen.queryByRole("button", { name: "Researcher" }) !== null).toBe(!invalidated);
    expect(screen.getByRole("button", { name: "Export agent CSV" }).hasAttribute("disabled")).toBe(invalidated);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });
  it("preserves exact tenant totals separately from filtered totals and never derives either from this page", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(page({ counts: { total: 100000, filtered: 50000 },
      page: { limit: 50, nextCursor: "byte-short-next", previousCursor: null } }));
    render(<ReportingView />);
    await screen.findByRole("button", { name: "Researcher" });
    const totals = screen.getByRole("region", { name: "Snapshot tenant totals" });
    expect(totals).toHaveTextContent("1,000,000");
    expect(totals).toHaveTextContent("41,050");
    expect(screen.getByText("Reported agents").parentElement).toHaveTextContent("100,000");
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "agents pages" })).toHaveTextContent("50,000 matching agents; 2 on this page");
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });

  it("keeps stale evidence, observed-date limitations, discrepancy and technical provenance visible without claiming freshness", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(page({ reports: { ...reports, availability: "stale",
      lineages: reports.lineages.map(lineage => ({ ...lineage, sourceAsOf: "2026-01-31T00:00:00.000Z" })),
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous agents" })).toHaveAttribute("aria-disabled", "false"));
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
  it.each([
    { total: 0, filtered: 0, heading: "No reported agents" },
    { total: 10, filtered: 0, heading: "No agents match these filters" },
    { total: 10, filtered: 5, heading: "No agents on this page" },
  ])("describes empty agent rows using server counts: total=$total, filtered=$filtered", async ({ total, filtered, heading }) => {
    vi.mocked(api.readReportPage).mockResolvedValue(page({ value: [], counts: { total, filtered } }));
    render(<ReportingView />);
    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
  });
  it.each([
    { availability: "never_imported", heading: "Reports not imported" },
    { availability: "not_selected", heading: "No report selected" },
    { availability: "deleted", heading: "Selected report deleted" },
    { availability: "incomplete", heading: "Incomplete report bundle" },
  ] as const)("keeps missing $availability evidence distinct from zero activity", async ({ availability, heading }) => {
    const empty = page({ value: [], counts: { total: 0, filtered: 0 },
      reports: { ...reports, setId: null, lineages: [], availability } });
    empty.analytics.agents = { inactive: 0, neverUsed: 0, anchorDateUtc: null, windowDays: 30, windowAgents: 0,
      windowResponses: null, windowDistinctActiveUsers: 0, mostResponses: [], leastResponses: [] };
    vi.mocked(api.readReportPage).mockResolvedValue(empty);
    render(<ReportingView />);
    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
    expect(screen.queryByText("Activity analytics")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
  });
  it("does not label missing activity dates as never used or full-snapshot responses as window totals", async () => {
    const selected = page();
    selected.analytics.agents = { inactive: 2, neverUsed: 3, anchorDateUtc: "2026-01-31", windowDays: 30, windowAgents: 4,
      windowResponses: 200, windowDistinctActiveUsers: 8, mostResponses: [], leastResponses: [] };
    vi.mocked(api.readReportPage).mockResolvedValue(selected);
    render(<ReportingView />);
    fireEvent.click(await screen.findByText("Activity analytics"));
    expect(screen.getByText(/3 without a reported last-activity date/)).toBeVisible();
    expect(screen.getByText(/4 agents last active within 30 days of the activity anchor/)).toBeVisible();
    expect(screen.getByText(/Full-snapshot totals for those agents: 200 responses; 8 distinct active users/)).toBeVisible();
    expect(screen.queryByText(/never used/)).not.toBeInTheDocument();
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
    expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("41,050");
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

describe("exact reported-agent evidence lifetime", () => {
  const props = { selectionId, agentId: first.agentId, onClose: vi.fn(), onRestartSelection: vi.fn() };
  const evidence = () => ({ value: first, reports, sources: page().sources, selection: page().selection });
  it.each([
    { total: 0, filtered: 0, message: "No users listed for this agent in the selected report." },
    { total: 10, filtered: 0, message: "No users match this search." },
    { total: 10, filtered: 5, message: "No users on this page. Use the page controls to continue." },
  ])("describes empty relationships using server counts: total=$total, filtered=$filtered", async ({ total, filtered, message }) => {
    vi.mocked(api.readReportPage).mockResolvedValue(reportPage([], { counts: { total, filtered },
      page: { limit: 50, previousCursor: filtered ? "previous" : null, nextCursor: null } }));
    render(<ReportAgentDetail {...props} />);
    fireEvent.change(screen.getByLabelText("Search reported agent users"), { target: { value: "nobody" } });
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByText("No users listed in this report.")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "relationships pages" })).toHaveTextContent(`${filtered} matching relationships; 0 on this page`);
    if (filtered) expect(screen.getByRole("button", { name: "Previous relationships" })).toHaveAttribute("aria-disabled", "false");
  });
  it("shows initial loading, withdraws old details on revision, and defers dependent rows until exact evidence succeeds", async () => {
    const initial = deferred<ReturnType<typeof evidence>>(), replacement = deferred<ReturnType<typeof evidence>>();
    vi.mocked(api.readReportDetail).mockReturnValueOnce(initial.promise).mockReturnValueOnce(replacement.promise);
    vi.mocked(api.readReportPage).mockResolvedValue(reportPage([]));
    const view = render(<ReportAgentDetail {...props} />);
    expect(screen.getByText("Loading exact agent details...")).toBeVisible();
    expect(api.readReportPage).not.toHaveBeenCalled();
    await act(async () => initial.resolve(evidence()));
    await screen.findByText(/Exact report identity/);
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledOnce());
    view.rerender(<ReportAgentDetail {...props} revision={1} />);
    expect(screen.queryByText(/Exact report identity/)).not.toBeInTheDocument();
    expect(screen.getByText("Loading exact agent details...")).toBeVisible();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    await act(async () => replacement.resolve(evidence()));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
  });
  it("shares retries and clears prior exact-read errors while a replacement is pending", async () => {
    const client = createSavedQueryClient(), pending = deferred<ReturnType<typeof evidence>>();
    vi.mocked(api.readReportPage).mockResolvedValue(reportPage([]));
    render(<QueryClientProvider client={client}><ReportAgentDetail {...props} /></QueryClientProvider>);
    await screen.findByText(/Exact report identity/);
    vi.mocked(api.readReportDetail).mockRejectedValueOnce(new Error("Exact read unavailable"));
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved", "report-agent-detail"] }); });
    const retry = await screen.findByRole("button", { name: "Retry agent details" });
    vi.mocked(api.readReportDetail).mockClear().mockReturnValue(pending.promise);
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(api.readReportDetail).toHaveBeenCalledOnce();
    expect(vi.mocked(api.readReportDetail).mock.lastCall?.[2]?.aborted).toBe(false);
    expect(await screen.findByText("Loading exact agent details...")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => pending.resolve(evidence()));
    await screen.findByText(/Exact report identity/);
    cleanup(); client.clear();
  });
  it.each(["expired", "invalid"] as const)("rejects %s exact-agent expiry before reading relationships", async expiry => {
    vi.mocked(api.readReportDetail).mockResolvedValue({ ...evidence(), selection: { ...page().selection,
      expiresAt: expiry === "expired" ? "2000-01-01T00:00:00Z" : "not-a-date" } });
    render(<ReportAgentDetail {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired/);
    expect(screen.queryByText(/Exact report identity/)).not.toBeInTheDocument();
    expect(api.readReportPage).not.toHaveBeenCalled();
  });
  it("accepts equivalent selection UUID casing without restarting exact or relationship reads", async () => {
    const id = "abcdefab-1234-4567-8901-abcdefabcdef";
    vi.mocked(api.readReportDetail).mockResolvedValue({ ...evidence(), selection: { ...page().selection, id } });
    vi.mocked(api.readReportPage).mockResolvedValue(reportPage([], { selection: { ...page().selection, id } }));
    const view = render(<ReportAgentDetail {...props} selectionId={id.toUpperCase()} />);
    await screen.findByText(/Exact report identity/);
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledOnce());
    view.rerender(<ReportAgentDetail {...props} selectionId={id} />);
    expect(api.readReportDetail).toHaveBeenCalledOnce();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it.each(["timer", "focus"] as const)("retires expired exact evidence on %s and cancels pending relationships without reloading", async boundary => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof reportPage>>();
    vi.mocked(api.readReportDetail).mockResolvedValue({ ...evidence(), selection: { ...page().selection,
      expiresAt: new Date(Date.now() + 2000).toISOString() } });
    vi.mocked(api.readReportPage).mockReturnValue(pending.promise);
    render(<ReportAgentDetail {...props} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText(/Exact report identity/)).toBeVisible();
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    await act(async () => {
      if (boundary === "timer") await vi.advanceTimersByTimeAsync(2000);
      else { vi.setSystemTime(Date.now() + 2000); fireEvent.focus(window); }
    });
    expect(screen.queryByText(/Exact report identity/)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/expired/);
    expect(signal?.aborted).toBe(true);
    expect(api.readReportDetail).toHaveBeenCalledOnce();
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });
});

describe("selected agent durable CSV boundaries", () => {
  const queued = { id: "queued-agents", status: "queued" as const, rows: 0, bytes: 0,
    expiresAt: "2030-01-01T00:00:00.000Z", error: null, limit: null, observed: null };
  it.each(["admission", "status", "download", "cancellation"] as const)(
    "withdraws invalidated report evidence after export %s and only reloads on explicit restart", async phase => {
      const invalidated = new ApiError(409, "selection_invalidated", "The selected report was retired.");
      const ready = { ...queued, status: "ready" as const, rows: 50000, bytes: 5000000 };
      if (phase === "admission") vi.mocked(api.createReportExport).mockRejectedValueOnce(invalidated);
      else vi.mocked(api.createReportExport).mockResolvedValue(queued);
      if (phase === "status") vi.mocked(api.reportExportStatus).mockRejectedValueOnce(invalidated);
      else if (phase === "download") vi.mocked(api.reportExportStatus).mockResolvedValueOnce(ready).mockRejectedValueOnce(invalidated);
      if (phase === "cancellation") vi.mocked(api.cancelReportExport).mockRejectedValueOnce(invalidated);
      const detail = deferred<Awaited<ReturnType<typeof api.readReportDetail<ReportAgent>>>>();
      vi.mocked(api.readReportDetail).mockReturnValueOnce(detail.promise);
      const nativeDownload = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      render(<ReportingView setId={reportSetId} />);
      fireEvent.click(await screen.findByRole("button", { name: "Researcher" }));
      const detailSignal = vi.mocked(api.readReportDetail).mock.calls[0][2]!;
      vi.useFakeTimers();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export agent CSV" })); });
      if (phase === "status" || phase === "download") await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      if (phase === "download") await act(async () => { fireEvent.click(screen.getByRole("link", { name: "Download CSV" })); });
      if (phase === "cancellation") await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel export" })); });

      expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
      expect(detailSignal.aborted).toBe(true);
      expect(screen.getByRole("alert")).toHaveTextContent("This selection changed or expired.");
      expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
      expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
      expect(screen.queryByText("Loading saved data...")).not.toBeInTheDocument();
      await act(async () => {
        detail.resolve({ value: first, reports, sources: page().sources, selection: page().selection });
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
      expect(api.readReportPage).toHaveBeenCalledOnce();
      expect(api.createReportExport).toHaveBeenCalledOnce();
      expect(nativeDownload).not.toHaveBeenCalled();

      const replacementId = "10000000-0000-4000-8000-000000000009";
      vi.mocked(api.readReportPage).mockResolvedValueOnce(page({ selection: { ...page().selection, id: replacementId } }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(api.readReportPage).toHaveBeenCalledTimes(2);
      expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]).toMatchObject({ setId: reportSetId });
      expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.selectionId).toBeUndefined();
      expect(screen.getByRole("button", { name: "Researcher" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeEnabled();
      expect(api.createReportExport).toHaveBeenCalledOnce();
    },
  );
  it("exports the exact displayed selection, not its page, and polls only metadata before a native download", async () => {
    vi.mocked(api.createReportExport).mockResolvedValue(queued);
    vi.mocked(api.reportExportStatus).mockResolvedValue({ ...queued, status: "ready", rows: 50000, bytes: 5000000 });
    render(<ReportingView setId={reportSetId} />);
    await screen.findByRole("button", { name: "Researcher" });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Export agent CSV" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.createReportExport).toHaveBeenCalledWith({ kind: "official_agents", selectionId, idempotencyKey: expect.any(String) }, expect.any(AbortSignal));
    expect(api.reportExportStatus).toHaveBeenCalledWith("queued-agents", expect.any(AbortSignal));
    expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", "/api/data-exports/queued-agents/download");
  });
  it("surfaces failed export creation and permits an explicit retry without downloading", async () => {
    vi.mocked(api.createReportExport).mockRejectedValueOnce(new Error("Export unavailable")).mockResolvedValue(queued);
    render(<ReportingView />);
    await screen.findByRole("button", { name: "Researcher" });
    fireEvent.click(screen.getByRole("button", { name: "Export agent CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Export unavailable");
    const first = vi.mocked(api.createReportExport).mock.calls[0][0];
    fireEvent.click(screen.getByRole("button", { name: "Retry export request" }));
    await waitFor(() => expect(api.createReportExport).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.createReportExport).mock.calls[1][0]).toEqual(first);
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
