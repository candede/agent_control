import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { ApiError, getAgentInvestigationContext, getAgentPurviewRecords, resolveAgentInvestigationIdentity, type AgentInvestigationContext, type PurviewAuditRecord } from "../api/client";
import { AgentInvestigationsPanel } from "./AgentInvestigationsPanel";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { createSavedQueryClient } from "../savedQueries";

vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(),
  getAgentInvestigationContext: vi.fn(),
  getAgentPurviewRecords: vi.fn(),
  resolveAgentInvestigationIdentity: vi.fn(),
}));
vi.mock("./DefenderHuntingView", () => ({
  DefenderHuntingView: ({ agentRecordId, entraAgentIds, active, contextCurrent }: { agentRecordId: string; entraAgentIds: string[]; active: boolean; contextCurrent: boolean }) =>
    active ? <div aria-label="Scoped Defender hunt" data-current={contextCurrent}>{agentRecordId} / {entraAgentIds.join(",")}</div> : null,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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

  it("states saved-agent unavailability without recommending refresh or implying logs are empty", async () => {
    vi.mocked(getAgentInvestigationContext).mockRejectedValue(new ApiError(404, "agent_not_found",
      "This agent is not available in the current saved inventory."));
    render(panel());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This agent is not available in the current saved inventory.");
    expect(alert).not.toHaveTextContent(/refresh|sync|retry/i);
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
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

  it("keeps audit pagination focused while admitting only one page move through loading and failure", async () => {
    const nextPage = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
    vi.mocked(getAgentPurviewRecords)
      .mockResolvedValueOnce({ recordId, mode: "saved_only", value: [auditRecord], count: 151, limit: 50, offset: 0 })
      .mockReturnValueOnce(nextPage.promise)
      .mockResolvedValue({ recordId, mode: "saved_only", value: [auditRecord], count: 151, limit: 50, offset: 0 });
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    const next = screen.getByRole("button", { name: "Next audit records" });
    const previous = screen.getByRole("button", { name: "Previous audit records" });
    next.focus();
    act(() => { next.click(); next.click(); });
    await waitFor(() => expect(getAgentPurviewRecords).toHaveBeenCalledTimes(2));
    expect(getAgentPurviewRecords).toHaveBeenLastCalledWith(recordId, expect.objectContaining({ offset: 50 }), expect.anything());
    expect(screen.getByRole("button", { name: "Next audit records" })).toBe(next);
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(previous).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
    expect(screen.queryByText(/of 151/)).not.toBeInTheDocument();
    fireEvent.click(next);
    fireEvent.click(previous);
    expect(getAgentPurviewRecords).toHaveBeenCalledTimes(2);
    await act(async () => nextPage.reject(new Error("Audit page failed")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Audit page failed");
    expect(next).toHaveFocus();
    expect(previous).toHaveAttribute("aria-disabled", "false");
    expect(screen.queryByText("0 records")).not.toBeInTheDocument();
    fireEvent.click(previous);
    expect(await screen.findByText("actor@example.invalid")).toBeVisible();
    expect(getAgentPurviewRecords).toHaveBeenLastCalledWith(recordId, expect.objectContaining({ offset: 0 }), expect.anything());
  });

  it("keeps a retrying audit search focused and suppresses the retired failure", async () => {
    const retry = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
    vi.mocked(getAgentPurviewRecords).mockRejectedValueOnce(new Error("Audit unavailable")).mockReturnValueOnce(retry.promise);
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByRole("alert");
    const search = screen.getByRole("button", { name: "Search saved audit" });
    search.focus();
    act(() => { search.click(); search.click(); });
    expect(getAgentPurviewRecords).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(search).toHaveAttribute("aria-disabled", "true"));
    expect(search).not.toBeDisabled();
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => retry.resolve({ recordId, mode: "saved_only", value: [], count: 0, limit: 50, offset: 0 }));
    expect(await screen.findByText(/No matching saved audit records/)).toBeVisible();
    expect(search).toHaveFocus();
  });

  it("preserves audit next-page focus when the last page makes that direction unavailable", async () => {
    vi.mocked(getAgentPurviewRecords).mockImplementation(async (_id, query) => ({
      recordId, mode: "saved_only", value: [auditRecord], count: 51, limit: 50, offset: query?.offset ?? 0,
    }));
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    const next = screen.getByRole("button", { name: "Next audit records" });
    next.focus();
    fireEvent.click(next);
    await screen.findByText("51-51 of 51");
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(next).not.toBeDisabled();
    fireEvent.click(next);
    expect(getAgentPurviewRecords).toHaveBeenCalledTimes(2);
  });

  it("rejects queued page and filter actions when shared audit invalidation precedes its observer notification", async () => {
    const client = createSavedQueryClient();
    const refreshing = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
    vi.mocked(getAgentPurviewRecords)
      .mockResolvedValueOnce({ recordId, mode: "saved_only", value: [auditRecord], count: 151, limit: 50, offset: 0 })
      .mockReturnValue(refreshing.promise);
    const view = render(<QueryClientProvider client={client}>{panel()}</QueryClientProvider>);
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    const next = screen.getByRole("button", { name: "Next audit records" });
    fireEvent.change(screen.getByLabelText("Search saved audit metadata"), { target: { value: "queued filter" } });
    act(() => {
      void client.invalidateQueries({ queryKey: ["agent-purview-records"] });
      next.click();
      screen.getByRole("button", { name: "Search saved audit" }).click();
    });
    expect(getAgentPurviewRecords).toHaveBeenCalledTimes(2);
    expect(getAgentPurviewRecords).toHaveBeenLastCalledWith(recordId, expect.objectContaining({ offset: 0, search: "" }), expect.anything());
    expect(vi.mocked(getAgentPurviewRecords).mock.calls[1][2]?.signal?.aborted).toBe(false);
    view.unmount();
    client.clear();
  });

  it("rejects queued audit actions when investigation access is invalidated before the panel rerenders", async () => {
    const client = createSavedQueryClient();
    const access = deferred<AgentInvestigationContext>();
    vi.mocked(getAgentPurviewRecords).mockResolvedValue({
      recordId, mode: "saved_only", value: [auditRecord], count: 151, limit: 50, offset: 0,
    });
    const view = render(<QueryClientProvider client={client}>{panel()}</QueryClientProvider>);
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    vi.mocked(getAgentInvestigationContext).mockReturnValue(access.promise);
    fireEvent.change(screen.getByLabelText("Search saved audit metadata"), { target: { value: "queued filter" } });
    act(() => {
      void client.invalidateQueries({ queryKey: ["agent-investigation-context"] });
      screen.getByRole("button", { name: "Next audit records" }).click();
      screen.getByRole("button", { name: "Search saved audit" }).click();
    });
    expect(getAgentPurviewRecords).toHaveBeenCalledOnce();
    view.unmount();
    client.clear();
  });

  it("surfaces denied saved reads instead of presenting an empty result", async () => {
    vi.mocked(getAgentPurviewRecords).mockRejectedValue(new Error("Saved audit scope is unavailable."));
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved audit scope is unavailable.");
    expect(screen.queryByText(/0 matching saved records/)).not.toBeInTheDocument();
  });

  it("revalidates saved Purview access when only the application configuration revision changes", async () => {
    const definition = capabilityDefinitions.find(item => item.id === "purview.audit.search.application")!;
    const access = (revision: number): typeof capability => ({ ...capability, views: [{
      definition, decision: { capabilityId: definition.id, status: "unknown", authorized: false, fresh: false,
        previewQualification: "unqualified", remediation: [] },
      configuration: { enabled: true, sharedDataScope: true, revision },
    }] });
    const refreshed = deferred<AgentInvestigationContext>();
    vi.mocked(getAgentInvestigationContext).mockResolvedValueOnce(investigation).mockReturnValueOnce(refreshed.promise);
    vi.mocked(getAgentPurviewRecords).mockResolvedValueOnce({
      recordId, mode: "saved_only", value: [auditRecord], count: 1, limit: 50, offset: 0,
    }).mockResolvedValueOnce({
      recordId, mode: "saved_only", value: [], count: 0, limit: 50, offset: 0,
    });
    const view = render(panel(recordId, ["AgentControl.Viewer"], access(1)));
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    view.rerender(panel(recordId, ["AgentControl.Viewer"], access(2)));
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
    expect(getAgentInvestigationContext).toHaveBeenCalledTimes(2);
    expect(getAgentPurviewRecords).toHaveBeenCalledOnce();
    await act(async () => refreshed.resolve(investigation));
    expect(await screen.findByText(/No matching saved audit records/)).toBeVisible();
    expect(getAgentPurviewRecords).toHaveBeenCalledTimes(2);
    expect(resolveAgentInvestigationIdentity).not.toHaveBeenCalled();
  });

  it("retires a hidden Purview read and fetches fresh records on return without losing draft filters", async () => {
    const retired = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
    const fresh = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
    vi.mocked(getAgentPurviewRecords).mockReturnValueOnce(retired.promise).mockReturnValueOnce(fresh.promise);
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await waitFor(() => expect(getAgentPurviewRecords).toHaveBeenCalledOnce());
    const signal = vi.mocked(getAgentPurviewRecords).mock.calls[0][2]!.signal!;
    fireEvent.change(screen.getByLabelText("Search saved audit metadata"), { target: { value: "unfinished edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Defender & Agent 365" }));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole("region", { name: "Agent Purview audit" })).not.toBeInTheDocument();
    await act(async () => retired.resolve({ recordId, mode: "saved_only", value: [auditRecord], count: 1, limit: 50, offset: 0 }));
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await waitFor(() => expect(getAgentPurviewRecords).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Search saved audit metadata")).toHaveValue("unfinished edit");
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading agent audit records");
    await act(async () => fresh.resolve({
      recordId, mode: "saved_only", value: [{ ...auditRecord, actorUserPrincipalName: "fresh@example.invalid" }], count: 1, limit: 50, offset: 0,
    }));
    expect(await screen.findByText("fresh@example.invalid")).toBeVisible();
    expect(getAgentInvestigationContext).toHaveBeenCalledOnce();
  });

  it("shares pending context and Purview reads without letting a hidden observer cancel an active peer", async () => {
    const client = createSavedQueryClient();
    const context = deferred<AgentInvestigationContext>();
    const records = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
    vi.mocked(getAgentInvestigationContext).mockReturnValue(context.promise);
    vi.mocked(getAgentPurviewRecords).mockReturnValue(records.promise);
    const view = render(<QueryClientProvider client={client}>{panel()}{panel()}</QueryClientProvider>);
    expect(getAgentInvestigationContext).toHaveBeenCalledOnce();
    await act(async () => context.resolve(investigation));
    await screen.findAllByLabelText("Scoped Defender hunt");
    const [first, second] = screen.getAllByRole("region", { name: "Investigations for Agent A" }).map(element => within(element));
    fireEvent.click(first.getByRole("button", { name: "Purview audit" }));
    fireEvent.click(second.getByRole("button", { name: "Purview audit" }));
    expect(getAgentPurviewRecords).toHaveBeenCalledOnce();
    const signal = vi.mocked(getAgentPurviewRecords).mock.calls[0][2]!.signal!;
    fireEvent.click(first.getByRole("button", { name: "Defender & Agent 365" }));
    expect(signal.aborted).toBe(false);
    expect(second.getByRole("status")).toHaveTextContent("Loading agent audit records");
    await act(async () => records.resolve({ recordId, mode: "saved_only", value: [auditRecord], count: 1, limit: 50, offset: 0 }));
    expect(await second.findByText("actor@example.invalid")).toBeVisible();
    expect(first.queryByText("actor@example.invalid")).not.toBeInTheDocument();
    expect(getAgentPurviewRecords).toHaveBeenCalledOnce();
    view.unmount();
    client.clear();
  });

  it("retires pending Purview data during an identity readback even when the query scope is unchanged", async () => {
    const lookup = deferred<AgentInvestigationContext>();
    const readback = deferred<AgentInvestigationContext>();
    const retired = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
    vi.mocked(getAgentInvestigationContext).mockResolvedValueOnce(unresolved).mockReturnValueOnce(readback.promise);
    vi.mocked(resolveAgentInvestigationIdentity).mockReturnValue(lookup.promise);
    vi.mocked(getAgentPurviewRecords).mockReturnValueOnce(retired.promise).mockResolvedValue({
      recordId, mode: "saved_only", value: [{ ...auditRecord, actorUserPrincipalName: "current@example.invalid" }], count: 1, limit: 50, offset: 0,
    });
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Resolve log identity" }));
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await waitFor(() => expect(getAgentPurviewRecords).toHaveBeenCalledOnce());
    const signal = vi.mocked(getAgentPurviewRecords).mock.calls[0][2]!.signal!;
    await act(async () => lookup.resolve(investigation));
    await waitFor(() => expect(getAgentInvestigationContext).toHaveBeenCalledTimes(2));
    expect(signal.aborted).toBe(true);
    await act(async () => retired.resolve({ recordId, mode: "saved_only", value: [auditRecord], count: 1, limit: 50, offset: 0 }));
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
    expect(getAgentPurviewRecords).toHaveBeenCalledOnce();
    await act(async () => readback.resolve(investigation));
    expect(await screen.findByText("current@example.invalid")).toBeVisible();
    expect(getAgentPurviewRecords).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
  });

  it.each(["principal", "tenant", "role", "sign-out"] as const)(
    "clears private Purview rows and drafts, cancels pending reads and ignores late data after %s changes", async change => {
      const retired = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
      const client = createSavedQueryClient();
      const content = (access = capability) => <QueryClientProvider client={client}>{panel(recordId, ["AgentControl.Viewer"], access)}</QueryClientProvider>;
      const view = render(content());
      await screen.findByLabelText("Scoped Defender hunt");
      fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
      await screen.findByText("actor@example.invalid");
      vi.mocked(getAgentPurviewRecords).mockReturnValueOnce(retired.promise).mockResolvedValue({
        recordId, mode: "saved_only", value: [{ ...auditRecord, actorUserPrincipalName: "current@example.invalid" }], count: 1, limit: 50, offset: 0,
      });
      fireEvent.click(screen.getByRole("button", { name: "Search saved audit" }));
      await waitFor(() => expect(getAgentPurviewRecords).toHaveBeenCalledTimes(2));
      const signal = vi.mocked(getAgentPurviewRecords).mock.calls[1][2]!.signal!;
      fireEvent.change(screen.getByLabelText("Search saved audit metadata"), { target: { value: "private draft" } });
      const changed: typeof capability = { ...capability, user: change === "sign-out" ? undefined : {
        ...capability.user!,
        ...(change === "principal" ? { homeAccountId: "principal-b" }
          : change === "tenant" ? { tenantId: "tenant-b" } : { roles: [] }),
      } };
      view.rerender(content(changed));
      expect(signal.aborted).toBe(true);
      expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue("private draft")).not.toBeInTheDocument();
      await act(async () => retired.resolve({
        recordId, mode: "saved_only", value: [{ ...auditRecord, actorUserPrincipalName: "retired@example.invalid" }], count: 1, limit: 50, offset: 0,
      }));
      expect(screen.queryByText("retired@example.invalid")).not.toBeInTheDocument();
      if (change === "role" || change === "sign-out") {
        expect(getAgentInvestigationContext).toHaveBeenCalledOnce();
        view.rerender(content());
      }
      await screen.findByLabelText("Scoped Defender hunt");
      fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
      expect(screen.getByLabelText("Search saved audit metadata")).toHaveValue("");
      expect(await screen.findByText("current@example.invalid")).toBeVisible();
      expect(screen.queryByText("retired@example.invalid")).not.toBeInTheDocument();
      expect(getAgentInvestigationContext).toHaveBeenCalledTimes(2);
      expect(getAgentPurviewRecords).toHaveBeenCalledTimes(3);
      view.unmount();
      client.clear();
    },
  );

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

  it("honors current principal role revocation even before the modal roles prop catches up", async () => {
    const view = render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    view.rerender(panel(recordId, ["AgentControl.Viewer"], { ...capability, user: { ...capability.user!, roles: [] } }));
    expect(screen.getByText("An AgentControl.Viewer role is required to view agent logs.")).toBeVisible();
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
    expect(getAgentInvestigationContext).toHaveBeenCalledOnce();
    expect(getAgentPurviewRecords).toHaveBeenCalledOnce();
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
    expect(screen.getByText("actor@example.invalid")).toBeVisible();
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

  it("retains Purview rows, applied page, draft edits, focus and scroll through overlapping context and record reads", async () => {
    vi.mocked(getAgentPurviewRecords).mockImplementation(async (_id, query) => ({
      recordId, mode: "saved_only", value: [auditRecord], count: 101, limit: 50, offset: query?.offset ?? 0,
    }));
    const view = render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    const search = screen.getByLabelText("Search saved audit metadata");
    fireEvent.change(search, { target: { value: "correlation-a" } });
    fireEvent.change(screen.getByLabelText("Exact audit operation"), { target: { value: "BotCreate" } });
    fireEvent.click(screen.getByRole("button", { name: "Search saved audit" }));
    await waitFor(() => expect(getAgentPurviewRecords).toHaveBeenCalledTimes(2));
    await screen.findByText("actor@example.invalid");
    fireEvent.click(screen.getByRole("button", { name: "Next audit records" }));
    await screen.findByText("51-51 of 101");
    fireEvent.change(search, { target: { value: "unfinished edit" } });
    search.focus();
    const table = screen.getByRole("region", { name: "Agent Purview records" });
    table.scrollTop = 143;
    const staleContext = deferred<AgentInvestigationContext>();
    const currentContext = deferred<AgentInvestigationContext>();
    const staleRecords = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
    const currentRecords = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
    vi.mocked(getAgentInvestigationContext).mockReturnValueOnce(staleContext.promise).mockReturnValueOnce(currentContext.promise);
    vi.mocked(getAgentPurviewRecords).mockReturnValueOnce(staleRecords.promise).mockReturnValueOnce(currentRecords.promise);

    view.rerender(panel(recordId, ["AgentControl.Viewer"], capability, "2"));
    const contextSignal = vi.mocked(getAgentInvestigationContext).mock.calls.at(-1)![1]!.signal!;
    expect(screen.getByRole("region", { name: "Agent Purview records" })).toBe(table);
    expect(search).toHaveFocus();
    expect(table.scrollTop).toBe(143);
    expect(getAgentPurviewRecords).toHaveBeenCalledTimes(3);
    view.rerender(panel(recordId, ["AgentControl.Viewer"], capability, "3"));
    expect(contextSignal.aborted).toBe(true);
    await act(async () => currentContext.resolve(investigation));
    await waitFor(() => expect(getAgentPurviewRecords).toHaveBeenCalledTimes(4));
    const recordSignal = vi.mocked(getAgentPurviewRecords).mock.calls.at(-1)![2]!.signal!;
    expect(screen.getByRole("region", { name: "Agent Purview records" })).toBe(table);
    expect(search).toHaveFocus();
    expect(table.scrollTop).toBe(143);

    view.rerender(panel(recordId, ["AgentControl.Viewer"], capability, "4"));
    await waitFor(() => expect(getAgentPurviewRecords).toHaveBeenCalledTimes(5));
    expect(recordSignal.aborted).toBe(true);
    expect(screen.getByRole("region", { name: "Agent Purview records" })).toBe(table);
    expect(screen.getByLabelText("Search saved audit metadata")).toHaveValue("unfinished edit");
    expect(screen.getByLabelText("Exact audit operation")).toHaveValue("BotCreate");
    expect(getAgentPurviewRecords).toHaveBeenLastCalledWith(recordId,
      { search: "correlation-a", operation: "BotCreate", offset: 50, limit: 50 }, expect.anything());
    await act(async () => currentRecords.resolve({
      recordId, mode: "saved_only", value: [{ ...auditRecord, actorUserPrincipalName: "updated@example.invalid" }], count: 101, offset: 50, limit: 50,
    }));
    expect(await within(table).findByText("updated@example.invalid")).toBeVisible();
    expect(search).toHaveFocus();
    expect(table.scrollTop).toBe(143);
    await act(async () => {
      staleContext.resolve({ ...investigation, purview: { mode: "saved_only", status: "unavailable", reason: "Superseded mapping" } });
      staleRecords.resolve({ recordId, mode: "saved_only", value: [auditRecord], count: 101, offset: 50, limit: 50 });
    });
    expect(screen.queryByText("Superseded mapping")).not.toBeInTheDocument();
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
    expect(screen.getByText("updated@example.invalid")).toBeVisible();
  });

  it.each([new Error("Saved audit refresh failed"), new ApiError(403, "forbidden", "Saved audit access denied")])(
    "removes retained records on $message and retries without changing draft filters", async failure => {
      const view = render(panel());
      await screen.findByLabelText("Scoped Defender hunt");
      fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
      await screen.findByText("actor@example.invalid");
      fireEvent.change(screen.getByLabelText("Search saved audit metadata"), { target: { value: "draft" } });
      const pending = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
      vi.mocked(getAgentPurviewRecords).mockReturnValueOnce(pending.promise);
      view.rerender(panel(recordId, ["AgentControl.Viewer"], capability, "2"));
      await waitFor(() => expect(getAgentPurviewRecords).toHaveBeenCalledTimes(2));
      expect(screen.getByText("actor@example.invalid")).toBeVisible();
      await act(async () => pending.reject(failure));
      expect(await screen.findByRole("alert")).toHaveTextContent(failure.message);
      expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Search saved audit metadata")).toHaveValue("draft");
      const recovery = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
      vi.mocked(getAgentPurviewRecords).mockReturnValueOnce(recovery.promise);
      fireEvent.click(screen.getByRole("button", { name: "Refresh investigation access" }));
      await waitFor(() => expect(getAgentPurviewRecords).toHaveBeenCalledTimes(3));
      expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
      await act(async () => recovery.resolve({
        recordId, mode: "saved_only", value: [auditRecord], count: 1, offset: 0, limit: 50,
      }));
      expect(await screen.findByText("actor@example.invalid")).toBeVisible();
      expect(getAgentPurviewRecords).toHaveBeenLastCalledWith(recordId, expect.objectContaining({ search: "" }), expect.anything());
      expect(screen.getByLabelText("Search saved audit metadata")).toHaveValue("draft");
    },
  );

  it.each(["error", "unmapped"] as const)("removes loaded Purview records after refreshed context becomes %s", async outcome => {
    const view = render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    if (outcome === "error") vi.mocked(getAgentInvestigationContext).mockRejectedValueOnce(new Error("Saved investigation access denied"));
    else vi.mocked(getAgentInvestigationContext).mockResolvedValueOnce({
      ...investigation, purview: { status: "unavailable", mode: "saved_only", reason: "The saved bot mapping was removed." },
    });
    view.rerender(panel(recordId, ["AgentControl.Viewer"], capability, "2"));
    await screen.findByText(outcome === "error" ? "Saved investigation access denied" : "The saved bot mapping was removed.");
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
    expect(getAgentPurviewRecords).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Purview audit" })).toHaveAttribute("aria-pressed", "true");
  });

  it("rejects investigation context for another agent before exposing either child", async () => {
    vi.mocked(getAgentInvestigationContext).mockResolvedValueOnce({ ...investigation, recordId: "other-agent" });
    render(panel());
    expect(await screen.findByRole("alert")).toHaveTextContent("Investigation access does not match the selected agent");
    expect(screen.queryByLabelText("Scoped Defender hunt")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    const refreshed = structuredClone({ views: access.views });
    if (diagnostic === "timestamps") {
      refreshed.views[0].decision.checkedAt = "2026-09-26T10:01:00Z";
      refreshed.views[0].decision.expiresAt = "2026-09-26T10:06:00Z";
    }
    if (diagnostic === "freshness") refreshed.views[0].decision.fresh = false;
    if (diagnostic === "verification") refreshed.views[0].decision.verification = "provider";
    if (diagnostic === "qualification") refreshed.views[0].decision.previewQualification = "qualified";
    view.rerender(panel(recordId, ["AgentControl.Viewer"], { ...access, ...refreshed }));
    expect(screen.getByRole("button", { name: "Purview audit" })).toHaveAttribute("aria-pressed", "true");
    expect(getAgentInvestigationContext).toHaveBeenCalledOnce();
    expect(getAgentPurviewRecords).toHaveBeenCalledOnce();
    expect(screen.getByText("actor@example.invalid")).toBeVisible();
    vi.mocked(getAgentInvestigationContext).mockRejectedValue(new Error("Saved access was revoked"));
    refreshed.views[0].decision.authorized = false;
    view.rerender(panel(recordId, ["AgentControl.Viewer"], { ...access, ...refreshed }));
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved access was revoked");
    expect(screen.getByRole("button", { name: "Purview audit" })).toHaveAttribute("aria-pressed", "true");
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

  it("shows pending audit recovery without the previous cached search failure", async () => {
    const pending = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    const form = screen.getByRole("button", { name: "Search saved audit" }).closest("form")!;
    vi.mocked(getAgentPurviewRecords).mockRejectedValueOnce(new Error("Audit refresh failed"));
    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toHaveTextContent("Audit refresh failed");
    vi.mocked(getAgentPurviewRecords).mockReturnValueOnce(pending.promise);
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(await screen.findByRole("status")).toHaveTextContent("Loading agent audit records");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
    expect(getAgentPurviewRecords).toHaveBeenCalledTimes(3);
    expect(vi.mocked(getAgentPurviewRecords).mock.lastCall?.[2]?.signal?.aborted).toBe(false);
    await act(async () => pending.resolve({
      recordId, mode: "saved_only", value: [auditRecord], count: 1, limit: 50, offset: 0,
    }));
    expect(await screen.findByText("actor@example.invalid")).toBeVisible();
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

  it("shares rapid equivalent saved-audit searches without restarting the transport", async () => {
    const pending = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    vi.mocked(getAgentPurviewRecords).mockReturnValue(pending.promise);
    const form = screen.getByRole("button", { name: "Search saved audit" }).closest("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(getAgentPurviewRecords).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getAgentPurviewRecords).mock.calls[1][2]!.signal!.aborted).toBe(false);
    await act(async () => pending.resolve({
      recordId, mode: "saved_only", value: [auditRecord], count: 1, limit: 50, offset: 0,
    }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Search saved audit" })).toHaveAttribute("aria-disabled", "false"));
  });

  it.each(["error", "unmapped"] as const)("does not revive withdrawn audit rows while recovering from %s access", async outcome => {
    const pending = deferred<Awaited<ReturnType<typeof getAgentPurviewRecords>>>();
    render(panel());
    await screen.findByLabelText("Scoped Defender hunt");
    fireEvent.click(screen.getByRole("button", { name: "Purview audit" }));
    await screen.findByText("actor@example.invalid");
    fireEvent.change(screen.getByLabelText("Search saved audit metadata"), { target: { value: "private draft" } });
    if (outcome === "error") vi.mocked(getAgentInvestigationContext).mockRejectedValueOnce(new Error("Saved access denied"));
    else vi.mocked(getAgentInvestigationContext).mockResolvedValueOnce({
      ...investigation, purview: { status: "unavailable", mode: "saved_only", reason: "Mapping unavailable" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh investigation access" }));
    await screen.findByText(outcome === "error" ? "Saved access denied" : "Mapping unavailable");
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
    vi.mocked(getAgentPurviewRecords).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh investigation access" }));
    await waitFor(() => expect(getAgentPurviewRecords).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("actor@example.invalid")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search saved audit metadata")).toHaveValue("private draft");
    await act(async () => pending.resolve({
      recordId, mode: "saved_only", value: [{ ...auditRecord, actorUserPrincipalName: "current@example.invalid" }],
      count: 1, limit: 50, offset: 0,
    }));
    expect(await screen.findByText("current@example.invalid")).toBeVisible();
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
