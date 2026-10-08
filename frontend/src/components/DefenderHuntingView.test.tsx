import { act, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { ApiError, approveDefenderHuntingQualification, cancelDefenderHunt, deleteDefenderHunt, downloadDefenderHuntingCsv, getDefenderHuntingCatalog, getDefenderHuntingJob, getDefenderHuntingJobs, getDefenderHuntingRows, resumeDefenderHunt, startDefenderHuntingQualification,
  revokeDefenderHuntingRetainedScope, submitDefenderHunt, type CapabilityView, type DefenderHuntingCatalog, type DefenderHuntingJob, type DefenderHuntingRowPage, type SessionUser } from "../api/client";
import { DefenderHuntingView as AgentDefenderHuntingView } from "./DefenderHuntingView";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { createSavedQueryClient, readSavedQuery } from "../savedQueries";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { useCapabilities } from "../useCapabilities";

const agentRecordId = "power_platform:environment-a:agent-a";
const entraAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const applicationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function DefenderHuntingView() {
  return <AgentDefenderHuntingView agentRecordId={agentRecordId} agentName="Selected agent" entraAgentIds={[entraAgentId]} entraAgentApplicationIds={[applicationId]} />;
}

function render(ui: ReactNode, reactStrictMode = false) {
  const wrap = (children: ReactNode) => <WorkbenchActionProvider value={workbenchActions}>{children}</WorkbenchActionProvider>;
  const result = rtlRender(wrap(ui), { reactStrictMode });
  return { ...result, rerender: (next: ReactNode) => result.rerender(wrap(next)) };
}

vi.mock("../api/client", async original => ({ ...await original<typeof import("../api/client")>(), approveDefenderHuntingQualification: vi.fn(),
  cancelDefenderHunt: vi.fn(), deleteDefenderHunt: vi.fn(), downloadDefenderHuntingCsv: vi.fn(), getDefenderHuntingCatalog: vi.fn(),
  getDefenderHuntingJob: vi.fn(), getDefenderHuntingJobs: vi.fn(), getDefenderHuntingRows: vi.fn(), resumeDefenderHunt: vi.fn(), revokeDefenderHuntingRetainedScope: vi.fn(),
  startDefenderHuntingQualification: vi.fn(), submitDefenderHunt: vi.fn() }));

const catalog: DefenderHuntingCatalog = { templates: [
  { id: "agents_inventory", label: "Defender agent inventory", sourceTable: "AgentsInfo", operations: [] },
  { id: "agent_activity", label: "Agent activity", sourceTable: "CloudAppEvents", operations: ["InvokeAgent", "InferenceCall"] },
  { id: "agent_tools", label: "Agent tool activity", sourceTable: "CloudAppEvents", operations: ["ExecuteToolBySDK"] },
], qualifications: [{ capabilityId: "defender.hunting.delegated", templateId: "agents_inventory", targetScopeHash: "c".repeat(64),
  approvedScope: { templateId: "agents_inventory", agentIds: [], entraAgentIds: [entraAgentId], blueprintIds: [], actorObjectIds: [], operations: [] },
  queryVersion: 3, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: "security-a",
  qualifiedAt: "2026-09-09T11:00:00.000Z", expiresAt: "2026-09-09T12:00:00.000Z" }],
retainedScopes: [{ id: "44444444-4444-4444-8444-444444444444", resultScope: { kind: "principal", scopeId: "security-a", configurationRevision: null },
  tokenMode: "delegated", capabilityId: "defender.hunting.delegated", templateId: "agents_inventory", targetScopeHash: "c".repeat(64),
  approvedScope: { templateId: "agents_inventory", agentIds: [], entraAgentIds: [entraAgentId], blueprintIds: [], actorObjectIds: [], operations: [] }, queryVersion: 3,
  contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: "security-a",
  sourceQualificationJobId: "55555555-5555-4555-8555-555555555555", approvedAt: "2026-09-09T11:00:00.000Z",
  qualifiedAt: "2026-09-09T11:00:00.000Z", expiresAt: "2026-10-09T11:00:00.000Z", revokedAt: null }],
limits: { maximumWindowHours: 168, qualificationWindowHours: 1, maximumRows: 200, maximumBytes: 2_000_000, providerRequests: 12, activations: 4 },
scopeNotice: "Graph-selected Defender scope; no workspace selection.", contentNotice: "Messages and tool content are absent.",
readinessNotice: "Check license, connector, RBAC and rollout separately.", retentionNotice: "Local results expire after 30 days.",
defenderPortalUrl: "https://security.microsoft.com/v2/advanced-hunting" };

function job(overrides: Partial<DefenderHuntingJob> = {}): DefenderHuntingJob {
  return { id: "11111111-1111-4111-8111-111111111111", authorizationPrincipalId: "security-a",
    resultScope: { kind: "principal", scopeId: "security-a", configurationRevision: null }, tokenMode: "delegated", status: "succeeded",
    filters: { templateId: "agents_inventory", startDateTime: "2026-09-09T10:00:00.000Z", endDateTime: "2026-09-09T11:00:00.000Z", agentIds: [], entraAgentIds: [entraAgentId], blueprintIds: [], actorObjectIds: [], operations: [] },
    queryVersion: 3, retainedScopeId: catalog.retainedScopes[0].id, localRequestId: "22222222-2222-4222-8222-222222222222", providerRequestId: "provider-a", providerRequestCount: 1,
    activationCount: 1, providerRowCount: 1, storedRowCount: 1, byteCount: 512, complete: true, noData: false, partialReason: null,
    observedRange: { startDateTime: "2026-09-09T10:30:00.000Z", endDateTime: "2026-09-09T10:30:00.000Z" }, unobservedRange: null,
    snapshotId: "33333333-3333-4333-8333-333333333333", priorSuccessfulJobId: null, qualification: null, cancelRequested: false, createdAt: "2026-09-09T11:00:00.000Z",
    attemptedAt: "2026-09-09T11:00:00.000Z", updatedAt: "2026-09-09T11:00:01.000Z", finishedAt: "2026-09-09T11:00:01.000Z",
    expiresAt: "2026-10-09T11:00:00.000Z", canResume: false, ...overrides };
}

function inventoryPage(sourceJob: DefenderHuntingJob, agentName: string): DefenderHuntingRowPage {
  return { value: [{ projectionVersion: 3, sourceTable: "AgentsInfo", observationTime: "2026-09-09T10:30:00.000Z", agentId: `${agentName}-id`, agentName,
    platform: "CopilotStudio", agentDescription: null, version: null, sourceAgentId: null, entraAgentObjectId: null, entraBlueprintId: null, observabilityId: null,
    publishedStatus: null, lifecycleStatus: null, availability: null, createdDateTime: null, lastPublishedDateTime: null, lastUpdatedDateTime: null,
    instanceCount: null, model: null, ownerCount: null, sharedWithCount: null, permissionMetadataKeyCount: null, authenticationMetadataKeyCount: null,
    detailStates: { owners: "not_supplied", sharing: "not_supplied", permissions: "not_exposed", authentication: "not_exposed", risk: "not_exposed" } }],
  count: 1, limit: 100, offset: 0, job: sourceJob, snapshot: { id: sourceJob.snapshotId!, jobId: sourceJob.id, resultScope: sourceJob.resultScope,
    filters: sourceJob.filters, sourceTable: "AgentsInfo", queryVersion: 3, requestedRange: { startDateTime: sourceJob.filters.startDateTime, endDateTime: sourceJob.filters.endDateTime },
    observedRange: sourceJob.observedRange, unobservedRange: sourceJob.unobservedRange, observationTime: sourceJob.finishedAt!, complete: sourceJob.complete,
    noData: sourceJob.noData, partialReason: sourceJob.partialReason, providerRowCount: sourceJob.providerRowCount, storedRowCount: sourceJob.storedRowCount,
    byteCount: sourceJob.byteCount, expiresAt: sourceJob.expiresAt } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function context(available = true, roles: SessionUser["roles"] = ["AgentControl.Admin"], homeAccountId = "security-a"): ReturnType<typeof useCapabilityContext> {
  return { user: { homeAccountId, tenantId: "tenant-a", displayName: "Security", username: `${homeAccountId}@example.invalid`, roles: [...roles] }, loading: false,
    pending: false, error: undefined,
    now: Date.parse("2026-09-09T11:02:00.000Z"), reload: vi.fn(async () => undefined), openPermissions: vi.fn(),
    views: (["delegated", "application"] as const).map<CapabilityView>(mode => ({ definition: { id: `defender.hunting.${mode}`, displayName: "Defender hunting", purpose: "Hunt", provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: "https://graph.microsoft.com",
      mode, permissions: ["ThreatHunting.Read.All"], providerRoles: [], licenses: [], configuration: [], sources: [], dataClass: "hunting", internalRoles: ["AgentControl.Viewer"],
      probe: { kind: "live_qualification", adapterRegistered: true, description: "bounded" } },
      decision: { capabilityId: `defender.hunting.${mode}`, status: available ? "available" : "unknown", authorized: available, fresh: available,
        checkedAt: available ? "2026-09-09T11:00:00.000Z" : undefined, expiresAt: available ? "2026-09-09T11:05:00.000Z" : undefined,
        previewQualification: "not_required", remediation: available ? [] : ["Run one approved qualification."] } })) };
}

function renderView(available = true, roles?: readonly ("AgentControl.Viewer" | "AgentControl.Admin")[]) {
  if (!available) vi.mocked(getDefenderHuntingCatalog).mockResolvedValue({ ...catalog, qualifications: [] });
  return render(<CapabilityContext value={context(available, roles ? [...roles] : undefined)}><DefenderHuntingView /></CapabilityContext>);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-09T11:02:00.000Z"));
  window.history.replaceState({}, "", "/agents?detail=agent-a&detailTab=audit-security");
  vi.mocked(getDefenderHuntingCatalog).mockResolvedValue(catalog);
  vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DefenderHuntingView", () => {
  it("shows the documented human caller rather than the provider account and retires rows on user changes", async () => {
    const human = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const account = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const selected = job({ filters: { ...job().filters, templateId: "agent_activity", operations: ["InvokeAgent"], userObjectId: human } });
    const page = inventoryPage(selected, "unused");
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [selected], count: 1, limit: 20, offset: 0 });
    vi.mocked(getDefenderHuntingRows).mockResolvedValue({ ...page, snapshot: { ...page.snapshot!, sourceTable: "CloudAppEvents" },
      value: [{
        projectionVersion: 3, sourceTable: "CloudAppEvents", timestamp: "2026-09-09T10:30:00.000Z", actionType: "InvokeAgent",
        cloudApplication: null, cloudApplicationId: null, cloudAppInstanceId: null, actorAccountObjectId: account, actorProviderAccountId: null,
        objectId: null, reportId: "report-a", oauthAppId: null, operation: "invoke_agent", organizationId: null, targetAgentId: applicationId,
        targetAgentName: "Selected agent", targetAgentBlueprintId: null, agentId: null, agentName: null, agentBlueprintId: null,
        alternatePlatformAgentId: null, platformAgentType: null, conversationId: null, conversationThreadId: null, sessionIdentity: null, channelName: null,
        humanActorUserObjectId: human, humanActorUserPrincipalName: "human@example.invalid", agentUserObjectId: null, agentUserPrincipalName: null,
        targetAgentUserObjectId: null, spanId: "span-a", parentSpanId: null, creationTime: null, completionTime: null, errorType: null,
        toolName: null, toolType: null, toolCallId: null, invokeSource: null, durationMilliseconds: null,
        outcome: "unknown", spanRole: "root_invoke_agent", rootSpanObserved: true, contentAvailable: false,
        fieldStates: { conversationId: "null", conversationThreadId: "unavailable", channelName: "null",
          humanActorUserObjectId: "value", agentUserObjectId: "unavailable", targetAgentUserObjectId: "null",
          completionTime: "null", errorType: "null", platformAgentId: "null", platformAgentType: "null" },
      }] });
    const view = render(<CapabilityContext value={context()}><AgentDefenderHuntingView userObjectId={human} /></CapabilityContext>);
    fireEvent.click(await screen.findByRole("button", { name: /View hunt/ }));
    const rows = within(await screen.findByRole("region", { name: "Minimized hunting rows" }));
    expect(rows.getByText("Human caller")).toBeVisible();
    expect(rows.getByText("human@example.invalid")).toBeVisible();
    expect(rows.getByText(human)).toBeVisible();
    expect(rows.queryByText(account)).not.toBeInTheDocument();
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
    view.rerender(<CapabilityContext value={context()}><AgentDefenderHuntingView userObjectId={account} /></CapabilityContext>);
    expect(screen.queryByText("human@example.invalid")).not.toBeInTheDocument();
    await screen.findByText("No hunting history");
    expect(getDefenderHuntingJobs).toHaveBeenLastCalledWith(20, 0, expect.objectContaining({ userObjectId: account }));
  });

  it.each([undefined, agentRecordId])("scopes a human invocation search and its history to user plus agent %s", async selectedAgent => {
    const userObjectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    vi.mocked(submitDefenderHunt).mockRejectedValue(new ApiError(403, "provider_denied", "Defender access denied by the provider."));
    render(<CapabilityContext value={context()}><AgentDefenderHuntingView userObjectId={userObjectId}
      agentRecordId={selectedAgent} entraAgentApplicationIds={selectedAgent ? [applicationId] : []} /></CapabilityContext>);
    await screen.findByText("No hunting history");
    expect(getDefenderHuntingJobs).toHaveBeenCalledWith(20, 0, expect.objectContaining({ agentRecordId: selectedAgent, userObjectId }));
    expect(getDefenderHuntingCatalog).toHaveBeenCalledWith(expect.objectContaining({ agentRecordId: selectedAgent, userObjectId }));
    expect(within(screen.getByLabelText("Log type")).getAllByRole("option")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Log type"), { target: { value: "agent_activity" } });
    fireEvent.click(screen.getByRole("button", { name: "Run hunt" }));
    await waitFor(() => expect(submitDefenderHunt).toHaveBeenCalledWith("delegated", expect.objectContaining({
      templateId: "agent_activity", userObjectId, operations: ["InvokeAgent"],
      entraAgentApplicationIds: selectedAgent ? [applicationId] : [],
    }), expect.objectContaining({ agentRecordId: selectedAgent, userObjectId })));
    expect(await screen.findByText("Defender access denied by the provider.")).toBeVisible();
  });

  it.each(["history", "exact job"] as const)(
    "settles terminal %s polling and reads qualification evidence after completion without duplicate job reads", async location => {
      vi.useFakeTimers();
      const qualification = { capabilityId: "defender.hunting.application" as const, contractRevision: "a".repeat(64),
        permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: "security-a" };
      const approved = job({ status: "waiting_authorization", tokenMode: "application", qualification, snapshotId: null, canResume: true });
      const running = job({ status: "running", tokenMode: "application", qualification, snapshotId: null });
      const completed = job({ tokenMode: "application", qualification });
      const pendingCatalog = deferred<DefenderHuntingCatalog>();
      const qualifiedCatalog: DefenderHuntingCatalog = { ...catalog,
        qualifications: [{ ...catalog.qualifications[0], capabilityId: "defender.hunting.application" }],
        retainedScopes: [{ ...catalog.retainedScopes[0], capabilityId: "defender.hunting.application", tokenMode: "application",
          resultScope: { kind: "application", scopeId: "application-a", configurationRevision: 1 } }],
      };
      vi.mocked(getDefenderHuntingCatalog).mockResolvedValueOnce({ ...catalog, qualifications: [], retainedScopes: [] })
        .mockReturnValueOnce(pendingCatalog.promise);
      vi.mocked(approveDefenderHuntingQualification).mockResolvedValue(approved);
      vi.mocked(startDefenderHuntingQualification).mockResolvedValue(running);
      vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 })
        .mockResolvedValueOnce({ value: [approved], count: 1, limit: 20, offset: 0 })
        .mockResolvedValueOnce({ value: [running], count: 1, limit: 20, offset: 0 })
        .mockResolvedValue({ value: location === "history" ? [completed] : [], count: location === "history" ? 1 : 0, limit: 20, offset: 0 });
      vi.mocked(getDefenderHuntingJob).mockResolvedValueOnce(approved).mockResolvedValue(completed);
      renderView();
      await act(async () => {});
      fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
      fireEvent.click(screen.getByRole("checkbox", { name: /Approve one bounded/ }));
      fireEvent.click(screen.getByRole("button", { name: "Approve qualification" }));
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Run approved qualification" }));
      await act(async () => {});
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(1_500));
      expect(getDefenderHuntingCatalog).toHaveBeenCalledTimes(2);
      const signal = vi.mocked(getDefenderHuntingCatalog).mock.calls[1][0]!.signal!;
      expect(signal.aborted).toBe(false);
      if (location === "exact job") {
        expect(getDefenderHuntingJob).toHaveBeenCalledTimes(2);
        expect(vi.mocked(getDefenderHuntingJob).mock.invocationCallOrder[1])
          .toBeLessThan(vi.mocked(getDefenderHuntingCatalog).mock.invocationCallOrder[1]);
      } else expect(getDefenderHuntingJob).toHaveBeenCalledOnce();
      await act(async () => pendingCatalog.resolve(qualifiedCatalog));
      expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
      await act(() => vi.advanceTimersByTimeAsync(3_000));
      expect(getDefenderHuntingCatalog).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["delete", "revoke", "cancel", "resume"] as const)(
    "reconciles an admitted %s after draft edits without restoring cleared selection", async action => {
      vi.useFakeTimers();
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const existing = job({ ...(action === "cancel" ? { status: "running" as const }
        : action === "resume" ? { status: "waiting_authorization" as const, canResume: true } : {}) });
      const pending = deferred<DefenderHuntingJob>();
      const deleted = deferred<void>();
      const revoked = deferred<DefenderHuntingCatalog["retainedScopes"][number]>();
      vi.mocked(cancelDefenderHunt).mockReturnValue(pending.promise);
      vi.mocked(resumeDefenderHunt).mockReturnValue(pending.promise);
      vi.mocked(deleteDefenderHunt).mockReturnValue(deleted.promise);
      vi.mocked(revokeDefenderHuntingRetainedScope).mockReturnValue(revoked.promise);
      vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ value: [existing], count: 1, limit: 20, offset: 0 })
        .mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
      vi.mocked(getDefenderHuntingCatalog).mockResolvedValueOnce(catalog).mockResolvedValue({ ...catalog, qualifications: [], retainedScopes: [] });
      renderView();
      await act(async () => {});
      const label = action === "revoke" ? /Revoke saved-data access/ : new RegExp(`${action[0].toUpperCase()}${action.slice(1)} hunt`);
      fireEvent.click(screen.getByRole("button", { name: label }));
      await act(async () => {});
      const signal = action === "revoke" ? vi.mocked(revokeDefenderHuntingRetainedScope).mock.calls[0][1]!.signal!
        : action === "delete" ? vi.mocked(deleteDefenderHunt).mock.calls[0][1]!.signal!
          : action === "cancel" ? vi.mocked(cancelDefenderHunt).mock.calls[0][1]!.signal!
            : vi.mocked(resumeDefenderHunt).mock.calls[0][1]!.signal!;
      fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-09T10:30" } });
      expect(signal.aborted).toBe(false);
      expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
      await act(async () => {
        if (action === "delete") deleted.resolve(undefined);
        else if (action === "revoke") revoked.resolve({ ...catalog.retainedScopes[0], revokedAt: "2026-09-09T11:03:00.000Z" });
        else pending.resolve({ ...existing, status: action === "cancel" ? "cancelled" : "succeeded" });
      });
      expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
      expect(screen.getByText("No hunting history")).toBeVisible();
      expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
      expect(screen.queryByRole("region", { name: "Defender agent inventory result" })).not.toBeInTheDocument();
      if (action === "revoke") {
        expect(getDefenderHuntingCatalog).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole("region", { name: "Retained hunting scope" })).not.toBeInTheDocument();
      }
    },
  );

  it.each(["start", "resume"] as const)("refreshes qualification evidence when %s finishes before its history read", async action => {
    vi.useFakeTimers();
    const qualification = { capabilityId: "defender.hunting.application" as const, contractRevision: "a".repeat(64),
      permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: "security-a" };
    const approved = job({ status: "waiting_authorization", tokenMode: "application", qualification, snapshotId: null, canResume: true });
    const running = { ...approved, status: "running" as const, canResume: false };
    const completed = job({ tokenMode: "application", qualification });
    vi.mocked(approveDefenderHuntingQualification).mockResolvedValue(approved);
    vi.mocked(getDefenderHuntingJob).mockResolvedValue(approved);
    vi.mocked(startDefenderHuntingQualification).mockResolvedValue(running);
    vi.mocked(resumeDefenderHunt).mockResolvedValue(running);
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 })
      .mockResolvedValueOnce({ value: [approved], count: 1, limit: 20, offset: 0 })
      .mockResolvedValue({ value: [completed], count: 1, limit: 20, offset: 0 });
    vi.mocked(getDefenderHuntingCatalog).mockResolvedValueOnce({ ...catalog, qualifications: [], retainedScopes: [] })
      .mockResolvedValue({ ...catalog,
        qualifications: [{ ...catalog.qualifications[0], capabilityId: "defender.hunting.application" }],
        retainedScopes: [{ ...catalog.retainedScopes[0], capabilityId: "defender.hunting.application", tokenMode: "application",
          resultScope: { kind: "application", scopeId: "application-a", configurationRevision: 1 } }],
      });
    renderView();
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Approve one bounded/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve qualification" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: action === "start" ? "Run approved qualification" : /Resume hunt/ }));
    await act(async () => {});
    expect(getDefenderHuntingCatalog).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(3);
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("does not poll an exact selected job already returned in the current history page", async () => {
    vi.useFakeTimers();
    const running = job({ status: "running", snapshotId: null });
    vi.mocked(submitDefenderHunt).mockResolvedValue(running);
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [running], count: 1, limit: 20, offset: 0 });
    vi.mocked(getDefenderHuntingJob).mockResolvedValue(running);
    renderView();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Run hunt" }));
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(4);
    expect(getDefenderHuntingCatalog).toHaveBeenCalledTimes(3);
    expect(getDefenderHuntingJob).not.toHaveBeenCalled();
  });

  it("reads the catalog after progressing jobs settle during an explicit refresh", async () => {
    vi.useFakeTimers();
    const qualification = { capabilityId: "defender.hunting.application" as const, contractRevision: "a".repeat(64),
      permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: "security-a" };
    const running = job({ status: "running", tokenMode: "application", qualification, snapshotId: null });
    const completed = job({ tokenMode: "application", qualification });
    const history = deferred<Awaited<ReturnType<typeof getDefenderHuntingJobs>>>();
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ value: [running], count: 1, limit: 20, offset: 0 })
      .mockReturnValueOnce(history.promise);
    vi.mocked(getDefenderHuntingCatalog).mockResolvedValueOnce({ ...catalog, qualifications: [], retainedScopes: [] })
      .mockResolvedValue({ ...catalog,
        qualifications: [{ ...catalog.qualifications[0], capabilityId: "defender.hunting.application" }],
        retainedScopes: [{ ...catalog.retainedScopes[0], capabilityId: "defender.hunting.application", tokenMode: "application",
          resultScope: { kind: "application", scopeId: "application-a", configurationRevision: 1 } }],
      });
    renderView();
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh hunting history" }));
    await act(async () => {});
    expect(getDefenderHuntingCatalog).toHaveBeenCalledOnce();
    await act(async () => history.resolve({ value: [completed], count: 1, limit: 20, offset: 0 }));
    expect(getDefenderHuntingCatalog).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
  });

  it("invalidates catalog qualification evidence after deleting its source job", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const qualified = job({ tokenMode: "application", qualification: { capabilityId: "defender.hunting.application",
      contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: "security-a" } });
    const qualifiedCatalog: DefenderHuntingCatalog = { ...catalog,
      qualifications: [{ ...catalog.qualifications[0], capabilityId: "defender.hunting.application" }],
      retainedScopes: [{ ...catalog.retainedScopes[0], capabilityId: "defender.hunting.application", tokenMode: "application",
        sourceQualificationJobId: qualified.id, resultScope: { kind: "application", scopeId: "application-a", configurationRevision: 1 } }],
    };
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ value: [qualified], count: 1, limit: 20, offset: 0 })
      .mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
    vi.mocked(getDefenderHuntingCatalog).mockResolvedValueOnce(qualifiedCatalog)
      .mockResolvedValue({ ...qualifiedCatalog, qualifications: [] });
    vi.mocked(deleteDefenderHunt).mockResolvedValue(undefined);
    renderView();
    await screen.findByRole("button", { name: /Delete hunt/ });
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Delete hunt/ }));
    await screen.findByText("No hunting history");
    expect(getDefenderHuntingCatalog).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
    expect(screen.getByText("Shared application hunting is not qualified")).toBeVisible();
  });

  it.each(["delete", "resume", "cancel"] as const)("reconciles the current approval after history %s", async action => {
    vi.useFakeTimers();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const approved = job({ status: "waiting_authorization", tokenMode: "application", snapshotId: null, canResume: true,
      qualification: { capabilityId: "defender.hunting.application", contractRevision: "a".repeat(64),
        permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: "security-a" } });
    const running = { ...approved, status: "running" as const, canResume: false };
    const cancelled = { ...approved, status: "cancelled" as const, canResume: false, cancelRequested: true };
    vi.mocked(approveDefenderHuntingQualification).mockResolvedValue(approved);
    vi.mocked(startDefenderHuntingQualification).mockResolvedValue(running);
    vi.mocked(getDefenderHuntingJob).mockResolvedValue(approved);
    vi.mocked(deleteDefenderHunt).mockResolvedValue(undefined);
    vi.mocked(resumeDefenderHunt).mockResolvedValue(running);
    vi.mocked(cancelDefenderHunt).mockResolvedValue(cancelled);
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 })
      .mockResolvedValueOnce({ value: [approved], count: 1, limit: 20, offset: 0 });
    if (action === "cancel") vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ value: [running], count: 1, limit: 20, offset: 0 });
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({
      value: action === "delete" ? [] : [action === "resume" ? running : cancelled],
      count: action === "delete" ? 0 : 1, limit: 20, offset: 0,
    });
    renderView(false);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Approve one bounded/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve qualification" }));
    await act(async () => {});
    if (action === "cancel") {
      fireEvent.click(screen.getByRole("button", { name: "Run approved qualification" }));
      await act(async () => {});
    }
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`${action[0].toUpperCase()}${action.slice(1)} hunt`) }));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Run approved qualification" })).not.toBeInTheDocument();
    if (action === "resume") {
      vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [approved], count: 1, limit: 20, offset: 0 });
      await act(() => vi.advanceTimersByTimeAsync(1_500));
      expect(screen.getByRole("button", { name: "Run approved qualification" })).toBeEnabled();
      expect(startDefenderHuntingQualification).not.toHaveBeenCalled();
    }
  });

  it.each(["refresh", "history page"] as const)("finishes an explicit %s read after draft edits without stranding loading", async action => {
    const history = { value: [job()], count: 21, limit: 20, offset: 0 };
    const pending = deferred<typeof history>();
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce(history).mockReturnValueOnce(pending.promise).mockResolvedValue(history);
    renderView();
    await screen.findByRole("button", { name: /View hunt 11111111/ });
    fireEvent.click(screen.getByRole("button", { name: action === "refresh" ? "Refresh hunting history" : "Next" }));
    await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(getDefenderHuntingJobs).mock.calls[1][2]!.signal!;
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-09T10:30" } });
    expect(signal.aborted).toBe(false);
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
    await act(async () => pending.resolve({ ...history, offset: action === "history page" ? 20 : 0 }));
    expect(screen.queryByText(/Loading hunting history|Refreshing hunting access/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /View hunt 11111111/ })).toBeEnabled();
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Start")).toHaveValue("2026-09-09T10:30");
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it.each(["draft", "account"] as const)("keeps an export bound to its saved job through a %s change", async change => {
    vi.useFakeTimers();
    const pending = deferred<Blob>();
    const blob = new Blob(["minimized rows"], { type: "text/csv" });
    const createObjectURL = vi.fn(() => "blob:defender-export");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.mocked(downloadDefenderHuntingCsv).mockReturnValue(pending.promise);
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ value: [job()], count: 1, limit: 20, offset: 0 })
      .mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
    const content = (account = "security-a") => <CapabilityContext value={context(true, ["AgentControl.Admin"], account)}><DefenderHuntingView /></CapabilityContext>;
    const view = render(content());
    await act(async () => {});
    const exportButton = screen.getByRole("button", { name: /Export hunt/ });
    act(() => {
      exportButton.click();
      exportButton.click();
    });
    expect(downloadDefenderHuntingCsv).toHaveBeenCalledOnce();
    const signal = vi.mocked(downloadDefenderHuntingCsv).mock.calls[0][1]!.signal!;
    if (change === "account") view.rerender(content("other-account"));
    else fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-09T10:30" } });
    expect(signal.aborted).toBe(change === "account");
    await act(async () => pending.resolve(blob));
    if (change === "account") {
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(click).not.toHaveBeenCalled();
    } else {
      expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(blob);
      expect(click).toHaveBeenCalledOnce();
      expect(document.querySelector("a[download]")).toHaveAttribute("download", `defender-hunting-${job().id}.csv`);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:defender-export");
      expect(document.querySelector("a[download]")).not.toBeInTheDocument();
    }
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it.each(["request", "activation"] as const)("recovers an export %s failure without leaking downloads or reloading history", async stage => {
    vi.useFakeTimers();
    const failure = new Error(`CSV ${stage} failed`);
    const blob = new Blob(["saved hunting rows"]);
    const createObjectURL = vi.fn(() => `blob:defender-${createObjectURL.mock.calls.length}`);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.mocked(downloadDefenderHuntingCsv).mockResolvedValue(blob);
    if (stage === "request") vi.mocked(downloadDefenderHuntingCsv).mockRejectedValueOnce(failure);
    else click.mockImplementationOnce(() => { throw failure; });
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [job()], count: 1, limit: 20, offset: 0 });
    renderView();
    await act(async () => {});
    const button = screen.getByRole("button", { name: /Export hunt/ });

    await act(async () => { button.click(); button.click(); });
    expect(downloadDefenderHuntingCsv).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent(failure.message);
    expect(button).toBeEnabled();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(document.querySelector("a[download]")).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledTimes(stage === "activation" ? 1 : 0);

    await act(async () => { button.click(); button.click(); });
    expect(downloadDefenderHuntingCsv).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(document.querySelector("a[download]")).toHaveAttribute("download", `defender-hunting-${job().id}.csv`);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(document.querySelector("a[download]")).not.toBeInTheDocument();
    expect(revokeObjectURL.mock.calls).toEqual(createObjectURL.mock.results.map(result => [result.value]));
    expect(getDefenderHuntingCatalog).toHaveBeenCalledOnce();
    expect(getDefenderHuntingJobs).toHaveBeenCalledOnce();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it.each([
    { action: "export", error: new ApiError(404, "not_found", "Saved hunting job unavailable") },
    { action: "export", error: new ApiError(409, "agent_investigation_unavailable", "Saved investigation identity unavailable") },
    { action: "export", error: new ApiError(409, "agent_identity_source_changed", "Saved agent source changed") },
    { action: "resume", error: new ApiError(404, "not_found", "Saved hunting job unavailable") },
    { action: "resume", error: new ApiError(409, "application_scope_changed", "Saved hunting scope changed") },
    { action: "cancel", error: new ApiError(404, "not_found", "Saved hunting job unavailable") },
    { action: "cancel", error: new ApiError(409, "hunting_job_state", "Saved hunting job changed") },
    { action: "delete", error: new ApiError(404, "not_found", "Saved hunting job unavailable") },
    { action: "revoke", error: new ApiError(404, "not_found", "Saved hunting scope unavailable") },
  ] as const)("withdraws stale hunting evidence after $action rejects it with $error.code", async ({ action, error }) => {
    const saved = job(action === "resume" ? { canResume: true }
      : action === "cancel" ? { status: "running", finishedAt: null } : {});
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ value: [saved], count: 1, limit: 20, offset: 0 })
      .mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
    vi.mocked(getDefenderHuntingRows).mockResolvedValue(inventoryPage(saved, "Retired saved agent"));
    const command = action === "export" ? downloadDefenderHuntingCsv : action === "resume" ? resumeDefenderHunt
      : action === "cancel" ? cancelDefenderHunt : action === "delete" ? deleteDefenderHunt : revokeDefenderHuntingRetainedScope;
    vi.mocked(command).mockRejectedValue(error);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderView();
    const name = action === "resume" ? /Resume hunt/ : action === "cancel" ? /Cancel hunt/
      : action === "delete" ? /Delete hunt/ : action === "revoke" ? /Revoke saved-data access/ : /Export hunt/;
    await screen.findByRole("button", { name: /View hunt|Cancel hunt/ });
    if (action !== "cancel") {
      fireEvent.click(screen.getByRole("button", { name: /View hunt/ }));
      expect(await screen.findByText("Retired saved agent")).toBeVisible();
    }

    fireEvent.click(screen.getByRole("button", { name }));
    expect(await screen.findByRole("alert")).toHaveTextContent(error.message);
    expect(screen.queryByText("Retired saved agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.getByText("Hunting history unavailable")).toBeVisible();
    expect(screen.queryByText("No hunting history")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
    expect(command).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
    expect(getDefenderHuntingJobs).toHaveBeenCalledOnce();
    expect(getDefenderHuntingCatalog).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Refresh hunting history" }));
    expect(await screen.findByText("No hunting history")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
    expect(command).toHaveBeenCalledOnce();
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
    expect(getDefenderHuntingCatalog).toHaveBeenCalledTimes(2);
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("keeps the admitted approval when duplicate clicks arrive before React commits", async () => {
    const pending = deferred<DefenderHuntingJob>();
    vi.mocked(approveDefenderHuntingQualification).mockReturnValue(pending.promise);
    renderView(false);
    await screen.findByText("No hunting history");
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Approve one bounded/ }));
    const approve = screen.getByRole("button", { name: "Approve qualification" });
    act(() => {
      approve.click();
      approve.click();
    });
    expect(approveDefenderHuntingQualification).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(job({ status: "waiting_authorization", snapshotId: null, canResume: true, qualification: {
      capabilityId: "defender.hunting.application", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64),
      configurationRevision: 1, approvedBy: "security-a",
    } })));
    expect(screen.getByRole("button", { name: "Run approved qualification" })).toBeEnabled();
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
    expect(startDefenderHuntingQualification).not.toHaveBeenCalled();
  });

  it("keeps the admitted row selection and announces its pending read when another click is rejected", async () => {
    const second = job({ id: "22222222-2222-4222-8222-222222222222" });
    const pending = deferred<DefenderHuntingRowPage>();
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [job(), second], count: 2, limit: 20, offset: 0 });
    vi.mocked(getDefenderHuntingRows).mockReturnValue(pending.promise);
    renderView();
    const firstButton = await screen.findByRole("button", { name: /View hunt 11111111/ });
    const secondButton = screen.getByRole("button", { name: /View hunt 22222222/ });
    act(() => {
      firstButton.click();
      secondButton.click();
    });
    expect(getDefenderHuntingRows).toHaveBeenCalledOnce();
    expect(firstButton.closest("tr")).toHaveClass("selected-row");
    expect(secondButton.closest("tr")).not.toHaveClass("selected-row");
    expect(screen.getByText("Loading minimized rows...")).toHaveAttribute("role", "status");
    expect(screen.queryByText("No loaded rows match these filters.")).not.toBeInTheDocument();
    await act(async () => pending.resolve(inventoryPage(job(), "Admitted selection")));
    expect(screen.getByText("Admitted selection")).toBeVisible();
    expect(screen.queryByText("Loading minimized rows...")).not.toBeInTheDocument();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("still fails closed and allows retry when a refreshed saved read fails after draft edits", async () => {
    const history = { value: [job()], count: 1, limit: 20, offset: 0 };
    const pending = deferred<typeof history>();
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce(history).mockReturnValueOnce(pending.promise).mockResolvedValue(history);
    vi.mocked(getDefenderHuntingRows).mockResolvedValue(inventoryPage(job(), "Previous selected result"));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /View hunt 11111111/ }));
    await screen.findByText("Previous selected result");
    fireEvent.click(screen.getByRole("button", { name: "Refresh hunting history" }));
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-09T10:30" } });
    await act(async () => pending.reject(new ApiError(403, "forbidden", "Saved hunting access denied")));
    expect(screen.getByRole("alert")).toHaveTextContent("Saved hunting access denied");
    expect(screen.getByText("Hunting history unavailable")).toBeVisible();
    expect(screen.queryByText("Previous selected result")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh hunting history" }));
    await screen.findByRole("button", { name: /View hunt 11111111/ });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Start")).toHaveValue("2026-09-09T10:30");
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
    expect(getDefenderHuntingRows).toHaveBeenCalledOnce();
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(3);
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("does not restore a cleared exact-job selection when refresh must clamp history after cancellation", async () => {
    const running = job({ id: "22222222-2222-4222-8222-222222222222", status: "running", snapshotId: null });
    const cancelled = { ...running, status: "cancelled" as const, cancelRequested: true };
    const firstPage = { value: [job()], count: 21, limit: 20, offset: 0 };
    const lastPage = { value: [running], count: 21, limit: 20, offset: 20 };
    const clamped = deferred<typeof firstPage>();
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce(firstPage).mockResolvedValueOnce(lastPage)
      .mockResolvedValueOnce({ ...lastPage, value: [cancelled] })
      .mockResolvedValueOnce({ ...lastPage, value: [], count: 1 }).mockReturnValueOnce(clamped.promise);
    vi.mocked(cancelDefenderHunt).mockResolvedValue(cancelled);
    vi.mocked(getDefenderHuntingJob).mockResolvedValue(cancelled);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: /Cancel hunt 22222222/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh hunting history" })).toBeEnabled());
    expect(screen.getByRole("region", { name: "Defender agent inventory result" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh hunting history" }));
    await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(5));
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-09T10:30" } });
    await act(async () => clamped.resolve({ ...firstPage, count: 1 }));
    expect(screen.queryByRole("region", { name: "Defender agent inventory result" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /View hunt 11111111/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
    expect(cancelDefenderHunt).toHaveBeenCalledExactlyOnceWith(running.id, expect.objectContaining({ agentRecordId }));
    expect(getDefenderHuntingJob).toHaveBeenCalledOnce();
    expect(getDefenderHuntingRows).not.toHaveBeenCalled();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it.each(["typed identity", "capability"] as const)(
    "does not reuse an old owner's pending saved read across a %s boundary", async boundary => {
      const client = createSavedQueryClient();
      const oldHistory = deferred<Awaited<ReturnType<typeof getDefenderHuntingJobs>>>();
      vi.mocked(getDefenderHuntingJobs).mockReturnValueOnce(oldHistory.promise)
        .mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
      const content = (changed = false) => <SavedQueryProvider client={client}>
        <CapabilityContext value={context()}><section aria-label="Old hunting owner"><DefenderHuntingView /></section></CapabilityContext>
        <CapabilityContext value={context(!changed || boundary !== "capability")}>
          <section aria-label="Current hunting owner"><AgentDefenderHuntingView agentRecordId={agentRecordId}
            agentName="Selected agent" entraAgentIds={[changed && boundary === "typed identity" ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc" : entraAgentId]}
            entraAgentApplicationIds={[applicationId]} /></section>
        </CapabilityContext>
      </SavedQueryProvider>;
      const view = render(content());
      try {
        await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenCalledOnce());
        expect(getDefenderHuntingCatalog).toHaveBeenCalledOnce();
        const signal = vi.mocked(getDefenderHuntingJobs).mock.calls[0][2]!.signal!;
        view.rerender(content(true));
        await act(async () => {});
        expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
        expect(getDefenderHuntingCatalog).toHaveBeenCalledTimes(2);
        expect(signal.aborted).toBe(false);
        const current = within(screen.getByRole("region", { name: "Current hunting owner" }));
        expect(current.getByText("No hunting history")).toBeVisible();
        await act(async () => oldHistory.resolve({ value: [job()], count: 1, limit: 20, offset: 0 }));
        expect(within(screen.getByRole("region", { name: "Old hunting owner" })).getByRole("button", { name: /View hunt 11111111/ })).toBeVisible();
        expect(current.queryByRole("button", { name: /View hunt 11111111/ })).not.toBeInTheDocument();
        expect(submitDefenderHunt).not.toHaveBeenCalled();
      } finally {
        view.unmount();
        client.clear();
      }
    },
  );

  it.each([
    ["qualification", false], ["retained scope", false], ["qualification", true], ["retained scope", true],
  ] as const)(
    "expires application %s independently of the capability clock without reloading saved data (timers suspended: %s)", async (expiring, suspended) => {
      vi.useFakeTimers();
      const expiresAt = new Date(Date.now() + 1_000).toISOString();
      vi.mocked(getDefenderHuntingCatalog).mockResolvedValue({
        ...catalog,
        qualifications: [{ ...catalog.qualifications[0], capabilityId: "defender.hunting.application",
          ...(expiring === "qualification" ? { expiresAt } : {}) }],
        retainedScopes: [{ ...catalog.retainedScopes[0], tokenMode: "application", capabilityId: "defender.hunting.application",
          resultScope: { kind: "application", scopeId: "application-a", configurationRevision: 1 },
          ...(expiring === "retained scope" ? { expiresAt } : {}) }],
      });
      const access = context();
      render(<CapabilityContext value={access}><DefenderHuntingView /></CapabilityContext>);
      await act(async () => {});
      fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
      expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
      if (suspended) {
        vi.setSystemTime(new Date(Date.parse(expiresAt) + 1));
        fireEvent.submit(screen.getByRole("button", { name: "Run hunt" }).closest("form")!);
        expect(submitDefenderHunt).not.toHaveBeenCalled();
        act(() => window.dispatchEvent(new Event("focus")));
      } else await act(() => vi.advanceTimersByTimeAsync(1_001));
      expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
      if (expiring === "retained scope") expect(screen.queryByRole("region", { name: "Retained hunting scope" })).not.toBeInTheDocument();
      expect(getDefenderHuntingCatalog).toHaveBeenCalledOnce();
      expect(getDefenderHuntingJobs).toHaveBeenCalledOnce();
      expect(access.reload).not.toHaveBeenCalled();
      expect(submitDefenderHunt).not.toHaveBeenCalled();
    },
  );

  it("keeps an admitted application hunt and filters when its qualification expires", async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 1_000).toISOString();
    vi.mocked(getDefenderHuntingCatalog).mockResolvedValue({
      ...catalog,
      qualifications: [{ ...catalog.qualifications[0], capabilityId: "defender.hunting.application", expiresAt }],
      retainedScopes: [{ ...catalog.retainedScopes[0], tokenMode: "application", capabilityId: "defender.hunting.application",
        resultScope: { kind: "application", scopeId: "application-a", configurationRevision: 1 } }],
    });
    const pending = deferred<DefenderHuntingJob>();
    vi.mocked(submitDefenderHunt).mockReturnValue(pending.promise);
    const access = context();
    render(<CapabilityContext value={access}><DefenderHuntingView /></CapabilityContext>);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-09T10:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Run hunt" }));
    const signal = vi.mocked(submitDefenderHunt).mock.calls[0][2]!.signal!;
    await act(() => vi.advanceTimersByTimeAsync(1_001));
    expect(signal.aborted).toBe(false);
    expect(getDefenderHuntingCatalog).toHaveBeenCalledOnce();
    expect(getDefenderHuntingJobs).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(job({ tokenMode: "application" })));
    expect(screen.getByRole("region", { name: "Defender agent inventory result" })).toBeVisible();
    expect(screen.getByLabelText("Start")).toHaveValue("2026-09-09T10:30");
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
    expect(submitDefenderHunt).toHaveBeenCalledOnce();
    expect(access.reload).not.toHaveBeenCalled();
  });

  it.each(["timer", "suspended timer", "readback"] as const)(
    "rejects an approval that expires during %s while the capability clock is unchanged", async phase => {
      vi.useFakeTimers();
      const expiresAt = new Date(Date.now() + 1_000).toISOString();
      const approved = job({ status: "waiting_authorization", snapshotId: null, canResume: true, expiresAt, qualification: {
        capabilityId: "defender.hunting.application", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64),
        configurationRevision: 1, approvedBy: "security-a",
      } });
      const readback = deferred<DefenderHuntingJob>();
      vi.mocked(approveDefenderHuntingQualification).mockResolvedValue(approved);
      vi.mocked(getDefenderHuntingJob).mockReturnValue(readback.promise);
      renderView(false);
      await act(async () => {});
      fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
      fireEvent.click(screen.getByRole("checkbox", { name: /Approve one bounded/ }));
      fireEvent.click(screen.getByRole("button", { name: "Approve qualification" }));
      await act(async () => {});
      const start = screen.getByRole("button", { name: "Run approved qualification" });
      if (phase === "readback") {
        fireEvent.click(start);
        await act(async () => {});
        expect(getDefenderHuntingJob).toHaveBeenCalledOnce();
      }
      if (phase === "timer") {
        await act(() => vi.advanceTimersByTimeAsync(1_001));
        expect(screen.queryByRole("button", { name: "Run approved qualification" })).not.toBeInTheDocument();
      } else {
        vi.setSystemTime(new Date(Date.parse(expiresAt) + 1));
        if (phase === "suspended timer") {
          fireEvent.click(start);
          expect(getDefenderHuntingJob).not.toHaveBeenCalled();
        } else {
          await act(async () => readback.resolve(approved));
          expect(screen.getByRole("alert")).toHaveTextContent("Qualification approval is no longer current");
        }
      }
      expect(startDefenderHuntingQualification).not.toHaveBeenCalled();
    },
  );

  it.each(["timestamps", "freshness", "verification", "qualification"] as const)(
    "preserves the log type and dates across diagnostic %s renewals and inactive source refreshes", async diagnostic => {
    const access = context();
    const view = (active = true, value = access) => <CapabilityContext value={value}>
      <AgentDefenderHuntingView agentRecordId={agentRecordId} agentName="Selected agent" active={active}
        entraAgentIds={[entraAgentId]} entraAgentApplicationIds={[applicationId]} />
    </CapabilityContext>;
    const rendered = render(view());
    await screen.findByText("No hunting history");
    fireEvent.change(screen.getByLabelText("Log type"), { target: { value: "agent_tools" } });
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-09T10:30" } });
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-09-09T11:00" } });
    const renewed = { ...access, views: access.views.map(item => ({ ...item, decision: {
      ...item.decision, checkedAt: "2026-09-09T11:02:00Z", expiresAt: "2026-09-09T11:07:00Z",
      ...(diagnostic === "freshness" ? { fresh: false }
        : diagnostic === "verification" ? { verification: "provider" as const }
          : diagnostic === "qualification" ? { previewQualification: "qualified" as const } : {}),
    } })) };
    rendered.rerender(view(true, renewed));
    expect(screen.getByLabelText("Log type")).toHaveValue("agent_tools");
    expect(getDefenderHuntingCatalog).toHaveBeenCalledOnce();
    rendered.rerender(view(false, renewed));
    expect(screen.queryByLabelText("Log type")).not.toBeInTheDocument();
    rendered.rerender(view(true, renewed));
    await waitFor(() => expect(getDefenderHuntingCatalog).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Log type")).toHaveValue("agent_tools");
    expect(screen.getByLabelText("Start")).toHaveValue("2026-09-09T10:30");
    expect(screen.getByLabelText("End")).toHaveValue("2026-09-09T11:00");
    expect(screen.queryByRole("checkbox", { name: "ExecuteToolBySDK" })).not.toBeInTheDocument();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("keeps an admitted hunt and its selected result across diagnostic verification updates", async () => {
    const pending = deferred<DefenderHuntingJob>();
    const access = context();
    vi.mocked(submitDefenderHunt).mockReturnValueOnce(pending.promise);
    const content = (value = access) => <CapabilityContext value={value}><DefenderHuntingView /></CapabilityContext>;
    const view = render(content());
    await screen.findByText("No hunting history");
    fireEvent.click(screen.getByRole("button", { name: "Run hunt" }));
    await waitFor(() => expect(submitDefenderHunt).toHaveBeenCalledOnce());
    const signal = vi.mocked(submitDefenderHunt).mock.calls[0][2]!.signal!;
    const renewed = { ...access, views: access.views.map(item => ({ ...item,
      decision: { ...item.decision, verification: "provider" as const },
    })) };
    view.rerender(content(renewed));
    expect(signal.aborted).toBe(false);
    expect(getDefenderHuntingCatalog).toHaveBeenCalledOnce();
    expect(getDefenderHuntingJobs).toHaveBeenCalledOnce();
    const result = job();
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [result], count: 1, limit: 20, offset: 0 });
    await act(async () => pending.resolve(result));
    expect(screen.getByRole("region", { name: "Defender agent inventory result" })).toBeVisible();
    view.rerender(content(access));
    expect(screen.getByRole("region", { name: "Defender agent inventory result" })).toBeVisible();
    expect(getDefenderHuntingCatalog).toHaveBeenCalledOnce();
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
    expect(submitDefenderHunt).toHaveBeenCalledOnce();
  });

  it("displays the real capability provider's failed recheck and clears it when retrying", async () => {
    const access = context();
    const held = deferred<Response>();
    let retry = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/capabilities") return retry ? held.promise : Response.json({ value: access.views });
      if (url === "/api/capabilities/check") return Response.json({ code: "request_throttled" }, { status: 429 });
      if (url === "/api/capabilities/check?retry=failed") return Response.json({ value: access.views });
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    function LiveCapabilities() {
      const state = useCapabilities(access.user);
      return <CapabilityContext value={{ ...state, openPermissions: access.openPermissions }}>
        <button type="button" onClick={() => void state.reload()}>Recheck permissions</button>
        <DefenderHuntingView />
      </CapabilityContext>;
    }
    render(<LiveCapabilities />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission checks failed. Use Check status to retry.");
    retry = true;
    fireEvent.click(screen.getByRole("button", { name: "Recheck permissions" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => held.resolve(Response.json({ value: access.views })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
    expect(startDefenderHuntingQualification).not.toHaveBeenCalled();
  });

  it("aborts an in-flight hunt when inactive and ignores its late result on resume", async () => {
    let finish!: (value: DefenderHuntingJob) => void;
    vi.mocked(submitDefenderHunt).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = (active: boolean) => <CapabilityContext value={context()}>
      <AgentDefenderHuntingView agentRecordId={agentRecordId} agentName="Selected agent"
        entraAgentIds={[entraAgentId]} active={active} />
    </CapabilityContext>;
    const rendered = render(view(true));
    await screen.findByText("No hunting history");
    fireEvent.click(screen.getByRole("button", { name: "Run hunt" }));
    await waitFor(() => expect(submitDefenderHunt).toHaveBeenCalledOnce());
    const signal = vi.mocked(submitDefenderHunt).mock.calls[0][2]!.signal!;
    rendered.rerender(view(false));
    expect(signal.aborted).toBe(true);
    rendered.rerender(view(true));
    await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2));
    await act(async () => finish(job()));
    expect(screen.queryByRole("heading", { name: "Defender agent inventory result" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
    expect(submitDefenderHunt).toHaveBeenCalledOnce();
  });

  it("finishes an admitted hunt across passive scope refresh and revalidates before admitting another action", async () => {
    const pending = deferred<DefenderHuntingJob>();
    const latestCatalog = deferred<DefenderHuntingCatalog>();
    const result = job();
    vi.mocked(submitDefenderHunt).mockReturnValueOnce(pending.promise);
    vi.mocked(getDefenderHuntingJob).mockResolvedValue(result);
    const content = (revision: string, contextCurrent = true) => <CapabilityContext value={context()}>
      <AgentDefenderHuntingView agentRecordId={agentRecordId} agentName="Selected agent"
        entraAgentIds={[entraAgentId]} revision={revision} contextCurrent={contextCurrent} />
    </CapabilityContext>;
    const view = render(content("1"));
    await screen.findByText("No hunting history");
    fireEvent.click(screen.getByRole("button", { name: "Run hunt" }));
    await waitFor(() => expect(submitDefenderHunt).toHaveBeenCalledOnce());
    const signal = vi.mocked(submitDefenderHunt).mock.calls[0][2]!.signal!;
    vi.mocked(getDefenderHuntingCatalog).mockReturnValueOnce(latestCatalog.promise);

    view.rerender(content("2", false));
    expect(signal.aborted).toBe(false);
    view.rerender(content("2"));
    view.rerender(content("3", false));
    view.rerender(content("3"));
    expect(signal.aborted).toBe(false);
    expect(getDefenderHuntingCatalog).toHaveBeenCalledOnce();
    expect(getDefenderHuntingJobs).toHaveBeenCalledOnce();
    fireEvent.submit(screen.getByRole("button", { name: "Run hunt" }).closest("form")!);
    expect(submitDefenderHunt).toHaveBeenCalledOnce();

    await act(async () => pending.resolve(result));
    await waitFor(() => expect(getDefenderHuntingCatalog).toHaveBeenCalledTimes(2));
    expect(signal.aborted).toBe(false);
    expect(screen.getByRole("region", { name: "Defender agent inventory result" })).toBeVisible();
    expect(getDefenderHuntingJob).toHaveBeenCalledExactlyOnceWith(result.id, expect.objectContaining({ agentRecordId }));
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revoke saved-data access" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "Run hunt" }).closest("form")!);
    expect(submitDefenderHunt).toHaveBeenCalledOnce();
    await act(async () => latestCatalog.resolve(catalog));
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
    expect(screen.getByRole("region", { name: "Defender agent inventory result" })).toBeVisible();
    expect(submitDefenderHunt).toHaveBeenCalledOnce();
  });

  it.each(["tenant", "principal", "role", "agent", "capability", "typed identity", "application revision"] as const)(
    "still aborts an admitted hunt immediately when its actual %s scope changes", async change => {
      const pending = deferred<DefenderHuntingJob>();
      vi.mocked(submitDefenderHunt).mockReturnValueOnce(pending.promise);
      const content = (changed = false) => {
        const access = context(!changed || change !== "capability",
          changed && change === "role" ? ["AgentControl.Viewer"] : ["AgentControl.Admin"],
          changed && change === "principal" ? "other-principal" : "security-a");
        if (changed && change === "tenant") access.user = { ...access.user!, tenantId: "other-tenant" };
        if (change === "application revision") access.views = access.views.map(view => ({
          ...view, configuration: { enabled: true, sharedDataScope: true, revision: changed ? 2 : 1 },
        }));
        return <CapabilityContext value={access}><AgentDefenderHuntingView
          agentRecordId={changed && change === "agent" ? "other-agent" : agentRecordId} agentName="Selected agent"
          entraAgentIds={[changed && change === "typed identity" ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc" : entraAgentId]} />
        </CapabilityContext>;
      };
      const view = render(content());
      await screen.findByText("No hunting history");
      fireEvent.click(screen.getByRole("button", { name: "Run hunt" }));
      await waitFor(() => expect(submitDefenderHunt).toHaveBeenCalledOnce());
      const signal = vi.mocked(submitDefenderHunt).mock.calls[0][2]!.signal!;
      view.rerender(content(true));
      expect(signal.aborted).toBe(true);
      await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2));
      await act(async () => pending.resolve(job()));
      expect(screen.queryByRole("region", { name: "Defender agent inventory result" })).not.toBeInTheDocument();
      expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
      expect(getDefenderHuntingJob).not.toHaveBeenCalled();
      expect(submitDefenderHunt).toHaveBeenCalledOnce();
    },
  );

  it("defaults to runtime activity when all verified log types are available", async () => {
    render(<CapabilityContext value={context()}>
      <AgentDefenderHuntingView agentRecordId={agentRecordId} agentName="Selected agent"
        entraAgentIds={[entraAgentId]} entraAgentApplicationIds={[applicationId]} templates={{
          agents_inventory: { status: "available" }, agent_activity: { status: "available" }, agent_tools: { status: "available" },
        }} />
    </CapabilityContext>);
    await screen.findByText("No hunting history");
    expect(screen.getByLabelText("Log type")).toHaveValue("agent_activity");
    expect(screen.getByText(/Agent invocations and model inference/)).toBeVisible();
  });

  it("keeps the chosen log type and dates when refreshed template coverage changes without changing identity", async () => {
    const content = (toolsAvailable: boolean) => <CapabilityContext value={context()}>
      <AgentDefenderHuntingView agentRecordId={agentRecordId} agentName="Selected agent"
        entraAgentIds={[entraAgentId]} entraAgentApplicationIds={[applicationId]} templates={{
          agents_inventory: { status: "available" }, agent_activity: { status: "available" },
          agent_tools: toolsAvailable ? { status: "available" } : { status: "unavailable", reason: "Tool identity mapping is no longer verified." },
        }} />
    </CapabilityContext>;
    const view = render(content(true));
    await screen.findByText("No hunting history");
    fireEvent.change(screen.getByLabelText("Log type"), { target: { value: "agent_tools" } });
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-09T10:30" } });
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-09-09T11:00" } });
    const start = screen.getByLabelText("Start");
    start.focus();
    view.rerender(content(false));
    expect(screen.getByLabelText("Log type")).toHaveValue("agent_tools");
    expect(screen.getByLabelText("Start")).toBe(start);
    expect(start).toHaveValue("2026-09-09T10:30");
    expect(start).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("Tool identity mapping is no longer verified.");
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
    await waitFor(() => expect(getDefenderHuntingCatalog).toHaveBeenCalledTimes(2));
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("revalidates selected results when resuming and removes jobs no longer in saved history", async () => {
    const history = { value: [job()], count: 1, limit: 20, offset: 0 };
    let finish!: (value: typeof history) => void;
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce(history)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(getDefenderHuntingRows).mockResolvedValue(inventoryPage(job(), "Private selected agent"));
    const view = (active: boolean) => <CapabilityContext value={context()}>
      <AgentDefenderHuntingView agentRecordId={agentRecordId} agentName="Selected agent"
        entraAgentIds={[entraAgentId]} active={active} />
    </CapabilityContext>;
    const rendered = render(view(true));
    fireEvent.click(await screen.findByRole("button", { name: /View hunt 11111111/ }));
    expect(await screen.findByText("Private selected agent")).toBeVisible();
    rendered.rerender(view(false));
    rendered.rerender(view(true));
    await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Private selected agent")).not.toBeInTheDocument();
    await act(async () => finish({ value: [], count: 0, limit: 20, offset: 0 }));
    expect(screen.getByText("No hunting history")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Defender agent inventory result" })).not.toBeInTheDocument();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("keeps selected rows, page, metadata filters, focus and scroll across repeated refresh without authorizing stale actions", async () => {
    const original = job({ storedRowCount: 201 });
    const history = { value: [original], count: 1, offset: 0, limit: 20 };
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue(history);
    vi.mocked(getDefenderHuntingRows).mockImplementation(async (_id, _limit, offset = 0) => ({
      ...inventoryPage(original, `Retained page ${offset}`), offset, count: 201,
    }));
    const content = (revision: string, contextCurrent = true) => <CapabilityContext value={context()}>
      <AgentDefenderHuntingView agentRecordId={agentRecordId} agentName="Selected agent"
        entraAgentIds={[entraAgentId]} revision={revision} contextCurrent={contextCurrent} />
    </CapabilityContext>;
    const view = render(content("1"));
    await screen.findByRole("button", { name: /View hunt 11111111/ });
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-09T10:30" } });
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-09-09T11:00" } });
    fireEvent.click(screen.getByRole("button", { name: /View hunt 11111111/ }));
    await screen.findByText("Retained page 0");
    fireEvent.click(within(screen.getByRole("region", { name: "Defender agent inventory result" })).getByRole("button", { name: "Next" }));
    await screen.findByText("Retained page 100");
    const filter = screen.getByLabelText("Filter loaded metadata");
    fireEvent.change(filter, { target: { value: "Retained" } });
    filter.focus();
    const results = screen.getByRole("region", { name: "Defender agent inventory result" });
    const table = screen.getByRole("region", { name: "Minimized hunting rows" });
    table.scrollTop = 137;
    const staleHistory = deferred<typeof history>();
    const currentHistory = deferred<typeof history>();
    const staleCatalog = deferred<DefenderHuntingCatalog>();
    const currentCatalog = deferred<DefenderHuntingCatalog>();
    const currentRows = deferred<DefenderHuntingRowPage>();
    vi.mocked(getDefenderHuntingJobs).mockReturnValueOnce(staleHistory.promise).mockReturnValueOnce(currentHistory.promise);
    vi.mocked(getDefenderHuntingCatalog).mockReturnValueOnce(staleCatalog.promise).mockReturnValueOnce(currentCatalog.promise);
    vi.mocked(getDefenderHuntingRows).mockReturnValueOnce(currentRows.promise);

    view.rerender(content("2", false));
    expect(screen.getByRole("region", { name: "Defender agent inventory result" })).toBe(results);
    expect(screen.getByText("Retained page 100")).toBeVisible();
    expect(filter).toHaveFocus();
    expect(table.scrollTop).toBe(137);
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revoke saved-data access" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Delete hunt 11111111/ })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "Run hunt" }).closest("form")!);
    expect(submitDefenderHunt).not.toHaveBeenCalled();
    view.rerender(content("2"));
    await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2));
    const staleSignal = vi.mocked(getDefenderHuntingJobs).mock.calls.at(-1)![2]!.signal!;
    expect(screen.getByText("Retained page 100")).toBeVisible();
    view.rerender(content("3", false));
    expect(staleSignal.aborted).toBe(true);
    view.rerender(content("3"));
    await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("region", { name: "Minimized hunting rows" })).toBe(table);
    expect(filter).toHaveFocus();
    expect(filter).toHaveValue("Retained");
    const latest = { ...original, updatedAt: "2026-09-09T11:03:00.000Z", snapshotId: "66666666-6666-4666-8666-666666666666" };
    await act(async () => {
      currentCatalog.resolve(catalog);
      currentHistory.resolve({ ...history, value: [latest] });
    });
    await waitFor(() => expect(getDefenderHuntingRows).toHaveBeenCalledTimes(3));
    expect(getDefenderHuntingRows).toHaveBeenLastCalledWith(original.id, 100, 100, expect.objectContaining({ agentRecordId }));
    expect(screen.getByText("Retained page 100")).toBeVisible();
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
    expect(filter).toHaveFocus();
    await act(async () => currentRows.resolve({ ...inventoryPage(latest, "Retained updated result"), count: 201, offset: 100 }));
    expect(screen.getByText("Retained updated result")).toBeVisible();
    expect(screen.getByRole("region", { name: "Defender agent inventory result" })).toBe(results);
    expect(screen.getByRole("region", { name: "Minimized hunting rows" })).toBe(table);
    expect(screen.getByLabelText("Start")).toHaveValue("2026-09-09T10:30");
    expect(screen.getByLabelText("Filter loaded metadata")).toBe(filter);
    expect(filter).toHaveValue("Retained");
    expect(filter).toHaveFocus();
    expect(table.scrollTop).toBe(137);
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
    await act(async () => {
      staleCatalog.resolve(catalog);
      staleHistory.resolve({ ...history, value: [] });
    });
    expect(screen.getByText("Retained updated result")).toBeVisible();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
    expect(approveDefenderHuntingQualification).not.toHaveBeenCalled();
    expect(startDefenderHuntingQualification).not.toHaveBeenCalled();
    expect(revokeDefenderHuntingRetainedScope).not.toHaveBeenCalled();
    expect(deleteDefenderHunt).not.toHaveBeenCalled();
  });

  it("finishes background saved reads after draft date edits without restoring a cleared job selection", async () => {
    const history = { value: [job()], count: 1, limit: 20, offset: 0 };
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce(history);
    vi.mocked(getDefenderHuntingRows).mockResolvedValue(inventoryPage(job(), "Previous selected result"));
    const content = (revision: string) => <CapabilityContext value={context()}>
      <AgentDefenderHuntingView agentRecordId={agentRecordId} agentName="Selected agent" entraAgentIds={[entraAgentId]} revision={revision} />
    </CapabilityContext>;
    const view = render(content("1"));
    fireEvent.click(await screen.findByRole("button", { name: /View hunt 11111111/ }));
    await screen.findByText("Previous selected result");
    const pending = deferred<typeof history>();
    vi.mocked(getDefenderHuntingJobs).mockReturnValueOnce(pending.promise);
    view.rerender(content("2"));
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-09T10:30" } });
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-09-09T11:00" } });
    await act(async () => pending.resolve(history));
    expect(screen.getByLabelText("Start")).toHaveValue("2026-09-09T10:30");
    expect(screen.queryByText("Previous selected result")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading hunting history...")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
    expect(getDefenderHuntingRows).toHaveBeenCalledOnce();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it.each(["history denial", "row failure", "mismatched rows", "removed job"] as const)(
    "does not retain selected presentation after a background %s", async failure => {
      const history = { value: [job()], count: 1, limit: 20, offset: 0 };
      vi.mocked(getDefenderHuntingJobs).mockResolvedValue(history);
      vi.mocked(getDefenderHuntingRows).mockResolvedValue(inventoryPage(job(), "Selected private result"));
      const content = (revision: string) => <CapabilityContext value={context()}>
        <AgentDefenderHuntingView agentRecordId={agentRecordId} agentName="Selected agent" entraAgentIds={[entraAgentId]} revision={revision} />
      </CapabilityContext>;
      const view = render(content("1"));
      fireEvent.click(await screen.findByRole("button", { name: /View hunt 11111111/ }));
      await screen.findByText("Selected private result");
      if (failure === "history denial") vi.mocked(getDefenderHuntingJobs).mockRejectedValueOnce(new ApiError(403, "forbidden", "Saved hunting access denied"));
      else if (failure === "row failure") vi.mocked(getDefenderHuntingRows).mockRejectedValueOnce(new Error("Saved selected rows failed"));
      else if (failure === "mismatched rows") vi.mocked(getDefenderHuntingRows).mockResolvedValueOnce(inventoryPage(job({ id: "other-job" }), "Other private result"));
      else vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ ...history, value: [], count: 0 });
      view.rerender(content("2"));
      expect(screen.getByText("Selected private result")).toBeVisible();
      if (failure === "removed job") expect(await screen.findByText("No hunting history")).toBeVisible();
      else expect(await screen.findByRole("alert")).toHaveTextContent(failure === "history denial" ? "Saved hunting access denied"
        : failure === "row failure" ? "Saved selected rows failed" : "Saved hunting rows do not match the selected job");
      expect(screen.queryByText("Selected private result")).not.toBeInTheDocument();
      expect(screen.queryByText("Other private result")).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Defender agent inventory result" })).not.toBeInTheDocument();
      expect(submitDefenderHunt).not.toHaveBeenCalled();
    },
  );

  it("starts with the supported runtime template and never substitutes an opaque object identity", async () => {
    vi.mocked(submitDefenderHunt).mockResolvedValue(job());
    render(<CapabilityContext value={context()}><AgentDefenderHuntingView agentRecordId={agentRecordId} agentName="Legacy agent"
      entraAgentIds={[]} entraAgentApplicationIds={[applicationId]} templates={{
        agents_inventory: { status: "unavailable", reason: "No verified enterprise-application object ID." },
        agent_activity: { status: "available" }, agent_tools: { status: "available" },
      }} /></CapabilityContext>);
    await screen.findByText("No hunting history");
    expect(screen.getByLabelText("Log type")).toHaveValue("agent_activity");
    fireEvent.click(screen.getByRole("button", { name: "Run hunt" }));
    await waitFor(() => expect(submitDefenderHunt).toHaveBeenCalledOnce());
    expect(vi.mocked(submitDefenderHunt).mock.calls[0][1]).toMatchObject({ templateId: "agent_activity", entraAgentApplicationIds: [applicationId], agentIds: [] });
    expect(vi.mocked(submitDefenderHunt).mock.calls[0][1]).not.toHaveProperty("entraAgentIds");
    expect(screen.queryByRole("option", { name: "Defender agent inventory" })).not.toBeInTheDocument();
    expect(submitDefenderHunt).toHaveBeenCalledOnce();
  });

  it("loads only catalog and saved history and explains the selected log type without portal links or disclosures", async () => {
    renderView();
    expect(await screen.findByRole("heading", { name: "Search Defender logs" })).toBeVisible();
    expect(screen.getByLabelText("Log type")).toHaveValue("agents_inventory");
    expect(screen.getByText(/This is an inventory snapshot, not a log of conversations/)).toBeVisible();
    expect(screen.queryByText("Not independently proven")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Microsoft Defender hunting" }).querySelector("details")).toBeNull();
    expect(screen.getByText("Run a hunt to collect results for this selection.")).toBeVisible();
    expect(screen.queryByText("Selected agent", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/Opening this view does not run a provider query|Delegated results remain principal-private|authorization permits an explicit bounded hunt/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Tenant Defender portal" })).not.toBeInTheDocument();
    expect(getDefenderHuntingCatalog).toHaveBeenCalledOnce();
    expect(getDefenderHuntingCatalog).toHaveBeenCalledWith(expect.objectContaining({ agentRecordId }));
    expect(getDefenderHuntingJobs).toHaveBeenCalledExactlyOnceWith(
      20,
      0,
      expect.objectContaining({ signal: expect.any(AbortSignal), agentRecordId }),
    );
    expect(submitDefenderHunt).not.toHaveBeenCalled();
    expect(approveDefenderHuntingQualification).not.toHaveBeenCalled();
    expect(startDefenderHuntingQualification).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Agent IDs")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Blueprint IDs")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/agents");
    expect(new URLSearchParams(window.location.search).get("detail")).toBe("agent-a");
  });

  it("discards another agent's pending history and keeps the Agents URL untouched", async () => {
    let finish!: (value: Awaited<ReturnType<typeof getDefenderHuntingJobs>>) => void;
    let signal!: AbortSignal;
    vi.mocked(getDefenderHuntingJobs).mockImplementationOnce((_limit, _offset, options) => {
      signal = options!.signal!;
      return new Promise(resolve => { finish = resolve; });
    }).mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 });
    const view = render(<CapabilityContext value={context()}><AgentDefenderHuntingView agentRecordId={agentRecordId} agentName="Agent A" entraAgentIds={[entraAgentId]} /></CapabilityContext>);
    view.rerender(<CapabilityContext value={context()}><AgentDefenderHuntingView agentRecordId="agent-b" agentName="Agent B" entraAgentIds={["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]} /></CapabilityContext>);
    await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2));
    expect(signal.aborted).toBe(true);
    expect(getDefenderHuntingJobs).toHaveBeenLastCalledWith(20, 0, expect.objectContaining({ agentRecordId: "agent-b" }));
    await act(async () => finish({ value: [job()], count: 1, limit: 20, offset: 0 }));
    expect(screen.queryByRole("button", { name: /View hunt/ })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/agents");
  });

  it("filters loaded metadata without issuing another provider query or hiding the page boundary", async () => {
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [job()], count: 1, limit: 20, offset: 0 });
    const page = inventoryPage(job(), "Selected agent");
    vi.mocked(getDefenderHuntingRows).mockResolvedValue(page);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /View hunt/ }));
    const filter = await screen.findByLabelText("Filter loaded metadata");
    fireEvent.change(filter, { target: { value: "not-in-these-results" } });
    expect(screen.getByText("No loaded rows match these filters.")).toBeVisible();
    expect(screen.getByText(/rows on this page. CSV includes all saved rows/)).toBeVisible();
    fireEvent.change(filter, { target: { value: "selected" } });
    expect(screen.getByRole("region", { name: "Minimized hunting rows" })).toHaveTextContent("Selected agent");
    expect(getDefenderHuntingRows).toHaveBeenCalledExactlyOnceWith(job().id, 100, 0, expect.objectContaining({ agentRecordId }));
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("aborts an old principal's history read and never renders its late rows", async () => {
    let resolveStaleHistory!: (value: Awaited<ReturnType<typeof getDefenderHuntingJobs>>) => void;
    let staleSignal!: AbortSignal;
    vi.mocked(getDefenderHuntingJobs)
      .mockImplementationOnce((_limit, _offset, options) => {
        staleSignal = options!.signal!;
        return new Promise(resolve => { resolveStaleHistory = resolve; });
      })
      .mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 });
    const view = render(
      <CapabilityContext value={context()}><DefenderHuntingView /></CapabilityContext>,
    );
    await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenCalledOnce());

    view.rerender(
      <CapabilityContext value={context(true, undefined, "security-b")}><DefenderHuntingView /></CapabilityContext>,
    );

    await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2));
    expect(staleSignal.aborted).toBe(true);
    await act(async () => resolveStaleHistory({
      value: [job()],
      count: 1,
      limit: 20,
      offset: 0,
    }));
    expect(screen.queryByRole("button", { name: /View hunt 11111111/ })).not.toBeInTheDocument();
  });

  it("submits an explicit fixed template with typed filters and no KQL or workspace field", async () => {
    vi.mocked(submitDefenderHunt).mockResolvedValue(job());
    renderView();
    await waitFor(() => expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run hunt" }));
    await waitFor(() => expect(submitDefenderHunt).toHaveBeenCalledOnce());
    expect(submitDefenderHunt).toHaveBeenCalledWith("delegated", expect.objectContaining({ templateId: "agents_inventory", operations: [], agentIds: [], blueprintIds: [], actorObjectIds: [] }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await screen.findByRole("heading", { name: "Defender agent inventory result" })).toBeVisible();
    const submitted = vi.mocked(submitDefenderHunt).mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(submitted).not.toHaveProperty("Query");
    expect(submitted).not.toHaveProperty("workspaceId");
  });

  it.each(["current", "expired", "revoked", "different-target"])(
    "uses exact application qualification without delegated readiness (%s)",
    async evidence => {
      const approvedScope = {
        ...catalog.qualifications[0].approvedScope,
        entraAgentIds: [evidence === "different-target" ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : entraAgentId],
      };
      vi.mocked(getDefenderHuntingCatalog).mockResolvedValue({
        ...catalog,
        qualifications: [{
          ...catalog.qualifications[0],
          capabilityId: "defender.hunting.application",
          approvedScope,
          expiresAt: evidence === "expired" ? "2026-09-09T11:01:00.000Z" : "2026-09-09T12:00:00.000Z",
        }],
        retainedScopes: [{
          ...catalog.retainedScopes[0],
          tokenMode: "application",
          capabilityId: "defender.hunting.application",
          resultScope: { kind: "application", scopeId: "application-a", configurationRevision: 1 },
          approvedScope,
          revokedAt: evidence === "revoked" ? "2026-09-09T11:01:00.000Z" : null,
        }],
      });
      vi.mocked(submitDefenderHunt).mockResolvedValue(job({ tokenMode: "application" }));
      render(<CapabilityContext value={{
        user: {
          homeAccountId: "security-a", tenantId: "tenant-a", displayName: "Security",
          username: "security@example.invalid", roles: ["AgentControl.Admin"],
        },
        loading: false, pending: false, error: undefined, now: Date.parse("2026-09-09T11:02:00.000Z"),
        reload: vi.fn(async () => undefined), openPermissions: vi.fn(),
        views: context(false).views.map(view => ({ ...view, enabled: true, configuration: { enabled: true, sharedDataScope: true, revision: 1 } })),
      }}><DefenderHuntingView /></CapabilityContext>);

      await screen.findByText("No hunting history");
      const authorization = screen.getByLabelText("Authorization");
      expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
      fireEvent.change(authorization, { target: { value: "application" } });
      const search = screen.getByRole("button", { name: "Run hunt" });
      expect(search).toHaveProperty("disabled", evidence !== "current");
      expect(submitDefenderHunt).not.toHaveBeenCalled();
      fireEvent.click(search);

      if (evidence === "current") {
        await waitFor(() => expect(submitDefenderHunt).toHaveBeenCalledExactlyOnceWith(
          "application", expect.objectContaining({ templateId: "agents_inventory", entraAgentIds: [entraAgentId], agentIds: [] }),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ));
      } else {
        expect(submitDefenderHunt).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps explicit application qualification approval and run separate", async () => {
    const approved = job({ status: "waiting_authorization", complete: false, noData: false, snapshotId: null, canResume: true, qualification: {
      capabilityId: "defender.hunting.application", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: "security-a" } });
    vi.mocked(approveDefenderHuntingQualification).mockResolvedValue(approved);
    vi.mocked(getDefenderHuntingJob).mockResolvedValue(approved);
    vi.mocked(startDefenderHuntingQualification).mockResolvedValue({ ...approved, status: "running" });
    renderView(false, ["AgentControl.Admin"]);
    await screen.findByText("Delegated authorization is not ready");
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    await screen.findByText("Shared application hunting is not qualified");
    const approve = screen.getByRole("button", { name: /Approve qualification/ });
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Approve one bounded/ }));
    expect(approve).toBeEnabled();
    expect(screen.queryByLabelText("Agent IDs")).not.toBeInTheDocument();
    fireEvent.click(approve);
    await waitFor(() => expect(approveDefenderHuntingQualification).toHaveBeenCalledOnce());
    expect(startDefenderHuntingQualification).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: /Run approved qualification/ }));
    await waitFor(() => expect(startDefenderHuntingQualification).toHaveBeenCalledExactlyOnceWith(approved.id, expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it("renders no_data without diagnosing permission, connector, license or coverage", async () => {
    const empty = job({ storedRowCount: 0, providerRowCount: 0, noData: true, observedRange: null });
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [empty], count: 1, limit: 20, offset: 0 });
    vi.mocked(getDefenderHuntingRows).mockResolvedValue({ value: [], count: 0, limit: 100, offset: 0, job: empty, snapshot: {
      id: empty.snapshotId!, jobId: empty.id, resultScope: empty.resultScope, filters: empty.filters, sourceTable: "AgentsInfo", queryVersion: 3,
      requestedRange: { startDateTime: empty.filters.startDateTime, endDateTime: empty.filters.endDateTime }, observedRange: null, unobservedRange: null,
      observationTime: empty.finishedAt!, complete: true, noData: true, partialReason: null, providerRowCount: 0, storedRowCount: 0, byteCount: 2, expiresAt: empty.expiresAt } });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /View hunt/ }));
    expect(await screen.findByText("No data returned")).toBeVisible();
    expect(screen.getByText("No rows matched this hunt. Try another time range or check log setup in Permissions.")).toBeVisible();
    expect(screen.queryByText(/does not prove complete tenant coverage/)).not.toBeInTheDocument();
  });

  it("shows partial coverage, preview nulls, exact association and absent activity content honestly", async () => {
    const partial = job({ status: "partial", complete: false, partialReason: "hunting_row_limit", providerRowCount: 201,
      unobservedRange: { startDateTime: "2026-09-09T10:00:00.000Z", endDateTime: "2026-09-09T11:00:00.000Z" } });
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [partial], count: 1, limit: 20, offset: 0 });
    const page: DefenderHuntingRowPage = { value: [{ projectionVersion: 3, sourceTable: "AgentsInfo", observationTime: "2026-09-09T10:30:00.000Z", agentId: "agent-a",
      agentName: null, platform: "CopilotStudio", agentDescription: null, version: null, sourceAgentId: null, entraAgentObjectId: "11111111-1111-4111-8111-111111111111",
      entraBlueprintId: "22222222-2222-4222-8222-222222222222", observabilityId: null, publishedStatus: null, lifecycleStatus: null, availability: null,
      createdDateTime: null, lastPublishedDateTime: null, lastUpdatedDateTime: null, instanceCount: null, model: null, ownerCount: null, sharedWithCount: null,
      permissionMetadataKeyCount: null, authenticationMetadataKeyCount: null, detailStates: { owners: "not_supplied", sharing: "not_supplied", permissions: "not_exposed", authentication: "not_exposed", risk: "not_exposed" },
      association: { status: "resolved", sourceSystem: "power_platform", nativeId: "power-a",
        resourceType: "microsoft.copilotstudio/agents", environmentId: "environment-a", matchedKind: "entra_agent_id" } }], count: 1, limit: 100, offset: 0,
      job: partial, snapshot: { id: partial.snapshotId!, jobId: partial.id, resultScope: partial.resultScope, filters: partial.filters, sourceTable: "AgentsInfo", queryVersion: 3,
        requestedRange: { startDateTime: partial.filters.startDateTime, endDateTime: partial.filters.endDateTime }, observedRange: partial.observedRange,
        unobservedRange: partial.unobservedRange, observationTime: partial.finishedAt!, complete: false, noData: false, partialReason: "hunting_row_limit",
        providerRowCount: 201, storedRowCount: 1, byteCount: 512, expiresAt: partial.expiresAt } };
    vi.mocked(getDefenderHuntingRows).mockResolvedValue(page);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /View hunt/ }));
    expect(await screen.findByText(/200-row local cap was reached/)).toBeVisible();
    expect(screen.getAllByText("Not supplied").length).toBeGreaterThan(0);
    expect(screen.getByText("Exact entra_agent_id")).toBeVisible();
  });

  it("removes delegated qualification ritual while retaining own-scope revoke and Admin-only application setup", async () => {
    renderView(false, ["AgentControl.Viewer"]);
    await screen.findByText("Delegated authorization is not ready");
    expect(screen.queryByRole("button", { name: /Approve qualification/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Revoke saved-data access/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    expect(screen.queryByRole("button", { name: /Approve qualification/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Revoke saved-data access/ })).not.toBeInTheDocument();
  });

  it("revokes the exact retained scope and refreshes saved visibility", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(revokeDefenderHuntingRetainedScope).mockResolvedValue({ ...catalog.retainedScopes[0], revokedAt: "2026-09-09T11:03:00.000Z" });
    vi.mocked(getDefenderHuntingCatalog).mockResolvedValueOnce(catalog).mockResolvedValueOnce({ ...catalog, qualifications: [], retainedScopes: [] });
    try {
      renderView();
      expect(await screen.findByText("Exact saved-data scope approved")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: /Revoke saved-data access/ }));
      await waitFor(() => expect(revokeDefenderHuntingRetainedScope).toHaveBeenCalledExactlyOnceWith(catalog.retainedScopes[0].id, expect.objectContaining({ signal: expect.any(AbortSignal) })));
      await waitFor(() => expect(getDefenderHuntingCatalog).toHaveBeenCalledTimes(2));
      expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
    } finally {
      confirm.mockRestore();
    }
  });

  it("does not let sibling evidence authorize another application template", async () => {
    vi.mocked(getDefenderHuntingCatalog).mockResolvedValue({ ...catalog, qualifications: [{ ...catalog.qualifications[0], templateId: "agent_activity",
      approvedScope: { templateId: "agent_activity", agentIds: [], blueprintIds: [], actorObjectIds: [], operations: ["InferenceCall", "InvokeAgent"] } }] });
    renderView();
    fireEvent.change(await screen.findByLabelText("Authorization"), { target: { value: "application" } });
    expect(await screen.findByText("Shared application hunting is not qualified")).toBeVisible();
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("invalidates pending approval and search responses when exact filters change", async () => {
    let resolveApproval!: (value: DefenderHuntingJob) => void;
    vi.mocked(approveDefenderHuntingQualification).mockReturnValue(new Promise(resolve => { resolveApproval = resolve; }));
    const approvalView = renderView(false);
    await screen.findByText("Delegated authorization is not ready");
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    await screen.findByText("Shared application hunting is not qualified");
    fireEvent.click(screen.getByRole("checkbox", { name: /Approve one bounded/ }));
    fireEvent.click(screen.getByRole("button", { name: /Approve qualification/ }));
    await waitFor(() => expect(approveDefenderHuntingQualification).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Log type"), { target: { value: "agent_activity" } });
    await act(async () => resolveApproval(job({ status: "waiting_authorization", snapshotId: null, canResume: true })));
    expect(screen.queryByRole("button", { name: /Run approved qualification/ })).not.toBeInTheDocument();
    approvalView.unmount();

    let resolveSearch!: (value: DefenderHuntingJob) => void;
    vi.mocked(getDefenderHuntingCatalog).mockResolvedValue(catalog);
    vi.mocked(submitDefenderHunt).mockReturnValue(new Promise(resolve => { resolveSearch = resolve; }));
    renderView();
    await waitFor(() => expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run hunt" }));
    await waitFor(() => expect(submitDefenderHunt).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Log type"), { target: { value: "agent_tools" } });
    await act(async () => resolveSearch(job()));
    expect(screen.queryByRole("heading", { name: /Defender agent inventory result/ })).not.toBeInTheDocument();
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
  });

  it("clears prior rows on selection and omits internal query-scope diagnostics", async () => {
    const first = job({ resultScope: { kind: "principal", scopeId: "principal-scope-with-a-full-untruncated-identifier", configurationRevision: null } });
    const second = job({ id: "22222222-2222-4222-8222-222222222222", localRequestId: "44444444-4444-4444-8444-444444444444" });
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [first, second], count: 2, limit: 20, offset: 0 });
    let resolveSecond!: (value: DefenderHuntingRowPage) => void;
    vi.mocked(getDefenderHuntingRows).mockResolvedValueOnce(inventoryPage(first, "First selected agent"))
      .mockReturnValueOnce(new Promise(resolve => { resolveSecond = resolve; }));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "View hunt 11111111..." }));
    expect(await screen.findByText("First selected agent")).toBeVisible();
    expect(screen.queryByText(/principal-scope-with-a-full-untruncated-identifier/)).not.toBeInTheDocument();
    expect(screen.queryByText(first.localRequestId)).not.toBeInTheDocument();
    expect(screen.queryByText("provider-a")).not.toBeInTheDocument();
    expect(screen.queryByText("Query details")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View hunt 22222222..." }));
    expect(screen.queryByText("First selected agent")).not.toBeInTheDocument();
    await act(async () => resolveSecond(inventoryPage(second, "Second selected agent")));
    expect(await screen.findByText("Second selected agent")).toBeVisible();
  });

  it("pages hunting history explicitly without running a provider query", async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => job({ id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
    const last = job({ id: "20000000-0000-4000-8000-000000000020" });
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ value: firstPage, count: 21, limit: 20, offset: 0 })
      .mockResolvedValueOnce({ value: [last], count: 21, limit: 20, offset: 20 });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenLastCalledWith(
      20,
      20,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(await screen.findByText("21-21 of 21")).toBeVisible();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("fails closed when refreshed hunting history is no longer authorized", async () => {
    vi.mocked(getDefenderHuntingJobs)
      .mockResolvedValueOnce({ value: [job()], count: 1, limit: 20, offset: 0 })
      .mockRejectedValueOnce(new ApiError(403, "forbidden", "Saved hunting access denied"));
    renderView();
    expect(await screen.findByRole("button", { name: /View hunt 11111111/ })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Refresh hunting history" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Saved hunting access denied");
    expect(screen.queryByRole("button", { name: /View hunt 11111111/ })).not.toBeInTheDocument();
    expect(screen.getByText("Hunting history unavailable")).toBeVisible();
  });

  it.each([403, 503])("keeps explicit history recovery after a selected result fails with %s", async status => {
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [job()], count: 1, limit: 20, offset: 0 });
    vi.mocked(getDefenderHuntingRows).mockRejectedValue(new ApiError(status, "saved_read_failed", "Saved result unavailable"));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /View hunt 11111111/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved result unavailable");
    expect(screen.queryByRole("button", { name: /View hunt 11111111/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Return to hunting history" }));
    expect(await screen.findByRole("button", { name: /View hunt 11111111/ })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Defender agent inventory result" })).not.toBeInTheDocument();
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
    expect(getDefenderHuntingJob).not.toHaveBeenCalled();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("does not restore history when another concurrent saved read denies access", async () => {
    const history = { value: [job()], count: 1, limit: 20, offset: 0 };
    let finish!: (value: typeof history) => void;
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce(history)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(getDefenderHuntingCatalog).mockResolvedValueOnce(catalog)
      .mockRejectedValueOnce(new ApiError(403, "forbidden", "Catalog access denied"));
    renderView();
    await screen.findByRole("button", { name: /View hunt 11111111/ });
    fireEvent.click(screen.getByRole("button", { name: "Refresh hunting history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Catalog access denied");
    await act(async () => finish(history));
    expect(screen.queryByRole("button", { name: /View hunt 11111111/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh hunting history" })).toBeEnabled();
  });

  it("clears selected private rows when their exact filters change or saved history removes the job", async () => {
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ value: [job()], count: 1, limit: 20, offset: 0 })
      .mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
    vi.mocked(getDefenderHuntingRows).mockResolvedValue(inventoryPage(job(), "Private selected agent"));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /View hunt 11111111/ }));
    expect(await screen.findByText("Private selected agent")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh hunting history" }));
    await waitFor(() => expect(screen.queryByText("Private selected agent")).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Defender agent inventory result" })).not.toBeInTheDocument();
  });

  it("invalidates a pending selected row response when filters change", async () => {
    let finish!: (value: DefenderHuntingRowPage) => void;
    let signal!: AbortSignal;
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [job()], count: 1, limit: 20, offset: 0 });
    vi.mocked(getDefenderHuntingRows).mockImplementationOnce((_id, _limit, _offset, options) => {
      signal = options!.signal!;
      return new Promise(resolve => { finish = resolve; });
    });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /View hunt 11111111/ }));
    expect(screen.getByText("Loading minimized rows...")).toHaveAttribute("role", "status");
    fireEvent.change(screen.getByLabelText("Log type"), { target: { value: "agent_activity" } });
    expect(signal.aborted).toBe(true);
    expect(screen.queryByText("Loading minimized rows...")).not.toBeInTheDocument();
    await act(async () => finish(inventoryPage(job(), "Obsolete filtered agent")));
    expect(screen.queryByRole("heading", { name: "Defender agent inventory result" })).not.toBeInTheDocument();
    expect(screen.queryByText("Obsolete filtered agent")).not.toBeInTheDocument();
  });

  it("retains history and other owners' shared reads after provider, rather than session, admission fails", async () => {
    const client = createSavedQueryClient();
    const outside = new AbortController();
    let finish!: (value: string) => void;
    let sharedSignal!: AbortSignal;
    const shared = readSavedQuery(client, ["other-saved-source"], signal => {
      sharedSignal = signal;
      return new Promise<string>(resolve => { finish = resolve; });
    }, outside.signal);
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [job()], count: 1, limit: 20, offset: 0 });
    vi.mocked(submitDefenderHunt).mockRejectedValue(new ApiError(403, "capability_unavailable", "Provider consent required"));
    const view = render(<SavedQueryProvider client={client}>
      <CapabilityContext value={context()}><DefenderHuntingView /></CapabilityContext>
    </SavedQueryProvider>);
    try {
      await screen.findByRole("button", { name: /View hunt 11111111/ });
      fireEvent.click(screen.getByRole("button", { name: "Run hunt" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Provider consent required");
      expect(screen.getByRole("button", { name: /View hunt 11111111/ })).toBeEnabled();
      expect(sharedSignal.aborted).toBe(false);
      await act(async () => {
        finish("unrelated saved evidence");
        await expect(shared).resolves.toBe("unrelated saved evidence");
      });
    } finally {
      const settled = shared.catch(() => undefined);
      outside.abort();
      view.unmount();
      client.clear();
      await settled;
    }
  });

  it("does not submit through the form when provider admission is unavailable", async () => {
    renderView(false);
    await screen.findByText("No hunting history");
    fireEvent.submit(screen.getByRole("button", { name: "Run hunt" }).closest("form")!);
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("stops polling after failure and only restarts its budget after explicit refresh", async () => {
    vi.useFakeTimers();
    const running = job({ status: "running", finishedAt: null });
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ value: [running], count: 1, limit: 20, offset: 0 })
      .mockRejectedValueOnce(new Error("Polling unavailable"))
      .mockResolvedValue({ value: [running], count: 1, limit: 20, offset: 0 });
    renderView();
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(screen.getByRole("alert")).toHaveTextContent("Polling unavailable");
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Refresh hunting history" }));
    await act(async () => {});
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(4);
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("isolates saved rows and pending approval when current roles change", async () => {
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ value: [job()], count: 1, limit: 20, offset: 0 })
      .mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
    const view = render(<CapabilityContext value={context()}><DefenderHuntingView /></CapabilityContext>);
    await screen.findByRole("button", { name: /View hunt 11111111/ });
    view.rerender(<CapabilityContext value={context(true, ["AgentControl.Viewer"])}><DefenderHuntingView /></CapabilityContext>);
    await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: /View hunt 11111111/ })).not.toBeInTheDocument();
  });

  it("loads saved evidence under real StrictMode without provider side effects", async () => {
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [job()], count: 1, limit: 20, offset: 0 });
    render(<CapabilityContext value={context()}><DefenderHuntingView /></CapabilityContext>, true);
    expect(await screen.findByRole("button", { name: /View hunt 11111111/ })).toBeVisible();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
    expect(startDefenderHuntingQualification).not.toHaveBeenCalled();
  });

  it.each(["", "not-a-date"])("rejects malformed authoritative approval expiry before provider start (%j)", async expiresAt => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T11:02:00.000Z"));
    const approved = job({ status: "waiting_authorization", snapshotId: null, canResume: true, qualification: {
      capabilityId: "defender.hunting.application", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: "security-a",
    } });
    vi.mocked(approveDefenderHuntingQualification).mockResolvedValue(approved);
    vi.mocked(getDefenderHuntingJob).mockResolvedValue({ ...approved, expiresAt });
    vi.mocked(startDefenderHuntingQualification).mockResolvedValue({ ...approved, status: "running" });
    renderView(false);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Approve one bounded/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve qualification" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Run approved qualification" }));
    await act(async () => {});
    expect(startDefenderHuntingQualification).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Qualification approval is no longer current");
  });

  it("revalidates an approved qualification before starting provider work", async () => {
    const approved = job({ status: "waiting_authorization", snapshotId: null, canResume: true, qualification: {
      capabilityId: "defender.hunting.application", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: "security-a",
    } });
    vi.mocked(approveDefenderHuntingQualification).mockResolvedValue(approved);
    vi.mocked(getDefenderHuntingJob).mockResolvedValue({ ...approved, canResume: false });
    renderView(false);
    await screen.findByText("No hunting history");
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Approve one bounded/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve qualification" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run approved qualification" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Qualification approval is no longer current");
    expect(startDefenderHuntingQualification).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Run approved qualification" })).not.toBeInTheDocument();
  });

  it("requires application mode to remain enabled even when exact catalog evidence is current", async () => {
    const approvedScope = { ...catalog.qualifications[0].approvedScope, entraAgentIds: [entraAgentId] };
    vi.mocked(getDefenderHuntingCatalog).mockResolvedValue({
      ...catalog,
      qualifications: [{ ...catalog.qualifications[0], capabilityId: "defender.hunting.application", approvedScope }],
      retainedScopes: [{ ...catalog.retainedScopes[0], tokenMode: "application", capabilityId: "defender.hunting.application", approvedScope,
        resultScope: { kind: "application", scopeId: "application-a", configurationRevision: 1 } }],
    });
    const value = context();
    value.views = value.views.map(view => view.definition.mode === "application" ? {
      ...view, enabled: false, configuration: { enabled: false, sharedDataScope: false, revision: 1 },
    } : view);
    const initial = context();
    const rendered = render(<CapabilityContext value={initial}><DefenderHuntingView /></CapabilityContext>);
    await screen.findByText("No hunting history");
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    rendered.rerender(<CapabilityContext value={value}><DefenderHuntingView /></CapabilityContext>);
    await screen.findByText("No hunting history");
    expect(screen.queryByLabelText("Authorization")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeEnabled();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("clamps history after deleting its last server-paged row", async () => {
    const last = job({ id: "22222222-2222-4222-8222-222222222222" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce({ value: [job()], count: 21, limit: 20, offset: 0 })
      .mockResolvedValueOnce({ value: [last], count: 21, limit: 20, offset: 20 })
      .mockResolvedValueOnce({ value: [], count: 20, limit: 20, offset: 20 })
      .mockResolvedValueOnce({ value: [job()], count: 20, limit: 20, offset: 0 });
    vi.mocked(deleteDefenderHunt).mockResolvedValue(undefined);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: /Delete hunt 22222222/ }));
    expect(await screen.findByRole("button", { name: /View hunt 11111111/ })).toBeVisible();
    expect(getDefenderHuntingJobs).toHaveBeenLastCalledWith(20, 0, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.queryByText("No hunting history")).not.toBeInTheDocument();
  });

  it("does not reattach a post-delete read to another consumer's shared refresh", async () => {
    const client = createSavedQueryClient();
    const history = { value: [job()], count: 1, limit: 20, offset: 0 };
    let phase: "initial" | "old" | "fresh" = "initial";
    let finish!: (value: typeof history) => void;
    let oldSignal!: AbortSignal;
    const oldRead = new Promise<typeof history>(resolve => { finish = resolve; });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(deleteDefenderHunt).mockResolvedValue(undefined);
    vi.mocked(getDefenderHuntingJobs).mockImplementation((_limit, _offset, options) => {
      if (phase === "old") {
        oldSignal = options!.signal!;
        return oldRead;
      }
      return Promise.resolve(phase === "fresh" ? { ...history, value: [], count: 0 } : history);
    });
    const view = render(<SavedQueryProvider client={client}><CapabilityContext value={context()}>
      <section aria-label="First hunting consumer"><DefenderHuntingView /></section>
      <section aria-label="Second hunting consumer"><DefenderHuntingView /></section>
    </CapabilityContext></SavedQueryProvider>);
    try {
      const first = within(screen.getByRole("region", { name: "First hunting consumer" }));
      const second = within(screen.getByRole("region", { name: "Second hunting consumer" }));
      await first.findByRole("button", { name: /View hunt 11111111/ });
      await second.findByRole("button", { name: /View hunt 11111111/ });
      const initialCalls = vi.mocked(getDefenderHuntingJobs).mock.calls.length;
      phase = "old";
      fireEvent.click(first.getByRole("button", { name: "Refresh hunting history" }));
      await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(initialCalls + 1));
      phase = "fresh";
      fireEvent.click(second.getByRole("button", { name: /Delete hunt 11111111/ }));
      await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(initialCalls + 2));
      expect(await second.findByText("No hunting history")).toBeVisible();
      expect(oldSignal.aborted).toBe(false);
      await act(async () => finish(history));
      expect(await first.findByRole("button", { name: /View hunt 11111111/ })).toBeVisible();
      expect(second.queryByRole("button", { name: /View hunt 11111111/ })).not.toBeInTheDocument();
    } finally {
      view.unmount();
      client.clear();
    }
  });

  it("keeps post-delete polling in its new revision while another owner retains a shared poll", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const client = createSavedQueryClient();
    const outside = new AbortController();
    const running = job({ id: "22222222-2222-4222-8222-222222222222", status: "running" });
    const oldHistory = { value: [job(), running], count: 2, limit: 20, offset: 0 };
    const freshHistory = { value: [running], count: 1, limit: 20, offset: 0 };
    let finish!: (value: typeof oldHistory) => void;
    let oldSignal!: AbortSignal;
    vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce(oldHistory)
      .mockImplementationOnce((_limit, _offset, options) => {
        oldSignal = options!.signal!;
        return new Promise(resolve => { finish = resolve; });
      }).mockResolvedValue(freshHistory);
    vi.mocked(deleteDefenderHunt).mockResolvedValue(undefined);
    let initialHistoryKey: readonly unknown[] = [];
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type === "added" && event.query.queryKey.includes("defender-hunting-jobs")) initialHistoryKey = event.query.queryKey;
    });
    const view = render(<SavedQueryProvider client={client}>
      <CapabilityContext value={context()}><DefenderHuntingView /></CapabilityContext>
    </SavedQueryProvider>);
    let shared: Promise<typeof oldHistory> | undefined;
    try {
      await act(async () => {});
      unsubscribe();
      const sharedKey = [...initialHistoryKey.slice(1, -1), undefined];
      shared = readSavedQuery(client, sharedKey,
        signal => getDefenderHuntingJobs(20, 0, { signal }), outside.signal);
      await act(() => vi.advanceTimersByTimeAsync(1_500));
      expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
      const oldQuery = client.getQueryCache().find({ queryKey: ["saved", ...sharedKey], exact: true });
      expect(oldQuery?.getObserversCount()).toBe(2);
      fireEvent.click(screen.getByRole("button", { name: /Delete hunt 11111111/ }));
      await act(async () => {});
      expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(3);
      expect(oldQuery?.getObserversCount()).toBe(1);
      expect(oldSignal.aborted).toBe(false);
      await act(() => vi.advanceTimersByTimeAsync(1_500));
      expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(4);
      expect(oldQuery?.getObserversCount()).toBe(1);
      expect(oldSignal.aborted).toBe(false);
      await act(async () => {
        finish(oldHistory);
        await expect(shared).resolves.toEqual(oldHistory);
      });
      expect(screen.queryByRole("button", { name: /View hunt 11111111/ })).not.toBeInTheDocument();
    } finally {
      unsubscribe();
      const settled = shared?.catch(() => undefined);
      outside.abort();
      view.unmount();
      client.clear();
      await settled;
    }
  });

  it.each([false, true])("keeps its polling budget across passive history transitions (frozen clock: %s)", async frozenClock => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    if (frozenClock) vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const running = job({ status: "running", finishedAt: null });
    const terminal = job({ id: "22222222-2222-4222-8222-222222222222" });
    const requestTimes: number[] = [];
    vi.mocked(getDefenderHuntingJobs).mockImplementation(async (_limit, offset = 0) => {
      requestTimes.push(Date.now());
      return { value: [offset ? terminal : running], count: 21, limit: 20, offset };
    });
    renderView();
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(285_000));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await act(async () => {});
    const inactiveCount = requestTimes.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(requestTimes).toHaveLength(inactiveCount);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.getByText(/Automatic history refresh paused/)).toBeVisible();
    if (frozenClock) expect(requestTimes).toHaveLength(203);
    else expect(requestTimes.filter(time => time >= startedAt + 300_000)).toEqual([]);

    const pausedCount = requestTimes.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh hunting history" }));
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(requestTimes).toHaveLength(pausedCount + 2);
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("bounds automatic polling and requires manual refresh to restart", async () => {
    vi.useFakeTimers();
    const running = job({ status: "running", finishedAt: null });
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [running], count: 1, limit: 20, offset: 0 });
    renderView();
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(300_000));
    expect(screen.getByText(/Automatic history refresh paused/)).toBeVisible();
    const count = vi.mocked(getDefenderHuntingJobs).mock.calls.length;
    expect(count).toBeLessThanOrEqual(201);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(count);
    fireEvent.click(screen.getByRole("button", { name: "Refresh hunting history" }));
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(count + 2);
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it.each(["ready", "pending"] as const)("opens a retained prior successful result from a failed newer attempt (%s saved reads)", async savedReads => {
    const prior = job();
    const failed = job({ id: "55555555-5555-4555-8555-555555555555", status: "inconclusive", snapshotId: null,
      priorSuccessfulJobId: prior.id, complete: false, errorCode: "provider_error" });
    const history = { value: [], count: 0, limit: 20, offset: 0 };
    let finishCatalog!: (value: DefenderHuntingCatalog) => void;
    let finishHistory!: (value: Awaited<ReturnType<typeof getDefenderHuntingJobs>>) => void;
    if (savedReads === "pending") {
      vi.mocked(getDefenderHuntingCatalog).mockReturnValueOnce(new Promise(resolve => { finishCatalog = resolve; }));
      vi.mocked(getDefenderHuntingJobs).mockResolvedValueOnce(history)
        .mockReturnValueOnce(new Promise(resolve => { finishHistory = resolve; }));
    }
    vi.mocked(submitDefenderHunt).mockResolvedValue(failed);
    vi.mocked(getDefenderHuntingRows).mockResolvedValue(inventoryPage(prior, "Retained prior agent"));
    renderView();
    const search = screen.getByRole("button", { name: "Run hunt" });
    if (savedReads === "pending") {
      expect(search).toBeDisabled();
      fireEvent.click(search);
      expect(submitDefenderHunt).not.toHaveBeenCalled();
      await act(async () => finishCatalog(catalog));
    }
    await waitFor(() => expect(search).toBeEnabled());
    fireEvent.click(search);
    await waitFor(() => expect(submitDefenderHunt).toHaveBeenCalledOnce());
    const viewPrior = await screen.findByRole("button", { name: /View prior successful result/ });
    if (savedReads === "pending") {
      expect(viewPrior).toBeDisabled();
      fireEvent.click(viewPrior);
      expect(getDefenderHuntingRows).not.toHaveBeenCalled();
      await act(async () => finishHistory(history));
    }
    await waitFor(() => expect(viewPrior).toBeEnabled());
    fireEvent.click(viewPrior);
    expect(await screen.findByText("Retained prior agent")).toBeVisible();
    expect(getDefenderHuntingRows).toHaveBeenCalledExactlyOnceWith(
      prior.id,
      100,
      0,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});