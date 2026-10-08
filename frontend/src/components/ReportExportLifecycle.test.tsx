import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/reportData";
import { ApiError } from "../api/client";
import { createSavedQueryClient } from "../savedQueries";
import { deferred } from "../test/deferred";
import { combinedUser, reportAgent, reportPage, reportUser } from "../test/reportDataFixture";
import { CopilotUsersView } from "./CopilotUsersView";
import { ReportedUserActivity } from "./ReportedUserActivity";
import { ReportingView } from "./ReportingView";

vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(),
  readReportPage: vi.fn(), readReportFacet: vi.fn(),
  createReportExport: vi.fn(), reportExportStatus: vi.fn(),
}));
const clients: ReturnType<typeof createSavedQueryClient>[] = [];
const route = { view: "activity" as const, search: "", page: 0 };
const views = [
  { name: "paid users", element: <CopilotUsersView />, page: () => reportPage([combinedUser()]), row: "User 1", exportLabel: "Export users CSV" },
  { name: "reported users", element: <ReportedUserActivity route={route} onRouteChange={() => {}} />,
    page: () => reportPage([reportUser()]), row: "User 1", exportLabel: "Export users CSV" },
  { name: "reported agents", element: <ReportingView />, page: () => reportPage([reportAgent()]), row: "Agent 1", exportLabel: "Export agent CSV" },
];
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.readReportFacet).mockImplementation(async (_path, id) => ({
    value: [], selection: { ...reportPage([]).selection, id }, counts: { total: 0, filtered: 0 },
    page: { limit: 50, nextCursor: null, previousCursor: null },
  }));
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear());
  vi.resetAllMocks(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe.each(views)("$name export and page lifetimes", ({ element, page, row, exportLabel }) => {
  it("does not revive export-rejected cached evidence on an immediate view revisit", async () => {
    const client = createSavedQueryClient();
    clients.push(client);
    vi.mocked(api.readReportPage).mockResolvedValue(page());
    vi.mocked(api.createReportExport).mockRejectedValue(new ApiError(409, "selection_invalidated", "Selection retired."));
    const view = render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole("button", { name: row })).toBeVisible();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: exportLabel })); });
    expect(screen.getByRole("alert")).toHaveTextContent("This selection changed or expired.");
    expect(screen.queryByRole("button", { name: row })).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledOnce();

    const pending = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    view.rerender(<QueryClientProvider client={client}>{null}</QueryClientProvider>);
    view.rerender(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
    expect(screen.queryByRole("button", { name: row })).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.selectionId).toBeUndefined();
    const replacement = page();
    replacement.selection = { ...replacement.selection, id: "replacement-selection" };
    await act(async () => { pending.resolve(replacement); await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole("button", { name: row })).toBeVisible();
    expect(api.createReportExport).toHaveBeenCalledOnce();
  });

  it.each([
    { phase: "building", age: 0 }, { phase: "ready", age: 0 },
    { phase: "building", age: 31_000 }, { phase: "ready", age: 31_000 },
  ] as const)("preserves a $phase export during pinned focus revalidation at cache age $age", async ({ phase, age }) => {
    const selected = page();
    vi.mocked(api.readReportPage).mockResolvedValue(selected);
    vi.mocked(api.createReportExport).mockResolvedValue({ id: "artifact" });
    const ready = { id: "artifact", status: "ready" as const, rows: 1, bytes: 10,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), error: null, limit: null, observed: null };
    vi.mocked(api.reportExportStatus).mockResolvedValue({ ...ready, status: phase });
    render(element);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: exportLabel })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    const signal = vi.mocked(api.createReportExport).mock.calls[0][1]!;
    const pending = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    vi.setSystemTime(Date.now() + age);
    await act(async () => { fireEvent.focus(window); fireEvent.focus(window); await vi.advanceTimersByTimeAsync(1); });
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.selectionId).toBe(selected.selection.id);
    expect(signal.aborted).toBe(false);
    expect(screen.getByRole("button", { name: "Cancel export" })).toBeEnabled();
    if (phase === "ready") expect(screen.getByRole("link", { name: "Download CSV" })).toBeVisible();
    else expect(screen.getByRole("button", { name: "Preparing export..." })).toBeDisabled();
    await act(async () => { pending.resolve(selected); await vi.advanceTimersByTimeAsync(1); });
    vi.mocked(api.reportExportStatus).mockResolvedValue(ready);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("link", { name: "Download CSV" })).toBeVisible();
    expect(api.createReportExport).toHaveBeenCalledOnce();
  });

  it.each(["admission", "building", "ready", "retry"] as const)(
    "preserves a %s export while paging the same pinned selection", async phase => {
      const selected = page();
      selected.page = { ...selected.page, nextCursor: "next-page" };
      vi.mocked(api.readReportPage).mockResolvedValue(selected);
      const admission = deferred<{ id: string }>();
      vi.mocked(api.createReportExport).mockReturnValue(admission.promise);
      const ready = { id: "artifact", status: "ready" as const, rows: 1, bytes: 10,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), error: null, limit: null, observed: null };
      if (phase === "retry") vi.mocked(api.reportExportStatus).mockRejectedValueOnce(new Error("Status unavailable."));
      vi.mocked(api.reportExportStatus).mockResolvedValue(phase === "building" ? { ...ready, status: "building" } : ready);
      render(element);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: exportLabel })); });
      if (phase !== "admission") await act(async () => { admission.resolve({ id: "artifact" }); await vi.advanceTimersByTimeAsync(2000); });
      const signal = vi.mocked(api.createReportExport).mock.calls[0][1]!;
      const pending = deferred<ReturnType<typeof page>>();
      vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Next (users|agents)$/ })); });
      expect(api.readReportPage).toHaveBeenCalledTimes(2);
      expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]).toMatchObject({ selectionId: selected.selection.id, cursor: "next-page" });
      expect(screen.queryByRole("button", { name: row })).not.toBeInTheDocument();
      expect(signal.aborted).toBe(false);
      expect(screen.getByRole("button", { name: "Cancel export" })).toBeEnabled();
      if (phase === "ready") expect(screen.getByRole("link", { name: "Download CSV" })).toBeVisible();
      else if (phase === "retry") {
        expect(screen.getByRole("button", { name: "Retry export status" })).toBeEnabled();
        expect(screen.getByRole("alert")).toHaveTextContent("Status unavailable.");
      } else expect(screen.getByRole("button", { name: "Preparing export..." })).toBeDisabled();
      await act(async () => { pending.resolve(page()); await vi.advanceTimersByTimeAsync(1); });
      expect(signal.aborted).toBe(false);
      vi.mocked(api.reportExportStatus).mockResolvedValue(ready);
      if (phase === "retry") await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry export status" })); });
      await act(async () => { admission.resolve({ id: "artifact" }); await vi.advanceTimersByTimeAsync(3000); });
      expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", "/api/data-exports/artifact/download");
      expect(api.createReportExport).toHaveBeenCalledOnce();
      expect(api.readReportPage).toHaveBeenCalledTimes(2);
    });

  it("retires a paging selection when export status invalidates it and ignores the late page", async () => {
    const selected = page();
    selected.page = { ...selected.page, nextCursor: "next-page" };
    vi.mocked(api.readReportPage).mockResolvedValueOnce(selected);
    vi.mocked(api.createReportExport).mockResolvedValue({ id: "artifact" });
    vi.mocked(api.reportExportStatus).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Selection retired."));
    render(element);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: exportLabel })); });
    const pending = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Next (users|agents)$/ })); });
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("alert")).toHaveTextContent("This selection changed or expired.");
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: exportLabel })).toBeDisabled();
    await act(async () => { pending.resolve(selected); await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByRole("button", { name: row })).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(api.createReportExport).toHaveBeenCalledOnce();
    const replacement = page();
    replacement.selection = { ...replacement.selection, id: "replacement-selection" };
    vi.mocked(api.readReportPage).mockResolvedValueOnce(replacement);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart selection" })); await vi.advanceTimersByTimeAsync(1); });
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.selectionId).toBeUndefined();
    expect(screen.getByRole("button", { name: row })).toBeVisible();
    expect(screen.getByRole("button", { name: exportLabel })).toBeEnabled();
    expect(api.createReportExport).toHaveBeenCalledOnce();
  });

  it("withdraws an export when a pending page denies access, without publishing its late status", async () => {
    const selected = page();
    selected.page = { ...selected.page, nextCursor: "next-page" };
    vi.mocked(api.readReportPage).mockResolvedValueOnce(selected);
    vi.mocked(api.createReportExport).mockResolvedValue({ id: "artifact" });
    const ready = { id: "artifact", status: "ready" as const, rows: 1, bytes: 10,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), error: null, limit: null, observed: null };
    const status = deferred<typeof ready>();
    vi.mocked(api.reportExportStatus).mockReturnValueOnce(status.promise);
    render(element);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: exportLabel })); await vi.advanceTimersByTimeAsync(2000); });
    const signal = vi.mocked(api.reportExportStatus).mock.calls[0][1]!;
    const pending = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Next (users|agents)$/ })); });
    expect(signal.aborted).toBe(false);
    await act(async () => { pending.reject(new ApiError(403, "forbidden", "Report access denied.")); await vi.advanceTimersByTimeAsync(1); });
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("Report access denied.");
    expect(screen.getByRole("button", { name: exportLabel })).toBeDisabled();
    await act(async () => { status.resolve(ready); await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: row })).not.toBeInTheDocument();
    expect(api.createReportExport).toHaveBeenCalledOnce();
    expect(api.reportExportStatus).toHaveBeenCalledOnce();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });

  it("withdraws a ready export when focus revalidation actually denies its evidence", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(page());
    vi.mocked(api.createReportExport).mockResolvedValue({ id: "artifact" });
    vi.mocked(api.reportExportStatus).mockResolvedValue({ id: "artifact", status: "ready", rows: 1, bytes: 10,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), error: null, limit: null, observed: null });
    render(element);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: exportLabel })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("link", { name: "Download CSV" })).toBeVisible();
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(403, "forbidden", "Report access denied."));
    await act(async () => { fireEvent.focus(window); await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole("alert")).toHaveTextContent("Report access denied.");
    expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: row })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: exportLabel })).toBeDisabled();
    expect(vi.mocked(api.createReportExport).mock.calls[0][1]?.aborted).toBe(true);
    expect(api.createReportExport).toHaveBeenCalledOnce();
  });
});

it.each(["directory", "report"] as const)("does not enable non-paid exports without %s evidence while paging", async missing => {
  const selected = reportPage([reportUser()]);
  selected.page = { ...selected.page, nextCursor: "next-page" };
  if (missing === "directory") selected.sources.directory = { ...selected.sources.directory, state: "unavailable" };
  else selected.reports = { ...selected.reports, setId: null };
  vi.mocked(api.readReportPage).mockResolvedValueOnce(selected);
  render(<ReportedUserActivity route={route} onRouteChange={() => {}} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
  const pending = deferred<typeof selected>();
  vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next users" })); });
  expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
  await act(async () => { pending.resolve(selected); await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
  expect(api.createReportExport).not.toHaveBeenCalled();
});
