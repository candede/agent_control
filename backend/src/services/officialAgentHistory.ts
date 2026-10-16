import type pg from "pg";
import { AppError } from "../errors.js";
import { digest } from "../db/dataBounds.js";
import { officialReportCount as exactCount } from "../db/officialReportBounds.js";
import { readableHistorySql } from "../db/officialReportHistory.js";
import { reportPeriodSortKey } from "../db/officialReportQueries.js";
import { selectedInventorySourcesSql } from "../db/inventoryAuthority.js";
import { bounded, type LargeTenantUsersReports, type ReportReadContext } from "./largeTenantUsersReports.js";
import type { AgentUsageComparison, AgentUsageHistoryPoint, CandidateAgentUsageContext, CandidateAgentUsageHistory } from "../types/officialReportApi.js";

export function reportAgentLinksSql(tenant: string, set: string) {
  return `SELECT s.native_id AS report_agent_id FROM sources s WHERE s.source='graph_packages'
    AND NOT EXISTS(SELECT 1 FROM agent_usage_associations a
      WHERE a.tenant_id=${tenant} AND a.report_set_id=${set} AND a.report_agent_id=s.native_id)
    UNION SELECT a.report_agent_id FROM agent_usage_associations a JOIN sources s
      ON s.source=a.source AND s.normalized_native_id=a.normalized_native_id
      AND s.normalized_environment_id=a.normalized_environment_id
    WHERE a.tenant_id=${tenant} AND a.report_set_id=${set}`;
}

const caches = new WeakMap<pg.Pool, Map<string, { expires: number; value: CandidateAgentUsageHistory }>>();
type HistoryRow = {
  id: string; reporting_start: string | null; reporting_end: string | null; period_provenance: string; accepted_at: string;
  responses: string | null; last_activity: string | null; association_count: string; page_key: string | null;
  cohort_hash: string | null;
  candidate_count: string; matched_count: string; ambiguous_report_rows: boolean;
};
export function compareAgentHistory(from: HistoryRow, to: HistoryRow): AgentUsageComparison {
  const endpoint = (row: HistoryRow): AgentUsageComparison["from"] => ({ setId: row.id,
    window: { start: row.reporting_start, end: row.reporting_end, provenance: row.period_provenance },
    metrics: { responses: row.responses === null ? null : exactCount(row.responses), associationCount: exactCount(row.association_count),
      source: "agents", cohortHash: row.cohort_hash, cohortKind: "report_agent_associations",
      coverage: { expectedAssociations: exactCount(row.candidate_count), matchedAssociations: exactCount(row.matched_count),
        ambiguousReportRows: row.ambiguous_report_rows } } });
  const a = endpoint(from), b = endpoint(to), reasons: string[] = [];
  const known = (row: HistoryRow) => row.reporting_start !== null && row.reporting_end !== null
    && !["unknown", "activity_range"].includes(row.period_provenance);
  if (!known(from) || !known(to)) reasons.push("unknown_reporting_window");
  else {
    const startA = Date.parse(from.reporting_start!), endA = Date.parse(from.reporting_end!);
    const startB = Date.parse(to.reporting_start!), endB = Date.parse(to.reporting_end!);
    if (endA >= startB) reasons.push("overlapping_or_out_of_order_windows");
    if (endA - startA !== endB - startB) reasons.push("unequal_reporting_windows");
    if (from.period_provenance !== to.period_provenance) reasons.push("different_window_provenance");
  }
  if (a.metrics.responses === null || b.metrics.responses === null) reasons.push("unknown_metrics");
  if ([a, b].some(value => value.metrics.coverage.expectedAssociations !== value.metrics.coverage.matchedAssociations
    || value.metrics.coverage.ambiguousReportRows)) reasons.push("unknown_agent_report_coverage");
  if (!from.cohort_hash || !to.cohort_hash) reasons.push("unknown_associations");
  else if (from.cohort_hash !== to.cohort_hash) reasons.push("different_association_cohorts");
  const state = reasons.length ? reasons.some(reason => reason.startsWith("unknown")) ? "unknown" : "incomparable" : "comparable";
  const delta = state === "comparable" ? b.metrics.responses! - a.metrics.responses! : null;
  const percent = delta !== null && a.metrics.responses! > 0 ? delta / a.metrics.responses! * 100 : null;
  if (state === "comparable" && a.metrics.responses === 0 && b.metrics.responses! > 0) reasons.push("new_activity");
  return { state, reasons, from: a, to: b, responsesDelta: delta, responseGrowthPercent: percent };
}
function point(row: HistoryRow): AgentUsageHistoryPoint {
  return { setId: row.id, reportingStart: row.reporting_start, reportingEnd: row.reporting_end,
    periodProvenance: row.period_provenance, acceptedAt: row.accepted_at, status: row.responses === null ? "unlinked" : "linked",
    responses: row.responses === null ? null : exactCount(row.responses),
    lastActivityDateUtc: row.last_activity ? `${row.last_activity}T00:00:00.000Z` : null,
    associationCount: exactCount(row.association_count) };
}

export async function readAgentHistory(client: pg.PoolClient, reports: LargeTenantUsersReports,
  context: ReportReadContext & { inventorySelectionId?: string }, target: { id: string; context: CandidateAgentUsageContext },
  recordId: string, options: { limit?: number; cursor?: string; compareFromSetId?: string; compareToSetId?: string }): Promise<CandidateAgentUsageHistory> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, "invalid_cursor", "Page limit must be 1..100.");
  const expected = { identity: context.identity, endpoint: "agent-usage-history", selectionId: context.selection.id,
    revision: context.selection.revision, queryHash: digest(JSON.stringify([recordId, target.context, options.compareFromSetId, options.compareToSetId])) };
  const cursor = options.cursor ? reports.codec.decode(options.cursor, expected) : undefined;
  const key = digest(JSON.stringify([expected, limit, options.cursor]));
  const cache = caches.get(reports.database) ?? new Map();
  caches.set(reports.database, cache);
  const now = Date.now();
  for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return structuredClone(cached.value); }
  const previous = cursor?.direction === "previous", direction = previous ? "ASC" : "DESC";
  const source = context.inventorySelectionId ? selectedInventorySourcesSql("$1", "$3", "$4", "$5")
    : `SELECT * FROM inventory_live_sources WHERE tenant_id=$1 AND principal_id=$3 AND agent_id=$4
      AND authority_expires_at>GREATEST($5::timestamptz,clock_timestamp())`;
  // Root validation may choose broad-history join settings. This read starts with exact indexed agent IDs.
  await client.query("SELECT set_config('jit','off',true),set_config('enable_nestloop','on',true),set_config('enable_mergejoin','on',true)");
  const result = await client.query<{ item: HistoryRow | null; latest: HistoryRow | null; latest_set_id: string | null; total: string;
    comparison_from: HistoryRow | null; comparison_to: HistoryRow | null }>(`
    WITH retained AS MATERIALIZED (SELECT * FROM (${readableHistorySql}) history WHERE visibility='retained'),
    sources AS MATERIALIZED (${source}), linked_ids AS (
      SELECT period.id AS set_id,l.report_agent_id FROM retained period CROSS JOIN LATERAL (${reportAgentLinksSql("$1", "period.id")}) l
    ), coverage AS (
      SELECT set_id,count(*)::text AS candidate_count FROM linked_ids GROUP BY set_id
    ), totals AS (
      SELECT l.set_id,sum(f.responses)::text AS responses,count(*)::text AS association_count,max(f.last_activity)::text AS last_activity,
        count(DISTINCT l.report_agent_id)::text AS matched_count,count(*)<>count(DISTINCT l.report_agent_id) AS ambiguous_report_rows,
        encode(sha256(convert_to(string_agg(l.report_agent_id,E'\\n' ORDER BY l.report_agent_id COLLATE "C"),'UTF8')),'hex') AS cohort_hash
      FROM linked_ids l
      JOIN official_usage_set_versions m ON m.tenant_id=$1 AND m.set_id=l.set_id AND m.kind='agents'
      JOIN official_usage_row_facts f ON f.tenant_id=$1 AND f.kind=m.kind AND f.agent_id=l.report_agent_id
      JOIN official_usage_version_rows r ON r.tenant_id=$1 AND r.kind=f.kind AND r.payload_hash=f.payload_hash AND r.version_id=m.version_id
      GROUP BY l.set_id
    ), points AS MATERIALIZED (
      SELECT s.id,s.reporting_start::text,s.reporting_end::text,s.period_provenance,s.accepted_at,
        t.responses,COALESCE(t.association_count,'0') AS association_count,t.last_activity,t.cohort_hash,
        COALESCE(c.candidate_count,'0') AS candidate_count,COALESCE(t.matched_count,'0') AS matched_count,
        COALESCE(t.ambiguous_report_rows,false) AS ambiguous_report_rows,
        ${reportPeriodSortKey} AS page_key
      FROM retained s LEFT JOIN totals t ON t.set_id=s.id LEFT JOIN coverage c ON c.set_id=s.id
    ), page AS (
      SELECT * FROM points WHERE $6::int IS NULL OR (page_key IS NULL)::int ${previous ? "<" : ">"} $6
        OR (page_key IS NULL)::int=$6 AND (COALESCE(page_key,'') COLLATE "C",id::text COLLATE "C")
          ${previous ? ">" : "<"} ($7::text COLLATE "C",$8::text COLLATE "C")
      ORDER BY (page_key IS NULL)::int ${previous ? "DESC" : "ASC"},page_key COLLATE "C" ${direction},id ${direction} LIMIT $9
    )
    SELECT to_jsonb(page) AS item,(SELECT to_jsonb(p) FROM points p WHERE responses IS NOT NULL
      ORDER BY (page_key IS NULL)::int,page_key COLLATE "C" DESC,
        CASE WHEN page_key IS NULL THEN accepted_at END DESC,id DESC LIMIT 1) AS latest,
      (SELECT id::text FROM points ORDER BY (page_key IS NULL)::int,page_key COLLATE "C" DESC,
        CASE WHEN page_key IS NULL THEN accepted_at END DESC,id DESC LIMIT 1) AS latest_set_id,
      (SELECT count(*)::text FROM points) AS total,
      (SELECT to_jsonb(p) FROM points p WHERE id=$10::uuid) AS comparison_from,
      (SELECT to_jsonb(p) FROM points p WHERE id=$11::uuid) AS comparison_to FROM page RIGHT JOIN (SELECT 1) anchor ON true
      ORDER BY (page.page_key IS NULL)::int ${previous ? "DESC" : "ASC"},page.page_key COLLATE "C" ${direction},page.id ${direction}`,
  [context.identity.tenantId, context.report.historyRevision, context.identity.principalId, target.id,
    context.inventorySelectionId ?? context.evaluatedAt, cursor?.boundary.nullRank ?? null, cursor?.boundary.key ?? "", cursor?.boundary.id ?? "", limit + 1,
    options.compareFromSetId ?? null, options.compareToSetId ?? null]);
  if (options.compareFromSetId && (!result.rows[0].comparison_from || !result.rows[0].comparison_to)) {
    throw new AppError(404, "report_history_not_found", "Both comparison snapshots must belong to the pinned retained history.");
  }
  const raw = result.rows.flatMap(row => row.item ? [row.item] : []), more = raw.length > limit, page = raw.slice(0, limit);
  if (previous) page.reverse();
  const encode = (row: HistoryRow, direction: "next" | "previous") => reports.codec.encode({ ...expected, direction,
    boundary: { key: row.page_key, id: row.id, nullRank: row.page_key === null ? 1 : 0 } });
  const total = exactCount(result.rows[0].total), latest = result.rows[0].latest;
  const value: CandidateAgentUsageHistory = bounded({ recordId, context: target.context, value: page.map(point),
    latestReportSetId: result.rows[0].latest_set_id,
    latestReported: latest ? point(latest) : null,
    ...(options.compareFromSetId ? { comparison: compareAgentHistory(result.rows[0].comparison_from!, result.rows[0].comparison_to!) } : {}),
    counts: { total, filtered: total }, page: { limit,
      nextCursor: page.length && (previous ? Boolean(cursor) : more) ? encode(page.at(-1)!, "next") : null,
      previousCursor: page.length && (previous ? more : Boolean(cursor)) ? encode(page[0], "previous") : null } });
  if (Buffer.byteLength(JSON.stringify(value)) <= 65536) {
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Math.min(Date.parse(context.selection.expiresAt), now + 300_000), value: structuredClone(value) });
  }
  return value;
}
