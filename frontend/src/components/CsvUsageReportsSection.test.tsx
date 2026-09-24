import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { CsvUsageReportsSection } from "./CsvUsageReportsSection";
import { reportHistoryFixture } from "./reportHistoryFixture";

afterEach(() => vi.restoreAllMocks());

function history(): api.OfficialUsageHistoryView {
  const data = reportHistoryFixture();
  data.summary = {
    ...data.summary,
    importCount: 8, uniqueObservationCount: 24, observationRowCount: 1_234,
    latestObservedAt: "2026-09-24T08:00:00.000Z",
    reportingWindows: {
      earliestStartDateUtc: "2026-04-01", latestEndDateUtc: "2026-09-20",
      knownCount: 8, unknownCount: 0, overlappingKnownWindowCount: 2, additive: false,
    },
    activityDateRange: {
      earliestDateUtc: "2026-04-05T00:00:00.000Z", latestDateUtc: "2026-09-18T00:00:00.000Z",
      provenance: "last_activity_dates", provesReportingCoverage: false,
    },
  };
  data.bundles.count = 8;
  data.bundles.limit = 1;
  return data;
}

const props = {
  principalKey: "tenant:viewer",
  revision: 0,
  canUploadUsage: true,
  onOpenUsageImport: vi.fn(),
  onManageUsageReports: vi.fn(),
};

describe("CSV usage reports section", () => {
  it("uses the earliest and latest CSV activity dates across history rather than optional windows or the latest page", async () => {
    const getHistory = vi.spyOn(api, "getOfficialUsageHistory").mockResolvedValue(history());
    render(<CsvUsageReportsSection {...props} />);
    const section = screen.getByRole("region", { name: "CSV usage reports" });
    expect(within(section).getByRole("heading", { level: 2, name: "CSV usage reports" })).toBeVisible();
    await screen.findByText("Reports available");
    expect(getHistory).toHaveBeenCalledExactlyOnceWith({ limit: 1, offset: 0 }, { signal: expect.any(AbortSignal) });
    const range = screen.getByText("Reporting dates (UTC)").closest("div")!;
    expect([...range.querySelectorAll("time")].map(time => time.dateTime)).toEqual(["2026-04-05", "2026-09-18"]);
    expect(range).toHaveTextContent("to");
    expect(screen.queryByText("Known reporting windows (UTC)")).not.toBeInTheDocument();
    expect(screen.queryByText("Observed activity (UTC)")).not.toBeInTheDocument();
    expect(section).toHaveTextContent("8 retained report sets · 24 distinct CSV reports · 1,234 report rows");
    expect(section).toHaveTextContent("Latest acceptance");
    expect(section).toHaveTextContent("not just the current selection or latest upload");
    expect(section).toHaveTextContent("The range may contain gaps");
    expect(section).toHaveTextContent("Overlapping snapshots are not added together");
    expect(section).toHaveTextContent("separate from automatic data sync");
    expect(section).toHaveTextContent("No manual dates are needed");
  });

  it.each([true, false])("keeps report management available with upload permission %s", async canUploadUsage => {
    vi.spyOn(api, "getOfficialUsageHistory").mockResolvedValue(reportHistoryFixture([]));
    const onManageUsageReports = vi.fn();
    const onOpenUsageImport = vi.fn();
    render(<CsvUsageReportsSection {...props} {...{ canUploadUsage, onManageUsageReports, onOpenUsageImport }} />);
    await screen.findByText("Import needed");
    expect(screen.getByText(/No complete CSV report sets are retained/)).toBeVisible();
    expect(screen.queryByText("Reporting dates (UTC)")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Manage reports" }));
    expect(onManageUsageReports).toHaveBeenCalledOnce();
    if (canUploadUsage) {
      await userEvent.click(screen.getByRole("button", { name: "Add CSV reports" }));
      expect(onOpenUsageImport).toHaveBeenCalledOnce();
    } else {
      expect(screen.queryByRole("button", { name: "Add CSV reports" })).not.toBeInTheDocument();
      expect(screen.getByText("An AgentControl.Admin can import reports.")).toBeVisible();
    }
  });

  it("calculates reporting dates when optional reporting windows are missing or mixed", async () => {
    const data = history();
    data.summary.reportingWindows.knownCount = 7;
    data.summary.reportingWindows.unknownCount = 1;
    const getHistory = vi.spyOn(api, "getOfficialUsageHistory").mockResolvedValue(data);
    const view = render(<CsvUsageReportsSection {...props} />);
    await screen.findByText("Reports available");
    const dates = () => [...screen.getByText("Reporting dates (UTC)").closest("div")!.querySelectorAll("time")].map(time => time.dateTime);
    expect(dates()).toEqual(["2026-04-05", "2026-09-18"]);
    const unknown = structuredClone(data);
    unknown.summary.reportingWindows = {
      earliestStartDateUtc: null, latestEndDateUtc: null,
      knownCount: 0, unknownCount: 8, overlappingKnownWindowCount: 0, additive: false,
    };
    getHistory.mockResolvedValue(unknown);
    view.rerender(<CsvUsageReportsSection {...props} revision={1} />);
    await screen.findByText("Reports available");
    expect(dates()).toEqual(["2026-04-05", "2026-09-18"]);
    expect(screen.queryByText("Reporting dates not supplied")).not.toBeInTheDocument();
    expect(screen.queryByText(/no known reporting window/)).not.toBeInTheDocument();
  });

  it("shows unknown dates, not an invented range, for accepted reports without dated rows", async () => {
    const data = reportHistoryFixture();
    vi.spyOn(api, "getOfficialUsageHistory").mockResolvedValue(data);
    render(<CsvUsageReportsSection {...props} />);
    expect(await screen.findByText("Reports available")).toBeVisible();
    expect(screen.getByText("No dates found in imported reports")).toBeVisible();
    expect(screen.getByRole("region", { name: "CSV usage reports" }).querySelector("time")).toBeNull();
  });

  it("shows a valid single-day range without requesting manual dates", async () => {
    const data = history();
    data.summary.activityDateRange.earliestDateUtc = data.summary.activityDateRange.latestDateUtc = "2026-09-18";
    vi.spyOn(api, "getOfficialUsageHistory").mockResolvedValue(data);
    render(<CsvUsageReportsSection {...props} />);
    await screen.findByText("Reports available");
    const range = screen.getByText("Reporting dates (UTC)").closest("div")!;
    expect([...range.querySelectorAll("time")].map(time => time.dateTime)).toEqual(["2026-09-18", "2026-09-18"]);
  });

  it("reloads after report mutations and hides the previous range while verifying or after deletion", async () => {
    const getHistory = vi.spyOn(api, "getOfficialUsageHistory").mockResolvedValue(history());
    const view = render(<CsvUsageReportsSection {...props} />);
    await screen.findByText("Reports available");
    let resolve!: (value: api.OfficialUsageHistoryView) => void;
    getHistory.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    view.rerender(<CsvUsageReportsSection {...props} revision={1} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading cumulative CSV report range");
    expect(screen.queryByText("Reporting dates (UTC)")).not.toBeInTheDocument();
    await act(async () => resolve(reportHistoryFixture([])));
    expect(await screen.findByText("Import needed")).toBeVisible();
    expect(getHistory).toHaveBeenCalledTimes(2);
  });

  it.each([403, 503])("does not show stale success after a %s failure and supports retry", async status => {
    const getHistory = vi.spyOn(api, "getOfficialUsageHistory").mockResolvedValueOnce(history())
      .mockRejectedValueOnce(new api.ApiError(status, "summary_unavailable", "Report summary unavailable."))
      .mockResolvedValue(history());
    render(<CsvUsageReportsSection {...props} />);
    await screen.findByText("Reports available");
    await userEvent.click(screen.getByRole("button", { name: "Refresh report summary" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Report summary unavailable.");
    expect(screen.queryByText("Reports available")).not.toBeInTheDocument();
    expect(screen.queryByText("Reporting dates (UTC)")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry report summary" }));
    expect(await screen.findByText("Reports available")).toBeVisible();
    expect(getHistory).toHaveBeenCalledTimes(3);
  });

  it("aborts a prior principal's read and ignores its late response", async () => {
    let resolve!: (value: api.OfficialUsageHistoryView) => void;
    const getHistory = vi.spyOn(api, "getOfficialUsageHistory")
      .mockReturnValueOnce(new Promise(done => { resolve = done; }))
      .mockResolvedValue(reportHistoryFixture([]));
    const view = render(<CsvUsageReportsSection {...props} />);
    await waitFor(() => expect(getHistory).toHaveBeenCalledOnce());
    const signal = getHistory.mock.calls[0][1]!.signal!;
    view.rerender(<CsvUsageReportsSection {...props} principalKey="other:viewer" />);
    expect(await screen.findByText("Import needed")).toBeVisible();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(history()));
    expect(screen.queryByText("Reports available")).not.toBeInTheDocument();
  });
});
