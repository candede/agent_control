import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PackageDetailSyncState } from "../api/client";
import { PackageDetailsSyncPanel, type PackageDetailsSyncPanelHandle } from "./PackageDetailsSyncPanel";

const api = vi.hoisted(() => ({ read: vi.fn(), start: vi.fn(), cancel: vi.fn() }));
vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(),
  getPackageDetailSyncState: api.read, startPackageDetailSync: api.start, cancelPackageDetailSync: api.cancel,
}));
vi.mock("../workbenchActionContext", () => ({
  WorkbenchActionGate: ({ children }: { children: React.ReactNode }) => children,
}));
const initial: PackageDetailSyncState = {
  status: "ready", total: 1_216, fresh: 140, pending: 1_076, eligible: 1_076,
  message: "Catalog sync alone does not collect exact details.", job: null,
};
function props() {
  return { principalKey: "viewer-1", revision: "catalog-1", onStateChanged: vi.fn(), onPublicationChanged: vi.fn(),
    onStartRequested: vi.fn(), onCancelRequested: vi.fn() };
}
describe("visible package detail collection", () => {
  beforeEach(() => {
    api.read.mockReset().mockResolvedValue(initial);
    api.start.mockReset();
    api.cancel.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("shows the actual post-reset gap without labeling the catalog as complete details", async () => {
    render(<PackageDetailsSyncPanel {...props()} />);
    expect(await screen.findByText("140 / 1,216")).toBeVisible();
    expect(screen.getByText("packages fresh; 1,076 pending")).toBeVisible();
    expect(screen.getByText("Details pending", { exact: true })).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Package detail coverage" })).toHaveAttribute("max", "1216");
    expect(screen.getByRole("button", { name: "Sync package details" })).toBeEnabled();
  });

  it.each([0, 1_217])("shows completed coverage for %i packages without implying ongoing work or a force-refresh action", async total => {
    api.read.mockResolvedValue({ ...initial, status: "complete", total, fresh: total, pending: 0, eligible: 0,
      message: "Exact package details are fresh for every package in the current saved catalog." });
    render(<PackageDetailsSyncPanel {...props()} />);
    expect(await screen.findByText(`${total.toLocaleString()} / ${total.toLocaleString()}`)).toBeVisible();
    expect(screen.getByText("packages fresh; 0 pending")).toBeVisible();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Sync package details" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "No pending or stale package details to collect.");
    expect(screen.getByText(/does not force a reread of fresh details/)).toBeVisible();
    expect(screen.queryByText(/Runs in paced/)).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(api.start).not.toHaveBeenCalled();
  });

  it("starts, observes publication progress and cancels the bounded detail collection", async () => {
    const callbacks = props();
    const running: PackageDetailSyncState = { ...initial, status: "running", fresh: 160, pending: 1_056, eligible: 1_036,
      job: { id: "detail-job", status: "running", targetCount: 20, observedCount: 7, updatedAt: "2026-10-12T17:10:00Z" } };
    api.start.mockResolvedValue(running);
    api.cancel.mockResolvedValue({ ...running, status: "paused", job: { ...running.job!, status: "cancelled" } });
    render(<PackageDetailsSyncPanel {...callbacks} />);
    await screen.findByText("Details pending", { exact: true });
    api.read.mockResolvedValue(running);
    fireEvent.click(screen.getByRole("button", { name: "Sync package details" }));
    expect(await screen.findByText("Syncing", { exact: true })).toBeVisible();
    expect(api.start).toHaveBeenCalledOnce();
    expect(callbacks.onStartRequested).toHaveBeenCalledOnce();
    expect(callbacks.onPublicationChanged).toHaveBeenCalledOnce();
    expect(screen.getByText(/7 of 20 targets checked/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel detail collection" })).toHaveTextContent("Cancel details");
    api.read.mockResolvedValue({ ...running, status: "paused", job: { ...running.job!, status: "cancelled" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel detail collection" }));
    expect(await screen.findByText("Cancelled", { exact: true })).toBeVisible();
    expect(api.cancel).toHaveBeenCalledOnce();
    expect(callbacks.onCancelRequested).toHaveBeenCalledOnce();
  });

  it("does not silently keep a complete claim when status cannot be reverified", async () => {
    const callbacks = props();
    const ref = createRef<PackageDetailsSyncPanelHandle>();
    api.read.mockRejectedValue(new Error("Status unavailable"));
    render(<PackageDetailsSyncPanel ref={ref} {...callbacks} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Status unavailable");
    expect(callbacks.onStateChanged).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByRole("button", { name: "Sync package details" })).toBeDisabled();
    api.read.mockResolvedValue(initial);
    await act(async () => ref.current!.refresh());
    expect(await screen.findByText("Details pending", { exact: true })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("fences a previous principal's late private status response", async () => {
    let resolve!: (value: PackageDetailSyncState) => void;
    api.read.mockReturnValueOnce(new Promise<PackageDetailSyncState>(done => { resolve = done; }))
      .mockResolvedValue({ ...initial, total: 5, fresh: 5, pending: 0, eligible: 0, status: "complete" });
    const callbacks = props();
    const view = render(<PackageDetailsSyncPanel {...callbacks} />);
    await waitFor(() => expect(api.read).toHaveBeenCalledOnce());
    view.rerender(<PackageDetailsSyncPanel {...callbacks} principalKey="viewer-2" />);
    await screen.findByText("5 / 5");
    await act(async () => resolve(initial));
    expect(screen.queryByText("140 / 1,216")).not.toBeInTheDocument();
  });

  it.each([
    ["ready", "Details pending"],
    ["waiting_authorization", "Sign-in required"],
    ["permission_required", "Permission required"],
    ["failed", "Failed"],
    ["paused", "Cancelled"],
  ] as const)("retains truthful %s coverage despite a successful previous batch", async (status, label) => {
    api.read.mockResolvedValue({ ...initial, status, eligible: 0, message: "Remaining packages are waiting for retry.",
      job: { id: "previous-batch", status: "succeeded", targetCount: 20, observedCount: 20, updatedAt: "2026-10-12T17:10:00Z" } });
    render(<PackageDetailsSyncPanel {...props()} />);
    expect(await screen.findByText(label, { exact: true })).toBeVisible();
    expect(screen.getByText("140 / 1,216")).toBeVisible();
    expect(screen.queryByText("Complete", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("Latest batch update")).toBeVisible();
    expect(screen.queryByText("Last successful sync")).not.toBeInTheDocument();
    expect(screen.getByText("Remaining packages are waiting for retry.")).toBeVisible();
  });
});
import { createRef } from "react";
