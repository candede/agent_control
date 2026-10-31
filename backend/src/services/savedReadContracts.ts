import type pg from "pg";
import { AppError } from "../errors.js";
import { digest, exactCount } from "../db/dataBounds.js";
import { reportRelationsSql } from "../db/officialReportQueries.js";
import { selectedInventorySourcesSql } from "../db/inventorySelections.js";
import type { InventoryQueries } from "../db/inventoryQueries.js";
import type { AgentRelationship, ChampionAgentPage, SavedAgentRelationship, SavedRelationshipPage, UserResolution } from "../types/savedReadContracts.js";
import type { LargeTenantUsersReports, ReportReadContext } from "./largeTenantUsersReports.js";
import { SelectionError, type SelectionIdentity } from "./dataSelections.js";
import { adoptionDataset } from "./adoptionGroups.js";
import { bounded } from "./largeTenantUsersReports.js";

// These are selected saved reads, not provider/directory resolution operations.
export class SavedReadContracts {
  constructor(readonly reports: LargeTenantUsersReports, readonly inventory: InventoryQueries) {}

  resolve(id: string, identity: SelectionIdentity, username: string): Promise<UserResolution> {
    return this.reports.read(id, identity, async (client, context) => {
      if (context.endpoint !== "copilot_users") throw new SelectionError("invalid_cursor");
      const rows = (await client.query(`${reportRelationsSql}
        SELECT (SELECT count(*)::text FROM directory WHERE upn_key=lower(btrim($7) COLLATE "default") COLLATE "C") AS matches,
          (SELECT min(identity) FROM directory WHERE upn_key=lower(btrim($7) COLLATE "default") COLLATE "C") AS object_id,
          (SELECT username FROM report_users WHERE username=$7 LIMIT 1) AS exact_report,
          (SELECT reported_username FROM combined WHERE identity=(
            SELECT min(identity) FROM directory WHERE upn_key=lower(btrim($7) COLLATE "default") COLLATE "C")) AS reported_username,
          EXISTS(SELECT 1 FROM matches m WHERE (m.username=$7 OR m.directory_identity_key IN (
            SELECT identity_key FROM directory_keys WHERE identity=(
              SELECT min(identity) FROM directory WHERE upn_key=lower(btrim($7) COLLATE "default") COLLATE "C")))
            AND (m.match_count>1 OR m.user_rows>1 OR m.alias_ambiguous))
            OR EXISTS(SELECT 1 FROM resolved WHERE identity_count>1 AND identity=(
              SELECT min(identity) FROM directory WHERE upn_key=lower(btrim($7) COLLATE "default") COLLATE "C")) AS ambiguous_report`,
      [...this.reports.parameters(context), username])).rows[0];
      const matches = exactCount(rows.matches);
      const state: UserResolution["state"] = matches > 1 ? "ambiguous" : matches === 1 ? "resolved"
        : context.metadata.directory.generationId === null ? "directory_missing"
          : rows.exact_report ? "concealed_or_unresolved" : "unresolved";
      return { username, state, objectId: matches === 1 ? rows.object_id : null, directoryMatches: matches,
        reportedUsername: matches === 1 ? rows.reported_username : rows.exact_report,
        reportIdentityState: rows.ambiguous_report ? "ambiguous" : rows.reported_username ? "matched" : rows.exact_report ? "unresolved" : "missing",
        concealment: "unknown", selection: context.selection, directory: context.metadata.directory, reports: context.report };
    });
  }

  private async compound(client: pg.PoolClient, context: ReportReadContext, inventoryId: string) {
    const { context: selected, selection } = await this.inventory.contextInRead(client, inventoryId, context.identity);
    if (selected.source !== "inventory_canonical") throw new SelectionError("invalid_cursor");
    if (selected.data.metadata.directory.generationId !== context.metadata.directory.generationId
      || selected.data.report.historyRevision !== context.report.historyRevision || selected.data.report.historyEpoch !== context.report.historyEpoch) {
      throw new AppError(409, "selection_invalidated", "Report, directory and inventory join selections no longer share the same saved dependencies.");
    }
    // Full person/cohort relationships must not accidentally inherit a category UI filter.
    if (Object.entries(selected.query).some(([key, value]) => !["setId", "sortBy", "sortDirection"].includes(key)
      && !(["inventoryScope", "view", "source"].includes(key) && value === "all"))) {
      throw new AppError(400, "relationship_inventory_scope", "Capture an all-inventory selection for complete person relationships.");
    }
    return { id: inventoryId, revision: String(selection.revision), evaluatedAt: new Date(selection.evaluated_at).toISOString(),
      expiresAt: new Date(selection.expires_at).toISOString(), validatedAt: new Date(selection.validated_at).toISOString(),
      publicationRevisions: selected.data.publicationRevisions };
  }

  private relations() {
    return `, sources AS MATERIALIZED (${selectedInventorySourcesSql("$4", "$7", "NULL", "$8")}),
      canonical AS MATERIALIZED (
        SELECT DISTINCT r.identity,r.generation_id,r.display_name FROM sources s JOIN unified_agent_rows r
          ON r.generation_id=s.control_revision AND r.identity=s.agent_id
      ), links AS (
        SELECT DISTINCT s.agent_id,a.report_agent_id FROM sources s JOIN agent_usage_associations a
          ON a.tenant_id=$4 AND a.report_set_id=$5 AND a.source=s.source
          AND a.normalized_native_id=s.normalized_native_id AND a.normalized_environment_id=s.normalized_environment_id
        UNION SELECT s.agent_id,s.native_id FROM sources s WHERE s.source='graph_packages'
          AND NOT EXISTS(SELECT 1 FROM agent_usage_associations a WHERE a.tenant_id=$4 AND a.report_set_id=$5 AND a.report_agent_id=s.native_id)
      ), link_counts AS (
        SELECT report_agent_id,count(*) AS matches,min(agent_id) AS agent_id FROM links GROUP BY report_agent_id
      ), relationships AS (
        SELECT 'agent:'||a.identity AS id,a.identity AS canonical_id,NULL::text AS report_agent_id,a.display_name AS name,
          CASE f.kind WHEN 'person:createdBy' THEN 'created' WHEN 'person:owner' THEN 'owned' ELSE 'modified' END AS relationship,
          f.value AS person_id,NULL::text AS reported_username,NULL::numeric AS responses,NULL::date AS last_activity,
          'inventory'::text AS source,'canonical'::text AS identity_state
        FROM canonical a JOIN inventory_facts f ON f.generation_id=a.generation_id AND f.identity=a.identity
          AND f.kind IN ('person:createdBy','person:owner','person:lastModifiedBy')
        UNION ALL
        SELECT CASE WHEN l.matches=1 THEN 'agent:'||l.agent_id ELSE 'report:'||r.agent_id END,
          CASE WHEN l.matches=1 THEN l.agent_id END,r.agent_id,coalesce(a.display_name,r.agent_name,r.agent_id),'used',
          u.identity,r.username,r.responses,r.last_activity,'userAgents',CASE WHEN l.matches=1 THEN 'canonical'
            WHEN l.matches>1 THEN 'ambiguous' ELSE 'report_only' END
        FROM reports r JOIN resolved u ON u.username=r.username AND u.identity_count=1
          LEFT JOIN link_counts l ON l.report_agent_id=r.agent_id LEFT JOIN canonical a ON a.identity=l.agent_id AND l.matches=1
        WHERE r.kind='userAgents'
      )`;
  }

  private async page(client: pg.PoolClient, context: ReportReadContext, inventoryId: string,
    inventorySelection: SavedRelationshipPage["inventorySelection"], sql: string, values: unknown[], key: unknown[],
    needsReport: boolean, options: { limit: number; cursor?: string }): Promise<SavedRelationshipPage> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new SelectionError("invalid_cursor");
    const expected = { identity: context.identity, endpoint: "saved-agent-relationships", selectionId: context.selection.id,
      revision: digest(JSON.stringify([context.selection.revision, inventorySelection.id, inventorySelection.revision,
        inventorySelection.evaluatedAt, inventorySelection.expiresAt, inventorySelection.publicationRevisions])),
      queryHash: digest(JSON.stringify([key, options.limit])) };
    const cursor = options.cursor ? this.reports.codec.decode(options.cursor, expected) : undefined;
    if (cursor && (cursor.direction !== "next" || cursor.boundary.key !== "" || cursor.boundary.nullRank !== 0)) throw new SelectionError("invalid_cursor");
    const counts = (await client.query(`${sql} SELECT count(*)::text AS total,count(DISTINCT id)::text AS agents FROM requested`, values)).rows[0];
    const total = exactCount(counts.total);
    const n = values.length;
    const rows = (await client.query(`${sql}, ordered AS (
        SELECT *,encode(sha256(convert_to(jsonb_build_array(person_id,relationship,id,report_agent_id)::text,'UTF8')),'hex') AS edge FROM requested
      ), picked AS (
        SELECT * FROM ordered WHERE edge COLLATE "C">$${n + 1} ORDER BY edge COLLATE "C" LIMIT $${n + 2}
      ), sized AS (
        SELECT *,sum(octet_length(to_jsonb(picked)::text)+1024) OVER(ORDER BY edge COLLATE "C") AS bytes,
          count(*) OVER()::int AS candidates FROM picked
      ) SELECT sized.*,last_activity::text AS last_activity FROM sized
        WHERE bytes<=458752 OR edge=(SELECT min(edge COLLATE "C") FROM picked) ORDER BY edge COLLATE "C"`,
    [...values, cursor?.boundary.id ?? "", options.limit + 1])).rows;
    if (rows[0]?.bytes > 458752) throw new AppError(413, "data_response_bytes", "One relationship exceeds the output bound.");
    const page = rows.slice(0, options.limit);
    const value: SavedAgentRelationship[] = page.map(row => ({ id: row.id, canonicalId: row.canonical_id ? `agent:${row.canonical_id}` : null,
      reportAgentId: row.report_agent_id, name: row.name, relationship: row.relationship, personId: row.person_id,
      reportedUsername: row.reported_username, responses: row.responses === null ? null : exactCount(row.responses),
      lastActivityDateUtc: row.last_activity ? `${row.last_activity}T00:00:00.000Z` : null, source: row.source, identityState: row.identity_state,
      sourceReferences: row.canonical_id ? { selectionId: inventoryId, path: `/api/agent-inventory/agent:${row.canonical_id}/members` } : null }));
    await this.inventory.selections.assert(client, inventoryId, context.identity);
    const missing = needsReport && !context.report.lineages.some(source => source.kind === "userAgents");
    return bounded({ value, counts: { total: missing ? null : total, distinctAgents: missing ? null : exactCount(counts.agents), returned: value.length }, page: { limit: options.limit,
      nextCursor: page.length && (rows.length > options.limit || rows[0].candidates > page.length)
        ? this.reports.codec.encode({ ...expected, direction: "next", boundary: { key: "", nullRank: 0, id: page.at(-1)!.edge } }) : null },
      selection: context.selection, inventorySelection, directory: context.metadata.directory, reports: context.report,
      relationshipState: missing ? "unavailable" : "available", missingReasons: missing ? ["userAgents_report_missing"] : [] }, 524288);
  }

  relationships(id: string, identity: SelectionIdentity, inventoryId: string, objectId: string, relationship: AgentRelationship,
    options: { limit: number; cursor?: string }) {
    return this.reports.read(id, identity, async (client, context) => {
      if (context.endpoint !== "copilot_users") throw new SelectionError("invalid_cursor");
      const inventorySelection = await this.compound(client, context, inventoryId);
      await this.reports.exactInRead(client, context, objectId);
      const sql = `${reportRelationsSql}${this.relations()}, requested AS (
        SELECT * FROM relationships WHERE person_id=$9 AND relationship=$10)`;
      return this.page(client, context, inventoryId, inventorySelection, sql, [...this.reports.parameters(context), identity.principalId, inventoryId, objectId, relationship],
        [objectId, relationship], relationship === "used", options);
    });
  }

  champions(id: string, identity: SelectionIdentity, inventoryId: string, options: { limit: number; cursor?: string }): Promise<ChampionAgentPage> {
    return this.reports.read(id, identity, async (client, context) => {
      if (context.endpoint !== "adoption" || !Object.hasOwn(context.query, "company") || !Object.hasOwn(context.query, "department")) {
        throw new AppError(400, "champion_group_required", "Select one exact company and department.");
      }
      const inventorySelection = await this.compound(client, context, inventoryId);
      const dataset = adoptionDataset(this.reports, context);
      const group = (await client.query<{ company: string | null; department: string | null;
        people: Array<{ identity: string; name: string | null; rank: number; responses: string | null; agents: string }> }>(
        `${dataset.relations} SELECT (SELECT company FROM matching_groups LIMIT 1) AS company,
          (SELECT department FROM matching_groups LIMIT 1) AS department,
          coalesce(jsonb_agg(to_jsonb(person) ORDER BY person.rank) FILTER(WHERE person.identity IS NOT NULL),'[]'::jsonb) AS people
        FROM (SELECT identity,name,rank::int,responses::text,agents::text FROM adoption_champions) person
        RIGHT JOIN (SELECT 1) anchor ON true`, dataset.values)).rows[0];
      const people = group.people;
      const ids = people.map(row => row.identity);
      const created = (await client.query(`${reportRelationsSql}${this.relations()}
        SELECT person_id,count(DISTINCT id)::text AS count FROM relationships
        WHERE person_id=ANY($9::text[]) AND relationship='created' GROUP BY person_id`,
      [...this.reports.parameters(context), identity.principalId, inventoryId, ids])).rows;
      const createdCounts = new Map<string, number>(created.map(row => [row.person_id, exactCount(row.count)]));
      const sql = `${reportRelationsSql}${this.relations()}, requested AS (
        SELECT * FROM relationships WHERE person_id=ANY($9::text[]) AND relationship IN ('used','created'))`;
      const page = await this.page(client, context, inventoryId, inventorySelection, sql, [...this.reports.parameters(context), identity.principalId, inventoryId, ids],
        [context.query.company, context.query.department, ids], true, options);
      return bounded({ ...page, company: group.company, department: group.department,
        champions: people.map(row => ({ objectId: row.identity, name: row.name, rank: row.rank, created: createdCounts.get(row.identity) ?? 0,
          responses: row.responses === null ? null : exactCount(row.responses),
          agents: context.report.lineages.some(lineage => lineage.kind === "userAgents") ? exactCount(row.agents) : null })) }, 524288);
    });
  }
}
