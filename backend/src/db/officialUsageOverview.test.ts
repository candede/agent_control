import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixturePassword, testDatabase } from "../../scripts/testDatabase.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { retainUntilConverged } from "../../scripts/database.js";
import { OfficialReportImports } from "./officialReportImports.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { schemaRegistry } from "../services/officialReportFields.js";
import type { OfficialUsageMetadata } from "../types/officialReportRecords.js";
import type { ReportAgent, ReportOverviewAgent, ReportPage, ReportQuery } from "../types/officialReportData.js";
import type { SelectionIdentity } from "../services/dataSelections.js";

type Observation = { id: string; name?: string; creator?: string; responses?: number; date?: string; username?: string };
type BundleInput = {
  agents: Observation[]; relationships?: Observation[]; userResponses?: number;
  metadata?: OfficialUsageMetadata; correctionOfSetId?: string;
};
const kinds = ["agents", "userAgents", "users"] as const;
let fixture: Awaited<ReturnType<typeof testDatabase>>, imports: OfficialReportImports, reports: LargeTenantUsersReports, today: Date;
beforeAll(async () => {
  fixture = await testDatabase(); imports = new OfficialReportImports(fixture.runtime);
  reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-native-overview-regression-secret", 35);
  today = (await fixture.runtime.query("SELECT clock_timestamp() AS now")).rows[0].now;
}, 30_000);
afterAll(async () => { await fixture?.close(); });
const owner = (): SelectionIdentity => ({ ...selectionIdentity, tenantId: `native-overview-${randomUUID()}` });
const day = (offset = 0) => new Date(today.getTime() + offset * 86400000).toISOString().slice(0, 10);
const window = (start: number, end: number): OfficialUsageMetadata => ({
  reportingPeriod: { startDate: day(start), endDate: day(end), provenance: "operator_asserted" },
});
async function stage(identity: SelectionIdentity, input: BundleInput, kind: typeof kinds[number], bundleId: string) {
  async function* csv() {
    yield Buffer.from(schemaRegistry[kind].headers.join(",") + "\n");
    const encode = (values: string[]) => Buffer.from(values.map(value => `"${value.replaceAll('"', '""')}"`).join(",") + "\n");
    if (kind === "users") yield encode(["user-only", "User only", "1", String(input.userResponses ?? 3), day()]);
    else for (const [index, observation] of (kind === "agents" ? input.agents : input.relationships ?? input.agents).entries()) {
      yield encode([observation.id, observation.name ?? observation.id, observation.creator ?? "Your org",
        ...(kind === "agents" ? ["1", "0"] : [observation.username ?? `user-${index}`]),
        String(observation.responses ?? 3), observation.date ?? ""]);
    }
  }
  return imports.stage(identity, { bundleId, correctionOfSetId: input.correctionOfSetId }, csv(), input.metadata);
}
async function accept(identity: SelectionIdentity, input: BundleInput) {
  const bundleId = randomUUID();
  for (const kind of kinds) await stage(identity, input, kind, bundleId);
  return imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
}
const mutate = async (identity: SelectionIdentity, setId: string, operation: "select" | "delete") =>
  imports.confirm(identity, await imports.confirmPreview(identity, setId, operation));
async function overview(identity: SelectionIdentity, query: ReportQuery = {}, limit = 50, authority = reports) {
  const selection = await authority.capture(identity, "delegated", "overview", query);
  return authority.page(selection.id, identity, { limit }) as Promise<ReportPage<ReportOverviewAgent>>;
}
async function agents(identity: SelectionIdentity, setId: string) {
  const selection = await reports.capture(identity, "delegated", "official_agents", { setId });
  return reports.page(selection.id, identity) as Promise<ReportPage<ReportAgent>>;
}
async function historyCount(identity: SelectionIdentity) {
  const selection = await reports.capture(identity, "delegated", "history");
  return (await reports.page(selection.id, identity)).counts.total;
}

describe("native cumulative overview SQL", () => {
  it("changes selected-set metrics without merging history or silently falling back after deletion", async () => {
    const identity = owner(), first = await accept(identity, { agents: [{ id: "older-only", date: day(-44) }, { id: "shared", date: day() }] });
    const second = await accept(identity, { agents: [{ id: "newer-only", date: day() }] });
    expect((await overview(identity)).analytics.overview?.reportedAgents).toBe(3);
    const selected = await overview(identity, { scope: "selected" });
    expect(selected.analytics.overview).toMatchObject({ retainedSets: 1, reportedAgents: 1, usedAgents: 1, active30Days: 1 });
    expect(selected.value).toMatchObject([{ agentId: "newer-only", latestSetId: second.setId }]);
    await mutate(identity, first.setId, "select");
    expect((await overview(identity, { scope: "selected" })).analytics.overview)
      .toMatchObject({ retainedSets: 1, reportedAgents: 2, usedAgents: 2, active30Days: 1 });
    await mutate(identity, first.setId, "delete");
    await expect(reports.page(selected.selection.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    expect((await overview(identity, { scope: "selected" })).analytics.overview).toMatchObject({ retainedSets: 0, reportedAgents: 0 });
    expect((await overview(identity)).analytics.overview?.reportedAgents).toBe(1);
  });

  it("permits explicit superseded snapshots without reviving them in cumulative evidence", async () => {
    const identity = owner(), first = await accept(identity, { agents: [{ id: "original", date: day(-14) }] });
    await accept(identity, { agents: [{ id: "corrected", date: day() }], correctionOfSetId: first.setId });
    await mutate(identity, first.setId, "select");
    expect((await overview(identity, { scope: "selected" })).value).toMatchObject([{ agentId: "original" }]);
    expect((await overview(identity)).value).toMatchObject([{ agentId: "corrected" }]);
  });

  it("preserves a 45-day union of overlapping 30-day snapshots without adding responses", async () => {
    const identity = owner(), dates = Array.from({ length: 45 }, (_, index) => day(index - 44));
    const input = (start: number, end: number, name: string, date: string, responses: number): BundleInput => ({
      agents: [...dates.slice(start, start + 30).map(date => ({ id: `day-${date}`, date })), { id: "shared", name, date, responses }],
      metadata: window(start - 44, end),
    });
    const first = await accept(identity, input(0, -15, "Earlier shared", day(-35), 7));
    const secondInput = input(15, 0, "Latest shared", day(), 11), second = await accept(identity, secondInput);
    const view = await overview(identity, {}, 100);
    expect(view.analytics.overview).toEqual({
      retainedSets: 2, reportedAgents: 46, usedAgents: 46, active30Days: 31, undatedAgents: 0,
      earliestActivityDateUtc: day(-44), latestActivityDateUtc: day(),
      asOf: view.selection.evaluatedAt, activeSinceDateUtc: day(-29),
    });
    expect(view.counts).toEqual({ total: 46, filtered: 46 });
    expect(view.value.find(row => row.agentId === `day-${day(-44)}`)).toMatchObject({ observationCount: 2, latestSetId: first.setId });
    expect(view.value.find(row => row.agentId === `day-${day(-29)}`)).toMatchObject({ observationCount: 4, latestSetId: second.setId });
    expect(view.value.find(row => row.agentId === "shared")).toMatchObject({ agentName: "Latest shared", observationCount: 4, latestSetId: second.setId });
    expect(view.analytics.responses).toBeNull();
    expect(JSON.stringify(view.value)).not.toMatch(/responsesSentToUsers|totalResponses|username|activeUsers/);
    expect((await agents(identity, first.setId)).value.find(row => row.agentId === "shared")?.responses).toBe(7);
    expect((await agents(identity, second.setId)).value.find(row => row.agentId === "shared")?.responses).toBe(11);
    const earlier = await overview(identity, { search: "shared", startDate: day(-35), endDate: day(-35) });
    expect(earlier.analytics).toMatchObject({ basis: "filtered_rows", rowCount: 1, overview: { reportedAgents: 1 } });
    expect(earlier.value).toMatchObject([{ agentId: "shared", agentName: "Earlier shared", observationCount: 2, latestSetId: first.setId }]);
    const paged = await overview(identity, {}, 25);
    expect(paged.value).toHaveLength(25); expect(paged.page.nextCursor).toEqual(expect.any(String));
    expect((await reports.page(paged.selection.id, identity, { limit: 25, cursor: paged.page.nextCursor! })).value).toHaveLength(21);
    expect((await accept({ ...identity, principalId: "another-administrator" }, secondInput)).setId).toBe(second.setId);
    const repeated = await overview(identity, {}, 100);
    expect(repeated.value).toEqual(view.value); expect(repeated.reports.historyRevision).toBe(view.reports.historyRevision);
  });

  it("counts reused versions once despite overlapping retained sets and multiple relationship identities", async () => {
    const identity = owner(), input: BundleInput = { agents: [{ id: "same-agent", date: day() }],
      relationships: ["CaseUser", "caseuser", "third-user"].map(username => ({ id: "same-agent", username, date: day() })) };
    const first = await accept(identity, input), second = await accept(identity, { ...input, userResponses: 9 });
    expect(first.setId).not.toBe(second.setId);
    const view = await overview(identity);
    expect(view.analytics.overview).toMatchObject({ retainedSets: 2, reportedAgents: 1, usedAgents: 1, active30Days: 1 });
    expect(view.value).toMatchObject([{ agentId: "same-agent", observationCount: 2, creatorTypeCount: 1, latestSetId: second.setId }]);
    expect((await fixture.runtime.query(`SELECT kind,count(DISTINCT version_id)::int AS versions FROM official_usage_set_versions
      WHERE tenant_id=$1 GROUP BY kind ORDER BY kind`, [identity.tenantId])).rows).toEqual([
      { kind: "agents", versions: 1 }, { kind: "userAgents", versions: 1 }, { kind: "users", versions: 2 },
    ]);
    await mutate(identity, second.setId, "delete");
    expect((await overview(identity)).value[0]).toMatchObject({ latestSetId: first.setId, observationCount: 2 });
  });

  it("keeps exact case-distinct agent identities and creator type counts without including Users scalars", async () => {
    const identity = owner();
    await accept(identity, { agents: [{ id: "Case", creator: "z type", responses: 0, date: day() }, { id: "case", creator: "A type", date: day() }],
      relationships: [{ id: "Case", creator: "A type", username: "one", date: day() },
        { id: "Case", creator: "z type", username: "two", date: day() }, { id: "relationship-only", creator: "Other", date: day() }],
      userResponses: 999999 });
    const view = await overview(identity, { sort: "name", order: "asc" });
    expect(view.analytics.overview).toMatchObject({ reportedAgents: 3, usedAgents: 3, active30Days: 3 });
    expect(view.value.map(row => row.agentId)).toEqual(["Case", "case", "relationship-only"]);
    expect(view.value[0]).toMatchObject({ creatorTypeCount: 2, observationCount: 2, hasResponses: true });
    expect(view.value[2]).toMatchObject({ observationCount: 1, creatorTypeCount: 1 });
  });

  it("uses positive dated evidence on exactly 30 UTC dates, not upload time or mixed-row inference", async () => {
    const identity = owner(), agents = [
      { id: "inclusive-start", date: day(-29) }, { id: "stale", date: day(-30) }, { id: "inclusive-today", date: day() },
      { id: "future", date: day(1) }, { id: "undated" }, { id: "dated-zero", responses: 0, date: day() },
      { id: "mixed", date: day(-30) }, { id: "partly-dated" },
    ];
    const accepted = await accept(identity, { agents,
      relationships: [{ id: "mixed", responses: 0, date: day() }, { id: "partly-dated", responses: 0, date: day() }] });
    await fixture.operator.query("UPDATE official_usage_sets SET accepted_at=$2 WHERE id=$1", [accepted.setId, today]);
    const check = async (authority = reports) => {
      const view = await overview(identity, {}, 50, authority);
      expect(view.analytics.overview).toMatchObject({ reportedAgents: 8, usedAgents: 7, active30Days: 2, undatedAgents: 1,
        earliestActivityDateUtc: day(-30), latestActivityDateUtc: day(1), activeSinceDateUtc: day(-29) });
      expect(view.value.find(row => row.agentId === "mixed")).toMatchObject({ hasResponses: true, lastActivityDateUtc: day(), active30Days: false });
      expect(view.value.find(row => row.agentId === "undated")).toMatchObject({ hasResponses: true, lastActivityDateUtc: null, active30Days: false });
    };
    await check();
    expect((await overview(identity, { startDate: day(-29), endDate: day() })).value.map(row => row.agentId).sort())
      .toEqual(["dated-zero", "inclusive-start", "inclusive-today", "mixed", "partly-dated"]);
    const zoned = new pg.Pool({ ...fixture.runtime.options, password: fixturePassword, max: 4,
      options: `-c timezone=${today.getUTCHours() < 12 ? "Etc/GMT+12" : "Etc/GMT-14"}` });
    try { await check(new LargeTenantUsersReports(zoned, "synthetic-native-overview-regression-secret", 35)); }
    finally { await zoned.end(); }
  });

  it("searches retained observations literally and pages stable ties with unknown dates last", async () => {
    const identity = owner(), first = await accept(identity, { agents: [{ id: "A", name: "Historical label", date: day(-44) },
      { id: "only-old", name: "Archive only", date: day(-44) }] });
    await accept(identity, { agents: [{ id: "A", name: "Same", date: day() }, { id: "a", name: "Same", date: day() },
      { id: "unknown", name: "Same" }, { id: "literal", name: "100%_literal", date: day(-1) }] });
    expect((await overview(identity, { search: "HISTORICAL LABEL" })).value)
      .toMatchObject([{ agentId: "A", agentName: "Historical label", lastActivityDateUtc: day(-44), observationCount: 2, latestSetId: first.setId }]);
    expect((await overview(identity, { search: "%_" })).value.map(row => row.agentId)).toEqual(["literal"]);
    expect((await overview(identity, { search: "archive" })).value[0]).toMatchObject({ agentId: "only-old", latestSetId: first.setId });
    for (const order of ["asc", "desc"] as const) {
      const expected = order === "asc" ? ["only-old", "literal", "A", "a", "unknown"] : ["A", "a", "literal", "only-old", "unknown"];
      const full = await overview(identity, { sort: "lastActivity", order }, 100), page = await overview(identity, { sort: "lastActivity", order }, 2);
      expect(full.value.map(row => row.agentId)).toEqual(expected);
      const second = await reports.page(page.selection.id, identity, { limit: 2, cursor: page.page.nextCursor! }) as ReportPage<ReportOverviewAgent>;
      expect(second.value.map(row => row.agentId)).toEqual(expected.slice(2, 4));
      expect(second.analytics).toEqual(page.analytics); expect(second.counts).toEqual({ total: 5, filtered: 5 });
      expect((await overview(identity, { search: "same", sort: "name", order })).value.map(row => row.agentId)).toEqual(["A", "a", "unknown"]);
      const tied = await overview(identity, { search: "same", sort: "name", order }, 1);
      const next = await reports.page(tied.selection.id, identity, { limit: 1, cursor: tied.page.nextCursor! });
      expect(next.value).toMatchObject([{ agentId: "a" }]);
      expect((await reports.page(tied.selection.id, identity, { limit: 1, cursor: next.page.previousCursor! })).value).toMatchObject([{ agentId: "A" }]);
    }
    expect((await overview(identity, { startDate: day(1) })).counts.filtered).toBe(0);
  });

  it("searches non-ASCII names and IDs case-insensitively without merging their identities", async () => {
    const identity = owner();
    await accept(identity, { agents: [{ id: "ПАКЕТ", name: "ÉQUIPE %_ Nord", date: day() },
      { id: "пакет", name: "équipe %_ Sud", date: day() }, { id: "other", name: "Other", date: day() }] });
    for (const search of ["пакет", "ПАКЕТ", "équipe", "ÉQUIPE", "%_"]) {
      const view = await overview(identity, { search });
      expect(view.counts.filtered, search).toBe(2); expect(view.value.map(row => row.agentId), search).toEqual(["ПАКЕТ", "пакет"]);
    }
  });

  it("uses set-ID tie-breaking for the newest accepted name without erasing the historical activity maximum", async () => {
    const identity = owner(), first = await accept(identity, { agents: [{ id: "shared", name: "First", date: day(-14) }] });
    const second = await accept(identity, { agents: [{ id: "shared", name: "Second", date: day(-13) }] });
    await fixture.operator.query("UPDATE official_usage_sets SET accepted_at=$2 WHERE tenant_id=$1", [identity.tenantId, today]);
    const latest = first.setId > second.setId ? first : second;
    expect((await overview(identity)).value[0]).toMatchObject({ agentId: "shared", agentName: latest === first ? "First" : "Second",
      lastActivityDateUtc: day(-13), latestSetId: latest.setId, latestAcceptedAt: today.toISOString() });
  });

  it("excludes deleted, partial, foreign, missing-membership and broken-version evidence", async () => {
    const identity = owner(), keep = await accept(identity, { agents: [{ id: "keep", date: day() }] });
    const deleted = await accept(identity, { agents: [{ id: "deleted", date: day() }] });
    await mutate(identity, deleted.setId, "delete");
    const partial = await stage(identity, { agents: [{ id: "incomplete", date: day() }] }, "agents", randomUUID());
    await imports.accept(identity, { stagingId: partial.id, revision: partial.revision, contentHash: partial.contentHash, expectedActiveRevision: partial.activeRevision });
    const broken = await accept(identity, { agents: [{ id: "orphan-fact", date: day() }] });
    await fixture.operator.query(`DELETE FROM official_usage_version_rows r USING official_usage_set_versions m
      WHERE m.set_id=$1 AND m.kind='agents' AND r.version_id=m.version_id`, [broken.setId]);
    const missing = await accept(identity, { agents: [{ id: "missing-kind", date: day() }] });
    await fixture.operator.query("DELETE FROM official_usage_set_versions WHERE set_id=$1 AND kind='users'", [missing.setId]);
    const dead = await accept(identity, { agents: [{ id: "deleted-version", date: day() }] });
    await fixture.operator.query(`UPDATE official_usage_versions SET deleted_at=clock_timestamp()
      WHERE id=(SELECT version_id FROM official_usage_set_versions WHERE set_id=$1 AND kind='agents')`, [dead.setId]);
    await accept(owner(), { agents: [{ id: "foreign-only", date: day() }] });
    const view = await overview(identity);
    expect(view.analytics.overview).toMatchObject({ retainedSets: 1, reportedAgents: 1, usedAgents: 1, active30Days: 1 });
    expect(view.value).toMatchObject([{ agentId: "keep", latestSetId: keep.setId }]);
  });

  it("never revives superseded evidence after deleting the correction or purging its payloads", async () => {
    const identity = owner(), metadata = window(-6, 0);
    const first = await accept(identity, { metadata, agents: [{ id: "incorrect", date: day(), responses: 999 }] });
    const second = await accept(identity, { metadata, correctionOfSetId: first.setId, agents: [{ id: "intermediate", date: day(-1) }] });
    const final = await accept(identity, { metadata, correctionOfSetId: second.setId, agents: [{ id: "correct", date: day(-44) }] });
    expect((await overview(identity)).value).toMatchObject([{ agentId: "correct", latestSetId: final.setId }]);
    expect((await agents(identity, first.setId)).value).toMatchObject([{ agentId: "incorrect", responses: 999 }]);
    expect(await historyCount(identity)).toBe(3);
    await mutate(identity, final.setId, "delete");
    expect((await overview(identity)).analytics.overview).toMatchObject({ retainedSets: 0, reportedAgents: 0, usedAgents: 0,
      active30Days: 0, undatedAgents: 0, earliestActivityDateUtc: null, latestActivityDateUtc: null });
    expect(await historyCount(identity)).toBe(2);
    await fixture.operator.query("UPDATE data_read_selections SET invalidated_at=clock_timestamp() WHERE tenant_id=$1", [identity.tenantId]);
    await fixture.operator.query("UPDATE official_usage_sets SET deleted_at=clock_timestamp()-interval '91 days' WHERE id=$1", [final.setId]);
    await fixture.operator.query("UPDATE official_usage_versions SET deleted_at=clock_timestamp()-interval '91 days' WHERE tenant_id=$1 AND deleted_at IS NOT NULL", [identity.tenantId]);
    await retainUntilConverged(fixture.operator);
    expect((await overview(identity)).analytics.overview?.reportedAgents).toBe(0);
    expect((await agents(identity, first.setId)).value).toMatchObject([{ agentId: "incorrect" }]);
    expect((await fixture.runtime.query("SELECT supersedes_set_id,complete FROM official_usage_sets WHERE id=$1", [final.setId])).rows)
      .toEqual([{ supersedes_set_id: second.setId, complete: true }]);
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM official_usage_set_versions WHERE set_id=$1", [final.setId])).rows).toEqual([{ n: 0 }]);
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM official_usage_row_facts WHERE tenant_id=$1 AND agent_id='correct'", [identity.tenantId])).rows).toEqual([{ n: 0 }]);
  });

  it("returns explicit zero evidence with a captured time and no inferred response totals", async () => {
    const view = await overview(owner(), { search: "none" }, 1);
    expect(view.analytics.overview).toEqual({ retainedSets: 0, reportedAgents: 0, usedAgents: 0, active30Days: 0, undatedAgents: 0,
      earliestActivityDateUtc: null, latestActivityDateUtc: null, asOf: view.selection.evaluatedAt, activeSinceDateUtc: day(-29) });
    expect(view.analytics.responses).toBeNull(); expect(view.counts).toEqual({ total: 0, filtered: 0 });
    expect(view.value).toEqual([]); expect(view.page).toEqual({ limit: 1, nextCursor: null, previousCursor: null });
  });
});
