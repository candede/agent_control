import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentUsageHistoryPoint, CandidateAgentUsageAssociations, CandidateAgentUsageHistory, CandidateAgentUsageSummary, CandidateAgentUsageUsers } from "../../../backend/src/types/officialReportApi";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import { ApiError, type SessionUser, type UnifiedAgentRecord } from "../api/client";
import * as api from "../api/reportData";
import { CapabilityContext } from "../capabilityContext";
import { agentUsageHistoryFixture, automaticUsageContext as inventoryContext, automaticUsagePackageId } from "../test/automaticAgentUsageFixture";
import { reportPage, reports, selectionId } from "../test/reportDataFixture";
import { deferred } from "../test/deferred";
import { createSavedQueryClient } from "../savedQueries";
import { usageDate } from "../usageInsights";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { AgentUsagePanel } from "./AgentUsagePanel";

const paging = vi.hoisted(() => ({ links: undefined as ComponentProps<typeof import("./ReportPageControls").ReportPageControls> | undefined }));
vi.mock("./ReportPageControls", async original => {
  const actual = await original<typeof import("./ReportPageControls")>();
  return { ...actual, ReportPageControls: (props: ComponentProps<typeof actual.ReportPageControls>) => {
    if (props.label === "report links") paging.links = props;
    return <actual.ReportPageControls {...props} />;
  } };
});
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
  const queryClient = createSavedQueryClient();
  const principal: SessionUser = { tenantId: "tenant", homeAccountId: "admin", username: "admin@example.invalid", displayName: "Admin", roles: ["AgentControl.Admin"] };
  const content = (next: Partial<typeof props> = {}, user = principal, panelKey = "panel") => <QueryClientProvider client={queryClient}><CapabilityContext value={{
    user, views: [], now: Date.now(), pending: false, loading: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
  }}><WorkbenchActionProvider value={workbenchActions}><AgentUsagePanel key={panelKey} {...props} {...next} /></WorkbenchActionProvider></CapabilityContext></QueryClientProvider>;
  return { ...render(content()), props, principal, content, queryClient };
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
  it.each(["page", "revision", "disabled", "account", "unmount"] as const)(
    "retires report-link callbacks across %s changes", async boundary => {
      const view = renderPanel();
      await removal();
      const stale = paging.links!;
      if (boundary === "unmount") view.unmount();
      else if (boundary === "page") {
        fireEvent.click(screen.getByRole("button", { name: "Next report links" }));
        await waitFor(() => expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.getByRole("button", { name: "Next report links" })).toHaveAttribute("aria-disabled", "false"));
      } else {
        view.rerender(view.content(boundary === "revision" ? { dataRevision: 1 } : boundary === "disabled" ? { disabled: true } : {},
          boundary === "account" ? { ...view.principal, homeAccountId: "replacement" } : view.principal));
        if (boundary !== "disabled") await screen.findByText("person0@example.invalid");
      }
      const count = vi.mocked(api.readAgentReportAssociations).mock.calls.length;
      act(() => { stale.next(); stale.previous(); });
      expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(count);
    });

  it.each(["exact-inventory-report", "exact-inventory-history", "exact-inventory-associations"])(
    "does not page report links after %s fails before its notification renders", async kind => {
      const view = renderPanel();
      await removal();
      const cached = view.queryClient.getQueryCache().find({ queryKey: ["saved", kind], exact: false })!;
      act(() => {
        cached.setState({ status: "error", error: new Error("Read failed.") });
        fireEvent.click(screen.getByRole("button", { name: "Next report links" }));
      });
      expect(api.readAgentReportAssociations).toHaveBeenCalledOnce();
    });

  it.each(["exact-inventory-report", "exact-inventory-history", "exact-inventory-associations"])(
    "does not page report links while %s revalidates before its notification renders", async kind => {
      const view = renderPanel();
      await removal();
      const summaryRead = deferred<CandidateAgentUsageSummary>(), historyRead = deferred<CandidateAgentUsageHistory>();
      const linksRead = deferred<CandidateAgentUsageAssociations>();
      vi.mocked(api.readAgentReportSummary).mockReturnValue(summaryRead.promise);
      vi.mocked(api.readAgentReportHistory).mockReturnValue(historyRead.promise);
      vi.mocked(api.readAgentReportAssociations).mockReturnValue(linksRead.promise);
      act(() => {
        void view.queryClient.invalidateQueries({ queryKey: ["saved", kind] });
        fireEvent.click(screen.getByRole("button", { name: "Next report links" }));
      });
      expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(kind === "exact-inventory-associations" ? 2 : 1);
      expect(vi.mocked(api.readAgentReportAssociations).mock.lastCall?.[1].cursor).toBeUndefined();
      expect(vi.mocked(api.readAgentReportAssociations).mock.lastCall?.[2]?.aborted).toBe(false);
    });

  it("admits only the first report-link direction before the page transition commits", async () => {
    vi.mocked(api.readAgentReportAssociations).mockResolvedValueOnce(links({
      page: { limit: 50, nextCursor: "links-next", previousCursor: "links-previous" },
    }));
    renderPanel();
    await removal();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Next report links" }));
      fireEvent.click(screen.getByRole("button", { name: "Previous report links" }));
    });
    await waitFor(() => expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.readAgentReportAssociations).mock.lastCall?.[1].cursor).toBe("links-next");
  });

  it.each([false, true])("does not describe an empty users page as no matching users (filtered=%s)", async filtered => {
    renderPanel();
    await screen.findByText("person0@example.invalid");
    if (filtered) {
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "person" } });
      await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByRole("button", { name: "Next users" })).toHaveAttribute("aria-disabled", "false"));
    }
    vi.mocked(api.readReportPage).mockResolvedValueOnce({ ...users("users-next"), value: [] });
    fireEvent.click(screen.getByRole("button", { name: "Next users" }));
    expect(await screen.findByText("No users on this page. Use the page controls to continue.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous users" })).toHaveAttribute("aria-disabled", "false");
    expect(screen.queryByText("No users match your search.")).not.toBeInTheDocument();
    expect(screen.queryByText("No users listed in this report.")).not.toBeInTheDocument();
  });

  it("retains the users pager through pending, failed and retried reads", async () => {
    renderPanel({ inventorySelectionId: selectionId });
    await screen.findByText("person0@example.invalid");
    const pending = deferred<CandidateAgentUsageUsers>(), retry = deferred<CandidateAgentUsageUsers>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise).mockReturnValueOnce(retry.promise);
    const next = screen.getByRole("button", { name: "Next users" });
    next.focus();
    fireEvent.click(next);
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    await act(async () => pending.reject(new Error("Page unavailable.")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Page unavailable.");
    expect(next).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    expect(next).toHaveFocus();
    await act(async () => retry.resolve(users("users-next")));
    await screen.findByText("person25@example.invalid");
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
  });

  it("keeps report-link paging focused and withdraws stale rows and counts during failure and retry", async () => {
    renderPanel({ inventorySelectionId: selectionId });
    await removal();
    const pending = deferred<CandidateAgentUsageAssociations>(), retry = deferred<CandidateAgentUsageAssociations>();
    vi.mocked(api.readAgentReportAssociations).mockReturnValueOnce(pending.promise).mockReturnValueOnce(retry.promise);
    const next = screen.getByRole("button", { name: "Next report links" });
    next.focus();
    fireEvent.click(next);
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText("Reviewed report identity")).not.toBeInTheDocument();
    expect(screen.queryByText("2,000 matching report links; 2 on this page")).not.toBeInTheDocument();
    await act(async () => pending.reject(new ApiError(400, "invalid_cursor", "Link cursor expired.")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Link cursor expired.");
    expect(next).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Retry report links" }));
    expect(next).toHaveFocus();
    await act(async () => retry.resolve(links()));
    await screen.findByText("Reviewed report identity");
    expect(next).toHaveFocus();
    expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(3);
    expect(api.readAgentReportSummary).toHaveBeenCalledOnce();
  });

  it("loads only history for a pinned Usage view and reuses Users reads across tab switches", async () => {
    const view = renderPanel({ inventorySelectionId: selectionId, view: "usage" });
    await screen.findByRole("region", { name: "Reported usage trend" });
    expect(api.readAgentReportSummary).not.toHaveBeenCalled();
    expect(api.readAgentReportAssociations).not.toHaveBeenCalled();
    expect(api.readReportPage).not.toHaveBeenCalled();
    view.rerender(view.content({ view: "users" }));
    await screen.findByText("person0@example.invalid");
    view.rerender(view.content({ view: "usage" }));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(api.readAgentReportHistory).toHaveBeenCalledTimes(2));
    expect(api.readAgentReportSummary).toHaveBeenCalledOnce();
    expect(api.readAgentReportAssociations).toHaveBeenCalledOnce();
    view.rerender(view.content({ view: "users" }));
    await screen.findByText("person0@example.invalid");
    expect(api.readAgentReportSummary).toHaveBeenCalledOnce();
    expect(api.readAgentReportAssociations).toHaveBeenCalledOnce();
  });

  it("preserves the users search and page across hidden visits without refetching unchanged evidence", async () => {
    const view = renderPanel({ inventorySelectionId: selectionId });
    await screen.findByText("person0@example.invalid");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "person" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: "Next users" }));
    await screen.findByText("person25@example.invalid");
    view.rerender(view.content({ view: "usage" }));
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(api.readAgentReportHistory).toHaveBeenCalledTimes(2));
    view.rerender(view.content({ view: "users" }));
    expect(await screen.findByRole("searchbox")).toHaveValue("person");
    expect(screen.getByText("person25@example.invalid")).toBeVisible();
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(api.readAgentReportHistory).toHaveBeenCalledTimes(3));
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
  });

  it("keeps a pending users read owned while hidden and defers its recovery until Users is visible", async () => {
    const pending = deferred<CandidateAgentUsageUsers>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const onReloadInventory = vi.fn(), view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    view.rerender(view.content({ view: "usage" }));
    expect(signal?.aborted).toBe(false);
    await act(async () => pending.reject(new ApiError(409, "selection_invalidated", "Users selection expired")));
    expect(screen.getByRole("region", { name: "Reported usage trend" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onReloadInventory).not.toHaveBeenCalled();
    view.rerender(view.content({ view: "users" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This selection changed or expired");
    await waitFor(() => expect(onReloadInventory).toHaveBeenCalledOnce());
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });

  it("defers hidden users revision reads and catches up once without resetting their search or page", async () => {
    const view = renderPanel({ inventorySelectionId: selectionId });
    await screen.findByText("person0@example.invalid");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "person" } });
    const next = screen.getByRole("button", { name: "Next users" });
    await waitFor(() => expect(next).toHaveAttribute("aria-disabled", "false"));
    fireEvent.click(next);
    await screen.findByText("person25@example.invalid");
    view.rerender(view.content({ view: "usage", dataRevision: 1 }));
    await waitFor(() => expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(2));
    view.rerender(view.content({ view: "usage", dataRevision: 2 }));
    await waitFor(() => expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(3));
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    view.rerender(view.content({ view: "users", dataRevision: 2 }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(4));
    expect(api.readReportPage).toHaveBeenLastCalledWith(expect.stringContaining("/usage-users"),
      expect.objectContaining({ selectionId, search: "person", cursor: "users-next" }), expect.any(AbortSignal));
    expect(screen.getByRole("searchbox")).toHaveValue("person");
    await screen.findByText("person25@example.invalid");
  });

  it("resets hidden users state and rejects late results across an account A-B-A change", async () => {
    const view = renderPanel({ inventorySelectionId: selectionId });
    await screen.findByText("person0@example.invalid");
    const pending = deferred<CandidateAgentUsageUsers>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "private search" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    view.rerender(view.content({ view: "usage" }));
    view.rerender(view.content({ view: "usage" }, { ...view.principal, homeAccountId: "different" }));
    expect(signal?.aborted).toBe(true);
    view.rerender(view.content({ view: "users" }));
    expect(await screen.findByRole("searchbox")).toHaveValue("");
    const stale = users(); stale.value[0].username = "obsolete@example.invalid";
    await act(async () => pending.resolve(stale));
    expect(screen.queryByText("obsolete@example.invalid")).not.toBeInTheDocument();
    await screen.findByText("person0@example.invalid");
  });

  it.each(["history", "summary", "associations"] as const)("cancels pending private users when %s loses authority", async endpoint => {
    const pending = deferred<CandidateAgentUsageUsers>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const view = renderPanel({ inventorySelectionId: selectionId });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    const failure = new ApiError(403, "forbidden", "Usage access revoked");
    if (endpoint === "history") vi.mocked(api.readAgentReportHistory).mockRejectedValue(failure);
    else if (endpoint === "summary") vi.mocked(api.readAgentReportSummary).mockRejectedValue(failure);
    else vi.mocked(api.readAgentReportAssociations).mockRejectedValue(failure);
    await act(async () => view.queryClient.refetchQueries({
      queryKey: ["saved", endpoint === "summary" ? "exact-inventory-report" : `exact-inventory-${endpoint}`],
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Usage access revoked");
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(users()));
    expect(screen.queryByText("person0@example.invalid")).not.toBeInTheDocument();
  });

  it.each(["summary", "associations"] as const)("does not let a hidden Users %s failure hide or reload the trend", async endpoint => {
    const failure = new ApiError(409, "selection_invalidated", "Users evidence changed");
    const pending = deferred<never>();
    if (endpoint === "summary") vi.mocked(api.readAgentReportSummary).mockReturnValueOnce(pending.promise);
    else vi.mocked(api.readAgentReportAssociations).mockReturnValueOnce(pending.promise);
    const onReloadInventory = vi.fn(), view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    await waitFor(() => expect(endpoint === "summary" ? api.readAgentReportSummary : api.readAgentReportAssociations).toHaveBeenCalledOnce());
    view.rerender(view.content({ view: "usage" }));
    await act(async () => pending.reject(failure));
    await waitFor(() => expect(view.queryClient.getQueryCache().find({
      queryKey: ["saved", endpoint === "summary" ? "exact-inventory-report" : "exact-inventory-associations"], exact: false,
    })?.state.status).toBe("error"));
    await waitFor(() => expect(screen.queryByText("Loading saved agent usage...")).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Reported usage trend" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onReloadInventory).not.toHaveBeenCalled();
    view.rerender(view.content({ view: "users" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Users evidence changed");
    await waitFor(() => expect(onReloadInventory).toHaveBeenCalledOnce());
  });

  it("retries an invalid history cursor from the first page without reloading inventory", async () => {
    const first = { ...agentUsageHistoryFixture(context, record.id),
      page: { limit: 50, nextCursor: "retired-cursor", previousCursor: null } };
    vi.mocked(api.readAgentReportHistory).mockImplementation(async (_id, query) => {
      if (query.cursor) throw new ApiError(400, "invalid_cursor", "Report history changed");
      return first;
    });
    const onReloadInventory = vi.fn();
    renderPanel({ inventorySelectionId: selectionId, onReloadInventory, view: "usage" });
    fireEvent.click(await screen.findByRole("button", { name: "Older reports" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Report history changed");
    fireEvent.click(screen.getByRole("button", { name: "Retry usage history" }));
    await screen.findByRole("region", { name: "Reported usage trend" });
    expect(api.readAgentReportHistory).toHaveBeenCalledTimes(3);
    expect(api.readAgentReportHistory).toHaveBeenLastCalledWith(record.id,
      { selectionId, inventorySelectionId: selectionId, cursor: undefined, limit: 50 }, expect.any(AbortSignal));
    expect(onReloadInventory).not.toHaveBeenCalled();
  });

  it("retains a busy trend while paging and deduplicates navigation and focus without loading Users", async () => {
    const defaultPoint = agentUsageHistoryFixture(context, record.id).value[0];
    const points = [
      ...Array.from({ length: 50 }, (_, index) => ({ ...defaultPoint, setId: `report-${String(index).padStart(2, "0")}` })),
      { ...defaultPoint, setId: "older-report", reportingStart: "2025-12-01", reportingEnd: "2025-12-31",
        responses: 0, status: "linked" as const, associationCount: 1 },
    ];
    const first = agentUsageHistoryFixture(context, record.id, points);
    const older = agentUsageHistoryFixture(context, record.id, points, { cursor: first.page.nextCursor! });
    const pending = deferred<CandidateAgentUsageHistory>(), returning = deferred<CandidateAgentUsageHistory>();
    vi.mocked(api.readAgentReportHistory).mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise)
      .mockReturnValueOnce(returning.promise);
    const onReloadInventory = vi.fn(), view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory, view: "usage" });
    const trend = await screen.findByRole("region", { name: "Reported usage trend" });
    const table = within(trend).getByRole("table"), next = screen.getByRole("button", { name: "Older reports" });
    expect(within(table).getAllByRole("row")).toHaveLength(51);
    expect(screen.getByText("50 of 51 reports")).toBeVisible();
    expect(screen.queryByText("No usage reported in saved reports.")).not.toBeInTheDocument();
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent(window, new Event("focus"));
    fireEvent(window, new Event("focus"));
    expect(api.readAgentReportHistory).toHaveBeenCalledTimes(2);
    expect(api.readAgentReportHistory).toHaveBeenLastCalledWith(record.id,
      { selectionId, inventorySelectionId: selectionId, cursor: first.page.nextCursor, limit: 50 }, expect.any(AbortSignal));
    expect(screen.getByRole("region", { name: "Reported usage trend" })).toBe(trend);
    expect(trend).toHaveAttribute("aria-busy", "true");
    expect(within(trend).getByRole("table")).toBe(table);
    expect(next).toBeDisabled();
    expect(screen.getByRole("button", { name: "Newer reports" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Checking saved report history...");
    await act(async () => pending.resolve(older));
    await waitFor(() => expect(trend).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByText("Dec 1, 2025 to Dec 31, 2025")).toBeVisible();
    view.rerender(view.content({ disabled: true }));
    fireEvent.click(screen.getByRole("button", { name: "Newer reports" }));
    expect(api.readAgentReportHistory).toHaveBeenCalledTimes(2);
    view.rerender(view.content());
    fireEvent.click(screen.getByRole("button", { name: "Newer reports" }));
    expect(api.readAgentReportHistory).toHaveBeenLastCalledWith(record.id,
      { selectionId, inventorySelectionId: selectionId, cursor: older.page.previousCursor, limit: 50 }, expect.any(AbortSignal));
    expect(trend).toHaveAttribute("aria-busy", "true");
    await act(async () => returning.resolve(first));
    await waitFor(() => expect(trend).toHaveAttribute("aria-busy", "false"));
    expect(screen.queryByText("Dec 1, 2025 to Dec 31, 2025")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.readAgentReportHistory).toHaveBeenCalledTimes(3);
    expect(api.readAgentReportSummary).not.toHaveBeenCalled();
    expect(api.readAgentReportAssociations).not.toHaveBeenCalled();
    expect(api.readReportPage).not.toHaveBeenCalled();
    expect(onReloadInventory).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid_cursor", false], ["service_unavailable", false],
    ["invalid_cursor", true], ["service_unavailable", true],
  ] as const)("preserves Users ownership after history %s with a different shared report: %s", async (code, differentSharedReport) => {
    const sharedContext = differentSharedReport ? { ...context, reportSetId: "77777777-7777-4777-8777-777777777777",
      reports: { ...reports, setId: "77777777-7777-4777-8777-777777777777" } } : context;
    const first = { ...agentUsageHistoryFixture(context, record.id),
      context: sharedContext,
      page: { limit: 50, nextCursor: "older", previousCursor: null } };
    vi.mocked(api.readAgentReportHistory).mockResolvedValue(first);
    const onReloadInventory = vi.fn(), view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory,
      context: { ...inventoryContext, reports: sharedContext.reports } });
    await screen.findByText("person0@example.invalid");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "person" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: "Next users" }));
    await screen.findByText("person25@example.invalid");
    view.rerender(view.content({ view: "usage" }));
    const failed = deferred<CandidateAgentUsageHistory>();
    vi.mocked(api.readAgentReportHistory).mockReturnValueOnce(failed.promise);
    fireEvent.click(screen.getByRole("button", { name: "Older reports" }));
    const signal = vi.mocked(api.readAgentReportHistory).mock.lastCall?.[2];
    fireEvent(window, new Event("focus"));
    expect(api.readAgentReportHistory).toHaveBeenCalledTimes(2);
    expect(signal?.aborted).toBe(false);
    await act(async () => failed.reject(new ApiError(code === "invalid_cursor" ? 400 : 503, code, "History page failed")));
    expect(await screen.findByRole("alert")).toHaveTextContent("History page failed");
    view.rerender(view.content({ view: "users" }));
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    const retry = deferred<CandidateAgentUsageHistory>();
    vi.mocked(api.readAgentReportHistory).mockReturnValueOnce(retry.promise);
    fireEvent.click(screen.getByRole("button", { name: "Retry usage history" }));
    expect(api.readAgentReportHistory).toHaveBeenLastCalledWith(record.id,
      { selectionId, inventorySelectionId: selectionId, cursor: code === "invalid_cursor" ? undefined : "older", limit: 50 }, expect.any(AbortSignal));
    await act(async () => retry.resolve(first));
    expect(await screen.findByRole("searchbox")).toHaveValue("person");
    expect(screen.getByText("person25@example.invalid")).toBeVisible();
    expect(api.readAgentReportHistory).toHaveBeenCalledTimes(3);
    expect(api.readAgentReportSummary).toHaveBeenCalledExactlyOnceWith(record.id,
      { selectionId, inventorySelectionId: selectionId, ...(differentSharedReport ? { setId: reports.setId } : {}) }, expect.any(AbortSignal));
    expect(api.readAgentReportAssociations).toHaveBeenCalledOnce();
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(onReloadInventory).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("waits for all current reads before treating a revalidation revision mismatch as invalidation", async () => {
    const onReloadInventory = vi.fn(), view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    await screen.findByText("person0@example.invalid");
    const updatedContext = { ...context, usageRevision: "d".repeat(64) };
    const pendingSummary = deferred<CandidateAgentUsageSummary>(), pendingLinks = deferred<CandidateAgentUsageAssociations>();
    vi.mocked(api.readAgentReportSummary).mockReturnValueOnce(pendingSummary.promise);
    vi.mocked(api.readAgentReportAssociations).mockReturnValueOnce(pendingLinks.promise);
    vi.mocked(api.readAgentReportHistory).mockResolvedValue(agentUsageHistoryFixture(updatedContext, record.id));
    const updatedUsers: CandidateAgentUsageUsers = { ...users(), context: updatedContext };
    vi.mocked(api.readReportPage).mockResolvedValue(updatedUsers);
    view.rerender(view.content({ dataRevision: 1 }));
    await act(async () => pendingSummary.resolve(summary({ context: updatedContext })));
    await waitFor(() => expect(view.queryClient.getQueryCache().findAll({
      queryKey: ["saved", "exact-inventory-report"],
    }).some(query => query.state.data && (query.state.data as CandidateAgentUsageSummary).context.usageRevision === updatedContext.usageRevision)).toBe(true));
    expect(onReloadInventory).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Usage unavailable" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No CSV reports available" })).not.toBeInTheDocument();
    await act(async () => pendingLinks.resolve(links({ context: updatedContext })));
    await screen.findByText("person0@example.invalid");
    expect(onReloadInventory).not.toHaveBeenCalled();
    expect(api.readAgentReportSummary).toHaveBeenCalledTimes(2);
    expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("invalidates dependent Users reads and retired link cursors only when history revisions change", async () => {
    const onReloadInventory = vi.fn(), view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    await removal();
    fireEvent.click(screen.getByRole("button", { name: "Next report links" }));
    await waitFor(() => expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(2));
    const updatedContext = { ...context, usageRevision: "d".repeat(64) };
    vi.mocked(api.readAgentReportHistory).mockResolvedValue(agentUsageHistoryFixture(updatedContext, record.id));
    vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({ responses: 999, context: updatedContext }));
    vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({ context: updatedContext }));
    const updatedUsers: CandidateAgentUsageUsers = { ...users(), context: updatedContext };
    vi.mocked(api.readReportPage).mockResolvedValue(updatedUsers);
    view.rerender(view.content({ view: "usage" }));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(api.readAgentReportSummary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(3));
    expect(api.readAgentReportAssociations).toHaveBeenLastCalledWith(record.id,
      { selectionId, inventorySelectionId: selectionId, cursor: undefined, limit: 50 }, expect.any(AbortSignal));
    expect(api.readReportPage).toHaveBeenCalledOnce();
    view.rerender(view.content({ view: "users" }));
    expect(await screen.findByLabelText("Selected agent report metrics")).toHaveTextContent("999");
    await screen.findByText("person0@example.invalid");
    expect(api.readAgentReportSummary).toHaveBeenCalledTimes(2);
    expect(api.readAgentReportHistory).toHaveBeenCalledTimes(2);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(onReloadInventory).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("deduplicates pending history revalidation and aborts superseded revisions without accepting late data", async () => {
    const view = renderPanel({ inventorySelectionId: selectionId, view: "usage" });
    await screen.findByRole("region", { name: "Reported usage trend" });
    const stale = deferred<CandidateAgentUsageHistory>(), current = deferred<CandidateAgentUsageHistory>();
    vi.mocked(api.readAgentReportHistory).mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    fireEvent(window, new Event("focus"));
    fireEvent(window, new Event("focus"));
    expect(api.readAgentReportHistory).toHaveBeenCalledTimes(2);
    const signal = vi.mocked(api.readAgentReportHistory).mock.lastCall?.[2];
    view.rerender(view.content({ dataRevision: 1 }));
    expect(api.readAgentReportHistory).toHaveBeenCalledTimes(3);
    expect(signal?.aborted).toBe(true);
    const freshHistory = agentUsageHistoryFixture(context, record.id);
    freshHistory.value[0] = { ...freshHistory.value[0], responses: 222, status: "linked" };
    await act(async () => current.resolve(freshHistory));
    expect(await screen.findByRole("cell", { name: "222" })).toBeVisible();
    const staleHistory = agentUsageHistoryFixture(context, record.id);
    staleHistory.value[0] = { ...staleHistory.value[0], responses: 111, status: "linked" };
    await act(async () => stale.resolve(staleHistory));
    expect(screen.queryByRole("cell", { name: "111" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.readAgentReportSummary).not.toHaveBeenCalled();
  });

  it.each(["tenant", "principal", "roles"] as const)("withdraws history and cancels pending requests across a %s A-B-A boundary", async boundary => {
    const view = renderPanel({ inventorySelectionId: selectionId, view: "usage" });
    await screen.findByRole("region", { name: "Reported usage trend" });
    const stale = deferred<CandidateAgentUsageHistory>();
    vi.mocked(api.readAgentReportHistory).mockReturnValueOnce(stale.promise);
    fireEvent(window, new Event("focus"));
    const signal = vi.mocked(api.readAgentReportHistory).mock.lastCall?.[2];
    const principal = { ...view.principal, ...(boundary === "tenant" ? { tenantId: "different" }
      : boundary === "principal" ? { homeAccountId: "different" } : { roles: ["AgentControl.Viewer"] as SessionUser["roles"] }) };
    vi.mocked(api.readAgentReportHistory).mockReturnValue(new Promise(() => {}));
    view.rerender(view.content({}, principal));
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("region", { name: "Reported usage trend" })).not.toBeInTheDocument();
    view.rerender(view.content());
    const staleHistory = agentUsageHistoryFixture(context, record.id);
    staleHistory.value[0] = { ...staleHistory.value[0], responses: 111, status: "linked" };
    await act(async () => stale.resolve(staleHistory));
    expect(screen.queryByRole("region", { name: "Reported usage trend" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.readAgentReportHistory).toHaveBeenCalledTimes(4);
  });

  it("allows another history recovery only after a replacement selection has loaded successfully", async () => {
    vi.mocked(api.readAgentReportHistory).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Expired history"));
    const onReloadInventory = vi.fn(), view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory, view: "usage" });
    await waitFor(() => expect(onReloadInventory).toHaveBeenCalledOnce());
    const next = "66666666-6666-4666-8666-666666666666";
    view.rerender(view.content({ inventorySelectionId: next }));
    await screen.findByRole("region", { name: "Reported usage trend" });
    vi.mocked(api.readAgentReportHistory).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Expired again"));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(onReloadInventory).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent("Expired again");
  });

  it.each(["summary", "associations", "users"] as const)("does not renew failed %s recovery by visiting a healthy Usage tab", async endpoint => {
    const failure = new ApiError(409, "selection_invalidated", "Users selection expired");
    if (endpoint === "summary") vi.mocked(api.readAgentReportSummary).mockRejectedValue(failure);
    if (endpoint === "associations") vi.mocked(api.readAgentReportAssociations).mockRejectedValue(failure);
    if (endpoint === "users") vi.mocked(api.readReportPage).mockRejectedValue(failure);
    const onReloadInventory = vi.fn(), view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    await waitFor(() => expect(onReloadInventory).toHaveBeenCalledOnce());
    for (let visit = 0; visit < 2; visit++) {
      view.rerender(view.content({ view: "usage" }));
      await screen.findByRole("region", { name: "Reported usage trend" });
      view.rerender(view.content({ view: "users" }));
      await screen.findByRole("alert");
      expect(onReloadInventory).toHaveBeenCalledOnce();
    }
  });

  it.each(["summary", "associations"] as const)("does not let retained unlinked data renew failed %s recovery while hidden", async endpoint => {
    vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({ status: "unlinked", responses: null }));
    const onReloadInventory = vi.fn(), view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    await screen.findByRole("heading", { name: "Usage not reported" });
    await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
    const failure = new ApiError(409, "selection_invalidated", "Unlinked evidence expired");
    if (endpoint === "summary") vi.mocked(api.readAgentReportSummary).mockRejectedValue(failure);
    else vi.mocked(api.readAgentReportAssociations).mockRejectedValue(failure);
    await act(async () => view.queryClient.refetchQueries({
      queryKey: ["saved", endpoint === "summary" ? "exact-inventory-report" : "exact-inventory-associations"],
    }));
    await waitFor(() => expect(onReloadInventory).toHaveBeenCalledOnce());
    for (let visit = 0; visit < 2; visit++) {
      view.rerender(view.content({ view: "usage" }));
      await screen.findByRole("region", { name: "Reported usage trend" });
      view.rerender(view.content({ view: "users" }));
      await screen.findByRole("alert");
      expect(onReloadInventory).toHaveBeenCalledOnce();
    }
  });

  it("normalizes report and selection UUIDs without restarting equivalent evidence", async () => {
    const selected = "abcdefab-abcd-4abc-8abc-abcdefabcdef", setId = "fedcbafe-fedc-4fed-8fed-fedcbafedcba";
    const normalized = { ...context, selectionId: selected, reportSetId: setId, reports: { ...reports, setId } };
    vi.mocked(api.readAgentReportHistory).mockResolvedValue(agentUsageHistoryFixture(normalized, record.id));
    vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({ context: normalized }));
    vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({ context: normalized }));
    vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => {
      const page = users(query?.cursor, query?.search);
      return { ...page, context: normalized, reports: normalized.reports, selection: { ...page.selection, id: selected } };
    });
    const onReloadInventory = vi.fn(), view = renderPanel({ inventorySelectionId: selected.toUpperCase(), onReloadInventory,
      context: { ...inventoryContext, reports: { ...normalized.reports, setId: setId.toUpperCase() } } });
    await waitFor(() => expect(screen.queryByText("Checking saved report history...")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await screen.findByText("person0@example.invalid");
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "person" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    view.rerender(view.content({ inventorySelectionId: selected, context: { ...inventoryContext, reports: normalized.reports } }));
    expect(screen.getByRole("searchbox")).toBe(search);
    expect(search).toHaveValue("person");
    expect(api.readAgentReportHistory).toHaveBeenCalledExactlyOnceWith(record.id,
      { selectionId: selected, inventorySelectionId: selected, cursor: undefined, limit: 50 }, expect.any(AbortSignal));
    expect(api.readAgentReportSummary).toHaveBeenCalledOnce();
    expect(api.readAgentReportAssociations).toHaveBeenCalledOnce();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(onReloadInventory).not.toHaveBeenCalled();
  });

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
    expect(await screen.findByRole("heading", { name: "Usage not reported" })).toBeVisible();
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
    expect(screen.getByLabelText("CSV report dates")).toHaveTextContent(usageDate(reports.reportingPeriod!.startDate));
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
  it("preserves users search, pagination and focus while loading another report-links page", async () => {
    renderPanel({ inventorySelectionId: selectionId });
    await removal();
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "person" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: "Next users" }));
    await screen.findByText("person25@example.invalid");
    const table = screen.getByRole("table"), region = screen.getByRole("region", { name: "Agent users" });
    region.scrollTop = 128;
    const pending = deferred<CandidateAgentUsageAssociations>();
    vi.mocked(api.readAgentReportAssociations).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Next report links" }));
    expect(screen.getByRole("searchbox")).toBe(search);
    search.focus();
    await act(async () => pending.resolve(links({ value: [association],
      page: { limit: 50, nextCursor: null, previousCursor: "links-previous" } })));
    expect(screen.getByRole("table")).toBe(table);
    expect(search).toHaveFocus();
    expect(search).toHaveValue("person");
    expect(region.scrollTop).toBe(128);
    expect(screen.getByText("person25@example.invalid")).toBeVisible();
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
  });
  it("retries a retired users cursor at the first page of the same selection", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => {
      if (query?.cursor) throw new ApiError(400, "invalid_cursor", "Saved user cursor changed");
      return users(undefined, query?.search);
    });
    const onReloadInventory = vi.fn();
    renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    await screen.findByText("person0@example.invalid");
    fireEvent.click(screen.getByRole("button", { name: "Next users" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved user cursor changed");
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(3));
    expect(api.readReportPage).toHaveBeenLastCalledWith(expect.stringContaining("/usage-users"),
      { selectionId, inventorySelectionId: selectionId, search: undefined, limit: 25 }, expect.any(AbortSignal));
    await screen.findByText("person0@example.invalid");
    expect(onReloadInventory).not.toHaveBeenCalled();
  });
  it("retries a retired association cursor without recapturing inventory or other usage reads", async () => {
    vi.mocked(api.readAgentReportAssociations).mockImplementation(async (_id, query) => {
      if (query.cursor) throw new ApiError(400, "invalid_cursor", "Saved links cursor changed");
      return links();
    });
    const onReloadInventory = vi.fn();
    renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    await removal();
    fireEvent.click(screen.getByRole("button", { name: "Next report links" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved links cursor changed");
    fireEvent.click(screen.getByRole("button", { name: "Retry report links" }));
    await waitFor(() => expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(3));
    expect(api.readAgentReportAssociations).toHaveBeenLastCalledWith(record.id,
      { selectionId, inventorySelectionId: selectionId, cursor: undefined, limit: 50 }, expect.any(AbortSignal));
    await screen.findByText("person0@example.invalid");
    expect(api.readAgentReportHistory).toHaveBeenCalledOnce();
    expect(api.readAgentReportSummary).toHaveBeenCalledOnce();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(onReloadInventory).not.toHaveBeenCalled();
  });
  it("retires confirmed removal when management permission changes without changing account roles", async () => {
    const view = renderPanel();
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    view.rerender(view.content({ canRemoveReviewedAssociations: false }));
    expect(screen.queryByRole("button", { name: "Confirm removal" })).not.toBeInTheDocument();
    view.rerender(view.content());
    expect(screen.queryByRole("button", { name: "Confirm removal" })).not.toBeInTheDocument();
    expect(api.mutateAgentReportAssociation).not.toHaveBeenCalled();
  });
  it("reconciles a submitted removal when management permission is withdrawn", async () => {
    const pending = deferred<typeof context>();
    vi.mocked(api.mutateAgentReportAssociation).mockReturnValueOnce(pending.promise);
    const view = renderPanel();
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.mutateAgentReportAssociation).mock.lastCall?.[3];
    view.rerender(view.content({ canRemoveReviewedAssociations: false }));
    expect(signal?.aborted).toBe(false);
    await act(async () => pending.resolve(context));
    expect(view.props.onChanged).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it.each(["view", "remount", "session"] as const)("does not send an admitted removal retired before submission by %s", async boundary => {
    const view = renderPanel();
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    if (boundary === "session") view.queryClient.clear();
    view.rerender(view.content(boundary === "view" ? { view: "usage" } : {}, view.principal,
      boundary === "view" ? "panel" : "replacement"));
    await act(async () => {});
    expect(api.mutateAgentReportAssociation).not.toHaveBeenCalled();
    expect(view.props.onChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it.each(["view", "revision", "context", "disabled", "remount"] as const)(
    "reconciles committed removal across a %s boundary without replaying it", async boundary => {
      const pending = deferred<typeof context>(), onReloadInventory = vi.fn();
      vi.mocked(api.mutateAgentReportAssociation).mockReturnValueOnce(pending.promise);
      const view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
      fireEvent.click(await removal());
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
      await waitFor(() => expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce());
      const signal = vi.mocked(api.mutateAgentReportAssociation).mock.lastCall?.[3];
      const overrides = boundary === "view" ? { view: "usage" as const } : boundary === "revision" ? { dataRevision: 1 }
        : boundary === "context" ? { context: { ...inventoryContext, revision: "replacement" } }
          : boundary === "disabled" ? { disabled: true } : {};
      const panelKey = boundary === "remount" ? "replacement" : "panel";
      view.rerender(view.content(overrides, view.principal, panelKey));
      expect(signal?.aborted).toBe(false);
      view.rerender(view.content({}, view.principal, panelKey));
      expect(await removal()).toBeDisabled();
      const historyReads = vi.mocked(api.readAgentReportHistory).mock.calls.length;
      const summaryReads = vi.mocked(api.readAgentReportSummary).mock.calls.length;
      const linkReads = vi.mocked(api.readAgentReportAssociations).mock.calls.length;
      const userReads = vi.mocked(api.readReportPage).mock.calls.length;
      vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({ value: [automatic] }));
      await act(async () => pending.resolve(context));
      await waitFor(() => expect(view.props.onChanged).toHaveBeenCalledOnce());
      await screen.findByText("person0@example.invalid");
      expect(screen.queryByText("Reviewed report identity")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Removing association..." })).not.toBeInTheDocument();
      expect(api.readAgentReportHistory).toHaveBeenCalledTimes(historyReads + 1);
      expect(api.readAgentReportSummary).toHaveBeenCalledTimes(summaryReads + 1);
      expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(linkReads + 1);
      expect(api.readReportPage).toHaveBeenCalledTimes(userReads + 1);
      expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce();
      expect(view.queryClient.getMutationCache().getAll()).toHaveLength(0);
      expect(onReloadInventory).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  it("refreshes committed usage while hidden without fetching users until the tab reopens", async () => {
    const pending = deferred<typeof context>();
    vi.mocked(api.mutateAgentReportAssociation).mockReturnValueOnce(pending.promise);
    const view = renderPanel({ inventorySelectionId: selectionId });
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce());
    view.rerender(view.content({ view: "usage" }));
    expect(screen.getByText("Removing association...")).toHaveAttribute("role", "status");
    vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({ value: [automatic] }));
    await act(async () => pending.resolve(context));
    await waitFor(() => expect(api.readAgentReportHistory).toHaveBeenCalledTimes(2));
    expect(api.readAgentReportSummary).toHaveBeenCalledOnce();
    expect(api.readAgentReportAssociations).toHaveBeenCalledOnce();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(view.props.onChanged).toHaveBeenCalledOnce();
    expect(screen.queryByText("Removing association...")).not.toBeInTheDocument();
    view.rerender(view.content());
    await screen.findByText("person0@example.invalid");
    expect(screen.queryByText("Reviewed report identity")).not.toBeInTheDocument();
    expect(api.readAgentReportHistory).toHaveBeenCalledTimes(2);
    expect(api.readAgentReportSummary).toHaveBeenCalledTimes(2);
    expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(2);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });
  it("invalidates the session after a removal commits with no usage panel mounted", async () => {
    const pending = deferred<typeof context>(), onReloadInventory = vi.fn();
    vi.mocked(api.mutateAgentReportAssociation).mockReturnValueOnce(pending.promise);
    const view = renderPanel({ inventorySelectionId: selectionId, onChanged: undefined, onReloadInventory });
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => pending.resolve(context));
    expect(onReloadInventory).toHaveBeenCalledOnce();
    expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce();
    expect(api.readAgentReportAssociations).toHaveBeenCalledOnce();
  });
  it("uses current owner callbacks and cancels reads begun before removal committed", async () => {
    const pending = deferred<typeof context>(), staleLinks = deferred<CandidateAgentUsageAssociations>();
    const currentOnChanged = vi.fn();
    vi.mocked(api.mutateAgentReportAssociation).mockReturnValueOnce(pending.promise);
    const view = renderPanel({ inventorySelectionId: selectionId });
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce());
    vi.mocked(api.readAgentReportAssociations).mockReturnValueOnce(staleLinks.promise);
    view.rerender(view.content({ onChanged: currentOnChanged }, view.principal, "replacement"));
    await waitFor(() => expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(2));
    const staleSignal = vi.mocked(api.readAgentReportAssociations).mock.lastCall?.[2];
    vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({ value: [automatic] }));
    await act(async () => pending.resolve(context));
    await screen.findByText("person0@example.invalid");
    expect(staleSignal?.aborted).toBe(true);
    await act(async () => staleLinks.resolve(links()));
    expect(screen.queryByText("Reviewed report identity")).not.toBeInTheDocument();
    expect(currentOnChanged).toHaveBeenCalledOnce();
    expect(view.props.onChanged).not.toHaveBeenCalled();
    expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce();
  });
  it("admits a confirmed removal only once within the same event batch", async () => {
    const pending = deferred<typeof context>();
    vi.mocked(api.mutateAgentReportAssociation).mockReturnValueOnce(pending.promise);
    const view = renderPanel();
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    const confirm = screen.getByRole("button", { name: "Confirm removal" });
    act(() => { confirm.click(); confirm.click(); });
    await waitFor(() => expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce());
    await act(async () => pending.resolve(context));
    await waitFor(() => expect(view.props.onChanged).toHaveBeenCalledOnce());
  });
  it("does not dismiss an admitted removal before its busy state renders", async () => {
    const pending = deferred<typeof context>(), view = renderPanel();
    vi.mocked(api.mutateAgentReportAssociation).mockReturnValueOnce(pending.promise);
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    const confirm = screen.getByRole("button", { name: "Confirm removal" });
    const cancel = screen.getByRole("button", { name: "Cancel association change" });
    act(() => { confirm.click(); cancel.click(); });
    await waitFor(() => expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce());
    expect(screen.getByRole("region", { name: "Confirm reviewed association removal" })).toBeVisible();
    await act(async () => pending.resolve(context));
    expect(view.props.onChanged).toHaveBeenCalledOnce();
  });
  it("retires failed removal errors with their cancelled confirmation", async () => {
    vi.mocked(api.mutateAgentReportAssociation).mockRejectedValueOnce(new ApiError(400, "invalid_agent_usage", "Removal failed"));
    renderPanel();
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Removal failed");
    fireEvent.click(screen.getByRole("button", { name: "Cancel association change" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(await removal());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm removal" })).toBeDisabled();
  });
  it.each([
    new ApiError(0, "network_error", "Response was lost.", { kind: "network" }),
    new ApiError(200, "invalid_response", "Response was malformed."),
    new ApiError(503, "service_unavailable", "Response was unavailable."),
  ])("reconciles a possibly committed removal after $code without replaying it", async cause => {
    const pending = deferred<typeof context>(), view = renderPanel({ inventorySelectionId: selectionId });
    vi.mocked(api.mutateAgentReportAssociation).mockReturnValueOnce(pending.promise);
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce());
    view.rerender(view.content({}, view.principal, "replacement"));
    await removal();
    const reads = vi.mocked(api.readAgentReportAssociations).mock.calls.length;
    vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({ value: [automatic] }));
    await act(async () => pending.reject(cause));
    expect(await screen.findByRole("alert")).toHaveTextContent("The removal result could not be verified");
    await screen.findByText("person0@example.invalid");
    expect(screen.queryByText("Reviewed report identity")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm removal" })).not.toBeInTheDocument();
    expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce();
    expect(api.readAgentReportAssociations).toHaveBeenCalledTimes(reads + 1);
    expect(view.props.onChanged).toHaveBeenCalledOnce();
  });
  it.each(["view", "revision", "remount"] as const)("retires late removal errors, but not submission ownership, across a %s boundary", async boundary => {
    const pending = deferred<typeof context>();
    vi.mocked(api.mutateAgentReportAssociation).mockReturnValueOnce(pending.promise);
    const view = renderPanel();
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce());
    view.rerender(view.content(boundary === "view" ? { view: "usage" } : { dataRevision: 1 }, view.principal,
      boundary === "remount" ? "replacement" : "panel"));
    view.rerender(view.content({}, view.principal, boundary === "remount" ? "replacement" : "panel"));
    expect(await removal()).toBeDisabled();
    await act(async () => pending.reject(new ApiError(400, "invalid_agent_usage", "Obsolete removal failure")));
    await waitFor(() => expect(screen.getByRole("button", { name: /Remove association for/ })).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(view.props.onChanged).not.toHaveBeenCalled();
    expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce();
  });
  it.each([
    ["account", "success"], ["account", "failure"], ["session", "success"], ["session", "failure"],
  ] as const)("fences submitted removal completion across a replacement %s (%s)", async (boundary, outcome) => {
    const stale = deferred<typeof context>(), current = deferred<typeof context>();
    vi.mocked(api.mutateAgentReportAssociation).mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const view = renderPanel();
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce());
    const replacement = boundary === "account" ? { ...view.principal, homeAccountId: "different" } : view.principal;
    if (boundary === "session") view.queryClient.clear();
    view.rerender(view.content({}, replacement, boundary === "session" ? "replacement" : "panel"));
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(api.mutateAgentReportAssociation).toHaveBeenCalledTimes(2));
    const reads = vi.mocked(api.readAgentReportSummary).mock.calls.length;
    await act(async () => { if (outcome === "success") stale.resolve(context); else stale.reject(new Error("Obsolete failure")); });
    expect(screen.getByRole("button", { name: "Removing association..." })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(view.props.onChanged).not.toHaveBeenCalled();
    expect(api.readAgentReportSummary).toHaveBeenCalledTimes(reads);
    await act(async () => current.resolve(context));
    await waitFor(() => expect(view.props.onChanged).toHaveBeenCalledOnce());
  });
  it("does not publish an old removal into an account A-B-A replacement", async () => {
    const pending = deferred<typeof context>(), view = renderPanel();
    vi.mocked(api.mutateAgentReportAssociation).mockReturnValueOnce(pending.promise);
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce());
    view.rerender(view.content({}, { ...view.principal, homeAccountId: "different" }));
    view.rerender(view.content());
    await screen.findByText("person0@example.invalid");
    const reads = vi.mocked(api.readAgentReportSummary).mock.calls.length;
    await act(async () => pending.resolve(context));
    expect(api.readAgentReportSummary).toHaveBeenCalledTimes(reads);
    expect(view.props.onChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
  it("keeps an admitted removal owned when history observes its new revision before the response arrives", async () => {
    const onReloadInventory = vi.fn(), view = renderPanel({ inventorySelectionId: selectionId, onReloadInventory });
    const pending = deferred<typeof context>();
    vi.mocked(api.mutateAgentReportAssociation).mockReturnValueOnce(pending.promise);
    fireEvent.click(await removal());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(api.mutateAgentReportAssociation).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.mutateAgentReportAssociation).mock.lastCall?.[3];
    const updatedContext = { ...context, usageRevision: "d".repeat(64) };
    vi.mocked(api.readAgentReportHistory).mockResolvedValue(agentUsageHistoryFixture(updatedContext, record.id));
    vi.mocked(api.readAgentReportSummary).mockResolvedValue(summary({ context: updatedContext }));
    vi.mocked(api.readAgentReportAssociations).mockResolvedValue(links({ context: updatedContext }));
    const updatedUsers: CandidateAgentUsageUsers = { ...users(), context: updatedContext };
    vi.mocked(api.readReportPage).mockResolvedValue(updatedUsers);
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(api.readAgentReportSummary).toHaveBeenCalledTimes(2));
    expect(signal?.aborted).toBe(false);
    await act(async () => pending.resolve(updatedContext));
    await waitFor(() => expect(view.props.onChanged).toHaveBeenCalledOnce());
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
    view.rerender(view.content({ view: "usage" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.rerender(view.content({ view: "users" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Exact source changed");
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
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
    expect(region).toHaveAttribute("aria-busy", "true");
    const newest = users("users-next", "person"); newest.value[0].responses = 909;
    await act(async () => latest.resolve(newest));
    expect(await screen.findByRole("cell", { name: "909" })).toBeVisible();
    await waitFor(() => expect(region).toHaveAttribute("aria-busy", "false"));
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
  it("reuses equivalent normalized user searches without resetting the current page", async () => {
    renderPanel();
    await screen.findByText("person0@example.invalid");
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "person" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: "Next users" }));
    await screen.findByText("person25@example.invalid");
    fireEvent.change(search, { target: { value: " Person " } });
    expect(screen.getByText("person25@example.invalid")).toBeVisible();
    expect(search).toHaveValue(" Person ");
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
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
