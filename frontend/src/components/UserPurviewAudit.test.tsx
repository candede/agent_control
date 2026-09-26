import { createRef } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCopilotUsageUsers } from "../api/client";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { copilotUsageFixture } from "../test/copilotUsageFixture";
import { CopilotUsersView } from "./CopilotUsersView";
import { ReportedUserDetail } from "./ReportedUserDetail";
import { UserPurviewAudit } from "./UserPurviewAudit";

vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(), getCopilotUsageUsers: vi.fn(),
}));
vi.mock("./UserAgentResponsibility", () => ({ UserAgentResponsibility: () => null }));
vi.mock("./PurviewAuditView", () => ({
  PurviewAuditView: ({ userPrincipalName, active = true }: { userPrincipalName: string; active?: boolean }) =>
    active ? <div aria-label="Scoped user search">{userPrincipalName}</div> : null,
}));

const capability: ReturnType<typeof useCapabilityContext> = {
  user: { homeAccountId: "viewer", tenantId: "tenant", displayName: "Viewer", username: "viewer@example.invalid", roles: ["AgentControl.Viewer"] },
  views: [], loading: false, pending: false, error: undefined, now: Date.now(),
  reload: vi.fn(async () => {}), openPermissions: vi.fn(),
};

function panel(userPrincipalName?: string, access = capability) {
  return <CapabilityContext value={access}><UserPurviewAudit userPrincipalName={userPrincipalName} /></CapabilityContext>;
}

beforeEach(() => {
  vi.mocked(getCopilotUsageUsers).mockResolvedValue(copilotUsageFixture);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

describe("user audit entry point", () => {
  it("uses consistent lazy tabs, keyboard navigation and retained user-agent filters", async () => {
    const view = render(<CapabilityContext value={capability}><CopilotUsersView /></CapabilityContext>);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    const element = screen.getByRole("dialog", { name: "Ada" });
    const dialog = within(element);
    expect(dialog.getAllByRole("tab").map(tab => tab.textContent)).toEqual([
      "Overview", "Usage & agents", "Licenses", "Responsibility", "Purview audit",
    ]);
    expect(dialog.getByRole("tabpanel")).toHaveAccessibleName("Overview");
    expect(dialog.queryByLabelText("Scoped user search")).not.toBeInTheDocument();
    expect(dialog.queryByRole("list", { name: "Paid feature states" })).not.toBeInTheDocument();
    const overview = dialog.getByRole("tab", { name: "Overview" });
    overview.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(dialog.getByRole("tab", { name: "Usage & agents" })).toHaveFocus();
    await userEvent.type(dialog.getByRole("searchbox", { name: "Search this user's agents" }), "research");
    await userEvent.click(dialog.getByRole("tab", { name: "Licenses" }));
    expect(dialog.getByRole("list", { name: "Paid feature states" })).toBeVisible();
    await userEvent.click(dialog.getByRole("tab", { name: "Usage & agents" }));
    expect(dialog.getByRole("searchbox", { name: "Search this user's agents" })).toHaveValue("research");
    view.rerender(<CapabilityContext value={capability}><CopilotUsersView dataRevision={1} /></CapabilityContext>);
    expect(dialog.getByRole("tab", { name: "Usage & agents" })).toHaveAttribute("aria-selected", "true");
    expect(dialog.getByRole("searchbox", { name: "Search this user's agents" })).toHaveValue("research");
    dialog.getByRole("tab", { name: "Usage & agents" }).focus();
    await userEvent.keyboard("{End}");
    expect(dialog.getByRole("tab", { name: "Purview audit" })).toHaveFocus();
    expect(dialog.getByLabelText("Scoped user search")).toHaveTextContent("ada@example.invalid");
    await userEvent.keyboard("{Home}");
    expect(overview).toHaveFocus();
    expect(dialog.queryByLabelText("Scoped user search")).not.toBeInTheDocument();
    expect(element.querySelector("details")).toBeNull();
  });

  it("starts in the paid-user details modal and passes its verified directory identity", async () => {
    render(<CapabilityContext value={capability}><CopilotUsersView /></CapabilityContext>);
    expect(screen.queryByRole("button", { name: "Open Purview audit search" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    const dialog = within(screen.getByRole("dialog", { name: "Ada" }));
    await userEvent.click(dialog.getByRole("tab", { name: "Purview audit" }));
    expect(dialog.getByLabelText("Scoped user search")).toHaveTextContent("ada@example.invalid");
    expect(window.location.pathname).not.toBe("/audit");
  });

  it("uses the verified directory link in reported-user details and blocks unlinked report identities", async () => {
    const directory = copilotUsageFixture.users[0];
    const props = {
      user: directory.importedUsage!, hasRelationships: true,
      filters: { responsesOnly: false }, returnFocusTo: createRef<HTMLInputElement>(),
      onClose: vi.fn(), onFocusAgent: vi.fn(),
    };
    const view = render(<CapabilityContext value={capability}><ReportedUserDetail {...props} directoryUser={directory} /></CapabilityContext>);
    const dialog = within(screen.getByRole("dialog", { name: "Ada" }));
    await userEvent.click(dialog.getByRole("tab", { name: "Purview audit" }));
    expect(dialog.getByLabelText("Scoped user search")).toHaveTextContent("ada@example.invalid");
    view.rerender(<CapabilityContext value={capability}><ReportedUserDetail {...props} /></CapabilityContext>);
    expect(screen.queryByLabelText("Scoped user search")).not.toBeInTheDocument();
    expect(screen.getByText(/verified directory user principal name is required/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Purview audit search" })).not.toBeInTheDocument();
  });

  it("embeds the selected identity directly without another expandable control", () => {
    const view = render(panel("one@example.invalid"));
    expect(screen.getByLabelText("Scoped user search")).toHaveTextContent("one@example.invalid");
    view.rerender(panel("two@example.invalid"));
    expect(screen.getByLabelText("Scoped user search")).toHaveTextContent("two@example.invalid");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not guess a report-only identity or open searches without Viewer access", () => {
    const view = render(panel());
    expect(screen.getByText(/verified directory user principal name is required/)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    view.rerender(panel("one@example.invalid", { ...capability, user: { ...capability.user!, roles: [] } }));
    expect(screen.getByText("Viewer access is required to search Purview audit records.")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Scoped user search")).not.toBeInTheDocument();
  });
});
