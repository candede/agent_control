import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getAgentResponsibility } from "../api/client";
import * as api from "../api/reportData";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import type { CombinedUser, ReportPage, ReportQuery } from "../../../backend/src/types/officialReportData";
import type { UserSourcePlan } from "../../../backend/src/types/userSources";
import { combinedUser, reportPage, reports, selectionId } from "../test/reportDataFixture";
import { mockNativeDialogs } from "../test/dialog";
import { CopilotUsersView } from "./CopilotUsersView";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { responsibilityFixture, responsibilityOwnerId } from "../test/agentResponsibilityFixture";

vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(), getAgentResponsibility: vi.fn(),
}));
vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(),
  readReportPage: vi.fn(), readReportDetail: vi.fn(), readReportFacet: vi.fn(),
  createReportExport: vi.fn(), reportExportStatus: vi.fn(), cancelReportExport: vi.fn(),
}));
mockNativeDialogs();
const viewer: ReturnType<typeof useCapabilityContext> = {
  user: { tenantId: "tenant", homeAccountId: "principal", displayName: "Viewer", username: "viewer@example.invalid", roles: ["AgentControl.Viewer"] },
  loading: false, pending: false, error: undefined, now: Date.now(), views: [], reload: vi.fn(async () => {}), openPermissions: vi.fn(),
};
const plan: UserSourcePlan = {
  servicePlanId: "a62f8878-de10-42f3-b68f-6149a25ceb97", service: "M365_COPILOT_APPS",
  displayName: "Microsoft 365 Copilot in Productivity Apps", state: "enabled", capabilityStatus: "Enabled", assignedDateTime: "2026-01-01",
};
function named(index: number, name: string, responses: number | null = 12): CombinedUser {
  const user = combinedUser(index);
  return { ...user, directory: { ...user.directory, displayName: name }, reportedResponses: responses };
}
const ada = named(1, "Ada", 200), ben = named(2, "Ben", 4), cleo = named(3, "Cleo", 0), drew = named(4, "Drew", null);
function page(value = [ada, ben, cleo, drew], overrides: Partial<ReportPage<CombinedUser>> = {}) {
  const result = reportPage(value);
  return { ...result, counts: { total: 100000, filtered: 4 }, summary: { ...result.summary, licensedUsers: 4,
    usingAgentsUsers: 2, noAgentActivityUsers: 1, needsAttentionUsers: 2, unknownMetricsUsers: 1 }, ...overrides };
}
function detail(user = ada, data = page()) {
  vi.mocked(api.readReportDetail).mockResolvedValue({ value: user, reports: data.reports, sources: data.sources, selection: data.selection });
}
function rows() { return within(screen.getByRole("region", { name: "M365 Copilot license status" })).getAllByRole("row").slice(1); }
async function filters() {
  if (!screen.queryByRole("dialog", { name: "Filter users" })) await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  return within(screen.getByRole("dialog", { name: "Filter users" }));
}
async function open(name = "Ada") {
  const trigger = await screen.findByRole("button", { name });
  await userEvent.click(trigger);
  return { trigger, modal: within(await screen.findByRole("dialog", { name })) };
}
function assertQuery(query: Partial<ReportQuery>) {
  expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users", expect.objectContaining(query), expect.any(AbortSignal));
}
beforeEach(() => {
  vi.mocked(api.readReportPage).mockResolvedValue(page());
  vi.mocked(api.readReportFacet).mockImplementation(async (_path, _selection, field) => ({
    value: [{ value: field === "company" ? "Contoso" : "Engineering", count: 50000 }, { value: null, count: 3 }],
    counts: { total: 2000, filtered: 2000 }, page: { limit: 50, nextCursor: "facet-next", previousCursor: null }, selection: page().selection,
  }));
  vi.mocked(getAgentResponsibility).mockImplementation(async query => responsibilityFixture(query?.objectId));
  detail();
});
afterEach(() => vi.resetAllMocks());

describe("record-backed paid M365 Copilot license dashboard", () => {
  it("deep-links a responsible person absent from paid/report cohorts without loading license or report data", async () => {
    render(<CopilotUsersView route={{ view: "responsibility", personId: responsibilityOwnerId, search: "", page: 0 }} />);
    expect(await screen.findByText("Responsible only")).toBeVisible();
    expect(api.readReportPage).not.toHaveBeenCalled();
    expect(getAgentResponsibility).toHaveBeenCalledWith(expect.objectContaining({ objectId: responsibilityOwnerId }), expect.anything());
    expect(screen.queryByLabelText("M365 Copilot license summary")).not.toBeInTheDocument();
  });
  it("adds exact responsibility alongside paid user's unchanged usage and license totals", async () => {
    const onOpenAgent = vi.fn();
    render(<CopilotUsersView onOpenAgent={onOpenAgent} />);
    const { modal } = await open();
    expect(modal.getByText("Agent responses").parentElement).toHaveTextContent("200");
    expect(getAgentResponsibility).not.toHaveBeenCalled();
    await userEvent.click(modal.getByRole("tab", { name: "Responsibility" }));
    await modal.findByText("Responsible agent");
    expect(getAgentResponsibility).toHaveBeenCalledWith(expect.objectContaining({ objectId: ada.directory.objectId }), expect.anything());
    await userEvent.click(modal.getByRole("button", { name: "Open agent Responsible agent" }));
    expect(onOpenAgent).toHaveBeenCalledWith("agent:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });
  it("isolates a new data revision from a saved read kept alive by another observer", async () => {
    let finish!: (value: ReportPage<CombinedUser>) => void;
    vi.mocked(api.readReportPage).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue(page([named(1, "Current Ada")]));
    const panels = (revision: number) => <SavedQueryProvider>
      <section aria-label="Previous reader"><CopilotUsersView /></section>
      <section aria-label="Current reader"><CopilotUsersView dataRevision={revision} /></section>
    </SavedQueryProvider>;
    const view = render(panels(0));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledOnce());
    const oldSignal = vi.mocked(api.readReportPage).mock.calls[0][2];
    view.rerender(panels(1));
    const current = within(screen.getByRole("region", { name: "Current reader" }));
    await current.findByRole("button", { name: "Current Ada" });
    expect(oldSignal?.aborted).toBe(false);
    await act(async () => finish(page()));
    await within(screen.getByRole("region", { name: "Previous reader" })).findByRole("button", { name: "Ada" });
    expect(current.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });
  it("leads with the selected licensed cohort, accessible six-field rows and collapsed provenance", async () => {
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Drew" });
    assertQuery({ cohort: "licensed", sort: "responses", order: "desc" });
    expect(rows()).toHaveLength(4);
    expect(rows()[3]).toHaveTextContent("Unknown");
    expect(screen.getByText("Data sources and coverage").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const cohort = screen.getByRole("combobox", { name: "User cohort" });
    expect(within(cohort).getAllByRole("option").map(option => option.getAttribute("value"))).toEqual(["licenses", "activity", "responsibility"]);
    expect(screen.getByRole("button", { name: "Active M365 Copilot licensed users" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Using agents" })).toHaveAccessibleDescription("2. Licensed users with agent responses");
    const headings = within(screen.getByRole("region", { name: "M365 Copilot license status" })).getAllByRole("columnheader");
    expect(headings).toHaveLength(6);
    for (const [index, label] of ["User", "Agent responses", "Agents used", "Company", "Department", "Last activity"].entries()) {
      expect(within(headings[index]).getByRole("button")).toHaveAccessibleName(label);
    }
    for (const row of rows()) {
      expect(within(row).getByRole("rowheader")).toHaveAttribute("scope", "row");
      expect(within(within(row).getByRole("rowheader")).getByRole("button")).toHaveAttribute("aria-haspopup", "dialog");
      expect(within(row).getAllByRole("cell")).toHaveLength(5);
      expect(row).not.toHaveTextContent(/Paid features:|Offer adoption help/);
    }
    expect(screen.getByRole("status", { name: "Matching users" })).toHaveTextContent("4 matching users");
    expect(api.readReportDetail).not.toHaveBeenCalled();
  });
  it("keeps expanded source coverage bounded to status, counts and source dates", async () => {
    const data = page();
    data.sources.directory.message = "Checked directory users.";
    data.sources.app_activity.state = "partial"; data.sources.app_activity.message = "App activity incomplete.";
    vi.mocked(api.readReportPage).mockResolvedValue(data);
    render(<CopilotUsersView />);
    const summary = await screen.findByText("Data sources and coverage");
    expect(summary.closest("details")).toHaveClass("copilot-users-provenance");
    await userEvent.click(summary);
    const coverage = within(summary.closest("details")!);
    expect(coverage.getByText("Checked directory users: Connected")).toBeVisible();
    expect(coverage.getByText("Office app activity: Incomplete")).toBeVisible();
    expect(coverage.getByText("App activity incomplete.")).toBeVisible();
    expect(coverage.getAllByText(/^Checked:/)).toHaveLength(2);
    expect(coverage.getByText(/Report refreshed:.*Version: v1; Period: D30/)).toBeVisible();
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });
  it.each([
    ["Using agents", "using_agents", "usingAgentsUsers", 2],
    ["Needs attention", "needs_attention", "needsAttentionUsers", 2],
    ["No reported agent activity", "no_agent_activity", "noAgentActivityUsers", 1],
    ["Active M365 Copilot licensed users", "licensed", "licensedUsers", 4],
  ] as const)("preserves server-authoritative %s counts and cohort membership", async (label, cohort, metric, count) => {
    render(<CopilotUsersView />); await screen.findByRole("button", { name: "Ada" });
    const card = screen.getByRole("button", { name: label });
    expect(card.querySelector("strong")).toHaveTextContent(String(count));
    expect(page().summary[metric]).toBe(count);
    vi.mocked(api.readReportPage).mockResolvedValue(page([ben]));
    await userEvent.click(card);
    await waitFor(() => assertQuery({ cohort }));
    expect(card).toHaveAttribute("aria-pressed", "true");
    if (cohort !== "licensed") await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(screen.getByRole("group", { name: "M365 Copilot license summary" })).getAllByRole("button", { pressed: true })).toHaveLength(1);
  });
  it.each([0, null, 42000])("does not infer licensed count %s from the displayed page", async licensedUsers => {
    const data = page(); data.summary.licensedUsers = licensedUsers;
    vi.mocked(api.readReportPage).mockResolvedValue(data);
    render(<CopilotUsersView />); await screen.findByRole("button", { name: "Ada" });
    expect(screen.getByRole("button", { name: "Active M365 Copilot licensed users" }).querySelector("strong"))
      .toHaveTextContent(licensedUsers === null ? "Unknown" : licensedUsers.toLocaleString());
    expect(rows()).toHaveLength(4);
  });
  it.each(["partial", "stale", "unavailable"] as const)("qualifies retained %s directory evidence and withholds current adoption guidance", async state => {
    const data = page(); data.sources.directory.state = state; data.summary.licensedUsers = data.summary.needsAttentionUsers = null;
    vi.mocked(api.readReportPage).mockResolvedValue(data); detail({ ...ada, attention: ["agent_usage_low", "app_activity_inactive"] }, data);
    render(<CopilotUsersView />); const { modal } = await open();
    expect(modal.getByText("Last saved: M365 Copilot licensed")).toBeVisible();
    expect(modal.getByText("Usage unknown")).toBeVisible();
    expect(modal.getByText("Verify paid license inventory")).toBeVisible();
    expect(modal.queryByText(/Offer adoption help|Review app activity/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Active M365 Copilot licensed users" }).querySelector("strong")).toHaveTextContent("Unknown");
  });
  it("keeps independent app permission recovery visible while retaining exact license assignments", async () => {
    const data = page(); data.sources.app_activity.state = "unavailable";
    vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/service-plans") ? reportPage([plan]) : data);
    detail(ada, data); render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    expect(screen.getByText("Office app activity unavailable. Review the connection in Permissions.")).toBeVisible();
    const { modal } = await open();
    await userEvent.click(modal.getByRole("tab", { name: "Licenses" }));
    expect(await modal.findByRole("list", { name: "Paid feature states" })).toHaveTextContent(plan.displayName);
  });
  it.each(["never_imported", "incomplete", "not_selected", "stale", "deleted"] as const)(
    "does not recommend report interventions or infer zero from %s report evidence", async availability => {
      const data = page(); data.reports = { ...reports, availability }; data.summary.noAgentActivityUsers = null;
      detail({ ...ada, attention: ["agent_usage_zero"], agentActivityState: "none", reportedResponses: null }, data);
      vi.mocked(api.readReportPage).mockResolvedValue(data);
      render(<CopilotUsersView />); const { modal } = await open();
      expect(modal.getByText("Usage unknown")).toBeVisible();
      expect(modal.queryByText("Offer adoption help")).not.toBeInTheDocument();
      expect(modal.getByText("Agent responses").parentElement).toHaveTextContent("Unknown");
      expect(screen.getByRole("button", { name: "No reported agent activity" }).querySelector("strong")).toHaveTextContent("Unknown");
      if (availability === "stale") expect(screen.getByRole("link", { name: "Manage reports in Sync" })).toHaveAttribute("href", "/sync?reports=manage");
    },
  );
  it.each([["enabled", "Active"], ["warning", "Active (grace period)"], ["partially_enabled", "Partially active"]] as const)(
    "shows exact %s effective paid evidence separately from account disablement", async (state, label) => {
      const user = { ...ada, copilotServiceState: state, directory: { ...ada.directory, accountEnabled: false } };
      vi.mocked(api.readReportPage).mockResolvedValue(page([user])); detail(user);
      render(<CopilotUsersView />); const { modal } = await open();
      expect(rows()[0]).toHaveTextContent("Account disabled");
      expect(modal.getByText("M365 Copilot licensed", { exact: true })).toBeVisible();
      expect(modal.getByText(label, { exact: true })).toBeVisible();
      expect(modal.getByText("Account disabled")).toBeVisible();
    },
  );
  it.each([["disabled", "Not enabled"], ["suspended", "Suspended"], ["locked_out", "Locked out"], ["unknown", "Unverified"]] as const)(
    "presents independently paged mixed %s features without overriding their state from raw Enabled", async (state, label) => {
      detail({ ...ada, copilotServiceState: "partially_enabled" });
      vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/service-plans") ? reportPage([
        plan, { ...plan, servicePlanId: "b95945de-b3bd-46db-8437-f2beb6ea2347", displayName: "Copilot in Teams", state },
      ]) : page());
      render(<CopilotUsersView />); const { modal } = await open();
      expect(modal.getByText("Review paid features")).toBeVisible();
      await userEvent.click(modal.getByRole("tab", { name: "Licenses" }));
      const services = await modal.findByRole("list", { name: "Paid feature states" });
      expect(within(services).getByText("Copilot in Teams").parentElement).toHaveTextContent(label);
      expect(within(services).getByText(plan.displayName).parentElement).toHaveTextContent("Active");
      expect(api.readReportPage).toHaveBeenLastCalledWith(`copilot-usage/users/${ada.directory.objectId}/service-plans`,
        expect.objectContaining({ selectionId, limit: 50 }), expect.any(AbortSignal));
      expect(document.body).not.toHaveTextContent(/SKU|Microsoft_365_E7|legacy-package/);
    },
  );
  it.each([
    ["responses:asc", "responses", "asc"], ["agentsUsed:asc", "agentsUsed", "asc"], ["lastActivity:desc", "lastActivity", "desc"],
    ["name:desc", "name", "desc"], ["company:asc", "company", "asc"], ["department:desc", "department", "desc"], ["service:asc", "service", "asc"],
  ] as const)("delegates complete-cohort %s ordering to the server and preserves returned null-last order", async (sort, column, order) => {
    render(<CopilotUsersView />); await screen.findByRole("button", { name: "Ada" });
    vi.mocked(api.readReportPage).mockResolvedValue(page([cleo, ben, ada, drew]));
    await userEvent.selectOptions((await filters()).getByLabelText("Sort"), sort);
    await userEvent.click(screen.getByRole("button", { name: "Close filters" }));
    await waitFor(() => assertQuery({ sort: column, order }));
    await waitFor(() => expect(rows().map(row => within(row).getByRole("button").textContent)).toEqual(["Cleo", "Ben", "Ada", "Drew"]));
    expect(rows().at(-1)).toHaveTextContent("Unknown");
  });
  it("pages a 100000-user cohort by byte-short cursors and resets only the cursor when sorting", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(page([ada], { counts: { total: 100000, filtered: 100000 },
      page: { limit: 50, nextCursor: "next", previousCursor: null } }));
    render(<CopilotUsersView />); await screen.findByRole("button", { name: "Ada" });
    await userEvent.click(screen.getByRole("button", { name: "Next users" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users",
      expect.objectContaining({ cursor: "next", selectionId }), expect.any(AbortSignal)));
    await userEvent.click(screen.getByRole("button", { name: "Agent responses" }));
    await waitFor(() => assertQuery({ sort: "responses", order: "asc" }));
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)![1]).not.toHaveProperty("cursor");
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)![1]).not.toHaveProperty("selectionId");
    expect(screen.getByRole("status", { name: "Matching users" })).toHaveTextContent("100,000");
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(rows()).toHaveLength(1);
  });
  it("passes company/department filters exactly, obtains bounded facets, and does not enumerate options", async () => {
    render(<CopilotUsersView />); await screen.findByRole("button", { name: "Ada" });
    const popup = await filters();
    await waitFor(() => expect(popup.getByLabelText("Company")).toBeEnabled());
    expect(api.readReportFacet).toHaveBeenCalledTimes(2);
    await userEvent.selectOptions(popup.getByLabelText("Company"), "~string:Contoso");
    await waitFor(() => assertQuery({ company: "Contoso" }));
    await userEvent.selectOptions(popup.getByLabelText("Department"), "~null");
    await waitFor(() => assertQuery({ company: "Contoso", department: null }));
    await waitFor(() => expect(api.readReportFacet).toHaveBeenCalledTimes(6));
    expect(vi.mocked(api.readReportFacet).mock.calls.every(([, , , query]) => !query?.cursor)).toBe(true);
    await userEvent.selectOptions(popup.getByLabelText("Company"), "next-options");
    await waitFor(() => expect(api.readReportFacet).toHaveBeenLastCalledWith("copilot-usage/users", selectionId, "company",
      expect.objectContaining({ cursor: "facet-next", signal: expect.any(AbortSignal) })));
  });
  it.each(["Clear filters", "Reset filters"])("%s clears search, organization, activity and threshold but preserves sort", async reset => {
    render(<CopilotUsersView />); await screen.findByRole("button", { name: "Ada" });
    fireEvent.change(screen.getByLabelText("Search users or agents"), { target: { value: "Contoso" } });
    const popup = await filters();
    await userEvent.selectOptions(popup.getByLabelText("Sort"), "name:desc");
    await userEvent.selectOptions(popup.getByLabelText("Activity"), "needs_attention");
    fireEvent.change(popup.getByLabelText("Low-response threshold"), { target: { value: "20" } });
    await waitFor(() => assertQuery({ search: "Contoso", lowResponseThreshold: 20, cohort: "needs_attention", sort: "name", order: "desc" }));
    fireEvent.click(screen.getByRole("button", { name: reset }));
    await waitFor(() => assertQuery({ search: undefined, cohort: "licensed", lowResponseThreshold: 5, sort: "name", order: "desc" }));
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)![1]).not.toHaveProperty("company");
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)![1]).not.toHaveProperty("department");
  });
  it.each(["", "0", "-1", "1.5", "100000001"])("retains the last valid server threshold and blocks export for invalid %s", async invalid => {
    render(<CopilotUsersView />); await screen.findByRole("button", { name: "Ada" });
    const popup = await filters(), threshold = popup.getByLabelText("Low-response threshold");
    fireEvent.change(threshold, { target: { value: "20" } });
    await waitFor(() => assertQuery({ lowResponseThreshold: 20 }));
    const before = vi.mocked(api.readReportPage).mock.calls.length;
    fireEvent.change(threshold, { target: { value: invalid } });
    expect(threshold).toHaveAttribute("aria-invalid", "true");
    expect(api.readReportPage).toHaveBeenCalledTimes(before);
    await userEvent.click(popup.getByRole("button", { name: "Close filters" }));
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
  });
  it.each(["D28", "D30"] as const)("loads exact details with the saved %s period and separate dates, and restores keyboard focus", async period => {
    const user = { ...ada, appActivity: { reportRefreshDate: "2026-02-01", lastActivityDate: "2026-01-31",
      copilotChatLastActivityDate: null, microsoftTeamsCopilotLastActivityDate: null, wordCopilotLastActivityDate: "2026-01-30",
      excelCopilotLastActivityDate: null, powerpointCopilotLastActivityDate: null, outlookCopilotLastActivityDate: null, onenoteCopilotLastActivityDate: null, loopCopilotLastActivityDate: null } };
    const data = page();
    data.sources.app_activity = { ...data.sources.app_activity, period, reportVersion: period === "D28" ? "v2" : "v1" };
    detail(user, data);
    render(<CopilotUsersView />); const { trigger, modal } = await open();
    expect(api.readReportDetail).toHaveBeenCalledWith(`copilot-usage/users/${ada.directory.objectId}`, selectionId, expect.any(AbortSignal));
    expect(modal.getByText(/Last reported agent activity Jan 28, 2026/)).toBeVisible();
    vi.mocked(api.readReportPage).mockResolvedValue(reportPage([]));
    await userEvent.click(modal.getByRole("tab", { name: "Usage & agents" }));
    expect(modal.getByRole("region", { name: "User Office app activity" })).toHaveTextContent("Jan 30, 2026");
    expect(modal.getByRole("region", { name: "User Office app activity" })).toHaveTextContent(`${period} report refreshed`);
    await userEvent.click(modal.getByRole("button", { name: "Close user details" }));
    expect(trigger).toHaveFocus();
  });
  it.each(["agent_usage_low", "agent_usage_zero", "app_activity_inactive"] as const)("shows the verified %s coaching signal only in exact details", async attention => {
    detail({ ...ada, attention: [attention], agentActivityState: attention === "agent_usage_zero" ? "none" : "active" });
    render(<CopilotUsersView />); const { modal } = await open();
    expect(modal.getByText(attention === "app_activity_inactive" ? "Review app activity" : "Offer adoption help")).toBeVisible();
    expect(rows()[0]).not.toHaveTextContent(/Offer adoption help|Review app activity/);
  });
  it("keeps null organization fields explicitly unknown without hiding independently paged assignments", async () => {
    detail({ ...ada, directory: { ...ada.directory, companyName: null, department: null } });
    vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/service-plans") ? reportPage([plan]) : page());
    render(<CopilotUsersView />); const { modal } = await open();
    expect(modal.getAllByText("Not reported")).toHaveLength(2);
    await userEvent.click(modal.getByRole("tab", { name: "Licenses" }));
    expect(await modal.findByText(plan.displayName)).toBeVisible();
  });
  it("closes historical details immediately on A-B-A selection changes without reviving old queries", async () => {
    const route = { view: "licenses" as const, page: 0, search: "", reportSetId: reports.setId! };
    const view = render(<CopilotUsersView route={route} />); await open();
    vi.mocked(api.readReportPage).mockReturnValue(new Promise(() => {}));
    view.rerender(<CopilotUsersView route={{ ...route, reportSetId: "historical-b" }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(<CopilotUsersView route={route} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it.each(["tenant", "principal", "roles"] as const)("aborts and clears private details on a %s boundary change", async change => {
    const view = render(<CapabilityContext value={viewer}><CopilotUsersView /></CapabilityContext>); await open();
    const changed = { ...viewer, user: { ...viewer.user!, ...(change === "tenant" ? { tenantId: "other" }
      : change === "principal" ? { homeAccountId: "other" } : { roles: [] }) } };
    vi.mocked(api.readReportPage).mockReturnValue(new Promise(() => {}));
    view.rerender(<CapabilityContext value={changed}><CopilotUsersView /></CapabilityContext>);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
    if (change === "roles") expect(screen.getByRole("alert")).toHaveTextContent("Viewer access");
  });
  it("retries saved reads locally without starting a collection, and Strict Mode discards superseded responses", async () => {
    vi.mocked(api.readReportPage).mockRejectedValue(new ApiError(503, "data_read_conflict", "Retry this read"));
    render(<StrictMode><CopilotUsersView /></StrictMode>);
    await screen.findByRole("alert");
    vi.mocked(api.readReportPage).mockResolvedValue(page());
    await userEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    expect(await screen.findByRole("button", { name: "Ada" })).toBeVisible();
    expect(vi.mocked(api.readReportPage).mock.calls.every(([path]) => path === "copilot-usage/users")).toBe(true);
    expect(api.createReportExport).not.toHaveBeenCalled();
  });
  it("loads the active-without-paid cohort only after navigation and aborts pending paid reads", async () => {
    let finish!: (value: ReportPage<CombinedUser>) => void;
    vi.mocked(api.readReportPage).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue(reportPage([]));
    render(<CopilotUsersView />);
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.readReportPage).mock.calls[0][2];
    await userEvent.selectOptions(screen.getByLabelText("User cohort"), "activity");
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/users",
      expect.objectContaining({ licenseCohort: "active_without_paid" }), expect.any(AbortSignal)));
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(page()));
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("does not mistake an empty byte-short page for an empty cohort or drain hidden unresolved identities", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(page([], { page: { limit: 50, nextCursor: "later", previousCursor: null } }));
    render(<CopilotUsersView />);
    expect(await screen.findByRole("heading", { name: "No users on this page" })).toBeVisible();
    expect(screen.getByText("Continue to the next page.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Next users" })).toBeEnabled();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(vi.mocked(api.readReportPage).mock.calls.some(([path]) => path.endsWith("/unresolved-identities"))).toBe(false);
  });
});
