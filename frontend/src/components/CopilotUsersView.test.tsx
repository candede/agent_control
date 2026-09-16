import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCopilotUsageUsers } from "../api/client";
import { copilotUsageFixture, licensedUser } from "../test/copilotUsageFixture";
import { CopilotUsersView } from "./CopilotUsersView";

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getCopilotUsageUsers: vi.fn(),
}));

function userRows() {
  return within(screen.getByRole("region", { name: "Licensed users" })).getAllByRole("row").slice(1);
}

describe("Copilot license usage dashboard", () => {
  beforeEach(() => {
    vi.mocked(getCopilotUsageUsers).mockResolvedValue(structuredClone(copilotUsageFixture));
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
    await userEvent.click(screen.getByRole("button", { name: "Least active" }));
    expect(userRows().map(row => within(row).getByRole("button").textContent)).toEqual(["Cleo", "Ben", "Ada"]);
    await userEvent.click(screen.getByRole("button", { name: "Most active" }));
    expect(userRows().map(row => within(row).getByRole("button").textContent)).toEqual(["Ada", "Ben", "Cleo"]);
    await userEvent.click(screen.getByRole("button", { name: "Usage unknown" }));
    expect(userRows()).toHaveLength(1);
    expect(userRows()[0]).toHaveTextContent("Drew");
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();
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

  it("shows first-party agent totals, app dates and a scoped explicit interaction-log link", async () => {
    render(<CopilotUsersView />);
    const trigger = await screen.findByRole("button", { name: "Ada" });
    await userEvent.click(trigger);
    const detail = screen.getByRole("dialog", { name: "Ada" });
    expect(within(detail).getByText("Researcher")).toBeVisible();
    expect(within(detail).getByText("Microsoft")).toBeVisible();
    expect(within(detail).getByText("Outlook")).toBeVisible();
    expect(within(detail).getByText("Word").parentElement).toHaveTextContent("Sep 11, 2026");
    expect(within(detail).getByRole("link", { name: "Search interaction log" })).toHaveAttribute("href", "/audit?source=purview&user=ada%40example.invalid");
    expect(within(detail).queryByText("Sep 12, 2026", { exact: true })).not.toBeInTheDocument();
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
    expect(await screen.findByRole("link", { name: "Connect license data" })).toHaveAttribute("href", "/permissions");
    expect(screen.getByText(/License inventory unavailable/)).toHaveTextContent("User.Read.All");
    expect(screen.getByText(/Office app activity unavailable/)).toBeVisible();
    expect(screen.getByText(/Office app activity unavailable/)).toHaveTextContent("Reports.Read.All and Reports Reader");
    expect(screen.getByText(/License count unavailable/)).toBeVisible();
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

  it("starts an explicit users sync and preserves the last saved view while a post-sync reload fails", async () => {
    const onSyncUsers = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getCopilotUsageUsers).mockResolvedValueOnce(structuredClone(copilotUsageFixture))
      .mockRejectedValueOnce(new Error("Authorization changed"))
      .mockResolvedValueOnce(structuredClone(copilotUsageFixture));
    const view = render(<CopilotUsersView dataRevision={0} onSyncUsers={onSyncUsers} />);
    await screen.findByRole("button", { name: "Ada" });
    await userEvent.click(screen.getByRole("button", { name: "Sync users" }));
    expect(onSyncUsers).toHaveBeenCalledOnce();
    expect(getCopilotUsageUsers).toHaveBeenCalledOnce();

    view.rerender(<CopilotUsersView dataRevision={1} onSyncUsers={onSyncUsers} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Authorization changed");
    expect(screen.getByRole("button", { name: "Ada" })).toBeVisible();

    view.rerender(<CopilotUsersView dataRevision={2} onSyncUsers={onSyncUsers} />);
    expect(await screen.findByRole("button", { name: "Ada" })).toBeVisible();
    expect(getCopilotUsageUsers).toHaveBeenCalledTimes(3);
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
});
