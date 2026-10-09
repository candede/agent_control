import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficialReportConfirmation, OfficialReportConfirmed } from "../../../backend/src/types/officialReportApi";
import type { ReportHistorySet, ReportPage } from "../../../backend/src/types/officialReportData";
import { ApiError } from "../api/client";
import * as api from "../api/reportData";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { historySet, reportPage, reports } from "../test/reportDataFixture";
import { deferred } from "../test/deferred";
import { mockNativeDialogs } from "../test/dialog";
import { OfficialUsageManageReports } from "./OfficialUsageManageReports";
import { OfficialUsageHistoryPanel } from "./OfficialUsageHistoryPanel";
import { SavedQueryProvider } from "./SavedQueryProvider";

vi.mock("../api/reportData", async original => ({ ...await original<typeof import("../api/reportData")>(),
  readReportPage: vi.fn(), previewReportOperation: vi.fn(), confirmReportOperation: vi.fn() }));
mockNativeDialogs();
const report = historySet(1), older = historySet(2);
const confirmation: OfficialReportConfirmation = { id: "confirmation", operation: "delete", setId: report.id,
  activeRevision: reports.activeRevision, historyRevision: reports.historyRevision, historyEpoch: reports.historyEpoch, hash: "a".repeat(64) };
const props = { revision: 0, canManage: true, onChanged: vi.fn(), onViewSnapshot: vi.fn(), onCorrect: vi.fn() };
const admin: ReturnType<typeof useCapabilityContext> = { user: { tenantId: "tenant", homeAccountId: "principal", displayName: "Admin",
  username: "admin@example.invalid", roles: ["AgentControl.Viewer", "AgentControl.Admin"] }, loading: false, pending: false,
  error: undefined, now: Date.now(), views: [], reload: vi.fn(async () => {}), openPermissions: vi.fn() };
async function open() {
  const trigger = await screen.findByRole("button", { name: "Delete report set" });
  await userEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Delete report set?" });
  return { trigger, dialog, modal: within(dialog) };
}
beforeEach(() => {
  vi.mocked(api.readReportPage).mockResolvedValue(reportPage([report], { counts: { total: 1, filtered: 1 } }));
  vi.mocked(api.previewReportOperation).mockImplementation(async id => ({ ...confirmation, setId: id }));
  vi.mocked(api.confirmReportOperation).mockResolvedValue({ activeSetId: null, activeRevision: "5" });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); });

describe("record-backed report management", () => {
  it.each(["admission", "confirmation"] as const)("fences deletion %s at monotonic lease end without clearing saved history", async phase => {
    const saved = reportPage([report], { counts: { total: 1, filtered: 1 } });
    vi.mocked(api.readReportPage).mockResolvedValue(saved);
    render(<OfficialUsageManageReports {...props} />);
    let trigger = await screen.findByRole("button", { name: "Delete report set" });
    if (phase === "confirmation") {
      const { modal } = await open();
      trigger = modal.getByRole("button", { name: "Delete report set" });
      await waitFor(() => expect(trigger).toBeEnabled());
    }
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + Date.parse(saved.selection.expiresAt) - Date.parse(saved.selection.validatedAt) + 1);
    fireEvent.click(trigger);
    expect(api.previewReportOperation).toHaveBeenCalledTimes(phase === "confirmation" ? 1 : 0);
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    fireEvent.focus(window);
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete report set" })).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });
  it("shows one bounded history list and exact inspection without querying any whole-report administration endpoint", async () => {
    const storage = vi.spyOn(Storage.prototype, "getItem");
    render(<OfficialUsageManageReports {...props} />);
    await screen.findByRole("table");
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.getByText("Current", { exact: true })).toBeVisible();
    expect(screen.queryByText(/Staged imports|Remove old/)).not.toBeInTheDocument();
    expect(screen.queryByText("Find an agent across reports", { selector: "summary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Retained agent activity rows" })).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledExactlyOnceWith("official-usage/history", expect.objectContaining({ limit: 50 }), expect.any(AbortSignal));
    expect(storage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View report" }));
    expect(props.onViewSnapshot).toHaveBeenCalledExactlyOnceWith(report.id);
    expect(api.previewReportOperation).not.toHaveBeenCalled();
  });
  it.each([true, false])("requires an explicit fenced deletion and accurately describes active=%s before opening a fresh post-mutation history", async active => {
    const target = active ? report : older;
    vi.mocked(api.readReportPage).mockResolvedValue(reportPage([target], { counts: { total: 1, filtered: 1 } }));
    render(<OfficialUsageManageReports {...props} />);
    const { modal, dialog } = await open();
    await waitFor(() => expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    expect(dialog).toHaveTextContent(active ? "No report will be selected" : "The active report selection stays unchanged");
    expect(dialog).toHaveTextContent("History pages, overview and exports will be invalidated");
    expect(api.previewReportOperation).toHaveBeenCalledWith(target.id, "delete", expect.any(AbortSignal));
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    vi.mocked(api.readReportPage).mockResolvedValue(reportPage([], { counts: { total: 0, filtered: 0 } }));
    fireEvent.click(modal.getByRole("button", { name: "Delete report set" }));
    expect(await screen.findByText("Report set deleted.")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "No reports yet" })).toBeVisible();
    expect(api.confirmReportOperation).toHaveBeenCalledExactlyOnceWith({ ...confirmation, setId: target.id }, expect.any(AbortSignal));
    expect(props.onChanged).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.selectionId).toBeUndefined();
  });
  it.each(["delete", "reload", "denial"] as const)("captures fresh history after %s even when a peer retains the pre-operation query", async action => {
    if (action !== "delete") vi.mocked(api.previewReportOperation).mockRejectedValueOnce(new ApiError(action === "denial" ? 403 : 409,
      action === "denial" ? "denied" : "selection_invalidated", "History unavailable."));
    render(<SavedQueryProvider>
      <OfficialUsageManageReports {...props} />
      <section aria-label="Pinned peer"><OfficialUsageHistoryPanel revision={0} /></section>
    </SavedQueryProvider>);
    const management = within(screen.getByRole("region", { name: "Manage saved reports" }));
    fireEvent.click(await management.findByRole("button", { name: "Delete report set" }));
    const replacement = reportPage([], { counts: { total: 0, filtered: 0 } });
    replacement.selection = { ...replacement.selection, id: "replacement-selection" };
    vi.mocked(api.readReportPage).mockResolvedValue(replacement);
    if (action === "delete") {
      const modal = within(await screen.findByRole("dialog", { name: "Delete report set?" }));
      const remove = modal.getByRole("button", { name: "Delete report set" });
      await waitFor(() => expect(remove).toBeEnabled());
      fireEvent.click(remove);
      await screen.findByText("Report set deleted.");
    } else fireEvent.click(await management.findByRole("button", { name: "Reload report history" }));
    expect(await management.findByRole("heading", { name: "No reports yet" })).toBeVisible();
    expect(management.queryByRole("table")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Pinned peer" })).getByRole("table")).toBeVisible();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.calls[1][1]).not.toHaveProperty("selectionId");
    expect(props.onChanged).toHaveBeenCalledOnce();
  });
  it("does not reuse pending peer revalidation or let its late response replace post-deletion history", async () => {
    render(<SavedQueryProvider>
      <OfficialUsageManageReports {...props} />
      <section aria-label="Pinned peer"><OfficialUsageHistoryPanel revision={0} /></section>
    </SavedQueryProvider>);
    const { modal } = await open();
    await waitFor(() => expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    const earlier = deferred<ReportPage<ReportHistorySet>>();
    const replacement = deferred<ReportPage<ReportHistorySet>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(earlier.promise).mockReturnValueOnce(replacement.promise);
    fireEvent.focus(window);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    const signal = vi.mocked(api.readReportPage).mock.calls[1][2];
    fireEvent.click(modal.getByRole("button", { name: "Delete report set" }));
    await screen.findByText("Report set deleted.");
    const management = within(screen.getByRole("region", { name: "Manage saved reports" }));
    await management.findByText("Loading saved data...");
    expect(management.queryByRole("table")).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(signal?.aborted).toBe(false);
    expect(vi.mocked(api.readReportPage).mock.calls[2][1]).not.toHaveProperty("selectionId");
    await act(async () => earlier.resolve(reportPage([report])));
    expect(management.getByText("Loading saved data...")).toBeVisible();
    expect(management.queryByRole("table")).not.toBeInTheDocument();
    await act(async () => replacement.resolve(reportPage([], { counts: { total: 0, filtered: 0 } })));
    await management.findByRole("heading", { name: "No reports yet" });
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(props.onChanged).toHaveBeenCalledOnce();
  });
  it("makes only one fresh history request when deletion also publishes a workspace revision", async () => {
    function Management() {
      const [revision, setRevision] = useState(0);
      return <><OfficialUsageManageReports {...props} revision={revision}
        onChanged={() => { props.onChanged(); setRevision(value => value + 1); }} />
        <OfficialUsageHistoryPanel revision={revision} /></>;
    }
    render(<SavedQueryProvider><Management /></SavedQueryProvider>);
    const { modal } = await open();
    await waitFor(() => expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    vi.mocked(api.readReportPage).mockResolvedValue(reportPage([], { counts: { total: 0, filtered: 0 } }));
    fireEvent.click(modal.getByRole("button", { name: "Delete report set" }));
    await waitFor(() => expect(screen.getAllByRole("heading", { name: "No reports yet" })).toHaveLength(2));
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.calls[1][1]).not.toHaveProperty("selectionId");
    expect(props.onChanged).toHaveBeenCalledOnce();
  });
  it("cancels by Escape and restores the exact triggering row without consuming a confirmation", async () => {
    render(<OfficialUsageManageReports {...props} />);
    const { trigger, dialog, modal } = await open();
    await waitFor(() => expect(modal.getByRole("button", { name: "Cancel" })).toBeEnabled());
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(trigger).toHaveFocus();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
  });
  it("allows cancellation of a pending preview, aborting late completion rather than reviving the dialog", async () => {
    const pending = deferred<OfficialReportConfirmation>(); vi.mocked(api.previewReportOperation).mockReturnValue(pending.promise);
    render(<OfficialUsageManageReports {...props} />);
    const { modal } = await open();
    expect(modal.getByRole("button", { name: "Delete report set" })).toBeDisabled();
    fireEvent.click(modal.getByRole("button", { name: "Cancel" }));
    expect(vi.mocked(api.previewReportOperation).mock.calls[0][2]?.aborted).toBe(true);
    await act(async () => pending.resolve(confirmation));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
  });
  it.each(["pending", "prepared"] as const)("retires a %s deletion when history revalidation denies its evidence", async stage => {
    const preview = deferred<OfficialReportConfirmation>();
    if (stage === "pending") vi.mocked(api.previewReportOperation).mockReturnValueOnce(preview.promise);
    render(<OfficialUsageManageReports {...props} />);
    const { modal } = await open();
    if (stage === "prepared") await waitFor(() => expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(403, "denied", "History access denied."));
    fireEvent.focus(window);
    expect(await screen.findByRole("alert")).toHaveTextContent("History access denied.");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    if (stage === "pending") {
      expect(vi.mocked(api.previewReportOperation).mock.calls[0][2]?.aborted).toBe(true);
      await act(async () => preview.resolve(confirmation));
    }
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Manage saved reports" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    await screen.findByRole("table");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.previewReportOperation).toHaveBeenCalledOnce();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
  });
  it("retires prepared deletion on history invalidation and explicitly replaces it without replaying the preview", async () => {
    render(<OfficialUsageManageReports {...props} />);
    const { modal } = await open();
    await waitFor(() => expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    const current = deferred<ReportPage<ReportHistorySet>>();
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "History changed."))
      .mockReturnValueOnce(current.promise);
    fireEvent.focus(window);
    await screen.findByRole("alert");
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    await screen.findByText("Loading saved data...");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    await act(async () => current.resolve(reportPage([older])));
    await screen.findByRole("table");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.previewReportOperation).toHaveBeenCalledOnce();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
  });
  it("keeps a prepared deletion through unchanged background revalidation", async () => {
    render(<OfficialUsageManageReports {...props} />);
    const { modal, dialog } = await open();
    await waitFor(() => expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    const current = deferred<ReportPage<ReportHistorySet>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(current.promise);
    fireEvent.focus(window);
    expect(screen.getByRole("dialog")).toBe(dialog);
    await act(async () => current.resolve(reportPage([report], { counts: { total: 1, filtered: 1 } })));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled();
    expect(api.previewReportOperation).toHaveBeenCalledOnce();
  });
  it("keeps an admitted deletion locked when history revalidation fails", async () => {
    const pending = deferred<OfficialReportConfirmed>();
    vi.mocked(api.confirmReportOperation).mockReturnValueOnce(pending.promise);
    render(<OfficialUsageManageReports {...props} />);
    const { modal, dialog } = await open();
    const remove = modal.getByRole("button", { name: "Delete report set" });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(403, "denied", "History access denied."));
    fireEvent.focus(window);
    await screen.findByText("History access denied.");
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(modal.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(vi.mocked(api.confirmReportOperation).mock.calls[0][1]?.aborted).toBe(false);
    await act(async () => pending.resolve({ activeSetId: null, activeRevision: "5" }));
    await screen.findByText("Report set deleted.");
    expect(props.onChanged).toHaveBeenCalledOnce();
  });
  it("preserves an uncertain deletion's recovery when a concurrent history read also fails", async () => {
    const deletion = deferred<OfficialReportConfirmed>(), history = deferred<ReportPage<ReportHistorySet>>();
    vi.mocked(api.confirmReportOperation).mockReturnValueOnce(deletion.promise);
    render(<OfficialUsageManageReports {...props} />);
    const { modal, dialog } = await open();
    const remove = modal.getByRole("button", { name: "Delete report set" });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    vi.mocked(api.readReportPage).mockReturnValueOnce(history.promise);
    fireEvent.focus(window);
    await act(async () => deletion.reject(new ApiError(0, "network_error", "Connection lost.")));
    expect(await modal.findByRole("alert")).toHaveTextContent("Deletion may already have completed.");
    await act(async () => history.reject(new Error("History unavailable.")));
    await screen.findByText("History unavailable.");
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(modal.getByRole("alert")).toHaveTextContent("Deletion may already have completed.");
    expect(remove).toBeDisabled();
    fireEvent.click(modal.getByRole("button", { name: "Reload report history" }));
    await screen.findByRole("table");
    expect(api.confirmReportOperation).toHaveBeenCalledOnce();
    expect(api.previewReportOperation).toHaveBeenCalledOnce();
    expect(props.onChanged).toHaveBeenCalledOnce();
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.selectionId).toBeUndefined();
  });
  it("retires prepared deletion when shared history revalidation rejects its selection", async () => {
    const revalidation = deferred<ReportPage<ReportHistorySet>>();
    render(<SavedQueryProvider>
      <OfficialUsageManageReports {...props} />
      <section aria-label="Pinned peer"><OfficialUsageHistoryPanel revision={0} /></section>
    </SavedQueryProvider>);
    const peer = within(screen.getByRole("region", { name: "Pinned peer" }));
    await peer.findByRole("table");
    const { modal } = await open();
    await waitFor(() => expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    vi.mocked(api.readReportPage).mockReturnValueOnce(revalidation.promise);
    fireEvent.focus(window);
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    await act(async () => revalidation.reject(new ApiError(409, "selection_invalidated", "History changed.")));
    const management = within(screen.getByRole("region", { name: "Manage saved reports" }));
    await management.findByRole("alert");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(management.queryByRole("table")).not.toBeInTheDocument();
    expect(management.getByRole("button", { name: "Restart selection" })).toBeEnabled();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(api.previewReportOperation).toHaveBeenCalledOnce();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
  });
  it("returns focus to management when cancellation cannot focus a revalidating row", async () => {
    render(<OfficialUsageManageReports {...props} />);
    const { modal, trigger } = await open();
    const pending = deferred<ReportPage<ReportHistorySet>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    fireEvent.focus(window);
    await waitFor(() => expect(trigger).toBeDisabled());
    fireEvent.click(modal.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Manage saved reports" })).toHaveFocus();
    await act(async () => pending.resolve(reportPage([report])));
  });
  it("focuses the denial recovery after its dialog and triggering history are removed", async () => {
    vi.mocked(api.previewReportOperation).mockRejectedValueOnce(new ApiError(403, "denied", "Management access denied."));
    render(<OfficialUsageManageReports {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete report set" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Management access denied.");
    expect(screen.getByRole("alert")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Reload report history" }));
    await screen.findByRole("table");
    expect(screen.getByRole("region", { name: "Manage saved reports" })).toHaveFocus();
  });
  it("returns focus to management when a revision retires its prepared deletion", async () => {
    const view = render(<OfficialUsageManageReports {...props} />);
    const { modal } = await open();
    await waitFor(() => expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    view.rerender(<OfficialUsageManageReports {...props} revision={1} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Manage saved reports" })).toHaveFocus();
    await screen.findByRole("table");
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
  });
  it("retries failed preparation without silently performing deletion", async () => {
    vi.mocked(api.previewReportOperation).mockRejectedValueOnce(new Error("Unable to check report"));
    render(<OfficialUsageManageReports {...props} />);
    const { modal } = await open();
    await modal.findByRole("alert");
    fireEvent.click(modal.getByRole("button", { name: "Retry preparation" }));
    await waitFor(() => expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    expect(api.previewReportOperation).toHaveBeenCalledTimes(2);
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
  });
  it("admits a single preparation when the same row is activated twice before rerender", async () => {
    const pending = deferred<OfficialReportConfirmation>();
    vi.mocked(api.previewReportOperation).mockReturnValue(pending.promise);
    render(<OfficialUsageManageReports {...props} />);
    const trigger = await screen.findByRole("button", { name: "Delete report set" });
    act(() => { fireEvent.click(trigger); fireEvent.click(trigger); });
    expect(api.previewReportOperation).toHaveBeenCalledOnce();
    expect(vi.mocked(api.previewReportOperation).mock.calls[0][2]?.aborted).toBe(false);
    await act(async () => pending.resolve(confirmation));
    const dialog = screen.getByRole("dialog", { name: "Delete report set?" });
    expect(within(dialog).getByRole("button", { name: "Delete report set" })).toBeEnabled();
  });
  it("consumes a prepared deletion only once for same-batch confirmation clicks", async () => {
    const pending = deferred<OfficialReportConfirmed>();
    vi.mocked(api.confirmReportOperation).mockReturnValue(pending.promise);
    render(<OfficialUsageManageReports {...props} />);
    const { modal, dialog } = await open();
    const remove = modal.getByRole("button", { name: "Delete report set" });
    await waitFor(() => expect(remove).toBeEnabled());
    act(() => {
      fireEvent.click(remove); fireEvent.click(remove);
      fireEvent(dialog, new Event("cancel", { cancelable: true }));
    });
    expect(api.confirmReportOperation).toHaveBeenCalledOnce();
    expect(vi.mocked(api.confirmReportOperation).mock.calls[0][1]?.aborted).toBe(false);
    expect(dialog).toBeInTheDocument();
    await act(async () => pending.resolve({ activeSetId: null, activeRevision: "5" }));
    await screen.findByText("Report set deleted.");
    expect(props.onChanged).toHaveBeenCalledOnce();
  });
  it("does not navigate into a correction when deletion starts before the disabled state renders", async () => {
    const pending = deferred<OfficialReportConfirmed>();
    vi.mocked(api.confirmReportOperation).mockReturnValueOnce(pending.promise);
    render(<OfficialUsageManageReports {...props} />);
    const { modal, dialog } = await open();
    const remove = modal.getByRole("button", { name: "Delete report set" });
    await waitFor(() => expect(remove).toBeEnabled());
    const correct = modal.getByRole("button", { name: "Import correction instead" });
    act(() => { fireEvent.click(remove); fireEvent.click(correct); });
    expect(props.onCorrect).not.toHaveBeenCalled();
    expect(api.confirmReportOperation).toHaveBeenCalledOnce();
    expect(vi.mocked(api.confirmReportOperation).mock.calls[0][1]?.aborted).toBe(false);
    expect(dialog).toBeInTheDocument();
    await act(async () => pending.resolve({ activeSetId: null, activeRevision: "5" }));
    await screen.findByText("Report set deleted.");
    expect(props.onChanged).toHaveBeenCalledOnce();
  });
  it.each(["cancel", "escape", "correction"] as const)("retires a prepared deletion synchronously on %s", async action => {
    const pending = deferred<OfficialReportConfirmed>();
    vi.mocked(api.confirmReportOperation).mockReturnValueOnce(pending.promise);
    render(<OfficialUsageManageReports {...props} />);
    const { modal, dialog } = await open();
    const remove = modal.getByRole("button", { name: "Delete report set" });
    await waitFor(() => expect(remove).toBeEnabled());
    act(() => {
      if (action === "escape") fireEvent(dialog, new Event("cancel", { cancelable: true }));
      else fireEvent.click(modal.getByRole("button", { name: action === "cancel" ? "Cancel" : "Import correction instead" }));
      fireEvent.click(remove);
    });
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(props.onCorrect).toHaveBeenCalledTimes(action === "correction" ? 1 : 0);
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });
  it("does not revive failed preparation when its retry is activated after cancellation in the same batch", async () => {
    vi.mocked(api.previewReportOperation).mockRejectedValueOnce(new Error("Unable to check report"));
    render(<OfficialUsageManageReports {...props} />);
    const { modal } = await open();
    const retry = await modal.findByRole("button", { name: "Retry preparation" });
    act(() => {
      fireEvent.click(modal.getByRole("button", { name: "Cancel" }));
      fireEvent.click(retry);
    });
    expect(api.previewReportOperation).toHaveBeenCalledOnce();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("still allows cancellation immediately after retrying a pending preview", async () => {
    const pending = deferred<OfficialReportConfirmation>();
    vi.mocked(api.previewReportOperation).mockRejectedValueOnce(new Error("Unable to check report")).mockReturnValueOnce(pending.promise);
    render(<OfficialUsageManageReports {...props} />);
    const { modal } = await open();
    const retry = await modal.findByRole("button", { name: "Retry preparation" });
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(modal.getByRole("button", { name: "Cancel" }));
    });
    expect(api.previewReportOperation).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.previewReportOperation).mock.calls[1][2]?.aborted).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => pending.resolve(confirmation));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
  });
  it.each(["reload", "denial", "correction"] as const)("admits only one %s navigation before its dialog unmounts", async action => {
    vi.mocked(api.previewReportOperation).mockRejectedValueOnce(new ApiError(action === "denial" ? 403 : 409,
      action === "denial" ? "denied" : "selection_invalidated", "History unavailable."));
    render(<OfficialUsageManageReports {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete report set" }));
    await screen.findByRole("alert");
    const next = screen.getByRole("button", { name: action === "correction" ? "Import correction instead" : "Reload report history" });
    act(() => { fireEvent.click(next); fireEvent.click(next); });
    expect(props.onChanged).toHaveBeenCalledTimes(action === "correction" ? 0 : 1);
    expect(props.onCorrect).toHaveBeenCalledTimes(action === "correction" ? 1 : 0);
    expect(api.previewReportOperation).toHaveBeenCalledOnce();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it.each(["activeRevision", "historyRevision", "historyEpoch"] as const)("refuses a preview whose %s differs from the history the operator chose", async field => {
    vi.mocked(api.previewReportOperation).mockResolvedValue({ ...confirmation, [field]: "99" });
    render(<OfficialUsageManageReports {...props} />);
    const { modal } = await open();
    expect(await modal.findByRole("alert")).toHaveTextContent(/history changed/i);
    expect(modal.getByRole("button", { name: "Delete report set" })).toBeDisabled();
    fireEvent.click(modal.getByRole("button", { name: "Reload report history" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
  });
  it.each([0, 409])("verifies status %s through fresh history instead of replaying a consumed or stale confirmation", async status => {
    vi.mocked(api.confirmReportOperation).mockRejectedValueOnce(new ApiError(status, status ? "active_revision_mismatch" : "network_error", "Uncertain deletion"));
    render(<OfficialUsageManageReports {...props} />);
    const { modal } = await open();
    await waitFor(() => expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    fireEvent.click(modal.getByRole("button", { name: "Delete report set" }));
    await modal.findByRole("alert");
    expect(screen.queryByText("Report set deleted.")).not.toBeInTheDocument();
    fireEvent.click(modal.getByRole("button", { name: "Reload report history" }));
    await screen.findByRole("table");
    expect(api.confirmReportOperation).toHaveBeenCalledOnce();
    expect(api.previewReportOperation).toHaveBeenCalledOnce();
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.selectionId).toBeUndefined();
  });
  it("keeps uncertain deletion unverified when its fresh history read fails and retries only that read", async () => {
    vi.mocked(api.confirmReportOperation).mockRejectedValueOnce(new ApiError(0, "network_error", "Connection lost."));
    render(<OfficialUsageManageReports {...props} />);
    const { modal } = await open();
    const remove = modal.getByRole("button", { name: "Delete report set" });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    expect(await modal.findByRole("alert")).toHaveTextContent("Deletion may already have completed.");
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new Error("Fresh history unavailable."));
    fireEvent.click(modal.getByRole("button", { name: "Reload report history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Fresh history unavailable.");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Report set deleted.")).not.toBeInTheDocument();
    const readback = deferred<ReportPage<ReportHistorySet>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(readback.promise);
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    expect(screen.getByText("Loading saved data...")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => readback.resolve(reportPage([], { counts: { total: 0, filtered: 0 } })));
    await screen.findByRole("heading", { name: "No reports yet" });
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.readReportPage).mock.calls.slice(1).every(([, query]) => !query?.selectionId && !query?.cursor)).toBe(true);
    expect(api.previewReportOperation).toHaveBeenCalledOnce();
    expect(api.confirmReportOperation).toHaveBeenCalledOnce();
    expect(props.onChanged).toHaveBeenCalledOnce();
  });
  it.each([401, 403])("preserves the %s denial explanation across revisions until history is explicitly reloaded", async status => {
    vi.mocked(api.previewReportOperation).mockRejectedValueOnce(new ApiError(status, "denied", "Report management access denied."));
    const view = render(<OfficialUsageManageReports {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete report set" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Report management access denied.");
    view.rerender(<OfficialUsageManageReports {...props} revision={1} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Report management access denied.");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(api.previewReportOperation).toHaveBeenCalledOnce();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload report history" }));
    await screen.findByRole("table");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(props.onChanged).toHaveBeenCalledOnce();
  });
  it("prevents cancellation while atomic deletion is committing", async () => {
    const pending = deferred<OfficialReportConfirmed>(); vi.mocked(api.confirmReportOperation).mockReturnValue(pending.promise);
    render(<OfficialUsageManageReports {...props} />);
    const { modal, dialog } = await open();
    await waitFor(() => expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    fireEvent.click(modal.getByRole("button", { name: "Delete report set" }));
    expect(modal.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(dialog).toBeInTheDocument();
    await act(async () => pending.resolve({ activeSetId: null, activeRevision: "5" }));
    await screen.findByText("Report set deleted.");
  });
  it("offers an exact correction instead of deleting or selecting another set", async () => {
    render(<OfficialUsageManageReports {...props} />);
    const { modal } = await open();
    await waitFor(() => expect(modal.getByRole("button", { name: "Import correction instead" })).toBeEnabled());
    fireEvent.click(modal.getByRole("button", { name: "Import correction instead" }));
    expect(props.onCorrect).toHaveBeenCalledExactlyOnceWith(report.id);
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("never renders mutation or retired browser-migration controls for a Viewer", async () => {
    render(<OfficialUsageManageReports {...props} canManage={false} />);
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: /Delete|Remove old|Continue import|Acknowledge/ })).not.toBeInTheDocument();
    expect(api.previewReportOperation).not.toHaveBeenCalled();
  });
  it("retires a prepared deletion on capability revocation even when its caller still requests management", async () => {
    const panel = (roles: NonNullable<typeof admin.user>["roles"]) => <CapabilityContext.Provider value={{ ...admin, user: { ...admin.user!, roles } }}>
      <OfficialUsageManageReports {...props} /></CapabilityContext.Provider>;
    const view = render(panel(["AgentControl.Viewer", "AgentControl.Admin"]));
    await open();
    view.rerender(panel(["AgentControl.Viewer"]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete report set" })).not.toBeInTheDocument();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
  });
  it("preserves prepared deletion across equivalent account and capability metadata updates", async () => {
    const panel = (context: typeof admin) => <CapabilityContext.Provider value={context}>
      <OfficialUsageManageReports {...props} /></CapabilityContext.Provider>;
    const view = render(panel(admin));
    const { modal, dialog } = await open();
    await waitFor(() => expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    view.rerender(panel({ ...admin, now: admin.now + 1000, pending: true,
      user: { ...admin.user!, displayName: "Renamed admin", roles: [...admin.user!.roles].reverse() } }));
    expect(screen.getByRole("dialog", { name: "Delete report set?" })).toBe(dialog);
    expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(api.previewReportOperation).toHaveBeenCalledOnce();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
  });
  it.each((["account", "tenant"] as const).flatMap(transition => (["preview", "confirm"] as const).map(kind => ({ transition, kind }))))(
    "retires pending $kind across $transition A-B-A changes, including late denial", async ({ transition, kind }) => {
    const preview = deferred<OfficialReportConfirmation>(), confirmed = deferred<OfficialReportConfirmed>();
    if (kind === "preview") vi.mocked(api.previewReportOperation).mockReturnValueOnce(preview.promise);
    else vi.mocked(api.confirmReportOperation).mockReturnValueOnce(confirmed.promise);
    const panel = (owner: string) => <SavedQueryProvider>
      <CapabilityContext.Provider value={{ ...admin, user: { ...admin.user!,
        ...(transition === "account" ? { homeAccountId: owner } : { tenantId: owner }) } }}>
        <OfficialUsageManageReports {...props} />
      </CapabilityContext.Provider>
    </SavedQueryProvider>;
    const view = render(panel("account-a"));
    const { modal } = await open();
    if (kind === "confirm") {
      const remove = modal.getByRole("button", { name: "Delete report set" });
      await waitFor(() => expect(remove).toBeEnabled());
      fireEvent.click(remove);
    }
    const signal = kind === "preview" ? vi.mocked(api.previewReportOperation).mock.calls[0][2]
      : vi.mocked(api.confirmReportOperation).mock.calls[0][1];
    view.rerender(panel("account-b"));
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await screen.findByRole("table");
    view.rerender(panel("account-a"));
    await screen.findByRole("table");
    const current = await open();
    await waitFor(() => expect(current.modal.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    await act(async () => {
      if (kind === "preview") preview.reject(new ApiError(403, "denied", "Retired account denied."));
      else confirmed.resolve({ activeSetId: null, activeRevision: "5" });
    });
    expect(screen.getByRole("dialog", { name: "Delete report set?" })).toBe(current.dialog);
    expect(current.modal.getByRole("button", { name: "Delete report set" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Report set deleted.")).not.toBeInTheDocument();
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(api.previewReportOperation).toHaveBeenCalledTimes(2);
    expect(api.confirmReportOperation).toHaveBeenCalledTimes(kind === "confirm" ? 1 : 0);
  });
  it("keeps a replacement preview busy when an earlier cancelled request settles", async () => {
    const earlier = deferred<OfficialReportConfirmation>(), current = deferred<OfficialReportConfirmation>();
    vi.mocked(api.previewReportOperation).mockReturnValueOnce(earlier.promise).mockReturnValueOnce(current.promise);
    render(<OfficialUsageManageReports {...props} />);
    const first = await open();
    fireEvent.click(first.modal.getByRole("button", { name: "Cancel" }));
    const second = await open();
    expect(vi.mocked(api.previewReportOperation).mock.calls[0][2]?.aborted).toBe(true);
    expect(vi.mocked(api.previewReportOperation).mock.calls[1][2]?.aborted).toBe(false);
    await act(async () => earlier.resolve(confirmation));
    expect(second.modal.getByRole("status")).toHaveTextContent("Checking report operation...");
    expect(second.modal.getByRole("button", { name: "Delete report set" })).toBeDisabled();
    expect(api.previewReportOperation).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve({ ...confirmation, id: "replacement-confirmation" }));
    fireEvent.click(second.modal.getByRole("button", { name: "Delete report set" }));
    await screen.findByText("Report set deleted.");
    expect(api.confirmReportOperation).toHaveBeenCalledExactlyOnceWith({ ...confirmation, id: "replacement-confirmation" }, expect.any(AbortSignal));
    expect(props.onChanged).toHaveBeenCalledOnce();
  });
  it("aborts obsolete confirmations across revision A-B-A transitions without notifying the replacement view", async () => {
    const pending = deferred<OfficialReportConfirmed>(); vi.mocked(api.confirmReportOperation).mockReturnValue(pending.promise);
    const view = render(<OfficialUsageManageReports {...props} />);
    const { modal } = await open();
    await waitFor(() => expect(modal.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    fireEvent.click(modal.getByRole("button", { name: "Delete report set" }));
    const signal = vi.mocked(api.confirmReportOperation).mock.calls[0][1];
    view.rerender(<OfficialUsageManageReports {...props} revision={1} />);
    view.rerender(<OfficialUsageManageReports {...props} revision={0} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ activeSetId: null, activeRevision: "5" }));
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
