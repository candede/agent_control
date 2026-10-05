import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateAgentUsageAssociations, CandidateAgentUsageSummary } from "../../../backend/src/types/officialReportApi";
import type { ReportPage, ReportRelationship } from "../../../backend/src/types/officialReportData";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import { ApiError, type SessionUser, type UnifiedAgentRecord } from "../api/client";
import * as api from "../api/reportData";
import { CapabilityContext } from "../capabilityContext";
import { automaticUsageContext as inventoryContext, automaticUsagePackageId } from "../test/automaticAgentUsageFixture";
import { reportAgent, reportPage, reports, selectionId } from "../test/reportDataFixture";
import { deferred } from "../test/deferred";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { AgentUsagePanel } from "./AgentUsagePanel";

vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(), readAgentReportSummary: vi.fn(), readAgentReportAssociations: vi.fn(),
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
  return { recordId: record.id, status: "linked", responses: 181, activeUsers: 7, lastActivityDateUtc: "2026-09-12",
    associationCount: 2, context, ...overrides };
}
function links(overrides: Partial<CandidateAgentUsageAssociations> = {}): CandidateAgentUsageAssociations {
  return { value: [automatic, association], context, counts: { total: 2000, filtered: 2000 },
    page: { limit: 50, nextCursor: "links-next", previousCursor: null }, ...overrides };
}
function users(cursor?: string, search?: string): ReportPage<ReportRelationship> {
  return reportPage([{ id: "relationship", agentId: automaticUsagePackageId, agentName: "Excel", creatorType: "Your org",
    username: search === "concealed" ? "7f7de4f6-censored" : cursor ? "person25@example.invalid" : "person0@example.invalid",
    responses: cursor ? 25 : 50, lastActivityDateUtc: null, identityStatus: "unresolved" }],
  { counts: { total: 20000, filtered: 20000 }, page: { limit: 50, nextCursor: cursor ? null : "users-next", previousCursor: cursor ? "users-previous" : null } });
}
function renderPanel(overrides: Partial<ComponentProps<typeof AgentUsagePanel>> = {}) {
  const props = { record, context: inventoryContext, inventoryRevision: "a".repeat(64), canRemoveReviewedAssociations: true, onChanged: vi.fn(), ...overrides };
  const principal: SessionUser = { tenantId: "tenant", homeAccountId: "admin", username: "admin@example.invalid", displayName: "Admin", roles: ["AgentControl.Admin"] };
  const content = (next: Partial<typeof props> = {}, user = principal) => <CapabilityContext value={{
    user, views: [], now: Date.now(), pending: false, loading: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
  }}><WorkbenchActionProvider value={workbenchActions}><AgentUsagePanel {...props} {...next} /></WorkbenchActionProvider></CapabilityContext>;
  return { ...render(content()), props, principal, content };
}
beforeEach(() => {
  vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary());
  vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links());
  vi.mocked(api.mutateAgentReportAssociation).mockResolvedValue(context);
  vi.mocked(api.readReportDetail).mockResolvedValue({ value: reportAgent(1, { agentId: automaticUsagePackageId, agentName: "Excel" }),
    reports, selection: reportPage([]).selection, sources: reportPage([]).sources });
  vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => users(query?.cursor, query?.search));
  vi.mocked(api.readAgentReportCandidates).mockResolvedValue({
    value: [{ ...reportAgent(3, { agentName: "Possible exact association" }), associated: false }], context, selection: reportPage([]).selection,
    page: { limit: 50, nextCursor: "candidate-next", previousCursor: null }, counts: { total: 30000, filtered: 30000 },
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("exact inventory report usage", () => {
  it("explains missing exact saved-source evidence without fabricating zero or browsing report candidates", async () => {
    vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({ status: "unlinked", responses: null, activeUsers: null, associationCount: 0 }));
    vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({ value: [], counts: { total: 0, filtered: 0 }, page: { limit: 50, nextCursor: null, previousCursor: null } }));
    renderPanel();
    expect(await screen.findByText(/no linked evidence/)).toBeVisible();
    expect(screen.getByLabelText("Selected agent report metrics")).toHaveTextContent("Unknown");
    expect(api.readAgentReportCandidates).not.toHaveBeenCalled();
    expect(api.readReportDetail).not.toHaveBeenCalled();
    expect(api.readReportPage).not.toHaveBeenCalled();
  });
  it("shows exact server totals, dates and source references without adding overlapping observations", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "Excel report identity" });
    const metrics = screen.getByLabelText("Selected agent report metrics");
    expect(metrics).toHaveTextContent("181"); expect(metrics).toHaveTextContent("7"); expect(metrics).toHaveTextContent("Sep 12, 2026");
    expect(screen.getByRole("region", { name: "Report provenance" })).toHaveTextContent("2026-01-01");
    expect(screen.getAllByText(/snapshot exact-snapshot/)).toHaveLength(2);
    expect(screen.getByRole("navigation", { name: "report links pages" })).toHaveTextContent("2,000 matching report links; 2 on this page");
    expect(api.readAgentReportAssociations).toHaveBeenCalledWith(record.id, expect.objectContaining({ selectionId, limit: 50 }), expect.any(AbortSignal));
    expect(api.readReportPage).not.toHaveBeenCalled();
  });
  it("opens one unambiguous automatic identity without setup, but respects an explicit close across refreshes", async () => {
    vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({ associationCount: 1 }));
    vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({ value: [automatic], counts: { total: 1, filtered: 1 },
      page: { limit: 50, nextCursor: null, previousCursor: null } }));
    const view = renderPanel();
    await screen.findByText("person0@example.invalid");
    expect(api.readReportDetail).toHaveBeenCalledExactlyOnceWith(`official-usage/agents/${automaticUsagePackageId}`, selectionId, expect.any(AbortSignal));
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(api.readAgentReportCandidates).not.toHaveBeenCalled();
    expect(api.mutateAgentReportAssociation).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Review report association" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close agent details" }));
    view.rerender(view.content({ dataRevision: 1 }));
    await waitFor(() => expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Excel report identity" }));
    await screen.findByText("person0@example.invalid");
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });
  it.each(["record", "requested-set", "metadata-set", "pinned-selection"] as const)(
    "rejects a mismatched %s summary before exposing any associations or detail", async mismatch => {
      if (mismatch !== "pinned-selection") vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({
        ...(mismatch === "record" ? { recordId: "different-record" } : {}),
        context: { ...context, ...(mismatch === "requested-set" ? { reportSetId: "different", reports: { ...reports, setId: "different" } }
          : mismatch === "metadata-set" ? { reports: { ...reports, setId: "different" } } : {}) },
      }));
      const view = renderPanel();
      if (mismatch === "pinned-selection") {
        await screen.findByRole("button", { name: "Excel report identity" });
        vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({ context: { ...context, selectionId: "silently-new-selection" } }));
        view.rerender(view.content({ dataRevision: 1 }));
      }
      expect(await screen.findByRole("alert")).toHaveTextContent("does not match");
      expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Excel report identity" })).not.toBeInTheDocument();
      expect(api.readReportDetail).not.toHaveBeenCalled();
      expect(api.readReportPage).not.toHaveBeenCalled();
      if (mismatch !== "pinned-selection") expect(api.readAgentReportAssociations).not.toHaveBeenCalled();
    });
  it.each([0, null])("keeps true zero and unknown exact totals distinct: %s", async value => {
    vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({ responses: value, activeUsers: value, lastActivityDateUtc: null }));
    renderPanel();
    const metrics = await screen.findByLabelText("Selected agent report metrics");
    expect(within(metrics).getAllByText(value === null ? "Unknown" : "0")).toHaveLength(2);
    expect(within(metrics).getByText("Not reported")).toBeVisible();
  });
  it.each(["selectionId", "reportSetId", "usageRevision", "inventoryRevision"] as const)(
    "rejects cross-read %s mismatch rather than displaying associations from another mutable context", async field => {
      vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({ context: { ...context, [field]: "changed" } }));
      renderPanel();
      expect(await screen.findByRole("alert")).toHaveTextContent("Restart");
      expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Reviewed report identity" })).not.toBeInTheDocument();
    });
  it("pages byte-short associations only on demand without draining thousands of links", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "Excel report identity" });
    expect(api.readAgentReportAssociations).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Next report links" }));
    await waitFor(() => expect(api.readAgentReportAssociations).toHaveBeenLastCalledWith(record.id,
      { selectionId, cursor: "links-next", limit: 50 }, expect.any(AbortSignal)));
    expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(2);
  });
  it("allows removal only for reviewed identities with explicit confirmation and exact CAS fences", async () => {
    const view = renderPanel();
    const remove = await screen.findByRole("button", { name: "Remove reviewed association" });
    expect(screen.getAllByRole("button", { name: "Remove reviewed association" })).toHaveLength(1);
    fireEvent.click(remove);
    expect(screen.getByRole("button", { name: "Confirm removal" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I confirm this exact report association removal" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(view.props.onChanged).toHaveBeenCalledOnce());
    expect(api.mutateAgentReportAssociation).toHaveBeenCalledExactlyOnceWith(record.id, {
      selectionId, reportSetId: context.reportSetId, usageRevision: context.usageRevision, inventoryRevision: context.inventoryRevision,
      reportAgentId: association.reportAgentId, confirmed: true,
    }, "remove", expect.any(AbortSignal));
  });
  it("focuses confirmation and restores its trigger on cancellation without writing", async () => {
    renderPanel();
    const remove = await screen.findByRole("button", { name: "Remove reviewed association" });
    fireEvent.click(remove);
    expect(screen.getByRole("heading", { name: "Remove reviewed association for Reviewed report identity?" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel removal" }));
    expect(remove).toHaveFocus();
    expect(api.mutateAgentReportAssociation).not.toHaveBeenCalled();
  });
  it.each(["role", "flag"] as const)("withholds mutations when %s permission is absent", async boundary => {
    const view = renderPanel({ canRemoveReviewedAssociations: boundary !== "flag" });
    if (boundary === "role") view.rerender(view.content({}, { ...view.principal, roles: ["AgentControl.Viewer"] }));
    await screen.findByRole("button", { name: "Excel report identity" });
    expect(screen.queryByRole("button", { name: "Remove reviewed association" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review report association" })).not.toBeInTheDocument();
    expect(api.readAgentReportCandidates).not.toHaveBeenCalled();
  });
  it.each(["context", "dataRevision", "disabled"] as const)("retires confirmation across %s A-B-A changes", async boundary => {
    const view = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Remove reviewed association" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "I confirm this exact report association removal" }));
    view.rerender(view.content(boundary === "context" ? { context: { ...inventoryContext, revision: "changed" } }
      : boundary === "disabled" ? { disabled: true } : { dataRevision: 1 }));
    expect(screen.queryByRole("button", { name: "Confirm removal" })).not.toBeInTheDocument();
    view.rerender(view.content());
    expect(screen.queryByRole("button", { name: "Confirm removal" })).not.toBeInTheDocument();
    expect(api.mutateAgentReportAssociation).not.toHaveBeenCalled();
  });
  it("surfaces mutation conflicts with an explicit selection restart and no successful update", async () => {
    vi.mocked(api.mutateAgentReportAssociation).mockRejectedValue(new ApiError(409, "agent_usage_changed", "Exact source changed"));
    const view = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Remove reviewed association" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "I confirm this exact report association removal" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Exact source changed");
    expect(view.props.onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restart usage selection" }));
    await waitFor(() => expect(api.readAgentReportSummary).toHaveBeenCalledTimes(2));
    expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce();
  });
  it("loads exact report identity and separately paged searchable relationships, preserving concealed identities", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Excel report identity" }));
    await screen.findByText("person0@example.invalid");
    expect(api.readReportDetail).toHaveBeenCalledWith(`official-usage/agents/${encodeURIComponent(automaticUsagePackageId)}`, selectionId, expect.any(AbortSignal));
    expect(screen.getByRole("navigation", { name: "relationships pages" })).toHaveTextContent("20,000 matching relationships; 1 on this page");
    fireEvent.click(screen.getByRole("button", { name: "Next relationships" }));
    await screen.findByText("person25@example.invalid");
    expect(screen.queryByText("person0@example.invalid")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search reported agent users" }), { target: { value: "concealed" } });
    expect(await screen.findByText("7f7de4f6-censored")).toBeVisible();
    expect(api.readReportPage).toHaveBeenLastCalledWith(expect.any(String),
      expect.objectContaining({ selectionId, search: "concealed", limit: 50 }), expect.any(AbortSignal));
  });
  it("preserves relationship search, page, focus and scroll through slow same-selection revisions, aborting obsolete reads", async () => {
    const view = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Excel report identity" }));
    await screen.findByText("person0@example.invalid");
    const search = screen.getByRole("searchbox", { name: "Search reported agent users" });
    fireEvent.change(search, { target: { value: "person" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next relationships" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next relationships" }));
    await screen.findByText("person25@example.invalid");
    const table = screen.getByRole("table"), region = screen.getByRole("region", { name: "Exact reported agent details" });
    region.scrollTop = 128; search.focus();
    const stale = deferred<ReportPage<ReportRelationship>>(), latest = deferred<ReportPage<ReportRelationship>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(stale.promise).mockReturnValueOnce(latest.promise);
    view.rerender(view.content({ dataRevision: 1 }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(4));
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    expect(screen.getByText("person25@example.invalid")).toBeVisible();
    view.rerender(view.content({ dataRevision: 2 }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(5));
    expect(signal?.aborted).toBe(true);
    expect(api.readReportPage).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ selectionId, cursor: "users-next", search: "person" }), expect.any(AbortSignal));
    const newest = users("users-next", "person"); newest.value[0].responses = 909;
    await act(async () => latest.resolve(newest));
    expect(await screen.findByRole("cell", { name: "909" })).toBeVisible();
    expect(screen.getByRole("table")).toBe(table); expect(search).toHaveFocus(); expect(region.scrollTop).toBe(128);
    const obsolete = users(); obsolete.value[0].username = "obsolete@example.invalid";
    await act(async () => stale.resolve(obsolete));
    expect(screen.queryByText("obsolete@example.invalid")).not.toBeInTheDocument();
  });
  it.each([new Error("Saved users failed"), new ApiError(403, "forbidden", "User access revoked")])(
    "clears retained relationships on $message and retries the pinned query", async failure => {
      const view = renderPanel();
      fireEvent.click(await screen.findByRole("button", { name: "Excel report identity" }));
      await screen.findByText("person0@example.invalid");
      vi.mocked(api.readReportPage).mockRejectedValueOnce(failure);
      view.rerender(view.content({ dataRevision: 1 }));
      expect(await screen.findByRole("alert")).toHaveTextContent(failure.message);
      expect(screen.queryByText("person0@example.invalid")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
      await screen.findByText("person0@example.invalid");
      expect(api.readReportPage).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ selectionId }), expect.any(AbortSignal));
    });
  it.each(["tenant", "principal", "roles", "agent", "report", "associations"] as const)(
    "cancels private reads and details on a %s boundary and never revives an obsolete response", async boundary => {
      const view = renderPanel();
      fireEvent.click(await screen.findByRole("button", { name: "Excel report identity" }));
      await screen.findByText("person0@example.invalid");
      const stale = deferred<ReportPage<ReportRelationship>>();
      vi.mocked(api.readReportPage).mockReturnValueOnce(stale.promise);
      view.rerender(view.content({ dataRevision: 1 }));
      await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
      const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
      const principal = { ...view.principal, ...(boundary === "tenant" ? { tenantId: "different" }
        : boundary === "principal" ? { homeAccountId: "different" } : boundary === "roles" ? { roles: ["AgentControl.Viewer"] as SessionUser["roles"] } : {}) };
      view.rerender(view.content(boundary === "agent" ? { record: { ...record, id: "different" } }
        : boundary === "report" ? { context: { ...inventoryContext, revision: "different", reports: { ...reports, setId: "different" } } }
          : boundary === "associations" ? { context: { ...inventoryContext, revision: "different" } } : {}, principal));
      expect(signal?.aborted).toBe(true);
      expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
      await act(async () => stale.resolve(users()));
      expect(screen.queryByText("person0@example.invalid")).not.toBeInTheDocument();
      view.rerender(view.content({}, { ...principal, roles: [] }));
      expect(screen.getByRole("alert")).toHaveTextContent("Current Viewer access");
    });
  it("replaces removed relationship rows with an explicit empty selected result", async () => {
    const view = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Excel report identity" }));
    await screen.findByText("person0@example.invalid");
    vi.mocked(api.readReportPage).mockResolvedValue(reportPage([], { counts: { total: 0, filtered: 0 } }));
    view.rerender(view.content({ dataRevision: 1 }));
    expect(await screen.findByText("No users listed in this report.")).toBeVisible();
    expect(screen.queryByText("person0@example.invalid")).not.toBeInTheDocument();
  });
  it("browses bounded candidate pages only after explicit review, then confirms the exact source and CAS context", async () => {
    const view = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Review report association" }));
    const section = screen.getByRole("region", { name: "Review exact report association" });
    fireEvent.click(await within(section).findByRole("button", { name: "Possible exact association" }));
    expect(api.readAgentReportCandidates).toHaveBeenCalledOnce();
    const confirm = screen.getByRole("button", { name: "Confirm association" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Exact inventory source"), { target: { value: JSON.stringify(["graph_packages", automaticUsagePackageId]) } });
    fireEvent.click(screen.getByRole("checkbox", { name: "I confirm these exact identities represent the same agent" }));
    fireEvent.click(confirm);
    await waitFor(() => expect(view.props.onChanged).toHaveBeenCalledOnce());
    expect(api.mutateAgentReportAssociation).toHaveBeenCalledWith(record.id, {
      selectionId, reportSetId: context.reportSetId, usageRevision: context.usageRevision, inventoryRevision: context.inventoryRevision,
      reportAgentId: "agent-3", target: { source: "graph_packages", packageId: automaticUsagePackageId }, confirmed: true,
    }, "associate", expect.any(AbortSignal));
  });
  it("restarts the inventory parent rather than replaying invalidated exact-agent children", async () => {
    vi.mocked(api.readReportPage).mockRejectedValue(new ApiError(409, "selection_invalidated", "Changed"));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Excel report identity" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restart selection" }));
    await waitFor(() => expect(api.readAgentReportSummary).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("region", { name: "Exact reported agent details" })).not.toBeInTheDocument();
  });
});
