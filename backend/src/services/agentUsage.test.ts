import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentUsageRepository, type AgentUsageSnapshot, type AuthorizedAgentUsageSource, type StoredAgentUsageAssociation,
} from "../db/agentUsage.js";
import type { AgentUsageAssociationInput } from "../types/agentUsage.js";
import type { ParsedOfficialUsageReport, PublishedOfficialUsage } from "../types/officialUsage.js";
import type { UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { AgentUsageService, buildAgentUsageContext, buildAgentUsageProjection, combineAgentInventoryRevision } from "./agentUsage.js";
import { agentUsageAssociationInput, agentUsageAssociationRemoval, agentUsageCandidateQuery } from "./agentUsageValidation.js";
import { allowlistedPackage } from "./packageObservation.js";

const scope = { tenantId: "tenant-a", principalId: "principal-a" };
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const setId = "33333333-3333-4333-8333-333333333333";
const observedAt = "2026-09-18T00:00:00.000Z";
const snapshotAt = "2026-09-19T00:00:00.000Z";
const expiresAt = "2035-01-01T00:00:00.000Z";
const observation = { id: firstId, snapshotId: firstId, observedAt, expiresAt, current: true as const };
const reportBase = {
  parserVersion: "test-parser", schemaVersion: "test-schema",
  reportingPeriod: { startDate: "2026-09-15", endDate: "2026-09-18", days: 4, provenance: "activity_range" as const },
  sourceAsOfProvenance: "absent" as const, sourceFreshness: "unknown" as const, warnings: ["Observed activity is not a report window."],
};

afterEach(() => vi.restoreAllMocks());

describe("report-backed inventory usage", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(snapshotAt));
  });

  it("returns explicit unavailable nulls for every record without an accepted report", () => {
    const fixture = data();
    fixture.snapshot.published = { ...fixture.snapshot.published, activeSet: null, reports: {}, retainedCompleteSets: 0, hasImportHistory: false };
    const result = project(fixture);
    expect(result.context.availability).toBe("never_imported");
    for (const summary of result.summaries.values()) expect(summary).toEqual({
      status: "unavailable", reportSetId: null, responses: null, activeUsers: null, lastActivityDateUtc: null, associations: [],
    });
  });

  it("matches full report/package IDs without names or manual writes and deduplicates merged-agent users", () => {
    const fixture = automaticData();
    const before = structuredClone(fixture);
    fixture.sources.push(fixture.sources[0]);
    const summary = project(fixture).summaries.get(fixture.records[0].id)!;
    expect(summary).toMatchObject({
      status: "linked", reportSetId: setId, responses: 30, activeUsers: 3, lastActivityDateUtc: "2026-09-18T00:00:00.000Z",
    });
    expect(summary.associations).toEqual(fixture.records[0].packages.map((value, index) => ({
      reportAgentId: value.id, reportAgentName: index ? "Report B" : "Report A",
      target: { source: "graph_packages", packageId: value.id }, basis: "exact_package_id",
    })));
    expect(fixture.records).toEqual(before.records);
    expect(fixture.snapshot).toEqual(before.snapshot);
    expect(summary.associations.every(value => !("reviewedAt" in value))).toBe(true);
  });

  it.each(["name", "guid-fragment", "prefix", "case", "manifest", "app", "asset"] as const)(
    "does not infer a package identity from a matching %s",
    kind => {
      const fixture = automaticData();
      const value = fixture.records[0].packages[0];
      value.manifestId = value.appId = value.assetId = firstId;
      const row = fixture.snapshot.published.reports.agents!.rows[0];
      row.agentName = fixture.records[0].displayName;
      row.agentId = kind === "name" ? value.displayName
        : kind === "prefix" ? value.id.replace(/^T_/, "P_")
          : kind === "case" ? value.id.toLowerCase() : firstId;
      fixture.snapshot.published.reports.agents!.rows = [row];
      expect(project(fixture).summaries.get(fixture.records[0].id)).toEqual({
        status: "unlinked", reportSetId: setId, responses: null, activeUsers: null, lastActivityDateUtc: null, associations: [],
      });
    },
  );

  it.each(["missing", "snapshot", "expired"] as const)("requires a current authorized package membership, not %s evidence", mismatch => {
    const fixture = automaticData();
    fixture.snapshot.published.reports.agents!.rows = fixture.snapshot.published.reports.agents!.rows.slice(0, 1);
    if (mismatch === "missing") fixture.sources = [];
    if (mismatch === "snapshot") fixture.sources[0].package_snapshot_id = secondId;
    if (mismatch === "expired") fixture.sources[0].expires_at = new Date("2026-09-01");
    expect(project(fixture).summaries.get(fixture.records[0].id)).toMatchObject({
      status: "unlinked", responses: null, activeUsers: null, associations: [],
    });
  });

  it("preserves automatic explicit zero and leaves absent companion evidence unknown", () => {
    const fixture = automaticData();
    const row = fixture.snapshot.published.reports.agents!.rows[0];
    row.responsesSentToUsers = 0;
    delete row.lastActivityDateUtc;
    fixture.snapshot.published.reports.agents!.rows = [row];
    fixture.snapshot.published.reports.userAgents!.rows = [{
      agentId: row.agentId, agentName: row.agentName, creatorType: row.creatorType, username: "zero", responsesSentToUsers: 0,
    }];
    expect(project(fixture).summaries.get(fixture.records[0].id)).toMatchObject({
      status: "linked", responses: 0, activeUsers: 0, lastActivityDateUtc: null,
    });
    delete fixture.snapshot.published.reports.userAgents;
    expect(project(fixture).summaries.get(fixture.records[0].id)).toMatchObject({
      status: "linked", responses: 0, activeUsers: null, lastActivityDateUtc: null,
    });
  });

  it("recomputes matches for a new selected report without summing overlapping snapshot totals", () => {
    const fixture = automaticData();
    const row = fixture.snapshot.published.reports.agents!.rows[0];
    row.responsesSentToUsers = 179;
    fixture.snapshot.published.reports.agents!.rows = [row];
    const previous = project(fixture);
    expect(previous.summaries.get(fixture.records[0].id)?.responses).toBe(179);
    fixture.snapshot.published.activeSet!.id = secondId;
    fixture.snapshot.published.activeRevision += 1;
    row.responsesSentToUsers = 181;
    const next = project(fixture);
    expect(next.summaries.get(fixture.records[0].id)).toMatchObject({
      reportSetId: secondId, status: "linked", responses: 181,
      associations: [{ basis: "exact_package_id" }],
    });
    expect(next.context.revision).not.toBe(previous.context.revision);
    expect(fixture.snapshot.associations).toEqual([]);
  });

  it.each([true, false])("preserves a reviewed override without automatic reassignment (target authorized: %s)", authorized => {
    const fixture = automaticData();
    fixture.snapshot.associations = [{
      ...fixture.sources[2], report_agent_id: fixture.records[0].packages[0].id, reviewed_at: new Date(observedAt),
    }];
    if (!authorized) fixture.sources = fixture.sources.slice(0, 2);
    const result = project(fixture);
    expect(result.summaries.get(fixture.records[0].id)).toMatchObject({ responses: 20, associations: [{ basis: "exact_package_id" }] });
    expect(result.summaries.get(fixture.records[1].id)).toMatchObject(authorized
      ? { responses: 10, associations: [{ basis: "admin_reviewed" }] }
      : { status: "unlinked", responses: null, associations: [] });
  });

  it("fails explicitly rather than choosing between conflicting canonical owners of one package", () => {
    const fixture = automaticData();
    const packageId = fixture.records[0].packages[0].id;
    fixture.records[1].packages.push(fixture.records[0].packages[0]);
    fixture.records[1].observations.packageSnapshots[packageId] = fixture.records[0].observations.packageSnapshots[packageId];
    fixture.sources.push({ ...fixture.sources[0], agent_id: secondId });
    expect(() => project(fixture)).toThrow("belongs to multiple agents");
    fixture.sources.reverse();
    expect(() => project(fixture)).toThrow("belongs to multiple agents");
  });

  it("deduplicates report IDs and positive-response user identities across a merged logical agent", () => {
    const fixture = data();
    fixture.snapshot.associations.push(fixture.snapshot.associations[0]);
    const before = structuredClone(fixture.records);
    const result = project(fixture).summaries.get(fixture.records[0].id)!;
    expect(result).toMatchObject({
      status: "linked", reportSetId: setId, responses: 30, activeUsers: 3, lastActivityDateUtc: "2026-09-18T00:00:00.000Z",
    });
    expect(result.associations.map(value => value.reportAgentId)).toEqual(["Report-A", "Report-B"]);
    expect(result.associations.every(value => value.basis === "admin_reviewed")).toBe(true);
    expect(fixture.records).toEqual(before);
  });

  it("uses Agents response/activity authority rather than Users or companion response totals", () => {
    const fixture = data();
    fixture.snapshot.published.reports.userAgents!.rows[0].responsesSentToUsers = 50_000;
    fixture.snapshot.published.reports.userAgents!.rows[0].lastActivityDateUtc = "2030-01-01T00:00:00.000Z";
    fixture.snapshot.published.reports.users!.rows[0].agentResponsesReceived = 70_000;
    expect(project(fixture).summaries.get(fixture.records[0].id)).toMatchObject({
      responses: 30, activeUsers: 3, lastActivityDateUtc: "2026-09-18T00:00:00.000Z",
    });
  });

  it.each(["one", "all"])("keeps missing %s companion evidence null rather than using category counts or zero", missing => {
    const fixture = data();
    if (missing === "all") delete fixture.snapshot.published.reports.userAgents;
    else fixture.snapshot.published.reports.userAgents!.rows = fixture.snapshot.published.reports.userAgents!.rows.filter(row => row.agentId !== "Report-B");
    expect(project(fixture).summaries.get(fixture.records[0].id)).toMatchObject({ status: "linked", responses: 30, activeUsers: null });
  });

  it("preserves explicit zero while ignoring bridge-only reported identities", () => {
    const fixture = data();
    fixture.snapshot.associations = fixture.snapshot.associations.slice(0, 1);
    fixture.snapshot.published.reports.agents!.rows[0].responsesSentToUsers = 0;
    delete fixture.snapshot.published.reports.agents!.rows[0].lastActivityDateUtc;
    fixture.snapshot.published.reports.userAgents!.rows = [
      { agentId: "Report-A", agentName: "A", creatorType: "Your org", username: "zero", responsesSentToUsers: 0 },
      { agentId: "bridge-only", agentName: "A", creatorType: "Your org", username: "other", responsesSentToUsers: 99 },
    ];
    expect(project(fixture).summaries.get(fixture.records[0].id)).toMatchObject({
      status: "linked", responses: 0, activeUsers: 0, lastActivityDateUtc: null,
    });
  });

  it("resolves tenant associations through another viewer's exact source, never their private canonical UUID", () => {
    const fixture = data();
    const records = [structuredClone(fixture.records[0])];
    records[0].id = `agent:${setId}`;
    const sources = fixture.sources.map(source => ({ ...source, agent_id: setId }));
    const otherViewer = { ...scope, principalId: "different-principal" };
    expect(buildAgentUsageProjection(otherViewer, records, sources, fixture.snapshot).summaries.get(records[0].id))
      .toMatchObject({ status: "linked", responses: 30 });
    expect(buildAgentUsageProjection(otherViewer, records, [], fixture.snapshot).summaries.get(records[0].id))
      .toMatchObject({ status: "unlinked", responses: null });
  });

  it.each(["package-case", "source", "snapshot", "expired"])("does not resolve a %s mismatch", mismatch => {
    const fixture = data();
    fixture.snapshot.associations = fixture.snapshot.associations.slice(0, 1);
    if (mismatch === "package-case") fixture.snapshot.associations[0].normalized_native_id = "package-a";
    if (mismatch === "source") fixture.snapshot.associations[0].source = "power_platform";
    if (mismatch === "snapshot") fixture.sources[0].package_snapshot_id = secondId;
    if (mismatch === "expired") fixture.sources[0].expires_at = new Date("2026-09-01");
    expect(project(fixture).summaries.get(fixture.records[0].id)).toMatchObject({ status: "unlinked", responses: null });
  });

  it("retains stale activity-range and unknown source-freshness lineage", () => {
    const fixture = data();
    fixture.snapshot.now = new Date("2027-01-01T00:00:00Z");
    const context = project(fixture).context;
    expect(context).toMatchObject({ availability: "stale", reportSet: { reportingPeriod: { provenance: "activity_range" } } });
    expect(context.lineages).toHaveLength(3);
    expect(context.lineages.every(value => value.sourceFreshness === "unknown" && value.sourceAsOfProvenance === "absent")).toBe(true);
    expect(context.lineages[0].warnings).toEqual(reportBase.warnings);
  });

  it("fails explicitly on inconsistent association evidence or inexact response totals", () => {
    const fixture = data();
    fixture.snapshot.published.reports.agents!.rows = [];
    expect(() => project(fixture)).toThrow("immutable Agents");
    const overflow = data();
    overflow.snapshot.published.reports.agents!.rows[0].responsesSentToUsers = Number.MAX_SAFE_INTEGER;
    expect(() => project(overflow)).toThrow("numeric range");
  });

  it("fences active set/content, freshness changes and association ABA cycles in deterministic revisions", () => {
    const fixture = data();
    const context = buildAgentUsageContext(scope, fixture.snapshot);
    expect(buildAgentUsageContext({ ...scope, principalId: "other" }, fixture.snapshot).revision).toBe(context.revision);
    expect(buildAgentUsageContext({ ...scope, tenantId: "other" }, fixture.snapshot).revision).not.toBe(context.revision);
    for (const change of [
      (value: AgentUsageSnapshot) => { value.associationRevision = "2"; },
      (value: AgentUsageSnapshot) => { value.published.activeRevision += 1; },
      (value: AgentUsageSnapshot) => { value.published.activeSet!.id = secondId; },
      (value: AgentUsageSnapshot) => { value.published.reports.agents!.lineage.contentHash = "c".repeat(64); },
      (value: AgentUsageSnapshot) => { value.now = new Date("2030-01-01"); },
      (value: AgentUsageSnapshot) => { value.expiresAt = new Date("2035-01-01"); },
    ]) {
      const changed = structuredClone(fixture.snapshot);
      change(changed);
      expect(buildAgentUsageContext(scope, changed).revision).not.toBe(context.revision);
    }
    const combined = combineAgentInventoryRevision("a".repeat(64), context.revision);
    expect(combined).toMatch(/^[a-f0-9]{64}$/);
    expect(combineAgentInventoryRevision("a".repeat(64), context.revision)).toBe(combined);
    expect(combineAgentInventoryRevision(context.revision, "a".repeat(64))).not.toBe(combined);
  });

  it("takes each source/report lock once in the caller's existing transaction", async () => {
    const fixture = data();
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as pg.PoolClient;
    vi.spyOn(AgentUsageRepository.prototype, "readSources").mockResolvedValue(fixture.sources);
    vi.spyOn(AgentUsageRepository.prototype, "read").mockResolvedValue(fixture.snapshot);
    const service = new AgentUsageService({ connect: vi.fn().mockRejectedValue(new Error("Must reuse caller")) } as unknown as pg.Pool);
    await service.project(scope, fixture.records, client);
    expect(query.mock.calls.map(call => call[1])).toEqual([
      ["package-refresh:tenant-a:principal-a"], ["power-platform:tenant-a:principal-a"], ["official-usage:tenant-a"],
    ]);
  });

  it("does not turn database errors into a successful empty projection or revision", async () => {
    const error = new Error("Database unavailable");
    const service = new AgentUsageService({ connect: vi.fn().mockRejectedValue(error) } as unknown as pg.Pool);
    await expect(service.project(scope, data().records)).rejects.toBe(error);
    await expect(service.revision(scope)).rejects.toBe(error);
  });

  it("rejects publication if a locked report expires after its rows were read", async () => {
    const fixture = data();
    fixture.snapshot.expiresAt = new Date(Date.now() + 1_000);
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as pg.PoolClient;
    vi.spyOn(AgentUsageRepository.prototype, "readSources").mockResolvedValue(fixture.sources);
    vi.spyOn(AgentUsageRepository.prototype, "read").mockResolvedValue(fixture.snapshot);
    vi.spyOn(Date, "now").mockReturnValue(fixture.snapshot.expiresAt.getTime() + 1);
    const service = new AgentUsageService({} as pg.Pool);
    await expect(service.project(scope, fixture.records, client)).rejects.toMatchObject({ code: "agent_usage_changed" });
    await expect(service.revision(scope, client)).rejects.toMatchObject({ code: "agent_usage_changed" });
  });
});

describe("strict usage association contracts", () => {
  const input = (): AgentUsageAssociationInput => ({
    reportSetId: setId, reportAgentId: "Report-A", target: { source: "graph_packages", packageId: "Package-A" },
    expectedInventoryRevision: "a".repeat(64), expectedUsageRevision: "b".repeat(64), confirmed: true,
  });

  it("accepts only exact source-qualified targets and explicit confirmation", () => {
    expect(agentUsageAssociationInput(input())).toEqual(input());
    expect(agentUsageAssociationInput({ ...input(), target: { source: "power_platform", nativeId: "Opaque-ID", environmentId: null } }).target)
      .toEqual({ source: "power_platform", nativeId: "Opaque-ID", environmentId: null });
    const { target: _target, ...removal } = input();
    expect(agentUsageAssociationRemoval(removal)).toEqual(removal);
    expect(agentUsageCandidateQuery({ search: " Agent ", limit: "250", offset: "100000" })).toEqual({ search: "Agent", limit: 250, offset: 100000 });
  });

  it.each([
    null, [], {}, { confirmed: false }, { confirmed: "true" }, { confirmed: 1 }, { confirmed: undefined },
    { reportSetId: "not-a-uuid" }, { reportAgentId: "" }, { reportAgentId: "a\nb" }, { reportAgentId: "a".repeat(513) },
    { expectedInventoryRevision: "old" }, { expectedUsageRevision: "g".repeat(64) }, { unexpected: true },
    { target: { source: "canonical", agentId: firstId } }, { target: { source: "graph_packages", packageId: "Package-A", appId: "forged" } },
    { target: { source: "graph_packages", packageId: "" } }, { target: { source: "graph_packages", packageId: " leading-space" } },
    { target: { source: "power_platform", nativeId: "bot" } }, { target: { source: "power_platform", nativeId: "bot", environmentId: "" } },
    { target: { source: "power_platform", nativeId: "bot", environmentId: null, packageId: "smuggled" } },
  ])("rejects malformed or extended input %j", value => {
    const candidate = value === null || Array.isArray(value) || value && Object.keys(value).length === 0 ? value : { ...input(), ...value };
    expect(() => agentUsageAssociationInput(candidate)).toThrow();
  });

  it("does not accept a target or other extension on removal", () => {
    expect(() => agentUsageAssociationRemoval(input())).toThrow();
  });

  it.each([
    { limit: "0" }, { limit: "251" }, { limit: "-1" }, { limit: "1.5" }, { limit: ["1", "2"] }, { limit: 1 },
    { offset: "-1" }, { offset: "100001" }, { offset: "1e2" }, { search: ["a", "b"] }, { search: "a".repeat(257) },
    { search: "a\u0000b" }, { automatic: "true" },
  ])("rejects invalid candidate parameters %j", query => {
    expect(() => agentUsageCandidateQuery(query)).toThrow();
  });
});

function data(packageIds = ["Package-A", "Package-B", "Package-C"]) {
  const records: UnifiedAgentRecord[] = [firstId, secondId].map((id, index) => ({
    id: `agent:${id}`, displayName: "Same visible name", presence: "graph_packages", environmentId: null,
    packages: (index ? packageIds.slice(2) : packageIds.slice(0, 2))
      .map(id => allowlistedPackage({ id, displayName: "Same visible name", isBlocked: false })),
    powerPlatformResource: null, identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
    observations: {
      graphPackages: { ...observation, tokenMode: "delegated", scopeKind: "broad", observedCount: 3, totalRecords: 3 },
      packageSnapshots: Object.fromEntries((index ? packageIds.slice(2) : packageIds.slice(0, 2)).map(id => [id, {
        ...observation, scopeKind: "broad", identityDetails: null,
      }])), powerPlatform: null,
    },
  }));
  const sources: AuthorizedAgentUsageSource[] = records.flatMap(record => record.packages.map(value => ({
    source: "graph_packages", native_id: value.id, normalized_native_id: value.id, environment_id: "", normalized_environment_id: "",
    agent_id: record.id.slice(6), package_snapshot_id: firstId, power_platform_snapshot_id: null, expires_at: new Date(expiresAt),
  })));
  const associations: StoredAgentUsageAssociation[] = sources.slice(0, 2).map((source, index) => ({
    ...source, report_agent_id: index ? "Report-B" : "Report-A", reviewed_at: new Date(observedAt),
  }));
  const agents = { ...reportBase, kind: "agents" as const, rows: [
    { agentId: "Report-A", agentName: "Report A", creatorType: "Your org", activeUsersLicensed: 99, activeUsersUnlicensed: 99, responsesSentToUsers: 10, lastActivityDateUtc: "2026-09-16T00:00:00.000Z" },
    { agentId: "Report-B", agentName: "Report B", creatorType: "Your org", activeUsersLicensed: 99, activeUsersUnlicensed: 99, responsesSentToUsers: 20, lastActivityDateUtc: "2026-09-18T00:00:00.000Z" },
  ] };
  const userAgents = { ...reportBase, kind: "userAgents" as const, rows: [
    { agentId: "Report-A", agentName: "A", creatorType: "Your org", username: "CaseUser", responsesSentToUsers: 1 },
    { agentId: "Report-A", agentName: "A", creatorType: "Your org", username: "shared", responsesSentToUsers: 2 },
    { agentId: "Report-B", agentName: "B", creatorType: "Your org", username: "caseuser", responsesSentToUsers: 3 },
    { agentId: "Report-B", agentName: "B", creatorType: "Your org", username: "shared", responsesSentToUsers: 4 },
    { agentId: "Report-B", agentName: "B", creatorType: "Your org", username: "zero", responsesSentToUsers: 0 },
  ] };
  const users = { ...reportBase, kind: "users" as const, rows: [
    { username: "shared", displayName: "Shared", numberOfAgentsUsed: 2, agentResponsesReceived: 6 },
  ] };
  const published: PublishedOfficialUsage = {
    activeRevision: 1, activeSet: {
      id: setId, bundleId: setId, contentHash: "a".repeat(64), reportingPeriod: reportBase.reportingPeriod,
      supersedesSetId: null, complete: true, kinds: ["agents", "userAgents", "users"], acceptedAt: observedAt,
      deletedAt: null, createdAt: observedAt, expiresAt: null,
    }, reports: { agents: accepted(agents), userAgents: accepted(userAgents), users: accepted(users) },
    retainedCompleteSets: 1, retainedIncompleteSets: 0, hasImportHistory: true, activeSelectionIncomplete: false,
  };
  const snapshot: AgentUsageSnapshot = { published, associations, associationRevision: "1",
    now: new Date(snapshotAt), expiresAt: null };
  return { records, sources, snapshot };
}

function accepted<T extends ParsedOfficialUsageReport>(report: T) {
  return { ...report, lineage: {
    ...reportBase, kind: report.kind, versionId: `${report.kind}-version`, contentHash: "a".repeat(64),
    fileHash: "b".repeat(64), acceptedAt: observedAt, rowCount: report.rows.length, reconciliation: {}, supersedesVersionId: null,
  } };
}

function project(fixture: ReturnType<typeof data>) {
  return buildAgentUsageProjection(scope, fixture.records, fixture.sources, fixture.snapshot);
}

function automaticData() {
  const fixture = data([`T_${firstId}`, `P_${secondId}`, "Package-C"]);
  fixture.snapshot.associations = [];
  for (const report of [fixture.snapshot.published.reports.agents, fixture.snapshot.published.reports.userAgents]) {
    for (const row of report!.rows) row.agentId = fixture.records[0].packages[row.agentId === "Report-A" ? 0 : 1].id;
  }
  return fixture;
}
