import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, downloadOfficialUsageCsv, getAgentResponsibility, getCopilotUsageUsers, getOfficialUsageAgentDetail, getOfficialUsageUsers } from "../api/client";
import { downloadBlob } from "../agentExport";
import { copilotUsageFixture, licensedUser } from "../test/copilotUsageFixture";
import { activeWithoutPaidUsersFixture, usageAgentDetailFixture, usageUsersFixture } from "../test/usageInsightsFixture";
import { CopilotUsersView } from "./CopilotUsersView";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { responsibilityFixture, responsibilityOwnerId } from "../test/agentResponsibilityFixture";

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getCopilotUsageUsers: vi.fn(),
  getAgentResponsibility: vi.fn(),
  downloadOfficialUsageCsv: vi.fn(),
  getOfficialUsageUsers: vi.fn(),
  getOfficialUsageAgentDetail: vi.fn(),
}));
vi.mock("../agentExport", () => ({ downloadBlob: vi.fn() }));

function userRows() {
  return within(screen.getByRole("region", { name: "M365 Copilot license status" })).getAllByRole("row").slice(1);
}

describe("Paid M365 Copilot license dashboard", () => {
  beforeEach(() => {
    vi.mocked(getAgentResponsibility).mockImplementation(async query => responsibilityFixture(query?.objectId));
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(structuredClone(copilotUsageFixture));
    vi.mocked(getOfficialUsageUsers).mockImplementation(async query => activeWithoutPaidUsersFixture(query));
    vi.mocked(getOfficialUsageAgentDetail).mockResolvedValue(usageAgentDetailFixture());
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  });
  afterEach(() => { vi.resetAllMocks(); });

  it("deep-links a responsible person absent from paid/report cohorts without loading license or report data", async () => {
    render(<CopilotUsersView route={{ view: "responsibility", personId: responsibilityOwnerId, search: "", page: 0 }} />);
    expect(await screen.findByText("Responsible only")).toBeVisible();
    expect(getCopilotUsageUsers).not.toHaveBeenCalled();
    expect(getOfficialUsageUsers).not.toHaveBeenCalled();
    expect(getAgentResponsibility).toHaveBeenCalledWith(expect.objectContaining({ objectId: responsibilityOwnerId }), expect.anything());
    expect(screen.queryByLabelText("M365 Copilot license summary")).not.toBeInTheDocument();
  });

  it("adds exact responsibility alongside paid user's unchanged usage and license totals", async () => {
    const open = vi.fn();
    render(<CopilotUsersView onOpenAgent={open} />);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText("Responsible agent");
    expect(within(dialog).getByText("Agent responses").parentElement).toHaveTextContent("200");
    expect(getAgentResponsibility).toHaveBeenCalledWith(expect.objectContaining({ objectId: copilotUsageFixture.users[0].directory.objectId }), expect.anything());
    await userEvent.click(within(dialog).getByRole("button", { name: "Open agent Responsible agent" }));
    expect(open).toHaveBeenCalledWith("agent:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

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

  it("leads with effectively licensed users and keeps technical provenance collapsed", async () => {
    render(<CopilotUsersView />);
    expect(await screen.findByRole("button", { name: "Drew" })).toBeVisible();
    expect(userRows()).toHaveLength(4);
    expect(userRows()[3]).toHaveTextContent("Unknown");
    expect(screen.getByText("Microsoft 365 admin center Copilot Agents usage exports")).not.toBeVisible();
    expect(screen.queryByText("Concealed report user")).not.toBeInTheDocument();
    const metrics = screen.getByLabelText("M365 Copilot license summary");
    expect(within(metrics).getByText("Active M365 Copilot licensed users").parentElement).toHaveTextContent("4");
    expect(within(metrics).getByText("Agent usage unknown").parentElement).toHaveTextContent("1");
    expect(screen.queryByText("Unavailable in exports")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const cohort = screen.getByRole("combobox", { name: "User cohort" });
    expect(cohort).toHaveValue("licenses");
    expect(within(cohort).getAllByRole("option").map(option => [option.getAttribute("value"), option.textContent])).toEqual([
      ["licenses", "Paid M365 Copilot users"],
      ["activity", "Active users without paid Copilot"],
      ["responsibility", "Agent responsibility"],
    ]);
    expect(screen.queryByRole("button", { name: "M365 Copilot licenses" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reported activity" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Licensed users" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/^Effective paid M365 Copilot licenses and adoption/)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Paid license scope and coverage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All checked users" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Unlinked report identities/)).not.toBeInTheDocument();
    expect(screen.queryByText(/directory users checked|Containing bundles identify candidates|All matching Graph pages/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Basic Copilot Chat may be available/)).not.toBeInTheDocument();
    expect(within(metrics).getByText("Active M365 Copilot licensed users").parentElement)
      .toHaveTextContent("Verified paid access, not recent usage");
    expect(screen.queryByText(/Last successful sync:/)).not.toBeInTheDocument();
    expect(getOfficialUsageUsers).not.toHaveBeenCalled();
  });

  it("excludes disabled and unknown candidates from paid search and adoption metrics", async () => {
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
    expect(userRows().map(row => within(row).getByRole("button").textContent)).toEqual(["Ada", "Drew"]);
    expect(screen.getByRole("button", { name: "Licensed users" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/2 licensed users shown/)).toBeVisible();
    const usingAgents = within(screen.getByLabelText("M365 Copilot license summary")).getByText("Using agents").parentElement!;
    expect(within(usingAgents).getByText("1")).toBeVisible();
    expect(screen.queryByRole("button", { name: "All checked users" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Basic|Disabled|Copilot Disabled)$/)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Search users or agents"), "Ben");
    expect(screen.getByRole("heading", { name: "No users match" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Ben" })).not.toBeInTheDocument();
    expect(active).toHaveTextContent("2");
    expect(within(usingAgents).getByText("1")).toBeVisible();
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();
    expect(getOfficialUsageUsers).not.toHaveBeenCalled();
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

  it("defaults to verified licensed states, including grace and partial but never inferring licensing from usage", async () => {
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
    fixture.users[0].directory.accountEnabled = false;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "enabled" });
    expect(screen.getByRole("button", { name: "Licensed users" })).toHaveAttribute("aria-pressed", "true");
    expect(userRows().map(row => within(row).getByRole("button").textContent)).toEqual(["enabled", "warning", "partially_enabled"]);
    expect(userRows().every(row => within(row).queryByText("M365 Copilot licensed", { exact: true }))).toBe(true);
    expect(userRows()[0]).toHaveTextContent("Account disabled");
    expect(userRows()[1]).toHaveTextContent("Active (grace period)");
    expect(userRows()[2]).toHaveTextContent("Partially active");
    expect(screen.queryByRole("button", { name: "All checked users" })).not.toBeInTheDocument();
    for (const excluded of ["disabled", "suspended", "locked_out", "unknown"]) {
      expect(screen.queryByRole("button", { name: excluded })).not.toBeInTheDocument();
    }
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();
  });

  it("resets local pagination when changing paid adoption filters without revealing inactive candidates", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users = Array.from({ length: 103 }, (_, index) => licensedUser(index + 1, `Person${index}`, 200 - index));
    fixture.users[0].copilotServiceState = fixture.users[0].servicePlans[0].state = "disabled";
    fixture.counts.licensedUsers = 102;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Person1" });
    expect(screen.queryByRole("button", { name: "Person0" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByLabelText("Copilot user pages")).toHaveTextContent("51-100 of 102");
    await userEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.getByRole("heading", { name: "No users match" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Licensed users" }));
    expect(screen.getByLabelText("Copilot user pages")).toHaveTextContent("1-50 of 102");
    expect(userRows()[0]).toHaveTextContent("Person1");
    expect(screen.queryByRole("button", { name: "Person0" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Usage unknown" }));
    expect(screen.getByRole("heading", { name: "No users match" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Licensed users" }));
    expect(screen.getByLabelText("Copilot user pages")).toHaveTextContent("1-50 of 102");
    expect(userRows()[0]).toHaveTextContent("Person1");
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();
    expect(getOfficialUsageUsers).not.toHaveBeenCalled();
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
    await screen.findByRole("heading", { name: "No active M365 Copilot licenses found" });
    const metrics = within(screen.getByLabelText("M365 Copilot license summary"));
    expect(within(metrics.getByText("Active M365 Copilot licensed users").parentElement!).getByText("0")).toBeVisible();
    for (const label of ["Using agents", "Needs attention", "Agent usage unknown"]) {
      const metric = metrics.getByText(label).parentElement!;
      expect(within(metric).getByText("0")).toBeVisible();
      expect(metric).toHaveTextContent("Licensed users");
    }
    expect(screen.queryByRole("region", { name: "M365 Copilot license status" })).not.toBeInTheDocument();
    expect(screen.queryByText("M365 Copilot licensed", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No active M365 Copilot licenses found" })).toBeVisible();
    expect(screen.queryByText(/Unlinked report identities/)).not.toBeInTheDocument();
    expect(screen.queryByText("Concealed report user")).not.toBeInTheDocument();
    expect(screen.queryByText("30,000")).not.toBeInTheDocument();
  });

  it("restricts every adoption cohort and KPI to licensed users while keeping agent-only unknown distinct from app coverage", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users = [
      licensedUser(1, "Active", 20), licensedUser(2, "Grace", 2), licensedUser(3, "Partial", null),
      licensedUser(4, "Disabled", 500), licensedUser(5, "Suspended", 0),
      licensedUser(6, "Locked", null), licensedUser(7, "Unverified", 600),
    ];
    const states = ["enabled", "warning", "partially_enabled", "disabled", "suspended", "locked_out", "unknown"] as const;
    fixture.users.forEach((user, index) => {
      user.copilotServiceState = states[index];
      user.servicePlans[0].state = states[index] === "partially_enabled" ? "enabled" : states[index];
      user.appActivity = null;
    });
    fixture.counts.licensedUsers = 3;
    fixture.counts.unknownMetricsUsers = 3;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Active" });
    const metrics = within(screen.getByLabelText("M365 Copilot license summary"));
    const assertCounts = () => {
      for (const [label, count] of [["Active M365 Copilot licensed users", "3"], ["Using agents", "2"], ["Needs attention", "2"], ["Agent usage unknown", "1"]]) {
        expect(within(metrics.getByText(label).parentElement!).getByText(count)).toBeVisible();
      }
    };
    assertCounts();
    expect(userRows().map(row => within(row).getByRole("button").textContent)).toEqual(["Active", "Grace", "Partial"]);
    await userEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(userRows().map(row => within(row).getByRole("button").textContent)).toEqual(["Grace", "Partial"]);
    await userEvent.click(screen.getByRole("button", { name: "Usage unknown" }));
    expect(userRows().map(row => within(row).getByRole("button").textContent)).toEqual(["Partial"]);
    await userEvent.click(screen.getByRole("button", { name: "Licensed users" }));
    expect(userRows()).toHaveLength(3);
    expect(screen.queryByText("No active M365 Copilot license", { exact: true })).not.toBeInTheDocument();
    assertCounts();
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
    expect(within(userRows()[0]).getAllByRole("cell")[1]).toHaveTextContent("M365 Copilot licensedPaid features: Active");
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

  it.each(["disabled", "suspended", "locked_out", "unknown"] as const)(
    "excludes %s candidates despite a containing bundle, raw Enabled evidence and activity", async state => {
    const fixture = structuredClone(copilotUsageFixture);
    const user = licensedUser(1, "Ada", 0);
    user.copilotServiceState = state;
    user.servicePlans[0].state = state;
    user.attention = ["app_activity_inactive"];
    Object.assign(user, { licenses: [{ skuPartNumber: "Microsoft_365_E7", state: "active" }] });
    fixture.users = [user];
    fixture.counts.licensedUsers = 0;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("heading", { name: "No active M365 Copilot licenses found" });
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "M365 Copilot license status" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All checked users" })).not.toBeInTheDocument();
    expect(screen.queryByText("M365 Copilot licensed", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Explore agents|Offer adoption help|Review app activity)$/)).not.toBeInTheDocument();
    expect(screen.getByText(/not a recommendation to remove a paid license/)).not.toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.getByRole("heading", { name: "No users match" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([
    ["disabled", "Not enabled"], ["suspended", "Suspended"],
    ["locked_out", "Locked out"], ["unknown", "Unverified"],
  ] as const)("shows mixed enabled and %s paid features as partially active without trusting raw Enabled evidence", async (state, label) => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users[0].copilotServiceState = "partially_enabled";
    fixture.users[0].servicePlans.push({
      servicePlanId: "b95945de-b3bd-46db-8437-f2beb6ea2347", service: "M365_COPILOT_TEAMS",
      displayName: "Microsoft 365 Copilot in Microsoft Teams", state,
      assignedDateTime: null, capabilityStatus: "Enabled",
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
    const inactiveFeature = within(services).getByText("Microsoft 365 Copilot in Microsoft Teams").parentElement!;
    expect(inactiveFeature).toHaveTextContent(label);
    expect(within(inactiveFeature).queryByText("Enabled")).not.toBeInTheDocument();
    expect(within(services).getByText("Microsoft 365 Copilot with Graph-grounded chat").parentElement).toHaveTextContent("Active");
    expect(within(services).getByText("M365_COPILOT_BUSINESS_CHAT")).toBeVisible();
    expect(within(detail).getAllByText(/^Raw capability status:/).every(item => !item.closest("details")?.open)).toBe(true);
    await userEvent.click(within(detail).getByText("Technical service-plan evidence"));
    expect(within(detail).getAllByText("Assigned at: Not reported")).toHaveLength(2);
    for (const raw of within(detail).getAllByText(/^Raw capability status:/)) {
      expect(raw).toBeVisible();
      expect(raw).toHaveTextContent("Raw capability status: Enabled");
    }
    expect(inactiveFeature).toHaveTextContent(label);
  });

  it("honors a separately enabled paid feature even when the other bundle features are not enabled", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    const user = licensedUser(1, "Ada", null);
    user.copilotServiceState = "partially_enabled";
    user.servicePlans[0].state = "disabled";
    user.servicePlans.push({
      servicePlanId: "b95945de-b3bd-46db-8437-f2beb6ea2347", service: "M365_COPILOT_TEAMS",
      displayName: "Microsoft 365 Copilot in Microsoft Teams", state: "enabled",
      assignedDateTime: "2026-09-12T00:00:00.000Z", capabilityStatus: "Enabled",
    });
    fixture.users = [user];
    fixture.counts.licensedUsers = 1;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    expect(userRows()).toHaveLength(1);
    expect(within(userRows()[0]).getByText("M365 Copilot licensed", { exact: true })).toBeVisible();
    const detail = screen.getByRole("dialog", { name: "Ada" });
    expect(within(detail).getByText("M365 Copilot licensed", { exact: true })).toBeVisible();
    const plans = within(detail).getByRole("list", { name: "Paid feature states" });
    expect(within(plans).getByText("Microsoft 365 Copilot in Productivity Apps").parentElement).toHaveTextContent("Not enabled");
    expect(within(plans).getByText("Microsoft 365 Copilot in Microsoft Teams").parentElement).toHaveTextContent("Active");
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

    const table = await screen.findByRole("region", { name: "M365 Copilot license status" });
    const responseHeader = within(table).getByRole("columnheader", { name: "Agent responses" });
    expect(responseHeader).toHaveAttribute("aria-sort", "descending");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByLabelText("Copilot user pages")).toHaveTextContent("51-100 of 2,053");

    await userEvent.click(within(responseHeader).getByRole("button", { name: "Sort by Agent responses" }));
    expect(screen.getByLabelText("Copilot user pages")).toHaveTextContent("1-50 of 2,053");
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
    ["M365 Copilot license", "license-asc", "license-desc", [0, 3, 1, 2], [2, 1, 0, 3]],
    ["Agent responses", "responses-asc", "responses-desc", [2, 1, 0, 3], [0, 1, 2, 3]],
    ["Agents used", "agents-asc", "agents-desc", [2, 1, 0, 3], [0, 1, 2, 3]],
    ["Agent-report last activity", "activity-asc", "activity", [2, 1, 0, 3], [0, 1, 2, 3]],
    ["Follow-up", "follow-up-asc", "follow-up-desc", [1, 2, 3, 0], [0, 3, 1, 2]],
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
    data.users[1].copilotServiceState = data.users[1].servicePlans[0].state = "warning";
    data.users[2].copilotServiceState = "partially_enabled";
    data.counts.licensedUsers = 4;
    data.users[3].importedUsage!.missingUserReport = true;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    render(<CopilotUsersView />);
    const table = await screen.findByRole("region", { name: "M365 Copilot license status" });
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
    await screen.findByRole("region", { name: "M365 Copilot license status" });
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
    const initial = activeWithoutPaidUsersFixture();
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
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "User cohort" }), "activity");
    await screen.findByRole("region", { name: "Active users without paid Copilot" });
    await userEvent.click(screen.getByRole("button", { name: "Next users" }));
    await waitFor(() => expect(getOfficialUsageUsers).toHaveBeenLastCalledWith(
      expect.objectContaining({ licenseCohort: "active_without_paid", sortBy: "responses", sortDirection: "desc", offset: 50 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));

    await userEvent.click(within(screen.getByRole("region", { name: "Active users without paid Copilot" }))
      .getByRole("button", { name: "Sort by Reported user" }));
    await waitFor(() => expect(getOfficialUsageUsers).toHaveBeenLastCalledWith(
      expect.objectContaining({ licenseCohort: "active_without_paid", sortBy: "displayName", sortDirection: "asc", offset: 0 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(screen.getByLabelText("Order reported users by")).toHaveValue("name");
    const ascendingHeader = within(screen.getByRole("region", { name: "Active users without paid Copilot" }))
      .getByRole("columnheader", { name: "Reported user" });
    expect(ascendingHeader).toHaveAttribute("aria-sort", "ascending");
    expect(within(ascendingHeader).getByRole("button", { name: "Sort by Reported user" })).toHaveFocus();

    await userEvent.click(within(screen.getByRole("region", { name: "Active users without paid Copilot" }))
      .getByRole("button", { name: "Sort by Reported user" }));
    await waitFor(() => expect(getOfficialUsageUsers).toHaveBeenLastCalledWith(
      expect.objectContaining({ licenseCohort: "active_without_paid", sortBy: "displayName", sortDirection: "desc", offset: 0 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(screen.getByLabelText("Order reported users by")).toHaveValue("name-desc");

    await userEvent.click(screen.getByRole("button", { name: "Export users CSV" }));
    await waitFor(() => expect(downloadOfficialUsageCsv).toHaveBeenCalledWith(
      "users",
      expect.objectContaining({ licenseCohort: "active_without_paid", sortBy: "displayName", sortDirection: "desc" }),
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

  it("requests the server-filtered active-without-paid cohort even when the local directory roster is unavailable", async () => {
    const data = structuredClone(copilotUsageFixture);
    data.sources.directory.state = "unavailable";
    data.users = [];
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    const onRouteChange = vi.fn();
    render(<CopilotUsersView onRouteChange={onRouteChange} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "User cohort" }), "activity");
    const activity = await screen.findByRole("region", { name: "Active users without paid Copilot" });
    expect(within(activity).getByRole("row", { name: /Cleo/ })).toBeVisible();
    expect(within(activity).getByRole("row", { name: /Ben/ })).toBeVisible();
    expect(within(activity).queryByText("Ada")).not.toBeInTheDocument();
    expect(within(activity).queryByText("Concealed report user")).not.toBeInTheDocument();
    expect(within(activity).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByRole("combobox", { name: "User cohort" })).toHaveValue("activity");
    expect(onRouteChange).toHaveBeenLastCalledWith({ view: "activity", search: "", page: 0 }, false);
    expect(getOfficialUsageUsers).toHaveBeenLastCalledWith(
      expect.objectContaining({ licenseCohort: "active_without_paid" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "User cohort" }), "licenses");
    expect(onRouteChange).toHaveBeenLastCalledWith({ view: "licenses", search: "", page: 0 }, false);
    expect(screen.queryByRole("region", { name: "Active users without paid Copilot" })).not.toBeInTheDocument();
  });

  it("keeps the paid user's complete agent breakdown local, searchable, sortable and paged without cohort navigation", async () => {
    const data = structuredClone(copilotUsageFixture);
    const imported = data.users[0].importedUsage!;
    imported.rows = Array.from({ length: 105 }, (_, index) => ({
      ...imported.rows[0], agentId: `report-agent-${index}`, displayAgentName: `Researcher ${index}`,
      responsesSentToUsers: index,
    }));
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    const onRouteChange = vi.fn();
    render(<CopilotUsersView onRouteChange={onRouteChange} />);
    const trigger = await screen.findByRole("button", { name: "Ada" });
    await userEvent.click(trigger);
    const detail = screen.getByRole("dialog", { name: "Ada" });
    const breakdown = within(detail).getByRole("region", { name: "User agent breakdown" });
    const rows = () => within(breakdown).getAllByRole("row").slice(1);
    expect(rows()).toHaveLength(50);
    expect(rows()[0]).toHaveTextContent("Researcher 104");
    expect(within(breakdown).queryByRole("button", { name: /Researcher|active users without paid Copilot/i })).not.toBeInTheDocument();
    await userEvent.click(within(detail).getByRole("button", { name: "Next agents" }));
    expect(within(detail).getByLabelText("User agent pages")).toHaveTextContent("51-100 of 105");
    await userEvent.click(within(detail).getByRole("button", { name: "Sort by Responses to this user" }));
    expect(within(detail).getByLabelText("User agent pages")).toHaveTextContent("1-50 of 105");
    expect(rows()[0]).toHaveTextContent("Researcher 0");
    await userEvent.type(within(detail).getByRole("searchbox", { name: "Search this user's agents" }), "report-agent-104");
    expect(rows()).toHaveLength(1);
    const agentName = within(rows()[0]).getByText("Researcher 104");
    expect(agentName.closest("button, a")).toBeNull();
    await userEvent.click(agentName);
    expect(detail).toBeVisible();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: "User cohort" })).toHaveValue("licenses");
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();
    expect(getOfficialUsageUsers).not.toHaveBeenCalled();
    expect(getOfficialUsageAgentDetail).not.toHaveBeenCalled();
    expect(onRouteChange).not.toHaveBeenCalled();
    await userEvent.click(within(detail).getByRole("button", { name: "Close user details" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
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
    expect(screen.getByText(/current licensing unverified/)).toBeVisible();
    expect(screen.queryByText(/^0 licensed users shown/)).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("M365 Copilot license summary")).getByText("Active M365 Copilot licensed users").parentElement).toHaveTextContent("Unknown");
    expect(screen.queryByText(/Unlinked report identities/)).not.toBeInTheDocument();
    expect(screen.queryByText("Concealed report user")).not.toBeInTheDocument();
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
    expect(within(userRows()[0]).getAllByRole("cell")[1]).toHaveTextContent("M365 Copilot licensedPaid features: Active");
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

  it("pages and searches more than 4,000 paid users without including inactive candidates or dropping missing usage", async () => {
    const fixture = structuredClone(copilotUsageFixture);
    fixture.users = Array.from({ length: 4_053 }, (_, index) => {
      const user = licensedUser(index + 1, `Person${String(index).padStart(4, "0")}`, index < 10 ? 100 - index : null);
      if (index >= 4_003) user.copilotServiceState = user.servicePlans[0].state = "disabled";
      return user;
    });
    fixture.counts.licensedUsers = 4_003;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(fixture);
    render(<CopilotUsersView />);
    await screen.findByRole("button", { name: "Person0000" });
    const active = within(screen.getByLabelText("M365 Copilot license summary")).getByText("Active M365 Copilot licensed users").parentElement!;
    expect(within(active).getByText("4,003")).toBeVisible();
    expect(userRows()).toHaveLength(50);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(userRows()).toHaveLength(50);
    expect(screen.getByLabelText("Copilot user pages")).toHaveTextContent("51-100 of 4,003");
    const search = screen.getByLabelText("Search users or agents");
    await userEvent.type(search, "person4002");
    expect(userRows()).toHaveLength(1);
    expect(userRows()[0]).toHaveTextContent("Person4002");
    expect(userRows()[0]).toHaveTextContent("Unknown");
    expect(userRows()[0]).toHaveTextContent("M365 Copilot licensed");
    expect(screen.queryByLabelText("Copilot user pages")).not.toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, "person4052");
    expect(screen.getByRole("heading", { name: "No users match" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Person4052" })).not.toBeInTheDocument();
    expect(within(active).getByText("4,003")).toBeVisible();
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
    expect(screen.getByText(/Showing the last saved user snapshot/)).toHaveTextContent("unverified until saved users reload");
    expect(screen.queryByRole("region", { name: "Paid license scope and coverage" })).not.toBeInTheDocument();
    expect(within(userRows()[0]).getAllByRole("cell")[1]).toHaveTextContent("Last saved: M365 Copilot licensed");

    view.rerender(<CopilotUsersView dataRevision={2} />);
    expect(await screen.findByRole("button", { name: "Ada" })).toBeVisible();
    expect(getCopilotUsageUsers).toHaveBeenCalledTimes(3);
  });

  it("keeps server-verified cohort membership but withholds feature detail during a failed directory reload", async () => {
    const data = structuredClone(copilotUsageFixture);
    data.users = data.users.map(user => ({
      ...user,
      importedUsage: usageUsersFixture().users.value.find(row => row.username === user.directory.userPrincipalName) ?? null,
    }));
    data.users[1].copilotServiceState = data.users[1].servicePlans[0].state = "disabled";
    data.users[2].copilotServiceState = data.users[2].servicePlans[0].state = "disabled";
    let reject!: (error: Error) => void;
    vi.mocked(getCopilotUsageUsers).mockResolvedValueOnce(data)
      .mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    const route = { view: "activity", search: "", page: 0 } as const;
    const view = render(<CopilotUsersView route={route} dataRevision={0} />);
    const activity = await screen.findByRole("region", { name: "Active users without paid Copilot" });
    await waitFor(() => expect(within(activity).getByRole("row", { name: /Ben/ })).toHaveTextContent("No active M365 Copilot license"));
    expect(within(activity).queryByRole("row", { name: /Ada/ })).not.toBeInTheDocument();

    view.rerender(<CopilotUsersView route={route} dataRevision={1} />);
    const refreshedActivity = await screen.findByRole("region", { name: "Active users without paid Copilot" });
    expect(within(refreshedActivity).getByRole("row", { name: /Ben/ })).toHaveTextContent("No active M365 Copilot license");
    expect(within(refreshedActivity).getByRole("row", { name: /Ben/ })).not.toHaveTextContent("Paid features:");
    await act(async () => reject(new Error("Saved users temporarily unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved users temporarily unavailable");
    expect(within(refreshedActivity).getByRole("row", { name: /Ben/ })).toHaveTextContent("No active M365 Copilot license");
    await userEvent.click(within(refreshedActivity).getByRole("button", { name: "View reported details for Ben" }));
    expect(within(screen.getByRole("dialog", { name: "Ben" })).getByText("M365 Copilot license").parentElement).toHaveTextContent("No active M365 Copilot license");
    expect(within(screen.getByRole("dialog", { name: "Ben" })).queryByRole("region", { name: "Microsoft 365 Copilot paid features" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("clears retained user data after read authorization is revoked", async () => {
    vi.mocked(getCopilotUsageUsers).mockResolvedValueOnce(structuredClone(copilotUsageFixture))
      .mockRejectedValueOnce(new ApiError(403, "missing_internal_role", "User access was revoked."));
    const view = render(<CopilotUsersView dataRevision={0} />);
    await screen.findByRole("button", { name: "Ada" });
    view.rerender(<CopilotUsersView dataRevision={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("User access was revoked.");
    expect(screen.queryByRole("region", { name: "M365 Copilot license status" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("M365 Copilot license summary")).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing the last saved user snapshot/)).not.toBeInTheDocument();
  });

  it.each(["partial", "stale", "unavailable"] as const)("labels retained %s entitlement as last saved without current counts or recommendations", async state => {
    const data = structuredClone(copilotUsageFixture);
    data.sources.directory.state = state;
    data.sources.directory.message = "The last directory sync failed; retained candidate evidence remains visible.";
    data.users[1].copilotServiceState = data.users[1].servicePlans[0].state = "disabled";
    data.counts.licensedUsers = 3;
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    render(<CopilotUsersView />);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    const detail = screen.getByRole("dialog", { name: "Ada" });
    expect(within(detail).getByText("Last saved: M365 Copilot licensed")).toHaveClass("unknown");
    expect(within(detail).queryByText("M365 Copilot licensed", { exact: true })).not.toBeInTheDocument();
    expect(within(detail).getByText(/Last saved paid-feature evidence/)).toBeVisible();
    expect(within(detail).getAllByText("Last saved: Active")).toHaveLength(2);
    expect(screen.getByText(/Current paid license inventory is unverified/)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Paid license scope and coverage" })).not.toBeInTheDocument();
    const metric = within(screen.getByLabelText("M365 Copilot license summary")).getByText("Active M365 Copilot licensed users").parentElement!;
    expect(within(metric).getByText("Unknown")).toBeVisible();
    await userEvent.click(within(detail).getByRole("button", { name: "Close user details" }));
    expect(userRows()).toHaveLength(3);
    expect(screen.getByText(/Last saved: 3 previously licensed users shown; current licensing unverified/)).toBeVisible();
    expect(screen.queryByText("M365 Copilot licensed", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Offer adoption help|Explore agents|Review paid features)$/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All checked users" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ben" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.queryByRole("region", { name: "M365 Copilot license status" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No last-saved users in this cohort" })).toBeVisible();
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

  it("moves users between the paid and server-filtered unpaid cohorts after a new sync revision", async () => {
    const previous = structuredClone(copilotUsageFixture);
    previous.users[1].copilotServiceState = previous.users[1].servicePlans[0].state = "disabled";
    previous.users[2].copilotServiceState = previous.users[2].servicePlans[0].state = "disabled";
    previous.counts.licensedUsers = 2;
    const current = structuredClone(previous);
    current.users[0].copilotServiceState = current.users[0].servicePlans[0].state = "disabled";
    current.users[1].copilotServiceState = current.users[1].servicePlans[0].state = "enabled";
    let resolveCurrent!: (value: typeof copilotUsageFixture) => void;
    vi.mocked(getCopilotUsageUsers).mockResolvedValueOnce(previous)
      .mockReturnValueOnce(new Promise(resolve => { resolveCurrent = resolve; }));
    let synced = false;
    vi.mocked(getOfficialUsageUsers).mockImplementation(async query => {
      const result = activeWithoutPaidUsersFixture(query);
      if (!synced) return result;
      const ada = usageUsersFixture().users.value.find(user => user.displayName === "Ada")!;
      return {
        ...result,
        users: { ...result.users, value: [ada, ...result.users.value.filter(user => user.displayName !== "Ben")] },
      };
    });
    const view = render(<CopilotUsersView dataRevision={0} />);
    await screen.findByRole("button", { name: "Ada" });
    expect(userRows().map(row => within(row).getByRole("button").textContent)).toEqual(["Ada", "Drew"]);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "User cohort" }), "activity");
    const previousUnpaid = await screen.findByRole("region", { name: "Active users without paid Copilot" });
    expect(within(previousUnpaid).getByRole("row", { name: /Ben/ })).toBeVisible();
    expect(within(previousUnpaid).queryByRole("row", { name: /Ada/ })).not.toBeInTheDocument();

    synced = true;
    view.rerender(<CopilotUsersView dataRevision={1} />);
    const currentUnpaid = await screen.findByRole("region", { name: "Active users without paid Copilot" });
    expect(within(currentUnpaid).getByRole("row", { name: /Ada/ })).toBeVisible();
    expect(within(currentUnpaid).queryByRole("row", { name: /Ben/ })).not.toBeInTheDocument();
    expect(getOfficialUsageUsers).toHaveBeenCalledTimes(2);
    for (const [query] of vi.mocked(getOfficialUsageUsers).mock.calls) {
      expect(query).toMatchObject({ licenseCohort: "active_without_paid" });
    }
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "User cohort" }), "licenses");
    expect(screen.getByText(/Showing the last saved user snapshot/)).toBeVisible();
    expect(userRows()[0]).toHaveTextContent("Last saved: M365 Copilot licensed");
    expect(within(screen.getByLabelText("M365 Copilot license summary"))
      .getByText("Active M365 Copilot licensed users").parentElement).toHaveTextContent("Unknown");
    await act(async () => resolveCurrent(current));
    expect(userRows().map(row => within(row).getByRole("button").textContent)).toEqual(["Ben", "Drew"]);
    expect(screen.queryByText(/Showing the last saved user snapshot/)).not.toBeInTheDocument();
    expect(getCopilotUsageUsers).toHaveBeenCalledTimes(2);
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

  it("does not surface unlinked report identities or their old search, paging and navigation controls", async () => {
    const data = structuredClone(copilotUsageFixture);
    data.unresolvedImportedIdentities = Array.from({ length: 153 }, (_, index) => ({
      ...data.unresolvedImportedIdentities[0],
      importedUsage: { ...data.unresolvedImportedIdentities[0].importedUsage, username: `concealed-${index}`, displayName: `Concealed ${index}` },
    }));
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(data);
    const onRouteChange = vi.fn();
    render(<CopilotUsersView onRouteChange={onRouteChange} />);
    await screen.findByRole("button", { name: "Ada" });
    expect(screen.queryByText(/Unlinked report identities/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Unlinked report identities" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next unlinked identities" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Unlinked identity pages")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search unlinked report identities" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View reported activity" })).not.toBeInTheDocument();
    expect(screen.queryByText("Concealed 152")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Search users or agents"), "concealed-152");
    expect(screen.getByRole("heading", { name: "No users match" })).toBeVisible();
    expect(onRouteChange).not.toHaveBeenCalled();
    expect(getOfficialUsageUsers).not.toHaveBeenCalled();
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
    await screen.findByRole("button", { name: "Ada" });
    expect(screen.queryByText("Concealed report user")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Unlinked report identities" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View reported activity" })).not.toBeInTheDocument();
    expect(getOfficialUsageUsers).not.toHaveBeenCalled();
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
    expect(await screen.findByText(/No saved user data\. Run Users sync/)).toBeVisible();
    expect(screen.queryByRole("region", { name: "M365 Copilot license status" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("M365 Copilot license summary")).getByText("Active M365 Copilot licensed users").parentElement).toHaveTextContent("Unknown");
    expect(screen.queryByText("Review paid features")).not.toBeInTheDocument();
    expect(screen.queryByText("Active", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Paid license scope and coverage" })).not.toBeInTheDocument();
    expect(screen.queryByText(/directory users checked|count checks completed/)).not.toBeInTheDocument();
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
    const metrics = await screen.findByLabelText("M365 Copilot license summary");
    expect(screen.queryByRole("region", { name: "Paid license scope and coverage" })).not.toBeInTheDocument();
    const metric = within(metrics).getByText("Active M365 Copilot licensed users").parentElement!;
    expect(within(metric).getByText(verified ? "0" : "Unknown")).toBeVisible();
    expect(screen.queryByRole("region", { name: "M365 Copilot license status" })).not.toBeInTheDocument();
    if (verified) {
      expect(screen.getByRole("heading", { name: "No active M365 Copilot licenses found" })).toBeVisible();
      expect(screen.queryByText(/Saved user snapshot is partial/)).not.toBeInTheDocument();
    } else {
      expect(screen.getByText(/Saved user snapshot is partial/)).toBeVisible();
      expect(screen.getByText(/Run Users Sync to verify the saved paid licenses/, { selector: "p" })).toBeVisible();
      expect(screen.getByText(/current licensing unverified/)).toBeVisible();
      expect(screen.queryByRole("heading", { name: "No active M365 Copilot licenses found" })).not.toBeInTheDocument();
      expect(screen.queryByText(/^0 licensed users shown/)).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/directory users checked|count checks completed/)).not.toBeInTheDocument();
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
    expect(screen.queryByRole("region", { name: "Active users without paid Copilot" })).not.toBeInTheDocument();
  });
});
