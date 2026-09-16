import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions, workbenchViews } from "../../backend/src/services/workbenchMetadata";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import App from "./App";
import {
  getAgents,
  type BulkActionJob,
  type CopilotPackage,
  type InventoryRefreshJob,
  type PackagePage,
  type PackageRefreshJob,
  type PowerPlatformResource,
  type QuarantineJob,
  type SessionUser,
  type UnifiedAgentInventoryPage,
  type UnifiedAgentRecord,
} from "./api/client";
import { storePackageSelection } from "./packageSelectionSession";
import { mockNativeDialogs } from "./test/dialog";
import { copilotUsageFixture } from "./test/copilotUsageFixture";

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

const unifiedPage: UnifiedAgentInventoryPage = {
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
  return {
    ...unifiedPage,
    value: records,
    count,
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
    await userEvent.click(screen.getByRole("button", { name: `Manage ${agent.displayName}` }));
    expect(await screen.findByRole("tab", { name: "Manage" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps basic filters compact and hides advanced controls without removing them", async () => {
    vi.stubGlobal("fetch", appTransport({ revalidatedRoles: viewer.roles }).fetchMock);
    render(<App />);
    await screen.findByText(agent.displayName);
    const filters = within(screen.getByRole("region", { name: "Filters" }));
    expect(filters.getAllByRole("combobox")).toHaveLength(5);
    expect(filters.getByRole("checkbox", { name: "Advanced filters" })).not.toBeChecked();
    expect(screen.getByLabelText("Environment")).not.toBeVisible();
    expect(screen.queryByLabelText("Source")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Source link")).not.toBeInTheDocument();
    for (const name of ["Built with", "Available to", "Host", "Package status"]) {
      expect(filters.getByRole("combobox", { name })).toBeVisible();
    }
    expect(filters.getByRole("spinbutton", { name: "Created within days" })).toBeVisible();
    expect(screen.getByLabelText("Publisher")).not.toBeVisible();
    expect(filters.queryByRole("button", { name: "Export package inventory CSV" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export package inventory CSV" })).toBeInTheDocument();
    await userEvent.click(filters.getByRole("checkbox", { name: "Advanced filters" }));
    expect(filters.getByRole("region", { name: "Advanced agent filters" })).toBeVisible();
    for (const label of ["Environment", "Search environments", "Publisher"]) {
      expect(screen.getByLabelText(label)).toBeVisible();
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

  it("keeps Agents focused on the catalog and moves coverage and collection controls to Sync", async () => {
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
    expect(screen.queryByText("Copilot Studio agent coverage is incomplete.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh agents" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` }));
    expect(screen.getByRole("button", { name: "Block selected packages" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Partial inventory/ }));
    expect(window.location.pathname).toBe("/sync");
    expect(screen.getByRole("region", { name: "Data sync" })).toBeVisible();
    expect(screen.getByText("Copilot Studio agent coverage is incomplete.")).toBeVisible();
    expect(screen.getByText("Source-metadata links")).toBeVisible();
    expect(screen.getByText(/1 published target selected/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Sync history" })).toBeVisible();
    expect(screen.queryByText("No Agent Control app role is assigned.")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Data sync" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Browse agents" }));
    expect(window.location.pathname).toBe("/agents");
    expect(screen.getByRole("checkbox", { name: `Select ${agent.displayName}` })).toBeChecked();
  });

  it("opens Sync for a users-only collection without putting progress back on Users", async () => {
    window.history.replaceState({}, "", "/users");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input.startsWith("/api/copilot-usage/users")) return Response.json(copilotUsageFixture);
      if (input === "/api/data-sync/runs" && init?.method === "POST") return Response.json({
        id: "users-sync", mode: "incremental", status: "running",
        startedAt: "2026-09-15T08:00:00.000Z", updatedAt: "2026-09-15T08:00:00.000Z", completedAt: null,
        sources: [{ source: "users", status: "running", count: null, jobId: null, lastSuccessAt: null, updatedAt: null, message: "", canRetry: false }],
      });
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Sync users" }));
    expect(window.location.pathname).toBe("/sync");
    expect(screen.getByRole("region", { name: "Data sync" })).toBeVisible();
    await waitFor(() => {
      const request = transport.fetchMock.mock.calls.find(([path, init]) => path === "/api/data-sync/runs" && init?.method === "POST");
      expect(request).toBeDefined();
      expect(JSON.parse(String(request?.[1]?.body))).toEqual({ mode: "incremental", sources: ["users"] });
    });
    await userEvent.click(screen.getByRole("button", { name: "Users" }));
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
    expect(screen.getByText(/Discover agents across Microsoft 365 and Copilot Studio, explore Copilot usage and license insights, and investigate activity/)).toBeInTheDocument();
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

  it("keeps a restored unified agent detail open after the saved inventory resolves", async () => {
    const detailId = unifiedPage.value[0].id;
    window.history.replaceState({}, "", `/agents?detail=${encodeURIComponent(detailId)}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const dialog = await screen.findByRole("dialog", { name: agent.displayName });
    expect(within(dialog).getByText("Agent details")).toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
    expect(dialog).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("detail")).toBe(detailId);
  });

  it.each(["navigation", "role revocation"] as const)(
    "does not open a delayed unified detail after %s leaves the owning session route",
    async scenario => {
      const transport = appTransport({
        revalidatedRoles: scenario === "role revocation" ? [] : viewer.roles,
        deferRevalidation: scenario === "role revocation",
      });
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
      await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private")).toBe(true));
      if (scenario === "navigation") {
        await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
      } else {
        transport.failProtectedReadsWith = 401;
        await act(async () => { await expect(getAgents()).rejects.toMatchObject({ status: 401 }); });
        await waitFor(() => expect(transport.meCalls()).toBe(2));
        await act(async () => transport.releaseRevalidation());
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

  it("uses authorized bulk references for both package lists and exports", async () => {
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

    const exportButton = screen.getByRole("button", { name: "Export package inventory CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await userEvent.click(exportButton);
    await userEvent.click(await screen.findByRole("button", { name: /Download package inventory/ }));
    await waitFor(() => expect(transport.fetchMock).toHaveBeenCalledWith(
      "/api/agents/export.csv",
      expect.objectContaining({ method: "POST" }),
    ));
    const exportCall = transport.fetchMock.mock.calls.find(([path]) => path === "/api/agents/export.csv")!;
    expect(JSON.parse(String(exportCall[1]?.body))).toMatchObject({
      filters: { operationIdPrefix: "a5331a93" },
      snapshotId: "snapshot-private",
    });
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
    expect(await screen.findByText(/Latest agent refresh: succeeded/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sync history" })).toBeInTheDocument();
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
    expect(await screen.findByText(/Latest agent refresh: succeeded/, {}, { timeout: 4_000 })).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText(/Last synced/)).toBeInTheDocument());
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
    expect(await screen.findByText("Saved catalog unavailable")).toBeInTheDocument();
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

  it.each(["availability", "installation"] as const)("refreshes exact details only when Edit %s is requested", async target => {
    const transport = accessEditorTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View details for Sensitive cached agent" }));
    const saved = await screen.findByRole("dialog", { name: "Sensitive cached agent" });
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private/refresh-jobs")).toBe(false);
    await userEvent.click(within(saved).getByRole("tab", { name: "Availability" }));
    await userEvent.click(within(saved).getByRole("button", { name: target === "availability" ? /Manage access for/ : /Manage installation for/ }));
    const editor = await screen.findByRole("dialog", { name: "Manage agent access" });
    expect(screen.queryByRole("dialog", { name: "Sensitive cached agent" })).not.toBeInTheDocument();
    expect(within(editor).getByRole("heading", { name: target === "availability" ? "Select who can use this agent" : "Select who this agent is installed for" })).toBeInTheDocument();
    expect(within(editor).getByRole("radio", { name: target === "availability" ? /No users/ : /Specific users or groups/ })).toBeChecked();
    if (target === "installation") expect(await within(editor).findByText("Installed user", { exact: true })).toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/package-private/refresh-jobs")).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/package-private")).toHaveLength(2);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Manage agent access" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Sensitive cached agent" })).toBeInTheDocument();
  });

  it("hands a unified native modal off to package confirmation and restores it on cancel", async () => {
    const transport = accessEditorTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View details for Sensitive cached agent" }));
    const detail = await screen.findByRole("dialog", { name: "Sensitive cached agent" });
    await userEvent.click(within(detail).getByRole("tab", { name: "Availability" }));
    await userEvent.click(within(detail).getByRole("button", { name: "Block Sensitive cached agent (package-private)" }));

    const confirmation = await screen.findByRole("dialog", { name: /block package/i });
    expect(screen.queryByRole("dialog", { name: "Sensitive cached agent" })).not.toBeInTheDocument();
    expect(within(confirmation).getByText("package-private")).toBeInTheDocument();
    await userEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("dialog", { name: "Sensitive cached agent" })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("detail")).toBe(unifiedPage.value[0].id);
  });

  it("projects provider-verified access results into the unified row detail", async () => {
    const transport = accessEditorTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View details for Sensitive cached agent" }));
    const detail = await screen.findByRole("dialog", { name: "Sensitive cached agent" });
    await userEvent.click(within(detail).getByRole("tab", { name: "Availability" }));
    await userEvent.click(within(detail).getByRole("button", { name: /Manage access for/ }));
    const editor = await screen.findByRole("dialog", { name: "Manage agent access" });
    await userEvent.click(within(editor).getByRole("button", { name: "Apply" }));
    await userEvent.click(within(editor).getByRole("button", { name: "Confirm and apply" }));
    const confirmation = await screen.findByRole("dialog", { name: /update availability package/i });
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm update availability" }));

    const restored = await screen.findByRole("dialog", { name: "Sensitive cached agent" });
    expect(await within(restored).findByText(/Available to: No users/)).toBeInTheDocument();
    expect(within(restored).getByText(/Installed for: Unknown/)).toBeInTheDocument();
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
    expect(selectA).toBeEnabled();
    await waitFor(() => expect(selectA).toBeChecked());
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

  it.each(["table", "detail"] as const)("surfaces exact-read failures instead of opening the %s editor from saved data", async entry => {
    const transport = accessEditorTransport();
    transport.exactResponse = async () => Response.json({ code: "forbidden", detail: "Exact provider read denied" }, { status: 403 });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    if (entry === "table") {
      await userEvent.click(await screen.findByRole("button", { name: "Manage access for Sensitive cached agent" }));
    } else {
      await userEvent.click(await screen.findByRole("button", { name: "View details for Sensitive cached agent" }));
      const saved = await screen.findByRole("dialog", { name: "Sensitive cached agent" });
      await userEvent.click(within(saved).getByRole("tab", { name: "Availability" }));
      await userEvent.click(within(saved).getByRole("button", { name: /Manage installation for/ }));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent("Exact provider read denied");
    expect(screen.queryByRole("dialog", { name: "Manage agent access" })).not.toBeInTheDocument();
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

  it("restores a historical official-usage snapshot as exact GET reads without changing active selection", async () => {
    const reportSetId = "11111111-1111-4111-8111-111111111111";
    window.history.replaceState({}, "", `/official-usage?snapshot=${reportSetId}`);
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const base = transport.fetchMock.getMockImplementation()!;
    transport.fetchMock.mockImplementation(async (input, init) => {
      if (input.startsWith("/api/official-usage/aggregate") || input.startsWith("/api/official-usage/users")) {
        return Response.json(null);
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("Historical snapshot view")).toBeVisible();
    await waitFor(() => {
      expect(transport.fetchMock.mock.calls.some(([input]) =>
        input.startsWith(`/api/official-usage/aggregate?setId=${reportSetId}&activityWindowDays=365`))).toBe(true);
      expect(transport.fetchMock.mock.calls.some(([input]) =>
        input.startsWith(`/api/official-usage/users?setId=${reportSetId}`))).toBe(true);
    });
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
    expect(exactCalls.some(([input]) => input.startsWith("/api/official-usage/users"))).toBe(true);
    expect(exactCalls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
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

  it.each(["navigation", "session revalidation"] as const)(
    "discards a delayed bulk preview after %s",
    async scenario => {
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
      await userEvent.click(await screen.findByRole("checkbox", { name: `Select ${agent.displayName}` }));
      await userEvent.click(screen.getByRole("button", { name: "Block selected packages" }));
      await waitFor(() => expect(preview).toBeDefined());
      if (scenario === "navigation") {
        await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
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

  it.each(["single", "bulk"] as const)(
    "does not track a delayed %s mutation response in a revalidated session",
    async scope => {
      const transport = accessEditorTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const endpoint = scope === "single" ? `/api/agents/${agent.id}/block` : "/api/agents/block";
      transport.fetchMock.mockImplementation(async (input, init) =>
        input === endpoint ? pending.promise : base(input, init));
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
      await revalidateTransportSession(transport.session);
      await act(async () => pending.resolve(Response.json(waitingBulkJob())));
      expect(window.localStorage.getItem("agent-control:active-bulk-job:v1")).toBeNull();
      expect(screen.queryByRole("region", { name: "Job controls" })).not.toBeInTheDocument();
    },
  );

  it.each(["resume", "cancel", "reconcile"] as const)(
    "discards a delayed package-job %s response after session revalidation",
    async operation => {
      const transport = accessEditorTransport();
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const job = waitingBulkJob();
      const endpoint = `/api/agents/bulk-jobs/${job.id}/${operation}`;
      window.localStorage.setItem("agent-control:active-bulk-job:v1", job.id);
      transport.fetchMock.mockImplementation(async (input, init) => {
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
      await revalidateTransportSession(transport.session);
      await act(async () => pending.resolve(Response.json({
        ...job, reconciliation: { attempted: 1, failed: 0, errors: [] },
      })));
      expect(window.localStorage.getItem("agent-control:active-bulk-job:v1")).toBeNull();
      expect(screen.queryByRole("region", { name: "Job controls" })).not.toBeInTheDocument();
    },
  );

  it.each([
    ["package", "success"],
    ["package", "failure"],
    ["Power Platform", "success"],
    ["Power Platform", "failure"],
  ] as const)("discards a delayed %s export %s after session revalidation", async (source, outcome) => {
    const transport = appTransport({
      revalidatedRoles: viewer.roles,
      unifiedResponse: unifiedRecordsPage(unifiedPage.value),
    });
    const base = transport.fetchMock.getMockImplementation()!;
    const pending = deferredResponse();
    const isExport = (path: string) => source === "package"
      ? path === "/api/agents/export.csv" : path.startsWith("/api/inventory/export.csv?");
    transport.fetchMock.mockImplementation(async (input, init) =>
      isExport(input) ? pending.promise : base(input, init));
    vi.stubGlobal("fetch", transport.fetchMock);
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:expired-export") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    render(<App />);
    await screen.findByText(agent.displayName);
    if (source === "package") {
      await userEvent.click(screen.getByRole("button", { name: "Export package inventory CSV" }));
      await userEvent.click(await screen.findByRole("button", { name: /Download package inventory/ }));
    } else {
      await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
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

  it.each(["package", "Power Platform"] as const)(
    "finishes an in-flight %s export across tabs without starting a duplicate",
    async source => {
      const transport = appTransport({
        revalidatedRoles: viewer.roles,
        unifiedResponse: unifiedRecordsPage(unifiedPage.value),
      });
      const base = transport.fetchMock.getMockImplementation()!;
      const pending = deferredResponse();
      const isExport = (path: string) => source === "package"
        ? path === "/api/agents/export.csv" : path.startsWith("/api/inventory/export.csv?");
      transport.fetchMock.mockImplementation(async (input, init) =>
        isExport(input) ? pending.promise : base(input, init));
      vi.stubGlobal("fetch", transport.fetchMock);
      const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:current-export") });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
      render(<App />);
      await screen.findByText(agent.displayName);
      if (source === "package") {
        await userEvent.click(screen.getByRole("button", { name: "Export package inventory CSV" }));
        await userEvent.click(await screen.findByRole("button", { name: /Download package inventory/ }));
      } else {
        await userEvent.click(screen.getByRole("button", { name: /^Sync/ }));
        await userEvent.click(await screen.findByRole("button", { name: "Export PP agent inventory CSV" }));
      }
      await waitFor(() => expect(transport.fetchMock.mock.calls.filter(([path]) => isExport(path))).toHaveLength(1));
      await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
      await userEvent.click(screen.getByRole("button", { name: source === "package" ? "Agents" : /^Sync/ }));
      expect(screen.getByRole("button", { name: source === "package" ? /^Exporting/ : "Exporting PP agents..." })).toBeDisabled();
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
    expect(screen.getByText("Loading agent details...")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Block selected packages" }));
    await screen.findByRole("dialog", { name: /block package/i });
    await act(async () => pending.resolve(Response.json(agent)));
    expect(screen.queryByText("Loading agent details...")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: agent.displayName })).not.toBeInTheDocument();
  });
});

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
    if (input.startsWith("/api/official-usage/aggregate")) return Response.json({});
    if (input.startsWith("/api/official-usage/users")) return Response.json({});
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
