import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { appRoles } from "../../../backend/src/types/capability";
import { getCurrentUser, type CapabilityStatus, type CapabilityView, type SessionUser } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { statusLabels } from "../capabilityState";
import { useCapabilities } from "../useCapabilities";
import { CapabilityGate } from "./CapabilityGate";
import { CapabilityHealth, PermissionCenter } from "./PermissionCenter";

const user: SessionUser = { displayName: "Synthetic administrator", username: "fixture@example.invalid", homeAccountId: "fixture-a", roles: [...appRoles] };
function fixture(status: CapabilityStatus): CapabilityView {
  return { definition: capabilityDefinitions[0], decision: { capabilityId: capabilityDefinitions[0].id, status, authorized: status === "available", fresh: true, expiresAt: new Date(Date.now() + 60000).toISOString(), previewQualification: "not_required", remediation: ["Check the documented requirements."] } };
}
function context(views: CapabilityView[]) {
  return { views, user, loading: false, pending: undefined, error: undefined, now: Date.now(), reload: vi.fn(), refresh: vi.fn(), openPermissions: vi.fn() };
}
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

describe("Permission Center", () => {
  it.each(Object.keys(statusLabels) as CapabilityStatus[])("renders %s with exact requirements and safe actions", async status => {
    const value = context([fixture(status)]);
    render(<CapabilityContext value={value}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByText(statusLabels[status])).toBeInTheDocument();
    expect(screen.getByText("delegated: CopilotPackages.Read.All")).toBeInTheDocument();
    expect(screen.getByText("https://graph.microsoft.com")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Permissions" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Retry probe" }));
    expect(value.refresh).toHaveBeenCalledExactlyOnceWith("graph.package.read.delegated");
    expect(screen.getByRole("link", { name: "Microsoft documentation 1" })).toHaveAttribute("href", capabilityDefinitions[0].sources[0]);
  });
  it("shows delivered Power Platform adapters and independent roles", () => {
    render(<CapabilityContext value={context(capabilityDefinitions.map(definition => ({ ...fixture("unknown"), definition })))}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByRole("heading", { name: "Power Platform inventory" })).toBeInTheDocument();
    expect(screen.getByText("delegated: ResourceQuery.Resources.Read")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Copilot Studio quarantine" })).toBeInTheDocument();
    expect(screen.getByText("delegated: CopilotStudio.AdminActions.Invoke")).toBeInTheDocument();
    for (const role of appRoles) expect(screen.getByText(role, { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText(/Administrator does not inherit/)).toBeInTheDocument();
  });
  it("uses provider roles only from the contract and only claims a missing role when conclusive", () => {
    const view = fixture("missing_role");
    view.definition = { ...capabilityDefinitions.find(definition => definition.id === "powerPlatform.quarantine.manage")!, probe: { ...view.definition.probe, adapterRegistered: true } };
    render(<CapabilityContext value={context([view])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByText("delegated: CopilotStudio.AdminActions.Invoke")).toBeInTheDocument();
    expect(screen.getByText("Requires Global Administrator or AI Administrator or Power Platform Administrator.")).toBeInTheDocument();
  });
  it("explains a disabled write while retaining role-authorized saved data", async () => {
    const view = fixture("available"); view.decision.previewQualification = "unqualified";
    const value = context([view]); const write = vi.fn(); const read = vi.fn();
    render(<CapabilityContext value={value}><CapabilityGate capability={view.definition.id} write><button onClick={write}>Write</button></CapabilityGate><CapabilityGate roles={["AgentControl.Reader"]}><button onClick={read}>Saved data</button></CapabilityGate></CapabilityContext>);
    await userEvent.click(screen.getByRole("button", { name: "Write" })); expect(write).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Write" })).toHaveAccessibleDescription(/writes remain unqualified/);
    await userEvent.click(screen.getByRole("button", { name: "Saved data" })); expect(read).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: /Permissions:/ })); expect(value.openPermissions).toHaveBeenCalledOnce();
  });
  it("performs explicit probe and consent requests through the API client with CSRF", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      requests.push({ url: input, init });
      if (input === "/api/me") return Response.json({ user, csrfToken: "fixture-csrf" });
      if (input.endsWith("/probe")) return Response.json(fixture("available").decision);
      if (input === "/api/auth/consent") return Response.json({ type: "https://agent-control.invalid/problems/interaction_required", status: 403, code: "interaction_required", detail: "Synthetic conditional access", requestId: "fixture-request" }, { status: 403, headers: { "Content-Type": "application/problem+json" } });
      return Response.json({ value: [fixture("missing_permission")] });
    });
    vi.stubGlobal("fetch", fetchMock); await getCurrentUser();
    function Harness() { const value = useCapabilities(user); return <CapabilityContext value={{ ...value, openPermissions: vi.fn() }}><CapabilityHealth /><PermissionCenter /></CapabilityContext>; }
    render(<Harness />);
    await screen.findByText("Missing app permission");
    expect(requests.filter(request => request.url.endsWith("/probe"))).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Retry probe" }));
    await screen.findByText("Available");
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
    expect(screen.getByRole("button", { name: /0 available \/ 1 degraded \/ 0 blocked/ })).toBeInTheDocument();
  });
  it("shows cancellation and conditional-access outcomes without provider error text", () => {
    window.history.replaceState({}, "", "/permissions?authorization=interaction_required");
    render(<CapabilityContext value={context([])}><PermissionCenter /></CapabilityContext>);
    expect(screen.getByRole("status")).toHaveTextContent("Conditional Access");
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