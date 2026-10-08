import { afterEach, describe, expect, it, vi } from "vitest";
import { combinedUser, historySet, overviewAgent, overviewPage, reportAgent, reportPage, reports, reportSelection, reportSetId, reportUser, selectionId, source } from "./reportDataFixture";

afterEach(() => { vi.restoreAllMocks(); });

describe("report response fixture snapshots", () => {
  it("isolates rows, metadata and summaries between captures and caller-owned overrides", () => {
    const rows = [combinedUser()], overrides = reportPage(rows);
    const first = reportPage(rows, overrides), second = reportPage(rows, overrides);
    rows[0].directory.displayName = "Changed caller";
    overrides.value[0].attention.push("changed");
    overrides.reports.lineages[0].versionId = "changed-version";
    overrides.reports.reportingPeriod!.provenance = "activity_range";
    overrides.selection.id = "changed-selection";
    overrides.selection.revision = "changed-revision";
    overrides.selection.expiresAt = "invalid";
    overrides.counts.filtered = 0;
    overrides.page.nextCursor = "changed-cursor";
    overrides.sources.directory.state = "unavailable";
    overrides.filters.company = "Changed company";
    overrides.summary.licensedUsers = 0;
    overrides.analytics.rowCount = 0;
    expect(first).toEqual(second);
    expect(first.value[0].directory.displayName).toBe("User 1");
    expect(first.value[0].attention).toEqual([]);
    first.summary.licensedUsers = 0;
    first.reports.lineages[0].contentHash = "changed-hash";
    first.value[0].directory.userPrincipalName = "other-account@example.invalid";
    expect(second).toEqual(reportPage([combinedUser()]));
  });

  it("makes shared report templates immutable, including provenance and lineage arrays", () => {
    expect(Object.isFrozen(reports)).toBe(true);
    expect(Object.isFrozen(reports.reportingPeriod)).toBe(true);
    expect(Object.isFrozen(reports.lineages)).toBe(true);
    expect(reports.lineages.every(Object.isFrozen)).toBe(true);
    expect(() => { reports.activeRevision = "changed"; }).toThrow(TypeError);
    expect(() => { reports.lineages[0].sourceFreshness = "unknown"; }).toThrow(TypeError);
  });

  it("does not invent matches or filtered response totals for empty and generic pages", () => {
    for (const value of [[], [reportUser()], [reportAgent()]]) {
      const page = reportPage<ReturnType<typeof reportUser> | ReturnType<typeof reportAgent>>(value);
      expect(page.counts).toEqual({ total: value.length, filtered: value.length });
      expect(page.analytics).toMatchObject({ rowCount: value.length, responses: null, zeroResponses: null, unknownResponses: null, review: null });
      expect(page.page).toEqual({ limit: 50, nextCursor: null, previousCursor: null });
    }
    expect(reportPage([reportUser()], { value: [] }).counts).toEqual({ total: 0, filtered: 0 });
  });

  it("keeps explicit byte-short pages, tenant counts and zero/unknown evidence distinct", () => {
    const page = reportPage([reportUser()], { counts: { total: 100000, filtered: 50000 },
      page: { limit: 50, nextCursor: "owned-next", previousCursor: "owned-previous" } });
    expect(page.value).toHaveLength(1);
    expect(page.counts).toEqual({ total: 100000, filtered: 50000 });
    expect(page.analytics.rowCount).toBe(50000);
    expect(page.page).toEqual({ limit: 50, nextCursor: "owned-next", previousCursor: "owned-previous" });
    const empty = reportPage([], { counts: { total: 100000, filtered: 0 }, summary: { ...page.summary, licensedUsers: null },
      analytics: { ...page.analytics, rowCount: 0, responses: 0 } });
    expect(empty.summary.licensedUsers).toBeNull();
    expect(empty.analytics.responses).toBe(0);
  });

  it("uses a stable ten-minute capture without renewing it on retry or hiding explicit expiry", () => {
    const first = reportPage([]);
    const start = Date.parse(first.selection.evaluatedAt);
    expect(first.selection.id).toBe(selectionId);
    expect(first.selection.revision).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(first.selection.expiresAt) - start).toBe(600000);
    vi.spyOn(Date, "now").mockReturnValue(start + 600001);
    expect(reportPage([]).selection).toEqual(first.selection);
    expect(Date.parse(reportPage([]).selection.expiresAt)).toBeLessThan(Date.now());
    const replacement = reportSelection(3, Date.now());
    expect(replacement.id).not.toBe(first.selection.id);
    expect(replacement.revision).not.toBe(first.selection.revision);
    expect(Date.parse(replacement.expiresAt) - Date.now()).toBe(600000);
    for (const expiresAt of ["invalid", new Date(start - 1).toISOString()]) {
      expect(reportPage([], { selection: { ...replacement, expiresAt } }).selection.expiresAt).toBe(expiresAt);
    }
  });

  it.each([0, -1, 1.5, Number.NaN, 1000000000000])("rejects invalid capture index %s", index => {
    expect(() => reportSelection(index)).toThrow("Invalid report fixture selection index");
  });

  it("keeps selected report dates, source provenance and history aligned with the capture", () => {
    const page = reportPage([]), period = page.reports.reportingPeriod!, evaluation = Date.parse(page.selection.evaluatedAt);
    expect(historySet()).toMatchObject({ id: reportSetId, reportingStart: period.startDate, reportingEnd: period.endDate,
      acceptedAt: page.reports.acceptedAt, periodProvenance: period.provenance, active: true });
    expect(historySet(2).contentHash).not.toBe(historySet(1).contentHash);
    expect((Date.parse(period.endDate!) - Date.parse(period.startDate!)) / 86400000 + 1).toBe(period.days);
    expect(Math.floor((evaluation - Date.parse(`${period.endDate}T23:59:59.999Z`)) / 86400000)).toBe(page.reports.periodAgeDays);
    expect(Math.floor((evaluation - Date.parse(page.reports.acceptedAt!)) / 86400000)).toBe(page.reports.acceptedAgeDays);
    for (const kind of ["directory", "app_activity"] as const) {
      const metadata = source(kind);
      expect(Date.parse(metadata.observedAt!)).toBeLessThanOrEqual(evaluation);
      expect(Date.parse(metadata.expiresAt!)).toBeGreaterThanOrEqual(Date.parse(page.selection.expiresAt));
      expect(metadata.scopeId).not.toBe(page.selection.id);
    }
    for (const lineage of page.reports.lineages) {
      expect(lineage).toMatchObject({ sourceFreshness: "known", sourceAsOfProvenance: "source_metadata", periodProvenance: period.provenance });
      expect(lineage.sourceAsOf?.slice(0, 10)).toBe(period.endDate);
    }
  });

  it("keeps impossible response-producing and overview counts out of default rows", () => {
    const user = reportUser(), overview = overviewAgent(), page = overviewPage();
    expect(user.responseProducingAgentCount).toBeLessThanOrEqual(user.bridgeResponses!);
    expect(overview.creatorTypeCount).toBeLessThanOrEqual(overview.observationCount);
    expect(page.analytics.rowCount).toBe(page.counts.filtered);
    expect(page.page.nextCursor).not.toBeNull();
    expect(page.summary.distinctActiveReportUsers).toBe(page.summary.paidActiveReportUsers!
      + page.summary.activeWithoutPaidUsers! + page.summary.unknownLicenseActiveReportUsers);
    const copy = overviewPage(page);
    page.analytics.overview!.retainedSets = 0;
    expect(copy.analytics.overview!.retainedSets).toBe(32);
  });
});
