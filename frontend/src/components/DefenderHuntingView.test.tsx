import { act, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import { CapabilityContext } from "../capabilityContext";
import { approveDefenderHuntingQualification, getDefenderHuntingCatalog, getDefenderHuntingJob, getDefenderHuntingJobs, getDefenderHuntingRows, startDefenderHuntingQualification,
  revokeDefenderHuntingRetainedScope, submitDefenderHunt, type DefenderHuntingCatalog, type DefenderHuntingJob, type DefenderHuntingRowPage } from "../api/client";
import { DefenderHuntingView } from "./DefenderHuntingView";
import { WorkbenchActionProvider } from "../workbenchActionContext";

function render(ui: ReactNode) {
  const wrap = (children: ReactNode) => <WorkbenchActionProvider value={workbenchActions}>{children}</WorkbenchActionProvider>;
  const result = rtlRender(wrap(ui));
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
  approvedScope: { templateId: "agents_inventory", agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [] },
  queryVersion: 3, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: "security-a",
  qualifiedAt: "2026-09-09T11:00:00.000Z", expiresAt: "2026-09-09T12:00:00.000Z" }],
retainedScopes: [{ id: "44444444-4444-4444-8444-444444444444", resultScope: { kind: "principal", scopeId: "security-a", configurationRevision: null },
  tokenMode: "delegated", capabilityId: "defender.hunting.delegated", templateId: "agents_inventory", targetScopeHash: "c".repeat(64),
  approvedScope: { templateId: "agents_inventory", agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [] }, queryVersion: 3,
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
    filters: { templateId: "agents_inventory", startDateTime: "2026-09-09T10:00:00.000Z", endDateTime: "2026-09-09T11:00:00.000Z", agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [] },
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

function context(available = true, roles = ["AgentControl.SecurityReader", "AgentControl.Administrator"] as const) {
  return { user: { homeAccountId: "security-a", tenantId: "tenant-a", displayName: "Security", username: "security@example.invalid", roles: [...roles] }, loading: false,
    now: Date.parse("2026-09-09T11:02:00.000Z"), reload: vi.fn(async () => undefined), openPermissions: vi.fn(),
    views: ["delegated", "application"].map(mode => ({ definition: { id: `defender.hunting.${mode}`, displayName: "Defender hunting", purpose: "Hunt", provider: "Microsoft Graph", maturity: "v1.0", cloud: "global", audience: "https://graph.microsoft.com",
      mode, permissions: ["ThreatHunting.Read.All"], providerRoles: [], licenses: [], configuration: [], sources: [], dataClass: "hunting", internalRoles: ["AgentControl.SecurityReader"],
      probe: { kind: "live_qualification", adapterRegistered: true, description: "bounded" } },
      decision: { capabilityId: `defender.hunting.${mode}`, status: available ? "available" : "unknown", authorized: available, fresh: available,
        checkedAt: available ? "2026-09-09T11:00:00.000Z" : undefined, expiresAt: available ? "2026-09-09T11:05:00.000Z" : undefined,
        previewQualification: "not_required", remediation: available ? [] : ["Run one approved qualification."] } })) } as never;
}

function renderView(available = true, roles?: readonly ("AgentControl.SecurityReader" | "AgentControl.Administrator")[]) {
  if (!available) vi.mocked(getDefenderHuntingCatalog).mockResolvedValue({ ...catalog, qualifications: [] });
  return render(<CapabilityContext value={context(available, roles as never)}><DefenderHuntingView /></CapabilityContext>);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/security");
  vi.mocked(getDefenderHuntingCatalog).mockResolvedValue(catalog);
  vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
});

describe("DefenderHuntingView", () => {
  it("loads only catalog and saved history on navigation and labels source/readiness boundaries", async () => {
    renderView();
    expect(await screen.findByRole("heading", { name: "Defender and Agent 365 hunting" })).toBeVisible();
    expect(screen.getByText("AgentsInfo")).toBeVisible();
    expect(screen.getByText("Not independently proven")).toBeVisible();
    expect(screen.getByText(/Authorization qualified; verify connector, license, rollout and table separately/)).toBeVisible();
    expect(screen.getByText(/Messages and tool content are absent/)).toBeVisible();
    expect(screen.getByText(/Opening this view does not run a provider query/)).toBeVisible();
    expect(getDefenderHuntingCatalog).toHaveBeenCalledOnce();
    expect(getDefenderHuntingJobs).toHaveBeenCalledExactlyOnceWith(20, 0);
    expect(submitDefenderHunt).not.toHaveBeenCalled();
    expect(approveDefenderHuntingQualification).not.toHaveBeenCalled();
    expect(startDefenderHuntingQualification).not.toHaveBeenCalled();
  });

  it("loads the exact older deep-linked job without selecting the latest history item or calling a provider", async () => {
    const latest = job({ id: "99999999-9999-4999-8999-999999999999", localRequestId: "latest-request" });
    const older = job({ id: "88888888-8888-4888-8888-888888888888", localRequestId: "older-request" });
    window.history.replaceState({}, "", `/security?job=${older.id}`);
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [latest], count: 21, limit: 20, offset: 0 });
    vi.mocked(getDefenderHuntingJob).mockResolvedValue(older);
    renderView();

    expect(await screen.findByText("older-request")).toBeVisible();
    expect(getDefenderHuntingJob).toHaveBeenCalledWith(older.id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("does not pretend the latest row is an exact job outside the current scope", async () => {
    const latest = job({ localRequestId: "latest-request" });
    window.history.replaceState({}, "", "/security?job=other-principal");
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [latest], count: 1, limit: 20, offset: 0 });
    vi.mocked(getDefenderHuntingJob).mockRejectedValue(new Error("Not found"));
    renderView();

    expect(await screen.findByText(/exact Defender job is expired, deleted, or unavailable/i)).toBeVisible();
    expect(screen.queryByText("latest-request")).not.toBeInTheDocument();
  });

  it("submits an explicit fixed template with typed filters and no KQL or workspace field", async () => {
    vi.mocked(submitDefenderHunt).mockResolvedValue(job());
    renderView();
    await screen.findByRole("heading", { name: "Defender and Agent 365 hunting" });
    fireEvent.click(screen.getByRole("button", { name: "Run hunt" }));
    await waitFor(() => expect(submitDefenderHunt).toHaveBeenCalledOnce());
    expect(submitDefenderHunt).toHaveBeenCalledWith("delegated", expect.objectContaining({ templateId: "agents_inventory", operations: [], agentIds: [], blueprintIds: [], actorObjectIds: [] }));
    const submitted = vi.mocked(submitDefenderHunt).mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(submitted).not.toHaveProperty("Query");
    expect(submitted).not.toHaveProperty("workspaceId");
  });

  it("requires explicit administrator acknowledgement and a separate run for qualification", async () => {
    const approved = job({ status: "waiting_authorization", complete: false, noData: false, snapshotId: null, canResume: true, qualification: {
      capabilityId: "defender.hunting.delegated", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: "security-a" } });
    vi.mocked(approveDefenderHuntingQualification).mockResolvedValue(approved);
    vi.mocked(startDefenderHuntingQualification).mockResolvedValue({ ...approved, status: "running" });
    renderView(false);
    await screen.findByText("Live hunting is not qualified");
    const approve = screen.getByRole("button", { name: /Approve qualification/ });
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Approve one bounded/ }));
    expect(approve).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/Select at least one exact agent, blueprint, or actor object ID/);
    fireEvent.change(screen.getByLabelText("Agent IDs"), { target: { value: "defender-agent" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Approve one bounded/ }));
    fireEvent.click(approve);
    await waitFor(() => expect(approveDefenderHuntingQualification).toHaveBeenCalledOnce());
    expect(startDefenderHuntingQualification).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: /Run approved qualification/ }));
    await waitFor(() => expect(startDefenderHuntingQualification).toHaveBeenCalledExactlyOnceWith(approved.id));
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
    expect(screen.getByText(/does not prove complete tenant coverage or identify a missing permission, connector, license or table/)).toBeVisible();
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

  it("keeps qualification unavailable to SecurityReader without Administrator", async () => {
    renderView(false, ["AgentControl.SecurityReader"]);
    await screen.findByText("Live hunting is not qualified");
    expect(screen.queryByRole("button", { name: /Approve qualification/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Revoke saved-data access/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
  });

  it("revokes the exact retained scope and refreshes saved visibility", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(revokeDefenderHuntingRetainedScope).mockResolvedValue({ ...catalog.retainedScopes[0], revokedAt: "2026-09-09T11:03:00.000Z" });
    vi.mocked(getDefenderHuntingCatalog).mockResolvedValueOnce(catalog).mockResolvedValueOnce({ ...catalog, qualifications: [], retainedScopes: [] });
    try {
      renderView();
      expect(await screen.findByText("Exact saved-data scope approved")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: /Revoke saved-data access/ }));
      await waitFor(() => expect(revokeDefenderHuntingRetainedScope).toHaveBeenCalledExactlyOnceWith(catalog.retainedScopes[0].id));
      await waitFor(() => expect(getDefenderHuntingCatalog).toHaveBeenCalledTimes(2));
      expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
    } finally {
      confirm.mockRestore();
    }
  });

  it("does not let broad capability availability or sibling evidence authorize another template", async () => {
    vi.mocked(getDefenderHuntingCatalog).mockResolvedValue({ ...catalog, qualifications: [{ ...catalog.qualifications[0], templateId: "agent_activity",
      approvedScope: { templateId: "agent_activity", agentIds: [], blueprintIds: [], actorObjectIds: [], operations: ["InferenceCall", "InvokeAgent"] } }] });
    renderView();
    expect(await screen.findByText("Live hunting is not qualified")).toBeVisible();
    expect(screen.getByRole("button", { name: "Run hunt" })).toBeDisabled();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("invalidates pending approval and search responses when exact filters change", async () => {
    let resolveApproval!: (value: DefenderHuntingJob) => void;
    vi.mocked(approveDefenderHuntingQualification).mockReturnValue(new Promise(resolve => { resolveApproval = resolve; }));
    const approvalView = renderView(false);
    await screen.findByText("Live hunting is not qualified");
    fireEvent.change(screen.getByLabelText("Agent IDs"), { target: { value: "agent-before-approval" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Approve one bounded/ }));
    fireEvent.click(screen.getByRole("button", { name: /Approve qualification/ }));
    await waitFor(() => expect(approveDefenderHuntingQualification).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Agent IDs"), { target: { value: "agent-after-approval" } });
    await act(async () => resolveApproval(job({ status: "waiting_authorization", snapshotId: null, canResume: true })));
    expect(screen.queryByRole("button", { name: /Run approved qualification/ })).not.toBeInTheDocument();
    approvalView.unmount();
    window.history.replaceState({}, "", "/security");

    let resolveSearch!: (value: DefenderHuntingJob) => void;
    vi.mocked(getDefenderHuntingCatalog).mockResolvedValue(catalog);
    vi.mocked(submitDefenderHunt).mockReturnValue(new Promise(resolve => { resolveSearch = resolve; }));
    renderView();
    await screen.findByText("Current qualification evidence permits an explicit hunt.");
    fireEvent.click(screen.getByRole("button", { name: "Run hunt" }));
    await waitFor(() => expect(submitDefenderHunt).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Agent IDs"), { target: { value: "agent-after-search" } });
    await act(async () => resolveSearch(job()));
    expect(screen.queryByRole("heading", { name: /Defender agent inventory result/ })).not.toBeInTheDocument();
    expect(getDefenderHuntingJobs).toHaveBeenCalledTimes(2);
  });

  it("clears prior rows on selection and shows full provenance without truncating scope IDs", async () => {
    const first = job({ resultScope: { kind: "principal", scopeId: "principal-scope-with-a-full-untruncated-identifier", configurationRevision: null } });
    const second = job({ id: "22222222-2222-4222-8222-222222222222", localRequestId: "44444444-4444-4444-8444-444444444444" });
    vi.mocked(getDefenderHuntingJobs).mockResolvedValue({ value: [first, second], count: 2, limit: 20, offset: 0 });
    let resolveSecond!: (value: DefenderHuntingRowPage) => void;
    vi.mocked(getDefenderHuntingRows).mockResolvedValueOnce(inventoryPage(first, "First selected agent"))
      .mockReturnValueOnce(new Promise(resolve => { resolveSecond = resolve; }));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "View hunt 11111111..." }));
    expect(await screen.findByText("First selected agent")).toBeVisible();
    expect(screen.getByText(/principal-scope-with-a-full-untruncated-identifier/)).toBeVisible();
    expect(screen.getByText(first.localRequestId)).toBeVisible();
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
    await waitFor(() => expect(getDefenderHuntingJobs).toHaveBeenLastCalledWith(20, 20));
    expect(await screen.findByText("21-21 of 21")).toBeVisible();
    expect(submitDefenderHunt).not.toHaveBeenCalled();
  });

  it("opens a retained prior successful result from a failed newer attempt", async () => {
    const prior = job();
    const failed = job({ id: "55555555-5555-4555-8555-555555555555", status: "inconclusive", snapshotId: null,
      priorSuccessfulJobId: prior.id, complete: false, errorCode: "provider_error" });
    vi.mocked(submitDefenderHunt).mockResolvedValue(failed);
    vi.mocked(getDefenderHuntingRows).mockResolvedValue(inventoryPage(prior, "Retained prior agent"));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Run hunt" }));
    fireEvent.click(await screen.findByRole("button", { name: /View prior successful result/ }));
    expect(await screen.findByText("Retained prior agent")).toBeVisible();
    expect(getDefenderHuntingRows).toHaveBeenCalledWith(prior.id, 100, 0);
  });
});