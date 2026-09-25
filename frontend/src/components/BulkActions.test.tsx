import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import type { BulkActionJob, BulkJobStatus, SessionUser } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { BulkActions } from "./BulkActions";

const user: SessionUser = {
  homeAccountId: "fixture", tenantId: "tenant", displayName: "Admin", username: "admin@example.invalid",
  roles: ["AgentControl.Admin"],
};
const running: BulkActionJob = {
  id: "job-1", action: "block", targetBlockedState: true, status: "running", canResume: false,
  total: 4, completed: 1, succeeded: 1, failed: 0, skipped: 0, currentAgentName: "Support agent",
  results: [{ id: "completed", displayName: "Completed agent", status: "succeeded" }],
  createdAt: "2026-09-25T09:00:00Z", updatedAt: "2026-09-25T09:01:00Z",
};
function mount(overrides: Partial<Parameters<typeof BulkActions>[0]> = {}, roles = user.roles, metadata = true) {
  const props = {
    disabled: false, selectedCount: 0,
    onBlockAll: vi.fn(), onUnblockAll: vi.fn(), onManageAccess: vi.fn(), onJobCommand: vi.fn(),
    ...overrides,
  };
  const view = render(<CapabilityContext value={{
    user: { ...user, roles }, views: [], loading: false, pending: false, error: undefined, now: Date.now(),
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
    const { panel, props } = mount({ job: {
      ...running, status: "waiting_authorization", canResume: true,
      results: [{ id: "uncertain", displayName: "Uncertain agent", status: "inconclusive", reconciliationStatus: "required", message: "Provider response lost." }],
    } });
    expect(panel.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/api/auth/login");
    await userEvent.click(panel.getByRole("button", { name: "Resume unprocessed tasks" }));
    await userEvent.click(panel.getByRole("button", { name: "Check uncertain results" }));
    expect(props.onJobCommand).toHaveBeenNthCalledWith(1, "resume");
    expect(props.onJobCommand).toHaveBeenNthCalledWith(2, "reconcile");
    expect(panel.getByText("1 uncertain")).toBeVisible();
    await userEvent.click(panel.getByText("Review 1 failed or uncertain changes"));
    expect(panel.getByText("Provider response lost.")).toBeVisible();
  });

  it.each(["cancel", "resume", "reconcile"] as const)("disables recovery controls while %s is pending", operation => {
    const { panel } = mount({ jobCommand: operation, job: {
      ...running, status: "partial", canResume: true,
      results: [{ id: "uncertain", displayName: "Agent", status: "inconclusive", reconciliationStatus: "required" }],
    } });
    for (const button of panel.getAllByRole("button")) expect(button).toBeDisabled();
    expect(panel.getByRole("status")).toHaveTextContent(operation === "cancel" ? "Cancelling" : operation === "resume" ? "Resuming" : "Checking results");
  });

  it.each([false, true])("keeps cancellation gated when metadata or Admin access is missing (metadata: %s)", metadata => {
    const { panel } = mount({ job: running }, metadata ? ["AgentControl.Viewer"] : user.roles, metadata);
    expect(panel.getByRole("button", { name: "Cancel unprocessed tasks" })).toBeDisabled();
  });

  it("shows terminal counts once and does not imply that cancellation undid applied changes", () => {
    const results: BulkActionJob["results"] = [
      ...running.results, { id: "cancelled", displayName: "Cancelled agent", status: "cancelled" },
    ];
    const result = { targetBlockedState: true, total: 2, succeeded: 1, failed: 0, skipped: 0, results };
    const { panel } = mount({ result, job: { ...running, ...result, completed: 2, status: "cancelled", result } });
    expect(panel.getAllByText("1 succeeded")).toHaveLength(1);
    expect(panel.getByText("1 cancelled")).toBeVisible();
    expect(panel.getByText(/Changes already in progress may still finish/)).toBeVisible();
    expect(panel.queryByRole("button", { name: /Cancel|Resume/ })).not.toBeInTheDocument();
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
});
