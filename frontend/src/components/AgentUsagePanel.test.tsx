import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentUsageHistoryPoint, CandidateAgentUsageAssociations, CandidateAgentUsageSummary, CandidateAgentUsageUsers } from "../../../backend/src/types/officialReportApi";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import { ApiError, type SessionUser, type UnifiedAgentRecord } from "../api/client";
import * as api from "../api/reportData";
import { CapabilityContext } from "../capabilityContext";
import { agentUsageHistoryFixture, automaticUsageContext as inventoryContext, automaticUsagePackageId } from "../test/automaticAgentUsageFixture";
import { reportPage, reports, selectionId } from "../test/reportDataFixture";
import { deferred } from "../test/deferred";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { AgentUsagePanel } from "./AgentUsagePanel";

vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(), readAgentReportSummary: vi.fn(), readAgentReportHistory: vi.fn(), readAgentReportAssociations: vi.fn(),
  readAgentReportCandidates: vi.fn(), mutateAgentReportAssociation: vi.fn(), readReportDetail: vi.fn(), readReportPage: vi.fn(),
}));
const context = { selectionId, reportSetId: reports.setId, usageRevision: "b".repeat(64), inventoryRevision: "c".repeat(64), reports };
const record: UnifiedAgentRecord = {
  id: "agent:11111111-1111-4111-8111-111111111111", displayName: "Excel", presence: "graph_packages", environmentId: null,
  packages: [{ id: automaticUsagePackageId, displayName: "Excel", isBlocked: false, sourceSystem: "graph_packages", authoringTool: "Agent Builder",
    creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {} }],
  powerPlatformResource: null, identity: { state: "unmatched", reason: null, evidence: [], packageEvidence: [] },
  observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
};
const association: CandidateAgentUsageAssociations["value"][number] = { reportAgentId: "reviewed", agentName: "Reviewed report identity",
  responses: 181, basis: "reviewed", target: { source: "graph_packages", packageId: automaticUsagePackageId, snapshotId: "exact-snapshot" } };
const automatic: CandidateAgentUsageAssociations["value"][number] = { ...association, reportAgentId: automaticUsagePackageId,
  agentName: "Excel report identity", basis: "exact_package_id" };
function summary(overrides: Partial<CandidateAgentUsageSummary> = {}): CandidateAgentUsageSummary {
  return { recordId: record.id, status: "linked", responses: 181, activeUsers: 7, lastActivityDateUtc: "2026-09-12", associationCount: 2, context, ...overrides };
}
function links(overrides: Partial<CandidateAgentUsageAssociations> = {}): CandidateAgentUsageAssociations {
  return { value: [automatic, association], context, counts: { total: 2000, filtered: 2000 },
    page: { limit: 50, nextCursor: "links-next", previousCursor: null }, ...overrides };
}
function users(cursor?: string, search?: string): CandidateAgentUsageUsers {
  const username = search === "concealed" ? "7f7de4f6-censored" : cursor ? "person25@example.invalid" : "person0@example.invalid";
  return { ...reportPage([{ username, displayName: username, responses: cursor ? 25 : 50 }],
    { counts: { total: 20000, filtered: 20000 }, page: { limit: 25, nextCursor: cursor ? null : "users-next", previousCursor: cursor ? "users-previous" : null } }), context };
}
function renderPanel(overrides: Partial<ComponentProps<typeof AgentUsagePanel>> = {}) {
  const props = { record, view: "users" as const, context: inventoryContext, inventoryRevision: "a".repeat(64), canRemoveReviewedAssociations: true, onChanged: vi.fn(), ...overrides };
  const principal: SessionUser = { tenantId: "tenant", homeAccountId: "admin", username: "admin@example.invalid", displayName: "Admin", roles: ["AgentControl.Admin"] };
  const content = (next: Partial<typeof props> = {}, user = principal) => <CapabilityContext value={{
    user, views: [], now: Date.now(), pending: false, loading: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
  }}><WorkbenchActionProvider value={workbenchActions}><AgentUsagePanel {...props} {...next} /></WorkbenchActionProvider></CapabilityContext>;
  return { ...render(content()), props, principal, content };
}
async function removal() {
  await screen.findByText("person0@example.invalid");
  fireEvent.click(screen.getByText("Reviewed report links"));
  return screen.getByRole("button", { name: "Remove association for Reviewed report identity (reviewed)" });
}
beforeEach(() => {
  vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary());
  vi.mocked(api.readAgentReportHistory).mockImplementation(async (recordId, query) =>
    agentUsageHistoryFixture({ ...context, selectionId: query.selectionId }, recordId));
  vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links());
  vi.mocked(api.mutateAgentReportAssociation).mockResolvedValue(context);
  vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => users(query?.cursor, query?.search));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("restored agent usage and users", () => {
  it.each(["older", "none"])("uses the newest report for all Users data when the shared selection is %s", async shared => {
    const sharedReports = { ...reports, setId: shared === "older" ? reports.setId : null };
    const sharedContext = { ...context, reportSetId: sharedReports.setId, reports: sharedReports };
    const latest: AgentUsageHistoryPoint = { setId: "77777777-7777-4777-8777-777777777777",
      reportingStart: "2026-09-06", reportingEnd: "2026-10-05", periodProvenance: "activity_range",
      acceptedAt: "2026-10-05T12:00:00Z", status: "linked", responses: 499, lastActivityDateUtc: "2026-10-05T00:00:00Z", associationCount: 1 };
    const older = { ...latest, setId: reports.setId!, reportingStart: "2026-08-14", reportingEnd: "2026-09-12",
      acceptedAt: "2026-10-06T12:00:00Z", responses: 442, lastActivityDateUtc: "2026-09-11T00:00:00Z" };
    const latestContext = { ...sharedContext, reportSetId: latest.setId, reports: { ...sharedReports, setId: latest.setId,
      reportingPeriod: { startDate: latest.reportingStart, endDate: latest.reportingEnd, provenance: "activity_range" as const, days: 30 } } };
    const first = { ...agentUsageHistoryFixture(sharedContext, record.id, [latest]),
      counts: { total: 2, filtered: 2 }, page: { limit: 50, nextCursor: "older", previousCursor: null } };
    const pending = deferred<typeof first>();
    vi.mocked(api.readAgentReportHistory).mockImplementation(async (_id, query) => query.cursor
      ? { ...first, value: [older], page: { limit: 50, nextCursor: null, previousCursor: "newer" } } : pending.promise);
    vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({
      responses: 499, activeUsers: 57, lastActivityDateUtc: latest.lastActivityDateUtc, context: latestContext,
    }));
    vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({ context: latestContext }));
    vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => ({
      ...users(query?.cursor, query?.search), reports: latestContext.reports, context: latestContext,
    }));
    const onReloadInventory = vi.fn();
    const view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory, context: { ...inventoryContext, reports: sharedReports } });
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(api.readAgentReportSummary).not.toHaveBeenCalled();
    expect(api.readReportPage).not.toHaveBeenCalled();
    await act(async () => pending.resolve(first));
    await screen.findByText("person0@example.invalid");
    expect(screen.getByLabelText("Selected agent report metrics")).toHaveTextContent("499Active users57Last reported activityOct 5, 2026");
    expect(screen.getByLabelText("CSV report dates")).toHaveTextContent("Latest report datesSep 6, 2026 - Oct 5, 2026");
    expect(screen.queryByText("Reviewed report links")).not.toBeInTheDocument();
    expect(api.readAgentReportSummary).toHaveBeenCalledExactlyOnceWith(record.id,
      { selectionId, inventorySelectionId: selectionId, setId: latest.setId }, expect.any(AbortSignal));
    expect(api.readAgentReportAssociations).toHaveBeenCalledWith(record.id,
      expect.objectContaining({ selectionId, setId: latest.setId }), expect.any(AbortSignal));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "person" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith(expect.stringContaining("/usage-users"),
      expect.objectContaining({ selectionId, setId: latest.setId, search: "person" }), expect.any(AbortSignal)));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next users" })).toHaveAttribute("aria-disabled", "false"));
    fireEvent.click(screen.getByRole("button", { name: "Next users" }));
    await screen.findByText("person25@example.invalid");
    expect(api.readReportPage).toHaveBeenLastCalledWith(expect.stringContaining("/usage-users"),
      expect.objectContaining({ setId: latest.setId, cursor: "users-next" }), expect.any(AbortSignal));
    view.rerender(view.content({ view: "usage" }));
    fireEvent.click(screen.getByRole("button", { name: "Older reports" }));
    await screen.findByText("Aug 14, 2026 to Sep 12, 2026");
    view.rerender(view.content({ view: "users" }));
    expect(await screen.findByLabelText("Selected agent report metrics")).toHaveTextContent("499");
    expect(screen.getByLabelText("CSV report dates")).toHaveTextContent("Oct 5, 2026");
    expect(api.readAgentReportSummary).toHaveBeenCalledOnce();
    expect(api.readAgentReportHistory).toHaveBeenCalledTimes(2);
    expect(onReloadInventory).not.toHaveBeenCalled();
    expect(api.mutateAgentReportAssociation).not.toHaveBeenCalled();
  });

  it("does not fall back to the shared report if latest-report metadata is missing", async () => {
    const invalid = agentUsageHistoryFixture(context, record.id);
    Reflect.deleteProperty(invalid, "latestReportSetId");
    vi.mocked(api.readAgentReportHistory).mockResolvedValue(invalid);
    renderPanel({ inventorySelectionId: selectionId });
    expect(await screen.findByRole("alert")).toHaveTextContent("The latest saved usage report could not be determined.");
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(api.readAgentReportSummary).not.toHaveBeenCalled();
    expect(api.readReportPage).not.toHaveBeenCalled();
  });

  it("keeps Usage read-only and confines historical discovery and report context to Users", async () => {
    const historicalId = "77777777-7777-4777-8777-777777777777";
    const historical: AgentUsageHistoryPoint = { setId: historicalId, reportingStart: "2026-09-01", reportingEnd: "2026-10-01",
      periodProvenance: "activity_range", acceptedAt: "2026-10-02T00:00:00Z", status: "linked", responses: 200,
      lastActivityDateUtc: "2026-10-01T00:00:00Z", associationCount: 1 };
    const current = { ...historical, setId: reports.setId!, reportingStart: "2026-09-05", reportingEnd: "2026-10-04",
      status: "unlinked" as const, responses: null, activeUsers: null, associationCount: 0 };
    vi.mocked(api.readAgentReportHistory).mockResolvedValue(agentUsageHistoryFixture(context, record.id, [current, historical]));
    const local = { ...context, reportSetId: historicalId, reports: { ...reports, setId: historicalId,
      reportingPeriod: { ...reports.reportingPeriod!, startDate: historical.reportingStart, endDate: historical.reportingEnd } } };
    vi.mocked(api.readAgentReportSummary).mockImplementation(async (_id, query) => query.setId === historicalId
      ? summary({ responses: 200, context: local }) : summary({ status: "unlinked", responses: null }));
    vi.mocked(api.readAgentReportAssociations).mockImplementation(async (_id, query) => links({ context: query.setId === historicalId ? local : context }));
    vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => ({
      ...users(), reports: query?.setId === historicalId ? local.reports : reports, context: query?.setId === historicalId ? local : context,
    }));
    const onReloadInventory = vi.fn();
    const view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory, view: "usage" });
    expect(await screen.findByRole("region", { name: "Reported usage trend" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Report snapshots and changes in responses" })).toBeVisible();
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("CSV report dates")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Usage not reported" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View this period" })).not.toBeInTheDocument();
    expect(api.readReportPage).not.toHaveBeenCalled();
    view.rerender(view.content({ view: "users" }));
    expect(screen.getByRole("heading", { name: "Usage not reported" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "View this period" }));
    expect(await screen.findByText("person0@example.invalid")).toBeVisible();
    expect(screen.getByLabelText("CSV report dates")).toHaveTextContent("Sep 1, 2026");
    expect(screen.queryByRole("region", { name: "Reported usage trend" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Report snapshots and changes in responses" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Selected agent report metrics")).toHaveTextContent("200");
    expect(api.readAgentReportSummary).toHaveBeenLastCalledWith(record.id,
      { inventorySelectionId: selectionId, selectionId, setId: historicalId }, expect.any(AbortSignal));
    expect(api.readReportPage).toHaveBeenLastCalledWith(expect.stringContaining("/usage-users"),
      expect.objectContaining({ selectionId, inventorySelectionId: selectionId, setId: historicalId }), expect.any(AbortSignal));
    expect(screen.queryByText("Reviewed report links")).not.toBeInTheDocument();
    expect(api.readAgentReportHistory).toHaveBeenCalledOnce();
    view.rerender(view.content({ view: "usage" }));
    const table = screen.getByRole("table", { name: "Report snapshots and changes in responses" });
    expect(within(table).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("CSV report dates")).not.toBeInTheDocument();
    expect(screen.queryByText(/Viewing a historical period/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Return to latest report" })).not.toBeInTheDocument();
    view.rerender(view.content({ view: "users" }));
    expect(screen.getByLabelText("Selected agent report metrics")).toHaveTextContent("200");
    fireEvent.click(screen.getByRole("button", { name: "Return to latest report" }));
    await screen.findByRole("heading", { name: "Usage not reported" });
    expect(onReloadInventory).not.toHaveBeenCalled();
    expect(api.mutateAgentReportAssociation).not.toHaveBeenCalled();
  });
  it("cancels a pending association confirmation when leaving Users", async () => {
    const view = renderPanel();
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Confirm removal" })).toBeEnabled();
    view.rerender(view.content({ view: "usage" }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Reviewed report links")).not.toBeInTheDocument();
    view.rerender(view.content({ view: "users" }));
    await screen.findByText("person0@example.invalid");
    expect(screen.queryByRole("button", { name: "Confirm removal" })).not.toBeInTheDocument();
    expect(api.mutateAgentReportAssociation).not.toHaveBeenCalled();
  });
  it("withholds metrics until the newest report is known and exposes history failures for retry", async () => {
    vi.mocked(api.readAgentReportHistory).mockRejectedValueOnce(new Error("History connection failed"));
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("History connection failed");
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(api.readReportPage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry usage history" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(await screen.findByLabelText("Selected agent report metrics")).toHaveTextContent("181");
  });
  it("binds metrics, links and users to the table inventory selection instead of recapturing live evidence", async () => {
    renderPanel({ inventorySelectionId: selectionId });
    await screen.findByText("person0@example.invalid");
    expect(api.readAgentReportSummary).toHaveBeenCalledExactlyOnceWith(record.id,
      { inventorySelectionId: selectionId, selectionId }, expect.any(AbortSignal));
    expect(api.readAgentReportAssociations).toHaveBeenCalledExactlyOnceWith(record.id,
      { inventorySelectionId: selectionId, selectionId, cursor: undefined, limit: 50 }, expect.any(AbortSignal));
    expect(api.readReportPage).toHaveBeenCalledWith(`agent-inventory/${encodeURIComponent(record.id)}/usage-users`,
      expect.objectContaining({ inventorySelectionId: selectionId, selectionId }), expect.any(AbortSignal));
  });
  it.each(["summary", "associations", "users"] as const)("recaptures inventory once when the pinned %s selection is invalidated", async endpoint => {
    const error = new ApiError(409, "selection_invalidated", "Saved selection expired");
    if (endpoint === "summary") vi.mocked(api.readAgentReportSummary).mockRejectedValue(error);
    if (endpoint === "associations") vi.mocked(api.readAgentReportAssociations).mockRejectedValue(error);
    if (endpoint === "users") vi.mocked(api.readReportPage).mockRejectedValue(error);
    const onReloadInventory = vi.fn(), view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    await waitFor(() => expect(onReloadInventory).toHaveBeenCalledOnce());
    view.rerender(view.content({ dataRevision: 1 }));
    await waitFor(() => expect(api.readAgentReportSummary).toHaveBeenCalledTimes(2));
    expect(onReloadInventory).toHaveBeenCalledOnce();
    const next = "66666666-6666-4666-8666-666666666666", nextContext = { ...context, selectionId: next };
    vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({ context: nextContext }));
    vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({ context: nextContext }));
    const nextUsers: CandidateAgentUsageUsers = { ...users(), context: nextContext, selection: { ...users().selection, id: next } };
    vi.mocked(api.readReportPage).mockResolvedValue(nextUsers);
    view.rerender(view.content({ inventorySelectionId: next }));
    expect(await screen.findByText("person0@example.invalid")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("reloads the parent inventory on manual retry and refetches associations even when the selection ID stays the same", async () => {
    vi.mocked(api.readAgentReportAssociations).mockRejectedValueOnce(new Error("Temporary links failure"));
    const onReloadInventory = vi.fn();
    renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    await screen.findByRole("alert");
    expect(screen.getByRole("heading", { name: "Usage unavailable" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Usage not reported" })).not.toBeInTheDocument();
    expect(onReloadInventory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload usage" }));
    expect(onReloadInventory).toHaveBeenCalledOnce();
    expect(await screen.findByText("person0@example.invalid")).toBeVisible();
    expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(2);
  });
  it("does not loop if a freshly recaptured inventory selection is also invalid", async () => {
    vi.mocked(api.readAgentReportSummary).mockRejectedValue(new ApiError(409, "selection_invalidated", "Saved selection unavailable"));
    const onReloadInventory = vi.fn(), view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    await waitFor(() => expect(onReloadInventory).toHaveBeenCalledOnce());
    view.rerender(view.content({ inventorySelectionId: "66666666-6666-4666-8666-666666666666" }));
    await waitFor(() => expect(api.readAgentReportSummary).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved selection unavailable");
    expect(onReloadInventory).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Reload usage" }));
    expect(onReloadInventory).toHaveBeenCalledTimes(2);
  });
  it("does not recapture after access denial or silently select a report when the table has none", async () => {
    const onReloadInventory = vi.fn();
    vi.mocked(api.readAgentReportSummary).mockRejectedValueOnce(new ApiError(403, "forbidden", "Access revoked"));
    const view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    expect(await screen.findByRole("alert")).toHaveTextContent("Access revoked");
    expect(onReloadInventory).not.toHaveBeenCalled();
    view.rerender(view.content({ context: { ...inventoryContext, reports: { ...inventoryContext.reports, setId: null } } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match");
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
  });

  it("restores report dates, three metric cards and a direct two-column users table without storage diagnostics", async () => {
    renderPanel(); await screen.findByText("person0@example.invalid");
    const metrics = screen.getByLabelText("Selected agent report metrics");
    expect(metrics).toHaveTextContent("181"); expect(metrics).toHaveTextContent("7"); expect(metrics).toHaveTextContent("Sep 12, 2026");
    expect(metrics.querySelectorAll(".agent-usage-metric")).toHaveLength(3);
    expect(screen.getByLabelText("CSV report dates")).toHaveTextContent("Jan 1, 2026");
    expect(screen.getAllByRole("columnheader").map(cell => cell.textContent)).toEqual(["User", "Responses"]);
    expect(screen.queryByRole("region", { name: "Report provenance" })).not.toBeInTheDocument();
    expect(screen.queryByText(/snapshot exact-snapshot|Reported agent identities|exact_package_id/)).not.toBeInTheDocument();
    expect(screen.getByText("Reviewed report links").closest("details")).not.toHaveAttribute("open");
    expect(api.readReportDetail).not.toHaveBeenCalled(); expect(api.readAgentReportCandidates).not.toHaveBeenCalled();
    expect(api.readReportPage).toHaveBeenCalledExactlyOnceWith(`agent-inventory/${encodeURIComponent(record.id)}/usage-users`,
      expect.objectContaining({ selectionId, limit: 25 }), expect.any(AbortSignal));
  });
  it("shows missing CSV usage as not reported without offering reload or inventing zero", async () => {
    vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({ status: "unlinked", responses: null, activeUsers: null, associationCount: 0 }));
    vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({ value: [], counts: { total: 0, filtered: 0 }, page: { limit: 50, nextCursor: null, previousCursor: null } }));
    const onReloadInventory = vi.fn();
    renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    expect(await screen.findByText("This agent is not included in the latest CSV report.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Usage not reported" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reload usage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onReloadInventory).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(api.readReportPage).not.toHaveBeenCalled(); expect(api.readAgentReportCandidates).not.toHaveBeenCalled();
  });
  it.each(["never_imported", "deleted"] as const)("explains a %s CSV report without offering a reload that cannot supply it", async availability => {
    const noReport = { ...reports, setId: null, activeSetId: null, availability, lineages: [] };
    const noReportContext = { ...context, reportSetId: null, reports: noReport };
    vi.mocked(api.readAgentReportHistory).mockResolvedValue(agentUsageHistoryFixture(noReportContext, record.id));
    vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({
      status: "unavailable", responses: null, activeUsers: null, associationCount: 0, context: noReportContext,
    }));
    vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({
      value: [], context: noReportContext, counts: { total: 0, filtered: 0 }, page: { limit: 50, nextCursor: null, previousCursor: null },
    }));
    const onReloadInventory = vi.fn();
    renderPanel({ context: { ...inventoryContext, reports: noReport }, inventorySelectionId: selectionId, onReloadInventory });
    expect(await screen.findByRole("heading", { name: "No CSV reports available" })).toBeVisible();
    expect(screen.getByText("Import a complete CSV report in Sync to see usage.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reload usage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(onReloadInventory).not.toHaveBeenCalled();
    expect(api.readReportPage).not.toHaveBeenCalled();
  });
  it.each([0, null])("keeps zero and unknown exact metrics distinct: %s", async value => {
    vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({ responses: value, activeUsers: value, lastActivityDateUtc: null }));
    renderPanel(); const metrics = await screen.findByLabelText("Selected agent report metrics");
    expect(within(metrics).getAllByText(value === null ? "Unknown" : "0")).toHaveLength(2);
    expect(within(metrics).getByText("Not reported")).toBeVisible();
  });
  it.each(["record", "requested-set", "metadata-set", "pinned-selection"] as const)("rejects mismatched %s summaries", async mismatch => {
    if (mismatch !== "pinned-selection") vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({
      ...(mismatch === "record" ? { recordId: "different-record" } : {}),
      context: { ...context, ...(mismatch === "requested-set" ? { reportSetId: "different", reports: { ...reports, setId: "different" } }
        : mismatch === "metadata-set" ? { reports: { ...reports, setId: "different" } } : {}) },
    }));
    const view = renderPanel();
    if (mismatch === "pinned-selection") {
      await screen.findByText("person0@example.invalid");
      vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({ context: { ...context, selectionId: "different" } }));
      view.rerender(view.content({ dataRevision: 1 }));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match");
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(screen.queryByText("person0@example.invalid")).not.toBeInTheDocument();
  });
  it.each(["selectionId", "reportSetId", "usageRevision", "inventoryRevision"] as const)("rejects cross-read %s mismatches", async field => {
    vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({ context: { ...context, [field]: "changed" } }));
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("Reload usage");
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(api.readReportPage).not.toHaveBeenCalled();
  });
  it.each(["selectionId", "reportSetId", "usageRevision", "inventoryRevision"] as const)("withholds a users page with changed %s", async field => {
    const page = users(); page.context = { ...context, [field]: "changed" };
    vi.mocked(api.readReportPage).mockResolvedValue(page);
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("Reload agent usage");
    expect(screen.queryByText("person0@example.invalid")).not.toBeInTheDocument();
  });
  it("pages reviewed links only on request without draining thousands of associations", async () => {
    renderPanel(); await removal();
    expect(api.readAgentReportAssociations).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Next report links" }));
    await waitFor(() => expect(api.readAgentReportAssociations).toHaveBeenLastCalledWith(record.id,
      { selectionId, cursor: "links-next", limit: 50 }, expect.any(AbortSignal)));
  });
  it("removes reviewed identities only after confirmation with exact compare-and-swap fences", async () => {
    const view = renderPanel(); fireEvent.click(await removal());
    expect(screen.getByRole("heading", { name: "Remove reviewed association" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Confirm removal" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I confirm this reporting association should be removed." }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(view.props.onChanged).toHaveBeenCalledOnce());
    expect(api.mutateAgentReportAssociation).toHaveBeenCalledExactlyOnceWith(record.id, {
      selectionId, reportSetId: context.reportSetId, usageRevision: context.usageRevision, inventoryRevision: context.inventoryRevision,
      reportAgentId: association.reportAgentId, confirmed: true,
    }, "remove", expect.any(AbortSignal));
  });
  it("removes a reviewed link on its inventory pin and requests only one parent refresh", async () => {
    const onReloadInventory = vi.fn(), view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox", { name: "I confirm this reporting association should be removed." }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(view.props.onChanged).toHaveBeenCalledOnce());
    expect(api.mutateAgentReportAssociation).toHaveBeenCalledExactlyOnceWith(record.id, {
      selectionId, reportSetId: context.reportSetId, usageRevision: context.usageRevision, inventoryRevision: context.inventoryRevision,
      reportAgentId: association.reportAgentId, confirmed: true,
    }, "remove", expect.any(AbortSignal), selectionId);
    expect(onReloadInventory).not.toHaveBeenCalled();
  });
  it("restores focus on cancellation without writing", async () => {
    renderPanel(); const trigger = await removal(); fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Cancel association change" }));
    expect(trigger).toHaveFocus(); expect(api.mutateAgentReportAssociation).not.toHaveBeenCalled();
  });
  it.each(["role", "flag"] as const)("withholds management when %s permission is absent", async boundary => {
    const view = renderPanel({ canRemoveReviewedAssociations: boundary !== "flag" });
    if (boundary === "role") view.rerender(view.content({}, { ...view.principal, roles: ["AgentControl.Viewer"] }));
    await screen.findByText("person0@example.invalid");
    expect(screen.queryByText("Reviewed report links")).not.toBeInTheDocument();
  });
  it.each(["context", "dataRevision", "disabled"] as const)("retires confirmation across %s A-B-A changes", async boundary => {
    const view = renderPanel(); fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    view.rerender(view.content(boundary === "context" ? { context: { ...inventoryContext, revision: "changed" } }
      : boundary === "disabled" ? { disabled: true } : { dataRevision: 1 }));
    expect(screen.queryByRole("button", { name: "Confirm removal" })).not.toBeInTheDocument();
    view.rerender(view.content());
    expect(screen.queryByRole("button", { name: "Confirm removal" })).not.toBeInTheDocument();
    expect(api.mutateAgentReportAssociation).not.toHaveBeenCalled();
  });
  it("surfaces conflicts with explicit reload and no successful update", async () => {
    vi.mocked(api.mutateAgentReportAssociation).mockRejectedValue(new ApiError(409, "agent_usage_changed", "Exact source changed"));
    const view = renderPanel(); fireEvent.click(await removal()); fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Exact source changed");
    expect(view.props.onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload usage" }));
    await waitFor(() => expect(api.readAgentReportSummary).toHaveBeenCalledTimes(2));
  });
  it("keeps search, pagination, focus and scroll during slow same-selection revisions and aborts obsolete reads", async () => {
    const view = renderPanel(); await screen.findByText("person0@example.invalid");
    const search = screen.getByRole("searchbox", { name: "Search agent users" });
    fireEvent.change(search, { target: { value: "person" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next users" })).toHaveAttribute("aria-disabled", "false"));
    fireEvent.click(screen.getByRole("button", { name: "Next users" })); await screen.findByText("person25@example.invalid");
    const table = screen.getByRole("table"), region = screen.getByRole("region", { name: "Agent users" });
    region.scrollTop = 128; search.focus();
    const stale = deferred<CandidateAgentUsageUsers>(), latest = deferred<CandidateAgentUsageUsers>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(stale.promise).mockReturnValueOnce(latest.promise);
    view.rerender(view.content({ dataRevision: 1 }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(4));
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    view.rerender(view.content({ dataRevision: 2 }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(5));
    expect(signal?.aborted).toBe(true);
    const newest = users("users-next", "person"); newest.value[0].responses = 909;
    await act(async () => latest.resolve(newest));
    expect(await screen.findByRole("cell", { name: "909" })).toBeVisible();
    expect(screen.getByRole("table")).toBe(table); expect(search).toHaveFocus(); expect(region.scrollTop).toBe(128);
    const obsolete = users(); obsolete.value[0].username = "obsolete@example.invalid";
    await act(async () => stale.resolve(obsolete));
    expect(screen.queryByText("obsolete@example.invalid")).not.toBeInTheDocument();
  });
  it("searches concealed identities without substituting guessed directory users", async () => {
    renderPanel(); await screen.findByText("person0@example.invalid");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search agent users" }), { target: { value: "concealed" } });
    expect(await screen.findByText("7f7de4f6-censored")).toBeVisible();
  });
  it.each([new Error("Saved users failed"), new ApiError(403, "forbidden", "User access revoked")])("clears retained users on $message and retries", async failure => {
    const view = renderPanel(); await screen.findByText("person0@example.invalid");
    vi.mocked(api.readReportPage).mockRejectedValueOnce(failure); view.rerender(view.content({ dataRevision: 1 }));
    expect(await screen.findByRole("alert")).toHaveTextContent(failure.message);
    expect(screen.queryByText("person0@example.invalid")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" })); await screen.findByText("person0@example.invalid");
  });
  it.each(["tenant", "principal", "roles", "agent", "report", "associations"] as const)("cancels private reads across a %s boundary", async boundary => {
    const view = renderPanel(); await screen.findByText("person0@example.invalid");
    const stale = deferred<CandidateAgentUsageUsers>(); vi.mocked(api.readReportPage).mockReturnValueOnce(stale.promise);
    view.rerender(view.content({ dataRevision: 1 })); await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    const principal = { ...view.principal, ...(boundary === "tenant" ? { tenantId: "different" }
      : boundary === "principal" ? { homeAccountId: "different" } : boundary === "roles" ? { roles: ["AgentControl.Viewer"] as SessionUser["roles"] } : {}) };
    vi.mocked(api.readReportPage).mockReturnValue(new Promise(() => {}));
    view.rerender(view.content(boundary === "agent" ? { record: { ...record, id: "different" } }
      : boundary === "report" ? { context: { ...inventoryContext, revision: "different", reports: { ...reports, setId: "different" } } }
        : boundary === "associations" ? { context: { ...inventoryContext, revision: "different" } } : {}, principal));
    expect(signal?.aborted).toBe(true); await act(async () => stale.resolve(users()));
    expect(screen.queryByText("person0@example.invalid")).not.toBeInTheDocument();
    view.rerender(view.content({}, { ...principal, roles: [] }));
    expect(screen.getByRole("alert")).toHaveTextContent("Current Viewer access");
  });
});
