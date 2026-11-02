import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  automaticDataSyncSourceIds,
  type DataSyncRun,
  type DataSyncSourceId,
  type DataSyncSourceState,
  type DataSyncSourceStatus,
  type DataSyncState,
} from "../api/client";
import { mockNativeDialogs } from "../test/dialog";
import { FirstSyncNotice } from "./FirstSyncNotice";
import { syncStatusLabel } from "./syncPresentation";

mockNativeDialogs();

vi.mock("../workbenchActionContext", () => ({
  WorkbenchActionGate: ({ children }: { children: ReactNode }) => children,
}));

function source(id: DataSyncSourceId, status: DataSyncSourceState, count: number | null = null): DataSyncSourceStatus {
  return {
    source: id,
    status,
    count,
    jobId: null,
    lastSuccessAt: status === "succeeded" ? "2026-09-15T10:00:00Z" : null,
    updatedAt: "2026-09-15T10:01:00Z",
    message: `Current attempt: ${status}.`,
    canRetry: status !== "succeeded",
  };
}

function renderNotice(
  status: DataSyncSourceState,
  runStatus: DataSyncRun["status"],
  savedCount: number | null = 42,
  message = `Current attempt: ${status}.`,
) {
  const state: DataSyncState = {
    onboardingRequired: true,
    usageImportRequired: true,
    sources: automaticDataSyncSourceIds.map(id => source(id, id === "users" ? "succeeded" : "not_started", id === "users" ? savedCount : null)),
    run: {
      id: "automatic-run",
      automatic: true,
      mode: "incremental",
      status: runStatus,
      startedAt: "2026-09-15T10:01:00Z",
      updatedAt: "2026-09-15T10:02:00Z",
      completedAt: runStatus === "running" ? null : "2026-09-15T10:02:00Z",
      sources: [{ ...source("users", status, 17), message }],
    },
  };
  const onStart = vi.fn();
  const onOpenPermissions = vi.fn();
  const onDismiss = vi.fn();
  render(<FirstSyncNotice
    state={state} loading={false} error="" stale={false} cannotStart={runStatus === "running"}
    onStart={onStart} onCancel={vi.fn()} onCheckStatus={vi.fn()}
    onOpenPermissions={onOpenPermissions} onDismiss={onDismiss}
  />);
  const row = within(screen.getByRole("list", { name: "First sync sources" })).getAllByRole("listitem")[0];
  return { row, onStart, onOpenPermissions, onDismiss };
}

describe("FirstSyncNotice", () => {
  it.each([
    { status: "queued", runStatus: "running" },
    { status: "running", runStatus: "running" },
    { status: "failed", runStatus: "partial" },
    { status: "partial", runStatus: "partial" },
    { status: "permission_required", runStatus: "partial" },
    { status: "waiting_authorization", runStatus: "partial" },
    { status: "cancelled", runStatus: "cancelled" },
  ] as const)("retains saved progress and exposes the $status attempt and its recovery", async ({ status, runStatus }) => {
    const { row, onStart, onOpenPermissions, onDismiss } = renderNotice(status, runStatus);

    expect(screen.getByRole("progressbar", { name: "First sync sources saved" })).toHaveAttribute("value", "1");
    expect(within(row).getByText("42 directory users checked saved")).toBeVisible();
    expect(within(row).getByText(syncStatusLabel(status))).toBeVisible();
    expect(row).not.toHaveTextContent("17 directory users checked saved");
    expect(within(row).getByText(status === "queued" ? "Waiting to start." : `Current attempt: ${status}.`)).toBeVisible();
    if (status === "running") expect(within(row).getByText("17 processed in this stage")).toBeVisible();
    else expect(within(row).queryByText("17 processed in this stage")).not.toBeInTheDocument();
    if (["failed", "partial", "permission_required", "waiting_authorization"].includes(status)) {
      expect(screen.getByRole("heading", { name: "First sync needs attention" })).toBeVisible();
    }
    if (status === "permission_required") {
      await userEvent.click(within(row).getByRole("button", { name: "Review permissions" }));
      expect(onOpenPermissions).toHaveBeenCalledOnce();
      expect(screen.getAllByRole("button", { name: "Review permissions" })).toHaveLength(1);
    } else {
      expect(screen.queryByRole("button", { name: "Review permissions" })).not.toBeInTheDocument();
    }
    if (status === "waiting_authorization") {
      expect(within(row).getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/api/auth/login");
      expect(screen.getAllByRole("link", { name: "Sign in again" })).toHaveLength(1);
    } else {
      expect(screen.queryByRole("link", { name: "Sign in again" })).not.toBeInTheDocument();
    }
    if (runStatus === "running") {
      expect(screen.queryByRole("button", { name: "Retry incomplete sources" })).not.toBeInTheDocument();
      expect(onStart).not.toHaveBeenCalled();
    } else {
      await userEvent.click(screen.getByRole("button", { name: "Retry incomplete sources" }));
      expect(onStart).toHaveBeenCalledExactlyOnceWith(["graph_packages", "power_platform"]);
    }
    await userEvent.click(screen.getByRole("button", { name: "Continue to workspace" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it.each([0, null])("keeps a saved count of %s separate from running observations", savedCount => {
    const { row } = renderNotice("running", "running", savedCount);

    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1");
    expect(within(row).getByText(savedCount === null ? "Saved successfully." : "0 directory users checked saved")).toBeVisible();
    expect(within(row).getByText("17 processed in this stage")).toBeVisible();
    expect(row).not.toHaveTextContent("17 directory users checked saved");
    expect(row).not.toHaveTextContent("No successful collection yet.");
  });

  it("continues to use saved markers when a successful attempt has not been revalidated", () => {
    const { row } = renderNotice("succeeded", "completed");

    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1");
    expect(within(row).getByText("Complete")).toBeVisible();
    expect(within(row).getByText("42 directory users checked saved")).toBeVisible();
    expect(row).not.toHaveTextContent("17 directory users checked saved");
    expect(row).not.toHaveTextContent("Current attempt:");
  });

  it("does not imply that a failed retry removed saved data when its message is empty", () => {
    const { row } = renderNotice("failed", "partial", 42, "");

    expect(within(row).getByText("Failed")).toBeVisible();
    expect(within(row).getByText("42 directory users checked saved")).toBeVisible();
    expect(within(row).getByText("No new collection has completed.")).toBeVisible();
    expect(row).not.toHaveTextContent("No successful collection yet.");
  });
});
