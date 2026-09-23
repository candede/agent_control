import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { usageInsightsPublished } from "../test/usageInsightsFixture";
import { OfficialUsageManageReports } from "./OfficialUsageManageReports";
import { reportHistoryFixture } from "./reportHistoryFixture";

afterEach(() => vi.restoreAllMocks());

const complete = usageInsightsPublished.activeSet!;
const incomplete = { ...complete, id: "incomplete-set", bundleId: "incomplete-bundle", complete: false, acceptedAt: null };
const deleted = { ...complete, id: "deleted-set", deletedAt: "2026-09-20T10:00:00.000Z" };

function setup() {
  const data = reportHistoryFixture([complete, incomplete, deleted]);
  const getHistory = vi.spyOn(api, "getOfficialUsageHistory").mockResolvedValue(data);
  const getOverview = vi.spyOn(api, "getOfficialUsageOverview");
  const admin = { verified: true, busy: false, onResume: vi.fn(), onOperation: vi.fn() };
  const onViewSnapshot = vi.fn();
  return { data, getHistory, getOverview, admin, onViewSnapshot };
}

describe("single managed report history", () => {
  it("keeps retained, incomplete and deleted evidence in one table and resumes accepted incomplete bundles", async () => {
    const { admin, onViewSnapshot, getOverview } = setup();
    render(<OfficialUsageManageReports revision={0} admin={admin} onViewSnapshot={onViewSnapshot} />);
    expect(screen.getByRole("region", { name: "Saved reports" })).toHaveAttribute("tabindex", "0");
    await screen.findByRole("table");
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.getByText("Retained", { exact: true })).toBeVisible();
    expect(screen.getByText("Deleted", { exact: true })).toBeVisible();
    const incompleteRow = screen.getByRole("button", { name: "Resume" }).closest("tr")!;
    expect(within(incompleteRow).getAllByText("Incomplete")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(admin.onResume).toHaveBeenCalledWith("incomplete-bundle");
    await userEvent.click(screen.getByRole("button", { name: "Make current" }));
    expect(admin.onOperation).toHaveBeenCalledWith(complete.id, "select");
    const retainedRow = screen.getByRole("button", { name: "Make current" }).closest("tr")!;
    await userEvent.click(within(retainedRow).getByRole("button", { name: /Delete retained/ }));
    expect(admin.onOperation).toHaveBeenLastCalledWith(complete.id, "delete");
    await userEvent.click(screen.getByRole("button", { name: "View snapshot" }));
    expect(onViewSnapshot).toHaveBeenCalledWith(complete.id);
    await userEvent.click(screen.getByRole("button", { name: "View current snapshot" }));
    expect(onViewSnapshot).toHaveBeenLastCalledWith(undefined);
    expect(getOverview).not.toHaveBeenCalled();
  });

  it("blocks all history mutations on unverified admin state, busy state, pending reads and failed refreshes", async () => {
    const { admin, data, getHistory, onViewSnapshot } = setup();
    const onRefresh = vi.fn();
    const view = render(<OfficialUsageManageReports revision={0} admin={{ ...admin, verified: false }} onViewSnapshot={onViewSnapshot} onRefresh={onRefresh} />);
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "Make current" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
    view.rerender(<OfficialUsageManageReports revision={0} admin={{ ...admin, busy: true }} onViewSnapshot={onViewSnapshot} onRefresh={onRefresh} />);
    expect(screen.getByRole("button", { name: "Make current" })).toBeDisabled();
    view.rerender(<OfficialUsageManageReports revision={0} admin={admin} onViewSnapshot={onViewSnapshot} onRefresh={onRefresh} />);
    expect(screen.getByRole("button", { name: "Make current" })).toBeEnabled();
    let reject!: (reason: Error) => void;
    getHistory.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Make current" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
    for (const button of screen.getAllByRole("button", { name: /Delete retained/ })) expect(button).toBeDisabled();
    await act(async () => reject(new Error("History unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
    expect(screen.getByRole("button", { name: "Make current" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "View snapshot" })).toBeDisabled();
    getHistory.mockResolvedValue(data);
    await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Make current" })).toBeEnabled());
    expect(admin.onOperation).not.toHaveBeenCalled();
  });

  it("reloads history on revision changes without starting the locator and omits all mutation controls for Viewers", async () => {
    const { getHistory, getOverview, onViewSnapshot } = setup();
    const view = render(<OfficialUsageManageReports revision={0} onViewSnapshot={onViewSnapshot} />);
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: /Delete|Make current|Resume/ })).not.toBeInTheDocument();
    getHistory.mockResolvedValue(reportHistoryFixture([]));
    view.rerender(<OfficialUsageManageReports revision={1} onViewSnapshot={onViewSnapshot} />);
    expect(await screen.findByText("No accepted official usage snapshots are retained.")).toBeVisible();
    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(getOverview).not.toHaveBeenCalled();
  });

  it("keeps staged drafts outside the one history table and requires verified history before resuming", async () => {
    const { getHistory, admin, data, onViewSnapshot } = setup();
    let finish!: (value: api.OfficialUsageHistoryView) => void;
    getHistory.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const stage: api.OfficialUsageStagingPreview = {
      id: "stage-id", revision: 1, status: "active", kind: "agents", fileHash: "a".repeat(64),
      parserVersion: "1", schemaVersion: "observed-v1", bundleId: "draft-bundle", correctionOfSetId: null,
      reportingPeriod: complete.reportingPeriod, sourceAsOf: null, sourceAsOfProvenance: "absent", sourceFreshness: "unknown",
      downloadedAt: null, rowCount: 2, warnings: [], reconciliation: {}, activeRevision: 1,
      acceptedVersionId: null, acceptedSetId: null, createdAt: complete.createdAt, expiresAt: "2026-09-30T10:00:00Z", acceptedAt: null,
    };
    render(<OfficialUsageManageReports revision={0} admin={admin} onViewSnapshot={onViewSnapshot}
      state={{ activeSetId: null, activeRevision: 1, staging: [stage], sets: [complete] }} />);
    const resume = screen.getByRole("button", { name: /Resume import/ });
    expect(resume).toBeDisabled();
    expect(screen.getByRole("region", { name: "Staged imports" })).toHaveTextContent("not published");
    await act(async () => finish(data));
    await waitFor(() => expect(resume).toBeEnabled());
    expect(screen.getAllByRole("table")).toHaveLength(1);
    await userEvent.click(resume);
    expect(admin.onResume).toHaveBeenCalledWith("draft-bundle");
    getHistory.mockRejectedValueOnce(new Error("History not verified"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("History not verified");
    expect(resume).toBeDisabled();
  });
});
