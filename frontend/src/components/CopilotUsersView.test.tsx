import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getCopilotUsageUsers, getOfficialUsageAgentDetail, getOfficialUsageUsers } from "../api/client";
import { copilotUsageFixture, licensedUser } from "../test/copilotUsageFixture";
import { usageAgentDetailFixture, usageUsersFixture } from "../test/usageInsightsFixture";
import { CopilotUsersView } from "./CopilotUsersView";

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getCopilotUsageUsers: vi.fn(),
  getOfficialUsageUsers: vi.fn(),
  getOfficialUsageAgentDetail: vi.fn(),
}));

function userRows() {
  return within(screen.getByRole("region", { name: "Licensed users" })).getAllByRole("row").slice(1);
}

describe("Copilot license usage dashboard", () => {
  beforeEach(() => {
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(structuredClone(copilotUsageFixture));
    vi.mocked(getOfficialUsageUsers).mockResolvedValue(usageUsersFixture());
    vi.mocked(getOfficialUsageAgentDetail).mockResolvedValue(usageAgentDetailFixture());
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  });
  afterEach(() => { vi.clearAllMocks(); });

  it("leads with all licensed users and keeps technical provenance collapsed", async () => {
    render(<CopilotUsersView />);
    expect(await screen.findByRole("button", { name: "Drew" })).toBeVisible();
    expect(userRows()).toHaveLength(4);
    expect(userRows()[3]).toHaveTextContent("Unknown");
    expect(screen.getByText("Microsoft 365 admin center Copilot Agents usage exports")).not.toBeVisible();
    expect(screen.getByText("Concealed report user")).not.toBeVisible();
    const metrics = screen.getByLabelText("Licensed user summary");
    expect(within(metrics).getByText("Licensed users").parentElement).toHaveTextContent("4");
    expect(within(metrics).getByText("Agent usage unknown").parentElement).toHaveTextContent("1");
    expect(screen.queryByText("Unavailable in exports")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/base licenses and free Copilot Chat alone are not counted/)).toBeVisible();
    expect(screen.getByText("Saved user snapshot is available.")).toBeVisible();
    expect(screen.getByText(/Last successful sync:/)).toHaveTextContent("Sep 12, 2026");
  });

  it("ranks measured users in both directions without treating unknown as zero", async () => {
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    await userEvent.selectOptions(screen.getByLabelText("Order by"), "responses-asc");
    expect(userRows().map(row => within(row).getByRole("button").textContent)).toEqual(["Cleo", "Ben", "Ada", "Drew"]);
    await userEvent.selectOptions(screen.getByLabelText("Order by"), "responses-desc");
    expect(userRows().map(row => within(row).getByRole("button").textContent)).toEqual(["Ada", "Ben", "Cleo", "Drew"]);
    await userEvent.click(screen.getByRole("button", { name: "Usage unknown" }));
    expect(userRows()).toHaveLength(1);
    expect(userRows()[0]).toHaveTextContent("Drew");
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();
  });

  it("shows saved company and department in licensed user details and supports organization search", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users[0].directory.companyName = "Fabrikam Clinics";
    fixture.users[0].directory.department = "Clinical Operations";
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    const search = screen.getByLabelText("Search users or agents");
    await userEvent.type(search, "fabrikam");
    expect(userRows()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Ada" }));
    const organization = within(screen.getByRole("dialog", { name: "Ada" })).getByRole("region", { name: "Saved directory organization" });
    expect(organization).toHaveTextContent("Company: Fabrikam Clinics");
    expect(organization).toHaveTextContent("Department: Clinical Operations");
    await userEvent.click(screen.getByRole("button", { name: "Close user details" }));
    await userEvent.clear(search);
    await userEvent.type(search, "clinical operations");
    expect(userRows()).toHaveLength(1);
    expect(userRows()[0]).toHaveTextContent("Ada");
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();
  });

  it.each(["null", "legacy"] as const)("keeps %s organization metadata explicitly unknown without hiding licensed users", async mode => {
    const fixture = structuredClone(copilotUsageFixture);
    if (mode === "null") {
      fixture.users[0].directory.companyName = null;
      fixture.users[0].directory.department = null;
    } else {
      Reflect.deleteProperty(fixture.users[0].directory, "companyName");
      Reflect.deleteProperty(fixture.users[0].directory, "department");
    }
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    expect(userRows()).toHaveLength(4);
    const organization = within(screen.getByRole("dialog", { name: "Ada" })).getByRole("region", { name: "Saved directory organization" });
    expect(organization).toHaveTextContent("Company: Not reported");
    expect(organization).toHaveTextContent("Department: Not reported");
    expect(organization).not.toHaveTextContent("undefined");
  });

  it("makes reported activity a primary user view independent of the license roster", async () => {
    const data = structuredClone(copilotUsageFixture);
    data.sources.directory.state = "unavailable";
    data.users = [];
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    render(<CopilotUsersView />);
    await userEvent.click(screen.getByRole("button", { name: "Reported activity" }));
    const activity = await screen.findByRole("region", { name: "Reported users" });
    expect(within(activity).getByText("Concealed report user")).toBeVisible();
    expect(within(activity).getAllByRole("row")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Reported activity" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens exact agent activity from a user's breakdown without stacking dialogs", async () => {
    const onRouteChange = vi.fn();
    render(<CopilotUsersView onRouteChange={onRouteChange} />);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Ada" })).getByRole("button", { name: "Researcher" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onRouteChange).toHaveBeenCalledWith({
      view: "activity", agentId: "synthetic-researcher", reportSetId: "synthetic-set", search: "", page: 0,
    }, false);
    expect(screen.getByRole("button", { name: "Reported activity" })).toHaveFocus();
    expect(await screen.findByRole("region", { name: "Reported users" })).toBeVisible();
  });
  it("supports coaching cohorts and a local response threshold", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users[0] = licensedUser(1, "Ada", 12);
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    await userEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(userRows()).toHaveLength(2);
    await userEvent.selectOptions(screen.getByLabelText("Low agent usage threshold"), "20");
    expect(userRows()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Drew" })).not.toBeInTheDocument();
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();
  });

  it("does not recommend low-use interventions from stale or missing agent evidence", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.sources.importedAgentUsage.state = "stale";
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    expect(screen.getByText(/Agent usage is out of date/)).toBeVisible();
    expect(screen.queryByText("Offer adoption help")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.getByText("No users match")).toBeVisible();
  });

  it("shows separate agent/app dates and restores focus without cross-page links", async () => {
    render(<CopilotUsersView />);
    const trigger = await screen.findByRole("button", { name: "Ada" });
    await userEvent.click(trigger);
    const detail = screen.getByRole("dialog", { name: "Ada" });
    expect(within(detail).getByText("Researcher")).toBeVisible();
    expect(within(detail).getByText("Microsoft")).toBeVisible();
    expect(within(detail).getByText("Outlook")).toBeVisible();
    expect(within(detail).getByText("Word").parentElement).toHaveTextContent("Sep 11, 2026");
    expect(within(detail).queryByRole("link")).not.toBeInTheDocument();
    expect(within(detail).getByText("Agent-wide last activity")).toBeVisible();
    expect(within(detail).getByText("Anyone, not this user")).toBeVisible();
    expect(within(detail).getByText(/not a daily event log/)).toBeVisible();
    await userEvent.click(within(detail).getByRole("button", { name: "Close user details" }));
    expect(trigger).toHaveFocus();
  });

  it("keeps missing license and Office data explicit and provides connection recovery", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users = [];
    fixture.sources.directory = { ...fixture.sources.directory, state: "unavailable", message: "User.Read.All permission required." };
    fixture.sources.appActivity = { ...fixture.sources.appActivity, state: "unavailable", message: "Reports.Read.All and Reports Reader are required." };
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    expect(await screen.findByText(/Current license inventory is unverified/)).toHaveTextContent("User.Read.All");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/Office app activity unavailable/)).toBeVisible();
    expect(screen.getByText(/Office app activity unavailable/)).toHaveTextContent("Reports.Read.All and Reports Reader");
    expect(screen.getByText(/Current license count unavailable/)).toBeVisible();
    expect(screen.queryByText(/^0 licensed users/)).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Licensed user summary")).getByText("Licensed users").parentElement).toHaveTextContent("Unknown");
    await userEvent.click(screen.getByText("Unlinked report identities (1)"));
    expect(screen.getByText("Concealed report user")).toBeVisible();
  });

  it("keeps licensed employees visible when only report permission is denied", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.sources.appActivity = {
      ...fixture.sources.appActivity, state: "unavailable",
      message: "Check Reports.Read.All admin consent on the existing Entra app and the signed-in user's Reports Reader role.",
    };
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    expect(userRows()).toHaveLength(4);
    expect(screen.getByText(/Office app activity unavailable/)).toHaveTextContent("Reports Reader");
    expect(screen.getByText(/Office app activity unavailable/)).toBeVisible();
  });

  it("includes assigned-but-disabled accounts for follow-up", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users[0].licenses[0].state = "disabled";
    fixture.users[0].directory.accountEnabled = false;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    expect(userRows()[0]).toHaveTextContent("Assigned, disabled");
    expect(userRows()[0]).toHaveTextContent("Account disabled");
    expect(userRows()[0]).toHaveTextContent("Review assignment");
  });

  it("retains exact service-plan states separately from license assignment", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users[0].servicePlans[0].capabilityStatus = "Warning";
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    const detail = screen.getByRole("dialog", { name: "Ada" });
    expect(within(detail).getByText("Warning", { exact: true })).not.toBeVisible();
    await userEvent.click(within(detail).getByText("License and service-plan details"));
    expect(within(detail).getByText("Warning", { exact: true })).toBeVisible();
    expect(within(detail).getByText(/Direct assignment: Active/)).toBeVisible();
    expect(within(detail).getByText(/Warning is a grace-period state/)).toBeVisible();
  });

  it("counts and searches more than 2,000 licensed accounts independently of the visible page", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users = Array.from({ length: 2_053 }, (_, index) => licensedUser(index + 1, `Person${String(index).padStart(4, "0")}`, index < 10 ? 100 - index : null));
    fixture.counts.licensedUsers = fixture.users.length;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Person0000" });
    expect(within(screen.getByLabelText("Licensed user summary")).getByText("Licensed users").parentElement).toHaveTextContent("2,053");
    expect(userRows()).toHaveLength(50);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(userRows()).toHaveLength(50);
    expect(screen.getByLabelText("Licensed user pages")).toHaveTextContent("51-100 of 2,053");
    await userEvent.type(screen.getByLabelText("Search users or agents"), "person2052");
    expect(userRows()).toHaveLength(1);
    expect(userRows()[0]).toHaveTextContent("Person2052");
    expect(userRows()[0]).toHaveTextContent("Unknown");
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();
  });

  it("leaves collection to Sync and preserves last saved data while a reload fails", async () => {
    vi.mocked(getCopilotUsageUsers).mockResolvedValueOnce(structuredClone(copilotUsageFixture))
      .mockRejectedValueOnce(new Error("Authorization changed"))
      .mockResolvedValueOnce(structuredClone(copilotUsageFixture));
    const view = render(<CopilotUsersView dataRevision={0} />);
    await screen.findByRole("button", { name: "Ada" });
    expect(screen.queryByRole("button", { name: "Sync users" })).not.toBeInTheDocument();
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();

    view.rerender(<CopilotUsersView dataRevision={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Authorization changed");
    expect(screen.getByRole("button", { name: "Ada" })).toBeVisible();
    expect(screen.getByText(/Showing the last saved user snapshot/)).toBeVisible();
    expect(screen.queryByText("Offer adoption help")).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Licensed user summary")).getByText("Using agents").parentElement).toHaveTextContent("Unknown");

    view.rerender(<CopilotUsersView dataRevision={2} />);
    expect(await screen.findByRole("button", { name: "Ada" })).toBeVisible();
    expect(getCopilotUsageUsers).toHaveBeenCalledTimes(3);
  });

  it("withholds current reported-user licenses during and after a failed saved-user reload", async () => {
    const data = structuredClone(copilotUsageFixture);
    data.users = data.users.map(user => ({
      ...user,
      importedUsage: usageUsersFixture().users.value.find(row => row.username === user.directory.userPrincipalName) ?? null,
    }));
    let reject!: (error: Error) => void;
    vi.mocked(getCopilotUsageUsers).mockResolvedValueOnce(data)
      .mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    const route = { view: "activity", search: "", page: 0 } as const;
    const view = render(<CopilotUsersView route={route} dataRevision={0} />);
    const activity = await screen.findByRole("region", { name: "Reported users" });
    await waitFor(() => expect(within(activity).getByRole("row", { name: /Ada/ })).toHaveTextContent("Assigned"));

    view.rerender(<CopilotUsersView route={route} dataRevision={1} />);
    const refreshedActivity = await screen.findByRole("region", { name: "Reported users" });
    expect(within(refreshedActivity).getByRole("row", { name: /Ada/ })).toHaveTextContent("Unknown");
    await act(async () => reject(new Error("Saved users temporarily unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved users temporarily unavailable");
    expect(within(refreshedActivity).getByRole("row", { name: /Ada/ })).toHaveTextContent("Unknown");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("clears retained user data after read authorization is revoked", async () => {
    vi.mocked(getCopilotUsageUsers).mockResolvedValueOnce(structuredClone(copilotUsageFixture))
      .mockRejectedValueOnce(new ApiError(403, "missing_internal_role", "User access was revoked."));
    const view = render(<CopilotUsersView dataRevision={0} />);
    await screen.findByRole("button", { name: "Ada" });
    view.rerender(<CopilotUsersView dataRevision={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("User access was revoked.");
    expect(screen.queryByRole("region", { name: "Licensed users" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Licensed user summary")).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing the last saved user snapshot/)).not.toBeInTheDocument();
  });

  it("labels a retained partial directory assignment as last saved rather than current", async () => {
    const data = structuredClone(copilotUsageFixture);
    data.sources.directory.state = "partial";
    data.sources.directory.message = "The last directory sync failed; retained assignments remain visible.";
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    render(<CopilotUsersView />);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    const detail = screen.getByRole("dialog", { name: "Ada" });
    expect(within(detail).getByText("Last saved Entra assignment")).toBeVisible();
    expect(within(detail).queryByText("Current Entra assignment")).not.toBeInTheDocument();
  });

  it("closes a selected user detail rather than silently replacing its report on revision changes", async () => {
    const view = render(<CopilotUsersView dataRevision={0} />);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    expect(screen.getByRole("dialog", { name: "Ada" })).toBeVisible();
    view.rerender(<CopilotUsersView dataRevision={1} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(getCopilotUsageUsers).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not revive verified assignments or an old dialog on an A-B-A revision transition", async () => {
    let resolveB!: (value: typeof copilotUsageFixture) => void;
    let resolveA!: (value: typeof copilotUsageFixture) => void;
    vi.mocked(getCopilotUsageUsers).mockResolvedValueOnce(structuredClone(copilotUsageFixture))
      .mockReturnValueOnce(new Promise(done => { resolveB = done; }))
      .mockReturnValueOnce(new Promise(done => { resolveA = done; }));
    const view = render(<CopilotUsersView dataRevision={0} />);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    view.rerender(<CopilotUsersView dataRevision={1} />);
    view.rerender(<CopilotUsersView dataRevision={0} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/Showing the last saved user snapshot/)).toBeVisible();
    expect(within(screen.getByLabelText("Licensed user summary")).getByText("Licensed users").parentElement).toHaveTextContent("Unknown");
    await act(async () => resolveB(structuredClone(copilotUsageFixture)));
    expect(screen.getByText(/Showing the last saved user snapshot/)).toBeVisible();
    await act(async () => resolveA(structuredClone(copilotUsageFixture)));
    expect(screen.queryByText(/Showing the last saved user snapshot/)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the licensed-user dialog across external subview navigation without reviving it on return", async () => {
    const route = { view: "licenses", search: "", page: 0 } as const;
    const view = render(<CopilotUsersView route={route} />);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    view.rerender(<CopilotUsersView route={{ ...route, view: "activity" }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(<CopilotUsersView route={route} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("aborts an old principal request and ignores its late completion", async () => {
    let resolve!: (value: typeof copilotUsageFixture) => void;
    vi.mocked(getCopilotUsageUsers).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const { unmount } = render(<CopilotUsersView />);
    await waitFor(() => expect(getCopilotUsageUsers).toHaveBeenCalledOnce());
    const signal = vi.mocked(getCopilotUsageUsers).mock.calls[0][0]!.signal!;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(copilotUsageFixture));
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
  });

  it("retries saved reads without starting a collection job", async () => {
    vi.mocked(getCopilotUsageUsers).mockRejectedValueOnce(new Error("Saved users could not be read"));
    render(<CopilotUsersView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved users could not be read");
    await userEvent.click(screen.getByRole("button", { name: "Retry saved users" }));
    expect(await screen.findByRole("button", { name: "Ada" })).toBeVisible();
    expect(getCopilotUsageUsers).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Sync users" })).not.toBeInTheDocument();
  });

  it("makes every unlinked identity searchable and paged with same-page snapshot-scoped activity", async () => {
    const data = structuredClone(copilotUsageFixture);
    data.unresolvedImportedIdentities = Array.from({ length: 153 }, (_, index) => ({
      ...data.unresolvedImportedIdentities[0],
      importedUsage: { ...data.unresolvedImportedIdentities[0].importedUsage, username: `concealed-${index}`, displayName: `Concealed ${index}` },
    }));
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    const onRouteChange = vi.fn();
    render(<CopilotUsersView onRouteChange={onRouteChange} />);
    await userEvent.click(await screen.findByText("Unlinked report identities (153)"));
    const table = screen.getByRole("region", { name: "Unlinked report identities" });
    expect(within(table).getAllByRole("row")).toHaveLength(51);
    await userEvent.click(screen.getByRole("button", { name: "Next unlinked identities" }));
    expect(screen.getByLabelText("Unlinked identity pages")).toHaveTextContent("51-100 of 153");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search unlinked report identities" }), "concealed-152");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("Concealed 152")).toBeVisible();
    await userEvent.click(within(table).getByRole("button", { name: "View reported activity" }));
    expect(onRouteChange).toHaveBeenLastCalledWith({ view: "activity", search: "concealed-152", reportSetId: "synthetic-set", page: 0 }, false);
    expect(await screen.findByRole("region", { name: "Reported users" })).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("uses only user-level agent-report dates for table recency and leaves Office dates separate", async () => {
    const data = structuredClone(copilotUsageFixture);
    data.users[0].importedUsage!.userLastActivityDateUtc = undefined;
    data.users[0].appActivity!.lastActivityDate = "2026-09-19";
    data.users[1].importedUsage!.userLastActivityDateUtc = "2026-09-17";
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    await userEvent.selectOptions(screen.getByLabelText("Order by"), "activity");
    expect(userRows()[0]).toHaveTextContent("Ben");
    const ada = userRows().find(row => within(row).queryByRole("button", { name: "Ada" }))!;
    expect(ada).toHaveTextContent("Not reported");
    expect(ada).not.toHaveTextContent("Sep 19");
    expect(ada).toHaveTextContent("Users report only");
  });

  it("never searches a concealed identity in another snapshot when its saved report scope is missing", async () => {
    const data = structuredClone(copilotUsageFixture);
    data.unresolvedImportedIdentities[0].importedUsage.datasetScope.reportSetId = null;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    render(<CopilotUsersView />);
    await userEvent.click(await screen.findByText("Unlinked report identities (1)"));
    const table = screen.getByRole("region", { name: "Unlinked report identities" });
    expect(within(table).getByText("Concealed report user")).toBeVisible();
    expect(within(table).getByText("Report snapshot unavailable")).toBeVisible();
    expect(within(table).queryByRole("button", { name: "View reported activity" })).not.toBeInTheDocument();
  });

  it("retains but never presents partial license assignments as current or actionable", async () => {
    const data = structuredClone(copilotUsageFixture);
    data.sources.directory.state = "partial";
    data.users[0].licenses[0].state = "error";
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    expect(userRows()[0]).toHaveTextContent("Last saved: Assignment issue");
    expect(userRows()[0]).toHaveTextContent("Verify license inventory");
    expect(within(screen.getByLabelText("Licensed user summary")).getByText("Licensed users").parentElement).toHaveTextContent("Unknown");
    expect(screen.queryByText("Review assignment")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.getByText("Current license count unavailable; any listed assignments are last saved", { exact: false })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
  });

  it("aborts a late directory read when reported-user access is denied", async () => {
    let resolve!: (value: typeof copilotUsageFixture) => void;
    vi.mocked(getCopilotUsageUsers).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    vi.mocked(getOfficialUsageUsers).mockRejectedValueOnce(new ApiError(403, "forbidden", "Report user access revoked"));
    render(<CopilotUsersView route={{ view: "activity", search: "", page: 0 }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Report user access revoked");
    const signal = vi.mocked(getCopilotUsageUsers).mock.calls[0][0]!.signal!;
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(copilotUsageFixture));
    expect(screen.queryByText("Ada")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Reported users" })).not.toBeInTheDocument();
  });
});
