import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import type { CapabilityId, CapabilityStatus, CapabilityView, SessionUser } from "../api/client";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { useCapabilities } from "../useCapabilities";
import { isDeferredSecurityCapability } from "../deferredSecurityUi";
import { CapabilityHealth, PermissionCenter } from "./PermissionCenter";

const user: SessionUser = { displayName: "Synthetic administrator", username: "fixture@example.invalid", homeAccountId: "fixture-a", tenantId: "tenant-a", roles: ["AgentControl.Admin"] };
const now = Date.parse("2026-09-24T00:00:00Z");
function fixture(status: CapabilityStatus = "available", id: CapabilityId = "graph.package.read.application"): CapabilityView {
  const definition = capabilityDefinitions.find(definition => definition.id === id)!;
  return {
    enabled: true, definition,
    ...(definition.mode === "application" ? { configuration: { enabled: true, sharedDataScope: true, revision: 1 } } : {}),
    decision: {
      capabilityId: id, status, authorized: status === "available", fresh: true,
      verification: status === "available" ? id === "graph.package.read.application" ? "provider" : "token" : undefined,
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
function registration() {
  return within(screen.getByRole("region", { name: "App registration permissions" }));
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); window.history.replaceState({}, "", "/"); });

describe("Permissions setup and issues", () => {
  it("has exactly three ordered, permanently visible sections and no functionality-first matrix", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<Page value={context([])} />);
    expect(screen.getAllByRole("heading", { level: 3 }).map(heading => heading.textContent))
      .toEqual(["Issues", "App-defined roles", "App registration permissions"]);
    expect(container.querySelectorAll(".permission-body > section")).toHaveLength(3);
    expect(container.querySelector("details, summary, [aria-expanded], dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Details:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: /Refresh Copilot Studio|Block, unblock|Download usage CSVs/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Permissions sections" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps all three app-role definitions available without an assignment", () => {
    render(<Page value={{ ...context([]), user: { ...user, roles: [] } }} />);
    const guide = within(screen.getByRole("region", { name: "App-defined roles" }));
    for (const [title, role] of [
      ["Viewer", "AgentControl.Viewer"], ["Usage Report Uploader", "AgentControl.UsageReportUploader"], ["Admin", "AgentControl.Admin"],
    ]) expect(within(guide.getByRole("article", { name: title })).getByText(role, { exact: true })).toBeVisible();
    expect(guide.getAllByRole("article")).toHaveLength(3);
    expect(guide.queryByText("Assigned to you")).not.toBeInTheDocument();
    expect(guide.queryByText("Included", { exact: true })).not.toBeInTheDocument();
    for (const card of guide.getAllByRole("article")) expect(card).not.toHaveClass("is-assigned");
    expect(guide.getByText(/App roles control Agent Control access/)).toBeVisible();
    expect(guide.getByText(/Usage Summary Reports Reader does not include user details/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Check status" })).toBeDisabled();
    expect(screen.getByRole("region", { name: "Issues" })).toHaveTextContent("Ask an administrator to assign");
  });

  it.each(["AgentControl.Viewer", "AgentControl.UsageReportUploader", "AgentControl.Admin"] as const)(
    "shows assigned and inherited roles without confusing them with provider grants for %s", role => {
      render(<Page value={{ ...context([]), user: { ...user, roles: [role] } }} />);
      const guide = within(screen.getByRole("region", { name: "App-defined roles" }));
      const assigned = guide.getAllByRole("article").find(article => article.querySelector("code")?.textContent === role)!;
      expect(within(assigned).getByText("Assigned to you")).toBeVisible();
      expect(assigned).toHaveClass("is-assigned");
      for (const card of guide.getAllByRole("article").filter(card => card !== assigned)) {
        expect(card).not.toHaveClass("is-assigned");
      }
      expect(guide.getAllByText("Assigned to you")).toHaveLength(1);
      expect(guide.queryAllByText("Included", { exact: true })).toHaveLength(role === "AgentControl.Admin" ? 2 : role === "AgentControl.UsageReportUploader" ? 1 : 0);
      expect(guide.getByRole("article", { name: "Viewer" })).toHaveTextContent("No signed-in Microsoft directory or reporting reader role is required");
      expect(guide.getByRole("article", { name: "Usage Report Uploader" })).toHaveTextContent("No Graph permission is needed to upload");
      expect(guide.getByRole("article", { name: "Admin" })).toHaveTextContent("signed-in user's delegated permission, applicable Microsoft role and license");
      expect(guide.getByText(/Application read permissions never authorize provider changes/)).toBeVisible();
      expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
    },
  );

  it("highlights multiple direct assignments and clears them when the user signs out", () => {
    const { rerender } = render(<Page value={{ ...context([]), user: { ...user, roles: ["AgentControl.Viewer", "AgentControl.Admin"] } }} />);
    const guide = within(screen.getByRole("region", { name: "App-defined roles" }));
    expect(guide.getByRole("article", { name: "Viewer" })).toHaveClass("is-assigned");
    expect(guide.getByRole("article", { name: "Admin" })).toHaveClass("is-assigned");
    expect(guide.getByRole("article", { name: "Usage Report Uploader" })).not.toHaveClass("is-assigned");
    expect(guide.getAllByText("Assigned to you")).toHaveLength(2);
    rerender(<Page value={{ ...context([]), user: undefined }} />);
    const signedOutGuide = within(screen.getByRole("region", { name: "App-defined roles" }));
    for (const card of signedOutGuide.getAllByRole("article")) expect(card).not.toHaveClass("is-assigned");
    expect(signedOutGuide.queryByText("Assigned to you")).not.toBeInTheDocument();
  });

  it("maps each required permission to its app use, independently of live check results", () => {
    render(<Page value={context([])} />);
    const setup = registration();
    for (const [provider, mode] of [
      ["Microsoft Graph", "application"], ["Microsoft Graph", "delegated"], ["Power Platform", "delegated"],
    ] as const) {
      const group = setup.getByRole("region", { name: `${provider} / ${mode === "application" ? "Application" : "Delegated"}` });
      const required = new Set(capabilityDefinitions.filter(definition => !isDeferredSecurityCapability(definition.id)
        && definition.probe.adapterRegistered && definition.provider === provider && definition.mode === mode).flatMap(definition => definition.permissions));
      expect([...group.querySelectorAll("dt")].map(term => term.textContent).sort()).toEqual([...required].sort());
    }
    const signin = setup.getByRole("region", { name: "Sign-in / OpenID Connect" });
    expect([...signin.querySelectorAll("dt")].map(term => term.textContent)).toEqual(["openid", "profile", "offline_access"]);
    const rows = screen.getByRole("region", { name: "App registration permissions" }).querySelectorAll(".permission-map-row");
    expect(rows).toHaveLength(11);
    for (const row of rows) {
      expect(row.firstElementChild?.tagName).toBe("DT");
      expect(row.lastElementChild?.tagName).toBe("DD");
      expect(row.querySelector("dt code")).toBeVisible();
      expect(row.querySelector("dd strong")).toBeVisible();
      expect(row.querySelector("dd p")).toBeVisible();
    }
    expect(setup.getByText(/required configuration, not a claim/)).toBeVisible();
    expect(setup.getByText("User.Read", { exact: true }).closest("p")).toHaveTextContent("is not used");
    expect(setup.getByText(/No administrator session is needed/)).toBeVisible();
    expect(setup.getByRole("link", { name: "Open app registration" })).toHaveAttribute("href", "https://entra.microsoft.com/");
    expect(setup.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps app-role guidance in its dedicated section rather than the API permission reference", () => {
    render(<Page value={context([])} />);
    const apiPermissions = screen.getByRole("region", { name: "App registration permissions" });
    expect(apiPermissions).not.toHaveTextContent(/AgentControl\.|\b(?:Viewer|Uploader|UsageReportUploader|Admin)\b/);
    expect(apiPermissions).not.toHaveTextContent(/\bapp[- ]roles?\b/i);
    const roles = screen.getByRole("region", { name: "App-defined roles" });
    for (const role of ["AgentControl.Viewer", "AgentControl.UsageReportUploader", "AgentControl.Admin"]) {
      expect(roles).toHaveTextContent(role);
    }
  });

  it("explains the exact application, delegated, provider-role and licensing requirements", () => {
    render(<Page value={context([])} />);
    const row = (permission: string) => registration().getByText(permission, { exact: true }).closest(".permission-map-row")!;
    expect(row("CopilotPackages.Read.All")).toHaveTextContent("published Copilot package inventory");
    expect(row("User.Read.All")).toHaveTextContent("exact agent creators and owners");
    expect(row("LicenseAssignment.Read.All")).toHaveTextContent("product SKUs and service plans");
    expect(row("Reports.Read.All")).toHaveTextContent("does not replace the three imported agent-usage CSV reports");
    expect(row("CopilotPackages.ReadWrite.All")).toHaveTextContent("Delegated tenant admin consent and a Microsoft Agent 365 license");
    expect(row("CopilotPackages.ReadWrite.All")).toHaveTextContent("Recommended signed-in administrator role: AI Administrator");
    expect(row("CopilotPackages.ReadWrite.All")).toHaveTextContent("Global Administrator is a broader alternative");
    expect([...row("CopilotPackages.ReadWrite.All").querySelectorAll(".permission-map-requirement strong")].map(role => role.textContent))
      .toEqual(["AI Administrator", "Global Administrator"]);
    expect(row("User.Read.All")).toHaveTextContent("search management recipients, and validate user IDs before an access change");
    expect(row("Group.Read.All")).toHaveTextContent("The signed-in user's delegated directory access");
    const inventory = row("ResourceQuery.Resources.Read");
    expect(inventory).toHaveTextContent("no application permission equivalent");
    expect(inventory).toHaveTextContent("saved tenant data remains readable");
    const recommended = inventory.querySelector(".permission-map-requirement")!;
    expect(recommended).toHaveTextContent("Recommended for read-only sync: AI Reader");
    expect(recommended).toHaveTextContent("least-privileged supported Microsoft Entra inventory role");
    expect(recommended).not.toHaveTextContent(/Global Reader|AI Administrator|Power Platform Administrator|Dynamics 365 Administrator|Global Administrator/);
    const alternatives = inventory.querySelector(".permission-map-alternatives")!;
    for (const role of ["AI Administrator", "Global Reader", "Power Platform Administrator", "Dynamics 365 Administrator", "Global Administrator"]) {
      expect(alternatives).toHaveTextContent(role);
    }
    expect(alternatives).toHaveTextContent("AI roles cover AI-scoped resources");
    expect(alternatives).toHaveTextContent("broader roles are not needed");
    expect(row("CopilotStudio.AdminActions.Invoke")).toHaveTextContent("Both status checks and changes require AI Administrator, Power Platform Administrator or Global Administrator");
    expect([...row("CopilotStudio.AdminActions.Invoke").querySelectorAll(".permission-map-requirement strong")].map(role => role.textContent))
      .toEqual(["AI Administrator", "Power Platform Administrator", "Global Administrator"]);
  });

  it("distinguishes the Graph package permission definition from supported write authorization", () => {
    render(<Page value={context([])} />);
    const packageRow = registration().getByText("CopilotPackages.ReadWrite.All", { exact: true }).closest<HTMLElement>(".permission-map-row")!;
    expect(packageRow).toHaveTextContent("Recommended signed-in administrator role: AI Administrator");
    const setup = within(packageRow).getByRole("region", { name: "Configure delegated package access" });
    expect(setup).toHaveTextContent("Microsoft Graph > Delegated permissions");
    expect(setup).toHaveTextContent("Grant admin consent");
    expect(setup).toHaveTextContent("Microsoft documents these roles for agent management in the Microsoft 365 admin center");
    expect(setup).toHaveTextContent("package API does not publish an explicit role minimum");
    expect(setup).toHaveTextContent("not a confirmed exclusive API role requirement");
    expect(setup).toHaveTextContent("both application and delegated forms");
    expect(setup).toHaveTextContent("delegated work or school accounts only");
    expect(setup).toHaveTextContent("application form does not authorize these writes");
    expect(within(setup).getByRole("link", { name: "Permission definition" }))
      .toHaveAttribute("href", "https://learn.microsoft.com/en-us/graph/permissions-reference#copilotpackagesreadwriteall");
    expect(within(setup).getByRole("link", { name: "Package write API requirements" }))
      .toHaveAttribute("href", "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-update");
    expect(within(setup).getByRole("link", { name: "Agent-management roles" }))
      .toHaveAttribute("href", "https://learn.microsoft.com/en-us/microsoft-agent-365/admin/agent-roles-perms");
  });

  it("explains how an administrator gives a viewer read-only Power Platform sync access", () => {
    render(<Page value={context([])} />);
    const setup = within(screen.getByRole("region", { name: "Assign AI Reader to a viewer" }));
    expect(setup.getByRole("link", { name: "Microsoft Entra admin center" })).toHaveAttribute("href", "https://entra.microsoft.com/");
    const steps = setup.getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent("Privileged Role Administrator");
    expect(steps[0]).toHaveTextContent("Identity > Roles & admins > AI Reader");
    expect(steps[1]).toHaveTextContent("Add assignments");
    expect(steps[1]).toHaveTextContent("AI Reader provides read-only inventory access");
    expect(steps[1]).toHaveTextContent("no administrator role is needed for the viewer");
    expect(steps[2]).toHaveTextContent("sign out and sign in again");
    expect(steps[2]).toHaveTextContent("If AI Reader is PIM-eligible, they must activate it first");
    expect(setup.getByText(/is the app's delegated API permission/)).toHaveTextContent("not a user role; the app registration also needs admin consent");
    expect(setup.getByText(/does not grant quarantine/)).toBeVisible();
    expect(setup.getByRole("link", { name: "Role assignment instructions" })).toHaveAttribute("href",
      "https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/manage-roles-portal#assign-roles-with-tenant-scope");
  });

  it("retains the complete reference through loading, errors, principal changes and sign-out", () => {
    const value = context([]);
    const { rerender } = render(<Page value={value} />);
    const reference = screen.getByRole("region", { name: "App registration permissions" }).textContent;
    for (const state of [
      { ...value, loading: true },
      { ...value, pending: true, activeCheck: { id: 1, retryFailed: true } },
      { ...value, error: "Permission checks could not be loaded. Use Check status to retry." },
      { ...value, user: { ...user, tenantId: "tenant-b", homeAccountId: "fixture-b", roles: [] } },
      { ...value, user: undefined },
    ]) {
      rerender(<Page value={state} />);
      expect(screen.getByRole("region", { name: "App registration permissions" }).textContent).toBe(reference);
      expect(screen.getByRole("region", { name: "App-defined roles" })).toBeVisible();
    }
  });

  it("keeps deferred security guidance hidden without modifying capability records", () => {
    const views = capabilityDefinitions.map(definition => fixture("missing_permission", definition.id));
    const before = structuredClone(views);
    render(<Page value={context(views)} />);
    const count = views.filter(view => !isDeferredSecurityCapability(view.definition.id)
      && view.definition.probe.adapterRegistered && view.definition.mode !== "local").length;
    expect(within(screen.getByRole("region", { name: "Issues" })).getAllByRole("article")).toHaveLength(count);
    expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription(`Permissions: ${count} issues`);
    expect(screen.getByRole("region", { name: "Permissions" })).not.toHaveTextContent(
      /Purview|Defender|AgentIdentity.Read.All|AuditLogsQuery.Read.All|ThreatHunting.Read.All|log identity/);
    expect(views).toEqual(before);
  });

  it("shows actual failures, full evidence and recovery inline without a details control", () => {
    const failed = fixture("missing_permission");
    failed.decision.evidence = { category: "missing_permission", phase: "provider_read", httpStatus: 403,
      providerErrorCode: "Authorization_RequestDenied", correlationId: "synthetic-request" };
    const { container } = render(<Page value={context([failed, fixture("available", "graph.licenses.read")])} />);
    const issues = within(screen.getByRole("region", { name: "Issues" }));
    const issue = within(issues.getByRole("article", { name: "Agent inventory" }));
    expect(issue.getByText("Microsoft denied the required API permission.")).toBeVisible();
    expect(issue.getByRole("link", { name: "Admin setup" })).toHaveAttribute("href", "https://entra.microsoft.com/");
    expect(issue.getByRole("region", { name: "Required setup" })).toHaveTextContent("CopilotPackages.Read.All");
    for (const text of ["https://graph.microsoft.com", "synthetic-request", "403", "Authorization_RequestDenied", "Provider read"]) {
      expect(issue.getByText(text, { exact: true })).toBeVisible();
    }
    expect(issues.queryByText("Copilot license sync")).not.toBeInTheDocument();
    expect(container.querySelector("details, summary, dialog, [aria-expanded]")).toBeNull();
  });

  describe("Permissions request lifecycle", () => {
    it("keeps requirements visible through catalog failure, retry and recovery", async () => {
      vi.useFakeTimers({ now });
      const reads: Array<{ release: (response: Response) => void; signal?: AbortSignal | null }> = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/capabilities") return new Promise<Response>(release => { reads.push({ release, signal: init?.signal }); });
        return Response.json({ value: [fixture()] });
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<SessionPage principal={user} />);
      const setup = screen.getByRole("region", { name: "App registration permissions" });
      const reference = setup.textContent;
      expect(setup.querySelectorAll("dt")).toHaveLength(11);
      expect(screen.queryByText("No issues reported.")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();
      await act(async () => reads[0].release(Response.json({ code: "request_throttled" }, { status: 429 })));
      expect(setup.textContent).toBe(reference);
      expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded");
      expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription("Permissions: check failed");
      expect(screen.queryByText("No issues reported.")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Checking..." }));
      expect(reads).toHaveLength(2);
      expect(reads[1].signal?.aborted).toBe(false);
      await act(async () => reads[1].release(Response.json({ value: [fixture()] })));
      expect(setup.textContent).toBe(reference);
      expect(screen.getByText("No issues reported.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "/api/capabilities", "/api/capabilities", "/api/capabilities/check?retry=failed",
      ]);
    });

    it("retains known issues during one recheck without restarting on navigation", async () => {
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
      expect(screen.getByText("Loading permission results")).toBeVisible();
      expect(screen.getByRole("article", { name: "Agent inventory" })).toBeVisible();
      expect(screen.getByRole("region", { name: "App registration permissions" }).querySelectorAll("dt")).toHaveLength(11);
      expect(held).toHaveLength(1);
      expect(held[0].signal?.aborted).toBe(false);
      await act(async () => held[0].release(Response.json({ value: [fixture("missing_permission")] })));
      expect(screen.getByText("Checking permissions")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Checking..." }));
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(held.map(request => request.url)).toEqual([
        "/api/capabilities", "/api/capabilities/check?retry=failed", "/api/capabilities/check-progress?retry=failed",
      ]);
      rerender(<SessionPage principal={user} open={false} />);
      expect(held[1].signal?.aborted).toBe(false);
      expect(held[2].signal?.aborted).toBe(true);
      rerender(<SessionPage principal={user} />);
      expect(screen.getByRole("article", { name: "Agent inventory" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();
      expect(fetchMock).toHaveBeenCalledTimes(5);
      await act(async () => {
        held[1].release(Response.json({ value: [fixture()] }));
        held[2].release(Response.json({ progress: { checks: [{ capabilityId: "graph.package.read.application", state: "checking" }] } }));
      });
      expect(screen.getByText("No issues reported.")).toBeVisible();
      expect(screen.queryByRole("region", { name: "Permission check progress" })).not.toBeInTheDocument();
      expect(screen.queryByRole("article", { name: "Agent inventory" })).not.toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it.each(["account", "tenant", "roles", "role removal", "epoch", "sign-out"] as const)(
      "aborts in-flight checks and rejects late results after %s changes", async change => {
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
        expect(screen.getByRole("article", { name: "Agent inventory" })).toBeVisible();
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
        expect(screen.queryByRole("article", { name: "Agent inventory" })).not.toBeInTheDocument();
        await act(async () => {
          held[0].release(Response.json({ value: [fixture("missing_permission")] }));
          held[1].release(Response.json({ code: "session_invalidated" }, { status: 401 }));
        });
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.queryByRole("article", { name: "Agent inventory" })).not.toBeInTheDocument();
        if (change === "sign-out" || change === "role removal") {
          expect(fetchMock).toHaveBeenCalledTimes(3);
          expect(screen.getByRole("button", { name: "Check status" })).toBeDisabled();
          expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription("Permissions: app role required");
        } else {
          expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();
          expect(screen.queryByText("No issues reported.")).not.toBeInTheDocument();
          expect(held[2].signal?.aborted).toBe(false);
          await act(async () => held[2].release(Response.json({ value: [fixture("missing_role", "graph.directory.read")] })));
          expect(screen.getByRole("article", { name: "Management group lookup" })).toBeVisible();
          expect(screen.queryByRole("article", { name: "Agent inventory" })).not.toBeInTheDocument();
          expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
          expect(fetchMock).toHaveBeenCalledTimes(5);
        }
      },
    );

    it("preserves evidence across equivalent principals and ages it without refetching", async () => {
      vi.useFakeTimers({ now });
      const fetchMock = vi.fn(async () => Response.json({ value: [fixture("missing_permission")] }));
      vi.stubGlobal("fetch", fetchMock);
      const principal: SessionUser = { ...user, roles: ["AgentControl.Admin", "AgentControl.Viewer"] };
      const { rerender } = render(<SessionPage principal={principal} />);
      await act(async () => {});
      const issue = screen.getByRole("article", { name: "Agent inventory" });
      rerender(<SessionPage principal={{ ...principal, displayName: "Updated name", roles: [...principal.roles].reverse() }} />);
      expect(screen.getByRole("article", { name: "Agent inventory" })).toBe(issue);
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(issue).toBeVisible();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await act(() => vi.advanceTimersByTimeAsync(60_001));
      expect(screen.queryByRole("article", { name: "Agent inventory" })).not.toBeInTheDocument();
      expect(screen.getByText("No issues reported.")).toBeVisible();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each(["check", "operation"] as const)("expires a displayed %s issue during a reload commit", async source => {
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
      expect(screen.getByRole("article", { name: "Agent inventory" })).toBeVisible();
      vi.setSystemTime(expiresAt - 1);
      await act(async () => release(Response.json({ value: [view] })));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.queryByRole("article", { name: "Agent inventory" })).not.toBeInTheDocument();
      expect(screen.getByText("No issues reported.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription("Permissions and setup");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  it.each(["success", "expiry", "removed"] as const)("removes resolved inline evidence after %s", change => {
    const value = context([fixture("missing_permission")]);
    const { rerender } = render(<Page value={value} />);
    expect(screen.getByRole("article", { name: "Agent inventory" })).toBeVisible();
    rerender(<Page value={{ ...value, ...(change === "success" ? { views: [fixture()] }
      : change === "removed" ? { views: [] } : { now: now + 61_000 }) }} />);
    expect(screen.queryByRole("article", { name: "Agent inventory" })).not.toBeInTheDocument();
    expect(screen.getByText("No issues reported.")).toBeVisible();
  });

  it.each(["AgentControl.Viewer", "AgentControl.UsageReportUploader", "AgentControl.Admin"] as const)("does not report unused admin actions as issues for %s", role => {
    render(<Page value={{ ...context([fixture("missing_internal_role", "graph.package.block.manage")]), user: { ...user, roles: [role] } }} />);
    expect(screen.getByText("No issues reported.")).toBeVisible();
    expect(screen.queryByRole("article", { name: "Package blocking" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
  });

  it.each(["AgentControl.Viewer", "AgentControl.UsageReportUploader"] as const)(
    "keeps collection issues available without unused Admin readback for %s", role => {
      render(<Page value={{ ...context([
        fixture("missing_permission"), fixture("missing_internal_role", "graph.package.read.delegated"),
      ]), user: { ...user, roles: [role] } }} />);
      const issues = within(screen.getByRole("region", { name: "Issues" }));
      expect(issues.getByRole("article", { name: "Agent inventory" })).toBeVisible();
      expect(issues.getAllByRole("article")).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription("Permissions: 1 issue");
    });

  it("hides transient errors until the initial retry confirms them", () => {
    const failed = fixture("provider_error");
    failed.decision.evidence = { category: "provider_timeout" };
    const value = context([failed]);
    const { rerender } = render(<Page value={{ ...value, pending: true, awaitingInitialCheck: true }} />);
    expect(screen.queryByRole("article", { name: "Agent inventory" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Permissions" })).toHaveAccessibleDescription("Permissions and setup");
    expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();
    rerender(<Page value={value} />);
    expect(screen.getByText("Microsoft did not respond after retrying.")).toBeVisible();
  });

  it("retains an issue during recheck and reports transport failure once", () => {
    const value = context([fixture("missing_permission")]);
    const { rerender } = render(<Page value={value} />);
    rerender(<Page value={{ ...value, pending: true, error: "Permission checks failed after retrying." }} />);
    expect(screen.getByRole("article", { name: "Agent inventory" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("after retrying");
    expect(screen.queryByText("No issues reported.")).not.toBeInTheDocument();
  });

  it("omits disabled application evidence and reports enabled collector failures", () => {
    const view = fixture("missing_permission");
    const { rerender } = render(<Page value={context([{ ...view, enabled: false }])} />);
    expect(screen.getByText("No issues reported.")).toBeVisible();
    rerender(<Page value={context([{ ...view, enabled: true }])} />);
    expect(screen.getByRole("article", { name: "Agent inventory" })).toBeVisible();
  });

  it("runs only the explicit check callback from the page", async () => {
    const value = context([]);
    render(<Page value={value} />);
    await userEvent.click(screen.getByRole("button", { name: "Check status" }));
    expect(value.reload).toHaveBeenCalledOnce();
  });

  it("shows cancelled sign-in without inferring missing grants", () => {
    window.history.replaceState({}, "", "/permissions?authorization=cancelled");
    render(<Page value={context([])} />);
    expect(screen.getByText("Sign-in was cancelled.")).toBeVisible();
    expect(screen.queryByText(/missing.*permission/i)).not.toBeInTheDocument();
  });

  it("exposes accessible inline evidence and lets keyboard users continue into the role reference", async () => {
    const { container } = render(<Page value={context([fixture("missing_permission")])} />);
    expect(screen.getByRole("heading", { name: "Permissions", level: 2 })).toHaveFocus();
    const assignRoles = screen.getByRole("link", { name: "Assign app roles" });
    for (let index = 0; index < 20 && document.activeElement !== assignRoles; index++) await userEvent.tab();
    expect(assignRoles).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
  });
});
