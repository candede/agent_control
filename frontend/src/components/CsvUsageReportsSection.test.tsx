import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { reportPages } from "../api/reportData";
import { createSavedQueryClient } from "../savedQueries";
import { historySet, reportPage } from "../test/reportDataFixture";
import { deferred } from "../test/deferred";
import { CsvUsageReportsSection } from "./CsvUsageReportsSection";

vi.mock("../api/reportData", async original => {
  const actual = await original<typeof import("../api/reportData")>();
  return { ...actual, reportPages: { ...actual.reportPages, history: vi.fn() } };
});
function history(empty = false, dated = true) {
  const page = reportPage(empty ? [] : [historySet()], { counts: { total: empty ? 0 : 8, filtered: empty ? 0 : 8 },
    page: { limit: 1, nextCursor: empty ? null : "next-set", previousCursor: null } });
  return { ...page, analytics: { ...page.analytics, history: {
    imports: empty ? 0 : 8, uniqueObservations: 24, observationRows: 1234, uniquePayloads: 1000, repeatedRowsReused: 234,
    earliestAcceptedAt: null, latestAcceptedAt: dated ? "2026-09-24T08:00:00.000Z" : null,
    earliestActivityDateUtc: dated ? "2026-04-05" : null, latestActivityDateUtc: dated ? "2026-09-18" : null,
    earliestReportingStart: "2026-04-01", latestReportingEnd: "2026-09-20", knownWindows: 8, unknownWindows: 0,
    overlappingKnownWindows: 2, additive: false as const, activityRangeProvesCoverage: false as const,
  } } };
}
const props = { principalKey: "tenant:viewer", revision: 0, canUploadUsage: true, onOpenUsageImport: vi.fn(), onManageUsageReports: vi.fn() };
beforeEach(() => { vi.mocked(reportPages.history).mockResolvedValue(history()); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("CSV usage reports section", () => {
  it("uses global observed activity dates and exact set counts, not optional windows or the single returned row", async () => {
    render(<CsvUsageReportsSection {...props} />);
    const section = screen.getByRole("region", { name: "CSV usage reports" });
    expect(within(section).getByRole("heading", { level: 2, name: "CSV usage reports" })).toBeVisible();
    await screen.findByText("Reports available");
    expect(reportPages.history).toHaveBeenCalledExactlyOnceWith({ limit: 1 }, expect.any(AbortSignal));
    expect(within(section).getByRole("heading", { name: "8 saved report sets" })).toBeVisible();
    const range = screen.getByText("Observed activity dates (UTC)").closest("div")!;
    expect([...range.querySelectorAll("time")].map(time => time.dateTime)).toEqual(["2026-04-05", "2026-09-18"]);
    expect(screen.queryByText("Known reporting windows (UTC)")).not.toBeInTheDocument();
    expect(section).toHaveTextContent("Last imported");
    expect(section).toHaveTextContent("Observed activity across all saved report sets, not continuous reporting coverage");
    expect(section).toHaveTextContent("Report totals are kept separate");
    expect(within(section).queryByRole("button", { name: /Refresh/ })).not.toBeInTheDocument();
  });
  it.each([true, false])("keeps management available while independently enforcing upload permission %s", async canUploadUsage => {
    vi.mocked(reportPages.history).mockResolvedValue(history(true));
    render(<CsvUsageReportsSection {...props} canUploadUsage={canUploadUsage} />);
    await screen.findByText("Import needed");
    expect(screen.getByRole("heading", { name: "No reports yet" })).toBeVisible();
    expect(screen.queryByText("Observed activity dates (UTC)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage reports" }));
    expect(props.onManageUsageReports).toHaveBeenCalledOnce();
    if (canUploadUsage) {
      fireEvent.click(screen.getByRole("button", { name: "Add CSV reports" }));
      expect(props.onOpenUsageImport).toHaveBeenCalledOnce();
    } else {
      expect(screen.queryByRole("button", { name: "Add CSV reports" })).not.toBeInTheDocument();
      expect(screen.getByText("An AgentControl.Admin can import reports.")).toBeVisible();
    }
  });
  it("preserves observed dates with mixed or entirely missing reporting windows", async () => {
    const data = history(); data.analytics.history.knownWindows = 7; data.analytics.history.unknownWindows = 1;
    vi.mocked(reportPages.history).mockResolvedValue(data);
    const view = render(<CsvUsageReportsSection {...props} />);
    await screen.findByText("Reports available");
    const dates = () => [...screen.getByText("Observed activity dates (UTC)").closest("div")!.querySelectorAll("time")].map(time => time.dateTime);
    expect(dates()).toEqual(["2026-04-05", "2026-09-18"]);
    vi.mocked(reportPages.history).mockResolvedValue({ ...data, analytics: { ...data.analytics, history: {
      ...data.analytics.history, knownWindows: 0, unknownWindows: 8, earliestReportingStart: null, latestReportingEnd: null,
    } } });
    view.rerender(<CsvUsageReportsSection {...props} revision={1} />);
    await screen.findByText("Reports available");
    expect(dates()).toEqual(["2026-04-05", "2026-09-18"]);
    expect(screen.queryByText("Reporting dates not supplied")).not.toBeInTheDocument();
  });
  it("does not invent dates when accepted reports have no dated rows", async () => {
    vi.mocked(reportPages.history).mockResolvedValue(history(false, false));
    render(<CsvUsageReportsSection {...props} />);
    expect(await screen.findByText("Reports available")).toBeVisible();
    expect(screen.getByText("No dates found in imported reports")).toBeVisible();
    expect(screen.getByRole("region", { name: "CSV usage reports" }).querySelector("time")).toBeNull();
  });
  it("keeps imported reports available without inventing an invalid import time", async () => {
    const data = history(); data.analytics.history.latestAcceptedAt = "invalid";
    vi.mocked(reportPages.history).mockResolvedValue(data);
    render(<CsvUsageReportsSection {...props} />);
    expect(await screen.findByText("Reports available")).toBeVisible();
    expect(screen.getByText("Not recorded").closest("p")).toHaveTextContent("Last imported Not recorded");
    expect(screen.getByRole("heading", { name: "8 saved report sets" })).toBeVisible();
    expect(reportPages.history).toHaveBeenCalledOnce();
  });
  it("shows a valid single-day range without requiring manual reporting dates", async () => {
    const data = history(); data.analytics.history.earliestActivityDateUtc = "2026-09-18";
    vi.mocked(reportPages.history).mockResolvedValue(data);
    render(<CsvUsageReportsSection {...props} />);
    await screen.findByText("Reports available");
    expect([...screen.getByText("Observed activity dates (UTC)").closest("div")!.querySelectorAll("time")].map(time => time.dateTime))
      .toEqual(["2026-09-18", "2026-09-18"]);
  });
  it("hides prior dates during mutation revalidation and accepts explicit empty history after deletion", async () => {
    const view = render(<CsvUsageReportsSection {...props} />);
    await screen.findByText("Reports available");
    const pending = deferred<ReturnType<typeof history>>();
    vi.mocked(reportPages.history).mockReturnValueOnce(pending.promise);
    view.rerender(<CsvUsageReportsSection {...props} revision={1} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading reports");
    expect(screen.queryByText("Observed activity dates (UTC)")).not.toBeInTheDocument();
    await act(async () => pending.resolve(history(true)));
    expect(await screen.findByText("Import needed")).toBeVisible();
    expect(reportPages.history).toHaveBeenCalledTimes(2);
  });
  it.each([403, 503])("does not display stale success after status %s and permits explicit retry", async status => {
    vi.mocked(reportPages.history).mockResolvedValueOnce(history())
      .mockRejectedValueOnce(new ApiError(status, "summary_unavailable", "Report summary unavailable.")).mockResolvedValue(history());
    const view = render(<CsvUsageReportsSection {...props} />);
    await screen.findByText("Reports available");
    view.rerender(<CsvUsageReportsSection {...props} revision={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Report summary unavailable.");
    expect(screen.queryByText("Reports available")).not.toBeInTheDocument();
    expect(screen.queryByText("Observed activity dates (UTC)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Reports available");
    expect(reportPages.history).toHaveBeenCalledTimes(3);
  });
  it("aborts old principal reads, never applies obsolete history and never automatically follows cursors", async () => {
    const pending = deferred<ReturnType<typeof history>>();
    vi.mocked(reportPages.history).mockReturnValueOnce(pending.promise);
    const view = render(<CsvUsageReportsSection {...props} />);
    await waitFor(() => expect(reportPages.history).toHaveBeenCalledOnce());
    const oldSignal = vi.mocked(reportPages.history).mock.calls[0][1];
    view.rerender(<CsvUsageReportsSection {...props} principalKey="different-principal" />);
    await screen.findByText("Reports available");
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => pending.resolve(history(true)));
    expect(screen.queryByText("Import needed")).not.toBeInTheDocument();
    expect(reportPages.history).toHaveBeenCalledTimes(2);
  });
  it.each(["loading", "sharing"])("keeps retry %s correct after a cached summary fails revalidation", async check => {
    const client = createSavedQueryClient();
    render(<QueryClientProvider client={client}><CsvUsageReportsSection {...props} /></QueryClientProvider>);
    await screen.findByText("Reports available");
    vi.mocked(reportPages.history).mockRejectedValueOnce(new Error("Summary revalidation failed."));
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved", "csv-usage-reports"] }); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Summary revalidation failed.");
    const pending = deferred<ReturnType<typeof history>>();
    vi.mocked(reportPages.history).mockReturnValue(pending.promise);
    const retry = screen.getByRole("button", { name: "Retry" });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Loading reports"));
    if (check === "sharing") {
      expect(reportPages.history).toHaveBeenCalledTimes(3);
      expect(vi.mocked(reportPages.history).mock.calls[2][1]?.aborted).toBe(false);
    } else {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("Reports available")).not.toBeInTheDocument();
    }
    await act(async () => pending.resolve(history(true)));
    expect(await screen.findByText("Import needed")).toBeVisible();
  });
  it("shares concurrent summary reads without cancelling a remaining observer or following cursors", async () => {
    const client = createSavedQueryClient(), pending = deferred<ReturnType<typeof history>>();
    vi.mocked(reportPages.history).mockReturnValue(pending.promise);
    const panels = (first: boolean) => <QueryClientProvider client={client}>
      {first ? <CsvUsageReportsSection key="first" {...props} /> : null}
      <CsvUsageReportsSection key="second" {...props} />
    </QueryClientProvider>;
    const view = render(panels(true));
    await waitFor(() => expect(reportPages.history).toHaveBeenCalledOnce());
    const signal = vi.mocked(reportPages.history).mock.calls[0][1];
    view.rerender(panels(false));
    expect(signal?.aborted).toBe(false);
    await act(async () => pending.resolve(history()));
    expect(await screen.findByText("Reports available")).toBeVisible();
    expect(reportPages.history).toHaveBeenCalledOnce();
  });
  it("does not reload history for upload access, callback or focus changes", async () => {
    const view = render(<CsvUsageReportsSection {...props} />);
    await screen.findByText("Reports available");
    view.rerender(<CsvUsageReportsSection {...props} canUploadUsage={false}
      onOpenUsageImport={vi.fn()} onManageUsageReports={vi.fn()} />);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(screen.getByText("Reports available")).toBeVisible();
    expect(reportPages.history).toHaveBeenCalledOnce();
  });
  it("retires pending revision reads and unmounted session reads even when their transports settle late", async () => {
    const previous = deferred<ReturnType<typeof history>>(), current = deferred<ReturnType<typeof history>>();
    vi.mocked(reportPages.history).mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    const view = render(<CsvUsageReportsSection {...props} />);
    await waitFor(() => expect(reportPages.history).toHaveBeenCalledOnce());
    const previousSignal = vi.mocked(reportPages.history).mock.calls[0][1];
    view.rerender(<CsvUsageReportsSection {...props} revision={1} />);
    expect(previousSignal?.aborted).toBe(true);
    await waitFor(() => expect(reportPages.history).toHaveBeenCalledTimes(2));
    await act(async () => previous.reject(new Error("Obsolete revision error")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading reports");
    const currentSignal = vi.mocked(reportPages.history).mock.calls[1][1];
    view.unmount();
    expect(currentSignal?.aborted).toBe(true);
    await act(async () => current.resolve(history()));
    expect(screen.queryByRole("region", { name: "CSV usage reports" })).not.toBeInTheDocument();
  });
});
