import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOfficialUsageUserView } from "../../../backend/src/services/officialUsageViews";
import * as api from "../api/client";
import { downloadBlob } from "../agentExport";
import type { UsersRouteState } from "../workbenchRouting";
import { copilotUsageFixture } from "../test/copilotUsageFixture";
import { usageFixtureNow, usageFixtureSetId, usageInsightsPublished, usageUsersFixture } from "../test/usageInsightsFixture";
import { ReportedUserActivity } from "./ReportedUserActivity";
import { SavedQueryProvider } from "./SavedQueryProvider";

vi.mock("../agentExport", () => ({ downloadBlob: vi.fn() }));

const initialRoute: UsersRouteState = { view: "activity", search: "", page: 0 };
function directoryFixture() {
  const data = structuredClone(copilotUsageFixture);
  data.users = data.users.map(user => ({
    ...user,
    importedUsage: usageUsersFixture().users.value.find(row => row.username === user.directory.userPrincipalName) ?? null,
  }));
  return data;
}

function renderActivity(route = initialRoute, directoryData = directoryFixture()) {
  const changed = vi.fn();
  const denied = vi.fn();
  function Harness() {
    const [current, setCurrent] = useState(route);
    return <ReportedUserActivity route={current} directoryData={directoryData} onAccessDenied={denied}
      onRouteChange={(next, replace) => { setCurrent(next); changed(next, replace); }} />;
  }
  return { ...render(<Harness />), changed, denied };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function reportedRows() {
  return within(screen.getByRole("region", { name: "Reported users" })).getAllByRole("row").slice(1);
}

async function openUser(name: string) {
  const trigger = await screen.findByRole("button", { name: `View reported details for ${name}` });
  await userEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name }) };
}

beforeEach(() => {
  vi.spyOn(api, "getOfficialUsageUsers").mockImplementation(async query => usageUsersFixture({
    staleAfterDays: 35, ...query, userSortBy: query?.sortBy,
  }));
  vi.spyOn(api, "downloadOfficialUsageCsv").mockResolvedValue(new Blob(["users"]));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("reported user activity", () => {
  it("isolates a new data revision from a saved read kept alive by another observer", async () => {
    const previous = deferred<api.OfficialUsageUserView>();
    const previousData = usageUsersFixture();
    previousData.users.value[0].displayName = "Previous report identity";
    const currentData = usageUsersFixture();
    currentData.users.value[0].displayName = "Current report identity";
    vi.mocked(api.getOfficialUsageUsers).mockReturnValueOnce(previous.promise).mockResolvedValue(currentData);
    const panels = (revision: number) => <SavedQueryProvider>
      <section aria-label="Previous reader"><ReportedUserActivity route={initialRoute} onRouteChange={vi.fn()} dataRevision={0} /></section>
      <section aria-label="Current reader"><ReportedUserActivity route={initialRoute} onRouteChange={vi.fn()} dataRevision={revision} /></section>
    </SavedQueryProvider>;
    const view = render(panels(0));
    await waitFor(() => expect(api.getOfficialUsageUsers).toHaveBeenCalledOnce());
    const previousSignal = vi.mocked(api.getOfficialUsageUsers).mock.calls[0][1]?.signal;
    view.rerender(panels(1));
    const current = within(screen.getByRole("region", { name: "Current reader" }));
    expect(await current.findByRole("button", { name: "View reported details for Current report identity" })).toBeVisible();
    expect(api.getOfficialUsageUsers).toHaveBeenCalledTimes(2);
    expect(previousSignal?.aborted).toBe(false);
    await act(async () => previous.resolve(previousData));
    expect(await within(screen.getByRole("region", { name: "Previous reader" }))
      .findByRole("button", { name: "View reported details for Previous report identity" })).toBeVisible();
    expect(current.queryByRole("button", { name: "View reported details for Previous report identity" })).not.toBeInTheDocument();
  });

  it("shows every report identity in a single six-field table with no automatic detail or cross-page links", async () => {
    renderActivity();
    const table = await screen.findByRole("region", { name: "Reported users" });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(6);
    expect(reportedRows()).toHaveLength(4);
    expect(within(table).getByRole("row", { name: /Concealed report user/ })).toHaveTextContent("Unknown");
    expect(within(table).getByRole("row", { name: /Ben/ })).toHaveTextContent("0");
    expect(within(table).queryByText(/Sep 12/)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "User agent breakdown" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/Microsoft 365 admin center Copilot Agents usage exports/)).not.toBeVisible();
    expect(screen.queryByText(/Top users by responses|Least active users/)).not.toBeInTheDocument();
  });

  it("opens details only on explicit action and restores keyboard focus on close or Escape", async () => {
    renderActivity();
    const trigger = await screen.findByRole("button", { name: "View reported details for Ada" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const detail = screen.getByRole("dialog", { name: "Ada" });
    expect(within(detail).getByRole("button", { name: "Close reported user details" })).toHaveFocus();
    expect(within(detail).queryByRole("link")).not.toBeInTheDocument();
    fireEvent(detail, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Close reported user details" }));
    expect(trigger).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search this user's agents" }), "research");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps discrepant totals separate and never substitutes bridge responses for unknown Users metrics", async () => {
    const data = usageUsersFixture();
    const ada = data.users.value.find(user => user.displayName === "Ada")!;
    ada.reportedResponsesReceived = 999;
    ada.hasReportMismatch = true;
    const concealed = data.users.value.find(user => user.username === "concealed-user")!;
    concealed.missingUserReport = true;
    concealed.reportedResponsesReceived = 0;
    concealed.reportedAgentsUsed = 0;
    vi.mocked(api.getOfficialUsageUsers).mockResolvedValue(data);
    renderActivity();
    const { dialog } = await openUser("Ada");
    expect(within(dialog).getByText("Responses (Users report)").parentElement).toHaveTextContent("999");
    expect(within(dialog).getByText("Responses (all Users & agents rows)").parentElement).toHaveTextContent("215");
    expect(within(dialog).getByText(/shown separately, never added/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close reported user details" }));
    const row = within(screen.getByRole("region", { name: "Reported users" })).getByRole("row", { name: /Concealed report user/ });
    expect(within(row).getAllByRole("cell").slice(0, 2).map(cell => cell.textContent)).toEqual(["Unknown", "Unknown"]);
    const bridgeDetail = (await openUser("Concealed report user")).dialog;
    expect(within(bridgeDetail).getByText("Responses (Users report)").parentElement).toHaveTextContent("Unknown");
    expect(within(bridgeDetail).getByText("Agents used (Users report)").parentElement).toHaveTextContent("Unknown");
    expect(within(bridgeDetail).getByText("Responses (all Users & agents rows)").parentElement).toHaveTextContent("12");
    expect(within(bridgeDetail).getByText("User last activity (Users report)").parentElement).toHaveTextContent("Not reported");
  });

  it("preserves zero relationships but describes absent rows as not reported", async () => {
    const data = usageUsersFixture();
    const cleo = data.users.value.find(user => user.displayName === "Cleo")!;
    cleo.rows = [];
    cleo.bridgeResponsesSentToUsers = 0;
    vi.mocked(api.getOfficialUsageUsers).mockResolvedValue(data);
    renderActivity();
    const ben = (await openUser("Ben")).dialog;
    const row = within(ben).getByRole("row", { name: /Researcher/ });
    expect(within(row).getAllByRole("cell")[2]).toHaveTextContent(/^0$/);
    expect(within(row).getByText("Anyone, not this user")).toBeVisible();
    expect(within(ben).getByText("User last activity (Users report)").parentElement).toHaveTextContent("Not reported");
    await userEvent.click(within(ben).getByRole("button", { name: "Close reported user details" }));
    const cleoDetail = (await openUser("Cleo")).dialog;
    expect(within(cleoDetail).getByRole("heading", { name: "No agent relationships reported" })).toBeVisible();
    expect(within(cleoDetail).getByText(/contains no agent rows for this user/)).toBeVisible();
    expect(within(cleoDetail).getByText("Responses (Users report)").parentElement).toHaveTextContent("40");
    expect(within(cleoDetail).getByText("Responses (all Users & agents rows)").parentElement).toHaveTextContent("Not reported");
    expect(within(cleoDetail).queryByText(/Import and activate/)).not.toBeInTheDocument();
  });

  it("does not describe a missing companion as a report containing no relationship rows", async () => {
    const published = structuredClone(usageInsightsPublished);
    published.reports.userAgents = undefined;
    vi.mocked(api.getOfficialUsageUsers).mockResolvedValue(buildOfficialUsageUserView(published, { staleAfterDays: 35, now: usageFixtureNow }));
    renderActivity();
    const detail = (await openUser("Ada")).dialog;
    expect(within(detail).getByRole("heading", { name: "Agent relationships unavailable" })).toBeVisible();
    expect(within(detail).queryByText(/contains no agent rows/)).not.toBeInTheDocument();
    expect(within(detail).queryByText(/Report totals differ/)).not.toBeInTheDocument();
    expect(within(detail).getByText("Responses (all Users & agents rows)").parentElement).toHaveTextContent("Not reported");
  });

  it.each(["set", "users-version", "bridge-version", "case", "ambiguous", "unavailable", "partial"])(
    "does not claim a current license for a %s directory link", async scenario => {
      const directory = directoryFixture();
      const ada = directory.users[0];
      if (scenario === "set") ada.importedUsage!.datasetScope.reportSetId = "older-set";
      if (scenario === "users-version") ada.importedUsage!.datasetScope.usersVersionId = "older-users";
      if (scenario === "bridge-version") ada.importedUsage!.datasetScope.userAgentsVersionId = "older-bridge";
      if (scenario === "case") ada.importedUsage!.username = "ADA@example.invalid";
      if (scenario === "ambiguous") directory.users.push({ ...ada, directory: { ...ada.directory, objectId: "other-directory-user" } });
      if (scenario === "unavailable") directory.sources.directory.state = "unavailable";
      if (scenario === "partial") directory.sources.directory.state = "partial";
      renderActivity(initialRoute, directory);
      const table = await screen.findByRole("region", { name: "Reported users" });
      expect(within(table).getByRole("row", { name: /Ada/ })).toHaveTextContent("Unknown");
      const detail = (await openUser("Ada")).dialog;
      expect(within(detail).getByText("Current license").parentElement).toHaveTextContent("Unknown");
    },
  );

  it("keeps case-distinct pseudonyms separate and reports identities when directory data is unavailable", async () => {
    const data = usageUsersFixture();
    data.users.value = [data.users.value[0], { ...data.users.value[0], username: "ADA@example.invalid", displayName: "ADA" }];
    data.users.count = 2;
    const directory = directoryFixture();
    directory.sources.directory.state = "unavailable";
    directory.users = [];
    vi.mocked(api.getOfficialUsageUsers).mockResolvedValue(data);
    renderActivity(initialRoute, directory);
    const table = await screen.findByRole("region", { name: "Reported users" });
    expect(within(table).getByText("ada@example.invalid", { exact: true })).toBeVisible();
    expect(within(table).getByText("ADA@example.invalid", { exact: true })).toBeVisible();
    expect(reportedRows()).toHaveLength(2);
    expect(reportedRows().every(row => row.textContent?.includes("Unknown"))).toBe(true);
  });

  it("searches over 2,000 report users before paging, including agents not on the current page", async () => {
    const published = structuredClone(usageInsightsPublished);
    published.reports.users!.rows = Array.from({ length: 2_053 }, (_, index) => ({
      username: `person${index}@example.invalid`, displayName: `Person${String(index).padStart(4, "0")}`,
      numberOfAgentsUsed: 1, agentResponsesReceived: 2_100 - index,
    }));
    published.reports.userAgents!.rows = published.reports.users!.rows.map((user, index) => ({
      username: user.username, agentId: `agent-${index}`, agentName: `Specialist${index}`, creatorType: "Your org",
      responsesSentToUsers: user.agentResponsesReceived,
    }));
    vi.mocked(api.getOfficialUsageUsers).mockImplementation(async query => buildOfficialUsageUserView(published, {
      ...query, staleAfterDays: 35, now: usageFixtureNow, userSortBy: query?.sortBy,
    }));
    renderActivity();
    await screen.findByRole("region", { name: "Reported users" });
    expect(reportedRows()).toHaveLength(50);
    expect(screen.getByLabelText("Reported user pages")).toHaveTextContent("1-50 of 2,053");
    await userEvent.click(screen.getByRole("button", { name: "Next users" }));
    await waitFor(() => expect(screen.getByLabelText("Reported user pages")).toHaveTextContent("51-100 of 2,053"));
    expect(reportedRows()).toHaveLength(50);
    expect(api.getOfficialUsageUsers).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 50, offset: 50, setId: usageFixtureSetId }), expect.anything());
    await userEvent.type(screen.getByRole("searchbox", { name: "Search reported users or agents" }), "Specialist2052");
    await waitFor(() => expect(reportedRows()).toHaveLength(1));
    expect(reportedRows()[0]).toHaveTextContent("Person2052");
    expect(api.getOfficialUsageUsers).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Specialist2052", limit: 50, offset: 0 }), expect.anything());
  });

  it("bounds a 1,005-agent detail to 50 rows and searches all its agents", async () => {
    const data = usageUsersFixture();
    const user = data.users.value[0];
    user.rows = Array.from({ length: 1_005 }, (_, index) => ({
      ...user.rows[0], agentId: `agent-${index}`, displayAgentName: `Agent${String(index).padStart(4, "0")}`, responsesSentToUsers: 2_000 - index,
    }));
    data.users.value = [user];
    data.users.count = 1;
    vi.mocked(api.getOfficialUsageUsers).mockResolvedValue(data);
    renderActivity();
    await screen.findByRole("region", { name: "Reported users" });
    expect(screen.queryByRole("region", { name: "User agent breakdown" })).not.toBeInTheDocument();
    const { dialog } = await openUser("Ada");
    const breakdown = within(dialog).getByRole("region", { name: "User agent breakdown" });
    expect(within(breakdown).getAllByRole("row")).toHaveLength(51);
    expect(within(dialog).getByLabelText("User agent pages")).toHaveTextContent("1-50 of 1,005");
    await userEvent.click(within(dialog).getByRole("button", { name: "Next agents" }));
    expect(within(dialog).getByLabelText("User agent pages")).toHaveTextContent("51-100 of 1,005");
    await userEvent.type(within(dialog).getByRole("searchbox", { name: "Search this user's agents" }), "agent-1004");
    expect(within(breakdown).getAllByRole("row")).toHaveLength(2);
    expect(within(breakdown).getByRole("button", { name: "Agent1004" })).toBeVisible();
  });

  it("supports exact focused agents, shows selected relationship responses, and can explore every other agent", async () => {
    const { changed } = renderActivity({ ...initialRoute, agentId: "helpdesk/report:2", reportSetId: usageFixtureSetId });
    await screen.findByRole("region", { name: "Reported users" });
    expect(reportedRows()).toHaveLength(2);
    expect(screen.getByLabelText("Selected report agent")).toHaveTextContent("helpdesk/report:2");
    const { dialog } = await openUser("Ada");
    expect(within(dialog).getByText("Responses (Users report)").parentElement).toHaveTextContent("215");
    expect(within(dialog).getByRole("row", { name: /Helpdesk/ })).toHaveTextContent("15");
    expect(within(dialog).queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Show all this user's agents" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Researcher" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "synthetic-researcher", reportSetId: usageFixtureSetId, page: 0 }), undefined);
    await waitFor(() => expect(api.getOfficialUsageUsers).toHaveBeenLastCalledWith(expect.objectContaining({
      agentId: "synthetic-researcher", setId: usageFixtureSetId, limit: 50, offset: 0,
    }), expect.anything()));
  });

  it("applies advanced filters together, preserves all-agent totals, and exports server-applied filters without paging", async () => {
    const fullUserCsv = new Blob(["User,Agent,All-agent responses,Relationship responses\nAda,helpdesk/report:2,215,15\nAda,synthetic-researcher,215,200\n"]);
    vi.mocked(api.downloadOfficialUsageCsv).mockResolvedValueOnce(fullUserCsv);
    const { changed } = renderActivity({ ...initialRoute, reportSetId: usageFixtureSetId, agentId: "helpdesk/report:2", search: "Ada", page: 2 });
    await screen.findByRole("heading", { name: "No reported users on this page" });
    expect(screen.getByRole("button", { name: "Export users CSV" })).toHaveAccessibleDescription(/all agent details for matching users, including relationships outside the selected agent, creator or response filters/);
    expect(screen.getByText(/All-agent user totals repeat per relationship; do not sum them/)).toBeVisible();
    await userEvent.click(screen.getByText("Advanced user filters"));
    await userEvent.selectOptions(screen.getByLabelText("Relationship creator"), "Your org");
    await userEvent.selectOptions(screen.getByLabelText("User recency"), "recent");
    fireEvent.change(screen.getByLabelText("User activity start (UTC)"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("User activity end (UTC)"), { target: { value: "2026-09-10" } });
    await userEvent.selectOptions(screen.getByLabelText("Users-report response cohort"), "low");
    fireEvent.change(screen.getByLabelText("Low-response threshold"), { target: { value: "250" } });
    await userEvent.click(screen.getByLabelText("Require a response-producing relationship"));
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Apply user filters" }));
    await screen.findByRole("region", { name: "Reported users" });
    expect(reportedRows()[0]).toHaveTextContent("215");
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ page: 0 }), undefined);
    await userEvent.selectOptions(screen.getByLabelText("Order reported users by"), "responses-asc");
    await waitFor(() => expect(api.getOfficialUsageUsers).toHaveBeenLastCalledWith(expect.objectContaining({ sortBy: "responses", sortDirection: "asc" }), expect.anything()));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export users CSV" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    expect(api.downloadOfficialUsageCsv).toHaveBeenCalledExactlyOnceWith("users", {
      setId: usageFixtureSetId, agentId: "helpdesk/report:2", search: "Ada", creatorType: "Your org",
      activity: "recent", inactiveDays: 30, responsesOnly: true, startDate: "2026-09-01", endDate: "2026-09-10",
      lowResponseThreshold: 250, cohort: "low", sortBy: "responses", sortDirection: "asc",
    }, expect.any(AbortSignal));
    expect(downloadBlob).toHaveBeenCalledWith("reported-user-activity.csv", fullUserCsv);
    expect(screen.getByText(/User CSV downloaded with all agent details for matching identities/)).toBeVisible();
  });

  it.each([
    ["responses-desc", "responses", "desc"],
    ["responses-asc", "responses", "asc"],
    ["agents-desc", "agentsUsed", "desc"],
    ["agents-asc", "agentsUsed", "asc"],
    ["activity-desc", "lastActivity", "desc"],
    ["activity-asc", "lastActivity", "asc"],
    ["name", "displayName", "asc"],
    ["name-desc", "displayName", "desc"],
  ])("requests the %s ordering across all users", async (value, sortBy, sortDirection) => {
    renderActivity();
    await screen.findByRole("region", { name: "Reported users" });
    await userEvent.selectOptions(screen.getByLabelText("Order reported users by"), value);
    await waitFor(() => expect(api.getOfficialUsageUsers).toHaveBeenLastCalledWith(expect.objectContaining({ sortBy, sortDirection, offset: 0, limit: 50 }), expect.anything()));
  });

  it.each([
    ["Agent responses (Users report)", "responses-asc", "responses", ["u0", "u2", "u10", "unknown"], ["u10", "u2", "u0", "unknown"]],
    ["Agents used (Users report)", "agents-asc", "agentsUsed", ["u0", "u2", "u10", "unknown"], ["u10", "u2", "u0", "unknown"]],
    ["User last activity (Users report)", "activity-asc", "lastActivity", ["u0", "u2", "u10", "unknown"], ["u10", "u2", "u0", "unknown"]],
    ["Reported user", "name", "displayName", ["u0", "u10", "u2", "unknown"], ["unknown", "u2", "u10", "u0"]],
  ] as const)("honors backend %s comparisons in both directions and exports the same ordering", async (header, order, sortBy, ascending, descending) => {
    const published = structuredClone(usageInsightsPublished);
    published.reports.users!.rows = [
      { username: "u10", displayName: "User10", numberOfAgentsUsed: 10, agentResponsesReceived: 10, lastActivityDateUtc: "2026-10-01T00:00:00.000Z" },
      { username: "u2", displayName: "User2", numberOfAgentsUsed: 2, agentResponsesReceived: 2, lastActivityDateUtc: "2026-01-02T00:00:00.000Z" },
      { username: "u0", displayName: "User0", numberOfAgentsUsed: 0, agentResponsesReceived: 0, lastActivityDateUtc: "2025-12-31T00:00:00.000Z" },
    ];
    published.reports.userAgents!.rows = [{ ...published.reports.userAgents!.rows[0], username: "unknown", responsesSentToUsers: 999 }];
    vi.mocked(api.getOfficialUsageUsers).mockImplementation(async query => buildOfficialUsageUserView(published, {
      ...query, staleAfterDays: 35, now: usageFixtureNow, userSortBy: query?.sortBy,
    }));
    renderActivity();
    await screen.findByRole("region", { name: "Reported users" });
    const usernames = () => reportedRows().map(row => within(row).getByRole("rowheader").querySelector("small")?.textContent);
    await userEvent.selectOptions(screen.getByLabelText("Order reported users by"), order);
    await waitFor(() => expect(usernames()).toEqual(ascending));
    const sortButton = screen.getByRole("button", { name: `Sort by ${header}` });
    sortButton.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(usernames()).toEqual(descending));
    expect(screen.getByRole("columnheader", { name: header })).toHaveAttribute("aria-sort", "descending");
    expect(api.getOfficialUsageUsers).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy, sortDirection: "desc", offset: 0, limit: 50 }), expect.anything(),
    );
    const unknown = reportedRows().find(row => within(row).getByRole("rowheader").querySelector("small")?.textContent === "unknown")!;
    expect(within(unknown).getAllByRole("cell")[0]).toHaveTextContent(/^Unknown$/);
    expect(within(unknown).getAllByRole("cell")[1]).toHaveTextContent(/^Unknown$/);
    await userEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    expect(api.downloadOfficialUsageCsv).toHaveBeenLastCalledWith(
      "users", expect.objectContaining({ setId: usageFixtureSetId, sortBy, sortDirection: "desc" }), expect.any(AbortSignal),
    );
  });

  it("leaves focus in the search input after a delayed server sort finishes", async () => {
    renderActivity();
    await screen.findByRole("region", { name: "Reported users" });
    const pending = deferred<api.OfficialUsageUserView>();
    vi.mocked(api.getOfficialUsageUsers).mockReturnValueOnce(pending.promise);
    await userEvent.click(screen.getByRole("button", { name: "Sort by Reported user" }));
    const search = screen.getByRole("searchbox", { name: "Search reported users or agents" });
    search.focus();
    await act(async () => pending.resolve(usageUsersFixture({ staleAfterDays: 35, userSortBy: "displayName", sortDirection: "asc" })));
    expect(screen.getByRole("region", { name: "Reported users" })).toBeVisible();
    expect(search).toHaveFocus();
  });

  it("survives root Strict Mode replay without reviving its first saved read", async () => {
    const pending = deferred<api.OfficialUsageUserView>();
    vi.mocked(api.getOfficialUsageUsers).mockReturnValueOnce(pending.promise);
    render(<ReportedUserActivity route={initialRoute} onRouteChange={vi.fn()} />, { reactStrictMode: true });
    await screen.findByRole("region", { name: "Reported users" });
    expect(api.getOfficialUsageUsers).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.getOfficialUsageUsers).mock.calls[0][1]?.signal?.aborted).toBe(true);
    const old = usageUsersFixture();
    old.users.value[0].displayName = "Obsolete user";
    await act(async () => pending.resolve(old));
    expect(screen.queryByRole("row", { name: /Obsolete user/ })).not.toBeInTheDocument();
    expect(reportedRows()).toHaveLength(4);
  });

  it.each(["responses-desc", "responses-asc", "agents-desc", "agents-asc"])("keeps missing Users-report metrics last for %s", async order => {
    const published = structuredClone(usageInsightsPublished);
    published.reports.users!.rows = published.reports.users!.rows.filter(user => user.username !== "concealed-user");
    vi.mocked(api.getOfficialUsageUsers).mockImplementation(async query => buildOfficialUsageUserView(published, {
      ...query, staleAfterDays: 35, now: usageFixtureNow, userSortBy: query?.sortBy,
    }));
    renderActivity();
    await screen.findByRole("region", { name: "Reported users" });
    await userEvent.selectOptions(screen.getByLabelText("Order reported users by"), order);
    await waitFor(() => expect(reportedRows().at(-1)).toHaveTextContent("concealed-user"));
    const cells = within(reportedRows().at(-1)!).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent(/^Unknown$/);
    expect(cells[1]).toHaveTextContent(/^Unknown$/);
  });

  it("validates date bounds and thresholds instead of exporting unapplied or invalid filters", async () => {
    renderActivity();
    await screen.findByRole("region", { name: "Reported users" });
    await userEvent.click(screen.getByText("Advanced user filters"));
    fireEvent.change(screen.getByLabelText("User activity start (UTC)"), { target: { value: "2026-09-10" } });
    fireEvent.change(screen.getByLabelText("User activity end (UTC)"), { target: { value: "2026-09-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("start must be on or before");
    expect(screen.getByRole("button", { name: "Apply user filters" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Low-response threshold"), { target: { value: "0" } });
    expect(screen.getByText(/whole-number threshold/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reset user filters" }));
    expect(screen.getByLabelText("User activity start (UTC)")).toHaveValue("");
    expect(screen.getByLabelText("Low-response threshold")).toHaveValue(5);
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeEnabled();
    expect(api.getOfficialUsageUsers).toHaveBeenCalledOnce();
  });

  it("pins pagination and export to the displayed active set even if the tenant selection changes", async () => {
    let currentId = usageFixtureSetId;
    vi.mocked(api.getOfficialUsageUsers).mockImplementation(async query => {
      const data = usageUsersFixture({ ...query, staleAfterDays: 35 });
      data.activeSet = { ...data.activeSet!, id: query?.setId ?? currentId };
      data.users.count = 101;
      return data;
    });
    const { changed } = renderActivity();
    await screen.findByRole("region", { name: "Reported users" });
    currentId = "33333333-3333-4333-8333-333333333333";
    await userEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    expect(api.downloadOfficialUsageCsv).toHaveBeenLastCalledWith("users", expect.objectContaining({ setId: usageFixtureSetId }), expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Next users" }));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ reportSetId: usageFixtureSetId, page: 1 }), undefined);
    await waitFor(() => expect(api.getOfficialUsageUsers).toHaveBeenLastCalledWith(expect.objectContaining({ setId: usageFixtureSetId, offset: 50 }), expect.anything()));
  });

  it("aborts outdated requests and prevents a late result from replacing a newer query", async () => {
    const late = deferred<api.OfficialUsageUserView>();
    vi.mocked(api.getOfficialUsageUsers).mockReturnValueOnce(late.promise);
    renderActivity();
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    const firstSignal = vi.mocked(api.getOfficialUsageUsers).mock.calls[0][1]!.signal!;
    await userEvent.type(screen.getByRole("searchbox", { name: "Search reported users or agents" }), "Cleo");
    await screen.findByRole("region", { name: "Reported users" });
    expect(firstSignal.aborted).toBe(true);
    expect(reportedRows()).toHaveLength(1);
    await act(async () => late.resolve(usageUsersFixture()));
    expect(reportedRows()).toHaveLength(1);
    expect(reportedRows()[0]).toHaveTextContent("Cleo");
  });

  it("does not revive an earlier read, detail or export during A-B-A snapshot navigation", async () => {
    const middle = deferred<api.OfficialUsageUserView>();
    const current = deferred<api.OfficialUsageUserView>();
    const exportResult = deferred<Blob>();
    vi.mocked(api.getOfficialUsageUsers).mockResolvedValueOnce(usageUsersFixture())
      .mockReturnValueOnce(middle.promise).mockReturnValueOnce(current.promise);
    vi.mocked(api.downloadOfficialUsageCsv).mockReturnValueOnce(exportResult.promise);
    const props = { onRouteChange: vi.fn(), directoryData: directoryFixture() };
    const route = { ...initialRoute, reportSetId: usageFixtureSetId };
    const view = render(<ReportedUserActivity {...props} route={route} />);
    await screen.findByRole("region", { name: "Reported users" });
    await userEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    await openUser("Ada");
    view.rerender(<ReportedUserActivity {...props} route={{ ...route, reportSetId: "other-set" }} />);
    view.rerender(<ReportedUserActivity {...props} route={route} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Reported users" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    await act(async () => {
      middle.resolve(usageUsersFixture());
      exportResult.resolve(new Blob(["obsolete"]));
    });
    expect(screen.queryByRole("region", { name: "Reported users" })).not.toBeInTheDocument();
    expect(downloadBlob).not.toHaveBeenCalled();
    await act(async () => current.resolve(usageUsersFixture()));
    expect(screen.getByRole("region", { name: "Reported users" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeEnabled();
  });

  it("aborts pending exports on query change and ignores their late downloads", async () => {
    const late = deferred<Blob>();
    vi.mocked(api.downloadOfficialUsageCsv).mockReturnValue(late.promise);
    renderActivity();
    await screen.findByRole("region", { name: "Reported users" });
    await userEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    expect(screen.getByRole("button", { name: "Exporting users…" })).toBeDisabled();
    const signal = vi.mocked(api.downloadOfficialUsageCsv).mock.calls[0][2]!;
    await userEvent.type(screen.getByRole("searchbox", { name: "Search reported users or agents" }), "Ben");
    expect(signal.aborted).toBe(true);
    await act(async () => late.resolve(new Blob(["old result"])));
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(screen.queryByText(/User CSV downloaded/)).not.toBeInTheDocument();
  });

  it("aborts pending exports on unmount without downloading late content", async () => {
    const late = deferred<Blob>();
    vi.mocked(api.downloadOfficialUsageCsv).mockReturnValue(late.promise);
    const view = renderActivity();
    await screen.findByRole("region", { name: "Reported users" });
    await userEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    const exportSignal = vi.mocked(api.downloadOfficialUsageCsv).mock.calls[0][2]!;
    view.unmount();
    expect(exportSignal.aborted).toBe(true);
    await act(async () => late.resolve(new Blob(["old"])));
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("aborts an in-flight reported-user read on unmount", () => {
    const pending = deferred<api.OfficialUsageUserView>();
    vi.mocked(api.getOfficialUsageUsers).mockReturnValueOnce(pending.promise);
    const view = renderActivity();
    const signal = vi.mocked(api.getOfficialUsageUsers).mock.calls[0][1]!.signal!;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("does not revive an aborted export when draft filters are reset to their previous values", async () => {
    const late = deferred<Blob>();
    vi.mocked(api.downloadOfficialUsageCsv).mockReturnValue(late.promise);
    renderActivity();
    await screen.findByRole("region", { name: "Reported users" });
    await userEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    const signal = vi.mocked(api.downloadOfficialUsageCsv).mock.calls[0][2]!;
    await userEvent.click(screen.getByText("Advanced user filters"));
    fireEvent.change(screen.getByLabelText("Low-response threshold"), { target: { value: "10" } });
    expect(signal.aborted).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Reset user filters" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export users CSV" })).toBeEnabled());
    await act(async () => late.resolve(new Blob(["aborted"])));
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("aborts exports when switching snapshots and never lets a late download use a newer report label", async () => {
    const late = deferred<Blob>();
    vi.mocked(api.downloadOfficialUsageCsv).mockReturnValue(late.promise);
    renderActivity({ ...initialRoute, reportSetId: usageFixtureSetId });
    await screen.findByRole("region", { name: "Reported users" });
    await userEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    const signal = vi.mocked(api.downloadOfficialUsageCsv).mock.calls[0][2]!;
    await userEvent.click(screen.getByRole("button", { name: "Use current reports" }));
    expect(signal.aborted).toBe(true);
    await act(async () => late.resolve(new Blob(["old snapshot"])));
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(api.getOfficialUsageUsers).toHaveBeenLastCalledWith(expect.objectContaining({ setId: undefined, offset: 0 }), expect.anything());
  });

  it("surfaces export failure with a local retry and clears private rows after authorization failure", async () => {
    vi.mocked(api.downloadOfficialUsageCsv).mockRejectedValueOnce(new Error("Export unavailable"))
      .mockRejectedValueOnce(new api.ApiError(403, "forbidden", "User access revoked"));
    const { denied } = renderActivity();
    await screen.findByRole("region", { name: "Reported users" });
    await userEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Export unavailable");
    expect(reportedRows()).toHaveLength(4);
    await userEvent.click(screen.getByRole("button", { name: "Retry user export" }));
    await waitFor(() => expect(denied).toHaveBeenCalledWith("User access revoked"));
    expect(screen.queryByRole("region", { name: "Reported users" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("keeps retained snapshot failures explicit and retries locally without falling back", async () => {
    vi.mocked(api.getOfficialUsageUsers).mockRejectedValueOnce(new Error("Retained report unavailable"));
    renderActivity({ ...initialRoute, reportSetId: usageFixtureSetId });
    expect(await screen.findByRole("alert")).toHaveTextContent("Retained report unavailable");
    expect(screen.queryByText(/Loading reported user activity/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    expect(api.getOfficialUsageUsers).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ setId: usageFixtureSetId }), expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Retry reported activity" }));
    expect(await screen.findByRole("region", { name: "Reported users" })).toBeVisible();
    expect(api.getOfficialUsageUsers).toHaveBeenLastCalledWith(expect.objectContaining({ setId: usageFixtureSetId }), expect.anything());
  });

  it("closes details and removes stale data when report revisions change or authorization is revoked", async () => {
    const denied = vi.fn();
    const props = { route: initialRoute, onRouteChange: vi.fn(), onAccessDenied: denied };
    const view = render(<ReportedUserActivity {...props} dataRevision={0} />);
    await openUser("Ada");
    vi.mocked(api.getOfficialUsageUsers).mockRejectedValueOnce(new api.ApiError(401, "expired", "Sign in again"));
    view.rerender(<ReportedUserActivity {...props} dataRevision={1} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Reported users" })).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in again");
    expect(denied).toHaveBeenCalledWith("Sign in again");
  });

  it("distinguishes missing reports, missing companions, empty matches and out-of-range pages", async () => {
    const empty = usageUsersFixture();
    empty.activeSet = null;
    empty.availability = "incomplete";
    empty.lineages = [];
    empty.users = { value: [], count: 0, limit: 50, offset: 0 };
    vi.mocked(api.getOfficialUsageUsers).mockResolvedValueOnce(empty);
    const first = renderActivity();
    expect(await screen.findByRole("heading", { name: "No selected user reports" })).toBeVisible();
    expect(screen.getAllByText(/Incomplete report bundle/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Loading reported user activity/)).not.toBeInTheDocument();
    first.unmount();
    const missingBridge = usageUsersFixture();
    missingBridge.lineages = missingBridge.lineages.filter(lineage => lineage.kind !== "userAgents");
    vi.mocked(api.getOfficialUsageUsers).mockResolvedValueOnce(missingBridge);
    const second = renderActivity();
    expect(await screen.findByText(/Relationships are unknown, not zero/)).toBeVisible();
    second.unmount();
    const third = renderActivity({ ...initialRoute, search: "no-such-user" });
    expect(await screen.findByRole("heading", { name: "No reported users match" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search reported users or agents" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Clear user filters" }));
    expect(await screen.findByRole("region", { name: "Reported users" })).toBeVisible();
    third.unmount();
    renderActivity({ ...initialRoute, page: 1 });
    expect(await screen.findByRole("heading", { name: "No reported users on this page" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "First user page" }));
    expect(await screen.findByRole("region", { name: "Reported users" })).toBeVisible();
  });
});
