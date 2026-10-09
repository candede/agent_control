import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportAgent, ReportMetadata, ReportPage } from "../../../backend/src/types/officialReportData";
import * as api from "../api/reportData";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { deferred } from "../test/deferred";
import { reportAgent, reportPage, reports, reportSetId } from "../test/reportDataFixture";
import { createSavedQueryClient } from "../savedQueries";
import { ReportingView } from "./ReportingView";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { UsageReportContext } from "./UsageReportContext";

vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(), readReportPage: vi.fn(), readReportFacet: vi.fn(),
}));
const capability: ReturnType<typeof useCapabilityContext> = {
  user: { tenantId: "tenant", homeAccountId: "first", username: "viewer@example.invalid", displayName: "Viewer", roles: ["AgentControl.Viewer"] },
  now: Date.now(), views: [], loading: false, pending: false, error: undefined, reload: vi.fn(async () => {}), openPermissions: vi.fn(),
};
function evidence(metadata: ReportMetadata = reports) {
  return reportPage([reportAgent()], { reports: metadata });
}
beforeEach(() => {
  vi.mocked(api.readReportPage).mockResolvedValue(evidence());
  vi.mocked(api.readReportFacet).mockResolvedValue({
    value: [], counts: { total: 0, filtered: 0 }, page: { limit: 50, nextCursor: null, previousCursor: null },
    selection: evidence().selection,
  });
});
afterEach(() => { vi.resetAllMocks(); });

describe("report provenance presentation", () => {
  it.each([
    ["activity_range", "Observed activity range"],
    ["operator_asserted", "Admin-supplied period"],
    ["source_metadata", "Reporting period"],
  ] as const)("qualifies %s dates before opening the source disclosure", (provenance, label) => {
    render(<UsageReportContext reports={{ ...reports, reportingPeriod: { ...reports.reportingPeriod!, provenance } }} />);
    expect(screen.getByText(`${label}: ${reports.reportingPeriod!.startDate} to ${reports.reportingPeriod!.endDate}`)).toBeVisible();
    if (provenance !== "source_metadata") expect(screen.queryByText(/^Reporting period:/)).not.toBeInTheDocument();
    if (provenance === "activity_range") expect(screen.getByText(/Observed dates are last-activity dates/)).toBeVisible();
    expect(api.readReportPage).not.toHaveBeenCalled();
  });
  it.each(["absent", "operator_asserted"] as const)("keeps %s source freshness unknown outside collapsed technical details", sourceAsOfProvenance => {
    render(<UsageReportContext reports={{ ...reports, lineages: reports.lineages.map((lineage, index) => index ? lineage : {
      ...lineage, sourceFreshness: "unknown", sourceAsOfProvenance,
      sourceAsOf: sourceAsOfProvenance === "absent" ? null : reports.acceptedAt,
    }) }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Source freshness is unknown for one or more reports.");
    expect(screen.getByRole("status")).toBeVisible();
    expect(screen.getByText("Selected report")).toBeVisible();
    expect(screen.getByText("Report sources").closest("details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Report sources"));
    const context = screen.getByRole("region", { name: "Report provenance" });
    expect(context).toHaveTextContent("source freshness unknown");
    expect(context).toHaveTextContent(sourceAsOfProvenance);
    expect(context).toHaveTextContent("Import time does not establish source freshness");
    expect(api.readReportPage).not.toHaveBeenCalled();
  });
  it("keeps stale and unknown evidence separate, then replaces both from current props without requests", () => {
    const view = render(<UsageReportContext inlineSources reports={{ ...reports, availability: "stale",
      lineages: reports.lineages.map(lineage => ({ ...lineage, sourceFreshness: "unknown" })) }} />);
    expect(screen.getByText(/Reports are out of date/)).toBeVisible();
    expect(screen.getByText(/Source freshness is unknown/)).toBeVisible();
    const replacement = { ...reports, historyRevision: "36", setId: "next-set",
      lineages: reports.lineages.map(lineage => ({ ...lineage, versionId: `new-${lineage.kind}`, rowCount: 0 })) };
    view.rerender(<UsageReportContext inlineSources reports={replacement} />);
    const context = screen.getByRole("region", { name: "Report provenance" });
    expect(context).not.toHaveTextContent(/Reports are out of date|Source freshness is unknown/);
    expect(context).toHaveTextContent("History revision 36");
    expect(context).toHaveTextContent("next-set");
    expect(context).not.toHaveTextContent(reportSetId);
    for (const lineage of reports.lineages) expect(context).not.toHaveTextContent(lineage.versionId);
    expect(within(context).getAllByRole("definition")).toHaveLength(3);
    expect(within(context).getAllByRole("definition")[0]).toHaveTextContent("0 rows");
    expect(api.readReportPage).not.toHaveBeenCalled();
  });
  it.each(["never_imported", "incomplete", "not_selected", "deleted"] as const)(
    "does not invent dates or source freshness when reports are %s", availability => {
      render(<UsageReportContext reports={{ ...reports, availability, setId: null, activeSetId: null,
        reportingPeriod: null, acceptedAt: null, lineages: [] }} />);
      expect(screen.getByText("Reporting period not supplied")).toBeVisible();
      expect(screen.queryByText(/Source freshness is unknown/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Reports are out of date/)).not.toBeInTheDocument();
      expect(screen.queryAllByRole("definition")).toHaveLength(0);
    },
  );
});

describe("report provenance request ownership", () => {
  it.each(["account", "report", "revision"] as const)("withdraws %s provenance and rejects abandoned responses without duplicate reads", async boundary => {
    const pending = deferred<ReportPage<ReportAgent>>(), replacement = deferred<ReportPage<ReportAgent>>();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(evidence()).mockReturnValueOnce(pending.promise).mockReturnValueOnce(replacement.promise);
    const client = createSavedQueryClient();
    const nextSetId = "10000000-0000-4000-8000-000000000009";
    const panel = (changed = false) => <SavedQueryProvider client={client}><CapabilityContext value={{
      ...capability, user: { ...capability.user!, homeAccountId: changed && boundary === "account" ? "second" : "first" },
    }}><ReportingView setId={changed && boundary === "report" ? nextSetId : reportSetId}
      revision={changed && boundary === "revision" ? 1 : 0} /></CapabilityContext></SavedQueryProvider>;
    const view = render(panel());
    await screen.findByRole("region", { name: "Report provenance" });
    // Explicit invalidation revalidates the same selection without replacing its owner.
    act(() => { void client.invalidateQueries({ queryKey: ["saved", "record-page"] }); });
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    view.rerender(panel(true));
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("region", { name: "Report provenance" }) !== null).toBe(boundary === "revision");
    if (boundary !== "revision") expect(screen.getByText("Loading saved data...")).toBeVisible();
    view.rerender(panel(true));
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    await act(async () => pending.resolve(evidence({ ...reports, historyRevision: "obsolete-revision" })));
    expect(screen.queryByText(/obsolete-revision/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Report provenance" }) !== null).toBe(boundary === "revision");
    await act(async () => replacement.resolve(evidence({ ...reports, setId: boundary === "report" ? nextSetId : reportSetId,
      historyRevision: "current-revision" })));
    fireEvent.click(await screen.findByText("Report sources"));
    expect(screen.getByRole("region", { name: "Report provenance" })).toHaveTextContent("current-revision");
    expect(screen.queryByText("Loading saved data...")).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    view.unmount();
    client.clear();
  });
});
