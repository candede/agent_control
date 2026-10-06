import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CombinedUser, ReportPage, ReportQuery, ReportRelationship, ReportUser } from "../../../backend/src/types/officialReportData";
import type { UserSourcePlan } from "../../../backend/src/types/userSources";
import { ApiError, getAgentResponsibility } from "../api/client";
import * as api from "../api/reportData";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { combinedUser, reportPage, reportSetId, reportUser, selectionId } from "../test/reportDataFixture";
import { responsibilityFixture } from "../test/agentResponsibilityFixture";
import { deferred } from "../test/deferred";
import { mockNativeDialogs } from "../test/dialog";
import type { UsersRouteState } from "../workbenchRouting";
import { ReportedUserActivity } from "./ReportedUserActivity";
import { SavedQueryProvider } from "./SavedQueryProvider";

vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(), getAgentResponsibility: vi.fn(),
}));
vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(), readReportPage: vi.fn(), readReportDetail: vi.fn(),
  readReportFacet: vi.fn(), createReportExport: vi.fn(), reportExportStatus: vi.fn(), cancelReportExport: vi.fn(),
}));
mockNativeDialogs();
const initial: UsersRouteState = { view: "activity", search: "", page: 0 };
const ada = reportUser(1, { displayName: "Ada", reportedResponses: 215, bridgeResponses: 220 });
const ben = reportUser(2, { displayName: "Ben", reportedResponses: 0, bridgeResponses: 3 });
const bridge = reportUser(3, { displayName: "Bridge only", reportedResponses: null, reportedAgentsUsed: null, missingUserReport: true });
const assignment: UserSourcePlan = { servicePlanId: "a62f8878-de10-42f3-b68f-6149a25ceb97", service: "M365_COPILOT_APPS",
  displayName: "Microsoft 365 Copilot in Productivity Apps", state: "disabled", capabilityStatus: "Enabled", assignedDateTime: null };
const relationship: ReportRelationship = { id: "relationship-1", username: ada.username, agentId: "agent-1", agentName: "Researcher",
  creatorType: "Your org", responses: 0, lastActivityDateUtc: "2026-01-31", identityStatus: "unresolved" };
const viewer: ReturnType<typeof useCapabilityContext> = { user: { tenantId: "tenant", homeAccountId: "principal", displayName: "Viewer",
  username: "viewer@example.invalid", roles: ["AgentControl.Viewer"] }, loading: false, pending: false, error: undefined,
  now: Date.now(), views: [], reload: vi.fn(async () => {}), openPermissions: vi.fn() };
function page(overrides: Partial<ReportPage<ReportUser>> = {}) { return reportPage([ada, ben, bridge], overrides); }
function directory(overrides: Partial<CombinedUser> = {}): CombinedUser {
  const value = combinedUser(1);
  return { ...value, directory: { ...value.directory, displayName: "Ada" }, entitlement: "no_paid", copilotServiceState: "disabled", ...overrides };
}
function details(user = ada, saved = directory(), evidence = page()) {
  vi.mocked(api.readReportDetail).mockImplementation(async path => ({
    value: path.endsWith("/directory") ? saved : user, selection: evidence.selection, reports: evidence.reports, sources: evidence.sources,
  }));
}
function renderActivity(route = initial) {
  const changed = vi.fn();
  function Harness() {
    const [current, setCurrent] = useState(route);
    return <ReportedUserActivity route={current} onRouteChange={next => { changed(next); setCurrent(next); }} />;
  }
  return { ...render(<Harness />), changed };
}
function assertQuery(query: Partial<ReportQuery> & { selectionId?: string; cursor?: string }) {
  expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/users", expect.objectContaining(query), expect.any(AbortSignal));
}
async function filters() {
  if (!screen.queryByRole("dialog", { name: "Filter users" })) await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  return within(screen.getByRole("dialog", { name: "Filter users" }));
}
async function open(name = "Ada") {
  const trigger = await screen.findByRole("button", { name });
  await userEvent.click(trigger);
  return { trigger, dialog: await screen.findByRole("dialog", { name }), modal: within(await screen.findByRole("dialog", { name })) };
}
beforeEach(() => {
  vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/service-plans") ? reportPage([assignment])
    : path.endsWith("/agents") ? reportPage([relationship]) : page());
  vi.mocked(api.readReportFacet).mockImplementation(async (_path, _selection, field) => ({
    value: (field === "company" ? ["Contoso", "Fabrikam", null] : ["Engineering", "Sales", null]).map(value => ({ value, count: 1000 })),
    selection: page().selection, counts: { total: 10000, filtered: 10000 }, page: { limit: 50, nextCursor: "facet-next", previousCursor: null },
  }));
  vi.mocked(getAgentResponsibility).mockImplementation(async query => responsibilityFixture(query?.objectId));
  details();
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("selected active users without paid Copilot", () => {
  it("keeps valid non-paid users and export available without a routine refresh banner", async () => {
    const saved = page();
    saved.sources.directory.attemptStatus = "running";
    vi.mocked(api.readReportPage).mockResolvedValue(saved);
    renderActivity();
    expect(await screen.findByRole("button", { name: "Ada" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeEnabled();
    expect(screen.queryByText(/Refreshing license data|Showing the last saved data|License data unavailable/)).not.toBeInTheDocument();
  });

  it("renders bounded server membership in the original six columns without eagerly reading detail", async () => {
    renderActivity();
    await screen.findByRole("button", { name: "Bridge only" });
    const table = screen.getByRole("region", { name: "Reported user activity" });
    const surface = table.closest<HTMLElement>(".agent-table-stack")!;
    expect(surface).toHaveClass("user-directory-table");
    expect(within(surface).getByRole("region", { name: "User filters" })).toHaveClass("agent-grid-toolbar");
    expect(within(surface).getByRole("navigation", { name: "users pages" })).toBeVisible();
    expect(within(table).getAllByRole("columnheader")).toHaveLength(6);
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByRole("row", { name: /Bridge only/ })).toHaveTextContent("Users report metric unknown");
    expect(within(table).getByRole("row", { name: /Ben/ })).toHaveTextContent("0");
    assertQuery({ licenseCohort: "active_without_paid", cohort: "all", sort: "responses", order: "desc", lowResponseThreshold: 5 });
    expect(screen.getByRole("status", { name: "Matching users" })).toHaveTextContent("50,000");
    expect(api.readReportDetail).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps global unverified identity coverage beside filtered results, without calling unknown identities unpaid", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(page({ value: [], counts: { total: 100000, filtered: 0 } }));
    renderActivity();
    expect(await screen.findByText(/50 active report users need a license check/)).toHaveTextContent("Run Users sync");
    expect(screen.getByText(/No matching reported users/)).toBeVisible();
    expect(screen.getByRole("status", { name: "Matching users" })).toHaveTextContent("0");
  });
  it("makes unavailable directory verification explicit and disables export until a new valid revision", async () => {
    const missing = page();
    missing.value = [];
    missing.sources.directory = { ...missing.sources.directory, state: "unavailable", generationId: null, message: "Verification failed." };
    vi.mocked(api.readReportPage).mockResolvedValueOnce(missing).mockResolvedValue(page());
    const view = render(<ReportedUserActivity route={initial} onRouteChange={vi.fn()} />);
    expect(await screen.findByText(/License data unavailable/)).toHaveTextContent("Verification failed.");
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    view.rerender(<ReportedUserActivity route={initial} onRouteChange={vi.fn()} dataRevision={1} />);
    await screen.findByRole("button", { name: "Ada" });
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeEnabled();
  });
  it("retains keyboard filter dismissal, source provenance and bounded full-cohort facets on empty matches", async () => {
    renderActivity();
    await screen.findByRole("button", { name: "Ada" });
    const trigger = screen.getByRole("button", { name: /^Filters/ });
    const controls = await filters();
    await controls.findByRole("option", { name: /Fabrikam/ });
    await userEvent.selectOptions(controls.getByLabelText("Sort"), "name:desc");
    await userEvent.selectOptions(controls.getByLabelText("Company"), "~string:Contoso");
    await userEvent.selectOptions(controls.getByLabelText("Department"), "~string:Sales");
    assertQuery({ company: "Contoso", department: "Sales", sort: "name", order: "desc" });
    expect(api.readReportFacet).toHaveBeenCalledWith("official-usage/users", selectionId, "company", expect.anything());
    const readsBeforeReset = vi.mocked(api.readReportPage).mock.calls.length;
    await userEvent.click(controls.getByRole("button", { name: "Reset filters" }));
    expect(controls.getByLabelText("Company")).toHaveValue("");
    expect(controls.getByLabelText("Department")).toHaveValue("");
    expect(controls.getByLabelText("Sort")).toHaveValue("name:desc");
    expect(api.readReportPage).toHaveBeenCalledTimes(readsBeforeReset);
    expect(screen.getByRole("button", { name: "Ada" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    fireEvent.click(screen.getByText("Report sources", { selector: "summary" }));
    expect(screen.getByRole("region", { name: "Report provenance" })).toHaveTextContent("Import time does not establish source freshness");
  });
  it.each(["responses", "agentsUsed", "lastActivity", "name"] as const)("delegates both %s orders to the server instead of sorting this page", async sort => {
    renderActivity();
    await screen.findByRole("button", { name: "Ada" });
    const controls = await filters();
    for (const order of ["asc", "desc"]) {
      await userEvent.selectOptions(controls.getByLabelText("Sort"), `${sort}:${order}`);
      if (sort !== "responses" || order !== "desc") await waitFor(() => assertQuery({ sort, order: order as ReportQuery["order"] }));
      else expect(controls.getByLabelText("Sort")).toHaveValue("responses:desc");
    }
    expect(api.readReportPage).toHaveBeenCalledTimes(sort === "responses" ? 2 : 3);
  });
  it("keeps threshold validation out of server queries and export while retaining the last valid threshold", async () => {
    renderActivity();
    await screen.findByRole("button", { name: "Ada" });
    const controls = await filters(), input = controls.getByLabelText("Low-response threshold");
    const before = vi.mocked(api.readReportPage).mock.calls.length;
    fireEvent.change(input, { target: { value: "1.5" } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(api.readReportPage).toHaveBeenCalledTimes(before);
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "8" } });
    await waitFor(() => assertQuery({ lowResponseThreshold: 8 }));
    await userEvent.selectOptions(controls.getByLabelText("Agent responses"), "low");
    await waitFor(() => assertQuery({ cohort: "low", lowResponseThreshold: 8 }));
    expect(controls.getByLabelText("Agent responses")).toHaveValue("low");
  });
  it.each([0, 1])("follows a cursor from a byte-short page of %i rows rather than relying on page length", async count => {
    vi.mocked(api.readReportPage).mockResolvedValue(page({ value: [ada].slice(0, count), page: { limit: 50, nextCursor: "next", previousCursor: null } }));
    renderActivity();
    const next = await screen.findByRole("button", { name: "Next users" });
    await waitFor(() => expect(next).toHaveAttribute("aria-disabled", "false"));
    fireEvent.click(next);
    await waitFor(() => assertQuery({ selectionId, cursor: "next" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "cross-page-agent" } });
    await waitFor(() => assertQuery({ search: "cross-page-agent" }));
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.cursor).toBeUndefined();
  });
  it.each(["Next", "Previous"])("retains keyboard focus through a pending %s page and its cursor boundary", async direction => {
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page({ page: { limit: 50, nextCursor: "next", previousCursor: "previous" } }));
    renderActivity();
    await screen.findByRole("button", { name: "Ada" });
    const button = screen.getByRole("button", { name: `${direction} users` });
    const pending = deferred<ReportPage<ReportUser>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    button.focus();
    await userEvent.keyboard("{Enter}");
    assertQuery({ selectionId, cursor: direction.toLowerCase() });
    expect(button).toHaveFocus();
    expect(screen.getByRole("button", { name: `${direction} users` })).toBe(button);
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(page({ value: [ben] })));
    await screen.findByRole("button", { name: "Ben" });
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}");
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });
  it.each(["button", "Escape in a nonempty search"])("reads an exact detail, bounded licenses and relationships, then restores its trigger through %s", async close => {
    renderActivity();
    const { trigger, modal } = await open();
    expect(api.readReportDetail).toHaveBeenCalledWith(`official-usage/users/${encodeURIComponent(ada.username)}`, selectionId, expect.any(AbortSignal));
    await waitFor(() => expect(api.readReportDetail).toHaveBeenCalledTimes(2));
    expect(api.readReportPage).toHaveBeenCalledOnce();
    await userEvent.click(modal.getByRole("tab", { name: "Licenses" }));
    expect(await modal.findByText(assignment.displayName)).toBeVisible();
    expect(api.readReportPage).toHaveBeenLastCalledWith(expect.stringMatching(/\/service-plans$/), expect.objectContaining({ selectionId, limit: 50 }), expect.any(AbortSignal));
    await userEvent.click(modal.getByRole("tab", { name: "Usage & agents" }));
    expect(await modal.findByText("Researcher")).toBeVisible();
    expect(api.readReportPage).toHaveBeenLastCalledWith(expect.stringMatching(/\/agents$/), expect.objectContaining({ selectionId, limit: 50 }), expect.any(AbortSignal));
    expect(modal.getByRole("row", { name: /Researcher/ })).toHaveTextContent("0");
    if (close === "button") await userEvent.click(modal.getByRole("button", { name: "Close reported user details" }));
    else {
      await userEvent.type(modal.getByRole("searchbox", { name: "Search this user's agents" }), "Researcher");
      await userEvent.keyboard("{Escape}");
    }
    expect(trigger).toHaveFocus();
  });
  it("keeps unavailable relationship paging in the detail dialog's keyboard focus cycle", async () => {
    renderActivity();
    const { modal } = await open();
    await userEvent.click(modal.getByRole("tab", { name: "Usage & agents" }));
    await modal.findByText("Researcher");
    const next = modal.getByRole("button", { name: "Next agents" });
    expect(next).toHaveAttribute("aria-disabled", "true");
    next.focus();
    await userEvent.keyboard("{Tab}");
    expect(modal.getByRole("button", { name: "Close reported user details" })).toHaveFocus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(next).toHaveFocus();
  });
  it.each(["disabled", "suspended", "locked_out"] as const)("preserves %s feature state independently of account enablement and active licensing", async state => {
    const saved = directory({ copilotServiceState: state });
    saved.directory.accountEnabled = false;
    details(ada, saved);
    renderActivity();
    const { modal } = await open();
    expect(await modal.findByText("Account disabled")).toBeVisible();
    expect(modal.getByText("M365 Copilot license").parentElement).toHaveTextContent("No active M365 Copilot license");
    expect(modal.getByText("Agent responses").parentElement).toHaveTextContent("215");
    expect(modal.queryByText("M365 Copilot licensed", { exact: true })).not.toBeInTheDocument();
  });
  it("does not substitute bridge totals for missing Users metrics or infer paid services from positive activity", async () => {
    const saved = directory({ reportedResponses: null, reportedAgentsUsed: null, bridgeResponses: 220, servicePlanCount: 0 });
    details({ ...ada, reportedResponses: null, reportedAgentsUsed: null, bridgeResponses: 220, missingUserReport: true }, saved);
    vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/service-plans")
      ? reportPage([], { counts: { total: 0, filtered: 0 } }) : page());
    renderActivity();
    const { modal } = await open();
    expect(modal.getByText("Agent responses").parentElement).toHaveTextContent("Unknown");
    expect(modal.getByText("Agents used").parentElement).toHaveTextContent("Unknown");
    await userEvent.click(modal.getByRole("tab", { name: "Usage & agents" }));
    expect(modal.getByText(/Responses across reported agents:/)).toHaveTextContent("220");
    await userEvent.click(modal.getByRole("tab", { name: "Licenses" }));
    expect(await modal.findByText("No paid Copilot services are assigned.")).toBeVisible();
  });
  it("uses the exact selected report identity for lazy responsibility and withholds it when no exact directory identity exists", async () => {
    details({ ...ada, objectId: null });
    renderActivity();
    const { modal } = await open();
    expect(api.readReportDetail).toHaveBeenCalledOnce();
    await userEvent.click(modal.getByRole("tab", { name: "Responsibility" }));
    expect(modal.getByText(/Link this user to a directory identity/)).toBeVisible();
    expect(getAgentResponsibility).not.toHaveBeenCalled();
    await userEvent.click(modal.getByRole("button", { name: "Close reported user details" }));
    details();
    const opened = await open();
    await userEvent.click(opened.modal.getByRole("tab", { name: "Responsibility" }));
    await opened.modal.findByText("Responsible agent");
    expect(getAgentResponsibility).toHaveBeenCalledWith(expect.objectContaining({ objectId: ada.objectId }), expect.anything());
  });
  it.each(["stale", "partial", "unavailable"] as const)("does not authorize exact responsibility from %s directory evidence", async state => {
    const data = page(); data.sources.directory.state = state;
    details(ada, directory(), data);
    renderActivity();
    const { modal } = await open();
    await userEvent.click(modal.getByRole("tab", { name: "Responsibility" }));
    expect(modal.getByText(/Link this user to a directory identity/)).toBeVisible();
    expect(getAgentResponsibility).not.toHaveBeenCalled();
  });
  it("preserves exact focused-agent filters in independently paged detail and can switch to all relationships", async () => {
    renderActivity({ ...initial, agentId: "agent-1", reportSetId });
    const { modal } = await open();
    await userEvent.click(modal.getByRole("tab", { name: "Usage & agents" }));
    await modal.findByText("Researcher");
    expect(api.readReportPage).toHaveBeenLastCalledWith(expect.stringMatching(/\/agents$/), expect.objectContaining({ agentId: "agent-1", selectionId }), expect.any(AbortSignal));
    await userEvent.click(modal.getByRole("button", { name: "Show all this user's agents" }));
    await waitFor(() => expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.agentId).toBeUndefined());
  });
  it("clears prior user filters when focusing an agent from details while preserving sorting and the exact report", async () => {
    const { changed } = renderActivity({ ...initial, search: "Ada", agentId: "previous-agent", page: 3 });
    await screen.findByRole("button", { name: "Ada" });
    const controls = await filters();
    await controls.findByRole("option", { name: "Contoso" });
    await userEvent.selectOptions(controls.getByLabelText("Company"), "~string:Contoso");
    await userEvent.selectOptions(controls.getByLabelText("Department"), "~string:Engineering");
    await userEvent.selectOptions(controls.getByLabelText("Agent responses"), "low");
    fireEvent.change(controls.getByLabelText("Low-response threshold"), { target: { value: "250" } });
    await userEvent.selectOptions(controls.getByLabelText("Sort"), "name:asc");
    await userEvent.keyboard("{Escape}");
    const { modal } = await open();
    await userEvent.click(modal.getByRole("tab", { name: "Usage & agents" }));
    await userEvent.click(await modal.findByRole("button", { name: "Show all this user's agents" }));
    await userEvent.click(await modal.findByRole("button", { name: "Researcher: active users without paid Copilot" }));
    await screen.findByRole("button", { name: "Ada" });
    expect(changed).toHaveBeenLastCalledWith({ ...initial, agentId: "agent-1", reportSetId });
    assertQuery({ agentId: "agent-1", setId: reportSetId, licenseCohort: "active_without_paid",
      cohort: "all", lowResponseThreshold: 5, sort: "name", order: "asc" });
    const query = vi.mocked(api.readReportPage).mock.calls.at(-1)![1]!;
    for (const field of ["company", "department", "search", "cursor", "selectionId"] as const) expect(query[field]).toBeUndefined();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveValue("");
    const reset = await filters();
    expect(reset.getByLabelText("Agent responses")).toHaveValue("all");
    expect(reset.getByLabelText("Low-response threshold")).toHaveValue(5);
  });
  it("restarts from the first page when details focus the same agent and report without changing filters", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/agents") ? reportPage([relationship])
      : page({ page: { limit: 50, nextCursor: "next", previousCursor: null } }));
    renderActivity({ ...initial, agentId: "agent-1", reportSetId });
    await screen.findByRole("button", { name: "Ada" });
    fireEvent.click(screen.getByRole("button", { name: "Next users" }));
    await screen.findByRole("button", { name: "Ada" });
    assertQuery({ cursor: "next", selectionId });
    const { modal } = await open();
    await userEvent.click(modal.getByRole("tab", { name: "Usage & agents" }));
    await userEvent.click(await modal.findByRole("button", { name: "Researcher: active users without paid Copilot" }));
    await waitFor(() => expect(vi.mocked(api.readReportPage).mock.calls.filter(([path]) => path === "official-usage/users")).toHaveLength(3));
    assertQuery({ agentId: "agent-1", setId: reportSetId });
    const query = vi.mocked(api.readReportPage).mock.calls.at(-1)![1]!;
    expect(query.cursor).toBeUndefined();
    expect(query.selectionId).toBeUndefined();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("pins a durable export to the displayed selection, never serializes page rows, and aborts its obsolete request", async () => {
    const pending = deferred<{ id: string }>(); vi.mocked(api.createReportExport).mockReturnValue(pending.promise);
    renderActivity();
    await screen.findByRole("button", { name: "Ada" });
    fireEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    expect(api.createReportExport).toHaveBeenCalledWith({ kind: "official_users", selectionId, ids: undefined }, expect.any(AbortSignal));
    const signal = vi.mocked(api.createReportExport).mock.calls[0][1];
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ben" } });
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ id: "obsolete" }));
    expect(api.reportExportStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
  });
  it.each(["admission", "building", "download"] as const)("withdraws an export-invalidated selection during %s and offers a real parent restart", async phase => {
    const invalidated = new ApiError(409, "selection_invalidated", "Expired selection");
    const ready = { id: "export", status: "ready" as const, rows: 3, bytes: 200,
      expiresAt: new Date(Date.now() + 60000).toISOString(), error: null, limit: null, observed: null };
    if (phase === "admission") vi.mocked(api.createReportExport).mockRejectedValue(invalidated);
    else {
      vi.mocked(api.createReportExport).mockResolvedValue({ id: ready.id });
      if (phase === "building") vi.mocked(api.reportExportStatus).mockResolvedValue({ ...ready, status: "failed", error: "selection_invalidated" });
      else vi.mocked(api.reportExportStatus).mockResolvedValueOnce(ready).mockRejectedValueOnce(invalidated);
    }
    renderActivity();
    await open();
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export users CSV" })); });
    if (phase !== "admission") await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    if (phase === "download") await act(async () => { fireEvent.click(screen.getByRole("link", { name: "Download CSV" })); });
    vi.useRealTimers();
    expect(screen.getByRole("alert")).toHaveTextContent("This selection changed or expired.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "users pages" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    if (phase === "admission") expect(api.reportExportStatus).not.toHaveBeenCalled();
    const pending = deferred<ReportPage<ReportUser>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.selectionId).toBeUndefined();
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    const replacement = page();
    replacement.selection = { ...replacement.selection, id: "replacement-selection" };
    await act(async () => pending.resolve(replacement));
    await screen.findByRole("button", { name: "Ada" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeEnabled();
    vi.mocked(api.createReportExport).mockRejectedValue(new Error("Export service unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Export service unavailable");
    expect(api.createReportExport).toHaveBeenLastCalledWith(
      { kind: "official_users", selectionId: replacement.selection.id, ids: undefined }, expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Ada" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Restart selection" })).not.toBeInTheDocument();
  });
  it("keeps the pinned dialog during revalidation but clears it immediately when access is revoked", async () => {
    const pending = deferred<ReportPage<ReportUser>>();
    const view = render(<ReportedUserActivity route={initial} onRouteChange={vi.fn()} />);
    await open();
    vi.mocked(api.readReportPage).mockReturnValue(pending.promise);
    view.rerender(<ReportedUserActivity route={initial} onRouteChange={vi.fn()} dataRevision={1} />);
    expect(screen.getByRole("dialog", { name: "Ada" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/users",
      expect.not.objectContaining({ selectionId }), expect.any(AbortSignal));
    await act(async () => pending.reject(new ApiError(403, "role_required", "Viewer revoked")));
    await screen.findByRole("alert");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
  });
  it("closes pinned details when an invalidated parent selection is automatically recaptured", async () => {
    const pending = deferred<ReportPage<ReportUser>>();
    render(<ReportedUserActivity route={initial} onRouteChange={vi.fn()} />);
    await open();
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Saved data changed"))
      .mockReturnValueOnce(pending.promise);
    fireEvent.focus(window);
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => pending.resolve(page()));
    await screen.findByRole("button", { name: "Ada" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("does not replace another observer's revision with its delayed predecessor", async () => {
    const pending = deferred<ReportPage<ReportUser>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise).mockResolvedValue(page({ value: [reportUser(1, { displayName: "Current" })] }));
    const panels = (revision: number) => <SavedQueryProvider>
      <section aria-label="Previous"><ReportedUserActivity route={initial} onRouteChange={vi.fn()} /></section>
      <section aria-label="Current"><ReportedUserActivity route={initial} onRouteChange={vi.fn()} dataRevision={revision} /></section>
    </SavedQueryProvider>;
    const view = render(panels(0));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.readReportPage).mock.calls[0][2];
    view.rerender(panels(1));
    await within(screen.getByRole("region", { name: "Current" })).findByRole("button", { name: "Current" });
    expect(signal?.aborted).toBe(false);
    await act(async () => pending.resolve(page()));
    await within(screen.getByRole("region", { name: "Previous" })).findByRole("button", { name: "Ada" });
    expect(within(screen.getByRole("region", { name: "Current" })).queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
  });
  it("retires pending detail and exports through historical A-B-A navigation even when transports ignore cancellation", async () => {
    const pending = deferred<{ id: string }>(); vi.mocked(api.createReportExport).mockReturnValue(pending.promise);
    const view = render(<ReportedUserActivity route={initial} onRouteChange={vi.fn()} />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    const signal = vi.mocked(api.createReportExport).mock.calls[0][1];
    const second = deferred<ReportPage<ReportUser>>(); vi.mocked(api.readReportPage).mockReturnValueOnce(second.promise).mockResolvedValue(page());
    view.rerender(<ReportedUserActivity route={{ ...initial, reportSetId: "another" }} onRouteChange={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(signal?.aborted).toBe(true);
    view.rerender(<ReportedUserActivity route={initial} onRouteChange={vi.fn()} />);
    await act(async () => { pending.resolve({ id: "old-export" }); second.resolve(page({ value: [reportUser(9, { displayName: "Obsolete" })] })); });
    await screen.findByRole("button", { name: "Ada" });
    expect(screen.queryByRole("button", { name: "Obsolete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.reportExportStatus).not.toHaveBeenCalled();
  });
  it("rejects an envelope for a different explicitly requested report instead of adopting it silently", async () => {
    renderActivity({ ...initial, reportSetId: "a-different-set" });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent(/selection/i);
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Restart selection" })).toBeVisible();
  });
  it("offers an explicit parent restart after exact detail selection invalidation", async () => {
    vi.mocked(api.readReportDetail).mockRejectedValue(new ApiError(409, "selection_invalidated", "Selection expired"));
    renderActivity();
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByRole("alert");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart selection" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.selectionId).toBeUndefined();
  });
  it("does not combine a returned directory identity with a different exact report identity", async () => {
    details(ada, combinedUser(99));
    renderActivity();
    const { modal } = await open();
    expect(await modal.findByText(/directory evidence does not match/i)).toBeVisible();
    expect(modal.queryByText("User 99")).not.toBeInTheDocument();
    await userEvent.click(modal.getByRole("tab", { name: "Responsibility" }));
    expect(getAgentResponsibility).not.toHaveBeenCalled();
  });
  it.each(["selection", "set", "users-version", "bridge-hash", "directory-generation", "directory-scope", "app-generation", "app-revision"] as const)(
    "withholds detailed directory and responsibility evidence for a mismatched %s boundary", async changed => {
      const evidence = page(), wrong = structuredClone(evidence);
      if (changed === "selection") wrong.selection.id = "other-selection";
      if (changed === "set") wrong.reports.setId = "other-set";
      if (changed === "users-version") wrong.reports.lineages[0].versionId = "other-version";
      if (changed === "bridge-hash") wrong.reports.lineages[2].contentHash = "b".repeat(64);
      if (changed === "directory-generation") wrong.sources.directory.generationId = "other-generation";
      if (changed === "directory-scope") wrong.sources.directory.scopeId = "other-scope";
      if (changed === "app-generation") wrong.sources.app_activity.generationId = "other-generation";
      if (changed === "app-revision") wrong.sources.app_activity.revision = "99";
      vi.mocked(api.readReportDetail).mockImplementation(async path => {
        const selected = path.endsWith("/directory") ? wrong : evidence;
        return { value: path.endsWith("/directory") ? directory() : ada, selection: selected.selection, reports: selected.reports, sources: selected.sources };
      });
      renderActivity();
      const { modal } = await open();
      expect(await modal.findByText(/directory evidence does not match/i)).toBeVisible();
      await userEvent.click(modal.getByRole("tab", { name: "Licenses" }));
      expect(modal.getByText("Detailed license assignments are unavailable for this report identity.")).toBeVisible();
      await userEvent.click(modal.getByRole("tab", { name: "Responsibility" }));
      expect(getAgentResponsibility).not.toHaveBeenCalled();
    });
  it("aborts on unmount and Strict Mode replay without allowing an earlier completed transport to reappear", async () => {
    const pending = deferred<ReportPage<ReportUser>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise).mockResolvedValue(page());
    const view = render(<StrictMode><ReportedUserActivity route={initial} onRouteChange={vi.fn()} /></StrictMode>);
    await screen.findByRole("button", { name: "Ada" });
    expect(vi.mocked(api.readReportPage).mock.calls[0][2]?.aborted).toBe(true);
    await act(async () => pending.resolve(page({ value: [reportUser(4, { displayName: "Obsolete" })] })));
    expect(screen.queryByRole("button", { name: "Obsolete" })).not.toBeInTheDocument();
    view.unmount();
  });
  it("enforces current Viewer access without issuing a page request", () => {
    render(<CapabilityContext.Provider value={{ ...viewer, user: { ...viewer.user!, roles: [] } }}>
      <ReportedUserActivity route={initial} onRouteChange={vi.fn()} /></CapabilityContext.Provider>);
    expect(screen.getByRole("alert")).toHaveTextContent("Current Viewer access");
    expect(api.readReportPage).not.toHaveBeenCalled();
  });
});
