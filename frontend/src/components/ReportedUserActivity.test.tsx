import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CombinedUser, ReportPage, ReportQuery, ReportRelationship, ReportUser } from "../../../backend/src/types/officialReportData";
import type { UserSourcePlan } from "../../../backend/src/types/userSources";
import { ApiError, getAgentResponsibility } from "../api/client";
import * as api from "../api/reportData";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { createSavedQueryClient } from "../savedQueries";
import { PublicationContext } from "../publicationContext";
import { combinedUser, reportPage, reportSelection, reportSetId, reportUser, selectionId } from "../test/reportDataFixture";
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
  it.each(["queued", "running"] as const)("describes license verification during %s Users sync without assigning a manual task", async status => {
    const saved = page({ value: [], counts: { total: 3, filtered: 0 } });
    saved.sources.directory.state = "partial";
    vi.mocked(api.readReportPage).mockResolvedValue(saved);
    render(<PublicationContext value={{ admit: vi.fn(), usersRefresh: { checking: false, status } }}>
      <ReportedUserActivity route={initial} onRouteChange={vi.fn()} />
    </PublicationContext>);
    expect(await screen.findByRole("heading", { name: "Verifying user licenses" })).toBeVisible();
    expect(screen.getByText("Users sync is in progress. Please wait a moment; this page will update automatically.")).toBeVisible();
    expect(screen.queryByText(/Run Users sync|Non-paid user activity unavailable/)).not.toBeInTheDocument();
    expect(screen.getByText("Users will appear automatically when license verification completes.")).toBeVisible();
  });

  it("reads the retained stale directory cohort with truthful age while its successor fails", async () => {
    const saved = page();
    saved.sources.directory = { ...saved.sources.directory, state: "stale", attemptStatus: "failed",
      expiresAt: "2000-01-01T00:00:00Z", message: "Successor sync failed; showing the last published directory." };
    vi.mocked(api.readReportPage).mockResolvedValue(saved);
    renderActivity();
    expect(await screen.findByRole("button", { name: "Ada" })).toBeVisible();
    expect(screen.getByText(/Saved directory data is out of date/)).toHaveTextContent("Successor sync failed");
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeEnabled();
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });
  it.each(["success", "denied"] as const)("preserves detail tab and draft during automatic saved-data renewal (%s)", async outcome => {
    const saved = page(), replacement = page({ selection: reportSelection(9) });
    const pending = deferred<ReportPage<ReportUser>>();
    vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/agents") ? reportPage([relationship]) : saved);
    renderActivity({ ...initial, reportSetId, search: "Ada" });
    const { modal, dialog } = await open();
    await userEvent.click(modal.getByRole("tab", { name: "Usage & agents" }));
    const search = await modal.findByRole("searchbox", { name: "Search this user's agents" });
    fireEvent.change(search, { target: { value: "Researcher" } });
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith(expect.stringMatching(/\/agents$/),
      expect.objectContaining({ search: "researcher" }), expect.any(AbortSignal)));
    vi.mocked(api.readReportPage).mockImplementation(async (path, request) => path === "official-usage/users"
      ? pending.promise : reportPage([relationship], { selection: request?.selectionId === saved.selection.id ? saved.selection : replacement.selection }));
    const clock = vi.spyOn(performance, "now").mockReturnValue(performance.now() + Date.parse(saved.selection.expiresAt) - Date.parse(saved.selection.validatedAt) + 1);
    fireEvent.focus(window);
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Restart selection" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(search).toHaveValue("Researcher");
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/users",
      expect.objectContaining({ search: "ada", setId: reportSetId }), expect.any(AbortSignal));
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]).not.toHaveProperty("selectionId");
    if (outcome === "denied") {
      await act(async () => pending.reject(new ApiError(403, "forbidden", "User access withdrawn")));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("User access withdrawn");
    } else {
      details(ada, directory(), replacement);
      await act(async () => pending.resolve(replacement));
      await waitFor(() => expect(api.readReportDetail).toHaveBeenCalledWith(`official-usage/users/${encodeURIComponent(ada.username)}`, replacement.selection.id, expect.any(AbortSignal)));
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(modal.getByRole("tab", { name: "Usage & agents" })).toHaveAttribute("aria-selected", "true");
      expect(await modal.findByRole("searchbox", { name: "Search this user's agents" })).toHaveValue("Researcher");
    }
    clock.mockRestore();
  });
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
    vi.mocked(api.readReportPage).mockResolvedValue(page({ counts: { total: 100000, filtered: 50000 },
      page: { limit: 50, nextCursor: "byte-short-next", previousCursor: null } }));
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
  it("does not ask for another sync for unknown identities or call those identities unpaid", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(page({ value: [], counts: { total: 100000, filtered: 0 } }));
    renderActivity();
    expect(await screen.findByText(/No matching reported users/)).toBeVisible();
    expect(screen.queryByText(/need a license check|Run Users sync/)).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Matching users" })).toHaveTextContent("0");
  });
  it("shows newly verified report users when background sync publishes, without a manual action or prompt", async () => {
    const before = page({ value: [], counts: { total: 1, filtered: 0 } });
    const after = page({ value: [ada], selection: reportSelection(9), counts: { total: 1, filtered: 1 } });
    after.selection.publicationRevisions.users = "4".repeat(64);
    const admit = vi.fn(), client = createSavedQueryClient();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(before).mockResolvedValue(after);
    const surface = (revisions = before.selection.publicationRevisions) => <SavedQueryProvider client={client}>
      <PublicationContext value={{ admit, revisions }}>
        <ReportedUserActivity route={initial} onRouteChange={vi.fn()} />
      </PublicationContext>
    </SavedQueryProvider>;
    const view = render(surface());
    try {
      expect(await screen.findByText(/No matching reported users/)).toBeVisible();
      expect(screen.queryByText(/need a license check|Run Users sync/)).not.toBeInTheDocument();
      view.rerender(surface(after.selection.publicationRevisions));
      expect(await screen.findByRole("button", { name: "Ada" })).toBeVisible();
      expect(screen.getByRole("status", { name: "Matching users" })).toHaveTextContent("1");
      expect(api.readReportPage).toHaveBeenCalledTimes(2);
      expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]).not.toHaveProperty("selectionId");
      expect(screen.queryByText(/need a license check|Run Users sync/)).not.toBeInTheDocument();
    } finally { view.unmount(); client.clear(); }
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
  it.each(["unavailable", "partial"] as const)("does not describe %s license evidence as an empty matching cohort", async state => {
    const missing = page({ value: [], counts: { total: 100000, filtered: 0 } });
    missing.sources.directory = { ...missing.sources.directory, state };
    vi.mocked(api.readReportPage).mockResolvedValue(missing);
    renderActivity();
    expect(await screen.findByRole("heading", { name: "Non-paid user activity unavailable" })).toBeVisible();
    expect(screen.getByText("Current license verification is required to identify users without paid Copilot. Run Users sync in Sync.")).toBeVisible();
    expect(screen.queryByText("Try another search or clear filters.")).not.toBeInTheDocument();
    expect(screen.queryByText("No matching reported users")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Matching users" })).toHaveTextContent("Unavailable");
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });
  it.each([
    ["never_imported", "Reports not imported"], ["incomplete", "Incomplete report bundle"],
    ["not_selected", "No report selected"], ["deleted", "Selected report deleted"],
  ] as const)("preserves the %s report reason instead of reporting a zero cohort", async (availability, heading) => {
    const missing = page({ value: [], counts: { total: 0, filtered: 0 } });
    missing.reports = { ...missing.reports, availability, setId: null, activeSetId: null, lineages: [], reportingPeriod: null, acceptedAt: null };
    vi.mocked(api.readReportPage).mockResolvedValue(missing);
    renderActivity();
    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
    expect(screen.getByRole("status", { name: "Matching users" })).toHaveTextContent("Unavailable");
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    expect(screen.queryByText("No matching reported users")).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledOnce();
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
    vi.mocked(api.readReportPage).mockResolvedValue(page({ value: [ada].slice(0, count), counts: { total: 100000, filtered: 50000 },
      page: { limit: 50, nextCursor: "next", previousCursor: null } }));
    renderActivity();
    const next = await screen.findByRole("button", { name: "Next users" });
    await waitFor(() => expect(next).toHaveAttribute("aria-disabled", "false"));
    fireEvent.click(next);
    await waitFor(() => assertQuery({ selectionId, cursor: "next" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "cross-page-agent" } });
    await waitFor(() => assertQuery({ search: "cross-page-agent" }));
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.cursor).toBeUndefined();
  });
  it.each(["Next", "Previous"].flatMap(direction => [false, true].map(fails => ({ direction, fails }))))(
    "retains keyboard focus through a pending $direction page (failure=$fails) and its cursor boundary", async ({ direction, fails }) => {
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page({ page: { limit: 50, nextCursor: "next", previousCursor: "previous" } }));
    renderActivity();
    await screen.findByRole("button", { name: "Ada" });
    const button = screen.getByRole("button", { name: `${direction} users` });
    let pending = deferred<ReportPage<ReportUser>>();
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
    if (fails) {
      await act(async () => pending.reject(new Error("Page unavailable.")));
      expect(await screen.findByRole("alert")).toHaveTextContent("Page unavailable.");
      expect(button).toHaveFocus();
      pending = deferred<ReportPage<ReportUser>>();
      vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
      fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
      expect(button).toHaveFocus();
    }
    await act(async () => pending.resolve(page({ value: [ben] })));
    await screen.findByRole("button", { name: "Ben" });
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}");
    expect(api.readReportPage).toHaveBeenCalledTimes(fails ? 3 : 2);
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
  it.each(["failure", "invalidation", "replacement"] as const)(
    "does not navigate from a current relationship when its parent has a just-delivered %s", async boundary => {
      const client = createSavedQueryClient(), saved = page(), changed = vi.fn();
      vi.mocked(api.readReportPage).mockImplementation(async path => path.endsWith("/agents") ? reportPage([relationship]) : saved);
      const view = render(<SavedQueryProvider client={client}>
        <ReportedUserActivity route={initial} onRouteChange={changed} />
      </SavedQueryProvider>);
      const { modal } = await open();
      await userEvent.click(modal.getByRole("tab", { name: "Usage & agents" }));
      const agent = await modal.findByRole("button", { name: "Researcher: active users without paid Copilot" });
      const cached = client.getQueryCache().find({
        queryKey: ["saved", "record-page"], exact: false, predicate: query => query.state.data === saved,
      })!;
      act(() => {
        if (boundary === "replacement") client.setQueryData(cached.queryKey, page({ value: [ben] }));
        else cached.setState({ status: "error", error: boundary === "failure" ? new Error("Users unavailable.")
          : new ApiError(409, "selection_invalidated", "Selection changed.") });
        fireEvent.click(agent);
      });
      expect(changed).not.toHaveBeenCalled();
      view.unmount();
      client.clear();
    });
  it("admits only one same-batch relationship navigation and replacement cohort read", async () => {
    const { changed } = renderActivity({ ...initial, agentId: "agent-1", reportSetId });
    const { modal } = await open();
    await userEvent.click(modal.getByRole("tab", { name: "Usage & agents" }));
    const agent = await modal.findByRole("button", { name: "Researcher: active users without paid Copilot" });
    act(() => { fireEvent.click(agent); fireEvent.click(agent); });
    expect(changed).toHaveBeenCalledExactlyOnceWith({ ...initial, agentId: "agent-1", reportSetId });
    await waitFor(() => expect(vi.mocked(api.readReportPage).mock.calls.filter(([path]) => path === "official-usage/users")).toHaveLength(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("pins a durable export to the displayed selection, never serializes page rows, and aborts its obsolete request", async () => {
    const pending = deferred<{ id: string }>(); vi.mocked(api.createReportExport).mockReturnValue(pending.promise);
    renderActivity();
    await screen.findByRole("button", { name: "Ada" });
    fireEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    expect(api.createReportExport).toHaveBeenCalledWith({ kind: "official_users", selectionId, ids: undefined, idempotencyKey: expect.any(String) }, expect.any(AbortSignal));
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
    for (const button of within(screen.getByRole("navigation", { name: "users pages" })).getAllByRole("button")) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(button);
    }
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
      { kind: "official_users", selectionId: replacement.selection.id, ids: undefined, idempotencyKey: expect.any(String) }, expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Ada" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Restart selection" })).not.toBeInTheDocument();
  });
  it("keeps the pinned dialog during revalidation but clears it immediately when access is revoked", async () => {
    const pending = deferred<ReportPage<ReportUser>>();
    render(<ReportedUserActivity route={initial} onRouteChange={vi.fn()} />);
    await open();
    const detailReads = vi.mocked(api.readReportDetail).mock.calls.length;
    vi.mocked(api.readReportPage).mockReturnValue(pending.promise);
    fireEvent.focus(window);
    const dialog = screen.getByRole("dialog", { name: "Ada" });
    expect(dialog).toBeVisible();
    expect(within(dialog).queryByText("Loading exact user details...")).not.toBeInTheDocument();
    expect(within(dialog).getByText("No active M365 Copilot license", { exact: true })).toBeVisible();
    expect(api.readReportDetail).toHaveBeenCalledTimes(detailReads);
    expect(screen.getByRole("button", { name: "Ada" })).toBeVisible();
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/users",
      expect.objectContaining({ selectionId }), expect.any(AbortSignal));
    await act(async () => pending.reject(new ApiError(403, "role_required", "Viewer revoked")));
    await screen.findByRole("alert");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
  });
  it("closes rejected private detail and requires explicit parent replacement", async () => {
    const pending = deferred<ReportPage<ReportUser>>();
    render(<ReportedUserActivity route={initial} onRouteChange={vi.fn()} />);
    await open();
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Saved data changed"))
      .mockReturnValueOnce(pending.promise);
    fireEvent.focus(window);
    await screen.findByRole("alert");
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
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
  it.each(["tenant", "principal", "roles", "revision"] as const)(
    "retires pending reads on a %s change, preserving exports only across data revisions", async boundary => {
      const current: typeof viewer = { ...viewer, user: { ...viewer.user!, roles: ["AgentControl.Viewer", "AgentControl.Admin"] } };
      const changed: typeof viewer = { ...current, user: { ...current.user!,
        ...(boundary === "tenant" ? { tenantId: "other" } : boundary === "principal" ? { homeAccountId: "other" }
          : boundary === "roles" ? { roles: ["AgentControl.Viewer"] } : {}),
      } };
      const panel = (replacement = false) => <SavedQueryProvider><CapabilityContext value={replacement ? changed : current}>
        <ReportedUserActivity route={initial} onRouteChange={vi.fn()} dataRevision={replacement && boundary === "revision" ? 1 : 0} />
      </CapabilityContext></SavedQueryProvider>;
      const view = render(panel());
      await screen.findByRole("button", { name: "Ada" });
      const controls = await filters();
      await userEvent.selectOptions(controls.getByLabelText("Sort"), "name:asc");
      fireEvent.change(controls.getByLabelText("Low-response threshold"), { target: { value: "8" } });
      await waitFor(() => assertQuery({ sort: "name", order: "asc", lowResponseThreshold: 8 }));
      await userEvent.keyboard("{Escape}");

      const detail = deferred<Awaited<ReturnType<typeof api.readReportDetail>>>();
      const exporting = deferred<{ id: string }>();
      const previous = deferred<ReportPage<ReportUser>>();
      const replacement = deferred<ReportPage<ReportUser>>();
      vi.mocked(api.readReportDetail).mockReturnValueOnce(detail.promise);
      vi.mocked(api.createReportExport).mockReturnValueOnce(exporting.promise);
      fireEvent.click(screen.getByRole("button", { name: "Ada" }));
      expect(screen.getByText("Loading exact user details...")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
      vi.mocked(api.readReportPage).mockReturnValueOnce(previous.promise).mockReturnValueOnce(replacement.promise);
      fireEvent.focus(window);
      const detailSignal = vi.mocked(api.readReportDetail).mock.lastCall?.[2];
      const exportSignal = vi.mocked(api.createReportExport).mock.lastCall?.[1];
      const pageSignal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
      const pageReads = vi.mocked(api.readReportPage).mock.calls.length;
      view.rerender(panel(true));
      expect(detailSignal?.aborted).toBe(true);
      expect(exportSignal?.aborted).toBe(boundary !== "revision");
      expect(pageSignal?.aborted).toBe(true);
      expect(screen.queryByRole("dialog") !== null).toBe(boundary === "revision");
      expect(screen.queryByRole("button", { name: "Ada" }) !== null).toBe(boundary === "revision");
      expect(api.readReportPage).toHaveBeenCalledTimes(pageReads + 1);
      assertQuery(boundary === "revision" ? { sort: "name", order: "asc", lowResponseThreshold: 8 }
        : { sort: "responses", order: "desc", lowResponseThreshold: 5 });

      await act(async () => {
        detail.resolve({ value: { ...ada, displayName: "Obsolete detail" }, selection: page().selection, reports: page().reports, sources: page().sources });
        exporting.resolve({ id: "obsolete-export" });
        previous.reject(new ApiError(409, "selection_invalidated", "Obsolete selection"));
      });
      expect(api.readReportPage).toHaveBeenCalledTimes(pageReads + 1);
      expect(api.readReportDetail).toHaveBeenCalledTimes(boundary === "revision" ? 2 : 1);
      expect(api.reportExportStatus).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      if (boundary !== "revision") expect(screen.queryByText("Obsolete detail")).not.toBeInTheDocument();
      await act(async () => replacement.resolve(page({ value: [reportUser(4, { displayName: "Current" })] })));
      await screen.findByRole("button", { name: "Current" });
      expect(screen.queryByRole("dialog") !== null).toBe(boundary === "revision");
      if (boundary === "revision") expect(screen.getByRole("button", { name: "Preparing export..." })).toBeDisabled();
      else expect(screen.getByRole("button", { name: "Export users CSV" })).toBeEnabled();
    });
  it.each(["success", "invalidation"] as const)(
    "discards a cancelled search's late %s without changing the replacement's loading or results", async outcome => {
      renderActivity();
      await screen.findByRole("button", { name: "Ada" });
      const previous = deferred<ReportPage<ReportUser>>(), replacement = deferred<ReportPage<ReportUser>>();
      vi.mocked(api.readReportPage).mockReturnValueOnce(previous.promise).mockReturnValueOnce(replacement.promise);
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ben" } });
      const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Current" } });
      expect(signal?.aborted).toBe(true);
      expect(api.readReportPage).toHaveBeenCalledTimes(3);
      expect(screen.getByRole("status", { name: "Matching users" })).toHaveTextContent("Updating...");
      expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
      await act(async () => {
        if (outcome === "success") previous.resolve(page({ value: [ben] }));
        else previous.reject(new ApiError(409, "selection_invalidated", "Obsolete selection"));
      });
      expect(screen.queryByRole("button", { name: "Ben" })).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("status", { name: "Matching users" })).toHaveTextContent("Updating...");
      expect(api.readReportPage).toHaveBeenCalledTimes(3);
      await act(async () => replacement.resolve(page({ value: [reportUser(4, { displayName: "Current" })] })));
      await screen.findByRole("button", { name: "Current" });
      expect(screen.getByRole("button", { name: "Export users CSV" })).toBeEnabled();
    });
  it("retires open details and pending exports through historical A-B-A navigation even when transports ignore cancellation", async () => {
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
    expect(await screen.findByRole("alert")).toHaveTextContent(/selection/i);
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Restart selection" })).toBeVisible();
  });
  it("offers an explicit parent restart after exact detail selection invalidation", async () => {
    vi.mocked(api.readReportDetail).mockRejectedValue(new ApiError(409, "selection_invalidated", "Selection expired"));
    renderActivity();
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This selection changed or expired.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.selectionId).toBeUndefined();
  });
  it("does not combine a returned directory identity with a different exact report identity", async () => {
    details(ada, combinedUser(99));
    renderActivity();
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This selection changed or expired.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("User 99")).not.toBeInTheDocument();
    expect(screen.queryByText("No active M365 Copilot license", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    expect(api.readReportDetail).toHaveBeenCalledTimes(2);
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
      await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("This selection changed or expired.");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
      expect(screen.queryByText("No active M365 Copilot license", { exact: true })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
      expect(api.readReportDetail).toHaveBeenCalledTimes(2);
      expect(api.readReportPage).toHaveBeenCalledOnce();
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
