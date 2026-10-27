import { describe, expect, it } from "vitest";
import { adoptionChange, adoptionDirection, adoptionSnapshotLabel, orderedAdoptionSnapshots } from "./adoptionTrends";
import { adoptionSnapshot } from "./test/reportDataFixture";

const first = adoptionSnapshot(1, { reportingStart: "2026-08-14", reportingEnd: "2026-09-12" });
const second = adoptionSnapshot(2, { reportingStart: "2026-09-09", reportingEnd: "2026-10-08", activeUsers: 344, activeAgents: 325 });
const latest = adoptionSnapshot(3, { reportingStart: "2026-09-27", reportingEnd: "2026-10-26", activeUsers: 306, activeAgents: 317 });

describe("adoption snapshot comparisons", () => {
  it("calculates precise baseline and previous changes without making a daily-rate claim", () => {
    expect(adoptionChange(first, latest, "activeUsers")).toMatchObject({ difference: 6, percentage: 2, label: "+6 (+2%)", direction: "up" });
    expect(adoptionChange(second, latest, "activeUsers")).toMatchObject({ difference: -38, direction: "down", label: "-38 (-11%)" });
    expect(adoptionChange(second, latest, "activeAgents")).toMatchObject({ difference: -8, direction: "down", label: "-8 (-2.5%)" });
    expect(adoptionDirection(second, latest, "activeUsers")).toBe("Lower than the previous saved report");
  });

  it("does not mistake import order for observed activity chronology", () => {
    const backfill = { ...first, acceptedAt: "2026-10-27T15:00:00Z" };
    expect(orderedAdoptionSnapshots([latest, backfill, second]).map(snapshot => snapshot.id)).toEqual([first.id, second.id, latest.id]);
  });

  it("orders ties deterministically without inferring growth at the same endpoint", () => {
    const duplicateEnd = { ...latest, id: first.id };
    expect(orderedAdoptionSnapshots([latest, duplicateEnd]).map(snapshot => snapshot.id)).toEqual([first.id, latest.id]);
    expect(adoptionChange(latest, duplicateEnd, "activeUsers")).toMatchObject({ direction: "unknown", label: "Same report end / observed date" });
  });

  it("handles zero baselines, no change, and complete decline without infinite percentages", () => {
    const zero = { ...first, activeUsers: 0 };
    expect(adoptionChange(zero, latest, "activeUsers")).toEqual({ direction: "up", difference: 306, label: "+306 (from zero)" });
    expect(adoptionChange(first, { ...latest, activeUsers: 0 }, "activeUsers")).toMatchObject({ direction: "down", difference: -300, percentage: -100 });
    expect(adoptionChange(first, { ...latest, activeUsers: 300 }, "activeUsers")).toMatchObject({ direction: "flat", difference: 0, percentage: 0 });
    expect(adoptionChange(undefined, latest, "activeUsers")).toMatchObject({ direction: "unknown", label: "No earlier report" });
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid counts %s", activeUsers => {
    expect(adoptionChange({ ...first, activeUsers }, latest, "activeUsers").direction).toBe("unknown");
    expect(adoptionChange(first, { ...latest, activeUsers }, "activeUsers").direction).toBe("unknown");
  });

  it("retains observed-range comparisons but does not compare unequal explicit windows", () => {
    const short = { ...first, periodProvenance: "operator_asserted", reportingStart: "2026-09-06" };
    const long = { ...latest, periodProvenance: "operator_asserted" };
    expect(adoptionChange(short, long, "activeUsers")).toMatchObject({ direction: "unknown", label: "Different reporting window lengths" });
    expect(adoptionChange(short, latest, "activeUsers").direction).toBe("up");
  });

  it.each([
    { reportingStart: null }, { reportingEnd: null }, { reportingEnd: "2026-09-31" }, { reportingStart: "2026-11-01" },
  ])("keeps unavailable dates %j out of temporal conclusions", dates => {
    expect(adoptionChange(first, { ...latest, ...dates }, "activeUsers").direction).toBe("unknown");
    expect(adoptionSnapshotLabel({ ...latest, ...dates })).toBe("Activity dates unavailable");
  });
});
