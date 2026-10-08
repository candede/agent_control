import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { ApiError, getBulkActionJobItems, type BulkActionJob, type BulkJobItemPage, type BulkJobStatus, type BulkPackageResult, type SessionUser } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { BulkActions } from "./BulkActions";
import { BulkJobItems } from "./BulkJobItems";
vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(), getBulkActionJobItems: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(getBulkActionJobItems).mockReset();
  vi.mocked(getBulkActionJobItems).mockResolvedValue({ value: [], revision: "1", counts: { total: 4, filtered: 4 },
    page: { limit: 50, nextCursor: null, previousCursor: null } });
});

const user: SessionUser = {
  homeAccountId: "fixture", tenantId: "tenant", displayName: "Admin", username: "admin@example.invalid",
  roles: ["AgentControl.Admin"],
};
const running: BulkActionJob = {
  id: "job-1", action: "block", targetBlockedState: true, status: "running", canResume: false,
  total: 4, completed: 1, succeeded: 1, failed: 0, skipped: 0, currentAgentName: "Support agent",
  inconclusive: 0, cancelled: 0, queued: 2, reconciliationRequired: 0, retryEligible: 0, resultRevision: "1",
  createdAt: "2026-09-25T09:00:00Z", updatedAt: "2026-09-25T09:01:00Z",
};
function mount(overrides: Partial<Parameters<typeof BulkActions>[0]> = {}, roles = user.roles, metadata = true) {
  const props = {
    disabled: false, selectedCount: 0,
    onBlockAll: vi.fn(), onUnblockAll: vi.fn(), onManageAccess: vi.fn(), onJobCommand: vi.fn(),
    ...overrides,
  };
  const view = render(<CapabilityContext value={{
    user: { ...user, roles }, views: [{
      definition: capabilityDefinitions.find(item => item.id === "graph.package.block.manage")!,
      decision: { capabilityId: "graph.package.block.manage", status: "available", authorized: true, fresh: true,
        verification: "on_demand", previewQualification: "not_required", remediation: [] },
    }], loading: false, pending: false, error: undefined, now: Date.now(),
    reload: vi.fn(), openPermissions: vi.fn(),
  }}>
    <WorkbenchActionProvider value={metadata ? workbenchActions : undefined}>
      <BulkActions {...props} />
    </WorkbenchActionProvider>
  </CapabilityContext>);
  return { ...view, props, panel: within(screen.getByRole("region", { name: "Exact package bulk actions" })) };
}

describe("unified access job panel", () => {
  it("keeps idle selection actions without an empty job panel", () => {
    const { panel } = mount({ selectedCount: 2 });
    expect(panel.getByText("2 selected")).toBeVisible();
    expect(panel.getByRole("button", { name: "Block selected packages" })).toBeVisible();
    expect(panel.getByRole("button", { name: "Unblock selected packages" })).toBeVisible();
    expect(panel.getByRole("button", { name: "Manage access" })).toBeVisible();
    expect(panel.queryByRole("group", { name: "Package job progress" })).not.toBeInTheDocument();
  });

  it("labels preview preparation and permits replacing it with a different action", () => {
    const { panel } = mount({ selectedCount: 2, preparingAction: "block" });
    expect(panel.getByRole("status")).toHaveTextContent("Preparing block preview…");
    expect(panel.getByRole("button", { name: "Block selected packages" })).toBeDisabled();
    expect(panel.getByRole("button", { name: "Unblock selected packages" })).toBeEnabled();
  });

  it("does not offer status recovery for a submission that returned no job identity", () => {
    const { panel } = mount({ selectedCount: 2, jobError: "Submission denied." });
    expect(panel.getByRole("alert")).toHaveTextContent("Submission denied.");
    expect(panel.queryByRole("button", { name: "Refresh status" })).not.toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Block selected packages" })).toBeEnabled();
  });

  it("shows one job summary with progress and cancellation, not duplicate or disabled selection actions", async () => {
    const { panel, props } = mount({ job: running, selectedCount: 1, busyAction: "block" });
    expect(screen.getAllByRole("region")).toHaveLength(1);
    expect(panel.getAllByRole("status")).toHaveLength(1);
    expect(panel.getByRole("status")).toHaveTextContent("Running");
    expect(panel.getByText("4 published versions in this job")).toBeVisible();
    expect(panel.getByText("1 of 4 processed")).toBeVisible();
    expect(panel.getByText("25%")).toBeVisible();
    expect(panel.getByRole("progressbar", { name: "Block packages progress" })).toHaveAttribute("value", "1");
    expect(panel.getByText(/Current agent:/)).toHaveTextContent("Support agent");
    expect(panel.getAllByText("1 succeeded")).toHaveLength(1);
    expect(panel.queryByRole("button", { name: /Block selected packages/ })).not.toBeInTheDocument();
    const cancel = panel.getByRole("button", { name: "Cancel unprocessed tasks" });
    expect(cancel).toHaveClass("secondary", "bulk-job-cancel");
    expect(cancel).toHaveAttribute("title", expect.stringContaining("changes already in progress may still finish"));
    await userEvent.click(cancel);
    expect(props.onJobCommand).toHaveBeenCalledExactlyOnceWith("cancel");
  });

  it("shows starting progress without controls for a job not accepted yet", () => {
    const { panel } = mount({
      busyAction: "unblock", selectedCount: 1,
      progress: { action: "unblock", targetBlockedState: false, total: 1, completed: 0, succeeded: 0, failed: 0, skipped: 0 },
    });
    expect(panel.getByRole("status")).toHaveTextContent("Starting");
    expect(panel.getByText("1 published version in this job")).toBeVisible();
    expect(panel.getByRole("progressbar", { name: "Unblock packages progress" })).toHaveAttribute("value", "0");
    expect(panel.queryAllByRole("button")).toHaveLength(0);
  });

  it.each<[BulkJobStatus, string]>([
    ["queued", "Queued"], ["running", "Running"], ["waiting_authorization", "Sign-in required"],
    ["partial", "Needs review"], ["succeeded", "Completed"], ["failed", "Failed"], ["cancelled", "Cancelled"],
  ])("labels %s accurately without showing stale current work", (status, label) => {
    const { panel } = mount({ job: { ...running, status } });
    expect(panel.getByRole("status")).toHaveTextContent(label);
    expect(panel.queryByText(/Current agent:/) !== null).toBe(status === "running");
  });

  it("preserves sign-in, resume and read-only reconciliation inside the same panel", async () => {
    vi.mocked(getBulkActionJobItems).mockResolvedValue({ value: [{ id: "uncertain", displayName: "Uncertain agent",
      status: "inconclusive", reconciliationStatus: "required", message: "Provider response lost." }],
    revision: "1", counts: { total: 4, filtered: 4 }, page: { limit: 50, nextCursor: null, previousCursor: null } });
    const { panel, props } = mount({ job: {
      ...running, status: "waiting_authorization", canResume: true, inconclusive: 1, reconciliationRequired: 1,
    } });
    expect(panel.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/api/auth/login");
    await userEvent.click(panel.getByRole("button", { name: "Resume unprocessed tasks" }));
    await userEvent.click(panel.getByRole("button", { name: "Check uncertain results" }));
    expect(props.onJobCommand).toHaveBeenNthCalledWith(1, "resume");
    expect(props.onJobCommand).toHaveBeenNthCalledWith(2, "reconcile");
    expect(panel.getByText("1 uncertain")).toBeVisible();
    expect(await panel.findByText("Provider response lost.")).toBeVisible();
  });

  it.each(["cancel", "resume", "reconcile"] as const)("disables recovery controls while %s is pending", async operation => {
    vi.mocked(getBulkActionJobItems).mockResolvedValueOnce({
      value: [{ id: "result", displayName: "Saved result", status: "succeeded" }], revision: "1",
      counts: { total: 4, filtered: 4 }, page: { limit: 1, nextCursor: "next", previousCursor: "previous" },
    });
    const { panel } = mount({ jobCommand: operation, job: {
      ...running, status: "partial", canResume: true, inconclusive: 1, reconciliationRequired: 1,
    } });
    await panel.findByText("Saved result");
    for (const button of panel.getAllByRole("button")) expect(button).toBeDisabled();
    expect(panel.getByRole("status")).toHaveTextContent(operation === "cancel" ? "Cancelling" : operation === "resume" ? "Resuming" : "Checking results");
  });

  it.each([false, true])("keeps cancellation gated when metadata or Admin access is missing (metadata: %s)", metadata => {
    const { panel } = mount({ job: running }, metadata ? ["AgentControl.Viewer"] : user.roles, metadata);
    expect(panel.getByRole("button", { name: "Cancel unprocessed tasks" })).toBeDisabled();
  });

  it("shows terminal counts once and does not imply that cancellation undid applied changes", () => {
    const results: BulkPackageResult[] = [
      { id: "completed", displayName: "Completed agent", status: "succeeded" },
      { id: "cancelled", displayName: "Cancelled agent", status: "cancelled" },
    ];
    const result = { targetBlockedState: true, total: 2, succeeded: 1, failed: 0, skipped: 0, results };
    const { panel } = mount({ result, job: { ...running, total: 2, completed: 2, status: "cancelled", cancelled: 1 } });
    expect(panel.getAllByText("1 succeeded")).toHaveLength(1);
    expect(panel.getByText("1 cancelled")).toBeVisible();
    expect(panel.getByText(/Changes already in progress may still finish/)).toBeVisible();
    expect(panel.queryByRole("button", { name: /Cancel|Resume/ })).not.toBeInTheDocument();
  });

  it.each(["running", "partial"] as const)("does not offer unavailable reconciliation or repeat cancellation after a %s job was cancelled", async status => {
    vi.mocked(getBulkActionJobItems).mockResolvedValue({
      value: [{ id: "uncertain", displayName: "Uncertain agent", status: "inconclusive", reconciliationStatus: "required" }],
      revision: "1", counts: { total: 4, filtered: 4 }, page: { limit: 50, nextCursor: null, previousCursor: null },
    });
    const { panel } = mount({ job: { ...running, status, cancelRequested: true, inconclusive: 1, reconciliationRequired: 1 } });
    expect(panel.queryByRole("button", { name: /Check uncertain results|Cancel unprocessed tasks|Resume unprocessed tasks/ })).not.toBeInTheDocument();
    expect(panel.getByText(/cancelled jobs cannot be reconciled or resumed/)).toBeVisible();
    expect(panel.getByText("1 uncertain")).toBeVisible();
    expect(await panel.findByText("Uncertain agent")).toBeVisible();
  });

  it("uses the right operation for access jobs and keeps request errors in the panel", () => {
    const { panel } = mount({
      job: { ...running, action: "update-installation", targetBlockedState: undefined,
        accessUpdate: { target: "installation", mode: "replace", scope: "none", principals: [] } },
      jobError: "Cancellation failed. Retry.",
    });
    expect(panel.getByRole("progressbar", { name: "Update installation progress" })).toBeVisible();
    expect(panel.getByRole("alert")).toHaveTextContent("Cancellation failed. Retry.");
    expect(panel.getByRole("button", { name: "Cancel unprocessed tasks" })).toBeEnabled();
  });

  it("shows a failed job's server error instead of only a generic failed status", () => {
    const { panel } = mount({ job: { ...running, status: "failed", error: "Saved targets are no longer available." } });
    expect(panel.getByRole("alert")).toHaveTextContent("Saved targets are no longer available.");
  });

  it("offers a read-only status refresh in the progress panel after polling fails", async () => {
    const { panel, props } = mount({ job: running, jobError: "Automatic status updates paused." });
    await userEvent.click(panel.getByRole("button", { name: "Refresh status" }));
    expect(props.onJobCommand).toHaveBeenCalledExactlyOnceWith("refresh");
  });

  it("labels interrupted status as last reported without implying that polling is still running", () => {
    const { panel, container } = mount({ job: running, jobError: "Automatic status updates paused." });
    expect(panel.getByRole("status")).toHaveTextContent("Last reported: Running");
    expect(panel.getByText(/Last reported agent:/)).toHaveTextContent("Support agent");
    expect(container.querySelector(".agent-refresh-spinner")).not.toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Refresh status" })).toBeEnabled();
  });

  it("keeps current status while following running work after a cancellation failure", () => {
    const { panel, container } = mount({ job: running, busyAction: "block", jobError: "Cancellation unavailable." });
    expect(panel.getByRole("status")).toHaveTextContent(/^Running$/);
    expect(panel.getByText(/Current agent:/)).toHaveTextContent("Support agent");
    expect(container.querySelector(".agent-refresh-spinner")).toBeInTheDocument();
  });

  it("retries a failed result page once without refreshing the job or replaying a mutation", async () => {
    let resolve!: (page: BulkJobItemPage) => void;
    vi.mocked(getBulkActionJobItems).mockRejectedValueOnce(new Error("Result read unavailable."))
      .mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { panel, props } = mount({ job: running });
    expect(await panel.findByRole("alert")).toHaveTextContent("Result read unavailable.");
    const retry = panel.getByRole("button", { name: "Retry results" });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    await waitFor(() => expect(getBulkActionJobItems).toHaveBeenCalledTimes(2));
    expect(panel.queryByRole("alert")).not.toBeInTheDocument();
    expect(panel.getByText("Loading job results…")).toBeVisible();
    await act(async () => resolve({ value: [], revision: "1", counts: { total: 4, filtered: 4 },
      page: { limit: 50, nextCursor: null, previousCursor: null } }));
    expect(panel.getByText("No results.")).toBeVisible();
    expect(props.onJobCommand).not.toHaveBeenCalled();
  });

  it("offers status recovery when only the result-page revision has expired", async () => {
    vi.mocked(getBulkActionJobItems).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "changed"));
    const { panel, props } = mount({ job: { ...running, status: "partial" } });
    expect(await panel.findByRole("alert")).toHaveTextContent("Job results changed");
    await userEvent.click(panel.getByRole("button", { name: "Refresh status" }));
    expect(props.onJobCommand).toHaveBeenCalledExactlyOnceWith("refresh");
    expect(getBulkActionJobItems).toHaveBeenCalledOnce();
  });

  it.each(["owner", "job", "revision"] as const)("cancels obsolete result reads across a changed %s and ignores late results", async boundary => {
    let resolve!: (page: BulkJobItemPage) => void;
    vi.mocked(getBulkActionJobItems).mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockResolvedValueOnce({ value: [{ id: "new", displayName: "Current result", status: "succeeded" }],
        revision: "2", counts: { total: 1, filtered: 1 }, page: { limit: 50, nextCursor: null, previousCursor: null } });
    const view = render(<BulkJobItems job={running} owner="first-session" />);
    await waitFor(() => expect(getBulkActionJobItems).toHaveBeenCalledOnce());
    const signal = vi.mocked(getBulkActionJobItems).mock.calls[0][2]!.signal!;
    view.rerender(<BulkJobItems owner={boundary === "owner" ? "next-session" : "first-session"}
      job={{ ...running, id: boundary === "job" ? "next-job" : running.id, resultRevision: boundary === "revision" ? "2" : "1" }} />);
    expect(await screen.findByText("Current result")).toBeVisible();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({
      value: [{ id: "old", displayName: "Retired result", status: "failed" }], revision: "1",
      counts: { total: 1, filtered: 1 }, page: { limit: 50, nextCursor: null, previousCursor: null },
    }));
    expect(screen.queryByText("Retired result")).not.toBeInTheDocument();
    expect(screen.getByText("Current result")).toBeVisible();
    expect(getBulkActionJobItems).toHaveBeenCalledTimes(2);
  });
});
