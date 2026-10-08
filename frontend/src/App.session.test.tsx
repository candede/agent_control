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
  type AuditEvent,
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
  type WorkbenchJobSummary,
} from "./api/client";
import { restorePackageSelection, storePackageSelection } from "./packageSelectionSession";
import * as savedQueries from "./savedQueries";
import { AgentInventoryQueries } from "./agentInventoryQueries";
import { mockNativeDialogs } from "./test/dialog";
import { reportBundle, reportStage } from "./test/reportImportFixture";
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
  ...inventoryPageMetadata({ total: 1, scoped: 1, filtered: 1, packageTargets: 1 }, new Date(Date.now() + 600_000).toISOString(),
    { id: unifiedRevision, revision: unifiedRevision, evaluatedAt: new Date().toISOString() }),
  inventoryScope: "catalog",
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

  it.each([false, true])("requires unambiguous workbench metadata before automatic refresh (duplicate: %s)", async duplicate => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const action = workbenchActions.find(candidate => candidate.id === "data-sync.auto-refresh")!;
    transport.fetchMock.mockImplementation((input, init) => input === "/api/workbench/metadata"
      ? Promise.resolve(Response.json({ views: workbenchViews, actions: duplicate
        ? [...workbenchActions, { ...action, roles: ["AgentControl.Admin"] }]
        : workbenchActions }))
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await act(async () => {});
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-sync/auto-refresh")).toHaveLength(duplicate ? 0 : 1);
  });

  it("does not claim workbench action metadata is still loading after a failed read", async () => {
    const transport = appTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"] });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => input === "/api/workbench/metadata"
      ? Promise.resolve(Response.json({ code: "metadata_unavailable", detail: "Workbench metadata could not be loaded." }, { status: 503 }))
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText(/Workbench metadata could not be loaded/)).toBeVisible();
    const button = await screen.findByRole("button", { name: `Manage access for ${agent.displayName}` });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/Action metadata is unavailable/);
    expect(button).not.toHaveAccessibleDescription(/finishes loading/);
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/workbench/metadata")).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-sync/auto-refresh")).toHaveLength(0);
  });

  it.each(["same", "replacement"] as const)("retires pending workbench metadata before accepting the %s account session", async account => {
    const roles: SessionUser["roles"] = ["AgentControl.Admin"];
    const transport = appTransport({ initialRoles: roles, revalidatedRoles: roles,
      revalidatedUser: account === "same" ? viewer : { ...viewer, homeAccountId: "replacement-account" } });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let metadataReads = 0;
    let retiredSignal: AbortSignal | null | undefined;
    transport.fetchMock.mockImplementation((input, init) => {
      if (input !== "/api/workbench/metadata") return base(input, init);
      if (++metadataReads === 1) {
        retiredSignal = init?.signal;
        return pending.promise;
      }
      return Promise.resolve(Response.json({ views: workbenchViews, actions: [] }));
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("button", { name: `Manage access for ${agent.displayName}` })).toBeDisabled();
    await revalidateTransportSession(transport);
    await waitFor(() => expect(metadataReads).toBe(2));
    expect(retiredSignal?.aborted).toBe(true);
    const button = await screen.findByRole("button", { name: `Manage access for ${agent.displayName}` });
    expect(button).toHaveAccessibleDescription(/not defined by the current signed-in workbench metadata/);
    await act(async () => pending.resolve(Response.json({ views: workbenchViews, actions: workbenchActions })));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/not defined by the current signed-in workbench metadata/);
    expect(metadataReads).toBe(2);
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-sync/auto-refresh")).toHaveLength(0);
  });

  it("reuses recent Users, Agents, report summaries and selector reads across navigation", async () => {
    unifiedPage.usageContext.reports = selectedAgentsPage().reports;
    const roles: SessionUser["roles"] = ["AgentControl.Admin"];
    const transport = appTransport({ initialRoles: roles, revalidatedRoles: roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Report set" })).toBeEnabled());
    await waitFor(() => expect(screen.queryByText("Loading selected report evidence...")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Users" }));
    await screen.findByRole("button", { name: "Ada" });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Report set" })).toBeEnabled());
    const paths = ["/api/agent-inventory/selections", "/api/agent-inventory", "/api/copilot-usage/users",
      "/api/official-usage/overview", "/api/official-usage/history/options"];
    const reads = () => transport.fetchMock.mock.calls.filter(([input]) => paths.includes(new URL(input, "http://localhost").pathname)).length;
    const before = reads();
    for (let index = 0; index < 3; index++) {
      fireEvent.click(screen.getByRole("button", { name: "Agents" }));
      expect(screen.getByText(agent.displayName)).toBeVisible();
      expect(screen.getByRole("combobox", { name: "Report set" })).toBeEnabled();
      expect(screen.queryByText("Loading selected report evidence...")).not.toBeInTheDocument();
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Users" }));
      expect(screen.getByRole("button", { name: "Ada" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Active M365 Copilot licensed users" }).querySelector("strong")).toHaveTextContent("4");
      expect(screen.getByRole("combobox", { name: "Report set" })).toBeEnabled();
      await act(async () => {});
    }
    expect(reads()).toBe(before);
  });

  it("preserves licensed-user search and report filters across navigation without recapturing evidence", async () => {
    const reportId = selectedUsersPage().reports.setId!;
    window.history.replaceState({}, "", `/users?snapshot=${reportId}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("button", { name: "Ada" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search users or agents" }), { target: { value: "Ada" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Export users CSV" })).toBeEnabled());
    const reads = () => transport.fetchMock.mock.calls.filter(([input]) =>
      new URL(input, "http://localhost").pathname === "/api/copilot-usage/users").length;
    const before = reads();
    const search = new URLSearchParams(window.location.search);
    expect(search.get("q")).toBe("Ada");
    expect(search.get("snapshot")).toBe(reportId);
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("button", { name: "Users" }));
    expect(await screen.findByRole("searchbox", { name: "Search users or agents" })).toHaveValue("Ada");
    await screen.findByRole("button", { name: "Ada" });
    expect(new URLSearchParams(window.location.search).get("snapshot")).toBe(reportId);
    expect(reads()).toBe(before);
  });

  it.each(["licenses", "activity"] as const)("canonicalizes legacy %s numeric pages without restarting cursor-owned Users reads", async view => {
    window.history.replaceState({}, "", `/users?view=${view}&q=Ada&page=3`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const label = view === "licenses" ? "Search users or agents" : "Search reported users or agents";
    expect(await screen.findByRole("searchbox", { name: label })).toHaveValue("Ada");
    const reads = () => transport.fetchMock.mock.calls.filter(([input]) =>
      new URL(input, "http://localhost").pathname === (view === "licenses" ? "/api/copilot-usage/users" : "/api/official-usage/users")).length;
    expect(reads()).toBe(1);
    expect(new URLSearchParams(window.location.search).has("page")).toBe(false);
    act(() => {
      window.history.pushState({}, "", `/users?view=${view}&page=4&q=Ada`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {});
    expect(screen.getByRole("searchbox", { name: label })).toHaveValue("Ada");
    expect(new URLSearchParams(window.location.search).has("page")).toBe(false);
    expect(reads()).toBe(1);
  });

  it("invalidates saved views once for a verified CSV import, not again when acknowledging it", async () => {
    const roles: SessionUser["roles"] = ["AgentControl.Admin"];
    const transport = appTransport({ initialRoles: roles, revalidatedRoles: roles });
    const original = transport.fetchMock.getMockImplementation()!;
    const stages: ReturnType<typeof reportStage>[] = [];
    let reviewed: ReturnType<typeof reportBundle> | undefined;
    const reports = selectedAgentsPage().reports;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/official-usage/staging" && init?.method === "POST") {
        if (!(init.body instanceof FormData)) throw new Error("Expected a streamed upload");
        const file = init.body.get("file");
        if (!(file instanceof File)) throw new Error("Expected a CSV file");
        const kind = file.name === "agents.csv" ? "agents" : file.name === "user-agents.csv" ? "userAgents" : "users";
        const stage = reportStage(kind, url.searchParams.get("bundleId")!);
        stages.push(stage);
        return Response.json(stage);
      }
      if (/^\/api\/official-usage\/bundles\/[^/]+\/preview$/.test(url.pathname)) {
        reviewed = reportBundle(stages, url.pathname.split("/")[4]);
        return Response.json(reviewed);
      }
      if (/^\/api\/official-usage\/bundles\/[^/]+\/accept$/.test(url.pathname)) {
        expect(reviewed?.complete).toBe(true);
        expect(url.pathname.split("/")[4]).toBe(reviewed?.bundleId);
        expect(JSON.parse(String(init?.body))).toEqual({
          bundleHash: reviewed?.bundleHash, expectedActiveRevision: reviewed?.expectedActiveRevision,
        });
        expect(stages.every(stage => stage.status === "active")).toBe(true);
        stages.forEach((stage, index) => { stages[index] = { ...stage, status: "accepted" }; });
        return Response.json({ setId: reports.setId, activeRevision: reports.activeRevision, complete: true });
      }
      return original(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Add CSV reports" }));
    await userEvent.upload(screen.getByLabelText("CSV report files"), ["agents.csv", "user-agents.csv", "users.csv"].map(
      name => new File(["synthetic CSV"], name, { type: "text/csv" }),
    ));
    const stateReads = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-sync/state").length;
    const before = stateReads();
    await userEvent.click(await screen.findByRole("button", { name: "Import reports" }));
    await screen.findByRole("heading", { name: "Reports imported" });
    await waitFor(() => expect(stateReads()).toBe(before + 1));
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    await screen.findByText(agent.displayName);
    expect(window.location.pathname).toBe("/agents");
    expect(stateReads()).toBe(before + 1);
    expect(transport.fetchMock.mock.calls.filter(([input]) => /\/bundles\/[^/]+\/accept$/.test(input))).toHaveLength(1);
  });

  it.each(["different report", "same report", "no report", "failed inventory"] as const)(
    "waits for replacement inventory before refreshing its selected report overview (%s)", async outcome => {
    unifiedPage.usageContext.reports = selectedAgentsPage().reports;
    const roles: SessionUser["roles"] = ["AgentControl.Admin"];
    const transport = appTransport({ initialRoles: roles, revalidatedRoles: roles });
    const original = transport.fetchMock.getMockImplementation()!, pending = deferredResponse();
    const nextSet = outcome === "different report" ? "10000000-0000-4000-8000-000000000099"
      : outcome === "same report" ? unifiedPage.usageContext.reports.setId : null;
    const history = selectedHistoryPage();
    const alternate = { ...history.value[0], id: "10000000-0000-4000-8000-000000000099", active: false };
    let optionsAvailable = false, reloading = false, nextInventory: UnifiedAgentInventoryPage | undefined;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/official-usage/history/options") {
        return optionsAvailable ? Response.json(selectedHistoryPage([...history.value, alternate]))
          : Response.json({ code: "service_unavailable", detail: "Report options unavailable" }, { status: 503 });
      }
      if (url.pathname === `/api/official-usage/sets/${alternate.id}/preview`) {
        return Response.json({ code: "selection_invalidated", detail: "Report selection changed" }, { status: 409 });
      }
      const response = await original(input, init);
      if (url.pathname === "/api/agent-inventory" && reloading) {
        const data = await response.json() as UnifiedAgentInventoryPage;
        nextInventory = { ...data, usageContext: { ...data.usageContext,
          reports: { ...data.usageContext.reports, setId: nextSet, activeSetId: nextSet,
            availability: nextSet ? "active" : "not_selected" } } };
        return pending.promise;
      }
      return response;
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const summary = within(screen.getByRole("region", { name: "Agent inventory overview" }));
    await waitFor(() => expect(summary.getByRole("button", { name: "Show reported used agents" })).toBeEnabled());
    const overviewReads = () => transport.fetchMock.mock.calls.filter(([input]) =>
      new URL(input, "http://localhost").pathname === "/api/official-usage/overview");
    expect(overviewReads()).toHaveLength(1);
    const inventoryReads = () => transport.fetchMock.mock.calls.filter(([input]) =>
      new URL(input, "http://localhost").pathname === "/api/agent-inventory").length;
    const beforeRetry = inventoryReads();
    const selector = within(screen.getByRole("region", { name: "Report set selection" }));
    optionsAvailable = true;
    fireEvent.click(selector.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(selector.getByRole("combobox")).toBeEnabled());
    expect(inventoryReads()).toBe(beforeRetry);
    expect(overviewReads()).toHaveLength(1);
    await userEvent.selectOptions(selector.getByRole("combobox"), alternate.id);
    await selector.findByRole("alert");
    reloading = true;
    fireEvent.click(selector.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(nextInventory).toBeDefined());
    expect(overviewReads()).toHaveLength(1);
    expect(summary.getByRole("button", { name: "Show reported used agents" })).toBeDisabled();
    expect(summary.getByRole("button", { name: "Show reported used agents" })).toHaveTextContent("Waiting for saved inventory");
    expect(summary.queryByText("Loading selected report evidence...")).not.toBeInTheDocument();
    await act(async () => pending.resolve(outcome === "failed inventory"
      ? Response.json({ code: "service_unavailable", detail: "Replacement inventory unavailable" }, { status: 503 })
      : Response.json(nextInventory)));
    await waitFor(() => expect(summary.queryByText("Waiting for saved inventory before reading report evidence...")).not.toBeInTheDocument());
    if (nextSet) {
      await waitFor(() => expect(overviewReads()).toHaveLength(2));
      expect(new URL(overviewReads()[1][0], "http://localhost").searchParams.get("setId")).toBe(nextSet);
      await waitFor(() => expect(summary.getByRole("button", { name: "Show reported used agents" })).toBeEnabled());
    } else {
      expect(overviewReads()).toHaveLength(1);
      expect(summary.getByRole("button", { name: "Show reported used agents" })).toBeDisabled();
      expect(summary.getByRole("button", { name: "Show reported used agents" })).toHaveTextContent(
        outcome === "failed inventory" ? "Report context unavailable" : "No selected report data");
      expect(summary.queryByRole("alert")).not.toBeInTheDocument();
    }
  });

  it("restores recent catalog and additional Power Platform rows synchronously without new captures", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Additional native agent");
    const transport = appTransport({ revalidatedRoles: viewer.roles,
      unifiedResponse: unifiedRecordsPage([unifiedPage.value[0], native]), inventoryReadAuthorized: true });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("button", { name: "Additional Power Platform agents" }));
    await screen.findByText(native.displayName);
    const reads = () => transport.fetchMock.mock.calls.filter(([input]) =>
      ["/api/agent-inventory", "/api/agent-inventory/selections"].includes(new URL(input, "http://localhost").pathname)).length;
    const before = reads();
    for (let index = 0; index < 3; index++) {
      fireEvent.click(screen.getByRole("button", { name: "Microsoft 365 catalog" }));
      expect(screen.getByText(agent.displayName)).toBeVisible();
      expect(screen.queryByText(native.displayName)).not.toBeInTheDocument();
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Additional Power Platform agents" }));
      expect(screen.getByText(native.displayName)).toBeVisible();
      expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
      await act(async () => {});
    }
    expect(reads()).toBe(before);
  });

  it("does not refetch Power Platform job history for inventory filter and sort changes", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await waitFor(() => expect(screen.queryByRole("status", { name: "Updating agent results" })).not.toBeInTheDocument());
    const historyReads = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/inventory/refresh-jobs").length;
    const before = historyReads();
    for (const query of ["Sensitive", "cached", ""]) {
      fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: query } });
      await waitFor(() => expect(screen.queryByRole("status", { name: "Updating agent results" })).not.toBeInTheDocument());
    }
    await userEvent.click(screen.getByRole("button", { name: "Sort by Agent" }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Updating agent results" })).not.toBeInTheDocument());
    expect(historyReads()).toBe(before);
  });

  it.each([
    { field: "type", code: "selection_invalidated", status: 409 },
    { field: "environmentId", code: "selection_invalidated", status: 409 },
    { field: "environmentId", code: "read_busy", status: 503 },
  ])("does not let an old $field facet $code disrupt a replacement sort selection", async ({ field, code, status }) => {
    if (field === "environmentId") {
      window.history.replaceState({}, "", `/agents?environment=${encodeURIComponent(encodeInventoryFacet("env-a"))}`);
      unifiedPage.value[0].environmentId = "env-a";
    }
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const facet = deferredResponse(), replacement = deferredResponse();
    let previousSelection: string | null = null;
    let replacing = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/agent-inventory/facets" && url.searchParams.get("field") === field && !replacing) {
        previousSelection = url.searchParams.get("selectionId");
        return facet.promise;
      }
      if (url.pathname === "/api/agent-inventory" && replacing) return replacement.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await waitFor(() => expect(previousSelection).not.toBeNull());
    replacing = true;
    await userEvent.click(screen.getByRole("button", { name: "Sort by Agent" }));
    const inventoryReads = () => transport.fetchMock.mock.calls.filter(([input]) =>
      new URL(input, "http://localhost").pathname === "/api/agent-inventory");
    await waitFor(() => expect(inventoryReads()).toHaveLength(2));
    const [input, init] = inventoryReads()[1];
    expect(new URL(input, "http://localhost").searchParams.get("selectionId")).not.toBe(previousSelection);
    await act(async () => facet.resolve(Response.json({
      code, detail: "The previous selection's facet read failed.",
    }, { status })));
    expect(init?.signal?.aborted).toBe(false);
    expect(screen.getByRole("status", { name: "Updating agent results" })).toBeVisible();
    if (field === "environmentId") {
      expect(screen.queryByText("The previous selection's facet read failed.")).not.toBeInTheDocument();
    }
    await act(async () => replacement.resolve(await base(input, init)));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Updating agent results" })).not.toBeInTheDocument());
    expect(screen.getByText(agent.displayName)).toBeVisible();
    expect(screen.queryByText("The saved inventory selection is no longer available. Reload saved inventory.")).not.toBeInTheDocument();
    expect(screen.queryByText("The previous selection's facet read failed.")).not.toBeInTheDocument();
    expect(inventoryReads()).toHaveLength(2);
  });

  it("withdraws the current inventory when its facet read is invalidated", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const facet = deferredResponse();
    transport.fetchMock.mockImplementation(async (input, init) =>
      new URL(input, "http://localhost").pathname === "/api/agent-inventory/facets" ? facet.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await act(async () => facet.resolve(Response.json({
      code: "selection_invalidated", detail: "Selection expired.",
    }, { status: 409 })));
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent inventory unavailable" })).toBeVisible();
    expect(screen.getByRole("status", { name: "Matching agents" })).toHaveTextContent("Unavailable");
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
  });

  it.each(["detail:channels", "detail:connectors", "connectorOperation", "versions"])(
    "withdraws the overview and sibling reads when %s invalidates its inventory selection", async kind => {
      const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Selected native agent");
      native.packages = [agent];
      native.presence = "both";
      native.packagesComplete = false;
      native.packageCount = 2;
      native.powerPlatformResource = { ...native.powerPlatformResource!,
        savedSource: { scopeId: "11111111-1111-4111-8111-111111111111", identity: "native-source" },
        connectorCounts: { connectors: 1, operations: 1 } };
      const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([native]) });
      const base = transport.fetchMock.getMockImplementation()!;
      const rejected = deferredResponse(), operations = deferredResponse(), versions = deferredResponse();
      transport.fetchMock.mockImplementation(async (input, init) => {
        const url = new URL(input, "http://localhost");
        if (url.pathname.endsWith("/members")) return kind === "versions" ? rejected.promise : versions.promise;
        if (url.pathname.endsWith("/children")) {
          const section = url.searchParams.get("kind");
          if (section === kind) return rejected.promise;
          if (section === "connectorOperation") return operations.promise;
          return Response.json({ value: [{ ordinal: 0, kind: section, value: section === "detail:channels" ? "Teams" : "0",
            payload: section === "detail:connectors" ? { connectorId: "Saved connector", operations: [] } : {} }], total: 1, nextCursor: null });
        }
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("button", { name: "View details for Selected native agent" }));
      await screen.findByRole("dialog", { name: native.displayName });
      const childCalls = () => transport.fetchMock.mock.calls.filter(([input]) => {
        const url = new URL(input, "http://localhost");
        return url.pathname.endsWith("/members") || url.pathname.endsWith("/children");
      });
      await waitFor(() => expect(childCalls().some(([input]) => {
        const url = new URL(input, "http://localhost");
        return kind === "versions" ? url.pathname.endsWith("/members") : url.searchParams.get("kind") === kind;
      })).toBe(true));
      await act(async () => rejected.resolve(Response.json({ code: "selection_invalidated", detail: "Selected inventory expired." }, { status: 409 })));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: native.displayName })).not.toBeInTheDocument());
      expect(screen.queryByText(native.displayName)).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Agent inventory unavailable" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
      for (const [input, init] of childCalls()) {
        const url = new URL(input, "http://localhost");
        if (kind !== "versions" && url.pathname.endsWith("/members")
          || kind !== "connectorOperation" && url.searchParams.get("kind") === "connectorOperation") expect(init?.signal?.aborted).toBe(true);
      }
      await act(async () => {
        operations.resolve(Response.json({ value: [{ ordinal: 1, kind: "connectorOperation", value: "0",
          payload: { operationId: "Obsolete operation" } }], total: 1, nextCursor: null }));
        versions.resolve(Response.json({ value: [], total: 0, nextCursor: null }));
      });
      expect(screen.queryByText("Obsolete operation")).not.toBeInTheDocument();
      expect(transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === "/api/agent-inventory")).toHaveLength(1);
    });

  it("ignores late overview invalidation after a replacement inventory selection loads", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Selected native agent");
    native.packages = [agent];
    native.presence = "both";
    native.powerPlatformResource = { ...native.powerPlatformResource!,
      savedSource: { scopeId: "11111111-1111-4111-8111-111111111111", identity: "native-source" },
      connectorCounts: { connectors: 0, operations: 0 } };
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([native]) });
    const base = transport.fetchMock.getMockImplementation()!;
    const previous = deferredResponse();
    let channelReads = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname.endsWith("/children")) {
        if (url.searchParams.get("kind") === "detail:channels") {
          if (++channelReads === 1) return previous.promise;
          return Response.json({ value: [{ ordinal: 0, kind: "detail:channels", value: "Replacement channel", payload: {} }],
            total: 1, nextCursor: null });
        }
        return Response.json({ value: [], total: 0, nextCursor: null });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View details for Selected native agent" }));
    await waitFor(() => expect(channelReads).toBe(1));
    const previousSignal = transport.fetchMock.mock.calls.find(([input]) => {
      const url = new URL(input, "http://localhost");
      return url.pathname.endsWith("/children") && url.searchParams.get("kind") === "detail:channels";
    })?.[1]?.signal;
    const selection = currentInventorySelection(transport.fetchMock);
    await userEvent.click(within(screen.getByRole("dialog", { name: native.displayName })).getByRole("button", { name: "Reload saved inventory" }));
    expect(await screen.findByText("Replacement channel")).toBeVisible();
    expect(currentInventorySelection(transport.fetchMock)).not.toBe(selection);
    expect(previousSignal?.aborted).toBe(true);
    await act(async () => previous.resolve(Response.json({ code: "selection_invalidated", detail: "Previous inventory expired." }, { status: 409 })));
    expect(screen.getByRole("dialog", { name: native.displayName })).toBeVisible();
    expect(screen.getByText("Replacement channel")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Agent inventory unavailable" })).not.toBeInTheDocument();
    expect(channelReads).toBe(2);
  });

  it.each([
    { route: "/agents", view: "agents", path: "/api/agent-inventory" },
    { route: "/users", view: "users", path: "/api/copilot-usage/users" },
    { route: "/users?view=activity", view: "users", path: "/api/official-usage/users" },
    { route: "/audit", view: "audit", path: "/api/audit/events" },
  ])("keeps the $view skeleton from unknown setup through the first data read at $route", async ({ route, view, path }) => {
    window.history.replaceState({}, "", route);
    const roles: SessionUser["roles"] = ["AgentControl.Admin"];
    const transport = appTransport({ initialRoles: roles, revalidatedRoles: roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const status = deferredResponse(), data = deferredResponse();
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/state") return status.promise;
      if (new URL(input, "http://localhost").pathname === path) return data.promise;
      return base(input, init);
    });
    const pageReads = () => transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === path);
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<StrictMode><App /></StrictMode>);

    expect(await screen.findByRole("region", { name: `Loading ${view}` })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("navigation", { name: "Primary views" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(screen.queryByText("Setup needed")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(pageReads()).toHaveLength(0);

    await act(async () => status.resolve(await base("/api/data-sync/state")));
    await waitFor(() => expect(pageReads().length).toBeGreaterThan(0));
    expect(screen.getByRole("region", { name: `Loading ${view}` })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Setup needed")).not.toBeInTheDocument();

    const [input, init] = pageReads()[0];
    await act(async () => data.resolve(path === "/api/audit/events" ? Response.json({ value: [], count: 0 }) : await base(input, init)));
    await waitFor(() => expect(screen.queryByRole("region", { name: `Loading ${view}` })).not.toBeInTheDocument());
    if (view === "agents") expect(await screen.findByText("Sensitive cached agent")).toBeVisible();
    else if (view === "users") expect(screen.getByRole("region", { name: "Users and adoption" })).toBeVisible();
    else expect(screen.getByRole("heading", { name: "No audit events" })).toBeVisible();
    expect(showModal).not.toHaveBeenCalled();
  });

  it.each(["capture", "page"] as const)("ends the initial agent skeleton after transport cancellation during %s and offers saved-only retry", async phase => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse(), retry = deferredResponse();
    const path = phase === "capture" ? "/api/agent-inventory/selections" : "/api/agent-inventory";
    let retrying = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname !== path) return base(input, init);
      if (retrying) {
        await retry.promise;
        return base(input, init);
      }
      await pending.promise;
      throw new DOMException("The saved inventory transport was cancelled.", "AbortError");
    });
    const reads = () => transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === path);
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(reads()).toHaveLength(1));
    expect(screen.getByRole("region", { name: "Loading agents" })).toHaveAttribute("aria-busy", "true");
    expect(reads()[0][1]?.signal?.aborted).toBe(false);
    await act(async () => pending.resolve(new Response()));

    await waitFor(() => expect(screen.queryByRole("region", { name: "Loading agents" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Agent inventory unavailable" })).toBeVisible();
    expect(screen.getByText("The request was cancelled.")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("The current saved agent inventory could not be loaded.");
    expect(screen.queryByRole("heading", { name: /No agents in this inventory|No matching agents/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    expect(reads()).toHaveLength(1);
    expect(reads()[0][1]?.signal?.aborted).toBe(false);

    retrying = true;
    await userEvent.click(screen.getByRole("button", { name: "Reload saved agent inventory" }));
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(screen.queryByRole("region", { name: "Loading agents" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Updating agent results" })).toBeVisible();
    await act(async () => retry.resolve(new Response()));
    expect(await screen.findByText(agent.displayName)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
    expect(reads()).toHaveLength(2);
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("reports a cancelled replacement agent read without presenting retained rows as current or restarting it automatically", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let cancelling = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (cancelling && new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        await pending.promise;
        throw new DOMException("The replacement transport was cancelled.", "AbortError");
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const before = agentListRequests(transport.fetchMock).length;
    cancelling = true;
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: agent.displayName } });
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(before + 1));
    expect(screen.queryByRole("region", { name: "Loading agents" })).not.toBeInTheDocument();
    expect(screen.getByText(agent.displayName)).toBeVisible();
    expect(screen.getByRole("status", { name: "Updating agent results" })).toBeVisible();
    await act(async () => pending.resolve(new Response()));

    expect(await screen.findByText("The request was cancelled.")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("The current saved agent inventory could not be loaded.");
    expect(screen.queryByRole("status", { name: "Updating agent results" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Loading agents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Agent inventory pages" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    expect(agentListRequests(transport.fetchMock)).toHaveLength(before + 1);
    cancelling = false;
    await userEvent.click(screen.getByRole("button", { name: "Reload saved agent inventory" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(agentListRequests(transport.fetchMock)).toHaveLength(before + 2);
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it.each(["success", "failure"] as const)("silences an abandoned initial agent %s while the returning view is still loading", async outcome => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const previous = deferredResponse(), replacement = deferredResponse();
    let reads = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname !== "/api/agent-inventory") return base(input, init);
      if (++reads === 1) {
        await previous.promise;
        if (outcome === "failure") throw new Error("Abandoned transport failure.");
      } else await replacement.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(reads).toBe(1));
    const previousSignal = agentListRequests(transport.fetchMock)[0][1]?.signal;
    await userEvent.click(screen.getByRole("button", { name: "Users" }));
    await screen.findByRole("button", { name: "Ada" });
    expect(previousSignal?.aborted).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => previous.resolve(new Response()));
    expect(screen.getByRole("region", { name: "Loading agents" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(screen.queryByText("The request was cancelled.")).not.toBeInTheDocument();
    expect(screen.queryByText("Abandoned transport failure.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(reads).toBe(2);
    await act(async () => replacement.resolve(new Response()));
    expect(await screen.findByText(agent.displayName)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Loading agents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(reads).toBe(2);
  });

  it.each([
    { boundary: "same-account revalidation", user: viewer, roles: viewer.roles },
    { boundary: "account replacement", user: { ...viewer, tenantId: "tenant-2", homeAccountId: "viewer-2" }, roles: viewer.roles },
    { boundary: "role removal", user: viewer, roles: [] as SessionUser["roles"] },
  ])("retires local audit reads, details and exports on $boundary", async ({ user, roles }) => {
    window.history.replaceState({}, "", "/audit");
    const transport = appTransport({ revalidatedRoles: roles, revalidatedUser: user });
    const base = transport.fetchMock.getMockImplementation()!;
    const pendingExport = deferredResponse(), pendingRead = deferredResponse();
    const previousEvent: AuditEvent = {
      id: "previous-audit-event", operationId: "previous-operation", action: "associate-agent-usage",
      scope: "single", agentId: "previous-private-audit-agent", actor: { ...viewer, displayName: "Previous audit actor" },
      startedAt: "2026-09-17T00:00:00.000Z", status: "succeeded", requestPath: "/fixture",
      message: "Previous private audit details",
    };
    const currentEvent: AuditEvent = {
      ...previousEvent, id: "current-audit-event", agentId: "current-audit-agent",
      actor: { ...user, displayName: "Current audit actor" }, message: "Current audit details",
    };
    let replaced = false, auditReads = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(input, "http://localhost").pathname;
      if (path === "/api/audit/events") {
        auditReads += 1;
        if (!replaced && auditReads > 1) return pendingRead.promise;
        return Response.json({ count: 1, value: [replaced ? currentEvent : previousEvent] });
      }
      if (path === "/api/audit/events/export.csv") return pendingExport.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<App />);
    await screen.findByText("Previous audit actor");
    const exportButton = screen.getByRole("button", { name: "Export current audit page CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await userEvent.click(exportButton);
    await userEvent.click(screen.getByRole("button", { name: /View event details: Previous/ }));
    expect(screen.getByRole("dialog", { name: "Event details" })).toHaveTextContent("Previous private audit details");
    const exportSignal = transport.fetchMock.mock.calls.find(([input]) => input === "/api/audit/events/export.csv")?.[1]?.signal;
    expect(exportSignal?.aborted).toBe(false);

    replaced = true;
    await revalidateTransportSession(transport);
    expect(screen.queryByRole("dialog", { name: "Event details" })).not.toBeInTheDocument();
    expect(screen.queryByText("Previous audit actor")).not.toBeInTheDocument();
    expect(exportSignal?.aborted).toBe(true);
    if (roles.length) expect(await screen.findByText("Current audit actor")).toBeVisible();
    else expect(screen.queryByRole("button", { name: "Export current audit page CSV" })).not.toBeInTheDocument();
    const sessionReads = transport.meCalls();
    await act(async () => pendingExport.resolve(new Response("obsolete,audit,csv")));
    expect(download).not.toHaveBeenCalled();
    expect(transport.meCalls()).toBe(sessionReads);
    expect(auditReads).toBe(roles.length ? 2 : 1);

    if (roles.length) {
      // Exercise the same boundary with an unfinished saved read, not just an export.
      replaced = false;
      await userEvent.click(screen.getByRole("button", { name: "Refresh audit log" }));
      await waitFor(() => expect(auditReads).toBe(3));
      const readSignal = transport.fetchMock.mock.calls.filter(([input]) =>
        new URL(input, "http://localhost").pathname === "/api/audit/events").at(-1)?.[1]?.signal;
      replaced = true;
      await revalidateTransportSession(transport);
      expect(await screen.findByText("Current audit actor")).toBeVisible();
      expect(readSignal?.aborted).toBe(true);
      await act(async () => pendingRead.resolve(Response.json({ count: 1, value: [previousEvent] })));
      expect(screen.queryByText("Previous audit actor")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Event details" })).not.toBeInTheDocument();
      expect(auditReads).toBe(4);
    }
  });

  it("replaces unknown setup with an inline status error and retries without opening onboarding", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    let failing = true;
    transport.fetchMock.mockImplementation(async (input, init) => input === "/api/data-sync/state" && failing
      ? Response.json({ code: "unavailable", detail: "Workspace status could not be read." }, { status: 503 })
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Workspace status is unavailable" })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Loading agents" })).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Workspace status could not be read.");
    expect(agentListRequests(transport.fetchMock)).toHaveLength(0);
    expect(screen.queryByText("Setup needed")).not.toBeInTheDocument();
    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry status check" }));
    expect(await screen.findByText("Sensitive cached agent")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(showModal).not.toHaveBeenCalled();
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

  it.each(["not_collected", "preparing"] as const)("shows %s inventory in Sync health and diagnostics until publication", async state => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/sync");
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: verifiedSavedAgentPage() });
    const base = transport.fetchMock.getMockImplementation()!;
    let ready = false;
    const message = "Waiting for the first inventory publication.";
    transport.fetchMock.mockImplementation((input, init) => input === "/api/agent-inventory/selections" && !ready
      ? Promise.resolve(Response.json({ state, message })) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const health = screen.getByRole("region", { name: "Inventory health" });
    expect(within(health).getByText(state === "preparing" ? "Preparing" : "Not collected")).toBeVisible();
    expect(within(health).getByRole("status")).toHaveTextContent(message);
    fireEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    const receipt = within(screen.getByRole("region", { name: "Saved agent inventory verification" }));
    expect(receipt.getByRole("status")).toHaveTextContent(message);
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh matching details" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export PP agent inventory CSV" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    ready = true;
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(receipt.getByText("Saved inventory verified")).toBeVisible();
    expect(within(health).getByText("Verified")).toBeVisible();
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([input, init]) => init?.method === "POST"
      && ["/api/agents/refresh-jobs", "/api/inventory/refresh-jobs"].includes(input))).toHaveLength(0);
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

  it("does not reload saved inventory when delayed permission evidence changes but publications do not", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
    const base = transport.fetchMock.getMockImplementation()!;
    const permissions = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) => input === "/api/capabilities" ? permissions.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const checks = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-sync/auto-refresh").length;
    await waitFor(() => expect(checks()).toBe(1));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Updating agent results" })).not.toBeInTheDocument());
    const reads = agentListRequests(transport.fetchMock).length;
    const captures = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections").length;
    const selections = captures();
    await act(async () => permissions.resolve(await base("/api/capabilities")));
    await waitFor(() => expect(screen.getByRole("button", { name: "Permissions" })).toHaveAttribute("aria-busy", "false"));
    await waitFor(() => expect(checks()).toBe(2));
    expect(agentListRequests(transport.fetchMock)).toHaveLength(reads);
    expect(captures()).toBe(selections);
    expect(screen.getByText(agent.displayName)).toBeVisible();
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

  it.each(["pending", "failed"] as const)(
    "preserves a %s detail read when a saved inventory reload fails", async state => {
      vi.useFakeTimers();
      const transport = initialCatalogTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const inventoryRecovery = deferredResponse();
      let failInventory = false;
      let recovering = false;
      transport.fetchMock.mockImplementation((input, init) => {
        if (recovering && new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
          return inventoryRecovery.promise;
        }
        if (failInventory && new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
          return Promise.resolve(Response.json({
            code: "inventory_unavailable", detail: "Saved inventory could not be read.",
          }, { status: 503 }));
        }
        if (isPackageDetailRequest(input, agent.id)) return recovering
          ? Promise.resolve(Response.json({ ...agent, longDescription: "Recovered selection details" }))
          : state === "pending" ? pending.promise
          : Promise.resolve(Response.json({
            code: "saved_details_unavailable", detail: "Saved details require an explicit retry.",
          }, { status: 500 }));
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByRole("button", { name: `View details for ${agent.displayName}` }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      const reads = () => transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, agent.id));
      expect(reads()).toHaveLength(1);
      const signal = reads()[0][1]?.signal;
      failInventory = true;
      fireEvent.click(screen.getByRole("button", { name: "Reload saved inventory" }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      const dialog = screen.getByRole("dialog", { name: agent.displayName });
      expect(within(dialog).getAllByRole("alert").map(alert => alert.textContent)).toContainEqual(
        expect.stringContaining("Saved inventory could not be read."),
      );
      expect(reads()).toHaveLength(1);
      expect(signal?.aborted).toBe(false);
      if (state === "pending") {
        await act(async () => pending.resolve(Response.json({ ...agent, longDescription: "Original selected detail" })));
        expect(within(dialog).getByText("Original selected detail")).toBeVisible();
        expect(within(dialog).queryByText("Loading saved agent details...")).not.toBeInTheDocument();
      } else {
        expect(within(dialog).getByText("Saved details require an explicit retry.")).toBeVisible();
        const retryDetails = within(dialog).getByRole("button", { name: "Retry saved details" });
        expect(retryDetails).toBeDisabled();
        expect(within(dialog).queryByText("Loading saved agent details...")).not.toBeInTheDocument();
        fireEvent.click(retryDetails);
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(reads()).toHaveLength(1);
      }
      const inventoryReads = agentListRequests(transport.fetchMock).length;
      recovering = true;
      failInventory = false;
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry saved inventory" }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(agentListRequests(transport.fetchMock)).toHaveLength(inventoryReads + 1);
      expect(reads()).toHaveLength(1);
      expect(within(dialog).queryByText("Loading saved agent details...")).not.toBeInTheDocument();
      if (state === "failed") expect(within(dialog).getByRole("button", { name: "Retry saved details" })).toBeDisabled();
      await act(async () => inventoryRecovery.resolve(Response.json(selectedInventoryPage(
        agentListRequests(transport.fetchMock).at(-1)![0], unifiedPage,
      ))));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(reads()).toHaveLength(2);
      expect(reads()[1][0]).not.toBe(reads()[0][0]);
      expect(new URL(reads()[1][0], "http://localhost").searchParams.get("selectionId"))
        .toBe(currentInventorySelection(transport.fetchMock));
      expect(within(dialog).getByText("Recovered selection details")).toBeVisible();
      expect(within(dialog).queryByText("Original selected detail")).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
      expect(within(dialog).queryByText("Loading saved agent details...")).not.toBeInTheDocument();
      expect(agentListRequests(transport.fetchMock)).toHaveLength(inventoryReads + 1);
      expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    },
  );

  it.each(["success", "failure"] as const)(
    "replaces a pending detail read after inventory reload and ignores its late %s", async outcome => {
      vi.useFakeTimers();
      const transport = initialCatalogTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      let reads = 0;
      transport.fetchMock.mockImplementation((input, init) => {
        if (isPackageDetailRequest(input, agent.id)) return ++reads === 1 ? pending.promise
          : Promise.resolve(Response.json({ ...agent, longDescription: "New selection details" }));
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByRole("button", { name: `View details for ${agent.displayName}` }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      const original = transport.fetchMock.mock.calls.find(([input]) => isPackageDetailRequest(input, agent.id))!;
      expect(reads).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "Reload saved inventory" }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(reads).toBe(2);
      expect(original[1]?.signal?.aborted).toBe(true);
      const latest = transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, agent.id))[1];
      expect(latest[0]).not.toBe(original[0]);
      expect(screen.getByText("New selection details")).toBeVisible();
      await act(async () => pending.resolve(outcome === "success"
        ? Response.json({ ...agent, longDescription: "Superseded selection details" })
        : Response.json({ code: "unavailable", detail: "Superseded selection failure" }, { status: 503 })));
      expect(screen.queryByText(/Superseded selection/)).not.toBeInTheDocument();
      expect(screen.getByText("New selection details")).toBeVisible();
      expect(reads).toBe(2);
      expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    },
  );

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
        return Response.json(selectedInventoryPage(input, page));
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
    fireEvent.click(screen.getByRole("button", { name: "Reload saved inventory" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const delayed = transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, agent.id));
    expect(delayed).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Close unified agent details" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(delayed[1][1]?.signal?.aborted).toBe(true);
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
    await act(() => vi.advanceTimersByTimeAsync(0));
    const search = screen.getByRole("searchbox", { name: "Search users or agents" });
    fireEvent.change(search, { target: { value: "Ben" } });
    search.focus();
    expect(screen.queryByRole("status", { name: "Background refresh" })).not.toBeInTheDocument();
    const reads = () => transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === "/api/copilot-usage/users").length;
    const detailReads = () => transport.fetchMock.mock.calls.filter(([input]) =>
      new URL(input, "http://localhost").pathname === `/api/copilot-usage/users/${updated.value[1].directory.objectId}`).length;
    const before = reads();
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Ben" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("dialog", { name: "Ben" })).toBeVisible();
    expect(detailReads()).toBe(1);

    refreshing = true;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(reads()).toBe(before + 1);
    expect(screen.queryByRole("dialog", { name: "Ben" })).not.toBeInTheDocument();
    expect(detailReads()).toBe(1);
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
    expect(params.get("search")).toBe("ben");
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
    expect(detailReads()).toBe(1);
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
    expect(screen.queryByRole("button", { name: `Manage access for ${agent.displayName}` })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Block ${agent.displayName}` })).not.toBeInTheDocument();
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
      const reportUser = selectedReportUsersPage({ licenseCohort: "active_without_paid" }).value.find(user => user.username === "cleo@example.invalid")!;
      directory.value[2] = { ...directory.value[2], copilotServiceState: "disabled", entitlement: "no_paid", reportedResponses: reportUser.reportedResponses };
      const personId = surface === "responsibility" ? responsibilityOwnerId
        : directory.value[surface === "licenses" ? 0 : 2].directory.objectId;
      const url = surface === "responsibility" ? `/users?detail=${personId}&tab=responsibility`
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
        if (input === `/api/copilot-usage/users/${responsibilityOwnerId}`) {
          return Response.json({ code: "data_record_not_found", detail: "Record is not in the selected cohort." }, { status: 404 });
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
      const dialog = screen.getByRole("dialog", { name: surface === "responsibility" ? "Responsible only" : surface === "licenses" ? "Ada" : reportUser.displayName! });
      const directoryReads = () => transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === "/api/copilot-usage/users").length;
      const reportReads = () => transport.fetchMock.mock.calls.filter(([input]) => input.startsWith("/api/official-usage/users")).length;
      const beforeReads = [directoryReads(), reportReads()];
      completed = true;
      await waitFor(() => expect(screen.getByText("Current responsibility after sync")).toBeVisible(), { timeout: 2_500 });
      expect(screen.queryByText("Previous responsibility")).not.toBeInTheDocument();
      expect(screen.getByText("Created by", { exact: true })).toBeVisible();
      expect(screen.getByRole("combobox", { name: "User cohort" })).toHaveValue(surface === "responsibility" ? "licenses" : surface);
      expect(window.location.pathname + window.location.search).toBe(url);
      expect(responsibilityReads).toBe(beforeResponsibilityReads + 1);
      expect([directoryReads(), reportReads()]).toEqual(beforeReads);
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute("open");
      if (surface !== "responsibility") {
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

  it.each(["success", "failure"] as const)("ignores a superseded StrictMode bootstrap %s after sign-out", async outcome => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const firstSetup = deferredResponse();
    let setupReads = 0;
    let firstSignal: AbortSignal | null | undefined;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/auth/status" && ++setupReads === 1) {
        firstSignal = init?.signal;
        const response = await firstSetup.promise;
        if (outcome === "failure") throw new TypeError("Superseded configuration failure");
        return response;
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
    expect(screen.queryByText(/configuration could not be checked|Superseded configuration failure/)).not.toBeInTheDocument();
    expect(firstSignal?.aborted).toBe(true);
    expect(transport.meCalls()).toBe(1);
  });

  it.each(["network", "invalid JSON"] as const)("restores an existing session despite a configuration %s failure", async failure => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/auth/status") {
        if (failure === "network") throw new TypeError("internal configuration network diagnostic");
        return new Response("internal proxy response");
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText(agent.displayName)).toBeVisible();
    expect(transport.meCalls()).toBe(1);
    expect(screen.queryByRole("button", { name: "Sign in with Entra ID" })).not.toBeInTheDocument();
    expect(screen.queryByText(/internal configuration|internal proxy/)).not.toBeInTheDocument();
  });

  it.each(["bootstrap", "revalidation"] as const)("replaces a pre-departure pending %s session read on history restoration", async phase => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const abandoned = deferredResponse();
    const replacement = deferredResponse();
    const deferredRead = phase === "bootstrap" ? 1 : 2;
    let sessionReads = 0;
    let abandonedSignal: AbortSignal | null | undefined;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/me") {
        sessionReads += 1;
        if (sessionReads === deferredRead) {
          abandonedSignal = init?.signal;
          return abandoned.promise;
        }
        if (sessionReads === deferredRead + 1) return replacement.promise;
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    if (phase === "revalidation") {
      await screen.findByText(agent.displayName);
      await act(async () => {
        transport.failProtectedReadsWith = 401;
        await expect(getAgents()).rejects.toMatchObject({ status: 401 });
        transport.failProtectedReadsWith = undefined;
      });
    }
    await waitFor(() => expect(sessionReads).toBe(deferredRead));
    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    expect(abandonedSignal?.aborted).toBe(true);
    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await waitFor(() => expect(sessionReads).toBe(deferredRead + 1));
    await act(async () => abandoned.resolve(Response.json({
      user: { ...viewer, displayName: "Abandoned account" }, csrfToken: "abandoned-csrf", roleAssignmentRequired: false,
    })));
    expect(screen.queryByText("Abandoned account")).not.toBeInTheDocument();
    expect(screen.getByText("Checking sign-in...")).toBeVisible();
    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(sessionReads).toBe(deferredRead + 1);
    await act(async () => replacement.resolve(Response.json({ user: viewer, csrfToken: "replacement-csrf", roleAssignmentRequired: false })));
    expect(await screen.findByText(agent.displayName)).toBeVisible();
    expect(screen.getByText(viewer.displayName)).toBeVisible();
    expect(screen.queryByText("Abandoned account")).not.toBeInTheDocument();
  });

  it.each(["same", "replacement"] as const)("revalidates the %s account before reusing a browser-history-restored workbench", async account => {
    const client = savedQueries.createSavedQueryClient();
    vi.spyOn(savedQueries, "createSavedQueryClient").mockReturnValue(client);
    const replacementUser = account === "same" ? viewer : { ...viewer, homeAccountId: "replacement-account", displayName: "Replacement viewer" };
    const replacementPage = createUnifiedPage();
    const transport = appTransport({
      revalidatedRoles: viewer.roles, revalidatedUser: replacementUser,
      deferRevalidation: true, unifiedResponse: replacementPage,
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const previousCache = ["saved", "previous-session-evidence"];
    client.setQueryDefaults(previousCache, { gcTime: Infinity });
    client.setQueryData(previousCache, { value: "Previous session data" });
    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })));
    expect(transport.meCalls()).toBe(1);
    expect(client.getQueryData(previousCache)).toBeDefined();

    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await waitFor(() => expect(transport.meCalls()).toBe(2));
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(client.getQueryData(previousCache)).toBeUndefined();
    expect(screen.getByText("Checking sign-in...")).toBeVisible();

    replacementPage.value = [{ ...replacementPage.value[0], displayName: "Current session agent" }];
    await act(async () => transport.releaseRevalidation());
    expect(await screen.findByText("Current session agent")).toBeVisible();
    expect(screen.getByText(replacementUser.displayName)).toBeVisible();
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(transport.meCalls()).toBe(2);
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/auth/login")).toBe(false);
  });

  it.each(["success", "failure"] as const)("revalidates after suspending a pending logout and ignores its late %s", async outcome => {
    const replacementUser = { ...viewer, homeAccountId: "replacement-account", displayName: "Replacement viewer" };
    const transport = appTransport({
      revalidatedRoles: viewer.roles, revalidatedUser: replacementUser, deferRevalidation: true,
    });
    const base = transport.fetchMock.getMockImplementation()!;
    const abandoned = deferredResponse();
    const current = deferredResponse();
    const logoutSignals: (AbortSignal | null | undefined)[] = [];
    transport.fetchMock.mockImplementation((input, init) => {
      if (input === "/api/auth/logout") {
        logoutSignals.push(init?.signal);
        return logoutSignals.length === 1 ? abandoned.promise : current.promise;
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />, { reactStrictMode: true });
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeDisabled();

    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    expect(logoutSignals[0]?.aborted).toBe(true);
    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await waitFor(() => expect(transport.meCalls()).toBe(2));
    expect(screen.getByText("Checking sign-in...")).toBeVisible();
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with Entra ID" })).not.toBeInTheDocument();
    await act(async () => transport.releaseRevalidation());
    expect(await screen.findByText(replacementUser.displayName)).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(logoutSignals).toHaveLength(2);
    await act(async () => abandoned.resolve(outcome === "success" ? new Response(null, { status: 204 })
      : Response.json({ code: "invalid_origin", detail: "Abandoned logout failed." }, { status: 403 })));
    expect(screen.getByText(replacementUser.displayName)).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(logoutSignals[1]?.aborted).toBe(false);
    expect(transport.meCalls()).toBe(2);
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/auth/login")).toBe(false);

    await act(async () => current.resolve(new Response(null, { status: 204 })));
    expect(await screen.findByRole("button", { name: "Sign in with Entra ID" })).toBeEnabled();
  });

  it("revalidates a replaced account after an automatic-refresh CSRF rejection and withdraws its old cache", async () => {
    const client = savedQueries.createSavedQueryClient();
    vi.spyOn(savedQueries, "createSavedQueryClient").mockReturnValue(client);
    const replacementUser = { ...viewer, homeAccountId: "replacement-account", displayName: "Replacement viewer" };
    const replacementPage = createUnifiedPage();
    const transport = appTransport({
      revalidatedRoles: viewer.roles, revalidatedUser: replacementUser,
      deferRevalidation: true, unifiedResponse: replacementPage,
    });
    const base = transport.fetchMock.getMockImplementation()!;
    const automaticRefresh = deferredResponse();
    let automaticChecks = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/auto-refresh" && ++automaticChecks === 1) return automaticRefresh.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await waitFor(() => expect(automaticChecks).toBe(1));
    const previousCache = ["saved", "previous-account-evidence"];
    client.setQueryData(previousCache, { value: "Previous account data" });

    await act(async () => automaticRefresh.resolve(Response.json({
      code: "invalid_csrf", detail: "A valid CSRF token is required.",
    }, { status: 403 })));
    await waitFor(() => expect(transport.meCalls()).toBe(2));
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(client.getQueryData(previousCache)).toBeUndefined();
    expect(automaticChecks).toBe(1);
    expect(screen.queryByText(/Automatic refresh access was denied/)).not.toBeInTheDocument();

    replacementPage.value = [{ ...replacementPage.value[0], displayName: "Replacement account agent" }];
    await act(async () => transport.releaseRevalidation());
    expect(await screen.findByText("Replacement account agent")).toBeVisible();
    expect(screen.getByText(replacementUser.displayName)).toBeVisible();
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    await waitFor(() => expect(automaticChecks).toBe(2));
    const refreshCalls = transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-sync/auto-refresh");
    expect(refreshCalls.map(([, init]) => new Headers(init?.headers).get("X-CSRF-Token"))).toEqual(["csrf-1", "csrf-2"]);
    expect(transport.meCalls()).toBe(2);
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
      if (deniedSource === "refresh history") {
        await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
        await userEvent.click(screen.getByText("View diagnostics"));
      }
      const before = unrelatedReads();
      try {
        deny = true;
        if (deniedSource === "refresh history") {
          await userEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
        } else {
          fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Sensitive" } });
        }
        await screen.findAllByText(/Saved agent access denied/);
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
        if (deniedSource === "refresh history") {
          await userEvent.click(screen.getByRole("button", { name: "Reload saved inventory" }));
          await waitFor(() => expect(screen.queryAllByText(/Saved agent access denied/)).toHaveLength(0));
          await userEvent.click(screen.getByRole("button", { name: "Agents" }));
        } else {
          await userEvent.click(await screen.findByRole("button", { name: "Reload saved agent inventory" }));
        }
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

  it("admits only one detail read when choosing an already-loaded paged published version", async () => {
    const second = { ...agent, id: "package-alternate", displayName: "Second publication" };
    const group = { ...unifiedPage.value[0], packages: [agent, second], packagesComplete: false, packageCount: 40 };
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([group]) });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) => isPackageDetailRequest(input, second.id)
      ? pending.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
    const dialog = await screen.findByRole("dialog", { name: agent.displayName });
    const versions = within(dialog).getByRole("combobox", { name: "Published version details" });
    await waitFor(() => expect(versions).toBeEnabled());
    await waitFor(() => expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument());
    await userEvent.selectOptions(versions, second.id);
    const requests = transport.fetchMock.mock.calls.filter(([path]) => isPackageDetailRequest(path, second.id));
    expect(requests).toHaveLength(1);
    expect(requests[0][1]?.signal?.aborted).toBe(false);
    expect(within(dialog).getByText("Loading saved agent details...")).toBeVisible();

    await act(async () => pending.resolve(Response.json({ ...second, longDescription: "Selected publication details" })));
    expect(await within(dialog).findByText("Selected publication details")).toBeVisible();
    expect(versions).toHaveValue(second.id);
    expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument();
  });

  it("shares a pending saved-detail retry when repeated clicks occur in one React batch", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let retry = false;
    transport.fetchMock.mockImplementation((input, init) => isPackageDetailRequest(input, agent.id)
      ? retry ? pending.promise
        : Promise.resolve(Response.json({ code: "saved_details_unavailable", detail: "Saved details unavailable." }, { status: 503 }))
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
    const dialog = await screen.findByRole("dialog", { name: agent.displayName });
    const retryButton = await within(dialog).findByRole("button", { name: "Retry saved details" });
    retry = true;
    act(() => {
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
    });
    const reads = transport.fetchMock.mock.calls.filter(([path]) => isPackageDetailRequest(path, agent.id));
    expect(reads).toHaveLength(2);
    expect(reads[1][1]?.signal?.aborted).toBe(false);

    await act(async () => pending.resolve(Response.json({ ...agent, longDescription: "Retried saved detail" })));
    expect(await within(dialog).findByText("Retried saved detail")).toBeVisible();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retries a failed selected version outside the loaded preview without changing the target", async () => {
    const second = { ...agent, id: "package-alternate", displayName: "Second publication" };
    const group = { ...unifiedPage.value[0], packagesComplete: false, packageCount: 40 };
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([group]) });
    const base = transport.fetchMock.getMockImplementation()!;
    let recovered = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname.endsWith("/members")) return Response.json({
        value: [{ domain: "packages", native_id: second.id, display_name: second.displayName }],
        total: 40, nextCursor: null,
      });
      if (isPackageDetailRequest(input, second.id)) return recovered
        ? Response.json({
          ...second, longDescription: "Recovered publication details",
          observation: { observedAt: packagePage.selection.evaluatedAt, expiresAt: packagePage.selection.expiresAt, scopeKind: "exact" },
          selectedSource: {
            selectionId: new URL(input, "http://localhost").searchParams.get("selectionId"),
            recordId: group.id, sourceIdentity: second.id, sourceScopeId: "package-scope", generationId: "package-generation",
          },
        })
        : Response.json({ code: "provider_error", detail: "Saved publication temporarily unavailable" }, { status: 503 });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
    const dialog = await screen.findByRole("dialog", { name: agent.displayName });
    const versions = within(dialog).getByRole("combobox", { name: "Published version details" });
    await waitFor(() => expect(versions).toBeEnabled());
    await userEvent.selectOptions(versions, second.id);
    await waitFor(() => expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument());
    expect(versions).toHaveValue(second.id);
    expect(within(dialog).getAllByRole("alert")[0]).toHaveTextContent("Saved publication temporarily unavailable");
    expect(transport.fetchMock.mock.calls.filter(([path]) => isPackageDetailRequest(path, second.id))).toHaveLength(1);

    recovered = true;
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry saved details" }));
    expect(await within(dialog).findByText("Recovered publication details")).toBeVisible();
    expect(versions).toHaveValue(second.id);
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([path]) => isPackageDetailRequest(path, second.id))).toHaveLength(2);
  });

  it("retires the inventory selection when chosen published-version details invalidate it", async () => {
    const second = { ...agent, id: "package-alternate", displayName: "Second publication" };
    const group = { ...unifiedPage.value[0], packages: [agent, second], packagesComplete: false, packageCount: 40 };
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([group]) });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => isPackageDetailRequest(input, second.id)
      ? Promise.resolve(Response.json({ code: "selection_invalidated", detail: "The selected inventory expired." }, { status: 409 }))
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
    const dialog = await screen.findByRole("dialog", { name: agent.displayName });
    const versions = within(dialog).getByRole("combobox", { name: "Published version details" });
    await waitFor(() => expect(versions).toBeEnabled());
    await userEvent.selectOptions(versions, second.id);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: agent.displayName })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: `View details for ${agent.displayName}` })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent inventory unavailable" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload saved agent inventory" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Retry saved details" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([path]) => isPackageDetailRequest(path, second.id))).toHaveLength(1);
  });

  it("does not cancel a replacement inventory read when the old published-version detail invalidates", async () => {
    const transport = initialCatalogTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const detail = deferredResponse(), replacement = deferredResponse();
    let replacing = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (isPackageDetailRequest(input, agent.id)) return replacing
        ? Response.json({ ...agent, longDescription: "Replacement version details" }) : detail.promise;
      const response = await base(input, init);
      if (replacing && new URL(input, "http://localhost").pathname === "/api/agent-inventory") await replacement.promise;
      return response;
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
    const dialog = await screen.findByRole("dialog", { name: agent.displayName });
    const priorSelection = currentInventorySelection(transport.fetchMock);
    replacing = true;
    await userEvent.click(within(dialog).getByRole("button", { name: "Reload saved inventory" }));
    const inventoryReads = () => transport.fetchMock.mock.calls.filter(
      ([input]) => new URL(input, "http://localhost").pathname === "/api/agent-inventory",
    );
    await waitFor(() => expect(inventoryReads()).toHaveLength(2));
    const replacementSignal = inventoryReads()[1][1]?.signal;
    await act(async () => detail.resolve(Response.json({
      code: "selection_invalidated", detail: "Previous version selection expired.",
    }, { status: 409 })));
    expect(replacementSignal?.aborted).toBe(false);
    expect(screen.getByRole("dialog", { name: agent.displayName })).toBeVisible();
    await act(async () => replacement.resolve(Response.json({})));
    expect(await screen.findByText("Replacement version details")).toBeVisible();
    expect(currentInventorySelection(transport.fetchMock)).not.toBe(priorSelection);
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
    expect(screen.queryByText("Previous version selection expired.")).not.toBeInTheDocument();
    expect(inventoryReads()).toHaveLength(2);
  });

  it.each(["success", "failure", "invalidation"] as const)("cancels a paged version read and ignores its late %s after another version is selected", async outcome => {
    const second = { ...agent, id: "package-alternate", displayName: "Second publication" };
    const group = { ...unifiedPage.value[0], packages: [agent, second], packagesComplete: false, packageCount: 40 };
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([group]) });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) => isPackageDetailRequest(input, second.id)
      ? pending.promise : isPackageDetailRequest(input, agent.id)
        ? Promise.resolve(Response.json({ ...agent, longDescription: "Current publication details" })) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
    const dialog = await screen.findByRole("dialog", { name: agent.displayName });
    expect(await within(dialog).findByText("Current publication details")).toBeVisible();
    const versions = within(dialog).getByRole("combobox", { name: "Published version details" });
    await waitFor(() => expect(versions).toBeEnabled());
    await userEvent.selectOptions(versions, second.id);
    const requests = transport.fetchMock.mock.calls.filter(([path]) => isPackageDetailRequest(path, second.id));
    expect(requests).toHaveLength(1);
    expect(within(dialog).queryByText("Current publication details")).not.toBeInTheDocument();
    await userEvent.selectOptions(versions, agent.id);
    expect(requests[0][1]?.signal?.aborted).toBe(true);
    expect(await within(dialog).findByText("Current publication details")).toBeVisible();

    await act(async () => pending.resolve(outcome === "success"
      ? Response.json({ ...second, longDescription: "Superseded publication details" })
      : Response.json({ code: outcome === "invalidation" ? "selection_invalidated" : "provider_error",
        detail: "Superseded publication error" }, { status: outcome === "invalidation" ? 409 : 500 })));
    expect(versions).toHaveValue(agent.id);
    expect(within(dialog).getByText("Current publication details")).toBeVisible();
    expect(within(dialog).queryByText(/Superseded publication/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument();
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

  it("preserves one selected quarantine target when equivalent native GUID casing changes", async () => {
    const nativeId = "abcdefab-2222-4222-8222-222222222222";
    const native = powerPlatformRecord(nativeId, "Case-stable target");
    const replacement = powerPlatformRecord(nativeId.toUpperCase(), native.displayName);
    const transport = appTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"] });
    const base = transport.fetchMock.getMockImplementation()!;
    let changed = false;
    transport.fetchMock.mockImplementation(async (input, init) => new URL(input, "http://localhost").pathname === "/api/agent-inventory"
      ? Response.json(unifiedRecordsPage([changed ? replacement : native]))
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Case-stable target" }));
    changed = true;
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "displayName:desc");
    await waitFor(() => expect(transport.fetchMock.mock.calls.filter(([input]) =>
      new URL(input, "http://localhost").pathname === "/api/agent-inventory")).toHaveLength(2));
    expect(screen.getByRole("checkbox", { name: "Select Case-stable target" })).toBeChecked();
    expect(screen.getByText("1 of 25 exact Copilot Studio agents selected")).toBeVisible();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Case-stable target" }));
    expect(screen.queryByRole("region", { name: "Copilot Studio quarantine controls" })).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).getAll("selectedResource")).toEqual([]);
  });

  it("retains mixed package selection when adding its quarantine target would mix snapshots", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Selected native agent");
    const other = powerPlatformRecord("33333333-3333-4333-8333-333333333333", "Partially selected agent");
    const merged: UnifiedAgentRecord = {
      ...other, presence: "both", packages: [agent],
      observations: {
        ...other.observations,
        powerPlatform: { ...other.observations.powerPlatform!, id: "other-snapshot", snapshotId: "other-snapshot" },
      },
    };
    window.history.replaceState({}, "", `/agents?inventory=all&selected=${agent.id}`);
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"], unifiedResponse: unifiedRecordsPage([native, merged]),
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const checkbox = await screen.findByRole("checkbox", { name: "Select Partially selected agent" });
    expect(checkbox).toBePartiallyChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Selected native agent" }));
    const reads = transport.fetchMock.mock.calls.filter(([input]) =>
      new URL(input, "http://localhost").pathname === "/api/agent-inventory").length;
    await userEvent.click(checkbox);
    expect(screen.getByText("The saved inventory changed. Clear the previous quarantine selection before selecting more agents.")).toBeVisible();
    expect(checkbox).toBePartiallyChecked();
    expect(checkbox).toHaveFocus();
    expect(new URLSearchParams(window.location.search).getAll("selected")).toEqual([agent.id]);
    expect(new URLSearchParams(window.location.search).getAll("selectedResource")).toEqual([native.id]);
    expect(new URLSearchParams(window.location.search).get("inventorySnapshot")).toBe(native.observations.powerPlatform!.snapshotId);
    expect(transport.fetchMock.mock.calls.filter(([input]) =>
      new URL(input, "http://localhost").pathname === "/api/agent-inventory")).toHaveLength(reads);
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
        expect(url.searchParams.has("setId")).toBe(false);
        expect(url.searchParams.get("inventorySelectionId")).toBe(currentInventorySelection(transport.fetchMock));
        selectedContext.selectionId = url.searchParams.get("inventorySelectionId")!;
        return Response.json({ ...record.usage, recordId: record.id, context: selectedContext });
      }
      if (url.pathname.endsWith("/usage-history")) {
        selectedContext.selectionId = url.searchParams.get("inventorySelectionId")!;
        return Response.json({
          recordId: record.id, context: selectedContext, value: [], latestReportSetId: selectedContext.reportSetId, latestReported: null,
          counts: { total: 0, filtered: 0 }, page: { limit: 50, nextCursor: null, previousCursor: null },
        });
      }
      if (url.pathname.endsWith("/usage-users")) return Response.json({
        value: [{ username: "usage@example.invalid", displayName: "Usage user", responses: 215 }],
        reports: report.reports, selection: { ...report.selection, id: selectedContext.selectionId }, context: selectedContext,
        counts: { total: 1, filtered: 1 }, page: { limit: 25, nextCursor: null, previousCursor: null },
      });
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
      window.history.pushState({}, "", `/agents?detail=${encodeURIComponent(record.id)}&detailTab=users`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const detail = await screen.findByRole("dialog", { name: record.displayName });
    expect(await within(detail).findByLabelText("Selected agent report metrics")).toHaveTextContent("215");
    const exactReads = () => transport.fetchMock.mock.calls.filter(([input]) => unifiedDetailId(input) === record.id);
    expect(exactReads()).toHaveLength(1);
    await userEvent.click(await within(detail).findByText("Reviewed report links"));
    await userEvent.click(await within(detail).findByRole("button", { name: "Remove association for Researcher (synthetic-researcher)" }));
    await userEvent.click(within(detail).getByRole("checkbox", { name: "I confirm this reporting association should be removed." }));
    await userEvent.click(within(detail).getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(transport.fetchMock.mock.calls.find(([input, init]) =>
      new URL(input, "http://localhost").pathname.endsWith("/usage-associations") && init?.method === "DELETE")?.[1]).toMatchObject({
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

  it("reuses one inventory selection for equivalent environment bookmarks", async () => {
    window.history.replaceState({}, "", `/agents?environment=${encodeURIComponent(encodeInventoryFacet("ENV-A"))}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const response = await base(input, init);
      return new URL(input, "http://localhost").pathname === "/api/agent-inventory"
        ? Response.json({ ...await response.json(), value: unifiedPage.value, counts: unifiedPage.counts }) : response;
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const before = agentListRequests(transport.fetchMock).length;
    act(() => {
      window.history.pushState({}, "", `/agents?environment=${encodeURIComponent(encodeInventoryFacet("env-a"))}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {});
    expect(agentListRequests(transport.fetchMock)).toHaveLength(before);
    expect(new URLSearchParams(window.location.search).get("environment")).toBe(encodeInventoryFacet("env-a"));
  });

  it("does not reuse a later inventory cursor when history restores the first page", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const response = await base(input, init);
      const url = new URL(input, "http://localhost");
      if (url.pathname !== "/api/agent-inventory") return response;
      const page = await response.json() as UnifiedAgentInventoryPage;
      const later = url.searchParams.get("cursor") === "later-page";
      return Response.json({ ...page, value: later ? [{ ...page.value[0], displayName: "Later page agent" }] : page.value,
        page: { limit: 50, nextCursor: later ? null : "later-page", previousCursor: later ? "first-page" : null } });
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const first = { state: window.history.state, href: window.location.href };
    await userEvent.click(within(screen.getByRole("navigation", { name: "Agent inventory pages" })).getByRole("button", { name: "Next" }));
    await screen.findByText("Later page agent");
    const before = agentListRequests(transport.fetchMock).length;
    act(() => {
      window.history.pushState(first.state, "", first.href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByText(agent.displayName)).toBeVisible();
    expect(screen.queryByText("Later page agent")).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).has("page")).toBe(false);
    expect(agentListRequests(transport.fetchMock)).toHaveLength(before);
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

  it("rejects invalid creation age without reloading inventory or changing its applied query", async () => {
    window.history.replaceState({}, "", "/agents?createdWithinDays=30");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await waitFor(() => expect(screen.queryByRole("status", { name: "Updating agent results" })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Filters, 1 active" }));
    const input = screen.getByRole("spinbutton", { name: "Created within days" });
    const reads = () => transport.fetchMock.mock.calls.filter(([input]) =>
      ["/api/agent-inventory", "/api/agent-inventory/selections"].includes(new URL(input, "http://localhost").pathname));
    const initialReads = reads().length;
    for (const value of ["0", "-1", "1.5", "3651"]) {
      fireEvent.change(input, { target: { value } });
      expect(screen.getByText("Enter a whole number of days from 1 to 3650.")).toBeVisible();
      expect(input).toHaveValue(30);
      expect(new URLSearchParams(window.location.search).get("createdWithinDays")).toBe("30");
      expect(reads()).toHaveLength(initialReads);
    }
    for (const value of ["3e1", "30.0", "030"]) {
      fireEvent.change(input, { target: { value } });
      await act(async () => {});
      expect(new URLSearchParams(window.location.search).get("createdWithinDays")).toBe("30");
      expect(reads()).toHaveLength(initialReads);
    }
    fireEvent.change(input, { target: { value: "3650" } });
    await waitFor(() => expect(reads().some(([input]) =>
      selectedInventoryUrl(input).searchParams.get("createdWithinDays") === "3650")).toBe(true));
    expect(new URLSearchParams(window.location.search).get("createdWithinDays")).toBe("3650");
  });

  it("shows local filter validation errors without disrupting a pending replacement selection", async () => {
    window.history.replaceState({}, "", "/agents?createdWithinDays=30");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const replacement = deferredResponse();
    let replacing = false;
    transport.fetchMock.mockImplementation(async (input, init) =>
      replacing && new URL(input, "http://localhost").pathname === "/api/agent-inventory"
        ? replacement.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("button", { name: "Filters, 1 active" }));
    replacing = true;
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "displayName:desc");
    const reads = () => transport.fetchMock.mock.calls.filter(([input]) =>
      new URL(input, "http://localhost").pathname === "/api/agent-inventory");
    await waitFor(() => expect(reads()).toHaveLength(2));
    const [request, init] = reads()[1];
    const input = screen.getByRole("spinbutton", { name: "Created within days" });
    fireEvent.change(input, { target: { value: "0" } });
    expect(screen.getByText("Enter a whole number of days from 1 to 3650.")).toBeVisible();
    expect(input).toHaveValue(30);
    expect(new URLSearchParams(window.location.search).get("createdWithinDays")).toBe("30");
    expect(init?.signal?.aborted).toBe(false);
    expect(reads()).toHaveLength(2);
    expect(screen.getByRole("status", { name: "Matching agents" })).toHaveTextContent("Updating...");
    await act(async () => replacement.resolve(await base(request, init)));
    await waitFor(() => expect(screen.getByRole("status", { name: "Matching agents" })).toHaveTextContent("1 matching agent"));
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
    page.verification = createUnifiedVerification(page.verification, { packageMetadata: false });
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
    expect(transport.fetchMock.mock.calls.slice(beforeExpansion)
      .filter(([path]) => ["/api/agent-inventory/selections", "/api/agent-inventory"].includes(new URL(path, "http://localhost").pathname))).toEqual([]);
    const receipt = within(screen.getByRole("region", { name: "Saved agent inventory verification" }));
    expect(receipt.getByText("Resources stored / provider total").nextElementSibling).toHaveTextContent("4,178 / 4,178");
    expect(receipt.getByText("Provider pages collected").nextElementSibling).toHaveTextContent("42");
    expect(receipt.getByText("Optional directory-role hint").nextElementSibling).toHaveTextContent("Not supplied");
    const collectedTime = receipt.getByText("Graph source collected at").nextElementSibling?.textContent;
    const before = transport.fetchMock.mock.calls.length;
    verificationRequested = true;
    await userEvent.dblClick(receipt.getByRole("button", { name: "Verify saved inventory" }));
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
    expect(requests.filter(([input]) => input === "/api/agent-inventory/selections")).toHaveLength(1);
    expect(requests.filter(([input]) => input.startsWith("/api/agent-inventory?"))).toHaveLength(1);
    expect(requests.filter(([path, init]) => path !== "/api/agent-inventory/selections" && init?.method && init.method !== "GET").map(([input, init]) => [input, init?.method])).toEqual([]);
    expect(new URL(agentListRequests(transport.fetchMock).at(-1)![0], "http://localhost").searchParams.has("snapshotId")).toBe(false);
    expect(receipt.queryByText(/partial inventory|coverage unknown/i)).not.toBeInTheDocument();
  });

  it.each(["capture", "page"] as const)("keeps one pending verification %s while switching between inventory consumers", async phase => {
    window.history.replaceState({}, "", "/sync");
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: verifiedSavedAgentPage() });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let deferNextRead = false;
    let pendingResponse: Response | undefined;
    let pendingSignal: AbortSignal | null | undefined;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const response = await base(input, init);
      const path = new URL(input, "http://localhost").pathname;
      if (deferNextRead && path === (phase === "capture" ? "/api/agent-inventory/selections" : "/api/agent-inventory")) {
        deferNextRead = false;
        pendingResponse = response;
        pendingSignal = init?.signal;
        return pending.promise;
      }
      return response;
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View diagnostics" }));
    await screen.findByText("Saved inventory verified");
    const before = transport.fetchMock.mock.calls.length;
    deferNextRead = true;
    await userEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
    await waitFor(() => expect(pendingResponse).toBeDefined());
    await userEvent.click(screen.getByRole("button", { name: "Browse agents" }));
    expect(pendingSignal?.aborted).toBe(false);
    expect(screen.getByRole("status", { name: "Updating agent results" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    expect(screen.getByRole("button", { name: "Verifying saved inventory..." })).toBeDisabled();
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();

    await act(async () => pending.resolve(pendingResponse!));
    await screen.findByText("Saved inventory verified");
    const requests = transport.fetchMock.mock.calls.slice(before);
    expect(requests.filter(([path]) => path === "/api/agent-inventory/selections")).toHaveLength(1);
    expect(requests.filter(([path]) => new URL(path, "http://localhost").pathname === "/api/agent-inventory")).toHaveLength(1);
    expect(pendingSignal?.aborted).toBe(false);
  });

  it.each((["capture", "page"] as const).flatMap(phase =>
    (["filter", "scope", "departure"] as const).map(boundary => ({ phase, boundary }))))(
    "retires a pending verification $phase on $boundary and ignores its late denial", async ({ phase, boundary }) => {
      window.history.replaceState({}, "", "/sync");
      const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: verifiedSavedAgentPage() });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      let deferNextRead = false;
      let pendingSignal: AbortSignal | null | undefined;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (deferNextRead && new URL(input, "http://localhost").pathname ===
          (phase === "capture" ? "/api/agent-inventory/selections" : "/api/agent-inventory")) {
          deferNextRead = false;
          pendingSignal = init?.signal;
          return pending.promise;
        }
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("button", { name: "View diagnostics" }));
      await screen.findByText("Saved inventory verified");
      deferNextRead = true;
      await userEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
      await waitFor(() => expect(pendingSignal).toBeDefined());
      await userEvent.click(screen.getByRole("button", { name: "Browse agents" }));
      expect(pendingSignal?.aborted).toBe(false);
      if (boundary === "filter") fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: agent.displayName } });
      else if (boundary === "scope") await userEvent.click(screen.getByRole("button", { name: "Additional Power Platform agents" }));
      else {
        await userEvent.click(screen.getByRole("button", { name: "Users" }));
        await screen.findByRole("button", { name: "Ada" });
      }
      await waitFor(() => expect(pendingSignal?.aborted).toBe(true));
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await userEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
      const receipt = within(screen.getByRole("region", { name: "Saved agent inventory verification" }));
      await receipt.findByText("Saved inventory verified");
      const beforeLateResponse = transport.fetchMock.mock.calls.length;
      await act(async () => pending.resolve(Response.json({
        code: "unauthorized", detail: "Abandoned verification denied.",
      }, { status: 401 })));
      expect(receipt.getByText("Saved inventory verified")).toBeVisible();
      expect(receipt.queryByRole("alert")).not.toBeInTheDocument();
      expect(transport.meCalls()).toBe(1);
      expect(transport.fetchMock.mock.calls.slice(beforeLateResponse)).toEqual([]);
    },
  );

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

  it("captures inventory only once when verifying from a later result page", async () => {
    const page = { ...unifiedPage, counts: { ...unifiedPage.counts, filtered: 51 },
      value: Array.from({ length: 51 }, (_, index) => ({ ...unifiedPage.value[0], id: `graph_packages:saved-${index}`,
        displayName: `Saved agent ${index}`, packages: [{ ...agent, id: `saved-${index}` }] })) };
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText("Saved agent 0");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Saved agent 50");
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    const verify = screen.getByRole("button", { name: "Verify saved inventory" });
    await waitFor(() => expect(verify).toBeEnabled());
    const before = transport.fetchMock.mock.calls.length;
    await userEvent.click(verify);
    await waitFor(() => expect(verify).toBeEnabled());
    const captures = transport.fetchMock.mock.calls.slice(before)
      .filter(([path]) => path === "/api/agent-inventory/selections");
    expect(captures).toHaveLength(1);
    expect(captures[0][1]?.signal?.aborted).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(await screen.findByText("Saved agent 0")).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
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
    await userEvent.click(retryReceipt.getByRole("button", { name: "Reload saved inventory" }));
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

  it.each([
    { boundary: "the same account", nextUser: viewer },
    { boundary: "another account", nextUser: { ...viewer, homeAccountId: "replacement-account" } },
    { boundary: "another tenant", nextUser: { ...viewer, tenantId: "replacement-tenant" } },
  ].flatMap(owner => (["success", "denial"] as const).map(outcome => ({ ...owner, outcome }))))(
    "retires a late verification $outcome after revalidating as $boundary without disturbing its replacement",
    async ({ nextUser, outcome }) => {
      window.history.replaceState({}, "", "/sync");
      const page = verifiedSavedAgentPage();
      const transport = appTransport({
        revalidatedRoles: viewer.roles, revalidatedUser: nextUser, unifiedResponse: page, deferRevalidation: true,
      });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const checkedAt = "2026-09-18T06:15:00.000Z";
      let deferNextRead = false;
      let replacementSession = false;
      let retiredSignal: AbortSignal | null | undefined;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (new URL(input, "http://localhost").pathname !== "/api/agent-inventory") return base(input, init);
        if (deferNextRead) {
          deferNextRead = false;
          retiredSignal = init?.signal;
          return pending.promise;
        }
        const response = await base(input, init);
        if (!replacementSession) return response;
        const saved = await response.json() as UnifiedAgentInventoryPage;
        return Response.json({ ...saved, verification: { ...saved.verification, checkedAt } });
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("button", { name: "View diagnostics" }));
      await screen.findByText("Saved inventory verified");
      deferNextRead = true;
      await userEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
      await waitFor(() => expect(retiredSignal).toBeDefined());
      expect(retiredSignal?.aborted).toBe(false);
      expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();

      await act(async () => {
        transport.failProtectedReadsWith = 401;
        const expiredRequest = getAgents();
        transport.failProtectedReadsWith = undefined;
        await expect(expiredRequest).rejects.toMatchObject({ status: 401 });
      });
      await waitFor(() => expect(transport.meCalls()).toBe(2));
      expect(retiredSignal?.aborted).toBe(true);
      expect(screen.queryByRole("region", { name: "Saved agent inventory verification" })).not.toBeInTheDocument();
      replacementSession = true;
      await act(async () => transport.releaseRevalidation());
      await userEvent.click(await screen.findByRole("button", { name: "View diagnostics" }));
      const receipt = within(screen.getByRole("region", { name: "Saved agent inventory verification" }));
      await receipt.findByText("Saved inventory verified");
      expect(receipt.getByText("Saved data verified at").nextElementSibling?.querySelector("time"))
        .toHaveAttribute("datetime", checkedAt);
      const beforeLateResponse = transport.fetchMock.mock.calls.length;
      await act(async () => pending.resolve(outcome === "success" ? Response.json(page)
        : Response.json({ code: "unauthorized", detail: "The previous session expired." }, { status: 401 })));
      expect(receipt.getByText("Saved data verified at").nextElementSibling?.querySelector("time"))
        .toHaveAttribute("datetime", checkedAt);
      expect(receipt.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Verify saved inventory" })).toBeEnabled();
      expect(transport.meCalls()).toBe(2);
      expect(transport.fetchMock.mock.calls.slice(beforeLateResponse)).toEqual([]);
    },
  );

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
    expect(within(screen.getByRole("region", { name: "Sign in" })).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Work or school username" })).toBeVisible();
    const overview = within(screen.getByRole("region", { name: "Agent administration. A single workspace." }));
    expect(overview.getByText("Understand and manage your organization's AI agents, from adoption to access.")).toBeInTheDocument();
    expect(overview.getByRole("heading", { name: "Know your agent inventory" })).toBeInTheDocument();
    expect(overview.getByRole("heading", { name: "Understand adoption" })).toBeInTheDocument();
    expect(overview.getByRole("heading", { name: "Manage access and investigate" })).toBeInTheDocument();
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
    expect(within(screen.getByRole("region", { name: "Sign in" })).getAllByRole("button")).toHaveLength(1);
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
    window.localStorage.setItem("agent-control:signin-username:v1", "routing@example.com");
    storePackageSelection(viewer, ["current-tenant-package"]);
    storePackageSelection(otherTenant, ["other-tenant-package"]);
    render(<App />);
    await screen.findByText(agent.displayName);
    const privateQuery = ["saved", "private-tenant-report", viewer.tenantId, viewer.homeAccountId];
    client.setQueryData(privateQuery, { value: ["Private report"] });
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("textbox", { name: "Work or school username" })).toHaveValue("routing@example.com");
    expect(window.localStorage.getItem("agent-control:signin-username:v1")).toBe("routing@example.com");
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(client.getQueryData(privateQuery)).toBeUndefined();
    expect(window.localStorage.getItem(activeBulkJobStorageKey(viewer))).toBeNull();
    expect(window.localStorage.getItem(activeBulkJobStorageKey(otherTenant))).toBe("other-tenant-job");
    expect(restorePackageSelection(viewer, 1)).toEqual({ status: "unavailable" });
    expect(restorePackageSelection(otherTenant, 1)).toEqual({ status: "restored", ids: ["other-tenant-package"] });
  });

  it.each(["same principal", "another tenant"] as const)(
    "does not restore saved job bookmarks after revalidating as %s",
    async boundary => {
      window.history.replaceState({}, "", "/sync?powerPlatformJob=previous-session-job");
      const transport = appTransport({
        revalidatedRoles: viewer.roles,
        revalidatedUser: boundary === "another tenant" ? { ...viewer, tenantId: "tenant-2" } : viewer,
      });
      const base = transport.fetchMock.getMockImplementation()!;
      const path = "/api/inventory/refresh-jobs/previous-session-job";
      transport.fetchMock.mockImplementation((input, init) => input === path
        ? Promise.resolve(Response.json({ ...inventoryRefreshJob("failed", "previous-session-job"), message: "Previous session job details" }))
        : base(input, init));
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await screen.findByText(/Previous session job details/);
      await userEvent.click(screen.getByRole("button", { name: "Agents" }));
      await screen.findByText(agent.displayName);
      const before = transport.fetchMock.mock.calls.filter(([input]) => input === path).length;
      await revalidateTransportSession(transport);
      await screen.findByText(agent.displayName);
      await userEvent.click(screen.getByRole("button", { name: "Sync" }));
      await screen.findByRole("heading", { name: "Sync history" });
      expect(window.location.search).not.toContain("previous-session-job");
      expect(screen.queryByText(/Previous session job details/)).not.toBeInTheDocument();
      expect(transport.fetchMock.mock.calls.filter(([input]) => input === path)).toHaveLength(before);
    },
  );

  it.each(["active", "saved"] as const)("clears %s user detail routing on an account change", async state => {
    window.history.replaceState({}, "", `/users?detail=${responsibilityOwnerId}&tab=responsibility`);
    const transport = appTransport({
      revalidatedRoles: viewer.roles,
      revalidatedUser: { ...viewer, homeAccountId: "replacement-viewer" },
    });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => {
      if (input === `/api/copilot-usage/users/${responsibilityOwnerId}`) return Promise.resolve(Response.json({
        code: "data_record_not_found", detail: "Record is not in the selected cohort.",
      }, { status: 404 }));
      if (input.startsWith("/api/agent-responsibility")) return Promise.resolve(Response.json(responsibilityFixture(responsibilityOwnerId)));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("dialog", { name: "Responsible only" });
    if (state === "saved") await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    const before = transport.fetchMock.mock.calls.length;
    await revalidateTransportSession(transport);
    if (state === "saved") await userEvent.click(await screen.findByRole("button", { name: "Users" }));
    await screen.findByRole("button", { name: "Ada" });
    expect(window.location.search).not.toContain(responsibilityOwnerId);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.slice(before).some(([input]) => input.includes(responsibilityOwnerId))).toBe(false);
  });

  it.each(["same", "replacement"] as const)("does not restore an earlier history selection after %s session revalidation", async account => {
    window.history.replaceState({}, "", `/agents?selected=${agent.id}&q=Sensitive`);
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"],
      revalidatedUser: account === "same" ? viewer : { ...viewer, homeAccountId: "replacement-viewer" },
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` })).toBeChecked();
    const previous = { state: window.history.state, href: window.location.href };
    await userEvent.click(screen.getByRole("button", { name: "Users" }));
    await screen.findByRole("button", { name: "Ada" });
    await revalidateTransportSession(transport);
    await screen.findByRole("button", { name: "Ada" });
    act(() => {
      window.history.pushState(previous.state, "", previous.href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` })).not.toBeChecked();
    expect(new URLSearchParams(window.location.search).has("selected")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("q")).toBe("Sensitive");
  });

  it.each(["same", "replacement"] as const)("validates a persisted history entry against the %s account before restoring private routes", async account => {
    window.history.replaceState({}, "", `/agents?selected=${agent.id}`);
    const transport = appTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"] });
    vi.stubGlobal("fetch", transport.fetchMock);
    const first = render(<App />);
    expect(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` })).toBeChecked();
    first.unmount();
    const next = appTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"] });
    const base = next.fetchMock.getMockImplementation()!;
    next.fetchMock.mockImplementation((input, init) => input === "/api/me"
      ? Promise.resolve(Response.json({ user: { ...viewer, roles: ["AgentControl.Admin"],
        homeAccountId: account === "same" ? viewer.homeAccountId : "replacement-viewer" },
      csrfToken: "new-csrf", roleAssignmentRequired: false })) : base(input, init));
    vi.stubGlobal("fetch", next.fetchMock);
    render(<App />);
    const selection = await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` });
    if (account === "same") expect(selection).toBeChecked();
    else expect(selection).not.toBeChecked();
    expect(new URLSearchParams(window.location.search).has("selected")).toBe(account === "same");
  });

  it.each(["agents", "users", "sync", "correction"] as const)("removes private %s deep links before the next sign-in", async view => {
    const search = view === "agents" ? `?selected=${agent.id}&quarantineJob=previous-quarantine-job`
      : view === "users" ? `?detail=${responsibilityOwnerId}&tab=responsibility`
        : view === "correction" ? "?reports=import&correction=11111111-1111-4111-8111-111111111111"
        : "?reports=snapshot&snapshot=11111111-1111-4111-8111-111111111111";
    const path = view === "correction" ? "/sync" : `/${view}`;
    window.history.replaceState({}, "", `${path}${search}`);
    const transport = appTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"] });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => input === "/api/auth/logout"
      ? Promise.resolve(new Response(null, { status: 204 })) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await screen.findByRole("button", { name: "Sign in with Entra ID" });
    expect(window.location.pathname).toBe(path);
    expect(window.location.search).toBe("");
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
    expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([path]) => unifiedDetailId(path) === detailId)).toBe(true);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/graph_packages"))).toBe(false);
  });

  it.each(["close", "replace"] as const)("retires the previous detail immediately when browser history requests %s", async action => {
    const current = { ...unifiedPage.value[0], id: "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const replacement = powerPlatformRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Replacement agent");
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([current]) });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) => unifiedDetailId(input) === replacement.id
      ? pending.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
    await screen.findByRole("dialog", { name: agent.displayName });
    await waitFor(() => expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument());
    act(() => {
      window.history.pushState({}, "", action === "close" ? "/agents" : `/agents?detail=${encodeURIComponent(replacement.id)}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByRole("dialog", { name: agent.displayName })).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("detail")).toBe(action === "close" ? null : replacement.id);
    if (action === "replace") {
      expect(await screen.findByText("Loading agent details...")).toBeVisible();
      await act(async () => pending.resolve(Response.json(replacement)));
      expect(await screen.findByRole("dialog", { name: replacement.displayName })).toBeVisible();
    }
  });

  it.each(["pending", "settled"] as const)("preserves the same %s exact detail through tab-only browser history", async phase => {
    const current = { ...unifiedPage.value[0], id: "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([current]) });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) => isPackageDetailRequest(input, agent.id)
      ? pending.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
    const dialog = await screen.findByRole("dialog", { name: agent.displayName });
    await waitFor(() => expect(transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, agent.id))).toHaveLength(1));
    const request = transport.fetchMock.mock.calls.find(([input]) => isPackageDetailRequest(input, agent.id))!;
    if (phase === "settled") await act(async () => pending.resolve(Response.json({ ...agent, longDescription: "Retained detail" })));
    act(() => {
      window.history.pushState({}, "", `/agents?detail=${encodeURIComponent("agent:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")}&detailTab=controls`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("dialog", { name: agent.displayName })).toBe(dialog);
    expect(within(dialog).getByRole("tab", { name: "Manage" })).toHaveAttribute("aria-selected", "true");
    expect(request[1]?.signal?.aborted).toBe(false);
    expect(transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, agent.id))).toHaveLength(1);
    if (phase === "pending") await act(async () => pending.resolve(Response.json({ ...agent, longDescription: "Retained detail" })));
    await userEvent.click(within(dialog).getByRole("tab", { name: "Overview" }));
    expect(await within(dialog).findByText("Retained detail")).toBeVisible();
    expect(transport.fetchMock.mock.calls.filter(([input]) => unifiedDetailId(input) !== null)).toHaveLength(0);
  });

  it("clears a failed bookmarked detail when browser history leaves that identity", async () => {
    const id = "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    window.history.replaceState({}, "", `/agents?detail=${encodeURIComponent(id)}`);
    const transport = initialCatalogTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => unifiedDetailId(input) === id
      ? Promise.resolve(Response.json({ code: "inventory_record_not_found", detail: "The bookmarked identity was withdrawn." }, { status: 404 }))
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText("The bookmarked identity was withdrawn.")).toBeVisible();
    act(() => {
      window.history.pushState({}, "", "/agents");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByText("The bookmarked identity was withdrawn.")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([input]) => unifiedDetailId(input) === id)).toHaveLength(1);
  });

  it("shares an off-page logical read between equivalent detail and quarantine bookmarks", async () => {
    const native = powerPlatformRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Shared bookmarked agent");
    const alias = `power_platform:${native.environmentId}:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA`;
    window.history.replaceState({}, "", `/agents?${new URLSearchParams({
      detail: native.id, selectedResource: alias, inventorySnapshot: "pp-snapshot",
    })}`);
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"], unifiedResponse: unifiedRecordsPage([]),
    });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) => unifiedDetailId(input) === native.id
      ? pending.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText("Loading agent details...");
    await screen.findByText(/Restoring 1 bookmarked quarantine selection/);
    expect(transport.fetchMock.mock.calls.filter(([input]) => unifiedDetailId(input) === native.id)).toHaveLength(1);
    await act(async () => pending.resolve(Response.json(native)));
    expect(await screen.findByRole("dialog", { name: native.displayName })).toBeVisible();
    expect(await screen.findByText("1 of 25 exact Copilot Studio agents selected")).toBeVisible();
    expect(transport.fetchMock.mock.calls.filter(([input]) => unifiedDetailId(input) === native.id)).toHaveLength(1);
  });

  it("selects the exact encoded package alias rather than the first published version", async () => {
    const second = { ...agent, id: "Opaque/Second%2Fversion", displayName: "Bookmarked publication" };
    const group = { ...unifiedPage.value[0], id: "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", packages: [agent, second] };
    window.history.replaceState({}, "", `/agents?${new URLSearchParams({ detail: "graph_packages:Opaque%2fSecond%252Fversion" })}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([group]) });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => isPackageDetailRequest(input, second.id)
      ? Promise.resolve(Response.json({ ...second, longDescription: "Exact bookmarked publication details" })) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const dialog = await screen.findByRole("dialog", { name: group.displayName });
    expect(await within(dialog).findByText("Exact bookmarked publication details")).toBeVisible();
    expect(within(dialog).getByRole("combobox", { name: "Published version details" })).toHaveValue(second.id);
    expect(transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, agent.id))).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, second.id))).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([input]) => unifiedDetailId(input) !== null)).toHaveLength(0);
  });

  it("shows and cancels loading for an off-page bookmarked agent", async () => {
    const detailId = unifiedPage.value[0].id;
    window.history.replaceState({}, "", `/agents?detail=${encodeURIComponent(detailId)}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([]) });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) => unifiedDetailId(input) === detailId
      ? pending.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => unifiedDetailId(path) === detailId)).toBe(true));
    expect(screen.getByText("Loading agent details...")).toBeVisible();
    const request = transport.fetchMock.mock.calls.find(([path]) => unifiedDetailId(path) === detailId)!;
    await userEvent.click(screen.getByRole("button", { name: "Users" }));
    await screen.findByRole("button", { name: "Ada" });
    expect(request[1]?.signal?.aborted).toBe(true);
    expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument();
    await act(async () => pending.resolve(Response.json(unifiedPage.value[0])));
    expect(screen.queryByRole("dialog", { name: agent.displayName })).not.toBeInTheDocument();
  });

  it.each(["logical detail", "package detail"] as const)(
    "retires an inventory selection invalidated by bookmarked %s restoration", async phase => {
      const offPage = { ...agent, id: "off-page-package", displayName: "Bookmarked agent" };
      const detail = { ...unifiedPage.value[0], id: `graph_packages:${offPage.id}`, displayName: offPage.displayName, packages: [offPage] };
      window.history.replaceState({}, "", `/agents?detail=${encodeURIComponent(detail.id)}`);
      const transport = appTransport({ revalidatedRoles: viewer.roles });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      transport.fetchMock.mockImplementation((input, init) => {
        if (unifiedDetailId(input) === detail.id) return phase === "logical detail" ? pending.promise : Promise.resolve(Response.json(detail));
        if (isPackageDetailRequest(input, offPage.id)) return pending.promise;
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await screen.findByRole("button", { name: `View details for ${agent.displayName}` });
      const rejectedReads = () => transport.fetchMock.mock.calls.filter(([input]) => phase === "logical detail"
        ? unifiedDetailId(input) === detail.id : isPackageDetailRequest(input, offPage.id));
      await waitFor(() => expect(rejectedReads()).toHaveLength(1));
      const previousSelection = currentInventorySelection(transport.fetchMock);
      expect(screen.getByText("Loading agent details...")).toBeVisible();
      await act(async () => pending.resolve(Response.json({
        code: "selection_invalidated", detail: "Bookmarked inventory expired.",
      }, { status: 409 })));
      expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: `View details for ${agent.displayName}` })).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Agent inventory unavailable" })).toBeVisible();
      expect(rejectedReads()).toHaveLength(1);
      await userEvent.click(screen.getByRole("button", { name: "Reload saved agent inventory" }));
      expect(await screen.findByRole("button", { name: `View details for ${agent.displayName}` })).toBeVisible();
      expect(currentInventorySelection(transport.fetchMock)).not.toBe(previousSelection);
      expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(rejectedReads()).toHaveLength(1);
      expect(refreshRequests(transport.fetchMock)).toEqual([]);
    },
  );

  it.each(["logical detail", "package detail"] as const)(
    "keeps saved inventory usable after an ordinary bookmarked %s failure", async phase => {
      const offPage = { ...agent, id: "off-page-package", displayName: "Bookmarked agent" };
      const detail = { ...unifiedPage.value[0], id: `graph_packages:${offPage.id}`, displayName: offPage.displayName, packages: [offPage] };
      window.history.replaceState({}, "", `/agents?detail=${encodeURIComponent(detail.id)}`);
      const transport = appTransport({ revalidatedRoles: viewer.roles });
      const base = transport.fetchMock.getMockImplementation()!;
      const failure = () => Response.json({ code: "saved_details_unavailable", detail: "Bookmarked details unavailable." }, { status: 503 });
      transport.fetchMock.mockImplementation((input, init) => {
        if (unifiedDetailId(input) === detail.id) return Promise.resolve(phase === "logical detail" ? failure() : Response.json(detail));
        if (isPackageDetailRequest(input, offPage.id)) return Promise.resolve(failure());
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      expect(await screen.findByRole("alert")).toHaveTextContent("Bookmarked details unavailable.");
      expect(screen.getByRole("button", { name: `View details for ${agent.displayName}` })).toBeVisible();
      expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument();
      expect(transport.fetchMock.mock.calls.filter(([input]) => unifiedDetailId(input) === detail.id)).toHaveLength(1);
      expect(refreshRequests(transport.fetchMock)).toEqual([]);
    },
  );

  it.each(["pending", "settled"] as const)(
    "does not retire %s replacement inventory for a late bookmarked-detail invalidation", async phase => {
      const offPage = { ...agent, id: "off-page-package", displayName: "Bookmarked agent" };
      const detail = { ...unifiedPage.value[0], id: `graph_packages:${offPage.id}`, displayName: offPage.displayName, packages: [offPage] };
      window.history.replaceState({}, "", `/agents?detail=${encodeURIComponent(detail.id)}`);
      const transport = appTransport({ revalidatedRoles: viewer.roles });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse(), replacement = deferredResponse();
      let replacing = false;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (unifiedDetailId(input) === detail.id) return replacing ? Response.json(detail) : pending.promise;
        if (isPackageDetailRequest(input, offPage.id)) return Response.json(offPage);
        const response = await base(input, init);
        if (replacing && new URL(input, "http://localhost").pathname === "/api/agent-inventory") await replacement.promise;
        return response;
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await waitFor(() => expect(transport.fetchMock.mock.calls.filter(([input]) => unifiedDetailId(input) === detail.id)).toHaveLength(1));
      const oldSignal = transport.fetchMock.mock.calls.find(([input]) => unifiedDetailId(input) === detail.id)?.[1]?.signal;
      const previousSelection = currentInventorySelection(transport.fetchMock);
      replacing = true;
      await userEvent.click(screen.getByRole("button", { name: "Filters" }));
      await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "displayName:desc");
      const inventoryReads = () => transport.fetchMock.mock.calls.filter(
        ([input]) => new URL(input, "http://localhost").pathname === "/api/agent-inventory",
      );
      await waitFor(() => expect(inventoryReads()).toHaveLength(2));
      const replacementSignal = inventoryReads()[1][1]?.signal;
      if (phase === "settled") await act(async () => replacement.resolve(Response.json({})));
      await act(async () => pending.resolve(Response.json({
        code: "selection_invalidated", detail: "Obsolete bookmark selection expired.",
      }, { status: 409 })));
      expect(replacementSignal?.aborted).toBe(false);
      if (phase === "pending") await act(async () => replacement.resolve(Response.json({})));
      expect(await screen.findByRole("button", { name: `View details for ${agent.displayName}` })).toBeVisible();
      expect(currentInventorySelection(transport.fetchMock)).not.toBe(previousSelection);
      expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
      expect(screen.queryByRole("heading", { name: "Agent inventory unavailable" })).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(await screen.findByRole("dialog", { name: offPage.displayName })).toBeVisible();
      expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument();
      expect(oldSignal?.aborted).toBe(true);
      expect(inventoryReads()).toHaveLength(2);
      expect(refreshRequests(transport.fetchMock)).toEqual([]);
    },
  );

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

  it("clears a failed sign-out error when retrying and after leaving the session", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let signOuts = 0;
    transport.fetchMock.mockImplementation((input, init) => {
      if (input === "/api/auth/logout") return ++signOuts === 1
        ? Promise.resolve(Response.json({ code: "invalid_origin", detail: "Previous session sign-out was rejected." }, { status: 403 }))
        : pending.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await screen.findByText("Previous session sign-out was rejected.");
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.queryByText("Previous session sign-out was rejected.")).not.toBeInTheDocument();
    await act(async () => pending.resolve(new Response(null, { status: 204 })));
    await screen.findByRole("button", { name: "Sign in with Entra ID" });
    expect(screen.queryByText("Previous session sign-out was rejected.")).not.toBeInTheDocument();
    expect(transport.meCalls()).toBe(1);
  });

  it.each(["success", "failure"] as const)("ignores a late logout %s after a concurrent session denial", async outcome => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) => input === "/api/auth/logout"
      ? pending.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    transport.failProtectedReadsWith = 401;
    await act(async () => { await expect(getAgents()).rejects.toMatchObject({ status: 401 }); });
    await screen.findByRole("button", { name: "Sign in with Entra ID" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => pending.resolve(outcome === "success" ? new Response(null, { status: 204 })
      : Response.json({ code: "invalid_origin", detail: "Previous session logout failed." }, { status: 403 })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with Entra ID" })).toBeEnabled();
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

  it.each(["capture", "page"] as const)("does not restart a pending bulk-reference %s for equivalent input", async phase => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let response: Response | undefined;
    let signal: AbortSignal | null | undefined;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const isCapture = input === "/api/agent-inventory/selections"
        && JSON.parse(String(init?.body)).query.operationIdPrefix === "a5331a93";
      const url = selectedInventoryUrl(input);
      const isPage = url.pathname === "/api/agent-inventory" && url.searchParams.get("operationIdPrefix") === "a5331a93";
      if (phase === "capture" ? isCapture : isPage) {
        response = await base(input, init);
        signal = init?.signal;
        return pending.promise;
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const search = screen.getByRole("searchbox", { name: "Search" });
    fireEvent.change(search, { target: { value: "a5331a93" } });
    await waitFor(() => expect(response).toBeDefined());
    const requestSignal = signal;
    const requests = transport.fetchMock.mock.calls.length;
    expect(screen.getByRole("status", { name: "Matching agents" })).toHaveTextContent("Updating...");
    fireEvent.change(search, { target: { value: " REF A5331A93 " } });
    await act(async () => {});
    expect(requestSignal?.aborted).toBe(false);
    expect(transport.fetchMock.mock.calls).toHaveLength(requests);
    await act(async () => pending.resolve(response!));
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
    expect(screen.queryByRole("status", { name: "Updating agent results" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections")).toHaveLength(2);
    expect(agentListRequests(transport.fetchMock)).toHaveLength(2);
  });

  it("preserves bulk-reference paging and matching selection for equivalent input", async () => {
    window.history.replaceState({}, "", "/agents?q=a5331a93");
    const reads = vi.spyOn(AgentInventoryQueries.prototype, "read");
    const roles: SessionUser["roles"] = ["AgentControl.Admin"];
    const records = Array.from({ length: 51 }, (_, index) => ({
      ...unifiedPage.value[0], id: `graph_packages:bulk-package-${index}`, displayName: `Bulk agent ${index}`,
      packages: [{ ...agent, id: `bulk-package-${index}` }],
    }));
    const transport = appTransport({ initialRoles: roles, revalidatedRoles: roles, unifiedResponse: unifiedRecordsPage(records) });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText("Bulk agent 0");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Bulk agent 50");
    await userEvent.click(screen.getByRole("button", { name: "Select all 51 matching published versions" }));
    const previousReads = agentListRequests(transport.fetchMock).length;
    for (const value of ["A5331A93", "ref a5331a93", " REF A5331A93 "]) {
      fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value } });
      await act(async () => {});
      expect(new URLSearchParams(window.location.search).get("page")).toBe("2");
      expect(screen.getByText("Bulk agent 50")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Clear all-matching package selection" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
      expect(agentListRequests(transport.fetchMock)).toHaveLength(previousReads);
    }
    const beforeChange = reads.mock.calls.length;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "b5331a93" } });
    await screen.findByText("Bulk agent 0");
    expect(new URLSearchParams(window.location.search).has("page")).toBe(false);
    expect(screen.queryByRole("button", { name: "Clear all-matching package selection" })).not.toBeInTheDocument();
    expect(reads.mock.calls.slice(beforeChange).map(([, query]) => query.operationIdPrefix)).toEqual(["b5331a93"]);
  });

  it("shows loading rather than an empty bulk-reference result while the next reference is pending", async () => {
    window.history.replaceState({}, "", "/agents?q=a5331a93");
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([]) });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let delayRead = true;
    transport.fetchMock.mockImplementation((input, init) => {
      const url = selectedInventoryUrl(input);
      return delayRead && url.pathname === "/api/agent-inventory" && url.searchParams.get("operationIdPrefix") === "b5331a93"
        ? pending.promise : base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("heading", { name: "No matching agents" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "b5331a93" } });
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(2));
    expect(screen.queryByRole("heading", { name: "No matching agents" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading Copilot agents...")).toBeVisible();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    await act(async () => pending.resolve(Response.json({
      code: "inventory_read_failed", detail: "Bulk-reference inventory could not be loaded.",
    }, { status: 503 })));
    expect(screen.getByText(/^Bulk-reference inventory could not be loaded\./)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Agent inventory unavailable" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "No matching agents" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Matching agents" })).toHaveTextContent("Unavailable");
    expect(screen.queryByText("Loading Copilot agents...")).not.toBeInTheDocument();
    const rejectedSelection = currentInventorySelection(transport.fetchMock);
    delayRead = false;
    await userEvent.click(screen.getByRole("button", { name: "Reload saved agent inventory" }));
    await screen.findByRole("heading", { name: "No matching agents" });
    expect(currentInventorySelection(transport.fetchMock)).not.toBe(rejectedSelection);
    expect(agentListRequests(transport.fetchMock)).toHaveLength(3);
    expect(screen.getByRole("status", { name: "Matching agents" })).toHaveTextContent("0 matching agents");
    expect(screen.queryByText(/^Bulk-reference inventory could not be loaded\./)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "a5331a93" } });
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(4));
    await waitFor(() => expect(screen.getByRole("status", { name: "Matching agents" })).toHaveTextContent("0 matching agents"));
  });

  it.each(["capture", "page"] as const)("does not select retained rows as matching after a bulk-reference %s fails", async phase => {
    window.history.replaceState({}, "", "/agents?q=a5331a93");
    const roles: SessionUser["roles"] = ["AgentControl.Admin"];
    const transport = appTransport({ initialRoles: roles, revalidatedRoles: roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => {
      const isCapture = input === "/api/agent-inventory/selections"
        && JSON.parse(String(init?.body)).query.operationIdPrefix === "b5331a93";
      const url = selectedInventoryUrl(input);
      const isPage = url.pathname === "/api/agent-inventory" && url.searchParams.get("operationIdPrefix") === "b5331a93";
      return (phase === "capture" ? isCapture : isPage) ? Promise.resolve(Response.json({
        code: "inventory_read_failed", detail: "The requested reference could not be loaded.",
      }, { status: 503 })) : base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const originalSelection = currentInventorySelection(transport.fetchMock);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "b5331a93" } });
    await screen.findByText(/^The requested reference could not be loaded\./);
    expect(screen.getByText(agent.displayName)).toBeVisible();
    expect(screen.getByRole("status", { name: "Matching agents" })).toHaveTextContent("Unavailable");
    const selectMatching = screen.getByRole("button", { name: "Select all 1 matching published versions" });
    expect(selectMatching).toBeDisabled();
    await userEvent.click(selectMatching);
    expect(screen.queryByRole("region", { name: "Exact package bulk actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    const reads = agentListRequests(transport.fetchMock).length;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: " REF A5331A93 " } });
    await waitFor(() => expect(selectMatching).toBeEnabled());
    expect(screen.getByRole("status", { name: "Matching agents" })).toHaveTextContent("1 matching agent");
    expect(agentListRequests(transport.fetchMock)).toHaveLength(reads);
    await userEvent.click(selectMatching);
    expect(restorePackageSelection({ ...viewer, roles }, 1)).toMatchObject({
      status: "restored", inventory: { id: originalSelection, allMatching: true },
    });
  });

  it("disables existing all-matching actions after a bulk-reference page read fails", async () => {
    window.history.replaceState({}, "", "/agents?q=a5331a93");
    const records = Array.from({ length: 51 }, (_, index) => ({
      ...unifiedPage.value[0], id: `graph_packages:bulk-package-${index}`, displayName: `Bulk agent ${index}`,
      packages: [{ ...agent, id: `bulk-package-${index}` }],
    }));
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => {
      const url = selectedInventoryUrl(input);
      if (url.pathname === "/api/agent-inventory") return Promise.resolve(url.searchParams.has("cursor")
        ? Response.json({ code: "inventory_read_failed", detail: "The next reference page could not be loaded." }, { status: 503 })
        : Response.json(filterUnifiedResponse(unifiedRecordsPage(records), input)));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText("Bulk agent 0");
    await userEvent.click(screen.getByRole("button", { name: "Select all 51 matching published versions" }));
    expect(screen.getByRole("button", { name: "Block selected packages" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/^The next reference page could not be loaded\./);
    const calls = transport.fetchMock.mock.calls.length;
    const actions = within(screen.getByRole("region", { name: "Exact package bulk actions" }));
    for (const name of ["Block selected packages", "Unblock selected packages", "Manage access"]) {
      const button = actions.getByRole("button", { name });
      expect(button).toBeDisabled();
      await userEvent.click(button);
    }
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls).toHaveLength(calls);
    await userEvent.click(screen.getByRole("button", { name: "Reload saved agent inventory" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Select all 51 matching published versions" })).toBeEnabled());
    expect(screen.queryByRole("region", { name: "Exact package bulk actions" })).not.toBeInTheDocument();
  });

  it.each(["success", "failure"] as const)("discards a replaced bulk-reference %s without poisoning the next search", async outcome => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let delayPrevious = true;
    transport.fetchMock.mockImplementation((input, init) => {
      const url = selectedInventoryUrl(input);
      if (url.pathname === "/api/agent-inventory" && url.searchParams.has("operationIdPrefix")) {
        if (delayPrevious && url.searchParams.get("operationIdPrefix") === "a5331a93") return pending.promise;
        return Promise.resolve(Response.json(selectedInventoryPage(input, unifiedRecordsPage([{
          ...unifiedPage.value[0], displayName: "Current reference agent",
        }]))));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const search = screen.getByRole("searchbox", { name: "Search" });
    fireEvent.change(search, { target: { value: "a5331a93" } });
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(2));
    const previous = agentListRequests(transport.fetchMock).at(-1)!;
    fireEvent.change(search, { target: { value: "b5331a93" } });
    await screen.findByText("Current reference agent");
    expect(previous[1]?.signal?.aborted).toBe(true);
    await act(async () => pending.resolve(outcome === "success" ? Response.json(selectedInventoryPage(previous[0], unifiedPage))
      : Response.json({ code: "unauthorized", detail: "Previous reference denied." }, { status: 401 })));
    expect(screen.getByText("Current reference agent")).toBeVisible();
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(screen.queryByText("Previous reference denied.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
    expect(transport.meCalls()).toBe(1);
    delayPrevious = false;
    fireEvent.change(search, { target: { value: "ref a5331a93" } });
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(4));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled());
    fireEvent.change(search, { target: { value: "REF B5331A93" } });
    await act(async () => {});
    expect(agentListRequests(transport.fetchMock)).toHaveLength(4);
    expect(screen.getByText("Current reference agent")).toBeVisible();
  });

  it("retires bulk-reference rows and pending reads across account changes", async () => {
    window.history.replaceState({}, "", "/agents?q=a5331a93");
    const transport = appTransport({
      revalidatedRoles: viewer.roles, revalidatedUser: { ...viewer, homeAccountId: "replacement-account" },
    });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) => {
      const url = selectedInventoryUrl(input);
      if (url.pathname === "/api/agent-inventory" && url.searchParams.get("operationIdPrefix") === "b5331a93") {
        return transport.meCalls() === 1 ? pending.promise : Promise.resolve(Response.json(selectedInventoryPage(input,
          unifiedRecordsPage([{ ...unifiedPage.value[0], displayName: "Replacement account reference" }]))));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const originalSelection = currentInventorySelection(transport.fetchMock);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "b5331a93" } });
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(2));
    const previous = agentListRequests(transport.fetchMock).at(-1)!;
    await revalidateTransportSession(transport);
    await screen.findByText("Replacement account reference");
    expect(previous[1]?.signal?.aborted).toBe(true);
    await act(async () => pending.resolve(Response.json(selectedInventoryPage(previous[0], unifiedPage))));
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(screen.getByText("Replacement account reference")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "ref a5331a93" } });
    await screen.findByText(agent.displayName);
    expect(agentListRequests(transport.fetchMock)).toHaveLength(4);
    expect(currentInventorySelection(transport.fetchMock)).not.toBe(originalSelection);
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
    await within(dialog).findByRole("option", { name: "Off-preview version" });
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Published version details" }), nativeId);
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

  it("retries a failed inventory export admission with the same intent and without reloading saved inventory", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    let admissions = 0;
    transport.fetchMock.mockImplementation((input, init) => input === "/api/data-exports" && ++admissions === 1
      ? Promise.resolve(Response.json({ code: "request_failed", detail: "Admission response unavailable." }, { status: 500 })) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
    await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    await screen.findByText("Admission response unavailable.");
    const first = inventoryExportRequest(transport.fetchMock);
    expect(screen.getByText(agent.displayName)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reload saved agent inventory" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry export request" }));
    await waitFor(() => expect(admissions).toBe(2));
    expect(inventoryExportRequest(transport.fetchMock)).toEqual(first);
    expect(agentListRequests(transport.fetchMock)).toHaveLength(1);
    expect(screen.queryByText("Admission response unavailable.")).not.toBeInTheDocument();
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

  it.each([false, true])("does not invalidate a replacement inventory when an older export expires (replacement pending: %s)", async pendingReplacement => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const admission = deferredResponse();
    const replacement = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) => {
      if (input === "/api/data-exports") return admission.promise;
      const url = selectedInventoryUrl(input);
      if (pendingReplacement && url.pathname === "/api/agent-inventory" && url.searchParams.get("search") === "Sensitive") {
        return replacement.promise;
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
    await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    await waitFor(() => expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/data-exports")).toHaveLength(1));
    const previousSelection = inventoryExportRequest(transport.fetchMock).selectionId;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Sensitive" } });
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(2));
    const replacementRequest = agentListRequests(transport.fetchMock).at(-1)!;
    if (!pendingReplacement) {
      await waitFor(() => expect(screen.queryByRole("status", { name: "Updating agent results" })).not.toBeInTheDocument());
      await userEvent.click(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` }));
    }
    expect(currentInventorySelection(transport.fetchMock)).not.toBe(previousSelection);
    await act(async () => admission.resolve(Response.json({ code: "selection_invalidated", detail: "Previous selection expired." }, { status: 409 })));
    expect(replacementRequest[1]?.signal?.aborted).toBe(false);
    if (pendingReplacement) {
      await act(async () => replacement.resolve(Response.json(selectedInventoryPage(replacementRequest[0], unifiedPage))));
    }
    expect(screen.getByText(agent.displayName)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Reload saved agent inventory" })).not.toBeInTheDocument();
    if (!pendingReplacement) expect(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` })).toBeChecked();
    expect(agentListRequests(transport.fetchMock)).toHaveLength(2);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/data-exports")).toHaveLength(1);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "" } });
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(3));
    expect(currentInventorySelection(transport.fetchMock)).not.toBe(previousSelection);
  });

  it("uses authorized bulk references for package lists and unified agent exports", async () => {
    window.history.replaceState({}, "", "/agents?q=ref+a5331a93");
    const transport = appTransport({
      initialRoles: ["AgentControl.Viewer"],
      revalidatedRoles: ["AgentControl.Viewer"],
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    mockCsvDownload();
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
      verification: createUnifiedVerification({ graphPackageCount: 1, powerPlatformAgentCount: 0,
        logicalAgentCount: 1 }, { packageMetadata: false }) };
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
    const exportRequest = transport.fetchMock.mock.calls.find(([path]) => path === "/api/data-exports");
    expect(new Headers(exportRequest?.[1]?.headers).get("X-CSRF-Token")).toBe("csrf-1");
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
          return Response.json({ code: invalidation === "missing-reference" ? "export_selection_changed" : "selection_invalidated",
            detail: `${invalidation} invalidated the export.` }, { status: 409 });
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

    expect(screen.queryByRole("dialog", { name: "Inventory diagnostics" })).not.toBeInTheDocument();
    await completeNativeInventoryDownload(download);
    expect(inventoryExportRequest(transport.fetchMock)).toEqual({
      selectionId: currentInventorySelection(transport.fetchMock), kind: "power_platform_agents", idempotencyKey: expect.any(String),
    });
    expect(inventorySelections.get(currentInventorySelection(transport.fetchMock))?.query).toMatchObject({
      environmentId: encodeInventoryFacet("env-a"), search: "linked",
    });
    expect(transport.fetchMock.mock.calls.some(([input]) => input.includes("export.csv"))).toBe(false);
  });

  it.each(["pending", "failed"] as const)("exposes %s Power Platform export recovery outside diagnostics", async outcome => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/sync");
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: verifiedSavedAgentPage() });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation((input, init) => input === "/api/data-exports" && init?.method === "POST"
      ? pending.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    fireEvent.click(screen.getByRole("button", { name: "Export PP agent inventory CSV" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.queryByRole("dialog", { name: "Inventory diagnostics" })).not.toBeInTheDocument();
    const admitted = transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-exports");
    expect(admitted).toHaveLength(1);
    if (outcome === "pending") {
      fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(admitted[0][1]?.signal?.aborted).toBe(true);
      expect(screen.getByRole("alert")).toHaveTextContent("Export request cancelled.");
      await act(async () => pending.resolve(Response.json({ id: "abandoned-export" }, { status: 202 })));
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(transport.fetchMock.mock.calls.some(([input]) => input.includes("abandoned-export"))).toBe(false);
    } else {
      await act(async () => pending.resolve(Response.json({
        code: "export_unavailable", detail: "Export admission is temporarily unavailable.",
      }, { status: 500 })));
      expect(screen.getByRole("alert")).toHaveTextContent("Export admission is temporarily unavailable.");
      expect(screen.getByRole("button", { name: "Retry export request" })).toBeEnabled();
    }
  });

  it.each(["Refresh agents", "Refresh PP agent inventory"] as const)(
    "shows a failed %s command inside the still-open diagnostics and clears it on explicit retry",
    async action => {
      const transport = action === "Refresh agents" ? initialCatalogTransport()
        : appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const path = action === "Refresh agents" ? "/api/agents/refresh-jobs" : "/api/inventory/refresh-jobs";
      let attempts = 0;
      transport.fetchMock.mockImplementation((input, init) => input === path && init?.method === "POST"
        ? ++attempts === 1 ? Promise.resolve(Response.json({
          code: "refresh_unavailable", detail: "Source refresh is temporarily unavailable.",
        }, { status: 503 })) : pending.promise
        : base(input, init));
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("button", { name: /^Sync/ }));
      await userEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
      const dialog = within(screen.getByRole("dialog", { name: "Inventory diagnostics" }));
      await waitFor(() => expect(dialog.getByRole("button", { name: action })).toBeEnabled());
      await userEvent.click(dialog.getByRole("button", { name: action }));
      expect(await dialog.findByRole("alert")).toHaveTextContent("Source refresh is temporarily unavailable.");
      expect(dialog.getByText("Total").nextElementSibling).toHaveTextContent("1");
      await userEvent.click(dialog.getByRole("button", { name: action }));
      expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
      expect(attempts).toBe(2);
      await act(async () => pending.resolve(Response.json(action === "Refresh agents"
        ? completedRefreshJob() : inventoryRefreshJob("succeeded"))));
    },
  );

  it.each(["Refresh agents", "Refresh matching details", "Refresh PP agent inventory", "Resume PP agent refresh"] as const)(
    "admits only one same-batch %s request without cancelling the accepted command",
    async action => {
      const graph = action === "Refresh agents" || action === "Refresh matching details";
      const transport = graph ? initialCatalogTransport() : appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const previousJob = inventoryRefreshJob("waiting_authorization");
      const path = action === "Refresh agents" ? "/api/agents/refresh-jobs"
        : action === "Refresh matching details" ? "/api/agents/refresh-selection"
          : action === "Resume PP agent refresh" ? `/api/inventory/refresh-jobs/${previousJob.id}/resume`
            : "/api/inventory/refresh-jobs";
      transport.fetchMock.mockImplementation((input, init) => {
        if (input === path && init?.method === "POST") return pending.promise;
        if (input === "/api/inventory/refresh-jobs" && !init?.method) return Promise.resolve(Response.json({
          value: [previousJob], lastAttemptAt: null, lastSuccessAt: null,
        }));
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await userEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
      const button = screen.getByRole("button", { name: action });
      await waitFor(() => expect(button).toBeEnabled());
      act(() => { button.click(); button.click(); });
      const commands = () => transport.fetchMock.mock.calls.filter(([input, init]) => input === path && init?.method === "POST");
      await waitFor(() => expect(commands()).toHaveLength(1));
      expect(commands()[0][1]?.signal?.aborted).toBe(false);
      await act(async () => pending.resolve(Response.json(graph ? completedRefreshJob() : inventoryRefreshJob("succeeded"))));
      await waitFor(() => expect(screen.queryByRole("button", { name: graph ? "Refreshing agents" : "Refreshing PP agents..." })).not.toBeInTheDocument());
      expect(commands()).toHaveLength(1);
    },
  );

  it("does not admit a Power Platform export from the inventory being replaced by a same-batch verification", async () => {
    window.history.replaceState({}, "", "/sync");
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: {
      ...unifiedPage,
      sources: { ...unifiedPage.sources, powerPlatform: {
        state: "available", observation: powerPlatformSnapshot(), error: null,
      } },
    } });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let verifying = false;
    transport.fetchMock.mockImplementation((input, init) =>
      verifying && input === "/api/agent-inventory/selections" ? pending.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View diagnostics" }));
    const exportButton = screen.getByRole("button", { name: "Export PP agent inventory CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    verifying = true;
    act(() => {
      screen.getByRole("button", { name: "Verify saved inventory" }).click();
      exportButton.click();
    });
    await waitFor(() => expect(exportButton).toBeDisabled());
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/data-exports")).toHaveLength(0);
    await act(async () => pending.resolve(Response.json({
      code: "unavailable", detail: "Saved inventory temporarily unavailable.",
    }, { status: 503 })));
    expect(exportButton).toBeDisabled();
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/data-exports")).toHaveLength(0);
  });

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "uses one observer for an inspected latest source job and reloads only a %s publication",
    async outcome => {
      vi.useFakeTimers();
      const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      window.history.replaceState({}, "", `/sync?powerPlatformJob=${id.toUpperCase()}`);
      const transport = appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
      const base = transport.fetchMock.getMockImplementation()!;
      let currentJob = inventoryRefreshJob("running", id);
      const path = `/api/inventory/refresh-jobs/${currentJob.id}`;
      transport.fetchMock.mockImplementation((input, init) => {
        if (input.toLowerCase() === path) return Promise.resolve(Response.json(currentJob));
        if (input === "/api/inventory/refresh-jobs") return Promise.resolve(Response.json({
          value: [currentJob], lastAttemptAt: null, lastSuccessAt: null,
        }));
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      const reads = () => transport.fetchMock.mock.calls.filter(([input]) => input.toLowerCase() === path).length;
      const captures = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections").length;
      expect(reads()).toBe(1);
      expect(within(screen.getByRole("region", { name: "Power Platform source job" })).getByRole("status")).toHaveTextContent("running");
      const before = captures();
      await act(() => vi.advanceTimersByTimeAsync(2500));
      expect(reads()).toBe(2);
      expect(captures()).toBe(before);
      currentJob = inventoryRefreshJob(outcome, currentJob.id);
      await act(() => vi.advanceTimersByTimeAsync(2500));
      expect(reads()).toBe(3);
      expect(captures()).toBe(before + (outcome === "succeeded" ? 1 : 0));
      fireEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
      expect(screen.getByText(new RegExp(`Latest agent refresh: ${outcome}`))).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Close inventory diagnostics" }));
      fireEvent.click(screen.getByRole("button", { name: "Close source job" }));
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(reads()).toBe(3);
      expect(captures()).toBe(before + (outcome === "succeeded" ? 1 : 0));
    },
  );

  it.each(["success", "authorization failure"] as const)(
    "cancels the superseded background source read and ignores its late %s after exact-job cancellation",
    async outcome => {
      vi.useFakeTimers();
      window.history.replaceState({}, "", "/sync");
      const transport = appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      let currentJob = inventoryRefreshJob("running");
      let reads = 0;
      const path = `/api/inventory/refresh-jobs/${currentJob.id}`;
      transport.fetchMock.mockImplementation((input, init) => {
        if (input === path) return ++reads === 1 ? pending.promise : Promise.resolve(Response.json(currentJob));
        if (input === `${path}/cancel`) {
          currentJob = inventoryRefreshJob("cancelled");
          return Promise.resolve(Response.json(currentJob));
        }
        if (input === "/api/inventory/refresh-jobs") return Promise.resolve(Response.json({
          value: [currentJob], lastAttemptAt: null, lastSuccessAt: null,
        }));
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      await act(() => vi.advanceTimersByTimeAsync(2500));
      const retired = transport.fetchMock.mock.calls.find(([input]) => input === path)!;
      expect(reads).toBe(1);
      currentJob = inventoryRefreshJob("waiting_authorization");
      fireEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
      fireEvent.click(screen.getByRole("button", { name: "Inspect source job" }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(retired[1]?.signal?.aborted).toBe(true);
      const captures = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections").length;
      const before = captures();
      fireEvent.click(screen.getByRole("button", { name: "Cancel source job" }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(within(screen.getByRole("region", { name: "Power Platform source job" })).getByRole("status")).toHaveTextContent("cancelled");
      expect(captures()).toBe(before);
      const sessions = transport.meCalls();
      await act(async () => pending.resolve(outcome === "success"
        ? Response.json(inventoryRefreshJob("succeeded"))
        : Response.json({ code: "unauthorized", detail: "Retired source read." }, { status: 401 })));
      expect(transport.meCalls()).toBe(sessions);
      expect(captures()).toBe(before);
      fireEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
      expect(screen.getByText(/Latest agent refresh: cancelled/)).toBeVisible();
    },
  );

  it("reconciles an inspected completion that arrives before older latest-job history", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/sync?powerPlatformJob=inspected-job");
    const transport = appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const pendingExact = deferredResponse();
    const completed = inventoryRefreshJob("succeeded", "inspected-job");
    let delayHistory = true;
    const path = `/api/inventory/refresh-jobs/${completed.id}`;
    transport.fetchMock.mockImplementation((input, init) => {
      if (input === path) return pendingExact.promise;
      if (input === "/api/inventory/refresh-jobs") return delayHistory ? pending.promise.then(response => response.clone())
        : Promise.resolve(Response.json({ value: [completed], lastAttemptAt: null, lastSuccessAt: null }));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const captures = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections").length;
    const before = captures();
    await act(async () => pendingExact.resolve(Response.json(completed)));
    expect(within(screen.getByRole("region", { name: "Power Platform source job" })).getByRole("status")).toHaveTextContent("succeeded");
    expect(captures()).toBe(before + 1);
    delayHistory = false;
    await act(async () => pending.resolve(Response.json({
      value: [inventoryRefreshJob("running", completed.id)], lastAttemptAt: null, lastSuccessAt: null,
    })));
    fireEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    expect(screen.getByText(/Latest agent refresh: succeeded/)).toBeVisible();
    expect(captures()).toBe(before + 1);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === path)).toHaveLength(1);
    expect(captures()).toBe(before + 1);
  });

  it.each([
    ["succeeded", "same-job"], ["succeeded", "new-job"],
    ["failed", "same-job"], ["cancelled", "same-job"], ["waiting_authorization", "same-job"],
  ] as const)("reconciles a history-discovered %s %s without retaining stale inventory or reloading twice", async (status, id) => {
    vi.useFakeTimers();
    const transport = appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
    const base = transport.fetchMock.getMockImplementation()!;
    let latest = inventoryRefreshJob("running", "same-job");
    transport.fetchMock.mockImplementation((input, init) => input === "/api/inventory/refresh-jobs"
      ? Promise.resolve(Response.json({ value: [latest], lastAttemptAt: null, lastSuccessAt: null })) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const captures = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections").length;
    const before = captures();
    latest = inventoryRefreshJob(status, id);
    fireEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    expect(screen.getByText(new RegExp(`Latest agent refresh: ${status.replaceAll("_", " ")}`))).toBeVisible();
    const expected = before + (status === "succeeded" ? 1 : 0);
    expect(captures()).toBe(expected);
    fireEvent.click(screen.getByRole("button", { name: "Close inventory diagnostics" }));
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(captures()).toBe(expected);
    expect(transport.fetchMock.mock.calls.some(([input, init]) => input === "/api/inventory/refresh-jobs"
      && init?.method === "POST")).toBe(false);
  });

  it("reconciles a completed non-latest source bookmark once per session without reloading it on reopening", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const transport = appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
    const base = transport.fetchMock.getMockImplementation()!;
    const completed = inventoryRefreshJob("succeeded", "completed-bookmark");
    const latest = inventoryRefreshJob("waiting_authorization", "newer-job");
    transport.fetchMock.mockImplementation((input, init) => {
      if (input === `/api/inventory/refresh-jobs/${completed.id}`) return Promise.resolve(Response.json(completed));
      if (input === "/api/inventory/refresh-jobs") return Promise.resolve(Response.json({
        value: [latest, completed], lastAttemptAt: null, lastSuccessAt: null,
      }));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const captures = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections").length;
    const before = captures();
    const open = () => {
      window.history.pushState({}, "", `/sync?powerPlatformJob=${completed.id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
    act(open);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(within(screen.getByRole("region", { name: "Power Platform source job" })).getByRole("status")).toHaveTextContent("succeeded");
    expect(captures()).toBe(before + 1);
    fireEvent.click(screen.getByRole("button", { name: "Close source job" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    act(open);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(captures()).toBe(before + 1);
    fireEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    expect(screen.getByText(/Latest agent refresh: waiting authorization/)).toBeVisible();
    await revalidateTransportSession(transport);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const afterRevalidation = captures();
    act(open);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(captures()).toBe(afterRevalidation + 1);
    expect(transport.fetchMock.mock.calls.some(([input, init]) => input === "/api/inventory/refresh-jobs" && init?.method === "POST")).toBe(false);
  });

  it("hands commands to the source inspector only after workspace admission settles", async () => {
    window.history.replaceState({}, "", "/sync");
    const transport = appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const waiting = inventoryRefreshJob("waiting_authorization");
    const path = `/api/inventory/refresh-jobs/${waiting.id}`;
    transport.fetchMock.mockImplementation((input, init) => {
      if (input === `${path}/resume`) return pending.promise;
      if (input === path) return Promise.resolve(Response.json(waiting));
      if (input === "/api/inventory/refresh-jobs") return Promise.resolve(Response.json({
        value: [waiting], lastAttemptAt: null, lastSuccessAt: null,
      }));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View diagnostics" }));
    await userEvent.click(await screen.findByRole("button", { name: "Resume PP agent refresh" }));
    await userEvent.click(screen.getByRole("button", { name: "Inspect source job" }));
    expect(screen.getByText("Waiting for the current source command…")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Resume source job" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === path)).toHaveLength(0);
    await act(async () => pending.resolve(Response.json(waiting)));
    expect(await screen.findByRole("button", { name: "Resume source job" })).toBeEnabled();
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === path)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    expect(screen.getByRole("button", { name: "Resume PP agent refresh" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh PP agent inventory" })).toBeDisabled();
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === `${path}/resume`)).toHaveLength(1);
  });

  it.each(["running", "waiting_authorization", "succeeded", "failed", "cancelled"] as const)(
    "hands a retried %s source job to the inspector without discarding or rereading its response",
    async status => {
      vi.useFakeTimers();
      const initial = inventoryRefreshJob("failed", "failed-job");
      const submitted = { ...inventoryRefreshJob(status, "new-job"), message: "Accepted new source refresh" };
      window.history.replaceState({}, "", `/sync?powerPlatformJob=${initial.id}`);
      const transport = appTransport({ revalidatedRoles: viewer.roles, inventoryReadAuthorized: true });
      const base = transport.fetchMock.getMockImplementation()!;
      const path = `/api/inventory/refresh-jobs/${submitted.id}`;
      let latest = initial;
      transport.fetchMock.mockImplementation((input, init) => {
        if (input === `/api/inventory/refresh-jobs/${initial.id}`) return Promise.resolve(Response.json(initial));
        if (input === path) return Promise.resolve(Response.json({ code: "unavailable", detail: "Status read failed." }, { status: 503 }));
        if (input === "/api/inventory/refresh-jobs") {
          if (init?.method === "POST") {
            latest = submitted;
            return Promise.resolve(Response.json(submitted));
          }
          return Promise.resolve(Response.json({ value: [latest], lastAttemptAt: null, lastSuccessAt: null }));
        }
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      const captures = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections").length;
      const before = captures();
      const retry = screen.getByRole("button", { name: "Start a new source refresh" });
      act(() => { retry.click(); retry.click(); });
      await act(() => vi.advanceTimersByTimeAsync(0));
      const inspector = within(screen.getByRole("region", { name: "Power Platform source job" }));
      expect(inspector.getByRole("status")).toHaveTextContent(`${status.replaceAll("_", " ")} — Accepted new source refresh`);
      expect(new URLSearchParams(window.location.search).get("powerPlatformJob")).toBe(submitted.id);
      expect(transport.fetchMock.mock.calls.filter(([input, init]) => input === "/api/inventory/refresh-jobs" && init?.method === "POST")).toHaveLength(1);
      expect(transport.fetchMock.mock.calls.filter(([input]) => input === path)).toHaveLength(0);
      expect(captures()).toBe(before + (status === "succeeded" ? 1 : 0));
      await act(() => vi.advanceTimersByTimeAsync(2499));
      expect(transport.fetchMock.mock.calls.filter(([input]) => input === path)).toHaveLength(0);
      await act(() => vi.advanceTimersByTimeAsync(5001));
      expect(transport.fetchMock.mock.calls.filter(([input]) => input === path)).toHaveLength(status === "running" ? 1 : 0);
      expect(captures()).toBe(before + (status === "succeeded" ? 1 : 0));
      if (status === "running") expect(inspector.getByRole("alert")).toHaveTextContent("Status read failed.");
      fireEvent.click(screen.getByRole("button", { name: "Close source job" }));
      act(() => {
        window.history.pushState({}, "", `/sync?powerPlatformJob=${submitted.id}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(within(screen.getByRole("region", { name: "Power Platform source job" })).getByRole("alert")).toHaveTextContent("Status read failed.");
      expect(transport.fetchMock.mock.calls.filter(([input]) => input === path)).toHaveLength(status === "running" ? 2 : 1);
      expect(captures()).toBe(before + (status === "succeeded" ? 1 : 0));
    },
  );

  it.each((["read", "resume", "cancel", "retry"] as const).flatMap(action =>
    (["job change", "account change"] as const).map(boundary => ({ action, boundary })),
  ))("retires an inspected $action on $boundary without admitting its late authorization failure", async ({ action, boundary }) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState({}, "", "/sync?powerPlatformJob=retired-job");
    const transport = appTransport({
      revalidatedRoles: viewer.roles, inventoryReadAuthorized: true,
      revalidatedUser: { ...viewer, homeAccountId: "replacement-account", tenantId: "replacement-tenant" },
    });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const initial = inventoryRefreshJob(action === "retry" ? "failed" : "waiting_authorization", "retired-job");
    const next = { ...inventoryRefreshJob("failed", "current-job"), message: "Current source job" };
    const requestPath = action === "read" ? `/api/inventory/refresh-jobs/${initial.id}`
      : action === "retry" ? "/api/inventory/refresh-jobs" : `/api/inventory/refresh-jobs/${initial.id}/${action}`;
    const isRetiredRequest = (path: string, init?: RequestInit) =>
      path === requestPath && (action === "read" || init?.method === "POST");
    transport.fetchMock.mockImplementation((input, init) => {
      if (isRetiredRequest(input, init)) return pending.promise;
      if (input === `/api/inventory/refresh-jobs/${initial.id}`) return Promise.resolve(Response.json(initial));
      if (input === `/api/inventory/refresh-jobs/${next.id}`) return Promise.resolve(Response.json(next));
      if (input === "/api/inventory/refresh-jobs") return Promise.resolve(Response.json({
        value: [initial], lastAttemptAt: null, lastSuccessAt: null,
      }));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    if (action !== "read") {
      fireEvent.click(screen.getByRole("button", { name: action === "resume" ? "Resume source job"
        : action === "cancel" ? "Cancel source job" : "Start a new source refresh" }));
    }
    const retired = transport.fetchMock.mock.calls.find(([path, init]) => isRetiredRequest(path, init))!;
    expect(retired[1]?.signal?.aborted).toBe(false);
    if (boundary === "account change") await revalidateTransportSession(transport);
    act(() => {
      window.history.pushState({}, "", `/sync?powerPlatformJob=${next.id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(retired[1]?.signal?.aborted).toBe(true);
    expect(screen.getByText(/Current source job/)).toBeVisible();
    const captures = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections").length;
    const before = captures();
    const sessions = transport.meCalls();
    await act(async () => pending.resolve(Response.json({ code: "unauthorized", detail: "Retired source authorization." }, { status: 401 })));
    expect(transport.meCalls()).toBe(sessions);
    expect(captures()).toBe(before);
    expect(screen.getByText(/Current source job/)).toBeVisible();
    expect(screen.queryByText(/Retired source authorization/)).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([path, init]) => isRetiredRequest(path, init))).toHaveLength(1);
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
      expect(transport.fetchMock.mock.calls.find(([path, init]) =>
        path === requestPath && init?.method === "POST")?.[1]?.signal?.aborted).toBe(true);
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
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await waitFor(() => expect(delayedHistoryRequested).toBe(true));
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

  it.each(["failure", "cancellation"] as const)("reports Power Platform history %s without discarding saved agent inventory", async outcome => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const message = outcome === "failure" ? "Synthetic inventory history failure." : "The request was cancelled.";
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/inventory/refresh-jobs") {
        if (outcome === "cancellation") throw new DOMException("History transport cancelled.", "AbortError");
        return Response.json({
          code: "inventory_history_unavailable",
          detail: message,
        }, { status: 503 });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText(agent.displayName)).toBeVisible();
    const historyError = `Unable to load Power Platform agent refresh history: ${message}`;
    expect(await screen.findByText(historyError, { exact: false })).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Sensitive" } });
    await waitFor(() => expect(screen.queryByRole("status", { name: "Updating agent results" })).not.toBeInTheDocument());
    expect(screen.getByText(historyError, { exact: false })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByRole("heading", { name: "Agent inventory sources" })).toBeVisible();
    expect(within(screen.getByRole("dialog", { name: "Inventory diagnostics" })).getByRole("alert"))
      .toHaveTextContent(historyError);
    expect(screen.getByText("Total").nextElementSibling).toHaveTextContent("1");
  });

  it("labels cancelled refresh history as last observed and recovers without replaying provider work or late results", async () => {
    vi.useFakeTimers();
    const client = savedQueries.createSavedQueryClient();
    vi.spyOn(savedQueries, "createSavedQueryClient").mockReturnValue(client);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let delayHistory = false;
    let historyReads = 0;
    transport.fetchMock.mockImplementation((input, init) => {
      if (input === "/api/inventory/refresh-jobs") {
        historyReads += 1;
        return delayHistory ? pending.promise : Promise.resolve(Response.json({
          value: [inventoryRefreshJob("waiting_authorization")], lastAttemptAt: null, lastSuccessAt: null,
        }));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText(agent.displayName)).toBeVisible();
    const before = historyReads;
    delayHistory = true;
    fireEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(historyReads).toBe(before + 1);
    await act(async () => {
      await client.cancelQueries({ queryKey: ["saved", "inventory-refresh-jobs"] });
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load Power Platform agent refresh history: The request was cancelled.");
    expect(screen.queryByRole("status", { name: "Background refresh" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    expect(screen.getByText(/Last observed agent refresh: waiting authorization/)).toBeVisible();
    expect(screen.queryByText(/Latest agent refresh/)).not.toBeInTheDocument();
    expect(historyReads).toBe(before + 1);

    delayHistory = false;
    fireEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(historyReads).toBe(before + 2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/Latest agent refresh: waiting authorization/)).toBeVisible();
    const captures = transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections").length;
    await act(async () => {
      pending.resolve(Response.json({
        value: [inventoryRefreshJob("succeeded")], lastAttemptAt: null, lastSuccessAt: null,
      }));
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText(/Latest agent refresh: waiting authorization/)).toBeVisible();
    expect(historyReads).toBe(before + 2);
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections")).toHaveLength(captures);
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("renders inventory without waiting for history and ignores superseded history failures", async () => {
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
    expect(await screen.findByText(agent.displayName)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Loading agents" })).not.toBeInTheDocument();
    act(() => {
      window.history.pushState({}, "", "/agents?q=Sensitive");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByText(agent.displayName)).toBeVisible();
    expect(historyRequests).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "Users" }));
    await screen.findByRole("button", { name: "Ada" });
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    await waitFor(() => expect(historyRequests).toBe(2));

    await act(async () => {
      releaseHistory(Response.json({
        code: "inventory_history_unavailable",
        detail: "Superseded history failure.",
      }, { status: 503 }));
    });
    expect(screen.queryByText(/Unable to load Power Platform agent refresh history/)).not.toBeInTheDocument();
    expect(screen.getByText(agent.displayName)).toBeVisible();
  });

  it.each(["selection_invalidated", "inventory_changed"] as const)(
    "invalidates a rejected matching-detail selection and permits saved-only recovery for %s",
    async code => {
      const transport = initialCatalogTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const attempts: { selectionId: string; ids?: string[]; recordIds?: string[] }[] = [];
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (input === "/api/agents/refresh-selection" && init?.method === "POST") {
          attempts.push(JSON.parse(String(init.body)));
          if (attempts.length === 1) return Response.json({ code, detail: code }, { status: 409 });
        }
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);

      await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await userEvent.click(screen.getByText("View diagnostics"));
      const dialog = screen.getByRole("dialog", { name: "Inventory diagnostics" });
      const refresh = within(dialog).getByRole("button", { name: "Refresh matching details" });
      await waitFor(() => expect(refresh).toBeEnabled());
      await userEvent.click(refresh);
      const receipt = within(dialog).getByRole("region", { name: "Saved agent inventory verification" });
      await waitFor(() => expect(within(receipt).getByRole("alert"))
        .toHaveTextContent("The saved inventory selection is no longer available. Reload saved inventory."));
      expect(within(dialog).getByRole("button", { name: "Refresh matching details" })).toBeDisabled();
      expect(attempts).toHaveLength(1);

      const captures = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections").length;
      const before = captures();
      const recoveryStart = transport.fetchMock.mock.calls.length;
      await userEvent.click(within(receipt).getByRole("button", { name: "Reload saved inventory" }));
      await waitFor(() => expect(captures()).toBeGreaterThan(before));
      await waitFor(() => expect(within(receipt).queryByRole("alert")).not.toBeInTheDocument());
      expect(within(dialog).getByRole("button", { name: "Refresh matching details" })).toBeDisabled();
      expect(transport.fetchMock.mock.calls.slice(recoveryStart)
        .filter(([path, init]) => init?.method === "POST" && path !== "/api/agent-inventory/selections")).toEqual([]);
      expect(attempts).toHaveLength(1);

      await userEvent.click(within(dialog).getByRole("button", { name: "Browse agents" }));
      const checkbox = await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` });
      expect(checkbox).not.toBeChecked();
      await userEvent.click(checkbox);
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await userEvent.click(screen.getByText("View diagnostics"));
      const retry = screen.getByRole("button", { name: "Refresh matching details" });
      await waitFor(() => expect(retry).toBeEnabled());
      await userEvent.click(retry);
      await waitFor(() => expect(attempts).toHaveLength(2));
      expect(attempts[1]).toEqual({ ...attempts[0], selectionId: expect.any(String) });
      expect(attempts[1].selectionId).not.toBe(attempts[0].selectionId);
    },
  );

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

  it("restores a history selection only after its search stops being deferred", async () => {
    window.history.replaceState({}, "", "/agents?q=other");
    const owner = { ...viewer, roles: ["AgentControl.Admin"] as SessionUser["roles"] };
    const inventory = { id: "history-pin",
      query: JSON.stringify({ inventoryScope: "catalog", sortBy: "displayName", sortDirection: "asc" }),
      page: 0, count: 40, allMatching: true };
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/agent-inventory") return Response.json({
        ...unifiedPage, selection: { ...unifiedPage.selection, id: url.searchParams.get("selectionId") ?? "other-pin" },
        counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 40 },
      });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    expect(storePackageSelection(owner, [], inventory)).toBe(true);
    const before = agentListRequests(transport.fetchMock).length;

    act(() => {
      window.history.pushState({}, "", "/agents?selectionState=session&selectionCount=40");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(await screen.findByRole("button", { name: "Clear all-matching package selection" })).toBeEnabled();
    expect(screen.queryByText(/could not be restored/)).not.toBeInTheDocument();
    expect(restorePackageSelection(owner, 40)).toMatchObject({ status: "restored", inventory });
    const reads = agentListRequests(transport.fetchMock).slice(before);
    expect(reads).toHaveLength(1);
    expect(new URL(String(reads[0][0]), "http://localhost").searchParams.get("selectionId")).toBe(inventory.id);
  });

  it.each(["filtered", "group"] as const)("retires stored targets when the %s selection is explicitly cleared", async kind => {
    const owner = { ...viewer, roles: ["AgentControl.Admin"] as SessionUser["roles"] };
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const group = { ...unifiedPage.value[0], id: "agent:11111111-1111-4111-8111-111111111111",
      packageCount: 40, packagesComplete: false, memberCount: 40 };
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Response.json({
        ...unifiedPage, value: [group], counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 40 },
      });
      if (input === "/api/agents/mutation-selection") return Response.json({ count: 40 });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const selection = await screen.findByRole(kind === "filtered" ? "button" : "checkbox", {
      name: kind === "filtered" ? "Select all 40 matching published versions" : `Select ${agent.displayName}`,
    });
    await userEvent.click(selection);
    await waitFor(() => expect(restorePackageSelection(owner, 40).status).toBe("restored"));
    const reads = agentListRequests(transport.fetchMock).length;
    await userEvent.click(selection);
    expect(restorePackageSelection(owner, 40)).toEqual({ status: "unavailable" });
    expect(screen.queryByText(/selected packages are preserved/)).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).has("selectionState")).toBe(false);
    expect(agentListRequests(transport.fetchMock)).toHaveLength(reads);
  });

  it("omits a restorable route marker when selection storage fails", async () => {
    const transport = accessEditorTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const select = await screen.findByRole("button", { name: "Select all 1 matching published versions" });
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new DOMException("Storage denied.", "SecurityError"); });
    await userEvent.click(select);
    expect(await screen.findByText(/selection remains active, but could not be preserved/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear all-matching package selection" })).toBeEnabled();
    expect(new URLSearchParams(window.location.search).has("selectionState")).toBe(false);
    expect(new URLSearchParams(window.location.search).has("selectionCount")).toBe(false);
    expect(screen.getByRole("button", { name: "Block selected packages" })).toBeEnabled();
  });

  it("retries a failed group count once without reloading inventory or reviving its error", async () => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const retry = deferredResponse();
    const group = { ...unifiedPage.value[0], id: "agent:11111111-1111-4111-8111-111111111111",
      packageCount: 40, packagesComplete: false, memberCount: 40 };
    let counts = 0;
    transport.fetchMock.mockImplementation((input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Promise.resolve(Response.json({
        ...unifiedPage, value: [group], counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 40 },
      }));
      if (input === "/api/agents/mutation-selection") return ++counts === 1
        ? Promise.resolve(Response.json({ code: "count_failed", detail: "Count temporarily unavailable." }, { status: 503 }))
        : retry.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
    const retryButton = await screen.findByRole("button", { name: "Retry selected package count" });
    const reads = agentListRequests(transport.fetchMock).length;
    act(() => { retryButton.click(); retryButton.click(); });
    await waitFor(() => expect(counts).toBe(2));
    expect(screen.queryByText(/Count temporarily unavailable/)).not.toBeInTheDocument();
    expect(screen.getByText("Counting selected package targets...")).toBeInTheDocument();
    await act(async () => retry.resolve(Response.json({ count: 40 })));
    expect(await screen.findByRole("button", { name: "Block selected packages" })).toBeEnabled();
    expect(agentListRequests(transport.fetchMock)).toHaveLength(reads);
    expect(counts).toBe(2);
  });

  it.each(["selection_invalidated", "inventory_changed"])("retires a restored group after its count reports %s", async code => {
    const owner = { ...viewer, roles: ["AgentControl.Admin"] as SessionUser["roles"] };
    const group = { ...unifiedPage.value[0], id: "agent:11111111-1111-4111-8111-111111111111",
      packageCount: 40, packagesComplete: false, memberCount: 40 };
    const inventory = { id: unifiedPage.selection.id,
      query: JSON.stringify({ inventoryScope: "catalog", sortBy: "displayName", sortDirection: "asc" }),
      page: 0, count: 40, groups: [group.id] };
    expect(storePackageSelection(owner, [], inventory)).toBe(true);
    window.history.replaceState({}, "", "/agents?selectionState=session&selectionCount=40");
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Response.json({
        ...unifiedPage, value: [group], counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 40 },
      });
      if (input === "/api/agents/mutation-selection") return Response.json({ code, detail: "Saved group is no longer current." }, { status: 409 });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Reload saved agent inventory" })).toBeEnabled();
    expect(screen.queryByRole("checkbox", { name: `Select ${agent.displayName}` })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry selected package count" })).not.toBeInTheDocument();
    expect(screen.queryByText(/selected packages were restored/)).not.toBeInTheDocument();
    expect(restorePackageSelection(owner, 40)).toEqual({ status: "unavailable" });
    expect(agentListRequests(transport.fetchMock)).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agents/mutation-selection")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Reload saved agent inventory" }));
    expect(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` })).not.toBeChecked();
    expect(agentListRequests(transport.fetchMock)).toHaveLength(2);
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agents/mutation-selection")).toHaveLength(1);
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it.each(["search", "sorting"])("does not relabel a stored group with replacement %s while inventory is pending", async change => {
    const owner = { ...viewer, roles: ["AgentControl.Admin"] as SessionUser["roles"] };
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const group = { ...unifiedPage.value[0], id: "agent:11111111-1111-4111-8111-111111111111",
      packageCount: 40, packagesComplete: false, memberCount: 40 };
    const page = { ...unifiedPage, value: [group], counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 40 } };
    transport.fetchMock.mockImplementation((input, init) => {
      const url = selectedInventoryUrl(input);
      if (url.pathname === "/api/agent-inventory") return url.searchParams.get("search") === "replacement"
        || url.searchParams.get("sortDirection") === "desc" ? pending.promise : Promise.resolve(Response.json(selectedInventoryPage(input, page)));
      if (input === "/api/agents/mutation-selection") return Promise.resolve(Response.json({ count: 40 }));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
    await waitFor(() => expect(restorePackageSelection(owner, 40).status).toBe("restored"));
    const original = restorePackageSelection(owner, 40);
    if (change === "search") fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "replacement" } });
    else await userEvent.click(screen.getByRole("button", { name: "Sort by Agent" }));
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(2));
    expect(restorePackageSelection(owner, 40)).toEqual(original);
    expect(new URLSearchParams(window.location.search).has("selectionState")).toBe(false);
    await act(async () => pending.resolve(Response.json(selectedInventoryPage(String(agentListRequests(transport.fetchMock)[1][0]), page))));
    expect(restorePackageSelection(owner, 40)).toEqual(original);
    expect(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` })).not.toBeChecked();
  });

  it("does not revive a settled group count while reselecting the same group", async () => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const group = { ...unifiedPage.value[0], id: "agent:11111111-1111-4111-8111-111111111111",
      packageCount: 40, packagesComplete: false, memberCount: 40 };
    let counts = 0;
    transport.fetchMock.mockImplementation((input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Promise.resolve(Response.json({
        ...unifiedPage, value: [group], counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 40 },
      }));
      if (input === "/api/agents/mutation-selection") return ++counts === 1 ? Promise.resolve(Response.json({ count: 40 })) : pending.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const checkbox = await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` });
    await userEvent.click(checkbox);
    expect(await screen.findByRole("button", { name: "Block selected packages" })).toBeEnabled();
    await userEvent.click(checkbox);
    await userEvent.click(checkbox);
    await waitFor(() => expect(counts).toBe(2));
    expect(screen.getByText("Counting selected package targets...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Block selected packages" })).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).has("selectionState")).toBe(false);
    await act(async () => pending.resolve(Response.json({ count: 41 })));
    expect(await screen.findByText("41 published versions selected")).toBeInTheDocument();
    expect(agentListRequests(transport.fetchMock)).toHaveLength(1);
  });

  it.each(["account", "tenant", "roles"] as const)("retires group count and storage across A-B-A %s changes", async boundary => {
    const owner = { ...viewer, roles: ["AgentControl.Admin"] as SessionUser["roles"] };
    const replacement = { ...owner, ...(boundary === "account" ? { homeAccountId: "other-account" }
      : boundary === "tenant" ? { tenantId: "other-tenant" } : { roles: ["AgentControl.Viewer"] as SessionUser["roles"] }) };
    let currentUser = owner;
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const group = { ...unifiedPage.value[0], id: "agent:11111111-1111-4111-8111-111111111111",
      packageCount: 40, packagesComplete: false, memberCount: 40 };
    let counts = 0;
    transport.fetchMock.mockImplementation((input, init) => {
      if (input === "/api/me") return Promise.resolve(Response.json({ user: currentUser, csrfToken: "csrf-account", roleAssignmentRequired: false }));
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Promise.resolve(Response.json({
        ...unifiedPage, value: [group], counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 40 },
      }));
      if (input === "/api/agents/mutation-selection") return ++counts === 1 ? Promise.resolve(Response.json({ count: 40 })) : pending.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
    await waitFor(() => expect(restorePackageSelection(owner, 40).status).toBe("restored"));
    currentUser = replacement;
    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` })).not.toBeChecked();
    expect(restorePackageSelection(owner, 40)).toEqual({ status: "unavailable" });
    currentUser = owner;
    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    const checkbox = await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` });
    expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    await waitFor(() => expect(counts).toBe(2));
    const request = transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agents/mutation-selection")[1];
    currentUser = replacement;
    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` })).not.toBeChecked();
    expect(request[1]?.signal?.aborted).toBe(true);
    currentUser = owner;
    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` });
    await act(async () => pending.resolve(Response.json({ count: 40 })));
    expect(screen.queryByRole("button", { name: "Block selected packages" })).not.toBeInTheDocument();
    expect(screen.queryByText(/selected packages are preserved/)).not.toBeInTheDocument();
    expect(restorePackageSelection(owner, 40)).toEqual({ status: "unavailable" });
    expect(counts).toBe(2);
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

  it.each((["filtered", "group"] as const).flatMap(kind =>
    (["empty", "exact"] as const).map(route => [kind, route] as const)))(
    "replaces a pinned %s selection with the %s selection from browser history without reloading inventory",
    async (kind, route) => {
      const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
      const group = { ...unifiedPage.value[0], id: "agent:11111111-1111-4111-8111-111111111111",
        packageCount: 40, packagesComplete: false, memberCount: 40 };
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Response.json({
          ...unifiedPage, value: [group], counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 40 },
        });
        if (input === "/api/agents/mutation-selection") return Response.json({ count: 40 });
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole(kind === "filtered" ? "button" : "checkbox", {
        name: kind === "filtered" ? "Select all 40 matching published versions" : `Select ${agent.displayName}`,
      }));
      await waitFor(() => expect(new URLSearchParams(window.location.search).get("selectionState")).toBe("session"));
      const reads = agentListRequests(transport.fetchMock).length;
      const counts = transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agents/mutation-selection").length;
      act(() => {
        window.history.pushState({}, "", route === "exact" ? `/agents?selected=${agent.id}` : "/agents");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await act(async () => {});

      expect(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` })).not.toBeChecked();
      expect(screen.queryByRole("button", { name: "Clear all-matching package selection" })).not.toBeInTheDocument();
      expect(new URLSearchParams(window.location.search).has("selectionState")).toBe(false);
      expect(agentListRequests(transport.fetchMock)).toHaveLength(reads);
      expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agents/mutation-selection")).toHaveLength(counts);
      if (route === "exact") {
        expect(new URLSearchParams(window.location.search).getAll("selected")).toEqual([agent.id]);
        await userEvent.click(screen.getByRole("button", { name: "Block selected packages" }));
        await screen.findByRole("dialog", { name: "Block package?" });
        const preview = transport.fetchMock.mock.calls.find(([input]) => input === "/api/agents/mutation-preview")!;
        expect(JSON.parse(String(preview[1]?.body))).toEqual({ action: "block", ids: [agent.id], mutationScope: "bulk" });
      } else {
        expect(screen.queryByRole("button", { name: "Block selected packages" })).not.toBeInTheDocument();
      }
    },
  );

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

  it.each(["success", "failure"] as const)("cancels a group count on browser-history replacement and ignores its late %s", async outcome => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const group = { ...unifiedPage.value[0], id: "agent:11111111-1111-4111-8111-111111111111",
      packageCount: 40, packagesComplete: false, memberCount: 40 };
    transport.fetchMock.mockImplementation((input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") return Promise.resolve(Response.json({
        ...unifiedPage, value: [group], counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 40 },
      }));
      if (input === "/api/agents/mutation-selection") return pending.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
    await waitFor(() => expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agents/mutation-selection")).toHaveLength(1));
    const countRequest = transport.fetchMock.mock.calls.find(([input]) => input === "/api/agents/mutation-selection")!;
    const reads = agentListRequests(transport.fetchMock).length;
    act(() => {
      window.history.pushState({}, "", `/agents?selected=${agent.id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(countRequest[1]?.signal?.aborted).toBe(true);
    await act(async () => pending.resolve(outcome === "success" ? Response.json({ count: 40 }) : Response.json({
      code: "selection_invalidated", detail: "Previous group expired.",
    }, { status: 409 })));
    expect(screen.getByRole("button", { name: "Block selected packages" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` })).not.toBeChecked();
    expect(screen.queryByText("Previous group expired.")).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).getAll("selected")).toEqual([agent.id]);
    expect(new URLSearchParams(window.location.search).has("selectionState")).toBe(false);
    expect(agentListRequests(transport.fetchMock)).toHaveLength(reads);
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agents/mutation-selection")).toHaveLength(1);
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
    expect(request[1]).toMatchObject({ method: "POST" });
    expect(new Headers(request[1]?.headers).get("X-CSRF-Token")).toBe("csrf-1");
    expect(JSON.parse(String(request[1]?.body))).toEqual({ mode: "initial" });
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("opens first-sync permission recovery without reloading the session or restarting automatic work", async () => {
    window.history.replaceState({}, "", "/sync");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/data-sync/state") return Response.json({
        onboardingRequired: true, usageImportRequired: true, run: null,
        sources: ["users", "graph_packages", "power_platform", "usage_reports"].map(source => ({
          source, status: "not_started", jobId: null, count: null, lastSuccessAt: null, updatedAt: null,
          message: "", canRetry: false,
        })),
      });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("heading", { name: "Workspace data" });
    await userEvent.click(screen.getByRole("button", { name: "Pause automatic refresh" }));
    expect(screen.getByRole("button", { name: "Resume automatic refresh" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    const notice = await screen.findByRole("dialog", { name: "Set up your workspace" });
    const sessionReads = transport.meCalls();
    const syncRequests = () => transport.fetchMock.mock.calls.filter(([input]) => input.startsWith("/api/data-sync/")).length;
    const before = syncRequests();
    const inventoryReads = agentListRequests(transport.fetchMock).length;

    await userEvent.click(within(notice).getByRole("button", { name: "Review permissions" }));

    expect(await screen.findByRole("heading", { name: "Permissions" })).toBeVisible();
    expect(window.location.pathname).toBe("/permissions");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(transport.meCalls()).toBe(sessionReads);
    expect(syncRequests()).toBe(before);
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(await screen.findByRole("dialog", { name: "Set up your workspace" })).toBeVisible();
    expect(screen.getByText(/Automatic sync is paused for this session/)).toBeVisible();
    expect(syncRequests()).toBe(before);
    expect(agentListRequests(transport.fetchMock)).toHaveLength(inventoryReads);
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
    expect(await within(screen.getByRole("dialog", { name: "Inventory diagnostics" })).findByRole("alert"))
      .toHaveTextContent("Synthetic initial refresh failed");
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
    expect(calls[start][1]).toMatchObject({ method: "POST" });
    expect(new Headers(calls[start][1]?.headers).get("X-CSRF-Token")).toBe("csrf-1");
    expect(calls.some(([path]) => String(path).includes("mutation-preview") || String(path).endsWith("/access"))).toBe(false);
  });

  it("shares repeated table access preparation until it settles without restarting provider work", async () => {
    const transport = accessEditorTransport(), pending = deferredResponse();
    transport.exactResponse = () => pending.promise;
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const prepare = await screen.findByRole("button", { name: `Manage access for ${agent.displayName}` });
    act(() => { fireEvent.click(prepare); fireEvent.click(prepare); });
    await userEvent.click(prepare);
    const requests = () => transport.fetchMock.mock.calls.filter(([path]) => path === `/api/agents/${agent.id}/refresh-jobs`);
    expect(requests()).toHaveLength(1);
    expect(requests()[0][1]?.signal?.aborted).toBe(false);
    await act(async () => pending.resolve(Response.json(completedRefreshJob())));
    const editor = await screen.findByRole("dialog", { name: "Manage agent access" });
    expect(transport.fetchMock.mock.calls.filter(([path]) => isPackageDetailRequest(path, agent.id))).toHaveLength(1);
    await userEvent.click(within(editor).getByRole("button", { name: "Close access management" }));
    transport.exactResponse = undefined;
    await userEvent.click(prepare);
    expect(await screen.findByRole("dialog", { name: "Manage agent access" })).toBeVisible();
    expect(requests()).toHaveLength(2);
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

  it.each(["current settings", "mutation preview"] as const)(
    "keeps a cancelled inline %s failure out of the retained access draft",
    async phase => {
      const transport = accessEditorTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const path = phase === "current settings" ? `/api/agents/${agent.id}/refresh-jobs` : "/api/agents/mutation-preview";
      let delay = true;
      transport.fetchMock.mockImplementation((input, init) =>
        delay && input === path ? pending.promise : base(input, init));
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
      const detail = await screen.findByRole("dialog", { name: agent.displayName });
      await userEvent.click(within(detail).getByRole("tab", { name: "Manage" }));
      await userEvent.click(within(detail).getByRole("radio", { name: /No users/ }));
      await userEvent.click(within(detail).getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(transport.fetchMock.mock.calls.filter(([input]) => input === path)).toHaveLength(1));
      expect(within(detail).getByRole("button", { name: "Applying" })).toBeDisabled();

      await userEvent.click(within(detail).getByRole("tab", { name: "Overview" }));
      const request = transport.fetchMock.mock.calls.find(([input]) => input === path)!;
      expect(request[1]?.signal?.aborted).toBe(true);
      const sessionReads = transport.session.meCalls();
      await act(async () => pending.resolve(Response.json({
        code: "unauthorized", detail: "Retired inline access request.",
      }, { status: 401 })));
      await userEvent.click(within(detail).getByRole("tab", { name: "Manage" }));
      expect(within(detail).getByRole("radio", { name: /No users/ })).toBeChecked();
      expect(within(detail).queryByRole("alert")).not.toBeInTheDocument();
      expect(within(detail).getByRole("button", { name: "Apply" })).toBeEnabled();
      expect(transport.session.meCalls()).toBe(sessionReads);
      expect(transport.fetchMock.mock.calls.filter(([input]) => input === path)).toHaveLength(1);

      delay = false;
      await userEvent.click(within(detail).getByRole("button", { name: "Apply" }));
      expect(await within(detail).findByRole("region", { name: /update availability package/i })).toBeVisible();
      expect(transport.fetchMock.mock.calls.filter(([input]) => input === path)).toHaveLength(2);
    },
  );

  it.each(["current settings", "mutation preview"] as const)(
    "preserves a current inline %s error and retries only on Apply",
    async phase => {
      const transport = accessEditorTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const path = phase === "current settings" ? `/api/agents/${agent.id}/refresh-jobs` : "/api/agents/mutation-preview";
      let fail = true;
      transport.fetchMock.mockImplementation((input, init) => fail && input === path
        ? Promise.resolve(Response.json({ code: "provider_error", detail: "Current access verification failed." }, { status: 503 }))
        : base(input, init));
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
      const detail = await screen.findByRole("dialog", { name: agent.displayName });
      await userEvent.click(within(detail).getByRole("tab", { name: "Manage" }));
      await userEvent.click(within(detail).getByRole("radio", { name: /No users/ }));
      await userEvent.click(within(detail).getByRole("button", { name: "Apply" }));
      expect(await within(detail).findByRole("alert")).toHaveTextContent("Current access verification failed.");
      expect(within(detail).getByRole("radio", { name: /No users/ })).toBeChecked();
      expect(within(detail).getByRole("button", { name: "Apply" })).toBeEnabled();
      expect(transport.fetchMock.mock.calls.filter(([input]) => input === path)).toHaveLength(1);

      fail = false;
      await userEvent.click(within(detail).getByRole("button", { name: "Apply" }));
      expect(await within(detail).findByRole("region", { name: /update availability package/i })).toBeVisible();
      expect(within(detail).queryByText("Current access verification failed.")).not.toBeInTheDocument();
      expect(transport.fetchMock.mock.calls.filter(([input]) => input === path)).toHaveLength(2);
    },
  );

  it("keeps a saved-detail failure separate from inline access preparation without retrying either", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => isPackageDetailRequest(input, agent.id)
      ? Promise.resolve(Response.json({ code: "saved_details_unavailable", detail: "Saved assignments unavailable." }, { status: 503 }))
      : input === `/api/agents/${agent.id}/refresh-jobs`
        ? Promise.resolve(Response.json({ code: "provider_error", detail: "Current access preparation failed." }, { status: 503 }))
        : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
    const detail = await screen.findByRole("dialog", { name: agent.displayName });
    expect(await within(detail).findByRole("alert")).toHaveTextContent("Saved assignments unavailable.");
    await userEvent.click(within(detail).getByRole("tab", { name: "Manage" }));
    await userEvent.click(within(detail).getByRole("radio", { name: /No users/ }));
    await userEvent.click(within(detail).getByRole("button", { name: "Apply" }));
    expect(await within(detail).findByText("Current access preparation failed.")).toBeVisible();
    expect(within(detail).getByText(/Saved assignments unavailable\./)).toBeVisible();
    expect(transport.fetchMock.mock.calls.filter(([path]) => isPackageDetailRequest(path, agent.id))).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === `/api/agents/${agent.id}/refresh-jobs`)).toHaveLength(1);
  });

  it.each((["same account", "replacement account", "replacement tenant"] as const).flatMap(account =>
    (["pending", "success", "failure"] as const).map(outcome => ({ account, outcome })),
  ))(
    "retires assignment drafts and $outcome directory searches when revalidating the $account",
    async ({ account, outcome }) => {
      const transport = accessEditorTransport({
        ...viewer,
        homeAccountId: account === "replacement account" ? "replacement-account" : viewer.homeAccountId,
        tenantId: account === "replacement tenant" ? "replacement-tenant" : viewer.tenantId,
      });
      transport.exactCompleted = true;
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const results = { value: [
        { resourceType: "user", resourceId: "22222222-2222-4222-8222-222222222222", displayName: "Retired directory result", principalKind: "user" },
        { resourceType: "user", resourceId: "33333333-3333-4333-8333-333333333333", displayName: "Retired selected user", principalKind: "user" },
      ] };
      transport.fetchMock.mockImplementation((input, init) =>
        new URL(input, "http://localhost").pathname === "/api/directory/principals" ? pending.promise : base(input, init));
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
      const detail = await screen.findByRole("dialog", { name: agent.displayName });
      await userEvent.click(within(detail).getByRole("tab", { name: "Manage" }));
      await userEvent.click(within(detail).getByRole("button", { name: /^Installed for/ }));
      await userEvent.click(await within(detail).findByRole("button", { name: "Remove Installed user" }));
      expect(within(detail).getByText("0 selected")).toBeVisible();
      fireEvent.change(within(detail).getByRole("searchbox"), { target: { value: "Retired" } });
      fireEvent.change(within(detail).getByRole("combobox", { name: "Type" }), { target: { value: "users" } });
      const searches = () => transport.fetchMock.mock.calls.filter(([input]) =>
        new URL(input, "http://localhost").pathname === "/api/directory/principals");
      await waitFor(() => expect(searches()).toHaveLength(1));
      if (outcome === "success") {
        await act(async () => pending.resolve(Response.json(results)));
        await userEvent.click(within(detail).getByRole("button", { name: /Retired selected user/ }));
        expect(within(detail).getByRole("button", { name: "Remove Retired selected user" })).toBeEnabled();
        expect(within(detail).getByRole("button", { name: /Retired directory result/ })).toBeVisible();
      } else if (outcome === "failure") {
        await act(async () => pending.resolve(Response.json({
          code: "directory_unavailable", detail: "Retired directory failure",
        }, { status: 503 })));
        expect(within(detail).getByRole("alert")).toHaveTextContent("Retired directory failure");
      }
      expect(searches()).toHaveLength(1);

      await revalidateTransportSession(transport.session);
      expect(detail).not.toBeInTheDocument();
      expect(searches()[0][1]?.signal?.aborted).toBe(true);
      if (outcome === "pending") await act(async () => pending.resolve(Response.json(results)));
      await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
      const replacement = await screen.findByRole("dialog", { name: agent.displayName });
      await userEvent.click(within(replacement).getByRole("tab", { name: "Manage" }));
      await userEvent.click(within(replacement).getByRole("button", { name: /^Installed for/ }));
      expect(await within(replacement).findByRole("button", { name: "Remove Installed user" })).toBeEnabled();
      expect(within(replacement).getByText("1 selected")).toBeVisible();
      expect(within(replacement).getByRole("searchbox")).toHaveValue("");
      expect(within(replacement).getByRole("combobox", { name: "Type" })).toHaveValue("all");
      expect(within(replacement).getByText("Enter at least two characters.")).toBeVisible();
      expect(screen.queryByText("Retired directory result")).not.toBeInTheDocument();
      expect(screen.queryByText("Retired selected user")).not.toBeInTheDocument();
      expect(screen.queryByText("Retired directory failure")).not.toBeInTheDocument();
      expect(within(replacement).queryByText("Searching directory...")).not.toBeInTheDocument();
      expect(searches()).toHaveLength(1);
      expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/directory/principals/resolve")).toHaveLength(2);
    },
  );

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

  it("admits one block preview for repeated inline clicks and releases admission after cancellation", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let delay = true;
    transport.fetchMock.mockImplementation((input, init) => delay && input === "/api/agents/mutation-preview"
      ? pending.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
    const detail = await screen.findByRole("dialog", { name: agent.displayName });
    await userEvent.click(within(detail).getByRole("tab", { name: "Manage" }));
    const block = within(detail).getByRole("button", { name: `Block ${agent.displayName} (${agent.id})` });
    act(() => {
      fireEvent.click(block);
      fireEvent.click(block);
    });
    const previews = () => transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/mutation-preview");
    expect(previews()).toHaveLength(1);

    await userEvent.click(within(detail).getByRole("tab", { name: "Overview" }));
    expect(previews()[0][1]?.signal?.aborted).toBe(true);
    delay = false;
    await userEvent.click(within(detail).getByRole("tab", { name: "Manage" }));
    await userEvent.click(within(detail).getByRole("button", { name: `Block ${agent.displayName} (${agent.id})` }));
    const confirmation = await within(detail).findByRole("region", { name: /block package/i });
    expect(previews()).toHaveLength(2);
    await act(async () => pending.resolve(Response.json({ code: "provider_error", detail: "Retired preview failure" }, { status: 503 })));
    expect(confirmation).toBeVisible();
    expect(within(detail).queryByText("Retired preview failure")).not.toBeInTheDocument();
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

  it.each([true, false])("retires stale projected row summaries after verified blocking (complete=%s)", async complete => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const record = { ...unifiedPage.value[0], packages: [{ ...agent, availableTo: "all" }],
      packagesComplete: complete, packageCount: complete ? 1 : 40,
      columns: { status: complete ? "Not blocked" : "2 not blocked · 38 blocked", availability: "All users",
        publisher: "Saved publisher" } };
    const page = unifiedRecordsPage([record]);
    const count = complete ? 1 : 40;
    const job: BulkActionJob = { ...waitingBulkJob(), status: "succeeded", canResume: false,
      total: count, completed: count, succeeded: count, inconclusive: 0, queued: 0, reconciliationRequired: 0 };
    let changed = false;
    let delayReload = true;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        return changed && delayReload ? pending.promise : Promise.resolve(Response.json(selectedInventoryPage(input,
          changed ? { ...page, value: [{ ...record, packages: [{ ...record.packages[0], isBlocked: true }],
            columns: { ...record.columns, status: complete ? "Blocked" : "1 not blocked · 39 blocked",
              availability: complete ? "Not available" : "All users" } }] } : page)));
      }
      if (input === "/api/agents/mutation-selection") return Promise.resolve(Response.json({ count: 40 }));
      if (input === "/api/agents/mutation-preview") {
        const preview = await (await base(input, init)).json() as PackageMutationPreview;
        return Response.json({ ...preview, selectionId: currentInventorySelection(transport.fetchMock),
          summary: { ...preview.summary, targetCount: count, additionalTargetCount: count - 1 } });
      }
      if (input === "/api/agents/block") {
        changed = true;
        return Promise.resolve(Response.json(job));
      }
      if (input.startsWith(`/api/agents/bulk-jobs/${job.id}/items?`)) return Promise.resolve(Response.json({
        value: Array.from({ length: count }, (_, index) => ({
          id: index ? `other-version-${index}` : agent.id, displayName: agent.displayName, status: "succeeded",
        })),
        revision: job.resultRevision, counts: { total: count, filtered: count },
        page: { limit: 50, nextCursor: null, previousCursor: null },
      }));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
    await userEvent.click(await screen.findByRole("button", { name: "Block selected packages" }));
    await userEvent.click(await screen.findByRole("button", { name: complete ? "Block package" : "Block 40 packages" }));
    await screen.findByRole("status", { name: "Updating agent results" });
    const row = within(screen.getByRole("table")).getAllByRole("row")[1];
    if (complete) expect(within(row).getByRole("cell", { name: "Blocked" })).toBeVisible();
    else expect(within(row).getAllByRole("cell", { name: "Unknown" })).toHaveLength(3);
    expect(within(row).queryByText(record.columns.status)).not.toBeInTheDocument();
    expect(within(row).queryByText("All users")).not.toBeInTheDocument();
    expect(within(row).getByText("Saved publisher")).toBeVisible();
    if (complete) expect(within(row).getByRole("button", { name: `Unblock ${agent.displayName}` })).toBeEnabled();
    const reads = agentListRequests(transport.fetchMock).length;
    await act(async () => pending.resolve(Response.json({
      code: "inventory_unavailable", detail: "Replacement inventory unavailable.",
    }, { status: 503 })));
    expect(within(row).queryByText(record.columns.status)).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Updating agent results" })).not.toBeInTheDocument();
    delayReload = false;
    await userEvent.click(screen.getByRole("button", { name: "Reload saved agent inventory" }));
    await waitFor(() => expect(within(row).getByText(complete ? "Blocked" : "1 not blocked · 39 blocked")).toBeVisible());
    expect(agentListRequests(transport.fetchMock)).toHaveLength(reads + 1);
  });

  it.each(["availability", "installation"] as const)("retires projected %s after verified access while inventory reloads", async target => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const record = { ...unifiedPage.value[0], packages: [{ ...agent, availableTo: "all", deployedTo: "all" }],
      packagesComplete: true,
      columns: { status: "Not blocked", availability: "All users", deployment: "All users", publisher: "Saved publisher" } };
    let changed = false;
    transport.fetchMock.mockImplementation((input, init) => {
      if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
        return changed ? pending.promise : Promise.resolve(Response.json(selectedInventoryPage(input, unifiedRecordsPage([record]))));
      }
      if (input === `/api/agents/${agent.id}/access` && init?.method === "PATCH") changed = true;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("button", { name: `View details for ${agent.displayName}` });
    await userEvent.click(screen.getByRole("button", { name: "Columns" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Installed for" }));
    await userEvent.keyboard("{Escape}");
    const row = within(screen.getByRole("table")).getAllByRole("row")[1];
    await userEvent.click(screen.getByRole("button", { name: `View details for ${agent.displayName}` }));
    const detail = await screen.findByRole("dialog", { name: agent.displayName });
    await userEvent.click(within(detail).getByRole("tab", { name: "Manage" }));
    if (target === "installation") await userEvent.click(within(detail).getByRole("button", { name: /^Installed for/ }));
    await userEvent.click(within(detail).getByRole("radio", { name: /No users/ }));
    await userEvent.click(within(detail).getByRole("button", { name: "Apply" }));
    const confirmation = await within(detail).findByRole("region", { name: new RegExp(`update ${target} package`, "i") });
    await userEvent.click(within(confirmation).getByRole("button", { name: `Confirm update ${target}` }));
    await waitFor(() => expect(within(row).getByText(target === "availability" ? "Not available" : "No users")).toBeInTheDocument());
    await userEvent.click(within(detail).getByRole("tab", { name: "Overview" }));
    const summary = () => within(detail).getByText(target === "availability" ? "End-user access" : "Installed for",
      { selector: ".agent-overview-facts span" }).nextElementSibling;
    expect(summary()).toHaveTextContent(target === "availability" ? /^Not available$/ : /^No users$/);
    expect(summary()).toBeVisible();
    expect(within(row).getByText("Saved publisher")).toBeInTheDocument();
    await act(async () => pending.resolve(Response.json({
      code: "inventory_unavailable", detail: "Replacement inventory unavailable.",
    }, { status: 503 })));
    expect(within(row).getByText(target === "availability" ? "Not available" : "No users")).toBeInTheDocument();
    expect(summary()).toHaveTextContent(target === "availability" ? /^Not available$/ : /^No users$/);
    expect(summary()).toBeVisible();
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === `/api/agents/${agent.id}/access`)).toHaveLength(1);
  });

  it.each((["block", "availability", "installation"] as const).flatMap(operation =>
    (["success", "failure", "replacement", "off-page", "invalid membership", "detail failure", "late replacement", "account change"] as const)
      .map(outcome => ({ operation, outcome }))))(
    "retains the exact off-preview version after verified $operation through inventory reload $outcome",
    async ({ operation, outcome }) => {
      const transport = accessEditorTransport(outcome === "account change" ? { ...viewer, homeAccountId: "replacement-admin" } : viewer);
      const base = transport.fetchMock.getMockImplementation()!;
      const second = { ...agent, id: "package-alternate", displayName: "Second publication", version: "2",
        availableTo: "some", deployedTo: "some" };
      const group: UnifiedAgentRecord = { ...unifiedPage.value[0], id: "agent:33333333-3333-4333-8333-333333333333",
        packages: [agent], packagesComplete: false, packageCount: 40 };
      const pending = deferredResponse();
      const pendingDetail = deferredResponse();
      const completed: BulkActionJob = { ...waitingBulkJob(), status: "succeeded", canResume: false,
        total: 1, completed: 1, succeeded: 1, inconclusive: 0, queued: 0, reconciliationRequired: 0 };
      const job: BulkActionJob = operation === "block" ? completed : {
        ...completed, targetBlockedState: undefined, action: `update-${operation}`,
        accessUpdate: { target: operation, mode: "replace", scope: "none", principals: [] },
      };
      const mutationPath = `/api/agents/${second.id}/${operation === "block" ? "block" : "access"}`;
      const preparedReads = operation === "block" ? 1 : 2;
      let changed = false;
      let failDetail = outcome === "detail failure";
      let delayInventory = true;
      let delayedDetail: Response | undefined;
      transport.fetchMock.mockImplementation(async (input, init) => {
        const url = new URL(input, "http://localhost");
        if (url.pathname === "/api/agent-inventory") return changed && delayInventory ? pending.promise
          : Response.json(selectedInventoryPage(input, unifiedRecordsPage([group])));
        if (unifiedDetailId(input)) return Response.json(group);
        if (url.pathname.endsWith("/members")) return Response.json({
          value: [{ domain: "packages", native_id: second.id, display_name: second.displayName }], nextCursor: null,
        });
        if (isPackageDetailRequest(input, second.id)) {
          if (changed && failDetail) return Response.json({
            code: "detail_unavailable", detail: "Replacement version detail unavailable.",
          }, { status: 503 });
          const response = Response.json({
            ...second, isBlocked: changed && operation === "block",
            availableTo: changed && operation === "availability" ? "none" : "some",
            deployedTo: changed && operation === "installation" ? "none" : "some",
            allowedUsersAndGroups: changed && operation === "availability" ? [] : [{ resourceType: "user", resourceId: "installed-user" }],
            acquireUsersAndGroups: changed && operation === "installation" ? [] : [{ resourceType: "user", resourceId: "installed-user" }],
            longDescription: changed ? "Reloaded second publication" : "Selected second publication",
            selectedSource: { selectionId: url.searchParams.get("selectionId"),
              recordId: changed && outcome === "invalid membership" ? "another-group" : group.id.replace(/^agent:/, ""),
              sourceIdentity: second.id, sourceScopeId: "package-scope", generationId: "package-generation" },
            observation: { observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
              scopeKind: "broad", current: true },
          });
          if (changed && (outcome === "late replacement" || outcome === "account change")) {
            delayedDetail = response;
            return pendingDetail.promise;
          }
          return response;
        }
        if (input === `/api/agents/${second.id}/refresh-jobs`) return Response.json({
          ...completedRefreshJob(), id: "alternate-access", scopeKind: "exact", requestedIds: [second.id],
        });
        if (input === "/api/agents/mutation-preview") {
          const preview = await (await base(input, init)).json() as PackageMutationPreview;
          return Response.json({ ...preview, summary: { ...preview.summary, targets: [{
            ...preview.summary.targets[0], id: second.id, displayName: second.displayName,
          }] } });
        }
        if (input === mutationPath) {
          changed = true;
          return Response.json(job);
        }
        if (input.startsWith(`/api/agents/bulk-jobs/${job.id}/items?`)) return Response.json({
          value: [{ id: second.id, displayName: second.displayName, status: "succeeded" }],
          revision: job.resultRevision, counts: { total: 1, filtered: 1 },
          page: { limit: 50, nextCursor: null, previousCursor: null },
        });
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
      const detail = await screen.findByRole("dialog", { name: agent.displayName });
      const versions = within(detail).getByRole("combobox", { name: "Published version details" });
      await waitFor(() => expect(versions).toBeEnabled());
      await userEvent.selectOptions(versions, second.id);
      expect(await within(detail).findByText("Selected second publication")).toBeVisible();
      await userEvent.click(within(detail).getByRole("tab", { name: "Manage" }));
      if (operation === "block") {
        await userEvent.click(within(detail).getByRole("button", { name: `Block ${second.displayName} (${second.id})` }));
      } else {
        if (operation === "installation") await userEvent.click(within(detail).getByRole("button", { name: /^Installed for/ }));
        await userEvent.click(within(detail).getByRole("radio", { name: /No users/ }));
        await userEvent.click(within(detail).getByRole("button", { name: "Apply" }));
      }
      await userEvent.click(await within(detail).findByRole("button", {
        name: operation === "block" ? "Block package" : `Confirm update ${operation}`,
      }));
      await screen.findByRole("status", { name: "Updating agent results" });
      const changedControl = () => operation === "block"
        ? within(detail).getByRole("button", { name: `Unblock ${second.displayName} (${second.id})` })
        : within(detail).getByRole("radio", { name: /No users/ });
      expect(within(detail).getByRole("combobox", { name: "Published version details" })).toHaveValue(second.id);
      expect(changedControl()).toBeVisible();
      if (operation !== "block") expect(changedControl()).toBeChecked();
      expect(within(detail).queryByText(/is not in the loaded version list/)).not.toBeInTheDocument();
      expect(transport.fetchMock.mock.calls.filter(([input]) => input === mutationPath)).toHaveLength(1);
      expect(transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, second.id))).toHaveLength(preparedReads);
      if (outcome === "replacement") {
        await userEvent.click(within(detail).getByRole("button", { name: /close/i }));
        await userEvent.click(screen.getByRole("button", { name: `View details for ${agent.displayName}` }));
      }
      const read = agentListRequests(transport.fetchMock).at(-1)![0];
      await act(async () => pending.resolve(outcome === "failure" ? Response.json({
        code: "inventory_unavailable", detail: "Replacement inventory unavailable.",
      }, { status: 503 }) : Response.json(selectedInventoryPage(read, unifiedRecordsPage(outcome === "off-page" ? [] : [group])))));
      if (outcome === "late replacement" || outcome === "account change") {
        await waitFor(() => expect(delayedDetail).toBeDefined());
        const request = transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, second.id)).at(-1)!;
        expect(request[1]?.signal?.aborted).toBe(false);
        delayInventory = false;
        if (outcome === "account change") {
          await revalidateTransportSession(transport.session);
          await screen.findByRole("button", { name: `View details for ${agent.displayName}` });
        } else {
          await userEvent.click(within(detail).getByRole("button", { name: /close/i }));
          await userEvent.click(screen.getByRole("button", { name: `View details for ${agent.displayName}` }));
        }
        expect(request[1]?.signal?.aborted).toBe(true);
        await act(async () => pendingDetail.resolve(delayedDetail!));
        expect(screen.queryByText("Reloaded second publication")).not.toBeInTheDocument();
        expect(screen.queryByRole("region", { name: `Manage ${second.displayName} (${second.id})` })).not.toBeInTheDocument();
        if (outcome === "account change") expect(screen.queryByRole("dialog", { name: agent.displayName })).not.toBeInTheDocument();
        else expect(screen.getByRole("combobox", { name: "Published version details" })).toHaveValue(agent.id);
        expect(transport.fetchMock.mock.calls.filter(([input]) => input === mutationPath)).toHaveLength(1);
      } else if (outcome === "invalid membership" || outcome === "detail failure") {
        await waitFor(() => expect(within(detail).queryAllByRole("alert").map(item => item.textContent)).toEqual(expect.arrayContaining([expect.stringContaining(outcome === "detail failure"
          ? "Replacement version detail unavailable."
          : "The selected published version does not belong to the displayed inventory group.")])));
        expect(within(detail).queryByRole("region", { name: `Manage ${second.displayName} (${second.id})` })).not.toBeInTheDocument();
        expect(screen.queryByText("Reloaded second publication")).not.toBeInTheDocument();
        const reads = () => transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, second.id));
        expect(reads()).toHaveLength(preparedReads + 1);
        expect(within(detail).getByRole("button", { name: "Retry saved details" })).toBeEnabled();
        if (outcome === "detail failure") {
          failDetail = false;
          await userEvent.click(within(detail).getByRole("button", { name: "Retry saved details" }));
          await waitFor(() => expect(changedControl()).toBeEnabled());
          if (operation === "installation") await userEvent.click(within(detail).getByRole("button", { name: /^Installed for/ }));
          if (operation !== "block") expect(changedControl()).toBeChecked();
          expect(reads()).toHaveLength(preparedReads + 2);
          expect(within(detail).getByRole("combobox", { name: "Published version details" })).toHaveValue(second.id);
          expect(within(detail).queryByText(/Replacement version detail unavailable/)).not.toBeInTheDocument();
          expect(transport.fetchMock.mock.calls.filter(([input]) => input === mutationPath)).toHaveLength(1);
        }
      } else if (outcome === "replacement") {
        const replacement = screen.getByRole("dialog", { name: agent.displayName });
        expect(within(replacement).getByRole("combobox", { name: "Published version details" })).toHaveValue(agent.id);
        expect(within(replacement).queryByRole("region", { name: `Manage ${second.displayName} (${second.id})` })).not.toBeInTheDocument();
      } else {
        expect(changedControl()).toBeVisible();
        if (operation !== "block") expect(changedControl()).toBeChecked();
        expect(within(detail).getByRole("combobox", { name: "Published version details" })).toHaveValue(second.id);
        if (outcome !== "failure") {
          await waitFor(() => expect(changedControl()).toBeEnabled());
          const details = transport.fetchMock.mock.calls.filter(([input]) => isPackageDetailRequest(input, second.id));
          expect(details).toHaveLength(preparedReads + 1);
          expect(new URL(details.at(-1)![0], "http://localhost").searchParams.get("selectionId")).toBe(currentInventorySelection(transport.fetchMock));
        }
      }
    },
  );

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
      expect(within(restored).queryByText(/Loading saved agent details|Saved details will be loaded/)).not.toBeInTheDocument();
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

  it.each(["succeeded", "cancelled", "waiting_authorization"] as const)("preserves newer quarantine selection when a followed job becomes %s and reloads only for possible writes", async status => {
    window.history.replaceState({}, "", "/agents?inventory=power_platform_only&quarantineJob=job-only");
    const nextTarget = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "New quarantine target");
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"],
      unifiedResponse: unifiedRecordsPage([nextTarget]),
    });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let jobReads = 0;
    const complete: QuarantineJob = { ...quarantineJob("job-only"), status,
      total: status === "waiting_authorization" ? 2 : 1, canResume: status === "waiting_authorization",
      succeeded: status === "cancelled" ? 0 : 1, cancelled: status === "cancelled" ? 1 : 0 };
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/quarantine/jobs/job-only") return ++jobReads === 1
        ? Response.json({ ...complete, status: "running", completed: 0, succeeded: 0, cancelled: 0 })
        : pending.promise.then(response => response.clone());
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText("Quarantine job: Running");
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select New quarantine target" }));
    await waitFor(() => expect(jobReads).toBe(2), { timeout: 2000 });
    const captures = () => transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agent-inventory/selections").length;
    const before = captures();
    await act(async () => pending.resolve(Response.json(complete)));
    if (status !== "cancelled") await waitFor(() => expect(captures()).toBe(before + 1));
    expect(screen.getByRole("checkbox", { name: "Select New quarantine target" })).toBeChecked();
    expect(screen.getByText("1 of 25 exact Copilot Studio agents selected")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Refresh job status" }));
    await waitFor(() => expect(jobReads).toBe(3));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh job status" })).toBeEnabled());
    expect(captures()).toBe(before + (status === "cancelled" ? 0 : 1));
  });

  it("invalidates saved inventory after a detail quarantine result without starting a second job follower", async () => {
    window.history.replaceState({}, "", "/agents?inventory=power_platform_only");
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Detail quarantine target");
    const observation = native.observations.powerPlatform!;
    const resource = native.powerPlatformResource!;
    const job = quarantineJob();
    job.confirmation.targets = [{
      resourceNativeId: resource.nativeId, displayName: native.displayName, environmentId: resource.environmentId!,
      botId: resource.quarantineIdentity!.botId, currentState: false, requestedState: true,
      currentProviderUpdatedAt: observation.observedAt, inventoryState: false, inventoryObservedAt: observation.observedAt,
    }];
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"],
      unifiedResponse: unifiedRecordsPage([native]),
    });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/capabilities" || input.startsWith("/api/capabilities/check")) {
        const definition = capabilityDefinitions.find(item => item.id === "powerPlatform.quarantine.manage")!;
        return Response.json({ value: [{ definition, decision: {
          capabilityId: definition.id, status: "available", authorized: true, fresh: true,
          verification: "on_demand", previewQualification: "not_required", remediation: [],
        } }] });
      }
      if (input === "/api/quarantine/preview") return Response.json({
        confirmationHash: job.confirmationHash, summary: job.confirmation,
        statuses: [{
          target: job.confirmation.targets[0],
          direct: { isBotQuarantined: false, providerUpdatedAt: observation.observedAt,
            observedAt: observation.observedAt, correlationId: "status", source: "provider" },
          inventory: { isQuarantined: false, quarantinedAt: null, observedAt: observation.observedAt, snapshotId: observation.id },
          disagreesWithInventory: false,
        }],
      });
      if (input === "/api/quarantine/jobs" && init?.method === "POST") return Response.json(job);
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View details for Detail quarantine target" }));
    await userEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const confirmation = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(confirmation).getByRole("checkbox"));
    const captures = () => transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agent-inventory/selections").length;
    const before = captures();
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm quarantine" }));
    await waitFor(() => expect(captures()).toBe(before + 1));
    expect(screen.queryByRole("region", { name: "Copilot Studio quarantine controls" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([path]) => path.startsWith("/api/quarantine/jobs/") || path.startsWith("/api/quarantine/jobs?"))).toHaveLength(0);
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

  it.each(["success", "retry", "account-change"] as const)("preserves a cleared bulk quarantine receipt until %s", async outcome => {
    window.history.replaceState({}, "", "/agents?inventory=power_platform_only");
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Retained bulk target");
    const observation = native.observations.powerPlatform!;
    const job = quarantineJob();
    job.confirmation.targets = [{
      resourceNativeId: native.powerPlatformResource!.nativeId, displayName: native.displayName,
      environmentId: native.environmentId!, botId: native.powerPlatformResource!.quarantineIdentity!.botId,
      currentState: false, requestedState: true, currentProviderUpdatedAt: observation.observedAt,
      inventoryState: false, inventoryObservedAt: observation.observedAt,
    }];
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"],
      revalidatedUser: outcome === "account-change" ? { ...viewer, homeAccountId: "new-account" } : undefined,
      unifiedResponse: unifiedRecordsPage([native]),
    });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let submissions = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/capabilities" || input.startsWith("/api/capabilities/check")) {
        const definition = capabilityDefinitions.find(item => item.id === "powerPlatform.quarantine.manage")!;
        return Response.json({ value: [{ definition, decision: {
          capabilityId: definition.id, status: "available", authorized: true, fresh: true,
          verification: "on_demand", previewQualification: "not_required", remediation: [],
        } }] });
      }
      if (input === "/api/quarantine/preview") return Response.json({
        confirmationHash: job.confirmationHash, summary: job.confirmation,
        statuses: [{
          target: job.confirmation.targets[0],
          direct: { isBotQuarantined: false, providerUpdatedAt: observation.observedAt,
            observedAt: observation.observedAt, correlationId: "status", source: "provider" },
          inventory: { isQuarantined: false, quarantinedAt: null, observedAt: observation.observedAt, snapshotId: observation.id },
          disagreesWithInventory: false,
        }],
      });
      if (input === "/api/quarantine/jobs" && init?.method === "POST") return ++submissions === 1 ? pending.promise : Response.json(job);
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Retained bulk target" }));
    await userEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const confirmation = screen.getByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(confirmation).getByRole("checkbox"));
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm quarantine" }));
    const writes = () => transport.fetchMock.mock.calls.filter(([path, init]) => path === "/api/quarantine/jobs" && init?.method === "POST");
    const signal = writes()[0][1]?.signal;
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Clear" })); });
    expect(signal?.aborted).toBe(false);
    expect(screen.getByText("0 of 25 exact Copilot Studio agents selected")).toBeVisible();
    if (outcome === "account-change") await revalidateTransportSession(transport);
    await act(async () => pending.resolve(outcome === "retry"
      ? Response.json({ code: "receipt_unavailable", detail: "Submission receipt unavailable." }, { status: 502 })
      : Response.json(job)));
    if (outcome === "account-change") {
      expect(signal?.aborted).toBe(true);
      expect(screen.queryByRole("dialog", { name: "Quarantine 1 agent" })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Copilot Studio quarantine controls" })).not.toBeInTheDocument();
    } else {
      if (outcome === "retry") {
        const recovery = screen.getByRole("dialog", { name: "Quarantine 1 agent" });
        expect(within(recovery).getByRole("alert")).toHaveTextContent("Submission receipt unavailable.");
        await userEvent.click(within(recovery).getByRole("checkbox"));
        await userEvent.click(within(recovery).getByRole("button", { name: "Confirm quarantine" }));
        expect(writes()[1][1]?.body).toEqual(writes()[0][1]?.body);
        expect(new Headers(writes()[1][1]?.headers).get("Idempotency-Key"))
          .toEqual(new Headers(writes()[0][1]?.headers).get("Idempotency-Key"));
      }
      expect(screen.getByText("Quarantine job: Succeeded")).toBeVisible();
    }
    expect(writes()).toHaveLength(outcome === "retry" ? 2 : 1);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/quarantine/preview")).toHaveLength(1);
  });

  it.each([200, 401])("cancels the previous account's quarantine job read and ignores its late HTTP %s response", async status => {
    window.history.replaceState({}, "", "/agents?quarantineJob=private-job");
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"],
      revalidatedUser: { ...viewer, homeAccountId: "new-account" },
    });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation(async (input, init) => input === "/api/quarantine/jobs/private-job"
      ? pending.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/quarantine/jobs/private-job")).toBe(true));
    const signal = transport.fetchMock.mock.calls.find(([path]) => path === "/api/quarantine/jobs/private-job")![1]?.signal;
    await revalidateTransportSession(transport);
    expect(signal?.aborted).toBe(true);
    const requests = transport.fetchMock.mock.calls.length;
    await act(async () => pending.resolve(status === 200 ? Response.json(quarantineJob("private-job"))
      : Response.json({ code: "authentication_required", detail: "Retired account denied." }, { status })));
    expect(screen.queryByText("Quarantine job: Succeeded")).not.toBeInTheDocument();
    expect(screen.queryByText(/Retired account denied/)).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).has("quarantineJob")).toBe(false);
    expect(transport.fetchMock.mock.calls.length).toBe(requests);
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
    unifiedPage.usageContext.reports = selectedAgentsPage().reports;
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

  it.each(["Refresh agents", "Refresh matching details"] as const)(
    "keeps %s as the only status owner while history details wait and publishes once", async action => {
      vi.useFakeTimers();
      const transport = initialCatalogTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const complete = completedRefreshJob();
      const running = { ...complete, status: "running", finishedAt: null };
      const path = `/api/agents/refresh-jobs/${complete.id}?mode=delegated`;
      const selectedId = action === "Refresh agents" ? complete.id : "other-history-job";
      const selectedPath = `/api/agents/refresh-jobs/${selectedId}?mode=delegated`;
      const commandPath = action === "Refresh agents" ? "/api/agents/refresh-jobs" : "/api/agents/refresh-selection";
      let started = false;
      let reads = 0;
      transport.fetchMock.mockImplementation((input, init) => {
        if (input === commandPath && init?.method === "POST") {
          started = true;
          return Promise.resolve(Response.json(running));
        }
        if (input === path) return ++reads === 1 ? pending.promise : Promise.resolve(Response.json(complete));
        if (input === selectedPath) return Promise.resolve(Response.json({ ...complete, id: selectedId, status: "failed" }));
        if (input === "/api/workbench/jobs") return Promise.resolve(Response.json({
          value: started ? [{
            id: selectedId, source: "package-refresh", label: "Selected package refresh", target: "Saved source",
            status: "running", completed: 0, total: null, partial: false, updatedAt: complete.updatedAt,
            href: `/sync?refreshJob=${selectedId}`,
          }] : [],
          unavailableSources: [], polledAt: complete.updatedAt, requestId: "history-selection",
        }));
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` }));
      fireEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      const captures = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/selections").length;
      const before = captures();
      fireEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
      const command = screen.getByRole("button", { name: action });
      expect(command).toBeEnabled();
      fireEvent.click(command);
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByRole("button", { name: "Close inventory diagnostics" }));
      await act(() => vi.advanceTimersByTimeAsync(750));
      expect(reads).toBe(1);
      fireEvent.click(screen.getByRole("link", { name: /View details for Selected package refresh/ }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(reads).toBe(1);
      expect(screen.getByText(/Waiting for the current package refresh/)).toBeVisible();
      if (selectedId !== complete.id) {
        expect(screen.queryByRole("region", { name: "Selected package refresh job" })).not.toBeInTheDocument();
        expect(transport.fetchMock.mock.calls.some(([input]) => input === selectedPath)).toBe(false);
      }
      await act(async () => pending.resolve(Response.json(complete)));
      const selected = screen.getByRole("region", { name: "Selected package refresh job" });
      expect(selected).toHaveTextContent(selectedId);
      expect(selected).toHaveTextContent(selectedId === complete.id ? "succeeded" : "failed");
      expect(screen.queryByText(/Waiting for the current package refresh/)).not.toBeInTheDocument();
      expect(reads).toBe(selectedId === complete.id ? 2 : 1);
      expect(captures()).toBe(before + 1);
      expect(transport.fetchMock.mock.calls.filter(([input, init]) => input === commandPath && init?.method === "POST")).toHaveLength(1);
    },
  );

  it.each([
    ["package-refresh", "delegated"],
    ["package-refresh", "application"],
    ["power-platform", "delegated"],
  ] as const)("opens %s %s history details without reloading Sync or losing table controls", async (source, mode) => {
    window.history.replaceState({}, "", "/sync");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const history: WorkbenchJobSummary[] = Array.from({ length: 11 }, (_, index) => {
      const id = `history-${String(index).padStart(2, "0")}`;
      return {
        id, source, tokenMode: mode, label: `History refresh ${String(index).padStart(2, "0")}`,
        target: "Saved source", status: "failed", completed: null, total: null, partial: false,
        updatedAt: "2026-09-15T08:00:00.000Z",
        href: source === "power-platform" ? `/sync?powerPlatformJob=${id}`
          : `/sync?refreshJob=${id}${mode === "application" ? "&mode=application" : ""}`,
      };
    });
    const selected = history[10];
    const detail = deferredResponse();
    const path = source === "power-platform" ? `/api/inventory/refresh-jobs/${selected.id}`
      : `/api/agents/refresh-jobs/${selected.id}?mode=${mode}`;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/workbench/jobs") return Response.json({
        value: history, unavailableSources: [], polledAt: selected.updatedAt, requestId: "history-selection",
      });
      if (input === path) return detail.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const table = await screen.findByRole("table", { name: "Sync history" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Outcome" }), "incomplete");
    await userEvent.click(within(table).getByRole("button", { name: "Sort by Scope" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    const count = (path: string) => transport.fetchMock.mock.calls.filter(([input]) => input === path).length;
    const unchangedReads = ["/api/me", "/api/workbench/jobs", "/api/data-sync/state", "/api/agent-inventory/selections"];
    const before = unchangedReads.map(count);
    const link = within(table).getByRole("link", { name: /View details for History refresh 10/ });
    expect(link).toHaveAttribute("href", selected.href);
    expect(fireEvent.click(link)).toBe(false);
    expect(await screen.findByText(source === "power-platform" ? "Loading source job…" : "Loading package refresh status…")).toBeVisible();
    expect(fireEvent.click(link)).toBe(false);
    await act(async () => {});
    expect(count(path)).toBe(1);
    await act(async () => detail.resolve(Response.json(source === "power-platform"
      ? inventoryRefreshJob("failed", selected.id)
      : { ...completedRefreshJob(), id: selected.id, tokenMode: mode, status: "failed" })));
    expect(await screen.findByRole("region", { name: source === "power-platform"
      ? "Power Platform source job" : "Selected package refresh job" })).toHaveTextContent(selected.id);
    expect(window.location.pathname + window.location.search).toBe(selected.href);
    expect(screen.getByRole("table", { name: "Sync history" })).toBe(table);
    expect(screen.getByText(/11-11 of 11 recent records/)).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Outcome" })).toHaveValue("incomplete");
    expect(within(table).getByRole("columnheader", { name: "Scope" })).toHaveAttribute("aria-sort", "ascending");
    expect(fireEvent.click(link)).toBe(false);
    await act(async () => {});
    expect(count(path)).toBe(1);
    expect(unchangedReads.map(count)).toEqual(before);
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

  it.each(["syncRun", "refreshJob"] as const)("shares equivalent UUID %s bookmarks and displays the server's canonical ID", async field => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    window.history.replaceState({}, "", `/sync?${field}=${id.toUpperCase()}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const path = field === "syncRun" ? `/api/data-sync/runs/${id}` : `/api/agents/refresh-jobs/${id}`;
    const requests: Array<RequestInit | undefined> = [];
    transport.fetchMock.mockImplementation((input, init) => {
      if (new URL(input, "http://localhost").pathname.toLowerCase() === path) {
        requests.push(init);
        return pending.promise;
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(requests).toHaveLength(1));
    act(() => {
      window.history.pushState({}, "", `/sync?${field}=${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {});
    expect(requests[0]?.signal?.aborted).toBe(false);
    expect(requests).toHaveLength(1);
    await act(async () => pending.resolve(Response.json(field === "syncRun"
      ? { id, mode: "full", status: "completed", startedAt: "2026-09-14T09:00:00.000Z",
        updatedAt: "2026-09-14T09:01:00.000Z", completedAt: "2026-09-14T09:01:00.000Z", sources: [] }
      : { ...completedRefreshJob(), id, status: "failed" })));
    const region = await screen.findByRole(field === "syncRun" ? "dialog" : "region", {
      name: field === "syncRun" ? "Sync run details" : "Selected package refresh job",
    });
    await waitFor(() => expect(region).toHaveTextContent(id));
    expect(screen.queryByText(/Loading exact sync run|Loading package refresh status/)).not.toBeInTheDocument();
    act(() => {
      window.history.pushState({}, "", `/sync?${field}=${id.toUpperCase()}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {});
    expect(region).toHaveTextContent(id);
    expect(requests).toHaveLength(1);
    expect(new URLSearchParams(window.location.search).get(field)).toBe(id);
  });

  it.each(["syncRun", "refreshJob"] as const)("retires exact %s responses through A-B-A browser history", async field => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    window.history.replaceState({}, "", `/sync?${field}=${id.toUpperCase()}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = [deferredResponse(), deferredResponse(), deferredResponse()];
    const requests: Array<RequestInit | undefined> = [];
    const prefix = field === "syncRun" ? "/api/data-sync/runs/" : "/api/agents/refresh-jobs/";
    transport.fetchMock.mockImplementation((input, init) => {
      if (new URL(input, "http://localhost").pathname.startsWith(prefix)) {
        requests.push(init);
        return pending[requests.length - 1].promise;
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(requests).toHaveLength(1));
    for (const [index, next] of [otherId, id].entries()) {
      act(() => {
        window.history.pushState({}, "", `/sync?${field}=${next}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await waitFor(() => expect(requests).toHaveLength(index + 2));
      expect(requests[index]?.signal?.aborted).toBe(true);
    }
    await act(async () => pending[2].resolve(Response.json(field === "syncRun"
      ? { id, mode: "full", status: "completed", startedAt: "2026-09-14T09:00:00.000Z",
        updatedAt: "2026-09-14T09:01:00.000Z", completedAt: "2026-09-14T09:01:00.000Z", sources: [] }
      : { ...completedRefreshJob(), id, status: "failed", message: "Current visit evidence" })));
    const region = await screen.findByRole(field === "syncRun" ? "dialog" : "region", {
      name: field === "syncRun" ? "Sync run details" : "Selected package refresh job",
    });
    await waitFor(() => expect(region).toHaveTextContent(id));
    await act(async () => {
      pending[0].resolve(Response.json({ code: "unauthorized", detail: "Retired visit error" }, { status: 401 }));
      pending[1].resolve(Response.json({ id: otherId, status: "running", message: "Retired visit evidence" }));
    });
    expect(region).toHaveTextContent(id);
    expect(screen.queryByText(/Retired visit/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading exact sync run|Loading package refresh status/)).not.toBeInTheDocument();
    expect(transport.meCalls()).toBe(1);
    expect(requests).toHaveLength(3);
    expect(new URLSearchParams(window.location.search).get(field)).toBe(id);
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

  it("does not invalidate inventory again when revisiting a completed package job", async () => {
    window.history.replaceState({}, "", "/sync?refreshJob=refresh-first-load");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Selected package refresh job" })).toHaveTextContent("succeeded"));
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    await screen.findByText(agent.displayName);
    const before = transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agent-inventory/selections").length;
    for (let index = 0; index < 2; index++) {
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await waitFor(() => expect(screen.getByRole("region", { name: "Selected package refresh job" })).toHaveTextContent("succeeded"));
      await userEvent.click(screen.getByRole("button", { name: "Agents" }));
      await screen.findByText(agent.displayName);
    }
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agent-inventory/selections")).toHaveLength(before);
  });

  it("recovers invalidated refresh target pages with one status read and no repeated inventory invalidation or provider admission", async () => {
    window.history.replaceState({}, "", "/sync?refreshJob=target-progress&mode=application");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const job = { ...completedRefreshJob(), id: "target-progress", scopeKind: "exact", tokenMode: "application", targetCount: 1 };
    let statusReads = 0;
    transport.fetchMock.mockImplementation((input, init) => {
      const url = new URL(input, "http://localhost");
      if (input === "/api/agents/refresh-jobs/target-progress?mode=application") {
        statusReads += 1;
        return statusReads === 1 ? Promise.resolve(Response.json({ ...job, resultRevision: "1" })) : pending.promise;
      }
      if (url.pathname === "/api/agents/refresh-jobs/target-progress/targets") {
        return Promise.resolve(url.searchParams.get("revision") === "1"
          ? Response.json({ code: "selection_invalidated", detail: "Target progress changed." }, { status: 409 })
          : Response.json({ value: [{ id: "Recovered target", ordinal: 0, status: "published" }], revision: "2",
            counts: { total: 1, filtered: 1 }, page: { limit: 50, nextCursor: null, previousCursor: null } }));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText("Refresh progress changed. Refresh status to restart target pages.");
    const inventoryReads = () => transport.fetchMock.mock.calls.filter(([input]) =>
      ["/api/agent-inventory", "/api/agent-inventory/selections"].includes(new URL(input, "http://localhost").pathname)).length;
    const before = inventoryReads();
    const button = screen.getByRole("button", { name: "Refresh status" });
    act(() => { button.click(); button.click(); });
    await screen.findByText("Loading package refresh status…");
    expect(screen.queryByText("Refresh progress changed. Refresh status to restart target pages.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh status" })).not.toBeInTheDocument();
    expect(statusReads).toBe(2);
    await act(async () => pending.resolve(Response.json({ ...job, resultRevision: "2" })));
    expect(await screen.findByText("Recovered target")).toBeVisible();
    expect(screen.queryByText("Loading package refresh status…")).not.toBeInTheDocument();
    const targetReads = transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname.endsWith("/targets"));
    expect(targetReads).toHaveLength(2);
    expect(targetReads[1][0]).toBe("/api/agents/refresh-jobs/target-progress/targets?mode=application&revision=2&limit=50");
    expect(inventoryReads()).toBe(before);
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(selectedRefreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.filter(([input, init]) =>
      input.startsWith("/api/agents/refresh-jobs") && (init?.method ?? "GET") !== "GET")).toHaveLength(0);
  });

  it("retries failed linked refresh status explicitly and cancels the retry when its bookmark changes", async () => {
    window.history.replaceState({}, "", "/sync?refreshJob=unavailable-refresh");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let oldReads = 0;
    transport.fetchMock.mockImplementation((input, init) => {
      if (input === "/api/agents/refresh-jobs/unavailable-refresh?mode=delegated") {
        oldReads += 1;
        return oldReads === 1 ? Promise.resolve(Response.json({ code: "unavailable", detail: "Status unavailable." }, { status: 503 }))
          : pending.promise;
      }
      if (input === "/api/agents/refresh-jobs/current-refresh?mode=delegated") {
        return Promise.resolve(Response.json({ ...completedRefreshJob(), id: "current-refresh" }));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText(/Status unavailable/)).toHaveTextContent("Unable to read package refresh status.");
    expect(screen.queryByText("Loading package refresh status…")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await screen.findByText("Loading package refresh status…");
    expect(oldReads).toBe(2);
    const request = transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agents/refresh-jobs/unavailable-refresh?mode=delegated").at(-1)!;
    act(() => {
      window.history.pushState({}, "", "/sync?refreshJob=current-refresh");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByRole("region", { name: "Selected package refresh job" })).toHaveTextContent("current-refresh");
    expect(request[1]?.signal?.aborted).toBe(true);
    const sessionReads = transport.meCalls();
    await act(async () => pending.resolve(Response.json({ code: "unauthorized", detail: "Retired account error" }, { status: 401 })));
    expect(screen.getByRole("region", { name: "Selected package refresh job" })).toHaveTextContent("current-refresh");
    expect(screen.queryByText(/Retired account error/)).not.toBeInTheDocument();
    expect(transport.meCalls()).toBe(sessionReads);
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("does not admit a manual linked refresh status read while its poll is pending", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/sync?refreshJob=pending-poll");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let statusReads = 0;
    transport.fetchMock.mockImplementation((input, init) => {
      if (input === "/api/agents/refresh-jobs/pending-poll?mode=delegated") {
        statusReads += 1;
        return statusReads === 1 ? Promise.resolve(Response.json({ ...completedRefreshJob(), id: "pending-poll", status: "running" }))
          : pending.promise;
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const view = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(statusReads).toBe(2);
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(statusReads).toBe(2);
    await act(async () => pending.resolve(Response.json({ ...completedRefreshJob(), id: "pending-poll" })));
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    expect(screen.queryByText("Loading package refresh status…")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Selected package refresh job" })).toHaveTextContent("succeeded");
    view.unmount();
  });

  it("removes a linked refresh failure when its bookmark is no longer selected", async () => {
    window.history.replaceState({}, "", "/sync?refreshJob=missing-refresh");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => input === "/api/agents/refresh-jobs/missing-refresh?mode=delegated"
      ? Promise.resolve(Response.json({ code: "job_not_found", detail: "Previous refresh is unavailable." }, { status: 404 }))
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(/Previous refresh is unavailable/);
    act(() => {
      window.history.pushState({}, "", "/sync");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.queryByText(/Previous refresh is unavailable/)).not.toBeInTheDocument());
  });

  it("keeps independent control and refresh bookmark errors", async () => {
    window.history.replaceState({}, "", "/agents?controlJob=missing-control&refreshJob=missing-refresh");
    const transport = appTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"] });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => {
      if (input === "/api/agents/refresh-jobs/missing-refresh?mode=delegated") {
        return Promise.resolve(Response.json({ code: "job_not_found", detail: "Refresh bookmark failure." }, { status: 404 }));
      }
      if (input === "/api/agents/bulk-jobs/missing-control") {
        return Promise.resolve(Response.json({ code: "job_not_found", detail: "Control bookmark failure." }, { status: 404 }));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText(/Refresh bookmark failure/)).toBeVisible();
    expect(await screen.findByText(/Control bookmark failure/)).toBeVisible();
    act(() => {
      window.history.pushState({}, "", "/agents?controlJob=missing-control");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.queryByText(/Refresh bookmark failure/)).not.toBeInTheDocument());
    expect(screen.getByText(/Control bookmark failure/)).toBeVisible();
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

  it("keeps bulk access preview failures in the current draft without leaking a global error", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    let failPreview = true;
    transport.fetchMock.mockImplementation((input, init) => {
      if (input === "/api/agents/mutation-preview" && failPreview) {
        return Promise.resolve(Response.json({
          code: "preview_failed", detail: "The previous bulk access preview failed.",
        }, { status: 500 }));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
    await userEvent.click(screen.getByRole("button", { name: "Manage access" }));
    const editor = await screen.findByRole("dialog", { name: "Manage agent access" });
    await userEvent.click(within(editor).getByRole("radio", { name: /No users/ }));
    await userEvent.click(within(editor).getByRole("button", { name: "Apply" }));
    await userEvent.click(within(editor).getByRole("button", { name: "Confirm and apply" }));
    expect(await within(editor).findByText("The previous bulk access preview failed.")).toBeVisible();
    expect(screen.getAllByText("The previous bulk access preview failed.")).toHaveLength(1);
    const callsAfterFailure = transport.fetchMock.mock.calls.length;

    await userEvent.click(within(editor).getByRole("button", { name: /^Installed for/ }));
    expect(screen.queryByText("The previous bulk access preview failed.")).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls).toHaveLength(callsAfterFailure);
    failPreview = false;
    await userEvent.click(within(editor).getByRole("button", { name: "Apply" }));
    await userEvent.click(within(editor).getByRole("button", { name: "Confirm and apply" }));

    expect(await screen.findByRole("dialog", { name: /update installation package\?/i })).toBeVisible();
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/mutation-preview")).toHaveLength(2);
    expect(screen.queryByText("The previous bulk access preview failed.")).not.toBeInTheDocument();
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

  it.each(["exact targets", "grouped targets", "all-matching targets", "sort"].flatMap(boundary =>
    [200, 401].map(status => ({ boundary, status }))))(
    "retires a pending bulk preview after changing $boundary, ignoring late HTTP $status",
    async ({ boundary, status }) => {
      const transport = accessEditorTransport(), pending = deferredResponse();
      const base = transport.fetchMock.getMockImplementation()!;
      const groupedPage = { ...unifiedPage, value: [{ ...unifiedPage.value[0],
        id: "agent:11111111-1111-4111-8111-111111111111", packagesComplete: false, packageCount: 2 }] };
      let preview!: Response;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (boundary === "grouped targets" && new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
          return Response.json(selectedInventoryPage(input, groupedPage));
        }
        if (boundary === "grouped targets" && input === "/api/agents/mutation-selection") return Response.json({ count: 2 });
        if (input === "/api/agents/mutation-preview") {
          preview = await base(input, init);
          return pending.promise;
        }
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      const row = await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` });
      if (boundary === "all-matching targets") {
        await userEvent.click(screen.getByRole("button", { name: "Select all 1 matching published versions" }));
      } else await userEvent.click(row);
      await userEvent.click(await screen.findByRole("button", { name: "Block selected packages" }));
      await waitFor(() => expect(preview).toBeDefined());
      const request = transport.fetchMock.mock.calls.find(([path]) => path === "/api/agents/mutation-preview")!;
      if (boundary === "all-matching targets") {
        await userEvent.click(screen.getByRole("button", { name: "Clear all-matching package selection" }));
      } else if (boundary === "sort") {
        await userEvent.click(screen.getByRole("button", { name: "Sort by Agent" }));
      } else await userEvent.click(row);
      await waitFor(() => expect(request[1]?.signal?.aborted).toBe(true));
      expect(screen.queryByText("Preparing block preview…")).not.toBeInTheDocument();
      const sessionReads = transport.session.meCalls();
      await act(async () => pending.resolve(status === 200 ? preview
        : Response.json({ code: "unauthorized", detail: "Retired selection preview." }, { status: 401 })));
      expect(screen.queryByRole("dialog", { name: /^block package/i })).not.toBeInTheDocument();
      expect(screen.queryByText("Retired selection preview.")).not.toBeInTheDocument();
      expect(transport.session.meCalls()).toBe(sessionReads);
      expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/mutation-preview")).toHaveLength(1);
      expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/block")).toHaveLength(0);
    },
  );

  it.each(["success", "failure"] as const)("retires a pending block preview when Manage access replaces it (%s)", async outcome => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let preview!: Response;
    transport.fetchMock.mockImplementation(async (input, init) => {
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
    await userEvent.click(screen.getByRole("button", { name: "Manage access" }));
    expect(await screen.findByRole("dialog", { name: "Manage agent access" })).toBeVisible();
    const request = transport.fetchMock.mock.calls.find(([path]) => path === "/api/agents/mutation-preview");
    expect(request?.[1]?.signal?.aborted).toBe(true);
    expect(screen.queryByText("Preparing block preview…")).not.toBeInTheDocument();
    await act(async () => pending.resolve(outcome === "success" ? preview
      : Response.json({ code: "preview_failed", detail: "Replaced block preview failed." }, { status: 500 })));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: /^block package/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Replaced block preview failed.")).not.toBeInTheDocument();
  });

  it("admits one identical bulk preview and one confirmed submission in the same React batch", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pendingPreview = deferredResponse();
    const pendingSubmit = deferredResponse();
    let preview!: Response;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/agents/mutation-preview") {
        preview = await base(input, init);
        return pendingPreview.promise;
      }
      if (input === "/api/agents/block") return pendingSubmit.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
    const prepare = screen.getByRole("button", { name: "Block selected packages" });
    act(() => { fireEvent.click(prepare); fireEvent.click(prepare); });
    await waitFor(() => expect(preview).toBeDefined());
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/mutation-preview")).toHaveLength(1);
    await act(async () => pendingPreview.resolve(preview));
    const confirm = await screen.findByRole("button", { name: "Block package" });
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm); });
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/block")).toHaveLength(1);
    await act(async () => pendingSubmit.resolve(Response.json(waitingBulkJob())));
    expect(await screen.findByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
  });

  it("shares terminal result reads and invalidates inventory once even when reading results fails", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const job: BulkActionJob = { ...waitingBulkJob(), status: "succeeded", canResume: false,
      total: 1, completed: 1, succeeded: 1, inconclusive: 0, queued: 0, reconciliationRequired: 0 };
    const endpoint = `/api/agents/bulk-jobs/${job.id}`;
    let failResults = true;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/agents/block") return Response.json(job);
      if (input === endpoint) return Response.json(job);
      if (input.startsWith(`${endpoint}/items?`)) return failResults ? pending.promise : Response.json({
        value: [{ id: agent.id, displayName: agent.displayName, status: "succeeded" }],
        revision: job.resultRevision, counts: { total: 1, filtered: 1 },
        page: { limit: 50, nextCursor: null, previousCursor: null },
      });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
    await userEvent.click(screen.getByRole("button", { name: "Block selected packages" }));
    const confirm = await screen.findByRole("button", { name: "Block package" });
    const captures = () => transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agent-inventory/selections").length;
    const before = captures();
    await userEvent.click(confirm);
    const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
    expect(transport.fetchMock.mock.calls.filter(([path]) => path.startsWith(`${endpoint}/items?`))).toHaveLength(1);
    await act(async () => pending.resolve(Response.json({ code: "unavailable", detail: "Results unavailable." }, { status: 503 })));
    await waitFor(() => expect(captures()).toBe(before + 1));
    expect(panel.queryByRole("button", { name: "Retry results" })).not.toBeInTheDocument();
    failResults = false;
    await userEvent.click(await panel.findByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(panel.queryByRole("alert")).not.toBeInTheDocument());
    await waitFor(() => expect(panel.getByText(agent.displayName)).toBeVisible());
    expect(transport.fetchMock.mock.calls.filter(([path]) => path.startsWith(`${endpoint}/items?`))).toHaveLength(2);
    expect(captures()).toBe(before + 1);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/block")).toHaveLength(1);
    expect(screen.getByRole("button", { name: `Block ${agent.displayName}` })).toBeVisible();
  });

  it.each(["succeeded", "skipped", "unsent"] as const)(
    "invalidates paused package job readbacks once, only when published (%s)",
    async outcome => {
      const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
      const published = outcome !== "unsent";
      const job: BulkActionJob = { ...waitingBulkJob(), completed: published ? 1 : 0,
        succeeded: outcome === "succeeded" ? 1 : 0, skipped: outcome === "skipped" ? 1 : 0,
        inconclusive: 0, reconciliationRequired: 0, queued: published ? 1 : 2 };
      let changed = false;
      let resultsUnavailable = true;
      transport.fetchMock.mockImplementation((input, init) => {
        if (input === "/api/agents/block") {
          changed = published;
          return Promise.resolve(Response.json(job));
        }
        if (input === `/api/agents/bulk-jobs/${job.id}`) return Promise.resolve(Response.json(job));
        if (resultsUnavailable && input.startsWith(`/api/agents/bulk-jobs/${job.id}/items?`)) {
          return Promise.resolve(Response.json({ code: "selection_invalidated", detail: "Results changed." }, { status: 409 }));
        }
        if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
          return Promise.resolve(Response.json(selectedInventoryPage(input, {
            ...unifiedPage, value: [{ ...unifiedPage.value[0], packages: [{ ...agent, isBlocked: changed }] }],
          })));
        }
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
      await userEvent.click(screen.getByRole("button", { name: "Block selected packages" }));
      const confirm = await screen.findByRole("button", { name: "Block package" });
      const captures = () => transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agent-inventory/selections").length;
      const before = captures();
      await userEvent.click(confirm);
      const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
      await waitFor(() => expect(panel.getByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled());
      await waitFor(() => expect(captures()).toBe(before + (published ? 1 : 0)));
      expect(await screen.findByRole("button", { name: `${published ? "Unblock" : "Block"} ${agent.displayName}` })).toBeVisible();
      resultsUnavailable = false;
      await userEvent.click(await panel.findByRole("button", { name: "Refresh status" }));
      await waitFor(() => expect(panel.queryByText("Checking status...")).not.toBeInTheDocument());
      await waitFor(() => expect(panel.queryByRole("alert")).not.toBeInTheDocument());
      expect(captures()).toBe(before + (published ? 1 : 0));
      expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
      expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/block")).toHaveLength(1);
    },
  );

  it("invalidates verified package readbacks when polling is interrupted, without replaying the mutation", async () => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const job: BulkActionJob = { ...waitingBulkJob(), status: "running", canResume: false,
      succeeded: 1, inconclusive: 0, reconciliationRequired: 0 };
    transport.fetchMock.mockImplementation((input, init) => {
      if (input === "/api/agents/block") return Promise.resolve(Response.json(job));
      if (input === `/api/agents/bulk-jobs/${job.id}`) return Promise.resolve(Response.json({
        code: "unavailable", detail: "Package status unavailable.",
      }, { status: 503 }));
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
    await userEvent.click(screen.getByRole("button", { name: "Block selected packages" }));
    const confirm = await screen.findByRole("button", { name: "Block package" });
    const captures = () => transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agent-inventory/selections").length;
    const before = captures();
    await userEvent.click(confirm);
    const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
    expect(await panel.findByRole("alert", {}, { timeout: 3_000 })).toHaveTextContent("Package status unavailable.");
    await waitFor(() => expect(captures()).toBe(before + 1));
    expect(panel.getByRole("status")).toHaveTextContent("Last reported: Running");
    await userEvent.click(panel.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(panel.getByRole("button", { name: "Refresh status" })).toBeEnabled());
    expect(captures()).toBe(before + 1);
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/block")).toHaveLength(1);
  });

  it.each((["succeeded", "failed"] as const).flatMap(status =>
    (["single", "bulk"] as const).map(scope => ({ status, scope }))))(
    "preserves an independent exact selection when recovering a $status $scope package job",
    async ({ status, scope }) => {
      const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
      const other = { ...agent, id: "newly-selected-package", displayName: "Newer selection" };
      const page = unifiedRecordsPage([unifiedPage.value[0], {
        ...unifiedPage.value[0], id: `graph_packages:${other.id}`, displayName: other.displayName, packages: [other],
      }]);
      const job: BulkActionJob = { ...waitingBulkJob(), status, canResume: false, total: 1, completed: 1,
        succeeded: status === "succeeded" ? 1 : 0, failed: status === "failed" ? 1 : 0,
        inconclusive: 0, queued: 0, reconciliationRequired: 0 };
      const submitPath = scope === "bulk" ? "/api/agents/block" : `/api/agents/${agent.id}/block`;
      let resultsUnavailable = true;
      transport.fetchMock.mockImplementation((input, init) => {
        if (input === submitPath || input === `/api/agents/bulk-jobs/${job.id}`) {
          return Promise.resolve(Response.json(job));
        }
        if (input.startsWith(`/api/agents/bulk-jobs/${job.id}/items?`)) return Promise.resolve(resultsUnavailable
          ? Response.json({ code: "unavailable", detail: "Package results unavailable." }, { status: 503 })
          : Response.json({
            value: [{ id: agent.id, displayName: agent.displayName, status }], revision: job.resultRevision,
            counts: { total: 1, filtered: 1 }, page: { limit: 50, nextCursor: null, previousCursor: null },
          }));
        if (new URL(input, "http://localhost").pathname === "/api/agent-inventory") {
          return Promise.resolve(Response.json(selectedInventoryPage(input, page)));
        }
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${scope === "bulk" ? agent.displayName : other.displayName}` }));
      await userEvent.click(screen.getByRole("button", { name: scope === "bulk" ? "Block selected packages" : `Block ${agent.displayName}` }));
      await userEvent.click(await screen.findByRole("button", { name: "Block package" }));
      const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
      await panel.findByRole("button", { name: "Refresh status" });
      const original = screen.getByRole("checkbox", { name: `Select ${agent.displayName}` });
      await waitFor(() => expect(original).toBeEnabled());
      const replacement = screen.getByRole("checkbox", { name: `Select ${other.displayName}` });
      if (scope === "bulk") {
        await userEvent.click(original);
        await userEvent.click(replacement);
      }
      resultsUnavailable = false;
      await userEvent.click(panel.getByRole("button", { name: "Refresh status" }));
      await waitFor(() => expect(panel.queryByRole("alert")).not.toBeInTheDocument());
      await waitFor(() => expect(panel.getByText(agent.displayName)).toBeVisible());
      expect(replacement).toBeChecked();
      expect(original).not.toBeChecked();
      expect(transport.fetchMock.mock.calls.filter(([path]) => path === submitPath)).toHaveLength(1);
    },
  );

  it("does not restart an accepted package job when returning to Agents", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const job = waitingBulkJob();
    transport.fetchMock.mockImplementation(async (input, init) =>
      input === `/api/agents/${agent.id}/block` ? Response.json(job) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: `Block ${agent.displayName}` }));
    await userEvent.click(await screen.findByRole("button", { name: "Block package" }));
    await screen.findByRole("button", { name: "Resume unprocessed tasks" });
    const statusReads = () => transport.fetchMock.mock.calls.filter(([path]) => path === `/api/agents/bulk-jobs/${job.id}`).length;
    const before = statusReads();
    await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(await screen.findByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    expect(statusReads()).toBe(before);
  });

  it("does not let job restoration supersede a pending confirmed submission on return to Agents", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let submitting = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === `/api/agents/${agent.id}/block`) {
        submitting = true;
        return pending.promise;
      }
      if (input.startsWith("/api/agents/bulk-jobs?") && submitting) return Response.json({ value: [waitingBulkJob()] });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: `Block ${agent.displayName}` }));
    await userEvent.click(await screen.findByRole("button", { name: "Block package" }));
    const historyReads = () => transport.fetchMock.mock.calls.filter(([path]) => path.startsWith("/api/agents/bulk-jobs?")).length;
    const before = historyReads();
    await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(historyReads()).toBe(before);
    const submission = transport.fetchMock.mock.calls.find(([path]) => path === `/api/agents/${agent.id}/block`);
    expect(submission?.[1]?.signal?.aborted).toBe(false);
    await act(async () => pending.resolve(Response.json({ ...waitingBulkJob(), id: "accepted-package-job" })));
    expect(await screen.findByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBe("accepted-package-job");
  });

  it("retains a restored package job's pending first status read across ordinary navigation", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const job = waitingBulkJob();
    const endpoint = `/api/agents/bulk-jobs/${job.id}`;
    window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    transport.fetchMock.mockImplementation(async (input, init) => input === endpoint ? pending.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const request = transport.fetchMock.mock.calls.find(([path]) => path === endpoint);
    expect(request).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(request?.[1]?.signal?.aborted).toBe(false);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === endpoint)).toHaveLength(1);
    await act(async () => pending.resolve(Response.json(job)));
    expect(await screen.findByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
  });

  it.each(["resume", "cancel"] as const)("invalidates inventory after an explicit bookmarked-job %s, even across navigation", async operation => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const job = waitingBulkJob();
    const pending = deferredResponse();
    const endpoint = `/api/agents/bulk-jobs/${job.id}`;
    const completed: BulkActionJob = { ...job, status: "succeeded", canResume: false,
      total: 1, completed: 1, succeeded: 1, inconclusive: 0, queued: 0, reconciliationRequired: 0, resultRevision: "2" };
    window.history.replaceState(null, "", `/agents?controlJob=${job.id}`);
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === `${endpoint}/${operation}`) return pending.promise;
      if (input.startsWith(`${endpoint}/items?revision=2`)) return Response.json({
        value: [{ id: agent.id, displayName: agent.displayName, status: "succeeded" }],
        revision: "2", counts: { total: 1, filtered: 1 }, page: { limit: 50, nextCursor: null, previousCursor: null },
      });
      return base(input, init);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const label = operation === "resume" ? "Resume unprocessed tasks" : "Cancel unprocessed tasks";
    const captures = () => transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agent-inventory/selections").length;
    const before = captures();
    await userEvent.click(await screen.findByRole("button", { name: label }));
    await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
    const command = transport.fetchMock.mock.calls.find(([path]) => path === `${endpoint}/${operation}`);
    expect(command?.[1]?.signal?.aborted).toBe(false);
    await act(async () => pending.resolve(Response.json(completed)));
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
    await waitFor(() => expect(panel.getByRole("status")).toHaveTextContent("Completed"));
    await waitFor(() => expect(captures()).toBe(before + 1));
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === endpoint)).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === `${endpoint}/${operation}`)).toHaveLength(1);
  });

  it("reopens a retained exact job after inspecting a different job", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const job = waitingBulkJob();
    const endpoint = `/api/agents/bulk-jobs/${job.id}`;
    window.history.replaceState(null, "", `/agents?controlJob=${job.id}`);
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === `${endpoint}/resume`) return Response.json(job);
      if (input === "/api/agents/bulk-jobs/other-job") return Response.json({ ...job, id: "other-job", total: 3 });
      return base(input, init);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Resume unprocessed tasks" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled());
    act(() => {
      window.history.pushState({}, "", "/agents?controlJob=other-job");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await screen.findByText("3 published versions in this job");
    act(() => {
      window.history.pushState({}, "", `/agents?controlJob=${job.id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByText("2 published versions in this job")).toBeVisible();
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === endpoint)).toHaveLength(2);
  });

  it("replaces a historical job link when submitting a newly confirmed package change", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const job = waitingBulkJob();
    const endpoint = `/api/agents/bulk-jobs/${job.id}`;
    window.history.replaceState(null, "", `/agents?controlJob=${job.id}`);
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === endpoint) return Response.json({ ...job, status: "failed", canResume: false, queued: 0 });
      if (input === "/api/agents/block") return Response.json({ ...job, id: "new-package-job" });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
    await userEvent.click(await screen.findByRole("button", { name: "Block selected packages" }));
    await userEvent.click(await screen.findByRole("button", { name: "Block package" }));
    expect(await screen.findByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    expect(new URLSearchParams(window.location.search).has("controlJob")).toBe(false);
    expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBe("new-package-job");
    await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(await screen.findByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === endpoint)).toHaveLength(1);
  });

  it("does not invalidate or project reconciled inventory again when status recovery rereads the same revision", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const job = waitingBulkJob();
    const reconciled: BulkActionJob = { ...job, status: "partial", canResume: false,
      completed: 2, succeeded: 1, queued: 0, resultRevision: "2" };
    const endpoint = `/api/agents/bulk-jobs/${job.id}`;
    let checked = false;
    window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === endpoint) return Response.json(checked ? reconciled : job);
      if (input === `${endpoint}/reconcile`) {
        checked = true;
        return Response.json({ ...reconciled, reconciliation: { attempted: 2, failed: 1, errors: [] } });
      }
      if (input.startsWith(`${endpoint}/items?revision=2`)) return Response.json({
        value: [{ id: agent.id, displayName: agent.displayName, status: "succeeded" }],
        revision: "2", counts: { total: 2, filtered: 2 }, page: { limit: 50, nextCursor: null, previousCursor: null },
      });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const captures = () => transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agent-inventory/selections").length;
    const before = captures();
    await userEvent.click(await screen.findByRole("button", { name: "Check uncertain results" }));
    await waitFor(() => expect(captures()).toBe(before + 1));
    const panel = within(screen.getByRole("region", { name: "Exact package bulk actions" }));
    await userEvent.click(await panel.findByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(panel.queryByRole("alert")).not.toBeInTheDocument());
    expect(captures()).toBe(before + 1);
    expect(screen.getByRole("button", { name: `Block ${agent.displayName}` })).toBeVisible();
  });

  it.each([
    ["single", "session revalidation"], ["bulk", "session revalidation"],
    ["single", "scoped agent denial"], ["bulk", "scoped agent denial"],
  ].flatMap(([scope, boundary]) => ["success", "unauthorized"].map(outcome => ({ scope, boundary, outcome }))))(
    "does not track a delayed $scope mutation response after $boundary ($outcome)",
    async ({ scope, boundary, outcome }) => {
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
      const before = transport.session.meCalls();
      expect(transport.fetchMock.mock.calls.find(([path]) => path === endpoint)?.[1]?.signal?.aborted).toBe(true);
      await act(async () => pending.resolve(outcome === "success" ? Response.json(waitingBulkJob())
        : Response.json({ code: "unauthorized", detail: "Retired mutation denial." }, { status: 401 })));
      expect(transport.session.meCalls()).toBe(before);
      expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBeNull();
      expect(screen.queryByRole("group", { name: "Package job progress" })).not.toBeInTheDocument();
    },
  );

  it.each([
    ["resume", "session revalidation"], ["cancel", "session revalidation"], ["reconcile", "session revalidation"],
    ["resume", "scoped agent denial"], ["cancel", "scoped agent denial"], ["reconcile", "scoped agent denial"],
  ].flatMap(([operation, boundary]) => ["success", "unauthorized"].map(outcome => ({ operation, boundary, outcome }))))(
    "discards a delayed package-job $operation response after $boundary ($outcome)",
    async ({ operation, boundary, outcome }) => {
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
      const before = transport.session.meCalls();
      expect(transport.fetchMock.mock.calls.find(([path]) => path === endpoint)?.[1]?.signal?.aborted).toBe(true);
      await act(async () => pending.resolve(outcome === "success" ? Response.json({
        ...job, reconciliation: { attempted: 1, failed: 0, errors: [] },
      }) : Response.json({ code: "unauthorized", detail: "Retired command denial." }, { status: 401 })));
      expect(transport.session.meCalls()).toBe(before);
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
    const { click: download } = mockCsvDownload();
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

  it.each(["success", "unauthorized"] as const)("retires an older running poll before cancellation settles (%s)", async outcome => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const cancellation = deferredResponse();
    const job = { ...waitingBulkJob(), status: "running", canResume: false } satisfies BulkActionJob;
    const jobEndpoint = `/api/agents/bulk-jobs/${job.id}`;
    let polls = 0;
    window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === jobEndpoint) {
        polls += 1;
        return polls === 1 ? Response.json(job) : pending.promise;
      }
      if (input === `${jobEndpoint}/cancel`) return cancellation.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(polls).toBe(2), { timeout: 3_000 });
    const panel = within(screen.getByRole("region", { name: "Exact package bulk actions" }));
    expect(panel.getByRole("group", { name: "Package job progress" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Job controls" })).not.toBeInTheDocument();
    await userEvent.click(panel.getByRole("button", { name: "Cancel unprocessed tasks" }));
    const before = transport.session.meCalls();
    const poll = transport.fetchMock.mock.calls.filter(([path]) => path === jobEndpoint).at(-1);
    expect(poll?.[1]?.signal?.aborted).toBe(true);
    await act(async () => pending.resolve(outcome === "success" ? Response.json(job)
      : Response.json({ code: "unauthorized", detail: "Retired poll denial." }, { status: 401 })));
    expect(transport.session.meCalls()).toBe(before);
    expect(panel.getByRole("button", { name: "Cancelling..." })).toBeDisabled();
    await act(async () => cancellation.resolve(Response.json({ ...job, status: "cancelled" })));
    await waitFor(() => expect(panel.getByRole("status")).toHaveTextContent("Cancelled"));
    expect(panel.getByRole("status")).toHaveTextContent("Cancelled");
    expect(panel.queryByRole("button", { name: "Cancel unprocessed tasks" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBeNull();
    expect(panel.getByText("Unprocessed tasks were cancelled. Changes already in progress may still finish.")).toBeInTheDocument();
  });

  it.each([false, true])("restores interrupted tasks on Agents without a browser pointer, skipping cancelled history (%s)", async cancelledHistory => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const job = waitingBulkJob();
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input.startsWith("/api/agents/bulk-jobs?")) return Response.json({ value: cancelledHistory
        ? [{ ...job, id: "cancelled-job", status: "partial", canResume: false, cancelRequested: true }, job] : [job] });
      if (input === `/api/agents/bulk-jobs/${job.id}`) return Response.json(job);
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
    expect(await panel.findByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    expect(panel.getByRole("link", { name: "Sign in again" })).toBeVisible();
    expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBe(job.id);
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/bulk-jobs/cancelled-job")).toBe(false);
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

  it.each(["saved pointer", "bookmark"] as const)("retries a restored job's initial status failure without submitting new work (%s)", async source => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const job = waitingBulkJob();
    const endpoint = `/api/agents/bulk-jobs/${job.id}`;
    if (source === "saved pointer") window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    else window.history.replaceState(null, "", `/agents?controlJob=${job.id}`);
    let reads = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === endpoint) {
        reads += 1;
        return reads === 1
          ? Response.json({ code: "unavailable", detail: "Job status unavailable." }, { status: 503 })
          : Response.json(job);
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
    expect(await panel.findByRole("alert")).toHaveTextContent("Job status unavailable.");
    const refresh = panel.getByRole("button", { name: "Refresh status" });
    act(() => { fireEvent.click(refresh); fireEvent.click(refresh); });
    expect(await panel.findByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    expect(panel.queryByRole("alert")).not.toBeInTheDocument();
    expect(reads).toBe(2);
    expect(transport.fetchMock.mock.calls.filter(([path, init]) =>
      path.includes("/bulk-jobs") && init?.method === "POST")).toHaveLength(0);
  });

  it.each(["waiting_authorization", "partial"] as const)(
    "keeps an accepted resume queued while status still reports the pre-claim %s snapshot",
    async status => {
      const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
      const job: BulkActionJob = { ...waitingBulkJob(), status };
      const endpoint = `/api/agents/bulk-jobs/${job.id}`;
      let resumed = false;
      let polls = 0;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (input === `${endpoint}/resume`) {
          resumed = true;
          return Response.json({ ...job, status: "queued", canResume: false });
        }
        if (input === endpoint) {
          if (!resumed || ++polls === 1) return Response.json(job);
          return Response.json({ ...job, status: "waiting_authorization", updatedAt: "2026-09-15T08:01:00.000Z" });
        }
        return base(input, init);
      });
      window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
      vi.spyOn(window, "confirm").mockReturnValue(true);
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
      await waitFor(() => expect(panel.getByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled());
      vi.useFakeTimers();
      await act(async () => fireEvent.click(panel.getByRole("button", { name: "Resume unprocessed tasks" })));
      expect(panel.getByRole("status")).toHaveTextContent("Queued");
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(polls).toBe(1);
      expect(panel.getByRole("status")).toHaveTextContent("Queued");
      expect(panel.queryByRole("button", { name: "Resume unprocessed tasks" })).not.toBeInTheDocument();
      expect(panel.getByRole("button", { name: "Cancel unprocessed tasks" })).toBeEnabled();
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(panel.getByRole("status")).toHaveTextContent("Sign-in required");
      expect(panel.getByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(polls).toBe(2);
      expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBe(job.id);
      expect(transport.fetchMock.mock.calls.filter(([path]) => path === `${endpoint}/resume`)).toHaveLength(1);
      expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    },
  );

  it.each(["provider_pending", "constructor", null])(
    "retains an accepted job receipt when its initial status is unsupported (%s)",
    async status => {
      const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
      const job = waitingBulkJob();
      const endpoint = `/api/agents/bulk-jobs/${job.id}`;
      transport.fetchMock.mockImplementation(async (input, init) =>
        input === `/api/agents/${agent.id}/block` ? Response.json({ ...job, status, canResume: false }) : base(input, init));
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("button", { name: `Block ${agent.displayName}` }));
      await userEvent.click(await screen.findByRole("button", { name: "Block package" }));
      const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
      expect(await panel.findByRole("alert")).toHaveTextContent("unrecognized job status");
      expect(screen.getByRole("button", { name: `Block ${agent.displayName}` })).toBeDisabled();
      expect(screen.getByRole("button", { name: `Manage access for ${agent.displayName}` })).toBeDisabled();
      await userEvent.click(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` }));
      expect(panel.queryByRole("button", { name: "Block selected packages" })).not.toBeInTheDocument();
      expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBe(job.id);
      const refresh = panel.getByRole("button", { name: "Refresh status" });
      act(() => { fireEvent.click(refresh); fireEvent.click(refresh); });
      expect(await panel.findByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
      expect(screen.getByRole("button", { name: `Block ${agent.displayName}` })).toBeEnabled();
      expect(panel.queryByRole("alert")).not.toBeInTheDocument();
      expect(transport.fetchMock.mock.calls.filter(([path]) => path === endpoint)).toHaveLength(1);
      expect(transport.fetchMock.mock.calls.filter(([path]) => path === `/api/agents/${agent.id}/block`)).toHaveLength(1);
      expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    },
  );

  it("checks unsupported history status through the exact job instead of silently ignoring it", async () => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const job = waitingBulkJob();
    const endpoint = `/api/agents/bulk-jobs/${job.id}`;
    transport.fetchMock.mockImplementation(async (input, init) => input.startsWith("/api/agents/bulk-jobs?")
      ? Response.json({ value: [{ ...job, status: "provider_pending", canResume: false, reconciliationRequired: 0 }] })
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBe(job.id);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === endpoint)).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([path, init]) => path.includes("/bulk-jobs") && init?.method === "POST")).toHaveLength(0);
  });

  it("stops an unsupported poll with retained last-reported progress and read-only status recovery", async () => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const job: BulkActionJob = { ...waitingBulkJob(), status: "running", canResume: false };
    const endpoint = `/api/agents/bulk-jobs/${job.id}`;
    let reads = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === endpoint) {
        reads += 1;
        return Response.json(reads === 1 ? job : reads === 2
          ? { ...job, status: "provider_pending", resultRevision: "2" }
          : waitingBulkJob());
      }
      return base(input, init);
    });
    window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
    expect(await panel.findByRole("alert", {}, { timeout: 3_000 })).toHaveTextContent("unrecognized job status");
    expect(panel.getByRole("status")).toHaveTextContent("Last reported: Running");
    expect(panel.getByText("1 of 2 processed")).toBeVisible();
    expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBe(job.id);
    expect(transport.fetchMock.mock.calls.some(([path]) => path.startsWith(`${endpoint}/items?revision=2`))).toBe(false);
    await userEvent.click(panel.getByRole("button", { name: "Refresh status" }));
    expect(await panel.findByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    expect(panel.queryByRole("alert")).not.toBeInTheDocument();
    expect(reads).toBe(3);
    expect(transport.fetchMock.mock.calls.filter(([path, init]) => path.includes("/bulk-jobs") && init?.method === "POST")).toHaveLength(0);
  });

  it("preserves a queued resume through status-only recovery and invalidates its terminal publication once", async () => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const job: BulkActionJob = { ...waitingBulkJob(), total: 1, completed: 0, inconclusive: 0, reconciliationRequired: 0 };
    const endpoint = `/api/agents/bulk-jobs/${job.id}`;
    let resumed = false;
    let polls = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === `${endpoint}/resume`) {
        resumed = true;
        return Response.json({ ...job, status: "queued", canResume: false });
      }
      if (input === endpoint) {
        if (!resumed) return Response.json(job);
        polls += 1;
        if (polls === 1) return Response.json({ code: "unavailable", detail: "Status read interrupted." }, { status: 503 });
        return Response.json(polls < 4 ? job : {
          ...job, status: "succeeded", canResume: false, completed: 1, succeeded: 1, queued: 0,
          resultRevision: "2", updatedAt: "2026-09-15T08:01:00.000Z",
        });
      }
      if (input.startsWith(`${endpoint}/items?`)) {
        const revision = new URL(input, "http://localhost").searchParams.get("revision");
        return Response.json({ value: [{ id: agent.id, displayName: agent.displayName, status: revision === "2" ? "succeeded" : "queued" }],
          revision, counts: { total: 1, filtered: 1 }, page: { limit: 50, nextCursor: null, previousCursor: null } });
      }
      return base(input, init);
    });
    window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
    await waitFor(() => expect(panel.getByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled());
    const captures = () => transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agent-inventory/selections").length;
    const before = captures();
    vi.useFakeTimers();
    await act(async () => fireEvent.click(panel.getByRole("button", { name: "Resume unprocessed tasks" })));
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(panel.getByRole("alert")).toHaveTextContent("Status read interrupted.");
    expect(panel.getByRole("status")).toHaveTextContent("Last reported: Queued");
    const refresh = panel.getByRole("button", { name: "Refresh status" });
    await act(async () => { fireEvent.click(refresh); fireEvent.click(refresh); });
    expect(polls).toBe(2);
    expect(panel.getByRole("status")).toHaveTextContent(/^Queued$/);
    expect(panel.queryByRole("alert")).not.toBeInTheDocument();
    expect(panel.queryByRole("button", { name: "Resume unprocessed tasks" })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(panel.getByRole("status")).toHaveTextContent("Completed");
    expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBeNull();
    expect(captures()).toBe(before + 1);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(polls).toBe(4);
    expect(captures()).toBe(before + 1);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path.startsWith(`${endpoint}/items?revision=2`))).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === `${endpoint}/resume`)).toHaveLength(1);
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("retires a queued resume and its late poll when the session is revalidated", async () => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const job = waitingBulkJob();
    const endpoint = `/api/agents/bulk-jobs/${job.id}`;
    const pending = deferredResponse();
    let resumed = false;
    let revalidated = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === `${endpoint}/resume`) {
        resumed = true;
        return Response.json({ ...job, status: "queued", canResume: false });
      }
      if (input === endpoint) return resumed && !revalidated ? pending.promise : Response.json(job);
      return base(input, init);
    });
    window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
    await waitFor(() => expect(panel.getByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled());
    vi.useFakeTimers();
    await act(async () => fireEvent.click(panel.getByRole("button", { name: "Resume unprocessed tasks" })));
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    const oldPoll = transport.fetchMock.mock.calls.filter(([path]) => path === endpoint).at(-1);
    vi.useRealTimers();
    revalidated = true;
    await revalidateTransportSession(transport.session);
    expect(oldPoll?.[1]?.signal?.aborted).toBe(true);
    expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBeNull();
    act(() => {
      window.history.pushState({}, "", `/agents?controlJob=${job.id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const current = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
    expect(await current.findByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    await act(async () => pending.resolve(Response.json({ ...job, status: "provider_pending" })));
    expect(current.getByRole("status")).toHaveTextContent("Sign-in required");
    expect(current.queryByRole("alert")).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === `${endpoint}/resume`)).toHaveLength(1);
  });

  it("bounds queued resume polling even if the worker never advances the paused snapshot", async () => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const job = waitingBulkJob();
    const endpoint = `/api/agents/bulk-jobs/${job.id}`;
    transport.fetchMock.mockImplementation(async (input, init) => input === `${endpoint}/resume`
      ? Response.json({ ...job, status: "queued", canResume: false }) : base(input, init));
    window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
    await waitFor(() => expect(panel.getByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled());
    vi.useFakeTimers();
    await act(async () => fireEvent.click(panel.getByRole("button", { name: "Resume unprocessed tasks" })));
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(panel.getByRole("alert")).toHaveTextContent("Automatic status updates paused after five minutes");
    expect(panel.getByRole("status")).toHaveTextContent("Last reported: Queued");
    expect(panel.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    const polls = transport.fetchMock.mock.calls.filter(([path]) => path === endpoint).length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === endpoint)).toHaveLength(polls);
    expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBe(job.id);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === `${endpoint}/resume`)).toHaveLength(1);
  });

  it("does not publish unsupported reconciliation status or invalidate its claimed successes", async () => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const job = waitingBulkJob();
    const endpoint = `/api/agents/bulk-jobs/${job.id}`;
    let unsupported = false;
    let recoveryFails = true;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === `${endpoint}/reconcile`) {
        unsupported = true;
        return Response.json({ ...job, status: "provider_pending", completed: 2, succeeded: 2, resultRevision: "2",
          reconciliation: { attempted: 1, failed: 0, errors: [] } });
      }
      if (input === endpoint && unsupported && recoveryFails) {
        return Response.json({ code: "unavailable", detail: "Status recovery unavailable." }, { status: 503 });
      }
      return base(input, init);
    });
    window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
    await waitFor(() => expect(panel.getByRole("button", { name: "Check uncertain results" })).toBeEnabled());
    const captures = () => transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agent-inventory/selections").length;
    const before = captures();
    await userEvent.click(panel.getByRole("button", { name: "Check uncertain results" }));
    expect(await panel.findByRole("alert")).toHaveTextContent("unrecognized job status");
    expect(panel.getByRole("status")).toHaveTextContent("Last reported: Sign-in required");
    expect(panel.getByRole("button", { name: "Resume unprocessed tasks" })).toBeDisabled();
    expect(panel.getByRole("button", { name: "Check uncertain results" })).toBeDisabled();
    expect(panel.getByRole("button", { name: "Cancel unprocessed tasks" })).toBeEnabled();
    expect(panel.getByText("1 of 2 processed")).toBeVisible();
    expect(captures()).toBe(before);
    await userEvent.click(panel.getByRole("button", { name: "Refresh status" }));
    expect(await panel.findByRole("alert")).toHaveTextContent("Status recovery unavailable.");
    expect(panel.getByRole("button", { name: "Resume unprocessed tasks" })).toBeDisabled();
    expect(panel.getByRole("button", { name: "Check uncertain results" })).toBeDisabled();
    expect(panel.getByRole("status")).toHaveTextContent("Last reported: Sign-in required");
    expect(screen.getByRole("button", { name: `Block ${agent.displayName}` })).toBeDisabled();
    recoveryFails = false;
    await userEvent.click(panel.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(panel.queryByRole("alert")).not.toBeInTheDocument());
    expect(panel.getByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    expect(panel.getByRole("button", { name: "Check uncertain results" })).toBeEnabled();
    expect(screen.getByRole("button", { name: `Block ${agent.displayName}` })).toBeEnabled();
    expect(captures()).toBe(before);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === `${endpoint}/reconcile`)).toHaveLength(1);
  });

  it("does not restore mutation admission from a stale running snapshot after unknown status and failed cancellation", async () => {
    const transport = accessEditorTransport(), base = transport.fetchMock.getMockImplementation()!;
    const job: BulkActionJob = { ...waitingBulkJob(), status: "running", canResume: false };
    const endpoint = `/api/agents/bulk-jobs/${job.id}`;
    let reads = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === endpoint) return Response.json(++reads === 1 ? job : { ...job, status: "provider_pending" });
      if (input === `${endpoint}/cancel`) return Response.json({ code: "unavailable", detail: "Cancellation unavailable." }, { status: 503 });
      return base(input, init);
    });
    window.localStorage.setItem(activeBulkJobStorageKey(), job.id);
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const panel = within(await screen.findByRole("region", { name: "Exact package bulk actions" }));
    expect(await panel.findByRole("alert", {}, { timeout: 3_000 })).toHaveTextContent("unrecognized job status");
    await userEvent.click(panel.getByRole("button", { name: "Cancel unprocessed tasks" }));
    expect(await panel.findByRole("alert")).toHaveTextContent("Cancellation unavailable.");
    expect(panel.getByRole("status")).toHaveTextContent("Last reported: Running");
    expect(screen.getByRole("button", { name: `Block ${agent.displayName}` })).toBeDisabled();
    expect(panel.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBe(job.id);
    vi.useFakeTimers();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(reads).toBe(2);
    vi.useRealTimers();
    await revalidateTransportSession(transport.session);
    expect(await screen.findByRole("button", { name: `Block ${agent.displayName}` })).toBeEnabled();
    expect(screen.queryByText("Cancellation unavailable.")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(activeBulkJobStorageKey())).toBeNull();
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

  it.each(["filter change", "clear filters", "selection invalidation"] as const)(
    "clears cancelled access preparation after %s without reopening a stale editor",
    async boundary => {
      if (boundary === "clear filters") window.history.replaceState({}, "", "/agents?q=Sensitive");
      const transport = accessEditorTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      transport.exactResponse = () => pending.promise;
      let invalidateFacets = false;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (invalidateFacets && new URL(input, "http://localhost").pathname === "/api/agent-inventory/facets") {
          return Response.json({ code: "selection_invalidated", detail: "The selected inventory expired." }, { status: 409 });
        }
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("button", { name: `Manage access for ${agent.displayName}` }));
      expect(screen.getByText("Loading agent details...")).toBeVisible();

      if (boundary === "filter change") {
        fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Sensitive" } });
      } else if (boundary === "clear filters") {
        await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
      } else {
        invalidateFacets = true;
        await userEvent.click(screen.getByRole("button", { name: "Filters" }));
        await screen.findByRole("button", { name: "Reload saved agent inventory" });
      }

      await waitFor(() => expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument());
      await act(async () => pending.resolve(Response.json(completedRefreshJob())));
      expect(screen.queryByRole("dialog", { name: "Manage agent access" })).not.toBeInTheDocument();
      expect(transport.fetchMock.mock.calls.some(([path]) => isPackageDetailRequest(path, agent.id))).toBe(false);

      invalidateFacets = false;
      transport.exactResponse = undefined;
      if (boundary === "selection invalidation") {
        await userEvent.click(screen.getByRole("button", { name: "Reload saved agent inventory" }));
      }
      await userEvent.click(await screen.findByRole("button", { name: `Manage access for ${agent.displayName}` }));
      expect(await screen.findByRole("dialog", { name: "Manage agent access" })).toBeVisible();
      expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument();
    },
  );

  it.each(["details", "access"] as const)("clears a pending block preview when opening %s", async destination => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let preview: Response | undefined;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/agents/mutation-preview") {
        preview = await base(input, init);
        return pending.promise;
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: `Block ${agent.displayName}` }));
    await waitFor(() => expect(preview).toBeDefined());
    await userEvent.click(screen.getByRole("button", {
      name: `${destination === "details" ? "View details" : "Manage access"} for ${agent.displayName}`,
    }));
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => isPackageDetailRequest(path, agent.id))).toBe(true));
    expect(screen.getByRole("button", { name: `Block ${agent.displayName}` })).toBeEnabled();
    await act(async () => pending.resolve(preview!));
    expect(screen.queryByRole("dialog", { name: /block package/i })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: destination === "details" ? agent.displayName : "Manage agent access" })).toBeVisible();
  });

  it.each(["access preparation", "block preview"] as const)(
    "cancels %s transport so a retired authorization failure cannot clear the current session",
    async operation => {
      const transport = accessEditorTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const path = operation === "access preparation"
        ? `/api/agents/${agent.id}/refresh-jobs` : "/api/agents/mutation-preview";
      transport.fetchMock.mockImplementation((input, init) => input === path ? pending.promise : base(input, init));
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("button", {
        name: operation === "access preparation" ? `Manage access for ${agent.displayName}` : `Block ${agent.displayName}`,
      }));
      await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) => input === path)).toBe(true));
      const request = transport.fetchMock.mock.calls.find(([input]) => input === path)!;
      await userEvent.click(screen.getByRole("button", { name: "Users" }));
      await screen.findByRole("button", { name: "Ada" });
      const sessionReads = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/me").length;
      const before = sessionReads();
      await act(async () => pending.resolve(Response.json({
        code: "unauthorized", detail: "Retired request session expired.",
      }, { status: 401 })));
      expect(sessionReads()).toBe(before);
      expect(request[1]?.signal?.aborted).toBe(true);
      expect(screen.getByRole("button", { name: "Ada" })).toBeVisible();
      expect(screen.queryByText("Retired request session expired.")).not.toBeInTheDocument();
    },
  );

  it.each(["Refresh agents", "Refresh matching details"] as const)(
    "aborts retired %s admission on browser navigation before processing late authorization errors",
    async action => {
      const transport = initialCatalogTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const path = action === "Refresh agents" ? "/api/agents/refresh-jobs" : "/api/agents/refresh-selection";
      transport.fetchMock.mockImplementation((input, init) => input === path && init?.method === "POST"
        ? pending.promise : base(input, init));
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
      await userEvent.click(screen.getByText("View diagnostics"));
      await userEvent.click(screen.getByRole("button", { name: action }));
      await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) => input === path)).toBe(true));
      const request = transport.fetchMock.mock.calls.find(([input]) => input === path)!;
      act(() => {
        window.history.pushState({}, "", "/users");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await screen.findByRole("button", { name: "Ada" });
      const before = transport.session.meCalls();
      await act(async () => pending.resolve(Response.json({ code: "unauthorized", detail: "Retired refresh session." }, { status: 401 })));
      expect(transport.session.meCalls()).toBe(before);
      expect(request[1]?.signal?.aborted).toBe(true);
      expect(screen.getByRole("button", { name: "Ada" })).toBeVisible();
      expect(screen.queryByText("Retired refresh session.")).not.toBeInTheDocument();
    },
  );

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
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = vi.fn();
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    filenames.push(this.download);
    hrefs.push(this.getAttribute("href")!);
  });
  return { filenames, hrefs, createObjectURL, click };
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
    if (["/api/official-usage/history", "/api/official-usage/history/options"].includes(new URL(input, "http://localhost").pathname) && reportHistory) return Response.json(reportHistory);
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
    freshness: { ...response.freshness, capturedRevision: selected.selection.revision },
    usageContext: { ...response.usageContext, revision: selected.selection.id },
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
  return { ...page, selection: capture.selection,
    freshness: { ...page.freshness, capturedRevision: capture.selection.revision },
    usageContext: { ...page.usageContext, revision: capture.selection.id } };
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

function accessEditorTransport(revalidatedUser = viewer) {
  const base = initialCatalogTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"], revalidatedUser });
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
