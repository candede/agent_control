import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import * as api from "../api/reportData";
import { ApiError } from "../api/client";
import { createSavedQueryClient } from "../savedQueries";
import { useReportPage } from "../useReportPage";
import { deferred } from "../test/deferred";
import { combinedUser, historySet, reportPage, reports, selectionId } from "../test/reportDataFixture";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { mockNativeDialogs } from "../test/dialog";
import { CopilotUsersView } from "./CopilotUsersView";
import { ReportExportButton } from "./ReportExportButton";
import { OfficialUsageHistoryPanel } from "./OfficialUsageHistoryPanel";
import { ReportFacet } from "./ReportFacet";

vi.mock("../api/reportData", async original => ({ ...await original<typeof import("../api/reportData")>(),
  readReportPage: vi.fn(), readReportFacet: vi.fn(), readReportDetail: vi.fn(), createReportExport: vi.fn(),
  reportExportStatus: vi.fn(), cancelReportExport: vi.fn(),
}));
mockNativeDialogs();
beforeEach(() => {
  vi.mocked(api.readReportPage).mockResolvedValue(reportPage([combinedUser()]));
  vi.mocked(api.readReportFacet).mockResolvedValue({ value: [{ value: "Contoso", count: 50000 }], selection: reportPage([]).selection,
    counts: { total: 10000, filtered: 10000 }, page: { limit: 50, nextCursor: "facet-next", previousCursor: null } });
  vi.mocked(api.readReportDetail).mockResolvedValue({ value: combinedUser(), reports, sources: reportPage([]).sources, selection: reportPage([]).selection });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

describe("selected users and reports client boundary", () => {
  it.each(["licenses", "activity"] as const)("reports saved source availability without routine refresh banners for the %s cohort", async view => {
    const data = reportPage([]);
    data.sources.directory = { ...data.sources.directory, state: "unavailable", attemptStatus: "running" };
    data.sources.app_activity = { ...data.sources.app_activity, state: "stale", attemptStatus: "running" };
    vi.mocked(api.readReportPage).mockResolvedValueOnce(data);
    render(<CopilotUsersView route={{ view, search: "", page: 0 }} />);
    if (view === "licenses") {
      expect(await screen.findByText("License data unavailable. Run Users sync in Sync or review Permissions.")).toBeVisible();
      expect(screen.getByText("Office app activity is out of date. Run Users sync in Sync.")).toBeVisible();
    } else {
      expect(await screen.findByText("License data unavailable. Current directory verification is required. Run Users sync to verify licensing.")).toBeVisible();
    }
    expect(screen.queryByText(/Refreshing license data|Refreshing Office app activity|Showing the last saved data/)).not.toBeInTheDocument();
  });
  it.each(["available", "stale"] as const)("withholds old Office freshness notices during a read and reports the settled %s state", async state => {
    const stale = reportPage([combinedUser()]);
    stale.sources.app_activity.state = "stale";
    const pending = deferred<typeof stale>();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(stale).mockReturnValueOnce(pending.promise);
    render(<CopilotUsersView />);
    await screen.findByText("Office app activity is out of date. Run Users sync in Sync.");
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(screen.queryByText(/Office app activity is out of date/)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "User 1" })).toBeVisible();
    await act(async () => pending.resolve({ ...stale, sources: { ...stale.sources, app_activity: { ...stale.sources.app_activity, state } } }));
    await waitFor(() => expect(screen.queryByText(/Office app activity is out of date/) !== null).toBe(state === "stale"));
  });
  it.each(["company", "department"] as const)("keeps SQL null and every literal %s facet distinct through rendering, change and serialization", async field => {
    const values = [null, "null", "~null", "", "~string:", "~string:null"];
    vi.mocked(api.readReportFacet).mockResolvedValue({ value: values.map((value, index) => ({ value, count: index + 1 })),
      selection: reportPage([]).selection, counts: { total: values.length, filtered: values.length },
      page: { limit: 50, nextCursor: null, previousCursor: null } });
    const onChange = vi.fn();
    function Host() {
      const [value, setValue] = useState<string | null>();
      return <ReportFacet path="copilot-usage/users" selectionId={selectionId} field={field} value={value}
        onChange={next => { onChange(next); setValue(next); }} onRestartSelection={vi.fn()} />;
    }
    const errors = vi.spyOn(console, "error");
    try {
      render(<Host />);
      const select = screen.getByRole("combobox");
      await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
      const options = within(select).getAllByRole<HTMLOptionElement>("option");
      expect(new Set(options.map(option => option.value)).size).toBe(values.length + 1);
      for (const [index, value] of values.entries()) {
        fireEvent.change(select, { target: { value: options[index + 1].value } });
        expect(onChange).toHaveBeenLastCalledWith(value);
        expect(select).toHaveValue(options[index + 1].value);
        const query = api.reportQueryString({ [field]: onChange.mock.calls.at(-1)![0] });
        expect(new URLSearchParams(query).get(field)).toBe(value === null ? "~null" : `~string:${value}`);
      }
      fireEvent.change(select, { target: { value: "" } });
      expect(onChange).toHaveBeenLastCalledWith(undefined);
      expect(api.reportQueryString({ [field]: onChange.mock.calls.at(-1)![0] })).toBe("");
      expect(errors).not.toHaveBeenCalled();
    } finally { errors.mockRestore(); }
  });
  it("reuses a recent first page without restoring an earlier cursor when a changed filter returns to its original value", async () => {
    const first = reportPage([combinedUser(1)], { page: { limit: 50, nextCursor: "page-two", previousCursor: null } });
    const filtered = reportPage([combinedUser(3)], { selection: { ...first.selection, id: "20000000-0000-4000-8000-000000000003" } });
    vi.mocked(api.readReportPage)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(reportPage([combinedUser(2)], { page: { limit: 50, nextCursor: null, previousCursor: "page-one" } }))
      .mockResolvedValueOnce(filtered);
    const { result, rerender } = renderHook(({ search }) => useReportPage<ReturnType<typeof combinedUser>>(
      "copilot-usage/users", { search: search || undefined }), { initialProps: { search: "" } });
    await waitFor(() => expect(result.current.data?.value[0].directory.displayName).toBe("User 1"));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.data?.value[0].directory.displayName).toBe("User 2"));
    expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users",
      expect.objectContaining({ selectionId, cursor: "page-two" }), expect.any(AbortSignal));
    rerender({ search: "changed" });
    await waitFor(() => expect(result.current.data?.value[0].directory.displayName).toBe("User 3"));
    expect(result.current.data?.selection.id).toBe(filtered.selection.id);
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]).toEqual({ search: "changed", limit: 50 });
    rerender({ search: "" });
    expect(result.current.data).toEqual(first);
    expect(result.current.loading).toBe(false);
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.readReportPage).toHaveBeenCalledTimes(4);
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]).toEqual({ search: undefined, selectionId, limit: 50 });
  });
  it("aborts a bounded dependent read when its enabling exact evidence is withdrawn", async () => {
    const pending = deferred<ReturnType<typeof reportPage>>();
    vi.mocked(api.readReportPage).mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(({ enabled }) => useReportPage("copilot-usage/users", {}, 0, enabled), { initialProps: { enabled: true } });
    expect(api.readReportPage).toHaveBeenCalledOnce();
    const signal = vi.mocked(api.readReportPage).mock.calls[0][2];
    rerender({ enabled: false });
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(reportPage([combinedUser()])));
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });
  it.each([401, 403])("closes exact details on parent read failure %s and never revives them after recovery", async status => {
    render(<CopilotUsersView />);
    fireEvent.click(await screen.findByRole("button", { name: "User 1" }));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByRole("heading", { name: "User 1" });
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(status, "access_denied", "Read no longer authorized or current"));
    fireEvent.focus(window);
    await screen.findByRole("alert");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "User 1" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    await screen.findByRole("button", { name: "User 1" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("automatically recaptures a top-level selection invalidated by a concurrent saved-data update", async () => {
    render(<CopilotUsersView />);
    fireEvent.click(await screen.findByRole("button", { name: "User 1" }));
    await within(screen.getByRole("dialog")).findByRole("heading", { name: "User 1" });
    vi.mocked(api.readReportPage).mockRejectedValueOnce(
      new ApiError(409, "selection_invalidated", "Saved data changed during the read"),
    );
    fireEvent.focus(window);
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(3));
    expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users",
      expect.not.objectContaining({ selectionId: expect.anything() }), expect.any(AbortSignal));
    expect(await screen.findByRole("button", { name: "User 1" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("restarts the parent selection after a paged child invalidates rather than replaying its old selection", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async path => {
      if (path.endsWith("/service-plans")) throw new ApiError(409, "selection_invalidated", "Source changed");
      return reportPage([combinedUser()]);
    });
    render(<CopilotUsersView />);
    fireEvent.click(await screen.findByRole("button", { name: "User 1" }));
    await screen.findByRole("heading", { name: "User 1" });
    fireEvent.click(screen.getByRole("tab", { name: "Licenses" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restart selection" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users",
      expect.not.objectContaining({ selectionId }), expect.any(AbortSignal)));
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("withdraws stale historical rows and cursors while a known revision is recaptured", async () => {
    const page = reportPage([combinedUser()], { page: { limit: 50, nextCursor: "next", previousCursor: null } });
    const replacement = deferred<ReturnType<typeof reportPage>>();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page).mockReturnValueOnce(replacement.promise);
    const route = { view: "licenses" as const, search: "", page: 0, reportSetId: reports.setId! };
    const view = render(<CopilotUsersView route={route} />);
    await screen.findByRole("button", { name: "User 1" });
    view.rerender(<CopilotUsersView route={route} dataRevision={1} />);
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Loading saved data...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "User 1" })).not.toBeInTheDocument();
    const next = screen.getByRole("button", { name: "Next users" });
    expect(next).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(next);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.calls[1][1]).not.toHaveProperty("selectionId");
    expect(vi.mocked(api.readReportPage).mock.calls[1][1]).not.toHaveProperty("cursor");
    await act(async () => replacement.resolve(reportPage([combinedUser(2)])));
    await screen.findByRole("button", { name: "User 2" });
  });

  it("offers a real parent restart after an independently paged facet invalidates", async () => {
    vi.mocked(api.readReportFacet).mockRejectedValue(new ApiError(409, "selection_invalidated", "Source changed"));
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "User 1" });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restart selection" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users",
      expect.not.objectContaining({ selectionId }), expect.any(AbortSignal));
  });

  it("does not read, migrate, acknowledge or clear retired browser report storage", async () => {
    const key = "agent-control:usage-reports:v1";
    localStorage.setItem(key, JSON.stringify({ users: [{ displayName: "Untrusted legacy identity" }] }));
    localStorage.setItem("unrelated-cutover-sentinel", "preserve");
    const get = vi.spyOn(Storage.prototype, "getItem"), remove = vi.spyOn(Storage.prototype, "removeItem");
    try {
      render(<CopilotUsersView />);
      await screen.findByRole("button", { name: "User 1" });
      expect(screen.queryByText("Untrusted legacy identity")).not.toBeInTheDocument();
      expect(get).not.toHaveBeenCalledWith(key);
      expect(remove).not.toHaveBeenCalledWith(key);
      expect(api.readReportPage).toHaveBeenCalledOnce();
      expect(localStorage.getItem("unrelated-cutover-sentinel")).toBe("preserve");
    } finally {
      get.mockRestore(); remove.mockRestore();
      localStorage.removeItem(key); localStorage.removeItem("unrelated-cutover-sentinel");
    }
  });

  it.each([false, true])("checks only export metadata before a native download; invalidated=%s", async invalidated => {
    vi.useFakeTimers();
    const ready = { id: "export-download", status: "ready" as const, rows: 50000, bytes: 20000000,
      expiresAt: new Date(Date.now() + 60000).toISOString(), error: null, limit: null, observed: null };
    vi.mocked(api.createReportExport).mockResolvedValue({ id: ready.id });
    vi.mocked(api.reportExportStatus).mockResolvedValueOnce(ready);
    if (invalidated) vi.mocked(api.reportExportStatus).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Changed"));
    else vi.mocked(api.reportExportStatus).mockResolvedValueOnce(ready);
    const native = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(<ReportExportButton selectionId={selectionId} kind="official_users" label="Export selected users" />);
      fireEvent.click(screen.getByRole("button", { name: "Export selected users" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      const link = screen.getByRole("link", { name: "Download CSV" });
      expect(link).toHaveAttribute("href", "/api/data-exports/export-download/download");
      expect(link).not.toHaveAttribute("download");
      await act(async () => { fireEvent.click(link); });
      expect(api.reportExportStatus).toHaveBeenCalledTimes(2);
      if (invalidated) {
        expect(native).not.toHaveBeenCalled();
        expect(screen.getByRole("alert")).toHaveTextContent("Restart the selection before exporting");
        expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
      } else expect(native).toHaveBeenCalledOnce();
    } finally { native.mockRestore(); }
  });

  it("keeps keyboard sort and cohort controls mounted while their selected page changes", async () => {
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "User 1" });
    const heading = screen.getByRole("button", { name: "Agent responses" });
    vi.mocked(api.readReportPage).mockReturnValue(new Promise(() => {}));
    heading.focus(); fireEvent.click(heading);
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users",
      expect.objectContaining({ sort: "responses", order: "asc" }), expect.any(AbortSignal)));
    expect(heading).toHaveFocus(); expect(heading).toBeInTheDocument();
    const cohort = screen.getByRole("button", { name: "Needs attention" });
    cohort.focus(); fireEvent.click(cohort);
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users",
      expect.objectContaining({ cohort: "needs_attention" }), expect.any(AbortSignal)));
    expect(cohort).toHaveFocus(); expect(cohort).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "User 1" })).not.toBeInTheDocument();
  });

  it("uses server counts and follows a byte-short page's cursor, not row length", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => reportPage([combinedUser(query?.cursor ? 2 : 1)],
      { counts: { total: 100000, filtered: 50000 },
        page: { limit: 50, nextCursor: query?.cursor ? null : "byte-short-next", previousCursor: query?.cursor ? "previous" : null } }));
    render(<CopilotUsersView />);
    await waitFor(() => expect(screen.getByRole("status", { name: "Matching users" })).toHaveTextContent("50,000 matching users"));
    fireEvent.click(screen.getByRole("button", { name: "Next users" }));
    await screen.findByRole("button", { name: "User 2" });
    expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users",
      expect.objectContaining({ cursor: "byte-short-next", selectionId, limit: 50 }), expect.any(AbortSignal));
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["Using agents", "using_agents"], ["Needs attention", "needs_attention"], ["No reported agent activity", "no_agent_activity"],
  ])("lets the server select the %s cohort", async (label, cohort) => {
    render(<CopilotUsersView />);
    fireEvent.click(await screen.findByRole("button", { name: label }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users",
      expect.objectContaining({ cohort }), expect.any(AbortSignal)));
  });
  it("passes response/agents/activity sorts and thresholds without sorting a tenant array", async () => {
    render(<CopilotUsersView />); await screen.findByRole("button", { name: "User 1" });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "agentsUsed:asc" } });
    fireEvent.change(screen.getByLabelText("Low-response threshold"), { target: { value: "17" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users",
      expect.objectContaining({ sort: "agentsUsed", order: "asc", lowResponseThreshold: 17 }), expect.any(AbortSignal)));
  });
  it("aborts previous page requests and bounds the saved page cache", async () => {
    const client = createSavedQueryClient();
    vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => reportPage([combinedUser()],
      { page: { limit: 50, nextCursor: `${query?.cursor ?? "page"}-next`, previousCursor: "previous" } }));
    const view = render(<QueryClientProvider client={client}><CopilotUsersView /></QueryClientProvider>);
    for (let index = 0; index < 6; index++) {
      await screen.findByRole("button", { name: "User 1" });
      await waitFor(() => expect(screen.getByRole("button", { name: "Next users" })).toHaveAttribute("aria-disabled", "false"));
      fireEvent.click(screen.getByRole("button", { name: "Next users" }));
      await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(index + 2));
    }
    await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: ["saved", "record-page"] }).length).toBeLessThanOrEqual(3));
    view.unmount();
    client.clear();
    const pending = render(<CopilotUsersView />);
    expect(screen.getByRole("region", { name: "Loading users" })).toBeVisible();
    const search = await screen.findByRole("searchbox", { name: "Search users or agents" });
    vi.mocked(api.readReportPage).mockReturnValue(new Promise(() => {}));
    fireEvent.change(search, { target: { value: "pending" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users", expect.objectContaining({ search: "pending" }), expect.any(AbortSignal)));
    const signal = vi.mocked(api.readReportPage).mock.calls.at(-1)![2];
    expect(signal?.aborted).toBe(false);
    fireEvent.change(search, { target: { value: "replacement" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users", expect.objectContaining({ search: "replacement" }), expect.any(AbortSignal)));
    expect(signal?.aborted).toBe(true);
    const replacementSignal = vi.mocked(api.readReportPage).mock.calls.at(-1)![2];
    expect(replacementSignal?.aborted).toBe(false);
    pending.unmount();
    expect(replacementSignal?.aborted).toBe(true);
  });
  it("automatically recaptures after a paged root selection is invalidated", async () => {
    vi.mocked(api.readReportPage).mockResolvedValueOnce(reportPage([combinedUser()], { page: { limit: 50, nextCursor: "next", previousCursor: null } }))
      .mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Selection invalidated"))
      .mockResolvedValueOnce(reportPage([combinedUser(2)]));
    render(<CopilotUsersView />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Next users" })).toHaveAttribute("aria-disabled", "false"));
    fireEvent.click(await screen.findByRole("button", { name: "Next users" }));
    await screen.findByRole("button", { name: "User 2" });
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(vi.mocked(api.readReportPage).mock.calls[2][1]?.selectionId).toBeUndefined();
    expect(vi.mocked(api.readReportPage).mock.calls[2][1]?.cursor).toBeUndefined();
  });
  it("fetches exact details, then independently pages hundreds of service plans", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("service-plans") ? reportPage([], { counts: { total: 800, filtered: 800 },
      page: { limit: 50, nextCursor: "plans-next", previousCursor: null } }) : reportPage([combinedUser()]));
    render(<CopilotUsersView />); fireEvent.click(await screen.findByRole("button", { name: "User 1" }));
    await waitFor(() => expect(api.readReportDetail).toHaveBeenCalledWith(`copilot-usage/users/${combinedUser().directory.objectId}`, selectionId, expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("tab", { name: "Licenses" }));
    await screen.findByText("800 matching plans; 0 on this page");
    expect(screen.getByRole("button", { name: "Next plans" })).toHaveAttribute("aria-disabled", "false");
    expect(api.readReportPage).toHaveBeenLastCalledWith(expect.stringContaining("/service-plans"), expect.objectContaining({ selectionId, limit: 50 }), expect.any(AbortSignal));
  });
  it("preserves a user's current relationship page for surrounding search whitespace", async () => {
    const row = { id: "relationship", agentId: "agent", agentName: "Reported agent", creatorType: "Your org",
      username: combinedUser().directory.userPrincipalName, responses: 10, lastActivityDateUtc: null, identityStatus: "unresolved" as const };
    vi.mocked(api.readReportPage).mockImplementation(async (path, query) => path.endsWith("/agents") ? reportPage([row],
      { page: { limit: 50, nextCursor: query?.cursor ? null : "relationship-next", previousCursor: query?.cursor ? "previous" : null } })
      : reportPage([combinedUser()]));
    render(<CopilotUsersView />);
    fireEvent.click(await screen.findByRole("button", { name: "User 1" }));
    await screen.findByRole("heading", { name: "User 1" });
    fireEvent.click(screen.getByRole("tab", { name: "Usage & agents" }));
    await screen.findByText("Reported agent");
    fireEvent.click(screen.getByRole("button", { name: "Next agents" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous agents" })).toHaveAttribute("aria-disabled", "false"));
    const search = screen.getByRole("searchbox", { name: "Search this user's agents" });
    fireEvent.change(search, { target: { value: " " } });
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Reported agent")).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous agents" })).toHaveAttribute("aria-disabled", "false");
    fireEvent.change(search, { target: { value: "Reported" } });
    await screen.findByText("Reported agent");
    fireEvent.change(search, { target: { value: " Reported " } });
    expect(api.readReportPage).toHaveBeenCalledTimes(4);
    expect(search).toHaveValue(" Reported ");
  });
  it("keeps one history selection across more than 32 sets and pages observations separately", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async (path, query) => path.endsWith("observations") ? reportPage([])
      : reportPage([{ id: reports.setId!, bundleId: reports.setId!, contentHash: "a".repeat(64), reportingStart: null, reportingEnd: null,
        periodProvenance: "activity_range", supersedesSetId: null, acceptedAt: reports.acceptedAt!, visibility: "retained", active: false }],
      { counts: { total: 35, filtered: 35 }, page: { limit: 50, nextCursor: query?.cursor ? null : "history-next", previousCursor: query?.cursor ? "history-prev" : null } }));
    render(<OfficialUsageHistoryPanel revision={0} />);
    await screen.findByText("35 saved report sets");
    fireEvent.click(screen.getByRole("button", { name: "Next report sets" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/history", expect.objectContaining({ selectionId, cursor: "history-next" }), expect.any(AbortSignal)));
    fireEvent.click(await screen.findByRole("button", { name: "Report observations" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith(`official-usage/history/${reports.setId}/observations`, expect.objectContaining({ selectionId }), expect.any(AbortSignal)));
  });
  it.each(["revision", "restart", "denial", "account"] as const)(
    "cancels history observations across a %s boundary without silently reopening them", async boundary => {
      const pending = deferred<ReturnType<typeof reportPage>>();
      const first = reportPage([historySet()]);
      vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/observations") ? pending.promise : first);
      const capability: ReturnType<typeof useCapabilityContext> = {
        user: { tenantId: "tenant", homeAccountId: "first", username: "viewer@example.invalid", displayName: "Viewer", roles: ["AgentControl.Viewer"] },
        now: Date.now(), views: [], loading: false, pending: false, error: undefined, reload: vi.fn(async () => {}), openPermissions: vi.fn(),
      };
      const panel = (revision: number, account = "first") => <CapabilityContext value={{ ...capability, user: { ...capability.user!, homeAccountId: account } }}>
        <OfficialUsageHistoryPanel revision={revision} />
      </CapabilityContext>;
      const view = render(panel(0));
      fireEvent.click(await screen.findByRole("button", { name: "Report observations" }));
      await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
      const signal = vi.mocked(api.readReportPage).mock.calls[1][2];
      if (boundary === "revision") view.rerender(panel(1));
      else if (boundary === "account") view.rerender(panel(0, "second"));
      else if (boundary === "restart") fireEvent.click(screen.getByRole("button", { name: "Load current report history" }));
      else {
        vi.mocked(api.readReportPage).mockImplementation(async path => {
          if (path.endsWith("/observations")) return pending.promise;
          throw new ApiError(403, "access_denied", "History access denied");
        });
        fireEvent.focus(window);
        await screen.findByText("History access denied");
      }
      await waitFor(() => expect(signal?.aborted).toBe(true));
      if (boundary === "denial") {
        vi.mocked(api.readReportPage).mockResolvedValue(first);
        fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
      }
      await waitFor(() => expect(screen.getByRole("button", { name: "View report" })).toBeEnabled());
      expect(screen.queryByRole("region", { name: "Report observations" })).not.toBeInTheDocument();
      await act(async () => pending.reject(new ApiError(409, "selection_invalidated", "Obsolete observation")));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Report observations" })).not.toBeInTheDocument();
      expect(vi.mocked(api.readReportPage).mock.calls.filter(([path]) => path.endsWith("/observations"))).toHaveLength(1);
    },
  );
  it("preserves independently pending history observations while paging the same parent selection", async () => {
    const pending = deferred<ReturnType<typeof reportPage>>();
    vi.mocked(api.readReportPage).mockImplementation(async (path, query) => path.endsWith("/observations") ? pending.promise
      : reportPage([historySet(query?.cursor ? 2 : 1)], { page: { limit: 50, nextCursor: query?.cursor ? null : "next", previousCursor: null } }));
    render(<OfficialUsageHistoryPanel revision={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Report observations" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(api.readReportPage).mock.calls[1][2];
    const observations = screen.getByRole("region", { name: "Report observations" });
    fireEvent.click(screen.getByRole("button", { name: "Next report sets" }));
    await waitFor(() => expect(screen.getByRole("table")).toHaveTextContent(historySet(2).id));
    expect(signal?.aborted).toBe(false);
    expect(screen.getByRole("region", { name: "Report observations" })).toBe(observations);
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    await act(async () => pending.resolve(reportPage([])));
    await waitFor(() => expect(within(observations).queryByText("Loading saved data...")).not.toBeInTheDocument());
  });
  it("withdraws history actions when independently paged observations invalidate their selection", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async path => {
      if (path.endsWith("/observations")) throw new ApiError(409, "selection_invalidated", "History changed");
      return reportPage([historySet()]);
    });
    render(<OfficialUsageHistoryPanel revision={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Report observations" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "View report" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Report observations" })).not.toBeInTheDocument();
    fireEvent.focus(window);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    expect(await screen.findByRole("button", { name: "View report" })).toBeEnabled();
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]).not.toHaveProperty("selectionId");
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
  });
  it("polls metadata only and offers a native download instead of buffering CSV", async () => {
    vi.useFakeTimers();
    vi.mocked(api.createReportExport).mockResolvedValue({ id: "export-id" });
    vi.mocked(api.reportExportStatus).mockResolvedValue({ id: "export-id", status: "ready", rows: 100000, bytes: 900000000,
      expiresAt: new Date(Date.now() + 1800000).toISOString(), error: null, limit: null, observed: null });
    render(<ReportExportButton selectionId={selectionId} kind="copilot_users" label="Export users" />);
    fireEvent.click(screen.getByRole("button", { name: "Export users" }));
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(1999); });
    expect(api.reportExportStatus).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.reportExportStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", "/api/data-exports/export-id/download");
    expect(screen.getByRole("link", { name: "Download CSV" })).not.toHaveAttribute("download");
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(api.reportExportStatus).toHaveBeenCalledTimes(1);
  });
  it("recaptures the same historical report set on revision changes", async () => {
    const route = { view: "licenses" as const, search: "", page: 0, reportSetId: reports.setId! };
    const view = render(<CopilotUsersView route={route} dataRevision={0} />);
    await screen.findByRole("button", { name: "User 1" });
    view.rerender(<CopilotUsersView route={route} dataRevision={1} />);
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users",
      expect.objectContaining({ setId: reports.setId, limit: 50 }), expect.any(AbortSignal));
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.selectionId).toBeUndefined();
  });
  it("recaptures current data after a known revision without replaying a selection or cursor", async () => {
    const replacement = deferred<ReturnType<typeof reportPage>>();
    const first = reportPage([combinedUser()], { page: { limit: 50, nextCursor: "page-two", previousCursor: null } });
    vi.mocked(api.readReportPage).mockResolvedValueOnce(first).mockResolvedValueOnce(first).mockReturnValueOnce(replacement.promise);
    const query = { search: "User", sort: "name" as const, order: "asc" as const };
    const { result, rerender } = renderHook(({ revision }) =>
      useReportPage("copilot-usage/users", query, revision), { initialProps: { revision: 0 } });
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => result.current.next());
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    rerender({ revision: 1 });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users", { ...query, limit: 50 }, expect.any(AbortSignal));
    const latest = reportPage([combinedUser(2)], { selection: { ...first.selection, id: "new-selection" } });
    await act(async () => replacement.resolve(latest));
    await waitFor(() => expect(result.current.data?.selection.id).toBe("new-selection"));
    expect(result.current.invalidated).toBe(false);
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
  });
  it("does not recapture explicit child selections on revision changes", async () => {
    const { rerender } = renderHook(({ revision }) =>
      useReportPage("copilot-usage/users", { selectionId }, revision), { initialProps: { revision: 0 } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledOnce());
    rerender({ revision: 1 });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users", { selectionId, limit: 50 }, expect.any(AbortSignal));
  });
  it("sorts from accessible table headers and retains the last valid threshold during editing", async () => {
    render(<CopilotUsersView />); await screen.findByRole("button", { name: "User 1" });
    fireEvent.click(screen.getByRole("button", { name: "Agent responses" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users", expect.objectContaining({ sort: "responses", order: "asc" }), expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByLabelText("Low-response threshold"), { target: { value: "17" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users", expect.objectContaining({ lowResponseThreshold: 17 }), expect.any(AbortSignal)));
    const requests = vi.mocked(api.readReportPage).mock.calls.length;
    fireEvent.change(screen.getByLabelText("Low-response threshold"), { target: { value: "" } });
    expect(api.readReportPage).toHaveBeenCalledTimes(requests);
    expect(screen.getByRole("button", { name: "User 1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
  });
  it("expires a ready native link without reading the CSV or endlessly polling metadata", async () => {
    vi.useFakeTimers();
    vi.mocked(api.createReportExport).mockResolvedValue({ id: "export-id" });
    vi.mocked(api.reportExportStatus).mockResolvedValue({ id: "export-id", status: "ready", rows: 3, bytes: 200,
      expiresAt: new Date(Date.now() + 3000).toISOString(), error: null, limit: null, observed: null });
    render(<ReportExportButton selectionId={selectionId} kind="official_users" label="Export" />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("link", { name: "Download CSV" })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
    expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("expired");
    expect(api.reportExportStatus).toHaveBeenCalledTimes(1);
  });
  it("cancels persisted queued work and stops metadata polling", async () => {
    vi.useFakeTimers();
    vi.mocked(api.createReportExport).mockResolvedValue({ id: "export-id" });
    vi.mocked(api.cancelReportExport).mockResolvedValue(undefined);
    vi.mocked(api.reportExportStatus).mockResolvedValue({ id: "export-id", status: "queued", rows: 0, bytes: 0,
      expiresAt: new Date(Date.now() + 1800000).toISOString(), error: null, limit: null, observed: null });
    render(<ReportExportButton selectionId={selectionId} kind="official_users" label="Export" />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(30000); });
    expect(api.cancelReportExport).toHaveBeenCalledExactlyOnceWith("export-id", expect.any(AbortSignal));
    expect(api.reportExportStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Export cancelled.");
  });
});
