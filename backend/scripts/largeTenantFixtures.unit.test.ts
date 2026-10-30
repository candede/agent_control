import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BeginGeneration } from "../src/db/dataGenerations.js";
import { schemaRegistry } from "../src/services/officialReportFields.js";
import { streamOfficialReport } from "../src/services/officialReportStream.js";
import { isCopilotServiceActive } from "../src/types/copilotUsage.js";
import {
  directoryRecord, generationInput, licensingGolden, officialGoldenCsvRows, selectionIdentity,
} from "./largeTenantFixtures.js";

afterEach(() => vi.restoreAllMocks());

describe("large tenant fixture contracts without infrastructure", () => {
  it("uses a shared tenant directory scope with a separate actor and bounded timestamps", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const input = generationInput();
    expect(input).toEqual({
      scope: { tenantId: selectionIdentity.tenantId, kind: "tenant", principalId: null,
        tokenMode: "tenant", source: "directory", selector: "complete" },
      actorPrincipalId: selectionIdentity.principalId,
      schemaVersion: 1, sessionEpoch: selectionIdentity.sessionEpoch,
      jobId: expect.stringMatching(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/), jobKind: "fixture",
      observedAt: new Date(now), expiresAt: new Date(now + 86_400_000),
      deadlineAt: new Date(now + 30 * 60_000), reserveBytes: 16 * 1024 ** 2,
    });
    expect(generationInput().jobId).not.toBe(input.jobId);
  });

  it("preserves explicit generation overrides, including a renewed session epoch", () => {
    const overrides: BeginGeneration = {
      scope: { tenantId: "other-tenant", kind: "tenant", principalId: null, tokenMode: "tenant",
        source: "app_activity", selector: "complete" },
      actorPrincipalId: "other-actor", sessionEpoch: "7", schemaVersion: 2,
      jobId: "explicit-job", runId: "explicit-run", jobKind: "data_sync",
      observedAt: new Date("2026-10-01T00:00:00Z"), expiresAt: new Date("2026-10-02T00:00:00Z"),
      deadlineAt: new Date("2026-10-01T00:30:00Z"), reserveBytes: 0,
    };
    expect(generationInput(overrides)).toEqual(overrides);
  });

  it("does not share mutable default generation scopes or dates between calls", () => {
    const first = generationInput(), second = generationInput();
    first.scope.tenantId = "changed";
    first.observedAt.setTime(0);
    expect(second.scope.tenantId).toBe(selectionIdentity.tenantId);
    expect(second.observedAt.getTime()).toBeGreaterThan(0);
    expect(generationInput().scope.tenantId).toBe(selectionIdentity.tenantId);
  });

  it("provides complete directory records and preserves explicit false, zero and null values", () => {
    expect(directoryRecord()).toEqual({
      identity: "one", upn: "one@example.invalid", upn_key: "one@example.invalid",
      display_name: "one", sort_key: "one", company: "Example", department: null, account_enabled: true,
      user_type: "Member", employee_type: null, service_state: "unknown", plan_count: 0, residual: {},
    });
    const overrides = { account_enabled: false, display_name: null, sort_key: null, company: null,
      plan_count: 0, residual: { retained: true } };
    expect(directoryRecord("two", overrides)).toEqual({
      ...directoryRecord("two"), ...overrides,
    });
  });

  it("does not share default residual objects between directory records", () => {
    const first = directoryRecord(), second = directoryRecord();
    first.residual.changed = true;
    expect(second.residual).toEqual({});
    expect(directoryRecord().residual).toEqual({});
  });

  it("keeps all licensing summary states and their paid-feature meanings", () => {
    expect(licensingGolden.map(row => row.state).sort()).toEqual([
      "disabled", "enabled", "locked_out", "partially_enabled", "suspended", "unknown", "warning",
    ]);
    expect(licensingGolden.filter(row => row.paid).map(row => row.state)).toEqual([
      "enabled", "warning", "partially_enabled",
    ]);
    for (const row of licensingGolden) expect(isCopilotServiceActive(row.state)).toBe(row.paid);
  });

  it.each([
    { kind: "agents", rows: [
      { agentId: "agent-one", agentName: "One", creatorType: "Declarative",
        activeUsersLicensed: 1, activeUsersUnlicensed: 1, responsesSentToUsers: 9, lastActivityDateUtc: undefined },
    ] },
    { kind: "userAgents", rows: [
      { agentId: "agent-one", agentName: "One", creatorType: "Declarative",
        username: "exact@example.invalid", responsesSentToUsers: 5, lastActivityDateUtc: undefined },
      { agentId: "agent-one", agentName: "One", creatorType: "Declarative",
        username: "unresolved-token", responsesSentToUsers: 4, lastActivityDateUtc: undefined },
    ] },
    { kind: "users", rows: [
      { username: "exact@example.invalid", displayName: "Exact", numberOfAgentsUsed: 1,
        agentResponsesReceived: 5, lastActivityDateUtc: undefined },
      { username: "zero@example.invalid", displayName: "Zero", numberOfAgentsUsed: 0,
        agentResponsesReceived: 0, lastActivityDateUtc: undefined },
    ] },
  ] as const)("parses the $kind golden rows through the current streaming import contract", async ({ kind, rows }) => {
    const seeds = officialGoldenCsvRows();
    const csv = `${schemaRegistry[kind].headers.join(",")}\n${seeds[kind].join("\n")}\n`;
    const batch = vi.fn(async () => {});
    const report = await streamOfficialReport(
      Readable.from([Buffer.from(csv)]), undefined, new AbortController().signal, { batch },
    );
    expect(report).toMatchObject({
      kind, rowCount: rows.length, examples: rows,
      reportingPeriod: { startDate: null, endDate: null, days: null, provenance: "activity_range" },
      sourceAsOfProvenance: "absent", sourceFreshness: "unknown",
    });
    expect(batch).toHaveBeenCalledExactlyOnceWith(kind, rows, Buffer.byteLength(csv));
    expect(officialGoldenCsvRows()[kind]).not.toBe(seeds[kind]);
  });
});
