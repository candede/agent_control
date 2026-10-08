// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AgentUsageHistoryPoint, CandidateAgentUsageContext } from "../../../backend/src/types/officialReportApi";
import { agentUsageHistoryFixture, automaticUsageContext } from "./automaticAgentUsageFixture";
import { reports, selectionId } from "./reportDataFixture";

const context: CandidateAgentUsageContext = {
  selectionId, reportSetId: reports.setId, reports, usageRevision: automaticUsageContext.revision, inventoryRevision: "c".repeat(64),
};
function point(setId: string, end: string | null, responses: number | null, acceptedAt = "2026-02-01T00:00:00.000Z"): AgentUsageHistoryPoint {
  return { setId, reportingStart: end ? "2026-01-01" : null, reportingEnd: end, acceptedAt, periodProvenance: end ? "operator_asserted" : "unknown",
    status: responses === null ? "unlinked" : "linked", responses, lastActivityDateUtc: responses === null || !end ? null : `${end}T00:00:00.000Z`,
    associationCount: responses === null ? 0 : 1 };
}

describe("automatic agent usage history fixture", () => {
  it("uses the selected report's import and period metadata without inventing usage", () => {
    const selected = structuredClone(context);
    selected.reports.acceptedAt = "2026-03-01T12:00:00.000Z";
    const result = agentUsageHistoryFixture(selected, "agent");
    expect(result.value).toEqual([{
      setId: selected.reportSetId, reportingStart: reports.reportingPeriod!.startDate, reportingEnd: reports.reportingPeriod!.endDate,
      periodProvenance: reports.reportingPeriod!.provenance, acceptedAt: selected.reports.acceptedAt,
      status: "unlinked", responses: null, lastActivityDateUtc: null, associationCount: 0,
    }]);
    expect(result.latestReportSetId).toBe(selected.reportSetId);
    expect(result.latestReported).toBeNull();
  });

  it("isolates caller data, independent responses and repeated JSON objects", () => {
    const selected = structuredClone(context), points = [point("latest", "2026-01-31", 0)];
    const first = agentUsageHistoryFixture(selected, "agent", points);
    const second = agentUsageHistoryFixture(selected, "agent", points);
    selected.reports.lineages[0].sourceFreshness = "unknown";
    selected.reports.expiresAt = "2026-01-01T00:00:00.000Z";
    selected.usageRevision = "replacement";
    points[0].responses = 999;
    expect(first.context).toEqual(second.context);
    expect(first.context.reports.lineages[0].sourceFreshness).toBe("known");
    expect(first.context.reports.expiresAt).toBe(reports.expiresAt);
    expect(first.context.usageRevision).toBe(context.usageRevision);
    expect(first.value[0].responses).toBe(0);
    first.value[0].responses = 111;
    first.context.reports.lineages[0].rowCount = 1;
    expect(first.latestReported?.responses).toBe(0);
    expect(second.value[0].responses).toBe(0);
    expect(second.context.reports.lineages[0].rowCount).toBe(reports.lineages[0].rowCount);
  });

  it("bounds pages without replacing global metadata with the current page or newest upload", () => {
    const points = [
      point("backfill", "2026-01-01", 10, "2026-04-01T00:00:00.000Z"),
      point("zero", "2026-01-30", 0),
      point("latest", "2026-01-31", null),
    ];
    const first = agentUsageHistoryFixture(context, "agent", points, { limit: 1 });
    expect(first.value.map(row => row.setId)).toEqual(["latest"]);
    expect(first.latestReportSetId).toBe("latest");
    expect(first.latestReported).toMatchObject({ setId: "zero", responses: 0 });
    expect(first.counts).toEqual({ total: 3, filtered: 3 });
    const second = agentUsageHistoryFixture(context, "agent", points, { limit: 1, cursor: first.page.nextCursor! });
    const third = agentUsageHistoryFixture(context, "agent", points, { limit: 1, cursor: second.page.nextCursor! });
    expect(second.value.map(row => row.setId)).toEqual(["zero"]);
    expect(third.value.map(row => row.setId)).toEqual(["backfill"]);
    expect(third.latestReportSetId).toBe(first.latestReportSetId);
    expect(third.latestReported).toEqual(first.latestReported);
    expect(third.counts).toEqual(first.counts);
    expect(third.page.nextCursor).toBeNull();
    expect(agentUsageHistoryFixture(context, "agent", points, { limit: 1, cursor: third.page.previousCursor! })).toEqual(second);
    expect(points.map(row => row.setId)).toEqual(["backfill", "zero", "latest"]);
  });

  it("defaults to fifty rows and orders same-period imports and undated reports like the service", () => {
    const points = Array.from({ length: 51 }, (_, index) => point(String(index).padStart(2, "0"), "2026-01-31", index));
    const first = agentUsageHistoryFixture(context, "agent", points);
    expect(first.value).toHaveLength(50);
    expect(first.value[0].setId).toBe("50");
    expect(first.counts.total).toBe(51);
    const last = agentUsageHistoryFixture(context, "agent", points, { cursor: first.page.nextCursor! });
    expect(last.value.map(row => row.setId)).toEqual(["00"]);
    const undated = point("z", null, 30, "2026-05-01T00:00:00.000Z");
    const dated = point("a", "2026-01-31", 20, "2026-03-01T00:00:00.000Z");
    const olderImport = point("b", "2026-01-31", 10);
    expect(agentUsageHistoryFixture(context, "agent", [undated, olderImport, dated]).value.map(row => row.setId))
      .toEqual(["a", "b", "z"]);
    const newerUpload = point("a", null, 0, "2026-06-01T00:00:00.000Z");
    const unknownDates = agentUsageHistoryFixture(context, "agent", [undated, newerUpload], { limit: 1 });
    expect(unknownDates.value.map(row => row.setId)).toEqual(["z"]);
    expect(unknownDates.latestReportSetId).toBe("a");
    expect(unknownDates.latestReported?.setId).toBe("z");
  });

  it.each(["selection", "usage", "inventory", "history", "record"] as const)("rejects cursors from a different %s owner", boundary => {
    const points = [point("latest", "2026-01-31", 10), point("older", "2026-01-30", 0)];
    const first = agentUsageHistoryFixture(context, "agent", points, { limit: 1 });
    const changed = structuredClone(context);
    if (boundary === "selection") changed.selectionId = "other-selection";
    if (boundary === "usage") changed.usageRevision = "other-usage";
    if (boundary === "inventory") changed.inventoryRevision = "other-inventory";
    if (boundary === "history") changed.reports.historyRevision = "other-history";
    expect(() => agentUsageHistoryFixture(changed, boundary === "record" ? "other-agent" : "agent", points,
      { limit: 1, cursor: first.page.nextCursor! })).toThrow(/cursor/i);
  });

  it("continues from the same boundary when the requested page size changes", () => {
    const points = [point("latest", "2026-01-31", 10), point("middle", "2026-01-30", 0), point("oldest", "2026-01-29", null)];
    const first = agentUsageHistoryFixture(context, "agent", points, { limit: 1 });
    const next = agentUsageHistoryFixture(context, "agent", points, { limit: 2, cursor: first.page.nextCursor! });
    expect(next.value.map(row => row.setId)).toEqual(["middle", "oldest"]);
    expect(agentUsageHistoryFixture(context, "agent", points, { limit: 2, cursor: next.page.previousCursor! }).value.map(row => row.setId))
      .toEqual(["latest"]);
  });

  it.each([0, 101, 1.5, Number.NaN])("rejects the invalid page limit %s", limit => {
    expect(() => agentUsageHistoryFixture(context, "agent", [], { limit })).toThrow(/limit/i);
  });

  it("keeps empty history explicit and rejects malformed or unowned cursors", () => {
    const empty = agentUsageHistoryFixture({ ...context, reportSetId: null, reports: { ...reports, setId: null } }, "agent");
    expect(empty).toMatchObject({ value: [], latestReportSetId: null, latestReported: null,
      counts: { total: 0, filtered: 0 }, page: { limit: 50, nextCursor: null, previousCursor: null } });
    for (const cursor of ["foreign", "null", "[]"]) {
      expect(() => agentUsageHistoryFixture(context, "agent", [], { cursor })).toThrow(/cursor/i);
    }
  });

  it("does not confuse an absent shared selection with absent retained reports", () => {
    const selected = { ...context, reportSetId: null, reports: { ...reports, setId: null } };
    const result = agentUsageHistoryFixture(selected, "agent", [point("retained", "2026-01-31", 0)]);
    expect(result.context.reportSetId).toBeNull();
    expect(result.latestReportSetId).toBe("retained");
    expect(result.latestReported?.responses).toBe(0);
    expect(result.counts.total).toBe(1);
  });

  it("requires import metadata rather than manufacturing a timestamp for a saved report", () => {
    expect(() => agentUsageHistoryFixture({ ...context, reports: { ...reports, acceptedAt: null } }, "agent")).toThrow(/import timestamp/);
  });
});
