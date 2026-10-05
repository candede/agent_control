import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { streamOfficialReport, type StreamedOfficialReport } from "./officialReportStream.js";
import type { OfficialUsageMetadata } from "../types/officialReportRecords.js";

const metadata: OfficialUsageMetadata = {
  reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", provenance: "operator_asserted" },
  sourceAsOf: { value: "2026-07-08T12:00:00Z", provenance: "operator_asserted" },
  downloadedAt: "2030-01-01T00:00:00Z",
};
function bytes(value: string) { return Buffer.from(value, "utf8"); }
function stream(input: Uint8Array, assertions?: OfficialUsageMetadata) {
  return streamOfficialReport(Readable.from([input]), assertions, new AbortController().signal, { batch: async () => {} });
}
function userAgentCsv(date: string, agentName = "Research assistant") {
  return [
    "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)",
    `agent-1,"${agentName}",Declarative,User@Example.com,42,"${date}"`,
  ].join("\n");
}

describe("streamOfficialReport normalized field semantics", () => {
  it("derives only the observed activity range when operator metadata is omitted", async () => {
    const report = await stream(bytes([
      userAgentCsv("2026-07-06"), "agent-2,Other,Declarative,other@example.com,1,2026-06-29",
    ].join("\n")));
    expect(report).toMatchObject({
      reportingPeriod: { startDate: "2026-06-29", endDate: "2026-07-06", days: 8, provenance: "activity_range" },
      sourceAsOfProvenance: "absent", sourceFreshness: "unknown",
    });
    expect(report.sourceAsOf).toBeUndefined();
    expect(report.downloadedAt).toBeUndefined();
  });
  it("keeps empty and no-activity-date exports explicitly unknown", async () => {
    const header = "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)";
    for (const csv of [header, `${header}\nuser@example.com,User,0,0,`]) {
      expect(await stream(bytes(csv))).toMatchObject({
        reportingPeriod: { startDate: null, endDate: null, days: null, provenance: "activity_range" },
        sourceAsOfProvenance: "absent", sourceFreshness: "unknown",
      });
    }
  });
  it.each(["Jul 6, 2026", "July 6, 2026", "6 Jul 2026", "6 July 2026", "6 Jul, 2026", "2026-07-06", "2026/07/06"])(
    "ports the observed usage date format %s without deriving provenance from a filename", async date => {
      const report = await stream(bytes(userAgentCsv(date)), metadata);
      expect(report).toMatchObject({
        kind: "userAgents", reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", days: 30 },
        sourceAsOf: "2026-07-08T12:00:00.000Z", downloadedAt: "2030-01-01T00:00:00.000Z", sourceFreshness: "unknown",
      });
      expect(report.examples[0]).toMatchObject({ username: "User@Example.com", lastActivityDateUtc: "2026-07-06T00:00:00.000Z" });
    },
  );
  it.each([
    ["Jan", "January"], ["Feb", "February"], ["Mar", "March"], ["Apr", "April"],
    ["May", "May"], ["Jun", "June"], ["Jul", "July"], ["Aug", "August"],
    ["Sep", "September"], ["Oct", "October"], ["Nov", "November"], ["Dec", "December"],
  ])("recognizes only complete English month names and abbreviations for %s", async (short, full) => {
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(short) + 1;
    for (const date of [`${short.toUpperCase()}. 6, 2026`, `6 ${full.toLowerCase()} 2026`]) {
      const report = await stream(bytes(userAgentCsv(date)));
      expect(report.examples[0].lastActivityDateUtc).toBe(`2026-${String(month).padStart(2, "0")}-06T00:00:00.000Z`);
    }
  });
  it.each(["Sept 6, 2026", "6 Sept. 2026"])("supports the English September abbreviation %s", async date => {
    expect((await stream(bytes(userAgentCsv(date)))).examples[0].lastActivityDateUtc).toBe("2026-09-06T00:00:00.000Z");
  });
  it.each(["Junk 6, 2026", "6 Jultypo 2026", "Marching 6, 2026", "6 Septemberish 2026"])(
    "rejects invalid month names instead of accepting a prefix in %s", async date => {
      await expect(stream(bytes(userAgentCsv(date)))).rejects.toMatchObject({ code: "invalid_date" });
    },
  );
  it("handles UTF-8 BOM, quoted commas, escaped quotes and embedded newlines", async () => {
    const report = await stream(bytes(`\uFEFF${userAgentCsv("2026-07-06", "Research, \"\"North\"\"\nassistant")}`), metadata);
    expect(report.examples[0]).toMatchObject({ agentName: 'Research, "North"\nassistant' });
  });
  it.each(["\t", "\n", "\r", "\r\n"])("rejects embedded control characters in agent IDs (%j) before staging unassociatable identities", async control => {
    for (const csv of [
      [
        "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)",
        `"agent${control}1",Assistant,Declarative,1,0,42,2026-07-06`,
      ].join("\n"),
      userAgentCsv("2026-07-06").replace("agent-1", `"agent${control}1"`),
    ]) {
      await expect(stream(bytes(csv))).rejects.toMatchObject({ code: "invalid_identifier" });
    }
  });
  it("preserves embedded tabs in display names", async () => {
    expect((await stream(bytes(userAgentCsv("2026-07-06", "Research\tassistant")))).examples[0])
      .toMatchObject({ agentName: "Research\tassistant" });
  });
  it.each(["Report/% Agent?x=1#[]&:=+", "a".repeat(512), "Report-\u{1f916}", "Report-\ufffd"])(
    "preserves supported opaque agent IDs (%s)", async agentId => {
      expect((await stream(bytes(userAgentCsv("2026-07-06").replace("agent-1", agentId)))).examples[0]).toMatchObject({ agentId });
    },
  );
  it("labels operator assertions while keeping source freshness unknown", async () => {
    const report = await stream(bytes(userAgentCsv("2026-07-06")), {
      reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", provenance: "operator_asserted" },
      sourceAsOf: { value: "2026-07-08T12:00:00Z", provenance: "operator_asserted" },
    });
    expect(report).toMatchObject({ sourceAsOfProvenance: "operator_asserted", sourceFreshness: "unknown" });
  });
  it("preserves licensed and unlicensed source categories without creating an additive total", async () => {
    const report = await stream(bytes("Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\na,A,Your org,9007199254740991,1,0,2026-07-06"), metadata);
    expect(report.kind).toBe("agents");
    expect(report.examples[0]).toMatchObject({ activeUsersLicensed: 9007199254740991, activeUsersUnlicensed: 1 });
    expect(report.examples[0]).not.toHaveProperty("activeUsersTotal");
  });
  it.each([
    [
      "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)",
      'a,Assistant,User-created agent,"1,234","2,345","1,175","Sep 12, 2026"',
      { activeUsersLicensed: 1234, activeUsersUnlicensed: 2345, responsesSentToUsers: 1175 },
    ],
    [
      "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)",
      'a,Assistant,User-created agent,user@example.invalid,"1,175","Sep 12, 2026"', { responsesSentToUsers: 1175 },
    ],
    [
      "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)",
      'user@example.invalid,User,"1,234","1,048","Sep 12, 2026"', { numberOfAgentsUsed: 1234, agentResponsesReceived: 1048 },
    ],
  ])("parses Microsoft-exported comma-grouped counts for %s", async (header, row, expected) => {
    const report = await stream(bytes(`\uFEFF${header}\r\n${row}\r\n`));
    expect(report.examples[0]).toMatchObject(expected);
    expect(report.examples[0].lastActivityDateUtc).toBe("2026-09-12T00:00:00.000Z");
  });
  it.each(["1,00", "12,34", "1234,567", "1,,000", "0,123", "01,234", "1.000", "-1,000", "1,000.5", "1 000", "1e3", "9,007,199,254,740,992"])(
    "rejects malformed or unsafe numeric counts %s", async value => {
      const csv = `Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\nuser@example.invalid,User,1,"${value}",2026-09-12`;
      await expect(stream(bytes(csv))).rejects.toMatchObject({ code: "invalid_number" });
    },
  );
  it("validates Users metric totals independently without adding agents to responses", async () => {
    const report = await stream(bytes([
      "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)",
      "first,First,1,9007199254740990,2026-07-06", "second,Second,9007199254740990,1,2026-07-06",
    ].join("\n")));
    expect(report.kind).toBe("users");
    expect(report.examples).toMatchObject([
      { numberOfAgentsUsed: 1, agentResponsesReceived: 9007199254740990 },
      { numberOfAgentsUsed: 9007199254740990, agentResponsesReceived: 1 },
    ]);
  });
  it.each([["9007199254740991,0", "1,0"], ["0,9007199254740991", "0,1"]])(
    "rejects overflow within either Users metric total (%s)", async (first, second) => {
      const csv = [
        "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)",
        `first,First,${first},2026-07-06`, `second,Second,${second},2026-07-06`,
      ].join("\n");
      await expect(stream(bytes(csv))).rejects.toMatchObject({ code: "numeric_overflow" });
    },
  );
  it("rejects caller claims of source metadata because supported CSVs contain no metadata columns", async () => {
    await expect(stream(bytes(userAgentCsv("2026-07-06")), {
      ...metadata, reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", provenance: "source_metadata" },
    })).rejects.toMatchObject({ code: "unverified_source_metadata" });
  });
  it.each([
    ["invalid UTF-8", Buffer.from([0xff, 0xfe]), "invalid_utf8"],
    ["duplicate headers", bytes("Username,Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\na,a,A,1,1,2026-07-06"), "duplicate_header"],
    ["unknown schema", bytes("Agent ID,New required metric\na,1"), "schema_drift"],
    ["malformed columns", bytes(`${userAgentCsv("2026-07-06")}\nagent-2,short`), "invalid_csv"],
    ["invalid number", bytes("Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\na,A,one,1,2026-07-06"), "invalid_number"],
    ["invalid date", bytes(userAgentCsv("31 Feb 2026")), "invalid_date"],
    ["control data", bytes(userAgentCsv("2026-07-06", "Agent\u0000name")), "invalid_content"],
    ["aggregate arithmetic overflow", bytes("Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\na,A,0,9007199254740991,2026-07-06\nb,B,0,1,2026-07-06"), "numeric_overflow"],
  ])("rejects %s", async (_label, input, code) => {
    await expect(stream(input, metadata)).rejects.toMatchObject({ code });
  });
  it("counts CSV records rather than physical lines", async () => {
    const report = await stream(bytes(`\n${userAgentCsv("2026-07-06", "Research\nassistant")}\n\n`));
    expect(report.rowCount).toBe(1);
    expect(report.examples).toHaveLength(1);
    expect(report.examples[0]).toMatchObject({ agentName: "Research\nassistant" });
  });
  it("requires exact documented periods and unambiguous real timestamps", async () => {
    await expect(stream(bytes(userAgentCsv("2026-07-06")), {
      ...metadata, reportingPeriod: { startDate: "2026-06-08", endDate: "2026-07-06", provenance: "operator_asserted" },
    })).rejects.toMatchObject({ code: "invalid_reporting_period" });
    for (const downloadedAt of ["2026-07-08", "2026-02-30T12:00:00Z", "2026-07-08T12:00:00"]) {
      await expect(stream(bytes(userAgentCsv("2026-07-06")), { ...metadata, downloadedAt })).rejects.toMatchObject({ code: "invalid_metadata" });
    }
  });
  it("normalizes header order, CSV quoting, whitespace and row order to the same semantic rows", async () => {
    const conventional = [
      "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)",
      "agent-1,Agent One,Declarative,user-1@example.invalid,1000,2026-07-06",
      "agent-2,Agent Two,Custom,user-2@example.invalid,4,2026-07-05",
    ].join("\n");
    const reformatted = [
      '"Username","Responses sent to users","Agent name","Last activity date (UTC)","Creator type","Agent ID"',
      '" user-2@example.invalid ","4","Agent Two","2026/07/05","Custom","agent-2"',
      '"user-1@example.invalid","1,000"," Agent One ","Jul 6, 2026","Declarative","agent-1"',
    ].join("\r\n");
    const normalize = (report: StreamedOfficialReport) => [...report.examples].sort((left, right) =>
      ("agentId" in left ? left.agentId : "").localeCompare("agentId" in right ? right.agentId : ""));
    expect(normalize(await stream(bytes(reformatted), metadata))).toEqual(normalize(await stream(bytes(conventional), metadata)));
  });
});
