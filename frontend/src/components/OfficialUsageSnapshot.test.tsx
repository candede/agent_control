import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportAgent, ReportPage } from "../../../backend/src/types/officialReportData";
import { ApiError } from "../api/client";
import * as api from "../api/reportData";
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
afterEach(() => { cleanup(); vi.resetAllMocks(); });

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
    await waitFor(() => expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.search).toBe("Helpdesk"));
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
    const pending = deferred<ReportPage<ReportAgent>>(); vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const view = render(<OfficialUsageSnapshot {...props} setId="A" />);
    const signal = vi.mocked(api.readReportPage).mock.calls[0][2];
    view.rerender(<OfficialUsageSnapshot {...props} setId="B" activityWindowDays={7} />);
    await screen.findByRole("button", { name: "Researcher" });
    expect(signal?.aborted).toBe(true);
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/aggregate",
      expect.objectContaining({ setId: "B", activityWindowDays: 7 }), expect.any(AbortSignal));
    await act(async () => pending.resolve(page("A", "Obsolete")));
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
  it("never substitutes the current set after an exact retained-set read fails", async () => {
    vi.mocked(api.readReportPage).mockRejectedValue(new ApiError(404, "report_set_unavailable", "Retained set unavailable"));
    render(<OfficialUsageSnapshot {...props} setId="retained" />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.readReportPage).mock.calls.every(call => call[1]?.setId === "retained")).toBe(true);
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
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
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.calls.every(([, query]) => query?.setId === "retained")).toBe(true);
  });
});
