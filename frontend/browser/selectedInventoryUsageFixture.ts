import { expect, type Page } from "@playwright/test";
import type { CandidateAgentUsageAssociations, CandidateAgentUsageCandidates, CandidateAgentUsageContext, CandidateAgentUsageSummary, OfficialReportDetail } from "../../backend/src/types/officialReportApi";
import type { ReportAgent, ReportRelationship } from "../../backend/src/types/officialReportData";
import type { UnifiedAgentInventoryPage } from "../../backend/src/types/unifiedAgents";
import { reportAgent, reportPage, selectionId } from "../src/test/reportDataFixture";
import { selectedFixtureWindow } from "../src/test/selectedUsageFixture";

export async function mockSelectedInventoryUsage(page: Page, inventory: () => UnifiedAgentInventoryPage,
  relationships: () => ReportRelationship[], callbacks: { users?: (query: URLSearchParams) => void; candidates?: () => void } = {}) {
  function context(): CandidateAgentUsageContext {
    const data = inventory(), reports = data.usageContext!.reports;
    if (!data.selection.revision) throw new Error("Selected inventory fixture requires its captured revision");
    return { selectionId, reportSetId: reports.setId, reports, usageRevision: data.usageContext!.revision, inventoryRevision: data.selection.revision };
  }
  await page.route(url => /^\/api\/agent-inventory\/[^/]+\/usage(?:-associations|-candidates)?$/.test(url.pathname), route => {
    expect(route.request().method()).toBe("GET");
    const url = new URL(route.request().url()), recordId = decodeURIComponent(url.pathname.split("/")[3]);
    const record = inventory().value.find(value => value.id === recordId);
    expect(record, "Exact inventory evidence must exist").toBeDefined();
    const selected = context(), usage = record!.usage;
    if (!selected.reportSetId || usage?.reportSetId !== selected.reportSetId) {
      return route.fulfill({ status: 409, json: { code: "selection_invalidated", detail: !selected.reportSetId
        ? "Select a complete report in Sync to see usage." : "The selected report changed. Restart usage selection." } });
    }
    const pageInfo = { limit: 50, nextCursor: null, previousCursor: null };
    if (url.pathname.endsWith("/usage")) {
      const body: CandidateAgentUsageSummary = { recordId, status: usage.status, responses: usage.responses,
        activeUsers: usage.activeUsers, lastActivityDateUtc: usage.lastActivityDateUtc,
        associationCount: usage.associationCount, context: selected };
      return route.fulfill({ json: body });
    }
    if (url.pathname.endsWith("/usage-candidates")) {
      callbacks.candidates?.();
      const body: CandidateAgentUsageCandidates = { value: [], context: selected, selection: reportPage([]).selection,
        page: pageInfo, counts: { total: 0, filtered: 0 } };
      return route.fulfill({ json: body });
    }
    const body: CandidateAgentUsageAssociations = { value: usage.status === "linked" ? [{
      reportAgentId: record!.packages[0].id, agentName: record!.displayName, responses: usage.responses ?? 0, basis: "exact_package_id",
      target: { source: "graph_packages", packageId: record!.packages[0].id, snapshotId: record!.observations.graphPackages?.snapshotId ?? "synthetic-package-source" },
    }] : [], context: selected, page: pageInfo, counts: { total: usage.associationCount, filtered: usage.associationCount } };
    return route.fulfill({ json: body });
  });
  await page.route(url => /^\/api\/official-usage\/agents\/[^/]+(?:\/users)?$/.test(url.pathname), route => {
    expect(route.request().method()).toBe("GET");
    const url = new URL(route.request().url()), id = decodeURIComponent(url.pathname.split("/")[4]), selected = context();
    expect(url.searchParams.get("selectionId")).toBe(selected.selectionId);
    const record = inventory().value.find(row => row.packages.some(item => item.id === id));
    expect(record).toBeDefined();
    const rows = relationships().filter(row => row.agentId === id), base = reportPage(rows, { reports: selected.reports,
      counts: { total: rows.length, filtered: rows.length } });
    if (url.pathname.endsWith("/users")) {
      callbacks.users?.(url.searchParams);
      const search = url.searchParams.get("search")?.toLowerCase();
      return route.fulfill({ json: selectedFixtureWindow(url.href, rows.filter(row => !search || row.username.toLowerCase().includes(search)), base) });
    }
    const value = reportAgent(1, { agentId: id, agentName: record!.displayName, responses: record!.usage!.responses ?? 0,
      activeUsers: record!.usage!.activeUsers, relationshipCount: rows.length,
      reportResponses: record!.usage!.responses, bridgeResponses: rows.reduce((total, row) => total + row.responses, 0),
      lastActivityDateUtc: record!.usage!.lastActivityDateUtc });
    const body: OfficialReportDetail<ReportAgent> = { value, selection: base.selection, reports: selected.reports, sources: base.sources };
    return route.fulfill({ json: body });
  });
}
