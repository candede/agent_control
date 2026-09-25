import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { getAgentInvestigationContext, getAgentPurviewRecords, resolveAgentInvestigationIdentity, type AgentInvestigationContext, type PurviewAuditRecord } from "../api/client";
import { AgentInvestigationsPanel } from "./AgentInvestigationsPanel";

vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(),
  getAgentInvestigationContext: vi.fn(),
  getAgentPurviewRecords: vi.fn(),
  resolveAgentInvestigationIdentity: vi.fn(),
}));
vi.mock("./DefenderHuntingView", () => ({
  DefenderHuntingView: ({ agentRecordId, entraAgentIds }: { agentRecordId: string; entraAgentIds: string[] }) =>
    <div aria-label="Scoped Defender hunt">{agentRecordId} / {entraAgentIds.join(",")}</div>,
}));

const recordId = "power_platform:environment-a:agent-a";
const entraId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const investigation: AgentInvestigationContext = {
  recordId, displayName: "Agent A",
  defender: { status: "available", entraAgentIds: [entraId] },
  purview: { status: "available", mode: "saved_only" },
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
const auditRecord: PurviewAuditRecord = {
  projectionVersion: 1, wrapperId: "record-a", nativeEventId: "event-a",
  eventDateTime: "2026-09-23T09:00:00Z", auditLogRecordType: "powerPlatformAdministratorActivity",
  operation: "BotCreate", service: "PowerPlatform", resultStatus: null,
  actorUserId: null, actorUserPrincipalName: "actor@example.invalid", actorUserType: null,
  objectId: null, clientIp: null, administrativeUnits: [], correlationId: "correlation-a",
  agentId: null, appIdentity: null, appHost: "Teams", botId: "bot-a", environmentId: "environment-a",
  botComponentId: null, aiPluginOperationId: null, messages: [], contentAvailable: false, unknownFieldCount: 0,
};

function panel(id = recordId, roles: ("AgentControl.Viewer" | "AgentControl.Admin")[] = ["AgentControl.Viewer"], access = capability) {
  return <CapabilityContext value={access}><AgentInvestigationsPanel recordId={id} agentName={id === recordId ? "Agent A" : "Agent B"} roles={roles} /></CapabilityContext>;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAgentInvestigationContext).mockResolvedValue(investigation);
  vi.mocked(getAgentPurviewRecords).mockResolvedValue({ recordId, mode: "saved_only", value: [auditRecord], count: 1, limit: 50, offset: 0 });
  vi.mocked(resolveAgentInvestigationIdentity).mockResolvedValue(investigation);
});

describe("agent investigations", () => {
  it("resolves the selected saved agent and never asks for pasted IDs or starts a provider query", async () => {
    render(panel());
    expect(await screen.findByLabelText("Scoped Defender hunt")).toHaveTextContent(`${recordId} / ${entraId}`);
    expect(getAgentInvestigationContext).toHaveBeenCalledExactlyOnceWith(recordId, { signal: expect.any(AbortSignal) });
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
    expect(resolveAgentInvestigationIdentity).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Agent IDs")).not.toBeInTheDocument();
    expect(screen.getByText("Metadata only. Hunts run only when requested.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Setup & permissions" }));
    expect(capability.openPermissions).toHaveBeenCalledOnce();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
  });

  it("does not request identities or audit records without Viewer", () => {
    render(panel(recordId, []));
    expect(getAgentInvestigationContext).not.toHaveBeenCalled();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
    expect(screen.getByText(/Viewer is not assigned/)).toBeVisible();
  });

  it("explains a missing identity without falling back to a tenant-wide hunt", async () => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValue({
      ...investigation, defender: { status: "unavailable", reason: "No verified Entra agent identity.", entraAgentIds: [] },
    });
    render(panel());
    expect(await screen.findByRole("heading", { name: "Defender identity not mapped" })).toBeVisible();
    expect(screen.getByText("No verified Entra agent identity.")).not.toBeVisible();
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    expect(screen.getByText(/Portal setup alone will not fix the mapping/)).toBeVisible();
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("No verified Entra agent identity.")).toBeVisible();
  });

  it("keeps unavailable Purview concise without implying live collection or requesting records", async () => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValue({
      ...investigation, purview: { status: "unavailable", mode: "saved_only", reason: "An exact bot ID and environment are missing." },
    });
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    expect(screen.getByRole("heading", { name: "Purview identity not mapped" })).toBeVisible();
    expect(screen.getByText("Saved Copilot Studio admin events only. No live collection.")).toBeVisible();
    expect(screen.getByText("An exact bot ID and environment are missing.")).not.toBeVisible();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Audit Search (not agent-scoped)" })).toHaveAttribute("href", "https://purview.microsoft.com/audit/auditsearch");
    fireEvent.click(screen.getByRole("button", { name: "Setup & permissions" }));
    expect(capability.openPermissions).toHaveBeenCalledOnce();
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

  it("surfaces lookup permission failures and supports an explicit retry without falsely unlocking hunts", async () => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValue(unresolved);
    vi.mocked(resolveAgentInvestigationIdentity).mockRejectedValueOnce(new Error("AgentIdentity.Read.All requires administrator consent."));
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Resolve log identity" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("AgentIdentity.Read.All requires administrator consent.");
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    expect(getAgentInvestigationContext).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Setup & permissions" }));
    expect(capability.openPermissions).toHaveBeenCalledOnce();
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

  it.each(["unsupported_agent_type", "unsupported_identity_crosswalk"] as const)("distinguishes %s from disabled Microsoft telemetry", async reasonCode => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValue({
      ...investigation, defender: { status: "unavailable", reasonCode, entraAgentIds: [] },
    });
    render(panel());
    expect(await screen.findByRole("heading", { name: "Defender linking not supported for this agent" })).toBeVisible();
    expect(screen.getByText(/Microsoft may still hold its logs/)).toBeVisible();
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

  it("browses, searches and pages only saved Purview records for the selected agent", async () => {
    vi.mocked(getAgentPurviewRecords).mockResolvedValue({ recordId, mode: "saved_only", value: [auditRecord], count: 51, limit: 50, offset: 0 });
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    expect(await screen.findByText("actor@example.invalid")).toBeVisible();
    expect(getAgentPurviewRecords).toHaveBeenLastCalledWith(recordId, { limit: 50, offset: 0, search: "", operation: "" }, { signal: expect.any(AbortSignal) });
    fireEvent.click(screen.getByRole("button", { name: "Next audit records" }));
    await waitFor(() => expect(getAgentPurviewRecords).toHaveBeenLastCalledWith(recordId, expect.objectContaining({ offset: 50 }), { signal: expect.any(AbortSignal) }));
    fireEvent.change(screen.getByLabelText("Search saved audit metadata"), { target: { value: " correlation-a " } });
    expect(screen.getByRole("option", { name: "All supported operations" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Exact audit operation" }), { target: { value: "BotCreate" } });
    fireEvent.click(screen.getByRole("button", { name: "Search saved audit" }));
    await waitFor(() => expect(getAgentPurviewRecords).toHaveBeenLastCalledWith(recordId,
      { limit: 50, offset: 0, search: "correlation-a", operation: "BotCreate" }, { signal: expect.any(AbortSignal) }));
    expect(screen.getByText(/not a total of all activity/)).toBeVisible();
    expect(screen.queryByRole("link", { name: "View audit search" })).not.toBeInTheDocument();
  });

  it("surfaces denied saved reads instead of presenting an empty result", async () => {
    vi.mocked(getAgentPurviewRecords).mockRejectedValue(new Error("Saved audit scope is unavailable."));
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved audit scope is unavailable.");
    expect(screen.queryByText(/0 matching saved records/)).not.toBeInTheDocument();
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
    expect(await screen.findByText("Agent B has no typed identity.")).not.toBeVisible();
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("Agent B has no typed identity.")).toBeVisible();
    await act(async () => complete(investigation));
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
  });

  it("removes loaded records immediately when Viewer is lost", async () => {
    const view = render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    expect(await screen.findByText("actor@example.invalid")).toBeVisible();
    view.rerender(panel(recordId, []));
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
  });
});
