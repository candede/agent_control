import type pg from "pg";
import { AppError } from "../errors.js";
import { digest, encodeBatch, exactCount } from "../db/dataBounds.js";
import { reportRelationsSql } from "../db/officialReportQueries.js";
import type { AdoptionAgent, AdoptionGroup, AdoptionPage, AdoptionPerson } from "../types/adoption.js";
import { reportSearchSql, type LargeTenantUsersReports, type ReportReadContext } from "./largeTenantUsersReports.js";
import { SelectionError } from "./dataSelections.js";
import { selectedInventorySourcesSql } from "../db/inventorySelections.js";

const maxGroupItems = 16_384;
function assertGroupItems(rows: unknown[]) {
  if (rows.length > maxGroupItems) throw new AppError(413, "adoption_page_too_large",
    "These groups exceed the page size limit. Search for a specific company and department to narrow the page.");
}

const groupRelations = `${reportRelationsSql}, adoption_users AS MATERIALIZED (
  SELECT c.*,nullif(btrim(company),'') AS company_label,
    nullif(btrim(department),'') AS department_label,
    encode(sha256(convert_to(jsonb_build_array(
      ${reportSearchSql("nullif(btrim(company),'')")},
      ${reportSearchSql("nullif(btrim(department),'')")})::text,'UTF8')),'hex') AS group_id
  FROM combined c
), adoption_groups AS (
  SELECT group_id AS identity,min(company_label COLLATE "C") AS company,min(department_label COLLATE "C") AS department,
    ${reportSearchSql(`coalesce(min(company_label COLLATE "C"),'Company not provided')||' / '||
      coalesce(min(department_label COLLATE "C"),'Department not provided')`)} AS sort_key
  FROM adoption_users GROUP BY group_id
)`;

const agentRelations = `, user_agents AS MATERIALIZED (
  SELECT DISTINCT r.agent_id,u.identity AS user_id
  FROM reports r JOIN resolved resolved_user ON resolved_user.username=r.username AND resolved_user.identity_count=1
    JOIN adoption_users u ON u.identity=resolved_user.identity
  WHERE r.kind='userAgents' AND r.responses>0
)`;

const inventoryRelations = `, current_sources AS MATERIALIZED (
  ${selectedInventorySourcesSql("$4", "$10", "NULL", "$11")}
), current_agents AS MATERIALIZED (
  SELECT DISTINCT r.identity,r.generation_id
  FROM current_sources s JOIN unified_agent_rows r
    ON r.generation_id=s.control_revision AND r.identity=s.agent_id
), agent_links AS (
  SELECT DISTINCT s.agent_id AS canonical_id,a.report_agent_id FROM current_sources s
    JOIN agent_usage_associations a ON a.tenant_id=$4 AND a.report_set_id=$5 AND a.source=s.source
      AND a.normalized_native_id=s.normalized_native_id AND a.normalized_environment_id=s.normalized_environment_id
  UNION
  SELECT s.agent_id,s.native_id FROM current_sources s WHERE s.source='graph_packages'
    AND NOT EXISTS(SELECT 1 FROM agent_usage_associations a
      WHERE a.tenant_id=$4 AND a.report_set_id=$5 AND a.report_agent_id=s.native_id)
), link_counts AS (
  SELECT report_agent_id,count(DISTINCT canonical_id) AS matches,min(canonical_id) AS canonical_id
  FROM agent_links GROUP BY report_agent_id
)`;

export function adoptionDataset(reports: LargeTenantUsersReports, context: ReportReadContext) {
  const { company, department, adoptionChamps, adoptionAgents } = context.query;
  const values: unknown[] = [...reports.parameters(context), context.query.search ?? "",
    JSON.stringify({ company, department, adoptionChamps, adoptionAgents })];
  const relations = `${groupRelations}${agentRelations}, group_evidence AS (
    SELECT g.*,
      EXISTS(SELECT 1 FROM adoption_users u WHERE u.group_id=g.identity
        AND (coalesce(u.responses,u.bridge_responses,0)>0
          OR EXISTS(SELECT 1 FROM user_agents a WHERE a.user_id=u.identity))) AS has_champs,
      CASE WHEN ${context.report.lineages.some(lineage => lineage.kind === "userAgents")} THEN
        EXISTS(SELECT 1 FROM adoption_users u JOIN user_agents a ON a.user_id=u.identity
          WHERE u.group_id=g.identity) END AS has_agents
    FROM adoption_groups g
  ), matching_groups AS (
    SELECT * FROM group_evidence g WHERE NOT EXISTS(
      SELECT 1 FROM regexp_split_to_table($7::text,'\\s+') term
      WHERE term<>'' AND strpos(g.sort_key,term)=0
    )
    AND (NOT ($8::jsonb ? 'company') OR ${reportSearchSql("g.company")}
      IS NOT DISTINCT FROM ${reportSearchSql("nullif(btrim($8::jsonb->>'company'),'')")})
    AND (NOT ($8::jsonb ? 'department') OR ${reportSearchSql("g.department")}
      IS NOT DISTINCT FROM ${reportSearchSql("nullif(btrim($8::jsonb->>'department'),'')")})
    AND (NOT ($8::jsonb ? 'adoptionChamps') OR g.has_champs=($8::jsonb->>'adoptionChamps'='with'))
    AND (NOT ($8::jsonb ? 'adoptionAgents') OR g.has_agents=($8::jsonb->>'adoptionAgents'='with'))
  ), person_metrics AS (
    SELECT u.identity,u.group_id,coalesce(nullif(u.display_name,''),u.upn) AS name,
      (SELECT count(*) FROM user_agents a WHERE a.user_id=u.identity) AS agents,
      coalesce(u.responses,u.bridge_responses) AS responses
    FROM adoption_users u JOIN matching_groups g ON g.identity=u.group_id
  ), ranked_people AS (
    SELECT *,row_number() OVER(PARTITION BY group_id
      ORDER BY responses DESC NULLS LAST,agents DESC,lower(name) COLLATE "C",identity) AS rank
    FROM person_metrics
  ), adoption_champions AS (
    SELECT * FROM ranked_people WHERE rank<=3 AND (coalesce(responses,0)>0 OR agents>0)
  )`;
  return { values, relations, sql: `${relations} SELECT * FROM matching_groups` };
}

export async function readAdoptionGroups(client: pg.PoolClient, reports: LargeTenantUsersReports,
  context: ReportReadContext, options: { limit: number; cursor?: string; anchor?: string; pageNumber?: number }): Promise<AdoptionPage> {
  if (context.endpoint !== "adoption" || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100
    || options.anchor !== undefined && !/^[a-f0-9]{64}$/.test(options.anchor)
    || options.pageNumber !== undefined && (!Number.isSafeInteger(options.pageNumber) || options.pageNumber < 1)
    || [options.anchor, options.pageNumber, options.cursor].filter(value => value !== undefined).length > 1) {
    throw new SelectionError("invalid_cursor");
  }
  const limit = Math.min(options.limit, 10);
  const { values, relations: sql } = adoptionDataset(reports, context);
  const expected = { identity: context.identity, endpoint: "adoption", selectionId: context.selection.id,
    revision: context.selection.revision, queryHash: digest(JSON.stringify([context.queryHash, limit])) };
  const cursor = options.cursor ? reports.codec.decode(options.cursor, expected) : undefined;
  const order = context.query.order === "desc" ? "DESC" : "ASC";
  const counts = (await client.query(`${sql} SELECT
    (SELECT count(*)::text FROM adoption_groups) AS total,
    (SELECT count(*)::text FROM matching_groups) AS filtered,
    (SELECT count(*)::text FROM adoption_users u JOIN matching_groups g ON g.identity=u.group_id) AS people,
    (SELECT count(*)::text FROM adoption_champions) AS champs,
    (SELECT count(DISTINCT a.agent_id)::text FROM adoption_users u JOIN matching_groups g ON g.identity=u.group_id
      JOIN user_agents a ON a.user_id=u.identity) AS agents`, values)).rows[0];
  let pageNumber = options.pageNumber ?? 1;
  if (options.anchor) {
    // Resolve the visible group to its containing page in the freshly selected results.
    const position = (await client.query(`${sql} SELECT
      (SELECT count(*)::text FROM matching_groups preceding WHERE
        (preceding.sort_key COLLATE "C",preceding.identity COLLATE "C") ${order === "DESC" ? ">" : "<"}
        (g.sort_key COLLATE "C",g.identity COLLATE "C")) AS preceding
      FROM matching_groups g WHERE g.identity=$9::text`, [...values, options.anchor])).rows[0];
    if (position) pageNumber = Math.floor(exactCount(position.preceding) / limit) + 1;
  } else if (cursor) {
    const position = (await client.query(`${sql} SELECT
      (SELECT count(*)::text FROM matching_groups preceding WHERE
        (preceding.sort_key COLLATE "C",preceding.identity COLLATE "C") ${order === "DESC" ? ">" : "<"}${cursor.direction === "next" ? "=" : ""}
        (g.sort_key COLLATE "C",g.identity COLLATE "C")) AS preceding
      FROM matching_groups g WHERE g.identity=$9::text`, [...values, cursor.boundary.id])).rows[0];
    if (!position) throw new SelectionError("invalid_cursor");
    const preceding = exactCount(position.preceding);
    pageNumber = Math.floor(Math.max(0, preceding - (cursor.direction === "previous" ? limit : 0)) / limit) + 1;
  }
  const filtered = exactCount(counts.filtered);
  pageNumber = Math.min(pageNumber, Math.max(1, Math.ceil(filtered / limit)));
  const offset = (pageNumber - 1) * limit;
  const headers = (await client.query(`${sql} SELECT * FROM matching_groups
    ORDER BY sort_key COLLATE "C" ${order},identity COLLATE "C" ${order} LIMIT ${limit} OFFSET ${offset}`, values)).rows;
  const groupIds = headers.map(row => String(row.identity));
  const detailValues = [...values, groupIds];
  const usageAvailable = context.report.lineages.some(lineage => lineage.kind === "userAgents");
  const peopleRows = groupIds.length ? (await client.query(`${sql}
    SELECT *,rank<=3 AND (coalesce(responses,0)>0 OR agents>0) AS champion FROM ranked_people
    WHERE group_id=ANY($9::text[])
    ORDER BY group_id,rank LIMIT ${maxGroupItems + 1}`, detailValues)).rows : [];
  assertGroupItems(peopleRows);
  const agentsRows = groupIds.length ? (await client.query(`${sql}${inventoryRelations}, group_agents AS (
    SELECT DISTINCT u.group_id,a.agent_id FROM user_agents a JOIN adoption_users u ON u.identity=a.user_id
    WHERE u.group_id=ANY($9::text[])
  ) SELECT g.group_id,r.identity,coalesce(nullif(r.name,''),r.agent_id) AS display_name,r.creator_type,
    a.identity AS inventory_id,
    (SELECT left(coalesce(description.long_about,description.native_about,description.short_about),2048)
      FROM current_sources s JOIN inventory_records p
        ON p.generation_id=s.source_generation_id AND p.identity=s.source_identity
      CROSS JOIN LATERAL (
        SELECT coalesce(nullif(btrim(p.residual->>'longDescription'),''),chunk.long_about) AS long_about,
          coalesce(nullif(btrim(p.residual->'details'->>'description'),''),chunk.native_about) AS native_about,
          coalesce(nullif(btrim(p.residual->>'shortDescription'),''),chunk.short_about) AS short_about
        FROM (SELECT max(payload->>'text') FILTER(WHERE kind='about:long') AS long_about,
          max(payload->>'text') FILTER(WHERE kind='about:native') AS native_about,
          max(payload->>'text') FILTER(WHERE kind='about:short') AS short_about
          FROM inventory_facts WHERE generation_id=p.generation_id AND identity=p.identity AND value='0'
            AND kind IN ('about:long','about:native','about:short')) chunk
      ) description
      WHERE s.agent_id=a.identity
        AND coalesce(description.long_about,description.native_about,description.short_about) IS NOT NULL
      ORDER BY CASE WHEN description.long_about IS NOT NULL THEN 0
        WHEN description.native_about IS NOT NULL THEN 1 ELSE 2 END,
        s.source,s.native_id LIMIT 1) AS description
    FROM group_agents g JOIN official_agents r ON r.identity=g.agent_id
      LEFT JOIN link_counts l ON l.report_agent_id=g.agent_id AND l.matches=1
      LEFT JOIN current_agents a ON a.identity=l.canonical_id
    ORDER BY g.group_id,lower(coalesce(nullif(r.name,''),r.agent_id)) COLLATE "C",r.identity LIMIT ${maxGroupItems + 1}`,
  [...detailValues, context.identity.principalId, context.selection.id])).rows : [];
  assertGroupItems(agentsRows);
  const people = new Map<string, AdoptionPerson[]>(), agents = new Map<string, AdoptionAgent[]>();
  for (const row of peopleRows) {
    const list = people.get(row.group_id) ?? [];
    list.push({ id: row.identity, name: row.name, agents: usageAvailable ? exactCount(row.agents) : null,
      responses: row.responses === null ? null : exactCount(row.responses), champion: row.champion });
    people.set(row.group_id, list);
  }
  for (const row of agentsRows) {
    const list = agents.get(row.group_id) ?? [];
    list.push({ id: `report:${row.identity}`, name: row.display_name, description: row.description,
      creatorType: row.creator_type, inventoryId: row.inventory_id ? `agent:${row.inventory_id}` : null });
    agents.set(row.group_id, list);
  }
  // Resolve long organization sort keys from the signed group identity, not the cursor payload.
  const encode = (row: pg.QueryResultRow | undefined, direction: "next" | "previous", enabled: boolean) =>
    row && enabled ? reports.codec.encode({ ...expected, direction,
      boundary: { key: "\0", id: row.identity, nullRank: 0 } }) : null;
  const value: AdoptionGroup[] = headers.map(row => ({ id: row.identity, company: row.company ?? "Company not provided", department: row.department ?? "Department not provided",
    people: people.get(row.identity) ?? [], agents: agents.get(row.identity) ?? [] }));
  const result: AdoptionPage = { value, counts: { total: exactCount(counts.total), filtered },
    page: { limit, number: pageNumber, offset, nextCursor: encode(headers.at(-1), "next", offset + headers.length < filtered),
      previousCursor: encode(headers[0], "previous", offset > 0),
      ...(headers.length ? { anchor: String(headers[0].identity) } : {}) },
    selection: context.selection, reports: context.report, directory: context.metadata.directory,
    summary: { people: exactCount(counts.people), champs: exactCount(counts.champs), agents: usageAvailable ? exactCount(counts.agents) : null } };
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > 1_048_000) throw new AppError(413, "adoption_page_too_large",
    "These groups exceed the page size limit. Search for a specific company and department to narrow the page.");
  encodeBatch([result]);
  return result;
}
