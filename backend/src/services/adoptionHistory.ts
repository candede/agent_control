import type pg from "pg";
import { AppError } from "../errors.js";
import { encodeBatch } from "../db/dataBounds.js";
import { officialReportCount } from "../db/officialReportBounds.js";
import { readableHistorySql } from "../db/officialReportHistory.js";
import { reportPeriodSortKey } from "../db/officialReportQueries.js";
import type { AdoptionHistoryPage, AdoptionSnapshot } from "../types/adoptionDashboard.js";
import { SelectionError } from "./dataSelections.js";
import { bounded, type LargeTenantUsersReports, type ReportReadContext } from "./largeTenantUsersReports.js";

type SnapshotRow = {
  id: string; reporting_start: string | null; reporting_end: string | null; period_provenance: string; accepted_at: string;
  active_users: string; active_agents: string; responses: string; user_report_active_users: string;
  relationship_active_users: string; user_report_responses: string; relationship_responses: string; page_key: string;
};

function snapshot(row: SnapshotRow): AdoptionSnapshot {
  return {
    id: row.id, reportingStart: row.reporting_start, reportingEnd: row.reporting_end,
    periodProvenance: row.period_provenance, acceptedAt: row.accepted_at,
    activeUsers: officialReportCount(row.active_users), activeAgents: officialReportCount(row.active_agents),
    responses: officialReportCount(row.responses), userReportActiveUsers: officialReportCount(row.user_report_active_users),
    relationshipActiveUsers: officialReportCount(row.relationship_active_users),
    userReportResponses: officialReportCount(row.user_report_responses),
    relationshipResponses: officialReportCount(row.relationship_responses),
  };
}

export async function readAdoptionHistory(client: pg.PoolClient, reports: LargeTenantUsersReports, context: ReportReadContext,
  options: { limit?: number; cursor?: string } = {}): Promise<AdoptionHistoryPage> {
  if (context.endpoint !== "adoption_history" || Object.keys(context.query).length) throw new SelectionError("invalid_cursor");
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, "invalid_cursor", "Page limit must be 1..100.");
  const expected = { identity: context.identity, endpoint: "adoption_history", selectionId: context.selection.id,
    revision: context.selection.revision, queryHash: context.queryHash };
  const cursor = options.cursor ? reports.codec.decode(options.cursor, expected) : undefined;
  if (cursor && (cursor.boundary.nullRank !== 0 || cursor.boundary.key === null)) throw new SelectionError("invalid_cursor");
  const previous = cursor?.direction === "previous", direction = previous ? "ASC" : "DESC";
  const result = await client.query<{ item: SnapshotRow | null; total: string }>(`
    WITH retained AS MATERIALIZED (
      SELECT id,tenant_id,reporting_start,reporting_end,period_provenance,accepted_at,
        CASE WHEN reporting_end IS NULL THEN '0/' || to_char(accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')
          ELSE '1/' || ${reportPeriodSortKey} END AS page_key
      FROM (${readableHistorySql}) history WHERE visibility='retained' AND complete AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at>GREATEST($3::timestamptz,clock_timestamp()))
    ), page AS MATERIALIZED (
      SELECT * FROM retained WHERE $4::text IS NULL OR (page_key COLLATE "C",id::text COLLATE "C")
        ${previous ? ">" : "<"} ($4::text COLLATE "C",$5::text COLLATE "C")
      ORDER BY page_key COLLATE "C" ${direction},id ${direction} LIMIT $6
    ), totals AS (
      SELECT p.id,
        count(DISTINCT f.username COLLATE "C") FILTER(WHERE f.kind IN ('users','userAgents') AND f.responses>0)::text AS active_users,
        count(DISTINCT f.agent_id COLLATE "C") FILTER(WHERE f.kind IN ('agents','userAgents') AND f.responses>0)::text AS active_agents,
        COALESCE(sum(f.responses) FILTER(WHERE f.kind='agents'),0)::text AS responses,
        count(DISTINCT f.username COLLATE "C") FILTER(WHERE f.kind='users' AND f.responses>0)::text AS user_report_active_users,
        count(DISTINCT f.username COLLATE "C") FILTER(WHERE f.kind='userAgents' AND f.responses>0)::text AS relationship_active_users,
        COALESCE(sum(f.responses) FILTER(WHERE f.kind='users'),0)::text AS user_report_responses,
        COALESCE(sum(f.responses) FILTER(WHERE f.kind='userAgents'),0)::text AS relationship_responses
      FROM page p LEFT JOIN official_usage_set_versions m ON m.tenant_id=$1 AND m.set_id=p.id
      LEFT JOIN official_usage_version_rows r ON r.tenant_id=m.tenant_id AND r.version_id=m.version_id AND r.kind=m.kind
      LEFT JOIN official_usage_row_facts f ON f.tenant_id=r.tenant_id AND f.kind=r.kind AND f.payload_hash=r.payload_hash
      GROUP BY p.id
    ), points AS (
      SELECT p.id,p.reporting_start::text,p.reporting_end::text,p.period_provenance,
        to_char(p.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS accepted_at,p.page_key,
        t.active_users,t.active_agents,t.responses,t.user_report_active_users,t.relationship_active_users,
        t.user_report_responses,t.relationship_responses FROM page p JOIN totals t ON t.id=p.id
    )
    SELECT to_jsonb(points) AS item,(SELECT count(*)::text FROM retained) AS total
      FROM points RIGHT JOIN (SELECT 1) anchor ON true
      ORDER BY points.page_key COLLATE "C" ${direction},points.id ${direction}`,
  [context.identity.tenantId, context.report.historyRevision, context.evaluatedAt,
    cursor?.boundary.key ?? null, cursor?.boundary.id ?? "", limit + 1]);
  encodeBatch(result.rows);
  const raw = result.rows.flatMap(row => row.item ? [row.item] : []), more = raw.length > limit, page = raw.slice(0, limit);
  if (previous) page.reverse();
  const encode = (row: SnapshotRow, direction: "next" | "previous") => reports.codec.encode({ ...expected, direction,
    boundary: { key: row.page_key, id: row.id, nullRank: 0 } });
  const total = officialReportCount(result.rows[0].total);
  return bounded({ value: page.map(snapshot), reports: context.report, selection: context.selection,
    counts: { total, filtered: total }, page: { limit,
      nextCursor: page.length && (previous ? Boolean(cursor) : more) ? encode(page.at(-1)!, "next") : null,
      previousCursor: page.length && (previous ? more : Boolean(cursor)) ? encode(page[0], "previous") : null } });
}
