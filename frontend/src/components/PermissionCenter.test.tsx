import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import type { CapabilityId, CapabilityStatus, CapabilityView, SessionUser } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { mockNativeDialogs } from "../test/dialog";
import { CapabilityHealth, PermissionCenter } from "./PermissionCenter";

mockNativeDialogs();
const user: SessionUser = { displayName: "Synthetic administrator", username: "fixture@example.invalid", homeAccountId: "fixture-a", tenantId: "tenant-a", roles: ["AgentControl.Admin"] };
const now = Date.parse("2026-09-24T00:00:00Z");
function fixture(status: CapabilityStatus = "available", id: CapabilityId = "graph.package.read.delegated"): CapabilityView {
  return {
    definition: capabilityDefinitions.find(definition => definition.id === id)!,
    decision: {
      capabilityId: id, status, authorized: status === "available", fresh: true,
      verification: status === "available" ? "token" : undefined,
      checkedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      previewQualification: "not_required", remediation: [],
    },
  };
}
function context(views: CapabilityView[]) {
  return { views, user, loading: false, pending: false, error: undefined as string | undefined, now, reload: vi.fn(), openPermissions: vi.fn() };
}
function Page({ value }: { value: ReturnType<typeof context> & { awaitingInitialCheck?: boolean } }) {
  return <CapabilityContext value={value}><CapabilityHealth /><PermissionCenter /></CapabilityContext>;
}
async function openRequirements() {
  const setup = within(screen.getByRole("region", { name: "App prerequisites" }));
  await userEvent.click(setup.getByText("Required API permissions"));
  return setup;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

describe("Permissions setup and issues", () => {
  it("documents human roles separately without treating app roles as Microsoft role assignments", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<Page value={{ ...context([]), user: { ...user, roles: [] } }} />);
    const guide = within(screen.getByRole("region", { name: "Signed-in user roles" }));
    expect(guide.getByText(/not the API permissions on the app registration/)).toBeVisible();
    expect(guide.getByText(/Admin includes Viewer; neither grants a Microsoft administrator role/)).toBeVisible();
    expect(guide.getByText(/it does not enumerate or certify all of your Microsoft role assignments/)).toBeVisible();
    expect(within(guide.getByRole("article", { name: "View, filter and export saved data" })).getByText("AgentControl.Viewer or AgentControl.Admin")).toBeVisible();
    expect(within(guide.getByRole("article", { name: "Import and manage usage reports" })).getByText("AgentControl.Admin")).toBeVisible();
    expect(guide.getByText(/activate it in My roles before the task/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Check status" })).toBeDisabled();
    expect(screen.getByRole("region", { name: "Issues" })).toHaveTextContent("Ask an administrator to assign");
    expect(screen.getByRole("navigation", { name: "Permissions sections" })).toHaveTextContent("Signed-in user roles");
    expect(screen.getByRole("region", { name: "Signed-in user roles" }).querySelector("details")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("covers agent controls, directory reads, report downloads and service-specific log roles", () => {
    render(<Page value={context([])} />);
    const guide = within(screen.getByRole("region", { name: "Signed-in user roles" }));
    const task = (name: string) => guide.getByRole("article", { name });
    expect(task("Block or unblock Microsoft 365 agents")).toHaveTextContent("AgentControl.Admin");
    expect(task("Block or unblock Microsoft 365 agents")).toHaveTextContent("does not name an additional Entra role");
    expect(task("Change agent availability and installation assignments")).toHaveTextContent("AgentControl.Admin");
    expect(task("Refresh Copilot Studio agents and environments")).toHaveTextContent("AI Reader for agents/environments");
    expect(task("Refresh Copilot Studio agents and environments")).toHaveTextContent("REST API does not publish a separate human-role minimum");
    expect(task("Read Copilot Studio quarantine status")).toHaveTextContent("AgentControl.Viewer or AgentControl.Admin");
    expect(task("Quarantine or restore Copilot Studio agents")).toHaveTextContent("AI Administrator, Power Platform Administrator or Global Administrator");
    expect(task("Resolve a Studio agent's log identity")).toHaveTextContent("Agent ID Administrator");
    expect(task("Sync users and Copilot licenses")).toHaveTextContent("Directory Readers");
    expect(task("Refresh Copilot activity in Office apps")).toHaveTextContent("Reports Reader or AI Administrator");
    expect(task("Download usage CSVs from Microsoft 365")).toHaveTextContent("No Agent Control role is needed");
    expect(task("Download usage CSVs from Microsoft 365")).toHaveTextContent("summary-only reporting role is not sufficient");
    expect(task("Import and manage usage reports")).toHaveTextContent("AgentControl.Admin");
    expect(task("Search Purview audit for a user")).toHaveTextContent("Purview Audit Reader");
    expect(task("Search Purview audit for a user")).toHaveTextContent("not Entra directory roles");
    expect(task("Search Purview audit for a user")).toHaveTextContent("Security Reader + Purview Audit Reader");
    expect(task("Search Purview audit for a user")).toHaveTextContent("not a proven endpoint-specific minimum");
    expect(task("Run Defender and Agent 365 hunts")).toHaveTextContent("data sources and device groups");
  });

  it("links every topic and Microsoft requirement without adding role-assignment or consent actions", () => {
    render(<Page value={context([])} />);
    const guide = within(screen.getByRole("region", { name: "Signed-in user roles" }));
    const topics = within(guide.getByRole("navigation", { name: "User role topics" })).getAllByRole("link");
    expect(topics).toHaveLength(4);
    for (const link of topics) expect(document.querySelector(link.getAttribute("href")!)).not.toBeNull();
    const references = guide.getAllByRole("link").filter(link => link.getAttribute("target") === "_blank");
    expect(references.length).toBeGreaterThan(20);
    for (const link of references) {
      expect(link).toHaveAttribute("href", expect.stringMatching(/^https:\/\/learn\.microsoft\.com\//));
      expect(link).toHaveAttribute("rel", "noreferrer");
    }
    expect(guide.queryByRole("button")).not.toBeInTheDocument();
    expect(guide.queryByText(/CopilotPackages.ReadWrite.All|User.Read.All|Reports.Read.All/)).not.toBeInTheDocument();
  });

  it("keeps app-only authentication failures out of user sign-in recovery, including issue details", async () => {
    const view = fixture("available", "graph.package.read.application");
    view.operationFailure = { status: "unknown", checkedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(), evidence: { category: "authorization_expired" },
      remediation: ["An administrator must verify the application's credentials."] };
    render(<Page value={context([view])} />);
    const issues = within(screen.getByRole("region", { name: "Issues" }));
    expect(issues.getByRole("link", { name: "Admin setup" })).toHaveAttribute("href", "https://entra.microsoft.com/");
    expect(issues.queryByRole("link", { name: "Sign in again" })).not.toBeInTheDocument();
    await userEvent.click(issues.getByRole("button", { name: "Details: App-only agent inventory" }));
    const dialog = within(screen.getByRole("dialog", { name: "App-only agent inventory" }));
    expect(dialog.getByText(/User sign-in does not repair app-only authorization/)).toBeVisible();
    expect(dialog.queryByText(/Then sign in again/)).not.toBeInTheDocument();
    expect(dialog.queryByRole("link", { name: "Sign in again" })).not.toBeInTheDocument();
  });

  it("shows working feedback only during a check and retains confirmed issues until results arrive", () => {
    const value = { ...context([fixture("missing_permission")]), pending: true, activeCheck: { id: 1, retryFailed: true } };
    const { rerender } = render(<Page value={value} />);
    expect(screen.getByRole("region", { name: "Permission check progress" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Checking..." }).querySelector(".permission-spinner")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Permissions" }).querySelector(".permission-spinner")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription("Permissions: 1 issue");
    expect(screen.getByRole("button", { name: "Details: Agent inventory" })).toBeVisible();
    expect(screen.queryByText("No issues reported.")).not.toBeInTheDocument();
    rerender(<Page value={context([fixture()])} />);
    expect(screen.queryByRole("region", { name: "Permission check progress" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
    expect(screen.getByText("No issues reported.")).toBeVisible();
  });

  it("only checks permissions when Check status is requested, not when opening or rendering the page", () => {
    const value = context([]);
    const { rerender } = render(<Page value={value} />);
    expect(value.reload).not.toHaveBeenCalled();
    rerender(<Page value={{ ...value, now: now + 1 }} />);
    expect(value.reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    expect(value.reload).toHaveBeenCalledTimes(1);
  });

  it("shows actual license-sync failure details and closes them after the next successful operation", async () => {
    const view = fixture("available", "graph.licenses.read");
    view.decision = { capabilityId: view.definition.id, status: "available", authorized: true, fresh: true,
      verification: "on_demand", previewQualification: "not_required", remediation: [] };
    view.operationFailure = { status: "missing_permission", checkedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(), evidence: { httpStatus: 403, providerErrorCode: "Authorization_RequestDenied" },
      remediation: ["Ask an administrator to review the required grants."] };
    const { rerender } = render(<Page value={context([view])} />);
    expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription("Permissions: 1 issue");
    await userEvent.click(screen.getByRole("button", { name: "Details: Copilot license sync" }));
    const dialog = screen.getByRole("dialog", { name: "Copilot license sync" });
    expect(within(dialog).getByText("Microsoft denied the required API permission.")).toBeVisible();
    expect(within(dialog).getByText(/LicenseAssignment.Read.All/)).toBeVisible();
    await userEvent.click(within(dialog).getByText("Technical details"));
    expect(within(dialog).getByText("Authorization_RequestDenied")).toBeVisible();
    rerender(<Page value={context([{ ...view, operationFailure: undefined }])} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("No issues reported.")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Permissions", level: 2 })).toHaveFocus());
  });

  it("shows a compact neutral page without access tables or speculative status labels", () => {
    const views = capabilityDefinitions.map(definition => ({
      ...fixture(), definition, decision: { ...fixture().decision, capabilityId: definition.id },
    }));
    render(<Page value={context(views)} />);
    expect(screen.getByText("No issues reported.")).toBeVisible();
    expect(screen.getByText("App administrator")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/Ready to try|Microsoft checks access when used|not verified|no proof|Account access|Shared application modes/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Provider verified|Local access|Needs attention/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription("Permissions and setup");
    expect(screen.getByText("Log collection setup")).toBeVisible();
    expect(screen.getByRole("region", { name: "Log setup" }).querySelector("details")).not.toHaveAttribute("open");
  });

  it("keeps the exact permission-feature reference separate from optional app-only permissions", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<Page value={context(capabilityDefinitions.map(definition => ({
      ...fixture(), definition, decision: { ...fixture().decision, capabilityId: definition.id },
    })))} />);
    const setup = await openRequirements();
    const graph = setup.getByRole("region", { name: "Microsoft Graph / Delegated" });
    const platform = setup.getByRole("region", { name: "Power Platform / Delegated" });
    const signIn = setup.getByRole("region", { name: "Sign-in / OpenID Connect" });
    for (const [permission, feature] of [
      ["openid", "Sign-in: authenticate your account using an ID token."],
      ["profile", "Sign-in: identify your account and display its name and username."],
      ["offline_access", "Session renewal: refresh delegated access tokens without repeated sign-in."],
    ]) expect(within(signIn).getByText(permission).closest("div")).toHaveTextContent(feature);
    expect(signIn.querySelectorAll("dt")).toHaveLength(3);
    const mappings = [
      [graph, "CopilotPackages.Read.All", "Agents / Sync: load package inventory and package details."],
      [graph, "CopilotPackages.ReadWrite.All", "Agents > Manage: change package availability and installation assignments."],
      [graph, "CopilotPackages.ReadWrite.All", "Agents > Manage: block or unblock published packages."],
      [graph, "User.ReadBasic.All", "Agents > Overview / Manage: resolve people and search users for access assignments."],
      [graph, "Group.Read.All", "Agents > Overview / Manage: resolve groups and search groups for access assignments."],
      [graph, "User.Read.All", "Users / Sync: read users and their Copilot license and service-plan assignments."],
      [graph, "LicenseAssignment.Read.All", "Users / Sync: read the tenant product and service-plan catalog."],
      [graph, "Reports.Read.All", "Users / Sync: refresh 30-day Microsoft 365 Copilot app activity."],
      [graph, "AgentIdentity.Read.All", "Agents > Activity: verify a Studio agent's Entra identity for log matching."],
      [graph, "AuditLogsQuery.Read.All", "User details > Purview audit: run user-scoped searches. Agent details > Activity: search saved records."],
      [graph, "ThreatHunting.Read.All", "Agents > Activity: run Defender / Agent 365 log hunts."],
      [platform, "ResourceQuery.Resources.Read", "Agents / Sync: refresh Power Platform agent and environment inventory."],
      [platform, "CopilotStudio.AdminActions.Invoke", "Agents > Manage: check a Studio agent's quarantine status."],
      [platform, "CopilotStudio.AdminActions.Invoke", "Agents > Manage: quarantine or restore a Studio agent."],
    ] as const;
    for (const [group, permission, feature] of mappings) {
      const row = within(group).getByText(permission, { exact: true }).closest("div")!;
      expect(within(row).getByText(feature)).toBeVisible();
      expect(feature.split(/\s+/).length).toBeLessThanOrEqual(20);
    }
    for (const [group, provider] of [[graph, "Microsoft Graph"], [platform, "Power Platform"]] as const) {
      const required = new Set(capabilityDefinitions.filter(definition => definition.probe.adapterRegistered
        && definition.mode === "delegated" && definition.provider === provider).flatMap(definition => definition.permissions));
      expect([...group.querySelectorAll("dt")].map(term => term.textContent).sort()).toEqual([...required].sort());
    }
    expect(within(graph).queryByText("User.Read", { exact: true })).not.toBeInTheDocument();
    expect(setup.getByText(/Not used by this app/).closest("p")).toHaveTextContent("User.Read");
    expect(setup.getByText(/current app requests these read scopes separately/)).toBeVisible();
    expect(setup.getByRole("region", { name: "Microsoft Graph / Application" })).not.toBeVisible();
    await userEvent.click(setup.getByText("Optional application permissions"));
    const application = setup.getByRole("region", { name: "Microsoft Graph / Application" });
    expect(application.querySelectorAll("dt")).toHaveLength(3);
    for (const row of application.querySelectorAll("dd")) expect(row).toHaveTextContent("approved app-only access");
    expect(setup.queryByText(/Reassign an exact supported package target/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /consent|Authorize identity lookup/i })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps catalog failure explicit while retaining known sign-in requirements", async () => {
    render(<Page value={{ ...context([]), error: "Permission checks could not be loaded. Use Check status to retry." }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded");
    expect(screen.queryByText("No issues reported.")).not.toBeInTheDocument();
    const setup = await openRequirements();
    expect(setup.getByText(/feature permission list is unavailable/)).toBeVisible();
    expect(setup.getByRole("region", { name: "Sign-in / OpenID Connect" })).toBeVisible();
  });

  it("uses the catalog purpose for a new permission instead of an empty description", async () => {
    const view = fixture();
    view.definition = { ...view.definition, permissions: ["Future.Read"], purpose: "Read future package metadata." };
    render(<Page value={context([view])} />);
    const setup = await openRequirements();
    expect(setup.getByText("Future.Read").closest("div")).toHaveTextContent("Package catalog read: Read future package metadata.");
  });

  it("preserves concise, correctly linked connector and Purview instructions behind setup disclosure", async () => {
    render(<Page value={context([fixture()])} />);
    const setup = within(screen.getByRole("region", { name: "Log setup" }));
    await userEvent.click(setup.getByText("Log collection setup"));
    for (const name of ["Open Defender", "Connect Copilot Studio"]) {
      expect(setup.getByRole("link", { name })).toHaveAttribute("href", "https://security.microsoft.com/securitysettings/security_for_ai");
      expect(setup.getByRole("link", { name })).toHaveAttribute("rel", "noreferrer");
    }
    expect(setup.getByRole("link", { name: "Open Audit Search" })).toHaveAttribute("href", "https://purview.microsoft.com/audit/auditsearch");
    expect(setup.getByText("ThreatHunting.Read.All")).not.toBeVisible();
    for (const step of setup.getAllByText("Steps & permissions")) await userEvent.click(step);
    expect(setup.getByText(/keep Users and groups selected. Verify Connected/)).toBeVisible();
    expect(setup.getByText(/Security Administrator and Power Platform Administrator/)).toBeVisible();
    expect(setup.getByText(/Get-AdminAuditLogConfig/)).toBeVisible();
    expect(setup.getByText(/Set-AdminAuditLogConfig/)).toBeVisible();
    expect(setup.getByText(/No search history/)).toBeVisible();
    expect(setup.getByText(/does not confirm whether auditing is enabled/)).toBeVisible();
  });

  it("shows only actual failures, with short fixes and no readiness rows", async () => {
    render(<Page value={context([fixture("missing_permission"), fixture("available", "graph.licenses.read")])} />);
    expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription("Permissions: 1 issue");
    const issues = within(screen.getByRole("region", { name: "Issues" }));
    expect(issues.getByText("Agent inventory")).toBeVisible();
    expect(issues.getByText("Microsoft denied the required API permission.")).toBeVisible();
    expect(issues.getByRole("link", { name: "Admin setup" })).toHaveAttribute("href", "https://entra.microsoft.com/");
    expect(issues.queryByText("Copilot license sync")).not.toBeInTheDocument();
    const trigger = issues.getByRole("button", { name: "Details: Agent inventory" });
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Agent inventory" });
    expect(within(dialog).getByRole("region", { name: "Required setup" })).toHaveTextContent("CopilotPackages.Read.All");
    expect(within(dialog).getByText("https://graph.microsoft.com")).not.toBeVisible();
    await userEvent.click(within(dialog).getByText("Technical details"));
    expect(within(dialog).getByText("https://graph.microsoft.com")).toBeVisible();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(trigger).toHaveFocus();
  });

  it.each(["account", "tenant", "roles", "sign-out"] as const)("closes old issue details on %s change", async change => {
    const value = context([fixture("missing_permission")]);
    const { rerender } = render(<Page value={value} />);
    await userEvent.click(screen.getByRole("button", { name: "Details: Agent inventory" }));
    const nextUser: SessionUser = { ...user };
    if (change === "account") nextUser.homeAccountId = "other";
    else if (change === "tenant") nextUser.tenantId = "other";
    else nextUser.roles = change === "roles" ? ["AgentControl.Viewer"] : [];
    rerender(<Page value={{ ...value, user: nextUser }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["success", "expiry", "removed"] as const)("closes resolved details and restores focus when the failure is %s", async change => {
    const value = context([fixture("missing_permission")]);
    const { rerender } = render(<Page value={value} />);
    await userEvent.click(screen.getByRole("button", { name: "Details: Agent inventory" }));
    rerender(<Page value={{ ...value, ...(change === "success" ? { views: [fixture()] }
      : change === "removed" ? { views: [] } : { now: now + 61_000 }) }} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("No issues reported.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Permissions", level: 2 })).toHaveFocus();
  });

  it.each(["AgentControl.Viewer", "AgentControl.Admin"] as const)("does not report unused admin actions as issues for %s", role => {
    render(<Page value={{ ...context([fixture("missing_internal_role", "graph.package.block.manage")]), user: { ...user, roles: [role] } }} />);
    expect(screen.getByText("No issues reported.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Details:/ })).not.toBeInTheDocument();
    expect(screen.getByText(role === "AgentControl.Admin" ? "App administrator" : "App viewer")).toBeVisible();
  });

  it("makes missing app-role setup clear without a no-op retry button", () => {
    render(<Page value={{ ...context([]), user: { ...user, roles: [] } }} />);
    expect(screen.getByRole("button", { name: "Check status" })).toBeDisabled();
    const issues = within(screen.getByRole("region", { name: "Issues" }));
    expect(issues.getByText("AgentControl.Viewer")).toBeVisible();
    expect(issues.getByText("AgentControl.Admin")).toBeVisible();
    expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription("Permissions: app role required");
  });

  it("hides cached transient errors until the initial retry confirms them", () => {
    const failed = fixture("provider_error");
    failed.decision.evidence = { category: "provider_timeout" };
    const value = context([failed]);
    const { rerender } = render(<Page value={{ ...value, pending: true, awaitingInitialCheck: true }} />);
    expect(screen.queryByText("Agent inventory")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription("Permissions and setup");
    expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();
    rerender(<Page value={value} />);
    expect(screen.getByText("Microsoft did not respond after retrying.")).toBeVisible();
  });

  it("retains a confirmed issue during recheck and exposes transport errors inside an open dialog", async () => {
    const value = context([fixture("missing_permission")]);
    const { rerender } = render(<Page value={value} />);
    await userEvent.click(screen.getByRole("button", { name: "Details: Agent inventory" }));
    rerender(<Page value={{ ...value, pending: true, error: "Permission checks failed after retrying." }} />);
    const dialog = screen.getByRole("dialog", { name: "Agent inventory" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("after retrying");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("No issues reported.")).not.toBeInTheDocument();
  });

  it("keeps disabled app-only modes out of issues but reports an enabled failed request", () => {
    const view = fixture("missing_permission", "defender.hunting.application");
    const { rerender } = render(<Page value={context([{ ...view, enabled: false }])} />);
    expect(screen.getByText("No issues reported.")).toBeVisible();
    rerender(<Page value={context([{ ...view, enabled: true }])} />);
    expect(screen.getByText("App-only Defender logs")).toBeVisible();
  });

  it("runs only the explicit check callback from the page", async () => {
    const value = context([]);
    render(<Page value={value} />);
    await userEvent.click(screen.getByRole("button", { name: "Check status" }));
    expect(value.reload).toHaveBeenCalledOnce();
  });

  it("shows a cancelled sign-in without inferring missing API grants", () => {
    window.history.replaceState({}, "", "/permissions?authorization=cancelled");
    render(<Page value={context([])} />);
    expect(screen.getByText("Sign-in was cancelled.")).toBeVisible();
    expect(screen.queryByText(/missing.*permission/i)).not.toBeInTheDocument();
  });

  it("keeps keyboard focus in accessible failure details", async () => {
    const { container } = render(<Page value={context([fixture("missing_permission")])} />);
    expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Details: Agent inventory" }));
    const dialog = screen.getByRole("dialog", { name: "Agent inventory" });
    for (let index = 0; index < 12; index++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    expect((await axe.run(dialog, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
  });
});
