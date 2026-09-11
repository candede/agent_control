import { describe, expect, it } from "vitest";
import { parseOfficialUsageReport } from "./officialUsageParser.js";

const metadata = {
  reportingPeriod: {
    startDate: "2026-06-07",
    endDate: "2026-07-06",
    provenance: "operator_asserted" as const,
  },
  sourceAsOf: {
    value: "2026-07-08T12:00:00Z",
    provenance: "operator_asserted" as const,
  },
  downloadedAt: "2030-01-01T00:00:00Z",
};

function bytes(value: string) {
  return Buffer.from(value, "utf8");
}

function userAgentCsv(date: string, agentName = "Research assistant") {
  return [
    "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)",
    `agent-1,"${agentName}",Declarative,User@Example.com,42,"${date}"`,
  ].join("\n");
}

describe("parseOfficialUsageReport", () => {
  it.each(["Jul 6, 2026", "July 6, 2026", "6 Jul 2026", "6 July 2026", "6 Jul, 2026", "2026-07-06", "2026/07/06"])(
    "ports the observed usage date format %s without deriving provenance from a filename",
    (date) => {
      const report = parseOfficialUsageReport(bytes(userAgentCsv(date)), metadata);
      expect(report).toMatchObject({
        kind: "userAgents",
        reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", days: 30 },
        sourceAsOf: "2026-07-08T12:00:00.000Z",
        downloadedAt: "2030-01-01T00:00:00.000Z",
        sourceFreshness: "unknown",
      });
      expect(report.rows[0]).toMatchObject({ username: "User@Example.com", lastActivityDateUtc: "2026-07-06T00:00:00.000Z" });
    },
  );

  it("handles UTF-8 BOM, quoted commas, escaped quotes and embedded newlines", () => {
    const report = parseOfficialUsageReport(
      bytes(`\uFEFF${userAgentCsv("2026-07-06", "Research, \"\"North\"\"\nassistant")}`),
      metadata,
    );
    expect(report.rows[0].agentName).toBe('Research, "North"\nassistant');
  });

  it("labels operator assertions while keeping source freshness unknown", () => {
    const report = parseOfficialUsageReport(bytes(userAgentCsv("2026-07-06")), {
      reportingPeriod: { ...metadata.reportingPeriod, provenance: "operator_asserted" },
      sourceAsOf: { value: "2026-07-08T12:00:00Z", provenance: "operator_asserted" },
    });
    expect(report).toMatchObject({ sourceAsOfProvenance: "operator_asserted", sourceFreshness: "unknown" });
  });

  it("preserves licensed and unlicensed source categories without creating an additive total", () => {
    const report = parseOfficialUsageReport(bytes("Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\na,A,Your org,9007199254740991,1,0,2026-07-06"), metadata);
    expect(report.kind).toBe("agents");
    expect(report.rows[0]).toMatchObject({ activeUsersLicensed: 9007199254740991, activeUsersUnlicensed: 1 });
    expect(report.rows[0]).not.toHaveProperty("activeUsersTotal");
  });

  it("rejects caller claims of source metadata because supported CSVs contain no metadata columns", () => {
    expect(() => parseOfficialUsageReport(bytes(userAgentCsv("2026-07-06")), {
      ...metadata,
      reportingPeriod: { ...metadata.reportingPeriod, provenance: "source_metadata" },
    })).toThrowError(expect.objectContaining({ code: "unverified_source_metadata" }));
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0xff, 0xfe]), "invalid_utf8"],
    ["duplicate headers", bytes("Username,Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\na,a,A,1,1,2026-07-06"), "duplicate_header"],
    ["unknown schema", bytes("Agent ID,New required metric\na,1"), "schema_drift"],
    ["malformed columns", bytes(`${userAgentCsv("2026-07-06")}\nagent-2,short`), "malformed_csv"],
    ["invalid number", bytes("Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\na,A,one,1,2026-07-06"), "invalid_number"],
    ["invalid date", bytes(userAgentCsv("31 Feb 2026")), "invalid_date"],
    ["control data", bytes(userAgentCsv("2026-07-06", "Agent\u0000name")), "invalid_content"],
    ["duplicate identity", bytes(`${userAgentCsv("2026-07-06")}\nagent-1,Other,Declarative,User@Example.com,1,2026-07-06`), "duplicate_identity"],
    ["aggregate arithmetic overflow", bytes("Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\na,A,0,9007199254740991,2026-07-06\nb,B,0,1,2026-07-06"), "numeric_overflow"],
  ])("rejects %s", (_label, input, code) => {
    expect(() => parseOfficialUsageReport(input as Uint8Array, metadata)).toThrowError(expect.objectContaining({ code }));
  });

  it("enforces byte and row limits before accepting rows", () => {
    expect(() => parseOfficialUsageReport(bytes(userAgentCsv("2026-07-06")), metadata, {
      maxBytes: 10,
      maxRows: 1,
      maxFieldBytes: 128,
    })).toThrowError(expect.objectContaining({ code: "report_too_large" }));
    expect(() => parseOfficialUsageReport(bytes(`${userAgentCsv("2026-07-06")}\nagent-2,Other,Declarative,other@example.com,1,2026-07-06`), metadata, {
      maxBytes: 10_000,
      maxRows: 1,
      maxFieldBytes: 128,
    })).toThrowError(expect.objectContaining({ code: "row_limit_exceeded" }));
  });

  it("requires exact documented periods and unambiguous real timestamps", () => {
    expect(() => parseOfficialUsageReport(bytes(userAgentCsv("2026-07-06")), {
      ...metadata,
      reportingPeriod: { ...metadata.reportingPeriod, startDate: "2026-06-08" },
    })).toThrowError(expect.objectContaining({ code: "invalid_reporting_period" }));
    for (const downloadedAt of ["2026-07-08", "2026-02-30T12:00:00Z", "2026-07-08T12:00:00"]) {
      expect(() => parseOfficialUsageReport(bytes(userAgentCsv("2026-07-06")), { ...metadata, downloadedAt }))
        .toThrowError(expect.objectContaining({ code: "invalid_metadata" }));
    }
  });
});