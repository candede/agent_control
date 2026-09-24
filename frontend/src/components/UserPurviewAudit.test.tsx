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
  PurviewAuditView: ({ initialUserPrincipalName }: { initialUserPrincipalName: string }) =>
    <div aria-label="Scoped user search">{initialUserPrincipalName}</div>,
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
  it("starts in the paid-user details modal and passes its verified directory identity", async () => {
    render(<CapabilityContext value={capability}><CopilotUsersView /></CapabilityContext>);
    expect(screen.queryByRole("button", { name: "Open Purview audit search" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    const dialog = within(screen.getByRole("dialog", { name: "Ada" }));
    await userEvent.click(dialog.getByRole("button", { name: "Open Purview audit search" }));
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
    await userEvent.click(dialog.getByRole("button", { name: "Open Purview audit search" }));
    expect(dialog.getByLabelText("Scoped user search")).toHaveTextContent("ada@example.invalid");
    view.rerender(<CapabilityContext value={capability}><ReportedUserDetail {...props} /></CapabilityContext>);
    expect(screen.queryByLabelText("Scoped user search")).not.toBeInTheDocument();
    expect(screen.getByText(/verified directory user principal name is required/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Purview audit search" })).not.toBeInTheDocument();
  });

  it("opens only on request and discards the search when the selected identity changes", async () => {
    const view = render(panel("one@example.invalid"));
    expect(screen.queryByLabelText("Scoped user search")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Purview audit search" }));
    expect(screen.getByLabelText("Scoped user search")).toHaveTextContent("one@example.invalid");
    view.rerender(panel("two@example.invalid"));
    expect(screen.queryByLabelText("Scoped user search")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Purview audit search" }));
    expect(screen.getByLabelText("Scoped user search")).toHaveTextContent("two@example.invalid");
    await userEvent.click(screen.getByRole("button", { name: "Close Purview audit search" }));
    expect(screen.queryByLabelText("Scoped user search")).not.toBeInTheDocument();
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
