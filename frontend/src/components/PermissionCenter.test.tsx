import { act, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { appRoles } from "../../../backend/src/types/capability";
import { getCurrentUser, type CapabilityId, type CapabilityStatus, type CapabilityView, type SessionUser } from "../api/client";
import * as apiClient from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { statusLabels } from "../capabilityState";
import { useCapabilities } from "../useCapabilities";
import { mockNativeDialogs } from "../test/dialog";
import { CapabilityGate } from "./CapabilityGate";
import { CapabilityHealth, PermissionCenter } from "./PermissionCenter";

mockNativeDialogs();

const user: SessionUser = { displayName: "Synthetic administrator", username: "fixture@example.invalid", homeAccountId: "fixture-a", roles: [...appRoles] };
function fixture(status: CapabilityStatus): CapabilityView {
  return { definition: capabilityDefinitions[0], decision: { capabilityId: capabilityDefinitions[0].id, status, authorized: status === "available", fresh: true, verification: "provider", checkedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), previewQualification: "not_required", remediation: ["Check the documented requirements."] } };
}
function context(views: CapabilityView[]) {
  return { views, user, loading: false, pending: false, error: undefined, now: Date.now(), reload: vi.fn(), openPermissions: vi.fn() };
}
function deferredConsent() {
  let resolve!: (value: { authorizationUrl: string }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{ authorizationUrl: string }>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function onDemandFixture(id: CapabilityId): CapabilityView {
  return {
    definition: capabilityDefinitions.find(definition => definition.id === id)!,
    decision: {
      capabilityId: id, status: "available", authorized: true, fresh: true, verification: "on_demand",
      previewQualification: "not_required", remediation: [],
    },
  };
}
async function openDetails(name: string) {
  await userEvent.click(screen.getByRole("button", { name: `View details for ${name}` }));
  return within(screen.getByRole("dialog", { name }));
}
async function closeDetails(name: string) {
  await userEvent.click(screen.getByRole("button", { name: `Close ${name.toLowerCase()}` }));
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

describe("Permission Center", () => {
  it.each(["unmount", "account", "tenant", "roles", "sign-out"] as const)(
    "does not redirect for abandoned consent after %s", async change => {
      const pending = deferredConsent();
      const consent = vi.spyOn(apiClient, "beginCapabilityConsent").mockReturnValue(pending.promise);
      const view = fixture("missing_permission");
      const value = context([view]);
      const { rerender, unmount } = render(<CapabilityContext value={value}><PermissionCenter /></CapabilityContext>);
      await userEvent.click(screen.getByRole("button", { name: "Request consent" }));
      expect(screen.getByRole("button", { name: "Starting consent..." })).toBeDisabled();
      const signal = consent.mock.calls[0][2]?.signal;
      expect(signal?.aborted).toBe(false);

      if (change === "unmount") unmount();
      else {
        const nextUser: SessionUser | undefined = change === "account" ? { ...user, homeAccountId: "fixture-b" }
          : change === "tenant" ? { ...user, tenantId: "fixture-tenant-b" }
            : change === "roles" ? { ...user, roles: ["AgentControl.Viewer"] } : undefined;
        rerender(<CapabilityContext value={{ ...value, user: nextUser }}><PermissionCenter /></CapabilityContext>);
      }
      expect(signal?.aborted).toBe(true);
      await act(async () => pending.resolve({ authorizationUrl: "#abandoned-consent" }));
      expect(window.location.hash).toBe("");
    },
  );
  it("does not let an old consent failure replace a new account's pending consent", async () => {
    const previous = deferredConsent();
    const current = deferredConsent();
    const consent = vi.spyOn(apiClient, "beginCapabilityConsent")
      .mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    const value = context([fixture("missing_permission")]);
    const { rerender } = render(<CapabilityContext value={value}><PermissionCenter /></CapabilityContext>);
    await userEvent.click(screen.getByRole("button", { name: "Request consent" }));

    rerender(<CapabilityContext value={{ ...value, user: { ...user, homeAccountId: "fixture-b" } }}><PermissionCenter /></CapabilityContext>);
    await userEvent.click(screen.getByRole("button", { name: "Request consent" }));
    expect(consent).toHaveBeenCalledTimes(2);
    await act(async () => previous.reject(new Error("Previous account failure")));
    expect(screen.queryByText(/Consent could not start/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Starting consent..." })).toBeDisabled();
    await act(async () => current.resolve({ authorizationUrl: "#current-consent" }));
    expect(window.location.hash).toBe("#current-consent");
  });
  it("keeps active consent pending across equivalent account objects and role ordering", async () => {
    const pending = deferredConsent();
    const consent = vi.spyOn(apiClient, "beginCapabilityConsent").mockReturnValue(pending.promise);
    const value = context([fixture("missing_permission")]);
    const { rerender } = render(<CapabilityContext value={value}><PermissionCenter /></CapabilityContext>);
    await userEvent.click(screen.getByRole("button", { name: "Request consent" }));
    rerender(<CapabilityContext value={{ ...value, user: { ...user, roles: [...user.roles].reverse() } }}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByRole("button", { name: "Starting consent..." })).toBeDisabled();
    expect(consent).toHaveBeenCalledOnce();
    expect(consent.mock.calls[0][2]?.signal?.aborted).toBe(false);
    await act(async () => pending.resolve({ authorizationUrl: "#active-consent" }));
    expect(window.location.hash).toBe("#active-consent");
  });
  it("clears the previous failure while retrying consent", async () => {
    const pending = deferredConsent();
    vi.spyOn(apiClient, "beginCapabilityConsent")
      .mockRejectedValueOnce(new Error("Synthetic consent failure")).mockReturnValueOnce(pending.promise);
    render(<CapabilityContext value={context([fixture("missing_permission")])}><PermissionCenter /></CapabilityContext>);
    await userEvent.click(screen.getByRole("button", { name: "Request consent" }));
    expect(await screen.findByText(/Consent could not start/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Request consent" }));
    expect(screen.queryByText(/Consent could not start/)).not.toBeInTheDocument();
    await act(async () => pending.reject(new Error("Retry failure")));
    expect(screen.getByText(/Consent could not start/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Request consent" })).toBeEnabled();
  });
  it("explains missing internal roles instead of offering a no-op status check", async () => {
    const unassigned: SessionUser = { ...user, roles: [] };
    function Harness() {
      const value = useCapabilities(unassigned);
      return <CapabilityContext value={{ ...value, openPermissions: vi.fn() }}><CapabilityHealth /><PermissionCenter /></CapabilityContext>;
    }
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);
    expect(screen.getByRole("button", { name: "An internal app role is required to check permissions" })).toHaveTextContent("Permissions: role required");
    expect(screen.getByText(/Ask an administrator to assign AgentControl.Viewer or AgentControl.Admin/)).toBeVisible();
    expect(screen.queryByText(/Use Check status to try again/)).not.toBeInTheDocument();
    const check = screen.getByRole("button", { name: "Check status" });
    expect(check).toBeDisabled();
    await userEvent.click(check);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each<SessionUser["roles"]>([["AgentControl.Viewer"], ["AgentControl.Admin"]])(
    "allows a status check with the %s role", async role => {
      const value = { ...context([]), user: { ...user, roles: [role] } };
      render(<CapabilityContext value={value}><PermissionCenter /></CapabilityContext>);
      await userEvent.click(screen.getByRole("button", { name: "Check status" }));
      expect(value.reload).toHaveBeenCalledOnce();
    },
  );
  it("does not mistake untried operations for missing consent or claim provider proof", async () => {
    const views = (["graph.package.block.manage", "graph.package.access.manage", "powerPlatform.quarantine.manage"] as const).map(onDemandFixture);
    const consent = vi.spyOn(apiClient, "beginCapabilityConsent").mockRejectedValue(new Error("Synthetic consent failure"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<CapabilityContext value={context(views)}><CapabilityHealth /><PermissionCenter /></CapabilityContext>);
    expect(screen.getByRole("button", { name: "0 provider-verified / 0 local / 3 ready to try / 0 degraded / 0 blocked" })).toBeVisible();
    expect(within(screen.getByRole("table")).getAllByText("Ready to try", { exact: true })).toHaveLength(3);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    for (const view of views) {
      const details = await openDetails(view.definition.displayName);
      expect(details.getByText("Ready to try; Microsoft validates permission on the actual operation")).toBeVisible();
      expect(details.getByText("Not checked", { selector: "dd" })).toBeVisible();
      expect(details.getByText("No successful check recorded")).toBeVisible();
      await closeDetails(view.definition.displayName);
    }
    expect(consent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Request consent" })).not.toBeInTheDocument();
  });
  it("counts registered on-demand reads as ready without claiming verification or requiring a write", async () => {
    const views = (["graph.licenses.read", "reports.copilotUsage.read"] as const).map(onDemandFixture);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<CapabilityContext value={{ ...context(views), user: { ...user, roles: ["AgentControl.Viewer"] } }}>
      <CapabilityHealth /><PermissionCenter />
    </CapabilityContext>);
    expect(screen.getByRole("button", { name: "0 provider-verified / 0 local / 2 ready to try / 0 degraded / 0 blocked" })).toBeVisible();
    expect(within(screen.getByRole("table")).getAllByText("Ready to try", { exact: true })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "View details for M365 Copilot licenses" })).toBeVisible();
    for (const view of views) {
      const details = await openDetails(view.definition.displayName);
      expect(details.getByText("Ready to try; Microsoft validates permission on the actual operation")).toBeVisible();
      expect(details.queryByText(/Review and confirm the exact targets/)).not.toBeInTheDocument();
      await closeDetails(view.definition.displayName);
    }
    expect(screen.queryByRole("button", { name: "Request consent" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([undefined, "invalid", "2026-09-12T09:00:01.000Z"])(
    "disables actions when check time %s cannot establish current evidence", checkedAt => {
      const candidate = fixture("available");
      candidate.decision.checkedAt = checkedAt;
      candidate.decision.expiresAt = "2026-09-12T09:01:00.000Z";
      const perform = vi.fn();
      render(<CapabilityContext value={{ ...context([candidate]), now: Date.parse("2026-09-12T09:00:00.000Z") }}>
        <CapabilityHealth />
        <CapabilityGate capability={candidate.definition.id}><button onClick={perform}>Refresh provider data</button></CapabilityGate>
      </CapabilityContext>);
      expect(screen.getByRole("button", { name: "Refresh provider data" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "0 provider-verified / 0 local / 0 ready to try / 1 degraded / 0 blocked" })).toBeVisible();
      expect(perform).not.toHaveBeenCalled();
    },
  );
  it.each(["graph.package.block.manage", "graph.package.access.manage", "powerPlatform.quarantine.manage"] as const)(
    "offers %s consent only after a missing-permission check and removes it after token recovery", async id => {
      const ready = onDemandFixture(id);
      const missing: CapabilityView = { ...ready, decision: {
        ...fixture("missing_permission").decision, capabilityId: id, verification: undefined,
        evidence: { category: "missing_permission", phase: "token_acquisition" },
      } };
      const consent = vi.spyOn(apiClient, "beginCapabilityConsent").mockRejectedValue(new Error("Synthetic consent failure"));
      const { rerender } = render(<CapabilityContext value={context([missing])}><PermissionCenter /></CapabilityContext>);
      await userEvent.click(screen.getByRole("button", { name: "Request consent" }));
      expect(consent).toHaveBeenCalledWith(id, "/permissions", { signal: expect.any(AbortSignal) });
      expect(await screen.findByText(/Consent could not start/)).toBeVisible();
      const recovered: CapabilityView = { ...ready, decision: {
        ...fixture("available").decision, capabilityId: id, verification: "token",
      } };
      rerender(<CapabilityContext value={context([recovered])}><PermissionCenter /></CapabilityContext>);
      expect(screen.queryByRole("button", { name: "Request consent" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Open Agents" })).toBeVisible();
      const details = await openDetails(ready.definition.displayName);
      expect(details.getByText("Token acquired; provider authorization not verified")).toBeVisible();
    },
  );
  it.each(["graph.package.block.manage", "graph.package.access.manage", "powerPlatform.quarantine.manage"] as const)(
    "enables %s on demand without bypassing Viewer restrictions", async id => {
      const ready = onDemandFixture(id);
      const write = vi.fn();
      const content = <><PermissionCenter /><CapabilityGate capability={id} roles={["AgentControl.Admin"]} write><button onClick={write}>Apply change</button></CapabilityGate></>;
      const { rerender } = render(<CapabilityContext value={context([ready])}>{content}</CapabilityContext>);
      expect(screen.getByRole("button", { name: "Apply change" })).toBeEnabled();
      expect(write).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Apply change" }));
      expect(write).toHaveBeenCalledOnce();
      rerender(<CapabilityContext value={{ ...context([ready]), user: { ...user, roles: ["AgentControl.Viewer"] } }}>{content}</CapabilityContext>);
      expect(screen.getByRole("button", { name: "Apply change" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Request consent" })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Apply change" }));
      expect(write).toHaveBeenCalledOnce();
    },
  );
  it("shows a timeout and its recovery without requiring expansion of technical evidence", () => {
    const failed = fixture("provider_error");
    failed.decision.evidence = { category: "provider_timeout", phase: "provider_read", timeoutMs: 30_000 };
    render(<CapabilityContext value={context([failed])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByText("Check timed out")).toBeVisible();
    expect(screen.getByText(/bounded provider check timed out after 30 seconds/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Request consent" })).not.toBeInTheDocument();
  });

  it.each([
    ["graph.package.block.manage", "Open Agents", "/agents"],
    ["graph.package.access.manage", "Open Agents", "/agents"],
    ["powerPlatform.quarantine.read", "Open Agents", "/agents"],
    ["powerPlatform.quarantine.manage", "Open Agents", "/agents"],
    ["purview.audit.search.delegated", "Open Audit", "/audit"],
    ["defender.hunting.delegated", "Open Security", "/security"],
  ])("offers navigation, not automatic provider execution, for %s", (id, label, href) => {
    const ready = fixture("available");
    ready.definition = capabilityDefinitions.find(item => item.id === id)!;
    ready.decision.capabilityId = ready.definition.id;
    ready.decision.verification = "token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<CapabilityContext value={context([ready])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
    expect(within(screen.getByRole("table")).getByText("Ready to try")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request consent" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(Object.keys(statusLabels) as CapabilityStatus[])("renders %s with exact requirements and safe actions", async status => {
    const value = context([fixture(status)]);
    render(<CapabilityContext value={value}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByText(statusLabels[status])).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Permissions" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Retry probe" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request consent" })).toBe(status === "missing_permission"
      ? screen.getByRole("button", { name: "Request consent" })
      : null);
    const details = await openDetails("Package catalog read");
    expect(details.getByText("delegated: CopilotPackages.Read.All")).toBeVisible();
    expect(details.getByText("https://graph.microsoft.com")).toBeVisible();
    expect(details.getByRole("link", { name: "Microsoft documentation 1" })).toHaveAttribute("href", capabilityDefinitions[0].sources[0]);
  });
  it("shows delivered Power Platform adapters and the role hierarchy", async () => {
    render(<CapabilityContext value={context(capabilityDefinitions.map(definition => ({ ...fixture("unknown"), definition })))}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByRole("row", { name: "Power Platform inventory" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Copilot Studio quarantine" })).toBeInTheDocument();
    for (const role of appRoles) expect(screen.getByText(role, { selector: "code" })).toBeInTheDocument();
    const inventory = await openDetails("Power Platform inventory");
    expect(inventory.getByText("delegated: ResourceQuery.Resources.Read")).toBeVisible();
    await closeDetails("Power Platform inventory");
    for (const name of ["Copilot Studio quarantine status", "Copilot Studio quarantine"]) {
      expect((await openDetails(name)).getByText("delegated: CopilotStudio.AdminActions.Invoke")).toBeVisible();
      await closeDetails(name);
    }
    await userEvent.click(screen.getByRole("button", { name: "How access works" }));
    expect(screen.getByText(/Admin inherits every Viewer capability/)).toBeInTheDocument();
  });
  it("uses provider roles only from the contract and only claims a missing role when conclusive", async () => {
    const view = fixture("missing_role");
    view.definition = { ...capabilityDefinitions.find(definition => definition.id === "powerPlatform.quarantine.manage")!, probe: { ...view.definition.probe, adapterRegistered: true } };
    render(<CapabilityContext value={context([view])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByText("Requires Global Administrator or AI Administrator or Power Platform Administrator.")).toBeInTheDocument();
    expect((await openDetails(view.definition.displayName)).getByText("delegated: CopilotStudio.AdminActions.Invoke")).toBeVisible();
  });
  it("explains an actual permission failure while retaining role-authorized saved data", async () => {
    const view = fixture("missing_permission");
    const value = context([view]); const write = vi.fn(); const read = vi.fn();
    render(<CapabilityContext value={value}><CapabilityGate capability={view.definition.id} write><button onClick={write}>Write</button></CapabilityGate><CapabilityGate roles={["AgentControl.Viewer"]}><button onClick={read}>Saved data</button></CapabilityGate></CapabilityContext>);
    await userEvent.click(screen.getByRole("button", { name: "Write" })); expect(write).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Write" })).toHaveAccessibleDescription(/Requires delegated/);
    await userEvent.click(screen.getByRole("button", { name: "Saved data" })); expect(read).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: /Permissions:/ })); expect(value.openPermissions).toHaveBeenCalledOnce();
  });
  it("does not enable or advertise access using another capability's decision", async () => {
    const view = fixture("available");
    view.decision.capabilityId = "graph.directory.read";
    const read = vi.fn();
    render(<CapabilityContext value={context([view])}>
      <CapabilityHealth />
      <PermissionCenter />
      <CapabilityGate capability={view.definition.id}><button onClick={read}>Read packages</button></CapabilityGate>
    </CapabilityContext>);

    expect(screen.getByRole("button", { name: "Read packages" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Read packages" }));
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /0 provider-verified \/ 0 local \/ 0 ready to try \/ 1 degraded \/ 0 blocked/ })).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: view.definition.displayName })).getByText("Verification unavailable")).toBeVisible();
    const details = await openDetails(view.definition.displayName);
    expect(details.getByText("Verification").nextElementSibling).toHaveTextContent("Current verification unavailable");
    expect(details.queryByText("Provider-verified")).not.toBeInTheDocument();
  });
  it("enables an implemented package change for Admin only", async () => {
    const definition = capabilityDefinitions.find(item => item.id === "graph.package.block.manage")!;
    const ready = onDemandFixture(definition.id);
    const adminAction = vi.fn();
    const viewerAction = vi.fn();
    const adminContext = context([ready]);
    const viewerContext = { ...context([ready]), user: { ...user, roles: ["AgentControl.Viewer"] as SessionUser["roles"] } };

    const admin = render(<CapabilityContext value={adminContext}><CapabilityGate capability={definition.id} roles={["AgentControl.Admin"]} write><button onClick={adminAction}>Admin block</button></CapabilityGate></CapabilityContext>);
    await userEvent.click(screen.getByRole("button", { name: "Admin block" }));
    expect(adminAction).toHaveBeenCalledOnce();
    admin.unmount();

    render(<CapabilityContext value={viewerContext}><CapabilityGate capability={definition.id} roles={["AgentControl.Admin"]} write><button onClick={viewerAction}>Viewer block</button></CapabilityGate></CapabilityContext>);
    await userEvent.click(screen.getByRole("button", { name: "Viewer block" }));
    expect(viewerAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Viewer block" })).toBeDisabled();
  });
  it("performs an automatic bounded check and interactive consent through the API client with CSRF", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      requests.push({ url: input, init });
      if (input === "/api/me") return Response.json({ user, csrfToken: "fixture-csrf" });
      if (input === "/api/capabilities/check") return Response.json({ value: [fixture("missing_permission")] });
      if (input === "/api/auth/consent") return Response.json({ type: "https://agent-control.invalid/problems/interaction_required", status: 403, code: "interaction_required", detail: "Synthetic conditional access", requestId: "fixture-request" }, { status: 403, headers: { "Content-Type": "application/problem+json" } });
      return Response.json({ value: [fixture("missing_permission")] });
    });
    vi.stubGlobal("fetch", fetchMock); await getCurrentUser();
    function Harness() { const value = useCapabilities(user); return <CapabilityContext value={{ ...value, openPermissions: vi.fn() }}><CapabilityHealth /><PermissionCenter /></CapabilityContext>; }
    render(<Harness />);
    await screen.findByText("Missing app permission");
    await waitFor(() => expect(requests.filter(request => request.url === "/api/capabilities/check")).toHaveLength(1));
    const check = requests.find(request => request.url === "/api/capabilities/check")!;
    expect(check.init?.method).toBe("POST");
    expect(new Headers(check.init?.headers).get("X-CSRF-Token")).toBe("fixture-csrf");
    expect(requests.filter(request => request.url.endsWith("/probe"))).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Request consent" }));
    await screen.findByText(/Consent could not start/);
    const consent = requests.find(request => request.url === "/api/auth/consent")!;
    expect(JSON.parse(consent.init!.body as string)).toEqual({ capabilityId: "graph.package.read.delegated", returnTo: "/permissions" });
    expect(new Headers(consent.init!.headers).get("X-CSRF-Token")).toBe("fixture-csrf");
  });
  it("keeps stale evidence and health counts readable", () => {
    const view = fixture("unknown"); view.decision.checkedAt = new Date(0).toISOString(); view.decision.fresh = false;
    render(<CapabilityContext value={context([view])}><CapabilityHealth /><PermissionCenter /></CapabilityContext>);
    expect(screen.getByText("Unknown / stale evidence")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /0 provider-verified \/ 0 local \/ 0 ready to try \/ 1 degraded \/ 0 blocked/ })).toBeInTheDocument();
  });
  it("separates optional application modes from delegated health", async () => {
    const delegated = fixture("available");
    const application = fixture("not_configured");
    application.definition = capabilityDefinitions.find(definition => definition.id === "graph.package.read.application")!;
    application.decision = { ...application.decision, capabilityId: application.definition.id };
    application.enabled = false;
    application.configuration = { enabled: false, sharedDataScope: false };

    render(<CapabilityContext value={context([delegated, application])}><CapabilityHealth /><PermissionCenter /></CapabilityContext>);

    expect(screen.getByRole("button", { name: /1 provider-verified \/ 0 local \/ 0 ready to try \/ 0 degraded \/ 0 blocked/ })).toBeInTheDocument();
    expect(screen.queryByText(application.definition.displayName)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Shared application modes (1)" }));
    expect(screen.getByText(/0 active, 1 inactive/)).toBeInTheDocument();
    expect(screen.getByText(/Only enabled modes count toward permission health/)).toBeInTheDocument();
    const details = await openDetails(application.definition.displayName);
    expect(details.getByText("Application mode").nextElementSibling).toHaveTextContent("Disabled");
  });
  it("includes an enabled approved application mode in active health", () => {
    const delegated = fixture("available");
    const application = fixture("available");
    application.definition = capabilityDefinitions.find(definition => definition.id === "graph.package.read.application")!;
    application.decision = { ...application.decision, capabilityId: application.definition.id };
    application.enabled = true;
    application.configuration = { enabled: true, sharedDataScope: true };

    render(<CapabilityContext value={context([delegated, application])}><CapabilityHealth /></CapabilityContext>);

    expect(screen.getByRole("button", { name: /2 provider-verified \/ 0 local \/ 0 ready to try \/ 0 degraded \/ 0 blocked/ })).toBeInTheDocument();
  });
  it("counts an enabled application mode without approved shared scope as degraded", async () => {
    const application = fixture("not_configured");
    application.definition = capabilityDefinitions.find(definition => definition.id === "graph.package.read.application")!;
    application.decision = { ...application.decision, capabilityId: application.definition.id, authorized: false };
    application.enabled = true;
    application.configuration = { enabled: true, sharedDataScope: false };

    render(<CapabilityContext value={context([application])}><CapabilityHealth /><PermissionCenter /></CapabilityContext>);

    expect(screen.getByRole("button", { name: /0 provider-verified \/ 0 local \/ 0 ready to try \/ 1 degraded \/ 0 blocked/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Shared application modes (1)" }));
    const details = await openDetails(application.definition.displayName);
    expect(details.getByText("Application mode").nextElementSibling).toHaveTextContent("Enabled; shared scope not approved");
  });
  it.each([
    ["interaction_required", "Continue sign-in / consent"],
    ["authorization_expired", "Sign in again"],
  ] as const)("offers the accurate %s interaction action without redirecting automatically", (category, action) => {
    const interactive = fixture("unknown");
    interactive.decision.evidence = { category };

    render(<CapabilityContext value={context([interactive])}><PermissionCenter /></CapabilityContext>);

    expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request consent" })).not.toBeInTheDocument();
  });
  it.each([
    ["authorization_not_yet_valid", "Check the application host clock and time synchronization."],
    ["identity_provider_error", "Retry and troubleshoot the identity provider if the error persists."],
  ])("preserves %s remediation without requesting consent", async (category, remediation) => {
    const failed = fixture("provider_error");
    failed.decision.verification = "token";
    failed.decision.evidence = { category, providerErrorCode: "AADSTS50013", correlationId: "identity-request-123" };
    failed.decision.remediation = [remediation];
    render(<CapabilityContext value={context([failed])}><PermissionCenter /></CapabilityContext>);
    expect(screen.queryByRole("button", { name: /Request consent|Sign in again|Continue sign-in/ })).not.toBeInTheDocument();
    const details = await openDetails(failed.definition.displayName);
    expect(details.getByText(remediation)).toBeVisible();
    expect(details.getByText("AADSTS50013")).toBeVisible();
    expect(details.queryByText(/Token acquired/)).not.toBeInTheDocument();
    expect(details.queryByText("Provider HTTP status")).not.toBeInTheDocument();
  });
  it("shows cancellation and conditional-access outcomes without provider error text", () => {
    window.history.replaceState({}, "", "/permissions?authorization=interaction_required");
    render(<CapabilityContext value={context([])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByRole("status")).toHaveTextContent("Conditional Access");
  });
  it.each(["provider", "token", "on_demand"] as const)("does not label a failed %s check successful or stale", async verification => {
    const failed = fixture("provider_error");
    failed.decision.verification = verification;
    failed.decision.lastSuccessAt = new Date(Date.now() - 30_000).toISOString();
    render(<CapabilityContext value={context([failed])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByText("Provider error")).toBeInTheDocument();
    const details = await openDetails(failed.definition.displayName);
    expect(details.getByText("Verification").nextElementSibling).toHaveTextContent("Check did not establish current availability");
    expect(details.queryByText(/stale evidence/)).not.toBeInTheDocument();
    expect(details.queryByText(/Provider-verified|Token acquired|Ready to try;/)).not.toBeInTheDocument();
    expect(details.getByText("Last recorded success (historical)")).toBeVisible();
    expect(details.getByText(/last recorded success is historical/)).toBeVisible();
  });
  it("does not describe token or local history as provider success", async () => {
    const token = fixture("unknown");
    token.decision.verification = "token";
    token.decision.checkedAt = undefined;
    const local = fixture("missing_internal_role");
    local.definition = capabilityDefinitions.find(item => item.mode === "local")!;
    local.decision.capabilityId = local.definition.id;
    local.decision.verification = "local";
    render(<CapabilityContext value={context([token, local])}><PermissionCenter /></CapabilityContext>);
    const tokenDetails = await openDetails(token.definition.displayName);
    expect(tokenDetails.getByText("No successful check recorded")).toBeVisible();
    expect(tokenDetails.getByText("Not checked; no current verification")).toBeVisible();
    await closeDetails(token.definition.displayName);
    const localDetails = await openDetails(local.definition.displayName);
    expect(localDetails.getByText("No successful check recorded")).toBeVisible();
    expect(localDetails.getByText("Local policy authorization not established")).toBeVisible();
    expect(screen.queryByText(/No provider success/)).not.toBeInTheDocument();
  });
  it("keeps verified provider, local, ready, and failed health counts separate", () => {
    const provider = fixture("available");
    const local = fixture("available");
    local.definition = capabilityDefinitions.find(item => item.mode === "local")!;
    local.decision.capabilityId = local.definition.id;
    local.decision.verification = "local";
    const ready = onDemandFixture("graph.package.block.manage");
    const token = fixture("available");
    token.definition = capabilityDefinitions.find(item => item.id === "powerPlatform.quarantine.manage")!;
    token.decision.capabilityId = token.definition.id;
    token.decision.verification = "token";
    const failed = fixture("provider_error");
    const blocked = fixture("missing_permission");
    render(<CapabilityContext value={context([provider, local, ready, token, failed, blocked])}><CapabilityHealth /></CapabilityContext>);
    expect(screen.getByRole("button")).toHaveTextContent("Permissions: 2 need attention");
    expect(screen.getByRole("button")).toHaveAccessibleName("1 provider-verified / 1 local / 2 ready to try / 1 degraded / 1 blocked");
  });
  it("does not label disabled application evidence current", async () => {
    const application = fixture("available");
    application.definition = capabilityDefinitions.find(item => item.id === "graph.package.read.application")!;
    application.decision.capabilityId = application.definition.id;
    application.enabled = false;
    render(<CapabilityContext value={context([application])}><PermissionCenter /></CapabilityContext>);
    await userEvent.click(screen.getByRole("button", { name: "Shared application modes (1)" }));
    const details = await openDetails(application.definition.displayName);
    expect(details.getByText("Verification").nextElementSibling).toHaveTextContent("Disabled; no current verification");
    expect(details.getByText("Operation access").nextElementSibling).toHaveTextContent("No separate operation check");
    expect(details.queryByText("Provider-verified")).not.toBeInTheDocument();
  });
  it("explains on-demand quarantine authorization without claiming token acquisition", async () => {
    const quarantine = onDemandFixture("powerPlatform.quarantine.manage");
    render(<CapabilityContext value={context([quarantine])}><PermissionCenter /></CapabilityContext>);
    const details = await openDetails(quarantine.definition.displayName);
    expect(details.getByText("Operation access").nextElementSibling).toHaveTextContent("Microsoft validates permission when the operation is requested");
    expect(details.getByText("Ready to try")).toBeVisible();
    expect(details.getByText("Verification").nextElementSibling).toHaveTextContent("Ready to try; Microsoft validates permission on the actual operation");
  });
  it.each(["503", 503])("renders structured provider diagnostics with HTTP status %s without raw messages", async httpStatus => {
    const failed = fixture("provider_error");
    failed.decision.evidence = JSON.parse(JSON.stringify({
      category: "provider_error",
      httpStatus,
      providerErrorCode: "ServiceUnavailable",
      correlationId: "request-fixture-123",
      message: "Raw upstream message must not be rendered",
    }));
    render(<CapabilityContext value={context([failed])}><PermissionCenter /></CapabilityContext>);
    const evidence = await openDetails(failed.definition.displayName);
    expect(evidence.getByText("Provider HTTP status").nextElementSibling).toHaveTextContent("503");
    expect(evidence.getByText("Provider error code").nextElementSibling).toHaveTextContent("ServiceUnavailable");
    expect(evidence.getByText("Provider request / correlation ID").nextElementSibling).toHaveTextContent("request-fixture-123");
    expect(evidence.queryByText(/Raw upstream message/)).not.toBeInTheDocument();
    expect(screen.queryByText("Provider-verified")).not.toBeInTheDocument();
  });
  it("omits diagnostics that were not reported", async () => {
    render(<CapabilityContext value={context([fixture("provider_error")])}><PermissionCenter /></CapabilityContext>);
    const evidence = await openDetails("Package catalog read");
    expect(evidence.queryByText("Provider HTTP status")).not.toBeInTheDocument();
    expect(evidence.queryByText("Provider error code")).not.toBeInTheDocument();
    expect(evidence.queryByText("Provider request / correlation ID")).not.toBeInTheDocument();
  });
  it.each([
    ["missing_permission", undefined, "Request consent"],
    ["unknown", "authorization_expired", "Sign in again"],
    ["unknown", "interaction_required", "Continue sign-in / consent"],
  ] as const)("opens local setup help without starting authorization beside %s / %s", async (status, category, action) => {
    const view = fixture(status);
    view.decision.evidence = category ? { category } : undefined;
    const beginConsent = vi.spyOn(apiClient, "beginCapabilityConsent").mockRejectedValue(new Error("Unexpected consent attempt"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<CapabilityContext value={context([view])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const details = await openDetails(view.definition.displayName);

    expect(showModal).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: view.definition.displayName })).toBeVisible();
    expect(details.getByText(/Use the tenant's existing app registration/)).toBeVisible();
    expect(beginConsent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/");
  });
  it("has accessible tables and a single details view without nested expanders", async () => {
    const { container } = render(<main><CapabilityContext value={context([fixture("provider_error")])}><PermissionCenter /></CapabilityContext></main>);
    expect(screen.getByRole("table", { name: "Account permissions" })).toBeVisible();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    const details = await openDetails("Package catalog read");
    expect(details.getByRole("region", { name: "Access requirements" })).toBeVisible();
    expect(details.getByRole("region", { name: "Check evidence" })).toBeVisible();
    expect(details.getByRole("region", { name: "Setup and documentation" })).toBeVisible();
    expect(container.querySelector("details")).toBeNull();
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
  it("groups all delivered account capabilities by task and keeps requirements out of the overview", () => {
    const views = capabilityDefinitions.map(definition => ({
      ...fixture("available"), definition,
      decision: { ...fixture("available").decision, capabilityId: definition.id, verification: definition.mode === "local" ? "local" as const : "provider" as const },
    }));
    render(<CapabilityContext value={context(views)}><PermissionCenter /></CapabilityContext>);
    const table = screen.getByRole("table", { name: "Account permissions" });
    expect(within(table).getAllByRole("button", { name: /^View details for/ })).toHaveLength(12);
    for (const group of ["Inventory & people", "Agent controls", "Reports & investigations"]) expect(within(table).getByText(group)).toBeVisible();
    expect(within(table).queryByText("Package reassignment")).not.toBeInTheDocument();
    expect(screen.queryByText("Resource audience")).not.toBeInTheDocument();
    expect(screen.queryByText("Last recorded success (historical)")).not.toBeInTheDocument();
    expect(screen.getByText("Provider verified").nextElementSibling).toHaveTextContent("11");
    expect(screen.getByText("Local access").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Needs attention", { selector: "dt" }).nextElementSibling).toHaveTextContent("0");
  });
  it("filters attention without treating untried operations or disabled modes as problems", async () => {
    const ready = onDemandFixture("graph.package.block.manage");
    const failed = fixture("provider_error");
    const disabled = { ...fixture("not_configured"), definition: capabilityDefinitions.find(item => item.id === "graph.package.read.application")!, enabled: false };
    render(<CapabilityContext value={context([ready, failed, disabled])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByText("Ready to try", { selector: "dt" }).nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Needs attention", { selector: "dt" }).nextElementSibling).toHaveTextContent("1");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Show" }), "attention");
    expect(screen.getByRole("row", { name: failed.definition.displayName })).toBeVisible();
    expect(screen.queryByRole("row", { name: ready.definition.displayName })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Shared application modes (1)" }));
    expect(screen.getByRole("combobox", { name: "Show" })).toHaveValue("all");
    expect(screen.getByText("Disabled", { selector: ".capability-status" })).toBeVisible();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Show" }), "attention");
    expect(screen.getByText("No capabilities in this view need attention.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Show all capabilities" }));
    expect(screen.getByRole("row", { name: disabled.definition.displayName })).toBeVisible();
  });
  it("updates open details and attention counts when evidence expires instead of keeping a snapshot", async () => {
    const view = fixture("available");
    const { rerender } = render(<CapabilityContext value={context([view])}><PermissionCenter /></CapabilityContext>);
    const details = await openDetails(view.definition.displayName);
    expect(details.getByText("Provider-verified")).toBeVisible();
    rerender(<CapabilityContext value={{ ...context([view]), now: Date.parse(view.decision.expiresAt!) + 1 }}><PermissionCenter /></CapabilityContext>);
    expect(details.getByText("Stale evidence; no current verification")).toBeVisible();
    expect(details.queryByText("Provider-verified")).not.toBeInTheDocument();
    expect(screen.getByText("Needs attention", { selector: "dt" }).nextElementSibling).toHaveTextContent("1");
    await closeDetails(view.definition.displayName);
    expect(screen.getByRole("button", { name: `View details for ${view.definition.displayName}` })).toHaveFocus();
  });
  it("shows catalog failures explicitly and does not present empty counts as successful checks", () => {
    render(<CapabilityContext value={{ ...context([]), error: "Permission catalog unavailable." }}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByRole("alert")).toHaveTextContent("Permission catalog unavailable.");
    expect(screen.queryByText("Provider verified")).not.toBeInTheDocument();
    expect(screen.getByText(/No permission information is available/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
  });
  it("returns focus to the page heading when an open capability is removed", async () => {
    const view = fixture("available");
    const { rerender } = render(<CapabilityContext value={context([view])}><PermissionCenter /></CapabilityContext>);
    await openDetails(view.definition.displayName);
    rerender(<CapabilityContext value={context([])}><PermissionCenter /></CapabilityContext>);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Permissions" })).toHaveFocus();
  });
  it("keeps transport errors visible alongside authorization outcomes", () => {
    window.history.replaceState({}, "", "/permissions?authorization=cancelled");
    render(<CapabilityContext value={{ ...context([]), error: "Permission catalog unavailable." }}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByRole("status")).toHaveTextContent("Consent was cancelled or denied");
    expect(screen.getByRole("alert")).toHaveTextContent("Permission catalog unavailable.");
  });
  it("surfaces a check failure in the open details view instead of behind its modal", async () => {
    const view = fixture("available");
    const { rerender } = render(<CapabilityContext value={context([view])}><PermissionCenter /></CapabilityContext>);
    const details = await openDetails(view.definition.displayName);
    rerender(<CapabilityContext value={{ ...context([view]), error: "Automatic permission check failed." }}><PermissionCenter /></CapabilityContext>);
    expect(details.getByRole("alert")).toHaveTextContent("Automatic permission check failed.");
    await closeDetails(view.definition.displayName);
    expect(screen.getByRole("alert")).toHaveTextContent("Automatic permission check failed.");
  });
});