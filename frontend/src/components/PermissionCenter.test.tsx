import { render, screen, within, waitFor } from "@testing-library/react";
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
import { CapabilityGate } from "./CapabilityGate";
import { CapabilityHealth, PermissionCenter } from "./PermissionCenter";

const user: SessionUser = { displayName: "Synthetic administrator", username: "fixture@example.invalid", homeAccountId: "fixture-a", roles: [...appRoles] };
function fixture(status: CapabilityStatus): CapabilityView {
  return { definition: capabilityDefinitions[0], decision: { capabilityId: capabilityDefinitions[0].id, status, authorized: status === "available", fresh: true, verification: "provider", checkedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), previewQualification: "not_required", remediation: ["Check the documented requirements."] } };
}
function context(views: CapabilityView[]) {
  return { views, user, loading: false, pending: false, error: undefined, now: Date.now(), reload: vi.fn(), openPermissions: vi.fn() };
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

describe("Permission Center", () => {
  it("does not mistake untried operations for missing consent or claim provider proof", () => {
    const views = (["graph.package.block.manage", "graph.package.access.manage", "powerPlatform.quarantine.manage"] as const).map(onDemandFixture);
    const consent = vi.spyOn(apiClient, "beginCapabilityConsent").mockRejectedValue(new Error("Synthetic consent failure"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<CapabilityContext value={context(views)}><CapabilityHealth /><PermissionCenter /></CapabilityContext>);
    expect(screen.getByRole("button", { name: "0 provider-verified / 0 local / 3 ready to try / 0 degraded / 0 blocked" })).toBeVisible();
    expect(screen.getAllByText("Ready to try", { exact: true })).toHaveLength(3);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByText("Ready to try; Microsoft validates permission on the actual operation")).toHaveLength(3);
    expect(screen.getAllByText("Not checked", { selector: "dd" })).toHaveLength(3);
    expect(screen.getAllByText("No successful check recorded")).toHaveLength(3);
    expect(consent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Request consent" })).not.toBeInTheDocument();
  });
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
      expect(consent).toHaveBeenCalledWith(id, "/permissions");
      expect(await screen.findByText(/Consent could not start/)).toBeVisible();
      const recovered: CapabilityView = { ...ready, decision: {
        ...fixture("available").decision, capabilityId: id, verification: "token",
      } };
      rerender(<CapabilityContext value={context([recovered])}><PermissionCenter /></CapabilityContext>);
      expect(screen.queryByRole("button", { name: "Request consent" })).not.toBeInTheDocument();
      expect(screen.getByText("Token acquired; provider authorization not verified")).toBeVisible();
      expect(screen.getByRole("link", { name: id === "powerPlatform.quarantine.manage" ? "Open Power Platform" : "Open Agents" })).toBeVisible();
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
    ["powerPlatform.quarantine.read", "Open Power Platform", "/power-platform"],
    ["powerPlatform.quarantine.manage", "Open Power Platform", "/power-platform"],
    ["purview.audit.search.delegated", "Open Audit", "/audit"],
    ["defender.hunting.delegated", "Open Security", "/security"],
  ])("offers navigation, not automatic provider execution, for %s", (id, label, href) => {
    const ready = fixture("available");
    ready.definition = capabilityDefinitions.find(item => item.id === id)!;
    ready.decision.verification = "token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<CapabilityContext value={context([ready])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
    expect(screen.getByText("Ready to try")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request consent" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(Object.keys(statusLabels) as CapabilityStatus[])("renders %s with exact requirements and safe actions", async status => {
    const value = context([fixture(status)]);
    render(<CapabilityContext value={value}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByText(statusLabels[status])).toBeInTheDocument();
    expect(screen.getByText("delegated: CopilotPackages.Read.All")).toBeInTheDocument();
    expect(screen.getByText("https://graph.microsoft.com")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Permissions" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Retry probe" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request consent" })).toBe(status === "missing_permission"
      ? screen.getByRole("button", { name: "Request consent" })
      : null);
    expect(screen.getByRole("link", { name: "Microsoft documentation 1" })).toHaveAttribute("href", capabilityDefinitions[0].sources[0]);
  });
  it("shows delivered Power Platform adapters and the role hierarchy", () => {
    render(<CapabilityContext value={context(capabilityDefinitions.map(definition => ({ ...fixture("unknown"), definition })))}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByRole("heading", { name: "Power Platform inventory" })).toBeInTheDocument();
    expect(screen.getByText("delegated: ResourceQuery.Resources.Read")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Copilot Studio quarantine" })).toBeInTheDocument();
    expect(screen.getAllByText("delegated: CopilotStudio.AdminActions.Invoke")).toHaveLength(2);
    for (const role of appRoles) expect(screen.getByText(role, { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText(/Admin inherits every Viewer capability/)).toBeInTheDocument();
  });
  it("uses provider roles only from the contract and only claims a missing role when conclusive", () => {
    const view = fixture("missing_role");
    view.definition = { ...capabilityDefinitions.find(definition => definition.id === "powerPlatform.quarantine.manage")!, probe: { ...view.definition.probe, adapterRegistered: true } };
    render(<CapabilityContext value={context([view])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByText("delegated: CopilotStudio.AdminActions.Invoke")).toBeInTheDocument();
    expect(screen.getByText("Requires Global Administrator or AI Administrator or Power Platform Administrator.")).toBeInTheDocument();
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
  it("separates optional application modes from delegated health", () => {
    const delegated = fixture("available");
    const application = fixture("not_configured");
    application.definition = capabilityDefinitions.find(definition => definition.id === "graph.package.read.application")!;
    application.decision = { ...application.decision, capabilityId: application.definition.id };
    application.enabled = false;
    application.configuration = { enabled: false, sharedDataScope: false };

    render(<CapabilityContext value={context([delegated, application])}><CapabilityHealth /><PermissionCenter /></CapabilityContext>);

    expect(screen.getByRole("button", { name: /1 provider-verified \/ 0 local \/ 0 ready to try \/ 0 degraded \/ 0 blocked/ })).toBeInTheDocument();
    expect(screen.getByText("Optional shared application modes (0 active, 1 inactive)")).toBeInTheDocument();
    expect(screen.getByText(/excluded from the primary permission-health summary/)).toBeInTheDocument();
    expect(screen.getByText("Application mode").nextElementSibling).toHaveTextContent("Disabled");
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
  it("counts an enabled application mode without approved shared scope as degraded", () => {
    const application = fixture("not_configured");
    application.definition = capabilityDefinitions.find(definition => definition.id === "graph.package.read.application")!;
    application.decision = { ...application.decision, capabilityId: application.definition.id, authorized: false };
    application.enabled = true;
    application.configuration = { enabled: true, sharedDataScope: false };

    render(<CapabilityContext value={context([application])}><CapabilityHealth /><PermissionCenter /></CapabilityContext>);

    expect(screen.getByRole("button", { name: /0 provider-verified \/ 0 local \/ 0 ready to try \/ 1 degraded \/ 0 blocked/ })).toBeInTheDocument();
    expect(screen.getByText("Application mode").nextElementSibling).toHaveTextContent("Enabled; shared scope not approved");
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
  ])("preserves %s remediation without requesting consent", (category, remediation) => {
    const failed = fixture("provider_error");
    failed.decision.verification = "token";
    failed.decision.evidence = { category, providerErrorCode: "AADSTS50013", correlationId: "identity-request-123" };
    failed.decision.remediation = [remediation];
    render(<CapabilityContext value={context([failed])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByText(remediation)).toBeInTheDocument();
    expect(screen.getByText("AADSTS50013")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request consent|Sign in again|Continue sign-in/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Token acquired/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Provider HTTP status:/)).not.toBeInTheDocument();
  });
  it("shows cancellation and conditional-access outcomes without provider error text", () => {
    window.history.replaceState({}, "", "/permissions?authorization=interaction_required");
    render(<CapabilityContext value={context([])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByRole("status")).toHaveTextContent("Conditional Access");
  });
  it.each(["provider", "token", "on_demand"] as const)("does not label a failed %s check successful or stale", verification => {
    const failed = fixture("provider_error");
    failed.decision.verification = verification;
    failed.decision.lastSuccessAt = new Date(Date.now() - 30_000).toISOString();
    render(<CapabilityContext value={context([failed])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByText("Verification").nextElementSibling).toHaveTextContent("Check did not establish current availability");
    expect(screen.getByText("Provider error")).toBeInTheDocument();
    expect(screen.queryByText(/stale evidence/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Provider-verified|Token acquired|Ready to try;/)).not.toBeInTheDocument();
    expect(screen.getByText("Last recorded success (historical)")).toBeInTheDocument();
    expect(screen.getByText(/last recorded success is historical/)).toBeInTheDocument();
  });
  it("does not describe token or local history as provider success", () => {
    const token = fixture("unknown");
    token.decision.verification = "token";
    token.decision.checkedAt = undefined;
    const local = fixture("missing_internal_role");
    local.definition = capabilityDefinitions.find(item => item.mode === "local")!;
    local.decision.verification = "local";
    render(<CapabilityContext value={context([token, local])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getAllByText("No successful check recorded")).toHaveLength(2);
    expect(screen.getByText("Not checked; no current verification")).toBeInTheDocument();
    expect(screen.getByText("Local policy authorization not established")).toBeInTheDocument();
    expect(screen.queryByText(/No provider success/)).not.toBeInTheDocument();
  });
  it("keeps verified provider, local, ready, and failed health counts separate", () => {
    const provider = fixture("available");
    const local = fixture("available");
    local.definition = capabilityDefinitions.find(item => item.mode === "local")!;
    local.decision.verification = "local";
    const ready = onDemandFixture("graph.package.block.manage");
    const token = fixture("available");
    token.definition = capabilityDefinitions.find(item => item.id === "powerPlatform.quarantine.manage")!;
    token.decision.verification = "token";
    const failed = fixture("provider_error");
    const blocked = fixture("missing_permission");
    render(<CapabilityContext value={context([provider, local, ready, token, failed, blocked])}><CapabilityHealth /></CapabilityContext>);
    expect(screen.getByRole("button")).toHaveTextContent("1 provider-verified / 1 local / 2 ready to try / 1 degraded / 1 blocked");
  });
  it("does not label disabled application evidence current", () => {
    const application = fixture("available");
    application.definition = capabilityDefinitions.find(item => item.id === "graph.package.read.application")!;
    application.enabled = false;
    render(<CapabilityContext value={context([application])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByText("Verification").nextElementSibling).toHaveTextContent("Disabled; no current verification");
    expect(screen.getByText("Operation access").nextElementSibling).toHaveTextContent("No separate operation check");
    expect(screen.queryByText("Provider-verified")).not.toBeInTheDocument();
  });
  it("explains on-demand quarantine authorization without claiming token acquisition", () => {
    const quarantine = onDemandFixture("powerPlatform.quarantine.manage");
    render(<CapabilityContext value={context([quarantine])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByText("Operation access").nextElementSibling).toHaveTextContent("Microsoft validates permission when the operation is requested");
    expect(screen.getByText("Ready to try")).toBeInTheDocument();
    expect(screen.getByText("Verification").nextElementSibling).toHaveTextContent("Ready to try; Microsoft validates permission on the actual operation");
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
    const summary = screen.getByText("Evidence and remediation");
    await userEvent.click(summary);
    const evidence = within(summary.parentElement!);
    expect(evidence.getByText(/Provider HTTP status:/)).toHaveTextContent("503");
    expect(evidence.getByText(/Provider error code:/)).toHaveTextContent("ServiceUnavailable");
    expect(evidence.getByText(/Provider request \/ correlation ID:/)).toHaveTextContent("request-fixture-123");
    expect(evidence.queryByText(/Raw upstream message/)).not.toBeInTheDocument();
    expect(screen.queryByText("Provider-verified")).not.toBeInTheDocument();
  });
  it("omits diagnostics that were not reported", () => {
    render(<CapabilityContext value={context([fixture("provider_error")])}><PermissionCenter /></CapabilityContext>);
    expect(screen.queryByText(/Provider HTTP status:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Provider error code:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Provider request \/ correlation ID:/)).not.toBeInTheDocument();
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
    const dialog = screen.getByRole("dialog", { hidden: true });
    const showModal = vi.fn(() => dialog.setAttribute("open", ""));
    Object.defineProperty(dialog, "showModal", { value: showModal });

    await userEvent.click(screen.getByRole("button", { name: "Setup instructions" }));

    expect(showModal).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: `${view.definition.displayName} setup` })).toBeVisible();
    expect(within(dialog).getByText(/Use the tenant's existing app registration/)).toBeInTheDocument();
    expect(beginConsent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/");
  });
  it("has no DOM accessibility violations and expandable evidence panels", async () => {
    const { container } = render(<main><CapabilityContext value={context([fixture("provider_error")])}><PermissionCenter /></CapabilityContext></main>);
    const article = screen.getByRole("article");
    const summary = within(article).getByText("Evidence and remediation");
    await userEvent.click(summary);
    await waitFor(() => expect(summary.parentElement).toHaveAttribute("open"));
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
});