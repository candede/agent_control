import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isCancelledError } from "@tanstack/react-query";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions, workbenchViews } from "../../backend/src/services/workbenchMetadata";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import App from "./App";
import {
  getAgents,
  getUnifiedAgents,
  getAgentDetails,
  powerPlatformResourceTypes,
  type BulkActionJob,
  type AutomaticRefreshResult,
  type CopilotPackage,
  type InventoryRefreshJob,
  type PackagePage,
  type PackageMutationPreview,
  type PackageRefreshJob,
  type PowerPlatformResource,
  type QuarantineJob,
  type SessionUser,
  type UnifiedAgentInventoryPage,
  type UnifiedAgentRecord,
} from "./api/client";
import { restorePackageSelection, storePackageSelection } from "./packageSelectionSession";
import * as savedQueries from "./savedQueries";
import { AgentInventoryQueries } from "./agentInventoryQueries";
import { mockNativeDialogs } from "./test/dialog";
import { selectedAgentsPage, selectedFixtureRead, selectedHistoryPage, selectedReportUsersPage, selectedUsersPage } from "./test/selectedUsageFixture";
import type { ReportHistorySet, ReportPage } from "../../backend/src/types/officialReportData";
import { createInventoryVerification, createUnifiedVerification, inventoryPageMetadata } from "./test/inventoryVerification";
import { responsibilityFixture, responsibilityOwnerId } from "./test/agentResponsibilityFixture";
import { unifiedAgentInventoryScopes } from "../../backend/src/types/unifiedAgents";
import { decodeInventoryFacet, encodeInventoryFacet } from "../../backend/src/types/inventoryFacets";

mockNativeDialogs();

const viewer: SessionUser = {
  displayName: "Current viewer",
  username: "viewer@example.invalid",
  homeAccountId: "viewer-1",
  tenantId: "tenant-1",
  roles: ["AgentControl.Viewer"],
};

function activeBulkJobStorageKey(user: SessionUser = viewer) {
  return `agent-control:active-bulk-job:v2:${encodeURIComponent(user.tenantId ?? "")}:${encodeURIComponent(user.homeAccountId)}`;
}

function automaticRefreshResponse(overrides: Partial<AutomaticRefreshResult> = {}): AutomaticRefreshResult {
  return {
    run: null, detailJob: null,
    revisions: { users: "users-1", graph_packages: "packages-1", power_platform: "power-platform-1" },
    nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

const agent: CopilotPackage = {
  id: "package-private",
  displayName: "Sensitive cached agent",
  isBlocked: false,
  sourceSystem: "graph_packages",
  authoringTool: null,
  creatorType: "unknown",
  agentKind: "copilot_package",
  lifecycle: "unknown",
  identityConfidence: "exact_native",
  provenance: {},
};

let packagePage: PackagePage;
let unifiedPage: UnifiedAgentInventoryPage;
const inventorySelections = new Map<string, { query: Record<string, string>; selection: UnifiedAgentInventoryPage["selection"] }>();

const createPackagePage = (): PackagePage => ({
  value: [agent],
  counts: { total: 1, scoped: 1, filtered: 1 },
  selection: { id: "11111111-1111-4111-8111-111111111111", revision: "1",
    evaluatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() },
  page: { limit: 50, nextCursor: null, previousCursor: null },
  freshness: { state: "current", capturedRevision: "1", sources: [] },
  mode: "delegated",
});

const unifiedRevision = "a".repeat(64);
const inventoryFacets = {
  environmentId: [{ value: "env-a", label: "Finance" }, { value: "env-b", label: "Development" }],
  platform: [{ value: "studio", label: "Copilot Studio" }],
  type: [{ value: "firstParty", label: "1st party agents" }, { value: "thirdParty", label: "3rd party agents" }],
};
const createUnifiedPage = (): UnifiedAgentInventoryPage => ({
  ...inventoryPageMetadata({ total: 1, scoped: 1, filtered: 1, packageTargets: 1 }, new Date(Date.now() + 600_000).toISOString()),
  inventoryScope: "catalog",
  selection: { id: unifiedRevision, revision: unifiedRevision, evaluatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() },
  page: { limit: 50, nextCursor: null, previousCursor: null },
  verification: createUnifiedVerification({ graphPackageCount: 1, powerPlatformAgentCount: 0, logicalAgentCount: 1 }, { sourceScopes: false }),
  value: [{
    id: "graph_packages:package-private",
    displayName: agent.displayName,
    presence: "graph_packages",
    environmentId: null,
    packages: [agent],
    powerPlatformResource: null,
    identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: "No verified Power Platform link is present in saved package detail metadata." },
    observations: {
      graphPackages: {
        id: "snapshot-private",
        snapshotId: "snapshot-private",
        observedAt: packagePage.selection.evaluatedAt,
        expiresAt: packagePage.selection.expiresAt,
        current: true,
        tokenMode: "delegated",
        scopeKind: "broad",
        observedCount: 1,
        totalRecords: 1,
      },
      packageSnapshots: {},
      powerPlatform: null,
    },
  }],
  summary: { total: 1, linked: 0, graphOnly: 1, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 },
  scopeSummary: { total: 1, linked: 0, graphOnly: 1, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 },
  filteredSummary: { total: 1, linked: 0, graphOnly: 1, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 },
  sources: {
    graphPackages: {
      state: "available",
      observation: {
        id: "snapshot-private",
        snapshotId: "snapshot-private",
        observedAt: packagePage.selection.evaluatedAt,
        expiresAt: packagePage.selection.expiresAt,
        current: true,
        tokenMode: "delegated",
        scopeKind: "broad",
        observedCount: 1,
        totalRecords: 1,
      },
      error: null,
    },
    powerPlatform: {
      state: "unavailable",
      observation: null,
      error: { source: "power_platform", code: "snapshot_unavailable", message: "No saved Power Platform inventory." },
    },
  },
  partial: true,
  errors: [{ source: "power_platform", code: "snapshot_unavailable", message: "No saved Power Platform inventory." }],
});

function resetInventoryFixtures() {
  inventorySelections.clear();
  packagePage = createPackagePage();
  unifiedPage = createUnifiedPage();
}

function powerPlatformSnapshot(): NonNullable<UnifiedAgentRecord["observations"]["powerPlatform"]> {
  const now = Date.now();
  return {
    id: "pp-snapshot",
    snapshotId: "pp-snapshot",
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 24 * 60 * 60_000).toISOString(),
    current: true,
    roleScope: "full",
    environmentScope: null,
    coverage: "covered",
    coveredCount: 2,
    observedCount: 2,
    totalRecords: 2,
    pageCount: 1,
    verification: createInventoryVerification(2),
  };
}

function powerPlatformRecord(nativeId: string, displayName: string): UnifiedAgentRecord {
  const environmentId = "11111111-1111-4111-8111-111111111111";
  const resource: PowerPlatformResource = {
    tenantId: "tenant-1",
    nativeId,
    type: "microsoft.copilotstudio/agents",
    location: null,
    displayName,
    environmentId,
    createdAt: null,
    createdBy: null,
    lastPublishedAt: null,
    sourceSystem: "power_platform",
    authoringTool: "Copilot Studio",
    creatorType: "unknown",
    agentKind: "copilot_studio_agent",
    lifecycle: "published",
    identityConfidence: "exact_native",
    identifiers: [
      { kind: "environment_id", value: environmentId },
      { kind: "cds_bot_id", value: nativeId },
    ],
    quarantineIdentity: { environmentId, botId: nativeId },
    provenance: {},
    details: { isQuarantined: false },
    unknownFieldCount: 0,
  };
  return {
    id: `power_platform:${environmentId}:${nativeId}`,
    displayName,
    presence: "power_platform",
    environmentId,
    packages: [],
    powerPlatformResource: resource,
    identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: "No package link." },
    observations: { graphPackages: null, packageSnapshots: {}, powerPlatform: powerPlatformSnapshot() },
  };
}

function unifiedRecordsPage(records: UnifiedAgentRecord[], count = records.length): UnifiedAgentInventoryPage {
  const packageCount = new Set(records.flatMap(record => record.packages.map(item => item.id))).size;
  const nativeCount = new Set(records.flatMap(record => record.powerPlatformResource ? [`${record.powerPlatformResource.environmentId}:${record.powerPlatformResource.nativeId}`] : [])).size;
  const additionalRows = Math.max(0, count - records.length);
  return {
    ...unifiedPage,
    value: records,
    counts: { total: count, scoped: count, filtered: count, packageTargets: packageCount },
    verification: createUnifiedVerification({
      graphPackageCount: packageCount + (packageCount > 0 ? additionalRows : 0),
      powerPlatformAgentCount: nativeCount + (packageCount === 0 ? additionalRows : 0),
      logicalAgentCount: count,
    }),
    summary: { total: count, linked: 0, graphOnly: records.filter(item => item.presence === "graph_packages").length, powerPlatformOnly: records.filter(item => item.presence === "power_platform").length, ambiguous: 0, conflicting: 0 },
    filteredSummary: { total: count, linked: 0, graphOnly: records.filter(item => item.presence === "graph_packages").length, powerPlatformOnly: records.filter(item => item.presence === "power_platform").length, ambiguous: 0, conflicting: 0 },
    sources: {
      ...unifiedPage.sources,
      powerPlatform: { state: "available", observation: powerPlatformSnapshot(), error: null },
    },
    partial: false,
    errors: [],
  };
}

function verifiedSavedAgentPage(): UnifiedAgentInventoryPage {
  const collectedAt = "2026-09-17T05:30:00.000Z";
  const summary = { total: 1561, linked: 690, graphOnly: 314, powerPlatformOnly: 557, ambiguous: 0, conflicting: 0 };
  const graph = unifiedPage.sources.graphPackages.observation;
  if (!graph || !("scopeKind" in graph)) throw new Error("Expected a saved Graph observation");
  return {
    ...unifiedPage, counts: { total: 1561, scoped: 1004, filtered: 1, packageTargets: 1 }, summary, filteredSummary: { ...summary, total: 1 },
    identityCollection: { checkedPackages: 1010, pendingPackages: 0 },
    verification: createUnifiedVerification({ graphPackageCount: 1010, powerPlatformAgentCount: 1247, logicalAgentCount: 1561 }),
    sources: {
      graphPackages: { state: "available", error: null, observation: { ...graph, observedAt: collectedAt, observedCount: 1010, totalRecords: 1010 } },
      powerPlatform: { state: "available", error: null, observation: {
        ...powerPlatformSnapshot(), roleScope: "unknown", observedAt: collectedAt,
        observedCount: 4178, totalRecords: 4178, coveredCount: 1247, pageCount: 42,
        verification: createInventoryVerification(4178, [...powerPlatformResourceTypes]),
      } },
    },
    partial: false, errors: [],
  };
}

function quarantineJob(id = "quarantine-job"): QuarantineJob {
  const now = "2026-09-15T08:00:00.000Z";
  return {
    id,
    action: "quarantine",
    status: "succeeded",
    confirmationHash: "c".repeat(64),
    confirmation: {
      risk: true,
      operation: "quarantine",
      provider: "Power Platform Copilot Studio",
      endpoint: "api-version=1 botQuarantine",
      permission: "Delegated CopilotStudio.AdminActions.Invoke",
      targetCount: 1,
      targetSelectionHash: "d".repeat(64),
      actor: { id: "viewer-1", displayName: "Admin", username: viewer.username },
      packageControlIndependent: true,
      makerBehavior: "Makers retain authoring access.",
      providerAtomicity: false,
      targets: [],
      additionalTargetCount: 0,
    },
    isCanary: false,
    total: 1,
    completed: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    inconclusive: 0,
    cancelled: 0,
    canResume: false,
    canReconcile: false,
    createdAt: now,
    updatedAt: now,
    results: [],
  };
}

function inventoryRefreshJob(status: InventoryRefreshJob["status"], id = "inventory-refresh"): InventoryRefreshJob {
  const now = "2026-09-15T08:00:00.000Z";
  return {
    id,
    status,
    roleScope: "full",
    environmentScope: null,
    requestedTypes: ["microsoft.copilotstudio/agents"],
    pageCount: status === "succeeded" ? 1 : 0,
    observedCount: status === "succeeded" ? 1 : 0,
    totalRecords: status === "succeeded" ? 1 : null,
    unknownFieldCount: 0,
    snapshotId: status === "succeeded" ? "pp-snapshot-refreshed" : null,
    createdAt: now,
    attemptedAt: now,
    updatedAt: now,
    finishedAt: status === "succeeded" ? now : null,
  };
}

describe("App session revalidation", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/agents");
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetInventoryFixtures();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["not_collected", "preparing"] as const)("shows first-login %s inventory without errors and recovers without a click", async state => {
    vi.useFakeTimers();
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    let ready = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/agent-inventory/selections" && !ready) {
        return Response.json({ state, message: "Waiting for the first inventory publication." });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByRole("heading", { name: state === "preparing" ? "Preparing agent inventory" : "No saved agent inventory yet" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Sync" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No matching agents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Agent inventory pages" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    expect(transport.fetchMock.mock.calls.some(([input]) => input.startsWith("/api/agent-inventory?"))).toBe(false);
    const captures = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections").length;
    const initial = captures();
    expect(initial).toBeLessThanOrEqual(3);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(captures()).toBe(initial);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(captures()).toBe(initial);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(captures()).toBe(initial + 1);
    ready = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByRole("checkbox", { name: `Select ${unifiedPage.value[0].displayName}` })).toBeVisible();
    expect(screen.queryByRole("heading", { name: /Preparing agent inventory|No saved agent inventory yet/ })).not.toBeInTheDocument();
    const completed = captures();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(captures()).toBe(completed);
    expect(transport.fetchMock.mock.calls.some(([input]) => input === "/api/agents/refresh-jobs")).toBe(false);
  });

  it("keeps genuine selection invalidation explicit and stops first-inventory polling on failure", async () => {
    vi.useFakeTimers();
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    let failed = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/agent-inventory/selections") return failed
        ? Response.json({ code: "selection_invalidated", detail: "selection_invalidated" }, { status: 409 })
        : Response.json({ state: "preparing", message: "Preparing the first inventory." });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    failed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText("The saved inventory selection is no longer available. Reload saved inventory.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Agent inventory unavailable" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "No matching agents" })).not.toBeInTheDocument();
    const captures = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections").length;
    const stopped = captures();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(captures()).toBe(stopped);
  });

  it("refreshes Users, Agents and Sync history on automatic publications without opening a workflow", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/users");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    let version = 1;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/auto-refresh") return Response.json(automaticRefreshResponse({
        revisions: { users: `users-${version}`, graph_packages: `packages-${version}`, power_platform: `pp-${version}` },
      }));
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        const page = structuredClone(unifiedPage);
        page.value[0].displayName = `Published agent ${version}`;
        return Response.json(page);
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const count = (path: string) => transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === path).length;
    const usersBefore = count("/api/copilot-usage/users");
    expect(usersBefore).toBeGreaterThan(0);
    expect(count("/api/data-sync/auto-refresh")).toBe(1);
    expect(count("/api/agent-inventory")).toBe(0);
    expect(count("/api/agents")).toBe(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    version = 2;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(count("/api/copilot-usage/users")).toBe(usersBefore + 1);
    expect(count("/api/agent-inventory")).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Published agent 2")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const historyBefore = count("/api/workbench/jobs");
    version = 3;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(count("/api/workbench/jobs")).toBeGreaterThan(historyBefore);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toEqual([]);
    expect(transport.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")
      .every(([input]) => ["/api/data-sync/auto-refresh", "/api/capabilities/check", "/api/agent-inventory/selections"].includes(input))).toBe(true);
  });

  it("defers unused inventory reads across repeated checks and loads the latest revision when Agents opens", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/users");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    let version = 1;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/auto-refresh") return Response.json(automaticRefreshResponse({
        revisions: { ...automaticRefreshResponse().revisions, graph_packages: `packages-${version}` },
      }));
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        const page = structuredClone(unifiedPage);
        page.value[0].displayName = `Saved agent revision ${version}`;
        return Response.json(page);
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const count = (path: string) => transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === path).length;
    const usersReads = count("/api/copilot-usage/users");
    expect(usersReads).toBeGreaterThan(0);
    for (const nextVersion of [2, 3]) {
      version = nextVersion;
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(count("/api/agents")).toBe(0);
      expect(count("/api/agent-inventory")).toBe(0);
      expect(count("/api/inventory/refresh-jobs")).toBe(0);
      expect(count("/api/copilot-usage/users")).toBe(usersReads);
    }
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Saved agent revision 3")).toBeVisible();
    expect(count("/api/agent-inventory")).toBe(1);
    const inventoryReads = count("/api/agent-inventory");
    fireEvent.click(screen.getByRole("button", { name: "Users" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    version = 5;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(count("/api/agent-inventory")).toBe(inventoryReads);
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Saved agent revision 5")).toBeVisible();
    expect(count("/api/agent-inventory")).toBe(inventoryReads + 1);
  });

  it("does not reload saved content for unchanged revisions or job progress alone", async () => {
    vi.useFakeTimers();
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    let progress = 0;
    transport.fetchMock.mockImplementation(async (input, init) => input === "/api/data-sync/auto-refresh"
      ? Response.json(automaticRefreshResponse({
        detailJob: { id: "same-detail-job", status: "running", updatedAt: new Date().toISOString(), message: `Read ${progress} details` },
      })) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const contentReads = () => transport.fetchMock.mock.calls.filter(([input]) =>
      ["/api/agents", "/api/agent-inventory", "/api/copilot-usage/users"].includes(new URL(input, "http://localhost").pathname)).length;
    const before = contentReads();
    expect(before).toBeGreaterThan(0);
    for (progress = 1; progress <= 2; progress += 1) {
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(contentReads()).toBe(before);
      expect(screen.getByText(agent.displayName)).toBeVisible();
    }
  });

  it("keeps background detail pins and owns the open agent through repeated slow explicit inventory reloads", async () => {
    vi.useFakeTimers();
    const transport = initialCatalogTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    let version = 1;
    let pending: ReturnType<typeof deferredResponse> | undefined;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/auto-refresh") return Response.json(automaticRefreshResponse({
        revisions: { ...automaticRefreshResponse().revisions, graph_packages: `packages-${version}` },
      }));
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        return Response.json(selectedInventoryPage(input, unifiedPage));
      }
      if (isPackageDetailRequest(input, agent.id)) {
        return pending ? pending.promise : Response.json({ ...agent, longDescription: `Saved description ${version}` });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: `View details for ${agent.displayName}` }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const dialog = screen.getByRole("dialog", { name: agent.displayName });
    const information = within(dialog).getByRole("region", { name: "Agent information" });
    expect(within(dialog).getByText("Saved description 1")).toBeVisible();

    for (const nextVersion of [2, 3]) {
      version = nextVersion;
      pending = deferredResponse();
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, agent.id))).toHaveLength(version - 1);
      fireEvent.click(within(dialog).getByRole("button", { name: "Reload saved inventory" }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, agent.id))).toHaveLength(version);
      expect(within(dialog).getByText(`Saved description ${version - 1}`)).toBeVisible();
      expect(within(dialog).queryByText("Loading saved agent details...")).not.toBeInTheDocument();
      expect(within(dialog).getByRole("region", { name: "Agent information" })).toBe(information);
      await act(async () => pending!.resolve(Response.json({ ...agent, longDescription: `Saved description ${version}` })));
      pending = undefined;
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByRole("dialog", { name: agent.displayName })).toBe(dialog);
      expect(within(dialog).getByText(`Saved description ${version}`)).toBeVisible();
      expect(within(dialog).getByRole("region", { name: "Agent information" })).toBe(information);
    }
  });

  it("clears failed background agent details and requires an explicit successful retry", async () => {
    vi.useFakeTimers();
    const transport = initialCatalogTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let refreshing = false;
    let recovered = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/auto-refresh") return Response.json(automaticRefreshResponse({
        revisions: { ...automaticRefreshResponse().revisions, graph_packages: refreshing ? "packages-2" : "packages-1" },
      }));
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        return Response.json(selectedInventoryPage(input, unifiedPage));
      }
      if (isPackageDetailRequest(input, agent.id)) return recovered
        ? Response.json({ ...agent, longDescription: "Recovered saved details" })
        : refreshing ? pending.promise : Response.json({ ...agent, longDescription: "Last successful details" });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: `View details for ${agent.displayName}` }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const dialog = screen.getByRole("dialog", { name: agent.displayName });
    refreshing = true;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, agent.id))).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Reload saved inventory" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(within(dialog).getByText("Last successful details")).toBeVisible();
    await act(async () => pending.resolve(Response.json({
      code: "saved_details_unavailable", detail: "Saved details could not be read.",
    }, { status: 500 })));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Saved details could not be read.");
    expect(within(dialog).queryByText("Last successful details")).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, agent.id))).toHaveLength(2);
    recovered = true;
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry saved details" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(within(dialog).getByText("Recovered saved details")).toBeVisible();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, agent.id))).toHaveLength(3);
  });

  it("shows a failed background inventory read inside the open dialog and retries saved data", async () => {
    vi.useFakeTimers();
    const transport = initialCatalogTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    let version = 1;
    let failed = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/auto-refresh") return Response.json(automaticRefreshResponse({
        revisions: { ...automaticRefreshResponse().revisions, graph_packages: `packages-${version}` },
      }));
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        return failed ? Response.json({ code: "inventory_unavailable", detail: "Saved inventory could not be read." }, { status: 503 })
          : Response.json(selectedInventoryPage(input, unifiedPage));
      }
      if (isPackageDetailRequest(input, agent.id)) return Response.json({ ...agent, longDescription: `Saved description ${version}` });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: `View details for ${agent.displayName}` }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const dialog = screen.getByRole("dialog", { name: agent.displayName });
    failed = true;
    version = 2;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Saved inventory could not be read.");
    expect(within(dialog).getByText("Saved description 1")).toBeVisible();
    failed = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry saved inventory" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Saved description 2")).toBeVisible();
    expect(refreshRequests(transport.fetchMock)).toEqual([]);
  });

  it("removes an unavailable selected agent instead of preserving its previous details after refresh", async () => {
    vi.useFakeTimers();
    const transport = initialCatalogTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    let removed = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/auto-refresh") return Response.json(automaticRefreshResponse({
        revisions: { ...automaticRefreshResponse().revisions, graph_packages: removed ? "packages-2" : "packages-1" },
      }));
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        return Response.json(removed ? unifiedRecordsPage([]) : unifiedPage);
      }
      if (isPackageDetailRequest(input, agent.id)) return removed
        ? Response.json({ code: "package_target_stale_or_absent", detail: "Selected agent is no longer in the saved inventory." }, { status: 409 })
        : Response.json({ ...agent, longDescription: "Previously saved details" });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: `View details for ${agent.displayName}` }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Previously saved details")).toBeVisible();
    removed = true;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Previously saved details")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Selected agent is no longer in the saved inventory.");
  });

  it.each(["success", "failure"] as const)("ignores a late background detail %s after selecting another agent", async outcome => {
    vi.useFakeTimers();
    const transport = initialCatalogTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const second = { ...agent, id: "second-package", displayName: "Another saved agent" };
    const page = unifiedRecordsPage([
      unifiedPage.value[0],
      { ...unifiedPage.value[0], id: `graph_packages:${second.id}`, displayName: second.displayName, packages: [second] },
    ]);
    let refreshing = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/auto-refresh") return Response.json(automaticRefreshResponse({
        revisions: { ...automaticRefreshResponse().revisions, graph_packages: refreshing ? "packages-2" : "packages-1" },
      }));
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        return Response.json({ ...page, revision: (refreshing ? "b" : "a").repeat(64) });
      }
      if (isPackageDetailRequest(input, agent.id)) return refreshing
        ? pending.promise : Response.json({ ...agent, longDescription: "First agent saved details" });
      if (isPackageDetailRequest(input, second.id)) return Response.json({ ...second, longDescription: "Second agent saved details" });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: `View details for ${agent.displayName}` }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    refreshing = true;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText("First agent saved details")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close unified agent details" }));
    fireEvent.click(screen.getByRole("button", { name: `View details for ${second.displayName}` }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const dialog = screen.getByRole("dialog", { name: second.displayName });
    expect(within(dialog).getByText("Second agent saved details")).toBeVisible();
    await act(async () => pending.resolve(outcome === "success"
      ? Response.json({ ...agent, longDescription: "Late first agent data" })
      : Response.json({ code: "provider_error", detail: "Late first agent error" }, { status: 500 })));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("dialog", { name: second.displayName })).toBe(dialog);
    expect(within(dialog).getByText("Second agent saved details")).toBeVisible();
    expect(screen.queryByText(/Late first agent/)).not.toBeInTheDocument();
    expect(screen.queryByText("First agent saved details")).not.toBeInTheDocument();
  });

  it("does not supersede fresh management verification when an automatic inventory read completes", async () => {
    vi.useFakeTimers();
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let version = 1;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/auto-refresh") return Response.json(automaticRefreshResponse({
        revisions: { ...automaticRefreshResponse().revisions, graph_packages: `packages-${version}` },
      }));
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        return Response.json({ ...unifiedPage, revision: String(version).repeat(64) });
      }
      if (input === `/api/agents/${agent.id}/refresh-jobs`) return pending.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: `View details for ${agent.displayName}` }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const dialog = screen.getByRole("dialog", { name: agent.displayName });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Manage" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: /No users/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === `/api/agents/${agent.id}/refresh-jobs`)).toHaveLength(1);
    version = 2;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    await act(async () => pending.resolve(Response.json({
      ...completedRefreshJob(), scopeKind: "exact", requestedIds: [agent.id],
    })));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(within(dialog).getByRole("region", { name: /update availability package/i })).toBeVisible();
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === `/api/agents/${agent.id}/refresh-jobs`)).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agents/mutation-preview")).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([input, init]) => input === `/api/agents/${agent.id}/access` && init?.method === "PATCH")).toHaveLength(0);
  });

  it.each(["source", "running details", "starting details"] as const)(
    "clears the login refresh indicator after page reads settle while %s work continues on the server", async kind => {
      vi.useFakeTimers();
      window.history.replaceState({}, "", "/users");
      const transport = appTransport({ revalidatedRoles: viewer.roles });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const now = new Date().toISOString();
      const state = automaticRefreshResponse(kind === "source" ? {
        run: {
          id: "automatic-run", automatic: true, mode: "incremental", status: "running",
          startedAt: now, updatedAt: now, completedAt: null,
          sources: [{ source: "users", status: "running", jobId: null, count: null,
            lastSuccessAt: null, updatedAt: now, message: "", canRetry: false }],
        },
      } : {
        detailJob: { id: "automatic-details", status: kind === "running details" ? "running" : "waiting_authorization", updatedAt: now },
      });
      let firstCheck = true;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (input === "/api/data-sync/auto-refresh") {
          if (!firstCheck) return Response.json(state);
          firstCheck = false;
          return pending.promise;
        }
        if (new URL(input, "http://localhost").pathname === "/api/copilot-usage/users") return Response.json(selectedUsersPage());
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(screen.getByRole("button", { name: "Ada" })).toBeVisible();
      expect(screen.getByRole("status", { name: "Background refresh" })).toBeVisible();

      await act(async () => pending.resolve(Response.json(state)));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.queryByRole("status", { name: "Background refresh" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Ada" })).toBeVisible();
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(screen.queryByRole("status", { name: "Background refresh" })).not.toBeInTheDocument();
      expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-sync/auto-refresh")).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(screen.getByText("Automatic refresh · Refreshing in the background")).toBeVisible();
      expect(screen.queryByRole("status", { name: "Background refresh" })).not.toBeInTheDocument();
    },
  );

  it("loads a fresh Users selection after a known sync revision without replaying the stale selection", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/users");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let refreshing = false;
    const updated = selectedUsersPage();
    updated.value[1].reportedResponses = 4;
    updated.selection.id = "20000000-0000-4000-8000-000000000003";
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/auto-refresh") return Response.json(automaticRefreshResponse({
        revisions: { ...automaticRefreshResponse().revisions, users: refreshing ? "users-2" : "users-1" },
      }));
      if (new URL(input, "http://localhost").pathname === "/api/copilot-usage/users") return refreshing ? pending.promise : Response.json(selectedUsersPage());
      if (input.startsWith("/api/agent-responsibility")) {
        return Response.json(responsibilityFixture(new URL(input, "http://localhost").searchParams.get("objectId") ?? undefined));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(500));
    const search = screen.getByRole("searchbox", { name: "Search users or agents" });
    fireEvent.change(search, { target: { value: "Ben" } });
    search.focus();
    expect(screen.queryByRole("status", { name: "Background refresh" })).not.toBeInTheDocument();
    const reads = () => transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === "/api/copilot-usage/users").length;
    const before = reads();
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Ben" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("dialog", { name: "Ben" })).toBeVisible();

    refreshing = true;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(reads()).toBe(before + 1);
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.getByRole("status", { name: "Background refresh" })).toBeVisible();
    expect(screen.getByRole("status", { name: "Background refresh" }).textContent).toBe("");
    expect(screen.queryByRole("button", { name: "Ben" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Ben" })).not.toBeInTheDocument();
    expect(search).toHaveValue("Ben");
    expect(screen.queryByText(/Loading saved Copilot|Showing the last saved user snapshot/)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Users and adoption" })).toHaveAttribute("aria-busy", "false");
    const request = transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === "/api/copilot-usage/users").at(-1)![0];
    const params = new URL(request, "http://localhost").searchParams;
    expect(params.has("selectionId")).toBe(false);
    expect(params.has("cursor")).toBe(false);
    expect(params.get("search")).toBe("Ben");
    await act(async () => pending.resolve(Response.json(updated)));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.queryByRole("dialog", { name: "Ben" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restart selection" })).not.toBeInTheDocument();
    expect(search).toHaveValue("Ben");
    expect(screen.queryByRole("status", { name: "Background refresh" })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(reads()).toBe(before + 1);
    expect(screen.getByRole("cell", { name: "4" })).toBeVisible();
    expect(reads()).toBe(before + 1);
  });

  it.each(["block", "unblock"] as const)("keeps selected package actions usable during a background inventory read and reports an actual %s denial", async action => {
    vi.useFakeTimers();
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let refreshing = false;
    const checkedAt = new Date(Date.now() - 1_000).toISOString();
    const expiresAt = new Date(Date.now() + 1_000).toISOString();
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input.startsWith("/api/capabilities")) {
        const body = await (await base(input, init)).json();
        return Response.json({ value: body.value.map((view: { decision: { verification?: string } }) => ({
          ...view, decision: view.decision.verification === "on_demand"
            ? { ...view.decision, verification: "token", checkedAt, expiresAt } : view.decision,
        })) });
      }
      if (input === "/api/data-sync/auto-refresh") return Response.json(automaticRefreshResponse({
        revisions: { ...automaticRefreshResponse().revisions, graph_packages: refreshing ? "packages-2" : "packages-1" },
      }));
      if (refreshing && new URL(input, "http://localhost").pathname === "/api/agent-inventory") return pending.promise;
      if (input === `/api/agents/${action}` && init?.method === "POST") return Response.json({
        code: "missing_permission", detail: "Microsoft denied the package operation. Review your assigned permissions.",
      }, { status: 403 });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` }));
    const permissionRequests = () => transport.fetchMock.mock.calls.filter(([path]) => path.startsWith("/api/capabilities")).length;
    expect(permissionRequests()).toBe(2);

    refreshing = true;
    await act(() => vi.advanceTimersByTimeAsync(60_001));
    expect(screen.getByRole("status", { name: "Updating agent results" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` })).toBeDisabled();
    for (const name of ["Block selected packages", "Unblock selected packages", "Manage access",
      `Block ${agent.displayName}`, `Manage access for ${agent.displayName}`]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(permissionRequests()).toBe(2);
    const label = action === "block" ? "Block" : "Unblock";
    fireEvent.click(screen.getByRole("button", { name: `${label} selected packages` }));
    await act(async () => {});
    const confirmation = screen.getByRole("dialog", { name: `${label} package?` });
    fireEvent.click(within(confirmation).getByRole("button", { name: `${label} package` }));
    await act(async () => {});
    expect(screen.getByRole("alert")).toHaveTextContent("Microsoft denied the package operation. Review your assigned permissions.");
    const writes = transport.fetchMock.mock.calls.filter(([path, init]) => path === `/api/agents/${action}` && init?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ ids: [agent.id], confirmationHash: "a".repeat(64) });
    await act(async () => pending.resolve(Response.json(unifiedPage)));
    expect(screen.queryByRole("status", { name: "Updating agent results" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Microsoft denied the package operation. Review your assigned permissions.");
    expect(permissionRequests()).toBe(2);
  });

  it("confirms and submits 5000 all-matching package targets without loading IDs or walking inventory pages", async () => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Response.json({
        ...unifiedPage, count: 6001, counts: { total: 6001, scoped: 6001, filtered: 6001, packageTargets: 5000 },
        selection: { id: "server-filtered-selection", revision: "1", evaluatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
        page: { limit: 50, nextCursor: "more-6001-agents", previousCursor: null },
      });
      if (input === "/api/agents/mutation-preview") {
        const result = await (await base(input, init)).json();
        return Response.json({ ...result, summary: { ...result.summary, targetCount: 5000, additionalTargetCount: 4999 } });
      }
      if (input === "/api/agents/block") return Response.json({ code: "missing_permission", detail: "No synthetic provider write is permitted." }, { status: 403 });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(transport.fetchMock.mock.calls.filter(([input]) =>
      new URL(input, "http://localhost").pathname === "/api/agent-inventory")).toHaveLength(1));
    await userEvent.click(await screen.findByRole("button", { name: "Select all 5000 matching published versions" }));
    await userEvent.click(screen.getByRole("button", { name: "Block selected packages" }));
    const confirmation = await screen.findByRole("dialog", { name: "Block 5,000 packages?" });
    expect(transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === "/api/agent-inventory")).toHaveLength(1);
    await userEvent.click(within(confirmation).getByRole("button", { name: "Block 5,000 packages" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No synthetic provider write is permitted.");
    const preview = transport.fetchMock.mock.calls.find(([input]) => input === "/api/agents/mutation-preview")!;
    const submit = transport.fetchMock.mock.calls.find(([input]) => input === "/api/agents/block")!;
    expect(JSON.parse(String(preview[1]?.body))).toEqual({ action: "block", selectionId: "server-filtered-selection", mutationScope: "bulk" });
    expect(JSON.parse(String(submit[1]?.body))).toEqual({ selectionId: "server-filtered-selection", confirmationHash: "a".repeat(64) });
    expect(transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === "/api/agent-inventory")).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-sync/auto-refresh")).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.some(([input]) => input.includes("cursor=more-6001"))).toBe(false);
  });

  it("confirms a complete logical package group without expanding its primary-package preview", async () => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const id = "agent:11111111-1111-4111-8111-111111111111";
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Response.json({
        ...unifiedPage, value: [{ ...unifiedPage.value[0], id, packageCount: 40, packagesComplete: false, memberCount: 40 }],
        counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 40 },
        selection: { id: "group-read-selection", revision: "1", expiresAt: new Date(Date.now() + 60_000).toISOString() },
        page: { limit: 50, nextCursor: null, previousCursor: null },
      });
      if (input === "/api/agents/mutation-preview") {
        const result = await (await base(input, init)).json();
        return Response.json({ ...result, selectionId: "reviewed-group-selection",
          summary: { ...result.summary, targetCount: 40, additionalTargetCount: 39 } });
      }
      if (input === "/api/agents/mutation-selection") return Response.json({ count: 40 });
      if (input === "/api/agents/block") return Response.json({ code: "missing_permission", detail: "No synthetic provider write is permitted." }, { status: 403 });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
    await userEvent.click(await screen.findByRole("button", { name: "Block selected packages" }));
    const confirmation = await screen.findByRole("dialog", { name: "Block 40 packages?" });
    await userEvent.click(within(confirmation).getByRole("button", { name: "Block 40 packages" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No synthetic provider write is permitted.");
    const preview = transport.fetchMock.mock.calls.find(([input]) => input === "/api/agents/mutation-preview")!;
    const submit = transport.fetchMock.mock.calls.find(([input]) => input === "/api/agents/block")!;
    const counted = transport.fetchMock.mock.calls.find(([input]) => input === "/api/agents/mutation-selection")!;
    expect(JSON.parse(String(counted[1]?.body))).toEqual({ selectionId: "group-read-selection", recordIds: [id] });
    expect(JSON.parse(String(preview[1]?.body))).toEqual({
      action: "block", selectionId: "group-read-selection", recordIds: [id], mutationScope: "bulk",
    });
    expect(JSON.parse(String(submit[1]?.body))).toEqual({
      selectionId: "reviewed-group-selection", recordIds: [id], confirmationHash: "a".repeat(64),
    });
    expect(transport.fetchMock.mock.calls.some(([input]) => /\/members|\/children/.test(input))).toBe(false);
  });

  it.each(["AgentControl.Viewer", "AgentControl.Admin"] as const)(
    "clears grouped and exact export selections for %s without leaving saved targets",
    async role => {
      const group = { ...unifiedPage.value[0], id: "agent:11111111-1111-4111-8111-111111111111",
        displayName: "Grouped export selection", packagesComplete: false, packageCount: 40 };
      const single = { ...unifiedPage.value[0], id: "graph_packages:single-package",
        displayName: "Exact export selection", packages: [{ ...agent, id: "single-package" }] };
      const transport = appTransport({ initialRoles: [role], revalidatedRoles: [role],
        unifiedResponse: unifiedRecordsPage([group, single]) });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      const grouped = await screen.findByRole("checkbox", { name: `Select ${group.displayName}` });
      const exact = screen.getByRole("checkbox", { name: `Select ${single.displayName}` });
      await userEvent.click(grouped);
      await userEvent.click(exact);
      if (role === "AgentControl.Admin") {
        await waitFor(() => expect(new URLSearchParams(window.location.search).get("selectionState")).toBe("session"));
      }
      const storedCount = Number(new URLSearchParams(window.location.search).get("selectionCount"));
      await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
      const dialog = screen.getByRole("dialog", { name: "Export agent inventory" });
      await userEvent.click(within(dialog).getByRole("button", { name: "Clear selection" }));
      expect(grouped).not.toBeChecked();
      expect(exact).not.toBeChecked();
      expect(within(dialog).getByRole("button", { name: /Download selected agents/ })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: /Download matching agents/ })).toBeEnabled();
      expect(window.location.search).not.toMatch(/selected|selectionState|selectionCount/);
      expect(restorePackageSelection({ ...viewer, roles: [role] }, storedCount).status).not.toBe("restored");
      expect(transport.fetchMock.mock.calls.some(([input]) => input === "/api/data-exports")).toBe(false);
    },
  );

  it("preserves both job identities and the mode in combined package job bookmarks", async () => {
    const jobId = waitingBulkJob().id;
    window.history.replaceState({}, "", `/agents?controlJob=${jobId}&refreshJob=refresh-first-load&mode=application`);
    const transport = appTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"] });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/agents/refresh-jobs/refresh-first-load?mode=application") {
        return Response.json({ ...completedRefreshJob(), tokenMode: "application" });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` });
    await waitFor(() => expect(transport.fetchMock).toHaveBeenCalledWith(
      "/api/agents/refresh-jobs/refresh-first-load?mode=application", expect.anything(),
    ));
    expect(window.location.pathname).toBe("/agents");
    expect(new URLSearchParams(window.location.search).get("controlJob")).toBe(jobId);
    expect(new URLSearchParams(window.location.search).get("refreshJob")).toBe("refresh-first-load");
    expect(new URLSearchParams(window.location.search).get("mode")).toBe("application");
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    expect(new URLSearchParams(window.location.search).has("refreshJob")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(new URLSearchParams(window.location.search).get("controlJob")).toBe(jobId);
    expect(new URLSearchParams(window.location.search).get("refreshJob")).toBe("refresh-first-load");
    expect(new URLSearchParams(window.location.search).get("mode")).toBe("application");
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("does not copy a Sync package refresh bookmark into the Agents route", async () => {
    window.history.replaceState({}, "", "/sync?refreshJob=refresh-first-load");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Agents" }));
    await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` });
    expect(window.location.pathname).toBe("/agents");
    expect(new URLSearchParams(window.location.search).has("refreshJob")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    expect(new URLSearchParams(window.location.search).get("refreshJob")).toBe("refresh-first-load");
  });

  it("pauses automatic work before a manual cancellation and keeps manual sync available", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/sync");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const run = {
      id: "auto-run", automatic: true, mode: "incremental", status: "running", sources: [],
      startedAt: "2026-09-24T10:00:00Z", updatedAt: "2026-09-24T10:00:00Z", completedAt: null,
    };
    let cancelled = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/state") {
        const state = await (await base(input, init)).json();
        return Response.json({ ...state, run: { ...run, status: cancelled ? "cancelled" : "running" } });
      }
      if (input === "/api/data-sync/runs/auto-run/cancel") {
        cancelled = true;
        return Response.json({ ...run, status: "cancelled" });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(cancelled).toBe(true);
    expect(screen.getByText("Automatic refresh · Paused for this session")).toBeVisible();
    expect(screen.getByRole("button", { name: "Sync all sources" })).toBeEnabled();
    const checks = transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-sync/auto-refresh").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-sync/auto-refresh")).toHaveLength(checks);
  });

  it.each(["missing_permission", "interaction_required"] as const)("keeps automatic due checks eligible with one %s provider and unverified detail metadata", async category => {
    vi.useFakeTimers();
    const transport = initialCatalogTransport();
    transport.page = packagePage;
    transport.readAuthorized = false;
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/capabilities" || input.startsWith("/api/capabilities/check")) {
        const capabilities = await (await base(input, init)).json();
        capabilities.value[0].decision.evidence = { category };
        return Response.json(capabilities);
      }
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Response.json({
        ...unifiedPage, identityCollection: { checkedPackages: 0, pendingPackages: 1 },
      });
      if (input === "/api/data-sync/auto-refresh") return Response.json(automaticRefreshResponse({
        run: {
          id: "partially-authorized-run", automatic: true, mode: "incremental", status: "partial",
          startedAt: "2026-09-24T10:00:00Z", updatedAt: "2026-09-24T10:01:00Z", completedAt: "2026-09-24T10:01:00Z",
          sources: [
            { source: "users", status: "succeeded", jobId: null, count: 42, lastSuccessAt: "2026-09-24T10:01:00Z", updatedAt: "2026-09-24T10:01:00Z", message: "", canRetry: false },
            { source: "graph_packages", status: category === "interaction_required" ? "waiting_authorization" : "permission_required", jobId: null, count: null, lastSuccessAt: null, updatedAt: "2026-09-24T10:01:00Z", message: "", canRetry: false },
          ],
        },
      }));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(agent.displayName)).toBeVisible();
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-sync/auto-refresh")).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-sync/auto-refresh")).toHaveLength(2);
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each((["power_platform", "graph_packages"] as const).flatMap(source => [
    ...(["responsibility", "licenses", "activity"] as const).map(surface => ({ source, surface, event: "completion" as const })),
    { source, surface: "responsibility" as const, event: "reset" as const },
  ]))(
    "reloads mounted Users responsibility for $surface on background $source $event", async ({ source, surface, event }) => {
      const directory = selectedUsersPage();
      const reportUser = selectedReportUsersPage({ licenseCohort: "active_without_paid" }).value.find(user => user.username === "ben@example.invalid")!;
      directory.value[1] = { ...directory.value[1], copilotServiceState: "disabled", entitlement: "no_paid", reportedResponses: reportUser.reportedResponses };
      const personId = surface === "responsibility" ? responsibilityOwnerId
        : directory.value[surface === "licenses" ? 0 : 1].directory.objectId;
      const url = surface === "responsibility" ? `/users?view=responsibility&person=${personId}`
        : surface === "activity" ? "/users?view=activity" : "/users";
      window.history.replaceState({}, "", url);
      const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: verifiedSavedAgentPage() });
      const base = transport.fetchMock.getMockImplementation()!;
      let completed = false;
      let responsibilityReads = 0;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (input === "/api/data-sync/state") {
          const state = await (await base(input, init)).json();
          state.run = { id: "background-responsibility-sync", mode: "incremental", status: completed ? "completed" : "running",
            startedAt: "2026-09-15T08:00:00.000Z", updatedAt: "2026-09-15T08:01:00.000Z",
            completedAt: completed ? "2026-09-15T08:01:00.000Z" : null, sources: [] };
          if (completed) state.sources = state.sources.map((value: { source: string }) => value.source === source
            ? { ...value, updatedAt: "2026-09-15T08:01:00.000Z", lastSuccessAt: event === "reset" ? null : "2026-09-15T08:01:00.000Z",
              ...(event === "reset" ? { count: null, status: "not_started" } : {}) } : value);
          return Response.json(state);
        }
        const reportData = selectedFixtureRead(input, directory);
        if (reportData) return Response.json(reportData);
        if (input.startsWith("/api/agent-responsibility")) {
          responsibilityReads++;
          expect(new URL(input, "http://localhost").searchParams.get("objectId")).toBe(personId);
          const data = responsibilityFixture(personId);
          data.selected!.agents[0].displayName = completed ? "Current responsibility after sync" : "Previous responsibility";
          if (completed) {
            data.selected!.agents[0].id = "agent:dddddddd-dddd-4ddd-8ddd-dddddddddddd";
            data.selected!.agents[0].roles = ["createdBy"];
          }
          return Response.json(data);
        }
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await waitFor(() => expect(transport.fetchMock).toHaveBeenCalledWith("/api/data-sync/auto-refresh", expect.anything()));
      if (surface !== "responsibility") {
        await userEvent.click(await screen.findByRole("button", {
          name: surface === "licenses" ? "Ada" : reportUser.displayName,
        }));
        await userEvent.click(screen.getByRole("tab", { name: "Responsibility" }));
      }
      await screen.findByText("Previous responsibility");
      const beforeResponsibilityReads = responsibilityReads;
      const dialog = surface === "responsibility" ? undefined : screen.getByRole("dialog", { name: surface === "licenses" ? "Ada" : reportUser.displayName! });
      const directoryReads = () => transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === "/api/copilot-usage/users").length;
      const reportReads = () => transport.fetchMock.mock.calls.filter(([input]) => input.startsWith("/api/official-usage/users")).length;
      const beforeReads = [directoryReads(), reportReads()];
      completed = true;
      await waitFor(() => expect(screen.getByText("Current responsibility after sync")).toBeVisible(), { timeout: 2_500 });
      expect(screen.queryByText("Previous responsibility")).not.toBeInTheDocument();
      expect(screen.getByText("Created by", { exact: true })).toBeVisible();
      expect(screen.getByRole("combobox", { name: "User cohort" })).toHaveValue(surface);
      expect(window.location.pathname + window.location.search).toBe(url);
      expect(responsibilityReads).toBe(beforeResponsibilityReads + 1);
      expect([directoryReads(), reportReads()]).toEqual(beforeReads);
      if (surface === "responsibility") expect(beforeReads).toEqual([0, 0]);
      if (dialog) {
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute("open");
        expect(within(dialog).getByText("Agent responses").parentElement)
          .toHaveTextContent(String(surface === "licenses" ? directory.value[0].reportedResponses : reportUser.reportedResponses));
      }
      expect(transport.fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET").map(([input]) => input))
        .toEqual(expect.arrayContaining(["/api/capabilities/check", "/api/data-sync/auto-refresh"]));
      await userEvent.click(screen.getByRole("button", { name: "Open agent Current responsibility after sync" }));
      await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) =>
        unifiedDetailId(input) === "agent:dddddddd-dddd-4ddd-8ddd-dddddddddddd")).toBe(true));
    },
  );

  it.each(["inventory-refresh-jobs", "selected-agent-page"] as const)(
    "does not reattach a post-action %s read to another observer's pre-action request",
    async resource => {
      const usage = resource === "selected-agent-page";
      window.history.replaceState({}, "", usage ? "/official-usage?view=snapshot" : "/sync");
      const client = savedQueries.createSavedQueryClient();
      const admittedKeys = new Map<string, readonly unknown[]>();
      const unsubscribe = client.getQueryCache().subscribe(event => {
        const name = event.query.queryKey[1] === "record-page" && typeof event.query.queryKey[2] === "string"
          && JSON.parse(event.query.queryKey[2])[1] === "official-usage/aggregate" ? "selected-agent-page" : event.query.queryKey[1];
        if (event.type === "added" && typeof name === "string") {
          admittedKeys.set(name, event.query.queryKey);
        }
      });
      vi.spyOn(savedQueries, "createSavedQueryClient").mockReturnValue(client);
      const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: verifiedSavedAgentPage(),
        reportHistory: usage ? selectedHistoryPage() : undefined });
      const startupRefresh = deferredResponse();
      const base = transport.fetchMock.getMockImplementation()!;
      transport.fetchMock.mockImplementation((input, init) => input === "/api/data-sync/auto-refresh"
        ? startupRefresh.promise : base(input, init));
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await waitFor(() => expect(admittedKeys.has(resource)).toBe(true));
      const readFamily = usage ? admittedKeys.get(resource)!.slice(0, 3) : ["saved", resource];
      await waitFor(() => expect(client.isFetching({ queryKey: readFamily })).toBe(0));
      // Initial revision publication is a separate reload, not the action under test.
      await waitFor(() => expect(transport.fetchMock).toHaveBeenCalledWith("/api/data-sync/auto-refresh", expect.anything()));
      await act(async () => startupRefresh.resolve(Response.json(automaticRefreshResponse())));
      await waitFor(() => expect(client.isFetching({ queryKey: readFamily })).toBe(0));
      const key = admittedKeys.get(resource)!;
      const retained = deferredResponse();
      const controller = new AbortController();
      let retainedSignal: AbortSignal | undefined;
      const peer = savedQueries.readSavedQuery(client, key.slice(1), signal => {
        retainedSignal = signal;
        return retained.promise.then(response => response.json());
      }, controller.signal).then(value => ({ value }), error => ({ error }));
      const path = usage ? "/api/official-usage/aggregate" : "/api/inventory/refresh-jobs";
      const reads = () => transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === path).length;
      const before = reads();
      try {
        if (usage) {
          await userEvent.click(screen.getByRole("button", { name: "Back to reports" }));
          await userEvent.click(await screen.findByRole("button", { name: "View report" }));
        } else {
          await userEvent.click(await screen.findByText("View diagnostics"));
          await userEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
        }
        await waitFor(() => expect(reads()).toBe(before + 1));
        expect(retainedSignal?.aborted).toBe(false);
        const oldData = usage ? selectedAgentsPage() : { value: [], lastAttemptAt: null, lastSuccessAt: null };
        await act(async () => retained.resolve(Response.json(oldData)));
        expect(await peer).toEqual({ value: oldData });
      } finally {
        controller.abort();
        unsubscribe();
        await peer;
      }
    },
  );

  it.each(["inventory", "package-detail"] as const)(
    "uses a new selected %s request after verification without joining an independent historical reader", async resource => {
      const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: verifiedSavedAgentPage() });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await screen.findByText(agent.displayName);
      await waitFor(() => expect(transport.fetchMock).toHaveBeenCalledWith("/api/data-sync/auto-refresh", expect.anything()));
      const selectionId = currentInventorySelection(transport.fetchMock)!;
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse(), controller = new AbortController();
      let historicalUrl: string | undefined, historicalSignal: AbortSignal | undefined;
      transport.fetchMock.mockImplementation((input, init) => {
        if (!historicalUrl && (resource === "inventory"
          ? new URL(input, "http://localhost").pathname === "/api/agent-inventory"
          : isPackageDetailRequest(input, agent.id))) {
          historicalUrl = input;
          historicalSignal = init?.signal as AbortSignal;
          return pending.promise;
        }
        return base(input, init);
      });
      const peer = resource === "inventory" ? getUnifiedAgents({ selectionId }, { signal: controller.signal })
        : getAgentDetails(selectionId, agent.id, { signal: controller.signal });
      await waitFor(() => expect(historicalUrl).toBeDefined());
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await userEvent.click(screen.getByText("View diagnostics"));
      await userEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
      await waitFor(() => expect(currentInventorySelection(transport.fetchMock)).not.toBe(selectionId));
      await userEvent.click(screen.getByRole("button", { name: "Browse agents" }));
      if (resource === "package-detail") {
        await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
        await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) =>
          isPackageDetailRequest(input, agent.id) && input !== historicalUrl)).toBe(true));
      }
      expect(historicalSignal?.aborted).toBe(false);
      const historical = resource === "inventory" ? selectedInventoryPage(historicalUrl!, unifiedPage)
        : { ...agent, longDescription: "Historical independent description" };
      await act(async () => pending.resolve(Response.json(historical)));
      expect(await peer).toEqual(historical);
      expect(screen.queryByText("Historical independent description")).not.toBeInTheDocument();
      controller.abort();
    },
  );

  it("does not migrate or interpret a retired catalog bookmark", () => {
    window.history.replaceState({}, "", "/power-platform?refreshJob=old-job&detail=old-object");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeVisible();
    expect(window.location.pathname + window.location.search).toBe("/power-platform?refreshJob=old-job&detail=old-object");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not revive or rewrite a retired catalog route restored through browser history", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: verifiedSavedAgentPage() });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    act(() => {
      window.history.pushState({}, "", "/power-platform?refreshJob=retired-job");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeVisible();
    expect(window.location.pathname + window.location.search).toBe("/power-platform?refreshJob=retired-job");
  });

  it("opens the exact bookmarked Power Platform job in Sync without selecting the latest or starting provider work", async () => {
    window.history.replaceState({}, "", "/sync?powerPlatformJob=older-source-job");
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: verifiedSavedAgentPage() });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/inventory/refresh-jobs/older-source-job") {
        return Response.json({ ...inventoryRefreshJob("failed", "older-source-job"), message: "Older exact failure" });
      }
      if (input === "/api/inventory/refresh-jobs") {
        return Response.json({ value: [inventoryRefreshJob("succeeded", "newer-source-job")], lastAttemptAt: null, lastSuccessAt: null });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText(/Older exact failure/)).toBeVisible();
    expect(window.location.pathname + window.location.search).toBe("/sync?powerPlatformJob=older-source-job");
    expect(transport.fetchMock.mock.calls.some(([input]) => input === "/api/inventory/refresh-jobs/older-source-job")).toBe(true);
    expect(transport.fetchMock.mock.calls.filter(([input, init]) => input.startsWith("/api/inventory/refresh") && init?.method === "POST")).toEqual([]);
  });

  it("does not reopen a signed-out workbench from a superseded StrictMode bootstrap", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const firstSetup = deferredResponse();
    let setupReads = 0;
    let firstSignal: AbortSignal | null | undefined;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/auth/status" && ++setupReads === 1) {
        firstSignal = init?.signal;
        return firstSetup.promise;
      }
      if (input === "/api/auth/logout") return new Response(null, { status: 204 });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />, { reactStrictMode: true });
    await screen.findByText(agent.displayName);
    expect(setupReads).toBe(2);
    expect(firstSignal?.aborted).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("button", { name: "Sign in with Entra ID" });
    await act(async () => firstSetup.resolve(Response.json({ authConfigured: true })));
    expect(screen.getByRole("button", { name: "Sign in with Entra ID" })).toBeInTheDocument();
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(firstSignal?.aborted).toBe(true);
    expect(transport.meCalls()).toBe(1);
  });

  it("reloads capability evidence for a batched same-principal session revalidation", async () => {
    window.history.replaceState({}, "", "/permissions");
    const transport = appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
    const base = transport.fetchMock.getMockImplementation()!;
    let catalogReads = 0;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/capabilities" && ++catalogReads > 1) return pending.promise;
      if (input.startsWith("/api/capabilities/check")) return base("/api/capabilities", init);
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText("No issues reported.");
    await revalidateTransportSession(transport);
    expect(catalogReads).toBe(2);
    expect(screen.queryByText("No issues reported.")).not.toBeInTheDocument();
    await act(async () => pending.resolve(Response.json({ value: [] })));
  });

  it.each(["unified inventory", "inventory selection", "refresh history"] as const)(
    "purges saved agent data on a denied %s read and fences outstanding successes",
    async deniedSource => {
      const client = savedQueries.createSavedQueryClient();
      const inventoryReads = vi.spyOn(AgentInventoryQueries.prototype, "read");
      vi.spyOn(savedQueries, "createSavedQueryClient").mockReturnValue(client);
      const transport = appTransport({ revalidatedRoles: viewer.roles });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      let deny = false;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (deny) {
          const pathname = new URL(input, "http://localhost").pathname;
          const deniedPath = deniedSource === "unified inventory" ? "/api/agent-inventory"
            : deniedSource === "inventory selection" ? "/api/agent-inventory/selections" : "/api/inventory/refresh-jobs";
          if (pathname === deniedPath) return Response.json({ code: "forbidden", detail: "Saved agent access denied." }, { status: 403 });
          if (pathname === "/api/agent-inventory") return pending.promise;
        }
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await screen.findByText(agent.displayName);
      const peerKey = deniedSource === "refresh history"
        ? ["inventory-refresh-jobs", { dataRevision: 0, reload: "independent-owner" }]
        : ["official-usage-overview", "independent-owner"];
      const cached = { records: ["retained report"] };
      client.setQueryData(["saved", ...peerKey], cached);
      const peerResponse = deferredResponse();
      const peerController = new AbortController();
      let peerSignal: AbortSignal | undefined;
      const peer = savedQueries.readSavedQuery(client, peerKey, signal => {
        peerSignal = signal;
        return peerResponse.promise.then(response => response.json());
      }, peerController.signal).then(value => ({ value }), error => ({ error }));
      const agentOwner = inventoryReads.mock.calls.at(-1)![0];
      const agentCache = Reflect.get(inventoryReads.mock.contexts.at(-1)!, "client") as typeof client;
      expect(agentOwner).toEqual(expect.any(String));
      const agentKey = ["agent-inventory", agentOwner, { selectionId: currentInventorySelection(transport.fetchMock), cursor: "independent" }];
      agentCache.setQueryData(agentKey, { private: true });
      const agentResponse = deferredResponse();
      let agentSignal: AbortSignal | undefined;
      await agentCache.invalidateQueries({ queryKey: agentKey, exact: true, refetchType: "none" });
      const agentPeer = agentCache.fetchQuery({ queryKey: agentKey, queryFn: ({ signal }) => {
        agentSignal = signal;
        return agentResponse.promise.then(response => response.json());
      } }).then(value => ({ value }), error => ({ error }));
      const unrelatedReads = () => transport.fetchMock.mock.calls.filter(([input]) =>
        ["/api/capabilities", "/api/workbench/metadata", "/api/data-sync/state"].includes(input)).length;
      const before = unrelatedReads();
      try {
        deny = true;
        fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Sensitive" } });
        await screen.findByText(/Saved agent access denied/);
        expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
        expect(peerSignal?.aborted).toBe(false);
        expect(client.getQueryData(["saved", ...peerKey])).toEqual(cached);
        expect(agentSignal?.aborted).toBe(true);
        const cancelled = await agentPeer;
        expect("error" in cancelled && isCancelledError(cancelled.error)).toBe(true);
        expect(agentCache.getQueryData(agentKey)).toBeUndefined();
        expect(unrelatedReads()).toBe(before);
        await act(async () => {
          pending.resolve(Response.json(unifiedPage));
          peerResponse.resolve(Response.json(cached));
          agentResponse.resolve(Response.json({ private: true }));
        });
        expect(await peer).toEqual({ value: cached });
        expect(agentCache.getQueryData(agentKey)).toBeUndefined();
        expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
        expect(transport.meCalls()).toBe(1);
        deny = false;
        await userEvent.click(await screen.findByRole("button", { name: "Reload saved agent inventory" }));
        await screen.findByText(agent.displayName);
      } finally {
        pending.resolve(Response.json(unifiedPage));
        peerController.abort();
        await peer;
        await agentPeer;
      }
    },
  );

  it("retains the loaded report summary when an unrelated saved agent read is forbidden", async () => {
    window.history.replaceState({}, "", "/official-usage?view=snapshot");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const denied = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) =>
      new URL(input, "http://localhost").pathname === "/api/agent-inventory" ? denied.promise.then(response => response.clone()) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const summary = await screen.findByRole("region", { name: "Snapshot tenant totals" });
    const independent = getUnifiedAgents().then(value => ({ value }), error => ({ error }));
    await act(async () => denied.resolve(Response.json({
      code: "forbidden", detail: "Saved agent access denied.",
    }, { status: 403 })));
    expect(await independent).toMatchObject({ error: { status: 403, code: "forbidden", message: "Saved agent access denied." } });
    expect(screen.getByRole("region", { name: "Snapshot tenant totals" })).toBe(summary);
    expect(transport.meCalls()).toBe(1);
  });

  it("preserves an open Sync workflow when a concurrent saved agent read is forbidden", async () => {
    window.history.replaceState({}, "", "/sync");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const denied = deferredResponse();
    let deny = false;
    transport.fetchMock.mockImplementation((input, init) =>
      deny && new URL(input, "http://localhost").pathname === "/api/agent-inventory" ? denied.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByText("View diagnostics"));
    const verify = screen.getByRole("button", { name: "Verify saved inventory" });
    await waitFor(() => expect(verify).toBeEnabled());
    deny = true;
    await userEvent.click(verify);
    await userEvent.click(screen.getByRole("button", { name: "Reset saved data..." }));
    const dialog = screen.getByRole("dialog", { name: "Reset saved data" });
    const acknowledged = within(dialog).getByRole("checkbox");
    await userEvent.click(acknowledged);
    await act(async () => denied.resolve(Response.json({
      code: "forbidden", detail: "Saved agent access denied.",
    }, { status: 403 })));
    await screen.findAllByText(/Saved agent access denied/);
    expect(screen.getByRole("dialog", { name: "Reset saved data" })).toBe(dialog);
    expect(acknowledged).toBeChecked();
    expect(transport.fetchMock.mock.calls.some(([input, init]) =>
      input === "/api/data-sync/runs" && init?.method === "POST")).toBe(false);
  });

  it.each(["success", "failure"] as const)("fences a late agent export %s after scoped denial and recovery", async outcome => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const previousExport = deferredResponse();
    const currentExport = deferredResponse();
    let deny = false;
    let exports = 0;
    transport.fetchMock.mockImplementation((input, init) => {
      const path = new URL(input, "http://localhost").pathname;
      if (path === "/api/data-exports") return ++exports === 1 ? previousExport.promise : currentExport.promise;
      if (deny && path === "/api/agent-inventory") return Promise.resolve(Response.json({
        code: "forbidden", detail: "Saved agent access denied.",
      }, { status: 403 }));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await screen.findByText(agent.displayName);
    const startExport = async () => {
      const button = screen.getByRole("button", { name: "Export agent inventory CSV" });
      await waitFor(() => expect(button).toBeEnabled());
      await userEvent.click(button);
      await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    };
    try {
      await startExport();
      await waitFor(() => expect(exports).toBe(1));
      deny = true;
      fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Sensitive" } });
      await screen.findByText(/Saved agent access denied/);
      deny = false;
      await userEvent.click(screen.getByRole("button", { name: "Reload saved agent inventory" }));
      await screen.findByText(agent.displayName);
      await startExport();
      await waitFor(() => expect(exports).toBe(2));
      await act(async () => previousExport.resolve(outcome === "success"
        ? Response.json({ id: "superseded-export" })
        : Response.json({ detail: "Superseded export failure" }, { status: 503 })));
      expect(download.filenames).toEqual([]);
      expect(screen.queryByText("Superseded export failure")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Exporting agent inventory CSV" })).toBeDisabled();
      await act(async () => currentExport.resolve(Response.json({ id: "inventory-export" })));
      await completeNativeInventoryDownload(download);
      expect(transport.fetchMock.mock.calls.some(([input]) => input === "/api/data-exports/superseded-export")).toBe(false);
      expect(transport.meCalls()).toBe(1);
    } finally {
      previousExport.resolve(Response.json({ id: "superseded-export" }));
      currentExport.resolve(Response.json({ id: "inventory-export" }));
    }
  });

  it.each([
    { status: 401, code: undefined },
    { status: 403, code: undefined },
    { status: 401, code: "unauthorized" },
    { status: 403, code: "missing_internal_role" },
  ])("purges the workbench and all peers for a global $status denial ($code)", async ({ status, code }) => {
    const client = savedQueries.createSavedQueryClient();
    vi.spyOn(savedQueries, "createSavedQueryClient").mockReturnValue(client);
    const transport = appTransport({ revalidatedRoles: [], deferRevalidation: true });
    const base = transport.fetchMock.getMockImplementation()!;
    let deny = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (deny && new URL(input, "http://localhost").pathname === "/api/agent-inventory") return code
        ? Response.json({ code }, { status }) : new Response("Unreadable denial", { status });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const key = ["official-usage-overview", "independent-owner"];
    client.setQueryData(["saved", ...key], { records: ["private report"] });
    const pending = deferredResponse();
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const peer = savedQueries.readSavedQuery(client, key, currentSignal => {
      signal = currentSignal;
      return pending.promise.then(response => response.json());
    }, controller.signal).then(value => ({ value }), error => ({ error }));
    deny = true;
    await act(async () => { await expect(getUnifiedAgents()).rejects.toMatchObject({ status, code: code ?? "request_failed" }); });
    expect(signal?.aborted).toBe(true);
    expect(await peer).toMatchObject({ error: { code: "request_aborted" } });
    expect(client.getQueryData(["saved", ...key])).toBeUndefined();
    pending.resolve(Response.json({ records: ["late private report"] }));
    controller.abort();
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    await act(async () => transport.releaseRevalidation());
    await screen.findByRole("heading", { name: "Permissions" });
  });

  it("uses the automatic due check to replace duplicate source rows without a second identity scanner", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", agent.displayName);
    const merged: UnifiedAgentRecord = {
      ...native, presence: "both", packages: [agent],
      identity: { state: "matched", evidence: [], packageEvidence: [], reason: null },
      observations: { ...native.observations, graphPackages: unifiedPage.value[0].observations.graphPackages },
    };
    const transport = initialCatalogTransport();
    transport.page = packagePage;
    const base = transport.fetchMock.getMockImplementation()!;
    let collected = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Response.json({
        ...unifiedRecordsPage(collected ? [merged] : [unifiedPage.value[0], native]),
        identityCollection: { checkedPackages: collected ? 1 : 0, pendingPackages: collected ? 0 : 1 },
      });
      if (input === "/api/data-sync/auto-refresh") {
        collected = true;
        return Response.json(automaticRefreshResponse());
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<StrictMode><App /></StrictMode>);
    await waitFor(() => expect(collected).toBe(true));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Unified agents" })).getAllByText(agent.displayName)).toHaveLength(1));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.find(([input]) => input === "/api/data-sync/auto-refresh")?.[1]).toMatchObject({ method: "POST", body: "{}" });
    expect(screen.getAllByRole("checkbox", { name: `Select ${agent.displayName}` })).toHaveLength(1);
    expect(window.location.pathname).toBe("/agents");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "Sensitive");
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("follows an existing identity refresh across tabs without dispatching another collection", async () => {
    vi.useFakeTimers();
    const transport = initialCatalogTransport();
    transport.page = packagePage;
    transport.jobs = [{ ...completedRefreshJob(), status: "running", snapshotId: null, message: "Matching agent records (0/1 identities checked)." }];
    const base = transport.fetchMock.getMockImplementation()!;
    let finished = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Response.json({
        ...unifiedRecordsPage(unifiedPage.value),
        identityCollection: { checkedPackages: finished ? 1 : 0, pendingPackages: finished ? 0 : 1 },
      });
      if (input === "/api/data-sync/auto-refresh") return Response.json(automaticRefreshResponse({
        detailJob: { id: "details-1", status: finished ? "succeeded" : "running", updatedAt: String(finished) },
        revisions: { ...automaticRefreshResponse().revisions, graph_packages: finished ? "packages-2" : "packages-1" },
      }));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByRole("region", { name: "Automatic refresh" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    expect(screen.getByText("Automatic refresh · Refreshing in the background")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Users" }));
    finished = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.queryByRole("region", { name: "Automatic refresh" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    expect(screen.getByText("Automatic refresh · On")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(agent.displayName)).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("keeps automatic package collection monitored for three hours and reloads its completed result", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/sync");
    const transport = initialCatalogTransport();
    transport.page = packagePage;
    transport.jobs = [{ ...completedRefreshJob(), status: "running", snapshotId: null, message: "Matching agent records (0/1 identities checked)." }];
    const base = transport.fetchMock.getMockImplementation()!;
    let completed = false;
    let reads = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Response.json({
        ...unifiedRecordsPage(unifiedPage.value),
        identityCollection: { checkedPackages: completed ? 1 : 0, pendingPackages: completed ? 0 : 1 },
      });
      if (input === "/api/data-sync/auto-refresh") {
        reads += 1;
        return Response.json(automaticRefreshResponse({
          detailJob: { id: "details-1", status: completed ? "succeeded" : "running", updatedAt: String(completed) },
          revisions: { ...automaticRefreshResponse().revisions, graph_packages: completed ? "packages-2" : "packages-1" },
        }));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const mounted = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Automatic refresh · Refreshing in the background")).toBeVisible();
    vi.setSystemTime(Date.now() + 3 * 60 * 60_000);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/reached its.*minute bound/)).not.toBeInTheDocument();
    completed = true;
    packagePage = createPackagePage();
    Object.assign(unifiedPage, createUnifiedPage());
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByText("Automatic refresh · On")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(agent.displayName)).toBeVisible();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    const finalReads = reads;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(reads).toBe(finalReads);
    mounted.unmount();
  });

  it("delegates automatic source authorization to the due check and surfaces failures without a second scanner", async () => {
    const transport = initialCatalogTransport();
    transport.page = packagePage;
    transport.readAuthorized = false;
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Response.json({ ...unifiedRecordsPage(unifiedPage.value), identityCollection: { checkedPackages: 0, pendingPackages: 1 } });
      if (input === "/api/data-sync/auto-refresh") return Response.json(automaticRefreshResponse({
        detailJob: transport.failRefresh ? { id: "failed-details", status: "failed", updatedAt: "now" } : null,
      }));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const mounted = render(<App />);
    await screen.findByText(agent.displayName);
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    mounted.unmount();
    transport.readAuthorized = true;
    transport.failRefresh = true;
    render(<App />);
    await screen.findByText(agent.displayName);
    expect(screen.queryByRole("region", { name: "Automatic refresh" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "Sensitive");
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    expect(await screen.findByText("Automatic refresh · Some sources need attention")).toBeVisible();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("routes invalid metadata diagnostics to explicit recovery without treating checked packages as matches or retrying automatically", async () => {
    const invalid: UnifiedAgentRecord = {
      ...unifiedPage.value[0], id: "agent:33333333-3333-4333-8333-333333333333",
      identity: { ...unifiedPage.value[0].identity, invalidMetadata: true },
    };
    const transport = initialCatalogTransport({
      unifiedResponse: {
        ...unifiedRecordsPage([invalid]),
        identityCollection: { checkedPackages: 1, pendingPackages: 0, invalidPackages: 1 },
      },
    });
    transport.page = packagePage;
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    const issue = await screen.findByRole("button", { name: /Inventory needs attention.*Open Sync/ });
    expect(issue).toHaveAttribute("title", expect.stringContaining("1 package with invalid matching metadata"));
    await userEvent.click(issue);
    expect(window.location.pathname).toBe("/sync");
    expect(screen.queryByRole("dialog", { name: "Inventory diagnostics" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByText(/1 package has invalid saved matching metadata/)).toBeVisible();
    expect(screen.getByText("1 package detail check current; 0 not current.")).toBeVisible();
    expect(screen.getByText("Source-metadata links").nextElementSibling).toHaveTextContent(/^0$/);
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Select packages on Agents" }));
    await userEvent.click(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` }));
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    const admittedSelection = currentInventorySelection(transport.fetchMock);
    await userEvent.click(screen.getByRole("button", { name: "Refresh matching details" }));
    await waitFor(() => expect(selectedRefreshRequests(transport.fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(selectedRefreshRequests(transport.fetchMock)[0][1]?.body))).toMatchObject({
      selectionId: admittedSelection,
    });
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("selects both exact target kinds with one checkbox on a merged agent", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", agent.displayName);
    const merged: UnifiedAgentRecord = {
      ...native, presence: "both", packages: [agent],
      observations: { ...native.observations, graphPackages: unifiedPage.value[0].observations.graphPackages },
    };
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"], unifiedResponse: unifiedRecordsPage([merged]),
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const checkbox = await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` });
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(screen.getByRole("region", { name: "Exact package bulk actions" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Copilot Studio quarantine controls" })).toBeVisible();
    expect(new URLSearchParams(window.location.search).getAll("selected").join(",")).toContain(agent.id);
    await userEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByRole("region", { name: "Exact package bulk actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Copilot Studio quarantine controls" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: `View details for ${agent.displayName}` }));
    await userEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    expect(await screen.findByRole("tab", { name: "Manage" })).toHaveAttribute("aria-selected", "true");
  });

  it.each([null, "11111111-1111-4111-8111-111111111111"])("refreshes every exact package in a canonical graph-only group with environment %s", async environmentId => {
    const group: UnifiedAgentRecord = {
      ...unifiedPage.value[0], id: "agent:33333333-3333-4333-8333-333333333333", environmentId,
      displayName: "Grouped Graph agent",
      packages: [agent, { ...agent, id: "package-alternate", displayName: "Alternate representation", isBlocked: true }],
    };
    const transport = initialCatalogTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"], unifiedResponse: unifiedRecordsPage([group]),
    });
    transport.page = {
      ...packagePage, value: group.packages, counts: { total: 2, scoped: 2, filtered: 2 },
    };
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Grouped Graph agent" }));
    expect(screen.getByRole("heading", { name: "Agents 1" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Select Grouped Graph agent" })).toBeChecked();
    expect(new URLSearchParams(window.location.search).getAll("selected")).toEqual([agent.id, "package-alternate"]);
    expect(new URLSearchParams(window.location.search).getAll("selectedResource")).toEqual([]);
    expect(screen.queryByRole("region", { name: "Copilot Studio quarantine controls" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    const admittedSelection = currentInventorySelection(transport.fetchMock);
    await userEvent.click(screen.getByRole("button", { name: "Refresh matching details" }));
    await waitFor(() => expect(selectedRefreshRequests(transport.fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(selectedRefreshRequests(transport.fetchMock)[0][1]?.body))).toEqual({
      selectionId: admittedSelection, ids: [agent.id, "package-alternate"],
    });
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it.each([1, 2])("keeps management available when the automatic saved detail read fails for an agent with %s packages", async packageCount => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Saved merged agent");
    const merged: UnifiedAgentRecord = {
      ...native,
      id: "agent:33333333-3333-4333-8333-333333333333",
      presence: "both",
      packages: [agent, { ...agent, id: "package-alternate" }].slice(0, packageCount),
    };
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"], unifiedResponse: unifiedRecordsPage([merged]),
    });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => merged.packages.some(item => isPackageDetailRequest(input, item.id))
      ? Response.json({ code: "provider_error", detail: "Package detail is unavailable" }, { status: 503 })
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "View details for Saved merged agent" }));
    const dialog = await screen.findByRole("dialog", { name: "Saved merged agent" });
    await userEvent.click(within(dialog).getByRole("tab", { name: "Manage" }));
    for (const item of merged.packages) {
      if (packageCount > 1) await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Published version details" }), item.id);
      expect(within(dialog).getByRole("region", { name: `Manage ${item.displayName} (${item.id})` })).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: /^Available to/ })).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: /^Installed for/ })).toBeInTheDocument();
    }
    expect(within(dialog).getByRole("heading", { name: "Copilot Studio quarantine" })).toBeInTheDocument();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Package detail is unavailable");
    expect(transport.fetchMock.mock.calls.filter(([path]) => merged.packages.some(item => isPackageDetailRequest(path, item.id)))).toHaveLength(packageCount);
    expect(transport.fetchMock.mock.calls.some(([path, init]) => String(path).includes("/refresh-jobs") && init?.method === "POST")).toBe(false);
  });

  it.each(["revalidation", "account change", "role loss"] as const)("keeps native and package selections separate and clears them on %s", async boundary => {
    window.history.replaceState({}, "", "/agents?inventory=all");
    const nativeId = "22222222-2222-4222-8222-222222222222";
    const native = powerPlatformRecord(nativeId, "Private native target");
    native.observations.powerPlatform = {
      ...powerPlatformSnapshot(), observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const page = unifiedRecordsPage([unifiedPage.value[0], native]);
    page.sources.powerPlatform.observation = native.observations.powerPlatform;
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"],
      revalidatedRoles: boundary === "role loss" ? viewer.roles : ["AgentControl.Admin"],
      revalidatedUser: boundary === "account change" ? { ...viewer, homeAccountId: "another-account" } : viewer,
      unifiedResponse: page,
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` }));
    const target = screen.getByRole("checkbox", { name: "Select Private native target" });
    await userEvent.click(target);
    expect(target).toBeChecked();
    expect(screen.getByRole("region", { name: "Copilot Studio quarantine controls" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` })).toBeChecked();
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/quarantine/status" || path === "/api/quarantine/preview")).toBe(false);

    await revalidateTransportSession(transport);
    expect(screen.queryByRole("region", { name: "Copilot Studio quarantine controls" })).not.toBeInTheDocument();
    expect(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` })).not.toBeChecked();
    const restoredTarget = screen.getByRole("checkbox", { name: "Select Private native target" });
    expect(restoredTarget).not.toBeChecked();
    if (boundary === "role loss") {
      expect(restoredTarget).toBeDisabled();
    } else {
      expect(restoredTarget).toBeEnabled();
    }
  });

  it("keeps unified saved rows when the auxiliary package catalog is unavailable", async () => {
    window.history.replaceState({}, "", "/agents?inventory=power_platform_only");
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Independent native agent");
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([native]) });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => new URL(input, "http://localhost").pathname === "/api/agents"
      ? Response.json({ code: "inventory_unavailable", detail: "Saved package catalog unavailable" }, { status: 503 })
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("Independent native agent")).toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([input]) => new URL(input, "http://localhost").pathname === "/api/agents")).toBe(false);
    expect(screen.queryByText(/Saved package summaries are unavailable/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "View details for Independent native agent" }));
    expect(await screen.findByRole("dialog", { name: "Independent native agent" })).toBeInTheDocument();
  });

  it("rejects a different package's saved detail and retries only the selected package", async () => {
    const transport = initialCatalogTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    let matching = false;
    transport.fetchMock.mockImplementation((input, init) => isPackageDetailRequest(input, agent.id)
      ? Promise.resolve(Response.json({
        ...agent, id: matching ? agent.id : "unrelated-package",
        longDescription: matching ? "Recovered current agent description" : "Unrelated agent description",
      }))
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View details for Sensitive cached agent" }));
    const detail = await screen.findByRole("dialog", { name: "Sensitive cached agent" });
    expect(await within(detail).findByRole("alert")).toHaveTextContent("Saved agent details did not match the requested published version.");
    expect(screen.queryByText("Unrelated agent description")).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([path]) => isPackageDetailRequest(path, agent.id))).toHaveLength(1);
    matching = true;
    await userEvent.click(within(detail).getByRole("button", { name: "Retry saved details" }));
    expect(await within(detail).findByText("Recovered current agent description")).toBeVisible();
    expect(within(detail).queryByRole("alert")).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([path]) => isPackageDetailRequest(path, agent.id))).toHaveLength(2);
  });

  it("preserves the chosen version and draft through inline access and block confirmations", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const second = { ...agent, id: "package-alternate", displayName: "Second publication", version: "2" };
    const merged = { ...unifiedPage.value[0], packages: [agent, second] };
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (/^\/api\/agent-inventory(?:\?|$)/.test(input)) return Promise.resolve(Response.json(unifiedRecordsPage([merged])));
      if (isPackageDetailRequest(input, second.id)) return Promise.resolve(Response.json({ ...second, longDescription: "Second publication description" }));
      if (input === `/api/agents/${second.id}/refresh-jobs`) return Response.json({
        ...completedRefreshJob(), id: "alternate-access", scopeKind: "exact", requestedIds: [second.id],
      });
      if (input === "/api/agents/mutation-preview") {
        const response = await base(input, init);
        const preview: PackageMutationPreview = await response.json();
        return Response.json({
          ...preview, summary: {
            ...preview.summary,
            targets: preview.summary.targets.map(target => ({ ...target, id: second.id, displayName: second.displayName })),
          },
        });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View details for Sensitive cached agent" }));
    const detail = await screen.findByRole("dialog", { name: "Sensitive cached agent" });
    await userEvent.selectOptions(within(detail).getByRole("combobox", { name: "Published version details" }), second.id);
    expect(await within(detail).findByText("Second publication description")).toBeVisible();
    await userEvent.click(within(detail).getByRole("tab", { name: "Manage" }));
    await userEvent.click(within(detail).getByRole("button", { name: /^Installed for/ }));
    await userEvent.click(within(detail).getByRole("radio", { name: /No users/ }));
    await userEvent.click(within(detail).getByRole("button", { name: "Apply" }));
    const accessConfirmation = await within(detail).findByRole("region", { name: /update installation package/i });
    expect(within(accessConfirmation).getByText(second.id)).toBeVisible();
    expect(screen.getAllByRole("dialog")).toEqual([detail]);
    await userEvent.click(within(accessConfirmation).getByRole("button", { name: "Cancel" }));
    expect(within(detail).getByRole("radio", { name: /No users/ })).toBeChecked();
    expect(within(detail).getByRole("combobox", { name: "Published version details" })).toHaveValue(second.id);
    await userEvent.click(within(detail).getByRole("button", { name: "Block Second publication (package-alternate)" }));
    const confirmation = await within(detail).findByRole("region", { name: /block package/i });
    expect(within(confirmation).getByText(second.id)).not.toBeVisible();
    await userEvent.click(within(confirmation).getByText("Technical details"));
    expect(within(confirmation).getByText(second.id)).toBeVisible();
    await userEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(screen.getAllByRole("dialog")).toEqual([detail]);
    expect(within(detail).getByRole("radio", { name: /No users/ })).toBeChecked();
    expect(within(detail).getByRole("combobox", { name: "Published version details" })).toHaveValue(second.id);
    await userEvent.click(within(detail).getByRole("tab", { name: "Overview" }));
    expect(await within(detail).findByText("Second publication description")).toBeVisible();
    const refreshes = transport.fetchMock.mock.calls.filter(([path]) => /^\/api\/agents\/[^/]+\/refresh-jobs$/.test(path));
    expect(refreshes.map(([path]) => path)).toEqual([`/api/agents/${second.id}/refresh-jobs`]);
    const previews = transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/mutation-preview");
    expect(previews.map(([, init]) => JSON.parse(String(init?.body)))).toMatchObject([
      { action: "update-installation", ids: [second.id] }, { action: "block", ids: [second.id] },
    ]);
  });

  it("preserves one exact quarantine target when reconciliation changes the canonical row ID", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Reconciled agent");
    const initial = { ...native, id: "agent:33333333-3333-4333-8333-333333333333" };
    const merged: UnifiedAgentRecord = {
      ...native, id: "agent:44444444-4444-4444-8444-444444444444", presence: "both",
      packages: [agent, { ...agent, id: "package-alternate" }],
    };
    const transport = appTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"] });
    const base = transport.fetchMock.getMockImplementation()!;
    let reconciled = false;
    transport.fetchMock.mockImplementation(async (input, init) => new URL(input, "http://localhost").pathname === "/api/agent-inventory"
      ? Response.json(unifiedRecordsPage([reconciled ? merged : initial]))
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Reconciled agent" }));
    expect(screen.getByText("1 of 25 exact Copilot Studio agents selected")).toBeInTheDocument();
    reconciled = true;
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.selectOptions(screen.getByDisplayValue("Name (A-Z)"), "displayName:desc");
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Select Reconciled agent" })).toBePartiallyChecked());
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Reconciled agent" }));
    expect(screen.getByRole("checkbox", { name: "Select Reconciled agent" })).toBeChecked();
    expect(screen.getByText("1 of 25 exact Copilot Studio agents selected")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).getAll("selectedResource")).toEqual([native.id]);
    expect(new URLSearchParams(window.location.search).getAll("selected")).toEqual([agent.id, "package-alternate"]);
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Reconciled agent" }));
    expect(screen.queryByRole("region", { name: "Copilot Studio quarantine controls" })).not.toBeInTheDocument();
  });

  it("does not renew retained quarantine proof when newly linked packages are selected", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Snapshot-bound merged agent");
    const merged: UnifiedAgentRecord = {
      ...native, id: "agent:44444444-4444-4444-8444-444444444444", presence: "both", packages: [agent],
      observations: {
        ...native.observations,
        powerPlatform: { ...native.observations.powerPlatform!, id: "new-snapshot", snapshotId: "new-snapshot" },
      },
    };
    const transport = appTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"] });
    const base = transport.fetchMock.getMockImplementation()!;
    let reconciled = false;
    transport.fetchMock.mockImplementation(async (input, init) => new URL(input, "http://localhost").pathname === "/api/agent-inventory"
      ? Response.json(unifiedRecordsPage([reconciled ? merged : native]))
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Snapshot-bound merged agent" }));
    reconciled = true;
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "displayName:desc");
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Select Snapshot-bound merged agent" })).toBePartiallyChecked());
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Snapshot-bound merged agent" }));
    expect(screen.getByRole("checkbox", { name: "Select Snapshot-bound merged agent" })).toBeChecked();
    expect(new URLSearchParams(window.location.search).get("inventorySnapshot")).toBe(native.observations.powerPlatform!.snapshotId);
    expect(new URLSearchParams(window.location.search).getAll("selected")).toEqual([agent.id]);
    expect(screen.getByText("1 of 25 exact Copilot Studio agents selected")).toBeInTheDocument();
  });

  it("reconciles an open native-only detail through its canonical alias when package identities arrive", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Reconciled detail");
    const initial = { ...native, id: "agent:33333333-3333-4333-8333-333333333333" };
    const merged: UnifiedAgentRecord = {
      ...native, id: "agent:44444444-4444-4444-8444-444444444444", presence: "both",
      packages: [agent, { ...agent, id: "package-alternate" }],
    };
    const transport = initialCatalogTransport();
    transport.page = packagePage;
    const base = transport.fetchMock.getMockImplementation()!;
    const refresh = deferredResponse();
    let reconciled = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (unifiedDetailId(input) === initial.id) return Response.json(reconciled ? merged : initial);
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        return Response.json({
          ...unifiedRecordsPage(reconciled ? [merged] : [unifiedPage.value[0], initial]),
          identityCollection: { checkedPackages: reconciled ? 1 : 0, pendingPackages: reconciled ? 0 : 1 },
        });
      }
      if (input === "/api/data-sync/auto-refresh") return refresh.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    await waitFor(() => expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-sync/auto-refresh")).toHaveLength(1));
    await userEvent.click(await screen.findByRole("button", { name: "View details for Reconciled detail" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Reconciled detail" })).getByRole("tab", { name: "Manage" }));
    expect(screen.getByText("No published version is available for availability or installation settings.")).toBeInTheDocument();
    reconciled = true;
    await act(async () => refresh.resolve(Response.json(automaticRefreshResponse())));

    const dialog = screen.getByRole("dialog", { name: "Reconciled detail" });
    const versions = await within(dialog).findByRole("combobox", { name: "Published version details" });
    expect(within(versions).getAllByRole("option")).toHaveLength(2);
    await userEvent.selectOptions(versions, merged.packages[1].id);
    expect(within(dialog).getByRole("region", { name: `Manage ${merged.packages[1].displayName} (${merged.packages[1].id})` })).toBeVisible();
    expect(new URLSearchParams(window.location.search).get("detail")).toBe(merged.id);
    expect(transport.fetchMock.mock.calls.some(([path]) => unifiedDetailId(path) === initial.id)).toBe(true);
  });

  it("uses the selected report context for off-page exact reads and current usage changes", async () => {
    const report = selectedAgentsPage();
    const context = { reports: report.reports, expiresAt: report.reports.expiresAt, revision: "b".repeat(64) };
    const selectedContext = { reports: report.reports, reportSetId: report.reports.setId, selectionId: report.selection.id,
      usageRevision: "b".repeat(64), inventoryRevision: "c".repeat(64) };
    const target = { source: "graph_packages" as const, packageId: "off-page-package" };
    const record: UnifiedAgentRecord = {
      ...unifiedPage.value[0], id: "graph_packages:off-page-package", displayName: "Off-page usage agent",
      packages: [{ ...agent, id: target.packageId, displayName: "Off-page usage agent" }],
      usage: {
        recordId: "graph_packages:off-page-package", status: "linked", reportSetId: report.reports.setId, responses: 215, activeUsers: 2,
        lastActivityDateUtc: null, associationCount: 1,
      },
    };
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"],
      unifiedResponse: {
        ...unifiedPage,
        usageContext: context,
      },
    });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input, "http://localhost");
      if (unifiedDetailId(input) === record.id) return Response.json(record);
      if (isPackageDetailRequest(input, target.packageId)) return Response.json(record.packages[0]);
      if (url.pathname.endsWith("/usage")) {
        expect(url.searchParams.get("setId")).toBe(report.reports.setId);
        return Response.json({ ...record.usage, recordId: record.id, context: selectedContext });
      }
      if (url.pathname.endsWith("/usage-associations")) return Response.json(init?.method === "DELETE" ? selectedContext : {
        value: [{ reportAgentId: "synthetic-researcher", agentName: "Researcher", responses: 215,
          target: { ...target, snapshotId: "exact-package-snapshot" }, basis: "reviewed" }],
        context: selectedContext, counts: { total: 1, filtered: 1 }, page: { limit: 50, nextCursor: null, previousCursor: null },
      });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await waitFor(() => expect(transport.fetchMock).toHaveBeenCalledWith("/api/data-sync/auto-refresh", expect.anything()));
    await act(async () => {
      window.history.pushState({}, "", `/agents?detail=${encodeURIComponent(record.id)}&detailTab=reports`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const detail = await screen.findByRole("dialog", { name: record.displayName });
    expect(await within(detail).findByLabelText("Selected agent report metrics")).toHaveTextContent("215");
    const exactReads = () => transport.fetchMock.mock.calls.filter(([input]) => unifiedDetailId(input) === record.id);
    expect(exactReads()).toHaveLength(1);
    await userEvent.click(await within(detail).findByRole("button", { name: "Remove reviewed association" }));
    await userEvent.click(within(detail).getByRole("checkbox", { name: "I confirm this exact report association removal" }));
    await userEvent.click(within(detail).getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(transport.fetchMock.mock.calls.find(([input, init]) =>
      input.endsWith("/usage-associations") && init?.method === "DELETE")?.[1]).toMatchObject({
        body: JSON.stringify({
          selectionId: selectedContext.selectionId, reportSetId: report.reports.setId,
          usageRevision: selectedContext.usageRevision, inventoryRevision: selectedContext.inventoryRevision,
          reportAgentId: "synthetic-researcher", confirmed: true,
        }),
      }));
  });

  it("restores off-page canonical and source quarantine aliases as one exact native selection", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Off-page target");
    const canonicalAlias = "agent:33333333-3333-4333-8333-333333333333";
    const merged: UnifiedAgentRecord = {
      ...native, id: "agent:44444444-4444-4444-8444-444444444444", presence: "both", packages: [agent],
    };
    window.history.replaceState({}, "", `/agents?inventorySnapshot=pp-snapshot&selectedResource=${encodeURIComponent(canonicalAlias)}&selectedResource=${encodeURIComponent(native.id)}`);
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"], unifiedResponse: unifiedRecordsPage([]),
    });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const exact = unifiedDetailId(input);
      return exact === canonicalAlias || exact === native.id
        ? Response.json(merged)
        : base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("1 of 25 exact Copilot Studio agents selected")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).getAll("selectedResource")).toEqual([native.id]);
    expect(new URLSearchParams(window.location.search).getAll("selected")).toEqual([]);
    expect(transport.fetchMock.mock.calls.filter(([path, init]) => path.startsWith("/api/quarantine/") && init?.method === "POST")).toHaveLength(0);
  });

  it("cancels a pending canonical quarantine restore without a late response reselecting its native target", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Pending native target");
    const alias = "agent:33333333-3333-4333-8333-333333333333";
    window.history.replaceState({}, "", `/agents?inventory=power_platform_only&inventorySnapshot=pp-snapshot&selectedResource=${encodeURIComponent(alias)}`);
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"], unifiedResponse: unifiedRecordsPage([native]),
    });
    const base = transport.fetchMock.getMockImplementation()!;
    const lookup = deferredResponse();
    transport.fetchMock.mockImplementation(async (input, init) => unifiedDetailId(input) === alias
      ? lookup.promise
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    const controls = await screen.findByRole("region", { name: "Copilot Studio quarantine controls" });
    expect(await screen.findByRole("checkbox", { name: "Select Pending native target" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "View details for Pending native target" })).toBeEnabled();
    expect(within(controls).getByText(/Restoring 1 bookmarked quarantine selection/)).toBeVisible();
    await userEvent.click(within(controls).getByRole("button", { name: "Clear" }));
    await act(async () => lookup.resolve(Response.json(native)));
    expect(screen.queryByRole("region", { name: "Copilot Studio quarantine controls" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Pending native target" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Select Pending native target" })).not.toBeChecked();
    expect(new URLSearchParams(window.location.search).getAll("selectedResource")).toEqual([]);
  });

  it("does not renew a bookmarked quarantine selection with a different inventory snapshot", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Snapshot-bound target");
    window.history.replaceState({}, "", `/agents?inventory=power_platform_only&inventorySnapshot=previous-snapshot&selectedResource=${encodeURIComponent(native.id)}`);
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"], unifiedResponse: unifiedRecordsPage([native]),
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText(/Could not restore.*quarantine.*saved inventory changed/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Snapshot-bound target" })).not.toBeChecked();
    expect(screen.queryByText("1 of 25 exact Copilot Studio agents selected")).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([path, init]) => path.startsWith("/api/quarantine/") && init?.method === "POST")).toHaveLength(0);
  });

  it("keeps search and view in the table toolbar and opens detailed filters on demand", async () => {
    vi.stubGlobal("fetch", appTransport({ revalidatedRoles: viewer.roles }).fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const filters = within(screen.getByRole("region", { name: "Filters" }));
    expect(filters.getAllByRole("combobox")).toHaveLength(1);
    expect(filters.getByRole("button", { name: "Filters" })).toHaveAttribute("aria-expanded", "false");
    expect(filters.queryByLabelText("Environment")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Source")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Source link")).not.toBeInTheDocument();
    expect(filters.getByRole("combobox", { name: "Show agents" })).toBeVisible();
    expect(filters.queryByLabelText("Publisher")).not.toBeInTheDocument();
    expect(filters.queryByRole("button", { name: "Export agent inventory CSV" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeInTheDocument();
    await userEvent.click(filters.getByRole("button", { name: "Filters" }));
    expect(filters.getByRole("dialog", { name: "Filter agents" })).toBeVisible();
    for (const label of ["Built with", "Assigned access", "Host", "Package status", "Environment", "Search environments", "Publisher", "Sort"]) {
      expect(filters.getByLabelText(label)).toBeVisible();
    }
    expect(filters.getByRole("spinbutton", { name: "Created within days" })).toBeVisible();
    expect(filters.getByRole("combobox", { name: "Built with" })).toHaveFocus();
  });

  it("preserves hidden filters across tabs and exposes restored routes through removable chips", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search environments" }), "fin");
    expect(window.location.search).not.toContain("environment=");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Environment" }), encodeInventoryFacet("env-a"));
    const toggle = screen.getByRole("button", { name: "Filters, 1 active" });
    await userEvent.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
    expect(screen.queryByLabelText("Environment")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove environment filter" })).toHaveTextContent("Finance");
    expect(new URLSearchParams(window.location.search).get("environment")).toBe(encodeInventoryFacet("env-a"));
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(screen.getByRole("button", { name: "Filters, 1 active" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Remove environment filter" })).toHaveTextContent("Finance");
    await act(async () => {
      window.history.pushState({}, "", `/agents?${new URLSearchParams({ linkState: "conflicting", environment: encodeInventoryFacet("env-b") })}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("button", { name: "Filters, 1 active" })).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(screen.getByRole("button", { name: "Filters, 1 active" }));
    expect(screen.getByLabelText("Environment")).toHaveValue(encodeInventoryFacet("env-b"));
    expect(window.location.search).not.toContain("linkState");
  });

  it("round trips organization views and new sorts through list requests, headings, export and clear", async () => {
    window.history.replaceState({}, "", "/agents?show=organization&sort=responses&direction=desc");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await screen.findByText(agent.displayName);
    expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "Filters, 1 active" }));
    expect(screen.getByRole("combobox", { name: "Organization/usage evidence" })).toHaveValue("organization");
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("responses:desc");
    const unifiedRequests = () => transport.fetchMock.mock.calls.filter(([input]) => input.startsWith("/api/agent-inventory?"));
    expect(selectedInventoryUrl(unifiedRequests().at(-1)![0]).searchParams.get("relevance")).toBe("organization");
    expect(selectedInventoryUrl(agentListRequests(transport.fetchMock).at(-1)![0]).searchParams.get("sortBy")).toBe("responses");

    await userEvent.click(screen.getByRole("button", { name: "Columns" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Hosts" }));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Sort by Hosts" }));
    await waitFor(() => expect(screen.getByRole("columnheader", { name: "Hosts" })).toHaveAttribute("aria-sort", "ascending"));
    expect(new URLSearchParams(window.location.search).get("sort")).toBe("hosts");
    const exportButton = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await userEvent.click(exportButton);
    await userEvent.click(await screen.findByRole("button", { name: /Download matching agents/ }));
    await completeNativeInventoryDownload(download);
    const exported = inventoryExportRequest(transport.fetchMock);
    expect(exported).toEqual({ kind: "unified_agents", selectionId: currentInventorySelection(transport.fetchMock), idempotencyKey: expect.any(String) });
    expect(inventorySelections.get(exported.selectionId)?.query).toMatchObject({
      relevance: "organization", sortBy: "hosts", sortDirection: "asc",
    });
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue(""));
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("hosts:asc");
    expect(new URLSearchParams(window.location.search).has("show")).toBe(false);
    await waitFor(() => expect(selectedInventoryUrl(unifiedRequests().at(-1)![0]).searchParams.has("view")).toBe(false));
  });

  it("combines party, access, usage and management across requests, exports and browser history", async () => {
    window.history.replaceState({}, "", "/agents?show=third_party&access=available&usage=used&management=organization_managed");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await screen.findByText(agent.displayName);
    expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue(encodeInventoryFacet("thirdParty"));
    expect(screen.getByRole("button", { name: "Show available to end users" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Show reported used agents" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Filters, 3 active" })).toBeVisible();
    const lastQuery = () => selectedInventoryUrl(transport.fetchMock.mock.calls.filter(([input]) => input.startsWith("/api/agent-inventory?")).at(-1)![0]).searchParams;
    expect(Object.fromEntries(lastQuery())).toMatchObject({
      type: "thirdParty", endUserAccess: "available", reportedUsage: "used", management: "organization_managed",
    });
    const exportButton = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await userEvent.click(exportButton);
    await userEvent.click(await screen.findByRole("button", { name: /Download matching agents/ }));
    await completeNativeInventoryDownload(download);
    const exported = inventoryExportRequest(transport.fetchMock);
    expect(exported).toEqual({ kind: "unified_agents", selectionId: currentInventorySelection(transport.fetchMock), idempotencyKey: expect.any(String) });
    expect(inventorySelections.get(exported.selectionId)?.query).toMatchObject({
      type: encodeInventoryFacet("thirdParty"), endUserAccess: "available", reportedUsage: "used", management: "organization_managed",
    });
    await userEvent.click(screen.getByRole("button", { name: "Remove reported usage filter" }));
    await waitFor(() => expect(lastQuery().has("reportedUsage")).toBe(false));
    expect(lastQuery().get("type")).toBe("thirdParty");
    expect(lastQuery().has("view")).toBe(false);
    expect(lastQuery().get("management")).toBe("organization_managed");
    await act(async () => {
      window.history.pushState({}, "", "/agents?show=first_party&usage=used");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(lastQuery().get("type")).toBe("firstParty"));
    expect(lastQuery().get("reportedUsage")).toBe("used");
    expect(lastQuery().has("endUserAccess")).toBe(false);
    expect(lastQuery().has("management")).toBe(false);
    expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue(encodeInventoryFacet("firstParty"));
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(lastQuery().has("reportedUsage")).toBe(false));
    expect(lastQuery().has("type")).toBe(false);
    expect(window.location.search).toBe("");
  });

  it("preserves the focused sort control and column choices while a server sort is pending", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation(async (input, init) => {
      const url = selectedInventoryUrl(input);
      if (url.pathname === "/api/agent-inventory" && url.searchParams.get("sortBy") === "hosts") return pending.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("button", { name: "Columns" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Hosts" }));
    await userEvent.keyboard("{Escape}");
    const heading = screen.getByRole("button", { name: "Sort by Hosts" });
    await userEvent.click(heading);
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) => {
      const url = selectedInventoryUrl(input);
      return url.pathname === "/api/agent-inventory" && url.searchParams.get("sortBy") === "hosts";
    })).toBe(true));
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveFocus();
    expect(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` })).toBeDisabled();
    const exportButton = screen.getByRole("button", { name: "Export agent inventory CSV" });
    expect(exportButton).toBeDisabled();
    const refresh = screen.getByRole("status", { name: "Updating agent results" });
    expect(exportButton.parentElement).toContainElement(refresh);
    expect(refresh.querySelector("svg")).toHaveClass("agent-refresh-spinner");
    expect(refresh).toHaveTextContent("Updating agent results...");
    expect(refresh.closest(".agent-table-stack")).toBeNull();
    expect(screen.queryByText(/Previous results remain visible/)).not.toBeInTheDocument();
    await act(async () => pending.resolve(Response.json(unifiedPage)));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` })).toBeEnabled());
    expect(screen.queryByRole("status", { name: "Updating agent results" })).not.toBeInTheDocument();
    expect(exportButton.parentElement?.querySelector(".agent-refresh-indicator")).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: "Sort by Hosts" })).toBe(heading);
    expect(heading).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("columnheader", { name: "Hosts" })).toHaveAttribute("aria-sort", "descending"));
  });

  it("shows bookmarked restrictions as chips and clears every filter without changing sorting", async () => {
    window.history.replaceState({}, "", `/agents?${new URLSearchParams({ q: "agent", source: "graph_packages", status: "allowed",
      linkState: "unmatched", environment: encodeInventoryFacet("env-a"), publisher: encodeInventoryFacet("Microsoft"),
      availability: encodeInventoryFacet("some"), host: encodeInventoryFacet("Teams"), platform: encodeInventoryFacet("studio"),
      createdWithinDays: "30", sort: "lastModifiedAt", direction: "desc" })}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agents") return Response.json({
        ...packagePage,
        facets: {
          publishers: [{ value: "Microsoft", label: "Microsoft" }],
          availability: [{ value: "some", label: "Some users" }],
          hosts: [{ value: "Teams", label: "Teams" }],
          platforms: [{ value: "studio", label: "Copilot Studio" }],
        },
      });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const toggle = await screen.findByRole("button", { name: "Filters, 7 active" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Remove environment filter" })).toBeVisible();
    await userEvent.click(toggle);
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("lastModifiedAt:desc");
    expect(window.location.search).not.toMatch(/source=|linkState=/);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: "Filters" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("");
    expect(window.location.search).toBe("?sort=lastModifiedAt&direction=desc");
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("combobox", { name: "Package status" })).toHaveValue("all");
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("lastModifiedAt:desc");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "displayName:desc");
    expect(window.location.search).toBe("?direction=desc");
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) => {
      const url = selectedInventoryUrl(input);
      return url.pathname === "/api/agent-inventory" && url.searchParams.get("sortBy") === "displayName" && url.searchParams.get("sortDirection") === "desc";
    })).toBe(true));
  });

  it("keeps bookmarked filters disclosed by chips and ignores obsolete source/link URL restrictions", async () => {
    window.history.replaceState({}, "", `/agents?${new URLSearchParams({ source: "power_platform", linkState: "matched",
      platform: encodeInventoryFacet("studio"), createdWithinDays: "30", host: encodeInventoryFacet("Teams"), availability: encodeInventoryFacet("some") })}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Filters, 4 active" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Remove created within filter" })).toHaveTextContent("30 days");
    await userEvent.click(screen.getByRole("button", { name: "Filters, 4 active" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Built with" })).toHaveValue(encodeInventoryFacet("studio")));
    expect(screen.getByRole("spinbutton", { name: "Created within days" })).toHaveValue(30);
    await waitFor(() => expect(window.location.search).not.toMatch(/source=|linkState=/));
    const queries = transport.fetchMock.mock.calls.map(([input]) => selectedInventoryUrl(input))
      .filter(url => url.pathname === "/api/agent-inventory");
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(url => !url.searchParams.has("source") && !url.searchParams.has("linkState"))).toBe(true);
  });

  it.each([
    { value: "displayName:asc", search: "", sortBy: "displayName", sortDirection: "asc" },
    { value: "displayName:desc", search: "?direction=desc", sortBy: "displayName", sortDirection: "desc" },
    { value: "lastModifiedAt:asc", search: "?sort=lastModifiedAt", sortBy: "lastModifiedAt", sortDirection: "asc" },
    { value: "lastModifiedAt:desc", search: "?sort=lastModifiedAt&direction=desc", sortBy: "lastModifiedAt", sortDirection: "desc" },
  ])("serializes combined sort $value and resets pagination", async ({ value, search, sortBy, sortDirection }) => {
    window.history.replaceState({}, "", "/agents?page=3");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort" }), value);
    expect(window.location.search).toBe(search);
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) => {
      const url = selectedInventoryUrl(input);
      return url.pathname === "/api/agent-inventory" && !url.searchParams.has("cursor")
        && url.searchParams.get("sortBy") === sortBy && url.searchParams.get("sortDirection") === sortDirection;
    })).toBe(true));
  });

  it("keeps the verified Agents page focused on filters, agent rows and management without a diagnostic panel", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: verifiedSavedAgentPage() });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText(agent.displayName)).toBeVisible();
    expect(screen.getByRole("region", { name: "Filters" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Saved agent inventory verification" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify saved inventory" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Inventory needs attention/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Graph package targets")).not.toBeInTheDocument();
    expect(screen.queryByText("Optional directory-role hint")).not.toBeInTheDocument();
  });

  it("does not send admins from Agents to Sync for expired package details alone", async () => {
    const page = verifiedSavedAgentPage();
    page.identityCollection = {
      checkedPackages: 461, pendingPackages: 549, pendingDetails: { missing: 0, stale: 549, invalidated: 0 },
    };
    page.verification = { ...createUnifiedVerification(page.verification, { packageMetadata: false }), status: "details_pending" };
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText(agent.displayName)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Inventory needs attention/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    expect(await screen.findByText("Sources checked")).toBeVisible();
    expect(screen.queryByText("What needs attention")).not.toBeInTheDocument();
    expect(screen.queryByText(/awaiting identity metadata/)).not.toBeInTheDocument();
  });

  it("shows a concise issue notice on Agents and immediately explains it near the top of Sync", async () => {
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"],
      revalidatedRoles: ["AgentControl.Admin"],
      unifiedResponse: {
        ...unifiedPage,
        partial: true,
        errors: [{ source: "power_platform", code: "coverage_unknown", message: "Copilot Studio agent coverage is incomplete." }],
      },
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    await screen.findByText(agent.displayName);
    expect(screen.queryByRole("region", { name: "Data sync" })).not.toBeInTheDocument();
    expect(screen.queryByText("Setup complete")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Block selected packages" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Copilot Studio quarantine controls" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Source matching details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Power Platform agent source" })).not.toBeInTheDocument();
    expect(screen.queryByText("Source-metadata links")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Saved agent inventory verification" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Copilot Studio agent coverage is incomplete\./)).not.toBeInTheDocument();
    const issue = screen.getByRole("button", { name: /Inventory needs attention.*Open Sync/ });
    expect(issue).toBeVisible();
    expect(issue).toHaveAttribute("title", expect.stringContaining("Copilot Studio agent coverage is incomplete."));
    expect(screen.queryByRole("button", { name: "Refresh agents" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` }));
    expect(screen.getByRole("button", { name: "Block selected packages" })).toBeVisible();
    await userEvent.click(issue);
    expect(window.location.pathname).toBe("/sync");
    expect(screen.getByRole("region", { name: "Data sync" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Inventory diagnostics" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Saved agent inventory verification" })).not.toBeInTheDocument();
    expect(screen.getByText("Copilot Studio agent coverage is incomplete.")).toBeVisible();
    const health = screen.getByRole("region", { name: "Inventory health" });
    expect(health.compareDocumentPosition(screen.getByRole("region", { name: "CSV usage reports" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(within(screen.getByRole("dialog", { name: "Inventory diagnostics" })).getByText(/Copilot Studio agent coverage is incomplete\./)).toBeVisible();
    expect(screen.getByText("Source-metadata links")).toBeVisible();
    expect(screen.getByText(/1 published target selected/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Sync history" })).toBeVisible();
    expect(screen.queryByText("No Agent Control app role is assigned.")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Data sync" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Browse agents" }));
    expect(window.location.pathname).toBe("/agents");
    expect(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` })).toBeChecked();
  });

  it.each(["agents", "sync"])("offers saved-only verification in Sync advanced results when starting from %s", async view => {
    window.history.replaceState({}, "", `/${view}?q=Sensitive`);
    const page = verifiedSavedAgentPage();
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const permissionCatalog = deferredResponse();
    let verificationRequested = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/capabilities") return permissionCatalog.promise;
      if (input === "/api/capabilities/check") return base("/api/capabilities", init);
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        return verificationRequested ? pending.promise : Response.json(page);
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    if (view === "agents") {
      await screen.findByText(agent.displayName);
      expect(screen.queryByRole("button", { name: "Verify saved inventory" })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    }
    await within(await screen.findByRole("region", { name: "Inventory health" })).findByText("Verified");
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    // Finish the independent startup permission check before measuring the saved-only actions.
    await act(async () => permissionCatalog.resolve(await base("/api/capabilities")));
    await waitFor(() => expect(transport.fetchMock.mock.calls
      .filter(([, init]) => init?.method && init.method !== "GET").map(([input, init]) => [input, init?.method]))
      .toEqual(expect.arrayContaining([["/api/capabilities/check", "POST"], ["/api/data-sync/auto-refresh", "POST"]])));
    await waitFor(() => expect(screen.getByRole("button", { name: "Permissions" })).toHaveAttribute("aria-busy", "false"));
    const beforeExpansion = transport.fetchMock.mock.calls.length;
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(transport.fetchMock.mock.calls.slice(beforeExpansion)
      .filter(([path, init]) => path !== "/api/agent-inventory/selections" && init?.method && init.method !== "GET").map(([input, init]) => [input, init?.method])).toEqual([]);
    const receipt = within(screen.getByRole("region", { name: "Saved agent inventory verification" }));
    expect(receipt.getByText("Resources stored / provider total").nextElementSibling).toHaveTextContent("4,178 / 4,178");
    expect(receipt.getByText("Provider pages collected").nextElementSibling).toHaveTextContent("42");
    expect(receipt.getByText("Optional directory-role hint").nextElementSibling).toHaveTextContent("Not supplied");
    const collectedTime = receipt.getByText("Graph source collected at").nextElementSibling?.textContent;
    const before = transport.fetchMock.mock.calls.length;
    verificationRequested = true;
    await userEvent.click(receipt.getByRole("button", { name: "Verify saved inventory" }));
    expect(receipt.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(receipt.getByRole("button", { name: "Verifying saved inventory..." })).toBeDisabled();
    const checkedAt = "2026-09-17T06:15:00.000Z";
    await act(async () => pending.resolve(Response.json({
      ...page, revision: "b".repeat(64), verification: { ...page.verification, checkedAt },
    })));
    await receipt.findByText("Saved inventory verified");
    expect(receipt.getByText("Saved data verified at").nextElementSibling?.querySelector("time")).toHaveAttribute("datetime", checkedAt);
    expect(receipt.getByText("Graph source collected at").nextElementSibling).toHaveTextContent(collectedTime!);
    const requests = transport.fetchMock.mock.calls.slice(before);
    expect(requests.filter(([input]) => input.startsWith("/api/agent-inventory?"))).toHaveLength(1);
    expect(requests.filter(([path, init]) => path !== "/api/agent-inventory/selections" && init?.method && init.method !== "GET").map(([input, init]) => [input, init?.method])).toEqual([]);
    expect(new URL(agentListRequests(transport.fetchMock).at(-1)![0], "http://localhost").searchParams.has("snapshotId")).toBe(false);
    expect(receipt.queryByText(/partial inventory|coverage unknown/i)).not.toBeInTheDocument();
  });

  it("keeps Sync diagnostics and verification saved-only while the startup permission check is delayed", async () => {
    window.history.replaceState({}, "", "/sync");
    const page = verifiedSavedAgentPage();
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page });
    const base = transport.fetchMock.getMockImplementation()!;
    const permissionCatalog = deferredResponse();
    const verification = deferredResponse();
    let verificationRequested = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/capabilities") return permissionCatalog.promise;
      if (input === "/api/capabilities/check") return base("/api/capabilities", init);
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        return verificationRequested ? verification.promise : Response.json(page);
      }
      return base(input, init);
    });
    const nonGetRequests = () => transport.fetchMock.mock.calls
      .filter(([path, init]) => path !== "/api/agent-inventory/selections" && init?.method && init.method !== "GET").map(([input, init]) => [input, init?.method]);
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await within(await screen.findByRole("region", { name: "Inventory health" })).findByText("Verified");
    expect(screen.getByRole("button", { name: "Permissions" })).toHaveAttribute("aria-busy", "true");
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(nonGetRequests()).toEqual([["/api/data-sync/auto-refresh", "POST"]]);
    const receipt = within(screen.getByRole("region", { name: "Saved agent inventory verification" }));
    verificationRequested = true;
    const beforeVerification = transport.fetchMock.mock.calls.length;
    await userEvent.click(receipt.getByRole("button", { name: "Verify saved inventory" }));
    expect(receipt.getByRole("button", { name: "Verifying saved inventory..." })).toBeDisabled();
    expect(nonGetRequests()).toEqual([["/api/data-sync/auto-refresh", "POST"]]);
    await act(async () => permissionCatalog.resolve(await base("/api/capabilities")));
    await waitFor(() => expect(nonGetRequests()).toEqual(expect.arrayContaining([["/api/capabilities/check", "POST"], ["/api/data-sync/auto-refresh", "POST"]])));
    await waitFor(() => expect(screen.getByRole("button", { name: "Permissions" })).toHaveAttribute("aria-busy", "false"));
    expect(receipt.getByRole("button", { name: "Verifying saved inventory..." })).toBeDisabled();
    await act(async () => verification.resolve(Response.json({ ...page, revision: "b".repeat(64) })));
    await receipt.findByText("Saved inventory verified");
    expect(transport.fetchMock.mock.calls.slice(beforeVerification).filter(([input]) => input.startsWith("/api/agent-inventory?"))).toHaveLength(1);
    expect(nonGetRequests()).toEqual(expect.arrayContaining([["/api/capabilities/check", "POST"], ["/api/data-sync/auto-refresh", "POST"]]));
  });

  it("keeps the full verified receipt under search, environment filtering and a later result page", async () => {
    window.history.replaceState({}, "", `/agents?${new URLSearchParams({ q: "Sensitive", environment: encodeInventoryFacet("env-a") })}`);
    const saved = verifiedSavedAgentPage();
    const page = { ...saved, counts: { ...saved.counts, filtered: 51 },
      value: Array.from({ length: 51 }, (_, index) => ({ ...unifiedPage.value[0], id: `graph_packages:saved-${index}`,
        displayName: `Sensitive saved ${index}`, environmentId: "env-a", packages: [{ ...agent, id: `saved-${index}` }] })) };
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText("Sensitive saved 0");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Sensitive saved 50");
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    await screen.findByText("Saved inventory verified");
    const receipt = within(screen.getByRole("region", { name: "Saved agent inventory verification" }));
    expect(receipt.getByText("Logical agents").nextElementSibling).toHaveTextContent(/^1,561$/);
    expect(receipt.getByText("Targets represented / unique source targets").nextElementSibling).toHaveTextContent("2,257 / 2,257");
    expect(receipt.getByText("Environment request scope").nextElementSibling).toHaveTextContent("All environments requested");
    expect(transport.fetchMock.mock.calls.some(([input]) => {
      const url = selectedInventoryUrl(input);
      return url.pathname === "/api/agent-inventory" && url.searchParams.get("search") === "Sensitive"
        && url.searchParams.get("environmentId") === "env-a" && url.searchParams.get("cursor") === "fixture-page:50";
    })).toBe(true);
  });

  it.each([false, true])("keeps pending metadata visible without launching automatic provider backfill after Verify saved inventory (page correction: %s)", async correctPage => {
    window.history.replaceState({}, "", correctPage ? "/sync?q=Sensitive&page=2" : "/sync?q=Sensitive");
    const page = verifiedSavedAgentPage();
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page });
    const base = transport.fetchMock.getMockImplementation()!;
    let verificationRequested = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/capabilities" || input.startsWith("/api/capabilities/check")) {
        const definition = capabilityDefinitions.find(item => item.id === "graph.package.read.delegated")!;
        return Response.json({ value: [{ definition, decision: {
          capabilityId: definition.id, status: "available", authorized: true, fresh: true, verification: "provider",
          checkedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
          previewQualification: "not_required", remediation: [],
        } }] });
      }
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Response.json(verificationRequested ? {
        ...page, revision: "b".repeat(64), identityCollection: { checkedPackages: 1008, pendingPackages: 2 },
        verification: createUnifiedVerification(page.verification, { packageMetadata: false }),
      } : correctPage ? { ...page, count: 51, offset: 50 } : page);
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByText("View diagnostics"));
    await screen.findByText("Saved inventory verified");
    const before = transport.fetchMock.mock.calls.length;
    verificationRequested = true;
    await userEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
    await screen.findByText("Saved source accounting verified");
    expect(screen.getByText("Package detail checks are not all current. This is not a missing-agent count.")).toBeVisible();
    expect(screen.queryByText("What needs attention")).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.slice(before).filter(([path, init]) => path !== "/api/agent-inventory/selections" && init?.method === "POST")).toEqual([]);
    expect(transport.fetchMock.mock.calls.slice(before)
      .filter(([input]) => new URL(input, "http://localhost").pathname === "/api/agent-inventory")
      .map(([input]) => new URL(input, "http://localhost").searchParams.get("cursor"))).toEqual([null]);
  });

  it.each(["conflict", "expiry"] as const)("replaces a previous green receipt after %s and permits a saved-only retry", async failure => {
    window.history.replaceState({}, "", "/sync?q=Sensitive");
    const page = verifiedSavedAgentPage();
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page });
    const base = transport.fetchMock.getMockImplementation()!;
    const message = failure === "expiry"
      ? "The saved agent inventory or usage report expired. Reload Agents."
      : "Saved normalized identities do not match provider total.";
    let fail = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname !== "/api/agent-inventory") return base(input, init);
      if (!fail) return Response.json(page);
      return failure === "expiry"
        ? Response.json({ code: "selection_invalidated", detail: message }, { status: 409 })
        : Response.json({ detail: message }, { status: 409 });
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByText("View diagnostics"));
    await screen.findByText("Saved inventory verified");
    const receipt = within(screen.getByRole("region", { name: "Saved agent inventory verification" }));
    const before = transport.fetchMock.mock.calls.length;
    fail = true;
    await userEvent.click(receipt.getByRole("button", { name: "Verify saved inventory" }));
    await waitFor(() => expect(receipt.getByRole("alert")).toHaveTextContent(message));
    expect(receipt.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(receipt.queryByText("Authorized Power Platform query verified")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    const issue = await screen.findByRole("button", { name: /Inventory needs attention.*Open Sync/ });
    expect(issue).toHaveAttribute("title", expect.stringContaining(message));
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    await userEvent.click(issue);
    await userEvent.click(screen.getByText("View diagnostics"));
    const retryReceipt = within(screen.getByRole("region", { name: "Saved agent inventory verification" }));
    await waitFor(() => expect(retryReceipt.getByRole("alert")).toHaveTextContent(message));
    fail = false;
    await userEvent.click(retryReceipt.getByRole("button", { name: "Verify saved inventory" }));
    await retryReceipt.findByText("Saved inventory verified");
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled());
    expect(transport.fetchMock.mock.calls.slice(before).some(([path, init]) => path !== "/api/agent-inventory/selections" && init?.method && init.method !== "GET")).toBe(false);
  });

  it("does not let a late saved verification restore protected receipts after session revalidation", async () => {
    window.history.replaceState({}, "", "/sync?q=Sensitive");
    const page = verifiedSavedAgentPage();
    const transport = appTransport({ revalidatedRoles: [], unifiedResponse: page });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let deferNextRead = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        if (deferNextRead) { deferNextRead = false; return pending.promise; }
        return Response.json(page);
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByText("View diagnostics"));
    await screen.findByText("Saved inventory verified");
    deferNextRead = true;
    await userEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
    await revalidateTransportSession(transport);
    await act(async () => pending.resolve(Response.json(page)));
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Saved agent inventory verification" })).not.toBeInTheDocument();
  });

  it("keeps user collection in primary Sync navigation without duplicate page actions", async () => {
    window.history.replaceState({}, "", "/users");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/copilot-usage/users") return Response.json(selectedUsersPage());
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("button", { name: "Ada" });
    expect(screen.queryByRole("button", { name: "Sync users" })).not.toBeInTheDocument();
    const navigation = screen.getByRole("navigation", { name: "Primary views" });
    await userEvent.click(within(navigation).getByRole("button", { name: "Sync" }));
    expect(window.location.pathname).toBe("/sync");
    expect(screen.getByRole("region", { name: "Data sync" })).toBeVisible();
    expect(transport.fetchMock.mock.calls.some(([path, init]) => path === "/api/data-sync/runs" && init?.method === "POST")).toBe(false);
    await userEvent.click(within(navigation).getByRole("button", { name: "Users" }));
    expect(window.location.pathname).toBe("/users");
    expect(screen.queryByRole("region", { name: "Data sync" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Data sync" })).not.toBeInTheDocument();
  });

  it("introduces agent management benefits and offers one Entra sign-in", async () => {
    const transport = appTransport({ revalidatedRoles: [], authenticated: false });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Sign in with Entra ID" })).toBeEnabled();
    expect(within(screen.getByRole("region", { name: "Agent Control" })).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Work or school username" })).toBeVisible();
    expect(screen.getByText("Understand and manage your organization's AI agents in one place.")).toBeInTheDocument();
    expect(screen.getByText(/Discover agents across Microsoft 365 and Copilot Studio, explore Copilot usage and service insights, and investigate activity/)).toBeInTheDocument();
    expect(screen.getByText(/Make informed decisions about adoption and access, with the controls to take action/)).toBeInTheDocument();
    expect(screen.queryByText(/outstanding delegated permissions|Consent does not run investigations/)).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).includes("/api/capabilities"))).toBe(false);
  });

  it("offers recovery after declined setup without automatically restarting authorization", async () => {
    window.history.replaceState({}, "", "/permissions?authorization=cancelled");
    const transport = appTransport({ revalidatedRoles: [], authenticated: false });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("status")).toHaveTextContent("Microsoft permission setup was cancelled or denied. Retry or contact your tenant administrator.");
    expect(screen.getByRole("button", { name: "Sign in with Entra ID" })).toBeEnabled();
    expect(within(screen.getByRole("region", { name: "Agent Control" })).getAllByRole("button")).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).includes("/api/auth/consent"))).toBe(false);
  });

  it("purges cached rows before accepting a role-revalidated session", async () => {
    const transport = appTransport({ revalidatedRoles: [], deferRevalidation: true });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View details for Sensitive cached agent" }));
    expect(await screen.findByRole("dialog", { name: "Sensitive cached agent" })).toBeInTheDocument();

    transport.failProtectedReadsWith = 401;
    await act(async () => {
      await expect(getAgents()).rejects.toMatchObject({ status: 401 });
    });

    await waitFor(() => expect(transport.meCalls()).toBe(2));
    expect(screen.queryByText("Sensitive cached agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => transport.releaseRevalidation());
    expect(await screen.findByRole("heading", { name: "Permissions" })).toBeInTheDocument();
  });

  it("clears saved queries and cached inventory when the same home account revalidates in another tenant", async () => {
    const client = savedQueries.createSavedQueryClient();
    vi.spyOn(savedQueries, "createSavedQueryClient").mockReturnValue(client);
    const reads = vi.spyOn(AgentInventoryQueries.prototype, "read");
    const clearing = vi.spyOn(AgentInventoryQueries.prototype, "clear");
    const nextUser = { ...viewer, tenantId: "tenant-2", displayName: "Revalidated tenant user" };
    const transport = appTransport({
      revalidatedRoles: viewer.roles,
      revalidatedUser: nextUser,
      deferRevalidation: true,
    });
    const base = transport.fetchMock.getMockImplementation()!;
    let nextTenant = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (nextTenant && new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        const page = structuredClone(unifiedPage);
        page.value[0].displayName = "Current tenant agent";
        page.value[0].packages[0].displayName = "Current tenant agent";
        return Response.json(page);
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const privateQuery = ["saved", "private-tenant-report", viewer.tenantId, viewer.homeAccountId];
    client.setQueryData(privateQuery, { value: ["Previous tenant report"] });
    expect(reads.mock.calls.at(-1)?.[0]).toContain(`${viewer.tenantId}:${viewer.homeAccountId}:`);
    const previousClears = clearing.mock.calls.length;
    transport.failProtectedReadsWith = 401;
    await act(async () => { await expect(getAgents()).rejects.toMatchObject({ status: 401 }); });
    await waitFor(() => expect(transport.meCalls()).toBe(2));
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(client.getQueryData(privateQuery)).toBeUndefined();
    nextTenant = true;
    transport.failProtectedReadsWith = undefined;
    await act(async () => transport.releaseRevalidation());
    expect(await screen.findByText("Current tenant agent")).toBeVisible();
    expect(screen.getByText(nextUser.displayName)).toBeVisible();
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(reads.mock.calls.at(-1)?.[0]).toContain(`${nextUser.tenantId}:${viewer.homeAccountId}:`);
    expect(clearing.mock.calls.length).toBeGreaterThan(previousClears);
    expect(client.getQueryData(privateQuery)).toBeUndefined();
  });

  it("clears only the signing-out tenant's stored selections and jobs along with its query cache", async () => {
    const otherTenant = { ...viewer, tenantId: "tenant-2" };
    const client = savedQueries.createSavedQueryClient();
    vi.spyOn(savedQueries, "createSavedQueryClient").mockReturnValue(client);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) =>
      input === "/api/auth/logout" ? new Response(null, { status: 204 }) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    window.localStorage.setItem(activeBulkJobStorageKey(viewer), "current-tenant-job");
    window.localStorage.setItem(activeBulkJobStorageKey(otherTenant), "other-tenant-job");
    storePackageSelection(viewer, ["current-tenant-package"]);
    storePackageSelection(otherTenant, ["other-tenant-package"]);
    render(<App />);
    await screen.findByText(agent.displayName);
    const privateQuery = ["saved", "private-tenant-report", viewer.tenantId, viewer.homeAccountId];
    client.setQueryData(privateQuery, { value: ["Private report"] });
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("textbox", { name: "Work or school username" })).toBeVisible();
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(client.getQueryData(privateQuery)).toBeUndefined();
    expect(window.localStorage.getItem(activeBulkJobStorageKey(viewer))).toBeNull();
    expect(window.localStorage.getItem(activeBulkJobStorageKey(otherTenant))).toBe("other-tenant-job");
    expect(restorePackageSelection(viewer, 1)).toEqual({ status: "unavailable" });
    expect(restorePackageSelection(otherTenant, 1)).toEqual({ status: "restored", ids: ["other-tenant-package"] });
  });

  it.each([false, true])("keeps a restored unified agent detail open after the saved inventory resolves (Strict Mode: %s)", async reactStrictMode => {
    const detailId = unifiedPage.value[0].id;
    window.history.replaceState({}, "", `/agents?detail=${encodeURIComponent(detailId)}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />, { reactStrictMode });
    const dialog = await screen.findByRole("dialog", { name: agent.displayName });
    expect(within(dialog).getByText("Agent management")).toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
    expect(dialog).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("detail")).toBe(detailId);
  });

  it.each(["navigation", "role revocation"] as const)(
    "does not open a delayed package detail after %s leaves the owning session route",
    async scenario => {
      const transport = initialCatalogTransport({
        revalidatedRoles: scenario === "role revocation" ? [] : viewer.roles,
        deferRevalidation: scenario === "role revocation",
      });
      transport.page = packagePage;
      const base = transport.fetchMock.getMockImplementation()!;
      let releaseDetail!: (response: Response) => void;
      const delayedDetail = new Promise<Response>(resolve => { releaseDetail = resolve; });
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (isPackageDetailRequest(input, agent.id)) return delayedDetail;
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);

      await userEvent.click(await screen.findByRole("button", { name: "View details for Sensitive cached agent" }));
      const dialog = await screen.findByRole("dialog", { name: agent.displayName });
      expect(within(dialog).getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
      await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => isPackageDetailRequest(path, agent.id))).toBe(true));
      if (scenario === "navigation") {
        await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
      } else {
        transport.session.failProtectedReadsWith = 401;
        await act(async () => { await expect(getAgents()).rejects.toMatchObject({ status: 401 }); });
        await waitFor(() => expect(transport.session.meCalls()).toBe(2));
        await act(async () => transport.session.releaseRevalidation());
      }
      await act(async () => releaseDetail(Response.json(agent)));

      expect(await screen.findByRole("heading", { name: "Permissions" })).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: agent.displayName })).not.toBeInTheDocument();
      expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument();
    },
  );

  it("uses the unified count to keep Power Platform-only pages reachable", async () => {
    window.history.replaceState({}, "", "/agents?inventory=power_platform_only");
    const records = Array.from({ length: 60 }, (_, index) =>
      powerPlatformRecord(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, `Unified agent ${index}`));
    const transport = appTransport({
      revalidatedRoles: viewer.roles,
      unifiedResponse: unifiedRecordsPage(records, 60),
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("50 shown · 60 matching agents")).toBeInTheDocument();
    const next = screen.getByRole("button", { name: "Next" });
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.click(next);
    expect(await screen.findByText("Unified agent 50")).toBeInTheDocument();
    expect(screen.getByText("10 shown · 60 matching agents")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("page")).toBe("2");
    expect(transport.fetchMock.mock.calls.some(([path]) => {
      const url = new URL(String(path), "http://localhost");
      return url.pathname === "/api/agent-inventory" && url.searchParams.get("cursor") === "fixture-page:50";
    })).toBe(true);
  });

  it("restores an off-page unified detail through an exact source-qualified lookup", async () => {
    const detailId = unifiedPage.value[0].id;
    window.history.replaceState({}, "", `/agents?detail=${encodeURIComponent(detailId)}`);
    const transport = appTransport({
      revalidatedRoles: viewer.roles,
      unifiedResponse: {
        ...unifiedPage,
        value: Array.from({ length: 50 }, (_, index) => ({
          ...unifiedPage.value[0], id: `graph_packages:other-${index}`, displayName: `Other ${index}`,
          packages: [{ ...agent, id: `other-${index}`, displayName: `Other ${index}` }],
        })),
        counts: { total: 80, scoped: 80, filtered: 80, packageTargets: 80 },
      },
    });
    const original = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (unifiedDetailId(input) === detailId) {
        return Response.json(unifiedPage.value[0]);
      }
      return original(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("dialog", { name: agent.displayName })).toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([path]) => unifiedDetailId(path) === detailId)).toBe(true);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/graph_packages"))).toBe(false);
  });

  it.each([false, true])("validates exact source-qualified package identity (matching: %s)", async matching => {
    window.history.replaceState({}, "", `/agents?detail=${agent.id}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([]) });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (unifiedDetailId(input) === unifiedPage.value[0].id) return Response.json(unifiedPage.value[0]);
      return isPackageDetailRequest(input, agent.id)
        ? Response.json({ ...agent, id: matching ? agent.id : "unrelated-package" })
        : base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    if (matching) {
      expect(await screen.findByRole("dialog", { name: agent.displayName })).toBeInTheDocument();
      expect(new URLSearchParams(window.location.search).get("detail")).toBe(unifiedPage.value[0].id);
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent("Saved agent details did not match the requested published version.");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await waitFor(() => expect(new URLSearchParams(window.location.search).has("detail")).toBe(false));
    }
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it.each(["detail", "access", "block"] as const)("preserves an in-flight %s request when sign-out fails", async flow => {
    const consoleError = vi.spyOn(console, "error");
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const endpoint = flow === "detail" ? `/api/agents/${agent.id}/detail`
      : flow === "access" ? `/api/agents/${agent.id}/refresh-jobs` : "/api/agents/mutation-preview";
    let response: Response | undefined;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/auth/logout") return Response.json({ code: "invalid_origin", detail: "Sign-out was rejected." }, { status: 403 });
      if (new URL(input, "http://localhost").pathname === endpoint) {
        response = await base(input, init);
        return pending.promise;
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const action = flow === "detail" ? `View details for ${agent.displayName}`
      : flow === "access" ? `Manage access for ${agent.displayName}` : `Block ${agent.displayName}`;
    await userEvent.click(await screen.findByRole("button", { name: action }));
    await waitFor(() => expect(response).toBeDefined());
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByText("Sign-out was rejected.");
    await act(async () => pending.resolve(response!));

    expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument();
    if (flow === "detail") {
      expect(screen.getByRole("dialog", { name: agent.displayName })).toBeInTheDocument();
    } else {
      expect(await screen.findByRole("dialog", { name: flow === "access" ? "Manage agent access" : /block package/i })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(consoleError.mock.calls.some(([message]) => String(message).includes("same key"))).toBe(false);
  });

  it("does not clear the current session for a provider permission 403", async () => {
    const transport = appTransport({ revalidatedRoles: [] });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();

    transport.failProtectedReadsWith = 403;
    await expect(getAgents()).rejects.toMatchObject({ status: 403 });

    expect(screen.getByText("Sensitive cached agent")).toBeInTheDocument();
    expect(transport.meCalls()).toBe(1);
  });

  it("does not revalidate the current session for a provider authorization 401", async () => {
    const transport = appTransport({ revalidatedRoles: [] });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();

    transport.failProtectedReadsWith = 401;
    transport.protectedFailureCode = "interaction_required";
    await expect(getAgents()).rejects.toMatchObject({ status: 401, code: "interaction_required" });

    expect(screen.getByText("Sensitive cached agent")).toBeInTheDocument();
    expect(screen.queryByText("Checking sign-in...")).not.toBeInTheDocument();
    expect(transport.meCalls()).toBe(1);
  });

  it("does not describe a sign-out origin rejection as missing permissions", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => input === "/api/auth/logout"
      ? Response.json({ code: "invalid_origin", detail: "A same-origin request is required. Use --origin-header unchanged." }, { status: 403 })
      : transport.fetchMock(input, init));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("A same-origin request is required. Use --origin-header unchanged.")).toBeInTheDocument();
    expect(screen.queryByText(/Open Permissions for the current account/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(transport.meCalls()).toBe(1);
  });

  it("does not issue protected deep-link reads for an unassigned session", async () => {
    window.history.replaceState({}, "", "/agents?detail=package-private&refreshJob=private-job&selected=package-private");
    const transport = appTransport({ initialRoles: [], revalidatedRoles: [] });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Permissions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jobs" })).not.toBeInTheDocument();
    expect(agentListRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).includes("/api/agents/package-private"))).toBe(false);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).includes("/api/agents/refresh-jobs/private-job"))).toBe(false);
  });

  it("allows Viewer to use read-only bulk-reference filters", async () => {
    window.history.replaceState({}, "", "/agents?q=ref+a5331a93");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    expect(agentListRequests(transport.fetchMock).some(([path]) =>
      selectedInventoryUrl(String(path)).searchParams.get("operationIdPrefix") === "a5331a93",
    )).toBe(true);
    expect(transport.fetchMock.mock.calls.some(([path, init]) =>
      path === "/api/agent-inventory/selections" && JSON.parse(String(init?.body)).query.operationIdPrefix === "a5331a93",
    )).toBe(true);
    expect(transport.fetchMock.mock.calls.some(([path]) => {
      const url = selectedInventoryUrl(String(path));
      return url.pathname === "/api/agent-inventory"
        && url.searchParams.get("operationIdPrefix") === "a5331a93"
        && !url.searchParams.has("search");
    })).toBe(true);
    expect(screen.queryByText(/Bulk-reference filters require/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Audit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Security" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Manage access for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Block Sensitive/ })).not.toBeInTheDocument();
  });

  it("retires Security bookmarks to Agents without restoring tenant hunt filters or running a hunt", async () => {
    window.history.replaceState({}, "", "/security?job=legacy-job&mode=application&agentIds=not-an-inventory-identity");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/agents");
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("button", { name: "Security" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/hunting/"))).toBe(false);
  });

  it("lets Admin inherit every view while exposing supported mutation controls", async () => {
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"],
      revalidatedRoles: ["AgentControl.Admin"],
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    for (const name of ["Agents", "Users", "Audit", "Permissions"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Official usage" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage access for Sensitive cached agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Block Sensitive cached agent" })).toBeInTheDocument();
  });

  it("inspects an off-preview published member on its selected pin without inventory page walks", async () => {
    const group = { ...unifiedPage.value[0], id: "agent:33333333-3333-4333-8333-333333333333",
      displayName: "Large saved group", packageCount: 6000, memberCount: 6000, packagesComplete: false };
    const page = { ...unifiedRecordsPage([group]), counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 6000 },
      verification: createUnifiedVerification({ graphPackageCount: 6000, powerPlatformAgentCount: 0, logicalAgentCount: 1 }) };
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page });
    const base = transport.fetchMock.getMockImplementation()!;
    const nativeId = "opaque/SECOND-AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    transport.fetchMock.mockImplementation((input, init) => {
      if (new URL(input, "http://localhost").pathname.endsWith("/members")) return Promise.resolve(Response.json({
        value: [{ source_scope_id: "package-scope", source_identity: nativeId, source_generation_id: "source-generation",
          domain: "packages", native_id: nativeId, display_name: "Off-preview version", environment_id: null }],
        total: 6000, nextCursor: "next-members",
      }));
      if (isPackageDetailRequest(input, nativeId)) return Promise.resolve(Response.json({
        ...agent, id: nativeId, displayName: "Off-preview version", longDescription: "Exact saved off-preview description",
        observation: { observedAt: packagePage.selection.evaluatedAt, expiresAt: packagePage.selection.expiresAt,
          scopeKind: "exact", current: true },
        selectedSource: { selectionId: new URL(input, "http://localhost").searchParams.get("selectionId"), recordId: group.id.slice(6), sourceScopeId: "package-scope",
          sourceIdentity: nativeId, generationId: "source-generation" }, matchingEvidence: [],
      }));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(group.displayName);
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: `View details for ${group.displayName}` }));
    const dialog = await screen.findByRole("dialog", { name: group.displayName });
    await userEvent.click(await within(dialog).findByRole("button", { name: `Inspect published version (${nativeId})` }));
    expect(await within(dialog).findByText("Exact saved off-preview description")).toBeVisible();
    expect(within(dialog).getByRole("combobox", { name: "Published version details" })).toHaveValue(nativeId);
    const details = transport.fetchMock.mock.calls.filter(([path]) => isPackageDetailRequest(path, nativeId));
    expect(details).toHaveLength(1);
    expect(new URL(details[0][0], "http://localhost").searchParams.get("selectionId")).toBe(currentInventorySelection(transport.fetchMock));
    expect(agentListRequests(transport.fetchMock)).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([path]) => new URL(path, "http://localhost").pathname.endsWith("/members"))).toHaveLength(1);
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("keeps a durable inventory export across views without readmission or browser artifact materialization", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const admission = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) => input === "/api/data-exports" ? admission.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<App />);
    await screen.findByText(agent.displayName);
    const exportInventory = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(exportInventory).toBeEnabled());
    await userEvent.click(exportInventory);
    await userEvent.click(await screen.findByRole("button", { name: /Download matching agents/ }));
    await waitFor(() => expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/data-exports")).toHaveLength(1));
    expect(JSON.parse(String(transport.fetchMock.mock.calls.find(([path]) => path === "/api/data-exports")![1]?.body)))
      .toEqual({ selectionId: currentInventorySelection(transport.fetchMock), kind: "unified_agents", idempotencyKey: expect.any(String) });
    await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
    await act(async () => admission.resolve(Response.json({ id: "inventory-export" })));
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/data-exports/inventory-export")).toBe(true), { timeout: 4000 });
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    const link = await screen.findByRole("link", { name: "Download CSV" });
    expect(link).toHaveAttribute("href", "/api/data-exports/inventory-export/download");
    await userEvent.click(link);
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/data-exports")).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/data-exports/inventory-export")).toHaveLength(2);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).endsWith("/download") || String(path).includes("export.csv"))).toBe(false);
  });

  it("invalidates an export selection without automatic readmission and requires an explicit saved-data reload", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => input === "/api/data-exports"
      ? Promise.resolve(Response.json({ code: "selection_invalidated", detail: "Selection expired." }, { status: 409 })) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
    await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    const reload = await screen.findByRole("button", { name: "Reload saved agent inventory" });
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(agentListRequests(transport.fetchMock)).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/data-exports")).toHaveLength(1);
    await userEvent.click(reload);
    await screen.findByText(agent.displayName);
    expect(agentListRequests(transport.fetchMock)).toHaveLength(2);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/data-exports")).toHaveLength(1);
  });

  it("uses authorized bulk references for package lists and unified agent exports", async () => {
    window.history.replaceState({}, "", "/agents?q=ref+a5331a93");
    const transport = appTransport({
      initialRoles: ["AgentControl.Viewer"],
      revalidatedRoles: ["AgentControl.Viewer"],
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:package-export") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<App />);

    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    expect(agentListRequests(transport.fetchMock).some(([path]) =>
      selectedInventoryUrl(String(path)).searchParams.get("operationIdPrefix") === "a5331a93",
    )).toBe(true);

    const exportButton = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await userEvent.click(exportButton);
    await userEvent.click(await screen.findByRole("button", { name: /Download matching agents/ }));
    await waitFor(() => expect(transport.fetchMock).toHaveBeenCalledWith(
      "/api/data-exports", expect.objectContaining({ method: "POST" }),
    ));
    const exported = inventoryExportRequest(transport.fetchMock);
    expect(exported).toEqual({ kind: "unified_agents", selectionId: currentInventorySelection(transport.fetchMock), idempotencyKey: expect.any(String) });
    expect(inventorySelections.get(exported.selectionId)?.query.operationIdPrefix).toBe("a5331a93");
  });

  it("exports all matching logical rows with the exact unified filters and sorting, not the visible page", async () => {
    const params = new URLSearchParams({
      q: "Matched & saved", status: "blocked", publisher: encodeInventoryFacet("Publisher & Co"), availability: encodeInventoryFacet("available:some"),
      host: encodeInventoryFacet("Teams"), platform: encodeInventoryFacet("Copilot Studio"), environment: encodeInventoryFacet("env-a"), createdWithinDays: "30",
      sort: "lastModifiedAt", direction: "desc", page: "3",
    });
    window.history.replaceState({}, "", `/agents?${params}`);
    const records = Array.from({ length: 25 }, (_, index): UnifiedAgentRecord => ({
      ...unifiedPage.value[0],
      id: `agent:00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      displayName: `Matched & saved ${index}`,
      environmentId: "env-a",
      packages: [{ ...agent, id: `package-${index}`, isBlocked: true, publisher: "Publisher & Co", authoringTool: "Copilot Studio" }],
    }));
    const page = unifiedRecordsPage(records, 125);
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(input, "http://localhost").pathname;
      if (path === "/api/agent-inventory") return Response.json(selectedInventoryPage(input, page));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await screen.findByText("Matched & saved 0");
    const button = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(agentListRequests(transport.fetchMock).every(([input]) =>
      !new URL(input, "http://localhost").searchParams.has("offset"))).toBe(true);
    await userEvent.click(button);
    const matching = screen.getByRole("button", { name: /Download matching agents/ });
    expect(matching).toHaveTextContent("125 filtered agents across all pages");
    expect(matching).toHaveTextContent("Not limited to the displayed page or the 5,000-target mutation limit");
    await userEvent.click(matching);
    await completeNativeInventoryDownload(download);
    const body = inventoryExportRequest(transport.fetchMock);
    expect(body).toEqual({ kind: "unified_agents", selectionId: currentInventorySelection(transport.fetchMock), idempotencyKey: expect.any(String) });
    expect(inventorySelections.get(body.selectionId)?.query).toEqual({
        search: "Matched & saved", blocked: "true", publisher: encodeInventoryFacet("Publisher & Co"),
        availableTo: encodeInventoryFacet("available:some"), host: encodeInventoryFacet("Teams"),
        platform: encodeInventoryFacet("Copilot Studio"), environmentId: encodeInventoryFacet("env-a"), createdWithinDays: "30",
        inventoryScope: "catalog",
        sortBy: "lastModifiedAt", sortDirection: "desc",
    });
    const listUrl = new URL(transport.fetchMock.mock.calls.filter(([input]) => input.startsWith("/api/agent-inventory?")).at(-1)![0], "http://localhost");
    expect(Object.fromEntries(listUrl.searchParams)).toEqual({ selectionId: body.selectionId, limit: "50" });
    expect(transport.fetchMock.mock.calls.some(([input]) => input === "/api/agents/export.csv" || input.startsWith("/api/inventory/export.csv"))).toBe(false);
  });

  it("exports a merged selection once using observed canonical membership and exact off-page source references", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Grouped export agent");
    const canonicalId = "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const row: UnifiedAgentRecord = {
      ...native,
      id: canonicalId,
      presence: "both",
      packages: [{ ...agent, id: "opaque/package%one" }, { ...agent, id: "opaque:package-two", isBlocked: true }],
      identity: { state: "matched", evidence: [], packageEvidence: [], reason: "Exact saved native source association." },
    };
    const offPageId = "offpage/opaque%ref";
    window.history.replaceState({}, "", `/agents?${new URLSearchParams({
      q: "Grouped", environment: row.environmentId!, status: "blocked", sort: "lastModifiedAt", direction: "desc", selected: offPageId,
    })}`);
    const transport = appTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"], unifiedResponse: unifiedRecordsPage([row]) });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    const checkbox = await screen.findByRole("checkbox", { name: "Select Grouped export agent" });
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    const button = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(button).toBeEnabled());
    const initialPosts = transport.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([input]) => input);
    await userEvent.click(button);
    const selected = screen.getByRole("button", { name: /Download selected agents/ });
    expect(selected).toHaveTextContent("4 selected package/native references");
    expect(selected).toHaveTextContent("Current filters do not narrow this selection");
    await userEvent.click(selected);
    await completeNativeInventoryDownload(download);
    const body = inventoryExportRequest(transport.fetchMock);
    expect(body).toEqual({
      kind: "unified_agents", selectionId: currentInventorySelection(transport.fetchMock), idempotencyKey: expect.any(String),
      ids: ["graph_packages:offpage%2Fopaque%25ref", canonicalId],
    });
    expect(checkbox).toBeChecked();
    expect(transport.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([input]) => input)).toEqual([...initialPosts, "/api/data-exports"]);
  });

  it("acceptance: Viewer selects and deselects multi-version groups and exports mixed bounded references", async () => {
    const group = { ...unifiedPage.value[0], id: "agent:11111111-1111-4111-8111-111111111111",
      displayName: "Grouped viewer export", packagesComplete: false, packageCount: 40, memberCount: 40 };
    const single = { ...unifiedPage.value[0], id: "agent:22222222-2222-4222-8222-222222222222",
      displayName: "Single viewer export", packages: [{ ...agent, id: "single-opaque" }], packagesComplete: true };
    const transport = appTransport({ initialRoles: viewer.roles, revalidatedRoles: viewer.roles,
      unifiedResponse: unifiedRecordsPage([group, single]) });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    const checkbox = await screen.findByRole("checkbox", { name: "Select Grouped viewer export" });
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    await userEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Single viewer export" }));
    await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
    await userEvent.click(screen.getByRole("button", { name: /Download selected agents/ }));
    await completeNativeInventoryDownload(download);
    expect(inventoryExportRequest(transport.fetchMock)).toEqual({
      kind: "unified_agents", selectionId: currentInventorySelection(transport.fetchMock), idempotencyKey: expect.any(String),
      ids: [single.id, group.id],
    });
    expect(screen.queryByRole("button", { name: "Block selected packages" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([input]) => /\/members|\/children|\/mutation-selection|\/mutation-preview/.test(input))).toBe(false);
  });

  it("acceptance: App reads a presenter-shaped catalog with already-stale optional details", async () => {
    const row = structuredClone(unifiedPage.value[0]), expiresAt = new Date(Date.now() - 1_000).toISOString();
    row.packages = row.packages.map(value => ({ ...value, identityDetailsCollected: true,
      detailFreshness: { state: "stale", observedAt: new Date(Date.now() - 3_601_000).toISOString(), expiresAt } }));
    row.observations.packageSnapshots = Object.fromEntries(row.packages.map(value => [value.id, {
      id: "catalog", snapshotId: "catalog", current: true, scopeKind: "broad" as const,
      observedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
      identityDetails: { id: "stale-detail", snapshotId: "stale-detail", current: false,
        observedAt: new Date(Date.now() - 3_601_000).toISOString(), expiresAt },
    }]));
    const page = { ...unifiedRecordsPage([row]), identityCollection: {
      checkedPackages: 0, pendingPackages: 1, pendingDetails: { missing: 0, stale: 1, invalidated: 0 } },
      verification: { ...createUnifiedVerification({ graphPackageCount: 1, powerPlatformAgentCount: 0,
        logicalAgentCount: 1 }, { packageMetadata: false }), status: "details_pending" as const } };
    const transport = appTransport({ initialRoles: viewer.roles, revalidatedRoles: viewer.roles, unifiedResponse: page });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("checkbox", { name: `Select ${row.displayName}` })).toBeEnabled();
    expect(screen.queryByText(/current saved agent inventory could not be loaded/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Block selected packages" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sync" }));
    await userEvent.click(await screen.findByRole("button", { name: "View diagnostics" }));
    expect(await screen.findByText("0 package detail checks current; 1 not current.")).toBeVisible();
  });

  it("allows a Viewer to export Power Platform-only logical rows without Graph permissions or package summaries", async () => {
    window.history.replaceState({}, "", "/agents?inventory=power_platform_only");
    const row = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Native export agent");
    const page = unifiedRecordsPage([row]);
    const transport = appTransport({ initialRoles: viewer.roles, revalidatedRoles: viewer.roles, unifiedResponse: page });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) =>
      new URL(input, "http://localhost").pathname === "/api/agents"
        ? Response.json({ detail: "Package summaries unavailable." }, { status: 503 }) : base(input, init),
    );
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await screen.findByText("Native export agent");
    expect(transport.fetchMock.mock.calls.some(([input]) => new URL(input, "http://localhost").pathname === "/api/agents")).toBe(false);
    const button = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    await completeNativeInventoryDownload(download);
    expect(transport.fetchMock).toHaveBeenCalledWith("/api/data-exports", expect.objectContaining({
      headers: expect.objectContaining({ "X-CSRF-Token": "csrf-1" }),
    }));
    expect(inventoryExportRequest(transport.fetchMock)).toEqual({
      selectionId: currentInventorySelection(transport.fetchMock), kind: "unified_agents", idempotencyKey: expect.any(String),
    });
    expect(inventorySelections.get(currentInventorySelection(transport.fetchMock))?.query).toEqual({
      inventoryScope: "power_platform_only", sortBy: "displayName", sortDirection: "asc",
    });
    expect(transport.fetchMock.mock.calls.some(([input]) => input === "/api/agents/export.csv" || input.startsWith("/api/inventory/export.csv"))).toBe(false);
  });

  it.each(["", "expired"] as const)("does not export an unavailable selected inventory (%s)", async state => {
    const invalid = { ...unifiedPage,
      selection: { ...unifiedPage.selection, id: state === "" ? "" : unifiedPage.selection.id,
        expiresAt: state === "expired" ? "2000-01-01T00:00:00.000Z" : unifiedPage.selection.expiresAt } };
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => new URL(input, "http://localhost").pathname === "/api/agent-inventory"
      ? Promise.resolve(Response.json(invalid)) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Reload saved agent inventory" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    expect(screen.getByText(state === "expired" ? /current saved agent inventory could not be loaded/ : /saved agent inventory revision is unavailable/)).toBeVisible();
    expect(transport.fetchMock.mock.calls.some(([input]) => input === "/api/data-exports")).toBe(false);
  });

  it.each([5_000, 5_001])("exports %i matching rows without applying the mutation cap or losing a smaller explicit selection", async count => {
    window.history.replaceState({}, "", "/agents?selected=package-private");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) =>
      new URL(input, "http://localhost").pathname === "/api/agent-inventory"
        ? Response.json(selectedInventoryPage(input, unifiedRecordsPage(unifiedPage.value, count))) : base(input, init),
    );
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await screen.findByText(agent.displayName);
    const button = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const matching = screen.getByRole("button", { name: /Download matching agents/ });
    const selected = screen.getByRole("button", { name: /Download selected agents/ });
    expect(selected).toBeEnabled();
    expect(matching).toBeEnabled();
    expect(matching).toHaveTextContent("Not limited to the displayed page or the 5,000-target mutation limit");
    await userEvent.click(matching);
    await completeNativeInventoryDownload(download);
    expect(inventoryExportRequest(transport.fetchMock)).toEqual({
      selectionId: currentInventorySelection(transport.fetchMock), kind: "unified_agents", idempotencyKey: expect.any(String),
    });
    await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
    await userEvent.click(screen.getByRole("button", { name: /Download selected agents/ }));
    await completeNativeInventoryDownload(download);
    expect(inventoryExportRequest(transport.fetchMock)).toEqual({
      selectionId: currentInventorySelection(transport.fetchMock), kind: "unified_agents", ids: ["graph_packages:package-private"], idempotencyKey: expect.any(String),
    });
  });

  it.each(["revision", "missing-reference"] as const)("requires explicit saved-data reload after %s invalidation and never silently retries a source export", async invalidation => {
    if (invalidation === "missing-reference") window.history.replaceState({}, "", "/agents?selected=removed-package");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    let exports = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(input, "http://localhost").pathname;
      if (path === "/api/data-exports") {
        exports += 1;
        if (exports === 1) {
          unifiedPage.selection.revision = "b".repeat(64);
          return Response.json({ code: "selection_invalidated", detail: `${invalidation} invalidated the export.` }, { status: 409 });
        }
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await screen.findByText(agent.displayName);
    const button = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(button).toBeEnabled());
    const initialPosts = transport.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([input]) => input);
    await userEvent.click(button);
    await userEvent.click(screen.getByRole("button", { name: invalidation === "revision" ? /Download matching agents/ : /Download selected agents/ }));
    const reload = await screen.findByRole("button", { name: "Reload saved agent inventory" });
    expect(reload.closest("[role=alert]")).toHaveTextContent(/selection changed or expired.*reload/i);
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    expect(exports).toBe(1);
    expect(download.filenames).toEqual([]);
    const savedReadCount = agentListRequests(transport.fetchMock).length;
    await userEvent.click(reload);
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled());
    expect(agentListRequests(transport.fetchMock).length).toBeGreaterThan(savedReadCount);
    expect(exports).toBe(1);
    expect(screen.queryByRole("button", { name: "Reload saved agent inventory" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
    if (invalidation === "missing-reference") {
      expect(screen.getByRole("button", { name: /Download selected agents/ })).toBeDisabled();
      expect(new URLSearchParams(window.location.search).has("selected")).toBe(false);
    }
    await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    await completeNativeInventoryDownload(download);
    const requests = transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-exports");
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[1][1]?.body))).toEqual({
      selectionId: currentInventorySelection(transport.fetchMock), kind: "unified_agents", idempotencyKey: expect.any(String),
    });
    expect(inventorySelections.get(currentInventorySelection(transport.fetchMock))?.selection.revision).toBe("b".repeat(64));
    expect(transport.fetchMock.mock.calls.filter(([path, init]) => init?.method === "POST" && path !== "/api/agent-inventory/selections").map(([input]) => input)).toEqual([
      ...initialPosts.filter(path => path !== "/api/agent-inventory/selections"), "/api/data-exports", "/api/data-exports",
    ]);
  });

  it("waits for current filters and exports their newly loaded saved revision", async () => {
    const row = { ...unifiedPage.value[0], displayName: "X agent" };
    const page = unifiedRecordsPage([row]);
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation(async (input, init) => {
      const url = selectedInventoryUrl(input);
      if (url.pathname === "/api/agent-inventory" && url.searchParams.get("search") === "X") return pending.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await screen.findByText("X agent");
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled());
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "X");
    await waitFor(() => expect(agentListRequests(transport.fetchMock).some(([input]) => selectedInventoryUrl(input).searchParams.get("search") === "X")).toBe(true));
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    await act(async () => pending.resolve(Response.json(selectedInventoryPage(agentListRequests(transport.fetchMock).at(-1)![0], page))));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
    await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    await completeNativeInventoryDownload(download);
    expect(inventoryExportRequest(transport.fetchMock)).toEqual({ kind: "unified_agents", selectionId: currentInventorySelection(transport.fetchMock), idempotencyKey: expect.any(String) });
    expect(inventorySelections.get(currentInventorySelection(transport.fetchMock))?.query).toEqual({
      search: "X", inventoryScope: "catalog", sortBy: "displayName", sortDirection: "asc",
    });
  });

  it.each([false, true])("does not export retained rows after the current unified filters fail to load (late CSV failure: %s)", async lateCsvFailure => {
    const original = { ...unifiedPage.value[0], displayName: "Original agent" };
    const filtered = { ...original, displayName: "X agent" };
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([original]) });
    const base = transport.fetchMock.getMockImplementation()!;
    const pendingCsv = deferredResponse();
    let exports = 0;
    let failFilteredRead = true;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const url = selectedInventoryUrl(input);
      if (url.pathname === "/api/data-exports" && lateCsvFailure && ++exports === 1) return pendingCsv.promise;
      if (url.pathname === "/api/agent-inventory" && url.searchParams.get("search") === "X") {
        return failFilteredRead
          ? Response.json({ detail: "Filtered saved inventory unavailable." }, { status: 503 })
          : Response.json(selectedInventoryPage(input, unifiedRecordsPage([filtered])));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await screen.findByText("Original agent");
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled());
    if (lateCsvFailure) {
      await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
      await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    }
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "X");
    await screen.findByText(/^Filtered saved inventory unavailable\./);
    if (lateCsvFailure) {
      await act(async () => pendingCsv.resolve(Response.json({ detail: "Deferred CSV failed." }, { status: 500 })));
      await screen.findByText("Deferred CSV failed.");
    }
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-exports")).toHaveLength(lateCsvFailure ? 1 : 0);
    failFilteredRead = false;
    await userEvent.click(screen.getByRole("button", { name: "Reload saved agent inventory" }));
    await screen.findByText("X agent");
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
    await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    await completeNativeInventoryDownload(download);
    expect(inventoryExportRequest(transport.fetchMock)).toEqual({ kind: "unified_agents", selectionId: currentInventorySelection(transport.fetchMock), idempotencyKey: expect.any(String) });
    expect(inventorySelections.get(currentInventorySelection(transport.fetchMock))?.query).toEqual({
      search: "X", inventoryScope: "catalog", sortBy: "displayName", sortDirection: "asc",
    });
  });

  it("keeps matching export available during native selection restoration and can cancel that restoration from export", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Off-page native selection");
    const alias = "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    window.history.replaceState({}, "", `/agents?${new URLSearchParams({ selectedResource: alias, inventorySnapshot: "pp-snapshot" })}`);
    const transport = appTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"], unifiedResponse: unifiedRecordsPage(unifiedPage.value) });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (unifiedDetailId(input) === alias) return pending.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await screen.findByText(agent.displayName);
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) => unifiedDetailId(input) === alias)).toBe(true));
    const button = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(screen.getByRole("button", { name: /Download selected agents/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Download matching agents/ })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    await completeNativeInventoryDownload(download);
    await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Export agent inventory" })).getByRole("button", { name: "Clear selection" }));
    await act(async () => pending.resolve(Response.json({ ...native, id: alias })));
    expect(screen.getByRole("button", { name: /Download selected agents/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Download selected agents/ })).toHaveTextContent("0 selected package/native references");
    expect(new URLSearchParams(window.location.search).has("selectedResource")).toBe(false);
  });

  it("exports Power Platform agents from the exact selected source roots with native download in Sync", async () => {
    window.history.replaceState({}, "", `/agents?${new URLSearchParams({ q: "linked", environment: encodeInventoryFacet("env-a") })}`);
    const powerPlatformObservation = {
      ...powerPlatformSnapshot(),
      id: "pp-snapshot-exact",
      snapshotId: "pp-snapshot-exact",
      current: true as const,
      roleScope: "full" as const,
      environmentScope: null,
      coverage: "covered" as const,
      coveredCount: 1,
      observedCount: 1,
      totalRecords: 1,
      pageCount: 1,
      verification: createInventoryVerification(1),
    };
    const transport = appTransport({
      revalidatedRoles: viewer.roles,
      unifiedResponse: {
        ...unifiedPage,
        sources: {
          ...unifiedPage.sources,
          powerPlatform: { state: "available", observation: powerPlatformObservation, error: null },
        },
      },
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    await screen.findByRole("button", { name: "Export PP agent inventory CSV" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Export PP agent inventory CSV" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Export PP agent inventory CSV" }));

    await completeNativeInventoryDownload(download);
    expect(inventoryExportRequest(transport.fetchMock)).toEqual({
      selectionId: currentInventorySelection(transport.fetchMock), kind: "power_platform_agents", idempotencyKey: expect.any(String),
    });
    expect(inventorySelections.get(currentInventorySelection(transport.fetchMock))?.query).toMatchObject({
      environmentId: encodeInventoryFacet("env-a"), search: "linked",
    });
    expect(transport.fetchMock.mock.calls.some(([input]) => input.includes("export.csv"))).toBe(false);
  });

  it("refreshes only Power Platform agents and environments and exposes durable status", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const completedAt = new Date().toISOString();
    const completedJob = {
      id: "pp-agent-refresh",
      status: "succeeded",
      roleScope: "full",
      environmentScope: null,
      requestedTypes: ["microsoft.copilotstudio/agents"],
      pageCount: 1,
      observedCount: 1,
      totalRecords: 1,
      unknownFieldCount: 0,
      snapshotId: "pp-snapshot-refreshed",
      createdAt: completedAt,
      attemptedAt: completedAt,
      updatedAt: completedAt,
      finishedAt: completedAt,
    };
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/capabilities" || input.startsWith("/api/capabilities/check")) {
        const definition = capabilityDefinitions.find(item => item.id === "powerPlatform.inventory.read")!;
        return Response.json({ value: [{
          definition,
          decision: {
            capabilityId: definition.id,
            status: "available",
            authorized: true,
            fresh: true,
            verification: "provider",
            checkedAt: completedAt,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            previewQualification: "not_required",
            remediation: [],
          },
        }] });
      }
      if (input === "/api/inventory/refresh-jobs" && init?.method === "POST") {
        return Response.json(completedJob);
      }
      if (input === "/api/inventory/refresh-jobs") {
        return Response.json({ value: [], lastAttemptAt: null, lastSuccessAt: null });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    await screen.findByRole("button", { name: "Refresh PP agent inventory" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh PP agent inventory" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Refresh PP agent inventory" }));

    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path, init]) =>
      path === "/api/inventory/refresh-jobs"
      && init?.method === "POST"
      && JSON.stringify(JSON.parse(String(init.body))) === JSON.stringify({
        types: ["microsoft.copilotstudio/agents", "microsoft.powerplatform/environments"],
      }),
    )).toBe(true));
    expect(await screen.findByText(/Latest agent refresh: succeeded/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Sync history" })).toBeInTheDocument();
  });

  it.each([
    ["refresh", "tab"],
    ["resume", "tab"],
    ["refresh", "history"],
    ["resume", "history"],
  ] as const)(
    "retains a pending Power Platform %s across %s navigation and accepts completion away from Sync",
    async (action, navigation) => {
      const transport = appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      let currentJob = inventoryRefreshJob(action === "resume" ? "waiting_authorization" : "succeeded", "previous-job");
      const requestPath = action === "refresh"
        ? "/api/inventory/refresh-jobs"
        : `/api/inventory/refresh-jobs/${currentJob.id}/resume`;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (input === requestPath && init?.method === "POST") return pending.promise;
        if (input === "/api/inventory/refresh-jobs") {
          return Response.json({ value: [currentJob], lastAttemptAt: null, lastSuccessAt: null });
        }
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await screen.findByText(agent.displayName);

      async function navigate(view: "agents" | "sync") {
        if (navigation === "tab") {
          await userEvent.click(screen.getByRole("button", { name: view === "agents" ? "Agents" : /^Sync/ }));
        } else {
          act(() => {
            window.history.pushState({}, "", `/${view}`);
            window.dispatchEvent(new PopStateEvent("popstate"));
          });
        }
        if (view === "sync") await userEvent.click(await screen.findByText("View diagnostics"));
      }

      await navigate("sync");
      const start = screen.getByRole("button", { name: action === "resume" ? "Resume PP agent refresh" : "Refresh PP agent inventory" });
      await waitFor(() => expect(start).toBeEnabled());
      await userEvent.click(start);
      expect(transport.fetchMock).toHaveBeenCalledWith(requestPath, expect.objectContaining({ method: "POST" }));

      await navigate("agents");
      await navigate("sync");
      const refresh = screen.getByRole("button", { name: "Refreshing PP agents..." });
      expect(refresh).toBeDisabled();
      await userEvent.click(refresh);
      if (action === "resume") {
        const resume = screen.getByRole("button", { name: "Resume PP agent refresh" });
        expect(resume).toBeDisabled();
        await userEvent.click(resume);
      }
      expect(transport.fetchMock.mock.calls.filter(([path, init]) => path === requestPath && init?.method === "POST")).toHaveLength(1);

      await navigate("agents");
      const savedReads = () => transport.fetchMock.mock.calls.filter(([path]) => path.startsWith("/api/agent-inventory?")).length;
      const readsBeforeCompletion = savedReads();
      currentJob = {
        ...inventoryRefreshJob("succeeded", action === "refresh" ? "new-job" : currentJob.id),
        message: "Completed after navigation.",
      };
      await act(async () => pending.resolve(Response.json(currentJob)));
      await waitFor(() => expect(savedReads()).toBeGreaterThan(readsBeforeCompletion));

      await navigate("sync");
      expect(screen.getByText(/Latest agent refresh: succeeded - Completed after navigation/)).toBeVisible();
      expect(screen.getByRole("button", { name: "Refresh PP agent inventory" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Resume PP agent refresh" })).not.toBeInTheDocument();
      expect(transport.fetchMock.mock.calls.filter(([path, init]) => path === requestPath && init?.method === "POST")).toHaveLength(1);
    },
  );

  it.each(["refresh", "resume"] as const)(
    "reports a delayed Power Platform %s failure after leaving Sync and allows an explicit retry",
    async action => {
      const transport = appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const previousJob = inventoryRefreshJob(action === "resume" ? "waiting_authorization" : "succeeded", "previous-job");
      const requestPath = action === "refresh"
        ? "/api/inventory/refresh-jobs"
        : `/api/inventory/refresh-jobs/${previousJob.id}/resume`;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (input === requestPath && init?.method === "POST") return pending.promise;
        if (input === "/api/inventory/refresh-jobs") {
          return Response.json({ value: [previousJob], lastAttemptAt: null, lastSuccessAt: null });
        }
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await screen.findByText(agent.displayName);
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await userEvent.click(screen.getByText("View diagnostics"));
      const actionName = action === "resume" ? "Resume PP agent refresh" : "Refresh PP agent inventory";
      await waitFor(() => expect(screen.getByRole("button", { name: actionName })).toBeEnabled());
      await userEvent.click(screen.getByRole("button", { name: actionName }));
      await userEvent.click(screen.getByRole("button", { name: "Agents" }));

      await act(async () => pending.resolve(Response.json(
        { code: "inventory_refresh_failed", detail: "Delayed Power Platform refresh failed." },
        { status: 500 },
      )));
      expect(await screen.findByText("Delayed Power Platform refresh failed.")).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await userEvent.click(screen.getByText("View diagnostics"));
      expect(screen.getByRole("button", { name: actionName })).toBeEnabled();
      expect(transport.fetchMock.mock.calls.filter(([path, init]) => path === requestPath && init?.method === "POST")).toHaveLength(1);
    },
  );

  it.each([
    ["refresh", "session revalidation", "success"],
    ["refresh", "session revalidation", "failure"],
    ["resume", "session revalidation", "success"],
    ["resume", "session revalidation", "failure"],
    ["refresh", "unmount", "success"],
    ["refresh", "unmount", "failure"],
    ["resume", "unmount", "success"],
    ["resume", "unmount", "failure"],
  ] as const)(
    "discards a delayed Power Platform %s after %s (%s)",
    async (action, lifecycle, outcome) => {
      const transport = appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const previousJob = inventoryRefreshJob(action === "resume" ? "waiting_authorization" : "succeeded", "previous-job");
      const requestPath = action === "refresh"
        ? "/api/inventory/refresh-jobs"
        : `/api/inventory/refresh-jobs/${previousJob.id}/resume`;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (input === requestPath && init?.method === "POST") return pending.promise;
        if (input === "/api/inventory/refresh-jobs") {
          return Response.json({ value: [previousJob], lastAttemptAt: null, lastSuccessAt: null });
        }
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      const app = render(<App />);
      await screen.findByText(agent.displayName);
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await userEvent.click(screen.getByText("View diagnostics"));
      const actionName = action === "resume" ? "Resume PP agent refresh" : "Refresh PP agent inventory";
      await waitFor(() => expect(screen.getByRole("button", { name: actionName })).toBeEnabled());
      await userEvent.click(screen.getByRole("button", { name: actionName }));

      if (lifecycle === "session revalidation") {
        await revalidateTransportSession(transport);
        await userEvent.click(await screen.findByRole("button", { name: "View diagnostics" }));
        await screen.findByText(new RegExp(`Latest agent refresh: ${previousJob.status.replaceAll("_", " ")}`));
      } else {
        app.unmount();
      }
      const savedReads = () => transport.fetchMock.mock.calls.filter(([path]) => path.startsWith("/api/agent-inventory?")).length;
      const readsBeforeResult = savedReads();
      await act(async () => pending.resolve(outcome === "success"
        ? Response.json({ ...inventoryRefreshJob("succeeded", previousJob.id), message: "Late refresh result." })
        : Response.json({ code: "inventory_refresh_failed", detail: "Late refresh failure." }, { status: 500 })));
      expect(savedReads()).toBe(readsBeforeResult);
      expect(screen.queryByText(/Late refresh result|Late refresh failure/)).not.toBeInTheDocument();
      expect(transport.fetchMock.mock.calls.filter(([path, init]) => path === requestPath && init?.method === "POST")).toHaveLength(1);
    },
  );

  it("ignores an aborted Power Platform poll after returning to Sync and receiving newer status", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const currentJob = inventoryRefreshJob("waiting_authorization", "running-job");
    let polls = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === `/api/inventory/refresh-jobs/${currentJob.id}`) {
        polls += 1;
        return polls === 1 ? pending.promise : Response.json(currentJob);
      }
      if (input === "/api/inventory/refresh-jobs") {
        return Response.json({ value: [inventoryRefreshJob("running", currentJob.id)], lastAttemptAt: null, lastSuccessAt: null });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await waitFor(() => expect(polls).toBe(1), { timeout: 3_000 });
    const pollRequest = transport.fetchMock.mock.calls.find(([path]) => path === `/api/inventory/refresh-jobs/${currentJob.id}`);
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(pollRequest?.[1]?.signal?.aborted).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(await screen.findByText(/Latest agent refresh: waiting authorization/, {}, { timeout: 3_000 })).toBeVisible();
    expect(polls).toBe(2);

    const savedReads = () => transport.fetchMock.mock.calls.filter(([path]) => path.startsWith("/api/agent-inventory?")).length;
    const readsBeforeResult = savedReads();
    await act(async () => pending.resolve(Response.json(inventoryRefreshJob("succeeded", currentJob.id))));
    expect(screen.getByText(/Latest agent refresh: waiting authorization/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Resume PP agent refresh" })).toBeEnabled();
    expect(savedReads()).toBe(readsBeforeResult);
  });

  it.each([
    ["refresh", "succeeded", "running"],
    ["resume", "waiting_authorization", "running"],
    ["poll", "running", "waiting_authorization"],
  ] as const)(
    "does not let delayed Power Platform history replace a newer %s",
    async (action, previousStatus, nextStatus) => {
      const transport = appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
      const base = transport.fetchMock.getMockImplementation()!;
      const previousJob = inventoryRefreshJob(previousStatus, "previous-job");
      const nextJob = inventoryRefreshJob(nextStatus, action === "refresh" ? "new-job" : previousJob.id);
      let delayHistory = false;
      let delayedHistoryRequested = false;
      let releaseHistory!: (response: Response) => void;
      const delayedHistory = new Promise<Response>(resolve => { releaseHistory = resolve; });
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (input === "/api/inventory/refresh-jobs" && !init?.method) {
          if (delayHistory) {
            delayedHistoryRequested = true;
            return delayedHistory.then(response => response.clone());
          }
          return Response.json({ value: [previousJob], lastAttemptAt: null, lastSuccessAt: null });
        }
        if (
          (input === "/api/inventory/refresh-jobs" && init?.method === "POST")
          || input === `/api/inventory/refresh-jobs/${previousJob.id}/resume`
          || input === `/api/inventory/refresh-jobs/${nextJob.id}`
        ) return Response.json(nextJob);
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await screen.findByText(agent.displayName);

      delayHistory = true;
      await userEvent.click(screen.getByRole("searchbox", { name: "Search" }));
      await userEvent.paste("Sensitive");
      await waitFor(() => expect(delayedHistoryRequested).toBe(true));
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await userEvent.click(screen.getByText("View diagnostics"));
      if (action !== "poll") {
        await userEvent.click(screen.getByRole("button", {
          name: action === "resume" ? "Resume PP agent refresh" : "Refresh PP agent inventory",
        }));
      }
      const latestStatus = new RegExp(`Latest agent refresh: ${nextStatus.replaceAll("_", " ")}`);
      expect(await screen.findByText(latestStatus, {}, { timeout: 3_000 })).toBeVisible();

      await act(async () => {
        releaseHistory(Response.json({ value: [previousJob], lastAttemptAt: null, lastSuccessAt: null }));
      });
      expect(screen.getByText(latestStatus)).toBeVisible();
      if (nextStatus === "running") {
        expect(screen.getByRole("button", { name: "Refresh PP agent inventory" })).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Resume PP agent refresh" })).not.toBeInTheDocument();
      } else {
        expect(screen.getByRole("button", { name: "Resume PP agent refresh" })).toBeEnabled();
      }
      await waitFor(() => expect(transport.fetchMock).toHaveBeenCalledWith(
        `/api/inventory/refresh-jobs/${nextJob.id}`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ), { timeout: 3_000 });
    },
  );

  it("reports Power Platform history failures without discarding saved agent inventory", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/inventory/refresh-jobs") {
        return Response.json({
          code: "inventory_history_unavailable",
          detail: "Synthetic inventory history failure.",
        }, { status: 503 });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText(agent.displayName)).toBeVisible();
    await waitFor(() => expect(screen.getByText(/Unable to load Power Platform agent refresh history: Synthetic inventory history failure/)).toBeVisible());
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByRole("heading", { name: "Agent inventory sources" })).toBeVisible();
    expect(screen.getByText("Total").nextElementSibling).toHaveTextContent("1");
  });

  it("ignores Power Platform history failures from a superseded inventory read", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    let historyRequests = 0;
    let releaseHistory!: (response: Response) => void;
    const delayedHistory = new Promise<Response>(resolve => { releaseHistory = resolve; });
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/inventory/refresh-jobs" && ++historyRequests === 1) return delayedHistory;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(historyRequests).toBe(1));
    await userEvent.click(screen.getByRole("searchbox", { name: "Search" }));
    await userEvent.paste("Sensitive");
    expect(await screen.findByText(agent.displayName)).toBeVisible();

    await act(async () => {
      releaseHistory(Response.json({
        code: "inventory_history_unavailable",
        detail: "Superseded history failure.",
      }, { status: 503 }));
    });
    expect(screen.queryByText(/Unable to load Power Platform agent refresh history/)).not.toBeInTheDocument();
    expect(screen.getByText(agent.displayName)).toBeVisible();
  });

  it.each(["matching details", "Power Platform inventory"] as const)(
    "preserves selection and filters across Sync navigation when a delayed %s refresh completes",
    async refreshKind => {
      const freshAgent = { ...agent, id: "package-fresh", displayName: "Fresh filtered agent" };
      const freshRecord = {
        ...unifiedPage.value[0],
        id: "graph_packages:package-fresh",
        displayName: freshAgent.displayName,
        packages: [freshAgent],
      };
      const combinedPackagePage = { ...packagePage, value: [agent, freshAgent], count: 2 };
      const combinedUnifiedPage = unifiedRecordsPage([unifiedPage.value[0], freshRecord], 2);
      const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: combinedUnifiedPage });
      const base = transport.fetchMock.getMockImplementation()!;
      let releaseRefresh!: (response: Response) => void;
      const delayedRefresh = new Promise<Response>(resolve => { releaseRefresh = resolve; });
      transport.fetchMock.mockImplementation(async (input, init) => {
        const url = new URL(input, "http://localhost");
        if (url.pathname === "/api/capabilities") {
          const definitions = capabilityDefinitions.filter(item =>
            item.id === "graph.package.read.delegated"
            || item.id === "powerPlatform.inventory.read");
          return Response.json({ value: definitions.map(definition => ({
            definition,
            decision: {
              capabilityId: definition.id,
              status: "available",
              authorized: true,
              fresh: true,
              verification: "provider",
              checkedAt: new Date(Date.now() - 1_000).toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              previewQualification: "not_required",
              remediation: [],
            },
          })) });
        }
        if (url.pathname === "/api/agents" && (!init?.method || init.method === "GET")) {
          return Response.json(filterPackageResponse(combinedPackagePage, input));
        }
        if (
          refreshKind === "matching details"
          && input === "/api/agents/refresh-selection"
          && init?.method === "POST"
        ) return delayedRefresh;
        if (
          refreshKind === "Power Platform inventory"
          && input === "/api/inventory/refresh-jobs"
          && init?.method === "POST"
        ) return delayedRefresh;
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);

      await screen.findByText(agent.displayName);
      if (refreshKind === "matching details") {
        await userEvent.click(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` }));
      }
      const search = screen.getByRole("searchbox", { name: "Search" });
      await userEvent.clear(search);
      await userEvent.type(search, "Fresh");
      expect(await screen.findByText(freshAgent.displayName)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await userEvent.click(screen.getByText("View diagnostics"));
      await userEvent.click(screen.getByRole("button", {
        name: refreshKind === "matching details" ? "Refresh matching details" : "Refresh PP agent inventory",
      }));

      await act(async () => releaseRefresh(Response.json(
        refreshKind === "matching details"
          ? completedRefreshJob()
          : inventoryRefreshJob("succeeded"),
      )));
      await waitFor(() => {
        const inventoryRequests = transport.fetchMock.mock.calls
          .map(([path]) => selectedInventoryUrl(String(path)))
          .filter(url => url.pathname === "/api/agent-inventory");
        expect(inventoryRequests.at(-1)?.searchParams.get("search")).toBe("Fresh");
      });
      await userEvent.click(screen.getByRole("button", { name: "Agents" }));
      expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("Fresh");
      expect(screen.getByText(freshAgent.displayName)).toBeInTheDocument();
      expect(within(screen.getByRole("region", { name: "Unified agents" })).queryByText(agent.displayName)).not.toBeInTheDocument();
    },
  );

  it("continues restored Power Platform refresh polling through repeated running states", async () => {
    const freshAgent = { ...agent, id: "package-fresh", displayName: "Fresh polled agent" };
    const freshRecord = {
      ...unifiedPage.value[0],
      id: "graph_packages:package-fresh",
      displayName: freshAgent.displayName,
      packages: [freshAgent],
    };
    const combinedUnifiedPage = unifiedRecordsPage([unifiedPage.value[0], freshRecord], 2);
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: combinedUnifiedPage });
    const base = transport.fetchMock.getMockImplementation()!;
    let exactPolls = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/inventory/refresh-jobs/restored-running") {
        exactPolls += 1;
        return Response.json(inventoryRefreshJob(exactPolls < 2 ? "running" : "succeeded", "restored-running"));
      }
      if (input === "/api/inventory/refresh-jobs" && !init?.method) {
        return Response.json({
          value: [inventoryRefreshJob(exactPolls < 2 ? "running" : "succeeded", "restored-running")],
          lastAttemptAt: null,
          lastSuccessAt: null,
        });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    await screen.findByText(agent.displayName);
    const search = screen.getByRole("searchbox", { name: "Search" });
    await userEvent.clear(search);
    await userEvent.type(search, "Fresh");
    expect(await screen.findByText(freshAgent.displayName)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(await screen.findByText(/Latest agent refresh: succeeded/, {}, { timeout: 4_000 })).toBeVisible();
    expect(exactPolls).toBe(2);
    const inventoryRequests = transport.fetchMock.mock.calls
      .map(([path]) => selectedInventoryUrl(String(path)))
      .filter(url => url.pathname === "/api/agent-inventory");
    expect(inventoryRequests.at(-1)?.searchParams.get("search")).toBe("Fresh");
  });

  it("purges protected rows when Viewer is removed during revalidation", async () => {
    window.history.replaceState({}, "", "/agents?q=ref+a5331a93");
    const transport = appTransport({
      initialRoles: ["AgentControl.Viewer"],
      revalidatedRoles: [],
      deferRevalidation: true,
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();

    transport.failProtectedReadsWith = 403;
    transport.protectedFailureCode = "missing_internal_role";
    await act(async () => {
      await expect(getAgents({ operationIdPrefix: "a5331a93" })).rejects.toMatchObject({
        status: 403,
        code: "missing_internal_role",
      });
    });

    await waitFor(() => expect(transport.meCalls()).toBe(2));
    expect(screen.queryByText("Sensitive cached agent")).not.toBeInTheDocument();
    await act(async () => transport.releaseRevalidation());
    expect(await screen.findByRole("heading", { name: "Permissions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jobs" })).not.toBeInTheDocument();
  });

  it.each(["filtered", "group"] as const)("restores pinned %s 5000-target selection without downloading target IDs", async kind => {
    const owner = { ...viewer, roles: ["AgentControl.Admin"] as SessionUser["roles"] };
    const id = "agent:11111111-1111-4111-8111-111111111111";
    const inventory = { id: "restored-inventory-pin",
      query: JSON.stringify({ inventoryScope: "catalog", sortBy: "displayName", sortDirection: "asc" }), page: 0, count: 5_000,
      ...(kind === "filtered" ? { allMatching: true } : { groups: [id] }) };
    expect(storePackageSelection(owner, [], inventory)).toBe(true);
    window.history.replaceState({}, "", "/agents?selectionState=session&selectionCount=5000");
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Response.json({
        ...unifiedPage, value: [{ ...unifiedPage.value[0], id, packageCount: 5_000, packagesComplete: false, memberCount: 5_000 }],
        selection: { ...unifiedPage.selection, id: inventory.id },
        counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 5_000 },
      });
      if (input === "/api/agents/mutation-selection") return Response.json({ count: 5_000 });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText("5000 published versions selected")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Block selected packages" })).toBeEnabled());
    expect(restorePackageSelection(owner, 5_000)).toMatchObject({ status: "restored", ids: [], inventory });
    const reads = transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === "/api/agent-inventory");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(([input]) => new URL(input, "http://localhost").searchParams.get("selectionId") === inventory.id)).toBe(true);
    expect(transport.fetchMock.mock.calls.some(([input]) => /\/members|\/children/.test(input))).toBe(false);
    expect(window.location.search).toContain("selectionCount=5000");
    expect(window.location.search).not.toContain("selected=");
  });

  it("rejects a restored group belonging to different inventory filters without partial selection", async () => {
    const owner = { ...viewer, roles: ["AgentControl.Admin"] as SessionUser["roles"] };
    expect(storePackageSelection(owner, [], { id: "wrong-filter-pin",
      query: JSON.stringify({ inventoryScope: "catalog", sortBy: "displayName", sortDirection: "asc" }),
      page: 0, count: 5_000, groups: ["old-group"] })).toBe(true);
    window.history.replaceState({}, "", "/agents?q=changed&selectionState=session&selectionCount=5000");
    const transport = appTransport({ initialRoles: owner.roles, revalidatedRoles: owner.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText(/prior 5,000-package selection could not be restored/)).toBeInTheDocument();
    expect(restorePackageSelection(owner, 5_000)).toEqual({ status: "unavailable" });
    expect(screen.queryByRole("button", { name: "Block selected packages" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([input]) => String(input).includes("wrong-filter-pin"))).toBe(false);
  });

  it("restores all 5000 selected packages from bounded principal-scoped session routing", async () => {
    const selectedIds = Array.from({ length: 5_000 }, (_, index) => `package-${index}`);
    expect(storePackageSelection(viewer, selectedIds)).toBe(true);
    window.history.replaceState({}, "", "/agents?selectionState=session&selectionCount=5000");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("5000 published versions selected")).toBeInTheDocument();
    expect(await screen.findByText(/5,000 selected packages are preserved only for this signed-in browser session/)).toBeInTheDocument();
    expect(window.location.href.length).toBeLessThan(4_096);
    expect(window.location.search).toContain("selectionState=session");
    expect(window.location.search).not.toContain("selected=");
  });

  it.each(["AgentControl.Viewer", "AgentControl.Admin"] as const)("uses the durable initial sync instead of an automatic package scan for %s", async role => {
    const transport = initialCatalogTransport({ initialRoles: [role], revalidatedRoles: [role] });
    transport.page = undefined;
    const base = transport.fetchMock.getMockImplementation()!;
    const syncSources = ["users", "graph_packages", "power_platform", "usage_reports"].map(source => ({
      source,
      status: "not_started",
      jobId: null,
      count: null,
      lastSuccessAt: null,
      updatedAt: "2026-09-15T08:00:00.000Z",
      message: "",
      canRetry: false,
    }));
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/state") return Response.json({
        onboardingRequired: true,
        usageImportRequired: true,
        run: null,
        sources: syncSources,
      });
      if (input === "/api/data-sync/runs" && init?.method === "POST") return Response.json({
        id: "durable-initial-sync",
        mode: "initial",
        status: "running",
        startedAt: "2026-09-15T08:00:00.000Z",
        updatedAt: "2026-09-15T08:00:00.000Z",
        completedAt: null,
        sources: syncSources.map(source => ({ ...source, status: "queued" })),
      }, { status: 202 });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("dialog", { name: "Set up your workspace" })).toBeVisible();
    expect(agentListRequests(transport.fetchMock)).toHaveLength(0);
    expect(screen.queryByText(/No saved package catalog observation. Open Sync to collect it/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Data sync" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Data sync" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Set up your workspace" })).toBeVisible();
    expect(screen.getByRole("list", { name: "First sync sources" }).children).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "View sync details" }));
    expect(await screen.findByRole("region", { name: "Data sync" })).toBeVisible();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs?"))).toBe(false);

    await userEvent.click(await screen.findByRole("button", { name: "Start initial sync" }));
    const request = transport.fetchMock.mock.calls.find(([path, init]) =>
      path === "/api/data-sync/runs" && init?.method === "POST");
    expect(request).toBeDefined();
    if (!request) throw new Error("Expected the durable initial sync request.");
    expect(request[1]).toMatchObject({ method: "POST", headers: expect.objectContaining({ "X-CSRF-Token": "csrf-1" }) });
    expect(JSON.parse(String(request[1]?.body))).toEqual({ mode: "initial" });
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it.each(["/permissions", "/official-usage"])("does not start a package scan from %s or when Agents is later opened", async route => {
    window.history.replaceState({}, "", route);
    const transport = initialCatalogTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("button", { name: "Agents" });
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(route === "/permissions" ? 0 : 1));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs"))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs"))).toBe(false);
  });

  it("preserves existing snapshots, including empty catalogs and filtered-empty results", async () => {
    const transport = initialCatalogTransport();
    transport.page = { ...packagePage, value: [], counts: { total: 0, scoped: 0, filtered: 0 } };
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Catalog collected/)).toBeInTheDocument());
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs"))).toBe(false);
  });

  it("does not use legacy package-refresh job history as onboarding authority", async () => {
    const transport = initialCatalogTransport();
    transport.jobs = [{ ...completedRefreshJob(), status: "running", snapshotId: null }];
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(1));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs?"))).toBe(false);
    await userEvent.click(await screen.findByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(await screen.findByRole("button", { name: "Refresh agents" })).toBeEnabled();
  });

  it("does not turn a pending or empty saved catalog response into provider enumeration", async () => {
    const transport = initialCatalogTransport();
    let release!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { release = resolve; });
    transport.catalogResponse = () => response;
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(1));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    transport.page = { ...packagePage, value: [], counts: { total: 0, scoped: 0, filtered: 0 } };
    transport.catalogResponse = undefined;
    await act(async () => release(Response.json(unifiedRecordsPage([]))));
    expect(await screen.findByRole("heading", { name: "No agents in this inventory" })).toBeVisible();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs"))).toBe(false);
  });

  it("does not convert a failed saved catalog request into provider enumeration", async () => {
    const transport = initialCatalogTransport();
    transport.catalogResponse = async () => Response.json({ code: "provider_error", detail: "Saved catalog unavailable" }, { status: 500 });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText(/Saved catalog unavailable/)).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it.each(["unassigned", "missing-provider-permission"] as const)("does not automatically enumerate for %s sessions", async scenario => {
    const transport = initialCatalogTransport(scenario === "unassigned" ? { initialRoles: [], revalidatedRoles: [] } : {});
    if (scenario === "missing-provider-permission") transport.readAuthorized = false;
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("button", { name: "Sign out" });
    if (scenario === "unassigned") {
      expect(await screen.findByRole("heading", { name: "Permissions" })).toBeInTheDocument();
      expect(agentListRequests(transport.fetchMock)).toHaveLength(0);
    } else {
      await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(1));
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await userEvent.click(screen.getByText("View diagnostics"));
      expect(screen.getByRole("button", { name: "Refresh agents" })).toBeDisabled();
    }
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("does not auto-start a package refresh under StrictMode", async () => {
    const transport = initialCatalogTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<StrictMode><App /></StrictMode>);
    await screen.findByText("Sensitive cached agent");
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs"))).toBe(false);
  });

  it("keeps package refresh explicit and allows an explicit retry after failure", async () => {
    const transport = initialCatalogTransport();
    transport.failRefresh = true;
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    await screen.findByRole("button", { name: "Refresh agents" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh agents" })).toBeEnabled());
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
    expect(await screen.findByText("Synthetic initial refresh failed")).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(1);
    transport.failRefresh = false;
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh agents" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(2);
  });

  it("does not begin a package-refresh preflight when the user leaves Agents", async () => {
    const transport = initialCatalogTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs"))).toBe(false);
  });

  it.each([
    ["the same account", viewer],
    ["the same account in another tenant", { ...viewer, tenantId: "tenant-2" }],
    ["a different account", { ...viewer, tenantId: "tenant-2", homeAccountId: "viewer-2" }],
  ] as const)("does not auto-start a package scan when revalidating %s", async (_label, revalidatedUser) => {
    const transport = initialCatalogTransport({
      revalidatedRoles: viewer.roles,
      deferRevalidation: true,
      revalidatedUser,
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(1));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    transport.session.failProtectedReadsWith = 401;
    await act(async () => { await expect(getAgents()).rejects.toMatchObject({ status: 401 }); });
    await waitFor(() => expect(transport.session.meCalls()).toBe(2));
    transport.session.failProtectedReadsWith = undefined;
    await act(async () => transport.session.releaseRevalidation());
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs"))).toBe(false);
    expect(agentListRequests(transport.fetchMock).every(([path]) => !String(path).includes("snapshotId=snapshot-private"))).toBe(true);
  });

  it("loads fresh exact access details before opening the table access editor", async () => {
    const transport = accessEditorTransport();
    transport.exactStatus = "running";
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Manage access for Sensitive cached agent" }));
    expect(screen.queryByRole("dialog", { name: "Manage agent access" })).not.toBeInTheDocument();
    const editor = await screen.findByRole("dialog", { name: "Manage agent access" });
    expect(within(editor).getByRole("radio", { name: /No users/ })).toBeChecked();
    const calls = transport.fetchMock.mock.calls;
    const start = calls.findIndex(([path]) => path === "/api/agents/package-private/refresh-jobs");
    const poll = calls.findIndex(([path]) => String(path).startsWith("/api/agents/refresh-jobs/access-detail"));
    const detail = calls.findIndex(([path]) => isPackageDetailRequest(path, agent.id));
    expect(start).toBeGreaterThan(-1);
    expect(poll).toBeGreaterThan(start);
    expect(detail).toBeGreaterThan(poll);
    expect(calls[start][1]).toMatchObject({ method: "POST", headers: expect.objectContaining({ "X-CSRF-Token": "csrf-1" }) });
    expect(calls.some(([path]) => String(path).includes("mutation-preview") || String(path).endsWith("/access"))).toBe(false);
  });

  it.each(["availability", "installation"] as const)("edits %s inline and verifies current exact settings only on Apply", async target => {
    const transport = accessEditorTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View details for Sensitive cached agent" }));
    const saved = await screen.findByRole("dialog", { name: "Sensitive cached agent" });
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private/refresh-jobs")).toBe(false);
    expect(transport.fetchMock.mock.calls.filter(([path]) => isPackageDetailRequest(path, agent.id))).toHaveLength(1);
    await userEvent.click(within(saved).getByRole("tab", { name: "Manage" }));
    await userEvent.click(within(saved).getByRole("button", { name: target === "availability" ? /^Available to/ : /^Installed for/ }));
    expect(within(saved).getByRole("heading", { name: target === "availability" ? "Select who can use this agent" : "Select who this agent is installed for" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toEqual([saved]);
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private/refresh-jobs")).toBe(false);
    await userEvent.click(within(saved).getByRole("radio", { name: /No users/ }));
    await userEvent.click(within(saved).getByRole("button", { name: "Apply" }));
    const confirmation = await within(saved).findByRole("region", { name: new RegExp(`update ${target} package`, "i") });
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/package-private/refresh-jobs")).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([path]) => isPackageDetailRequest(path, agent.id))).toHaveLength(2);
    expect(transport.fetchMock.mock.calls.some(([path, init]) => String(path).endsWith("/access") && init?.method === "PATCH")).toBe(false);
    await userEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Manage agent access" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toEqual([saved]);
    expect(within(saved).getByRole("radio", { name: /No users/ })).toBeChecked();
  });

  it("keeps block confirmation inside the unified agent modal and returns to the editor on cancel", async () => {
    const transport = accessEditorTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View details for Sensitive cached agent" }));
    const detail = await screen.findByRole("dialog", { name: "Sensitive cached agent" });
    await userEvent.click(within(detail).getByRole("tab", { name: "Manage" }));
    await userEvent.click(within(detail).getByRole("button", { name: "Block Sensitive cached agent (package-private)" }));

    const confirmation = await within(detail).findByRole("region", { name: /block package/i });
    expect(screen.getAllByRole("dialog")).toEqual([detail]);
    expect(within(confirmation).getByText("package-private")).not.toBeVisible();
    await userEvent.click(within(confirmation).getByText("Technical details"));
    expect(within(confirmation).getByText("package-private")).toBeVisible();
    await userEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(screen.getAllByRole("dialog")).toEqual([detail]);
    expect(within(detail).getByRole("heading", { name: "Select who can use this agent" })).toBeVisible();
    expect(new URLSearchParams(window.location.search).get("detail")).toBe(unifiedPage.value[0].id);
  });

  it.each(["export", "confirmation"] as const)("contains keyboard focus in the standalone %s dialog and restores its opener", async kind => {
    const transport = accessEditorTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const opener = screen.getByRole("button", { name: kind === "export" ? "Export agent inventory CSV" : `Block ${agent.displayName}` });
    await userEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: kind === "export" ? "Export agent inventory" : /block package/i });
    expect(dialog).toHaveFocus();
    const first = kind === "export" ? within(dialog).getByRole("button", { name: /Download matching agents/ }) : within(dialog).getByText("Technical details");
    const last = within(dialog).getByRole("button", { name: kind === "export" ? "Cancel" : "Block package" });
    await userEvent.tab();
    expect(first).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
    await userEvent.tab();
    expect(first).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(dialog).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("projects provider-verified access results into the unified row detail", async () => {
    const transport = accessEditorTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View details for Sensitive cached agent" }));
    const detail = await screen.findByRole("dialog", { name: "Sensitive cached agent" });
    await userEvent.click(within(detail).getByRole("tab", { name: "Manage" }));
    await userEvent.click(within(detail).getByRole("radio", { name: /No users/ }));
    await userEvent.click(within(detail).getByRole("button", { name: "Apply" }));
    const confirmation = await within(detail).findByRole("region", { name: /update availability package/i });
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm update availability" }));

    const restored = await screen.findByRole("dialog", { name: "Sensitive cached agent" });
    expect(restored).toBe(detail);
    expect(within(restored).getByRole("radio", { name: /No users/ })).toBeChecked();
    await waitFor(() => {
      expect(within(restored).queryByText("Loading saved agent details...")).not.toBeInTheDocument();
      expect(within(restored).getByRole("button", { name: /^Installed for/ })).toBeEnabled();
    });
    await userEvent.click(within(restored).getByRole("button", { name: /^Installed for/ }));
    expect(within(restored).getByRole("region", { name: "Installation settings" })).toBeVisible();
    expect(await within(restored).findByText("Installed user", { exact: true })).toBeVisible();
  });

  it.each(["block", "availability", "skipped"] as const)("refreshes filtered membership, counts and export revisions after verified %s changes", async action => {
    window.history.replaceState({}, "", action === "availability"
      ? `/agents?${new URLSearchParams({ availability: encodeInventoryFacet("available:some") })}` : "/agents?status=allowed");
    const packageBefore = { ...agent, availableTo: "some", allowedUsersAndGroups: [{ resourceType: "user" as const, resourceId: "installed-user" }] };
    const retainedPackage = { ...packageBefore, id: "package-retained", displayName: "Retained matching agent" };
    const original = { ...unifiedPage.value[0], packages: [packageBefore] };
    const retained = { ...original, id: `graph_packages:${retainedPackage.id}`, displayName: retainedPackage.displayName, packages: [retainedPackage] };
    const before = unifiedRecordsPage([original, retained]);
    const revision = "c".repeat(64);
    let changed = false;
    const packageAfter = action === "availability"
      ? { ...packageBefore, availableTo: "none", allowedUsersAndGroups: [] }
      : { ...packageBefore, isBlocked: true };
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input.startsWith("/api/agent-inventory?")) {
        return Response.json(selectedInventoryPage(input, changed ? {
          ...before, selection: { ...before.selection, revision }, value: [retained],
          counts: { ...before.counts, filtered: 1 },
          filteredSummary: { ...before.filteredSummary, total: 1, graphOnly: 1 },
        } : before));
      }
      if (unifiedDetailId(input)) return Response.json({ ...original, packages: [changed ? packageAfter : packageBefore] });
      if (isPackageDetailRequest(input, agent.id)) return Response.json(changed ? packageAfter : packageBefore);
      if (input === `/api/agents/${agent.id}/block` && init?.method === "POST") {
        changed = true;
        unifiedPage.selection.revision = revision;
        return Response.json({
          ...waitingBulkJob(), id: "verified-block-job", status: "succeeded", canResume: false,
          total: 1, completed: 1, succeeded: action === "skipped" ? 0 : 1, skipped: action === "skipped" ? 1 : 0,
          inconclusive: 0, reconciliationRequired: 0,
        });
      }
      if (input.startsWith("/api/agents/bulk-jobs/verified-block-job/items?")) return Response.json({
        value: [{ id: agent.id, displayName: agent.displayName, status: action === "skipped" ? "skipped" : "succeeded" }],
        revision: "1", counts: { total: 1, filtered: 1 }, page: { limit: 50, nextCursor: null, previousCursor: null },
      });
      if (input === `/api/agents/${agent.id}/access` && init?.method === "PATCH") {
        changed = true;
        unifiedPage.selection.revision = revision;
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
    const detail = await screen.findByRole("dialog", { name: agent.displayName });
    await userEvent.click(within(detail).getByRole("tab", { name: "Manage" }));
    if (action !== "availability") {
      await userEvent.click(within(detail).getByRole("button", { name: `Block ${agent.displayName} (${agent.id})` }));
    } else {
      await userEvent.click(within(detail).getByRole("radio", { name: /No users/ }));
      await userEvent.click(within(detail).getByRole("button", { name: "Apply" }));
    }
    const confirmation = await within(detail).findByRole("region", { name: action === "availability" ? /update availability package/i : /block package/i });
    await userEvent.click(within(confirmation).getByRole("button", { name: action === "availability" ? "Confirm update availability" : "Block package" }));

    await screen.findByRole("heading", { name: "Agents 1 of 2", hidden: true });
    expect(screen.queryByRole("button", { name: `View details for ${agent.displayName}`, hidden: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: `View details for ${retainedPackage.displayName}`, hidden: true })).toBeInTheDocument();
    await userEvent.click(within(detail).getByRole("button", { name: /close/i }));
    const exportButton = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await userEvent.click(exportButton);
    await userEvent.click(await screen.findByRole("button", { name: /Download matching agents/ }));
    await completeNativeInventoryDownload(download);
    const exported = inventoryExportRequest(transport.fetchMock);
    expect(exported.kind).toBe("unified_agents");
    expect(inventorySelections.get(exported.selectionId)?.selection.revision).toBe(revision);
    expect(inventorySelections.get(exported.selectionId)?.query).toMatchObject(
      action === "availability" ? { availableTo: encodeInventoryFacet("available:some") } : { blocked: "false" },
    );
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it.each([
    "2026-09-15T12:00:00.000Z",
    "2026-09-16T12:00:00.000Z",
    "2030-01-01T12:00:00.000Z",
  ])("restores only the Power Platform targets named by a popped route on %s", async now => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    resetInventoryFixtures();
    const recordA = powerPlatformRecord("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", "Agent A");
    const recordB = powerPlatformRecord("bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", "Agent B");
    const routeA = `/agents?inventory=power_platform_only&inventorySnapshot=${powerPlatformSnapshot().snapshotId}&selectedResource=${encodeURIComponent(recordA.id)}`;
    window.history.replaceState({}, "", routeA);
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"],
      revalidatedRoles: ["AgentControl.Admin"],
      unifiedResponse: unifiedRecordsPage([recordA, recordB]),
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    const selectA = await screen.findByRole("checkbox", { name: "Select Agent A" });
    await waitFor(() => {
      expect(selectA).toBeChecked();
      expect(selectA).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Agent A" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Agent B" }));
    expect(screen.getByRole("checkbox", { name: "Select Agent B" })).toBeChecked();

    await act(async () => {
      window.history.replaceState({}, "", routeA);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Select Agent A" })).toBeChecked());
    expect(screen.getByRole("checkbox", { name: "Select Agent B" })).not.toBeChecked();
    expect(screen.getByText("1 exact quarantine target selected")).toBeInTheDocument();

    await userEvent.click(within(screen.getByRole("region", { name: "Copilot Studio quarantine controls" })).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Copilot Studio quarantine controls" })).not.toBeInTheDocument());
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("selectedResource")).toBe(false));
  });

  it("loads an exact quarantine job even when its route has no selected targets", async () => {
    window.history.replaceState({}, "", "/agents?quarantineJob=job-only");
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"],
      revalidatedRoles: ["AgentControl.Admin"],
    });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/quarantine/jobs/job-only") return Response.json(quarantineJob("job-only"));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("Quarantine job: Succeeded")).toBeInTheDocument();
    expect(screen.getByText("0 of 25 exact Copilot Studio agents selected")).toBeInTheDocument();
    expect(transport.fetchMock).toHaveBeenCalledWith(
      "/api/quarantine/jobs/job-only",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each(["table", "detail"] as const)("surfaces exact-read failures without offering a mutation confirmation from %s", async entry => {
    const transport = accessEditorTransport();
    transport.exactResponse = async () => Response.json({ code: "forbidden", detail: "Exact provider read denied" }, { status: 403 });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    if (entry === "table") {
      await userEvent.click(await screen.findByRole("button", { name: "Manage access for Sensitive cached agent" }));
    } else {
      await userEvent.click(await screen.findByRole("button", { name: "View details for Sensitive cached agent" }));
      const saved = await screen.findByRole("dialog", { name: "Sensitive cached agent" });
      await userEvent.click(within(saved).getByRole("tab", { name: "Manage" }));
      await userEvent.click(within(saved).getByRole("button", { name: /^Installed for/ }));
      await userEvent.click(within(saved).getByRole("radio", { name: /No users/ }));
      await userEvent.click(within(saved).getByRole("button", { name: "Apply" }));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent("Exact provider read denied");
    expect(screen.queryByRole("dialog", { name: "Manage agent access" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/mutation-preview")).toBe(false);
    expect(transport.fetchMock.mock.calls.filter(([path]) => isPackageDetailRequest(path, agent.id))).toHaveLength(entry === "table" ? 0 : 1);
  });

  it("preserves current capability checks before preparing access", async () => {
    const transport = accessEditorTransport();
    transport.accessAuthorized = false;
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const manage = await screen.findByRole("button", { name: "Manage access for Sensitive cached agent" });
    expect(manage).toBeDisabled();
    await userEvent.click(manage);
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private/refresh-jobs")).toBe(false);
  });

  it.each(["failed", "waiting_authorization"] as const)("surfaces a %s exact-read job without using the saved projection", async status => {
    const transport = accessEditorTransport();
    transport.exactStatus = status;
    transport.exactMessage = "Provider requires interactive read authorization.";
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Manage access for Sensitive cached agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(transport.exactMessage);
    expect(screen.queryByRole("dialog", { name: "Manage agent access" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([path]) => isPackageDetailRequest(path, agent.id))).toBe(false);
  });

  it.each(["navigation", "history"] as const)("does not open an editor from an exact-read response after %s leaves Agents", async method => {
    const transport = accessEditorTransport();
    let release!: (response: Response) => void;
    transport.exactResponse = () => new Promise<Response>(resolve => { release = resolve;     });

    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Manage access for Sensitive cached agent" }));
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private/refresh-jobs")).toBe(true));
    if (method === "navigation") await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
    else await act(async () => {
      window.history.pushState({}, "", "/permissions");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => release(Response.json(completedRefreshJob())));
    expect(screen.queryByRole("dialog", { name: "Manage agent access" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([path]) => isPackageDetailRequest(path, agent.id))).toBe(false);
  });

  it.each(["sign-out", "account-change", "role-loss"].flatMap(boundary =>
    ["official_agents", "official_users", "copilot_users"].map(kind => ({ boundary, kind })),
  ))("does not publish a pending private $kind export after $boundary", async ({ boundary, kind }) => {
    window.history.replaceState({}, "", kind === "official_users" ? "/users?view=activity"
      : kind === "copilot_users" ? "/users" : "/official-usage?view=snapshot");
    const transport = appTransport({
      revalidatedRoles: boundary === "role-loss" ? [] : viewer.roles,
      revalidatedUser: boundary === "account-change"
        ? { ...viewer, tenantId: "replacement-tenant", homeAccountId: "replacement-viewer" }
        : viewer,
    });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) => input === "/api/auth/logout"
      ? Promise.resolve(new Response(null, { status: 204 }))
      : input === "/api/data-exports" && init?.method === "POST" ? pending.promise
        : new URL(input, "http://localhost").pathname === "/api/copilot-usage/users" ? Promise.resolve(Response.json(selectedUsersPage()))
          : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await waitFor(() => expect(transport.fetchMock).toHaveBeenCalledWith("/api/data-sync/auto-refresh", expect.anything()));
    const exportLabel = kind === "official_agents" ? "Export agent CSV" : "Export users CSV";
    await waitFor(() => expect(screen.getByRole("button", { name: exportLabel })).toBeEnabled());
    const exportButton = screen.getByRole("button", { name: exportLabel });
    await userEvent.click(exportButton);
    const creations = transport.fetchMock.mock.calls.filter(([path, init]) => path === "/api/data-exports" && init?.method === "POST");
    expect(creations).toHaveLength(1);
    expect(JSON.parse(String(creations[0][1]?.body))).toEqual({ selectionId: selectedUsersPage().selection.id, kind, idempotencyKey: expect.any(String) });

    if (boundary === "sign-out") {
      await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument());
    } else {
      await revalidateTransportSession(transport);
    }
    await act(async () => pending.resolve(Response.json({ id: "70000000-0000-4000-8000-000000000001" })));
    expect(download.filenames).toEqual([]);
    expect(download.createObjectURL).not.toHaveBeenCalled();
    expect(creations[0][1]?.signal?.aborted).toBe(true);
    expect(transport.fetchMock.mock.calls.some(([path]) => path.startsWith("/api/data-exports/"))).toBe(false);
    expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([path]) => /official-usage\/.*\.csv/.test(path))).toBe(false);
  });

  it.each(["/official-usage", "/official-usage?view=history", "/sync?reports=manage"])(
    "opens one read-only report manager for Viewer from %s", async path => {
      window.history.replaceState({}, "", path);
      const transport = appTransport({ revalidatedRoles: viewer.roles });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      expect(await screen.findByRole("dialog", { name: "Manage reports" })).toBeVisible();
      await screen.findByRole("region", { name: "Saved report sets" });
      expect(window.location.pathname).toBe("/sync");
      expect(new URLSearchParams(window.location.search).get("reports")).toBe("manage");
      expect(screen.queryByRole("button", { name: "Official usage" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Add CSV reports" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "View report history" })).not.toBeInTheDocument();
      expect(transport.fetchMock.mock.calls.some(([path]) => path.startsWith("/api/official-usage/admin"))).toBe(false);
      expect(transport.fetchMock.mock.calls.filter(([path]) => path.startsWith("/api/official-usage/"))
        .every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    },
  );

  it("restores report inspection on browser navigation and closes back to Sync", async () => {
    window.history.replaceState({}, "", "/sync?reports=manage");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("region", { name: "Saved report sets" });
    await act(async () => {
      window.history.pushState({}, "", "/sync?reports=snapshot");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("270");
    await act(async () => {
      window.history.pushState({}, "", "/sync?reports=manage");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByRole("region", { name: "Saved report sets" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close reports" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/sync");
    expect(new URLSearchParams(window.location.search).has("reports")).toBe(false);
  });

  it("restores a historical official-usage snapshot as exact GET reads without changing active selection", async () => {
    const reportSetId = "11111111-1111-4111-8111-111111111111";
    window.history.replaceState({}, "", `/official-usage?snapshot=${reportSetId}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/official-usage/aggregate") {
        return Response.json(selectedAgentsPage({ setId: reportSetId }));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByRole("dialog", { name: "Report details" })).toBeVisible();
    await waitFor(() => {
      expect(transport.fetchMock.mock.calls.some(([input]) =>
        new URL(input, "http://localhost").pathname === "/api/official-usage/aggregate"
        && new URL(input, "http://localhost").searchParams.get("setId") === reportSetId
        && new URL(input, "http://localhost").searchParams.get("activityWindowDays") === "365")).toBe(true);
    });
    expect(transport.fetchMock.mock.calls.some(([input]) => input.startsWith("/api/official-usage/users"))).toBe(false);
    const officialUsageCalls = transport.fetchMock.mock.calls.filter(([input]) =>
      input.startsWith("/api/official-usage/"));
    expect(officialUsageCalls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    expect(await screen.findByRole("region", { name: "Snapshot tenant totals" })).toBeVisible();
    expect(new URLSearchParams(window.location.search).get("snapshot")).toBe(reportSetId);
    expect(new URLSearchParams(window.location.search).has("window")).toBe(false);
    expect(window.location.pathname).toBe("/sync");
    expect(new URLSearchParams(window.location.search).get("reports")).toBe("snapshot");
  });

  it("does not show current-snapshot data when an exact historical set is unavailable", async () => {
    const reportSetId = "99999999-9999-4999-8999-999999999999";
    window.history.replaceState({}, "", `/official-usage?snapshot=${reportSetId}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (
        (new URL(input, "http://localhost").pathname === "/api/official-usage/aggregate" || input.startsWith("/api/official-usage/users"))
        && input.includes(`setId=${reportSetId}`)
      ) {
        return Response.json({
          code: "official_usage_set_not_found",
          detail: "The retained official usage set is unavailable.",
        }, { status: 404 });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("The retained official usage set is unavailable.");
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    const exactCalls = transport.fetchMock.mock.calls.filter(([input]) =>
      input.includes(`setId=${reportSetId}`));
    expect(exactCalls.some(([input]) => new URL(input, "http://localhost").pathname === "/api/official-usage/aggregate")).toBe(true);
    expect(exactCalls.some(([input]) => input.startsWith("/api/official-usage/users"))).toBe(false);
    expect(exactCalls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it.each(["current", "historical"] as const)("hides a superseded %s snapshot summary until its new activity window loads", async scope => {
    const data = selectedAgentsPage();
    window.history.replaceState({}, "", scope === "current"
      ? "/official-usage?view=snapshot" : `/official-usage?snapshot=${data.reports.setId}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let reads = 0;
    transport.fetchMock.mockImplementation((input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/official-usage/aggregate") {
        return ++reads === 2 ? pending.promise : Promise.resolve(Response.json(data));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("270");
    await act(async () => {
      const params = new URLSearchParams(window.location.search);
      params.set("window", "7");
      window.history.pushState({}, "", `/sync?${params}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
    await act(async () => pending.resolve(Response.json({
      code: "service_unavailable", detail: "New snapshot revision unavailable.",
    }, { status: 503 })));
    expect(await screen.findByRole("alert")).toHaveTextContent("New snapshot revision unavailable.");
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing the last loaded data for retained set/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    expect(await screen.findByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("270");
  });

  it("withholds current-report totals after a failed HTTP selected read and retries only explicitly", async () => {
    window.history.replaceState({}, "", "/official-usage?view=snapshot");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    let failed = true;
    transport.fetchMock.mockImplementation((input, init) => {
      const url = new URL(input, "http://localhost");
      return failed && url.pathname === "/api/official-usage/aggregate" && url.searchParams.has("search")
        ? Promise.resolve(Response.json({ code: "service_unavailable", detail: "Filter read unavailable." }, { status: 503 }))
        : base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("region", { name: "Snapshot tenant totals" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents" }), { target: { value: "Researcher" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Filter read unavailable.");
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    expect(screen.queryByText(/The last loaded summary is shown/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
    const reads = () => transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === "/api/official-usage/aggregate").length;
    const before = reads();
    await act(async () => {});
    expect(reads()).toBe(before);
    failed = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    expect(await screen.findByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("270");
    expect(reads()).toBe(before + 1);
  });

  it("keeps report evidence in Sync without duplicating inventory analytics or navigation", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles, reportHistory: selectedHistoryPage() });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    expect(screen.queryByRole("region", { name: "Tenant adoption insights" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Explore usage & users" })).not.toBeInTheDocument();
    const aggregateReads = () => transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === "/api/official-usage/aggregate");
    expect(aggregateReads()).toHaveLength(0);

    expect(screen.queryByRole("button", { name: "Official usage" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Manage reports" }));
    expect(await screen.findByRole("region", { name: "Saved report sets" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Retained activity summary" })).not.toBeInTheDocument();
    expect(aggregateReads()).toHaveLength(0);
    await userEvent.click(await screen.findByRole("button", { name: "View report" }));
    expect(await screen.findByRole("region", { name: "Snapshot tenant totals" })).toHaveTextContent("270");
    expect(aggregateReads()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    await userEvent.click(screen.getByRole("button", { name: "Close reports" }));
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    await screen.findByText(agent.displayName);
    expect(screen.queryByRole("region", { name: "Tenant adoption insights" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Snapshot tenant totals" })).not.toBeInTheDocument();
    expect(aggregateReads()).toHaveLength(1);
  });

  it("keeps saved-report management history-only without an additional cross-report exploration surface", async () => {
    window.history.replaceState({}, "", "/official-usage");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("region", { name: "Saved report sets" });
    expect(screen.queryByText("Find an agent across reports")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Retained agent activity rows" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([input]) => input.startsWith("/api/official-usage/overview"))).toHaveLength(0);
  });

  it("keeps known inventory dashboard counts when retained reporting is unavailable", async () => {
    const transport = appTransport({
      revalidatedRoles: viewer.roles,
      inventoryReadAuthorized: true,
      unifiedResponse: { ...unifiedPage, inventoryOverview: { availableToUsers: 0, organizationCreated: 1, teamsAvailable: 0, createdOrAvailable: 1 } },
    });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => input.startsWith("/api/official-usage/overview")
      ? Promise.resolve(Response.json({ code: "service_unavailable", detail: "Retained reports unavailable." }, { status: 503 }))
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const overview = within(await screen.findByRole("region", { name: "Agent inventory overview" }));
    await waitFor(() => expect(overview.getByText("Agents in catalog").parentElement).toHaveTextContent("1"));
    expect(overview.getByText("Available to end users").parentElement).toHaveTextContent("0");
    expect(await overview.findByRole("alert")).toHaveTextContent("Retained reports unavailable.");
    expect(overview.getByText("Reported used agents").parentElement).toHaveTextContent("Unknown");
    expect(overview.getByText("Reported active · 30 days").parentElement).toHaveTextContent("Unknown");
  });

  it("defaults to the enriched catalog and switches scopes without carrying hidden selections or filters into exports", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Additional native agent");
    const records = [unifiedPage.value[0], native];
    const transport = appTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"],
      unifiedResponse: unifiedRecordsPage(records), inventoryReadAuthorized: true });
    vi.stubGlobal("fetch", transport.fetchMock);
    mockCsvDownload();
    render(<App />);
    await screen.findByText(agent.displayName);
    expect(screen.queryByText(native.displayName)).not.toBeInTheDocument();
    const scopes = within(screen.getByRole("group", { name: "Inventory scope" }));
    expect(scopes.getByRole("button", { name: "Microsoft 365 catalog" })).toHaveAttribute("aria-pressed", "true");
    expect(scopes.queryByRole("button", { name: "Combined inventory" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Agent inventory overview" })).getByRole("combobox", { name: "Report set" })).toBeInTheDocument();
    expect(screen.queryByText(/Agents in the Microsoft 365 package catalog/)).not.toBeInTheDocument();
    expect(screen.queryByText(/package records represent|Counts can differ from the admin portal/)).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Inventory scope" }).closest(".agent-catalog-heading")).not.toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Sensitive" } });
    await userEvent.click(scopes.getByRole("button", { name: "Additional Power Platform agents" }));
    await screen.findByText(native.displayName);
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Block selected packages" })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("");
    expect(window.location.search).toBe("?inventory=power_platform_only");
    expect(scopes.getByRole("button", { name: "Additional Power Platform agents" }))
      .toHaveAccessibleDescription(expect.stringContaining("no confirmed match in the saved package catalog"));
    expect(screen.queryByText(/no confirmed match in the saved package catalog/)).not.toBeInTheDocument();
    const reads = transport.fetchMock.mock.calls.filter(([path]) => path.startsWith("/api/agent-inventory?"));
    expect(selectedInventoryUrl(reads[0][0]).searchParams.get("inventoryScope")).toBe("catalog");
    expect(selectedInventoryUrl(reads.at(-1)![0]).searchParams.get("inventoryScope")).toBe("power_platform_only");
    await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
    await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/data-exports")).toBe(true));
    const exported = inventoryExportRequest(transport.fetchMock);
    expect(inventorySelections.get(exported.selectionId)?.query.inventoryScope).toBe("power_platform_only");
    act(() => {
      window.history.pushState({}, "", "/agents?inventory=all");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await screen.findByText(agent.displayName);
    expect(screen.getByText(native.displayName)).toBeVisible();
    expect(window.location.search).toBe("?inventory=all");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Sensitive" } });
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(window.location.search).toBe("?inventory=all");
  });

  it("does not present Power Platform inventory as a known catalog count when the catalog is unavailable", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Additional native agent");
    const page = unifiedRecordsPage([native]);
    page.sources.graphPackages = { state: "unavailable", observation: null, error: {
      source: "graph_packages", code: "snapshot_unavailable", message: "No saved package catalog.",
    } };
    page.partial = true;
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page, inventoryReadAuthorized: true });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const overview = within(await screen.findByRole("region", { name: "Agent inventory overview" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Additional Power Platform agents" })).toHaveTextContent("1"));
    expect(overview.getByText("Agents in catalog").parentElement).toHaveTextContent("Unknown");
    expect(overview.getByText("Available to end users").parentElement).toHaveTextContent("Unknown");
    expect(screen.queryByText(native.displayName)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Additional Power Platform agents" }));
    await screen.findByText(native.displayName);
    expect(overview.getByText(/Catalog matching is incomplete/)).toBeVisible();
  });

  it("ignores a superseded inventory-scope response even when the transport ignores cancellation", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Additional native agent");
    const page = unifiedRecordsPage([unifiedPage.value[0], native]);
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page, inventoryReadAuthorized: true });
    const base = transport.fetchMock.getMockImplementation()!;
    let resolvePrevious!: (response: Response) => void;
    const previous = new Promise<Response>(resolve => { resolvePrevious = resolve; });
    transport.fetchMock.mockImplementation((input, init) =>
      input.startsWith("/api/agent-inventory?") && selectedInventoryUrl(input).searchParams.get("inventoryScope") === "power_platform_only"
        ? previous : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("button", { name: "Additional Power Platform agents" }));
    await waitFor(() => expect(agentListRequests(transport.fetchMock).some(([input]) => selectedInventoryUrl(input).searchParams.get("inventoryScope") === "power_platform_only")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Microsoft 365 catalog" }));
    await screen.findByText(agent.displayName);
    await act(async () => resolvePrevious(Response.json({
      ...page, inventoryScope: "power_platform_only", value: [{ ...native, displayName: "Obsolete scope response" }],
    })));
    expect(screen.queryByText("Obsolete scope response")).not.toBeInTheDocument();
    expect(screen.getByText(agent.displayName)).toBeVisible();
    expect(screen.queryByText(native.displayName)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Microsoft 365 catalog" })).toHaveAttribute("aria-pressed", "true");
  });

  it("loads the cumulative summary on Sync but opens report history only on demand without person-level data", async () => {
    window.history.replaceState({}, "", "/official-usage?view=snapshot");
    const transport = appTransport({ revalidatedRoles: viewer.roles, reportHistory: selectedHistoryPage() });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agent CSV" })).toBeEnabled());
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) => {
      const url = new URL(input, "http://localhost");
      return url.pathname === "/api/official-usage/history" && url.searchParams.get("limit") === "1" && !url.searchParams.has("offset");
    })).toBe(true));
    expect(screen.queryByRole("region", { name: "Saved report sets" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([input]) => input.startsWith("/api/official-usage/users"))).toBe(false);
    expect(screen.getByRole("region", { name: "Reported agent activity" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) => input.startsWith("/api/official-usage/history"))).toBe(true));
    expect(screen.queryByRole("region", { name: "Reported agent activity" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Saved report sets" })).toBeVisible();
    await userEvent.click(await screen.findByRole("button", { name: "View report" }));
    expect(await screen.findByRole("region", { name: "Reported agent activity" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Saved report sets" })).not.toBeInTheDocument();
  });

  it("ignores a late aggregate when activity returns after visiting report history", async () => {
    window.history.replaceState({}, "", "/official-usage?view=snapshot");
    const transport = appTransport({ revalidatedRoles: viewer.roles, reportHistory: selectedHistoryPage() });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let reads = 0;
    transport.fetchMock.mockImplementation((input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/official-usage/aggregate") {
        reads += 1;
        return reads === 1 ? pending.promise : Promise.resolve(Response.json(selectedAgentsPage()));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(reads).toBe(1));
    const originalRead = transport.fetchMock.mock.calls.find(([input]) => new URL(input, "http://localhost").pathname === "/api/official-usage/aggregate")!;
    await userEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    expect(originalRead[1]?.signal?.aborted).toBe(true);
    await userEvent.click(await screen.findByRole("button", { name: "View report" }));
    const rows = await screen.findByRole("region", { name: "Reported agent activity" });
    expect(within(rows).getByRole("button", { name: "Researcher" })).toBeVisible();
    const obsolete = selectedAgentsPage();
    obsolete.value[0].agentName = "Obsolete private aggregate";
    await act(async () => pending.resolve(Response.json(obsolete)));
    expect(screen.queryByText("Obsolete private aggregate")).not.toBeInTheDocument();
    expect(within(rows).getByRole("button", { name: "Researcher" })).toBeVisible();
    expect(reads).toBe(2);
  });

  it("clears historical loading when reversed dates cancel a pending aggregate", async () => {
    const data = selectedAgentsPage();
    window.history.replaceState({}, "", `/official-usage?snapshot=${data.reports.setId}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/official-usage/aggregate" && url.searchParams.has("startDate")) return pending.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("region", { name: "Reported agent activity" });
    fireEvent.change(screen.getByLabelText("Activity start date"), { target: { value: "2026-09-12" } });
    expect(screen.getByRole("region", { name: "Reported agent activity" })).toHaveAttribute("aria-busy", "true");
    const pendingRequest = transport.fetchMock.mock.calls.find(([input]) => new URL(input, "http://localhost").searchParams.has("startDate"))!;
    fireEvent.change(screen.getByLabelText("Activity end date"), { target: { value: "2026-09-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("start date must be on or before the end date");
    expect(pendingRequest[1]?.signal?.aborted).toBe(true);
    expect(screen.getByRole("region", { name: "Reported agent activity" })).toHaveAttribute("aria-busy", "false");
    expect(transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === "/api/official-usage/aggregate")).toHaveLength(2);
    await act(async () => pending.resolve(Response.json(data)));
    expect(screen.queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByRole("button", { name: "Researcher" })).toBeVisible();
  });

  it.each(["/sync", "/agents"])("recovers an exact package refresh on Sync from a %s job link", async path => {
    window.history.replaceState({}, "", `${path}?refreshJob=retained-package-run&mode=application`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/agents/refresh-jobs/retained-package-run?mode=application") {
        return Response.json({ ...completedRefreshJob(), id: "retained-package-run", tokenMode: "application" });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("region", { name: "Selected package refresh job" })).toHaveTextContent("retained-package-run");
    expect(window.location.pathname).toBe("/sync");
    expect(new URLSearchParams(window.location.search).get("mode")).toBe("application");
    const collectionRequests = transport.fetchMock.mock.calls.filter(([input]) =>
      input.startsWith("/api/agents") || input.startsWith("/api/data-sync") || input.startsWith("/api/inventory"));
    expect(collectionRequests.every(([input, init]) => input === "/api/data-sync/auto-refresh" || (init?.method ?? "GET") === "GET")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(window.location.search).not.toContain("refreshJob");
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    expect(new URLSearchParams(window.location.search).get("refreshJob")).toBe("retained-package-run");
    expect(await screen.findByRole("region", { name: "Selected package refresh job" })).toHaveTextContent("retained-package-run");
  });

  it("keeps a linked package job live on Sync beyond thirty minutes until it finishes", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/sync?refreshJob=retained-package-run&mode=application");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    let completed = false;
    let reads = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/agents/refresh-jobs/retained-package-run?mode=application") {
        reads += 1;
        return Response.json({ ...completedRefreshJob(), id: "retained-package-run", tokenMode: "application",
          status: completed ? "succeeded" : "running" });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const view = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("region", { name: "Selected package refresh job" })).toHaveTextContent("running");
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_250); });
    expect(reads).toBe(4);
    completed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(reads).toBe(5);
    expect(screen.getByRole("region", { name: "Selected package refresh job" })).toHaveTextContent("succeeded");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(reads).toBe(5);
    view.unmount();
  });

  it.each([false, true])("reloads saved inventory after a linked package refresh publishes (already finished: %s)", async initiallyComplete => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/sync?refreshJob=linked-publish");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    let completed = initiallyComplete;
    let inventoryReads = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/agents/refresh-jobs/linked-publish?mode=delegated") {
        return Response.json({ ...completedRefreshJob(), id: "linked-publish", status: completed ? "succeeded" : "running" });
      }
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        inventoryReads += 1;
        const page = structuredClone(unifiedPage);
        if (completed) {
          page.value[0].displayName = "Newly published agent";
          page.value[0].packages[0].displayName = "Newly published agent";
        }
        return Response.json(page);
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const view = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(inventoryReads).toBe(2);
    expect(screen.getByRole("region", { name: "Selected package refresh job" })).toHaveTextContent(initiallyComplete ? "succeeded" : "running");
    completed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(screen.getByRole("region", { name: "Selected package refresh job" })).toHaveTextContent("succeeded");
    expect(inventoryReads).toBe(initiallyComplete ? 2 : 3);
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Newly published agent")).toBeVisible();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    view.unmount();
  });

  it("opens the exact data-sync run requested by a history link instead of showing the latest run", async () => {
    window.history.replaceState({}, "", "/agents?syncRun=retained-sync-run");
    const sources = ["users", "graph_packages", "power_platform", "usage_reports"].map(source => ({
      source,
      status: "succeeded",
      jobId: null,
      count: 1,
      lastSuccessAt: "2026-09-15T08:00:00.000Z",
      updatedAt: "2026-09-15T08:00:00.000Z",
      message: "",
      canRetry: false,
    }));
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/state") return Response.json({
        onboardingRequired: false,
        usageImportRequired: false,
        run: {
          id: "latest-sync-run",
          mode: "incremental",
          status: "completed",
          startedAt: "2026-09-15T09:00:00.000Z",
          updatedAt: "2026-09-15T09:01:00.000Z",
          completedAt: "2026-09-15T09:01:00.000Z",
          sources,
        },
        sources,
      });
      if (input === "/api/data-sync/runs/retained-sync-run") return Response.json({
        id: "retained-sync-run",
        mode: "full",
        status: "partial",
        startedAt: "2026-09-14T09:00:00.000Z",
        updatedAt: "2026-09-14T09:01:00.000Z",
        completedAt: "2026-09-14T09:01:00.000Z",
        sources: [
          { ...sources[0], count: 7 },
          { ...sources[1], status: "failed", count: null, canRetry: true },
        ],
      });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("retained-sync-run", { selector: "code" })).toBeVisible();
    expect(screen.queryByText("latest-sync-run", { selector: "code" })).not.toBeInTheDocument();
    expect(transport.fetchMock).toHaveBeenCalledWith(
      "/api/data-sync/runs/retained-sync-run",
      expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }),
    );
    expect(new URLSearchParams(window.location.search).get("syncRun")).toBe("retained-sync-run");
    expect(window.location.pathname).toBe("/sync");
    expect(screen.queryByRole("dialog", { name: "Data sync" })).not.toBeInTheDocument();
  });

  it.each(["/jobs", "/jobs/?source=package-controls"])("redirects the retired %s bookmark to Sync without job recovery controls", async path => {
    window.history.replaceState({}, "", path);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sync history" })).toBeVisible();
    expect(window.location.pathname).toBe("/sync");
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("button", { name: "Jobs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry incomplete" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([input]) => String(input).endsWith("/retry"))).toBe(false);
  });

  it("stages explicit access targets on the server without client detail enumeration", async () => {
    const transport = accessEditorTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Sensitive cached agent" }));
    await userEvent.click(screen.getByRole("button", { name: "Manage access" }));
    const editor = await screen.findByRole("dialog", { name: "Manage agent access" });
    await userEvent.click(within(editor).getByRole("radio", { name: /No users/ }));
    await userEvent.click(within(editor).getByRole("button", { name: "Apply" }));
    await userEvent.click(within(editor).getByRole("button", { name: "Confirm and apply" }));
    expect(await screen.findByRole("dialog", { name: /update availability package\?/i })).toBeInTheDocument();
    const calls = transport.fetchMock.mock.calls;
    const preview = calls.findIndex(([path]) => path === "/api/agents/mutation-preview");
    expect(preview).toBeGreaterThan(-1);
    expect(JSON.parse(String(calls[preview][1]?.body))).toMatchObject({
      ids: [agent.id], mutationScope: "bulk", action: "update-availability",
    });
    expect(calls.some(([path]) => isPackageDetailRequest(path, agent.id))).toBe(false);
    expect(calls.some(([path]) => String(path).endsWith("/access"))).toBe(false);
  });

  it.each(["navigation", "inventory scope change", "session revalidation", "scoped agent denial"] as const)(
    "discards a delayed bulk preview after %s",
    async scenario => {
      const transport = accessEditorTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      let preview: Response | undefined;
      let deny = false;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (deny && new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
          return Response.json({ code: "forbidden", detail: "Saved agent access denied." }, { status: 403 });
        }
        if (input === "/api/agents/mutation-preview") {
          preview = await base(input, init);
          return pending.promise;
        }
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
      await userEvent.click(screen.getByRole("button", { name: "Block selected packages" }));
      await waitFor(() => expect(preview).toBeDefined());
      if (scenario === "navigation") {
        await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
      } else if (scenario === "inventory scope change") {
        await userEvent.click(screen.getByRole("button", { name: "Additional Power Platform agents" }));
      } else if (scenario === "scoped agent denial") {
        deny = true;
        fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Sensitive" } });
        await screen.findByText(/Saved agent access denied/);
        deny = false;
        await userEvent.click(screen.getByRole("button", { name: "Reload saved agent inventory" }));
        await screen.findByText(agent.displayName);
      } else {
        await revalidateTransportSession(transport.session);
      }
      await act(async () => pending.resolve(preview!));
      expect(screen.queryByRole("dialog", { name: /block package/i })).not.toBeInTheDocument();
    },
  );

  it("keeps the newest bulk preview when responses arrive out of order", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let blockPreview: Response | undefined;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/agents/mutation-preview" && JSON.parse(String(init?.body)).action === "block") {
        blockPreview = await base(input, init);
        return pending.promise;
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
    await userEvent.click(screen.getByRole("button", { name: "Block selected packages" }));
    await userEvent.click(screen.getByRole("button", { name: "Unblock selected packages" }));
    await screen.findByRole("dialog", { name: /^unblock package/i });
    await act(async () => pending.resolve(blockPreview!));
    expect(screen.getByRole("dialog", { name: /^unblock package/i })).toBeInTheDocument();
  });

  it.each([
    ["single", "session revalidation"], ["bulk", "session revalidation"],
    ["single", "scoped agent denial"], ["bulk", "scoped agent denial"],
  ] as const)(
    "does not track a delayed %s mutation response after %s",
    async (scope, boundary) => {
      const transport = accessEditorTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const endpoint = scope === "single" ? `/api/agents/${agent.id}/block` : "/api/agents/block";
      let deny = false;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (deny && new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
          return Response.json({ code: "forbidden", detail: "Saved agent access denied." }, { status: 403 });
        }
        return input === endpoint ? pending.promise : base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      if (scope === "single") {
        await userEvent.click(await screen.findByRole("button", { name: `Block ${agent.displayName}` }));
      } else {
        await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
        await userEvent.click(screen.getByRole("button", { name: "Block selected packages" }));
      }
      await userEvent.click(await screen.findByRole("button", { name: "Block package" }));
      await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => path === endpoint)).toBe(true));
      if (boundary === "session revalidation") await revalidateTransportSession(transport.session);
      else {
        deny = true;
        fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Sensitive" } });
        await screen.findByText(/Saved agent access denied/);
        deny = false;
        await userEvent.click(screen.getByRole("button", { name: "Reload saved agent inventory" }));
        await screen.findByText(agent.displayName);
      }
      await act(async () => pending.resolve(Response.json(waitingBulkJob())));
      expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBeNull();
      expect(screen.queryByRole("group", { name: "Package job progress" })).not.toBeInTheDocument();
    },
  );

  it.each([
    ["resume", "session revalidation"], ["cancel", "session revalidation"], ["reconcile", "session revalidation"],
    ["resume", "scoped agent denial"], ["cancel", "scoped agent denial"], ["reconcile", "scoped agent denial"],
  ] as const)(
    "discards a delayed package-job %s response after %s",
    async (operation, boundary) => {
      const transport = accessEditorTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const job = waitingBulkJob();
      const endpoint = `/api/agents/bulk-jobs/${job.id}/${operation}`;
      window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
      let deny = false;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (deny && new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
          return Response.json({ code: "forbidden", detail: "Saved agent access denied." }, { status: 403 });
        }
        if (input === endpoint) return pending.promise;
        if (input === `/api/agents/bulk-jobs/${job.id}`) return Response.json(job);
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      const label = operation === "resume" ? "Resume unprocessed tasks"
        : operation === "cancel" ? "Cancel unprocessed tasks" : "Check uncertain results";
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const button = await screen.findByRole("button", { name: label });
      await waitFor(() => expect(button).toBeEnabled());
      await userEvent.click(button);
      await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => path === endpoint)).toBe(true));
      if (boundary === "session revalidation") await revalidateTransportSession(transport.session);
      else {
        deny = true;
        fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Sensitive" } });
        await screen.findByText(/Saved agent access denied/);
        deny = false;
        await userEvent.click(screen.getByRole("button", { name: "Reload saved agent inventory" }));
        await screen.findByText(agent.displayName);
      }
      await act(async () => pending.resolve(Response.json({
        ...job, reconciliation: { attempted: 1, failed: 0, errors: [] },
      })));
      expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBeNull();
      expect(screen.queryByRole("group", { name: "Package job progress" })).not.toBeInTheDocument();
    },
  );

  it.each([
    ["unified", "success"],
    ["unified", "failure"],
  ] as const)("discards a delayed %s export %s after session revalidation", async (source, outcome) => {
    const transport = appTransport({
      revalidatedRoles: viewer.roles,
      unifiedResponse: unifiedRecordsPage(unifiedPage.value),
    });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const isExport = (path: string) => path === "/api/data-exports";
    transport.fetchMock.mockImplementation(async (input, init) =>
      isExport(input) ? pending.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:expired-export") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    render(<App />);
    await screen.findByText(agent.displayName);
    if (source === "unified") {
      await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
      await userEvent.click(await screen.findByRole("button", { name: /Download matching agents/ }));
    } else {
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await userEvent.click(screen.getByText("View diagnostics"));
      const button = await screen.findByRole("button", { name: "Export PP agent inventory CSV" });
      await waitFor(() => expect(button).toBeEnabled());
      await userEvent.click(button);
    }
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => isExport(path))).toBe(true));
    await revalidateTransportSession(transport);
    await act(async () => pending.resolve(outcome === "success"
      ? Response.json({ id: "old-session-export" })
      : Response.json({ code: "export_failed", detail: "Old session export failed" }, { status: 500 })));
    expect(download).not.toHaveBeenCalled();
    expect(screen.queryByText(/Old session export failed/)).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/data-exports/old-session-export")).toBe(false);
  });

  it("purges private state even when browser storage removal fails", async () => {
    const transport = appTransport({ revalidatedRoles: [], deferRevalidation: true });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const remove = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key: string) {
      if (this === window.localStorage) throw new DOMException("Storage is blocked", "SecurityError");
      remove.call(this, key);
    });
    transport.failProtectedReadsWith = 401;
    await act(async () => { await expect(getAgents()).rejects.toMatchObject({ status: 401 }); });
    await waitFor(() => expect(transport.meCalls()).toBe(2));
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    await act(async () => transport.releaseRevalidation());
    expect(await screen.findByRole("heading", { name: "Permissions" })).toBeInTheDocument();
    expect(screen.getByText(/Unable to clear the saved package job/)).toBeInTheDocument();
  });

  it("tracks an accepted package job when browser storage writes fail", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) =>
      input === `/api/agents/${agent.id}/block` ? Response.json(waitingBulkJob()) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: `Block ${agent.displayName}` }));
    const store = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === window.localStorage) throw new DOMException("Storage is full", "QuotaExceededError");
      store.call(this, key, value);
    });
    await userEvent.click(await screen.findByRole("button", { name: "Block package" }));
    expect(await screen.findByRole("group", { name: "Package job progress" })).toBeInTheDocument();
    expect(screen.getByText(/Unable to save the active package job/)).toBeInTheDocument();
    expect(screen.queryByText("Storage is full")).not.toBeInTheDocument();
  });

  it.each(["navigation", "unmount"] as const)(
    "preserves accepted-job ownership across %s",
    async scenario => {
      const transport = accessEditorTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      transport.fetchMock.mockImplementation(async (input, init) =>
        input === `/api/agents/${agent.id}/block` ? pending.promise : base(input, init));
      vi.stubGlobal("fetch", transport.fetchMock);
      const app = render(<App />);
      await userEvent.click(await screen.findByRole("button", { name: `Block ${agent.displayName}` }));
      await userEvent.click(await screen.findByRole("button", { name: "Block package" }));
      if (scenario === "navigation") await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
      else app.unmount();
      await act(async () => pending.resolve(Response.json(waitingBulkJob())));
      if (scenario === "navigation") {
        expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBe(waitingBulkJob().id);
        await userEvent.click(screen.getByRole("button", { name: "Agents" }));
        expect(screen.getByRole("group", { name: "Package job progress" })).toBeInTheDocument();
      } else {
        expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBeNull();
      }
    },
  );

  it.each(["unified", "Power Platform"] as const)(
    "finishes an in-flight %s export across tabs without starting a duplicate",
    async source => {
      const transport = appTransport({
        revalidatedRoles: viewer.roles,
        unifiedResponse: unifiedRecordsPage(unifiedPage.value),
      });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const isExport = (path: string) => path === "/api/data-exports";
      transport.fetchMock.mockImplementation(async (input, init) =>
        isExport(input) ? pending.promise : base(input, init));
      vi.stubGlobal("fetch", transport.fetchMock);
      const download = mockCsvDownload();
      render(<App />);
      await screen.findByText(agent.displayName);
      if (source === "unified") {
        await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
        await userEvent.click(await screen.findByRole("button", { name: /Download matching agents/ }));
      } else {
        await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
        await userEvent.click(screen.getByText("View diagnostics"));
        await userEvent.click(await screen.findByRole("button", { name: "Export PP agent inventory CSV" }));
      }
      await waitFor(() => expect(transport.fetchMock.mock.calls.filter(([path]) => isExport(path))).toHaveLength(1));
      await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
      await userEvent.click(screen.getByRole("button", { name: source === "unified" ? "Agents" : /^Sync/ }));
      if (source !== "unified") await userEvent.click(screen.getByText("View diagnostics"));
      expect(screen.getByRole("button", { name: source === "unified" ? /^Exporting/ : "Exporting PP agents..." })).toBeDisabled();
      await act(async () => pending.resolve(Response.json({ id: "inventory-export" })));
      expect(download.hrefs).toHaveLength(0);
      await completeNativeInventoryDownload(download);
      expect(transport.fetchMock.mock.calls.filter(([path]) => isExport(path))).toHaveLength(1);
    },
  );

  it("does not replace a cancellation response with an older running poll", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const job = { ...waitingBulkJob(), status: "running", canResume: false } satisfies BulkActionJob;
    const jobEndpoint = `/api/agents/bulk-jobs/${job.id}`;
    let polls = 0;
    window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === jobEndpoint) {
        polls += 1;
        return polls === 1 ? Response.json(job) : pending.promise;
      }
      if (input === `${jobEndpoint}/cancel`) return Response.json({ ...job, status: "cancelled" });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(polls).toBe(2), { timeout: 3_000 });
    const panel = within(screen.getByRole("region", { name: "Exact package bulk actions" }));
    expect(panel.getByRole("group", { name: "Package job progress" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Job controls" })).not.toBeInTheDocument();
    await userEvent.click(panel.getByRole("button", { name: "Cancel unprocessed tasks" }));
    await waitFor(() => expect(panel.getByRole("status")).toHaveTextContent("Cancelled"));
    await act(async () => pending.resolve(Response.json(job)));
    expect(panel.getByRole("status")).toHaveTextContent("Cancelled");
    expect(panel.queryByRole("button", { name: "Cancel unprocessed tasks" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBeNull();
    expect(panel.getByText("Unprocessed tasks were cancelled. Changes already in progress may still finish.")).toBeInTheDocument();
  });

  it("restores interrupted tasks on Agents after sign-in even without a browser job pointer", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const job = waitingBulkJob();
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input.startsWith("/api/agents/bulk-jobs?")) return Response.json({ value: [job] });
      if (input === `/api/agents/bulk-jobs/${job.id}`) return Response.json(job);
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
    expect(await panel.findByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    expect(panel.getByRole("link", { name: "Sign in again" })).toBeVisible();
    expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBe(job.id);
    expect(transport.fetchMock.mock.calls.filter(([path]) => String(path).includes("/bulk-jobs"))
      .every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it.each([
    ["another tenant's", activeBulkJobStorageKey({ ...viewer, tenantId: "tenant-2" })],
    ["another user's", activeBulkJobStorageKey({ ...viewer, homeAccountId: "viewer-2" })],
    ["legacy unscoped", "agent-control:active-bulk-job:v1"],
  ])("restores only the current principal's job and never %s browser job", async (_label, otherKey) => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const job = { ...waitingBulkJob(), id: "current-principal-job" };
    window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    window.localStorage.setItem(otherKey, "foreign-principal-job");
    transport.fetchMock.mockImplementation(async (input, init) =>
      input === `/api/agents/bulk-jobs/${job.id}` ? Response.json(job) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    expect(transport.fetchMock.mock.calls.some(([path]) => path === `/api/agents/bulk-jobs/${job.id}`)).toBe(true);
    expect(transport.fetchMock.mock.calls.some(([path]) => path.includes("foreign-principal-job"))).toBe(false);
    expect(window.localStorage.getItem(otherKey)).toBe("foreign-principal-job");
  });

  it("refreshes interrupted progress in place using only the exact job GET", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const job = waitingBulkJob();
    window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    let reads = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === `/api/agents/bulk-jobs/${job.id}`) {
        reads += 1;
        return Response.json(job);
      }
      if (input === `/api/agents/bulk-jobs/${job.id}/resume`) {
        return Response.json({ code: "service_unavailable", detail: "Outcome could not be checked." }, { status: 503 });
      }
      return base(input, init);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Resume unprocessed tasks" }));
    const before = reads;
    await userEvent.click(await screen.findByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(reads).toBe(before + 1));
    expect(screen.queryByRole("button", { name: "Refresh status" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    expect(transport.fetchMock.mock.calls.filter(([path, init]) =>
      String(path).includes("/bulk-jobs") && init?.method === "POST")).toHaveLength(1);
  });

  it.each(["cancel", "resume", "reconcile"] as const)("submits %s once and shows a retryable failure in the unified job panel", async operation => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const job = waitingBulkJob();
    const endpoint = `/api/agents/bulk-jobs/${job.id}/${operation}`;
    window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    let attempts = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === `/api/agents/bulk-jobs/${job.id}`) return Response.json(job);
      if (input === endpoint) {
        attempts += 1;
        return attempts === 1 ? pending.promise : Response.json({
          ...job, reconciliation: { attempted: 0, failed: 0, errors: [] },
        });
      }
      return base(input, init);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
    const label = operation === "cancel" ? "Cancel unprocessed tasks"
      : operation === "resume" ? "Resume unprocessed tasks" : "Check uncertain results";
    const button = await panel.findByRole("button", { name: label });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(attempts).toBe(1));
    for (const control of panel.getAllByRole("button")) expect(control).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Job controls" })).not.toBeInTheDocument();
    await act(async () => pending.resolve(Response.json({ code: "provider_error", detail: "Job command unavailable." }, { status: 503 })));
    expect(await panel.findByRole("alert")).toHaveTextContent("Job command unavailable.");
    expect(screen.getAllByText(/Job command unavailable\./)).toHaveLength(1);
    expect(panel.getByRole("button", { name: label })).toBeEnabled();
    await userEvent.click(panel.getByRole("button", { name: label }));
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect(panel.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("continues tracking running work after a cancellation request fails", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const job: BulkActionJob = { ...waitingBulkJob(), status: "running", canResume: false, inconclusive: 0, reconciliationRequired: 0 };
    window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    let cancellationFailed = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === `/api/agents/bulk-jobs/${job.id}/cancel`) {
        cancellationFailed = true;
        return Response.json({ code: "provider_error", detail: "Cancellation unavailable." }, { status: 503 });
      }
      if (input === `/api/agents/bulk-jobs/${job.id}`) return Response.json(cancellationFailed
        ? { ...job, status: "succeeded", completed: 2, succeeded: 2 } : job);
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel unprocessed tasks" }));
    const panel = within(screen.getByRole("region", { name: "Exact package bulk actions" }));
    expect(await panel.findByRole("alert")).toHaveTextContent("Cancellation unavailable.");
    await waitFor(() => expect(panel.getByRole("status")).toHaveTextContent("Completed"), { timeout: 3000 });
    expect(panel.getByText("2 of 2 processed")).toBeVisible();
    expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBeNull();
  });

  it("reports unavailable browser job storage without blocking saved inventory", async () => {
    const transport = accessEditorTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    const read = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (this === window.localStorage && key === activeBulkJobStorageKey()) {
        throw new DOMException("Storage is blocked", "SecurityError");
      }
      return read.call(this, key);
    });
    render(<App />);
    expect(await screen.findByText(agent.displayName)).toBeInTheDocument();
    expect(screen.getByText(/Unable to read the saved package job/)).toBeInTheDocument();
  });

  it("completes sign-out even when removing the saved package job fails", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) =>
      input === "/api/auth/logout" ? new Response(null, { status: 204 }) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const remove = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key: string) {
      if (this === window.localStorage) throw new DOMException("Storage is blocked", "SecurityError");
      remove.call(this, key);
    });
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in with Entra ID" })).toBeInTheDocument();
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(screen.getByText(/Unable to clear the saved package job/)).toBeInTheDocument();
  });

  it("clears superseded detail loading when preparing a bulk preview", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation(async (input, init) =>
      isPackageDetailRequest(input, agent.id) ? pending.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
    await userEvent.click(screen.getByRole("button", { name: `View details for ${agent.displayName}` }));
    const dialog = await screen.findByRole("dialog", { name: agent.displayName });
    expect(within(dialog).getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Loading agent details...")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Block selected packages" }));
    await screen.findByRole("dialog", { name: /block package/i });
    await act(async () => pending.resolve(Response.json(agent)));
    expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: agent.displayName })).not.toBeInTheDocument();
  });
});

function mockCsvDownload() {
  const filenames: string[] = [];
  const hrefs: string[] = [];
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:unified-agent-export");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    filenames.push(this.download);
    hrefs.push(this.getAttribute("href")!);
  });
  return { filenames, hrefs, createObjectURL };
}

async function completeNativeInventoryDownload(download: ReturnType<typeof mockCsvDownload>) {
  const count = download.hrefs.length;
  const link = await screen.findByRole("link", { name: "Download CSV" }, { timeout: 4000 });
  expect(link).toHaveAttribute("href", "/api/data-exports/inventory-export/download");
  expect(link).not.toHaveAttribute("download");
  await userEvent.click(link);
  await waitFor(() => expect(download.hrefs).toHaveLength(count + 1));
  expect(download.hrefs.at(-1)).toBe("/api/data-exports/inventory-export/download");
  expect(download.createObjectURL).not.toHaveBeenCalled();
}

function inventoryExportRequest(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.filter(([path, init]) => path === "/api/data-exports" && init?.method === "POST").at(-1);
  if (!call) throw new Error("No durable inventory export admission");
  return JSON.parse(String(call[1]?.body)) as { kind: string; selectionId: string; ids?: string[] };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(resolveResponse => { resolve = resolveResponse; });
  return { promise, resolve };
}

async function revalidateTransportSession(transport: ReturnType<typeof appTransport>) {
  const previousCalls = transport.meCalls();
  await act(async () => {
    transport.failProtectedReadsWith = 401;
    const expiredRequest = getAgents();
    transport.failProtectedReadsWith = undefined;
    await expect(expiredRequest).rejects.toMatchObject({ status: 401 });
  });
  await waitFor(() => expect(transport.meCalls()).toBeGreaterThan(previousCalls));
  await waitFor(() => expect(screen.queryByText("Checking sign-in...")).not.toBeInTheDocument());
}

function waitingBulkJob(): BulkActionJob {
  return {
    id: "pending-package-job",
    action: "block",
    targetBlockedState: true,
    status: "waiting_authorization",
    canResume: true,
    total: 2,
    completed: 1,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    inconclusive: 1, cancelled: 0, queued: 1, reconciliationRequired: 1, retryEligible: 0, resultRevision: "1",
    createdAt: "2026-09-15T08:00:00.000Z",
    updatedAt: "2026-09-15T08:00:00.000Z",
  };
}

function appTransport({
  revalidatedRoles,
  deferRevalidation = false,
  initialRoles = viewer.roles,
  authenticated = true,
  revalidatedUser = viewer,
  unifiedResponse = unifiedPage,
  inventoryReadAuthorized = false,
  reportHistory,
}: {
  revalidatedRoles: SessionUser["roles"];
  deferRevalidation?: boolean;
  initialRoles?: SessionUser["roles"];
  authenticated?: boolean;
  revalidatedUser?: SessionUser;
  unifiedResponse?: UnifiedAgentInventoryPage;
  inventoryReadAuthorized?: boolean;
  reportHistory?: ReportPage<ReportHistorySet>;
}) {
  let currentUserCalls = 0;
  let resolveRevalidation!: (response: Response) => void;
  const revalidation = new Promise<Response>(resolve => {
    resolveRevalidation = resolve;
  });
  const revalidatedResponse = () => Response.json({
    user: { ...revalidatedUser, roles: revalidatedRoles },
    csrfToken: "csrf-2",
    roleAssignmentRequired: revalidatedRoles.length === 0,
  });
  const transport: {
    failProtectedReadsWith?: 401 | 403;
    protectedFailureCode?: "forbidden" | "interaction_required" | "missing_internal_role";
    fetchMock: ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;
    meCalls: () => number;
    releaseRevalidation: () => void;
  } = {
    failProtectedReadsWith: undefined,
    protectedFailureCode: undefined,
    fetchMock: vi.fn(),
    meCalls: () => currentUserCalls,
    releaseRevalidation: () => resolveRevalidation(revalidatedResponse()),
  };
  transport.fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    if (input === "/api/data-exports" && init?.method === "POST") return Response.json({ id: "inventory-export" }, { status: 202 });
    if (input === "/api/data-exports/inventory-export") return Response.json({
      id: "inventory-export", status: "ready", rows: unifiedResponse.counts.filtered, bytes: 1024,
      expiresAt: new Date(Date.now() + 600_000).toISOString(), error: null, limit: null, observed: null,
    });
    if (input === "/api/auth/status") return Response.json({ authConfigured: true, callback: "http://localhost/api/auth/callback" });
    if (input === "/api/me") {
      currentUserCalls += 1;
      if (!authenticated) return Response.json({ user: null });
      if (currentUserCalls === 1) return Response.json({ user: { ...viewer, roles: initialRoles }, csrfToken: "csrf-1", roleAssignmentRequired: false });
      return deferRevalidation ? revalidation : revalidatedResponse();
    }
    if (input === "/api/capabilities" || input.startsWith("/api/capabilities/check")) {
      const definition = capabilityDefinitions.find(item => item.id === "powerPlatform.inventory.read")!;
      return Response.json({ value: inventoryReadAuthorized ? [{
        definition,
        decision: {
          capabilityId: definition.id,
          status: "available",
          authorized: true,
          fresh: true,
          verification: "provider",
          checkedAt: new Date(Date.now() - 1_000).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          previewQualification: "not_required",
          remediation: [],
        },
      }] : [] });
    }
    if (input === "/api/workbench/metadata") return Response.json({ views: workbenchViews, actions: workbenchActions });
    if (input === "/api/data-sync/auto-refresh") return Response.json(automaticRefreshResponse());
    if (input === "/api/workbench/jobs") return Response.json({
      value: [], unavailableSources: [], polledAt: "2026-09-15T08:00:00.000Z", requestId: "sync-history",
    });
    if (input === "/api/data-sync/state") return Response.json({
      onboardingRequired: false,
      usageImportRequired: false,
      run: null,
      sources: ["users", "graph_packages", "power_platform", "usage_reports"].map(source => ({
        source,
        status: "succeeded",
        jobId: null,
        count: 1,
        lastSuccessAt: "2026-09-15T08:00:00.000Z",
        updatedAt: "2026-09-15T08:00:00.000Z",
        message: "",
        canRetry: false,
      })),
    });
    if (new URL(input, "http://localhost").pathname === "/api/official-usage/history" && reportHistory) return Response.json(reportHistory);
    const reportData = selectedFixtureRead(input);
    if (reportData) return Response.json(reportData);
    if (input.startsWith("/api/agent-inventory")) {
      if (transport.failProtectedReadsWith) return Response.json({
        code: transport.protectedFailureCode ?? (transport.failProtectedReadsWith === 401 ? "unauthorized" : "forbidden"),
        detail: transport.failProtectedReadsWith === 401 ? "The current session has expired." : "The provider permission is insufficient.",
      }, { status: transport.failProtectedReadsWith });
      if (input === "/api/agent-inventory/selections" && init?.method === "POST") {
        const { query } = JSON.parse(String(init.body)) as { query: Record<string, string> };
        const selection = { ...unifiedResponse.selection, id: crypto.randomUUID() };
        inventorySelections.set(selection.id, { selection, query });
        return Response.json(selection, { status: 201 });
      }
      const url = new URL(input, "http://localhost"), detail = /^\/api\/agent-inventory\/([^/]+)\/detail$/.exec(url.pathname);
      if (detail) {
        const record = unifiedResponse.value.find(record => record.id === decodeURIComponent(detail[1]));
        return record ? Response.json(record) : Response.json({ code: "record_not_found", detail: "This exact saved agent is not present." }, { status: 404 });
      }
      const members = /^\/api\/agent-inventory\/([^/]+)\/members$/.exec(url.pathname);
      if (members) {
        const record = unifiedResponse.value.find(record => record.id === decodeURIComponent(members[1]));
        if (!record) return Response.json({ code: "record_not_found", detail: "This exact saved agent is not present." }, { status: 404 });
        const value = record.packages.map(item => ({ source_scope_id: "package-scope", source_identity: item.id, source_generation_id: "package-generation",
          domain: "packages", native_id: item.id, environment_id: null, display_name: item.displayName,
          observed_at: record.observations.graphPackages?.observedAt, expires_at: record.observations.graphPackages?.expiresAt }));
        if (record.powerPlatformResource) value.push({ source_scope_id: "native-scope", source_identity: record.powerPlatformResource.nativeId,
          source_generation_id: "native-generation", domain: "power_platform", native_id: record.powerPlatformResource.nativeId,
          environment_id: null, display_name: record.powerPlatformResource.displayName ?? record.powerPlatformResource.nativeId,
          observed_at: record.observations.powerPlatform?.observedAt, expires_at: record.observations.powerPlatform?.expiresAt });
        return Response.json({ value, total: value.length, nextCursor: null });
      }
      if (url.pathname === "/api/agent-inventory/facets") {
        const field = url.searchParams.get("field") ?? "";
        const values = inventoryFacets[field as keyof typeof inventoryFacets] ?? [];
        return Response.json({ value: values, total: values.length, nextCursor: null });
      }
      return Response.json(filterUnifiedResponse(unifiedResponse, input));
    }
    if (input === "/api/inventory/refresh-jobs") {
      return Response.json({ value: [], lastAttemptAt: null, lastSuccessAt: null });
    }
    if (input.startsWith("/api/quarantine/jobs?")) {
      return Response.json({ value: [] });
    }
    if (input === "/api/agents/mutation-selection" && init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as { selectionId: string; ids?: string[]; recordIds?: string[] };
      if (!inventorySelections.has(request.selectionId) && request.selectionId !== unifiedResponse.selection.id) {
        return Response.json({ code: "selection_invalidated", detail: "Unknown selected inventory" }, { status: 409 });
      }
      const records = request.recordIds ? unifiedResponse.value.filter(record => request.recordIds!.includes(record.id)) : undefined;
      return Response.json({ count: request.ids ? request.ids.length : records
        ? records.reduce((total, record) => total + (record.packageCount ?? record.packages.length), 0) : unifiedResponse.counts.packageTargets });
    }
    if (input === "/api/agents/refresh-selection" && init?.method === "POST"
      || input === "/api/agents/refresh-jobs/refresh-first-load?mode=delegated") {
      return Response.json({ ...completedRefreshJob(), scopeKind: "exact", targetCount: unifiedResponse.counts.packageTargets });
    }
    if (input.startsWith("/api/agents/refresh-jobs?")) {
      return Response.json({ value: [], lastAttemptAt: null, lastSuccessAt: null });
    }
    if (input.startsWith("/api/agents/bulk-jobs?")) return Response.json({ value: [] });
    if (input === `/api/agents/bulk-jobs/${waitingBulkJob().id}`) return Response.json(waitingBulkJob());
    if (/^\/api\/agents\/bulk-jobs\/[^/]+\/items\?/.test(input)) return Response.json({
      value: [{ id: agent.id, displayName: agent.displayName, status: input.includes("/access-update-job/") ? "succeeded" : "inconclusive",
        reconciliationStatus: input.includes("/access-update-job/") ? "not_required" : "required" }],
      revision: "1", counts: { total: input.includes("/access-update-job/") ? 1 : 2, filtered: input.includes("/access-update-job/") ? 1 : 2 },
      page: { limit: 50, nextCursor: null, previousCursor: null },
    });
    if (isPackageDetailRequest(input, agent.id)) return Response.json({
      ...agent,
      allowedUsersAndGroups: [],
      acquireUsersAndGroups: [],
      observation: {
        observedAt: packagePage.selection.evaluatedAt,
        expiresAt: packagePage.selection.expiresAt,
        scopeKind: "broad",
        source: "Microsoft Graph package catalog",
        apiMaturity: "v1.0 read; preview controls",
      },
    });
    if (input.startsWith("/api/agents")) {
      if (transport.failProtectedReadsWith) {
        const status = transport.failProtectedReadsWith;
        return Response.json({
          status,
          code: transport.protectedFailureCode ?? (status === 401 ? "unauthorized" : "forbidden"),
          detail: transport.protectedFailureCode === "interaction_required"
            ? "Microsoft authorization is required for this capability."
            : status === 401 ? "The current session has expired." : "The provider permission is insufficient.",
        }, { status });
      }
      if (input === "/api/agents/selections" && init?.method === "POST") return Response.json(packagePage.selection, { status: 201 });
      if (new URL(input, "http://localhost").pathname === "/api/agents") return Response.json(filterPackageResponse(packagePage, input));
    }

    return Response.json(
      { code: "unexpected_test_request", detail: `Unexpected request ${input}` },
      { status: 500 },
    );
  });
  return transport;
}

function filterUnifiedResponse(response: UnifiedAgentInventoryPage, input: string) {
  const url = new URL(input, "http://localhost");
  const selected = inventorySelections.get(url.searchParams.get("selectionId") ?? "");
  if (!selected) throw new Error("Unknown synthetic inventory selection");
  for (const [key, value] of Object.entries(selected.query)) url.searchParams.set(key, value);
  const inventoryScope = unifiedAgentInventoryScopes.find(scope => scope === url.searchParams.get("inventoryScope")) ?? "all";
  const scoped = response.value.filter(record => inventoryScope === "catalog" ? record.packages.length > 0
    : inventoryScope === "power_platform_only" ? record.packages.length === 0 && record.powerPlatformResource !== null : true);
  const recordId = url.searchParams.get("recordId");
  const search = url.searchParams.get("search")?.toLowerCase();
  const source = url.searchParams.has("source") ? decodeInventoryFacet(url.searchParams.get("source")!) : undefined;
  const environmentId = url.searchParams.has("environmentId") ? decodeInventoryFacet(url.searchParams.get("environmentId")!) : undefined;
  const offset = Number(url.searchParams.get("cursor")?.replace(/^fixture-page:/, "") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? response.page.limit);
  let value = scoped.filter(record =>
    (!recordId || record.id === recordId || record.packages.some(item => item.id === recordId))
    && (!search || JSON.stringify(record).toLowerCase().includes(search))
    && (!source || source === "all" || record.presence === source)
    && (!environmentId || record.environmentId === environmentId),
  );
  const count = recordId || search || (source && source !== "all") || environmentId || scoped.length !== response.value.length
    ? value.length
    : response.counts.filtered;
  if (value.length > limit || offset > 0) {
    value = value.slice(offset, offset + limit);
  }
  const scopeSummary = inventoryScope === "catalog"
    ? { ...response.summary, total: response.summary.total - response.summary.powerPlatformOnly, powerPlatformOnly: 0 }
    : inventoryScope === "power_platform_only"
      ? { total: response.summary.powerPlatformOnly, linked: 0, graphOnly: 0, powerPlatformOnly: response.summary.powerPlatformOnly, ambiguous: 0, conflicting: 0 }
      : response.summary;
  return { ...response, selection: selected.selection, inventoryScope, scopeSummary,
    value,
    counts: { ...response.counts, scoped: scopeSummary.total, filtered: count },
    page: { limit, nextCursor: offset+limit<count ? `fixture-page:${offset+limit}` : null,
      previousCursor: offset ? `fixture-page:${Math.max(0, offset-limit)}` : null } };
}

function filterPackageResponse(response: PackagePage, input: string) {
  const url = new URL(input, "http://localhost");
  const search = url.searchParams.get("search")?.toLowerCase();
  if (!search) return response;
  const value = response.value.filter(item => JSON.stringify(item).toLowerCase().includes(search));
  return { ...response, value, counts: { ...response.counts, filtered: value.length } };
}

function isPackageDetailRequest(input: unknown, id: string) {
  const url = new URL(String(input), "http://localhost");
  return url.pathname === `/api/agents/${encodeURIComponent(id)}/detail` && Boolean(url.searchParams.get("selectionId"));
}

function unifiedDetailId(input: string) {
  const path = new URL(input, "http://localhost").pathname;
  const match = /^\/api\/agent-inventory\/([^/]+)\/detail$/.exec(path);
  return match ? decodeURIComponent(match[1]) : null;
}

function agentListRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([path]) =>
    new URL(String(path), "http://localhost").pathname === "/api/agent-inventory",
  );
}

function currentInventorySelection(fetchMock: ReturnType<typeof vi.fn>) {
  const path = agentListRequests(fetchMock).at(-1)?.[0];
  if (!path) throw new Error("No selected inventory read");
  return new URL(String(path), "http://localhost").searchParams.get("selectionId")!;
}

function selectedInventoryPage(input: string, page: UnifiedAgentInventoryPage) {
  const id = new URL(input, "http://localhost").searchParams.get("selectionId")!;
  const capture = inventorySelections.get(id);
  if (!capture) throw new Error("Unknown synthetic inventory selection");
  return { ...page, selection: capture.selection };
}

function selectedInventoryUrl(input: string) {
  const url = new URL(input, "http://localhost");
  if (url.pathname !== "/api/agent-inventory") return url;
  const selected = inventorySelections.get(url.searchParams.get("selectionId") ?? "");
  if (!selected) throw new Error("Unknown selected inventory criteria");
  for (const [key, value] of Object.entries(selected.query)) {
    const decoded = ["type", "publisher", "host", "platform", "environmentId", "source", "linkState", "availableTo"].includes(key)
      ? decodeInventoryFacet(value) : value;
    url.searchParams.set(key, typeof decoded === "string" ? decoded : JSON.stringify(decoded));
  }
  return url;
}

function refreshRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([path, init]) => path === "/api/agents/refresh-jobs" && init?.method === "POST");
}

function selectedRefreshRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([path, init]) => path === "/api/agents/refresh-selection" && init?.method === "POST");
}

function completedRefreshJob(): PackageRefreshJob {
  return {
    id: "refresh-first-load", authorizationPrincipalId: viewer.homeAccountId, tokenMode: "delegated", scopeKind: "broad", targetCount: 0, resultRevision: "fixture",
    status: "succeeded", pageCount: 1, observedCount: 1, totalRecords: 1, snapshotId: "snapshot-private",
    createdAt: new Date().toISOString(), attemptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  };
}

function initialCatalogTransport(options: Partial<Parameters<typeof appTransport>[0]> = {}) {
  const session = appTransport({ revalidatedRoles: viewer.roles, ...options });
  const transport = {
    session,
    page: packagePage as PackagePage | undefined,
    jobs: [] as PackageRefreshJob[],
    failRefresh: false,
    readAuthorized: true,
    catalogResponse: undefined as (() => Promise<Response>) | undefined,
    jobResponse: undefined as (() => Promise<Response>) | undefined,
    fetchMock: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
  };
  transport.fetchMock.mockImplementation(async (input, init) => {
    if (input.startsWith("/api/official-usage/overview") || new URL(input, "http://localhost").pathname === "/api/official-usage/aggregate") {
      return Response.json(selectedFixtureRead(input));
    }
    if (input === "/api/capabilities" || input.startsWith("/api/capabilities/check")) {
      const definition = capabilityDefinitions.find(item => item.id === "graph.package.read.delegated")!;
      return Response.json({ value: [{
        definition,
        decision: { capabilityId: definition.id, status: transport.readAuthorized ? "available" : "missing_permission", authorized: transport.readAuthorized, fresh: true, verification: "provider", checkedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), previewQualification: "not_required", remediation: [] },
      }] });
    }
    if (input.startsWith("/api/agents/refresh-jobs?")) return transport.jobResponse
      ? transport.jobResponse() : Response.json({ value: transport.jobs, lastAttemptAt: null, lastSuccessAt: null });
    if (input === "/api/agents/refresh-jobs" && init?.method === "POST") {
      if (transport.failRefresh) return Response.json({ code: "provider_error", detail: "Synthetic initial refresh failed" }, { status: 500 });
      transport.page = packagePage;
      return Response.json(completedRefreshJob());
    }
    const response = await session.fetchMock(input, init);
    if (response.ok && new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
      if (transport.catalogResponse) return transport.catalogResponse();
      if (options.unifiedResponse) return response;
      return Response.json({
        ...filterUnifiedResponse(unifiedPage, input),
        value: (transport.page?.value ?? []).map(item => ({ ...unifiedPage.value[0], id: `graph_packages:${item.id}`, displayName: item.displayName, packages: [item] })),
        counts: { ...transport.page?.counts, total: transport.page?.counts.total ?? 0,
          scoped: transport.page?.counts.scoped ?? 0, filtered: transport.page?.counts.filtered ?? 0,
          packageTargets: transport.page?.counts.filtered ?? 0 },
        sources: { ...unifiedPage.sources, graphPackages: transport.page ? unifiedPage.sources.graphPackages
          : { state: "unavailable", observation: null, error: { source: "graph_packages", code: "snapshot_unavailable", message: "No saved package catalog." } } },
      });
    }
    return response;
  });
  return transport;
}

function accessEditorTransport() {
  const base = initialCatalogTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"] });
  base.page = packagePage;
  const transport = {
    session: base.session,
    accessAuthorized: true,
    exactStatus: "succeeded" as PackageRefreshJob["status"],
    exactMessage: undefined as string | undefined,
    exactResponse: undefined as (() => Promise<Response>) | undefined,
    exactCompleted: false,
    fetchMock: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
  };
  const exactJob = () => ({ ...completedRefreshJob(), id: "access-detail", scopeKind: "exact", requestedIds: [agent.id], status: transport.exactStatus, message: transport.exactMessage });
  transport.fetchMock.mockImplementation(async (input, init) => {
    if (input === "/api/agents/package-private/refresh-jobs") {
      if (transport.exactResponse) return transport.exactResponse();
      transport.exactCompleted = transport.exactStatus === "succeeded";
      return Response.json(exactJob());
    }
    if (input.startsWith("/api/agents/refresh-jobs/access-detail")) {
      transport.exactStatus = "succeeded";
      transport.exactCompleted = true;
      return Response.json(exactJob());
    }
    if (isPackageDetailRequest(input, agent.id)) return Response.json(transport.exactCompleted ? {
      ...agent, availableTo: "none", deployedTo: "some", allowedUsersAndGroups: [],
      acquireUsersAndGroups: [{ resourceType: "user", resourceId: "installed-user" }],
      observation: { observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), scopeKind: "exact" },
    } : agent);
    if (input === "/api/directory/principals/resolve") return Response.json({
      value: [{ resourceType: "user", resourceId: "installed-user", displayName: "Installed user", principalKind: "user" }],
    });
    if (input === "/api/agents/package-private/access" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      const accessUpdate = {
        target: body.target,
        mode: body.mode,
        scope: body.scope,
        principals: body.principals,
      };
      return Response.json({
        id: "access-update-job",
        action: accessUpdate.target === "availability" ? "update-availability" : "update-installation",
        accessUpdate,
        status: "succeeded",
        canResume: false,
        total: 1,
        completed: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
        inconclusive: 0, cancelled: 0, queued: 0, reconciliationRequired: 0, retryEligible: 0, resultRevision: "1",
        createdAt: "2026-09-15T08:00:00.000Z",
        updatedAt: "2026-09-15T08:00:00.000Z",
        completedAt: "2026-09-15T08:00:00.000Z",
      });
    }
    if (input === "/api/agents/mutation-preview") {
      const request = JSON.parse(String(init?.body)) as { action: "block" | "unblock" | "update-availability" | "update-installation" };
      return Response.json({
      confirmationHash: "a".repeat(64),
      summary: {
        risk: true, operation: request.action, provider: "Microsoft Graph", endpoint: "PATCH /beta/copilot/admin/catalog/packages/{id}",
        apiMaturity: "preview", permission: "Delegated CopilotPackages.ReadWrite.All", actor: { id: viewer.homeAccountId, displayName: "Admin", username: viewer.username },
        scope: "bulk", targetCount: 1, affectedPrincipalCount: 0, rollback: "Confirm a separate inverse change.", targetSelectionHash: "b".repeat(64),
        targets: [{ id: agent.id, displayName: agent.displayName, currentState: {}, requestedState: {} }], additionalTargetCount: 0,
      },
      });
    }
    const response = await base.fetchMock(input, init);
    if (input === "/api/capabilities" || input.startsWith("/api/capabilities/check")) {
      const body = await response.json();
      const definition = capabilityDefinitions.find(item => item.id === "graph.package.access.manage")!;
      const blockDefinition = capabilityDefinitions.find(item => item.id === "graph.package.block.manage")!;
      return Response.json({ value: [
        ...body.value,
        { definition, decision: { capabilityId: definition.id, status: transport.accessAuthorized ? "available" : "missing_permission", authorized: transport.accessAuthorized, fresh: true, verification: "on_demand", previewQualification: "not_required", remediation: [] } },
        { definition: blockDefinition, decision: { capabilityId: blockDefinition.id, status: "available", authorized: true, fresh: true, verification: "on_demand", previewQualification: "not_required", remediation: [] } },
        { definition: capabilityDefinitions.find(item => item.id === "graph.directory.read")!, decision: { ...body.value[0].decision, capabilityId: "graph.directory.read" } },
      ] });
    }
    return response;
  });
  return transport;
}
