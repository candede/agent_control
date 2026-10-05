import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReportExportButton } from "./ReportExportButton";
import { cancelReportExport, createReportExport, reportExportStatus } from "../api/reportData";

vi.mock("../api/reportData", () => ({ createReportExport: vi.fn(), reportExportStatus: vi.fn(), cancelReportExport: vi.fn(),
  reportExportDownload: (id: string) => `/api/data-exports/${id}/download` }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

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
