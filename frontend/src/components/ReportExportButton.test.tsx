import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReportExportButton } from "./ReportExportButton";
import { cancelReportExport, createReportExport, reportExportStatus } from "../api/reportData";
import { ApiError } from "../api/client";

vi.mock("../api/reportData", () => ({ createReportExport: vi.fn(), reportExportStatus: vi.fn(), cancelReportExport: vi.fn(),
  reportExportDownload: (id: string) => `/api/data-exports/${id}/download` }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("finishes an admitted frozen export after the read lease ends without admitting another export", async () => {
  vi.useFakeTimers();
  vi.mocked(createReportExport).mockResolvedValue({ id: "frozen-artifact" });
  vi.mocked(reportExportStatus).mockResolvedValue({ id: "frozen-artifact", status: "ready", rows: 3, bytes: 100,
    expiresAt: "2030-01-01T00:00:00Z", error: null, limit: null, observed: null });
  let active = true;
  const props = { selectionId: "frozen-selection", kind: "official_users" as const, label: "Export", admissionAllowed: () => active };
  const view = render(<ReportExportButton {...props} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  const signal = vi.mocked(createReportExport).mock.calls[0][1]!;
  active = false;
  view.rerender(<ReportExportButton {...props} />);
  expect(signal.aborted).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", "/api/data-exports/frozen-artifact/download");
  expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
  expect(createReportExport).toHaveBeenCalledOnce();
  expect(reportExportStatus).toHaveBeenCalledExactlyOnceWith("frozen-artifact", signal);
});

it("checks export admission against the monotonic lease before the timer renders", () => {
  let active = true;
  render(<ReportExportButton selectionId="frozen" kind="official_users" label="Export" admissionAllowed={() => active} />);
  active = false;
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  expect(createReportExport).not.toHaveBeenCalled();
});

it.each(["admission", "building", "ready", "retry"] as const)("keeps a %s export independent of the current table selection", async phase => {
  vi.useFakeTimers();
  let admit!: (value: { id: string }) => void;
  vi.mocked(createReportExport).mockReturnValueOnce(new Promise(resolve => { admit = resolve; }))
    .mockResolvedValue({ id: "new-artifact" });
  const ready = { id: "artifact", status: "ready" as const, rows: 117, bytes: 100,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), error: null, limit: null, observed: null };
  if (phase === "retry") vi.mocked(reportExportStatus).mockRejectedValueOnce(new Error("Status unavailable."));
  vi.mocked(reportExportStatus).mockResolvedValue(phase === "building" ? { ...ready, status: "building" } : ready);
  const props = { kind: "official_users" as const, label: "Export", preserveOnRefresh: true };
  const view = render(<ReportExportButton {...props} selectionId="original" />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export" })));
  if (phase !== "admission") await act(async () => { admit({ id: "artifact" }); await vi.advanceTimersByTimeAsync(2000); });
  const signal = vi.mocked(createReportExport).mock.calls[0][1]!;
  view.rerender(<ReportExportButton {...props} disabled />);
  expect(signal.aborted).toBe(false);
  view.rerender(<ReportExportButton {...props} selectionId="replacement" />);
  if (phase === "retry") {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry export status" }));
      await vi.advanceTimersByTimeAsync(2000);
    });
  } else {
    vi.mocked(reportExportStatus).mockResolvedValue(ready);
    await act(async () => { if (phase === "admission") admit({ id: "artifact" }); await vi.advanceTimersByTimeAsync(3000); });
  }
  expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", "/api/data-exports/artifact/download");
  expect(createReportExport).toHaveBeenCalledOnce();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export" })));
  expect(vi.mocked(createReportExport).mock.lastCall?.[0].selectionId).toBe("replacement");
  expect(createReportExport).toHaveBeenCalledTimes(2);
});

it("does not invalidate a refreshed table when an older export selection is rejected", async () => {
  vi.useFakeTimers();
  vi.mocked(createReportExport).mockResolvedValue({ id: "artifact" });
  vi.mocked(reportExportStatus).mockRejectedValue(new ApiError(409, "selection_invalidated", "Old selection retired."));
  const onSelectionInvalidated = vi.fn();
  const props = { kind: "official_users" as const, label: "Export", preserveOnRefresh: true, onSelectionInvalidated };
  const view = render(<ReportExportButton {...props} selectionId="original" />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export" })));
  view.rerender(<ReportExportButton {...props} selectionId="replacement" />);
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByRole("alert")).toHaveTextContent("Export selection changed or expired.");
  expect(onSelectionInvalidated).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
});

it("aborts and clears a disabled owner's pending state, then permits a new explicit request", async () => {
  vi.useFakeTimers();
  vi.mocked(createReportExport).mockResolvedValue({ id: "artifact" });
  const props = { selectionId: "selected", kind: "official_users" as const, label: "Export" };
  const view = render(<ReportExportButton {...props} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  const signal = vi.mocked(createReportExport).mock.calls[0][1]!;
  view.rerender(<ReportExportButton {...props} disabled />);
  expect(signal.aborted).toBe(true);
  await act(async () => {});
  view.rerender(<ReportExportButton {...props} />);
  expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  expect(createReportExport).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(reportExportStatus).not.toHaveBeenCalled();
});

it("cancellation setup belongs to the component and is aborted on unmount", async () => {
  vi.mocked(createReportExport).mockResolvedValue({ id: "artifact" });
  vi.mocked(cancelReportExport).mockImplementation((_id, signal) => new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const view = render(<ReportExportButton selectionId="selected" kind="official_users" label="Export" />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
  const signal = vi.mocked(cancelReportExport).mock.calls[0][1]!;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => {});
});

it("admits only one export when an explicit click races automatic startup", async () => {
  vi.mocked(createReportExport).mockImplementation(() => new Promise(() => {}));
  render(<ReportExportButton selectionId="selected" kind="unified_agents" label="Export" autoStart />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  expect(createReportExport).toHaveBeenCalledOnce();
});

it("keeps ready-export cancellation busy and admits only one cancellation", async () => {
  vi.useFakeTimers();
  vi.mocked(createReportExport).mockResolvedValue({ id: "artifact" });
  vi.mocked(reportExportStatus).mockResolvedValue({
    id: "artifact", status: "ready", rows: 1, bytes: 10, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    error: null, limit: null, observed: null,
  });
  let finish!: () => void;
  vi.mocked(cancelReportExport).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const onPendingChange = vi.fn();
  render(<ReportExportButton selectionId="selected" kind="unified_agents" label="Export" onPendingChange={onPendingChange} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  const cancel = screen.getByRole("button", { name: "Cancel export" });
  await act(async () => { fireEvent.click(cancel); fireEvent.click(cancel); });
  expect(cancelReportExport).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Cancelling export..." })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
  expect(onPendingChange).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
  await act(async () => finish());
  expect(screen.getByRole("alert")).toHaveTextContent("Export cancelled.");
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
  expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
});

it.each(["success", "failure"] as const)("discards a late cancellation %s after disabling and restoring the same selection", async outcome => {
  vi.mocked(createReportExport).mockResolvedValue({ id: "artifact" });
  let finish!: () => void;
  vi.mocked(cancelReportExport).mockImplementation(() => new Promise((resolve, reject) => {
    finish = () => outcome === "success" ? resolve() : reject(new Error("Old cancellation failed."));
  }));
  const props = { selectionId: "selected", kind: "unified_agents" as const, label: "Export" };
  const view = render(<ReportExportButton {...props} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
  const signal = vi.mocked(cancelReportExport).mock.calls[0][1]!;
  view.rerender(<ReportExportButton {...props} disabled />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  view.rerender(<ReportExportButton {...props} />);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
});

it("permits an explicit cancellation retry without leaving the export falsely preparing", async () => {
  vi.mocked(createReportExport).mockResolvedValue({ id: "artifact" });
  vi.mocked(cancelReportExport).mockRejectedValueOnce(new Error("Cancellation failed.")).mockResolvedValueOnce();
  render(<ReportExportButton selectionId="selected" kind="unified_agents" label="Export" />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel export" })); });
  expect(screen.getByRole("alert")).toHaveTextContent("Cancellation failed.");
  expect(screen.getByRole("button", { name: "Retry export status" })).toBeEnabled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel export" })); });
  expect(cancelReportExport).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("alert")).toHaveTextContent("Export cancelled.");
});

it.each(["building", "ready"] as const)("withdraws unverified %s progress after cancellation failure and reconciles the same job", async phase => {
  vi.useFakeTimers();
  vi.mocked(createReportExport).mockResolvedValue({ id: "artifact" });
  const ready = { id: "artifact", status: "ready" as const, rows: 1, bytes: 10,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), error: null, limit: null, observed: null };
  vi.mocked(reportExportStatus).mockResolvedValueOnce({ ...ready, status: phase })
    .mockResolvedValueOnce({ ...ready, status: "cancelled" });
  vi.mocked(cancelReportExport).mockRejectedValue(new ApiError(0, "network_error", "Cancellation response lost.", { kind: "network" }));
  const onPendingChange = vi.fn(), onSelectionInvalidated = vi.fn();
  render(<ReportExportButton selectionId="selected" kind="unified_agents" label="Export" autoStart
    onPendingChange={onPendingChange} onSelectionInvalidated={onSelectionInvalidated} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByRole("status")).toHaveTextContent(phase);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel export" })); });
  expect(screen.getByRole("alert")).toHaveTextContent("Cancellation response lost.");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
  expect(screen.getByRole("button", { name: "Cancel export" })).toBeEnabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(reportExportStatus).toHaveBeenCalledOnce();
  const retry = screen.getByRole("button", { name: "Retry export status" });
  await act(async () => { fireEvent.click(retry); fireEvent.click(retry); });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(onPendingChange).toHaveBeenLastCalledWith(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(reportExportStatus).toHaveBeenCalledTimes(2);
  expect(reportExportStatus).toHaveBeenLastCalledWith("artifact", expect.any(AbortSignal));
  expect(createReportExport).toHaveBeenCalledOnce();
  expect(screen.getByRole("status")).toHaveTextContent("cancelled");
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
  expect(onSelectionInvalidated).not.toHaveBeenCalled();
  const previousKey = vi.mocked(createReportExport).mock.calls[0][0].idempotencyKey;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  expect(createReportExport).toHaveBeenCalledTimes(2);
  expect(vi.mocked(createReportExport).mock.calls[1][0].idempotencyKey).not.toBe(previousKey);
});

it("withdraws prior build progress when a later status read invalidates the selection", async () => {
  vi.useFakeTimers();
  vi.mocked(createReportExport).mockResolvedValue({ id: "artifact" });
  vi.mocked(reportExportStatus).mockResolvedValueOnce({ id: "artifact", status: "building", rows: 1, bytes: 10,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), error: null, limit: null, observed: null })
    .mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Selection retired."));
  const onSelectionInvalidated = vi.fn(), onPendingChange = vi.fn();
  render(<ReportExportButton selectionId="selected" kind="unified_agents" label="Export" autoStart
    onSelectionInvalidated={onSelectionInvalidated} onPendingChange={onPendingChange} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByRole("status")).toHaveTextContent("building");
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByRole("alert")).toHaveTextContent("Export selection changed or expired.");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Retry export|Cancel export/ })).not.toBeInTheDocument();
  expect(onSelectionInvalidated).toHaveBeenCalledOnce();
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(reportExportStatus).toHaveBeenCalledTimes(2);
  expect(createReportExport).toHaveBeenCalledOnce();
});

it("invalidates exact selections rejected with the backend's missing-reference code", async () => {
  vi.mocked(createReportExport).mockRejectedValue(new ApiError(409, "export_selection_changed", "An exact selected source is missing or ambiguous."));
  const onSelectionInvalidated = vi.fn();
  render(<ReportExportButton selectionId="selected" kind="unified_agents" label="Export" onSelectionInvalidated={onSelectionInvalidated} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  expect(onSelectionInvalidated).toHaveBeenCalledOnce();
  expect(screen.getByRole("alert")).toHaveTextContent("Export selection changed or expired.");
});

it("deduplicates download verification and discards its late result after cancellation", async () => {
  vi.useFakeTimers();
  vi.mocked(createReportExport).mockResolvedValue({ id: "artifact" });
  const ready = { id: "artifact", status: "ready" as const, rows: 1, bytes: 10,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), error: null, limit: null, observed: null };
  let finish!: (value: typeof ready) => void;
  vi.mocked(reportExportStatus).mockResolvedValueOnce(ready)
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.mocked(cancelReportExport).mockResolvedValue();
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<ReportExportButton selectionId="selected" kind="unified_agents" label="Export" />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  const link = screen.getByRole("link", { name: "Download CSV" });
  link.focus();
  await act(async () => { fireEvent.click(link); fireEvent.click(link); });
  expect(reportExportStatus).toHaveBeenCalledTimes(2);
  expect(link).toHaveAttribute("aria-disabled", "true");
  expect(link).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent("Verifying download...");
  const signal = vi.mocked(reportExportStatus).mock.calls[1][1]!;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel export" })); });
  expect(signal.aborted).toBe(true);
  await act(async () => finish(ready));
  expect(click).not.toHaveBeenCalled();
  expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Export cancelled.");
});

it("does not poll a late admission after cancellation before the export ID is known", async () => {
  vi.useFakeTimers();
  let finish!: (value: { id: string }) => void;
  vi.mocked(createReportExport).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<ReportExportButton selectionId="selected" kind="unified_agents" label="Export" autoStart />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
  expect(vi.mocked(createReportExport).mock.calls[0][1]?.aborted).toBe(true);
  await act(async () => { finish({ id: "obsolete" }); await vi.advanceTimersByTimeAsync(30_000); });
  expect(reportExportStatus).not.toHaveBeenCalled();
  expect(cancelReportExport).not.toHaveBeenCalled();
  expect(createReportExport).toHaveBeenCalledOnce();
  expect(screen.getByRole("alert")).toHaveTextContent("Any already-admitted work will expire automatically.");
  expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
});

it("invalidates the selection when cancellation confirms it is no longer available", async () => {
  vi.mocked(createReportExport).mockResolvedValue({ id: "artifact" });
  vi.mocked(cancelReportExport).mockRejectedValue(new ApiError(409, "selection_invalidated", "Selection changed."));
  const onSelectionInvalidated = vi.fn();
  render(<ReportExportButton selectionId="selected" kind="unified_agents" label="Export" onSelectionInvalidated={onSelectionInvalidated} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel export" })); });
  expect(onSelectionInvalidated).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Cancel export" })).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Export selection changed or expired.");
});

it("retries an uncertain admission with the same immutable intent instead of admitting duplicate work", async () => {
  vi.mocked(createReportExport).mockRejectedValueOnce(new ApiError(0, "network_error", "Admission response lost.", { kind: "network" }))
    .mockResolvedValueOnce({ id: "artifact" });
  const view = render(<ReportExportButton selectionId="selected" kind="unified_agents" ids={["agent:one"]} label="Export" autoStart />);
  await act(async () => {});
  expect(createReportExport).toHaveBeenCalledOnce();
  const first = vi.mocked(createReportExport).mock.calls[0][0];
  expect(first.idempotencyKey).toEqual(expect.any(String));
  const retry = screen.getByRole("button", { name: "Retry export request" });
  await act(async () => { fireEvent.click(retry); fireEvent.click(retry); });
  expect(createReportExport).toHaveBeenCalledTimes(2);
  expect(vi.mocked(createReportExport).mock.calls[1][0]).toEqual(first);
  view.unmount();
});

it.each([false, true])("keeps admitted exports retryable and cancellable after status failure (observed progress: %s)", async observedProgress => {
  vi.useFakeTimers();
  vi.mocked(createReportExport).mockResolvedValue({ id: "artifact" });
  const ready = { id: "artifact", status: "ready" as const, rows: 1, bytes: 10,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), error: null, limit: null, observed: null };
  if (observedProgress) vi.mocked(reportExportStatus).mockResolvedValueOnce({ ...ready, status: "building" });
  vi.mocked(reportExportStatus).mockRejectedValueOnce(new Error("Status is unavailable.")).mockResolvedValueOnce(ready);
  vi.mocked(cancelReportExport).mockResolvedValue();
  const onPendingChange = vi.fn();
  render(<ReportExportButton selectionId="selected" kind="unified_agents" label="Export" autoStart onPendingChange={onPendingChange} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(observedProgress ? 5000 : 2000); });
  expect(screen.getByRole("alert")).toHaveTextContent("Status is unavailable.");
  expect(screen.getByRole("button", { name: "Cancel export" })).toBeEnabled();
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry export status" })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(createReportExport).toHaveBeenCalledOnce();
  expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", "/api/data-exports/artifact/download");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel export" })); });
  expect(cancelReportExport).toHaveBeenCalledWith("artifact", expect.any(AbortSignal));
});

it("recovers a failed download verification by reading the same export, without another admission", async () => {
  vi.useFakeTimers();
  vi.mocked(createReportExport).mockResolvedValue({ id: "artifact" });
  const ready = { id: "artifact", status: "ready" as const, rows: 1, bytes: 10,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), error: null, limit: null, observed: null };
  vi.mocked(reportExportStatus).mockResolvedValueOnce(ready)
    .mockRejectedValueOnce(new Error("Download verification failed.")).mockResolvedValueOnce(ready);
  render(<ReportExportButton selectionId="selected" kind="unified_agents" label="Export" autoStart />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  await act(async () => { fireEvent.click(screen.getByRole("link", { name: "Download CSV" })); });
  expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Download verification failed.");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry export status" })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(createReportExport).toHaveBeenCalledOnce();
  expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", "/api/data-exports/artifact/download");
});

it("cancels an admitted job after a failed status read and starts a new intent only afterward", async () => {
  vi.useFakeTimers();
  vi.mocked(createReportExport).mockResolvedValue({ id: "artifact" });
  vi.mocked(reportExportStatus).mockRejectedValue(new Error("Status unavailable."));
  vi.mocked(cancelReportExport).mockResolvedValue();
  render(<ReportExportButton selectionId="selected" kind="unified_agents" label="Export" autoStart />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  const previousKey = vi.mocked(createReportExport).mock.calls[0][0].idempotencyKey;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel export" })); });
  expect(cancelReportExport).toHaveBeenCalledWith("artifact", expect.any(AbortSignal));
  expect(screen.queryByRole("button", { name: /Retry export/ })).not.toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  expect(createReportExport).toHaveBeenCalledTimes(2);
  expect(vi.mocked(createReportExport).mock.calls[1][0].idempotencyKey).not.toBe(previousKey);
});

it.each(["export_expired", "export_not_found"])("permits a fresh admission after %s without invalidating the inventory", async code => {
  vi.useFakeTimers();
  vi.mocked(createReportExport).mockResolvedValue({ id: "artifact" });
  vi.mocked(reportExportStatus).mockRejectedValue(new ApiError(code === "export_expired" ? 409 : 404, code, "Export unavailable."));
  const onSelectionInvalidated = vi.fn();
  render(<ReportExportButton selectionId="selected" kind="unified_agents" label="Export" autoStart onSelectionInvalidated={onSelectionInvalidated} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByRole("alert")).toHaveTextContent("Export unavailable.");
  expect(screen.queryByRole("button", { name: /Retry export|Cancel export/ })).not.toBeInTheDocument();
  const previousKey = vi.mocked(createReportExport).mock.calls[0][0].idempotencyKey;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  expect(createReportExport).toHaveBeenCalledTimes(2);
  expect(vi.mocked(createReportExport).mock.calls[1][0].idempotencyKey).not.toBe(previousKey);
  expect(onSelectionInvalidated).not.toHaveBeenCalled();
});

it("discards the retry intent and late status after the owning selection changes", async () => {
  vi.useFakeTimers();
  vi.mocked(createReportExport).mockResolvedValueOnce({ id: "old-artifact" }).mockResolvedValueOnce({ id: "new-artifact" });
  let finish!: () => void;
  vi.mocked(reportExportStatus).mockRejectedValueOnce(new Error("Status unavailable."))
    .mockImplementationOnce(() => new Promise((_, reject) => { finish = () => reject(new Error("Obsolete status.")); }))
    .mockResolvedValueOnce({ id: "new-artifact", status: "ready", rows: 1, bytes: 10,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), error: null, limit: null, observed: null });
  const view = render(<ReportExportButton selectionId="old-selection" kind="unified_agents" label="Export" autoStart />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry export status" })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  const obsoleteSignal = vi.mocked(reportExportStatus).mock.calls[1][1]!;
  view.rerender(<ReportExportButton selectionId="new-selection" kind="unified_agents" label="Export" autoStart />);
  expect(obsoleteSignal.aborted).toBe(true);
  await act(async () => { finish(); await vi.advanceTimersByTimeAsync(2000); });
  expect(createReportExport).toHaveBeenCalledTimes(2);
  expect(vi.mocked(createReportExport).mock.calls[1][0]).toMatchObject({ selectionId: "new-selection" });
  expect(vi.mocked(createReportExport).mock.calls[1][0].idempotencyKey)
    .not.toBe(vi.mocked(createReportExport).mock.calls[0][0].idempotencyKey);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", "/api/data-exports/new-artifact/download");
});
