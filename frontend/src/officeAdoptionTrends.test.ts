import { describe, expect, it } from "vitest";
import { officeHistory } from "./test/officeAdoptionFixture";
import { officeChange, orderedOfficeHistory, officeMonthHistory, officeFourWeekBaseline, officeParticipationChange } from "./officeAdoptionTrends";

describe("Office observation trends", () => {
  it("orders real refresh observations without interpolation or summing overlapping windows", () => {
    expect(orderedOfficeHistory(officeHistory().reverse()).map(point => point.metrics.reportedActiveUsers)).toEqual([20, 30, 40]);
    expect(officeChange(20, 40)).toEqual({ direction: "up", label: "+20 (+100%)" });
    expect(officeChange(40, 30)?.label).toBe("-10 (-25%)");
    expect(officeChange(0, 2)?.label).toBe("+2");
    expect(officeChange(undefined, 0)).toBeUndefined();
    expect(officeChange(0, 0)?.direction).toBe("flat");
  });
  it("compares app participation rather than treating population growth as improved adoption",()=>{
    expect(officeParticipationChange(50,100,75,150)).toEqual({direction:"flat",label:"0.0 percentage points"});
    expect(officeParticipationChange(50,100,60,100)).toEqual({direction:"up",label:"+10.0 percentage points"});
    expect(officeParticipationChange(60,100,50,100)?.direction).toBe("down");
    expect(officeParticipationChange(8,2201,9,2201)).toEqual({direction:"up",label:"+<0.1 percentage points"});
    expect(officeParticipationChange(0,0,50,100)).toBeUndefined();
  });
  it.each([
    [101, 1000, 102, 1000, "up", "+0.1 percentage points"],
    [102, 1000, 101, 1000, "down", "-0.1 percentage points"],
    [101, 1000, 205, 2000, "up", "+0.2 percentage points"],
    [205, 2000, 101, 1000, "down", "-0.2 percentage points"],
  ] as const)("formats exact participation boundaries for %s/%s to %s/%s", (beforeUsers, beforeLicensed, afterUsers, afterLicensed, direction, label) => {
    expect(officeParticipationChange(beforeUsers, beforeLicensed, afterUsers, afterLicensed)).toEqual({ direction, label });
  });
  it("preserves measured change direction across the safe-integer count range", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    expect(officeParticipationChange(maximum - 1, maximum, maximum - 2, maximum - 1))
      .toEqual({ direction: "down", label: "-<0.1 percentage points" });
    expect(officeParticipationChange(maximum - 2, maximum - 1, maximum - 1, maximum))
      .toEqual({ direction: "up", label: "+<0.1 percentage points" });
    expect(officeParticipationChange(0, 100, 0, 200)).toEqual({ direction: "flat", label: "0.0 percentage points" });
    expect(officeParticipationChange(50, 100, 0, 0)).toBeUndefined();
  });
  it("keeps only actual observations in the month and requires a measured four-week baseline",()=>{
    const points=officeHistory();
    expect(officeMonthHistory(points,"2026-10-21")).toHaveLength(3);
    expect(officeFourWeekBaseline(points,"2026-10-21")).toBeUndefined();
    expect(officeFourWeekBaseline(points,"2026-11-04")?.observation.reportRefreshDate).toBe("2026-10-07");
    expect(officeMonthHistory(points,"2026-11-20")).toHaveLength(0);
  });
  it("includes exactly thirty UTC calendar dates and excludes older and future points",()=>{
    const template=officeHistory()[0];
    const points=["2026-10-21","2026-10-22","2026-11-20","2026-11-21"].map(date=>({
      ...template,observation:{ ...template.observation,reportRefreshDate:date },
    }));
    expect(officeMonthHistory(points,"2026-11-20").map(point=>point.observation.reportRefreshDate))
      .toEqual(["2026-10-22","2026-11-20"]);
  });
  it("selects the newest measured baseline from four to five weeks earlier without mutating history", () => {
    const template = officeHistory()[0];
    const points = ["2026-10-23", "2026-10-14", "2026-10-15", "2026-10-22"].map(date => ({
      ...template, observation: { ...template.observation, reportRefreshDate: date },
    }));
    const original = [...points];
    expect(officeFourWeekBaseline(points, "2026-11-19")).toBe(points[3]);
    expect(officeFourWeekBaseline(points.slice(0, 3), "2026-11-19")).toBe(points[2]);
    expect(officeFourWeekBaseline(points.slice(0, 2), "2026-11-19")).toBeUndefined();
    expect(points).toEqual(original);
  });
});
