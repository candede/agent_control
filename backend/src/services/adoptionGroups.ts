import type pg from "pg";
import { AppError } from "../errors.js";
import { digest, encodeBatch, exactCount } from "../db/dataBounds.js";
import { reportRelationsSql } from "../db/officialReportQueries.js";
import type { AdoptionAgent, AdoptionGroup, AdoptionPage, AdoptionPerson } from "../types/adoption.js";
import type { LargeTenantUsersReports, ReportReadContext } from "./largeTenantUsersReports.js";
import { SelectionError } from "./dataSelections.js";

const groupRelations = `${reportRelationsSql}, adoption_users AS MATERIALIZED (
  SELECT c.*,nullif(btrim(company),'') AS company_label,
    nullif(btrim(department),'') AS department_label,
    encode(sha256(convert_to(jsonb_build_array(
      lower(normalize(nullif(btrim(company),''),NFKC)),
      lower(normalize(nullif(btrim(department),''),NFKC)))::text,'UTF8')),'hex') AS group_id
  FROM combined c
), adoption_groups AS (
  SELECT group_id AS identity,min(company_label COLLATE "C") AS company,min(department_label COLLATE "C") AS department,
    lower(normalize(coalesce(min(company_label COLLATE "C"),'Company not provided')||' / '||
      coalesce(min(department_label COLLATE "C"),'Department not provided'),NFKC)) AS sort_key
  FROM adoption_users GROUP BY group_id
)`;

// Inventory remains a current, read-only observation. Group membership and usage
// use the existing selected directory/report; no separate group state is stored.
const agentRelations = `, current_sources AS MATERIALIZED (
  SELECT * FROM inventory_live_sources WHERE tenant_id=$4 AND principal_id=$8
    AND authority_expires_at>transaction_timestamp()
), current_agents AS MATERIALIZED (
  SELECT DISTINCT r.identity,r.generation_id,r.display_name
  FROM current_sources s JOIN unified_agent_rows r
    ON r.generation_id=s.control_revision AND r.identity=s.agent_id
  WHERE NOT EXISTS(SELECT 1 FROM inventory_facts f WHERE f.generation_id=r.generation_id
    AND f.identity=r.identity AND f.kind='view' AND f.value IN ('first_party','third_party') AND f.boolean_value)
    AND (EXISTS(SELECT 1 FROM inventory_facts f WHERE f.generation_id=r.generation_id
      AND f.identity=r.identity AND (f.kind='relevance' AND f.value IN ('organization_created','organization_shared')
        OR f.kind='platform' AND f.value IN ('copilotstudio','microsoft365copilotagentbuilder')))
      OR EXISTS(SELECT 1 FROM current_sources native JOIN power_platform_record_rows p
        ON p.generation_id=native.source_generation_id AND p.identity=native.source_identity
        WHERE native.agent_id=r.identity AND p.resource_type='microsoft.copilotstudio/agents'))
), agent_links AS (
  SELECT DISTINCT s.agent_id AS canonical_id,a.report_agent_id FROM current_sources s
    JOIN agent_usage_associations a ON a.tenant_id=$4 AND a.report_set_id=$5 AND a.source=s.source
      AND a.normalized_native_id=s.normalized_native_id AND a.normalized_environment_id=s.normalized_environment_id
  UNION
  SELECT s.agent_id,s.native_id FROM current_sources s WHERE s.source='graph_packages'
    AND NOT EXISTS(SELECT 1 FROM agent_usage_associations a
      WHERE a.tenant_id=$4 AND a.report_set_id=$5 AND a.report_agent_id=s.native_id)
), creators AS (
  SELECT DISTINCT a.identity AS agent_id,u.identity AS user_id
  FROM current_agents a JOIN inventory_facts f ON f.generation_id=a.generation_id
    AND f.identity=a.identity AND f.kind='person:createdBy'
  JOIN adoption_users u ON u.identity=f.value
), used AS (
  SELECT DISTINCT a.identity AS agent_id,u.identity AS user_id
  FROM reports r JOIN resolved resolved_user ON resolved_user.username=r.username AND resolved_user.identity_count=1
    JOIN adoption_users u ON u.identity=resolved_user.identity
    JOIN agent_links l ON l.report_agent_id=r.agent_id JOIN current_agents a ON a.identity=l.canonical_id
  WHERE r.kind='userAgents' AND r.responses>0
), user_agents AS (
  SELECT * FROM creators UNION SELECT * FROM used
)`;

export function adoptionDataset(reports: LargeTenantUsersReports, context: ReportReadContext) {
  const { company, department, adoptionChamps, adoptionAgents } = context.query;
  const values: unknown[] = [...reports.parameters(context), context.query.search ?? "", context.identity.principalId,
    JSON.stringify({ company, department, adoptionChamps, adoptionAgents })];
  const relations = `${groupRelations}${agentRelations}, group_evidence AS (
    SELECT g.*,
      EXISTS(SELECT 1 FROM adoption_users u WHERE u.group_id=g.identity
        AND (coalesce(u.responses,u.bridge_responses,0)>0
          OR EXISTS(SELECT 1 FROM creators c WHERE c.user_id=u.identity))) AS has_champs,
      EXISTS(SELECT 1 FROM adoption_users u JOIN user_agents a ON a.user_id=u.identity
        WHERE u.group_id=g.identity) AS has_agents
    FROM adoption_groups g
  ), matching_groups AS (
    SELECT * FROM group_evidence g WHERE NOT EXISTS(
      SELECT 1 FROM regexp_split_to_table($7::text,'\\s+') term
      WHERE term<>'' AND strpos(g.sort_key,term)=0
    )
    AND (NOT ($9::jsonb ? 'company') OR lower(normalize(g.company,NFKC))
      IS NOT DISTINCT FROM lower(normalize(nullif(btrim($9::jsonb->>'company'),''),NFKC)))
    AND (NOT ($9::jsonb ? 'department') OR lower(normalize(g.department,NFKC))
      IS NOT DISTINCT FROM lower(normalize(nullif(btrim($9::jsonb->>'department'),''),NFKC)))
    AND (NOT ($9::jsonb ? 'adoptionChamps') OR g.has_champs=($9::jsonb->>'adoptionChamps'='with'))
    AND (NOT ($9::jsonb ? 'adoptionAgents') OR g.has_agents=($9::jsonb->>'adoptionAgents'='with'))
  )`;
  return { values, relations, sql: `${relations} SELECT * FROM matching_groups` };
}

export async function readAdoptionGroups(client: pg.PoolClient, reports: LargeTenantUsersReports,
  context: ReportReadContext, options: { limit: number; cursor?: string }): Promise<AdoptionPage> {
  if (context.endpoint !== "adoption" || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new SelectionError("invalid_cursor");
  }
  const limit = Math.min(options.limit, 10);
  const { values, relations: sql } = adoptionDataset(reports, context);
  const expected = { identity: context.identity, endpoint: "adoption", selectionId: context.selection.id,
    revision: context.selection.revision, queryHash: digest(JSON.stringify([context.queryHash, limit])) };
  const cursor = options.cursor ? reports.codec.decode(options.cursor, expected) : undefined;
  const reverse = cursor?.direction === "previous";
  const order = Boolean(reverse) !== (context.query.order === "desc") ? "DESC" : "ASC";
  let boundary = "";
  if (cursor) {
    if (cursor.boundary.key === null) throw new SelectionError("invalid_cursor");
    values.push(cursor.boundary.key, cursor.boundary.id);
    boundary = `WHERE (sort_key COLLATE "C",identity COLLATE "C") ${order === "DESC" ? "<" : ">"}
      ($10::text COLLATE "C",$11::text COLLATE "C")`;
  }
  const counts = (await client.query(`${sql} SELECT
    (SELECT count(*)::text FROM adoption_groups) AS total,
    (SELECT count(*)::text FROM matching_groups) AS filtered,
    (SELECT count(*)::text FROM adoption_users u JOIN matching_groups g ON g.identity=u.group_id) AS people,
    (SELECT coalesce(sum(champs),0)::text FROM (
      SELECT least(count(*),3) AS champs FROM adoption_users u JOIN matching_groups g ON g.identity=u.group_id
      WHERE coalesce(u.responses,u.bridge_responses,0)>0 OR EXISTS(SELECT 1 FROM creators c WHERE c.user_id=u.identity)
      GROUP BY u.group_id) candidates) AS champs,
    (SELECT count(DISTINCT a.agent_id)::text FROM adoption_users u JOIN matching_groups g ON g.identity=u.group_id
      JOIN user_agents a ON a.user_id=u.identity) AS agents`, values.slice(0, 9))).rows[0];
  const rows = (await client.query(`${sql} SELECT * FROM matching_groups ${boundary}
    ORDER BY sort_key COLLATE "C" ${order},identity COLLATE "C" ${order} LIMIT ${limit + 1}`, values)).rows;
  const more = rows.length > limit;
  const headers = rows.slice(0, limit);
  if (reverse) headers.reverse();
  const groupIds = headers.map(row => String(row.identity));
  const detailValues = [...values.slice(0, 9), groupIds];
  const inventoryAvailable = Boolean((await client.query(`${sql}
    SELECT EXISTS(SELECT 1 FROM current_sources) OR EXISTS(
      SELECT 1 FROM data_scope_epochs s JOIN inventory_roots root ON root.scope_id=s.id AND root.current
      JOIN inventory_revisions revision ON revision.scope_id=root.scope_id AND revision.revision=root.revision
      JOIN data_generations generation ON generation.id=revision.generation_id
      WHERE s.tenant_id=$4 AND s.principal_id=$8 AND s.source='inventory_canonical'
        AND s.token_mode='delegated' AND s.selector='complete'
        AND generation.state='published' AND generation.validated
        AND generation.scope_epoch=s.epoch AND generation.session_epoch=s.session_epoch
        AND generation.expires_at>transaction_timestamp()
    ) AS available`, detailValues.slice(0, 9))).rows[0].available);
  const peopleRows = groupIds.length ? (await client.query(`${sql}, person_metrics AS (
    SELECT u.identity,u.group_id,coalesce(nullif(u.display_name,''),u.upn) AS name,
      (SELECT count(*)::text FROM user_agents a WHERE a.user_id=u.identity) AS agents,
      (SELECT count(*) FROM creators a WHERE a.user_id=u.identity) AS created,
      coalesce(u.responses,u.bridge_responses) AS responses
    FROM adoption_users u WHERE u.group_id=ANY($10::text[])
  ), ranked AS (
    SELECT *,row_number() OVER(PARTITION BY group_id
      ORDER BY created DESC,responses DESC NULLS LAST,agents::bigint DESC,lower(name) COLLATE "C",identity) AS rank
    FROM person_metrics
  ) SELECT *,rank<=3 AND (created>0 OR coalesce(responses,0)>0) AS champion FROM ranked
    ORDER BY group_id,rank`, detailValues)).rows : [];
  const agentsRows = groupIds.length ? (await client.query(`${sql}, group_agents AS (
    SELECT DISTINCT u.group_id,a.agent_id FROM user_agents a JOIN adoption_users u ON u.identity=a.user_id
    WHERE u.group_id=ANY($10::text[])
  ) SELECT g.group_id,a.identity,a.display_name,
    (SELECT string_agg(DISTINCT f.text_value,' / ' ORDER BY f.text_value) FROM inventory_facts f
      WHERE f.generation_id=a.generation_id AND f.identity=a.identity AND f.kind='platform'
        AND f.value IN ('copilotstudio','microsoft365copilotagentbuilder')) AS type,
    (SELECT coalesce(nullif(btrim(p.residual->>'longDescription'),''),nullif(btrim(p.residual->'details'->>'description'),''),
      nullif(btrim(p.residual->>'shortDescription'),''))
      FROM current_sources s JOIN inventory_records p
        ON p.generation_id=s.source_generation_id AND p.identity=s.source_identity
      WHERE s.agent_id=a.identity
        AND coalesce(nullif(btrim(p.residual->>'longDescription'),''),nullif(btrim(p.residual->'details'->>'description'),''),
          nullif(btrim(p.residual->>'shortDescription'),'')) IS NOT NULL
      ORDER BY CASE WHEN nullif(btrim(p.residual->>'longDescription'),'') IS NOT NULL THEN 0
        WHEN nullif(btrim(p.residual->'details'->>'description'),'') IS NOT NULL THEN 1 ELSE 2 END,
        s.source,s.native_id LIMIT 1) AS description
    FROM group_agents g JOIN current_agents a ON a.identity=g.agent_id
    ORDER BY g.group_id,lower(a.display_name) COLLATE "C",a.identity`, detailValues)).rows : [];
  const people = new Map<string, AdoptionPerson[]>(), agents = new Map<string, AdoptionAgent[]>();
  for (const row of peopleRows) {
    const list = people.get(row.group_id) ?? [];
    list.push({ id: row.identity, name: row.name, agents: exactCount(row.agents),
      responses: row.responses === null ? null : exactCount(row.responses), champion: row.champion });
    people.set(row.group_id, list);
  }
  for (const row of agentsRows) {
    const list = agents.get(row.group_id) ?? [];
    list.push({ id: `agent:${row.identity}`, name: row.display_name, description: row.description,
      type: row.type });
    agents.set(row.group_id, list);
  }
  const encode = (row: pg.QueryResultRow | undefined, direction: "next" | "previous", enabled: boolean) =>
    row && enabled ? reports.codec.encode({ ...expected, direction,
      boundary: { key: row.sort_key, id: row.identity, nullRank: 0 } }) : null;
  const value: AdoptionGroup[] = headers.map(row => ({ id: row.identity, company: row.company ?? "Company not provided", department: row.department ?? "Department not provided",
    people: people.get(row.identity) ?? [], agents: agents.get(row.identity) ?? [] }));
  const result: AdoptionPage = { value, counts: { total: exactCount(counts.total), filtered: exactCount(counts.filtered) },
    page: { limit, nextCursor: encode(headers.at(-1), "next", reverse ? Boolean(cursor) : more),
      previousCursor: encode(headers[0], "previous", reverse ? more : Boolean(cursor)) },
    selection: context.selection, reports: context.report, directory: context.metadata.directory, inventoryAvailable,
    summary: { people: exactCount(counts.people), champs: exactCount(counts.champs), agents: exactCount(counts.agents) } };
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > 1_048_000) throw new AppError(413, "adoption_page_too_large",
    "These groups exceed the page size limit. Search for a specific company and department to narrow the page.");
  encodeBatch([result]);
  return result;
}
