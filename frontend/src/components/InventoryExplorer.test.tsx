import { act, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import { InventoryExplorer } from "./InventoryExplorer";
import { downloadInventoryCsv, getInventoryQuarantineSelection, getInventoryRefreshJob, getInventoryRefreshJobs, getInventoryResources, getInventorySnapshots, getInventorySourceAwareDetail, getQuarantineJobs, getQuarantineStatus, previewQuarantine, refreshInventory, resumeInventoryRefresh, submitQuarantine } from "../api/client";
import { quarantineTargetReason } from "../quarantineTarget";
import { CopilotStudioQuarantineControls } from "./CopilotStudioQuarantineControls";
import { WorkbenchActionProvider } from "../workbenchActionContext";

vi.mock("./CapabilityGate", () => ({ CapabilityGate: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getInventoryResources: vi.fn(), getInventoryRefreshJobs: vi.fn(), getInventorySnapshots: vi.fn(), refreshInventory: vi.fn(), getInventoryRefreshJob: vi.fn(), resumeInventoryRefresh: vi.fn(), downloadInventoryCsv: vi.fn(),
  getQuarantineJobs: vi.fn(), getQuarantineJob: vi.fn(), getQuarantineStatus: vi.fn(), previewQuarantine: vi.fn(), submitQuarantine: vi.fn(), cancelQuarantineJob: vi.fn(), resumeQuarantineJob: vi.fn(), reconcileQuarantineJob: vi.fn(),
  getInventorySourceAwareDetail: vi.fn(), getInventoryQuarantineSelection: vi.fn(),
}));

const savedSnapshot = { id: "snapshot-a", roleScope: "ai" as const, environmentScope: null, requestedTypes: ["microsoft.copilotstudio/agents" as const], coverage: [], observedCount: 1, totalRecords: 1, pageCount: 1, unknownFieldCount: 2, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
const environmentId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";

const resource = {
  tenantId: "tenant-a", nativeId: "agent-a", type: "microsoft.copilotstudio/agents" as const, location: null, displayName: null,
  environmentId, createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform" as const,
  authoringTool: "Agent Builder", creatorType: "unknown" as const, agentKind: "agent_builder_agent", lifecycle: "draft" as const,
  identityConfidence: "exact_native" as const, identifiers: [{ kind: "entra_agent_id" as const, value: "agent-a" }, { kind: "environment_id" as const, value: environmentId }, { kind: "cds_bot_id" as const, value: botId }],
  provenance: { authoringTool: { sourceSystem: "power_platform" as const, path: "properties.createdIn", maturity: "preview" as const } },
  details: { capabilityDetailsTruncated: true }, unknownFieldCount: 0,
};

function render(ui: ReactNode) {
  const wrap = (children: ReactNode) => <WorkbenchActionProvider value={workbenchActions}>{children}</WorkbenchActionProvider>;
  const result = rtlRender(wrap(ui));
  return { ...result, rerender: (next: ReactNode) => result.rerender(wrap(next)) };
}

const savedPage = {
  value: [resource], count: 1,
  typeCounts: [
    { type: "microsoft.copilotstudio/agents" as const, status: "covered" as const, count: 1 },
    { type: "microsoft.powerapps/canvasapps" as const, status: "not_authorized_scope" as const, count: null },
    { type: "microsoft.powerapps/codeapps" as const, status: "unknown" as const, count: null },
  ],
  snapshot: savedSnapshot,
};

describe("InventoryExplorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/power-platform");
    vi.mocked(getInventorySnapshots).mockResolvedValue({ value: [savedSnapshot] });
    vi.mocked(getInventoryRefreshJobs).mockResolvedValue({ value: [], lastAttemptAt: null, lastSuccessAt: null });
    vi.mocked(getInventoryResources).mockResolvedValue(savedPage);
    vi.mocked(getInventorySourceAwareDetail).mockResolvedValue({
      source: "power_platform", nativeId: resource.nativeId, resourceType: resource.type, environmentId: resource.environmentId,
      snapshotId: savedSnapshot.id, observedAt: savedSnapshot.observedAt, expiresAt: savedSnapshot.expiresAt, identifiers: resource.identifiers,
      package: { status: "unmatched", reason: "No documented package-to-Power-Platform identifier equivalence exists." },
      reports: { status: "unmatched", reason: "Official report agent IDs are report-only." },
      audit: { status: "available", count: 0, value: [] }, security: { status: "unauthorized", reason: "SecurityReader is required." },
      controls: { quarantineTarget: { environmentId, botId }, packageTarget: null },
    });
    vi.mocked(getInventoryQuarantineSelection).mockResolvedValue({ value: [resource], snapshot: savedSnapshot });
    vi.mocked(refreshInventory).mockResolvedValue({ id: "job-a", status: "running", roleScope: "ai", environmentScope: null, requestedTypes: ["microsoft.copilotstudio/agents"], pageCount: 0, observedCount: 0, totalRecords: null, unknownFieldCount: 0, snapshotId: null, createdAt: new Date().toISOString(), attemptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: null });
    vi.mocked(getQuarantineJobs).mockResolvedValue({ value: [] });
    vi.mocked(getQuarantineStatus).mockResolvedValue(quarantineStatus());
    vi.mocked(previewQuarantine).mockResolvedValue(quarantinePreview(true));
    vi.mocked(submitQuarantine).mockResolvedValue(quarantineJob());
  });

  it("reads saved inventory without submitting a provider scan and shows truthful coverage", async () => {
    render(<InventoryExplorer packages={[]} />);
    expect((await screen.findAllByText("Not supplied")).length).toBeGreaterThan(0);
    expect(refreshInventory).not.toHaveBeenCalled();
    expect(screen.getByText("Not authorized")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText(/Unknown fields omitted: 2/i)).toBeInTheDocument();
    expect(getInventorySnapshots).toHaveBeenCalledTimes(1);
    expect(getInventoryRefreshJobs).toHaveBeenCalledTimes(1);
    expect(getQuarantineStatus).not.toHaveBeenCalled();
    expect(previewQuarantine).not.toHaveBeenCalled();
  });

  it("shows preview, null, truncation and bounded-association states in an accessible dialog", async () => {
    render(<InventoryExplorer packages={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "View details for agent-a" }));
    const dialog = screen.getByRole("dialog", { name: "agent-a" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Package" }));
    expect(await within(dialog).findByText(/No documented package-to-Power-Platform/)).toBeInTheDocument();
    fireEvent.keyDown(within(dialog).getByRole("tab", { name: "Package" }), { key: "ArrowRight" });
    expect(within(dialog).getByRole("tab", { name: "Reports" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "View details for agent-a" })).toHaveFocus());
  });

  it("submits a provider refresh only after the explicit scoped command", async () => {
    render(<InventoryExplorer packages={[]} />);
    await waitFor(() => expect(getInventoryRefreshJobs).toHaveBeenCalledTimes(1));
    expect(refreshInventory).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Refresh resource scope"), { target: { value: "microsoft.copilotstudio/agents" } });
    fireEvent.change(screen.getByLabelText("Refresh environment scope"), { target: { value: "environment-a" } });
    fireEvent.click(screen.getByRole("button", { name: /Refresh selected scope/ }));
    await waitFor(() => expect(refreshInventory).toHaveBeenCalledTimes(1));
    expect(refreshInventory).toHaveBeenCalledWith({ types: ["microsoft.copilotstudio/agents"], environmentId: "environment-a" });
  });

  it("discovers and resumes durable waiting work after reload", async () => {
    const waiting = { id: "job-waiting", status: "waiting_authorization" as const, roleScope: "ai" as const, environmentScope: null, requestedTypes: ["microsoft.copilotstudio/agents" as const], pageCount: 0, observedCount: 0, totalRecords: null, unknownFieldCount: 0, snapshotId: null, createdAt: new Date().toISOString(), attemptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: null };
    vi.mocked(getInventoryRefreshJobs).mockResolvedValue({ value: [waiting], lastAttemptAt: waiting.attemptedAt, lastSuccessAt: null });
    vi.mocked(resumeInventoryRefresh).mockResolvedValue({ ...waiting, status: "running" });
    render(<InventoryExplorer packages={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /Resume with current authorization/ }));
    await waitFor(() => expect(resumeInventoryRefresh).toHaveBeenCalledWith("job-waiting"));
  });

  it("loads an exact older refresh job from a deep link instead of selecting the latest job", async () => {
    const base = { id: "job-latest", status: "succeeded" as const, roleScope: "ai" as const, environmentScope: null, requestedTypes: ["microsoft.copilotstudio/agents" as const], pageCount: 1, observedCount: 10, totalRecords: 10, unknownFieldCount: 0, snapshotId: savedSnapshot.id, createdAt: new Date().toISOString(), attemptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    const older = { ...base, id: "job-older", observedCount: 3, totalRecords: 3 };
    window.history.replaceState({}, "", `/power-platform?refreshJob=${older.id}`);
    vi.mocked(getInventoryRefreshJobs).mockResolvedValue({ value: [base], lastAttemptAt: base.attemptedAt, lastSuccessAt: base.finishedAt });
    vi.mocked(getInventoryRefreshJob).mockResolvedValue(older);
    render(<InventoryExplorer packages={[]} />);

    expect(await screen.findByText(/3 of 3 resources observed/)).toBeVisible();
    expect(getInventoryRefreshJob).toHaveBeenCalledWith(older.id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("does not fall back to the latest refresh job when the exact ID is unavailable", async () => {
    const latest = { id: "job-latest", status: "succeeded" as const, roleScope: "ai" as const, environmentScope: null, requestedTypes: ["microsoft.copilotstudio/agents" as const], pageCount: 1, observedCount: 10, totalRecords: 10, unknownFieldCount: 0, snapshotId: savedSnapshot.id, createdAt: new Date().toISOString(), attemptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    window.history.replaceState({}, "", "/power-platform?refreshJob=other-principal-job");
    vi.mocked(getInventoryRefreshJobs).mockResolvedValue({ value: [latest], lastAttemptAt: latest.attemptedAt, lastSuccessAt: latest.finishedAt });
    vi.mocked(getInventoryRefreshJob).mockRejectedValue(new Error("Not found"));
    render(<InventoryExplorer packages={[]} />);

    expect(await screen.findByText(/exact inventory refresh job is unavailable to this account/i)).toBeVisible();
    expect(screen.queryByText("10 of 10 resources observed")).not.toBeInTheDocument();
  });

  it("ignores delayed reads from the previous account key", async () => {
    let resolvePage!: (value: Awaited<ReturnType<typeof getInventoryResources>>) => void;
    let resolveSnapshots!: (value: Awaited<ReturnType<typeof getInventorySnapshots>>) => void;
    let resolveJobs!: (value: Awaited<ReturnType<typeof getInventoryRefreshJobs>>) => void;
    vi.mocked(getInventoryResources).mockReturnValueOnce(new Promise(resolve => { resolvePage = resolve; })).mockResolvedValue({ ...savedPage, value: [{ ...resource, nativeId: "agent-current" }] });
    vi.mocked(getInventorySnapshots).mockReturnValueOnce(new Promise(resolve => { resolveSnapshots = resolve; })).mockResolvedValue({ value: [{ ...savedSnapshot, id: "snapshot-current", environmentScope: "current-environment" }] });
    vi.mocked(getInventoryRefreshJobs).mockReturnValueOnce(new Promise(resolve => { resolveJobs = resolve; })).mockResolvedValue({ value: [], lastAttemptAt: null, lastSuccessAt: null });
    const view = render(<InventoryExplorer key="account-old" packages={[]} />);
    await waitFor(() => expect(getInventoryResources).toHaveBeenCalledTimes(1));
    expect(getInventorySnapshots).toHaveBeenCalledTimes(1);
    expect(getInventoryRefreshJobs).toHaveBeenCalledTimes(1);
    view.rerender(<InventoryExplorer key="account-current" packages={[]} />);
    expect(await screen.findByText("agent-current")).toBeInTheDocument();
    resolvePage({ ...savedPage, value: [{ ...resource, nativeId: "agent-stale" }] });
    resolveSnapshots({ value: [{ ...savedSnapshot, id: "snapshot-stale", environmentScope: "stale-environment" }] });
    resolveJobs({ value: [], lastAttemptAt: "2020-01-01T00:00:00.000Z", lastSuccessAt: null });
    await Promise.resolve();
    expect(screen.queryByText("agent-stale")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /stale-environment/ })).not.toBeInTheDocument();
  });

  it("does not create a delayed CSV download after unmount", async () => {
    let resolveExport!: (value: Blob) => void;
    vi.mocked(downloadInventoryCsv).mockReturnValue(new Promise(resolve => { resolveExport = resolve; }));
    const createObjectUrl = vi.fn(() => "blob:test");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const view = render(<InventoryExplorer packages={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /Export filtered inventory CSV/ }));
    view.unmount();
    resolveExport(new Blob(["saved"]));
    await Promise.resolve();
    expect(createObjectUrl).not.toHaveBeenCalled();
    delete (URL as Partial<typeof URL>).createObjectURL;
    delete (URL as Partial<typeof URL>).revokeObjectURL;
  });

  it("accepts explicit refresh results under Strict Mode and displays server-scoped associations", async () => {
    vi.mocked(getInventoryResources).mockResolvedValue({ ...savedPage, value: [{ ...resource, association: { status: "ambiguous", reason: "multiple_exact_candidates", candidates: [], candidateCount: 23, candidatesTruncated: true } }] });
    render(<StrictMode><InventoryExplorer packages={[]} /></StrictMode>);
    fireEvent.click(await screen.findByRole("button", { name: "View details for agent-a" }));
    expect(screen.getByText("Ambiguous: 23 exact candidates remain separate.")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /Refresh selected scope/ }));
    expect(await screen.findByText("Refreshing inventory")).toBeInTheDocument();
  });

  it("keeps direct quarantine status unknown until an explicit exact-target read", async () => {
    render(<InventoryExplorer packages={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "View details for agent-a" }));
    fireEvent.click(screen.getByRole("tab", { name: "Controls" }));
    expect(await screen.findByText("Not checked")).toBeInTheDocument();
    expect(getQuarantineStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check direct status" }));
    await waitFor(() => expect(getQuarantineStatus).toHaveBeenCalledWith("snapshot-a", "agent-a", false));
    expect(screen.getByText(/Direct and inventory states disagree/)).toBeInTheDocument();
  });

  it("shows an exact frozen preview but disables unqualified writes", async () => {
    vi.mocked(previewQuarantine).mockResolvedValue(quarantinePreview(false));
    render(<InventoryExplorer packages={[]} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select agent-a for quarantine control" }));
    fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    expect(within(dialog).getByText(`${environmentId} / ${botId}`)).toBeInTheDocument();
    expect(within(dialog).getByText(/two-direction canary qualification/)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Confirm quarantine" })).toBeDisabled();
    expect(submitQuarantine).not.toHaveBeenCalled();
  });

  it("disables quarantine targeting when retained inventory is older than the target freshness window", async () => {
    vi.mocked(getInventoryResources).mockResolvedValue({ ...savedPage, snapshot: { ...savedSnapshot, observedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() } });
    render(<InventoryExplorer packages={[]} />);
    expect(await screen.findByRole("checkbox", { name: "Select agent-a for quarantine control" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "View details for agent-a" }));
    fireEvent.click(screen.getByRole("tab", { name: "Controls" }));
    expect(await screen.findByText(/saved inventory target is stale/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check direct status" })).toBeDisabled();
  });

  it("submits the qualified frozen native target with a caller-owned idempotency key", async () => {
    render(<InventoryExplorer packages={[]} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select agent-a for quarantine control" }));
    fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    await waitFor(() => expect(submitQuarantine).toHaveBeenCalledTimes(1));
    expect(submitQuarantine).toHaveBeenCalledWith({ action: "quarantine", snapshotId: "snapshot-a", resourceNativeIds: ["agent-a"], confirmationHash: "c".repeat(64) }, expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(refreshInventory).not.toHaveBeenCalled();
  });

  it("discards a delayed direct-status response after the exact target changes", async () => {
    let resolveStatus!: (value: ReturnType<typeof quarantineStatus>) => void;
    vi.mocked(getQuarantineStatus).mockReturnValueOnce(new Promise(resolve => { resolveStatus = resolve; }));
    const view = render(<CopilotStudioQuarantineControls snapshot={savedSnapshot} targets={[resource]} variant="detail" canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Check direct status" }));
    await waitFor(() => expect(getQuarantineStatus).toHaveBeenCalledTimes(1));
    view.rerender(<CopilotStudioQuarantineControls snapshot={savedSnapshot} targets={[{ ...resource, nativeId: "agent-current" }]} variant="detail" canManage />);
    view.rerender(<CopilotStudioQuarantineControls snapshot={savedSnapshot} targets={[resource]} variant="detail" canManage />);
    await act(async () => { resolveStatus(quarantineStatus()); await Promise.resolve(); });
    expect(screen.getByText("Not checked")).toBeInTheDocument();
    expect(screen.queryByText(/Direct and inventory states disagree/)).not.toBeInTheDocument();
  });

  it("closes a frozen confirmation without submitting when the selection changes", async () => {
    const view = render(<CopilotStudioQuarantineControls snapshot={savedSnapshot} targets={[resource]} variant="bulk" canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    view.rerender(<CopilotStudioQuarantineControls snapshot={savedSnapshot} targets={[{ ...resource, nativeId: "agent-current" }]} variant="bulk" canManage />);
    expect(screen.queryByRole("dialog", { name: "Quarantine 1 agent" })).not.toBeInTheDocument();
    expect(submitQuarantine).not.toHaveBeenCalled();
  });

  it("matches the server's exact native environment and CDS bot eligibility", () => {
    expect(quarantineTargetReason(resource, savedSnapshot)).toBeUndefined();
    expect(quarantineTargetReason({ ...resource, identifiers: resource.identifiers.filter(identifier => identifier.kind !== "cds_bot_id") }, savedSnapshot)).toMatch(/CDS bot identity/);
    expect(quarantineTargetReason({ ...resource, identifiers: [...resource.identifiers, { kind: "cds_bot_id", value: "33333333-3333-4333-8333-333333333333" }] }, savedSnapshot)).toMatch(/one valid native CDS bot identity/);
    expect(quarantineTargetReason({ ...resource, environmentId: "environment-a" }, savedSnapshot)).toMatch(/valid native environment ID/);
  });
});

function quarantineStatus() {
  return { target: { resourceNativeId: "agent-a", displayName: "agent-a", environmentId, botId }, direct: { isBotQuarantined: true, providerUpdatedAt: "2026-09-09T10:00:00.123Z", observedAt: "2026-09-09T10:00:01.000Z", correlationId: "correlation-a", source: "provider" as const }, inventory: { isQuarantined: false, quarantinedAt: null, observedAt: savedSnapshot.observedAt, snapshotId: savedSnapshot.id }, disagreesWithInventory: true };
}

function quarantinePreview(qualified: boolean) {
  return { confirmationHash: "c".repeat(64), qualification: { qualified, requiredForSubmit: true as const }, statuses: [quarantineStatus()], summary: { risk: true as const, operation: "quarantine" as const, provider: "Power Platform Copilot Studio" as const, endpoint: "api-version=1 botQuarantine" as const, permission: "Delegated CopilotStudio.AdminActions.Invoke" as const, targetCount: 1, targetSelectionHash: "d".repeat(64), actor: { id: "operator-a", displayName: "Operator", username: "operator@example.invalid" }, packageControlIndependent: true as const, makerBehavior: "Makers may still see and test this bot while connected channels cannot use it.", providerAtomicity: false as const, targets: [{ resourceNativeId: "agent-a", displayName: "agent-a", environmentId, botId, currentState: false, currentProviderUpdatedAt: "2026-09-09T10:00:00.123Z", requestedState: true, inventoryState: false, inventoryObservedAt: savedSnapshot.observedAt }], additionalTargetCount: 0 } };
}

function quarantineJob() {
  const preview = quarantinePreview(true);
  return { id: "job-a", action: "quarantine" as const, status: "queued" as const, confirmationHash: preview.confirmationHash, confirmation: preview.summary, isCanary: false, total: 1, completed: 0, succeeded: 0, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0, canResume: false, canReconcile: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), results: [] };
}