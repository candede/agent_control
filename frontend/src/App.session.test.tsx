import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions, workbenchViews } from "../../backend/src/services/workbenchMetadata";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import App from "./App";
import {
  getAgents,
  powerPlatformResourceTypes,
  type BulkActionJob,
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
import { storePackageSelection } from "./packageSelectionSession";
import * as savedQueries from "./savedQueries";
import { mockNativeDialogs } from "./test/dialog";
import { copilotUsageFixture } from "./test/copilotUsageFixture";
import { usageAggregateFixture, usageAgentDetailFixture, usageOverviewFixture, usageUsersFixture } from "./test/usageInsightsFixture";
import { createInventoryVerification, createUnifiedVerification } from "./test/inventoryVerification";

mockNativeDialogs();

const viewer: SessionUser = {
  displayName: "Current viewer",
  username: "viewer@example.invalid",
  homeAccountId: "viewer-1",
  tenantId: "tenant-1",
  roles: ["AgentControl.Viewer"],
};

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

const packagePage: PackagePage = {
  value: [agent],
  count: 1,
  snapshot: {
    id: "snapshot-private",
    tokenMode: "delegated",
    requestedIds: [],
    observedCount: 1,
    totalRecords: 1,
    pageCount: 1,
    observedAt: "2026-09-10T08:00:00.000Z",
    expiresAt: "2026-09-10T09:00:00.000Z",
    scopeKind: "broad",
  },
  summary: { total: 1, allowed: 1, blocked: 0 },
  filteredSummary: { total: 1, allowed: 1, blocked: 0 },
  facets: { publishers: [], availability: [], hosts: [], platforms: [] },
};

const unifiedRevision = "a".repeat(64);
const unifiedPage: UnifiedAgentInventoryPage = {
  revision: unifiedRevision,
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
        id: packagePage.snapshot!.id,
        snapshotId: packagePage.snapshot!.id,
        observedAt: packagePage.snapshot!.observedAt,
        expiresAt: packagePage.snapshot!.expiresAt,
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
  count: 1,
  offset: 0,
  limit: 50,
  facets: {
    environments: [{ value: "env-a", label: "Finance" }, { value: "env-b", label: "Development" }],
    platforms: [{ value: "studio", label: "Copilot Studio" }],
  },
  summary: { total: 1, linked: 0, graphOnly: 1, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 },
  filteredSummary: { total: 1, linked: 0, graphOnly: 1, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 },
  sources: {
    graphPackages: {
      state: "available",
      observation: {
        id: packagePage.snapshot!.id,
        snapshotId: packagePage.snapshot!.id,
        observedAt: packagePage.snapshot!.observedAt,
        expiresAt: packagePage.snapshot!.expiresAt,
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
};

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
    count,
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
    ...unifiedPage, count: 1, summary, filteredSummary: { ...summary, total: 1 },
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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["package-summaries", "inventory-refresh-jobs", "official-usage-aggregate", "package-detail"] as const)(
    "does not reattach a post-action %s read to another observer's pre-action request",
    async resource => {
      const usage = resource === "official-usage-aggregate";
      const detail = resource === "package-detail";
      window.history.replaceState({}, "", usage ? "/official-usage?view=snapshot" : detail ? "/agents" : "/sync");
      const client = savedQueries.createSavedQueryClient();
      const admittedKeys = new Map<string, readonly unknown[]>();
      const unsubscribe = client.getQueryCache().subscribe(event => {
        const name = event.query.queryKey[1];
        if (event.type === "added" && typeof name === "string" && !admittedKeys.has(name)) {
          admittedKeys.set(name, event.query.queryKey);
        }
      });
      vi.spyOn(savedQueries, "createSavedQueryClient").mockReturnValue(client);
      const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: verifiedSavedAgentPage() });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      if (detail) {
        await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
      }
      await waitFor(() => expect(admittedKeys.has(resource)).toBe(true));
      await waitFor(() => expect(client.isFetching({ queryKey: ["saved", resource] })).toBe(0));
      const key = admittedKeys.get(resource)!;
      const retained = deferredResponse();
      const controller = new AbortController();
      let retainedSignal: AbortSignal | undefined;
      const peer = savedQueries.readSavedQuery(client, key.slice(1), signal => {
        retainedSignal = signal;
        return retained.promise.then(response => response.json());
      }, controller.signal).then(value => ({ value }), error => ({ error }));
      const path = detail ? `/api/agents/${agent.id}` : resource === "package-summaries" ? "/api/agents"
        : usage ? "/api/official-usage/aggregate" : "/api/inventory/refresh-jobs";
      const reads = () => transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname === path).length;
      const before = reads();
      try {
        if (usage) {
          await userEvent.click(screen.getByRole("button", { name: "Snapshot details" }));
        } else {
          if (detail) await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
          await userEvent.click(await screen.findByText("View diagnostics"));
          await userEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
          if (detail) {
            await waitFor(() => expect(screen.getByRole("button", { name: "Verify saved inventory" })).toBeEnabled());
            await userEvent.click(screen.getByRole("button", { name: "Browse agents" }));
            await userEvent.click(await screen.findByRole("button", { name: `View details for ${agent.displayName}` }));
          }
        }
        await waitFor(() => expect(reads()).toBe(before + 1));
        expect(retainedSignal?.aborted).toBe(false);
        const oldData = usage ? usageAggregateFixture() : detail ? agent
          : resource === "package-summaries" ? packagePage : { value: [], lastAttemptAt: null, lastSuccessAt: null };
        await act(async () => retained.resolve(Response.json(oldData)));
        expect(await peer).toEqual({ value: oldData });
      } finally {
        controller.abort();
        unsubscribe();
        await peer;
      }
    },
  );

  it("passes completed Power Platform sync revisions through remounts without rejoining a retained read", async () => {
    window.history.replaceState({}, "", "/power-platform");
    const client = savedQueries.createSavedQueryClient();
    const resourceKeys = new Map<string, readonly unknown[]>();
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type === "added" && event.query.queryKey[1] === "inventory-resources") {
        resourceKeys.set(event.query.queryHash, event.query.queryKey);
      }
    });
    vi.spyOn(savedQueries, "createSavedQueryClient").mockReturnValue(client);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const resourcePage = { value: [], count: 0, typeCounts: [], snapshot: null };
    let completed = false;
    let stateReads = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input.startsWith("/api/inventory/resources")) return Response.json(resourcePage);
      if (input.startsWith("/api/inventory/snapshots")) return Response.json({ value: [] });
      if (input === "/api/data-sync/state") {
        stateReads += 1;
        return Response.json({
          onboardingRequired: false, usageImportRequired: false, run: null,
          sources: ["users", "graph_packages", "power_platform", "usage_reports"].map(source => ({
            source, status: "succeeded", jobId: null, count: completed && source === "power_platform" ? 2 : 1,
            lastSuccessAt: completed && source === "power_platform" ? "2026-09-15T09:00:00.000Z" : "2026-09-15T08:00:00.000Z",
            updatedAt: "2026-09-15T08:00:00.000Z", message: "", canRetry: false,
          })),
        });
      }
      if (input === "/api/workbench/jobs") return Response.json({
        value: [{
          id: "power-platform-sync", source: "data-sync", label: "Power Platform sync", target: "Power Platform source",
          status: "partial", total: 1, completed: 0, partial: true,
          canResume: true, canCancel: false, canReconcile: false,
          updatedAt: "2026-09-15T08:00:00.000Z", href: "/sync?syncRun=power-platform-sync",
        }],
        unavailableSources: [], polledAt: "2026-09-15T08:00:00.000Z", requestId: "jobs-projection",
      });
      if (input === "/api/data-sync/runs/power-platform-sync/retry") {
        completed = true;
        return Response.json({ id: "power-platform-sync" });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => {
      expect(resourceKeys.size).toBe(1);
      expect(client.isFetching({ queryKey: ["saved", "inventory-resources"] })).toBe(0);
      expect(stateReads).toBe(1);
    });
    const retained = deferredResponse();
    const controller = new AbortController();
    let retainedSignal: AbortSignal | undefined;
    const peer = savedQueries.readSavedQuery(client, [...resourceKeys.values()][0].slice(1), signal => {
      retainedSignal = signal;
      return retained.promise.then(response => response.json());
    }, controller.signal).then(value => ({ value }), error => ({ error }));
    const resourceReads = () => transport.fetchMock.mock.calls.filter(([input]) => input.startsWith("/api/inventory/resources")).length;
    const before = resourceReads();
    const beforeCalls = transport.fetchMock.mock.calls.length;
    try {
      await userEvent.click(screen.getByRole("button", { name: "Jobs" }));
      await userEvent.click(await screen.findByRole("button", { name: name => name.endsWith(", job power-platform-sync") }));
      const details = within(screen.getByRole("dialog", { name: "Job details" }));
      await userEvent.click(details.getByRole("button", { name: "Retry incomplete" }));
      await waitFor(() => expect(stateReads).toBe(2));
      await userEvent.click(details.getAllByRole("button", { name: /close/i })[0]);
      await userEvent.click(screen.getByRole("button", { name: "Power Platform" }));
      await waitFor(() => expect(resourceReads()).toBe(before + 1));
      expect([...resourceKeys.values()].map(key => key.at(-1))).toEqual([
        expect.objectContaining({ dataRevision: 0 }),
        expect.objectContaining({ dataRevision: 1 }),
      ]);
      expect(retainedSignal?.aborted).toBe(false);
      await act(async () => retained.resolve(Response.json(resourcePage)));
      expect(await peer).toEqual({ value: resourcePage });
      expect(transport.fetchMock.mock.calls.slice(beforeCalls)
        .filter(([, init]) => init?.method && init.method !== "GET")
        .map(([input]) => input)).toEqual(["/api/data-sync/runs/power-platform-sync/retry"]);
    } finally {
      controller.abort();
      unsubscribe();
      await peer;
    }
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
    await screen.findByRole("link", { name: "Sign in with Entra ID" });
    await act(async () => firstSetup.resolve(Response.json({ authConfigured: true })));
    expect(screen.getByRole("link", { name: "Sign in with Entra ID" })).toBeInTheDocument();
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
    await screen.findByText("Provider check succeeded");
    await revalidateTransportSession(transport);
    expect(catalogReads).toBe(2);
    expect(screen.queryByText("Provider check succeeded")).not.toBeInTheDocument();
    await act(async () => pending.resolve(Response.json({ value: [] })));
  });

  it.each(["unified inventory", "package summaries", "refresh history"] as const)(
    "purges saved agent data on a denied %s read and fences outstanding successes",
    async deniedSource => {
      const client = savedQueries.createSavedQueryClient();
      let agentOwner: unknown;
      const unsubscribe = client.getQueryCache().subscribe(event => {
        if (event.query.queryKey[1] === "package-summaries") agentOwner = event.query.queryKey[2];
      });
      vi.spyOn(savedQueries, "createSavedQueryClient").mockReturnValue(client);
      const transport = appTransport({ revalidatedRoles: viewer.roles });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      let deny = false;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (deny) {
          const pathname = new URL(input, "http://localhost").pathname;
          const deniedPath = deniedSource === "unified inventory" ? "/api/agent-inventory"
            : deniedSource === "package summaries" ? "/api/agents" : "/api/inventory/refresh-jobs";
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
      expect(agentOwner).toEqual(expect.any(String));
      const agentKey = [deniedSource === "package summaries" ? "unified-agent-detail" : "package-detail", agentOwner, agent.id, 0];
      client.setQueryData(["saved", ...agentKey], { private: true });
      const agentResponse = deferredResponse();
      const agentController = new AbortController();
      let agentSignal: AbortSignal | undefined;
      const agentPeer = savedQueries.readSavedQuery(client, agentKey, signal => {
        agentSignal = signal;
        return agentResponse.promise.then(response => response.json());
      }, agentController.signal).then(value => ({ value }), error => ({ error }));
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
        expect(await agentPeer).toMatchObject({ error: { code: "request_aborted" } });
        expect(client.getQueryData(["saved", ...agentKey])).toBeUndefined();
        expect(unrelatedReads()).toBe(before);
        await act(async () => {
          pending.resolve(Response.json(unifiedPage));
          peerResponse.resolve(Response.json(cached));
          agentResponse.resolve(Response.json({ private: true }));
        });
        expect(await peer).toEqual({ value: cached });
        expect(client.getQueryData(["saved", ...agentKey])).toBeUndefined();
        expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
        expect(transport.meCalls()).toBe(1);
        deny = false;
        await userEvent.click(await screen.findByRole("button", { name: "Reload saved agent inventory" }));
        await screen.findByText(agent.displayName);
      } finally {
        pending.resolve(Response.json(unifiedPage));
        peerController.abort();
        agentController.abort();
        unsubscribe();
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
      new URL(input, "http://localhost").pathname === "/api/agents" ? denied.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const summary = await screen.findByRole("region", { name: "Usage summary" });
    await act(async () => denied.resolve(Response.json({
      code: "forbidden", detail: "Saved agent access denied.",
    }, { status: 403 })));
    await screen.findByText(/Saved agent access denied/);
    expect(screen.getByRole("region", { name: "Usage summary" })).toBe(summary);
    expect(transport.meCalls()).toBe(1);
  });

  it("preserves an open Sync workflow when a concurrent saved agent read is forbidden", async () => {
    window.history.replaceState({}, "", "/sync");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const denied = deferredResponse();
    let deny = false;
    transport.fetchMock.mockImplementation((input, init) =>
      deny && new URL(input, "http://localhost").pathname === "/api/agents" ? denied.promise : base(input, init));
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
      if (path === "/api/agent-inventory/export.csv") return ++exports === 1 ? previousExport.promise : currentExport.promise;
      if (deny && path === "/api/agents") return Promise.resolve(Response.json({
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
        ? new Response("superseded private CSV")
        : Response.json({ detail: "Superseded export failure" }, { status: 503 })));
      expect(download.filenames).toEqual([]);
      expect(screen.queryByText("Superseded export failure")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Exporting agent inventory CSV" })).toBeDisabled();
      await act(async () => currentExport.resolve(new Response("current CSV")));
      await waitFor(() => expect(download.filenames).toEqual(["agents.csv"]));
      expect(transport.meCalls()).toBe(1);
    } finally {
      previousExport.resolve(new Response("superseded private CSV"));
      currentExport.resolve(new Response("current CSV"));
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
      if (deny && input === "/api/agents") return code
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
    await act(async () => { await expect(getAgents()).rejects.toMatchObject({ status, code: code ?? "request_failed" }); });
    expect(signal?.aborted).toBe(true);
    expect(await peer).toMatchObject({ error: { code: "request_aborted" } });
    expect(client.getQueryData(["saved", ...key])).toBeUndefined();
    pending.resolve(Response.json({ records: ["late private report"] }));
    controller.abort();
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    await act(async () => transport.releaseRevalidation());
    await screen.findByRole("heading", { name: "Permissions" });
  });

  it("collects missing identities once and replaces duplicate source rows with one agent", async () => {
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
      if (input.startsWith("/api/agent-inventory")) return Response.json({
        ...unifiedRecordsPage(collected ? [merged] : [unifiedPage.value[0], native]),
        identityCollection: { checkedPackages: collected ? 1 : 0, pendingPackages: collected ? 0 : 1 },
      });
      if (input === "/api/agents/refresh-jobs" && init?.method === "POST") collected = true;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<StrictMode><App /></StrictMode>);
    await waitFor(() => expect(refreshRequests(transport.fetchMock)).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Unified agents" })).getAllByText(agent.displayName)).toHaveLength(1));
    expect(refreshRequests(transport.fetchMock)[0][1]).toMatchObject({
      headers: expect.objectContaining({ "Idempotency-Key": `agent-identities-${packagePage.snapshot!.id}` }),
    });
    expect(screen.getAllByRole("checkbox", { name: `Select ${agent.displayName}` })).toHaveLength(1);
    expect(window.location.pathname).toBe("/agents");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "Sensitive");
    expect(refreshRequests(transport.fetchMock)).toHaveLength(1);
  });

  it("follows an existing identity refresh across tabs without dispatching another collection", async () => {
    const transport = initialCatalogTransport();
    transport.page = packagePage;
    transport.jobs = [{ ...completedRefreshJob(), status: "running", snapshotId: null, message: "Matching agent records (0/1 identities checked)." }];
    const base = transport.fetchMock.getMockImplementation()!;
    let finished = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input.startsWith("/api/agent-inventory")) return Response.json({
        ...unifiedRecordsPage(unifiedPage.value),
        identityCollection: { checkedPackages: finished ? 1 : 0, pendingPackages: finished ? 0 : 1 },
      });
      if (input.startsWith("/api/agents/refresh-jobs/refresh-first-load?")) {
        finished = true;
        return Response.json(completedRefreshJob());
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText("Matching agent records (0/1 identities checked).");
    await userEvent.click(screen.getByRole("button", { name: "Users" }));
    await waitFor(() => expect(finished).toBe(true), { timeout: 3_000 });
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(screen.getByText(agent.displayName)).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("does not start identity collection without current read authorization and surfaces collection failure", async () => {
    const transport = initialCatalogTransport();
    transport.page = packagePage;
    transport.readAuthorized = false;
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => input.startsWith("/api/agent-inventory")
      ? Response.json({ ...unifiedRecordsPage(unifiedPage.value), identityCollection: { checkedPackages: 0, pendingPackages: 1 } })
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    const mounted = render(<App />);
    await screen.findByText(agent.displayName);
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    mounted.unmount();
    transport.readAuthorized = true;
    transport.failRefresh = true;
    render(<App />);
    expect(await screen.findByText(/Synthetic initial refresh failed/)).toBeVisible();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "Sensitive");
    expect(refreshRequests(transport.fetchMock)).toHaveLength(1);
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
    expect(screen.getByText("1 package identities checked; 0 still need collection.")).toBeVisible();
    expect(screen.getByText("Source-metadata links").nextElementSibling).toHaveTextContent(/^0$/);
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Select packages on Agents" }));
    await userEvent.click(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` }));
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh matching details" }));
    await waitFor(() => expect(refreshRequests(transport.fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(refreshRequests(transport.fetchMock)[0][1]?.body))).toEqual({ ids: [agent.id], mode: "delegated" });
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
      ...packagePage, value: group.packages, count: 2,
      summary: { total: 2, allowed: 1, blocked: 1 }, filteredSummary: { total: 2, allowed: 1, blocked: 1 },
      snapshot: { ...packagePage.snapshot!, observedCount: 2, totalRecords: 2 },
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
    await userEvent.click(screen.getByRole("button", { name: "Refresh matching details" }));
    await waitFor(() => expect(refreshRequests(transport.fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(refreshRequests(transport.fetchMock)[0][1]?.body))).toEqual({
      ids: [agent.id, "package-alternate"], mode: "delegated",
    });
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
    transport.fetchMock.mockImplementation(async (input, init) => merged.packages.some(item => input === `/api/agents/${item.id}`)
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
    expect(transport.fetchMock.mock.calls.filter(([path]) => merged.packages.some(item => path === `/api/agents/${item.id}`))).toHaveLength(packageCount);
    expect(transport.fetchMock.mock.calls.some(([path, init]) => String(path).includes("/refresh-jobs") && init?.method === "POST")).toBe(false);
  });

  it.each(["revalidation", "account change", "role loss"] as const)("keeps native and package selections separate and clears them on %s", async boundary => {
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
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Independent native agent");
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: unifiedRecordsPage([native]) });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => new URL(input, "http://localhost").pathname === "/api/agents"
      ? Response.json({ code: "inventory_unavailable", detail: "Saved package catalog unavailable" }, { status: 503 })
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("Independent native agent")).toBeInTheDocument();
    expect(screen.getByText(/Saved package summaries are unavailable: Saved package catalog unavailable/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "View details for Independent native agent" }));
    expect(await screen.findByRole("dialog", { name: "Independent native agent" })).toBeInTheDocument();
  });

  it("rejects a different package's saved detail and retries only the selected package", async () => {
    const transport = initialCatalogTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    let matching = false;
    transport.fetchMock.mockImplementation((input, init) => input === `/api/agents/${agent.id}`
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
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === `/api/agents/${agent.id}`)).toHaveLength(1);
    matching = true;
    await userEvent.click(within(detail).getByRole("button", { name: "Retry saved details" }));
    expect(await within(detail).findByText("Recovered current agent description")).toBeVisible();
    expect(within(detail).queryByRole("alert")).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === `/api/agents/${agent.id}`)).toHaveLength(2);
  });

  it("preserves the chosen version and draft through inline access and block confirmations", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const second = { ...agent, id: "package-alternate", displayName: "Second publication", version: "2" };
    const merged = { ...unifiedPage.value[0], packages: [agent, second] };
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (/^\/api\/agent-inventory(?:\?|$)/.test(input)) return Promise.resolve(Response.json(unifiedRecordsPage([merged])));
      if (input === `/api/agents/${second.id}`) return Promise.resolve(Response.json({ ...second, longDescription: "Second publication description" }));
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
    transport.fetchMock.mockImplementation(async (input, init) => input.startsWith("/api/agent-inventory")
      ? Response.json(unifiedRecordsPage([reconciled ? merged : initial]))
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Reconciled agent" }));
    expect(screen.getByText("1 of 25 exact Copilot Studio agents selected")).toBeInTheDocument();
    reconciled = true;
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
    transport.fetchMock.mockImplementation(async (input, init) => input.startsWith("/api/agent-inventory")
      ? Response.json(unifiedRecordsPage([reconciled ? merged : native]))
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Snapshot-bound merged agent" }));
    reconciled = true;
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
      if (input.startsWith("/api/agent-inventory")) {
        const exact = new URL(input, "http://localhost").searchParams.get("recordId");
        return Response.json({
          ...unifiedRecordsPage(reconciled ? [merged] : exact ? [initial] : [unifiedPage.value[0], initial]),
          identityCollection: { checkedPackages: reconciled ? 1 : 0, pendingPackages: reconciled ? 0 : 1 },
        });
      }
      if (input === "/api/agents/refresh-jobs" && init?.method === "POST") return refresh.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    await waitFor(() => expect(refreshRequests(transport.fetchMock)).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "View details for Reconciled detail" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Reconciled detail" })).getByRole("tab", { name: "Manage" }));
    expect(screen.getByText(/No published version is available for these controls/)).toBeInTheDocument();
    reconciled = true;
    await act(async () => refresh.resolve(Response.json(completedRefreshJob())));

    const dialog = screen.getByRole("dialog", { name: "Reconciled detail" });
    const versions = await within(dialog).findByRole("combobox", { name: "Published version details" });
    expect(within(versions).getAllByRole("option")).toHaveLength(2);
    await userEvent.selectOptions(versions, merged.packages[1].id);
    expect(within(dialog).getByRole("region", { name: `Manage ${merged.packages[1].displayName} (${merged.packages[1].id})` })).toBeVisible();
    expect(new URLSearchParams(window.location.search).get("detail")).toBe(merged.id);
    expect(transport.fetchMock.mock.calls.some(([path]) => new URL(path, "http://localhost").searchParams.get("recordId") === initial.id)).toBe(true);
  });

  it("uses the exact off-page detail's own report context and revision for usage changes", async () => {
    const report = usageAggregateFixture();
    const context = {
      reportSet: report.activeSet, availability: report.availability, lineages: report.lineages, revision: "b".repeat(64),
    };
    const target = { source: "graph_packages" as const, packageId: "off-page-package" };
    const record: UnifiedAgentRecord = {
      ...unifiedPage.value[0], id: "graph_packages:off-page-package", displayName: "Off-page usage agent",
      packages: [{ ...agent, id: target.packageId, displayName: "Off-page usage agent" }],
      usage: {
        status: "linked", reportSetId: report.activeSet!.id, responses: 215, activeUsers: 2, lastActivityDateUtc: null,
        associations: [{ reportAgentId: "synthetic-researcher", reportAgentName: "Researcher", target, basis: "admin_reviewed", reviewedAt: "2026-09-18T10:00:00.000Z" }],
      },
    };
    const detailPage: UnifiedAgentInventoryPage = {
      ...unifiedRecordsPage([record]), revision: "c".repeat(64), usageContext: context,
    };
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"],
      unifiedResponse: {
        ...unifiedPage,
        usageContext: { ...context, reportSet: { ...report.activeSet!, id: "44444444-4444-4444-8444-444444444444" } },
      },
    });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/agent-inventory" && url.searchParams.has("recordId")) return Response.json(detailPage);
      if (url.pathname.endsWith("/usage-associations")) return Response.json({ context });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await act(async () => {
      window.history.pushState({}, "", `/agents?detail=${encodeURIComponent(record.id)}&detailTab=reports`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const detail = await screen.findByRole("dialog", { name: record.displayName });
    expect(await within(detail).findByLabelText("Selected agent report metrics")).toHaveTextContent("215");
    const exactReads = () => transport.fetchMock.mock.calls.filter(([input]) => new URL(input, "http://localhost").searchParams.has("recordId"));
    expect(exactReads()).toHaveLength(1);
    await userEvent.click(within(detail).getByRole("button", { name: /Remove association for Researcher/ }));
    await userEvent.click(within(detail).getByRole("checkbox", { name: /I confirm this reporting association/ }));
    await userEvent.click(within(detail).getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(transport.fetchMock.mock.calls.find(([input, init]) =>
      input.endsWith("/usage-associations") && init?.method === "DELETE")?.[1]).toMatchObject({
        body: JSON.stringify({
          reportSetId: report.activeSet!.id, expectedInventoryRevision: detailPage.revision,
          expectedUsageRevision: context.revision, confirmed: true, reportAgentId: "synthetic-researcher",
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
      const exact = new URL(input, "http://localhost").searchParams.get("recordId");
      return exact === canonicalAlias || exact === native.id
        ? Response.json(unifiedRecordsPage([merged]))
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
    window.history.replaceState({}, "", `/agents?inventorySnapshot=pp-snapshot&selectedResource=${encodeURIComponent(alias)}`);
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"], unifiedResponse: unifiedRecordsPage([native]),
    });
    const base = transport.fetchMock.getMockImplementation()!;
    const lookup = deferredResponse();
    transport.fetchMock.mockImplementation(async (input, init) => new URL(input, "http://localhost").searchParams.get("recordId") === alias
      ? lookup.promise
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    const controls = await screen.findByRole("region", { name: "Copilot Studio quarantine controls" });
    expect(await screen.findByRole("checkbox", { name: "Select Pending native target" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "View details for Pending native target" })).toBeEnabled();
    expect(within(controls).getByText(/Restoring 1 bookmarked quarantine selection/)).toBeVisible();
    await userEvent.click(within(controls).getByRole("button", { name: "Clear" }));
    await act(async () => lookup.resolve(Response.json(unifiedRecordsPage([native]))));
    expect(screen.queryByRole("region", { name: "Copilot Studio quarantine controls" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Pending native target" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Select Pending native target" })).not.toBeChecked();
    expect(new URLSearchParams(window.location.search).getAll("selectedResource")).toEqual([]);
  });

  it("does not renew a bookmarked quarantine selection with a different inventory snapshot", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Snapshot-bound target");
    window.history.replaceState({}, "", `/agents?inventorySnapshot=previous-snapshot&selectedResource=${encodeURIComponent(native.id)}`);
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

  it("keeps basic filters compact and hides advanced controls without removing them", async () => {
    vi.stubGlobal("fetch", appTransport({ revalidatedRoles: viewer.roles }).fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const filters = within(screen.getByRole("region", { name: "Filters" }));
    expect(filters.getAllByRole("combobox")).toHaveLength(6);
    expect(filters.getByRole("checkbox", { name: "Advanced filters" })).not.toBeChecked();
    expect(filters.getByLabelText("Environment")).not.toBeVisible();
    expect(screen.queryByLabelText("Source")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Source link")).not.toBeInTheDocument();
    for (const name of ["Show agents", "Built with", "Assigned access", "Host", "Package status"]) {
      expect(filters.getByRole("combobox", { name })).toBeVisible();
    }
    expect(filters.getByRole("spinbutton", { name: "Created within days" })).toBeVisible();
    expect(screen.getByLabelText("Publisher")).not.toBeVisible();
    expect(filters.queryByRole("button", { name: "Export agent inventory CSV" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeInTheDocument();
    await userEvent.click(filters.getByRole("checkbox", { name: "Advanced filters" }));
    expect(filters.getByRole("region", { name: "Advanced agent filters" })).toBeVisible();
    for (const label of ["Environment", "Search environments", "Publisher"]) {
      expect(filters.getByLabelText(label)).toBeVisible();
    }
  });

  it("preserves hidden advanced filters across tabs and expands a restored advanced route", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("checkbox", { name: "Advanced filters" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search environments" }), "fin");
    expect(window.location.search).not.toContain("environment=");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Environment" }), "env-a");
    const toggle = screen.getByRole("checkbox", { name: "Advanced filters 1 active" });
    await userEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.getByLabelText("Environment")).not.toBeVisible();
    expect(window.location.search).toContain("environment=env-a");
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(screen.getByRole("checkbox", { name: "Advanced filters 1 active" })).not.toBeChecked();
    expect(screen.getByLabelText("Environment")).toHaveValue("env-a");
    await act(async () => {
      window.history.pushState({}, "", "/agents?linkState=conflicting&environment=env-b");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("checkbox", { name: "Advanced filters 1 active" })).toBeChecked();
    expect(screen.getByLabelText("Environment")).toBeVisible();
    expect(screen.getByLabelText("Environment")).toHaveValue("env-b");
    expect(window.location.search).not.toContain("linkState");
  });

  it("round trips organization views and new sorts through list requests, headings, export and clear", async () => {
    window.history.replaceState({}, "", "/agents?show=organization&sort=responses&direction=desc");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await screen.findByText(agent.displayName);
    expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue("organization");
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("responses:desc");
    const unifiedRequests = () => transport.fetchMock.mock.calls.filter(([input]) => input.startsWith("/api/agent-inventory?"));
    expect(new URL(unifiedRequests().at(-1)![0], "http://localhost").searchParams.get("view")).toBe("organization");
    expect(new URL(agentListRequests(transport.fetchMock).at(-1)![0], "http://localhost").searchParams.get("sortBy")).toBe("displayName");

    await userEvent.click(screen.getByRole("button", { name: "Columns" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Hosts" }));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Sort by Hosts" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("hosts:asc"));
    expect(new URLSearchParams(window.location.search).get("sort")).toBe("hosts");
    const exportButton = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await userEvent.click(exportButton);
    await userEvent.click(await screen.findByRole("button", { name: /Download matching agents/ }));
    await waitFor(() => expect(download.filenames).toHaveLength(1));
    const exported = transport.fetchMock.mock.calls.find(([path]) => path === "/api/agent-inventory/export.csv")!;
    expect(JSON.parse(String(exported[1]?.body))).toMatchObject({
      revision: unifiedRevision, query: { view: "organization", sortBy: "hosts", sortDirection: "asc" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue("all"));
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("hosts:asc");
    expect(new URLSearchParams(window.location.search).has("show")).toBe(false);
    await waitFor(() => expect(new URL(unifiedRequests().at(-1)![0], "http://localhost").searchParams.has("view")).toBe(false));
  });

  it("preserves the focused sort control and column choices while a server sort is pending", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input, "http://localhost");
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
      const url = new URL(input, "http://localhost");
      return url.pathname === "/api/agent-inventory" && url.searchParams.get("sortBy") === "hosts";
    })).toBe(true));
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveFocus();
    expect(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    await act(async () => pending.resolve(Response.json(unifiedPage)));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Sort by Hosts" })).toBe(heading);
    expect(heading).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("columnheader", { name: "Hosts" })).toHaveAttribute("aria-sort", "descending"));
  });

  it("opens bookmarked publisher/environment filters and clears every filter without changing sorting", async () => {
    window.history.replaceState({}, "", "/agents?q=agent&source=graph_packages&status=allowed&linkState=unmatched&environment=env-a&publisher=Microsoft&availability=some&host=Teams&platform=studio&createdWithinDays=30&sort=lastModifiedAt&direction=desc");
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
    expect(await screen.findByRole("checkbox", { name: "Advanced filters 2 active" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("lastModifiedAt:desc");
    expect(window.location.search).not.toMatch(/source=|linkState=/);
    await userEvent.click(screen.getByRole("checkbox", { name: "Advanced filters 2 active" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("checkbox", { name: "Advanced filters" })).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "Package status" })).toHaveValue("all");
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("");
    expect(window.location.search).toBe("?sort=lastModifiedAt&direction=desc");
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("lastModifiedAt:desc");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "displayName:desc");
    expect(window.location.search).toBe("?direction=desc");
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) => {
      const url = new URL(input, "http://localhost");
      return url.pathname === "/api/agent-inventory" && url.searchParams.get("sortBy") === "displayName" && url.searchParams.get("sortDirection") === "desc";
    })).toBe(true));
  });

  it("does not open Advanced for promoted filters or apply obsolete source/link URL restrictions", async () => {
    window.history.replaceState({}, "", "/agents?source=power_platform&linkState=matched&platform=studio&createdWithinDays=30&host=Teams&availability=some");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("checkbox", { name: "Advanced filters" })).not.toBeChecked();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Built with" })).toHaveValue("studio"));
    expect(screen.getByRole("spinbutton", { name: "Created within days" })).toHaveValue(30);
    await waitFor(() => expect(window.location.search).not.toMatch(/source=|linkState=/));
    const queries = transport.fetchMock.mock.calls.map(([input]) => new URL(input, "http://localhost"))
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
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort" }), value);
    expect(window.location.search).toBe(search);
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) => {
      const url = new URL(input, "http://localhost");
      return url.pathname === "/api/agent-inventory" && url.searchParams.get("offset") === "0"
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

  it("shows only a concise issue notice on Agents and keeps troubleshooting collapsed on Sync", async () => {
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
    expect(issue).toHaveAttribute("title", "Copilot Studio agent coverage is incomplete.");
    expect(screen.queryByRole("button", { name: "Refresh agents" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` }));
    expect(screen.getByRole("button", { name: "Block selected packages" })).toBeVisible();
    await userEvent.click(issue);
    expect(window.location.pathname).toBe("/sync");
    expect(screen.getByRole("region", { name: "Data sync" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Inventory diagnostics" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Saved agent inventory verification" })).not.toBeInTheDocument();
    expect(screen.getByText("Saved inventory checks need attention. View diagnostics for the cause and recovery options.")).toBeVisible();
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByText(/Copilot Studio agent coverage is incomplete\./)).toBeVisible();
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
    let verificationRequested = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
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
    const beforeExpansion = transport.fetchMock.mock.calls.length;
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(transport.fetchMock.mock.calls.slice(beforeExpansion).some(([, init]) => init?.method && init.method !== "GET")).toBe(false);
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
    expect(requests.some(([, init]) => init?.method && init.method !== "GET")).toBe(false);
    expect(new URL(agentListRequests(transport.fetchMock).at(-1)![0], "http://localhost").searchParams.has("snapshotId")).toBe(false);
    expect(receipt.queryByText(/partial inventory|coverage unknown/i)).not.toBeInTheDocument();
  });

  it("keeps the full verified receipt under search, environment filtering and a later result page", async () => {
    window.history.replaceState({}, "", "/agents?q=Sensitive&environment=env-a&page=2");
    const page = { ...verifiedSavedAgentPage(), count: 51, offset: 50, value: [{ ...unifiedPage.value[0], environmentId: "env-a" }] };
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => new URL(input, "http://localhost").pathname === "/api/agent-inventory"
      ? Response.json(page) : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    await screen.findByText("Saved inventory verified");
    const receipt = within(screen.getByRole("region", { name: "Saved agent inventory verification" }));
    expect(receipt.getByText("Logical agents").nextElementSibling).toHaveTextContent(/^1,561$/);
    expect(receipt.getByText("Targets represented / unique source targets").nextElementSibling).toHaveTextContent("2,257 / 2,257");
    expect(receipt.getByText("Environment request scope").nextElementSibling).toHaveTextContent("All environments requested");
    expect(transport.fetchMock.mock.calls.some(([input]) => {
      const url = new URL(input, "http://localhost");
      return url.pathname === "/api/agent-inventory" && url.searchParams.get("search") === "Sensitive"
        && url.searchParams.get("environmentId") === "env-a" && url.searchParams.get("offset") === "50";
    })).toBe(true);
  });

  it.each([false, true])("keeps pending metadata visible without launching automatic provider backfill after Verify saved inventory (page correction: %s)", async correctPage => {
    window.history.replaceState({}, "", correctPage ? "/sync?q=Sensitive&page=2" : "/sync?q=Sensitive");
    const page = verifiedSavedAgentPage();
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page });
    const base = transport.fetchMock.getMockImplementation()!;
    let verificationRequested = false;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/capabilities") {
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
    await screen.findByText("Saved inventory needs attention");
    expect(screen.getByText("Package identity metadata still needs collection or repair.")).toBeVisible();
    expect(transport.fetchMock.mock.calls.slice(before).filter(([, init]) => init?.method === "POST")).toEqual([]);
    expect(transport.fetchMock.mock.calls.slice(before)
      .filter(([input]) => new URL(input, "http://localhost").pathname === "/api/agent-inventory")
      .map(([input]) => new URL(input, "http://localhost").searchParams.get("offset"))).toEqual(correctPage ? ["50", "0"] : ["0"]);
  });

  it("replaces a previous green receipt with explicit verification failure and permits a saved-only retry", async () => {
    window.history.replaceState({}, "", "/sync?q=Sensitive");
    const page = verifiedSavedAgentPage();
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page });
    const base = transport.fetchMock.getMockImplementation()!;
    let fail = false;
    transport.fetchMock.mockImplementation(async (input, init) => new URL(input, "http://localhost").pathname === "/api/agent-inventory"
      ? fail ? Response.json({ detail: "Saved normalized identities do not match provider total." }, { status: 409 }) : Response.json(page)
      : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByText("View diagnostics"));
    await screen.findByText("Saved inventory verified");
    const receipt = within(screen.getByRole("region", { name: "Saved agent inventory verification" }));
    const before = transport.fetchMock.mock.calls.length;
    fail = true;
    await userEvent.click(receipt.getByRole("button", { name: "Verify saved inventory" }));
    await waitFor(() => expect(receipt.getByRole("alert")).toHaveTextContent("Saved normalized identities do not match provider total."));
    expect(receipt.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(receipt.queryByText("Authorized Power Platform query verified")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    const issue = await screen.findByRole("button", { name: /Inventory needs attention.*Open Sync/ });
    expect(issue).toHaveAttribute("title", expect.stringContaining("Saved normalized identities do not match provider total."));
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    await userEvent.click(issue);
    await userEvent.click(screen.getByText("View diagnostics"));
    const retryReceipt = within(screen.getByRole("region", { name: "Saved agent inventory verification" }));
    await waitFor(() => expect(retryReceipt.getByRole("alert")).toHaveTextContent("Saved normalized identities do not match provider total."));
    fail = false;
    await userEvent.click(retryReceipt.getByRole("button", { name: "Verify saved inventory" }));
    await retryReceipt.findByText("Saved inventory verified");
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled());
    expect(transport.fetchMock.mock.calls.slice(before).some(([, init]) => init?.method && init.method !== "GET")).toBe(false);
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
      if (input.startsWith("/api/copilot-usage/users")) return Response.json(copilotUsageFixture);
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
    expect(await screen.findByRole("link", { name: "Sign in with Entra ID" })).toHaveAttribute("href", "/api/auth/login");
    expect(within(screen.getByRole("region", { name: "Agent Control" })).getAllByRole("link")).toHaveLength(1);
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
    expect(screen.getByRole("link", { name: "Sign in with Entra ID" })).toHaveAttribute("href", "/api/auth/login");
    expect(within(screen.getByRole("region", { name: "Agent Control" })).getAllByRole("link")).toHaveLength(1);
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
        if (input === "/api/agents/package-private") return delayedDetail;
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);

      await userEvent.click(await screen.findByRole("button", { name: "View details for Sensitive cached agent" }));
      const dialog = await screen.findByRole("dialog", { name: agent.displayName });
      expect(within(dialog).getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
      await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private")).toBe(true));
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
    const records = Array.from({ length: 60 }, (_, index) => ({
      ...unifiedPage.value[0],
      id: `graph_packages:package-${index}`,
      displayName: `Unified agent ${index}`,
      packages: [{ ...agent, id: `package-${index}`, displayName: `Unified agent ${index}` }],
    }));
    const transport = appTransport({
      revalidatedRoles: viewer.roles,
      unifiedResponse: unifiedRecordsPage(records, 60),
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Unified agent 50")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("page")).toBe("2");
    expect(transport.fetchMock.mock.calls.some(([path]) => {
      const url = new URL(String(path), "http://localhost");
      return url.pathname === "/api/agent-inventory" && url.searchParams.get("offset") === "50";
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
        count: 80,
      },
    });
    const original = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input.startsWith("/api/agent-inventory") && new URL(input, "http://localhost").searchParams.get("recordId") === detailId) {
        return Response.json(unifiedPage);
      }
      return original(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("dialog", { name: agent.displayName })).toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).includes("recordId="))).toBe(true);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/graph_packages"))).toBe(false);
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
    const fetchMock = vi.fn(async (input: string) => input === "/api/auth/logout"
      ? Response.json({ code: "invalid_origin", detail: "A same-origin request is required. Use --origin-header unchanged." }, { status: 403 })
      : transport.fetchMock(input));
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
      String(path).includes("operationIdPrefix=a5331a93"),
    )).toBe(true);
    expect(transport.fetchMock.mock.calls.some(([path]) =>
      path.startsWith("/api/agent-inventory?operationIdPrefix=a5331a93"),
    )).toBe(true);
    expect(transport.fetchMock.mock.calls.some(([path]) => {
      const url = new URL(String(path), "http://localhost");
      return url.pathname === "/api/agent-inventory"
        && url.searchParams.get("operationIdPrefix") === "a5331a93"
        && !url.searchParams.has("search");
    })).toBe(true);
    expect(screen.queryByText(/Bulk-reference filters require/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Audit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Security" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Manage access for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Block Sensitive/ })).not.toBeInTheDocument();
  });

  it("lets Admin inherit every view while exposing supported mutation controls", async () => {
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"],
      revalidatedRoles: ["AgentControl.Admin"],
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    for (const name of ["Agents", "Power Platform", "Users", "Official usage", "Audit", "Security", "Permissions", "Jobs"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Manage access for Sensitive cached agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Block Sensitive cached agent" })).toBeInTheDocument();
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
      String(path).includes("operationIdPrefix=a5331a93"),
    )).toBe(true);

    const exportButton = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await userEvent.click(exportButton);
    await userEvent.click(await screen.findByRole("button", { name: /Download matching agents/ }));
    await waitFor(() => expect(transport.fetchMock).toHaveBeenCalledWith(
      "/api/agent-inventory/export.csv",
      expect.objectContaining({ method: "POST" }),
    ));
    const exportCall = transport.fetchMock.mock.calls.find(([path]) => path === "/api/agent-inventory/export.csv")!;
    expect(JSON.parse(String(exportCall[1]?.body))).toMatchObject({
      query: { operationIdPrefix: "a5331a93" },
      revision: unifiedRevision,
    });
  });

  it("exports all matching logical rows with the exact unified filters and sorting, not the visible page", async () => {
    const params = new URLSearchParams({
      q: "Matched & saved", status: "blocked", publisher: "Publisher & Co", availability: "available:some",
      host: "Teams", platform: "Copilot Studio", environment: "env-a", createdWithinDays: "30",
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
    const page = { ...unifiedRecordsPage(records, 125), offset: 100 };
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const csv = "agentId,packageIds,inventoryPartial\r\nserver-agent,\"one;two\",false\r\n";
    transport.fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(input, "http://localhost").pathname;
      if (path === "/api/agent-inventory") return Response.json(page);
      if (path === "/api/agent-inventory/export.csv") return new Response(csv, { headers: { "Content-Type": "text/csv" } });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await screen.findByText("Matched & saved 0");
    const button = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(transport.fetchMock.mock.calls.some(([input]) =>
      input.startsWith("/api/agent-inventory?") && new URL(input, "http://localhost").searchParams.get("offset") === "100",
    )).toBe(true);
    await userEvent.click(button);
    const matching = screen.getByRole("button", { name: /Download matching agents/ });
    expect(matching).toHaveTextContent("125 filtered agents across all pages");
    expect(screen.getByText(/8 MB and 15 seconds/)).toBeVisible();
    await userEvent.click(matching);
    await waitFor(() => expect(download.filenames).toEqual(["agents.csv"]));
    const body = JSON.parse(String(transport.fetchMock.mock.calls.find(([path]) => path === "/api/agent-inventory/export.csv")![1]?.body));
    expect(body).toEqual({
      revision: unifiedRevision,
      query: {
        search: "Matched & saved", blocked: true, publisher: "Publisher & Co", availableTo: "available:some",
        host: "Teams", platform: "Copilot Studio", environmentId: "env-a", createdWithinDays: 30,
        sortBy: "lastModifiedAt", sortDirection: "desc",
      },
    });
    const listUrl = new URL(transport.fetchMock.mock.calls.filter(([input]) => input.startsWith("/api/agent-inventory?")).at(-1)![0], "http://localhost");
    listUrl.searchParams.delete("limit");
    listUrl.searchParams.delete("offset");
    expect(Object.fromEntries(listUrl.searchParams)).toEqual(Object.fromEntries(
      Object.entries(body.query).map(([key, value]) => [key, String(value)]),
    ));
    expect(await download.createObjectURL.mock.calls[0][0].text()).toBe(csv);
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
    await waitFor(() => expect(download.filenames).toEqual(["agents.csv"]));
    const body = JSON.parse(String(transport.fetchMock.mock.calls.find(([path]) => path === "/api/agent-inventory/export.csv")![1]?.body));
    expect(body).toEqual({
      revision: unifiedRevision,
      recordIds: ["graph_packages:offpage%2Fopaque%25ref", canonicalId],
      query: { sortBy: "lastModifiedAt", sortDirection: "desc" },
    });
    expect(checkbox).toBeChecked();
    expect(transport.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([input]) => input)).toEqual([...initialPosts, "/api/agent-inventory/export.csv"]);
  });

  it("allows a Viewer to export Power Platform-only logical rows without Graph permissions or package summaries", async () => {
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
    await screen.findByText(/Saved package summaries are unavailable/);
    const button = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    await waitFor(() => expect(download.filenames).toEqual(["agents.csv"]));
    expect(transport.fetchMock).toHaveBeenCalledWith("/api/agent-inventory/export.csv", expect.objectContaining({
      headers: expect.objectContaining({ "X-CSRF-Token": "csrf-1" }),
      body: JSON.stringify({ revision: unifiedRevision, query: { sortBy: "displayName", sortDirection: "asc" } }),
    }));
    expect(transport.fetchMock.mock.calls.some(([input]) => input === "/api/agents/export.csv" || input.startsWith("/api/inventory/export.csv"))).toBe(false);
  });

  it.each([undefined, "a".repeat(63), "A".repeat(64)])("requires a valid saved revision before enabling unified export (%s)", async revision => {
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: { ...unifiedPage, revision } });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload saved agent inventory" })).toBeEnabled();
    expect(screen.getByText(/saved agent inventory revision is unavailable/)).toBeVisible();
    expect(transport.fetchMock.mock.calls.some(([input]) => input.endsWith("/export.csv"))).toBe(false);
  });

  it.each([5_000, 5_001])("enforces the exact matching-row cap at %i without disabling a smaller explicit selection", async count => {
    window.history.replaceState({}, "", "/agents?selected=package-private");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) =>
      new URL(input, "http://localhost").pathname === "/api/agent-inventory"
        ? Response.json(unifiedRecordsPage(unifiedPage.value, count)) : base(input, init),
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
    if (count === 5_000) {
      expect(matching).toBeEnabled();
      await userEvent.click(matching);
    } else {
      expect(matching).toBeDisabled();
      expect(matching).toHaveTextContent("More than 5,000 agents match. Narrow the filters");
      await userEvent.click(matching);
      expect(transport.fetchMock.mock.calls.some(([input]) => input === "/api/agent-inventory/export.csv")).toBe(false);
      await userEvent.click(selected);
    }
    await waitFor(() => expect(download.filenames).toEqual(["agents.csv"]));
    const body = JSON.parse(String(transport.fetchMock.mock.calls.find(([path]) => path === "/api/agent-inventory/export.csv")![1]?.body));
    if (count === 5_000) expect(body.recordIds).toBeUndefined();
    else expect(body.recordIds).toEqual(["graph_packages:package-private"]);
  });

  it.each(["revision", "missing-reference"] as const)("requires explicit saved-data reload after %s invalidation and never silently retries a source export", async invalidation => {
    if (invalidation === "missing-reference") window.history.replaceState({}, "", "/agents?selected=removed-package");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    let revision = unifiedRevision;
    let exports = 0;
    transport.fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(input, "http://localhost").pathname;
      if (path === "/api/agent-inventory") return Response.json({ ...unifiedPage, revision });
      if (path === "/api/agent-inventory/export.csv") {
        exports += 1;
        if (exports === 1) {
          revision = "b".repeat(64);
          return Response.json({ code: "agent_inventory_changed", detail: `${invalidation} invalidated the export.` }, { status: 409 });
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
    expect(reload.closest("[role=alert]")).toHaveTextContent(/reload.*review.*try again/i);
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
      await userEvent.click(within(screen.getByRole("dialog", { name: "Export agent inventory" })).getByRole("button", { name: "Clear selection" }));
      expect(screen.getByRole("button", { name: /Download selected agents/ })).toBeDisabled();
      expect(new URLSearchParams(window.location.search).has("selected")).toBe(false);
    }
    await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    await waitFor(() => expect(download.filenames).toEqual(["agents.csv"]));
    const requests = transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/export.csv");
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[1][1]?.body))).toEqual({
      revision: "b".repeat(64), query: { sortBy: "displayName", sortDirection: "asc" },
    });
    expect(transport.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([input]) => input)).toEqual([
      ...initialPosts, "/api/agent-inventory/export.csv", "/api/agent-inventory/export.csv",
    ]);
  });

  it("waits for current filters and exports their newly loaded saved revision", async () => {
    const row = { ...unifiedPage.value[0], displayName: "X agent" };
    const page = unifiedRecordsPage([row]);
    const transport = appTransport({ revalidatedRoles: viewer.roles, unifiedResponse: page });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/agent-inventory" && url.searchParams.get("search") === "X") return pending.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await screen.findByText("X agent");
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled());
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "X");
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) => input.startsWith("/api/agent-inventory?search=X"))).toBe(true));
    expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    await act(async () => pending.resolve(Response.json({ ...page, revision: "c".repeat(64) })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
    await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    await waitFor(() => expect(download.filenames).toEqual(["agents.csv"]));
    expect(transport.fetchMock).toHaveBeenCalledWith("/api/agent-inventory/export.csv", expect.objectContaining({
      body: JSON.stringify({ revision: "c".repeat(64), query: { search: "X", sortBy: "displayName", sortDirection: "asc" } }),
    }));
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
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/agent-inventory/export.csv" && lateCsvFailure && ++exports === 1) return pendingCsv.promise;
      if (url.pathname === "/api/agent-inventory" && url.searchParams.get("search") === "X") {
        return failFilteredRead
          ? Response.json({ detail: "Filtered saved inventory unavailable." }, { status: 503 })
          : Response.json({ ...unifiedRecordsPage([filtered]), revision: "c".repeat(64) });
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
    expect(transport.fetchMock.mock.calls.filter(([input]) => input === "/api/agent-inventory/export.csv")).toHaveLength(lateCsvFailure ? 1 : 0);
    failFilteredRead = false;
    await userEvent.click(screen.getByRole("button", { name: "Reload saved agent inventory" }));
    await screen.findByText("X agent");
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
    await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    await waitFor(() => expect(download.filenames).toEqual(["agents.csv"]));
    expect(transport.fetchMock).toHaveBeenCalledWith("/api/agent-inventory/export.csv", expect.objectContaining({
      body: JSON.stringify({ revision: "c".repeat(64), query: { search: "X", sortBy: "displayName", sortDirection: "asc" } }),
    }));
  });

  it("keeps matching export available during native selection restoration and can cancel that restoration from export", async () => {
    const native = powerPlatformRecord("22222222-2222-4222-8222-222222222222", "Off-page native selection");
    const alias = "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    window.history.replaceState({}, "", `/agents?${new URLSearchParams({ selectedResource: alias, inventorySnapshot: "pp-snapshot" })}`);
    const transport = appTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"], unifiedResponse: unifiedRecordsPage(unifiedPage.value) });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/agent-inventory" && url.searchParams.get("recordId") === alias) return pending.promise;
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    await screen.findByText(agent.displayName);
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) => new URL(input, "http://localhost").searchParams.get("recordId") === alias)).toBe(true));
    const button = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(screen.getByRole("button", { name: /Download selected agents/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Download matching agents/ })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /Download matching agents/ }));
    await waitFor(() => expect(download.filenames).toEqual(["agents.csv"]));
    await userEvent.click(screen.getByRole("button", { name: "Export agent inventory CSV" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Export agent inventory" })).getByRole("button", { name: "Clear selection" }));
    await act(async () => pending.resolve(Response.json(unifiedRecordsPage([{ ...native, id: alias }]))));
    expect(screen.getByRole("button", { name: /Download selected agents/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Download selected agents/ })).toHaveTextContent("0 selected package/native references");
    expect(new URLSearchParams(window.location.search).has("selectedResource")).toBe(false);
  });

  it("exports Power Platform agents from the exact retained source snapshot", async () => {
    window.history.replaceState({}, "", "/agents?q=linked&environment=env-a");
    const powerPlatformObservation = {
      id: "pp-snapshot-exact",
      snapshotId: "pp-snapshot-exact",
      observedAt: "2026-09-10T08:00:00.000Z",
      expiresAt: "2026-09-10T09:00:00.000Z",
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
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input.startsWith("/api/inventory/export.csv?")) {
        return new Response("Resource ID,Display name\r\n", { headers: { "Content-Type": "text/csv" } });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:pp-agent-export") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /^Sync/ }));
    await userEvent.click(screen.getByText("View diagnostics"));
    await screen.findByRole("button", { name: "Export PP agent inventory CSV" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Export PP agent inventory CSV" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Export PP agent inventory CSV" }));

    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => {
      const url = new URL(String(path), "http://localhost");
      return url.pathname === "/api/inventory/export.csv"
        && url.searchParams.get("snapshotId") === "pp-snapshot-exact"
        && url.searchParams.get("type") === "microsoft.copilotstudio/agents"
        && url.searchParams.get("environmentId") === "env-a"
        && url.searchParams.get("search") === "linked"
        && !url.searchParams.has("excludeAgents");
    })).toBe(true));
  });

  it("refreshes only Power Platform agents and exposes durable status", async () => {
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
      if (input === "/api/capabilities") {
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
        types: ["microsoft.copilotstudio/agents"],
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
    expect(await screen.findByText(/Unable to load Power Platform agent refresh history: Synthetic inventory history failure/)).toBeVisible();
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
          && input === "/api/agents/refresh-jobs"
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
          .map(([path]) => new URL(String(path), "http://localhost"))
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
      .map(([path]) => new URL(String(path), "http://localhost"))
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
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(1));
    expect(screen.getByText(/Open Data sync on the Sync tab to collect workspace data/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Data sync" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Data sync" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /^Sync/ }));
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
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(1));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs"))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs"))).toBe(false);
  });

  it("preserves existing snapshots, including empty catalogs and filtered-empty results", async () => {
    const transport = initialCatalogTransport();
    transport.page = { ...packagePage, value: [], count: 0 };
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Graph collected/)).toBeInTheDocument());
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
    transport.catalogResponse = undefined;
    await act(async () => release(Response.json(transport.page)));
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
    const detail = calls.findIndex(([path]) => path === "/api/agents/package-private");
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
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/package-private")).toHaveLength(1);
    await userEvent.click(within(saved).getByRole("tab", { name: "Manage" }));
    await userEvent.click(within(saved).getByRole("button", { name: target === "availability" ? /^Available to/ : /^Installed for/ }));
    expect(within(saved).getByRole("heading", { name: target === "availability" ? "Select who can use this agent" : "Select who this agent is installed for" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toEqual([saved]);
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private/refresh-jobs")).toBe(false);
    await userEvent.click(within(saved).getByRole("radio", { name: /No users/ }));
    await userEvent.click(within(saved).getByRole("button", { name: "Apply" }));
    const confirmation = await within(saved).findByRole("region", { name: new RegExp(`update ${target} package`, "i") });
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/package-private/refresh-jobs")).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/package-private")).toHaveLength(2);
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
    expect(within(confirmation).getByText("package-private")).toBeInTheDocument();
    await userEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(screen.getAllByRole("dialog")).toEqual([detail]);
    expect(within(detail).getByRole("heading", { name: "Select who can use this agent" })).toBeVisible();
    expect(new URLSearchParams(window.location.search).get("detail")).toBe(unifiedPage.value[0].id);
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
    window.history.replaceState({}, "", action === "availability" ? "/agents?availability=available:some" : "/agents?status=allowed");
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
        const recordId = new URL(input, "http://localhost").searchParams.get("recordId");
        if (recordId) return Response.json({
          ...unifiedRecordsPage([{ ...original, packages: [changed ? packageAfter : packageBefore] }]),
          revision: changed ? revision : before.revision,
        });
        return Response.json(changed ? {
          ...before, revision, value: [retained], count: 1,
          filteredSummary: { ...before.filteredSummary, total: 1, graphOnly: 1 },
        } : before);
      }
      if (input === `/api/agents/${agent.id}`) return Response.json(changed ? packageAfter : packageBefore);
      if (input === `/api/agents/${agent.id}/block` && init?.method === "POST") {
        changed = true;
        const result = {
          targetBlockedState: true, total: 1, succeeded: action === "skipped" ? 0 : 1, failed: 0, skipped: action === "skipped" ? 1 : 0,
          results: [{ id: agent.id, displayName: agent.displayName, status: action === "skipped" ? "skipped" : "succeeded" }],
        };
        return Response.json({
          ...waitingBulkJob(), id: "verified-block-job", status: "succeeded", canResume: false,
          total: 1, completed: 1, succeeded: result.succeeded, skipped: result.skipped, results: result.results, result,
        });
      }
      if (input === `/api/agents/${agent.id}/access` && init?.method === "PATCH") changed = true;
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
    await userEvent.click(within(confirmation).getByRole("button", { name: action === "availability" ? "Confirm update availability" : "Confirm block" }));

    await screen.findByRole("heading", { name: "Agents 1 of 2", hidden: true });
    expect(screen.queryByRole("button", { name: `View details for ${agent.displayName}`, hidden: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: `View details for ${retainedPackage.displayName}`, hidden: true })).toBeInTheDocument();
    await userEvent.click(within(detail).getByRole("button", { name: /close/i }));
    const exportButton = screen.getByRole("button", { name: "Export agent inventory CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await userEvent.click(exportButton);
    await userEvent.click(await screen.findByRole("button", { name: /Download matching agents/ }));
    await waitFor(() => expect(download.filenames).toHaveLength(1));
    const exported = transport.fetchMock.mock.calls.find(([path]) => path === "/api/agent-inventory/export.csv")!;
    expect(JSON.parse(String(exported[1]?.body))).toMatchObject({
      revision,
      query: action === "availability" ? { availableTo: "available:some" } : { blocked: false },
    });
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it.each([
    "2026-09-15T12:00:00.000Z",
    "2026-09-16T12:00:00.000Z",
    "2030-01-01T12:00:00.000Z",
  ])("restores only the Power Platform targets named by a popped route on %s", async now => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    const recordA = powerPlatformRecord("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", "Agent A");
    const recordB = powerPlatformRecord("bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", "Agent B");
    const routeA = `/agents?inventorySnapshot=${powerPlatformSnapshot().snapshotId}&selectedResource=${encodeURIComponent(recordA.id)}`;
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
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/package-private")).toHaveLength(entry === "table" ? 0 : 1);
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
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private")).toBe(false);
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
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private")).toBe(false);
  });

  it.each(["sign-out", "account-change", "role-loss"].flatMap(boundary =>
    ["aggregate", "users"].map(kind => ({ boundary, kind })),
  ))("does not publish a pending private $kind export after $boundary", async ({ boundary, kind }) => {
    window.history.replaceState({}, "", kind === "users" ? "/users?view=activity" : "/official-usage?view=snapshot");
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
      : input.startsWith(`/api/official-usage/${kind}.csv`) ? pending.promise
        : input === "/api/copilot-usage/users" ? Promise.resolve(Response.json(copilotUsageFixture))
          : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = mockCsvDownload();
    render(<App />);
    const exportButton = await screen.findByRole("button", { name: kind === "users" ? "Export users CSV" : "Export agents CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await userEvent.click(exportButton);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path.startsWith(`/api/official-usage/${kind}.csv`))).toHaveLength(1);

    if (boundary === "sign-out") {
      await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument());
    } else {
      await revalidateTransportSession(transport);
    }
    await act(async () => pending.resolve(new Response("private usage CSV", { headers: { "Content-Type": "text/csv" } })));
    expect(download.filenames).toEqual([]);
    expect(download.createObjectURL).not.toHaveBeenCalled();
    const exportCall = transport.fetchMock.mock.calls.find(([path]) => path.startsWith(`/api/official-usage/${kind}.csv`))!;
    expect(exportCall[1]?.signal?.aborted).toBe(true);
  });

  it("restores a historical official-usage snapshot as exact GET reads without changing active selection", async () => {
    const reportSetId = "11111111-1111-4111-8111-111111111111";
    window.history.replaceState({}, "", `/official-usage?snapshot=${reportSetId}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input.startsWith("/api/official-usage/aggregate")) {
        return Response.json(usageAggregateFixture());
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("Historical snapshot view")).toBeVisible();
    await waitFor(() => {
      expect(transport.fetchMock.mock.calls.some(([input]) =>
        input.startsWith(`/api/official-usage/aggregate?setId=${reportSetId}&activityWindowDays=365`))).toBe(true);
    });
    expect(transport.fetchMock.mock.calls.some(([input]) => input.startsWith("/api/official-usage/users"))).toBe(false);
    const officialUsageCalls = transport.fetchMock.mock.calls.filter(([input]) =>
      input.startsWith("/api/official-usage/"));
    expect(officialUsageCalls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    expect(screen.getByText(/Showing retained set 11111111/)).toBeVisible();
    expect(new URLSearchParams(window.location.search).get("snapshot")).toBe(reportSetId);
    expect(new URLSearchParams(window.location.search).has("window")).toBe(false);
  });

  it("does not show current-snapshot data when an exact historical set is unavailable", async () => {
    const reportSetId = "99999999-9999-4999-8999-999999999999";
    window.history.replaceState({}, "", `/official-usage?snapshot=${reportSetId}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (
        (input.startsWith("/api/official-usage/aggregate") || input.startsWith("/api/official-usage/users"))
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
    expect(screen.getByText(/Retained set 99999999 is unavailable/)).toBeVisible();
    expect(screen.queryByText(/Showing retained set/)).not.toBeInTheDocument();
    const exactCalls = transport.fetchMock.mock.calls.filter(([input]) =>
      input.includes(`setId=${reportSetId}`));
    expect(exactCalls.some(([input]) => input.startsWith("/api/official-usage/aggregate"))).toBe(true);
    expect(exactCalls.some(([input]) => input.startsWith("/api/official-usage/users"))).toBe(false);
    expect(exactCalls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it.each(["current", "historical"] as const)("hides a superseded %s snapshot summary until the new revision loads", async scope => {
    const data = usageAggregateFixture();
    window.history.replaceState({}, "", scope === "current"
      ? "/official-usage?view=snapshot" : `/official-usage?snapshot=${data.activeSet!.id}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let reads = 0;
    transport.fetchMock.mockImplementation((input, init) => {
      if (input.startsWith("/api/official-usage/aggregate?")) {
        return ++reads === 2 ? pending.promise : Promise.resolve(Response.json(data));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("region", { name: "Usage summary" })).toHaveTextContent("270");
    await userEvent.click(screen.getByRole("button", { name: "Snapshot details" }));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByRole("region", { name: "Usage summary" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agents CSV" })).toBeDisabled();
    await act(async () => pending.resolve(Response.json({
      code: "service_unavailable", detail: "New snapshot revision unavailable.",
    }, { status: 503 })));
    expect(await screen.findByRole("alert")).toHaveTextContent("New snapshot revision unavailable.");
    expect(screen.queryByRole("region", { name: "Usage summary" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing the last loaded data for retained set/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry report" }));
    expect(await screen.findByRole("region", { name: "Usage summary" })).toHaveTextContent("270");
  });

  it("keeps the same-revision snapshot summary when an ordinary filter read fails", async () => {
    window.history.replaceState({}, "", "/official-usage?view=snapshot");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation((input, init) => {
      const url = new URL(input, "http://localhost");
      return url.pathname === "/api/official-usage/aggregate" && url.searchParams.has("search")
        ? Promise.resolve(Response.json({ code: "service_unavailable", detail: "Filter read unavailable." }, { status: 503 }))
        : base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("region", { name: "Usage summary" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents" }), { target: { value: "Researcher" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Filter read unavailable.");
    expect(screen.getByRole("region", { name: "Usage summary" })).toHaveTextContent("270");
    expect(screen.getByText(/The last loaded summary is shown/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agents CSV" })).toBeDisabled();
  });

  it("keeps response totals snapshot-specific while inventory and cumulative activity have separate scopes", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    expect(screen.queryByRole("region", { name: "Tenant adoption insights" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Explore usage & users" })).not.toBeInTheDocument();
    const aggregateReads = () => transport.fetchMock.mock.calls.filter(([input]) => input.startsWith("/api/official-usage/aggregate"));
    expect(aggregateReads()).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Official usage" }));
    expect(await screen.findByRole("region", { name: "Retained activity summary" })).toHaveTextContent("Reported used agents");
    expect(aggregateReads()).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Snapshot details" }));
    expect(await screen.findByRole("region", { name: "Usage summary" })).toHaveTextContent("270");
    expect(aggregateReads()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    await screen.findByText(agent.displayName);
    expect(screen.queryByRole("region", { name: "Tenant adoption insights" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Usage summary" })).not.toBeInTheDocument();
    expect(aggregateReads()).toHaveLength(1);
  });

  it("preserves a chosen cumulative date range when inspecting a source snapshot and returning", async () => {
    window.history.replaceState({}, "", "/official-usage");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("region", { name: "Retained agent activity rows" });
    fireEvent.change(screen.getByLabelText("Observed activity on or after (UTC)"), { target: { value: "2026-06-01" } });
    fireEvent.change(screen.getByLabelText("Observed activity on or before (UTC)"), { target: { value: "2026-07-15" } });
    await userEvent.click(await screen.findByRole("button", { name: "View source snapshot for Researcher" }));
    expect(await screen.findByRole("region", { name: "Agent comparison rows" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cumulative activity" }));
    expect(await screen.findByRole("region", { name: "Retained agent activity rows" })).toBeVisible();
    expect(screen.getByLabelText("Observed activity on or after (UTC)")).toHaveValue("2026-06-01");
    expect(screen.getByLabelText("Observed activity on or before (UTC)")).toHaveValue("2026-07-15");
    expect(transport.fetchMock.mock.calls.filter(([input]) => input.startsWith("/api/official-usage/overview")).at(-1)?.[0])
      .toContain("startDate=2026-06-01&endDate=2026-07-15");
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
    await waitFor(() => expect(overview.getByText("Agents in repository").parentElement).toHaveTextContent("1"));
    expect(overview.getByText("Available to end users").parentElement).toHaveTextContent("0");
    expect(await overview.findByRole("alert")).toHaveTextContent("Retained reports unavailable.");
    expect(overview.getByText("Reported used agents").parentElement).toHaveTextContent("Unknown");
    expect(overview.getByText("Reported active · 30 days").parentElement).toHaveTextContent("Unknown");
  });

  it("loads official history only on demand and keeps person-level data off Official usage", async () => {
    window.history.replaceState({}, "", "/official-usage?view=snapshot");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Export agents CSV" })).toBeEnabled());
    expect(transport.fetchMock.mock.calls.some(([input]) => input.startsWith("/api/official-usage/history"))).toBe(false);
    expect(transport.fetchMock.mock.calls.some(([input]) => input.startsWith("/api/official-usage/users"))).toBe(false);
    expect(screen.getByRole("region", { name: "Agent comparison rows" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Report history" }));
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([input]) => input.startsWith("/api/official-usage/history"))).toBe(true));
    expect(screen.queryByRole("region", { name: "Agent comparison rows" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Report history" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Snapshot details" }));
    expect(await screen.findByRole("region", { name: "Agent comparison rows" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Report history" })).not.toBeInTheDocument();
  });

  it("ignores a late aggregate when activity returns after visiting report history", async () => {
    window.history.replaceState({}, "", "/official-usage?view=snapshot");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    let reads = 0;
    transport.fetchMock.mockImplementation((input, init) => {
      if (input.startsWith("/api/official-usage/aggregate?")) {
        reads += 1;
        return reads === 1 ? pending.promise : Promise.resolve(Response.json(usageAggregateFixture()));
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(reads).toBe(1));
    const originalRead = transport.fetchMock.mock.calls.find(([input]) => input.startsWith("/api/official-usage/aggregate?"))!;
    await userEvent.click(screen.getByRole("button", { name: "Report history" }));
    expect(originalRead[1]?.signal?.aborted).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Snapshot details" }));
    const rows = await screen.findByRole("region", { name: "Agent comparison rows" });
    expect(within(rows).getByRole("button", { name: "Researcher" })).toBeVisible();
    const obsolete = usageAggregateFixture();
    obsolete.agents.value[0].agentName = "Obsolete private aggregate";
    await act(async () => pending.resolve(Response.json(obsolete)));
    expect(screen.queryByText("Obsolete private aggregate")).not.toBeInTheDocument();
    expect(within(rows).getByRole("button", { name: "Researcher" })).toBeVisible();
    expect(reads).toBe(2);
  });

  it("clears historical loading when reversed dates cancel a pending aggregate", async () => {
    const data = usageAggregateFixture();
    window.history.replaceState({}, "", `/official-usage?snapshot=${data.activeSet!.id}`);
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
    await screen.findByRole("region", { name: "Agent comparison rows" });
    await userEvent.click(screen.getByText("Last-activity filters"));
    fireEvent.change(screen.getByLabelText("Agent last activity on or after (UTC)"), { target: { value: "2026-09-12" } });
    expect(await screen.findByText(/Loading retained set/)).toBeVisible();
    const pendingRequest = transport.fetchMock.mock.calls.find(([input]) => new URL(input, "http://localhost").searchParams.has("startDate"))!;
    fireEvent.change(screen.getByLabelText("Agent last activity on or before (UTC)"), { target: { value: "2026-09-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("start date must be on or before the end date");
    expect(pendingRequest[1]?.signal?.aborted).toBe(true);
    expect(screen.queryByText(/Loading retained set/)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Agent comparison" })).toHaveAttribute("aria-busy", "false");
    expect(transport.fetchMock.mock.calls.filter(([input]) => input.startsWith("/api/official-usage/aggregate?"))).toHaveLength(2);
    await act(async () => pending.resolve(Response.json(data)));
    expect(screen.queryByRole("region", { name: "Agent comparison rows" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reset agent filters" }));
    expect(await screen.findByRole("region", { name: "Agent comparison rows" })).toBeVisible();
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
    expect(collectionRequests.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(window.location.search).not.toContain("refreshJob");
    await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
    expect(new URLSearchParams(window.location.search).get("refreshJob")).toBe("retained-package-run");
    expect(await screen.findByRole("region", { name: "Selected package refresh job" })).toHaveTextContent("retained-package-run");
  });

  it("recovers the exact data-sync run requested by a Jobs link instead of showing the latest run", async () => {
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

  it.each(["accepted", "uncertain"] as const)("refreshes the hidden saved-sync workspace after %s retry and cancel from the full Jobs view", async outcome => {
    window.history.replaceState({}, "", "/jobs");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/workbench/jobs") return Response.json({
        value: [{
          id: "sync-from-jobs", source: "data-sync", label: "Retained partial sync", target: "4 saved-data sources",
          status: "partial", total: 4, completed: 2, partial: true,
          canResume: true, canCancel: true, canReconcile: false,
          updatedAt: "2026-09-15T08:00:00.000Z", href: "/sync?syncRun=sync-from-jobs",
        }],
        unavailableSources: [], polledAt: "2026-09-15T08:00:00.000Z", requestId: "jobs-projection",
      });
      if (input === "/api/data-sync/runs/sync-from-jobs/retry" || input === "/api/data-sync/runs/sync-from-jobs/cancel") {
        return outcome === "uncertain"
          ? Response.json({ code: "service_unavailable", detail: "Command outcome is unknown." }, { status: 503 })
          : Response.json({ id: "sync-from-jobs" });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: name => name.endsWith(", job sync-from-jobs") }));
    const details = within(screen.getByRole("dialog", { name: "Job details" }));
    const stateReads = () => transport.fetchMock.mock.calls.filter(([input]) => input === "/api/data-sync/state").length;
    await waitFor(() => expect(stateReads()).toBe(1));
    expect(screen.queryByRole("region", { name: "Data sync" })).not.toBeInTheDocument();
    const before = transport.fetchMock.mock.calls.length;
    await userEvent.click(details.getByRole("button", { name: "Retry incomplete" }));
    await waitFor(() => expect(stateReads()).toBe(2));
    await waitFor(() => expect(details.getByRole("button", { name: "Cancel run" })).toBeEnabled());
    await userEvent.click(details.getByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(stateReads()).toBe(3));
    expect(transport.fetchMock.mock.calls.slice(before)
      .filter(([, init]) => init?.method && init.method !== "GET")
      .map(([input]) => input)).toEqual([
      "/api/data-sync/runs/sync-from-jobs/retry",
      "/api/data-sync/runs/sync-from-jobs/cancel",
    ]);
  });

  it("prepares each bulk access target before requesting the server confirmation", async () => {
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
    const detail = calls.findIndex(([path]) => path === "/api/agents/package-private");
    const preview = calls.findIndex(([path]) => path === "/api/agents/mutation-preview");
    expect(detail).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(detail);
    expect(calls.some(([path]) => String(path).endsWith("/access"))).toBe(false);
  });

  it.each(["navigation", "session revalidation", "scoped agent denial"] as const)(
    "discards a delayed bulk preview after %s",
    async scenario => {
      const transport = accessEditorTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      let preview: Response | undefined;
      let deny = false;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (deny && new URL(input, "http://localhost").pathname === "/api/agents") {
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
        if (deny && new URL(input, "http://localhost").pathname === "/api/agents") {
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
      await userEvent.click(await screen.findByRole("button", { name: "Confirm block" }));
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
      expect(window.localStorage.getItem("agent-control:active-bulk-job:v1")).toBeNull();
      expect(screen.queryByRole("region", { name: "Job controls" })).not.toBeInTheDocument();
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
      window.localStorage.setItem("agent-control:active-bulk-job:v1", job.id);
      let deny = false;
      transport.fetchMock.mockImplementation(async (input, init) => {
        if (deny && new URL(input, "http://localhost").pathname === "/api/agents") {
          return Response.json({ code: "forbidden", detail: "Saved agent access denied." }, { status: 403 });
        }
        if (input === endpoint) return pending.promise;
        if (input === `/api/agents/bulk-jobs/${job.id}`) return Response.json(job);
        return base(input, init);
      });
      vi.stubGlobal("fetch", transport.fetchMock);
      render(<App />);
      const label = operation === "resume" ? "Resume unsent items"
        : operation === "cancel" ? "Cancel unsent items" : "Reconcile inconclusive";
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
      expect(window.localStorage.getItem("agent-control:active-bulk-job:v1")).toBeNull();
      expect(screen.queryByRole("region", { name: "Job controls" })).not.toBeInTheDocument();
    },
  );

  it.each([
    ["unified", "success"],
    ["unified", "failure"],
    ["Power Platform", "success"],
    ["Power Platform", "failure"],
  ] as const)("discards a delayed %s export %s after session revalidation", async (source, outcome) => {
    const transport = appTransport({
      revalidatedRoles: viewer.roles,
      unifiedResponse: unifiedRecordsPage(unifiedPage.value),
    });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const isExport = (path: string) => source === "unified"
      ? path === "/api/agent-inventory/export.csv" : path.startsWith("/api/inventory/export.csv?");
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
      ? new Response("ID,Name\r\n")
      : Response.json({ code: "export_failed", detail: "Old session export failed" }, { status: 500 })));
    expect(download).not.toHaveBeenCalled();
    expect(screen.queryByText(/Old session export failed/)).not.toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole("button", { name: "Confirm block" }));
    expect(await screen.findByRole("region", { name: "Job controls" })).toBeInTheDocument();
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
      await userEvent.click(await screen.findByRole("button", { name: "Confirm block" }));
      if (scenario === "navigation") await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
      else app.unmount();
      await act(async () => pending.resolve(Response.json(waitingBulkJob())));
      if (scenario === "navigation") {
        expect(window.localStorage.getItem("agent-control:active-bulk-job:v1")).toBe(waitingBulkJob().id);
        await userEvent.click(screen.getByRole("button", { name: "Agents" }));
        expect(screen.getByRole("region", { name: "Job controls" })).toBeInTheDocument();
      } else {
        expect(window.localStorage.getItem("agent-control:active-bulk-job:v1")).toBeNull();
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
      const isExport = (path: string) => source === "unified"
        ? path === "/api/agent-inventory/export.csv" : path.startsWith("/api/inventory/export.csv?");
      transport.fetchMock.mockImplementation(async (input, init) =>
        isExport(input) ? pending.promise : base(input, init));
      vi.stubGlobal("fetch", transport.fetchMock);
      const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:current-export") });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
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
      await act(async () => pending.resolve(new Response("ID,Name\r\n")));
      expect(download).toHaveBeenCalledTimes(1);
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
    window.localStorage.setItem("agent-control:active-bulk-job:v1", job.id);
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
    await userEvent.click(screen.getByRole("button", { name: "Cancel unsent items" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Job controls" })).not.toBeInTheDocument());
    await act(async () => pending.resolve(Response.json(job)));
    expect(screen.queryByRole("region", { name: "Job controls" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("agent-control:active-bulk-job:v1")).toBeNull();
    expect(screen.getByText("Cancelled. Already dispatched changes may have finished.")).toBeInTheDocument();
  });

  it("reports unavailable browser job storage without blocking saved inventory", async () => {
    const transport = accessEditorTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    const read = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (this === window.localStorage && key === "agent-control:active-bulk-job:v1") {
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
    expect(await screen.findByRole("link", { name: "Sign in with Entra ID" })).toBeInTheDocument();
    expect(screen.queryByText(agent.displayName)).not.toBeInTheDocument();
    expect(screen.getByText(/Unable to clear the saved package job/)).toBeInTheDocument();
  });

  it("clears superseded detail loading when preparing a bulk preview", async () => {
    const transport = accessEditorTransport();
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    transport.fetchMock.mockImplementation(async (input, init) =>
      input === `/api/agents/${agent.id}` ? pending.promise : base(input, init));
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
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:unified-agent-export");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    filenames.push(this.download);
  });
  return { filenames, createObjectURL };
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
    results: [{ id: agent.id, displayName: agent.displayName, status: "inconclusive", reconciliationStatus: "required" }],
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
}: {
  revalidatedRoles: SessionUser["roles"];
  deferRevalidation?: boolean;
  initialRoles?: SessionUser["roles"];
  authenticated?: boolean;
  revalidatedUser?: SessionUser;
  unifiedResponse?: UnifiedAgentInventoryPage;
  inventoryReadAuthorized?: boolean;
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
  transport.fetchMock.mockImplementation(async (input: string) => {
    if (input === "/api/auth/status") return Response.json({ authConfigured: true, callback: "http://localhost/api/auth/callback" });
    if (input === "/api/me") {
      currentUserCalls += 1;
      if (!authenticated) return Response.json({ user: null });
      if (currentUserCalls === 1) return Response.json({ user: { ...viewer, roles: initialRoles }, csrfToken: "csrf-1", roleAssignmentRequired: false });
      return deferRevalidation ? revalidation : revalidatedResponse();
    }
    if (input === "/api/capabilities") {
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
    if (input.startsWith("/api/official-usage/history")) return Response.json({
      summary: {
        importCount: 0,
        uniqueObservationCount: 0,
        observationRowCount: 0,
        uniquePayloadCount: 0,
        repeatedRowsReused: 0,
        earliestObservedAt: null,
        latestObservedAt: null,
        activityDateRange: {
          earliestDateUtc: null,
          latestDateUtc: null,
          provenance: "last_activity_dates",
          provesReportingCoverage: false,
        },
        reportingWindows: {
          knownCount: 0,
          unknownCount: 0,
          overlappingKnownWindowCount: 0,
          additive: false,
        },
        warning: {
          code: "rolling_snapshots_not_additive",
          message: "Rolling snapshots are non-additive.",
        },
      },
      bundles: { value: [], count: 0, limit: 10, offset: 0 },
    });
    if (input.startsWith("/api/official-usage/overview")) return Response.json(usageOverviewFixture());
    if (input.startsWith("/api/official-usage/aggregate")) return Response.json(usageAggregateFixture());
    if (input.startsWith("/api/official-usage/users")) {
      const params = new URL(input, "http://localhost").searchParams;
      return Response.json(usageUsersFixture({ staleAfterDays: 35, agentId: params.get("agentId") ?? undefined }));
    }
    if (input.startsWith("/api/official-usage/agents/")) {
      const agentId = decodeURIComponent(input.slice("/api/official-usage/agents/".length).split("?")[0]);
      return Response.json(usageAgentDetailFixture(agentId));
    }
    if (input === "/api/agent-inventory/export.csv") return new Response("Agent ID,Package IDs,inventoryPartial\r\n", { headers: { "Content-Type": "text/csv" } });
    if (input.startsWith("/api/agent-inventory")) {
      return Response.json(filterUnifiedResponse(unifiedResponse, input));
    }
    if (input === "/api/inventory/refresh-jobs") {
      return Response.json({ value: [], lastAttemptAt: null, lastSuccessAt: null });
    }
    if (input.startsWith("/api/quarantine/jobs?")) {
      return Response.json({ value: [] });
    }
    if (input === "/api/agents/export.csv") return new Response("Package ID,Display name\r\n", { headers: { "Content-Type": "text/csv" } });
    if (input === "/api/agents/package-private") return Response.json({
      ...agent,
      allowedUsersAndGroups: [],
      acquireUsersAndGroups: [],
      observation: {
        observedAt: packagePage.snapshot!.observedAt,
        expiresAt: packagePage.snapshot!.expiresAt,
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
      return Response.json(filterPackageResponse(packagePage, input));
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
  const recordId = url.searchParams.get("recordId");
  const search = url.searchParams.get("search")?.toLowerCase();
  const source = url.searchParams.get("source");
  const environmentId = url.searchParams.get("environmentId");
  const offset = Number(url.searchParams.get("offset") ?? response.offset ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? response.limit ?? 50);
  let value = response.value.filter(record =>
    (!recordId || record.id === recordId || record.packages.some(item => item.id === recordId))
    && (!search || JSON.stringify(record).toLowerCase().includes(search))
    && (!source || source === "all" || record.presence === source)
    && (!environmentId || record.environmentId === environmentId),
  );
  const count = recordId || search || (source && source !== "all") || environmentId
    ? value.length
    : response.count;
  if (value.length > limit || offset > 0) {
    value = value.slice(offset, offset + limit);
  }
  return { ...response, value, count, offset, limit };
}

function filterPackageResponse(response: PackagePage, input: string) {
  const url = new URL(input, "http://localhost");
  const search = url.searchParams.get("search")?.toLowerCase();
  if (!search) return response;
  const value = response.value.filter(item => JSON.stringify(item).toLowerCase().includes(search));
  return { ...response, value, count: value.length };
}

function agentListRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([path]) =>
    String(path).startsWith("/api/agents?") || path === "/api/agents",
  );
}

function refreshRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([path, init]) => path === "/api/agents/refresh-jobs" && init?.method === "POST");
}

function completedRefreshJob(): PackageRefreshJob {
  return {
    id: "refresh-first-load", authorizationPrincipalId: viewer.homeAccountId, tokenMode: "delegated", scopeKind: "broad", requestedIds: [],
    status: "succeeded", pageCount: 1, observedCount: 1, totalRecords: 1, snapshotId: packagePage.snapshot!.id,
    createdAt: new Date().toISOString(), attemptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  };
}

function initialCatalogTransport(options: Partial<Parameters<typeof appTransport>[0]> = {}) {
  const session = appTransport({ revalidatedRoles: viewer.roles, ...options });
  const transport = {
    session,
    page: { ...packagePage, snapshot: null, value: [], count: 0 } as PackagePage,
    jobs: [] as PackageRefreshJob[],
    failRefresh: false,
    readAuthorized: true,
    catalogResponse: undefined as (() => Promise<Response>) | undefined,
    jobResponse: undefined as (() => Promise<Response>) | undefined,
    fetchMock: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
  };
  transport.fetchMock.mockImplementation(async (input, init) => {
    if (input.startsWith("/api/official-usage/overview")) return Response.json(usageOverviewFixture());
    if (input.startsWith("/api/official-usage/aggregate")) return Response.json(null);
    if (input === "/api/capabilities" || input === "/api/capabilities/check") {
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
    if (response.ok && (input === "/api/agents" || input.startsWith("/api/agents?"))) {
      return transport.catalogResponse ? transport.catalogResponse() : Response.json(transport.page);
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
    if (input === "/api/agents/package-private") return Response.json(transport.exactCompleted ? {
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
      const result = {
        total: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
        accessUpdate,
        results: [{ id: agent.id, displayName: agent.displayName, status: "succeeded" }],
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
        results: result.results,
        result,
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
    if (input === "/api/capabilities" || input === "/api/capabilities/check") {
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
