import { act, fireEvent, render as rtlRender, screen, waitFor, within, type RenderOptions } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import { InventoryExplorer, PowerPlatformResourceData } from "./InventoryExplorer";
import { ApiError, downloadInventoryCsv, getInventoryQuarantineSelection, getInventoryRefreshJob, getInventoryRefreshJobs, getInventoryResources, getInventorySnapshots, getInventorySourceAwareDetail, getQuarantineJobs, getQuarantineStatus, powerPlatformResourceTypes, previewQuarantine, refreshInventory, resumeInventoryRefresh, submitQuarantine, type InventorySnapshot } from "../api/client";
import { quarantineTargetReason } from "../quarantineTarget";
import { CopilotStudioQuarantineControls } from "./CopilotStudioQuarantineControls";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { createInventoryVerification } from "../test/inventoryVerification";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { createSavedQueryClient, readSavedQuery } from "../savedQueries";

vi.mock("./CapabilityGate", () => ({ CapabilityGate: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getInventoryResources: vi.fn(), getInventoryRefreshJobs: vi.fn(), getInventorySnapshots: vi.fn(), refreshInventory: vi.fn(), getInventoryRefreshJob: vi.fn(), resumeInventoryRefresh: vi.fn(), downloadInventoryCsv: vi.fn(),
  getQuarantineJobs: vi.fn(), getQuarantineJob: vi.fn(), getQuarantineStatus: vi.fn(), previewQuarantine: vi.fn(), submitQuarantine: vi.fn(), cancelQuarantineJob: vi.fn(), resumeQuarantineJob: vi.fn(), reconcileQuarantineJob: vi.fn(),
  getInventorySourceAwareDetail: vi.fn(), getInventoryQuarantineSelection: vi.fn(),
}));

const savedSnapshot = { id: "snapshot-a", roleScope: "ai" as const, environmentScope: null, requestedTypes: ["microsoft.copilotstudio/agents" as const], coverage: [{ type: "microsoft.copilotstudio/agents" as const, status: "covered" as const, count: 1 }], observedCount: 1, totalRecords: 1, pageCount: 1, verification: createInventoryVerification(1), unknownFieldCount: 2, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
const environmentId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";
const runningRefresh = {
  id: "job-a", status: "running" as const, roleScope: "ai" as const, environmentScope: null,
  requestedTypes: ["microsoft.copilotstudio/agents" as const], pageCount: 0, observedCount: 0, totalRecords: null,
  unknownFieldCount: 0, snapshotId: null, createdAt: new Date().toISOString(), attemptedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(), finishedAt: null,
};

const resource = {
  tenantId: "tenant-a", nativeId: "agent-a", type: "microsoft.copilotstudio/agents" as const, location: null, displayName: null,
  environmentId, createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform" as const,
  authoringTool: "Agent Builder", creatorType: "unknown" as const, agentKind: "agent_builder_agent", lifecycle: "draft" as const,
  identityConfidence: "exact_native" as const, identifiers: [{ kind: "entra_agent_id" as const, value: "agent-a" }, { kind: "environment_id" as const, value: environmentId }, { kind: "cds_bot_id" as const, value: botId }],
  provenance: { authoringTool: { sourceSystem: "power_platform" as const, path: "properties.createdIn", maturity: "preview" as const } },
  details: { capabilityDetailsTruncated: true }, unknownFieldCount: 0,
};

function render(ui: ReactNode, options?: RenderOptions) {
  const wrap = (children: ReactNode) => <WorkbenchActionProvider value={workbenchActions}>{children}</WorkbenchActionProvider>;
  const result = rtlRender(wrap(ui), options);
  return { ...result, rerender: (next: ReactNode) => result.rerender(wrap(next)) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const savedPage = {
  value: [resource], count: 1,
  typeCounts: [
    { type: "microsoft.copilotstudio/agents" as const, status: "covered" as const, count: 1 },
    { type: "microsoft.powerapps/canvasapps" as const, status: "not_authorized_scope" as const, count: null },
    { type: "microsoft.powerapps/codeapps" as const, status: "not_requested" as const, count: null },
  ],
  snapshot: savedSnapshot,
};

describe("InventoryExplorer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.history.replaceState({}, "", "/power-platform");
    vi.mocked(getInventorySnapshots).mockResolvedValue({ value: [savedSnapshot] });
    vi.mocked(getInventoryRefreshJobs).mockResolvedValue({ value: [], lastAttemptAt: null, lastSuccessAt: null });
    vi.mocked(getInventoryResources).mockResolvedValue(savedPage);
    vi.mocked(getInventorySourceAwareDetail).mockResolvedValue({
      source: "power_platform", nativeId: resource.nativeId, resourceType: resource.type, environmentId: resource.environmentId,
      snapshotId: savedSnapshot.id, observedAt: savedSnapshot.observedAt, expiresAt: savedSnapshot.expiresAt, identifiers: resource.identifiers,
      package: { status: "unmatched", reason: "No documented package-to-Power-Platform identifier equivalence exists." },
      reports: { status: "unmatched", reason: "Official report agent IDs are report-only." },
      audit: { status: "available", count: 0, value: [] }, security: { status: "unauthorized", reason: "Viewer is required." },
      controls: { quarantineTarget: { environmentId, botId }, packageTarget: null },
    });
    vi.mocked(getInventoryQuarantineSelection).mockResolvedValue({ value: [resource], snapshot: savedSnapshot });
    vi.mocked(refreshInventory).mockResolvedValue(runningRefresh);
    vi.mocked(getInventoryRefreshJob).mockResolvedValue(runningRefresh);
    vi.mocked(getQuarantineJobs).mockResolvedValue({ value: [] });
    vi.mocked(getQuarantineStatus).mockResolvedValue(quarantineStatus());
    vi.mocked(previewQuarantine).mockResolvedValue(quarantinePreview());
    vi.mocked(submitQuarantine).mockResolvedValue(quarantineJob());
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("isolates a new data revision from saved reads kept alive by another observer", async () => {
    window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a");
    const previousResources = deferred<Awaited<ReturnType<typeof getInventoryResources>>>();
    const previousSnapshots = deferred<Awaited<ReturnType<typeof getInventorySnapshots>>>();
    const previousJobs = deferred<Awaited<ReturnType<typeof getInventoryRefreshJobs>>>();
    const currentPage = { ...savedPage, value: [{ ...resource, displayName: "Current resource" }] };
    vi.mocked(getInventoryResources).mockReturnValueOnce(previousResources.promise).mockResolvedValue(currentPage);
    vi.mocked(getInventorySnapshots).mockReturnValueOnce(previousSnapshots.promise);
    vi.mocked(getInventoryRefreshJobs).mockReturnValueOnce(previousJobs.promise);
    const panels = (revision: number) => <SavedQueryProvider>
      <section aria-label="Previous reader"><InventoryExplorer dataRevision={0} /></section>
      <section aria-label="Current reader"><InventoryExplorer key={revision} dataRevision={revision} /></section>
    </SavedQueryProvider>;
    const view = render(panels(0));
    await waitFor(() => {
      expect(getInventoryResources).toHaveBeenCalledOnce();
      expect(getInventorySnapshots).toHaveBeenCalledOnce();
      expect(getInventoryRefreshJobs).toHaveBeenCalledOnce();
    });
    const previousSignals = [
      vi.mocked(getInventoryResources).mock.calls[0][1]?.signal,
      vi.mocked(getInventorySnapshots).mock.calls[0][0]?.signal,
      vi.mocked(getInventoryRefreshJobs).mock.calls[0][0]?.signal,
    ];
    view.rerender(panels(1));
    await waitFor(() => {
      expect(getInventoryResources).toHaveBeenCalledTimes(2);
      expect(getInventorySnapshots).toHaveBeenCalledTimes(2);
      expect(getInventoryRefreshJobs).toHaveBeenCalledTimes(2);
    });
    expect(previousSignals.every(signal => signal?.aborted === false)).toBe(true);
    const current = within(screen.getByRole("region", { name: "Current reader" }));
    expect(await current.findByText("Current resource")).toBeVisible();
    await act(async () => {
      previousResources.resolve({ ...savedPage, value: [{ ...resource, displayName: "Previous resource" }] });
      previousSnapshots.resolve({ value: [savedSnapshot] });
      previousJobs.resolve({ value: [], lastAttemptAt: null, lastSuccessAt: null });
    });
    expect(await within(screen.getByRole("region", { name: "Previous reader" })).findByText("Previous resource")).toBeVisible();
    expect(current.queryByText("Previous resource")).not.toBeInTheDocument();
    expect(current.getByText("Current resource")).toBeVisible();
  });

  it("does not reuse another consumer's pre-action reload after a local mutation", async () => {
    window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a");
    render(<SavedQueryProvider>
      <section aria-label="Previous reader"><InventoryExplorer /></section>
      <section aria-label="Current reader"><InventoryExplorer /></section>
    </SavedQueryProvider>);
    const previous = within(screen.getByRole("region", { name: "Previous reader" }));
    const current = within(screen.getByRole("region", { name: "Current reader" }));
    await waitFor(() => {
      expect(previous.getByRole("button", { name: "Verify saved inventory" })).toBeEnabled();
      expect(current.getByRole("button", { name: "Verify saved inventory" })).toBeEnabled();
    });
    expect(getInventoryResources).toHaveBeenCalledOnce();
    const pending = deferred<Awaited<ReturnType<typeof getInventoryResources>>>();
    vi.mocked(getInventoryResources).mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ ...savedPage, value: [{ ...resource, displayName: "Post-action resource" }] });
    fireEvent.click(previous.getByRole("button", { name: "Verify saved inventory" }));
    await waitFor(() => expect(getInventoryResources).toHaveBeenCalledTimes(2));
    const previousSignal = vi.mocked(getInventoryResources).mock.calls[1][1]?.signal;
    fireEvent.click(current.getByRole("button", { name: "Refresh selected scope" }));
    await waitFor(() => expect(refreshInventory).toHaveBeenCalledOnce());
    await waitFor(() => expect(getInventoryResources).toHaveBeenCalledTimes(3));
    expect(previousSignal?.aborted).toBe(false);
    expect(await current.findByText("Post-action resource")).toBeVisible();
    await act(async () => pending.resolve({ ...savedPage, value: [{ ...resource, displayName: "Pre-action resource" }] }));
    expect(await previous.findByText("Pre-action resource")).toBeVisible();
    expect(current.queryByText("Pre-action resource")).not.toBeInTheDocument();
  });

  it("reads saved inventory without submitting a provider scan and shows truthful coverage", async () => {
    render(<InventoryExplorer packages={[]} />);
    expect((await screen.findAllByText("Not supplied")).length).toBeGreaterThan(0);
    expect(refreshInventory).not.toHaveBeenCalled();
    expect(await screen.findByText("Not queried (role scope)")).toBeInTheDocument();
    expect(screen.getByText("Not requested")).toBeInTheDocument();
    expect(screen.getByText(/Unknown fields omitted: 2/i)).toBeInTheDocument();
    expect(getInventorySnapshots).toHaveBeenCalledTimes(1);
    expect(getInventoryRefreshJobs).toHaveBeenCalledTimes(1);
    expect(getInventoryResources).toHaveBeenCalledWith(
      expect.objectContaining({ excludeAgents: true }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(getQuarantineStatus).not.toHaveBeenCalled();
    expect(previewQuarantine).not.toHaveBeenCalled();
  });

  it("delegates supported header sorting to the server, resets paging, preserves row order, and cancels superseded reads", async () => {
    window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a&page=2");
    const flow = { ...resource, nativeId: "flow-first", displayName: "Flow first", type: "microsoft.powerautomate/cloudflows" as const };
    const app = { ...resource, nativeId: "app-second", displayName: "App second", type: "microsoft.powerapps/apps" as const };
    let typeReadSignal: AbortSignal | undefined;
    vi.mocked(getInventoryResources).mockImplementation((query, options) => {
      if (query?.sortBy === "type") {
        typeReadSignal = options?.signal;
        return new Promise<Awaited<ReturnType<typeof getInventoryResources>>>(() => {});
      }
      if (query?.sortBy === "environmentId") return Promise.resolve({ ...savedPage, value: [app, flow], count: 2 });
      return Promise.resolve({ ...savedPage, value: [flow, app], count: 100 });
    });
    render(<InventoryExplorer />);
    await screen.findByText("flow-first");
    expect(screen.queryByRole("button", { name: "Sort by Built with" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sort by Lifecycle" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "createdAt" } });
    await waitFor(() => expect(getInventoryResources).toHaveBeenCalledWith(
      expect.objectContaining({ sortBy: "createdAt", offset: 0 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));

    fireEvent.click(screen.getByRole("button", { name: "Sort by Type" }));
    await waitFor(() => expect(getInventoryResources).toHaveBeenCalledWith(
      expect.objectContaining({ sortBy: "type", sortDirection: "asc", offset: 0 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(within(screen.getByRole("table")).getAllByRole("row").slice(1).map(row => within(row).getAllByRole("cell")[1].textContent))
      .toEqual(["Flow firstflow-first", "App secondapp-second"]);

    fireEvent.click(screen.getByRole("button", { name: "Sort by Environment" }));
    await waitFor(() => expect(typeReadSignal?.aborted).toBe(true));
    await waitFor(() => expect(getInventoryResources).toHaveBeenCalledWith(
      expect.objectContaining({ sortBy: "environmentId", sortDirection: "asc", offset: 0 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    const environmentSort = screen.getByRole("button", { name: "Sort by Environment" });
    await waitFor(() => expect(environmentSort).toHaveFocus());
    expect(environmentSort.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(new URLSearchParams(window.location.search).has("page")).toBe(false);
  });

  it("withholds CSV export while sorted saved results are pending or unverified", async () => {
    window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a");
    render(<InventoryExplorer />);
    const exportButton = screen.getByRole("button", { name: "Export filtered inventory CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    const pending = deferred<Awaited<ReturnType<typeof getInventoryResources>>>();
    vi.mocked(getInventoryResources).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Published" }));
    expect(exportButton).toBeDisabled();
    expect(screen.queryByText("1-1 of 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Page 1 of 1")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Power Platform inventory explorer" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Authorized Power Platform query verified")).not.toBeInTheDocument();
    await waitFor(() => expect(getInventoryResources).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: "lastPublishedAt", sortDirection: "asc", offset: 0 }),
      expect.anything(),
    ));
    await act(async () => pending.reject(new Error("Sorted saved rows could not be verified.")));
    expect(exportButton).toBeDisabled();
    expect(screen.getByText("Page and count not verified")).toBeVisible();
    expect(screen.getByText("agent-a")).toBeVisible();
    expect(screen.getByText(/Displaying previous saved results/)).toBeVisible();
    expect(downloadInventoryCsv).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
    await waitFor(() => expect(exportButton).toBeEnabled());
  });

  it.each(["query", "snapshot", "verification"] as const)(
    "cancels a delayed CSV on %s changes, including A-B-A transitions", async change => {
      window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a");
      const secondSnapshot = { ...savedSnapshot, id: "snapshot-b" };
      vi.mocked(getInventorySnapshots).mockResolvedValue({ value: [savedSnapshot, secondSnapshot] });
      vi.mocked(getInventoryResources).mockImplementation(async query => ({
        ...savedPage, snapshot: query?.snapshotId === secondSnapshot.id ? secondSnapshot : savedSnapshot,
      }));
      const pending = deferred<Blob>();
      vi.mocked(downloadInventoryCsv).mockReturnValueOnce(pending.promise);
      const createObjectURL = vi.fn(() => "blob:inventory");
      vi.stubGlobal("URL", class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = vi.fn();
      });
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      render(<InventoryExplorer />);
      const exportButton = screen.getByRole("button", { name: "Export filtered inventory CSV" });
      await waitFor(() => expect(exportButton).toBeEnabled());
      fireEvent.click(exportButton);
      const signal = vi.mocked(downloadInventoryCsv).mock.calls[0][1];
      expect(exportButton).toBeDisabled();
      if (change === "query") {
        fireEvent.change(screen.getByLabelText("Search"), { target: { value: "other" } });
        fireEvent.change(screen.getByLabelText("Search"), { target: { value: "" } });
      } else if (change === "snapshot") {
        fireEvent.change(screen.getByLabelText("Saved scope"), { target: { value: secondSnapshot.id } });
        fireEvent.change(screen.getByLabelText("Saved scope"), { target: { value: savedSnapshot.id } });
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
      }
      expect(signal?.aborted).toBe(true);
      await waitFor(() => expect(exportButton).toBeEnabled());
      await act(async () => pending.resolve(new Blob(["obsolete"])));
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(exportButton).toBeEnabled();
    },
  );

  it("exports the admitted snapshot and server sort without a page limit", async () => {
    window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a&page=2&sort=type&direction=desc&q=flow");
    vi.mocked(getInventoryResources).mockResolvedValue({ ...savedPage, count: 100 });
    vi.mocked(downloadInventoryCsv).mockResolvedValue(new Blob(["inventory"]));
    const createObjectURL = vi.fn(() => "blob:inventory");
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<InventoryExplorer />);
    const exportButton = screen.getByRole("button", { name: "Export filtered inventory CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    expect(downloadInventoryCsv).toHaveBeenCalledExactlyOnceWith({
      snapshotId: savedSnapshot.id, excludeAgents: true, type: undefined, environmentId: undefined,
      search: "flow", sortBy: "type", sortDirection: "desc", limit: undefined, offset: undefined,
    }, expect.any(AbortSignal));
  });

  it("never combines a prior detail resource with a different saved snapshot", async () => {
    const app = { ...resource, nativeId: "same-app", type: "microsoft.powerapps/apps" as const, displayName: "First saved app" };
    const secondSnapshot = { ...savedSnapshot, id: "snapshot-b" };
    const detailRoute = `&detail=same-app&detailType=${app.type}&detailEnvironment=${environmentId}`;
    window.history.replaceState({}, "", `/power-platform?snapshot=snapshot-a${detailRoute}`);
    vi.mocked(getInventorySnapshots).mockResolvedValue({ value: [savedSnapshot, secondSnapshot] });
    const pending = deferred<Awaited<ReturnType<typeof getInventoryResources>>>();
    vi.mocked(getInventoryResources).mockResolvedValueOnce({ ...savedPage, value: [app] })
      .mockReturnValueOnce(pending.promise);
    render(<InventoryExplorer />);
    await screen.findByRole("dialog", { name: "First saved app" });
    await act(async () => {
      window.history.replaceState({}, "", `/power-platform?snapshot=snapshot-b${detailRoute}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByRole("dialog", { name: "First saved app" })).not.toBeInTheDocument();
    await act(async () => pending.resolve({
      ...savedPage, snapshot: secondSnapshot, value: [{ ...app, displayName: "Second saved app" }],
    }));
    expect(await screen.findByRole("dialog", { name: "Second saved app" })).toBeVisible();
    expect(getInventorySourceAwareDetail).toHaveBeenLastCalledWith({
      snapshotId: secondSnapshot.id, nativeId: app.nativeId, type: app.type, environmentId,
    }, { signal: expect.any(AbortSignal) });
  });

  it("keeps opaque composite row identities stable across server reordering", async () => {
    window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a");
    const first = { ...resource, type: "microsoft.powerapps/apps" as const, nativeId: "c", environmentId: "a:b", displayName: "First app" };
    const second = { ...first, nativeId: "b:c", environmentId: "a", displayName: "Second app" };
    vi.mocked(getInventoryResources).mockImplementation(async query => ({
      ...savedPage, count: 2, value: query?.sortDirection === "desc" ? [second, first] : [first, second],
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<InventoryExplorer />);
    const trigger = await screen.findByRole("button", { name: "View details for First app" });
    fireEvent.click(screen.getByRole("button", { name: "Sort by Name" }));
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")[1]).toHaveTextContent("Second app"));
    expect(screen.getByRole("button", { name: "View details for First app" })).toBe(trigger);
    expect(consoleError).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "First app" })).toHaveTextContent("a:b");
    await waitFor(() => expect(getInventorySourceAwareDetail).toHaveBeenLastCalledWith({
      snapshotId: savedSnapshot.id, nativeId: first.nativeId, type: first.type, environmentId: first.environmentId,
    }, { signal: expect.any(AbortSignal) }));
  });

  it("does not guess a detail resource when a legacy native ID names multiple environments", async () => {
    window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a&detail=shared");
    const first = { ...resource, type: "microsoft.powerapps/apps" as const, nativeId: "shared", displayName: "First app" };
    const second = { ...first, environmentId: "other-environment", displayName: "Second app" };
    vi.mocked(getInventoryResources).mockResolvedValue({ ...savedPage, count: 2, value: [first, second] });
    render(<InventoryExplorer />);
    await screen.findByText("Authorized Power Platform query verified");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(getInventorySourceAwareDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View details for Second app" }));
    expect(screen.getByRole("dialog", { name: "Second app" })).toHaveTextContent(second.environmentId);
  });

  it("keeps focus in a filter and ignores a superseded server sort that resolves late", async () => {
    window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a");
    render(<InventoryExplorer />);
    await screen.findByText("Authorized Power Platform query verified");
    const pending = deferred<Awaited<ReturnType<typeof getInventoryResources>>>();
    vi.mocked(getInventoryResources).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Type" }));
    await waitFor(() => expect(getInventoryResources).toHaveBeenCalledTimes(2));
    const oldSignal = vi.mocked(getInventoryResources).mock.calls[1][1]?.signal;
    const search = screen.getByLabelText("Search");
    search.focus();
    fireEvent.change(search, { target: { value: "current" } });
    await screen.findByText("Authorized Power Platform query verified");
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => pending.resolve({ ...savedPage, value: [{ ...resource, nativeId: "obsolete-resource" }] }));
    expect(screen.queryByText("obsolete-resource")).not.toBeInTheDocument();
    expect(search).toHaveFocus();
  });

  describe("queued detail-close focus restoration", () => {
    it("does not steal Search focus acquired before the close frame is released", async () => {
      render(<InventoryExplorer />);
      fireEvent.click(await screen.findByRole("button", { name: "View details for agent-a" }));
      const dialog = screen.getByRole("dialog", { name: "agent-a" });
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.push(callback); return frames.length; });
      fireEvent.click(within(dialog).getByRole("button", { name: "Close inventory details" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(frames.length).toBeGreaterThan(0);
      const search = screen.getByLabelText("Search");
      search.focus();
      expect(search).toHaveFocus();
      act(() => { for (const frame of frames) frame(0); });
      expect(search).toHaveFocus();
    });

    it.each(["button", "Escape"] as const)("restores the opener after ordinary %s close", async method => {
      render(<InventoryExplorer />);
      const trigger = await screen.findByRole("button", { name: "View details for agent-a" });
      fireEvent.click(trigger);
      const dialog = screen.getByRole("dialog", { name: "agent-a" });
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.push(callback); return frames.length; });
      if (method === "button") fireEvent.click(within(dialog).getByRole("button", { name: "Close inventory details" }));
      else fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(frames.length).toBeGreaterThan(0);
      act(() => { for (const frame of frames) frame(0); });
      expect(trigger).toHaveFocus();
    });
  });

  describe("job action settlement ownership", () => {
    const original = { ...runningRefresh, id: "original-job", status: "waiting_authorization" as const, message: "Original exact job" };
    const selected = { ...original, id: "selected-job", message: "Selected exact job" };
    beforeEach(() => {
      window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a&refreshJob=original-job");
      vi.mocked(getInventoryRefreshJob).mockImplementation(async id => id === original.id ? original : selected);
    });

    it.each([
      ["refresh", "success"], ["resume", "success"], ["refresh", "failure"], ["resume", "failure"],
    ] as const)("ignores an obsolete %s %s after a newer exact-job selection", async (command, outcome) => {
      const pending = deferred<Awaited<ReturnType<typeof refreshInventory>>>();
      const mutate = command === "refresh" ? vi.mocked(refreshInventory) : vi.mocked(resumeInventoryRefresh);
      mutate.mockReturnValueOnce(pending.promise);
      render(<InventoryExplorer canManageQuarantine={false} />);
      await screen.findByText("Original exact job");
      fireEvent.click(screen.getByRole("button", {
        name: command === "refresh" ? "Refresh selected scope" : "Resume with current authorization",
      }));
      await waitFor(() => expect(mutate).toHaveBeenCalledOnce());
      window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a&refreshJob=selected-job");
      fireEvent.popState(window);
      await screen.findByText("Selected exact job");
      const jobReads = vi.mocked(getInventoryRefreshJob).mock.calls.length;
      const resourceReads = vi.mocked(getInventoryResources).mock.calls.length;
      await act(async () => {
        if (outcome === "failure") pending.reject(new Error("Obsolete command failure"));
        else pending.resolve({
          ...original, id: command === "resume" ? original.id : "obsolete-refresh",
          status: "succeeded", snapshotId: "obsolete-snapshot", message: "Obsolete command success",
        });
      });
      expect(new URLSearchParams(window.location.search).get("refreshJob")).toBe(selected.id);
      expect(new URLSearchParams(window.location.search).get("snapshot")).toBe(savedSnapshot.id);
      expect(screen.getByText("Selected exact job")).toBeVisible();
      expect(screen.queryByText("Obsolete command failure")).not.toBeInTheDocument();
      expect(screen.queryByText("Obsolete command success")).not.toBeInTheDocument();
      expect(getInventoryRefreshJob).toHaveBeenCalledTimes(jobReads);
      expect(getInventoryResources).toHaveBeenCalledTimes(resourceReads);
      expect(screen.getByRole("button", { name: "Resume with current authorization" })).toBeEnabled();
    });

    it("does not restore a resumed job whose newer exact read was denied", async () => {
      const pending = deferred<Awaited<ReturnType<typeof resumeInventoryRefresh>>>();
      vi.mocked(resumeInventoryRefresh).mockReturnValueOnce(pending.promise);
      render(<InventoryExplorer canManageQuarantine={false} />);
      await screen.findByText("Original exact job");
      fireEvent.click(screen.getByRole("button", { name: "Resume with current authorization" }));
      await waitFor(() => expect(resumeInventoryRefresh).toHaveBeenCalledExactlyOnceWith(original.id));
      vi.mocked(getInventoryRefreshJob).mockRejectedValueOnce(new ApiError(403, "forbidden", "Resumed job read denied."));
      fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
      await screen.findByText(/Resumed job read denied/);
      expect(screen.queryByText("Original exact job")).not.toBeInTheDocument();
      const jobReads = vi.mocked(getInventoryRefreshJob).mock.calls.length;
      await act(async () => pending.resolve({ ...original, status: "running", message: "Denied job revived by old resume" }));
      expect(screen.queryByText("Original exact job")).not.toBeInTheDocument();
      expect(screen.queryByText("Denied job revived by old resume")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Resume with current authorization" })).not.toBeInTheDocument();
      expect(screen.getByText(/Resumed job read denied/)).toBeVisible();
      expect(getInventoryRefreshJob).toHaveBeenCalledTimes(jobReads);
      expect(new URLSearchParams(window.location.search).get("refreshJob")).toBe(original.id);
      expect(screen.getByRole("button", { name: "Refresh selected scope" })).toBeEnabled();
    });

    it("admits only one pending command and does not cancel an admitted resume", async () => {
      const pending = deferred<Awaited<ReturnType<typeof resumeInventoryRefresh>>>();
      vi.mocked(resumeInventoryRefresh).mockReturnValue(pending.promise);
      render(<InventoryExplorer canManageQuarantine={false} />);
      await screen.findByText("Original exact job");
      const resume = screen.getByRole("button", { name: "Resume with current authorization" });
      const refresh = screen.getByRole("button", { name: "Refresh selected scope" });
      fireEvent.click(resume);
      fireEvent.click(resume);
      fireEvent.click(refresh);
      expect(resumeInventoryRefresh).toHaveBeenCalledExactlyOnceWith(original.id);
      expect(refreshInventory).not.toHaveBeenCalled();
      expect(resume).toBeDisabled();
      expect(refresh).toBeDisabled();
      await act(async () => pending.resolve(original));
      expect(await screen.findByText("Original exact job")).toBeVisible();
      expect(screen.getByRole("button", { name: "Resume with current authorization" })).toBeEnabled();
      expect(resumeInventoryRefresh).toHaveBeenCalledExactlyOnceWith(original.id);
    });

    it.each(["refresh", "resume"] as const)("keeps an independent pending %s eligible after unrelated history-only denial", async command => {
      window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a");
      vi.mocked(getInventoryRefreshJobs).mockResolvedValue({
        value: [original], lastAttemptAt: original.attemptedAt, lastSuccessAt: null,
      });
      const pending = deferred<Awaited<ReturnType<typeof refreshInventory>>>();
      const mutate = command === "refresh" ? vi.mocked(refreshInventory) : vi.mocked(resumeInventoryRefresh);
      mutate.mockReturnValueOnce(pending.promise);
      render(<InventoryExplorer canManageQuarantine={false} />);
      await screen.findByText("Original exact job");
      fireEvent.click(screen.getByRole("button", {
        name: command === "refresh" ? "Refresh selected scope" : "Resume with current authorization",
      }));
      await waitFor(() => expect(mutate).toHaveBeenCalledOnce());
      vi.mocked(getInventoryRefreshJobs).mockRejectedValue(new ApiError(403, "forbidden", "Unrelated history denied."));
      fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
      await screen.findByText("Unrelated history denied.");
      expect(screen.queryByText("Original exact job")).not.toBeInTheDocument();
      await act(async () => pending.resolve({
        ...selected, id: command === "refresh" ? "newly-created-job" : original.id, message: "Independently accepted command",
      }));
      expect(await screen.findByText("Independently accepted command")).toBeVisible();
      expect(screen.getByRole("button", { name: "Resume with current authorization" })).toBeEnabled();
      expect(screen.getByText("Last attempt").parentElement).toHaveTextContent("Not authorized");
      expect(mutate).toHaveBeenCalledOnce();
    });
  });

  it("clears private inventory rows and details after saved-read authorization is revoked", async () => {
    window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a");
    render(<InventoryExplorer />);
    fireEvent.click(await screen.findByRole("button", { name: "View details for agent-a" }));
    await screen.findByRole("dialog", { name: "agent-a" });
    vi.mocked(getInventoryResources).mockRejectedValueOnce(new ApiError(403, "forbidden", "Inventory access revoked."));
    fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
    await screen.findAllByText("Inventory access revoked.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export filtered inventory CSV" })).toBeDisabled();
    expect(screen.queryByText("agent-a")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Saved inventory unavailable" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "No saved inventory" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Run an explicit refresh after/)).not.toBeInTheDocument();
  });

  it("invalidates the saved verification and clears resource details when CSV authorization is revoked", async () => {
    window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a");
    const pending = deferred<Blob>();
    vi.mocked(downloadInventoryCsv).mockReturnValueOnce(pending.promise);
    render(<InventoryExplorer />);
    const exportButton = screen.getByRole("button", { name: "Export filtered inventory CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    fireEvent.click(screen.getByRole("button", { name: "View details for agent-a" }));
    await screen.findByRole("dialog", { name: "agent-a" });
    await act(async () => pending.reject(new ApiError(403, "forbidden", "Inventory CSV access revoked.")));
    expect(await screen.findAllByText("Inventory CSV access revoked.")).not.toHaveLength(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Authorized Power Platform query verified")).not.toBeInTheDocument();
    expect(exportButton).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Saved inventory unavailable" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "No saved inventory" })).not.toBeInTheDocument();
  });

  describe("scoped read denials", () => {
    beforeEach(() => window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a"));
    afterEach(() => vi.useRealTimers());

    it.each([403, 503])("does not call an initial saved-read failure an empty inventory (%s)", async status => {
      window.history.replaceState({}, "", "/power-platform");
      vi.mocked(getInventorySnapshots).mockResolvedValue({ value: [] });
      vi.mocked(getInventoryResources).mockRejectedValueOnce(
        new ApiError(status, status === 403 ? "forbidden" : "temporarily_unavailable", "The saved read is unavailable."),
      );
      render(<InventoryExplorer />);
      expect(await screen.findByRole("heading", { name: "Saved inventory unavailable" })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "No saved inventory" })).not.toBeInTheDocument();
      expect(screen.queryByText(/Run an explicit refresh after/)).not.toBeInTheDocument();
      expect(refreshInventory).not.toHaveBeenCalled();
      vi.mocked(getInventoryResources).mockResolvedValue({ value: [], count: 0, typeCounts: [], snapshot: null });
      fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
      expect(await screen.findByRole("heading", { name: "No saved inventory" })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Saved inventory unavailable" })).not.toBeInTheDocument();
      expect(refreshInventory).not.toHaveBeenCalled();
    });

    it("does not reuse a previously empty inventory claim while verification is pending or failed", async () => {
      window.history.replaceState({}, "", "/power-platform");
      vi.mocked(getInventorySnapshots).mockResolvedValue({ value: [] });
      vi.mocked(getInventoryResources).mockResolvedValue({ value: [], count: 0, typeCounts: [], snapshot: null });
      render(<InventoryExplorer />);
      await screen.findByRole("heading", { name: "No saved inventory" });
      const pending = deferred<Awaited<ReturnType<typeof getInventoryResources>>>();
      vi.mocked(getInventoryResources).mockReturnValueOnce(pending.promise);
      fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
      expect(screen.queryByRole("heading", { name: "No saved inventory" })).not.toBeInTheDocument();
      expect(screen.getByText("Loading saved inventory...")).toBeVisible();
      await act(async () => pending.reject(new ApiError(503, "temporarily_unavailable", "Verification unavailable.")));
      expect(await screen.findByRole("heading", { name: "Saved inventory unavailable" })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "No saved inventory" })).not.toBeInTheDocument();
    });

    it("clears denied snapshot choices without cancelling another reader or an authorized history sibling", async () => {
      vi.mocked(getInventorySnapshots).mockResolvedValue({ value: [
        savedSnapshot, { ...savedSnapshot, id: "restricted-snapshot", environmentScope: "restricted-scope" },
      ] });
      const otherPage = deferred<Awaited<ReturnType<typeof getInventoryResources>>>();
      vi.mocked(getInventoryResources).mockImplementation(query => query?.search === "independent"
        ? otherPage.promise : Promise.resolve(savedPage));
      render(<SavedQueryProvider>
        <section aria-label="Denied reader"><InventoryExplorer canManageQuarantine={false} /></section>
        <section aria-label="Independent reader"><InventoryExplorer canManageQuarantine={false} /></section>
      </SavedQueryProvider>);
      const denied = within(screen.getByRole("region", { name: "Denied reader" }));
      const independent = within(screen.getByRole("region", { name: "Independent reader" }));
      await denied.findByRole("option", { name: /restricted-scope/ });
      fireEvent.change(independent.getByLabelText("Search"), { target: { value: "independent" } });
      await waitFor(() => expect(getInventoryResources).toHaveBeenCalledWith(
        expect.objectContaining({ search: "independent" }), expect.anything(),
      ));
      const otherSignal = vi.mocked(getInventoryResources).mock.calls.find(([query]) => query?.search === "independent")?.[1]?.signal;
      const history = deferred<Awaited<ReturnType<typeof getInventoryRefreshJobs>>>();
      vi.mocked(getInventorySnapshots).mockRejectedValueOnce(new ApiError(403, "forbidden", "Snapshot choices denied."));
      vi.mocked(getInventoryRefreshJobs).mockReturnValueOnce(history.promise);
      fireEvent.click(denied.getByRole("button", { name: "Verify saved inventory" }));
      await denied.findByText("Snapshot choices denied.");
      expect(denied.queryByRole("option", { name: /restricted-scope/ })).not.toBeInTheDocument();
      expect(denied.getByLabelText("Saved scope")).toBeDisabled();
      expect(denied.getByRole("button", { name: "View details for agent-a" })).toBeVisible();
      expect(independent.getByRole("option", { name: /restricted-scope/ })).toBeInTheDocument();
      expect(otherSignal?.aborted).toBe(false);
      await act(async () => {
        history.resolve({
          value: [{ ...runningRefresh, status: "waiting_authorization", message: "Authorized history sibling" }],
          lastAttemptAt: runningRefresh.attemptedAt, lastSuccessAt: null,
        });
        otherPage.resolve({ ...savedPage, value: [{ ...resource, displayName: "Independent saved resource" }] });
      });
      expect(await denied.findByText("Authorized history sibling")).toBeVisible();
      expect(await independent.findByText("Independent saved resource")).toBeVisible();
      expect(denied.queryByRole("option", { name: /restricted-scope/ })).not.toBeInTheDocument();
    });

    it("does not reattach to a peer-held pre-denial snapshot request after route recovery", async () => {
      const previous = deferred<Awaited<ReturnType<typeof getInventorySnapshots>>>();
      const previousValue = { value: [savedSnapshot, { ...savedSnapshot, id: "old-choice", environmentScope: "old-authority" }] };
      vi.mocked(getInventorySnapshots).mockReturnValueOnce(previous.promise)
        .mockRejectedValueOnce(new ApiError(403, "forbidden", "Snapshot lookup denied."))
        .mockResolvedValue({ value: [savedSnapshot, { ...savedSnapshot, id: "new-choice", environmentScope: "new-authority" }] });
      vi.mocked(getInventoryRefreshJob).mockResolvedValue({ ...runningRefresh, id: "other-job", status: "failed" });
      const client = createSavedQueryClient();
      const view = render(<SavedQueryProvider client={client}><InventoryExplorer canManageQuarantine={false} /></SavedQueryProvider>);
      await waitFor(() => expect(getInventorySnapshots).toHaveBeenCalledOnce());
      const query = client.getQueryCache().find({ queryKey: ["saved", "inventory-snapshots"], exact: false })!;
      const peerController = new AbortController();
      const peer = readSavedQuery(client, query.queryKey.slice(1), signal => getInventorySnapshots({ signal }), peerController.signal);
      void peer.catch(() => undefined);
      const previousSignal = vi.mocked(getInventorySnapshots).mock.calls[0][0]?.signal;
      try {
        window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a&refreshJob=other-job");
        fireEvent.popState(window);
        await screen.findByText("Snapshot lookup denied.");
        expect(previousSignal?.aborted).toBe(false);
        window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a");
        fireEvent.popState(window);
        await waitFor(() => expect(getInventorySnapshots).toHaveBeenCalledTimes(3));
        expect(await screen.findByRole("option", { name: /new-authority/ })).toBeInTheDocument();
        await act(async () => previous.resolve(previousValue));
        await expect(peer).resolves.toEqual(previousValue);
        expect(screen.queryByRole("option", { name: /old-authority/ })).not.toBeInTheDocument();
        expect(screen.getByRole("option", { name: /new-authority/ })).toBeInTheDocument();
      } finally {
        view.unmount();
        peerController.abort();
        client.clear();
      }
    });

    it("clears denied history metadata and its actionable job while retaining authorized inventory", async () => {
      const waiting = { ...runningRefresh, status: "waiting_authorization" as const, message: "Private history job" };
      vi.mocked(getInventoryRefreshJobs).mockResolvedValue({
        value: [waiting], lastAttemptAt: waiting.attemptedAt, lastSuccessAt: waiting.updatedAt,
      });
      render(<InventoryExplorer canManageQuarantine={false} />);
      await screen.findByText("Private history job");
      expect(screen.getByRole("button", { name: "Resume with current authorization" })).toBeEnabled();
      vi.mocked(getInventoryRefreshJobs).mockRejectedValueOnce(new ApiError(403, "forbidden", "Refresh history denied."));
      vi.mocked(getInventorySnapshots).mockResolvedValue({ value: [
        savedSnapshot, { ...savedSnapshot, id: "allowed-snapshot", environmentScope: "newly-authorized-scope" },
      ] });
      fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
      await screen.findByText("Refresh history denied.");
      expect(screen.queryByText("Private history job")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Resume with current authorization" })).not.toBeInTheDocument();
      expect(screen.getByText("Last attempt").parentElement).toHaveTextContent("Not authorized");
      expect(screen.getByText("Last success").parentElement).toHaveTextContent("Not authorized");
      expect(await screen.findByRole("option", { name: /newly-authorized-scope/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "View details for agent-a" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Export filtered inventory CSV" })).toBeEnabled();
      vi.mocked(getInventoryRefreshJobs).mockResolvedValue({
        value: [{ ...waiting, message: "Newly authorized history job" }], lastAttemptAt: waiting.attemptedAt, lastSuccessAt: null,
      });
      fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
      expect(await screen.findByText("Newly authorized history job")).toBeVisible();
      expect(screen.getByRole("button", { name: "Resume with current authorization" })).toBeEnabled();
    });

    it("clears denied selected targets and frozen confirmation despite a late authorized resource sibling", async () => {
      const selection = deferred<Awaited<ReturnType<typeof getInventoryQuarantineSelection>>>();
      vi.mocked(getInventoryQuarantineSelection).mockReturnValueOnce(selection.promise);
      render(<InventoryExplorer />);
      fireEvent.click(await screen.findByRole("checkbox", { name: "Select agent-a for quarantine control" }));
      const page = deferred<Awaited<ReturnType<typeof getInventoryResources>>>();
      vi.mocked(getInventoryResources).mockReturnValueOnce(page.promise);
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "agent" } });
      await waitFor(() => expect(getInventoryResources).toHaveBeenCalledTimes(2));
      fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
      await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
      await act(async () => selection.reject(new ApiError(403, "forbidden", "Exact selected targets denied.")));
      await screen.findByText(/Exact selected targets denied/);
      expect(screen.queryByRole("dialog", { name: "Quarantine 1 agent" })).not.toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Select agent-a for quarantine control" })).not.toBeChecked();
      expect(new URLSearchParams(window.location.search).getAll("selected")).toEqual([]);
      await act(async () => page.resolve(savedPage));
      expect(screen.getByRole("checkbox", { name: "Select agent-a for quarantine control" })).not.toBeChecked();
      expect(screen.getByText("0 of 25 exact Copilot Studio agents selected")).toBeVisible();
      expect(submitQuarantine).not.toHaveBeenCalled();
      const retry = deferred<Awaited<ReturnType<typeof getInventoryQuarantineSelection>>>();
      vi.mocked(getInventoryQuarantineSelection).mockReturnValueOnce(retry.promise);
      fireEvent.click(screen.getByRole("checkbox", { name: "Select agent-a for quarantine control" }));
      await waitFor(() => expect(getInventoryQuarantineSelection).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole("button", { name: "Quarantine selected" })).not.toBeInTheDocument();
      await act(async () => retry.resolve({ value: [resource], snapshot: savedSnapshot }));
      expect(await screen.findByRole("button", { name: "Quarantine selected" })).toBeEnabled();
      expect(screen.queryByText(/Exact selected targets denied/)).not.toBeInTheDocument();
    });

    it("cancels only the history-derived job poll when its history read is denied", async () => {
      vi.useFakeTimers();
      const pending = deferred<Awaited<ReturnType<typeof getInventoryRefreshJob>>>();
      vi.mocked(getInventoryRefreshJobs).mockResolvedValue({
        value: [{ ...runningRefresh, message: "History-owned running job" }],
        lastAttemptAt: runningRefresh.attemptedAt, lastSuccessAt: null,
      });
      vi.mocked(getInventoryRefreshJob).mockReturnValueOnce(pending.promise);
      await act(async () => { render(<InventoryExplorer canManageQuarantine={false} />); });
      expect(screen.getByText("History-owned running job")).toBeVisible();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(getInventoryRefreshJob).toHaveBeenCalledOnce();
      const signal = vi.mocked(getInventoryRefreshJob).mock.calls[0][1]?.signal;
      vi.mocked(getInventoryRefreshJobs).mockRejectedValueOnce(new ApiError(403, "forbidden", "Job history revoked."));
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" })); });
      expect(screen.getByText("Job history revoked.")).toBeVisible();
      expect(signal?.aborted).toBe(true);
      expect(screen.queryByText("History-owned running job")).not.toBeInTheDocument();
      await act(async () => pending.resolve({
        ...runningRefresh, status: "waiting_authorization", message: "Late denied-history job",
      }));
      expect(screen.queryByText("Late denied-history job")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Resume with current authorization" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Refresh selected scope" })).toBeEnabled();
    });

    it("clears a denied polled job and prevents late history from rehydrating its actionability", async () => {
      vi.useFakeTimers();
      const poll = deferred<Awaited<ReturnType<typeof getInventoryRefreshJob>>>();
      const history = deferred<Awaited<ReturnType<typeof getInventoryRefreshJobs>>>();
      vi.mocked(getInventoryRefreshJobs).mockResolvedValue({
        value: [{ ...runningRefresh, message: "Private polled job" }],
        lastAttemptAt: runningRefresh.attemptedAt, lastSuccessAt: null,
      });
      vi.mocked(getInventoryRefreshJob).mockReturnValueOnce(poll.promise);
      await act(async () => { render(<InventoryExplorer canManageQuarantine={false} />); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(getInventoryRefreshJob).toHaveBeenCalledOnce();
      vi.mocked(getInventoryRefreshJobs).mockReturnValueOnce(history.promise);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" })); });
      const historySignal = vi.mocked(getInventoryRefreshJobs).mock.calls[1][0]?.signal;
      await act(async () => poll.reject(new ApiError(403, "forbidden", "Exact refresh job denied.")));
      expect(screen.getByText(/Exact refresh job denied/)).toBeVisible();
      expect(screen.queryByText("Private polled job")).not.toBeInTheDocument();
      expect(historySignal?.aborted).toBe(false);
      await act(async () => history.resolve({
        value: [{ ...runningRefresh, status: "waiting_authorization", message: "Late history must not restore this job" }],
        lastAttemptAt: runningRefresh.attemptedAt, lastSuccessAt: runningRefresh.updatedAt,
      }));
      expect(screen.queryByText("Late history must not restore this job")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Resume with current authorization" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "View details for agent-a" })).toBeVisible();
      expect(screen.getByText("Last success").parentElement).not.toHaveTextContent("None");
    });

    it("retains an independently authorized exact-job read when history is denied", async () => {
      window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a&refreshJob=exact-job");
      const exact = { ...runningRefresh, id: "exact-job", status: "waiting_authorization" as const, message: "Authorized exact job" };
      vi.mocked(getInventoryRefreshJob).mockResolvedValue(exact);
      render(<InventoryExplorer canManageQuarantine={false} />);
      await screen.findByText("Authorized exact job");
      const pending = deferred<Awaited<ReturnType<typeof getInventoryRefreshJob>>>();
      vi.mocked(getInventoryRefreshJob).mockReturnValueOnce(pending.promise);
      vi.mocked(getInventoryRefreshJobs).mockRejectedValueOnce(new ApiError(403, "forbidden", "History-only denial."));
      fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
      await screen.findByText("History-only denial.");
      await waitFor(() => expect(getInventoryRefreshJob).toHaveBeenCalledTimes(2));
      expect(vi.mocked(getInventoryRefreshJob).mock.calls[1][1]?.signal?.aborted).toBe(false);
      await act(async () => pending.resolve({ ...exact, message: "Fresh independently authorized exact job" }));
      expect(await screen.findByText("Fresh independently authorized exact job")).toBeVisible();
      expect(screen.getByRole("button", { name: "Resume with current authorization" })).toBeEnabled();
      expect(screen.getByText("Last attempt").parentElement).toHaveTextContent("Not authorized");
    });

    it("retains an independently authorized action result when its history sibling is denied", async () => {
      vi.mocked(refreshInventory).mockResolvedValue({
        ...runningRefresh, status: "waiting_authorization", message: "Explicitly accepted refresh job",
      });
      render(<InventoryExplorer canManageQuarantine={false} />);
      await screen.findByText("Authorized Power Platform query verified");
      vi.mocked(getInventoryRefreshJobs).mockRejectedValueOnce(new ApiError(403, "forbidden", "History denied after command."));
      fireEvent.click(screen.getByRole("button", { name: "Refresh selected scope" }));
      await screen.findByText("History denied after command.");
      expect(screen.getByText("Explicitly accepted refresh job")).toBeVisible();
      expect(screen.getByRole("button", { name: "Resume with current authorization" })).toBeEnabled();
      expect(screen.getByText("Last attempt").parentElement).toHaveTextContent("Not authorized");
      expect(refreshInventory).toHaveBeenCalledOnce();
    });

    it("rediscovers authorized history after leaving a pending exact-job lookup", async () => {
      window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a&refreshJob=pending-job");
      const pending = deferred<Awaited<ReturnType<typeof getInventoryRefreshJob>>>();
      vi.mocked(getInventoryRefreshJob).mockReturnValueOnce(pending.promise);
      const history = { ...runningRefresh, id: "history-job", status: "waiting_authorization" as const, message: "Authorized fallback history job" };
      vi.mocked(getInventoryRefreshJobs).mockResolvedValue({ value: [history], lastAttemptAt: history.attemptedAt, lastSuccessAt: null });
      render(<InventoryExplorer canManageQuarantine={false} />);
      await waitFor(() => expect(getInventoryRefreshJob).toHaveBeenCalledOnce());
      const signal = vi.mocked(getInventoryRefreshJob).mock.calls[0][1]?.signal;
      window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a");
      fireEvent.popState(window);
      expect(await screen.findByText("Authorized fallback history job")).toBeVisible();
      expect(signal?.aborted).toBe(true);
      await act(async () => pending.resolve({ ...history, id: "pending-job", message: "Obsolete exact job" }));
      expect(screen.queryByText("Obsolete exact job")).not.toBeInTheDocument();
      expect(screen.getByText("Authorized fallback history job")).toBeVisible();
    });

    it("retains authorized saved metadata after an ordinary temporary outage", async () => {
      const waiting = { ...runningRefresh, status: "waiting_authorization" as const, message: "Previously authorized history job" };
      vi.mocked(getInventoryRefreshJobs).mockResolvedValue({
        value: [waiting], lastAttemptAt: waiting.attemptedAt, lastSuccessAt: null,
      });
      render(<InventoryExplorer canManageQuarantine={false} />);
      await screen.findByText("Previously authorized history job");
      vi.mocked(getInventoryRefreshJobs).mockRejectedValueOnce(new ApiError(503, "temporarily_unavailable", "History temporarily unavailable."));
      fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
      await screen.findByText("History temporarily unavailable.");
      expect(screen.getByText("Previously authorized history job")).toBeVisible();
      expect(screen.getByRole("button", { name: "Resume with current authorization" })).toBeEnabled();
      expect(screen.getByText("Last attempt").parentElement).not.toHaveTextContent("Not authorized");
    });
  });

  it("shows verified stored/provider counts and all-requested environment scope independently of missing role hints and display filters", async () => {
    window.history.replaceState({}, "", "/power-platform?snapshot=snapshot-a&q=agent&environment=display-filter&page=2");
    const snapshot = {
      ...savedSnapshot, roleScope: "unknown" as const,
      observedCount: 4178, totalRecords: 4178, pageCount: 42,
      observedAt: "2026-09-17T05:30:00.000Z",
      requestedTypes: [...powerPlatformResourceTypes],
      coverage: powerPlatformResourceTypes.map(type => ({
        type, status: "covered" as const,
        count: type === "microsoft.copilotstudio/agents" ? 1247 : type === "microsoft.powerapps/canvasapps" ? 2931 : 0,
      })),
      verification: createInventoryVerification(4178, [...powerPlatformResourceTypes], "2026-09-17T06:00:00.000Z"),
    };
    vi.mocked(getInventoryResources).mockResolvedValue({ ...savedPage, snapshot, count: 51 });
    render(<InventoryExplorer />);
    await screen.findByText("Authorized Power Platform query verified");
    expect(screen.getByText("Resources stored / provider total").nextElementSibling).toHaveTextContent("4,178 / 4,178");
    expect(screen.getByText("Unique resource identities").nextElementSibling).toHaveTextContent("4,178");
    expect(screen.getByText("Provider pages collected").nextElementSibling).toHaveTextContent("42");
    expect(screen.getByText("Power Platform agents observed").nextElementSibling).toHaveTextContent("1,247");
    expect(screen.getByText("Environment request scope").nextElementSibling).toHaveTextContent("All environments requested");
    expect(screen.getByText("Optional directory-role hint").nextElementSibling).toHaveTextContent("Not supplied");
    expect(screen.getByText("Power Platform collected at").nextElementSibling?.querySelector("time")).toHaveAttribute("datetime", snapshot.observedAt);
    expect(screen.getByText("Saved request verified at").nextElementSibling?.querySelector("time")).toHaveAttribute("datetime", snapshot.verification.checkedAt);
    expect(screen.queryByText(/Stale saved source observation|unknown role coverage|partial completion/i)).not.toBeInTheDocument();
    expect(screen.getByText(/classic\/V1 bots.*20 minutes/)).toBeVisible();
    expect(getInventoryResources).toHaveBeenCalledWith(expect.objectContaining({ environmentId: "display-filter", search: "agent", offset: 50 }), expect.anything());
    expect(refreshInventory).not.toHaveBeenCalled();
  });

  it("re-verifies the selected saved snapshot without provider work and hides prior green verification during pending and failed reads", async () => {
    render(<InventoryExplorer />);
    await screen.findByText("Authorized Power Platform query verified");
    await waitFor(() => expect(screen.getByRole("button", { name: "Verify saved inventory" })).toBeEnabled());
    let rejectRead!: (error: Error) => void;
    vi.mocked(getInventoryResources).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    const before = vi.mocked(getInventoryResources).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
    expect(screen.getByRole("button", { name: "Verifying saved inventory..." })).toBeDisabled();
    expect(screen.queryByText("Authorized Power Platform query verified")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resource type coverage")).not.toBeInTheDocument();
    await waitFor(() => expect(getInventoryResources).toHaveBeenCalledTimes(before + 1));
    await act(async () => rejectRead(new Error("Saved row uniqueness verification failed.")));
    expect(screen.queryByText("Authorized Power Platform query verified")).not.toBeInTheDocument();
    const receipt = within(screen.getByRole("region", { name: "Saved Power Platform query verification" }));
    expect(receipt.getByRole("alert")).toHaveTextContent("Saved row uniqueness verification failed.");
    expect(screen.getByText("Matching resources").nextElementSibling).toHaveTextContent("Not verified");
    expect(screen.getByText("Verified type queries").nextElementSibling).toHaveTextContent("Not established");
    fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
    await screen.findByText("Authorized Power Platform query verified");
    expect(getInventoryResources).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotId: "snapshot-a" }), expect.anything());
    expect(refreshInventory).not.toHaveBeenCalled();
    expect(resumeInventoryRefresh).not.toHaveBeenCalled();
    expect(getQuarantineStatus).not.toHaveBeenCalled();
  });

  it("uses persisted executed types rather than requested types or a later broader role hint", async () => {
    let snapshot: InventorySnapshot = {
      ...savedSnapshot,
      requestedTypes: ["microsoft.copilotstudio/agents", "microsoft.powerapps/apps"],
      coverage: [
        { type: "microsoft.copilotstudio/agents", status: "covered", count: 1 },
        { type: "microsoft.powerapps/apps", status: "not_authorized_scope", count: null },
      ],
      verification: createInventoryVerification(1, ["microsoft.copilotstudio/agents"]),
    };
    vi.mocked(getInventoryResources).mockImplementation(async () => ({ ...savedPage, snapshot, typeCounts: snapshot.coverage }));
    vi.mocked(getInventorySnapshots).mockResolvedValue({ value: [snapshot] });
    render(<InventoryExplorer />);
    await screen.findByText("Authorized Power Platform query verified");
    expect(screen.getByText("Resource types requested").nextElementSibling).toHaveTextContent(/^2$/);
    expect(screen.getByText("Actual resource types queried").nextElementSibling).toHaveTextContent(/^1$/);
    expect(screen.getByText(/Not every requested type was executed/)).toBeVisible();
    const executedTypes = screen.getByText("Actual queried resource types").closest("details")!;
    expect(within(executedTypes).getByText("microsoft.copilotstudio/agents")).toBeInTheDocument();
    expect(within(executedTypes).queryByText("microsoft.powerapps/apps")).not.toBeInTheDocument();

    snapshot = { ...snapshot, roleScope: "full" };
    fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
    await waitFor(() => expect(screen.getByText("Optional directory-role hint").nextElementSibling).toHaveTextContent("Full (hint only)"));
    expect(screen.getByText("Actual resource types queried").nextElementSibling).toHaveTextContent(/^1$/);
    const excludedType = screen.getByLabelText("Resource type coverage").querySelector('[title="microsoft.powerapps/apps"]')!;
    expect(excludedType).toHaveTextContent("Not queried (role scope)");
    expect(excludedType).not.toHaveTextContent(/\b0\b/);
    expect(refreshInventory).not.toHaveBeenCalled();
  });

  it("does not turn an absent snapshot into verified coverage or zero resource/type counts", async () => {
    vi.mocked(getInventoryResources).mockResolvedValue({ value: [], count: 0, typeCounts: [], snapshot: null });
    vi.mocked(getInventorySnapshots).mockResolvedValue({ value: [] });
    render(<InventoryExplorer />);
    await screen.findByText("No saved inventory");
    expect(screen.getByText("Matching resources").nextElementSibling).toHaveTextContent("Unknown");
    expect(screen.getByText("Verified type queries").nextElementSibling).toHaveTextContent("Not established");
    expect(screen.getByText("Scope-excluded types").nextElementSibling).toHaveTextContent("Not established");
    expect(screen.queryByText("Authorized Power Platform query verified")).not.toBeInTheDocument();
    expect(screen.getByText(/Collection counts and request coverage are not established/)).toBeVisible();
  });

  it("does not reuse a prior empty result as a proven zero after a saved verification fails", async () => {
    vi.mocked(getInventoryResources).mockResolvedValue({ ...savedPage, value: [], count: 0 });
    render(<InventoryExplorer />);
    await screen.findByText("No matching resources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Verify saved inventory" })).toBeEnabled());
    vi.mocked(getInventoryResources).mockRejectedValueOnce(new Error("Saved totals could not be verified."));
    fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
    await waitFor(() => expect(screen.getByText("Matching resources").nextElementSibling).toHaveTextContent("Not verified"));
    expect(screen.queryByText("No matching resources")).not.toBeInTheDocument();
    expect(screen.getByText("A current matching count is not established.")).toBeVisible();
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

  it.each([
    { createdIn: "copilotStudio", authoringTool: "Copilot Studio" },
    { createdIn: "FutureProvider.vNext_build-X", authoringTool: null },
    { createdIn: undefined, authoringTool: "Agent Builder" },
  ])("preserves raw provider origin $createdIn separately from normalized authoring", ({ createdIn, authoringTool }) => {
    render(<PowerPlatformResourceData resource={{
      ...resource, authoringTool,
      details: { ...resource.details, ...(createdIn === undefined ? {} : { createdIn }) },
    }} />);
    expect(screen.getByText("Provider origin (raw)").nextElementSibling).toHaveTextContent(createdIn ?? "Not supplied");
    expect(screen.getByText("Authoring tool").nextElementSibling).toHaveTextContent(authoringTool ?? "Not supplied");
    expect(getInventoryResources).not.toHaveBeenCalled();
    expect(getQuarantineStatus).not.toHaveBeenCalled();
  });

  it("submits a provider refresh only after the explicit scoped command", async () => {
    render(<InventoryExplorer packages={[]} />);
    await waitFor(() => expect(getInventoryRefreshJobs).toHaveBeenCalledTimes(1));
    expect(refreshInventory).not.toHaveBeenCalled();
    expect(screen.queryByRole("option", { name: "Copilot Studio agents" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Refresh resource scope"), { target: { value: "microsoft.powerapps/canvasapps" } });
    fireEvent.change(screen.getByLabelText("Refresh environment scope"), { target: { value: "environment-a" } });
    fireEvent.click(screen.getByRole("button", { name: /Refresh selected scope/ }));
    await waitFor(() => expect(refreshInventory).toHaveBeenCalledTimes(1));
    expect(refreshInventory).toHaveBeenCalledWith({ types: ["microsoft.powerapps/canvasapps"], environmentId: "environment-a" });
  });

  it("keeps broad Power Platform refreshes non-agent scoped", async () => {
    render(<InventoryExplorer packages={[]} />);
    await screen.findByLabelText("Refresh resource scope");
    fireEvent.click(screen.getByRole("button", { name: /Refresh selected scope/ }));
    await waitFor(() => expect(refreshInventory).toHaveBeenCalledTimes(1));
    const request = vi.mocked(refreshInventory).mock.calls[0]![0];
    expect(request?.types?.length).toBeGreaterThan(0);
    expect(request?.types).not.toContain("microsoft.copilotstudio/agents");
  });

  it("displays the first saved snapshot after a 42-page refresh completes", async () => {
    const complete = { ...runningRefresh, status: "succeeded" as const, snapshotId: "snapshot-new", pageCount: 42, observedCount: 4_140, totalRecords: 4_140 };
    const snapshot = { ...savedSnapshot, id: complete.snapshotId, pageCount: 42, observedCount: 4_140, totalRecords: 4_140, verification: createInventoryVerification(4140) };
    vi.mocked(getInventoryResources).mockImplementation(async query => query?.snapshotId === snapshot.id
      ? { ...savedPage, count: 4_140, snapshot }
      : { value: [], count: 0, typeCounts: [], snapshot: null });
    vi.mocked(getInventoryRefreshJob).mockResolvedValue(complete);
    vi.mocked(getInventorySnapshots).mockResolvedValue({ value: [snapshot] });
    render(<InventoryExplorer />);
    expect(await screen.findByText("No saved inventory")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Refresh selected scope/ }));
    await waitFor(() => expect(screen.getByText("42 pages, 4140 of 4140 resources observed")).toBeVisible(), { timeout: 3_000 });
    expect(await screen.findByText("agent-a")).toBeVisible();
    expect(screen.queryByText("No saved inventory")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Saved scope")).toHaveValue(snapshot.id);
  });

  it("replaces an older pinned snapshot with the exact refreshed scope and clears old paging and selections", async () => {
    const snapshot = { ...savedSnapshot, id: "snapshot-new", environmentScope: "narrow-environment" };
    const nextPage = { ...savedPage, snapshot, value: [{ ...resource, nativeId: "agent-new" }] };
    vi.mocked(getInventoryResources).mockImplementation(async query => query?.snapshotId === snapshot.id ? nextPage : { ...savedPage, count: 100 });
    vi.mocked(getInventoryRefreshJob).mockResolvedValue({ ...runningRefresh, status: "succeeded", snapshotId: snapshot.id, pageCount: 1, observedCount: 1, totalRecords: 1 });
    vi.mocked(getInventorySnapshots).mockResolvedValue({ value: [savedSnapshot, snapshot] });
    render(<InventoryExplorer />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Select agent-a for quarantine/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next inventory page" }));
    await waitFor(() => expect(getInventoryResources).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotId: savedSnapshot.id, offset: 50 }), expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: /Refresh selected scope/ }));
    await waitFor(() => expect(screen.getByText("agent-new")).toBeVisible(), { timeout: 3_000 });
    expect(getInventoryResources).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotId: snapshot.id, offset: 0 }), expect.anything());
    expect(screen.getByLabelText("Saved scope")).toHaveValue(snapshot.id);
    expect(screen.getByText("0 of 25 exact Copilot Studio agents selected")).toBeVisible();
    expect(new URLSearchParams(window.location.search).getAll("selected")).toEqual([]);
    expect(screen.queryByText("agent-a")).not.toBeInTheDocument();
  });

  it("preserves the previous snapshot when the next refresh fails before complete publication", async () => {
    vi.mocked(getInventoryRefreshJob).mockResolvedValue({
      ...runningRefresh, status: "failed", pageCount: 41, observedCount: 4_100, totalRecords: 4_140, message: "Incomplete provider enumeration",
    });
    render(<InventoryExplorer />);
    expect(await screen.findByText("agent-a")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Refresh selected scope/ }));
    await waitFor(() => expect(screen.getByText("Incomplete provider enumeration")).toBeVisible(), { timeout: 3_000 });
    expect(screen.getByLabelText("Saved scope")).toHaveValue(savedSnapshot.id);
    expect(screen.getByText("agent-a")).toBeVisible();
    expect(screen.queryByText("No saved inventory")).not.toBeInTheDocument();
  });

  it("disables duplicate submissions and follows an immediately completed refresh instead of a stale job deep link", async () => {
    window.history.replaceState({}, "", "/power-platform?refreshJob=job-old");
    vi.mocked(getInventoryRefreshJob).mockResolvedValue({ ...runningRefresh, id: "job-old", status: "failed" });
    const snapshot = { ...savedSnapshot, id: "snapshot-immediate" };
    vi.mocked(getInventorySnapshots).mockResolvedValue({ value: [savedSnapshot, snapshot] });
    vi.mocked(getInventoryResources).mockImplementation(async query => query?.snapshotId === snapshot.id
      ? { ...savedPage, snapshot, value: [{ ...resource, nativeId: "agent-immediate" }] } : savedPage);
    let resolveRefresh!: (value: Awaited<ReturnType<typeof refreshInventory>>) => void;
    vi.mocked(refreshInventory).mockReturnValue(new Promise(resolve => { resolveRefresh = resolve; }));
    render(<InventoryExplorer />);
    expect(await screen.findByText("Failed")).toBeVisible();
    const refresh = screen.getByRole("button", { name: /Refresh selected scope/ });
    fireEvent.click(refresh);
    expect(refresh).toBeDisabled();
    fireEvent.click(refresh);
    expect(refreshInventory).toHaveBeenCalledOnce();
    await act(async () => resolveRefresh({ ...runningRefresh, status: "succeeded", snapshotId: snapshot.id, pageCount: 1, observedCount: 1, totalRecords: 1 }));
    expect(await screen.findByText("agent-immediate")).toBeVisible();
    expect(new URLSearchParams(window.location.search).has("refreshJob")).toBe(false);
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(refresh).toBeEnabled();
  });

  it("does not present the collection tenant as connector source ownership", async () => {
    vi.mocked(getInventoryResources).mockResolvedValue({
      ...savedPage,
      value: [{ ...resource, type: "microsoft.powerplatformconnector/connectors", environmentId: null, details: { sourceTenantId: "" } }],
    });
    render(<InventoryExplorer packages={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "View details for agent-a" }));
    const dialog = screen.getByRole("dialog", { name: "agent-a" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Power Platform" }));
    const sourceTenant = within(dialog).getByText("Source tenant ID").parentElement!;
    expect(within(sourceTenant).getByText("Not supplied")).toBeInTheDocument();
    expect(within(sourceTenant).queryByText(resource.tenantId)).not.toBeInTheDocument();
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
    render(<InventoryExplorer packages={[]} />, { reactStrictMode: true });
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
    await waitFor(() => expect(getQuarantineStatus).toHaveBeenCalledWith("snapshot-a", "agent-a", false, { signal: expect.any(AbortSignal) }));
    expect(screen.getByText(/Direct and inventory states disagree/)).toBeInTheDocument();
  });

  it("allows Viewer direct-status reads without rendering quarantine mutations", async () => {
    render(<InventoryExplorer packages={[]} canManageQuarantine={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "View details for agent-a" }));
    const dialog = screen.getByRole("dialog", { name: "agent-a" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Controls" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Check direct status" }));

    await waitFor(() => expect(getQuarantineStatus).toHaveBeenCalledOnce());
    expect(within(dialog).getByText("Quarantined", { exact: true })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Quarantine" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Restore from quarantine" })).not.toBeInTheDocument();
  });

  it("shows an exact frozen preview and requires target confirmation", async () => {
    vi.mocked(previewQuarantine).mockResolvedValue(quarantinePreview());
    render(<InventoryExplorer packages={[]} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select agent-a for quarantine control" }));
    fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    expect(previewQuarantine).toHaveBeenCalledExactlyOnceWith(
      { action: "quarantine", snapshotId: "snapshot-a", resourceNativeIds: ["agent-a"] },
      { signal: expect.any(AbortSignal) },
    );
    expect(within(dialog).getByText(`${environmentId} / ${botId}`)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox")).toBeEnabled();
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

  it("submits the confirmed frozen native target with a caller-owned idempotency key", async () => {
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

function quarantinePreview() {
  return { confirmationHash: "c".repeat(64), statuses: [quarantineStatus()], summary: { risk: true as const, operation: "quarantine" as const, provider: "Power Platform Copilot Studio" as const, endpoint: "api-version=1 botQuarantine" as const, permission: "Delegated CopilotStudio.AdminActions.Invoke" as const, targetCount: 1, targetSelectionHash: "d".repeat(64), actor: { id: "admin-a", displayName: "Admin", username: "admin@example.invalid" }, packageControlIndependent: true as const, makerBehavior: "Makers may still see and test this bot while connected channels cannot use it.", providerAtomicity: false as const, targets: [{ resourceNativeId: "agent-a", displayName: "agent-a", environmentId, botId, currentState: false, currentProviderUpdatedAt: "2026-09-09T10:00:00.123Z", requestedState: true, inventoryState: false, inventoryObservedAt: savedSnapshot.observedAt }], additionalTargetCount: 0 } };
}

function quarantineJob() {
  const preview = quarantinePreview();
  return { id: "job-a", action: "quarantine" as const, status: "queued" as const, confirmationHash: preview.confirmationHash, confirmation: preview.summary, isCanary: false, total: 1, completed: 0, succeeded: 0, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0, canResume: false, canReconcile: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), results: [] };
}