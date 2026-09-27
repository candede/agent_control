import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { usageInsightsPublished } from "../test/usageInsightsFixture";
import { mockNativeDialogs } from "../test/dialog";
import { legacyUsageStorageKey } from "../legacyUsageStorage";
import { OfficialUsageManageReports } from "./OfficialUsageManageReports";
import { reportHistoryFixture } from "./reportHistoryFixture";

mockNativeDialogs();
const report = usageInsightsPublished.activeSet!;
const props = { revision: 0, canManage: true, onChanged: vi.fn(), onLegacyCleared: vi.fn(), onViewSnapshot: vi.fn(), onResumeImport: vi.fn() };
const confirmation: api.OfficialUsageConfirmation = {
  id: "confirmation", operation: "delete", setId: report.id, expectedRevision: 3,
  confirmationHash: "a".repeat(64), activeSetId: report.id, expiresAt: "2026-10-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.spyOn(api, "getOfficialUsageHistory").mockResolvedValue(reportHistoryFixture([report], report.id));
  vi.spyOn(api, "getOfficialUsageOverview");
  vi.spyOn(api, "getOfficialUsageAdminState");
  vi.spyOn(api, "previewOfficialUsageSetOperation").mockResolvedValue(confirmation);
  vi.spyOn(api, "confirmOfficialUsageSetOperation").mockResolvedValue({ activeSetId: null, activeRevision: 4 });
  vi.spyOn(api, "acknowledgeLegacyUsageCleanup").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

describe("simplified report management", () => {
  it("presents one report list without refresh controls, technical accounting, drafts, or an agent locator", async () => {
    render(<OfficialUsageManageReports {...props} />);
    await screen.findByRole("table");
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.getByText("Current", { exact: true })).toBeVisible();
    expect(screen.queryByText(/Retention and source accounting|Find an agent across reports|Staged imports/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Refresh|View current|Make current/ })).not.toBeInTheDocument();
    expect(api.getOfficialUsageOverview).not.toHaveBeenCalled();
    expect(api.getOfficialUsageAdminState).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "View report" }));
    expect(props.onViewSnapshot).toHaveBeenCalledWith(report.id);
    expect(api.previewOfficialUsageSetOperation).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation for deletion and describes the effect on the current report", async () => {
    render(<OfficialUsageManageReports {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: /Delete report set:/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete report set?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete report set" })).toBeEnabled());
    expect(dialog).toHaveTextContent("Agents and Users will have no report selected");
    expect(dialog).not.toHaveTextContent(report.id);
    expect(api.previewOfficialUsageSetOperation).toHaveBeenCalledWith(report.id, "delete");
    expect(api.confirmOfficialUsageSetOperation).not.toHaveBeenCalled();
    vi.mocked(api.getOfficialUsageHistory).mockResolvedValue(reportHistoryFixture([]));
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete report set" }));
    expect(api.confirmOfficialUsageSetOperation).toHaveBeenCalledExactlyOnceWith(confirmation);
    expect(await screen.findByText("Report set deleted.")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "No reports yet" })).toBeVisible();
    expect(props.onChanged).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancels deletion with Escape and restores focus without mutating reports", async () => {
    render(<OfficialUsageManageReports {...props} />);
    const button = await screen.findByRole("button", { name: /Delete report set:/ });
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Delete report set?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled());
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(button).toHaveFocus());
    expect(api.confirmOfficialUsageSetOperation).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it("keeps deletion disabled while its preview is loading and retries failed preparation", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(api.previewOfficialUsageSetOperation).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    render(<OfficialUsageManageReports {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: /Delete report set:/ }));
    expect(screen.getByRole("button", { name: "Delete report set" })).toBeDisabled();
    await act(async () => reject(new Error("Unable to check report.")));
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to check report");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    expect(api.confirmOfficialUsageSetOperation).not.toHaveBeenCalled();
  });

  it("does not silently re-confirm stale or uncertain deletion requests", async () => {
    vi.mocked(api.confirmOfficialUsageSetOperation).mockRejectedValueOnce(new api.ApiError(409, "active_revision_mismatch", "Selection changed."));
    render(<OfficialUsageManageReports {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: /Delete report set:/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Delete report set" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The deletion could not be confirmed");
    expect(screen.queryByText("Report set deleted.")).not.toBeInTheDocument();
    expect(api.confirmOfficialUsageSetOperation).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    expect(api.previewOfficialUsageSetOperation).toHaveBeenCalledTimes(2);
    expect(api.confirmOfficialUsageSetOperation).toHaveBeenCalledOnce();
  });

  it("prevents cancellation during a confirmed deletion", async () => {
    let finish!: (value: { activeSetId: null; activeRevision: number }) => void;
    vi.mocked(api.confirmOfficialUsageSetOperation).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<OfficialUsageManageReports {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: /Delete report set:/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete report set" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Delete report set" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(dialog).toBeInTheDocument();
    await act(async () => finish({ activeSetId: null, activeRevision: 4 }));
    await screen.findByText("Report set deleted.");
  });

  it("never requests administration or renders mutation controls for Viewers", async () => {
    render(<OfficialUsageManageReports {...props} canManage={false} />);
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: /Delete|Continue import|Remove old/ })).not.toBeInTheDocument();
    expect(api.getOfficialUsageAdminState).not.toHaveBeenCalled();
    expect(api.previewOfficialUsageSetOperation).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "View report" }));
    expect(props.onViewSnapshot).toHaveBeenCalledWith(report.id);
  });

  it("retains an explicit recovery path for incomplete legacy bundles", async () => {
    vi.mocked(api.getOfficialUsageHistory).mockResolvedValue(reportHistoryFixture([{ ...report, complete: false, acceptedAt: null }]));
    render(<OfficialUsageManageReports {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: "Continue import" }));
    expect(props.onResumeImport).toHaveBeenCalledWith(report.bundleId);
    expect(api.confirmOfficialUsageSetOperation).not.toHaveBeenCalled();
  });

  it("clears legacy storage only after successful explicit acknowledgement", async () => {
    localStorage.setItem(legacyUsageStorageKey, "untouched legacy content");
    vi.mocked(api.acknowledgeLegacyUsageCleanup).mockRejectedValueOnce(new Error("Acknowledgement failed."));
    render(<OfficialUsageManageReports {...props} />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Remove old browser data" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Acknowledgement failed");
    expect(localStorage.getItem(legacyUsageStorageKey)).toBe("untouched legacy content");
    expect(props.onLegacyCleared).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove old browser data" }));
    await screen.findByText("Old browser report data removed.");
    expect(api.acknowledgeLegacyUsageCleanup).toHaveBeenCalledWith("discarded");
    expect(localStorage.getItem(legacyUsageStorageKey)).toBeNull();
    expect(props.onLegacyCleared).toHaveBeenCalledOnce();
  });
});
