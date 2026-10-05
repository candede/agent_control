import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficialReportConfirmation, OfficialReportConfirmed } from "../../../backend/src/types/officialReportApi";
import { ApiError } from "../api/client";
import * as api from "../api/reportData";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { historySet, reportPage, reports } from "../test/reportDataFixture";
import { deferred } from "../test/deferred";
import { mockNativeDialogs } from "../test/dialog";
import { OfficialUsageManageReports } from "./OfficialUsageManageReports";

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
