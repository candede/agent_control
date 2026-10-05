import type pg from "pg";
import { officialReportCount as exactCount } from "../db/officialReportBounds.js";
import { readableHistorySql } from "../db/officialReportHistory.js";
import type { ReportReadContext, LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import type { ReportAnalytics } from "../types/officialReportData.js";

const n = (value: string | null) => value === null ? null : exactCount(value);
const date = (value: Date | string | null) => value instanceof Date ? value.toISOString() : value;
export type ReportSql = { sql: string; values: unknown[] };
export function officialReportAnalyticsQuery(reports: LargeTenantUsersReports, context: ReportReadContext, dataset = reports.dataset(context)): ReportSql {
  const { sql, values } = dataset, where = reports.filter(context, context.endpoint, values);
  const base = `WITH dataset AS (${sql}), filtered AS (SELECT * FROM dataset WHERE ${where})`;
  const metrics = ["copilot_users", "official_users", "official_agents", "relationships", "unresolved"].includes(context.endpoint);
  const review = ["copilot_users", "official_users"].includes(context.endpoint);
  const totalsSql = `count(*)::text AS n,
    ${metrics ? "sum(responses)::text AS responses,count(*) FILTER(WHERE responses=0)::text AS zero,count(*) FILTER(WHERE responses IS NULL)::text AS unknown" : "NULL::text AS responses,NULL::text AS zero,NULL::text AS unknown"}`;
  const start = values.length;
  return { sql: context.endpoint === "official_agents" ? `${base},
    anchor AS (SELECT max(last_activity) AS date FROM dataset),
    window_agents AS (SELECT agent_id,responses FROM filtered
      WHERE last_activity BETWEEN (SELECT date FROM anchor)-($${start + 3}::int-1) AND (SELECT date FROM anchor))
    SELECT ${totalsSql},(SELECT date::text FROM anchor) AS anchor,
      count(*) FILTER(WHERE last_activity<($${start + 1}::timestamptz AT TIME ZONE 'UTC')::date-$${start + 2}::int)::text AS inactive,
      count(*) FILTER(WHERE last_activity IS NULL)::text AS never,
      (SELECT count(*) FROM window_agents)::text AS window_agents,(SELECT sum(responses) FROM window_agents)::text AS window_responses,
      (SELECT count(DISTINCT f.username) FROM official_usage_set_versions m JOIN official_usage_version_rows r ON r.version_id=m.version_id
        JOIN official_usage_row_facts f ON f.tenant_id=r.tenant_id AND f.kind=r.kind AND f.payload_hash=r.payload_hash
        JOIN window_agents a ON a.agent_id=f.agent_id WHERE m.tenant_id=$4 AND m.set_id=$5 AND m.kind='userAgents' AND f.responses>0)::text AS active_users,
      (SELECT COALESCE(jsonb_agg(r),'[]'::jsonb) FROM (SELECT agent_id,name,responses::text
        FROM filtered ORDER BY filtered.responses DESC,agent_id COLLATE "C" LIMIT 10) r) AS most,
      (SELECT COALESCE(jsonb_agg(r),'[]'::jsonb) FROM (SELECT agent_id,name,responses::text
        FROM filtered ORDER BY filtered.responses ASC,agent_id COLLATE "C" LIMIT 10) r) AS least FROM filtered`
    : `${base} SELECT ${totalsSql}${review ? `,
      count(*) FILTER(WHERE review_cohort='zero')::text AS review_zero,
      count(*) FILTER(WHERE review_cohort='low')::text AS review_low,
      count(*) FILTER(WHERE review_cohort='unknown')::text AS review_unknown` : ""} FROM filtered`,
    values: context.endpoint === "official_agents" ? [...values, context.evaluatedAt, context.query.inactiveDays, context.query.activityWindowDays] : values };
}
export function projectReportAnalytics(totals: pg.QueryResultRow, context: ReportReadContext): ReportAnalytics {
  const result: ReportAnalytics = { basis: "filtered_rows", rowCount: exactCount(totals.n), responses: n(totals.responses),
    zeroResponses: n(totals.zero), unknownResponses: n(totals.unknown), review: null, agents: null, history: null, overview: null };
  if (["copilot_users", "official_users"].includes(context.endpoint)) {
    result.review = { zero: exactCount(totals.review_zero), low: exactCount(totals.review_low), unknown: exactCount(totals.review_unknown) };
  }
  if (context.endpoint === "official_agents") {
    const ranking = (rows: Array<{ agent_id: string; name: string; responses: string }>) =>
      rows.map(row => ({ agentId: row.agent_id, name: row.name, responses: exactCount(row.responses) }));
    result.agents = { inactive: exactCount(totals.inactive), neverUsed: exactCount(totals.never), anchorDateUtc: totals.anchor,
      windowDays: context.query.activityWindowDays!, windowAgents: exactCount(totals.window_agents), windowResponses: n(totals.window_responses),
      windowDistinctActiveUsers: exactCount(totals.active_users), mostResponses: ranking(totals.most), leastResponses: ranking(totals.least) };
  }
  return result;
}
export async function officialReportAnalytics(client: pg.PoolClient, reports: LargeTenantUsersReports, context: ReportReadContext): Promise<ReportAnalytics> {
  const { sql, values } = reports.dataset(context), where = reports.filter(context, context.endpoint, values);
  const base = `WITH dataset AS (${sql}), filtered AS (SELECT * FROM dataset WHERE ${where})`;
  const query = officialReportAnalyticsQuery(reports, context);
  const result = projectReportAnalytics((await client.query(query.sql, query.values)).rows[0], context);
  if (context.endpoint === "history") {
    const row = (await client.query(`${base}, versions AS (
      SELECT DISTINCT v.id,v.tenant_id,v.kind,v.row_count FROM filtered s JOIN official_usage_set_versions m ON m.set_id=s.id AND m.tenant_id=s.tenant_id
        JOIN official_usage_versions v ON v.id=m.version_id AND v.tenant_id=m.tenant_id
    ), observations AS (
      SELECT f.kind,f.payload_hash,f.last_activity FROM versions v JOIN official_usage_version_rows r ON r.version_id=v.id
        JOIN official_usage_row_facts f ON f.tenant_id=r.tenant_id AND f.kind=r.kind AND f.payload_hash=r.payload_hash
    ) SELECT (SELECT count(*) FROM versions)::text AS versions,(SELECT count(*) FROM observations)::text AS rows,
      (SELECT count(*) FROM (SELECT DISTINCT kind,payload_hash FROM observations) p)::text AS payloads,
      min(accepted_at) AS earliest,max(accepted_at) AS latest,
      (SELECT min(last_activity)::text FROM observations) AS earliest_activity,(SELECT max(last_activity)::text FROM observations) AS latest_activity,
      min(reporting_start) FILTER(WHERE period_provenance<>'activity_range' AND reporting_start IS NOT NULL AND reporting_end IS NOT NULL)::text AS earliest_start,
      max(reporting_end) FILTER(WHERE period_provenance<>'activity_range' AND reporting_start IS NOT NULL AND reporting_end IS NOT NULL)::text AS latest_end,
      count(*) FILTER(WHERE period_provenance<>'activity_range' AND reporting_start IS NOT NULL AND reporting_end IS NOT NULL)::text AS known,
      count(*) FILTER(WHERE period_provenance='activity_range' OR reporting_start IS NULL OR reporting_end IS NULL)::text AS unknown,
      count(*) FILTER(WHERE period_provenance<>'activity_range' AND EXISTS(SELECT 1 FROM filtered other WHERE other.id<>filtered.id
        AND other.period_provenance<>'activity_range' AND other.reporting_start<=filtered.reporting_end AND other.reporting_end>=filtered.reporting_start))::text AS overlaps FROM filtered`, values)).rows[0];
    result.history = { imports: result.rowCount, uniqueObservations: exactCount(row.versions), observationRows: exactCount(row.rows),
      uniquePayloads: exactCount(row.payloads), repeatedRowsReused: exactCount(row.rows) - exactCount(row.payloads),
      earliestAcceptedAt: date(row.earliest), latestAcceptedAt: date(row.latest), earliestActivityDateUtc: row.earliest_activity, latestActivityDateUtc: row.latest_activity,
      earliestReportingStart: row.earliest_start, latestReportingEnd: row.latest_end, knownWindows: exactCount(row.known), unknownWindows: exactCount(row.unknown),
      overlappingKnownWindows: exactCount(row.overlaps), additive: false, activityRangeProvesCoverage: false };
  }
  if (context.endpoint === "overview") {
    const row = (await client.query(`${base} SELECT count(*) FILTER(WHERE has_responses)::text AS used,count(*) FILTER(WHERE active)::text AS active,
      count(*) FILTER(WHERE last_activity IS NULL)::text AS undated,min(earliest_activity)::text AS earliest,max(last_activity)::text AS latest FROM filtered`, values)).rows[0];
    const count = (await client.query(`SELECT count(*)::text AS n FROM (${readableHistorySql}) h
      WHERE ($3='history' AND visibility='retained') OR ($3='selected' AND id=$4::uuid)`,
    [context.identity.tenantId, context.report.historyRevision, context.query.scope ?? "history", context.report.setId])).rows[0].n;
    result.overview = { retainedSets: exactCount(count), reportedAgents: result.rowCount, usedAgents: exactCount(row.used), active30Days: exactCount(row.active),
      undatedAgents: exactCount(row.undated), earliestActivityDateUtc: row.earliest, latestActivityDateUtc: row.latest,
      asOf: context.evaluatedAt.toISOString(), activeSinceDateUtc: new Date(context.evaluatedAt.getTime() - 29 * 86400000).toISOString().slice(0, 10) };
  }
  return result;
}
