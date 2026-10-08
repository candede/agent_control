import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import type { CapabilityId, CapabilityStatus, CapabilityView, SessionUser } from "../api/client";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { mockNativeDialogs } from "../test/dialog";
import { useCapabilities } from "../useCapabilities";
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
function Page({ value }: { value: ReturnType<typeof useCapabilityContext> }) {
  return <CapabilityContext value={value}><CapabilityHealth /><PermissionCenter /></CapabilityContext>;
}
function SessionPage({ principal, epoch = 0, open = true }: {
  principal: SessionUser | undefined; epoch?: number; open?: boolean;
}) {
  const capabilities = useCapabilities(principal, epoch);
  return <CapabilityContext value={{ ...capabilities, openPermissions: vi.fn() }}>
    <CapabilityHealth />{open ? <PermissionCenter /> : null}
  </CapabilityContext>;
}
async function openRequirements() {
  const setup = within(screen.getByRole("region", { name: "App prerequisites" }));
  await userEvent.click(setup.getByText("Required API permissions"));
  return setup;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); window.history.replaceState({}, "", "/"); });

describe("Permissions setup and issues", () => {
  it("keeps the user guide focused on Microsoft roles, even without an app-role assignment", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<Page value={{ ...context([]), user: { ...user, roles: [] } }} />);
    const guide = within(screen.getByRole("region", { name: "Signed-in user roles" }));
    expect(guide.getByText(/Microsoft roles for actions you run with your signed-in account/)).toBeVisible();
    expect(guide.getByRole("link", { name: "App API permissions" })).toHaveAttribute("href", "#app-prerequisites-title");
    expect(guide.queryByText(/AgentControl\.|In Agent Control|Enterprise application|does not verify|documentation reviewed|certify/i)).not.toBeInTheDocument();
    expect(guide.queryByRole("article", { name: /saved data|Import and manage|application access|read jobs/i })).not.toBeInTheDocument();
    expect(guide.getByRole("link", { name: "Activate your role" })).toBeVisible();
    expect(screen.queryByText("App administrator", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check status" })).toBeDisabled();
    expect(screen.getByRole("region", { name: "Issues" })).toHaveTextContent("Ask an administrator to assign");
    expect(screen.getByRole("navigation", { name: "Permissions sections" })).toHaveTextContent("Signed-in user roles");
    expect(screen.getByRole("region", { name: "Signed-in user roles" }).querySelector("details")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps app actions to Microsoft roles and the documented package API permissions", () => {
    render(<Page value={context([])} />);
    const guide = within(screen.getByRole("region", { name: "Signed-in user roles" }));
    const task = (name: string) => guide.getByRole("article", { name });
    const packageRead = task("Refresh Microsoft 365 agent inventory");
    const packageWrite = task("Block, unblock or change agent access");
    expect(packageRead).toHaveTextContent("CopilotPackages.Read.All");
    expect(packageWrite).toHaveTextContent("CopilotPackages.ReadWrite.All");
    expect(packageWrite).toHaveTextContent("Delegated access");
    expect(packageWrite).toHaveTextContent("availability and installation assignments");
    for (const row of [packageRead, packageWrite]) {
      expect(row).toHaveTextContent("Entra role: not specified by the package API.");
      expect(row).toHaveTextContent("Microsoft Agent 365 license");
      expect(row).not.toHaveTextContent(/AI Administrator|Global Administrator|No role required/);
    }
    expect(task("Refresh Copilot Studio agents and environments")).toHaveTextContent("AI Reader or Global Reader");
    expect(task("Refresh Copilot Studio agents and environments")).toHaveTextContent("inventory feature");
    expect(task("Refresh Copilot Studio agents and environments")).toHaveTextContent("REST API does not publish a separate role minimum");
    expect(task("Check quarantine status, quarantine or restore Studio agents")).toHaveTextContent("AI Administrator or Power Platform Administrator");
    expect(task("Check quarantine status, quarantine or restore Studio agents")).toHaveTextContent("same roles are needed to read quarantine status");
    expect(task("Look up people and assignment users/groups")).toHaveTextContent("Guests cannot list users");
    expect(task("Resolve a Studio agent's log identity")).toHaveTextContent("Agent ID Administrator");
    expect(task("Resolve a Studio agent's log identity")).toHaveTextContent("Entra blueprint you own");
    expect(task("Sync users and Copilot licenses")).toHaveTextContent("Directory Readers");
    expect(task("Refresh Copilot activity in Office apps")).toHaveTextContent("Reports Reader or AI Administrator");
    expect(task("Download usage CSVs for import")).toHaveTextContent("Reports Reader or AI Administrator");
    expect(task("Download usage CSVs for import")).toHaveTextContent("Usage Summary Reports Reader does not include user details");
    expect(task("Search Purview audit for a user")).toHaveTextContent("Recommended: Security Reader + Purview Audit Reader");
    expect(task("Search Purview audit for a user")).toHaveTextContent("Audit Reader is a Purview role group");
    expect(task("Run Defender and Agent 365 hunts")).toHaveTextContent("Security Reader");
    expect(task("Run Defender and Agent 365 hunts")).toHaveTextContent("data sources and device groups");
  });

  it("keeps the role reference independent of identity and permission-check state", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const value = context([fixture("missing_permission")]);
    const { rerender } = render(<Page value={value} />);
    const reference = screen.getByRole("region", { name: "Signed-in user roles" }).textContent;
    const replacement = { ...user, homeAccountId: "fixture-b", tenantId: "tenant-b", displayName: "Other account" };
    const states: ReturnType<typeof useCapabilityContext>[] = [
      { ...value, views: [], loading: true },
      { ...value, pending: true, activeCheck: { id: 1, retryFailed: true } },
      { ...value, views: [], error: "Permission checks could not be loaded. Use Check status to retry." },
      { ...value, user: replacement, views: [], loading: true },
      { ...value, user: { ...replacement, roles: ["AgentControl.Viewer"] }, views: [fixture()] },
      { ...value, user: { ...replacement, roles: [] }, views: [] },
      { ...value, user: undefined, views: [] },
    ];
    for (const state of states) {
      rerender(<Page value={state} />);
      const guide = screen.getByRole("region", { name: "Signed-in user roles" });
      expect(guide).toBeVisible();
      expect(guide.textContent).toBe(reference);
      expect(within(guide).queryByRole("status")).not.toBeInTheDocument();
      expect(within(guide).queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByText(`Setup and troubleshooting for ${state.user?.displayName || "your account"}.`)).toBeVisible();
    }
    expect(value.reload).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("provides a compact, fully visible reference with Microsoft sources and no extra controls", () => {
    render(<Page value={context([])} />);
    const region = screen.getByRole("region", { name: "Signed-in user roles" });
    const guide = within(region);
    const tasks = guide.getAllByRole("article");
    expect(tasks).toHaveLength(11);
    expect(region.textContent!.trim().split(/\s+/).length).toBeLessThanOrEqual(600);
    expect(guide.queryByRole("navigation")).not.toBeInTheDocument();
    for (const task of tasks) expect(within(task).getAllByRole("link").length).toBeGreaterThan(0);
    const references = guide.getAllByRole("link").filter(link => link.getAttribute("target") === "_blank");
    expect(references.length).toBeLessThanOrEqual(16);
    for (const link of references) {
      expect(link).toHaveAttribute("href", expect.stringMatching(/^https:\/\/learn\.microsoft\.com\//));
      expect(link).toHaveAttribute("rel", "noreferrer");
    }
    expect(guide.queryByRole("button")).not.toBeInTheDocument();
    expect(region.querySelector("details")).toBeNull();
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
    expect(screen.queryByText("App administrator", { exact: true })).not.toBeInTheDocument();
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

  it.each(["account", "tenant", "roles", "role removal", "sign-out"] as const)("closes old issue details on %s change", async change => {
    const value = context([fixture("missing_permission")]);
    const { rerender } = render(<Page value={value} />);
    await userEvent.click(screen.getByRole("button", { name: "Details: Agent inventory" }));
    const nextUser: SessionUser | undefined = change === "sign-out" ? undefined : {
      ...user,
      ...(change === "account" ? { homeAccountId: "other" }
        : change === "tenant" ? { tenantId: "other" }
          : { roles: change === "roles" ? ["AgentControl.Viewer"] : [] }),
    };
    rerender(<Page value={{ ...value, user: nextUser }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  describe("Permissions request lifecycle", () => {
    it("distinguishes pending prerequisites, catalog failure, retry, and recovered requirements", async () => {
      vi.useFakeTimers({ now });
      const reads: Array<{ release: (response: Response) => void; signal?: AbortSignal | null }> = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/capabilities") return new Promise<Response>(release => { reads.push({ release, signal: init?.signal }); });
        return Response.json({ value: [fixture()] });
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<SessionPage principal={user} />);
      fireEvent.click(screen.getByText("Required API permissions"));
      const setup = within(screen.getByRole("region", { name: "App prerequisites" }));
      expect(setup.getByText("Loading feature permission requirements...")).toBeVisible();
      expect(setup.queryByText(/feature permission list is unavailable/)).not.toBeInTheDocument();
      expect(screen.queryByText("No issues reported.")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();
      await act(async () => reads[0].release(Response.json({ code: "request_throttled" }, { status: 429 })));
      expect(setup.getByText(/feature permission list is unavailable/)).toBeVisible();
      expect(setup.queryByText(/Loading feature/)).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded");
      expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription("Permissions: check failed");
      expect(screen.queryByText("No issues reported.")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      expect(setup.getByText("Loading feature permission requirements...")).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      const retry = screen.getByRole("button", { name: "Checking..." });
      fireEvent.click(retry);
      expect(reads).toHaveLength(2);
      expect(reads[1].signal?.aborted).toBe(false);
      await act(async () => reads[1].release(Response.json({ value: [fixture()] })));
      expect(within(setup.getByRole("region", { name: "Microsoft Graph / Delegated" })).getByText("CopilotPackages.Read.All")).toBeVisible();
      expect(setup.queryByText(/Loading feature|feature permission list is unavailable/)).not.toBeInTheDocument();
      expect(screen.getByText("No issues reported.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "/api/capabilities", "/api/capabilities", "/api/capabilities/check?retry=failed",
      ]);
    });

    it("retains known issues and requirements during one recheck, without restarting it on navigation", async () => {
      vi.useFakeTimers({ now });
      const held: Array<{ url: string; release: (response: Response) => void; signal?: AbortSignal | null }> = [];
      let hold = false;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (hold) return new Promise<Response>(release => { held.push({ url, release, signal: init?.signal }); });
        return Response.json({ value: [fixture("missing_permission")] });
      });
      vi.stubGlobal("fetch", fetchMock);
      const { rerender } = render(<SessionPage principal={user} />);
      await act(async () => {});
      expect(fetchMock).toHaveBeenCalledTimes(2);
      hold = true;
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      fireEvent.click(screen.getByRole("button", { name: "Checking..." }));
      fireEvent.click(screen.getByText("Required API permissions"));
      const setup = within(screen.getByRole("region", { name: "App prerequisites" }));
      expect(within(setup.getByRole("region", { name: "Microsoft Graph / Delegated" })).getByText("CopilotPackages.Read.All")).toBeVisible();
      expect(setup.queryByText(/Loading feature|feature permission list is unavailable/)).not.toBeInTheDocument();
      expect(screen.getByText("Loading permission results")).toBeVisible();
      expect(screen.getByRole("button", { name: "Details: Agent inventory" })).toBeVisible();
      expect(held).toHaveLength(1);
      expect(held[0].signal?.aborted).toBe(false);
      await act(async () => held[0].release(Response.json({ value: [fixture("missing_permission")] })));
      expect(screen.getByText("Checking permissions")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Checking..." }));
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(held.map(request => request.url)).toEqual([
        "/api/capabilities", "/api/capabilities/check?retry=failed", "/api/capabilities/check-progress?retry=failed",
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Details: Agent inventory" }));
      expect(screen.getByRole("dialog", { name: "Agent inventory" })).toBeVisible();

      rerender(<SessionPage principal={user} open={false} />);
      expect(held[1].signal?.aborted).toBe(false);
      expect(held[2].signal?.aborted).toBe(true);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      rerender(<SessionPage principal={user} />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();
      expect(fetchMock).toHaveBeenCalledTimes(5);
      await act(async () => {
        held[1].release(Response.json({ value: [fixture()] }));
        held[2].release(Response.json({ progress: { checks: [{ capabilityId: "graph.package.read.delegated", state: "checking" }] } }));
      });
      expect(screen.getByText("No issues reported.")).toBeVisible();
      expect(screen.queryByRole("region", { name: "Permission check progress" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Details:/ })).not.toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it.each(["account", "tenant", "roles", "epoch", "sign-out", "role removal"] as const)(
      "retires old details, evidence, checks, and progress after a %s transition",
      async change => {
        vi.useFakeTimers({ now });
        const held: Array<{ url: string; release: (response: Response) => void; signal?: AbortSignal | null }> = [];
        let replacement = false;
        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
          if (!replacement && url === "/api/capabilities") return Response.json({ value: [fixture("missing_permission")] });
          if (replacement && url.startsWith("/api/capabilities/check") && !url.includes("progress")) {
            return Response.json({ value: [fixture("missing_role", "graph.directory.read")] });
          }
          return new Promise<Response>(release => { held.push({ url, release, signal: init?.signal }); });
        });
        vi.stubGlobal("fetch", fetchMock);
        const { rerender } = render(<SessionPage principal={user} />);
        await act(async () => {});
        fireEvent.click(screen.getByRole("button", { name: "Details: Agent inventory" }));
        await act(() => vi.advanceTimersByTimeAsync(500));
        expect(held).toHaveLength(2);
        replacement = true;
        const principal: SessionUser | undefined = change === "sign-out" ? undefined : {
          ...user,
          ...(change === "account" ? { homeAccountId: "fixture-b" }
            : change === "tenant" ? { tenantId: "tenant-b" }
              : change === "roles" ? { roles: ["AgentControl.Viewer"] }
                : change === "role removal" ? { roles: [] } : {}),
        };
        rerender(<SessionPage principal={principal} epoch={change === "epoch" ? 1 : 0} />);
        expect(held[0].signal?.aborted).toBe(true);
        expect(held[1].signal?.aborted).toBe(true);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Details:/ })).not.toBeInTheDocument();
        await act(async () => {
          held[0].release(Response.json({ value: [fixture("missing_permission")] }));
          held[1].release(Response.json({ code: "session_invalidated" }, { status: 401 }));
        });
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.queryByText("Agent inventory")).not.toBeInTheDocument();
        if (change === "sign-out" || change === "role removal") {
          expect(fetchMock).toHaveBeenCalledTimes(3);
          expect(screen.getByRole("button", { name: "Check status" })).toBeDisabled();
          expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription("Permissions: app role required");
        } else {
          expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();
          expect(screen.queryByText("No issues reported.")).not.toBeInTheDocument();
          expect(held[2].signal?.aborted).toBe(false);
          await act(async () => held[2].release(Response.json({ value: [fixture("missing_role", "graph.directory.read")] })));
          expect(screen.getByRole("button", { name: "Details: Agent people" })).toBeVisible();
          expect(screen.queryByRole("button", { name: "Details: Agent inventory" })).not.toBeInTheDocument();
          expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
          expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
          expect(fetchMock).toHaveBeenCalledTimes(5);
        }
      },
    );

    it("preserves details across equivalent principals and ages issues without refetching", async () => {
      vi.useFakeTimers({ now });
      const fetchMock = vi.fn(async () => Response.json({ value: [fixture("missing_permission")] }));
      vi.stubGlobal("fetch", fetchMock);
      const principal: SessionUser = { ...user, roles: ["AgentControl.Admin", "AgentControl.Viewer"] };
      const { rerender } = render(<SessionPage principal={principal} />);
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Details: Agent inventory" }));
      const dialog = screen.getByRole("dialog");
      rerender(<SessionPage principal={{ ...principal, displayName: "Updated name", roles: [...principal.roles].reverse() }} />);
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(screen.getByText("Setup and troubleshooting for Updated name.")).toBeInTheDocument();
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await act(() => vi.advanceTimersByTimeAsync(60_001));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByText("No issues reported.")).toBeVisible();
      expect(screen.getByRole("heading", { name: "Permissions", level: 2 })).toHaveFocus();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each(["check", "operation"] as const)("expires a displayed %s issue when its deadline passes during a reload commit", async source => {
      vi.useFakeTimers({ now });
      const expiresAt = now + 60_000;
      const view = fixture("missing_permission");
      if (source === "operation") {
        view.operationFailure = { status: "missing_permission", checkedAt: view.decision.checkedAt!,
          expiresAt: view.decision.expiresAt!, remediation: [] };
        view.decision = { ...view.decision, status: "available", authorized: true,
          expiresAt: new Date(expiresAt + 60_000).toISOString() };
      }
      let release!: (response: Response) => void;
      const fetchMock = vi.fn(async (url: string) => url === "/api/capabilities/check?retry=failed"
        ? new Promise<Response>(resolve => { release = resolve; })
        : Response.json({ value: [view] }));
      vi.stubGlobal("fetch", fetchMock);
      function DelayedCommitPage() {
        const capabilities = useCapabilities(user);
        useLayoutEffect(() => {
          if (capabilities.now === expiresAt - 1) vi.setSystemTime(expiresAt + 1);
        }, [capabilities.now]);
        return <Page value={{ ...capabilities, openPermissions: vi.fn() }} />;
      }
      render(<DelayedCommitPage />);
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Details: Agent inventory" }));
      expect(screen.getByRole("dialog", { name: "Agent inventory" })).toBeVisible();
      vi.setSystemTime(expiresAt - 1);
      await act(async () => release(Response.json({ value: [view] })));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByText("No issues reported.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription("Permissions and setup");
      expect(screen.getByRole("heading", { name: "Permissions", level: 2 })).toHaveFocus();
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
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
    expect(screen.queryByText(/App administrator|App viewer/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
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
