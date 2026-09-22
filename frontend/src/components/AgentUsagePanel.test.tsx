import { render, screen, waitFor, within } from "@testing-library/react";
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
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  expect(api.getAgentUsageCandidates).not.toHaveBeenCalled();
  expect(api.associateAgentUsage).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.mocked(api.getAgentUsageCandidates).mockReset();
  vi.mocked(api.associateAgentUsage).mockReset();
  vi.mocked(api.removeAgentUsageAssociation).mockReset().mockResolvedValue({ context });
});

describe("AgentUsagePanel", () => {
  it("explains a missing exact saved-inventory match without routine setup or tenant candidate browsing", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "No matched usage data for this agent" })).toBeVisible();
    expect(screen.getByText(/No report Agent ID in this selected snapshot matches a full, case-sensitive package ID/)).toBeVisible();
    expect(screen.getByText(/Missing usage data does not mean zero usage/)).toBeVisible();
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expectNoManualSetup();
    expect(api.removeAgentUsageAssociation).not.toHaveBeenCalled();
  });

  it("shows automatic metrics and exact-ID provenance when the report and inventory names differ", () => {
    renderPanel({ record: automaticRecord });
    expect(screen.getByRole("region", { name: "Usage and users for Excel" })).toBeVisible();
    expect(screen.getByText(automaticUsageReportName)).toBeVisible();
    const metrics = within(screen.getByLabelText("Selected agent report metrics"));
    expect(metrics.getByText("181")).toBeVisible();
    expect(metrics.getByText("7")).toBeVisible();
    expect(metrics.getByText("1")).toBeVisible();
    expect(screen.getByText("Automatically matched: exact report Agent ID = saved Graph package ID.")).toBeVisible();
    expect(screen.getByText(/including prefix and case/)).toBeVisible();
    expect(screen.getByText(automaticUsagePackageId)).toBeVisible();
    expect(screen.getByText(/Reporting matches are not provider-verified identity links/)).toBeVisible();
    expect(screen.queryByText(/administrator-reviewed/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove association/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Admin-supplied period: 2026-08-14 to 2026-09-12/)).toBeVisible();
    expect(screen.getByText(/Selected report snapshot:/)).toHaveTextContent(reportSetId);
    expect(screen.getByText("Report provenance")).toBeVisible();
    const url = new URL(screen.getByRole("link", { name: "View active users without paid Copilot" }).getAttribute("href")!, "http://localhost");
    expect(url.searchParams.get("view")).toBe("activity");
    expect(url.searchParams.get("agent")).toBe(automaticUsagePackageId);
    expect(url.searchParams.get("snapshot")).toBe(reportSetId);
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
    expect(new URL(screen.getByRole("link", { name: "View active users without paid Copilot" }).getAttribute("href")!, "http://localhost").searchParams.get("snapshot")).toBe(olderId);
    expectNoManualSetup();
  });

  it.each(["never_imported", "not_selected", "incomplete", "deleted"] as const)("hides old metrics when report availability is %s", availability => {
    renderPanel({ record: automaticRecord, context: { ...context, availability } });
    expect(screen.getByText(/No complete usable usage report is selected/)).toBeVisible();
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View active users without paid Copilot" })).not.toBeInTheDocument();
    expectNoManualSetup();
  });

  it("distinguishes missing context, incomplete reports, unavailable projection and a mismatched snapshot", () => {
    const { update } = renderPanel({ record: automaticRecord, context: undefined });
    expect(screen.getByText(/selected report context is unavailable/)).toBeVisible();
    update({ context: { ...context, reportSet: { ...context.reportSet!, complete: false } } });
    expect(screen.getByText(/No complete usable usage report is selected/)).toBeVisible();
    update({ record: { ...record, usage: { ...record.usage!, status: "unavailable", reportSetId: null } }, context });
    expect(screen.getByText(/usage projection is unavailable/)).toBeVisible();
    update({ record: automaticRecord, context: { ...context, reportSet: { ...context.reportSet!, id: "different-report" } } });
    expect(screen.getByText(/saved usage belongs to a different report snapshot/)).toBeVisible();
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View active users without paid Copilot" })).not.toBeInTheDocument();
    expectNoManualSetup();
  });

  it("displays legacy reviewed provenance separately and permits removal only for that identity", () => {
    renderPanel({ record: { ...record, usage: automaticAgentUsageFixture({ associations: [...automaticRecord.usage.associations, association] }) } });
    expect(screen.getByText(/Existing administrator-reviewed association, reviewed on/)).toBeVisible();
    expect(screen.getByText(/Power Platform: native-1 - Environment: environment-1/)).toBeVisible();
    expect(screen.getByText(/Automatically matched:/)).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Remove association/ })).toHaveLength(1);
    const links = screen.getAllByRole("link", { name: "View active users without paid Copilot" }).map(link => new URL(link.getAttribute("href")!, "http://localhost"));
    expect(links.map(url => url.searchParams.get("agent"))).toEqual([automaticUsagePackageId, association.reportAgentId]);
    expect(links.every(url => url.searchParams.get("snapshot") === reportSetId)).toBe(true);
    expectNoManualSetup();
  });

  it("confirms legacy removals with the same report and inventory fences", async () => {
    const { props } = renderPanel({ record: reviewedRecord });
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
});
