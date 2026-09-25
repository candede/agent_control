import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { OfficialUsageOverviewService, validateOfficialUsageOverviewOptions } from "./officialUsageOverview.js";

function databaseFixture() {
  const row = {
    revision: "12", retained_sets: 2, reported_agents: 3, used_agents: 2, active_agents: 1, undated_agents: 1,
    earliest_activity: "2026-06-01", latest_activity: "2026-07-15", agent_count: 1,
    agents: [{
      agentId: "Report-A", agentName: "Agent", creatorTypes: ["Custom", "Your org"],
      hasResponses: true, lastActivityDateUtc: "2026-06-01", observationCount: 2,
      latestSetId: "retained-set", latestAcceptedAt: "2026-07-01T12:00:00.000Z",
    }],
  };
  const client = { query: vi.fn().mockResolvedValue({ rows: [row] }), release: vi.fn() };
  const database = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
  const service = new OfficialUsageOverviewService(database as unknown as pg.Pool,
    () => new Date("2026-07-16T01:15:00+04:00"));
  return { service, database, client, row };
}

describe("official usage cumulative overview", () => {
  it("validates bounded defaults, literal search and strict inclusive UTC dates", () => {
    expect(validateOfficialUsageOverviewOptions({})).toEqual({
      search: null, startDate: null, endDate: null, sortBy: "lastActivity", sortDirection: "desc",
      limit: 25, offset: 0,
    });
    expect(validateOfficialUsageOverviewOptions({
      search: "  %_Name  ", startDate: "2024-02-29", endDate: "2024-02-29", limit: 100, offset: 100_000,
      sortBy: "agentName", sortDirection: "asc",
    })).toEqual({
      search: "%_Name", startDate: "2024-02-29", endDate: "2024-02-29", limit: 100, offset: 100_000,
      sortBy: "agentName", sortDirection: "asc",
    });
  });

  it.each([
    { startDate: "" }, { endDate: "" }, { startDate: "2026-6-01" }, { startDate: "2026-02-29" },
    { startDate: "2024-02-30" }, { endDate: "2026-04-31" }, { startDate: "2026-00-01" },
    { startDate: "2026-13-01" }, { endDate: "2026-07-15T00:00:00Z" },
    { startDate: "2026-07-16", endDate: "2026-07-15" },
    { search: "x".repeat(257) }, { search: "test\nname" }, { search: "test\0name" },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: NaN },
    { offset: -1 }, { offset: 100_001 },
  ])("rejects invalid options before opening a database connection: %j", async options => {
    const { service, database } = databaseFixture();
    await expect(service.getOverview("tenant", options)).rejects.toMatchObject({
      code: "invalid_usage_query", status: 400,
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rejects unsupported sorting before it can enter SQL", () => {
    expect(() => validateOfficialUsageOverviewOptions({ sortBy: "responses" as never }))
      .toThrowError(expect.objectContaining({ code: "invalid_usage_query" }));
    expect(() => validateOfficialUsageOverviewOptions({ sortDirection: "desc; delete" as never }))
      .toThrowError(expect.objectContaining({ code: "invalid_usage_query" }));
  });

  it("returns report-wide summary and a bounded page within one read-only repeatable-read transaction", async () => {
    const { service, database, client, row } = databaseFixture();
    const view = await service.getOverview("tenant-A", {
      search: "Report-A", startDate: "2026-06-01", endDate: "2026-06-30", limit: 5, offset: 10,
    });
    expect(view).toEqual({
      revision: 12,
      summary: {
        retainedSets: 2, reportedAgents: 3, usedAgents: 2, activeAgents30Days: 1, undatedAgents: 1,
        earliestActivityDateUtc: "2026-06-01", latestActivityDateUtc: "2026-07-15",
        asOf: "2026-07-15T21:15:00.000Z", activeSinceDateUtc: "2026-06-16",
      },
      agents: { value: row.agents, count: 1, limit: 5, offset: 10 },
      filters: {
        search: "Report-A", startDate: "2026-06-01", endDate: "2026-06-30",
        sortBy: "lastActivity", sortDirection: "desc",
      },
    });
    expect(database.connect).toHaveBeenCalledTimes(1);
    expect(database.query).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query.mock.calls[0]).toEqual(["BEGIN"]);
    expect(client.query.mock.calls[1]).toEqual(["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
    expect(client.query.mock.calls[3]).toEqual(["COMMIT"]);
    const [sql, parameters] = client.query.mock.calls[2]!;
    expect(parameters).toEqual(["tenant-A", "2026-06-01", "2026-06-30", "Report-A", "2026-06-16", "2026-07-15", 5, 10]);
    expect(sql).toContain("count(DISTINCT version_id)");
    expect(sql).toContain("left(nullif(fact.row_data->>'lastActivityDateUtc',''),10) AS activity_date");
    expect(sql).toContain("LIMIT $7 OFFSET $8");
    expect(sql).toContain('last_activity desc NULLS LAST,agent_id COLLATE "C" ASC');
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|sum)\s*\(/i);
    expect(sql).not.toContain("username");
    expect(client.release).toHaveBeenCalledOnce();
    expect(JSON.stringify(view)).not.toMatch(/totalResponses|responsesSentToUsers|username/);
  });

  it("keeps dates unknown-last for both sort directions and parameterizes literal search", async () => {
    const { service, client } = databaseFixture();
    await service.getOverview("tenant", { sortDirection: "asc", search: "%'; SELECT" });
    expect(client.query.mock.calls[2]?.[0]).toContain('last_activity asc NULLS LAST,agent_id COLLATE "C" ASC');
    expect(client.query.mock.calls[2]?.[0]).not.toContain("%'; SELECT");
    expect(client.query.mock.calls[2]?.[1]).toContain("%'; SELECT");
  });

  it("excludes superseded sources using accepted correction markers even without retained correction payloads", async () => {
    const { service, client } = databaseFixture();
    await service.getOverview("tenant");
    const sql = String(client.query.mock.calls[2]?.[0]).replace(/\s+/g, " ");
    expect(sql).toContain(
      "AND NOT EXISTS ( SELECT 1 FROM official_usage_sets replacement" +
      " WHERE replacement.tenant_id=report_set.tenant_id AND replacement.supersedes_set_id=report_set.id" +
      " AND replacement.complete AND replacement.accepted_at IS NOT NULL )",
    );
  });

  it("rolls back and releases the client when the aggregate query fails", async () => {
    const { service, client } = databaseFixture();
    client.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("WITH")) throw new Error("read failed");
      return { rows: [] };
    });
    await expect(service.getOverview("tenant")).rejects.toThrow("read failed");
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects missing tenant scope before all reads", async () => {
    const { service, database } = databaseFixture();
    await expect(service.getOverview("")).rejects.toMatchObject({ status: 403, code: "scope_mismatch" });
    expect(database.connect).not.toHaveBeenCalled();
  });
});
