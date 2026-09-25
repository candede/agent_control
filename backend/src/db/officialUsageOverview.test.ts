import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retainUntilConverged } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { OfficialUsageHistoryService } from "../services/officialUsageHistory.js";
import { OfficialUsageOverviewService } from "../services/officialUsageOverview.js";
import { parseOfficialUsageReport } from "../services/officialUsageParser.js";
import type { OfficialUsageMetadata, OfficialUsageReportKind } from "../types/officialUsage.js";
import { OfficialUsageRepository, type OfficialUsageScope } from "./officialUsage.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: OfficialUsageRepository;
let overview: OfficialUsageOverviewService;
const now = () => new Date("2026-07-16T01:15:00+04:00");

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new OfficialUsageRepository(fixture.runtime);
  overview = new OfficialUsageOverviewService(fixture.runtime, now);
});
afterAll(async () => { await fixture?.close(); });

type Observation = { id: string; name?: string; creator?: string; responses?: number; date?: string; username?: string };
type BundleInput = {
  agents: Observation[];
  relationships?: Observation[];
  userResponses?: number;
  metadata?: OfficialUsageMetadata;
  correctionOfSetId?: string;
};

function scope(): OfficialUsageScope {
  return { tenantId: `overview-${randomUUID()}`, principalId: "overview-administrator" };
}

function reportCsv(kind: OfficialUsageReportKind, input: BundleInput) {
  const headers = {
    agents: "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)",
    userAgents: "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)",
    users: "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)",
  };
  const observations = kind === "userAgents" ? input.relationships ?? input.agents : input.agents;
  const rows = kind === "users"
    ? [["user-only", "User only", "1", String(input.userResponses ?? 3), "2026-07-15"]]
    : observations.map((observation, index) => [
      observation.id, observation.name ?? observation.id, observation.creator ?? "Your org",
      ...(kind === "agents" ? ["1", "0"] : [observation.username ?? `user-${index}`]),
      String(observation.responses ?? 3), observation.date ?? "",
    ]);
  return [headers[kind], ...rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(","))].join("\n");
}

async function stage(owner: OfficialUsageScope, input: BundleInput, kind: OfficialUsageReportKind, bundleId: string) {
  const content = reportCsv(kind, input);
  return repository.stage(owner, {
    report: parseOfficialUsageReport(Buffer.from(content), input.metadata),
    fileHash: createHash("sha256").update(content).digest("hex"),
    bundleId,
    correctionOfSetId: input.correctionOfSetId,
  });
}

async function importBundle(owner: OfficialUsageScope, input: BundleInput) {
  const bundleId = randomUUID();
  for (const kind of ["agents", "userAgents", "users"] as const) await stage(owner, input, kind, bundleId);
  const preview = await repository.previewBundle(owner, bundleId);
  return repository.acceptBundle(owner, bundleId, preview);
}

async function deleteSet(owner: OfficialUsageScope, setId: string) {
  const preview = await repository.previewSetOperation(owner, "delete", setId);
  await repository.confirmSetOperation(owner, preview.id, { ...preview, operation: "delete", setId });
}

function window(startDate: string, endDate: string): OfficialUsageMetadata {
  return { reportingPeriod: { startDate, endDate, provenance: "operator_asserted" } };
}

describe.sequential("cumulative official agent/activity overview SQL", () => {
  it("preserves the June 1–July 15 union from overlapping snapshots without adding response totals", async () => {
    const owner = scope();
    const dates = Array.from({ length: 45 }, (_, index) =>
      new Date(Date.UTC(2026, 5, index + 1)).toISOString().slice(0, 10));
    const firstInput: BundleInput = {
      agents: [
        ...dates.slice(0, 30).map(date => ({ id: `day-${date}`, date })),
        { id: "shared", name: "Earlier shared", date: "2026-06-10", responses: 7 },
      ],
      metadata: window("2026-06-01", "2026-06-30"),
    };
    const secondInput: BundleInput = {
      agents: [
        ...dates.slice(15).map(date => ({ id: `day-${date}`, date })),
        { id: "shared", name: "Latest shared", date: "2026-07-15", responses: 11 },
      ],
      metadata: window("2026-06-16", "2026-07-15"),
    };
    const first = await importBundle(owner, firstInput);
    const second = await importBundle(owner, secondInput);
    const view = await overview.getOverview(owner.tenantId, { limit: 100 });
    expect(view.summary).toEqual({
      retainedSets: 2, reportedAgents: 46, usedAgents: 46, activeAgents30Days: 31, undatedAgents: 0,
      earliestActivityDateUtc: "2026-06-01", latestActivityDateUtc: "2026-07-15",
      asOf: "2026-07-15T21:15:00.000Z", activeSinceDateUtc: "2026-06-16",
    });
    expect(view.agents.count).toBe(46);
    expect(view.agents.value.find(agent => agent.agentId === "day-2026-06-01"))
      .toMatchObject({ observationCount: 2, latestSetId: first.setId });
    expect(view.agents.value.find(agent => agent.agentId === "day-2026-06-16"))
      .toMatchObject({ observationCount: 4, latestSetId: second.setId });
    expect(view.agents.value.find(agent => agent.agentId === "shared"))
      .toMatchObject({ agentName: "Latest shared", observationCount: 4, latestSetId: second.setId });
    expect(JSON.stringify(view)).not.toMatch(/responsesSentToUsers|totalResponses|username|activeUsers/);
    expect((await repository.getPublished(owner.tenantId, first.setId)).reports.agents?.rows.at(-1)?.responsesSentToUsers).toBe(7);
    expect((await repository.getPublished(owner.tenantId, second.setId)).reports.agents?.rows.at(-1)?.responsesSentToUsers).toBe(11);

    const earlier = await overview.getOverview(owner.tenantId, {
      search: "shared", startDate: "2026-06-10", endDate: "2026-06-10",
    });
    expect(earlier.summary).toEqual(view.summary);
    expect(earlier.agents).toMatchObject({
      count: 1, value: [{
        agentId: "shared", agentName: "Earlier shared", lastActivityDateUtc: "2026-06-10",
        latestSetId: first.setId, observationCount: 2,
      }],
    });
    const defaultPage = await overview.getOverview(owner.tenantId);
    expect(defaultPage.agents).toMatchObject({ count: 46, limit: 25, offset: 0 });
    expect(defaultPage.agents.value).toHaveLength(25);
    expect((await overview.getOverview(owner.tenantId, { limit: 25, offset: 25 })).agents.value).toHaveLength(21);

    const repeat = await importBundle({ ...owner, principalId: "another-administrator" }, secondInput);
    expect(repeat.setId).toBe(second.setId);
    expect(await overview.getOverview(owner.tenantId, { limit: 100 })).toEqual(view);
  });

  it("counts report versions once even when multiple retained sets reuse unchanged versions and relationship rows", async () => {
    const owner = scope();
    const input: BundleInput = {
      agents: [{ id: "same-agent", date: "2026-07-15" }],
      relationships: [
        { id: "same-agent", date: "2026-07-15", username: "CaseUser" },
        { id: "same-agent", date: "2026-07-15", username: "caseuser" },
        { id: "same-agent", date: "2026-07-15", username: "third-user" },
      ],
    };
    const first = await importBundle(owner, input);
    const second = await importBundle(owner, { ...input, userResponses: 9 });
    expect(first.setId).not.toBe(second.setId);
    const view = await overview.getOverview(owner.tenantId);
    expect(view.summary).toMatchObject({ retainedSets: 2, reportedAgents: 1, usedAgents: 1, activeAgents30Days: 1 });
    expect(view.agents.value).toEqual([{
      agentId: "same-agent", agentName: "same-agent", creatorTypes: ["Your org"], hasResponses: true,
      lastActivityDateUtc: "2026-07-15", observationCount: 2, latestSetId: second.setId,
      latestAcceptedAt: expect.any(String),
    }]);
    const memberships = await fixture.runtime.query<{ kind: string; versions: number }>(`SELECT kind,
      count(DISTINCT version_id)::int AS versions FROM official_usage_set_versions
      WHERE tenant_id=$1 GROUP BY kind ORDER BY kind`, [owner.tenantId]);
    expect(memberships.rows).toEqual([
      { kind: "agents", versions: 1 }, { kind: "userAgents", versions: 1 }, { kind: "users", versions: 2 },
    ]);
    await deleteSet(owner, second.setId);
    expect((await overview.getOverview(owner.tenantId)).agents.value[0])
      .toMatchObject({ latestSetId: first.setId, observationCount: 2 });
  });

  it("deduplicates exact agent IDs across evidence kinds but never merges case-distinct identities or Users rows", async () => {
    const owner = scope();
    await importBundle(owner, {
      agents: [
        { id: "Case", creator: "z type", responses: 0, date: "2026-07-15" },
        { id: "case", creator: "A type", date: "2026-07-15" },
      ],
      relationships: [
        { id: "Case", creator: "A type", date: "2026-07-15", username: "one" },
        { id: "Case", creator: "z type", date: "2026-07-15", username: "two" },
        { id: "relationship-only", creator: "Other", date: "2026-07-15" },
      ],
      userResponses: 999_999,
    });
    const view = await overview.getOverview(owner.tenantId, { sortBy: "agentName", sortDirection: "asc" });
    expect(view.summary).toMatchObject({ reportedAgents: 3, usedAgents: 3, activeAgents30Days: 3 });
    expect(view.agents.value.map(agent => agent.agentId)).toEqual(["Case", "case", "relationship-only"]);
    expect(view.agents.value[0]).toMatchObject({
      creatorTypes: ["A type", "z type"], observationCount: 2, hasResponses: true,
    });
    expect(view.agents.value[2]).toMatchObject({ observationCount: 1, creatorTypes: ["Other"] });
  });

  it("uses positive dated evidence within exactly 30 UTC calendar dates, never upload time or mixed-row inference", async () => {
    const owner = scope();
    const observations: Observation[] = [
      { id: "inclusive-start", date: "2026-06-16" },
      { id: "stale", date: "2026-06-15" },
      { id: "inclusive-today", date: "2026-07-15" },
      { id: "future", date: "2026-07-16" },
      { id: "undated" },
      { id: "dated-zero", responses: 0, date: "2026-07-15" },
      { id: "mixed", date: "2026-06-15" },
      { id: "partly-dated" },
    ];
    const imported = await importBundle(owner, {
      agents: observations,
      relationships: [
        { id: "mixed", responses: 0, date: "2026-07-15" },
        { id: "partly-dated", responses: 0, date: "2026-07-15" },
      ],
    });
    await fixture.operator.query("UPDATE official_usage_sets SET accepted_at=$2 WHERE id=$1",
      [imported.setId, now()]);
    const view = await overview.getOverview(owner.tenantId);
    expect(view.summary).toMatchObject({
      reportedAgents: 8, usedAgents: 7, activeAgents30Days: 2, undatedAgents: 1,
      earliestActivityDateUtc: "2026-06-15", latestActivityDateUtc: "2026-07-16",
      activeSinceDateUtc: "2026-06-16",
    });
    expect(view.agents.value.find(agent => agent.agentId === "mixed")).toMatchObject({
      hasResponses: true, lastActivityDateUtc: "2026-07-15",
    });
    expect((await overview.getOverview(owner.tenantId, { startDate: "2026-06-16", endDate: "2026-07-15" })).agents.value
      .map(agent => agent.agentId).sort()).toEqual(["dated-zero", "inclusive-start", "inclusive-today", "mixed", "partly-dated"]);
    const nextDay = new OfficialUsageOverviewService(fixture.runtime, () => new Date("2026-07-16T00:00:00Z"));
    expect((await nextDay.getOverview(owner.tenantId)).summary).toMatchObject({
      activeSinceDateUtc: "2026-06-17", activeAgents30Days: 2,
    });
  });

  it("searches all retained matching observations literally and paginates with stable ties and unknown dates last", async () => {
    const owner = scope();
    const first = await importBundle(owner, {
      agents: [
        { id: "A", name: "Historical label", date: "2026-06-01" },
        { id: "only-old", name: "Archive only", date: "2026-06-01" },
      ],
    });
    await importBundle(owner, {
      agents: [
        { id: "A", name: "Same", date: "2026-07-15" },
        { id: "a", name: "Same", date: "2026-07-15" },
        { id: "unknown", name: "Same" },
        { id: "literal", name: "100%_literal", date: "2026-07-14" },
      ],
    });
    const historySearch = await overview.getOverview(owner.tenantId, { search: "HISTORICAL LABEL" });
    expect(historySearch.agents).toMatchObject({
      count: 1, value: [{
        agentId: "A", agentName: "Historical label", lastActivityDateUtc: "2026-06-01",
        observationCount: 2, latestSetId: first.setId,
      }],
    });
    expect((await overview.getOverview(owner.tenantId, { search: "%_" })).agents.value.map(agent => agent.agentId)).toEqual(["literal"]);
    expect((await overview.getOverview(owner.tenantId, { search: "archive" })).agents.value[0])
      .toMatchObject({ agentId: "only-old", latestSetId: first.setId });
    for (const sortDirection of ["asc", "desc"] as const) {
      const view = await overview.getOverview(owner.tenantId, { sortDirection, limit: 100 });
      const expected = sortDirection === "asc"
        ? ["only-old", "literal", "A", "a", "unknown"]
        : ["A", "a", "literal", "only-old", "unknown"];
      expect(view.agents.value.map(agent => agent.agentId)).toEqual(expected);
      const page = await overview.getOverview(owner.tenantId, { sortDirection, limit: 2, offset: 2 });
      expect(page.agents.count).toBe(5);
      expect(page.agents.value.map(agent => agent.agentId)).toEqual(expected.slice(2, 4));
      expect(page.summary).toEqual(view.summary);
    }
    for (const sortDirection of ["asc", "desc"] as const) {
      expect((await overview.getOverview(owner.tenantId, { search: "same", sortBy: "agentName", sortDirection }))
        .agents.value.map(agent => agent.agentId)).toEqual(["A", "a", "unknown"]);
    }
    expect((await overview.getOverview(owner.tenantId, { offset: 100_000 })).agents).toMatchObject({ count: 5, value: [] });
    expect((await overview.getOverview(owner.tenantId, { startDate: "2026-08-01" })).agents).toMatchObject({ count: 0, value: [] });
  });

  it("searches non-ASCII names and IDs case-insensitively without merging case-distinct identities", async () => {
    const owner = scope();
    await importBundle(owner, {
      agents: [
        { id: "ПАКЕТ", name: "ÉQUIPE %_ Nord", date: "2026-07-15" },
        { id: "пакет", name: "équipe %_ Sud", date: "2026-07-15" },
        { id: "other", name: "Other", date: "2026-07-15" },
      ],
    });
    for (const search of ["пакет", "ПАКЕТ", "équipe", "ÉQUIPE", "%_"]) {
      const view = await overview.getOverview(owner.tenantId, { search });
      expect(view.summary.reportedAgents).toBe(3);
      expect(view.agents.count, search).toBe(2);
      expect(view.agents.value.map(agent => agent.agentId), search).toEqual(["ПАКЕТ", "пакет"]);
    }
  });

  it("selects deterministic newest accepted source snapshots even when acceptance times tie", async () => {
    const owner = scope();
    const first = await importBundle(owner, { agents: [{ id: "shared", name: "First", date: "2026-07-01" }] });
    const second = await importBundle(owner, { agents: [{ id: "shared", name: "Second", date: "2026-07-02" }] });
    await fixture.operator.query("UPDATE official_usage_sets SET accepted_at=$2 WHERE tenant_id=$1", [owner.tenantId, now()]);
    const latest = first.setId > second.setId ? first : second;
    const view = await overview.getOverview(owner.tenantId);
    expect(view.agents.value[0]).toMatchObject({
      agentId: "shared", agentName: latest === first ? "First" : "Second",
      lastActivityDateUtc: "2026-07-02", latestSetId: latest.setId, latestAcceptedAt: now().toISOString(),
    });
  });

  it("excludes deleted, incomplete, foreign-tenant, missing-membership and broken-version sets", async () => {
    const owner = scope();
    const keep = await importBundle(owner, { agents: [{ id: "keep", date: "2026-07-15" }] });
    const deleted = await importBundle(owner, { agents: [{ id: "deleted", date: "2026-07-15" }] });
    await deleteSet(owner, deleted.setId);
    const partial = await stage(owner, { agents: [{ id: "incomplete", date: "2026-07-15" }] }, "agents", randomUUID());
    await repository.accept(owner, partial.id, {
      stagingRevision: partial.revision, fileHash: partial.fileHash, expectedActiveRevision: partial.activeRevision,
    });
    const broken = await importBundle(owner, { agents: [{ id: "orphan-fact", date: "2026-07-15" }] });
    await fixture.operator.query(`DELETE FROM official_usage_version_rows row
      USING official_usage_set_versions membership
      WHERE membership.set_id=$1 AND membership.kind='agents' AND row.version_id=membership.version_id`, [broken.setId]);
    const missing = await importBundle(owner, { agents: [{ id: "missing-kind", date: "2026-07-15" }] });
    await fixture.operator.query("DELETE FROM official_usage_set_versions WHERE set_id=$1 AND kind='users'", [missing.setId]);
    const deadVersion = await importBundle(owner, { agents: [{ id: "deleted-version", date: "2026-07-15" }] });
    await fixture.operator.query(`UPDATE official_usage_versions SET deleted_at=clock_timestamp()
      WHERE id=(SELECT version_id FROM official_usage_set_versions WHERE set_id=$1 AND kind='agents')`, [deadVersion.setId]);
    await importBundle(scope(), { agents: [{ id: "foreign-only", date: "2026-07-15" }] });

    const view = await overview.getOverview(owner.tenantId);
    expect(view.summary).toMatchObject({ retainedSets: 1, reportedAgents: 1, usedAgents: 1, activeAgents30Days: 1 });
    expect(view.agents.value).toMatchObject([{ agentId: "keep", latestSetId: keep.setId }]);
    expect(view.revision).toBe(Number((await fixture.runtime.query<{ revision: string }>(
      "SELECT revision FROM official_usage_state WHERE tenant_id=$1", [owner.tenantId])).rows[0]!.revision));
  });

  it("excludes superseded corrections permanently while preserving explicit snapshot and raw history reads", async () => {
    const owner = scope();
    const metadata = window("2026-07-09", "2026-07-15");
    const original = await importBundle(owner, {
      metadata, agents: [{ id: "incorrect", date: "2026-07-15", responses: 999 }],
    });
    const corrected = await importBundle(owner, {
      metadata, correctionOfSetId: original.setId, agents: [{ id: "intermediate", date: "2026-07-14" }],
    });
    const final = await importBundle(owner, {
      metadata, correctionOfSetId: corrected.setId, agents: [{ id: "correct", date: "2026-06-01" }],
    });
    const view = await overview.getOverview(owner.tenantId);
    expect(view.summary).toMatchObject({ retainedSets: 1, reportedAgents: 1, activeAgents30Days: 0 });
    expect(view.agents.value).toMatchObject([{ agentId: "correct", latestSetId: final.setId }]);
    expect((await repository.getPublished(owner.tenantId, original.setId)).reports.agents?.rows[0])
      .toMatchObject({ agentId: "incorrect", responsesSentToUsers: 999 });
    expect((await new OfficialUsageHistoryService(fixture.runtime).getHistory(owner.tenantId)).summary.importCount).toBe(3);
    await deleteSet(owner, final.setId);
    expect(await overview.getOverview(owner.tenantId)).toMatchObject({
      summary: {
        retainedSets: 0, reportedAgents: 0, usedAgents: 0, activeAgents30Days: 0, undatedAgents: 0,
        earliestActivityDateUtc: null, latestActivityDateUtc: null,
      },
      agents: { count: 0, value: [] },
    });
    expect((await new OfficialUsageHistoryService(fixture.runtime).getHistory(owner.tenantId)).summary.importCount).toBe(2);
    expect((await repository.getPublished(owner.tenantId, original.setId)).reports.agents?.rows[0].agentId).toBe("incorrect");
  });

  it("returns a zero-evidence summary and current revision for tenants with no eligible history", async () => {
    const view = await overview.getOverview(scope().tenantId, { search: "none", limit: 1, offset: 10 });
    expect(view).toMatchObject({
      revision: 1,
      summary: {
        retainedSets: 0, reportedAgents: 0, usedAgents: 0, activeAgents30Days: 0, undatedAgents: 0,
        earliestActivityDateUtc: null, latestActivityDateUtc: null,
        asOf: now().toISOString(), activeSinceDateUtc: "2026-06-16",
      },
      agents: { count: 0, value: [], limit: 1, offset: 10 },
    });
  });

  it("keeps corrected originals excluded after deleted correction payloads are purged", async () => {
    const owner = scope();
    const metadata = window("2026-07-09", "2026-07-15");
    const original = await importBundle(owner, {
      metadata, agents: [{ id: "incorrect", date: "2026-07-15" }],
    });
    const corrected = await importBundle(owner, {
      metadata, correctionOfSetId: original.setId, agents: [{ id: "correct", date: "2026-07-14" }],
    });
    await deleteSet(owner, corrected.setId);
    await fixture.operator.query(`UPDATE official_usage_sets
      SET deleted_at=clock_timestamp()-interval '91 days' WHERE id=$1`, [corrected.setId]);
    await fixture.operator.query(`UPDATE official_usage_versions
      SET deleted_at=clock_timestamp()-interval '91 days'
      WHERE tenant_id=$1 AND deleted_at IS NOT NULL`, [owner.tenantId]);
    await retainUntilConverged(fixture.operator);

    expect((await overview.getOverview(owner.tenantId)).summary).toMatchObject({
      retainedSets: 0, reportedAgents: 0, usedAgents: 0, activeAgents30Days: 0,
    });
    expect((await repository.getPublished(owner.tenantId, original.setId)).reports.agents?.rows[0].agentId)
      .toBe("incorrect");
    expect((await fixture.runtime.query(`SELECT supersedes_set_id,complete FROM official_usage_sets
      WHERE id=$1`, [corrected.setId])).rows).toEqual([{ supersedes_set_id: original.setId, complete: true }]);
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM official_usage_set_versions
      WHERE set_id=$1`, [corrected.setId])).rows[0].count).toBe(0);
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM official_usage_row_facts
      WHERE tenant_id=$1 AND row_data->>'agentId'='correct'`, [owner.tenantId])).rows[0].count).toBe(0);

    await deleteSet(owner, original.setId);
    await fixture.operator.query(`UPDATE official_usage_sets
      SET deleted_at=clock_timestamp()-interval '91 days' WHERE id=$1`, [original.setId]);
    await fixture.operator.query(`UPDATE official_usage_versions
      SET deleted_at=clock_timestamp()-interval '91 days'
      WHERE tenant_id=$1 AND deleted_at IS NOT NULL`, [owner.tenantId]);
    await retainUntilConverged(fixture.operator);
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM official_usage_sets
      WHERE tenant_id=$1`, [owner.tenantId])).rows[0].count).toBe(0);
  });
});
