import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, downloadOfficialUsageCsv, getCopilotUsageUsers, getOfficialUsageAgentDetail, getOfficialUsageUsers } from "../api/client";
import { downloadBlob } from "../agentExport";
import { copilotUsageFixture, licensedUser } from "../test/copilotUsageFixture";
import { usageAgentDetailFixture, usageUsersFixture } from "../test/usageInsightsFixture";
import { CopilotUsersView } from "./CopilotUsersView";
import { SavedQueryProvider } from "./SavedQueryProvider";

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getCopilotUsageUsers: vi.fn(),
  downloadOfficialUsageCsv: vi.fn(),
  getOfficialUsageUsers: vi.fn(),
  getOfficialUsageAgentDetail: vi.fn(),
}));
vi.mock("../agentExport", () => ({ downloadBlob: vi.fn() }));

function userRows() {
  return within(screen.getByRole("region", { name: "Paid M365 Copilot license assignments" })).getAllByRole("row").slice(1);
}

describe("Paid M365 Copilot license dashboard", () => {
  beforeEach(() => {
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(structuredClone(copilotUsageFixture));
    vi.mocked(getOfficialUsageUsers).mockResolvedValue(usageUsersFixture());
    vi.mocked(getOfficialUsageAgentDetail).mockResolvedValue(usageAgentDetailFixture());
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  });
  afterEach(() => { vi.clearAllMocks(); });

  it("isolates a new data revision from a saved read kept alive by another observer", async () => {
    let completePrevious!: (value: typeof copilotUsageFixture) => void;
    const previous = new Promise<typeof copilotUsageFixture>(resolve => { completePrevious = resolve; });
    const currentData = structuredClone(copilotUsageFixture);
    currentData.users = currentData.users.map(user => ({
      ...user, directory: { ...user.directory, displayName: `Current ${user.directory.displayName}` },
    }));
    vi.mocked(getCopilotUsageUsers).mockReturnValueOnce(previous).mockResolvedValue(currentData);
    const panels = (revision: number) => <SavedQueryProvider>
      <section aria-label="Previous reader"><CopilotUsersView dataRevision={0} /></section>
      <section aria-label="Current reader"><CopilotUsersView dataRevision={revision} /></section>
    </SavedQueryProvider>;
    const view = render(panels(0));
    await waitFor(() => expect(getCopilotUsageUsers).toHaveBeenCalledOnce());
    const previousSignal = vi.mocked(getCopilotUsageUsers).mock.calls[0][0]?.signal;
    view.rerender(panels(1));
    const current = within(screen.getByRole("region", { name: "Current reader" }));
    expect(await current.findByRole("button", { name: "Current Ada" })).toBeVisible();
    expect(getCopilotUsageUsers).toHaveBeenCalledTimes(2);
    expect(previousSignal?.aborted).toBe(false);
    await act(async () => completePrevious(structuredClone(copilotUsageFixture)));
    expect(await within(screen.getByRole("region", { name: "Previous reader" })).findByRole("button", { name: "Ada" })).toBeVisible();
    expect(current.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
    expect(current.getByRole("button", { name: "Current Ada" })).toBeVisible();
  });

  it("leads with all paid license assignments and keeps technical provenance collapsed", async () => {
    render(<CopilotUsersView />);
    expect(await screen.findByRole("button", { name: "Drew" })).toBeVisible();
    expect(userRows()).toHaveLength(4);
    expect(userRows()[3]).toHaveTextContent("Unknown");
    expect(screen.getByText("Microsoft 365 admin center Copilot Agents usage exports")).not.toBeVisible();
    expect(screen.getByText("Concealed report user")).not.toBeVisible();
    const metrics = screen.getByLabelText("M365 Copilot license summary");
    expect(within(metrics).getByText("Active M365 Copilot licensed users").parentElement).toHaveTextContent("4");
    expect(within(metrics).getByText("Agent usage unknown").parentElement).toHaveTextContent("1");
    expect(screen.queryByText("Unavailable in exports")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "M365 Copilot licenses" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Basic Copilot Chat access and usage are not counted/)).toBeVisible();
    const scope = screen.getByRole("region", { name: "Paid license scope and coverage" });
    expect(scope).toHaveTextContent("4 paid-license users in the saved roster");
    expect(scope).toHaveTextContent("Not all tenant accounts");
    expect(scope).toHaveTextContent("server-side filtering spans the tenant; all matching Graph pages and count checks completed for this saved directory sync");
    expect(scope).toHaveTextContent("Basic Copilot Chat may remain available without a paid license or when paid features are not enabled");
    expect(scope).toHaveTextContent("This snapshot does not measure basic access or usage");
    expect(within(metrics).getByText("Active M365 Copilot licensed users").parentElement)
      .toHaveTextContent("Verified paid access, not recent usage");
    expect(screen.getByText(/Last successful sync:/)).toHaveTextContent("Sep 12, 2026");
  });

  it("uses the verified active count without hiding disabled or unknown service assignments", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users[1].copilotServiceState = "disabled";
    fixture.users[1].servicePlans[0].state = "disabled";
    fixture.users[2].copilotServiceState = "unknown";
    fixture.users[2].servicePlans[0].state = "unknown";
    fixture.users[2].servicePlans[0].capabilityStatus = null;
    fixture.counts.licensedUsers = 2;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    const active = within(screen.getByLabelText("M365 Copilot license summary")).getByText("Active M365 Copilot licensed users").parentElement;
    expect(active).toHaveTextContent("2");
    expect(userRows()).toHaveLength(4);
    expect(userRows()[1]).toHaveTextContent("Paid license assigned");
    expect(userRows()[1]).toHaveTextContent("Paid features: Not enabled");
    expect(userRows()[2]).toHaveTextContent("Paid license assigned");
    expect(userRows()[2]).toHaveTextContent("Paid features: Unverified");
    expect(screen.getByRole("button", { name: "All paid licenses" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/4 paid-license users shown/)).toBeVisible();
    expect(screen.queryByText(/^(Basic|Disabled|Copilot Disabled)$/)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Search users or agents"), "Ben");
    expect(userRows()).toHaveLength(1);
    expect(active).toHaveTextContent("2");
    expect(userRows()[0]).toHaveTextContent("Review paid features");
    expect(screen.getByRole("region", { name: "Paid license scope and coverage" })).toHaveTextContent("4 paid-license users in the saved roster");
  });

  it.each([0, null])("preserves the backend active count %s instead of inferring it from the roster", async count => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.counts.licensedUsers = count;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    expect(userRows()).toHaveLength(4);
    const metric = within(screen.getByLabelText("M365 Copilot license summary")).getByText("Active M365 Copilot licensed users").parentElement!;
    expect(within(metric).getByText(count === null ? "Unknown" : "0")).toBeVisible();
  });

  it("filters active paid licenses by verified features, including grace and partial states but never usage", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users = (["enabled", "warning", "disabled", "suspended", "locked_out", "unknown", "partially_enabled"] as const).map((state, index) => {
      const user = licensedUser(index + 1, state, index < 2 || state === "partially_enabled" ? null : 500);
      user.copilotServiceState = state;
      user.servicePlans[0].state = state === "partially_enabled" ? "enabled" : state;
      if (state === "partially_enabled") user.servicePlans.push({
        servicePlanId: "b95945de-b3bd-46db-8437-f2beb6ea2347", service: "M365_COPILOT_TEAMS",
        displayName: "Microsoft 365 Copilot in Microsoft Teams", state: "disabled",
        assignedDateTime: null, capabilityStatus: "Enabled",
      });
      return user;
    });
    fixture.counts.licensedUsers = 3;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "enabled" });
    expect(userRows()).toHaveLength(7);
    await userEvent.click(screen.getByRole("button", { name: "Active paid licenses" }));
    expect(screen.getByRole("button", { name: "Active paid licenses" })).toHaveAttribute("aria-pressed", "true");
    expect(userRows().map(row => within(row).getByRole("button").textContent)).toEqual(["enabled", "warning", "partially_enabled"]);
    expect(userRows().every(row => row.textContent?.includes("Paid license assigned"))).toBe(true);
    expect(userRows()[1]).toHaveTextContent("Active (grace period)");
    expect(userRows()[2]).toHaveTextContent("Partially active");
    await userEvent.click(screen.getByRole("button", { name: "All paid licenses" }));
    expect(userRows()).toHaveLength(7);
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();
  });

  it("resets pagination when changing between all and active paid licenses", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users = Array.from({ length: 103 }, (_, index) => licensedUser(index + 1, `Person${index}`, 200 - index));
    fixture.users[0].copilotServiceState = fixture.users[0].servicePlans[0].state = "disabled";
    fixture.counts.licensedUsers = 102;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Person0" });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByLabelText("Paid license assignment pages")).toHaveTextContent("51-100 of 103");
    await userEvent.click(screen.getByRole("button", { name: "Active paid licenses" }));
    expect(screen.getByLabelText("Paid license assignment pages")).toHaveTextContent("1-50 of 102");
    expect(userRows()[0]).toHaveTextContent("Person1");
    expect(screen.queryByRole("button", { name: "Person0" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "All paid licenses" }));
    expect(screen.getByLabelText("Paid license assignment pages")).toHaveTextContent("1-50 of 103");
    expect(userRows()[0]).toHaveTextContent("Person0");
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();
  });

  it("does not count basic Chat dates or unlinked report activity as active paid licenses", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users.forEach(user => {
      user.copilotServiceState = user.servicePlans[0].state = "disabled";
      user.appActivity!.copilotChatLastActivityDate = "2026-09-12";
    });
    fixture.counts.licensedUsers = 0;
    fixture.unresolvedImportedIdentities[0].importedUsage.reportedResponsesReceived = 30_000;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    const metrics = within(screen.getByLabelText("M365 Copilot license summary"));
    expect(within(metrics.getByText("Active M365 Copilot licensed users").parentElement!).getByText("0")).toBeVisible();
    expect(within(metrics.getByText("Using agents").parentElement!).getByText("2")).toBeVisible();
    expect(metrics.getByText("Using agents").parentElement).toHaveTextContent("Paid-license users");
    expect(metrics.getByText("Needs attention").parentElement).toHaveTextContent("Paid-license users");
    expect(metrics.getByText("Agent usage unknown").parentElement).toHaveTextContent("Paid-license users");
    expect(userRows()).toHaveLength(4);
    await userEvent.click(screen.getByRole("button", { name: "Active paid licenses" }));
    expect(screen.getByText("No users match")).toBeVisible();
    await userEvent.click(screen.getByText("Unlinked report identities (1)"));
    const unlinked = screen.getByRole("region", { name: "Unlinked report identities" });
    expect(unlinked).toHaveTextContent("30,000");
    expect(unlinked).toHaveTextContent("License not verified");
  });

  it.each(["service-only", "legacy extras"] as const)("shows canonical enabled services, never package provenance (%s)", async scenario => {
    const fixture = structuredClone(copilotUsageFixture);
    expect(fixture.users[0]).not.toHaveProperty("licenses");
    if (scenario === "legacy extras") {
      Object.assign(fixture.users[0], {
        licenses: [{
          skuId: "legacy-package-id", skuPartNumber: "Microsoft_365_E7", state: "error",
          disabledPlanIds: ["legacy-disabled-plan-id"],
          assignmentStates: [{ state: "Error", error: "legacy-package-error", assignedByGroup: "legacy-group-id" }],
        }],
      });
    }
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    expect(within(userRows()[0]).getAllByRole("cell")[1]).toHaveTextContent("Paid license assignedPaid features: Active");
    const detail = screen.getByRole("dialog", { name: "Ada" });
    const services = within(detail).getByRole("list", { name: "Paid feature states" });
    expect(within(services).getByText("Microsoft 365 Copilot in Productivity Apps")).toBeVisible();
    expect(within(services).getByText("M365_COPILOT_APPS")).toBeVisible();
    expect(within(services).getByText("Active")).toBeVisible();
    expect(within(detail).getByText(/Service-plan ID:/)).not.toBeVisible();
    await userEvent.click(within(detail).getByText("Technical service-plan evidence"));
    expect(within(detail).getByText(/Service-plan ID:/)).toHaveTextContent(fixture.users[0].servicePlans[0].servicePlanId);
    expect(within(detail).getByText(/Assigned at:/)).toHaveTextContent("2026-08-01T00:00:00.000Z");
    expect(document.body).not.toHaveTextContent(/E7|SKU|legacy-package|legacy-disabled|legacy-group|Group assignment|Direct assignment|Disabled plans|Assignment error/i);
  });

  it.each([
    ["disabled", "Not enabled"],
    ["suspended", "Suspended"],
    ["locked_out", "Locked out"],
    ["unknown", "Unverified"],
  ] as const)("keeps %s effective service states despite raw Enabled evidence and low activity", async (state, label) => {
    const fixture = structuredClone(copilotUsageFixture);
    const user = licensedUser(1, "Ada", 0);
    user.copilotServiceState = state;
    user.servicePlans[0].state = state;
    user.attention = ["app_activity_inactive"];
    fixture.users = [user];
    fixture.counts.licensedUsers = 0;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    expect(within(userRows()[0]).getAllByRole("cell")[1]).toHaveTextContent(label);
    expect(within(userRows()[0]).getAllByRole("cell")[1]).toHaveTextContent("Paid license assigned");
    expect(within(userRows()[0]).getAllByRole("cell")[1]).not.toHaveTextContent(/Basic|Disabled/);
    expect(userRows()[0]).toHaveTextContent(state === "unknown" ? "Verify paid features" : "Review paid features");
    expect(screen.queryByText(/^(Explore agents|Offer adoption help|Review app activity)$/)).not.toBeInTheDocument();
    expect(screen.getByText(/not a recommendation to remove a paid license/)).not.toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(userRows()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Ada" }));
    const detail = screen.getByRole("dialog", { name: "Ada" });
    const services = within(detail).getByRole("list", { name: "Paid feature states" });
    expect(within(services).getByText(label)).toBeVisible();
    expect(within(services).queryByText("Enabled")).not.toBeInTheDocument();
    const rawCapability = within(detail).getByText(/^Raw capability status:/);
    expect(rawCapability).not.toBeVisible();
    await userEvent.click(within(detail).getByText("Technical service-plan evidence"));
    expect(rawCapability).toBeVisible();
    expect(rawCapability).toHaveTextContent("Raw capability status: Enabled");
    expect(within(services).getByText(label)).toBeVisible();
    const summary = within(detail).getByText("M365 Copilot license").parentElement!;
    expect(summary).toHaveTextContent("Paid license assigned");
    expect(summary).toHaveTextContent(`Paid features: ${label}`);
    expect(within(summary).queryByText(/^(Basic|Disabled)$/)).not.toBeInTheDocument();
  });

  it.each(["disabled", "unknown"] as const)("shows mixed enabled and %s paid features as partially active", async state => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users[0].copilotServiceState = "partially_enabled";
    fixture.users[0].servicePlans.push({
      servicePlanId: "b95945de-b3bd-46db-8437-f2beb6ea2347", service: "M365_COPILOT_TEAMS",
      displayName: "Microsoft 365 Copilot in Microsoft Teams", state,
      assignedDateTime: null, capabilityStatus: null,
    }, {
      servicePlanId: "3f30311c-6b1e-48a4-ab79-725b469da960", service: "M365_COPILOT_BUSINESS_CHAT",
      displayName: "Microsoft 365 Copilot with Graph-grounded chat", state: "enabled",
      assignedDateTime: null, capabilityStatus: "Enabled",
    });
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    expect(userRows()[0]).toHaveTextContent("Partially active");
    expect(userRows()[0]).toHaveTextContent("Review paid features");
    await userEvent.click(screen.getByRole("button", { name: "Ada" }));
    const detail = screen.getByRole("dialog", { name: "Ada" });
    expect(within(detail).getByText("M365 Copilot license").parentElement).toHaveTextContent("Partially active");
    const services = within(detail).getByRole("list", { name: "Paid feature states" });
    expect(within(services).getAllByRole("listitem")).toHaveLength(3);
    expect(within(services).getByText("Microsoft 365 Copilot in Productivity Apps").parentElement).toHaveTextContent("Active");
    expect(within(services).getByText("Microsoft 365 Copilot in Microsoft Teams").parentElement).toHaveTextContent(state === "disabled" ? "Not enabled" : "Unverified");
    expect(within(services).getByText("Microsoft 365 Copilot with Graph-grounded chat").parentElement).toHaveTextContent("Active");
    expect(within(services).getByText("M365_COPILOT_BUSINESS_CHAT")).toBeVisible();
    await userEvent.click(within(detail).getByText("Technical service-plan evidence"));
    expect(within(detail).getAllByText("Assigned at: Not reported")).toHaveLength(2);
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

  it("sorts the complete service snapshot before paging and resets the page from header sorting", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users = Array.from({ length: 2_053 }, (_, index) =>
      licensedUser(index + 1, `Person${String(index).padStart(4, "0")}`, index < 2_050 ? 2_050 - index : null));
    fixture.counts.licensedUsers = fixture.users.length;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);

    const table = await screen.findByRole("region", { name: "Paid M365 Copilot license assignments" });
    const responseHeader = within(table).getByRole("columnheader", { name: "Agent responses" });
    expect(responseHeader).toHaveAttribute("aria-sort", "descending");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByLabelText("Paid license assignment pages")).toHaveTextContent("51-100 of 2,053");

    await userEvent.click(within(responseHeader).getByRole("button", { name: "Sort by Agent responses" }));
    expect(screen.getByLabelText("Paid license assignment pages")).toHaveTextContent("1-50 of 2,053");
    expect(screen.getByLabelText("Order by")).toHaveValue("responses-asc");
    expect(responseHeader).toHaveAttribute("aria-sort", "ascending");
    expect(userRows()[0]).toHaveTextContent("Person2049");
    expect(userRows().some(row => row.textContent?.includes("Unknown"))).toBe(false);

    await userEvent.click(within(responseHeader).getByRole("button", { name: "Sort by Agent responses" }));
    expect(screen.getByLabelText("Order by")).toHaveValue("responses-desc");
    expect(responseHeader).toHaveAttribute("aria-sort", "descending");
    expect(userRows()[0]).toHaveTextContent("Person0000");
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();
  });

  it.each([
    ["User", "name", "name-desc", [2, 1, 0, 3], [3, 0, 1, 2]],
    ["M365 Copilot license", "license-asc", "license-desc", [0, 2, 1, 3], [3, 1, 2, 0]],
    ["Agent responses", "responses-asc", "responses-desc", [2, 1, 0, 3], [0, 1, 2, 3]],
    ["Agents used", "agents-asc", "agents-desc", [2, 1, 0, 3], [0, 1, 2, 3]],
    ["Agent-report last activity", "activity-asc", "activity", [2, 1, 0, 3], [0, 1, 2, 3]],
    ["Follow-up", "follow-up-asc", "follow-up-desc", [1, 2, 0, 3], [3, 0, 1, 2]],
  ] as const)("compares %s values in both directions and synchronizes keyboard headers with the selector", async (header, ascending, descending, ascOrder, descOrder) => {
    const data = structuredClone(copilotUsageFixture);
    data.users = [
      licensedUser(1, "Person10", 10), licensedUser(2, "Person2", 2),
      licensedUser(3, "Person0", 0), licensedUser(4, "PersonMissing", 999),
    ];
    data.users.forEach((user, index) => {
      user.importedUsage!.reportedAgentsUsed = [10, 2, 0, 999][index];
      user.importedUsage!.userLastActivityDateUtc = [
        "2026-10-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2025-12-31T00:00:00.000Z", undefined,
      ][index];
    });
    data.users[1].copilotServiceState = data.users[1].servicePlans[0].state = "suspended";
    data.users[2].copilotServiceState = data.users[2].servicePlans[0].state = "disabled";
    data.users[3].copilotServiceState = data.users[3].servicePlans[0].state = "unknown";
    data.counts.licensedUsers = 1;
    data.users[3].importedUsage!.missingUserReport = true;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    render(<CopilotUsersView />);
    const table = await screen.findByRole("region", { name: "Paid M365 Copilot license assignments" });
    const order = screen.getByLabelText("Order by");
    const names = () => userRows().map(row => within(row).getByRole("button").textContent);
    await userEvent.selectOptions(order, ascending);
    expect(names()).toEqual(ascOrder.map(index => data.users[index].directory.displayName));
    const heading = within(table).getByRole("columnheader", { name: header });
    expect(heading).toHaveAttribute("aria-sort", "ascending");
    const sortButton = within(heading).getByRole("button", { name: `Sort by ${header}` });
    sortButton.focus();
    await userEvent.keyboard("{Enter}");
    expect(names()).toEqual(descOrder.map(index => data.users[index].directory.displayName));
    expect(heading).toHaveAttribute("aria-sort", "descending");
    expect(order).toHaveValue(descending);
    expect(sortButton).toHaveFocus();
    const unknown = userRows().find(row => within(row).queryByRole("button", { name: "PersonMissing" }))!;
    expect(within(unknown).getAllByRole("cell")[2]).toHaveTextContent(/^Unknown$/);
    expect(within(unknown).getAllByRole("cell")[3]).toHaveTextContent(/^Unknown$/);
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();
  });

  it("keeps equal-name directory identities attached to their rows and selected details after reordering", async () => {
    const data = structuredClone(copilotUsageFixture);
    const high = licensedUser(1, "Kai", 10);
    const low = licensedUser(2, "Kai", 2);
    low.directory.userPrincipalName = "different-kai@example.invalid";
    data.users = [high, low];
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    render(<CopilotUsersView />);
    await screen.findByRole("region", { name: "Paid M365 Copilot license assignments" });
    const lowTrigger = within(userRows()[1]).getByRole("button", { name: "Kai" });
    await userEvent.click(screen.getByRole("button", { name: "Sort by Agent responses" }));
    expect(within(userRows()[0]).getByRole("button", { name: "Kai" })).toBe(lowTrigger);
    await userEvent.click(lowTrigger);
    const dialog = screen.getByRole("dialog", { name: "Kai" });
    expect(within(dialog).getByText(low.directory.userPrincipalName)).toBeVisible();
    expect(within(dialog).getByText("Agent responses").parentElement).toHaveTextContent("2");
    await userEvent.keyboard("{Escape}");
    expect(lowTrigger).toHaveFocus();
  });

  it("ignores the replayed first read under root React Strict Mode", async () => {
    let resolve!: (value: typeof copilotUsageFixture) => void;
    vi.mocked(getCopilotUsageUsers).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    render(<CopilotUsersView />, { reactStrictMode: true });
    expect(await screen.findByRole("button", { name: "Ada" })).toBeVisible();
    expect(getCopilotUsageUsers).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getCopilotUsageUsers).mock.calls[0][0]?.signal?.aborted).toBe(true);
    const old = structuredClone(copilotUsageFixture);
    old.users[0].directory.displayName = "Obsolete user";
    await act(async () => resolve(old));
    expect(screen.queryByRole("button", { name: "Obsolete user" })).not.toBeInTheDocument();
  });

  it("delegates reported-user header sorting to the backend and exports that same sort", async () => {
    const initial = usageUsersFixture();
    vi.mocked(getOfficialUsageUsers).mockImplementation(async (query = {}) => ({
      ...structuredClone(initial),
      users: { ...structuredClone(initial.users), count: 100, offset: query.offset ?? 0 },
      filters: {
        ...structuredClone(initial.filters),
        sortBy: query.sortBy ?? "responses",
        sortDirection: query.sortDirection ?? "desc",
      },
    }));
    vi.mocked(downloadOfficialUsageCsv).mockResolvedValue(new Blob(["csv"]));
    render(<CopilotUsersView />);
    await userEvent.click(screen.getByRole("button", { name: "Reported activity" }));
    await screen.findByRole("region", { name: "Reported users" });
    await userEvent.click(screen.getByRole("button", { name: "Next users" }));
    await waitFor(() => expect(getOfficialUsageUsers).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: "responses", sortDirection: "desc", offset: 50 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));

    await userEvent.click(within(screen.getByRole("region", { name: "Reported users" }))
      .getByRole("button", { name: "Sort by Reported user" }));
    await waitFor(() => expect(getOfficialUsageUsers).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: "displayName", sortDirection: "asc", offset: 0 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(screen.getByLabelText("Order reported users by")).toHaveValue("name");
    const ascendingHeader = within(screen.getByRole("region", { name: "Reported users" }))
      .getByRole("columnheader", { name: "Reported user" });
    expect(ascendingHeader).toHaveAttribute("aria-sort", "ascending");
    expect(within(ascendingHeader).getByRole("button", { name: "Sort by Reported user" })).toHaveFocus();

    await userEvent.click(within(screen.getByRole("region", { name: "Reported users" }))
      .getByRole("button", { name: "Sort by Reported user" }));
    await waitFor(() => expect(getOfficialUsageUsers).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: "displayName", sortDirection: "desc", offset: 0 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(screen.getByLabelText("Order reported users by")).toHaveValue("name-desc");

    await userEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    await waitFor(() => expect(downloadOfficialUsageCsv).toHaveBeenCalledWith(
      "users",
      expect.objectContaining({ sortBy: "displayName", sortDirection: "desc" }),
      expect.any(AbortSignal),
    ));
    expect(downloadBlob).toHaveBeenCalledWith("reported-user-activity.csv", expect.any(Blob));
  });

  it("shows saved company and department in user details and supports organization search", async () => {
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

  it("keeps null organization metadata explicitly unknown without hiding service assignments", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users[0].directory.companyName = null;
    fixture.users[0].directory.department = null;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    expect(userRows()).toHaveLength(4);
    const organization = within(screen.getByRole("dialog", { name: "Ada" })).getByRole("region", { name: "Saved directory organization" });
    expect(organization).toHaveTextContent("Company: Not reported");
    expect(organization).toHaveTextContent("Department: Not reported");
    expect(organization).not.toHaveTextContent("undefined");
  });

  it("makes reported activity a primary user view independent of the service roster", async () => {
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

  it("keeps missing service and Office data explicit and provides connection recovery", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users = [];
    fixture.sources.directory = { ...fixture.sources.directory, state: "unavailable", message: "User.Read.All permission required." };
    fixture.sources.appActivity = { ...fixture.sources.appActivity, state: "unavailable", message: "Reports.Read.All and Reports Reader are required." };
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    expect(await screen.findByText(/Current paid license inventory is unverified/)).toHaveTextContent("User.Read.All");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/Office app activity unavailable/)).toBeVisible();
    expect(screen.getByText(/Office app activity unavailable/)).toHaveTextContent("Reports.Read.All and Reports Reader");
    expect(screen.getByText(/Current paid-license count unavailable/)).toBeVisible();
    expect(screen.queryByText(/^0 paid-license users shown/)).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("M365 Copilot license summary")).getByText("Active M365 Copilot licensed users").parentElement).toHaveTextContent("Unknown");
    await userEvent.click(screen.getByText("Unlinked report identities (1)"));
    expect(screen.getByText("Concealed report user")).toBeVisible();
  });

  it("keeps service assignments visible when only report permission is denied", async () => {
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

  it("keeps a disabled directory account separate from a paid license with active features", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users[0].directory.accountEnabled = false;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Ada" });
    expect(within(userRows()[0]).getAllByRole("cell")[1]).toHaveTextContent("Paid license assignedPaid features: Active");
    expect(userRows()[0]).toHaveTextContent("Account disabled");
    expect(userRows()[0]).toHaveTextContent("Review disabled account");
    await userEvent.click(screen.getByRole("button", { name: "Ada" }));
    const detail = screen.getByRole("dialog", { name: "Ada" });
    expect(within(detail).getByText("M365 Copilot license").parentElement).toHaveTextContent("Paid features: Active");
    expect(within(detail).getByText(/Directory account:/)).toHaveTextContent("Account disabled");
  });

  it("shows usable grace-period services prominently and keeps raw capability evidence collapsed", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users[0].copilotServiceState = "warning";
    fixture.users[0].servicePlans[0].state = "warning";
    fixture.users[0].servicePlans[0].capabilityStatus = "Warning";
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    expect(userRows()[0]).toHaveTextContent("Active (grace period)");
    expect(userRows()[0]).toHaveTextContent("Review paid features");
    const detail = screen.getByRole("dialog", { name: "Ada" });
    const services = within(detail).getByRole("list", { name: "Paid feature states" });
    expect(within(services).getByText("Active (grace period)")).toBeVisible();
    expect(within(detail).getByText("Warning", { exact: true })).not.toBeVisible();
    await userEvent.click(within(detail).getByText("Technical service-plan evidence"));
    expect(within(detail).getByText("Warning", { exact: true })).toBeVisible();
    expect(within(detail).getByText(/Service-plan ID:/)).toHaveTextContent(fixture.users[0].servicePlans[0].servicePlanId);
    expect(within(detail).getByText(/Warning is a usable grace period/)).toBeVisible();
    expect(within(detail).queryByText(/Direct assignment|Group assignment/)).not.toBeInTheDocument();
  });

  it("counts and searches more than 4,000 paid license assignments independently of the visible page", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users = Array.from({ length: 4_053 }, (_, index) => licensedUser(index + 1, `Person${String(index).padStart(4, "0")}`, index < 10 ? 100 - index : null));
    fixture.counts.licensedUsers = fixture.users.length;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Person0000" });
    expect(within(screen.getByLabelText("M365 Copilot license summary")).getByText("Active M365 Copilot licensed users").parentElement).toHaveTextContent("4,053");
    expect(userRows()).toHaveLength(50);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(userRows()).toHaveLength(50);
    expect(screen.getByLabelText("Paid license assignment pages")).toHaveTextContent("51-100 of 4,053");
    await userEvent.type(screen.getByLabelText("Search users or agents"), "person4052");
    expect(userRows()).toHaveLength(1);
    expect(userRows()[0]).toHaveTextContent("Person4052");
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
    expect(within(screen.getByLabelText("M365 Copilot license summary")).getByText("Using agents").parentElement).toHaveTextContent("Unknown");
    const scope = screen.getByRole("region", { name: "Paid license scope and coverage" });
    expect(scope).toHaveTextContent("Last saved roster: 4 paid-license users");
    expect(scope).toHaveTextContent("Current paid-license coverage is unverified");
    expect(scope).not.toHaveTextContent(/all matching Graph pages and count checks completed/);
    expect(within(userRows()[0]).getAllByRole("cell")[1]).toHaveTextContent("Last saved: Paid license assigned");

    view.rerender(<CopilotUsersView dataRevision={2} />);
    expect(await screen.findByRole("button", { name: "Ada" })).toBeVisible();
    expect(getCopilotUsageUsers).toHaveBeenCalledTimes(3);
  });

  it("withholds current reported-user service states during and after a failed saved-user reload", async () => {
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
    await waitFor(() => expect(within(activity).getByRole("row", { name: /Ada/ })).toHaveTextContent("Paid license assigned"));

    view.rerender(<CopilotUsersView route={route} dataRevision={1} />);
    const refreshedActivity = await screen.findByRole("region", { name: "Reported users" });
    expect(within(refreshedActivity).getByRole("row", { name: /Ada/ })).toHaveTextContent("License not verified");
    await act(async () => reject(new Error("Saved users temporarily unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved users temporarily unavailable");
    expect(within(refreshedActivity).getByRole("row", { name: /Ada/ })).toHaveTextContent("License not verified");
    expect(within(refreshedActivity).getByRole("row", { name: /Ada/ })).not.toHaveTextContent("Paid license assigned");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("clears retained user data after read authorization is revoked", async () => {
    vi.mocked(getCopilotUsageUsers).mockResolvedValueOnce(structuredClone(copilotUsageFixture))
      .mockRejectedValueOnce(new ApiError(403, "missing_internal_role", "User access was revoked."));
    const view = render(<CopilotUsersView dataRevision={0} />);
    await screen.findByRole("button", { name: "Ada" });
    view.rerender(<CopilotUsersView dataRevision={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("User access was revoked.");
    expect(screen.queryByRole("region", { name: "Paid M365 Copilot license assignments" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("M365 Copilot license summary")).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing the last saved user snapshot/)).not.toBeInTheDocument();
  });

  it.each(["partial", "stale", "unavailable"] as const)("labels a retained %s directory assignment as last saved rather than current", async state => {
    const data = structuredClone(copilotUsageFixture);
    data.sources.directory.state = state;
    data.sources.directory.message = "The last directory sync failed; retained assignments remain visible.";
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    render(<CopilotUsersView />);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    const detail = screen.getByRole("dialog", { name: "Ada" });
    expect(within(detail).getByText("Last saved: Paid license assigned")).toBeVisible();
    expect(within(detail).queryByText("Paid license assigned", { exact: true })).not.toBeInTheDocument();
    expect(within(detail).getByText(/Last saved paid-feature evidence/)).toBeVisible();
    expect(within(detail).getAllByText("Last saved: Active")).toHaveLength(2);
    const scope = screen.getByRole("region", { name: "Paid license scope and coverage" });
    expect(scope).toHaveTextContent("Last saved roster: 4 paid-license users");
    expect(scope).toHaveTextContent("Current paid-license coverage is unverified");
    expect(scope).not.toHaveTextContent(/all matching Graph pages and count checks completed/);
    const metric = within(screen.getByLabelText("M365 Copilot license summary")).getByText("Active M365 Copilot licensed users").parentElement!;
    expect(within(metric).getByText("Unknown")).toBeVisible();
    await userEvent.click(within(detail).getByRole("button", { name: "Close user details" }));
    await userEvent.click(screen.getByRole("button", { name: "Active paid licenses" }));
    expect(screen.queryByRole("region", { name: "Paid M365 Copilot license assignments" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Verify the directory to see current paid licenses" })).toBeVisible();
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
    expect(within(screen.getByLabelText("M365 Copilot license summary")).getByText("Active M365 Copilot licensed users").parentElement).toHaveTextContent("Unknown");
    await act(async () => resolveB(structuredClone(copilotUsageFixture)));
    expect(screen.getByText(/Showing the last saved user snapshot/)).toBeVisible();
    await act(async () => resolveA(structuredClone(copilotUsageFixture)));
    expect(screen.queryByText(/Showing the last saved user snapshot/)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the service-user dialog across external subview navigation without reviving it on return", async () => {
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

  it("shows an empty roster after cached users are deleted and requests a fresh Users sync", async () => {
    const data = structuredClone(copilotUsageFixture);
    data.sources.directory.state = "unavailable";
    data.sources.directory.message = "Paid license data has not been synced for this account.";
    data.sources.directory.fetchedAt = null;
    data.snapshot = {
      state: "not_synced", lastAttemptAt: null, lastSuccessAt: null,
      directoryObservedAt: null, appActivityObservedAt: null,
    };
    data.counts.licensedUsers = null;
    data.users = [];
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    render(<CopilotUsersView />);
    expect(await screen.findByText("No saved user data. Run Users Sync.")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Paid M365 Copilot license assignments" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("M365 Copilot license summary")).getByText("Active M365 Copilot licensed users").parentElement).toHaveTextContent("Unknown");
    expect(screen.queryByText("Review paid features")).not.toBeInTheDocument();
    expect(screen.queryByText("Active", { exact: true })).not.toBeInTheDocument();
    const scope = screen.getByRole("region", { name: "Paid license scope and coverage" });
    expect(scope).toHaveTextContent("Paid-license user count unverified");
    expect(scope).not.toHaveTextContent(/0 paid-license users|count checks completed/);
  });

  it.each(["available", "partial"] as const)("distinguishes an empty %s snapshot from verified zero active services", async state => {
    const data = structuredClone(copilotUsageFixture);
    const verified = state === "available";
    data.users = [];
    data.unresolvedImportedIdentities = [];
    data.snapshot!.state = state;
    data.sources.directory.state = state;
    data.sources.directory.message = verified
      ? "Verified paid Microsoft 365 Copilot license inventory."
      : "Run Users Sync to verify the saved paid licenses.";
    data.counts = {
      licensedUsers: verified ? 0 : null, measuredActivityUsers: verified ? 0 : null,
      needsAttentionUsers: verified ? 0 : null, unknownMetricsUsers: verified ? 0 : null,
      unresolvedImportedIdentities: 0,
    };
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    render(<CopilotUsersView />);
    const scope = await screen.findByRole("region", { name: "Paid license scope and coverage" });
    expect(scope).toHaveTextContent(verified ? "0 paid-license users in the saved roster" : "Saved user snapshot is partial.");
    const metric = within(screen.getByLabelText("M365 Copilot license summary")).getByText("Active M365 Copilot licensed users").parentElement!;
    expect(within(metric).getByText(verified ? "0" : "Unknown")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Paid M365 Copilot license assignments" })).not.toBeInTheDocument();
    if (verified) {
      expect(screen.getByRole("heading", { name: "No paid Microsoft 365 Copilot license assignments found" })).toBeVisible();
      expect(scope).toHaveTextContent("all matching Graph pages and count checks completed");
    } else {
      expect(screen.getByText(/Run Users Sync to verify the saved paid licenses/, { selector: "p" })).toBeVisible();
      expect(screen.getByText(/Current paid-license count unavailable/)).toBeVisible();
      expect(screen.queryByRole("heading", { name: "No paid Microsoft 365 Copilot license assignments found" })).not.toBeInTheDocument();
      expect(screen.queryByText(/^0 paid-license users shown/)).not.toBeInTheDocument();
      expect(scope).not.toHaveTextContent(/0 paid-license users|count checks completed/);
    }
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
