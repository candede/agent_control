import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficialReportConfirmation, OfficialReportConfirmed } from "../../../backend/src/types/officialReportApi";
import type { ReportMetadata } from "../../../backend/src/types/officialReportData";
import { ApiError } from "../api/client";
import * as api from "../api/reportData";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { historySet, reportPage, reports, selectionId } from "../test/reportDataFixture";
import { deferred } from "../test/deferred";
import { OfficialUsageReportSelector } from "./OfficialUsageReportSelector";

vi.mock("../api/reportData", async original => ({ ...await original<typeof import("../api/reportData")>(),
  readReportPage: vi.fn(), previewReportOperation: vi.fn(), confirmReportOperation: vi.fn() }));
const first = historySet(1, { periodProvenance: "activity_range" }), second = historySet(2, { reportingStart: "2026-02-01", reportingEnd: "2026-02-28" });
let metadata: ReportMetadata;
function confirmation(setId = second.id): OfficialReportConfirmation {
  return { id: "confirmation", operation: "select", setId, activeRevision: metadata.activeRevision,
    historyRevision: metadata.historyRevision, historyEpoch: metadata.historyEpoch, hash: "a".repeat(64) };
}
function page() { return reportPage([first, second], { reports: metadata, counts: { total: 2, filtered: 2 } }); }
const admin: ReturnType<typeof useCapabilityContext> = { user: { tenantId: "tenant", homeAccountId: "principal", displayName: "Admin",
  username: "admin@example.invalid", roles: ["AgentControl.Viewer", "AgentControl.Admin"] }, loading: false, pending: false,
  error: undefined, now: Date.now(), views: [], reload: vi.fn(async () => {}), openPermissions: vi.fn() };
async function ready() {
  const select = screen.getByRole("combobox", { name: "Report set" });
  await waitFor(() => expect(select).toBeEnabled());
  return select;
}
async function choose() {
  const select = await ready();
  await userEvent.selectOptions(select, second.id);
  return select;
}
beforeEach(() => {
  metadata = { ...reports };
  vi.mocked(api.readReportPage).mockImplementation(async () => page());
  vi.mocked(api.previewReportOperation).mockImplementation(async id => confirmation(id));
  vi.mocked(api.confirmReportOperation).mockImplementation(async input => {
    metadata = { ...metadata, activeSetId: input.setId, setId: input.setId, activeRevision: String(Number(metadata.activeRevision) + 1) };
    return { activeSetId: metadata.activeSetId, activeRevision: metadata.activeRevision };
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("compact shared report-set selection", () => {
  it("uses metadata-only options without requiring analytics or user sources", async () => {
    const { value, page: navigation, counts, selection, reports } = page();
    vi.mocked(api.readReportPage).mockResolvedValue({ value, page: navigation, counts, selection, reports });
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    await ready();
    expect(api.readReportPage).toHaveBeenCalledExactlyOnceWith("official-usage/history/options",
      { sort: "acceptedAt", order: "desc", limit: 50 }, expect.any(AbortSignal));
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });
  it("applies the chosen report through an exact fenced preview without adding a confirmation panel", async () => {
    const onChanged = vi.fn();
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={onChanged} />);
    const select = await ready();
    expect(within(select).getByRole("option", { name: /Observed activity: 2026-01-01 to 2026-01-31/ })).toBeVisible();
    expect(within(select).getByRole("option", { name: /Reporting window: 2026-02-01 to 2026-02-28/ })).toBeVisible();
    await userEvent.selectOptions(select, second.id);
    expect(api.previewReportOperation).toHaveBeenCalledWith(second.id, "select", expect.any(AbortSignal));
    expect(screen.queryByRole("region", { name: "Confirm report selection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByText(/matching report sets/)).not.toBeInTheDocument();
    await waitFor(() => expect(onChanged).toHaveBeenCalledExactlyOnceWith(true));
    expect(api.confirmReportOperation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      setId: second.id, operation: "select", activeRevision: "4", historyRevision: "35", historyEpoch: "2", hash: "a".repeat(64),
    }), expect.any(AbortSignal));
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue(second.id);
    await userEvent.selectOptions(select, second.id);
    expect(api.previewReportOperation).toHaveBeenCalledOnce();
  });
  it("keeps the dropdown disabled while the selected report is being verified and applied", async () => {
    const pending = deferred<OfficialReportConfirmation>();
    vi.mocked(api.previewReportOperation).mockReturnValueOnce(pending.promise);
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    const select = await choose();
    expect(select).toBeDisabled();
    expect(select).toHaveValue(second.id);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    await act(async () => pending.resolve(confirmation()));
    await ready();
    expect(api.confirmReportOperation).toHaveBeenCalledOnce();
    select.focus();
    expect(select).toHaveFocus();
  });
  it.each([first.id, ""])("does not mutate when choosing the current report or placeholder: %s", async value => {
    const onChanged = vi.fn();
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={onChanged} />);
    const select = await ready();
    fireEvent.change(select, { target: { value } });
    expect(select).toHaveValue(first.id);
    expect(screen.queryByRole("region", { name: "Confirm report selection" })).not.toBeInTheDocument();
    expect(api.previewReportOperation).not.toHaveBeenCalled();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
  it("pages by opaque cursor, keeps an active report outside this page and never drains retained history", async () => {
    const outside = historySet(99).id, older = historySet(33);
    metadata = { ...metadata, activeSetId: outside };
    vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => reportPage(query?.cursor ? [older] : [first, second], {
      reports: metadata, counts: { total: 100000, filtered: 100000 },
      page: { limit: 50, nextCursor: query?.cursor ? null : "older", previousCursor: query?.cursor ? "newer" : null },
    }));
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    await ready();
    expect(screen.getByRole("option", { name: `Current report ${outside.slice(0, 8)} (outside this page) - selected` })).toBeVisible();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    await userEvent.selectOptions(await ready(), "older-reports");
    await waitFor(() => expect(screen.getByRole("combobox")).toContainHTML(older.id));
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/history/options", expect.objectContaining({ selectionId, cursor: "older", limit: 50 }), expect.any(AbortSignal));
    await userEvent.selectOptions(await ready(), older.id);
    await waitFor(() => expect(api.confirmReportOperation).toHaveBeenCalledOnce());
    expect(api.previewReportOperation).toHaveBeenLastCalledWith(older.id, "select", expect.any(AbortSignal));
  });
  it.each(["activeRevision", "historyRevision", "historyEpoch"] as const)("requires a refreshed history when the confirmation %s no longer matches the displayed evidence", async field => {
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    const select = await ready();
    metadata = { ...metadata, [field]: String(Number(metadata[field]) + 1) };
    await userEvent.selectOptions(select, second.id);
    expect(await screen.findByRole("alert")).toHaveTextContent(/shared report.*changed/i);
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Confirm report selection" })).not.toBeInTheDocument();
    expect(select).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await choose();
    await waitFor(() => expect(api.confirmReportOperation).toHaveBeenCalledOnce());
  });
  it.each([
    new ApiError(0, "network_error", "Connection lost"),
    new ApiError(503, "service_unavailable", "Service unavailable"),
    new ApiError(200, "invalid_response", "The server returned an invalid JSON response."),
  ])("verifies an uncertain committed selection by reading, never replaying a consumed confirmation: %s", async failure => {
    vi.mocked(api.confirmReportOperation).mockImplementationOnce(async input => {
      metadata = { ...metadata, activeSetId: input.setId, activeRevision: "5" };
      throw failure;
    });
    const onChanged = vi.fn();
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={onChanged} />);
    await choose();
    expect(await screen.findByRole("alert")).toHaveTextContent(/may have been saved/i);
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue(second.id));
    expect(api.confirmReportOperation).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each([
    { phase: "preview", status: 401 }, { phase: "preview", status: 403 },
    { phase: "confirm", status: 401 }, { phase: "confirm", status: 403 },
  ])("preserves explicit recovery after a $status $phase denial across a revision change", async ({ phase, status }) => {
    const failure = new ApiError(status, "forbidden", "Report access denied");
    if (phase === "preview") vi.mocked(api.previewReportOperation).mockRejectedValueOnce(failure);
    else vi.mocked(api.confirmReportOperation).mockRejectedValueOnce(failure);
    const onChanged = vi.fn();
    const view = render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={onChanged} />);
    await choose();
    expect(await screen.findByRole("alert")).toHaveTextContent("Report access denied");
    expect(screen.queryByRole("option", { name: /2026-01-01/ })).not.toBeInTheDocument();
    view.rerender(<OfficialUsageReportSelector principalKey="admin" revision={1} onChanged={onChanged} />);
    await screen.findByRole("option", { name: "Report sets unavailable" });
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.queryByRole("option", { name: /2026-01-01/ })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Report access denied");
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await ready();
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(api.confirmReportOperation).toHaveBeenCalledTimes(phase === "confirm" ? 1 : 0);
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(false);
    await choose();
    await waitFor(() => expect(onChanged).toHaveBeenLastCalledWith(true));
  });
  it("keeps a committed selection successful even when its subsequent metadata read fails", async () => {
    const onChanged = vi.fn();
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={onChanged} />);
    await ready();
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new Error("Metadata unavailable"));
    await choose();
    expect(await screen.findByRole("alert")).toHaveTextContent("Metadata unavailable");
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.getByRole("combobox")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue(second.id));
    expect(api.confirmReportOperation).toHaveBeenCalledOnce();
  });
  it.each([401, 403])("retires report options after a %i history refresh rejection", async status => {
    const view = render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    await ready();
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(status, "forbidden", "Report access denied"));
    view.rerender(<OfficialUsageReportSelector principalKey="admin" revision={1} onChanged={vi.fn()} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("option", { name: /2026-01-01/ })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeDisabled();
  });
  it("does not reveal or confirm a preview completed after unmount", async () => {
    const pending = deferred<OfficialReportConfirmation>(); vi.mocked(api.previewReportOperation).mockReturnValue(pending.promise);
    const onChanged = vi.fn(), view = render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={onChanged} />);
    await userEvent.selectOptions(await ready(), second.id);
    const signal = vi.mocked(api.previewReportOperation).mock.calls[0][2];
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(confirmation()));
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
  it("does not notify a replacement principal after an obsolete confirmation succeeds", async () => {
    const pending = deferred<OfficialReportConfirmed>(); vi.mocked(api.confirmReportOperation).mockReturnValue(pending.promise);
    const onChanged = vi.fn(), view = render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={onChanged} />);
    await choose();
    const signal = vi.mocked(api.confirmReportOperation).mock.calls[0][1];
    view.rerender(<OfficialUsageReportSelector principalKey="replacement" revision={0} onChanged={onChanged} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ activeSetId: second.id, activeRevision: "5" }));
    expect(onChanged).not.toHaveBeenCalled();
  });
  it("retires a pending preview across revision A-B-A transitions even if its transport ignores abort", async () => {
    const pending = deferred<OfficialReportConfirmation>(); vi.mocked(api.previewReportOperation).mockReturnValue(pending.promise);
    const view = render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    await userEvent.selectOptions(await ready(), second.id);
    const signal = vi.mocked(api.previewReportOperation).mock.calls[0][2];
    view.rerender(<OfficialUsageReportSelector principalKey="admin" revision={1} onChanged={vi.fn()} />);
    view.rerender(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(confirmation()));
    expect(screen.queryByRole("region", { name: "Confirm report selection" })).not.toBeInTheDocument();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
  });
  it("removes confirmation immediately when Admin access is revoked but preserves Viewer history", async () => {
    const pending = deferred<OfficialReportConfirmation>();
    vi.mocked(api.previewReportOperation).mockReturnValueOnce(pending.promise);
    const panel = (roles: NonNullable<typeof admin.user>["roles"]) => <CapabilityContext.Provider value={{ ...admin, user: { ...admin.user!, roles } }}>
      <OfficialUsageReportSelector principalKey="same" revision={0} onChanged={vi.fn()} /></CapabilityContext.Provider>;
    const view = render(panel(["AgentControl.Viewer", "AgentControl.Admin"]));
    await choose();
    view.rerender(panel(["AgentControl.Viewer"]));
    expect(screen.queryByRole("region", { name: "Confirm report selection" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByText(/An administrator can change/)).toBeVisible();
    await act(async () => pending.resolve(confirmation()));
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
  });
  it.each([false, true])("recovers history invalidation once and offers explicit retry when persistent=%s", async persistent => {
    vi.mocked(api.readReportPage).mockResolvedValueOnce({ ...page(), page: { limit: 50, nextCursor: "next", previousCursor: null } })
      .mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "A retained report was deleted"));
    if (persistent) vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "History changed again"));
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    await ready();
    await userEvent.selectOptions(await ready(), "older-reports");
    if (persistent) {
      await screen.findByRole("alert");
      expect(api.readReportPage).toHaveBeenCalledTimes(3);
      expect(screen.getByRole("combobox")).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    }
    await ready();
    expect(api.readReportPage).toHaveBeenCalledTimes(persistent ? 4 : 3);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]).toEqual({ sort: "acceptedAt", order: "desc", limit: 50 });
    expect(api.previewReportOperation).not.toHaveBeenCalled();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
  });
  it("shows empty history in the selector without admitting an empty report operation", async () => {
    metadata = { ...metadata, activeSetId: null, setId: null, availability: "never_imported" };
    vi.mocked(api.readReportPage).mockResolvedValue({ ...page(), value: [], counts: { total: 0, filtered: 0 } });
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    await screen.findByRole("option", { name: "No report sets available" });
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect(api.previewReportOperation).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
