import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { getAgentInvestigationContext, getAgentPurviewRecords, resolveAgentInvestigationIdentity, type AgentInvestigationContext, type PurviewAuditRecord } from "../api/client";
import { AgentInvestigationsPanel } from "./AgentInvestigationsPanel";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";

vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(),
  getAgentInvestigationContext: vi.fn(),
  getAgentPurviewRecords: vi.fn(),
  resolveAgentInvestigationIdentity: vi.fn(),
}));
vi.mock("./DefenderHuntingView", () => ({
  DefenderHuntingView: ({ agentRecordId, entraAgentIds, active }: { agentRecordId: string; entraAgentIds: string[]; active: boolean }) =>
    active ? <div aria-label="Scoped Defender hunt">{agentRecordId} / {entraAgentIds.join(",")}</div> : null,
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

function panel(id = recordId, roles: ("AgentControl.Viewer" | "AgentControl.Admin")[] = ["AgentControl.Viewer"], access = capability, revision = "1") {
  return <CapabilityContext value={access}><AgentInvestigationsPanel recordId={id} agentName={id === recordId ? "Agent A" : "Agent B"} roles={roles} revision={revision} /></CapabilityContext>;
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
    expect(screen.queryByText("Metadata only. Hunts run only when requested.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Setup & permissions" }));
    expect(capability.openPermissions).toHaveBeenCalledOnce();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
  });

  it("does not request identities or audit records without Viewer", () => {
    render(panel(recordId, []));
    expect(getAgentInvestigationContext).not.toHaveBeenCalled();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
    expect(screen.getByText("An AgentControl.Viewer role is required to view agent logs.")).toBeVisible();
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
      ...investigation, purview: { status: "unavailable", mode: "saved_only", reason: "An exact bot ID and environment are missing." },
    });
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    expect(screen.getByRole("heading", { name: "Purview identity not mapped" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Purview log coverage and setup" })).toHaveTextContent("Saved records only");
    expect(screen.getByText("An exact bot ID and environment are missing.")).toBeVisible();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Tenant Audit Search" })).not.toBeInTheDocument();
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
    expect(screen.getByText("51 matching saved records.")).toBeVisible();
    expect(screen.queryByText(/not a total of all activity/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View audit search" })).not.toBeInTheDocument();
  });

  it("keeps empty audit guidance concise and useful event references visible", async () => {
    vi.mocked(getAgentPurviewRecords)
      .mockResolvedValueOnce({ recordId, mode: "saved_only", value: [], count: 0, limit: 50, offset: 0 })
      .mockResolvedValueOnce({ recordId, mode: "saved_only", value: [auditRecord], count: 1, limit: 50, offset: 0 });
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    expect(await screen.findByText("No matching saved audit records. Try another search or check audit collection in Setup & permissions.")).toBeVisible();
    expect(screen.getByText("0 matching saved records.")).toBeVisible();
    expect(screen.queryByText(/does not prove inactivity|absence of risk/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search saved audit" }));
    expect(await screen.findByText("actor@example.invalid")).toBeVisible();
    expect(screen.getByText("event-a")).toBeVisible();
    expect(screen.getByText("correlation-a")).toBeVisible();
    expect(screen.getByRole("region", { name: "Agent Purview audit" }).querySelector("details")).toBeNull();
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
    expect(await screen.findByText("Agent B has no typed identity.")).toBeVisible();
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

  it("explains source coverage and collection requirements even when an agent cannot be linked", async () => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValue({
      ...investigation, defender: { status: "unavailable", reasonCode: "unsupported_identity_crosswalk", entraAgentIds: [] },
      purview: { status: "unavailable", mode: "saved_only", reasonCode: "unsupported_identity_crosswalk" },
    });
    const { container } = render(panel());
    await screen.findByRole("heading", { name: "Defender linking not supported for this agent" });
    expect(screen.getByRole("region", { name: "Defender log coverage and setup" })).toHaveTextContent("SDK, gateway and MCP");
    expect(screen.getByText("ThreatHunting.Read.All")).toBeVisible();
    expect(screen.queryByText("AuditLogsQuery.Read.All")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    expect(screen.getByRole("region", { name: "Purview log coverage and setup" })).toHaveTextContent("publishing, sharing, authentication changes");
    expect(screen.getByText("AuditLogsQuery.Read.All")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelector("details")).toBeNull();
    expect(getAgentPurviewRecords).not.toHaveBeenCalled();
  });

  it("preserves the Purview source, draft search and applied filters through revision refresh and source switching", async () => {
    const view = render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    fireEvent.change(screen.getByLabelText("Search saved audit metadata"), { target: { value: "correlation-a" } });
    fireEvent.change(screen.getByLabelText("Exact audit operation"), { target: { value: "BotCreate" } });
    fireEvent.click(screen.getByRole("button", { name: "Search saved audit" }));
    await screen.findByText("actor@example.invalid");
    fireEvent.change(screen.getByLabelText("Search saved audit metadata"), { target: { value: "unfinished edit" } });

    let complete!: (value: AgentInvestigationContext) => void;
    vi.mocked(getAgentInvestigationContext).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    view.rerender(panel(recordId, ["AgentControl.Viewer"], capability, "2"));
    expect(screen.getByRole("button", { name: "Purview audit" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
    await act(async () => complete(investigation));
    await screen.findByText("actor@example.invalid");
    expect(getAgentPurviewRecords).toHaveBeenLastCalledWith(recordId, { search: "correlation-a", operation: "BotCreate", limit: 50, offset: 0 }, { signal: expect.any(AbortSignal) });
    expect(screen.getByLabelText("Search saved audit metadata")).toHaveValue("unfinished edit");
    fireEvent.click(screen.getByRole("button", { name: "Defender & Agent 365" }));
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    expect(screen.getByLabelText("Search saved audit metadata")).toHaveValue("unfinished edit");
    expect(screen.getByLabelText("Exact audit operation")).toHaveValue("BotCreate");
  });

  it("ignores permission-check timestamp renewals but rechecks real access changes without resetting the chosen source", async () => {
    const definition = capabilityDefinitions.find(item => item.id === "purview.audit.search.delegated")!;
    const access: typeof capability = { ...capability, views: [{
      definition, decision: { capabilityId: definition.id, status: "available", authorized: true, fresh: true,
        previewQualification: "not_required", remediation: [], checkedAt: "2026-09-26T10:00:00Z", expiresAt: "2026-09-26T10:05:00Z" },
    }] };
    const view = render(panel(recordId, ["AgentControl.Viewer"], access));
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    const refreshed = structuredClone({ views: access.views });
    refreshed.views[0].decision.checkedAt = "2026-09-26T10:01:00Z";
    refreshed.views[0].decision.expiresAt = "2026-09-26T10:06:00Z";
    view.rerender(panel(recordId, ["AgentControl.Viewer"], { ...access, ...refreshed }));
    expect(screen.getByRole("button", { name: "Purview audit" })).toHaveAttribute("aria-pressed", "true");
    expect(getAgentInvestigationContext).toHaveBeenCalledOnce();
    vi.mocked(getAgentInvestigationContext).mockRejectedValue(new Error("Saved access was revoked"));
    refreshed.views[0].decision.authorized = false;
    view.rerender(panel(recordId, ["AgentControl.Viewer"], { ...access, ...refreshed }));
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved access was revoked");
    expect(screen.getByRole("button", { name: "Purview audit" })).toHaveAttribute("aria-pressed", "true");
  });

  it("refreshes the selected Purview data without clearing its filters", async () => {
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    fireEvent.change(screen.getByLabelText("Search saved audit metadata"), { target: { value: "actor" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh investigation access" }));
    await waitFor(() => expect(getAgentPurviewRecords).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Purview audit" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Search saved audit metadata")).toHaveValue("actor");
  });

  it("rejects audit responses for a different agent and never displays their records", async () => {
    vi.mocked(getAgentPurviewRecords).mockResolvedValue({
      recordId: "other-agent", mode: "saved_only", value: [auditRecord], count: 1, limit: 50, offset: 0,
    });
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Audit records do not match the selected agent");
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
  });
});
