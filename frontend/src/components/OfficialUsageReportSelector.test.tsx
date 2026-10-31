import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportMetadata } from "../../../backend/src/types/officialReportData";
import { ApiError } from "../api/client";
import * as api from "../api/reportData";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { historySet, reportPage, reportSelection, reports, selectionId } from "../test/reportDataFixture";
import { deferred } from "../test/deferred";
import { createSavedQueryClient } from "../savedQueries";
import { OfficialUsageReportSelector } from "./OfficialUsageReportSelector";

vi.mock("../api/reportData", async original => ({ ...await original<typeof import("../api/reportData")>(),
  readReportPage: vi.fn(), previewReportDeletion: vi.fn(), confirmReportDeletion: vi.fn() }));
const latest = historySet(1, { reportingStart: "2026-02-01", reportingEnd: "2026-02-28" });
const older = historySet(2, { reportingStart: "2026-01-01", reportingEnd: "2026-01-31", periodProvenance: "activity_range" });
let metadata: ReportMetadata;
const viewer: ReturnType<typeof useCapabilityContext> = { user: { tenantId: "tenant", homeAccountId: "principal", displayName: "Viewer",
  username: "viewer@example.invalid", roles: ["AgentControl.Viewer"] }, loading: false, pending: false,
  error: undefined, now: Date.now(), views: [], reload: vi.fn(async () => {}), openPermissions: vi.fn() };
function page(setId = latest.id) {
  const set = setId === older.id ? older : latest;
  return reportPage([latest, older], { reports: { ...metadata, setId,
    reportingPeriod: { startDate: set.reportingStart!, endDate: set.reportingEnd!, days: 28, provenance: setId === older.id ? "activity_range" : "operator_asserted" } },
    counts: { total: 2, filtered: 2 } });
}
function Harness({ initialId, onSelect = vi.fn(), onLatestReportObserved = vi.fn(), principalKey = "viewer", revision = 0 }: {
  initialId?: string; onSelect?: (id: string | undefined) => void;
  onLatestReportObserved?: (id: string | null, revision: string) => void; principalKey?: string; revision?: number;
}) {
  const [selectedId, setSelectedId] = useState(initialId);
  return <OfficialUsageReportSelector principalKey={principalKey} revision={revision} selectedId={selectedId}
    onSelect={id => { setSelectedId(id); onSelect(id); }} onLatestReportObserved={onLatestReportObserved} />;
}
async function ready() {
  const select = screen.getByRole("combobox", { name: "Report set" });
  await waitFor(() => expect(select).toBeEnabled());
  return select;
}
beforeEach(() => {
  metadata = { ...reports, activeSetId: latest.id, setId: latest.id };
  vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => page(query?.setId));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); });

describe("personal saved report selection", () => {
  it("reads bounded metadata-only options and starts in live Latest mode", async () => {
    const { value, page: navigation, counts, selection, reports } = page();
    vi.mocked(api.readReportPage).mockResolvedValue({ value, page: navigation, counts, selection, reports });
    const observed = vi.fn();
    render(<Harness onLatestReportObserved={observed} />);
    const select = await ready();
    expect(api.readReportPage).toHaveBeenCalledExactlyOnceWith("official-usage/history/options",
      { sort: "reportingPeriod", order: "desc", setId: undefined, limit: 50 }, expect.any(AbortSignal));
    expect(select).toHaveValue("");
    expect(within(select).getByRole("option", { name: /Latest report.*2026-02-01/ })).toBeVisible();
    expect(within(select).getByRole("option", { name: /Observed activity.*2026-01-01/ })).toBeVisible();
    await waitFor(() => expect(observed).toHaveBeenCalledWith(latest.id, metadata.activeRevision));
    expect(api.previewReportDeletion).not.toHaveBeenCalled();
    expect(api.confirmReportDeletion).not.toHaveBeenCalled();
  });

  it.each(["Viewer", "Admin"] as const)("lets a %s choose personally without preview, confirmation or tenant writes", async role => {
    const onSelect = vi.fn();
    const context: ReturnType<typeof useCapabilityContext> = { ...viewer, user: { ...viewer.user!,
      roles: role === "Admin" ? ["AgentControl.Viewer", "AgentControl.Admin"] : ["AgentControl.Viewer"] } };
    render(<CapabilityContext.Provider value={context}><Harness onSelect={onSelect} /></CapabilityContext.Provider>);
    await userEvent.selectOptions(await ready(), older.id);
    await waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith(older.id));
    expect(await ready()).toHaveValue(older.id);
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/history/options",
      expect.objectContaining({ setId: older.id }), expect.any(AbortSignal));
    expect(metadata.activeSetId).toBe(latest.id);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/administrator can change/)).not.toBeInTheDocument();
    expect(api.previewReportDeletion).not.toHaveBeenCalled();
    expect(api.confirmReportDeletion).not.toHaveBeenCalled();
  });

  it("returns to live Latest rather than pinning today's latest ID", async () => {
    const onSelect = vi.fn();
    render(<Harness initialId={older.id} onSelect={onSelect} />);
    expect(await ready()).toHaveValue(older.id);
    await userEvent.selectOptions(await ready(), "");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(await ready()).toHaveValue("");
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/history/options",
      expect.objectContaining({ setId: undefined }), expect.any(AbortSignal));
  });

  it("can deliberately pin the currently latest report without confusing that with Latest mode", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await userEvent.selectOptions(await ready(), latest.id);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(latest.id);
    expect(await ready()).toHaveValue(latest.id);
  });

  it("keeps two readers' choices separate and leaves the shared default unchanged", async () => {
    render(<><div data-testid="one"><Harness principalKey="one" /></div><div data-testid="two"><Harness principalKey="two" /></div></>);
    const one = within(screen.getByTestId("one")).getByRole("combobox");
    const two = within(screen.getByTestId("two")).getByRole("combobox");
    await waitFor(() => { expect(one).toBeEnabled(); expect(two).toBeEnabled(); });
    await userEvent.selectOptions(one, older.id);
    await waitFor(() => expect(one).toBeEnabled());
    expect(one).toHaveValue(older.id);
    expect(two).toHaveValue("");
    expect(metadata.activeSetId).toBe(latest.id);
  });

  it("pages by an opaque cursor without draining history or changing the personal choice", async () => {
    const outside = historySet(99), next = historySet(33), onSelect = vi.fn();
    vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => reportPage(query?.cursor === "older" ? [next] : [latest, older], {
      reports: { ...metadata, setId: outside.id }, counts: { total: 100000, filtered: 100000 },
      page: { limit: 50, nextCursor: query?.cursor ? null : "older", previousCursor: query?.cursor ? "newer" : null },
    }));
    render(<Harness initialId={outside.id} onSelect={onSelect} />);
    expect(await ready()).toHaveValue(outside.id);
    expect(screen.getByRole("option", { name: /outside this page/ })).toBeVisible();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    await userEvent.selectOptions(await ready(), "older-reports");
    await waitFor(() => expect(screen.getByRole("combobox")).toContainHTML(next.id));
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/history/options",
      expect.objectContaining({ setId: outside.id, selectionId, cursor: "older", limit: 50 }), expect.any(AbortSignal));
    expect(onSelect).not.toHaveBeenCalled();
    expect(await ready()).toHaveValue(outside.id);
    await userEvent.selectOptions(await ready(), next.id);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(next.id);
  });

  it("normalizes case-equivalent report IDs without duplicate options", async () => {
    const alpha = historySet(3, { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    vi.mocked(api.readReportPage).mockResolvedValue(reportPage([alpha], { reports: { ...metadata, setId: alpha.id } }));
    render(<Harness initialId={alpha.id.toUpperCase()} />);
    expect(await ready()).toHaveValue(alpha.id);
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("disables changes while metadata for a new personal choice is pending", async () => {
    const pending = deferred<ReturnType<typeof page>>();
    render(<Harness />);
    await ready();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    await userEvent.selectOptions(await ready(), older.id);
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("combobox")).toHaveValue(older.id);
    await act(async () => pending.resolve(page(older.id)));
    expect(await ready()).toHaveValue(older.id);
  });

  it("explicitly reports an unavailable personal report and automatically returns to Latest", async () => {
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(404, "usage_report_unavailable", "Report no longer available."));
    const onSelect = vi.fn();
    render(<Harness initialId={older.id} onSelect={onSelect} />);
    expect(await ready()).toHaveValue("");
    expect(screen.getByText(/no longer available.*latest available/i)).toBeVisible();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(api.confirmReportDeletion).not.toHaveBeenCalled();
  });

  it.each([
    new ApiError(409, "selection_invalidated", "This saved read changed."),
    new ApiError(503, "service_unavailable", "Report service unavailable."),
    new ApiError(404, "other_not_found", "A different resource is absent."),
  ])("never mistakes an unrelated read failure for a missing personal report: %s", async failure => {
    vi.mocked(api.readReportPage).mockRejectedValueOnce(failure);
    const onSelect = vi.fn();
    render(<Harness initialId={older.id} onSelect={onSelect} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(failure.code === "selection_invalidated" ? "selection changed or expired" : failure.message);
    expect(screen.getByRole("combobox")).toHaveValue(older.id);
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("retries a failed options read without changing the personal choice", async () => {
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new Error("Options unavailable"));
    const onSelect = vi.fn();
    render(<Harness initialId={older.id} onSelect={onSelect} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    expect(await ready()).toHaveValue(older.id);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([401, 403])("withdraws history after a %s denial and does not poll or expose retained labels", async status => {
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(status, "forbidden", "Report access denied"));
    const onSelect = vi.fn();
    const view = render(<Harness initialId={older.id} onSelect={onSelect} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Report access denied");
    view.rerender(<Harness initialId={older.id} onSelect={onSelect} revision={1} />);
    fireEvent.focus(window);
    expect(screen.queryByRole("option", { name: /2026-01-01/ })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    expect(await ready()).toHaveValue(older.id);
  });

  it.each([401, 403])("retries a retained %s denial after a report revision without changing the personal choice", async status => {
    const client = createSavedQueryClient(), onSelect = vi.fn();
    const view = render(<QueryClientProvider client={client}>
      <Harness initialId={older.id} onSelect={onSelect} />
    </QueryClientProvider>);
    expect(await ready()).toHaveValue(older.id);
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(status, "forbidden", "Report access denied"));
    view.rerender(<QueryClientProvider client={client}>
      <Harness initialId={older.id} onSelect={onSelect} revision={1} />
    </QueryClientProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Report access denied");
    expect(screen.queryByRole("option", { name: /2026-01-01/ })).not.toBeInTheDocument();
    fireEvent.focus(window);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    expect(await ready()).toHaveValue(older.id);
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.selectionId).toBeUndefined();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("can restart a denied options read after its previously captured selection expires", async () => {
    vi.useFakeTimers();
    const client = createSavedQueryClient(), onSelect = vi.fn(), initial = page(older.id);
    initial.selection = reportSelection(8, Date.now());
    initial.selection.expiresAt = new Date(Date.now() + 1000).toISOString();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new ApiError(403, "forbidden", "Report access denied"));
    render(<QueryClientProvider client={client}>
      <Harness initialId={older.id} onSelect={onSelect} />
    </QueryClientProvider>);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("combobox")).toBeEnabled();
    await act(() => client.refetchQueries());
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole("alert")).toHaveTextContent("Report access denied");
    expect(screen.getByRole("combobox")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("combobox")).toBeEnabled();
    expect(screen.getByRole("combobox")).toHaveValue(older.id);
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("preserves Viewer choice when Admin is removed, and withdraws when Viewer is removed", async () => {
    const context: ReturnType<typeof useCapabilityContext> = { ...viewer, user: { ...viewer.user!, roles: ["AgentControl.Viewer", "AgentControl.Admin"] } };
    const view = render(<CapabilityContext.Provider value={context}><Harness initialId={older.id} /></CapabilityContext.Provider>);
    expect(await ready()).toHaveValue(older.id);
    view.rerender(<CapabilityContext.Provider value={viewer}><Harness initialId={older.id} /></CapabilityContext.Provider>);
    expect(await ready()).toHaveValue(older.id);
    view.rerender(<CapabilityContext.Provider value={{ ...viewer, user: { ...viewer.user!, roles: [] } }}>
      <Harness initialId={older.id} /></CapabilityContext.Provider>);
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.queryByRole("option", { name: /2026-01-01/ })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Viewer access");
  });

  it("refreshes the automatic default on focus without changing a pinned personal choice", async () => {
    const observed = vi.fn(), onSelect = vi.fn();
    render(<Harness initialId={older.id} onSelect={onSelect} onLatestReportObserved={observed} />);
    await ready();
    metadata = { ...metadata, activeRevision: "5", activeSetId: historySet(8).id };
    fireEvent.focus(window);
    await waitFor(() => expect(observed).toHaveBeenCalledWith(metadata.activeSetId, "5"));
    expect(await ready()).toHaveValue(older.id);
    expect(onSelect).not.toHaveBeenCalled();
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.selectionId).toBeUndefined();
  });

  it("checks the latest default automatically once a minute without provider-read permissions", async () => {
    vi.useFakeTimers();
    const observed = vi.fn();
    render(<CapabilityContext.Provider value={viewer}><Harness onLatestReportObserved={observed} /></CapabilityContext.Provider>);
    await act(() => vi.advanceTimersByTimeAsync(1));
    metadata = { ...metadata, activeRevision: "5", activeSetId: historySet(8).id };
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(observed).toHaveBeenCalledWith(metadata.activeSetId, "5");
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.selectionId).toBeUndefined();
  });

  it("quietly renews expired options while keeping their labels and personal selection", async () => {
    vi.useFakeTimers();
    const initial = page(older.id), pending = deferred<ReturnType<typeof page>>(), onSelect = vi.fn();
    initial.selection = reportSelection(2, Date.now());
    initial.selection.expiresAt = new Date(Date.now() + 1000).toISOString();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(initial).mockReturnValueOnce(pending.promise);
    render(<Harness initialId={older.id} onSelect={onSelect} />);
    await act(() => vi.advanceTimersByTimeAsync(1));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    const select = screen.getByRole("combobox");
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(select).toHaveValue(older.id);
    expect(select).toBeDisabled();
    expect(within(select).getByRole("option", { name: /Observed activity.*2026-01-01/ })).toBeInTheDocument();
    await act(async () => { pending.resolve({ ...page(older.id), selection: reportSelection(9, Date.now()) }); await vi.advanceTimersByTimeAsync(1); });
    expect(select).toBeEnabled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not allow a late unavailable response from an obsolete principal to change the replacement reader", async () => {
    const pending = deferred<ReturnType<typeof page>>(), oldSelect = vi.fn(), newSelect = vi.fn();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const view = render(<Harness key="one" principalKey="one" initialId={older.id} onSelect={oldSelect} />);
    view.rerender(<Harness key="two" principalKey="two" onSelect={newSelect} />);
    await ready();
    await act(async () => pending.reject(new ApiError(404, "usage_report_unavailable", "Old report unavailable")));
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(oldSelect).not.toHaveBeenCalled();
    expect(newSelect).not.toHaveBeenCalled();
  });

  it("freshly observes the default on a later visit instead of recycling an old metadata capture", async () => {
    const client = createSavedQueryClient(), observed = vi.fn();
    const view = render(<QueryClientProvider client={client}><Harness onLatestReportObserved={observed} /></QueryClientProvider>);
    await ready();
    view.unmount();
    metadata = { ...metadata, activeRevision: "5", activeSetId: historySet(8).id };
    render(<QueryClientProvider client={client}><Harness onLatestReportObserved={observed} /></QueryClientProvider>);
    await ready();
    expect(observed).toHaveBeenCalledWith(metadata.activeSetId, "5");
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });

  it("shows empty history truthfully without pretending there is a selected report", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(reportPage([], { reports: { ...metadata, activeSetId: null, setId: null },
      counts: { total: 0, filtered: 0 } }));
    render(<Harness />);
    expect(await screen.findByRole("option", { name: "Latest report - no reports available" })).toBeVisible();
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(api.confirmReportDeletion).not.toHaveBeenCalled();
  });
});
