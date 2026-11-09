import { randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { dataConnections } from "../db/dataConnections.js";
import { digest, exactCount, dataLimitError } from "../db/dataBounds.js";
import { officeObservation, officeStatus, readableOfficeSql, officeMetrics as metrics, officeSavedMetrics, officeGroupMetricProjection } from "../db/officeAppAdoption.js";
import { readAutomaticInventoryRevisions } from "../db/inventoryAutomaticRevisions.js";
import { CursorCodec, DataSelections, SelectionError, canonicalQuery, type DependencyRoot, type SelectionIdentity } from "./dataSelections.js";
import { officeQuery, officeQueryFields } from "./officeAppAdoption.js";
import { reportSearchSql } from "./largeTenantUsersReports.js";
import { type OfficeContext, type OfficeFacet, type OfficeFacetKind, type OfficeGroup, type OfficeHistoryPoint,
  type OfficePage, type OfficePageInfo, type OfficePerson, type OfficeQuery, type OfficeSummary } from "../types/officeAppAdoption.js";

type ReadContext = { context: OfficeContext; identity: SelectionIdentity; queryHash: string };
export type OfficePaging = { limit?: number; cursor?: string; pageNumber?: number; anchor?: string };
const endpoint = "office-app-adoption";
export function boundedOfficeResponse<T>(value: T): T {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > 1048576) throw dataLimitError("office_response_bytes", 1048576, bytes);
  return value;
}
export function officeGroupRelations(context: OfficeContext) {
  const query = context.query;
  const values: unknown[] = [context.observation?.id ?? null, JSON.stringify(query)];
  const sql = `WITH groups AS MATERIALIZED (
    SELECT group_id AS id,company,department,metrics FROM office_group_facts WHERE generation_id=$1
  ), matching_groups AS MATERIALIZED (
    SELECT * FROM groups g WHERE
      (NOT ($2::jsonb ? 'company') OR ${reportSearchSql("g.company")} IS NOT DISTINCT FROM
        ${reportSearchSql("nullif(btrim($2::jsonb->>'company'),'')")})
      AND (NOT ($2::jsonb ? 'department') OR ${reportSearchSql("g.department")} IS NOT DISTINCT FROM
        ${reportSearchSql("nullif(btrim($2::jsonb->>'department'),'')")})
      AND NOT EXISTS(SELECT 1 FROM regexp_split_to_table(${reportSearchSql("$2::jsonb->>'search'")},'\\s+') term
        WHERE term<>'' AND strpos(${reportSearchSql("coalesce(g.company,'Company not provided')||' / '||coalesce(g.department,'Department not provided')")},term)=0)
      AND (NOT ($2::jsonb ? 'app') OR (g.metrics->'perApp'->>($2::jsonb->>'app'))::bigint>0)
  )`;
  return { sql, values };
}

export class OfficeAppAdoptionReads {
  readonly connections;
  readonly selections: DataSelections;
  readonly codec: CursorCodec;
  constructor(readonly database: pg.Pool, secret: string) {
    this.connections = dataConnections(database);
    this.codec = new CursorCodec(secret);
    this.selections = new DataSelections(database, async (client, root, identity) => {
      if (root.kind === "office_history") {
        const row = (await client.query(`SELECT id FROM data_scope_epochs WHERE id=$1 AND tenant_id=$2
          AND source='office_history' AND selector='complete' AND epoch=$3`, [root.scopeId, identity.tenantId, root.revision])).rows[0];
        if (!row) throw new SelectionError("selection_invalidated", "unavailable");
      } else if (root.kind === "office_observation") {
        const row = (await client.query(`SELECT o.generation_id ${readableOfficeSql}
          AND o.generation_id=$2 AND o.scope_id=$3 AND h.revision=$4`, [identity.tenantId, root.generationId, root.scopeId, root.revision])).rows[0];
        if (!row) throw new SelectionError("selection_invalidated", "unavailable");
      } else throw new SelectionError("invalid_cursor");
    });
  }
  async capture(identity: SelectionIdentity, input: OfficeQuery = {}) {
    const query = officeQuery(input);
    const history = await this.connections.run(async client => {
      await client.query(`INSERT INTO data_scope_epochs(id,tenant_id,scope_kind,principal_id,token_mode,source,selector)
        VALUES($1,$2,'tenant',NULL,'tenant','office_history','complete') ON CONFLICT DO NOTHING`, [randomUUID(), identity.tenantId]);
      return (await client.query(`SELECT id,epoch::text FROM data_scope_epochs WHERE tenant_id=$1
        AND source='office_history' AND selector='complete' AND scope_kind='tenant'`, [identity.tenantId])).rows[0];
    });
    return this.selections.captureWith(identity, endpoint, { values: query, allowed: officeQueryFields }, async (client, evaluatedAt) => {
      const roots: DependencyRoot[] = [{ kind: "office_history", scopeId: history.id, revision: history.epoch,
        expiresAt: new Date(evaluatedAt.getTime() + 600000) }];
      const chosen = (await client.query(`SELECT o.generation_id,o.scope_id,h.revision::text,g.expires_at,o.report_refresh_date
        ${readableOfficeSql} AND (($2::uuid IS NULL AND o.kind='current') OR o.generation_id=$2)
        ORDER BY o.report_refresh_date DESC,o.generation_id LIMIT 1`, [identity.tenantId, query.officeSnapshot ?? null])).rows[0];
      if (query.officeSnapshot && !chosen) throw new SelectionError("selection_invalidated", "unavailable");
      if (chosen) roots.push({ kind: "office_observation", scopeId: chosen.scope_id, generationId: chosen.generation_id,
        revision: chosen.revision, expiresAt: chosen.expires_at });
      if (query.officeBaseline) {
        const baseline = (await client.query(`SELECT o.generation_id,o.scope_id,h.revision::text,g.expires_at
          ${readableOfficeSql} AND o.generation_id=$2 AND o.report_refresh_date<$3::date`,
        [identity.tenantId, query.officeBaseline, chosen?.report_refresh_date ?? null])).rows[0];
        if (!baseline) throw new AppError(400, "invalid_office_baseline", "Office baseline must be a retained observation preceding the selected observation.");
        roots.push({ kind: "office_observation", scopeId: baseline.scope_id, generationId: baseline.generation_id,
          revision: baseline.revision, expiresAt: baseline.expires_at });
      }
      // Timeline members have no individual generation pins; fence their earliest expiry.
      const timelineExpiry = (await client.query(`SELECT min(g.expires_at) AS expires_at
        FROM office_observations o JOIN data_generations g ON g.id=o.generation_id
        JOIN data_scope_epochs s ON s.id=o.scope_id AND s.tenant_id=o.tenant_id AND s.epoch=g.scope_epoch
        JOIN data_generation_heads h ON h.scope_id=o.scope_id AND h.generation_id=o.generation_id
        WHERE o.tenant_id=$1 AND g.state='published' AND g.validated AND o.kind='weekly'
          AND o.report_refresh_date<=$2::date AND g.observed_at<=$3::timestamptz AND g.expires_at>$3::timestamptz`,
      [identity.tenantId, chosen?.report_refresh_date ?? null, evaluatedAt])).rows[0].expires_at as Date | null;
      if (timelineExpiry) roots[0].expiresAt = new Date(Math.min(roots[0].expiresAt.getTime(), timelineExpiry.getTime()));
      return { roots };
    });
  }
  async read<T>(identity: SelectionIdentity, input: OfficeQuery, selectionId: string | undefined,
    work: (client: pg.PoolClient, read: ReadContext) => Promise<T>): Promise<T> {
    const query = officeQuery(input);
    const selection = selectionId ? { id: selectionId } : await this.capture(identity, query);
    return this.selections.read(selection.id, identity, async (client, selected) =>
      boundedOfficeResponse(await work(client, await this.contextInRead(client, identity, query, selected))));
  }
  async contextInRead(client: pg.PoolClient, identity: SelectionIdentity, query: OfficeQuery,
    { selection: saved, pins }: Awaited<ReturnType<DataSelections["assert"]>>): Promise<ReadContext> {
      if (saved.endpoint !== endpoint || saved.query_hash !== canonicalQuery(query, officeQueryFields)) throw new SelectionError("invalid_cursor");
      const observations = await Promise.all(pins.filter(pin => pin.root_kind === "office_observation")
        .map(pin => officeObservation(client, identity.tenantId, pin.generation_id)));
      observations.sort((a, b) => b.reportRefreshDate.localeCompare(a.reportRefreshDate));
      if (observations.length && (await client.query(`SELECT EXISTS(SELECT 1 FROM office_observations o
        JOIN data_generations g ON g.id=o.generation_id WHERE o.tenant_id=$1 AND o.report_refresh_date<=$2::date
          AND o.kind='weekly' AND g.state='published'
          AND EXISTS(SELECT 1 FROM data_generation_heads h WHERE h.generation_id=g.id)
          AND g.observed_at<=$3 AND g.expires_at>$3 AND g.expires_at<=clock_timestamp()) AS expired`,
      [identity.tenantId,observations[0].reportRefreshDate,saved.evaluated_at])).rows[0].expired)
        throw new SelectionError("selection_invalidated","expired");
      const context: OfficeContext = {
        observation: observations[0] ?? null, baseline: observations[1] ?? null, query,
        status: await officeStatus(client, identity.tenantId),
        selection: { id: saved.id, revision: saved.revision, evaluatedAt: saved.evaluated_at.toISOString(),
          expiresAt: saved.expires_at.toISOString(), validatedAt: saved.validated_at.toISOString(),
          publicationRevisions: await readAutomaticInventoryRevisions(identity, client) },
      };
      return { context, identity, queryHash: saved.query_hash };
  }
  context(identity: SelectionIdentity, query: OfficeQuery, selectionId?: string) {
    return this.read(identity, query, selectionId, async (_client, read) => read.context);
  }
  summary(identity: SelectionIdentity, query: OfficeQuery, selectionId?: string): Promise<OfficeSummary> {
    return this.read(identity, query, selectionId, async (client, { context }) => {
      if (!context.observation) return { organization: null, matching: null, matchingGroups: 0, filteredPeople: 0,
        suggestedChampions:null,filteredSuggestedChampions:null,baseline: null, context };
      const { sql, values } = officeGroupRelations(context);
      const organization = officeSavedMetrics((await client.query("SELECT metrics FROM office_observations WHERE generation_id=$1",
        [context.observation.id])).rows[0].metrics);
      const matching = metrics((await client.query(`${sql} SELECT ${officeGroupMetricProjection} FROM matching_groups`, values)).rows[0]);
      const filteredCount = context.query.app ? `(metrics->'perApp'->>'${context.query.app}')::bigint` : "(metrics->>'savedLicensedPeople')::bigint";
      const filteredActive = context.query.app ? filteredCount : "(metrics->>'reportedActiveUsers')::bigint";
      const counts = (await client.query(`${sql} SELECT (SELECT count(*)::text FROM matching_groups) AS groups,
        (SELECT coalesce(sum(${filteredCount}),0)::text FROM matching_groups) AS people,
        (SELECT coalesce(sum(least(${filteredActive},3)),0)::text FROM matching_groups) AS filtered_champions,
        (SELECT coalesce(sum(least((metrics->>'reportedActiveUsers')::bigint,3)),0)::text FROM groups) AS champions`, values)).rows[0];
      const baseline = context.baseline ? officeSavedMetrics((await client.query("SELECT metrics FROM office_observations WHERE generation_id=$1",
        [context.baseline.id])).rows[0].metrics) : null;
      return { organization, matching, matchingGroups: exactCount(counts.groups), filteredPeople: exactCount(counts.people),
        suggestedChampions: context.observation.kind==="current" ? exactCount(counts.champions) : null,
        filteredSuggestedChampions: context.observation.kind==="current" ? exactCount(counts.filtered_champions) : null, baseline, context };
    });
  }
  private cursorBinding(identity: SelectionIdentity, context: OfficeContext, queryHash: string, kind: string, limit: number) {
    return { identity, endpoint: `${endpoint}/${kind}`, selectionId: context.selection.id, revision: context.selection.revision,
      queryHash: digest(JSON.stringify([queryHash, limit])) };
  }
  private page(identity: SelectionIdentity, context: OfficeContext, queryHash: string, kind: string, options: OfficePaging, total: number, limit: number) {
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit<1 || options.limit>100)
      || options.pageNumber !== undefined && (!Number.isSafeInteger(options.pageNumber) || options.pageNumber<1)
      || options.anchor !== undefined && !/^[a-f0-9]{64}$/.test(options.anchor)
      || [options.cursor, options.anchor, options.pageNumber].filter(value => value !== undefined).length>1) throw new SelectionError("invalid_cursor");
    const expected = this.cursorBinding(identity,context,queryHash,kind,limit);
    const key = "";
    const cursor = options.cursor ? this.codec.decode(options.cursor, expected) : null;
    let number = options.pageNumber ?? 1;
    if (cursor) {
      if (!/^[1-9]\d*$/.test(cursor.boundary.id) || cursor.boundary.key !== key) throw new SelectionError("invalid_cursor");
      number = Number(cursor.boundary.id);
    }
    if (!Number.isSafeInteger(number) || number<1 || number>Math.max(1,Math.ceil(total/limit))) throw new AppError(400, "invalid_office_page", "Page number is outside the selected dataset.");
    const page: OfficePageInfo = { limit, number, pages: Math.ceil(total/limit), offset: (number-1)*limit,
      anchor: null, previousCursor: number>1 ? this.codec.encode({ ...expected, direction: "previous", boundary: { id: String(number-1), key, nullRank: 0 } }) : null,
      nextCursor: number*limit<total ? this.codec.encode({ ...expected, direction: "next", boundary: { id: String(number+1), key, nullRank: 0 } }) : null };
    return page;
  }
  groups(identity: SelectionIdentity, query: OfficeQuery, selectionId?: string, options: OfficePaging = {}, departments = false): Promise<OfficePage<OfficeGroup>> {
    if (!departments && options.limit !== undefined && options.limit !== 5) throw new AppError(400, "invalid_office_query", "Office groups use five groups per page.");
    if (departments && options.anchor !== undefined) throw new SelectionError("invalid_cursor");
    return this.read(identity, query, selectionId, async (client, { context, queryHash }) => {
      const { sql, values } = officeGroupRelations(context);
      const counts = (await client.query(`${sql} SELECT (SELECT count(*)::text FROM groups) AS total,
        (SELECT count(*)::text FROM matching_groups) AS filtered`, values)).rows[0];
      const total = exactCount(counts.total), filtered = exactCount(counts.filtered);
      const limit = departments ? options.limit ?? 50 : 5;
      let requested = options;
      if (options.anchor) {
        this.page(identity,context,queryHash,departments ? "departments" : "groups",options,filtered,limit);
        const position = (await client.query(`${sql}, ordered AS (
          SELECT id,row_number() OVER(ORDER BY ${reportSearchSql("coalesce(company,'')||' / '||coalesce(department,'')")} COLLATE "C",id COLLATE "C") AS number
          FROM matching_groups) SELECT number::text FROM ordered WHERE id=$3`, [...values, options.anchor])).rows[0];
        requested = { ...options, anchor: undefined, pageNumber: position ? Math.floor((exactCount(position.number)-1)/limit)+1 : 1 };
      }
      const page = this.page(identity, context, queryHash, departments ? "departments" : "groups", requested, filtered, limit);
      const groupOrder = `${reportSearchSql("coalesce(g.company,'')||' / '||coalesce(g.department,'')")} COLLATE "C",g.id COLLATE "C"`;
      const groupFacts = `FROM office_person_facts WHERE generation_id=$1
        AND payload->>'groupId'=g.id AND payload->>'entitlement'='paid_active'`;
      const departmentOrder = `(g.metrics->>'noRecentEvidencePeople')::bigint DESC,(g.metrics->>'savedLicensedPeople')::bigint DESC,`;
      const pagedGroups = departments ? `page_groups AS (SELECT g.* FROM matching_groups g
        ORDER BY ${departmentOrder}${groupOrder} LIMIT $3 OFFSET $4)`
        : `page_groups AS (SELECT g.* FROM matching_groups g ORDER BY ${groupOrder} LIMIT $3 OFFSET $4)`;
      const championOrder = `jsonb_array_length(payload->'recentApps') DESC,payload->>'latestRecentDate' DESC NULLS LAST,
        ${reportSearchSql("coalesce(nullif(btrim(payload->>'displayName'),''),payload->>'userPrincipalName')")} COLLATE "C",identity COLLATE "C"`;
      const rows = (await client.query(`${sql}, ${pagedGroups}
        SELECT g.*,
          ${context.query.app ? `(g.metrics->'perApp'->>'${context.query.app}')` : "(g.metrics->>'savedLicensedPeople')"} AS filtered_people,
          ${context.observation?.kind==="current" ? `coalesce((SELECT jsonb_agg(payload ORDER BY ${championOrder}) FROM
            (SELECT identity,payload ${groupFacts} AND jsonb_array_length(payload->'recentApps')>0
              ${context.query.app ? "AND payload->'recentApps' ? ($2::jsonb->>'app')" : ""}
              ORDER BY ${championOrder} LIMIT 3) champions),'[]'::jsonb)` : "'[]'::jsonb"} AS champions
        FROM page_groups g ORDER BY ${departments ? departmentOrder : ""}${groupOrder}`,
      [...values, limit, page.offset])).rows;
      const value: OfficeGroup[] = rows.map(row => {
        const summary = officeSavedMetrics(row.metrics);
        return { id: row.id, company: row.company, department: row.department, metrics: summary,
          participation: summary.savedLicensedPeople ? summary.reportedActiveUsers/summary.savedLicensedPeople : null,
          filteredPeople: exactCount(row.filtered_people), champions: row.champions };
      });
      page.anchor = value[0]?.id ?? null;
      return { value, page, counts: { total, filtered }, context };
    });
  }
  people(identity: SelectionIdentity, query: OfficeQuery, groupId: string, selectionId?: string, options: OfficePaging = {}): Promise<OfficePage<OfficePerson>> {
    if (!/^[a-f0-9]{64}$/.test(groupId)) throw new AppError(400, "invalid_office_group", "Expected a selected Office group identity.");
    if (options.anchor !== undefined || options.cursor !== undefined && options.pageNumber !== undefined) throw new SelectionError("invalid_cursor");
    return this.read(identity, query, selectionId, async (client, { context, queryHash }) => {
      if (context.observation?.kind==="weekly") throw new AppError(409, "office_history_aggregate_only",
        "Weekly Office history contains app and group totals only. Select Latest to explore current people.");
      const values = [context.observation?.id ?? null, JSON.stringify(context.query), groupId];
      const where = `FROM office_person_facts WHERE generation_id=$1 AND payload->>'groupId'=$3
        AND payload->>'entitlement'='paid_active' AND $2::jsonb IS NOT NULL
        ${context.query.company === undefined ? "" : `AND ${reportSearchSql("payload->>'company'")} IS NOT DISTINCT FROM
          ${reportSearchSql("nullif(btrim($2::jsonb->>'company'),'')")}`}
        ${context.query.department === undefined ? "" : `AND ${reportSearchSql("payload->>'department'")} IS NOT DISTINCT FROM
          ${reportSearchSql("nullif(btrim($2::jsonb->>'department'),'')")}`}
        ${!context.query.search ? "" : `AND NOT EXISTS(SELECT 1 FROM regexp_split_to_table(${reportSearchSql("$2::jsonb->>'search'")},'\\s+') term
          WHERE term<>'' AND strpos(${reportSearchSql("coalesce(payload->>'company','Company not provided')||' / '||coalesce(payload->>'department','Department not provided')")},term)=0)`}`;
      const app = context.query.app ? "payload->'recentApps' ? ($2::jsonb->>'app')" : "true";
      const limit = options.limit ?? 50;
      const expected = this.cursorBinding(identity,context,queryHash,`people/${groupId}`,limit);
      const cursor = options.cursor ? this.codec.decode(options.cursor,expected) : null;
      let total: number, filtered: number;
      let boundaryName = "", boundaryIdentity = "";
      if (cursor) {
        let counts: unknown;
        try { counts=JSON.parse(cursor.boundary.key ?? ""); } catch { throw new SelectionError("invalid_cursor"); }
        if (!Array.isArray(counts) || counts.length!==3
          || counts.slice(0,2).some(value=>!Number.isSafeInteger(value) || value<0)
          || counts[1]>counts[0] || typeof counts[2]!=="string"
          || !counts[2] || counts[2].length>512
          || cursor.boundary.nullRank!==0
          || !/^[1-9]\d*$/.test(cursor.boundary.id)) throw new SelectionError("invalid_cursor");
        [total,filtered,boundaryIdentity]=counts;
      } else {
        const counts = (await client.query(`SELECT count(*)::text AS total,
          count(*) FILTER(WHERE ${app})::text AS filtered ${where}`, values)).rows[0];
        filtered=exactCount(counts.filtered); total=query.app && !filtered ? 0 : exactCount(counts.total);
      }
      const page = this.page(identity, context, queryHash, `people/${groupId}`,
        cursor ? { ...options, cursor:undefined, pageNumber:Number(cursor.boundary.id) } : options, filtered, limit);
      const sort = reportSearchSql("coalesce(nullif(btrim(payload->>'displayName'),''),payload->>'userPrincipalName')");
      if (cursor) {
        // NFKC can expand supported names beyond the cursor budget; resolve them in the selected snapshot.
        const boundary = (await client.query(`SELECT ${sort} AS sort_name ${where} AND ${app} AND identity=$4`,
          [...values,boundaryIdentity])).rows[0];
        if (!boundary || typeof boundary.sort_name!=="string") throw new SelectionError("invalid_cursor");
        boundaryName=boundary.sort_name;
      }
      const previous = cursor?.direction==="previous";
      const comparison = previous ? "<" : ">";
      const rows = (await client.query(`SELECT payload,identity ${where} AND ${app}
        ${cursor ? `AND (${sort} COLLATE "C",identity COLLATE "C") ${comparison} ($5::text COLLATE "C",$6::text COLLATE "C")` : ""}
        ORDER BY ${sort} COLLATE "C" ${previous ? "DESC" : "ASC"},identity COLLATE "C" ${previous ? "DESC" : "ASC"}
        LIMIT $4 ${cursor ? "" : "OFFSET $5"}`,
      [...values,limit,...(cursor ? [boundaryName,boundaryIdentity] : [page.offset])])).rows;
      if (previous) rows.reverse();
      const encode = (direction: "previous" | "next", number: number, row: typeof rows[number]) =>
        this.codec.encode({ ...expected,direction,boundary:{ id:String(number),
          key:JSON.stringify([total,filtered,row.identity]),nullRank:0 } });
      page.previousCursor=page.previousCursor && rows.length ? encode("previous",page.number-1,rows[0]) : null;
      page.nextCursor=page.nextCursor && rows.length ? encode("next",page.number+1,rows[rows.length-1]) : null;
      return { value: rows.map(row => row.payload as OfficePerson), page, counts: { total, filtered }, context };
    });
  }
  facets(identity: SelectionIdentity, query: OfficeQuery, kind: OfficeFacetKind, selectionId?: string, options: OfficePaging = {}): Promise<OfficePage<OfficeFacet>> {
    if (!["company","department"].includes(kind) || options.anchor !== undefined) throw new AppError(400,"invalid_office_facet","Expected company or department.");
    return this.read(identity, query, selectionId, async (client, { context, queryHash }) => {
      const { sql, values } = officeGroupRelations(context);
      const count = (await client.query(`${sql} SELECT count(*)::text AS count FROM (
        SELECT ${reportSearchSql(kind)} FROM matching_groups GROUP BY ${reportSearchSql(kind)}) facets`, values)).rows[0];
      const total = exactCount(count.count), limit = options.limit ?? 50;
      const page = this.page(identity, context, queryHash, `facets/${kind}`, options, total, limit);
      const countExpression = context.query.app ? `(g.metrics->'perApp'->>'${context.query.app}')::bigint` : "(g.metrics->>'savedLicensedPeople')::bigint";
      const rows = (await client.query(`${sql} SELECT min(g.${kind} COLLATE "C") AS value,count(*)::text AS groups,sum(${countExpression})::text AS people
        FROM matching_groups g GROUP BY ${reportSearchSql(`g.${kind}`)}
        ORDER BY ${reportSearchSql(`g.${kind}`)} COLLATE "C" NULLS LAST LIMIT $3 OFFSET $4`, [...values, limit, page.offset])).rows;
      return { value: rows.map(row => ({ value: row.value, groups: exactCount(row.groups), people: exactCount(row.people) })),
        page, counts: { total, filtered: total }, context };
    });
  }
  history(identity: SelectionIdentity, query: OfficeQuery, selectionId?: string, options: OfficePaging = {}): Promise<OfficePage<OfficeHistoryPoint>> {
    if (options.anchor !== undefined) throw new SelectionError("invalid_cursor");
    return this.read(identity, query, selectionId, async (client, { context, queryHash }) => {
      const values = [identity.tenantId, context.observation?.reportRefreshDate ?? null, context.selection.evaluatedAt];
      const where = `${readableOfficeSql} AND o.kind='weekly' AND o.report_refresh_date<=$2::date AND g.observed_at<=$3::timestamptz`;
      const total = exactCount((await client.query(`SELECT count(*)::text AS count ${where}`, values)).rows[0].count);
      const limit = options.limit ?? 50, page = this.page(identity, context, queryHash, "history", options, total, limit);
      const rows = (await client.query(`SELECT o.generation_id,o.metrics ${where} ORDER BY o.report_refresh_date DESC,o.generation_id LIMIT $4 OFFSET $5`,
      [...values, limit, page.offset])).rows;
      const value: OfficeHistoryPoint[] = [];
      for (const row of rows) {
        const observation = await officeObservation(client, identity.tenantId, row.generation_id);
        value.push({ observation, metrics: officeSavedMetrics(row.metrics) });
      }
      return { value, page, counts: { total, filtered: total }, context };
    });
  }
}
