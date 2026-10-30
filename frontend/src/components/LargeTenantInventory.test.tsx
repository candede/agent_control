import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useMemo, useState } from "react";
import { ApiError, getInventoryChildren, getInventoryFacets } from "../api/client";
import { InventoryFacetSelect } from "./InventoryFacetSelect";
import { InventoryRefreshTargets } from "./InventoryRefreshTargets";
import { getPackageRefreshTargets, type PackageRefreshJob } from "../api/client";
import { ReportExportButton } from "./ReportExportButton";
import { createReportExport, reportExportStatus } from "../api/reportData";
import { getUnifiedAgents, type UnifiedAgentInventoryPage, type UnifiedAgentInventoryQuery } from "../api/client";
import { encodeInventoryFacet } from "../../../backend/src/types/inventoryFacets";
import { AgentInventoryQueries } from "../agentInventoryQueries";
import { UnifiedAgentTable } from "./UnifiedAgentTable";
import { createInventoryVerification, createUnifiedVerification, inventoryPageMetadata } from "../test/inventoryVerification";
import { deferred } from "../test/deferred";
import { QueryClientProvider } from "@tanstack/react-query";
import { createSavedQueryClient } from "../savedQueries";
import { SavedAgentChannels, SavedAgentConnectors } from "./SavedAgentConfiguration";

vi.mock("../api/reportData", () => ({
  createReportExport: vi.fn(), reportExportStatus: vi.fn(), cancelReportExport: vi.fn(),
  reportExportDownload: (id: string) => `/api/data-exports/${id}/download`,
}));
vi.mock("../api/client", async original => ({ ...await original<typeof import("../api/client")>(),
  getInventoryChildren: vi.fn(), getInventoryFacets: vi.fn(), getPackageRefreshTargets: vi.fn(),
  getUnifiedAgents: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function inventoryPage(offset = 0, prefix = "First account"): UnifiedAgentInventoryPage {
  const total = 6001, summary = { total, linked: 0, graphOnly: total, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 };
  const observation = { id: "source", snapshotId: "source", observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(), current: true as const };
  return {
    ...inventoryPageMetadata({ total: 6031, scoped: 6021, filtered: total, packageTargets: total }),
    page: { limit: 50, nextCursor: `page-${offset + 50}`, previousCursor: offset ? `page-${offset - 50}` : null },
    inventoryScope: "catalog", summary: { ...summary, total: 6031, graphOnly: 6021, powerPlatformOnly: 10 },
    scopeSummary: { ...summary, total: 6021, graphOnly: 6021 }, filteredSummary: summary, partial: false, errors: [],
    verification: createUnifiedVerification({ graphPackageCount: 6021, powerPlatformAgentCount: 10, logicalAgentCount: 6031 }),
    sources: { graphPackages: { state: "available", error: null, observation: {
      ...observation, scopeKind: "broad", observedCount: 6021, totalRecords: 6021,
    } }, powerPlatform: { state: "available", error: null, observation: {
      ...observation, roleScope: "full", environmentScope: null, coverage: "covered", coveredCount: 1,
      observedCount: 10, totalRecords: 10, pageCount: 1, verification: createInventoryVerification(10),
    } } },
    value: Array.from({ length: 50 }, (_, index) => ({
      id: `agent:00000000-0000-4000-8000-${String(offset + index).padStart(12, "0")}`,
      displayName: `${prefix} agent ${offset + index}`, presence: "graph_packages", environmentId: null,
      packages: [{ id: `package-${offset + index}`, displayName: `Package ${offset + index}`, isBlocked: false,
        sourceSystem: "graph_packages", authoringTool: null, creatorType: "unknown", agentKind: "copilot_package",
        lifecycle: "unknown", identityConfidence: "exact_native", provenance: {} }], powerPlatformResource: null,
      identity: { state: "unmatched", reason: null, evidence: [], packageEvidence: [] },
      observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
    })),
  };
}

const initialInventoryQuery: UnifiedAgentInventoryQuery = {
  limit: 50, inventoryScope: "catalog", blocked: false, sortBy: "lastModifiedAt", sortDirection: "desc",
};
function SelectedInventoryTable({ owner }: { owner: string }) {
  const [queries] = useState(() => new AgentInventoryQueries());
  const [request, setRequest] = useState<{ owner: string; query: UnifiedAgentInventoryQuery }>({
    owner, query: initialInventoryQuery,
  });
  const query = useMemo(() => request.owner === owner ? request.query
    : initialInventoryQuery, [request, owner]);
  const key = JSON.stringify([owner, query]);
  const [result, setResult] = useState<{ key: string; page: UnifiedAgentInventoryPage }>();
  const page = result?.key === key ? result.page : undefined;
  useEffect(() => {
    const controller = new AbortController();
    void queries.read(owner, query, controller.signal).then(page => {
      if ("state" in page) throw new Error(`Expected a published inventory, received ${page.state}.`);
      if (!controller.signal.aborted) setResult({ key, page });
    }).catch(() => {});
    return () => controller.abort();
  }, [queries, key, owner, query]);
  useEffect(() => () => queries.clear(), [queries]);
  const navigate = (cursor: string) => setRequest({ owner, query: { ...query, selectionId: page!.selection.id, cursor } });
  return <>
    <output aria-label="Inventory counts">{page ? `${page.counts.filtered} matching / ${page.counts.scoped} scoped / ${page.counts.total} total` : "Loading"}</output>
    <button disabled={!page?.page.previousCursor} onClick={() => navigate(page!.page.previousCursor!)}>Previous inventory page</button>
    <button disabled={!page?.page.nextCursor} onClick={() => navigate(page!.page.nextCursor!)}>Next inventory page</button>
    <UnifiedAgentTable records={page?.value ?? []} selectedPackageIds={new Set()} selectedPackageCount={0} allPackagesSelected={false}
      selectedPowerPlatformKeys={new Set()} packageSelectionAllowed={false} packageOperationsAllowed={false} quarantineSelectionAllowed={false}
      selectionDisabled sortBy={query.sortBy} sortDirection={query.sortDirection} onSortChange={(sortBy, sortDirection) => {
        const next = { ...query, sortBy, sortDirection };
        delete next.cursor;
        delete next.selectionId;
        setRequest({ owner, query: next });
      }}
      onToggleSelection={() => {}} onViewDetails={() => {}} onManageAccess={() => {}} onSetBlocked={() => {}} />
  </>;
}

describe("large inventory outcome consumers", () => {
  it("renders only a 50-row server page with independent 6001 counts, cursor navigation, sorting and principal reset", async () => {
    const read = vi.mocked(getUnifiedAgents).mockReset().mockImplementation(async query =>
      inventoryPage(Number(query?.cursor?.split("-").at(-1) ?? 0)));
    const user = userEvent.setup(), view = render(<SelectedInventoryTable owner="tenant:first:viewer" />);
    await screen.findByRole("button", { name: "View details for First account agent 0" });
    expect(screen.getAllByRole("row")).toHaveLength(51);
    expect(screen.getByLabelText("Inventory counts")).toHaveTextContent("6001 matching / 6021 scoped / 6031 total");
    expect(read).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Next inventory page" }));
    await screen.findByRole("button", { name: "View details for First account agent 50" });
    expect(screen.queryByRole("button", { name: "View details for First account agent 0" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(51);
    expect(read.mock.calls.at(-1)![0]).toMatchObject({ limit: 50, cursor: "page-50", selectionId: inventoryPage().selection.id });
    await user.click(screen.getByRole("button", { name: "Previous inventory page" }));
    await screen.findByRole("button", { name: "View details for First account agent 0" });
    await user.click(screen.getByRole("button", { name: "Sort by Agent" }));
    await waitFor(() => expect(read.mock.calls.at(-1)![0]).toMatchObject({ sortBy: "displayName", limit: 50 }));
    expect(read.mock.calls.at(-1)![0]).not.toHaveProperty("cursor");
    expect(read.mock.calls.at(-1)![0]).not.toHaveProperty("selectionId");
    read.mockResolvedValueOnce(inventoryPage(0, "Second account"));
    view.rerender(<SelectedInventoryTable owner="tenant:second:viewer" />);
    expect(screen.queryByRole("button", { name: /View details for First account/ })).not.toBeInTheDocument();
    await screen.findByRole("button", { name: "View details for Second account agent 0" });
    expect(read.mock.calls.at(-1)![0]).not.toHaveProperty("selectionId");
    expect(read).toHaveBeenCalledTimes(5);
    expect(screen.getAllByRole("row")).toHaveLength(51);
  });
  it("prepares more than 5000 matching rows and uses a revalidated native download, never an artifact fetch", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.mocked(createReportExport).mockReset().mockResolvedValue({ id: "large-export" });
    vi.mocked(reportExportStatus).mockReset().mockResolvedValue({ id: "large-export", status: "ready", rows: 6001,
      bytes: 600100, expiresAt: new Date(Date.now() + 600000).toISOString(), error: null, limit: null, observed: null });
    render(<ReportExportButton kind="unified_agents" selectionId="pinned-large-selection" label="Prepare inventory CSV" autoStart />);
    await act(async () => { await Promise.resolve(); });
    expect(createReportExport).toHaveBeenCalledWith({ kind: "unified_agents", selectionId: "pinned-large-selection", ids: undefined,
      idempotencyKey: expect.any(String) }, expect.any(AbortSignal));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("status")).toHaveTextContent("6,001 rows");
    const link = screen.getByRole("link", { name: "Download CSV" });
    expect(link).toHaveAttribute("href", "/api/data-exports/large-export/download");
    await act(async () => { fireEvent.click(link); });
    expect(reportExportStatus).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts abandoned export admission and does not poll or reveal another selection's result", async () => {
    vi.useFakeTimers();
    let finish!: (value: { id: string }) => void;
    vi.mocked(createReportExport).mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ id: "new-export" });
    vi.mocked(reportExportStatus).mockReset().mockResolvedValue({ id: "new-export", status: "ready", rows: 1,
      bytes: 10, expiresAt: new Date(Date.now() + 600000).toISOString(), error: null, limit: null, observed: null });
    const view = render(<ReportExportButton kind="unified_agents" selectionId="old-selection" label="Prepare CSV" autoStart />);
    await act(async () => { await Promise.resolve(); });
    const oldSignal = vi.mocked(createReportExport).mock.calls[0][1]!;
    view.rerender(<ReportExportButton kind="unified_agents" selectionId="new-selection" label="Prepare CSV" autoStart />);
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { finish({ id: "old-export" }); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(reportExportStatus).toHaveBeenCalledExactlyOnceWith("new-export", expect.any(AbortSignal));
    expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", "/api/data-exports/new-export/download");
  });
  it.each(["admission", "build", "download"] as const)("reports %s selection invalidation without replaying or downloading", async phase => {
    vi.useFakeTimers();
    const invalidated = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const failure = new ApiError(409, "selection_invalidated", "Selection changed.");
    vi.mocked(createReportExport).mockReset().mockResolvedValue({ id: "invalid-export" });
    vi.mocked(reportExportStatus).mockReset().mockResolvedValue({ id: "invalid-export", status: "ready", rows: 1,
      bytes: 10, expiresAt: new Date(Date.now() + 600000).toISOString(), error: null, limit: null, observed: null });
    if (phase === "admission") vi.mocked(createReportExport).mockRejectedValueOnce(failure);
    if (phase === "build") vi.mocked(reportExportStatus).mockResolvedValueOnce({ id: "invalid-export",
      status: "failed", rows: 0, bytes: 0, expiresAt: new Date(Date.now() + 600000).toISOString(),
      error: "selection_invalidated", limit: null, observed: null });
    render(<ReportExportButton kind="unified_agents" selectionId="invalid-selection" label="Prepare CSV" autoStart
      onSelectionInvalidated={invalidated} />);
    await act(async () => { await Promise.resolve(); });
    if (phase !== "admission") await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    if (phase === "download") {
      vi.mocked(reportExportStatus).mockRejectedValueOnce(failure);
      await act(async () => { fireEvent.click(screen.getByRole("link", { name: "Download CSV" })); });
    }
    expect(invalidated).toHaveBeenCalledOnce();
    expect(createReportExport).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Restart the selection");
  });
  it("renders one refresh target page, uses scalar 5000 totals, and aborts old revisions", async () => {
    const refresh: PackageRefreshJob = { id: "refresh", authorizationPrincipalId: "principal", tokenMode: "delegated", scopeKind: "exact",
      targetCount: 5000, resultRevision: "1", status: "running", pageCount: 0, observedCount: 25, totalRecords: 5000,
      snapshotId: null, createdAt: "2026-01-01", updatedAt: "2026-01-01", attemptedAt: null, finishedAt: null };
    vi.mocked(getPackageRefreshTargets).mockResolvedValue({ value: [{ id: "selected target", ordinal: 0, status: "observed_unpublished" }],
      revision: "1", counts: { total: 5000, filtered: 5000 }, page: { limit: 50, nextCursor: "next-targets", previousCursor: null } });
    const view = render(<InventoryRefreshTargets job={refresh} owner="principal" />);
    expect(await screen.findByText("selected target")).toBeVisible();
    expect(screen.getByText("Refresh targets (5,000)")).toBeVisible();
    expect(getPackageRefreshTargets).toHaveBeenCalledTimes(1);
    const pending = deferred<Awaited<ReturnType<typeof getPackageRefreshTargets>>>();
    vi.mocked(getPackageRefreshTargets).mockReturnValueOnce(pending.promise);
    await userEvent.click(screen.getByRole("button", { name: "Next targets" }));
    const signal = vi.mocked(getPackageRefreshTargets).mock.calls[1][1]!.signal!;
    expect(getPackageRefreshTargets).toHaveBeenLastCalledWith(expect.objectContaining({ resultRevision: "1" }), expect.objectContaining({ cursor: "next-targets" }));
    view.rerender(<InventoryRefreshTargets job={{ ...refresh, resultRevision: "2" }} owner="principal" />);
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(getPackageRefreshTargets).toHaveBeenLastCalledWith(expect.objectContaining({ resultRevision: "2" }), expect.objectContaining({ cursor: undefined })));
  });

  describe("large saved configuration pages", () => {
    const props = { selectionId: "configuration-selection", recordId: "agent:configuration",
      source: { scopeId: "source-scope", identity: "native-agent" } };
    type ChildPage = Awaited<ReturnType<typeof getInventoryChildren>>;
    function configurationPage(kind: string, label = "First"): ChildPage {
      return { value: [{ ordinal: 0, kind, value: kind === "detail:channels" ? `${label} channel` : "0",
        payload: kind === "detail:connectors" ? { connectorId: `${label} connector`, operations: [] }
          : kind === "connectorOperation" ? { operationId: `${label} operation` } : {} }],
      total: 9000, nextCursor: "next-configuration" };
    }
    it.each(["connectors", "channels", "operations"] as const)(
      "keeps %s paging focused while loading and can leave a rejected cursor without draining details", async section => {
        const kind = section === "operations" ? "connectorOperation" : `detail:${section}`;
        const read = vi.mocked(getInventoryChildren).mockReset().mockImplementation(async (_s, _r, _m, requestedKind) => configurationPage(requestedKind));
        render(section === "channels" ? <SavedAgentChannels {...props} /> : <SavedAgentConnectors {...props} />);
        const label = section === "operations" ? "First operation" : section === "channels" ? "First channel" : "First connector";
        await screen.findByText(label);
        if (section !== "channels") await screen.findByText("First operation");
        expect(screen.getByText(`1 shown of 9,000 saved ${section}`)).toBeVisible();
        const initialCalls = read.mock.calls.length;
        expect(initialCalls).toBe(section === "channels" ? 1 : 2);
        const pending = deferred<ChildPage>();
        read.mockImplementationOnce(() => pending.promise);
        const next = screen.getByRole("button", { name: `Next ${section}` });
        next.focus();
        fireEvent.click(next);
        expect(next).toBeInTheDocument();
        expect(next).toHaveFocus();
        expect(next).toHaveAttribute("aria-disabled", "true");
        fireEvent.click(next);
        expect(read).toHaveBeenCalledTimes(initialCalls + 1);
        expect(read).toHaveBeenLastCalledWith(props.selectionId, props.recordId,
          { source_scope_id: props.source.scopeId, source_identity: props.source.identity },
          kind, "next-configuration", expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(screen.queryByText(label)).not.toBeInTheDocument();
        expect(screen.queryByText(`1 shown of 9,000 saved ${section}`)).not.toBeInTheDocument();
        await act(async () => pending.reject(new ApiError(400, "invalid_cursor", "Saved detail cursor rejected.")));
        expect(await screen.findByRole("alert")).toHaveTextContent("Saved detail cursor rejected.");
        expect(next).toHaveFocus();
        const previous = screen.getByRole("button", { name: `Previous ${section}` });
        expect(previous).toHaveAttribute("aria-disabled", "false");
        previous.focus();
        fireEvent.click(previous);
        expect(await screen.findByText(label)).toBeVisible();
        expect(previous).toHaveFocus();
        expect(previous).toHaveAttribute("aria-disabled", "true");
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(read.mock.calls.filter(call => call[3] === kind).map(call => call[4]))
          .toEqual([undefined, "next-configuration", undefined]);
      },
    );
    it.each(["page", "invalidation"] as const)("withdraws revalidating connectors, cancels pending operations and ignores a late child %s", async outcome => {
      const queries = createSavedQueryClient();
      const oldOperations = deferred<ChildPage>(), replacement = deferred<ChildPage>();
      const invalidated = vi.fn();
      const read = vi.mocked(getInventoryChildren).mockReset().mockImplementation(async (_s, _r, _m, kind) => configurationPage(kind));
      read.mockImplementationOnce(async () => configurationPage("detail:connectors"))
        .mockReturnValueOnce(oldOperations.promise);
      const view = render(<QueryClientProvider client={queries}><SavedAgentConnectors {...props} onInvalidated={invalidated} /></QueryClientProvider>);
      try {
        await screen.findByText("First connector");
        await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
        const oldSignal = read.mock.calls[1][5]!.signal!;
        read.mockReturnValueOnce(replacement.promise);
        act(() => { void queries.invalidateQueries({ predicate: query => query.queryKey[6] === "detail:connectors" }); });
        await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
        expect(screen.queryByText("First connector")).not.toBeInTheDocument();
        expect(oldSignal.aborted).toBe(true);
        await act(async () => {
          if (outcome === "page") oldOperations.resolve(configurationPage("connectorOperation", "Retired"));
          else oldOperations.reject(new ApiError(409, "selection_invalidated", "Retired operation selection."));
        });
        expect(screen.queryByText("Retired operation")).not.toBeInTheDocument();
        expect(invalidated).not.toHaveBeenCalled();
        await act(async () => replacement.reject(new Error("Saved configuration unavailable.")));
        expect(await screen.findByRole("alert")).toHaveTextContent("Saved configuration unavailable.");
        const retry = deferred<ChildPage>();
        read.mockReturnValueOnce(retry.promise);
        const retryButton = screen.getByRole("button", { name: "Retry configuration" });
        act(() => { retryButton.click(); retryButton.click(); });
        await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
        expect(screen.getByRole("status")).toHaveTextContent("Loading saved configuration");
        expect(read).toHaveBeenCalledTimes(4);
        await act(async () => retry.resolve(configurationPage("detail:connectors", "Current")));
        expect(await screen.findByText("Current connector")).toBeVisible();
        expect(await screen.findByText("First operation")).toBeVisible();
        expect(read).toHaveBeenCalledTimes(5);
        expect(screen.queryByText("Retired operation")).not.toBeInTheDocument();
        expect(invalidated).not.toHaveBeenCalled();
      } finally {
        view.unmount();
        queries.clear();
      }
    });
    it("keeps configuration paging focused through revalidation but withdraws it when the selection is invalidated", async () => {
      const queries = createSavedQueryClient(), invalidated = vi.fn();
      const pending = deferred<ChildPage>();
      const read = vi.mocked(getInventoryChildren).mockReset().mockResolvedValueOnce(configurationPage("detail:channels"))
        .mockReturnValueOnce(pending.promise);
      const view = render(<QueryClientProvider client={queries}><SavedAgentChannels {...props} onInvalidated={invalidated} /></QueryClientProvider>);
      try {
        await screen.findByText("First channel");
        const next = screen.getByRole("button", { name: "Next channels" });
        next.focus();
        act(() => { void queries.invalidateQueries(); });
        await waitFor(() => expect(next).toHaveAttribute("aria-disabled", "true"));
        expect(next).toHaveFocus();
        expect(screen.queryByText("First channel")).not.toBeInTheDocument();
        fireEvent.click(next);
        expect(read).toHaveBeenCalledTimes(2);
        await act(async () => pending.reject(new ApiError(409, "selection_invalidated", "Selection retired.")));
        expect(await screen.findByRole("alert")).toHaveTextContent("Reload saved inventory.");
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(invalidated).toHaveBeenCalledOnce();
        expect(read).toHaveBeenCalledTimes(2);
      } finally {
        view.unmount();
        queries.clear();
      }
    });
  });

  describe("selected inventory facet consumers", () => {
    beforeEach(() => {
      vi.mocked(getInventoryFacets).mockReset().mockResolvedValue({ value: [{ value: "platform", label: "Platform" }], total: 6001, nextCursor: "facet-next" });
    });
    it("searches and pages facet options on the server instead of draining 6001 values", async () => {
      render(<InventoryFacetSelect selectionId="selected" field="platform" label="Built with" allLabel="All platforms" onChange={vi.fn()} />);
      expect(await screen.findByRole("option", { name: "More options..." })).toBeVisible();
      expect(getInventoryFacets).toHaveBeenCalledTimes(1);
      await userEvent.selectOptions(screen.getByRole("combobox"), "next-options");
      await waitFor(() => expect(getInventoryFacets).toHaveBeenLastCalledWith("selected", "platform", { cursor: "facet-next", search: undefined }, expect.anything()));
      await userEvent.type(screen.getByRole("searchbox", { name: "Search built with options" }), "z");
      await waitFor(() => expect(getInventoryFacets).toHaveBeenLastCalledWith("selected", "platform", { cursor: undefined, search: "z" }, expect.anything()));
    });
    it("searches environment names on the server, preserves an off-page choice and clears only the draft after selection", async () => {
      const onChange = vi.fn(), read = vi.mocked(getInventoryFacets);
      const environmentId = "Default-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", selectedEnvironment = environmentId.toUpperCase();
      read.mockResolvedValue({ value: [{ value: environmentId, label: "Finance production" }], total: 6001, nextCursor: "next" });
      const view = render(<InventoryFacetSelect selectionId="selected" field="environmentId" label="Environment"
        allLabel="All environments" value={selectedEnvironment} onChange={onChange} />);
      expect(await screen.findByRole("option", { name: `Finance production (${environmentId})` })).toBeVisible();
      expect(screen.getByRole("combobox")).toHaveValue(encodeInventoryFacet(environmentId));
      const search = screen.getByRole("searchbox", { name: "Search environments" });
      read.mockResolvedValue({ value: [], total: 0, nextCursor: null });
      await userEvent.type(search, "missing");
      await waitFor(() => expect(screen.queryByRole("option", { name: "More options..." })).not.toBeInTheDocument());
      expect(screen.getByRole("combobox")).toHaveValue(encodeInventoryFacet(selectedEnvironment));
      expect(onChange).not.toHaveBeenCalled();
      view.rerender(<InventoryFacetSelect selectionId="selected" field="environmentId" label="Environment"
        allLabel="All environments" value="retained-environment" onChange={onChange} />);
      expect(screen.getByRole("combobox")).toHaveValue(encodeInventoryFacet("retained-environment"));
      await userEvent.selectOptions(screen.getByRole("combobox"), "");
      expect(onChange).toHaveBeenCalledWith(undefined);
      expect(search).toHaveValue("");
    });
    it("aborts an abandoned facet page and resets its cursor without replacing the focused control", async () => {
      const read = vi.mocked(getInventoryFacets);
      let finish!: (value: Awaited<ReturnType<typeof getInventoryFacets>>) => void;
      const props = { field: "platform" as const, label: "Built with", allLabel: "All platforms", onChange: vi.fn() };
      const view = render(<InventoryFacetSelect {...props} selectionId="first" />);
      await screen.findByRole("option", { name: "More options..." });
      read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      await userEvent.selectOptions(screen.getByRole("combobox"), "next-options");
      const signal = read.mock.calls.at(-1)![3]!.signal!;
      const control = screen.getByRole("combobox");
      control.focus();
      view.rerender(<InventoryFacetSelect {...props} selectionId="second" loading />);
      expect(signal.aborted).toBe(true);
      expect(control).toHaveFocus();
      expect(control).toHaveAttribute("aria-busy", "true");
      await waitFor(() => expect(read).toHaveBeenLastCalledWith("second", "platform", { search: undefined, cursor: undefined }, expect.anything()));
      await act(async () => finish({ value: [{ value: "private-old", label: "Private old option" }], total: 1, nextCursor: null }));
      expect(screen.queryByText("Private old option")).not.toBeInTheDocument();
      view.rerender(<InventoryFacetSelect {...props} selectionId="second" />);
      expect(control).toHaveFocus();
      expect(control).toHaveAttribute("aria-busy", "false");
    });
    it("distinguishes loading, empty, retryable failures and selection invalidation", async () => {
      const read = vi.mocked(getInventoryFacets), invalidated = vi.fn();
      read.mockRejectedValueOnce(new ApiError(503, "read_busy", "Try this read again."))
        .mockResolvedValueOnce({ value: [], total: 0, nextCursor: null });
      const props = { selectionId: "first", field: "environmentId" as const, label: "Environment",
        allLabel: "All environments", onChange: vi.fn(), onInvalidated: invalidated };
      const view = render(<InventoryFacetSelect {...props} />);
      expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "true");
      expect(await screen.findByRole("button", { name: "Retry options" })).toBeVisible();
      expect(invalidated).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Retry options" }));
      await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "false"));
      expect(screen.getAllByRole("option")).toHaveLength(1);
      read.mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Reload saved inventory."));
      view.rerender(<InventoryFacetSelect {...props} selectionId="expired" />);
      await waitFor(() => expect(invalidated).toHaveBeenCalledOnce());
      expect(screen.queryByRole("option", { name: /Finance/ })).not.toBeInTheDocument();
    });
  });
});
