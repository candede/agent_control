import { describe, expect, it } from "vitest";

import { parseUsageReport } from "./reportImports";

const expectedDate = "2026-07-06T00:00:00.000Z";

function userAgentReportCsv(date: string) {
  return [
    "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)",
    `agent-1,Research assistant,Declarative,user@example.com,42,${csvField(date)}`,
  ].join("\n");
}

function csvField(value: string) {
  return value.includes(",") ? `"${value.replaceAll('"', '""')}"` : value;
}

describe("parseUsageReport", () => {
  it.each([
    "Jul 6, 2026",
    "July 6, 2026",
    "6 Jul 2026",
    "6 July 2026",
    "6 Jul, 2026",
    "2026-07-06",
    "2026/07/06",
  ])("parses supported usage date format %s", (date) => {
    const report = parseUsageReport(
      "Microsoft 365 Copilot users and agents usage_30_2026-07-06T00_00_00Z.csv",
      userAgentReportCsv(date),
      "2026-07-06T12:00:00.000Z",
    );

    expect(report.kind).toBe("userAgents");
    expect(report.warnings).toEqual([]);
    expect(report.rows[0].lastActivityDateUtc).toBe(expectedDate);
  });

  it("warns and preserves the row when a usage date is invalid", () => {
    const report = parseUsageReport(
      "Microsoft 365 Copilot users and agents usage_30_2026-07-06T00_00_00Z.csv",
      userAgentReportCsv("31 Feb 2026"),
      "2026-07-06T12:00:00.000Z",
    );

    expect(report.kind).toBe("userAgents");
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].lastActivityDateUtc).toBeUndefined();
    expect(report.warnings).toEqual([
      "Row 2 has an invalid Last activity date (UTC) value: 31 Feb 2026.",
    ]);
  });
});
