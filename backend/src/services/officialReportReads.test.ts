import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { schemaRegistry } from "./officialReportFields.js";
import { LargeTenantUsersReports, reportQuery } from "./largeTenantUsersReports.js";
import type { ReportQuery } from "../types/officialReportData.js";

const secret = "synthetic-native-report-read-contract-secret";
describe.each(["history", "overview"] as const)("%s query admission", endpoint => {
  const rejected = [
    { offset: 0 }, { offset: 100000 }, { all: true }, { tenantId: "other" }, { limit: 101 },
    { search: ["one", "two"] }, { search: { name: "test" } }, { search: "x".repeat(257) },
    { search: "test\nname" }, { search: "test\0name" }, { sort: "responses" }, { sort: "" },
    { order: "DESC" }, { order: "desc; delete" }, { startDate: "" }, { endDate: "" },
    { startDate: "2026-6-01" }, { startDate: "2026-02-29" }, { startDate: "2024-02-30" },
    { endDate: "2026-04-31" }, { startDate: "2026-00-01" }, { startDate: "2026-13-01" },
    { endDate: "2026-07-15T00:00:00Z" }, { startDate: "2026-07-16", endDate: "2026-07-15" },
    { scope: "all" }, { scope: ["history", "selected"] }, { creatorType: "Custom" },
  ];
  it.each(rejected)("rejects unsupported intent before acquiring a database connection: %j", async input => {
    const database = { options: { max: 4 }, connect: vi.fn().mockRejectedValue(new Error("No database work for invalid intent")) };
    const reports = new LargeTenantUsersReports(database as unknown as pg.Pool, secret, 35);
    await expect(reports.capture(selectionIdentity, "delegated", endpoint, input as ReportQuery)).rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
    expect(database.connect).not.toHaveBeenCalled();
  });
  it("normalizes literal search and uses the frozen cursor-order defaults", () => {
    expect(reportQuery(endpoint, { search: "  %_Name " })).toEqual({ search: "%_name",
      sort: endpoint === "history" ? "acceptedAt" : "name", order: endpoint === "history" ? "desc" : "asc",
      lowResponseThreshold: 5, inactiveDays: 30, activityWindowDays: 30 });
    if (endpoint === "overview") expect(reportQuery(endpoint, { startDate: "2024-02-29", endDate: "2024-02-29", scope: "selected" }))
      .toMatchObject({ startDate: "2024-02-29", endDate: "2024-02-29", scope: "selected" });
  });
  it.each(["tenantId", "principalId", "authorizationHash"] as const)("rejects an empty %s before persistence", async field => {
    const database = { options: { max: 4 }, connect: vi.fn().mockRejectedValue(new Error("No unscoped persistence")) };
    const reports = new LargeTenantUsersReports(database as unknown as pg.Pool, secret, 35);
    await expect(reports.capture({ ...selectionIdentity, [field]: "" }, "delegated", endpoint)).rejects.toMatchObject({ status: 403, code: "scope_mismatch" });
    expect(database.connect).not.toHaveBeenCalled();
  });
});

describe("native history/overview snapshot execution", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>, reports: LargeTenantUsersReports;
  beforeAll(async () => {
    fixture = await testDatabase(); reports = new LargeTenantUsersReports(fixture.runtime, secret, 35);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  async function selected(endpoint: "history" | "overview") {
    const identity = { ...selectionIdentity, tenantId: `read-contract-${randomUUID()}` };
    const imports = new OfficialReportImports(fixture.runtime), bundleId = randomUUID();
    for (const kind of ["agents", "userAgents", "users"] as const) {
      const row = kind === "agents" ? "agent,Agent,Your org,1,0,1,"
        : kind === "userAgents" ? "agent,Agent,Your org,user,1," : "user,User,1,1,";
      await imports.stage(identity, { bundleId }, (async function* () { yield Buffer.from(schemaRegistry[kind].headers.join(",") + "\n" + row + "\n"); })());
    }
    const accepted = await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
    return { identity, set: { id: accepted.setId }, selection: await reports.capture(identity, "delegated", endpoint) };
  }
  async function instrument(failure?: (sql: string) => Error | undefined) {
    const client = await fixture.runtime.connect(), execute = client.query.bind(client), statements: string[] = [];
    const query = vi.spyOn(client, "query").mockImplementation(((...args: unknown[]) => {
      const sql = String(args[0]); statements.push(sql);
      const error = failure?.(sql);
      return error ? Promise.reject(error) : Reflect.apply(execute, client, args);
    }) as typeof client.query);
    const release = vi.spyOn(client, "release"), connect = vi.spyOn(fixture.runtime, "connect").mockResolvedValue(client);
    return { client, statements, release, connect, restore: () => { connect.mockRestore(); query.mockRestore(); release.mockRestore(); } };
  }
  it("reads selector options without user joins or whole-history row analytics, while retaining selection fences", async () => {
    const { identity, selection } = await selected("history");
    const full = await reports.page(selection.id, identity);
    const tape = await instrument();
    try {
      const options = await reports.historyOptions(selection.id, identity);
      expect(Object.keys(options).sort()).toEqual(["counts", "page", "reports", "selection", "value"]);
      expect(options).toEqual({ value: full.value, page: full.page, counts: full.counts, selection: full.selection, reports: full.reports });
      expect(tape.statements.some(sql => /directory_user_rows|official_usage_row_facts|envelope_summary/.test(sql))).toBe(false);
      expect(tape.connect).toHaveBeenCalledOnce();
      expect(tape.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
      expect(tape.statements.at(-1)).toBe("COMMIT");
    } finally { tape.restore(); }
    await expect(reports.historyOptions(selection.id, { ...identity, principalId: "other" })).rejects.toMatchObject({ code: "selection_invalidated" });
    const overview = await reports.capture(identity, "delegated", "overview");
    await expect(reports.historyOptions(overview.id, identity)).rejects.toMatchObject({ code: "invalid_cursor" });
    await fixture.operator.query("UPDATE data_read_selections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [selection.id]);
    await expect(reports.historyOptions(selection.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
  });
  it.each(["history", "overview"] as const)("returns %s rows, counts and analytics on one client and repeatable-read snapshot", async endpoint => {
    const { identity, selection } = await selected(endpoint), tape = await instrument();
    try {
      const page = await reports.read(selection.id, identity, async (client, context) => {
        expect(client).toBe(tape.client);
        const before = (await client.query("SELECT current_setting('transaction_isolation') AS isolation,pg_current_snapshot()::text AS snapshot")).rows[0];
        const page = await reports.pageInRead(client, context, { limit: 1 });
        const after = (await client.query("SELECT current_setting('transaction_isolation') AS isolation,pg_current_snapshot()::text AS snapshot")).rows[0];
        expect(before).toEqual(after); expect(before.isolation).toBe("repeatable read");
        expect(page.selection.evaluatedAt).toBe(context.evaluatedAt.toISOString());
        return page;
      });
      expect(page.value).toHaveLength(1); expect(page.counts).toEqual({ total: 1, filtered: 1 });
      expect(page.analytics).toMatchObject({ basis: "filtered_rows", rowCount: 1, responses: null });
      if (endpoint === "history") expect(page.analytics.history).toMatchObject({ additive: false, activityRangeProvesCoverage: false });
      else expect(page.analytics.overview?.asOf).toBe(page.selection.evaluatedAt);
      expect(tape.connect).toHaveBeenCalledOnce(); expect(tape.release).toHaveBeenCalledOnce();
      expect(tape.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ"); expect(tape.statements.at(-1)).toBe("COMMIT");
      expect(tape.statements.filter(sql => /(?:INSERT INTO|UPDATE|DELETE FROM) official_usage_(?:sets|versions|row_facts|version_rows)\b/.test(sql))).toEqual([]);
    } finally { tape.restore(); }
  });
  const boundaries = [
    ["metadata", (sql: string) => sql.startsWith("SELECT s.endpoint,s.query_json")],
    ["counts", (sql: string) => sql.includes("::text AS count_total,") && sql.includes("::text AS count_filtered,")],
    ["rows", (sql: string) => sql.includes("candidate AS MATERIALIZED")],
    ["analytics", (sql: string) => sql.includes("AS unknown FROM filtered")],
    ["commit", (sql: string) => sql === "COMMIT"],
  ] as const;
  describe.each(["history", "overview"] as const)("%s failure boundaries", endpoint => {
    it.each(boundaries)("rolls back and releases the same client after %s failure, with no replay", async (_name, match) => {
      const { identity, selection } = await selected(endpoint), failure = new Error("synthetic selected read failed");
      let failures = 0;
      const tape = await instrument(sql => { if (match(sql)) { failures++; return failure; } });
      try {
        await expect(reports.page(selection.id, identity)).rejects.toBe(failure);
        expect(failures).toBe(1); expect(tape.connect).toHaveBeenCalledOnce(); expect(tape.release).toHaveBeenCalledOnce();
        expect(tape.statements.at(-1)).toBe("ROLLBACK");
      } finally { tape.restore(); }
    });
    it("maps serialization failure to an explicit five-second 503 without weaker isolation or replay", async () => {
      const { identity, selection } = await selected(endpoint), failure = Object.assign(new Error("synthetic serialization conflict"), { code: "40001" });
      let failures = 0;
      const tape = await instrument(sql => { if (sql.includes("candidate AS MATERIALIZED")) { failures++; return failure; } });
      try {
        await expect(reports.page(selection.id, identity)).rejects.toMatchObject({ status: 503, code: "data_read_conflict", retryAfterSeconds: 5, cause: failure });
        expect(failures).toBe(1); expect(tape.connect).toHaveBeenCalledOnce(); expect(tape.release).toHaveBeenCalledOnce();
        expect(tape.statements.at(-1)).toBe("ROLLBACK");
        expect(tape.statements.filter(sql => sql.startsWith("BEGIN"))).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ"]);
      } finally { tape.restore(); }
    });
  });
  it("uses a separately bounded observation page on the same pinned history, not an embedded report graph", async () => {
    const { identity, selection, set } = await selected("history");
    const parent = await reports.page(selection.id, identity, { limit: 1 });
    expect(parent.value[0]).not.toHaveProperty("observations");
    const first = await reports.page(selection.id, identity, { endpoint: "observations", child: set.id, limit: 1 });
    expect(first.counts).toEqual({ total: 3, filtered: 3 }); expect(first.value).toHaveLength(1);
    expect(first.page.nextCursor).toEqual(expect.any(String));
    const failure = new Error("synthetic observation read failed");
    const tape = await instrument(sql => sql.includes("candidate AS MATERIALIZED") ? failure : undefined);
    try {
      await expect(reports.page(selection.id, identity, { endpoint: "observations", child: set.id, limit: 1, cursor: first.page.nextCursor! })).rejects.toBe(failure);
      expect(tape.connect).toHaveBeenCalledOnce(); expect(tape.release).toHaveBeenCalledOnce(); expect(tape.statements.at(-1)).toBe("ROLLBACK");
    } finally { tape.restore(); }
  });
});
