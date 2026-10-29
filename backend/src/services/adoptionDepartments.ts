import type pg from "pg";
import { digest } from "../db/dataBounds.js";
import { officialReportCount } from "../db/officialReportBounds.js";
import type { AdoptionDepartmentPage, AdoptionSummaryPage } from "../types/adoptionDashboard.js";
import { adoptionDataset } from "./adoptionGroups.js";
import { SelectionError } from "./dataSelections.js";
import { bounded, type LargeTenantUsersReports, type ReportReadContext } from "./largeTenantUsersReports.js";

export async function readAdoptionDepartments(client: pg.PoolClient, reports: LargeTenantUsersReports,
  context: ReportReadContext, options: { limit: number; cursor?: string; pageNumber?: number }): Promise<AdoptionDepartmentPage> {
  const { limit } = options;
  if (context.endpoint !== "adoption_departments" || context.query.sort !== "adoptionRate"
    || !Number.isInteger(limit) || limit < 1 || limit > 100
    || options.pageNumber !== undefined && (!Number.isSafeInteger(options.pageNumber) || options.pageNumber < 1)
    || options.pageNumber !== undefined && options.cursor !== undefined) {
    throw new SelectionError("invalid_cursor");
  }
  const { values, relations } = adoptionDataset(reports, context);
  const expected = { identity: context.identity, endpoint: "adoption_departments", selectionId: context.selection.id,
    revision: context.selection.revision, queryHash: digest(JSON.stringify([context.queryHash, limit])) };
  const cursor = options.cursor ? reports.codec.decode(options.cursor, expected) : undefined;
  if (cursor && (cursor.boundary.key === null || !/^[1-9]\d{0,15}$/.test(cursor.boundary.key)
    || !Number.isSafeInteger(Number(cursor.boundary.key)) || cursor.boundary.nullRank !== 0)) throw new SelectionError("invalid_cursor");
  const counts = (await client.query(`${relations} SELECT
    (SELECT count(*)::text FROM adoption_groups) AS total,
    (SELECT count(*)::text FROM matching_groups) AS filtered`, values)).rows[0];
  const total = officialReportCount(counts.total), filtered = officialReportCount(counts.filtered);
  const cursorOffset = cursor ? Number(cursor.boundary.key) - (cursor.direction === "previous" ? limit + 1 : 0) : 0;
  const pageNumber = Math.min(options.pageNumber ?? Math.floor(Math.max(0, cursorOffset) / limit) + 1,
    Math.max(1, Math.ceil(filtered / limit)));
  const offset = (pageNumber - 1) * limit;
  const order = context.query.order === "desc" ? "DESC" : "ASC";
  const measured = context.metadata.directory.generationId !== null
    && context.report.lineages.some(lineage => lineage.kind === "users" || lineage.kind === "userAgents");
  const rows = (await client.query(`${relations}, department_counts AS (
    SELECT g.identity,g.company,g.department,g.sort_key,count(*)::text AS people,
      count(*) FILTER(WHERE u.has_activity)::text AS active_people,
      ${measured ? "count(*) FILTER(WHERE u.has_activity)::numeric / NULLIF(count(*),0)" : "NULL::numeric"} AS adoption_rate
    FROM matching_groups g JOIN adoption_users u ON u.group_id=g.identity
    GROUP BY g.identity,g.company,g.department,g.sort_key
  ), ordered_departments AS (
    SELECT *,row_number() OVER(ORDER BY adoption_rate ${order} NULLS LAST,sort_key COLLATE "C",identity COLLATE "C") AS position
    FROM department_counts
  ) SELECT * FROM ordered_departments
    WHERE position > $9::bigint
    ORDER BY position ASC LIMIT $10`,
  [...values, offset, limit])).rows;
  const encode = (row: pg.QueryResultRow, direction: "next" | "previous") => reports.codec.encode({ ...expected, direction,
    boundary: { key: String(row.position), id: row.identity, nullRank: 0 } });
  return bounded({
    value: rows.map(row => ({ id: row.identity, company: row.company, department: row.department,
      people: officialReportCount(row.people), activePeople: measured ? officialReportCount(row.active_people) : null })),
    counts: { total, filtered },
    page: { limit, number: pageNumber, offset,
      nextCursor: rows.length && offset + rows.length < filtered ? encode(rows.at(-1)!, "next") : null,
      previousCursor: rows.length && offset > 0 ? encode(rows[0], "previous") : null },
    reports: context.report, selection: context.selection, directory: context.metadata.directory,
  });
}

export async function readAdoptionSummary(client: pg.PoolClient, reports: LargeTenantUsersReports,
  context: ReportReadContext): Promise<AdoptionSummaryPage> {
  if (context.endpoint !== "adoption"
    || ["search", "company", "department", "adoptionChamps", "adoptionAgents"].some(key => key in context.query)) {
    throw new SelectionError("invalid_cursor");
  }
  const { values, relations } = adoptionDataset(reports, context);
  const measured = context.metadata.directory.generationId !== null
    && context.report.lineages.some(lineage => lineage.kind === "users" || lineage.kind === "userAgents");
  const champions = measured ? officialReportCount((await client.query(
    `${relations} SELECT count(*)::text AS champions FROM adoption_champions`, values)).rows[0].champions) : null;
  return bounded({ value: [{ organization: await reports.summaryInRead(client, context), champions }],
    counts: { total: 1, filtered: 1 }, page: { limit: 1, nextCursor: null, previousCursor: null },
    reports: context.report, selection: context.selection });
}
