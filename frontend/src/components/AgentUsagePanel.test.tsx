import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import * as api from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { automaticAgentUsageFixture, automaticUsageContext as context, automaticUsagePackageId, automaticUsageReportName } from "../test/automaticAgentUsageFixture";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { AgentUsagePanel } from "./AgentUsagePanel";

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getAgentUsageCandidates: vi.fn(),
  associateAgentUsage: vi.fn(),
  removeAgentUsageAssociation: vi.fn(),
  getOfficialUsageAgentUsers: vi.fn(),
}));

const inventoryRevision = "a".repeat(64);
const reportSetId = context.reportSet!.id;
const association: api.AgentUsageAssociation = {
  reportAgentId: "legacy-reviewed/report:2", reportAgentName: "Reviewed report identity",
  target: { source: "power_platform", nativeId: "native-1", environmentId: "environment-1" },
  basis: "admin_reviewed", reviewedAt: "2026-09-18T10:00:00.000Z",
};
const record: api.UnifiedAgentRecord = {
  id: "agent:11111111-1111-4111-8111-111111111111", displayName: "Excel", presence: "graph_packages",
  environmentId: null, powerPlatformResource: null,
  packages: [{
    id: automaticUsagePackageId, displayName: "Excel", isBlocked: false, sourceSystem: "graph_packages", authoringTool: "Agent Builder",
    creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {},
  }],
  identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
  observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
  usage: { status: "unlinked", reportSetId, responses: null, activeUsers: null, lastActivityDateUtc: null, associations: [] },
};
const automaticRecord = { ...record, usage: automaticAgentUsageFixture() };
const reviewedRecord = { ...record, usage: automaticAgentUsageFixture({ associations: [association] }) };

function renderPanel(overrides: Partial<ComponentProps<typeof AgentUsagePanel>> = {}) {
  const props = { record, context, inventoryRevision, canRemoveReviewedAssociations: true, onChanged: vi.fn(), ...overrides };
  const content = (next: Partial<typeof props> = {}) => <CapabilityContext value={{
    user: { homeAccountId: "admin", username: "admin@example.invalid", displayName: "Admin", roles: ["AgentControl.Admin"] },
    views: [], now: Date.now(), pending: false, loading: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
  }}><WorkbenchActionProvider value={workbenchActions}><AgentUsagePanel {...props} {...next} /></WorkbenchActionProvider></CapabilityContext>;
  const result = render(content());
  return { ...result, props, update: (next: Partial<typeof props>) => result.rerender(content(next)) };
}

function expectNoManualSetup() {
  expect(screen.queryByRole("button", { name: "Associate a usage report" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Usage report candidates" })).not.toBeInTheDocument();
  expect(api.getAgentUsageCandidates).not.toHaveBeenCalled();
  expect(api.associateAgentUsage).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.mocked(api.getAgentUsageCandidates).mockReset();
  vi.mocked(api.associateAgentUsage).mockReset();
  vi.mocked(api.removeAgentUsageAssociation).mockReset().mockResolvedValue({ context });
  vi.mocked(api.getOfficialUsageAgentUsers).mockReset().mockImplementation(() => new Promise(() => {}));
});

describe("AgentUsagePanel", () => {
  it("explains a missing exact saved-inventory match without routine setup or tenant candidate browsing", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "Usage unavailable" })).toBeVisible();
    expect(screen.getByText("This agent is not included in the selected CSV report.")).toBeVisible();
    expect(api.getOfficialUsageAgentUsers).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expectNoManualSetup();
    expect(api.removeAgentUsageAssociation).not.toHaveBeenCalled();
  });

  it("shows report dates and metrics without legal notices, internal identities or the unpaid-user shortcut", () => {
    renderPanel({ record: automaticRecord });
    expect(screen.getByRole("region", { name: "Usage and users for Excel" })).toBeVisible();
    const metrics = within(screen.getByLabelText("Selected agent report metrics"));
    expect(metrics.getByText("181")).toBeVisible();
    expect(metrics.getByText("7")).toBeVisible();
    expect(metrics.queryByText("Report identities")).not.toBeInTheDocument();
    expect(screen.queryByText(automaticUsagePackageId)).not.toBeInTheDocument();
    expect(screen.queryByText(/provider-verified|not lifetime|not a proven|source refresh|matched automatically/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/administrator-reviewed/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove association/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("CSV report dates")).toHaveTextContent("Aug 14, 2026 - Sep 12, 2026");
    expect(screen.queryByText("Report provenance")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View active users without paid Copilot" })).not.toBeInTheDocument();
    expect(api.getOfficialUsageAgentUsers).toHaveBeenCalledWith({
      setId: reportSetId, agentIds: [automaticUsagePackageId], search: "", limit: 25, offset: 0,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expectNoManualSetup();
    expect(api.removeAgentUsageAssociation).not.toHaveBeenCalled();
  });

  it("keeps true zero, unknown counts and unreported activity distinct", () => {
    const { update } = renderPanel({ record: { ...record, usage: automaticAgentUsageFixture({ responses: 0, activeUsers: 0, lastActivityDateUtc: null }) } });
    expect(within(screen.getByLabelText("Selected agent report metrics")).getAllByText("0")).toHaveLength(2);
    expect(screen.getByText("Not reported")).toBeVisible();
    update({ record: { ...record, usage: automaticAgentUsageFixture({ responses: null, activeUsers: null, lastActivityDateUtc: null }) } });
    expect(within(screen.getByLabelText("Selected agent report metrics")).getAllByText("Unknown")).toHaveLength(2);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expectNoManualSetup();
  });

  it("changes selected-snapshot totals and per-report names without summing overlapping reports", () => {
    const { update } = renderPanel({ record: automaticRecord });
    const olderId = "33333333-3333-4333-8333-333333333333";
    update({
      context: { ...context, availability: "stale", reportSet: { ...context.reportSet!, id: olderId } },
      record: { ...record, usage: automaticAgentUsageFixture({
        reportSetId: olderId, responses: 179,
        associations: [{ ...automaticRecord.usage.associations[0], reportAgentName: "Excel" }],
      }) },
    });
    expect(within(screen.getByLabelText("Selected agent report metrics")).getByText("179")).toBeVisible();
    expect(screen.queryByText("181")).not.toBeInTheDocument();
    expect(screen.queryByText("360")).not.toBeInTheDocument();
    expect(screen.queryByText(automaticUsageReportName)).not.toBeInTheDocument();
    expect(screen.getByText("Out-of-date report")).toBeVisible();
    expect(api.getOfficialUsageAgentUsers).toHaveBeenLastCalledWith(expect.objectContaining({ setId: olderId }), expect.anything());
    expectNoManualSetup();
  });

  it.each(["never_imported", "not_selected", "incomplete", "deleted"] as const)("hides old metrics when report availability is %s", availability => {
    renderPanel({ record: automaticRecord, context: { ...context, availability } });
    expect(screen.getByText("Select a complete CSV report in Sync to see usage.")).toBeVisible();
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View active users without paid Copilot" })).not.toBeInTheDocument();
    expectNoManualSetup();
  });

  it("distinguishes missing context, incomplete reports, unavailable projection and a mismatched snapshot", () => {
    const { update } = renderPanel({ record: automaticRecord, context: undefined });
    expect(screen.getByText("Report data is unavailable. Reload usage to try again.")).toBeVisible();
    update({ context: { ...context, reportSet: { ...context.reportSet!, complete: false } } });
    expect(screen.getByText("Select a complete CSV report in Sync to see usage.")).toBeVisible();
    update({ record: { ...record, usage: { ...record.usage!, status: "unavailable", reportSetId: null } }, context });
    expect(screen.getByText("Usage could not be loaded for this agent. Reload usage to try again.")).toBeVisible();
    update({ record: automaticRecord, context: { ...context, reportSet: { ...context.reportSet!, id: "different-report" } } });
    expect(screen.getByText("The selected report changed. Reload usage to update this agent.")).toBeVisible();
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View active users without paid Copilot" })).not.toBeInTheDocument();
    expectNoManualSetup();
  });

  it("keeps reviewed links collapsed and permits removal only for reviewed identities", async () => {
    renderPanel({ record: { ...record, usage: automaticAgentUsageFixture({ associations: [...automaticRecord.usage.associations, association] }) } });
    const details = screen.getByText("Reviewed report links");
    expect(details.closest("details")).not.toHaveAttribute("open");
    await userEvent.click(details);
    expect(screen.getByText(/Reviewed Sep/)).toBeVisible();
    expect(screen.getByText(/Power Platform: native-1 - Environment: environment-1/)).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Remove association/ })).toHaveLength(1);
    expect(api.getOfficialUsageAgentUsers).toHaveBeenCalledWith(expect.objectContaining({
      agentIds: [automaticUsagePackageId, association.reportAgentId], setId: reportSetId,
    }), expect.anything());
    expectNoManualSetup();
  });

  it("confirms legacy removals with the same report and inventory fences", async () => {
    const { props } = renderPanel({ record: reviewedRecord });
    await userEvent.click(screen.getByText("Reviewed report links"));
    await userEvent.click(screen.getByRole("button", { name: /Remove association/ }));
    expect(screen.getByRole("button", { name: "Confirm removal" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Remove reviewed association" })).toHaveFocus();
    expect(screen.getByText(/exact saved-package ID match may still apply automatically/)).toBeVisible();
    await userEvent.click(screen.getByRole("checkbox", { name: /I confirm this reporting association/ }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(api.removeAgentUsageAssociation).toHaveBeenCalledExactlyOnceWith(record.id, {
      reportSetId, reportAgentId: association.reportAgentId, expectedInventoryRevision: inventoryRevision,
      expectedUsageRevision: context.revision, confirmed: true,
    });
    expect(screen.queryByRole("region", { name: "Confirm reviewed association removal" })).not.toBeInTheDocument();
    expectNoManualSetup();
  });

  it("restores the removal trigger on cancellation and performs no write", async () => {
    renderPanel({ record: reviewedRecord });
    await userEvent.click(screen.getByText("Reviewed report links"));
    const trigger = screen.getByRole("button", { name: /Remove association/ });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "Cancel association change" }));
    expect(trigger).toHaveFocus();
    expect(api.removeAgentUsageAssociation).not.toHaveBeenCalled();
  });

  it("does not offer reviewed removal without permission, revision or usable report context", () => {
    const { update } = renderPanel({ record: reviewedRecord, canRemoveReviewedAssociations: false });
    expect(screen.queryByRole("button", { name: /Remove association/ })).not.toBeInTheDocument();
    update({ canRemoveReviewedAssociations: true, inventoryRevision: undefined });
    expect(screen.queryByRole("button", { name: /Remove association/ })).not.toBeInTheDocument();
    update({ canRemoveReviewedAssociations: true, context: { ...context, availability: "deleted", reportSet: null } });
    expect(screen.queryByRole("button", { name: /Remove association/ })).not.toBeInTheDocument();
    expectNoManualSetup();
  });

  it("invalidates removal confirmation when the selected report revision changes", async () => {
    const { update } = renderPanel({ record: reviewedRecord });
    await userEvent.click(screen.getByText("Reviewed report links"));
    await userEvent.click(screen.getByRole("button", { name: /Remove association/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /I confirm this reporting association/ }));
    update({ context: { ...context, revision: "changed" } });
    expect(screen.queryByRole("button", { name: "Confirm removal" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Remove association/ }));
    expect(screen.getByRole("button", { name: "Confirm removal" })).toBeDisabled();
    expect(api.removeAgentUsageAssociation).not.toHaveBeenCalled();
  });

  it("surfaces removal conflicts with explicit reload and no successful update", async () => {
    vi.mocked(api.removeAgentUsageAssociation).mockRejectedValue(new api.ApiError(409, "inventory_revision_changed", "The saved inventory changed."));
    const { props } = renderPanel({ record: reviewedRecord });
    await userEvent.click(screen.getByText("Reviewed report links"));
    await userEvent.click(screen.getByRole("button", { name: /Remove association/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /I confirm this reporting association/ }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The saved inventory changed.");
    expect(props.onChanged).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Reload saved usage" }));
    expect(props.onChanged).toHaveBeenCalledOnce();
    expect(api.removeAgentUsageAssociation).toHaveBeenCalledTimes(1);
    expectNoManualSetup();
  });

  it("shows searchable paginated names, emails and this agent's responses", async () => {
    const users = Array.from({ length: 30 }, (_, index) => ({
      username: `person${index}@example.invalid`, displayName: `Person ${index}`, responsesSentToUsers: 50 - index,
    }));
    vi.mocked(api.getOfficialUsageAgentUsers).mockImplementation(async query => {
      const filtered = users.filter(user => !query.search || user.username.includes(query.search));
      return { activeSet: context.reportSet, agentIds: query.agentIds,
        users: { value: filtered.slice(query.offset, (query.offset ?? 0) + 25), count: filtered.length, offset: query.offset ?? 0, limit: 25 } };
    });
    renderPanel({ record: automaticRecord });
    expect(await screen.findByText("person0@example.invalid")).toBeVisible();
    expect(screen.getByText("Person 0")).toBeVisible();
    expect(screen.getByRole("cell", { name: "50" })).toBeVisible();
    expect(screen.getByText("1-25 of 30 users")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Next users" }));
    expect(await screen.findByText("26-30 of 30 users")).toBeVisible();
    expect(screen.queryByText("person0@example.invalid")).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search agent users" }), "person0@");
    expect(await screen.findByText("1-1 of 1 users")).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous users" })).toBeDisabled();
  });

  it("cancels old reads on report change and never replaces new users with stale results", async () => {
    let finish!: (result: api.OfficialUsageAgentUsersView) => void;
    vi.mocked(api.getOfficialUsageAgentUsers).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { update } = renderPanel({ record: automaticRecord });
    const signal = vi.mocked(api.getOfficialUsageAgentUsers).mock.calls[0][1]!.signal!;
    vi.mocked(api.getOfficialUsageAgentUsers).mockResolvedValue({
      activeSet: context.reportSet, agentIds: [automaticUsagePackageId], users: { value: [], count: 0, offset: 0, limit: 25 },
    });
    update({ context: { ...context, revision: "new-revision" } });
    expect(await screen.findByText("No users listed in this report.")).toBeVisible();
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ activeSet: context.reportSet, agentIds: [automaticUsagePackageId],
      users: { count: 1, offset: 0, limit: 25, value: [{ displayName: "Old user", username: "old@example.invalid", responsesSentToUsers: 1 }] } }));
    expect(screen.queryByText("old@example.invalid")).not.toBeInTheDocument();
  });

  it("shows errors with retry and rejects responses from a different report", async () => {
    vi.mocked(api.getOfficialUsageAgentUsers).mockResolvedValue({
      activeSet: { ...context.reportSet!, id: "wrong-report" }, agentIds: [automaticUsagePackageId],
      users: { value: [], count: 0, limit: 25, offset: 0 },
    });
    renderPanel({ record: automaticRecord });
    expect(await screen.findByRole("alert")).toHaveTextContent("The report changed.");
    vi.mocked(api.getOfficialUsageAgentUsers).mockRejectedValue(new Error("User report unavailable."));
    await userEvent.click(screen.getByRole("button", { name: "Retry users" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("User report unavailable.");
    expect(screen.queryByText("No users listed in this report.")).not.toBeInTheDocument();
  });

  it("keeps concealed usernames visible without guessing a name or email address", async () => {
    vi.mocked(api.getOfficialUsageAgentUsers).mockResolvedValue({
      activeSet: context.reportSet, agentIds: [automaticUsagePackageId],
      users: { value: [{ displayName: "concealed-user", username: "concealed-user", responsesSentToUsers: 4 }], count: 1, limit: 25, offset: 0 },
    });
    renderPanel({ record: automaticRecord });
    expect(await screen.findByRole("rowheader", { name: "concealed-user" })).toBeVisible();
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });
});
