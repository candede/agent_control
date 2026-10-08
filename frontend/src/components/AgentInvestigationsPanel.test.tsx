import { act, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { ApiError, getAgentInvestigationContext, getAgentPurviewRecords, resolveAgentInvestigationIdentity, type AgentInvestigationContext } from "../api/client";
import { AgentInvestigationsPanel } from "./AgentInvestigationsPanel";
import { PurviewAuditView } from "./PurviewAuditView";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { createSavedQueryClient } from "../savedQueries";

vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(),
  getAgentInvestigationContext: vi.fn(),
  getAgentPurviewRecords: vi.fn(),
  resolveAgentInvestigationIdentity: vi.fn(),
}));
vi.mock("./DefenderHuntingView", () => ({
  DefenderHuntingView: ({ agentRecordId, entraAgentIds, userObjectId, active, contextCurrent }: {
    agentRecordId: string; entraAgentIds: string[]; userObjectId?: string; active: boolean; contextCurrent: boolean;
  }) => active ? <div aria-label="Scoped Defender hunt" data-user={userObjectId} data-current={contextCurrent}>{agentRecordId} / {entraAgentIds.join(",")}</div> : null,
}));
vi.mock("./PurviewAuditView", () => ({
  PurviewAuditView: vi.fn(({ agentRecordId, userPrincipalName, active, contextCurrent }: {
    agentRecordId?: string; userPrincipalName?: string; active?: boolean; contextCurrent?: boolean;
  }) => active ? <div aria-label="Scoped Purview search" data-user={userPrincipalName} data-current={contextCurrent}>{agentRecordId}</div> : null),
}));

const recordId = "power_platform:environment-a:agent-a";
const entraId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const investigation: AgentInvestigationContext = {
  recordId, displayName: "Agent A",
  defender: { status: "available", entraAgentIds: [entraId] },
  purview: { status: "available", mode: "search", presets: ["copilot_studio_admin"] },
};
const unresolved: AgentInvestigationContext = {
  ...investigation,
  defender: {
    status: "unavailable", entraAgentIds: [], reasonCode: "identity_resolution_required",
    resolution: { canResolve: true, capabilityId: "graph.agentIdentity.read" },
  },
};
const capability: ReturnType<typeof useCapabilityContext> = {
  user: { homeAccountId: "principal-a", tenantId: "tenant-a", displayName: "Viewer", username: "viewer@example.invalid", roles: ["AgentControl.Viewer"] },
  views: [], loading: false, pending: false, error: undefined, now: Date.now(),
  reload: vi.fn(async () => {}), openPermissions: vi.fn(),
};

function panel(id = recordId, roles: ("AgentControl.Viewer" | "AgentControl.Admin")[] = ["AgentControl.Viewer"], access = capability, revision = "1") {
  return <CapabilityContext value={access}><AgentInvestigationsPanel recordId={id} agentName={id === recordId ? "Agent A" : "Agent B"} roles={roles} revision={revision} /></CapabilityContext>;
}

function render(ui: ReactNode) {
  const rendered = rtlRender(ui);
  for (const source of screen.queryAllByRole("combobox", { name: "Source" })) {
    fireEvent.change(source, { target: { value: "defender" } });
  }
  return rendered;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAgentInvestigationContext).mockResolvedValue(investigation);
  vi.mocked(resolveAgentInvestigationIdentity).mockResolvedValue(investigation);
});

describe("agent investigations", () => {
  it("defaults to a usable source and passes the saved agent target without setup clutter", async () => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValue(unresolved);
    const { container } = rtlRender(panel());
    expect(await screen.findByLabelText("Scoped Purview search")).toHaveTextContent(recordId);
    expect(screen.getByRole("combobox", { name: "Source" })).toHaveValue("purview");
    expect(PurviewAuditView).toHaveBeenLastCalledWith(expect.objectContaining({
      agentRecordId: recordId, presets: ["copilot_studio_admin"], contextCurrent: true,
    }), undefined);
    expect(container.querySelector("details")).toBeNull();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
    expect(resolveAgentInvestigationIdentity).not.toHaveBeenCalled();
  });

  it("intersects the same verified user with both agent log sources", async () => {
    const user = { objectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", userPrincipalName: "reader@example.invalid" };
    rtlRender(<CapabilityContext value={capability}><AgentInvestigationsPanel
      recordId={recordId} agentName="Agent A" roles={["AgentControl.Viewer"]} user={user}
    /></CapabilityContext>);
    expect(await screen.findByLabelText("Scoped Purview search")).toHaveAttribute("data-user", user.userPrincipalName);
    expect(PurviewAuditView).toHaveBeenLastCalledWith(expect.objectContaining({
      agentRecordId: recordId, userPrincipalName: user.userPrincipalName,
    }), undefined);
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "defender" } });
    expect(screen.getByLabelText("Scoped Defender hunt")).toHaveAttribute("data-user", user.objectId);
    expect(screen.getByLabelText("Scoped Defender hunt")).toHaveTextContent(recordId);
  });

  it("resolves the selected saved agent and never asks for pasted IDs or starts a provider query", async () => {
    render(panel());
    expect(await screen.findByLabelText("Scoped Defender hunt")).toHaveTextContent(`${recordId} / ${entraId}`);
    expect(getAgentInvestigationContext).toHaveBeenCalledExactlyOnceWith(recordId, { signal: expect.any(AbortSignal) });
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
    expect(resolveAgentInvestigationIdentity).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Agent IDs")).not.toBeInTheDocument();
    expect(screen.queryByText("Metadata only. Hunts run only when requested.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Setup & permissions" })).not.toBeInTheDocument();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
  });

  it("does not request identities or audit records without Viewer", () => {
    render(panel(recordId, []));
    expect(getAgentInvestigationContext).not.toHaveBeenCalled();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
    expect(screen.getByText("An AgentControl.Viewer role is required to view agent logs.")).toBeVisible();
  });

  it("states saved-agent unavailability without recommending refresh or implying logs are empty", async () => {
    vi.mocked(getAgentInvestigationContext).mockRejectedValue(new ApiError(404, "agent_not_found",
      "This agent is not available in the current saved inventory."));
    render(panel());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This agent is not available in the current saved inventory.");
    expect(alert).not.toHaveTextContent(/refresh|sync|retry/i);
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "purview" } });
    expect(alert).toBeVisible();
    expect(getAgentInvestigationContext).toHaveBeenCalledOnce();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
    expect(resolveAgentInvestigationIdentity).not.toHaveBeenCalled();
  });

  it("explains a missing identity without falling back to a tenant-wide hunt", async () => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValue({
      ...investigation, defender: { status: "unavailable", reason: "No verified Entra agent identity.", entraAgentIds: [] },
    });
    render(panel());
    expect(await screen.findByRole("heading", { name: "Defender identity not mapped" })).toBeVisible();
    expect(screen.getByText("No verified Entra agent identity.")).toBeVisible();
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    expect(screen.queryByText("Technical details")).not.toBeInTheDocument();
  });

  it("keeps unavailable Purview concise without implying live collection or requesting records", async () => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValue({
      ...investigation, purview: { status: "unavailable", mode: "search", presets: [], reason: "An exact bot ID and environment are missing." },
    });
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "purview" } });
    expect(screen.getByRole("heading", { name: "Purview identity not mapped" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Purview log coverage and setup" })).not.toBeInTheDocument();
    expect(screen.getByText("An exact bot ID and environment are missing.")).toBeVisible();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Tenant Audit Search" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Setup & permissions" })).not.toBeInTheDocument();
  });

  it("resolves only the selected agent on explicit request and rereads saved scope before unlocking hunts", async () => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValueOnce(unresolved).mockResolvedValue(investigation);
    render(panel());
    await screen.findByRole("button", { name: "Resolve log identity" });
    expect(resolveAgentInvestigationIdentity).not.toHaveBeenCalled();
    expect(screen.queryByText(/cannot link logs/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resolve log identity" }));
    expect(await screen.findByLabelText("Scoped Defender hunt")).toHaveTextContent(`${recordId} / ${entraId}`);
    expect(resolveAgentInvestigationIdentity).toHaveBeenCalledExactlyOnceWith(recordId, { signal: expect.any(AbortSignal) });
    expect(getAgentInvestigationContext).toHaveBeenCalledTimes(2);
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
  });

  it("admits one identity lookup and stays busy until fresh saved context finishes", async () => {
    const lookup = deferred<AgentInvestigationContext>();
    const readback = deferred<AgentInvestigationContext>();
    vi.mocked(getAgentInvestigationContext).mockResolvedValueOnce(unresolved).mockReturnValueOnce(readback.promise);
    vi.mocked(resolveAgentInvestigationIdentity).mockReturnValue(lookup.promise);
    render(panel());
    const resolve = await screen.findByRole("button", { name: "Resolve log identity" });
    act(() => {
      fireEvent.click(resolve);
      fireEvent.click(resolve);
    });
    expect(resolveAgentInvestigationIdentity).toHaveBeenCalledOnce();
    await act(async () => lookup.resolve(investigation));
    await waitFor(() => expect(getAgentInvestigationContext).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Resolving log identity..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh investigation access" })).toBeDisabled();
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    await act(async () => readback.resolve(investigation));
    expect(await screen.findByLabelText("Scoped Defender hunt")).toHaveAttribute("data-current", "true");
    expect(screen.queryByText("Verifying the selected agent with Microsoft Graph...")).not.toBeInTheDocument();
  });

  it("surfaces lookup permission failures and supports an explicit retry without falsely unlocking hunts", async () => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValue(unresolved);
    vi.mocked(resolveAgentInvestigationIdentity).mockRejectedValueOnce(new Error("AgentIdentity.Read.All requires administrator consent."));
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Resolve log identity" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("AgentIdentity.Read.All requires administrator consent.");
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    expect(getAgentInvestigationContext).toHaveBeenCalledTimes(2);
    vi.mocked(getAgentInvestigationContext).mockResolvedValue(investigation);
    fireEvent.click(screen.getByRole("button", { name: "Resolve log identity" }));
    await screen.findByLabelText("Scoped Defender hunt");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not trust a successful lookup response when the fresh saved-context read fails", async () => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValueOnce(unresolved).mockRejectedValueOnce(new Error("Saved inventory authorization expired."));
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Resolve log identity" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved inventory authorization expired.");
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
  });

  it("hides an old verified scope while refreshing and reloads the saved denial after failure", async () => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValueOnce({
      ...investigation, defender: { ...investigation.defender, resolution: {
        canResolve: true, capabilityId: "graph.agentIdentity.read", cacheStatus: "resolved",
        resolvedAt: "2026-09-23T10:00:00Z",
      } },
    }).mockResolvedValue({
      ...unresolved, defender: { ...unresolved.defender, resolution: {
        canResolve: true, capabilityId: "graph.agentIdentity.read", cacheStatus: "not_found",
      } },
    });
    let fail!: (cause: Error) => void;
    vi.mocked(resolveAgentInvestigationIdentity).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Refresh log identity" }));
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    await act(async () => fail(new Error("The saved candidate was not found.")));
    expect(await screen.findByRole("alert")).toHaveTextContent("The saved candidate was not found.");
    expect(await screen.findByText(/Microsoft Graph found no accessible agent identity/)).toBeVisible();
    expect(getAgentInvestigationContext).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
  });

  it("keeps the old verified scope hidden when both the refresh and saved-context reread fail", async () => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValueOnce({
      ...investigation, defender: { ...investigation.defender, resolution: {
        canResolve: true, capabilityId: "graph.agentIdentity.read", resolvedAt: "2026-09-23T10:00:00Z",
      } },
    }).mockRejectedValue(new Error("Saved inventory is unavailable."));
    vi.mocked(resolveAgentInvestigationIdentity).mockRejectedValue(new Error("Identity lookup was denied."));
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Refresh log identity" }));
    expect(await screen.findByText("Saved inventory is unavailable.")).toBeVisible();
    expect(screen.getByText(/Identity lookup was denied/)).toBeVisible();
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    expect(getAgentInvestigationContext).toHaveBeenCalledTimes(2);
  });

  it.each(["agent", "principal", "role"] as const)("aborts a pending identity lookup on %s changes and ignores late success", async change => {
    let finish!: (value: AgentInvestigationContext) => void;
    let signal!: AbortSignal;
    vi.mocked(getAgentInvestigationContext).mockResolvedValue(unresolved);
    vi.mocked(resolveAgentInvestigationIdentity).mockImplementation((_id, options) => {
      signal = options!.signal!;
      return new Promise(resolve => { finish = resolve; });
    });
    const view = render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Resolve log identity" }));
    expect(screen.getByRole("button", { name: "Resolving log identity..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh investigation access" })).toBeDisabled();
    if (change === "agent") view.rerender(panel("agent-b"));
    else if (change === "role") view.rerender(panel(recordId, []));
    else view.rerender(panel(recordId, ["AgentControl.Viewer"], { ...capability, user: { ...capability.user!, homeAccountId: "principal-b" } }));
    expect(signal.aborted).toBe(true);
    await act(async () => finish(investigation));
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    expect(getAgentInvestigationContext).toHaveBeenCalledTimes(change === "role" ? 1 : 2);
  });

  it.each(["pending", "failed"] as const)("does not revive a retired %s identity lookup when access returns", async outcome => {
    const definition = capabilityDefinitions.find(item => item.id === "graph.agentIdentity.read")!;
    const access: typeof capability = { ...capability, views: [{
      definition, decision: { capabilityId: definition.id, status: "available", authorized: true, fresh: true,
        previewQualification: "not_required", remediation: [] },
    }] };
    vi.mocked(getAgentInvestigationContext).mockResolvedValue(unresolved);
    const lookup = deferred<AgentInvestigationContext>();
    vi.mocked(resolveAgentInvestigationIdentity).mockReturnValueOnce(lookup.promise);
    const view = render(panel(recordId, ["AgentControl.Viewer"], access));
    fireEvent.click(await screen.findByRole("button", { name: "Resolve log identity" }));
    const signal = vi.mocked(resolveAgentInvestigationIdentity).mock.calls[0][1]!.signal!;
    if (outcome === "failed") {
      await act(async () => lookup.reject(new Error("Retired lookup failure")));
      expect(await screen.findByRole("alert")).toHaveTextContent("Retired lookup failure");
    }

    view.rerender(panel(recordId, ["AgentControl.Viewer"], { ...access, views: [{
      ...access.views[0], decision: { ...access.views[0].decision, authorized: false },
    }] }));
    if (outcome === "pending") expect(signal.aborted).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Resolve log identity" })).toBeEnabled());
    view.rerender(panel(recordId, ["AgentControl.Viewer"], access));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resolve log identity" })).toBeEnabled());
    expect(screen.queryByText(/Retired lookup failure/)).not.toBeInTheDocument();
    if (outcome === "pending") await act(async () => lookup.resolve(investigation));
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    expect(resolveAgentInvestigationIdentity).toHaveBeenCalledOnce();

    vi.mocked(getAgentInvestigationContext).mockResolvedValue(investigation);
    fireEvent.click(screen.getByRole("button", { name: "Resolve log identity" }));
    await screen.findByLabelText("Scoped Defender hunt");
    expect(resolveAgentInvestigationIdentity).toHaveBeenCalledTimes(2);
  });

  it.each(["unsupported_agent_type", "unsupported_identity_crosswalk"] as const)("distinguishes %s from disabled Microsoft telemetry", async reasonCode => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValue({
      ...investigation, defender: { status: "unavailable", reasonCode, entraAgentIds: [] },
    });
    render(panel());
    expect(await screen.findByRole("heading", { name: "Defender linking not supported for this agent" })).toBeVisible();
    expect(screen.getByText(/Changing permissions will not create a missing identity mapping/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Resolve log identity" })).not.toBeInTheDocument();
    expect(resolveAgentInvestigationIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["authorization_required", /Admin prerequisite missing/],
    ["not_found", /Microsoft Graph found no accessible agent identity/],
    ["provider_error", /The identity lookup failed/],
    ["setup_required", /Microsoft sign-in setup is incomplete/],
    ["expired", /saved identity verification expired/],
  ] as const)("shows the saved %s outcome without rerunning the provider lookup", async (cacheStatus, message) => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValue({
      ...unresolved, defender: { ...unresolved.defender, resolution: {
        canResolve: true, capabilityId: "graph.agentIdentity.read", cacheStatus,
      } },
    });
    render(panel());
    expect(await screen.findByText(message)).toBeVisible();
    expect(resolveAgentInvestigationIdentity).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
  });

  it("aborts the old context and discards late data when another agent is opened", async () => {
    let complete!: (value: AgentInvestigationContext) => void;
    let signal!: AbortSignal;
    vi.mocked(getAgentInvestigationContext)
      .mockImplementationOnce((_id, options) => {
        signal = options!.signal!;
        return new Promise(resolve => { complete = resolve; });
      })
      .mockResolvedValueOnce({ ...investigation, recordId: "agent-b", defender: { status: "unavailable", reason: "Agent B has no typed identity.", entraAgentIds: [] } });
    const view = render(panel());
    view.rerender(panel("agent-b"));
    expect(signal.aborted).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "defender" } });
    expect(await screen.findByText("Agent B has no typed identity.")).toBeVisible();
    await act(async () => complete(investigation));
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
  });

  it("removes loaded records immediately when Viewer is lost", async () => {
    const view = render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "purview" } });
    expect(await screen.findByLabelText("Scoped Purview search")).toBeVisible();
    view.rerender(panel(recordId, []));
    expect(screen.queryByLabelText("Scoped Purview search")).not.toBeInTheDocument();
  });

  it("honors current principal role revocation even before the modal roles prop catches up", async () => {
    const view = render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "purview" } });
    await screen.findByLabelText("Scoped Purview search");
    view.rerender(panel(recordId, ["AgentControl.Viewer"], { ...capability, user: { ...capability.user!, roles: [] } }));
    expect(screen.getByText("An AgentControl.Viewer role is required to view agent logs.")).toBeVisible();
    expect(screen.queryByLabelText("Scoped Purview search")).not.toBeInTheDocument();
    expect(getAgentInvestigationContext).toHaveBeenCalledOnce();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
  });

  it("keeps the Defender presentation mounted but unverified during repeated context refresh", async () => {
    const stale = deferred<AgentInvestigationContext>();
    const current = deferred<AgentInvestigationContext>();
    const view = render(panel());
    const hunt = await screen.findByLabelText("Scoped Defender hunt");
    vi.mocked(getAgentInvestigationContext).mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    view.rerender(panel(recordId, ["AgentControl.Viewer"], capability, "2"));
    const signal = vi.mocked(getAgentInvestigationContext).mock.calls.at(-1)![1]!.signal!;
    expect(screen.getByLabelText("Scoped Defender hunt")).toBe(hunt);
    expect(hunt).toHaveAttribute("data-current", "false");
    view.rerender(panel(recordId, ["AgentControl.Viewer"], capability, "3"));
    expect(signal.aborted).toBe(true);
    expect(screen.getByLabelText("Scoped Defender hunt")).toBe(hunt);
    await act(async () => current.resolve(investigation));
    await waitFor(() => expect(hunt).toHaveAttribute("data-current", "true"));
    await act(async () => stale.resolve(unresolved));
    expect(screen.getByLabelText("Scoped Defender hunt")).toBe(hunt);
    expect(resolveAgentInvestigationIdentity).not.toHaveBeenCalled();
  });

  it.each(["error", "unmapped"] as const)("removes loaded Purview records after refreshed context becomes %s", async outcome => {
    const view = render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "purview" } });
    await screen.findByLabelText("Scoped Purview search");
    if (outcome === "error") vi.mocked(getAgentInvestigationContext).mockRejectedValueOnce(new Error("Saved investigation access denied"));
    else vi.mocked(getAgentInvestigationContext).mockResolvedValueOnce({
      ...investigation, purview: { status: "unavailable", mode: "search", presets: [], reason: "The saved bot mapping was removed." },
    });
    view.rerender(panel(recordId, ["AgentControl.Viewer"], capability, "2"));
    await screen.findByText(outcome === "error" ? "Saved investigation access denied" : "The saved bot mapping was removed.");
    expect(screen.queryByLabelText("Scoped Purview search")).not.toBeInTheDocument();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Source" })).toHaveValue("purview");
  });

  it("rejects investigation context for another agent before exposing either child", async () => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValueOnce({ ...investigation, recordId: "other-agent" });
    render(panel());
    expect(await screen.findByRole("alert")).toHaveTextContent("Investigation access does not match the selected agent");
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "purview" } });
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
  });

  it.each(["timestamps", "freshness", "verification", "qualification"] as const)(
    "ignores permission-check %s changes but rechecks real access without resetting the chosen source", async diagnostic => {
    const definition = capabilityDefinitions.find(item => item.id === "purview.audit.search.delegated")!;
    const access: typeof capability = { ...capability, views: [{
      definition, decision: { capabilityId: definition.id, status: "available", authorized: true, fresh: true,
        previewQualification: "not_required", remediation: [], checkedAt: "2026-09-26T10:00:00Z", expiresAt: "2026-09-26T10:05:00Z" },
    }] };
    const view = render(panel(recordId, ["AgentControl.Viewer"], access));
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "purview" } });
    await screen.findByLabelText("Scoped Purview search");
    const refreshed = structuredClone({ views: access.views });
    if (diagnostic === "timestamps") {
      refreshed.views[0].decision.checkedAt = "2026-09-26T10:01:00Z";
      refreshed.views[0].decision.expiresAt = "2026-09-26T10:06:00Z";
    }
    if (diagnostic === "freshness") refreshed.views[0].decision.fresh = false;
    if (diagnostic === "verification") refreshed.views[0].decision.verification = "provider";
    if (diagnostic === "qualification") refreshed.views[0].decision.previewQualification = "qualified";
    view.rerender(panel(recordId, ["AgentControl.Viewer"], { ...access, ...refreshed }));
    expect(screen.getByRole("combobox", { name: "Source" })).toHaveValue("purview");
    expect(getAgentInvestigationContext).toHaveBeenCalledOnce();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Scoped Purview search")).toBeVisible();
    vi.mocked(getAgentInvestigationContext).mockRejectedValue(new Error("Saved access was revoked"));
    refreshed.views[0].decision.authorized = false;
    view.rerender(panel(recordId, ["AgentControl.Viewer"], { ...access, ...refreshed }));
    expect(screen.queryByLabelText("Scoped Purview search")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved access was revoked");
    expect(screen.getByRole("combobox", { name: "Source" })).toHaveValue("purview");
  });

  it("does not cancel an explicit identity lookup when diagnostic verification changes", async () => {
    const definition = capabilityDefinitions.find(item => item.id === "graph.agentIdentity.read")!;
    const access: typeof capability = { ...capability, views: [{
      definition, decision: { capabilityId: definition.id, status: "available", authorized: true, fresh: true,
        verification: "token", previewQualification: "not_required", remediation: [] },
    }] };
    vi.mocked(getAgentInvestigationContext).mockResolvedValue(unresolved);
    const pending = deferred<AgentInvestigationContext>();
    vi.mocked(resolveAgentInvestigationIdentity).mockReturnValue(pending.promise);
    const view = render(panel(recordId, ["AgentControl.Viewer"], access));
    fireEvent.click(await screen.findByRole("button", { name: "Resolve log identity" }));
    const signal = vi.mocked(resolveAgentInvestigationIdentity).mock.calls[0][1]?.signal;
    const renewed = { ...access, views: [{ ...access.views[0], decision: {
      ...access.views[0].decision, verification: "provider" as const,
    } }] };
    view.rerender(panel(recordId, ["AgentControl.Viewer"], renewed));
    expect(signal?.aborted).toBe(false);
    expect(getAgentInvestigationContext).toHaveBeenCalledOnce();
    vi.mocked(getAgentInvestigationContext).mockResolvedValue(investigation);
    await act(async () => pending.resolve(investigation));
    await screen.findByLabelText("Scoped Defender hunt");
    expect(resolveAgentInvestigationIdentity).toHaveBeenCalledOnce();
    expect(getAgentInvestigationContext).toHaveBeenCalledTimes(2);
  });

  it("shares rapid access refreshes without cancelling and restarting the same read", async () => {
    const pending = deferred<AgentInvestigationContext>();
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    vi.mocked(getAgentInvestigationContext).mockReturnValue(pending.promise);
    const refresh = screen.getByRole("button", { name: "Refresh investigation access" });
    act(() => {
      fireEvent.click(refresh);
      fireEvent.click(refresh);
    });
    expect(getAgentInvestigationContext).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getAgentInvestigationContext).mock.calls[1][1]!.signal!.aborted).toBe(false);
    await act(async () => pending.resolve(investigation));
    await waitFor(() => expect(refresh).toBeEnabled());
  });

  it("shows pending access recovery without the previous cached refresh failure", async () => {
    const pending = deferred<AgentInvestigationContext>();
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    vi.mocked(getAgentInvestigationContext).mockRejectedValueOnce(new Error("Access refresh failed"));
    const refresh = screen.getByRole("button", { name: "Refresh investigation access" });
    fireEvent.click(refresh);
    expect(await screen.findByRole("alert")).toHaveTextContent("Access refresh failed");
    vi.mocked(getAgentInvestigationContext).mockReturnValueOnce(pending.promise);
    act(() => { fireEvent.click(refresh); fireEvent.click(refresh); });
    expect(await screen.findByRole("status")).toHaveTextContent("Checking saved agent identity");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    expect(getAgentInvestigationContext).toHaveBeenCalledTimes(3);
    expect(vi.mocked(getAgentInvestigationContext).mock.lastCall?.[1]?.signal?.aborted).toBe(false);
    await act(async () => pending.resolve(investigation));
    expect(await screen.findByLabelText("Scoped Defender hunt")).toHaveAttribute("data-current", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["resolve-first", "refresh-first"] as const)("does not overlap identity resolution and access refresh (%s)", async order => {
    const lookup = deferred<AgentInvestigationContext>();
    const readback = deferred<AgentInvestigationContext>();
    vi.mocked(getAgentInvestigationContext).mockResolvedValueOnce(unresolved).mockReturnValueOnce(readback.promise);
    vi.mocked(resolveAgentInvestigationIdentity).mockReturnValueOnce(lookup.promise);
    render(panel());
    const resolve = await screen.findByRole("button", { name: "Resolve log identity" });
    const refresh = screen.getByRole("button", { name: "Refresh investigation access" });
    act(() => {
      fireEvent.click(order === "resolve-first" ? resolve : refresh);
      fireEvent.click(order === "resolve-first" ? refresh : resolve);
    });
    expect(resolveAgentInvestigationIdentity).toHaveBeenCalledTimes(order === "resolve-first" ? 1 : 0);
    expect(getAgentInvestigationContext).toHaveBeenCalledTimes(order === "resolve-first" ? 1 : 2);
    if (order === "resolve-first") {
      await act(async () => lookup.resolve(investigation));
      await waitFor(() => expect(getAgentInvestigationContext).toHaveBeenCalledTimes(2));
    }
    await act(async () => readback.resolve(investigation));
    expect(await screen.findByLabelText("Scoped Defender hunt")).toHaveAttribute("data-current", "true");
  });

  it("does not restore rejected investigation context while a replacement revision is loading", async () => {
    const pending = deferred<AgentInvestigationContext>();
    const view = render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    vi.mocked(getAgentInvestigationContext).mockRejectedValueOnce(new Error("Saved context denied"));
    view.rerender(panel(recordId, ["AgentControl.Viewer"], capability, "2"));
    await screen.findByText("Saved context denied");
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    vi.mocked(getAgentInvestigationContext).mockReturnValueOnce(pending.promise);
    view.rerender(panel(recordId, ["AgentControl.Viewer"], capability, "3"));
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Checking saved agent identity");
    await act(async () => pending.resolve(unresolved));
    expect(await screen.findByRole("button", { name: "Resolve log identity" })).toBeEnabled();
  });

  it("does not restore rejected context from a peer's older cached revision before revalidation", async () => {
    const client = createSavedQueryClient();
    const pending = deferred<AgentInvestigationContext>();
    const content = (revision = "1") => <QueryClientProvider client={client}>
      {panel(recordId, ["AgentControl.Viewer"], capability, revision)}{panel()}
    </QueryClientProvider>;
    const view = render(content());
    await screen.findAllByLabelText("Scoped Defender hunt");
    const first = within(screen.getAllByRole("region", { name: "Investigations for Agent A" })[0]);
    vi.mocked(getAgentInvestigationContext).mockRejectedValueOnce(new Error("Saved context denied"));
    view.rerender(content("2"));
    await first.findByText("Saved context denied");
    vi.mocked(getAgentInvestigationContext).mockReturnValueOnce(pending.promise);
    view.rerender(content());
    expect(first.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    await act(async () => pending.resolve(investigation));
    expect(await first.findByLabelText("Scoped Defender hunt")).toHaveAttribute("data-current", "true");
    view.unmount();
    client.clear();
  });
});
