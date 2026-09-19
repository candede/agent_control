import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import * as api from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { usageInsightsPublished } from "../test/usageInsightsFixture";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { AgentUsagePanel } from "./AgentUsagePanel";

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getAgentUsageCandidates: vi.fn(),
  associateAgentUsage: vi.fn(),
  removeAgentUsageAssociation: vi.fn(),
}));

const context: api.AgentUsageContext = {
  availability: "active", revision: "b".repeat(64), lineages: [], reportSet: usageInsightsPublished.activeSet,
};
const inventoryRevision = "a".repeat(64);
const reportSetId = usageInsightsPublished.activeSet!.id;
const candidate = { ...usageInsightsPublished.reports.agents!.rows[0], associated: false };
const candidatePage: api.AgentUsageCandidatePage = { context, value: [candidate], count: 1, limit: 20, offset: 0 };
const target: api.AgentUsageTarget = { source: "graph_packages", packageId: "package/A" };
const association: api.AgentUsageAssociation = {
  reportAgentId: candidate.agentId, reportAgentName: candidate.agentName, target,
  basis: "admin_reviewed", reviewedAt: "2026-09-18T10:00:00.000Z",
};
const record: api.UnifiedAgentRecord = {
  id: "agent:11111111-1111-4111-8111-111111111111", displayName: "Inventory agent", presence: "graph_packages",
  environmentId: null, powerPlatformResource: null,
  packages: [{
    id: "package/A", displayName: "Inventory agent", isBlocked: false, sourceSystem: "graph_packages", authoringTool: "Agent Builder",
    creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {},
  }],
  identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
  observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
  usage: { status: "unlinked", reportSetId, responses: null, activeUsers: null, lastActivityDateUtc: null, associations: [] },
};

function renderPanel(overrides: Partial<ComponentProps<typeof AgentUsagePanel>> = {}) {
  const props = { record, context, inventoryRevision, canManage: true, onChanged: vi.fn(), ...overrides };
  const content = (next: Partial<typeof props> = {}) => <CapabilityContext value={{
    user: { homeAccountId: "admin", username: "admin@example.invalid", displayName: "Admin", roles: ["AgentControl.Admin"] },
    views: [], now: Date.now(), pending: false, loading: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
  }}><WorkbenchActionProvider value={workbenchActions}><AgentUsagePanel {...props} {...next} /></WorkbenchActionProvider></CapabilityContext>;
  const result = render(content());
  return { ...result, props, update: (next: Partial<typeof props>) => result.rerender(content(next)) };
}

beforeEach(() => {
  vi.mocked(api.getAgentUsageCandidates).mockReset().mockResolvedValue(candidatePage);
  vi.mocked(api.associateAgentUsage).mockReset().mockResolvedValue({ context });
  vi.mocked(api.removeAgentUsageAssociation).mockReset().mockResolvedValue({ context });
});

describe("AgentUsagePanel", () => {
  it("does not browse tenant report identities just by opening an unlinked agent", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "No verified usage data for this agent" })).toBeVisible();
    expect(screen.getByText(/Missing usage data does not mean zero usage/)).toBeVisible();
    expect(screen.queryByText(candidate.agentName)).not.toBeInTheDocument();
    expect(api.getAgentUsageCandidates).not.toHaveBeenCalled();
    expect(api.associateAgentUsage).not.toHaveBeenCalled();
  });

  it("shows reviewed zero values, reporting provenance and report-set-pinned user navigation", () => {
    renderPanel({ record: {
      ...record, usage: { status: "linked", reportSetId, responses: 0, activeUsers: 0, lastActivityDateUtc: null, associations: [association] },
    } });
    expect(within(screen.getByLabelText("Selected agent report metrics")).getAllByText("0")).toHaveLength(2);
    expect(screen.getByText(/Administrator-reviewed usage, not a provider-verified/)).toBeVisible();
    expect(screen.getByText(/Admin-supplied period: 2026-08-14 to 2026-09-12/)).toBeVisible();
    const link = screen.getByRole("link", { name: "View reported users" });
    const url = new URL(link.getAttribute("href")!, "http://localhost");
    expect(url.searchParams.get("agent")).toBe(candidate.agentId);
    expect(url.searchParams.get("snapshot")).toBe(reportSetId);
    expect(api.getAgentUsageCandidates).not.toHaveBeenCalled();
  });

  it("requires review and explicit confirmation of an exact source target before association", async () => {
    const { props } = renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Associate a usage report" }));
    expect(api.getAgentUsageCandidates).toHaveBeenCalledWith(record.id, { search: "", limit: 20, offset: 0 }, { signal: expect.any(AbortSignal) });
    await userEvent.click(await screen.findByRole("button", { name: `Review association for ${candidate.agentName} (${candidate.agentId})` }));
    const confirm = screen.getByRole("button", { name: "Confirm association" });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Exact inventory target" })).toHaveValue(JSON.stringify(target));
    await userEvent.click(screen.getByRole("checkbox", { name: /I reviewed the report identity/ }));
    await userEvent.click(confirm);
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(api.associateAgentUsage).toHaveBeenCalledWith(record.id, {
      reportSetId, reportAgentId: candidate.agentId, target, expectedInventoryRevision: inventoryRevision,
      expectedUsageRevision: context.revision, confirmed: true,
    });
    expect(screen.queryByRole("region", { name: "Confirm usage association" })).not.toBeInTheDocument();
  });

  it("does not guess among published versions and clears confirmation when the exact target changes", async () => {
    renderPanel({ record: { ...record, packages: [...record.packages, { ...record.packages[0], id: "package/B" }] } });
    await userEvent.click(screen.getByRole("button", { name: "Associate a usage report" }));
    await userEvent.click(await screen.findByRole("button", { name: /Review association for Researcher/ }));
    const targetSelect = screen.getByRole("combobox", { name: "Exact inventory target" });
    const confirmation = screen.getByRole("checkbox", { name: /I reviewed/ });
    expect(targetSelect).toHaveValue("");
    await userEvent.click(confirmation);
    expect(screen.getByRole("button", { name: "Confirm association" })).toBeDisabled();
    await userEvent.selectOptions(targetSelect, JSON.stringify(target));
    expect(confirmation).not.toBeChecked();
    expect(api.associateAgentUsage).not.toHaveBeenCalled();
  });

  it("confirms removals with the same report and inventory fences", async () => {
    const { props } = renderPanel({ record: {
      ...record, usage: { status: "linked", reportSetId, responses: 215, activeUsers: 2, lastActivityDateUtc: null, associations: [association] },
    } });
    await userEvent.click(screen.getByRole("button", { name: /Remove association for Researcher/ }));
    expect(screen.getByRole("button", { name: "Confirm removal" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /I confirm this reporting association/ }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(api.removeAgentUsageAssociation).toHaveBeenCalledWith(record.id, {
      reportSetId, reportAgentId: candidate.agentId, expectedInventoryRevision: inventoryRevision,
      expectedUsageRevision: context.revision, confirmed: true,
    });
  });

  it("keeps candidate search bounded and prevents reassignment of an existing association", async () => {
    vi.mocked(api.getAgentUsageCandidates).mockResolvedValue({ ...candidatePage, value: [{ ...candidate, associated: true }], count: 45 });
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Associate a usage report" }));
    expect(await screen.findByRole("button", { name: /Review association for Researcher/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next reports" }));
    expect(api.getAgentUsageCandidates).toHaveBeenLastCalledWith(record.id, { search: "", limit: 20, offset: 20 }, expect.anything());
    await userEvent.type(screen.getByRole("searchbox", { name: "Search report agents" }), "Exact / report");
    await userEvent.click(screen.getByRole("button", { name: "Search reports" }));
    expect(api.getAgentUsageCandidates).toHaveBeenLastCalledWith(record.id, { search: "Exact / report", limit: 20, offset: 0 }, expect.anything());
    expect(api.associateAgentUsage).not.toHaveBeenCalled();
  });

  it("reopens candidates with the displayed search instead of silently reverting to all reports", async () => {
    renderPanel();
    const browse = screen.getByRole("button", { name: "Associate a usage report" });
    await userEvent.click(browse);
    const search = screen.getByRole("searchbox", { name: "Search report agents" });
    expect(search).toHaveFocus();
    await userEvent.type(search, "Researcher");
    await userEvent.click(screen.getByRole("button", { name: "Search reports" }));
    await screen.findByRole("button", { name: /Review association for Researcher/ });
    await userEvent.click(screen.getByRole("button", { name: "Close report search" }));
    expect(browse).toHaveFocus();
    await userEvent.click(browse);
    expect(screen.getByRole("searchbox", { name: "Search report agents" })).toHaveValue("Researcher");
    await waitFor(() => expect(api.getAgentUsageCandidates).toHaveBeenLastCalledWith(record.id,
      { search: "Researcher", limit: 20, offset: 0 }, expect.anything()));
  });

  it("focuses explicit association review and restores its exact trigger when cancelled", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Associate a usage report" }));
    const candidateButton = await screen.findByRole("button", { name: /Review association for Researcher/ });
    await userEvent.click(candidateButton);
    expect(screen.getByRole("heading", { name: "Confirm reporting association" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Cancel association change" }));
    expect(candidateButton).toHaveFocus();
    expect(api.associateAgentUsage).not.toHaveBeenCalled();
  });

  it("aborts a closed candidate read and restores focus after the browse action is enabled", async () => {
    let finish!: (value: api.AgentUsageCandidatePage) => void;
    vi.mocked(api.getAgentUsageCandidates).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    renderPanel();
    const browse = screen.getByRole("button", { name: "Associate a usage report" });
    await userEvent.click(browse);
    const signal = vi.mocked(api.getAgentUsageCandidates).mock.calls[0][2]?.signal;
    expect(browse).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Close report search" }));
    expect(signal?.aborted).toBe(true);
    expect(browse).toHaveFocus();
    await act(async () => finish(candidatePage));
    expect(screen.queryByRole("region", { name: "Usage report candidates" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Review association for Researcher/ })).not.toBeInTheDocument();
  });

  it("reports an empty candidate page without inventing an inverted range", async () => {
    vi.mocked(api.getAgentUsageCandidates).mockResolvedValueOnce({ ...candidatePage, count: 25 })
      .mockResolvedValueOnce({ ...candidatePage, count: 1, value: [], offset: 20 });
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Associate a usage report" }));
    await userEvent.click(await screen.findByRole("button", { name: "Next reports" }));
    expect(await screen.findByText("No report identities on this page (1 matching)")).toBeVisible();
    expect(screen.queryByText("21-20 of 1")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Search reports" }));
    expect(await screen.findByRole("button", { name: /Review association for Researcher/ })).toBeVisible();
    expect(api.getAgentUsageCandidates).toHaveBeenLastCalledWith(record.id, { search: "", limit: 20, offset: 0 }, expect.anything());
  });

  it("does not offer associations for viewers, missing revisions or an unavailable report", () => {
    const { update } = renderPanel({ canManage: false });
    expect(screen.queryByRole("button", { name: "Associate a usage report" })).not.toBeInTheDocument();
    update({ canManage: true, inventoryRevision: undefined });
    expect(screen.queryByRole("button", { name: "Associate a usage report" })).not.toBeInTheDocument();
    update({ canManage: true, context: { ...context, availability: "deleted", reportSet: null } });
    expect(screen.queryByRole("button", { name: "Associate a usage report" })).not.toBeInTheDocument();
    expect(api.getAgentUsageCandidates).not.toHaveBeenCalled();
  });

  it("rejects candidates from a changed report revision and offers an explicit saved-data reload", async () => {
    vi.mocked(api.getAgentUsageCandidates).mockResolvedValue({ ...candidatePage, context: { ...context, revision: "changed" } });
    const { props } = renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Associate a usage report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("selected report or its associations changed");
    expect(screen.queryByRole("button", { name: /Review association for Researcher/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reload saved usage" }));
    expect(props.onChanged).toHaveBeenCalledOnce();
  });

  it("surfaces save conflicts without reporting a successful update", async () => {
    vi.mocked(api.associateAgentUsage).mockRejectedValue(new api.ApiError(409, "inventory_revision_changed", "The saved inventory changed."));
    const { props } = renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Associate a usage report" }));
    await userEvent.click(await screen.findByRole("button", { name: /Review association for Researcher/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm association" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The saved inventory changed.");
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(api.associateAgentUsage).toHaveBeenCalledTimes(1);
  });

  it("cancels candidate reads when the owning panel closes", async () => {
    let resolve!: (value: api.AgentUsageCandidatePage) => void;
    vi.mocked(api.getAgentUsageCandidates).mockReturnValue(new Promise(done => { resolve = done; }));
    const mounted = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Associate a usage report" }));
    const signal = vi.mocked(api.getAgentUsageCandidates).mock.calls[0][2]?.signal;
    mounted.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve(candidatePage));
    expect(api.associateAgentUsage).not.toHaveBeenCalled();
  });
});
