import { describe, expect, it } from "vitest";
import { classifyOfficeApps, officeDate, officeExpiry, officeQuery, officeRetentionCutoff, officeWindowStart, officeWeekStart } from "./officeAppAdoption.js";
import { officeApps, type OfficeDates } from "../types/officeAppAdoption.js";
import { boundedOfficeResponse } from "./officeAppAdoptionReads.js";
import { exactCount } from "../db/dataBounds.js";
const empty: OfficeDates = { word: null, excel: null, powerpoint: null, outlook: null, onenote: null, loop: null, teams: null };
describe("seven-app Office semantics", () => {
  it.each([["2026-11-01","2026-10-26"],["2026-11-02","2026-11-02"],["2026-01-01","2025-12-29"]])(
    "buckets %s into the UTC week starting %s",(date,start)=>expect(officeWeekStart(date)).toBe(start));
  it("contains exactly seven Office apps, not Chat, overall, Edge or agents", () => {
    expect(officeApps.map(app=>app.id)).toEqual(["word","excel","powerpoint","outlook","onenote","loop","teams"]);
    expect(officeApps.map(app=>app.activityField)).not.toContain("lastActivityDate");
    expect(officeApps.map(app=>app.activityField)).not.toContain("copilotChatLastActivityDate");
  });
  it("fails explicitly rather than truncating oversized complete payloads", () => {
    expect(()=>boundedOfficeResponse({ value:"x".repeat(1048576) })).toThrow(expect.objectContaining({ status:413,code:"office_response_bytes" }));
  });
  it("uses exact bounded counts without lossy numeric coercion",()=>{
    expect(exactCount("9007199254740991")).toBe(9007199254740991);
    expect(()=>exactCount("9007199254740993")).toThrow();
    expect(()=>exactCount("-1")).toThrow();
  });
  it.each([["2026-10-04",true],["2026-10-31",true],["2026-10-03",false],["2026-11-01",false],["2026-02-30",false],["",false]])(
    "classifies %s within the inclusive provider D28 window", (word, recent) => {
      expect(classifyOfficeApps({ ...empty,word },"2026-10-31").recentApps.includes("word")).toBe(recent);
    });
  it("preserves dated older evidence without inferring never-use or unknown inactivity", () => {
    const old=classifyOfficeApps({ ...empty,word:"2026-01-01" },"2026-10-31");
    expect(old).toEqual({ recentApps:[],latestRecentDate:null,unknownReasons:[] });
    expect(classifyOfficeApps(empty,"2026-10-31").unknownReasons).toEqual(["no_app_dates"]);
    expect(classifyOfficeApps({ ...empty,word:"2026-11-01",excel:"bad" },"2026-10-31").unknownReasons).toEqual(["invalid_app_date","future_app_date"]);
  });
  it.each(["retained_row","retained_directory","missing_row","ambiguous_identity","wrong_window"] as const)(
    "%s never promotes dates within a new window into current participation", reason => {
      const classified=classifyOfficeApps({ ...empty,word:"2026-10-30" },"2026-10-31",[reason]);
      expect(classified.recentApps).toEqual([]);
      expect(classified.unknownReasons).toContain(reason);
    });
  it("counts one person with several distinct apps without inventing prompt volume", () => {
    expect(classifyOfficeApps({ ...empty,word:"2026-10-30",excel:"2026-10-29",teams:"2026-10-04" },"2026-10-31")).toMatchObject({
      recentApps:["word","excel","teams"],latestRecentDate:"2026-10-30",
    });
  });
  it.each([["2024-02-29","2023-02-28"],["2025-03-31","2024-03-31"],["2026-01-31","2025-01-31"]])(
    "uses UTC calendar-month retention for %s", (at,expected) => {
      expect(officeRetentionCutoff(new Date(`${at}T23:59:59Z`))).toBe(expected);
    });
  it("retains cutoff equality through its UTC day, including leap-day expiry", () => {
    expect(officeExpiry("2024-02-29").toISOString()).toBe("2025-03-01T00:00:00.000Z");
    expect(officeExpiry("2023-02-28").toISOString()).toBe("2024-03-01T00:00:00.000Z");
    expect(officeRetentionCutoff(new Date("2024-02-29T23:59:59Z"))).toBe("2023-02-28");
    expect(officeWindowStart("2024-03-01")).toBe("2024-02-03");
    expect(officeDate("2026-02-30")).toBe(false);
    expect(officeDate("0000-01-01")).toBe(false);
  });
  it.each([{ app:"chat" },{ officeSnapshot:"agent-set" },{ search:null },{ company:[] },{ overall:true },{ department:"bad\n" }])(
    "rejects invalid filters %j", query => { expect(()=>officeQuery(query as OfficeQueryForTest)).toThrow(); });
  it("preserves literal directory filters without relaxing search or invalid source text", () => {
    const query = { company: "Example\tCompany", department: "Research\u0001Development" };
    expect(officeQuery(query)).toEqual(query);
    for (const value of ["bad\0label", "bad\rlabel", "bad\nlabel", "bad\uD800label"]) {
      expect(() => officeQuery({ company: value })).toThrow();
      expect(() => officeQuery({ department: value })).toThrow();
    }
    expect(() => officeQuery({ search: "bad\tsearch" })).toThrow();
  });
});
type OfficeQueryForTest = Parameters<typeof officeQuery>[0];
