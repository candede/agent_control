import { createRef } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readReportDetail, readReportPage } from "../api/reportData";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { combinedUser, reportPage, reports, reportUser, selectionId } from "../test/reportDataFixture";
import { mockNativeDialogs } from "../test/dialog";
import { CopilotUsersView } from "./CopilotUsersView";
import { UserDetailModal } from "./UserDetailModal";
import { UserPurviewAudit } from "./UserPurviewAudit";

mockNativeDialogs();

vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(), readReportPage: vi.fn(), readReportDetail: vi.fn(),
}));
vi.mock("./UserAgentResponsibility", () => ({ UserAgentResponsibility: () => null }));
vi.mock("./DefenderHuntingView", () => ({
  DefenderHuntingView: ({ userObjectId, active }: { userObjectId?: string; active?: boolean }) =>
    active ? <div aria-label="Scoped human hunt">{userObjectId}</div> : null,
}));
vi.mock("./AgentInvestigationsPanel", () => ({
  AgentInvestigationsPanel: ({ recordId, user }: { recordId: string; user?: { objectId: string; userPrincipalName: string } }) =>
    <div aria-label="Scoped user on agent">{recordId} / {user?.objectId} / {user?.userPrincipalName}</div>,
}));
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
  const user = combinedUser();
  user.directory.displayName = "Ada"; user.directory.userPrincipalName = "ada@example.invalid";
  vi.mocked(readReportPage).mockImplementation(async path => path.endsWith("/service-plans") ? reportPage([{
    servicePlanId: "a62f8878-de10-42f3-b68f-6149a25ceb97", service: "M365_COPILOT_APPS", displayName: "Copilot in Productivity Apps",
    state: "enabled", assignedDateTime: null, capabilityStatus: "Enabled",
  }]) : path.endsWith("/agents") ? reportPage([]) : reportPage([user]));
  vi.mocked(readReportDetail).mockResolvedValue({ value: user, reports, sources: reportPage([]).sources, selection: reportPage([]).selection });
});
afterEach(() => vi.resetAllMocks());

describe("user audit entry point", () => {
  it("uses the verified report-to-directory link for both identities in user-on-agent logs", async () => {
    const directory = combinedUser();
    const report = reportUser(1, { username: "report-alias@example.invalid" });
    vi.mocked(readReportDetail).mockImplementation(async path => ({
      value: path.endsWith("/directory") ? directory : report, reports, sources: reportPage([]).sources, selection: reportPage([]).selection,
    }));
    render(<CapabilityContext value={capability}><UserDetailModal kind="report" identity={report.username}
      selectionId={selectionId} initialTab="purview" investigationAgent={{ recordId: "agent:saved", name: "Selected agent" }}
      closeLabel="Close logs" returnFocusTo={createRef<HTMLInputElement>()} onClose={vi.fn()} /></CapabilityContext>);
    const scoped = await screen.findByLabelText("Scoped user on agent");
    expect(scoped).toHaveTextContent(`agent:saved / ${directory.directory.objectId} / ${directory.directory.userPrincipalName}`);
    expect(scoped).not.toHaveTextContent(report.username);
  });

  it("switches a verified user's Logs to the exact directory-object hunting scope", async () => {
    const user = combinedUser().directory;
    render(<CapabilityContext value={capability}><UserPurviewAudit
      userObjectId={user.objectId} userPrincipalName={user.userPrincipalName} /></CapabilityContext>);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Source" }), "defender");
    expect(screen.getByLabelText("Scoped human hunt")).toHaveTextContent(user.objectId);
    expect(screen.queryByLabelText("Scoped user search")).not.toBeInTheDocument();
  });

  it("retains lazy tabs and user-agent filters within a selection, but retires them on a data revision", async () => {
    const view = render(<CapabilityContext value={capability}><CopilotUsersView /></CapabilityContext>);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    const element = await screen.findByRole("dialog", { name: "Ada" });
    const dialog = within(element);
    expect(dialog.getAllByRole("tab").map(tab => tab.textContent)).toEqual([
      "Overview", "Usage & agents", "Licenses", "Responsibility", "Logs",
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
    expect(await dialog.findByRole("list", { name: "Paid feature states" })).toBeVisible();
    await userEvent.click(dialog.getByRole("tab", { name: "Usage & agents" }));
    expect(dialog.getByRole("searchbox", { name: "Search this user's agents" })).toHaveValue("research");
    dialog.getByRole("tab", { name: "Usage & agents" }).focus();
    await userEvent.keyboard("{End}");
    expect(dialog.getByRole("tab", { name: "Logs" })).toHaveFocus();
    expect(dialog.getByLabelText("Scoped user search")).toHaveTextContent("ada@example.invalid");
    expect(dialog.getByLabelText("Scoped user search").closest("details")).toBeNull();
    await userEvent.keyboard("{Home}");
    expect(overview).toHaveFocus();
    expect(dialog.queryByLabelText("Scoped user search")).not.toBeInTheDocument();

    const detailReads = vi.mocked(readReportDetail).mock.calls.length;
    view.rerender(<CapabilityContext value={capability}><CopilotUsersView dataRevision={1} /></CapabilityContext>);
    expect(element).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Scoped user search")).not.toBeInTheDocument();
    expect(readReportDetail).toHaveBeenCalledTimes(detailReads);
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    const replacement = within(await screen.findByRole("dialog", { name: "Ada" }));
    expect(replacement.getByRole("tabpanel")).toHaveAccessibleName("Overview");
    await userEvent.click(replacement.getByRole("tab", { name: "Usage & agents" }));
    expect(await replacement.findByRole("searchbox", { name: "Search this user's agents" })).toHaveValue("");
    await userEvent.click(replacement.getByRole("tab", { name: "Logs" }));
    expect(replacement.getByLabelText("Scoped user search")).toHaveTextContent("ada@example.invalid");
  });

  it("starts in the paid-user details modal and passes its verified directory identity", async () => {
    render(<CapabilityContext value={capability}><CopilotUsersView /></CapabilityContext>);
    expect(screen.queryByRole("button", { name: "Open Purview audit search" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ada" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Ada" }));
    await userEvent.click(dialog.getByRole("tab", { name: "Logs" }));
    expect(dialog.getByLabelText("Scoped user search")).toHaveTextContent("ada@example.invalid");
    expect(window.location.pathname).not.toBe("/audit");
  });

  it("uses the verified directory link in reported-user details and blocks unlinked report identities", async () => {
    const directory = combinedUser();
    directory.directory.displayName = "Ada"; directory.directory.userPrincipalName = "ada@example.invalid";
    const user = reportUser(1, { username: "ada@example.invalid", displayName: "Ada" });
    vi.mocked(readReportDetail).mockImplementation(async path => ({
      value: path.endsWith("/directory") ? directory : user, reports, sources: reportPage([]).sources, selection: reportPage([]).selection,
    }));
    const props = {
      identity: "ada@example.invalid", selectionId, closeLabel: "Close reported user details",
      filters: { responsesOnly: false }, returnFocusTo: createRef<HTMLInputElement>(),
      onClose: vi.fn(), onFocusAgent: vi.fn(),
    };
    const view = render(<CapabilityContext value={capability}><UserDetailModal {...props} kind="report" /></CapabilityContext>);
    const dialog = within(await screen.findByRole("dialog", { name: "Ada" }));
    await userEvent.click(dialog.getByRole("tab", { name: "Logs" }));
    expect(await dialog.findByLabelText("Scoped user search")).toHaveTextContent("ada@example.invalid");
    const unlinked = reportUser(2, { username: "opaque-report-identity", objectId: null });
    vi.mocked(readReportDetail).mockResolvedValue({
      value: unlinked, reports, sources: reportPage([]).sources, selection: reportPage([]).selection,
    });
    view.rerender(<CapabilityContext value={capability}><UserDetailModal {...props} kind="report" identity={unlinked.username} /></CapabilityContext>);
    await waitFor(() => expect(screen.queryByLabelText("Scoped user search")).not.toBeInTheDocument());
    expect(await screen.findByText(/verified directory user is required/)).toBeVisible();
    expect(vi.mocked(readReportDetail).mock.calls.filter(([path]) => path.includes("opaque-report-identity") && path.endsWith("/directory"))).toHaveLength(0);
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
    expect(screen.getByText(/verified directory user is required/)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    view.rerender(panel("one@example.invalid", { ...capability, user: { ...capability.user!, roles: [] } }));
    expect(screen.getByText("Viewer access is required to search logs.")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Scoped user search")).not.toBeInTheDocument();
  });
});
