import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportAgent, ReportPage } from "../../../backend/src/types/officialReportData";
import { ApiError } from "../api/client";
import * as api from "../api/reportData";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { reportAgent, reportPage, reports, reportSetId, selectionId } from "../test/reportDataFixture";
import { deferred } from "../test/deferred";
import { OfficialUsageSnapshot } from "./OfficialUsageSnapshot";
import { SavedQueryProvider } from "./SavedQueryProvider";

vi.mock("../api/reportData", async original => ({ ...await original<typeof import("../api/reportData")>(),
  readReportPage: vi.fn(), readReportDetail: vi.fn(), readReportFacet: vi.fn(),
  createReportExport: vi.fn(), reportExportStatus: vi.fn(), cancelReportExport: vi.fn() }));
const props = { activityWindowDays: 30, revision: 0, onBack: vi.fn() };
function page(setId = reportSetId, name = "Researcher") {
  return reportPage([reportAgent(1, { agentName: name })], { reports: { ...reports, setId },
    page: { limit: 50, nextCursor: "next", previousCursor: null } });
}
beforeEach(() => {
  vi.mocked(api.readReportPage).mockImplementation(async (path, query) => path.endsWith("/users") ? reportPage([]) : page(query?.setId));
  vi.mocked(api.readReportDetail).mockResolvedValue({ value: reportAgent(1, { agentName: "Researcher" }),
    reports, sources: page().sources, selection: page().selection });
  vi.mocked(api.readReportFacet).mockResolvedValue({ value: [], counts: { total: 0, filtered: 0 },
    page: { limit: 50, nextCursor: null, previousCursor: null }, selection: page().selection });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("exact selected snapshot inspection", () => {
  it("loads the exact set and requested activity window, tenant totals and lazy detail without changing the active set", async () => {
    render(<OfficialUsageSnapshot {...props} setId={reportSetId} activityWindowDays={7} />);
    expect(screen.getByRole("region", { name: "Snapshot inspection" })).toHaveAttribute("tabindex", "0");
    await screen.findByRole("button", { name: "Researcher" });
    expect(api.readReportPage).toHaveBeenCalledWith("official-usage/aggregate",
      expect.objectContaining({ setId: reportSetId, activityWindowDays: 7, limit: 50 }), expect.any(AbortSignal));
    expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("1,000,000");
    expect(screen.getByText(/does not change the selected report set/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Researcher" }));
    await within(screen.getByRole("region", { name: "Exact reported agent details" })).findByRole("heading", { name: "Researcher" });
    expect(api.readReportDetail).toHaveBeenCalledWith("official-usage/agents/agent-1", selectionId, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    expect(props.onBack).toHaveBeenCalledOnce();
  });
  it("resets cursors when search, sort or dates change and prevents reversed-date reads and exports", async () => {
    render(<OfficialUsageSnapshot {...props} />);
    await screen.findByRole("button", { name: "Researcher" });
    fireEvent.click(screen.getByRole("button", { name: "Next agents" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/aggregate",
      expect.objectContaining({ cursor: "next", selectionId }), expect.any(AbortSignal)));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents" }), { target: { value: "Helpdesk" } });
    await waitFor(() => expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.search).toBe("helpdesk"));
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.cursor).toBeUndefined();
    await userEvent.selectOptions(screen.getByLabelText("Sort agents"), "name:asc");
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/aggregate", expect.objectContaining({ sort: "name", order: "asc" }), expect.any(AbortSignal));
    fireEvent.change(screen.getByLabelText("Activity start date"), { target: { value: "2026-02-20" } });
    const before = vi.mocked(api.readReportPage).mock.calls.length;
    fireEvent.change(screen.getByLabelText("Activity end date"), { target: { value: "2026-02-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("start date must be on or before");
    expect(api.readReportPage).toHaveBeenCalledTimes(before);
    expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
  });
  it.each([401, 403])("removes all private snapshot evidence after status %s and retries the exact report without an obsolete selection", async status => {
    const view = render(<OfficialUsageSnapshot {...props} setId={reportSetId} />);
    await screen.findByRole("button", { name: "Researcher" });
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(status, "forbidden", "Snapshot access denied"));
    view.rerender(<OfficialUsageSnapshot {...props} setId={reportSetId} revision={1} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    const pending = deferred<ReportPage<ReportAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    await act(async () => pending.resolve(page()));
    await screen.findByRole("button", { name: "Researcher" });
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/aggregate", expect.objectContaining({ setId: reportSetId }), expect.any(AbortSignal));
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.selectionId).toBeUndefined();
  });
  it("honors changed controlled windows and report IDs while ignoring an obsolete transport", async () => {
    const previousSetId = "a0000000-0000-4000-8000-000000000001", nextSetId = "b0000000-0000-4000-8000-000000000002";
    const pending = deferred<ReportPage<ReportAgent>>(); vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const view = render(<OfficialUsageSnapshot {...props} setId={previousSetId} />);
    const signal = vi.mocked(api.readReportPage).mock.calls[0][2];
    view.rerender(<OfficialUsageSnapshot {...props} setId={nextSetId.toUpperCase()} activityWindowDays={7} />);
    await screen.findByRole("button", { name: "Researcher" });
    expect(signal?.aborted).toBe(true);
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/aggregate",
      expect.objectContaining({ setId: nextSetId, activityWindowDays: 7 }), expect.any(AbortSignal));
    await act(async () => pending.resolve(page(previousSetId, "Obsolete")));
    expect(screen.queryByRole("button", { name: "Obsolete" })).not.toBeInTheDocument();
  });
  it("deduplicates concurrent snapshot reads and aborts the abandoned request on unmount", async () => {
    const pending = deferred<ReportPage<ReportAgent>>(); vi.mocked(api.readReportPage).mockReturnValue(pending.promise);
    const view = render(<SavedQueryProvider><OfficialUsageSnapshot {...props} /><OfficialUsageSnapshot {...props} /></SavedQueryProvider>);
    expect(api.readReportPage).toHaveBeenCalledOnce();
    const signal = vi.mocked(api.readReportPage).mock.calls[0][2];
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
  it("preserves an admitted creator-options read while paging the same selected snapshot", async () => {
    const options = deferred<Awaited<ReturnType<typeof api.readReportFacet>>>(), next = deferred<ReportPage<ReportAgent>>();
    vi.mocked(api.readReportFacet).mockReturnValueOnce(options.promise);
    render(<OfficialUsageSnapshot {...props} setId={reportSetId} />);
    await screen.findByRole("button", { name: "Researcher" });
    const signal = vi.mocked(api.readReportFacet).mock.lastCall?.[3]?.signal;
    vi.mocked(api.readReportPage).mockReturnValueOnce(next.promise);
    fireEvent.click(screen.getByRole("button", { name: "Next agents" }));
    expect(signal?.aborted).toBe(false);
    expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    await act(async () => options.resolve({ value: [{ value: "Your org", count: 10 }], counts: { total: 1, filtered: 1 },
      page: { limit: 50, nextCursor: null, previousCursor: null }, selection: page().selection }));
    await screen.findByRole("option", { name: "Your org (10)" });
    await act(async () => next.resolve(page()));
    await screen.findByRole("button", { name: "Researcher" });
    expect(api.readReportFacet).toHaveBeenCalledOnce();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });
  it.each(["building", "ready"] as const)("preserves facet paging and a %s export across same-selection agent pagination", async status => {
    vi.useFakeTimers();
    vi.mocked(api.readReportFacet).mockImplementation(async (_path, _id, _field, options) => ({
      value: [{ value: options?.cursor ? "Tail creator" : "First creator", count: 10 }], counts: { total: 100, filtered: 100 },
      page: { limit: 50, nextCursor: options?.cursor ? null : "creator-next", previousCursor: options?.cursor ? "creator-previous" : null },
      selection: page().selection,
    }));
    vi.mocked(api.createReportExport).mockResolvedValue({ id: "snapshot-export" });
    vi.mocked(api.reportExportStatus).mockResolvedValue({ id: "snapshot-export", status, rows: 10, bytes: 100,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), error: null, limit: null, observed: null });
    render(<OfficialUsageSnapshot {...props} setId={reportSetId} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next creator type options" }));
      fireEvent.click(screen.getByRole("button", { name: "Export agent CSV" }));
      await vi.advanceTimersByTimeAsync(2001);
    });
    const signal = vi.mocked(api.createReportExport).mock.lastCall?.[1], next = deferred<ReportPage<ReportAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(next.promise);
    fireEvent.click(screen.getByRole("button", { name: "Next agents" }));
    expect(signal?.aborted).toBe(false);
    expect(screen.getByRole("option", { name: "Tail creator (10)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel export" })).toBeEnabled();
    if (status === "ready") expect(screen.getByRole("link", { name: "Download CSV" })).toBeVisible();
    await act(async () => { next.resolve(page()); await vi.advanceTimersByTimeAsync(1); });
    expect(api.readReportFacet).toHaveBeenCalledTimes(2);
    expect(api.createReportExport).toHaveBeenCalledOnce();
    expect(screen.getByRole("option", { name: "Tail creator (10)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous creator type options" })).toBeEnabled();
  });
  it.each(["facet", "export"] as const)("retires a pending page when its preserved %s rejects the selection, without automatic replay", async child => {
    const options = deferred<Awaited<ReturnType<typeof api.readReportFacet>>>(), admission = deferred<{ id: string }>();
    const next = deferred<ReportPage<ReportAgent>>();
    vi.mocked(api.readReportFacet).mockReturnValueOnce(options.promise);
    vi.mocked(api.createReportExport).mockReturnValueOnce(admission.promise);
    render(<OfficialUsageSnapshot {...props} setId={reportSetId} />);
    await screen.findByRole("button", { name: "Researcher" });
    fireEvent.click(screen.getByRole("button", { name: "Export agent CSV" }));
    vi.mocked(api.readReportPage).mockReturnValueOnce(next.promise);
    fireEvent.click(screen.getByRole("button", { name: "Next agents" }));
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    await act(async () => (child === "facet" ? options : admission).reject(
      new ApiError(409, "selection_invalidated", "Snapshot selection retired")));
    expect(await screen.findByRole("alert")).toHaveTextContent("This selection changed or expired");
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole("region", { name: "Reported agent activity" })).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
    await act(async () => next.resolve(page()));
    fireEvent.focus(window);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    await screen.findByRole("button", { name: "Researcher" });
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]).toMatchObject({ setId: reportSetId });
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.selectionId).toBeUndefined();
    expect(api.createReportExport).toHaveBeenCalledOnce();
  });
  it.each(["revision", "report", "account", "roles", "session", "search", "dates", "failure", "invalidation", "expiry"] as const)(
    "preserves lease-end work but retires it on a %s boundary during pagination", async boundary => {
      vi.useFakeTimers();
      const initial = page(), next = deferred<ReportPage<ReportAgent>>(), replacement = deferred<ReportPage<ReportAgent>>();
      if (boundary === "expiry") initial.selection = { ...initial.selection, validatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString() };
      const options = deferred<Awaited<ReturnType<typeof api.readReportFacet>>>(), exact = deferred<Awaited<ReturnType<typeof api.readReportDetail>>>();
      const admission = deferred<{ id: string }>();
      vi.mocked(api.readReportPage).mockResolvedValueOnce(initial).mockReturnValueOnce(next.promise).mockReturnValue(replacement.promise);
      vi.mocked(api.readReportFacet).mockReturnValueOnce(options.promise);
      vi.mocked(api.readReportDetail).mockReturnValueOnce(exact.promise);
      vi.mocked(api.createReportExport).mockReturnValueOnce(admission.promise);
      const capability: ReturnType<typeof useCapabilityContext> = {
        user: { tenantId: "tenant", homeAccountId: "first", username: "viewer@example.invalid", displayName: "Viewer", roles: ["AgentControl.Viewer"] },
        now: Date.now(), views: [], loading: false, pending: false, error: undefined, reload: vi.fn(async () => {}), openPermissions: vi.fn(),
      };
      const panel = (changed = false) => <SavedQueryProvider><CapabilityContext key={changed && boundary === "session" ? 1 : 0}
        value={{ ...capability, user: { ...capability.user!, homeAccountId: changed && boundary === "account" ? "second" : "first",
          roles: changed && boundary === "roles" ? ["AgentControl.Admin"] : capability.user!.roles } }}>
        <OfficialUsageSnapshot {...props} revision={changed && boundary === "revision" ? 1 : 0}
          setId={changed && boundary === "report" ? "a0000000-0000-4000-8000-000000000009" : reportSetId} />
      </CapabilityContext></SavedQueryProvider>;
      const view = render(panel());
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      fireEvent.click(screen.getByRole("button", { name: "Researcher" }));
      fireEvent.click(screen.getByRole("button", { name: "Export agent CSV" }));
      fireEvent.click(screen.getByRole("button", { name: "Next agents" }));
      const pageSignal = vi.mocked(api.readReportPage).mock.lastCall?.[2], facetSignal = vi.mocked(api.readReportFacet).mock.lastCall?.[3]?.signal;
      const detailSignal = vi.mocked(api.readReportDetail).mock.lastCall?.[2], exportSignal = vi.mocked(api.createReportExport).mock.lastCall?.[1];
      expect(facetSignal?.aborted).toBe(false);
      expect(detailSignal?.aborted).toBe(false);
      expect(exportSignal?.aborted).toBe(false);
      await act(async () => {
        if (boundary === "search") fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "Changed filter" } });
        else if (boundary === "dates") fireEvent.change(screen.getByLabelText("Activity start date"), { target: { value: "2026-01-01" } });
        else if (boundary === "failure" || boundary === "invalidation") next.reject(new ApiError(boundary === "failure" ? 403 : 409,
          boundary === "failure" ? "forbidden" : "selection_invalidated", "Snapshot no longer available"));
        else if (boundary === "expiry") await vi.advanceTimersByTimeAsync(1000);
        else view.rerender(panel(true));
        await vi.advanceTimersByTimeAsync(1);
      });
      if (boundary === "expiry") {
        expect(pageSignal?.aborted).toBe(false);
        expect(facetSignal?.aborted).toBe(false);
        expect(detailSignal?.aborted).toBe(false);
        expect(exportSignal?.aborted).toBe(false);
        expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toBeVisible();
        expect(screen.getByRole("button", { name: "Cancel export" })).toBeVisible();
        await act(async () => {
          next.resolve(initial);
          exact.resolve({ value: reportAgent(1), reports, sources: initial.sources, selection: initial.selection });
          await vi.advanceTimersByTimeAsync(1);
        });
        expect(screen.getByRole("button", { name: "Researcher" })).toBeVisible();
        expect(screen.getByRole("region", { name: "Exact reported agent details" })).toBeVisible();
        expect(api.readReportPage).toHaveBeenCalledTimes(3);
        expect(api.createReportExport).toHaveBeenCalledOnce();
        return;
      }
      if (boundary !== "failure" && boundary !== "invalidation") expect(pageSignal?.aborted).toBe(true);
      expect(facetSignal?.aborted).toBe(true);
      expect(detailSignal?.aborted).toBe(true);
      expect(exportSignal?.aborted).toBe(true);
      expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel export" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
      await act(async () => {
        next.resolve(initial);
        options.resolve({ value: [{ value: "Obsolete creator", count: 10 }], counts: { total: 1, filtered: 1 },
          page: { limit: 50, nextCursor: null, previousCursor: null }, selection: initial.selection });
        exact.resolve({ value: reportAgent(1), reports, sources: initial.sources, selection: initial.selection });
        admission.resolve({ id: "obsolete-export" });
        await vi.advanceTimersByTimeAsync(2001);
      });
      expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /Obsolete creator/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
      expect(api.reportExportStatus).not.toHaveBeenCalled();
      expect(api.createReportExport).toHaveBeenCalledOnce();
    },
  );
  it("never substitutes the current set after an exact retained-set read fails", async () => {
    vi.mocked(api.readReportPage).mockRejectedValue(new ApiError(404, "report_set_unavailable", "Retained set unavailable"));
    render(<OfficialUsageSnapshot {...props} setId="retained" />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.readReportPage).mock.calls.every(call => call[1]?.setId === "retained")).toBe(true);
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
  });
  it("does not let focus bypass explicit replacement after snapshot invalidation", async () => {
    vi.mocked(api.readReportPage).mockRejectedValue(new ApiError(409, "selection_invalidated", "Retained snapshot expired"));
    render(<OfficialUsageSnapshot {...props} setId={reportSetId} />);
    await screen.findByRole("button", { name: "Restart selection" });
    expect(api.readReportPage).toHaveBeenCalledOnce();
    fireEvent.focus(window);
    await act(async () => {});
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(screen.getByRole("region", { name: "Reported agent activity" })).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
    expect(api.readReportFacet).not.toHaveBeenCalled();
    vi.mocked(api.readReportPage).mockResolvedValue(page());
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    await screen.findByRole("button", { name: "Researcher" });
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]).toMatchObject({ setId: reportSetId });
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.selectionId).toBeUndefined();
  });
  it("preserves explicitly retained immutable tenant totals on a filter transport failure but never stale rows or export", async () => {
    render(<OfficialUsageSnapshot {...props} setId="retained" />);
    await screen.findByRole("button", { name: "Researcher" });
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(0, "network_error", "Search unavailable"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents" }), { target: { value: "Changed filter" } });
    await screen.findByRole("alert");
    expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("1,000,000");
    expect(screen.getByText(/previously read snapshot totals/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
  });
  it.each([
    { phase: "pending", clock: "timer" }, { phase: "failed", clock: "timer" }, { phase: "pending", clock: "focus" },
  ] as const)("retains authorized historical totals on $clock while the replacement filter read is $phase without replaying it", async ({ phase, clock }) => {
    vi.useFakeTimers();
    const initial = page(), replacement = deferred<ReportPage<ReportAgent>>();
    initial.selection = { ...initial.selection, expiresAt: new Date(Date.now() + 1000).toISOString() };
    vi.mocked(api.readReportPage).mockResolvedValueOnce(initial).mockReturnValueOnce(replacement.promise);
    render(<OfficialUsageSnapshot {...props} setId={reportSetId} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "Changed filter" } });
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    if (phase === "failed") await act(async () => {
      replacement.reject(new ApiError(0, "network_error", "Filter read unavailable"));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toBeVisible();
    await act(async () => {
      if (clock === "timer") await vi.advanceTimersByTimeAsync(1000);
      else { vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1000); fireEvent.focus(window); }
    });
    expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    if (phase === "pending") {
      expect(signal?.aborted).toBe(false);
      expect(screen.getByText("Loading saved data...")).toBeVisible();
      await act(async () => { replacement.resolve(page()); await vi.advanceTimersByTimeAsync(1); });
      expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Researcher" })).toBeVisible();
    } else expect(screen.getByRole("alert")).toHaveTextContent("Filter read unavailable");
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });
  it.each(["report", "window"] as const)("does not revive totals after an abandoned %s A-B-A transition", async boundary => {
    const abandoned = deferred<ReportPage<ReportAgent>>(), replacement = deferred<ReportPage<ReportAgent>>();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page()).mockReturnValueOnce(abandoned.promise).mockReturnValueOnce(replacement.promise);
    const view = render(<OfficialUsageSnapshot {...props} setId={reportSetId} />);
    await screen.findByRole("button", { name: "Researcher" });
    view.rerender(<OfficialUsageSnapshot {...props}
      setId={boundary === "report" ? "10000000-0000-4000-8000-000000000009" : reportSetId}
      activityWindowDays={boundary === "window" ? 7 : props.activityWindowDays} />);
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    const obsoleteSignal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    view.rerender(<OfficialUsageSnapshot {...props} setId={reportSetId} />);
    expect(obsoleteSignal?.aborted).toBe(true);
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    await act(async () => abandoned.resolve(page()));
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    await act(async () => replacement.resolve(page()));
    expect(await screen.findByRole("region", { name: "Snapshot tenant totals" })).toBeVisible();
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
  });
  it("does not use retained totals or replay a read after a fenced serialization conflict", async () => {
    const view = render(<OfficialUsageSnapshot {...props} setId="retained" />);
    await screen.findByRole("button", { name: "Researcher" });
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(503, "data_read_conflict", "The selected read conflicted"));
    view.rerender(<OfficialUsageSnapshot {...props} setId="retained" revision={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("selected read conflicted");
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });
  it("isolates a new revision from an older request retained by another observer", async () => {
    const pending = deferred<ReportPage<ReportAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise).mockResolvedValue(page(reportSetId, "Current"));
    const panels = (revision: number) => <SavedQueryProvider>
      <section aria-label="Previous"><OfficialUsageSnapshot {...props} /></section>
      <section aria-label="Current"><OfficialUsageSnapshot {...props} revision={revision} /></section>
    </SavedQueryProvider>;
    const view = render(panels(0));
    expect(api.readReportPage).toHaveBeenCalledOnce();
    view.rerender(panels(1));
    await within(screen.getByRole("region", { name: "Current" })).findByRole("button", { name: "Current" });
    await act(async () => pending.resolve(page(reportSetId, "Previous")));
    await within(screen.getByRole("region", { name: "Previous" })).findByRole("button", { name: "Previous" });
    expect(within(screen.getByRole("region", { name: "Current" })).queryByRole("button", { name: "Previous" })).not.toBeInTheDocument();
  });
  it("aborts a pending read when dates become reversed and ignores its eventual rows", async () => {
    render(<OfficialUsageSnapshot {...props} />);
    await screen.findByRole("button", { name: "Researcher" });
    const pending = deferred<ReportPage<ReportAgent>>(); vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    fireEvent.change(screen.getByLabelText("Activity start date"), { target: { value: "2026-02-20" } });
    const signal = vi.mocked(api.readReportPage).mock.calls.at(-1)?.[2];
    fireEvent.change(screen.getByLabelText("Activity end date"), { target: { value: "2026-02-01" } });
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(page(reportSetId, "Obsolete")));
    expect(screen.queryByRole("button", { name: "Obsolete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
  });
  it.each([reportSetId, null])("rejects response set %s for another explicitly requested retained set", async setId => {
    vi.mocked(api.readReportPage).mockResolvedValue({ ...page(), reports: { ...reports, setId } });
    render(<OfficialUsageSnapshot {...props} setId="retained" />);
    await screen.findByRole("button", { name: "Restart selection" });
    expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(vi.mocked(api.readReportPage).mock.calls.every(([, query]) => query?.setId === "retained")).toBe(true);
  });
});
