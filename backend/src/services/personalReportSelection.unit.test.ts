import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LargeTenantUsersReports, type ReportReadContext } from "./largeTenantUsersReports.js";
import { reportQuery } from "./largeTenantUsersReports.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import { digest } from "../db/dataBounds.js";

const tenant = "personal-report-tenant";
const identity = { tenantId: tenant, principalId: "viewer", authorizationHash: "viewer", sessionEpoch: "1" };
const latest = "11111111-1111-4111-8111-111111111111";
const personal = "abcdefab-1234-4567-89ab-abcdefabcdef";
const now = new Date("2026-10-01T00:00:00Z");
const pools: pg.Pool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.end()));
  vi.restoreAllMocks();
});

function source(source: UserSourceMetadata["source"]): UserSourceMetadata {
  return { source, generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
    attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null, rowCount: null,
    state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null };
}

function fixture() {
  const pool = new pg.Pool({ max: 4 });
  pools.push(pool);
  vi.spyOn(pool, "connect").mockRejectedValue(new Error("Unit tests must not acquire a database."));
  const reports = new LargeTenantUsersReports(pool, "synthetic-personal-report-selection-secret", 35);
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const state = { history_revision: "8", invalidation_epoch: "1", active_set_id: latest, active_revision: "4", retained: 2, incomplete: 0 };
  const set = { id: personal, reporting_start: "2026-09-01", reporting_end: "2026-09-30",
    period_provenance: "operator_asserted", accepted_at: now, expires_at: null };
  const versions = ["agents", "userAgents", "users"].map(kind => ({ id: `version-${kind}`, kind, content_hash: "a".repeat(64),
    row_count: 1, source_as_of: null, source_as_of_provenance: "absent", source_freshness: "unknown",
    period_provenance: "operator_asserted", expires_at: null, artifact_expiry: null, complete: true, alive: true }));
  const result = (rows: object[] = []): pg.QueryResult => ({ command: "SELECT", rowCount: rows.length, fields: [], oid: 0, rows });
  const query = vi.spyOn(client, "query").mockImplementation(async (sql: string) => {
    if (sql.startsWith("SELECT current_setting")) return result([{ isolation: "repeatable read", now }]);
    if (sql.includes("AS history_revision")) return result([state]);
    if (sql.startsWith("SELECT s.id,s.reporting_start")) return result([set]);
    if (sql.startsWith("SELECT v.id,v.kind")) return result(versions);
    if (sql.startsWith("SELECT 1 FROM (SELECT s.*,m.visibility")) return result([{ exists: true }]);
    if (sql.startsWith("WITH markers")) return result();
    throw new Error(`Unexpected personal report SQL: ${sql}`);
  });
  vi.spyOn(reports.history, "prepareRead").mockResolvedValue(undefined);
  vi.spyOn(reports.sources, "metadataInRead").mockResolvedValue({ directory: source("directory"), app_activity: source("app_activity") });
  return { reports, client, query, state, set, versions, result };
}

describe("personal saved report reads", () => {
  it("validates but preserves captured JSONB metadata ordering for exact same-report mutation revisions", async () => {
    const { reports, client, versions } = fixture();
    const data = await reports.currentInventoryData(client, identity, now, personal);
    const report = Object.fromEntries(Object.entries(data.report).reverse()) as ReportReadContext["report"];
    const context: ReportReadContext = { ...data, identity, endpoint: "official_agents", query: reportQuery("official_agents"),
      queryHash: "a".repeat(64), selection: { id: latest, revision: "1", evaluatedAt: now.toISOString(),
        validatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString(),
        publicationRevisions: data.publicationRevisions }, report };
    expect(digest(JSON.stringify([data.report, "0"]))).not.toBe(digest(JSON.stringify([report, "0"])));
    const selected = await reports.reportForSelection(client, context, personal);
    expect(selected).toBe(report);
    expect(digest(JSON.stringify([selected, "0"]))).toBe(digest(JSON.stringify([report, "0"])));
    versions[0].alive = false;
    await expect(reports.reportForSelection(client, context, personal))
      .rejects.toMatchObject({ status: 404, code: "usage_report_unavailable" });
  });

  it("captures a canonical explicit report for inventory without writing the tenant default", async () => {
    const { reports, client, query } = fixture();
    const current = await reports.currentInventoryData(client, identity, now, personal.toUpperCase());
    expect(current.report).toMatchObject({ setId: personal, activeSetId: latest, activeRevision: "4" });
    expect(current.query).toMatchObject({ setId: personal, lowResponseThreshold: 5 });
    expect(query.mock.calls.every(([sql]) => !/^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(true);
    expect(query.mock.calls.find(([sql]) => sql.startsWith("SELECT s.id,s.reporting_start"))?.[1])
      .toEqual([personal, tenant, now]);
  });

  it.each(["missing", "deleted", "expired", "foreign", "incomplete"] as const)(
    "returns usage_report_unavailable for an explicitly requested %s report", async () => {
      const { reports, client, query, result } = fixture(), original = query.getMockImplementation()!;
      query.mockImplementation((sql, values) => sql.startsWith("SELECT s.id,s.reporting_start") ? Promise.resolve(result()) : original(sql, values));
      await expect(reports.currentInventoryData(client, identity, now, personal))
        .rejects.toMatchObject({ status: 404, code: "usage_report_unavailable" });
      expect(query.mock.calls.find(([sql]) => sql.startsWith("SELECT s.id,s.reporting_start"))?.[0])
        .toContain("s.deleted_at IS NULL AND s.complete AND m.valid_to_revision IS NULL");
  });

  it.each(["missing version", "incomplete version", "expired version or artifact"] as const)(
    "returns usage_report_unavailable for an explicit report with %s", async failure => {
      const { reports, client, versions } = fixture();
      if (failure === "missing version") versions.pop();
      if (failure === "incomplete version") versions[0].complete = false;
      if (failure === "expired version or artifact") versions[0].alive = false;
      await expect(reports.currentInventoryData(client, identity, now, personal))
        .rejects.toMatchObject({ status: 404, code: "usage_report_unavailable" });
    });

  it("reads superseded current history members while preserving the captured head and history revision", async () => {
    const { reports, client, query } = fixture();
    const data = await reports.currentInventoryData(client, identity, now);
    const context: ReportReadContext = { ...data, identity, endpoint: "official_agents", query: reportQuery("official_agents"),
      queryHash: "a".repeat(64), selection: { id: latest, revision: "1", evaluatedAt: now.toISOString(),
        validatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString(),
        publicationRevisions: data.publicationRevisions },
      report: { ...data.report, setId: latest, activeRevision: "2", historyRevision: "6", historyEpoch: "0" } };
    expect(await reports.reportForSelection(client, context, personal)).toMatchObject({
      setId: personal, activeSetId: latest, activeRevision: "2", historyRevision: "6", historyEpoch: "0",
    });
    const membership = query.mock.calls.find(([sql]) => sql.startsWith("SELECT 1 FROM (SELECT s.*,m.visibility"))!;
    expect(membership[0]).not.toContain("visibility='retained'");
    expect(membership[1]).toEqual([tenant, "6", personal]);
    const original = query.getMockImplementation()!;
    query.mockImplementation((sql, values) => sql.startsWith("SELECT 1 FROM (SELECT s.*,m.visibility")
      ? Promise.resolve({ command: "SELECT", rowCount: 0, fields: [], oid: 0, rows: [] }) : original(sql, values));
    await expect(reports.reportForSelection(client, context, personal)).rejects.toMatchObject({ code: "selection_invalidated" });
  });

  it("rejects malformed report identifiers before reading saved sources", async () => {
    const { reports, client, query } = fixture();
    await expect(reports.currentInventoryData(client, identity, now, "not-a-uuid")).rejects.toMatchObject({ status: 400, code: "invalid_identifier" });
    expect(query).not.toHaveBeenCalled();
  });
});
