import { randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";
import type pg from "pg";
import { AppError } from "../errors.js";
import { dataConnections } from "./dataConnections.js";
import { dataLimits, digest, encodeBatch, exactCount } from "./dataBounds.js";
import { CursorCodec, DataSelections, SelectionError, canonicalQuery, type CursorBoundary, type DependencyRoot, type SelectionIdentity } from "../services/dataSelections.js";
import { isCopilotAppActivityFresh, isGraphGuid } from "../types/copilotUsage.js";
import { automaticDataSyncIntervalMs } from "../types/dataSync.js";
import type { AgentPersonObservation } from "./agentPeople.js";
import type { UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { agentPersonLabel } from "../types/agentPresentation.js";
import type {
  UserSourceFacts, UserSourceFilter, UserSourceMetadata, UserSourcePage,
  UserSourcePeople, UserSourceScope, UserSourceSummary, UserSourcePlan,
} from "../types/userSources.js";

const queryFields = ["search", "company", "department", "entitlement", "serviceState", "activity", "sort", "order"] as const;
const endpoint = "/user-source-facts";
const activityMatchCounts = new WeakMap<pg.Pool, Map<string, number>>();
export type UserSourceMetadataSet = { directory: UserSourceMetadata; app_activity: UserSourceMetadata };
export type UserSourceReadContext = {
  metadata: UserSourceMetadataSet; evaluatedAt: Date; scope: UserSourceScope;
  selection: import("../types/dataSelection.js").SelectedRead;
  query: UserSourceFilter; queryHash: string;
};

export function userSourceFilter(query: UserSourceFilter): UserSourceFilter {
  if (Object.keys(query).some(key => !queryFields.includes(key as typeof queryFields[number]))) throw new SelectionError("invalid_cursor");
  for (const key of ["company", "department"] as const) {
    const value = query[key];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 256 || /[\0\r\n]/.test(value))) throw new SelectionError("invalid_cursor");
  }
  if (query.search === null || query.sort !== undefined && !["name", "upn", "company", "department", "service", "activity"].includes(query.sort)
    || query.order !== undefined && !["asc", "desc"].includes(query.order)
    || query.entitlement !== undefined && !["paid_active", "paid_inactive", "no_paid", "unknown"].includes(query.entitlement)
    || query.activity !== undefined && !["active", "inactive", "unknown"].includes(query.activity)
    || query.serviceState !== undefined && !["enabled", "warning", "partially_enabled", "disabled", "suspended", "locked_out", "unknown"].includes(query.serviceState)) {
    throw new SelectionError("invalid_cursor");
  }
  return { ...query, ...(query.search === undefined ? {} : { search: userSourceSearch(query.search) }),
    sort: query.sort ?? "name", order: query.order ?? "asc" };
}

// Composable relational source, not a final users/report cohort. 02A adds real
// report facts inside the SAME selected-read client and evaluated-at snapshot.
export function userSourceFactsSql(selected = false) {
  const projection = `SELECT d.identity,d.upn,d.upn_key,d.display_name,d.sort_key,d.company,d.department,
    d.account_enabled,d.user_type,d.employee_type,d.service_state,d.plan_count,
    CASE WHEN d.service_state='unknown' THEN 'unknown'
      WHEN d.service_state IN ('enabled','warning','partially_enabled') THEN 'paid_active'
      WHEN d.plan_count=0 THEN 'no_paid' ELSE 'paid_inactive' END AS entitlement,
    a.identity AS activity_identity,a.report_refresh_date,a.last_activity_date,a.chat_date,a.teams_date,
    a.word_date,a.excel_date,a.powerpoint_date,a.outlook_date,a.onenote_date,a.loop_date,
    CASE WHEN a.report_refresh_date IS NULL OR a.last_activity_date IS NULL
      OR $3::timestamptz >= ((a.report_refresh_date::timestamp+interval '5 days') AT TIME ZONE 'UTC') THEN 'unknown'
      WHEN a.last_activity_date BETWEEN a.report_refresh_date-(CASE a.period WHEN 'D28' THEN 27 ELSE 29 END) AND a.report_refresh_date THEN 'active'
      ELSE 'inactive' END AS activity_state`;
  if (selected) return `${projection} FROM selected_directory d
    LEFT JOIN LATERAL (
      SELECT candidate.* FROM app_activity_rows candidate WHERE candidate.generation_id=$2
        AND candidate.upn_key IN (d.identity,d.upn_key)
        AND (SELECT count(*) FROM app_activity_rows other WHERE other.generation_id=$2
          AND other.upn_key IN (d.identity,d.upn_key))=1
        AND (SELECT count(*) FROM directory_user_rows other WHERE other.generation_id=$1
          AND (other.identity=candidate.upn_key OR other.upn_key=candidate.upn_key))=1 LIMIT 1
    ) a ON true WHERE d.generation_id=$1`;
  // Count aliases before joining: duplicate aliases on both sides must not
  // produce a directory-by-activity cross product or hide ambiguous identities.
  return `WITH activity_keys AS MATERIALIZED (
      SELECT upn_key,count(*) AS matches,min(identity) AS identity FROM app_activity_rows
      WHERE generation_id=$2 GROUP BY upn_key
    ), directory_aliases AS MATERIALIZED (
      SELECT identity,identity AS key FROM directory_user_rows WHERE generation_id=$1
      UNION ALL SELECT identity,upn_key FROM directory_user_rows
      WHERE generation_id=$1 AND upn_key IS NOT NULL AND upn_key IS DISTINCT FROM identity
    ), directory_keys AS MATERIALIZED (
      SELECT key,count(*) AS matches FROM directory_aliases GROUP BY key
    ), activity_matches AS MATERIALIZED (
      SELECT aliases.identity AS directory_identity,min(activity.identity) AS activity_identity
      FROM directory_aliases aliases
      JOIN activity_keys activity ON activity.upn_key=aliases.key
      JOIN directory_keys directory ON directory.key=aliases.key
      GROUP BY aliases.identity
      HAVING sum(activity.matches)=1 AND bool_and(directory.matches=1)
    ) ${projection} FROM directory_user_rows d
    LEFT JOIN activity_matches matched ON matched.directory_identity=d.identity
    LEFT JOIN app_activity_rows a ON a.generation_id=$2 AND a.identity=matched.activity_identity
    WHERE d.generation_id=$1`;
}

export function userSourceSqlParameters(context: Pick<UserSourceReadContext, "metadata" | "evaluatedAt">): unknown[] {
  return [context.metadata.directory.generationId, context.metadata.app_activity.generationId,
    context.evaluatedAt];
}

export class UserSourcesRepository {
  readonly connections;
  readonly selections: DataSelections;
  private readonly codec: CursorCodec;
  constructor(readonly database: pg.Pool, cursorSecret: string) {
    this.connections = dataConnections(database);
    this.selections = new DataSelections(database, (client, root, identity) => this.validateRoot(client, root, identity));
    this.codec = new CursorCodec(cursorSecret);
  }

  async validateRoot(client: pg.PoolClient, root: DependencyRoot, identity: SelectionIdentity) {
    if (root.kind !== "user_sources") throw new AppError(400, "invalid_cursor", "Selection endpoint mismatch.");
    const row = (await client.query(`SELECT id FROM data_scope_epochs WHERE id=$1 AND tenant_id=$2
      AND source='user_sources' AND selector='complete' AND scope_kind='tenant' AND epoch=$3
      AND $4::timestamptz>clock_timestamp()`, [root.scopeId, identity.tenantId, root.revision, root.expiresAt])).rows[0];
    if (!row) throw new SelectionError("selection_invalidated");
  }

  async ensureScope(identity: SelectionIdentity) {
    if ([identity.tenantId, identity.principalId, identity.authorizationHash].some(value => typeof value !== "string" || !value.trim())) {
      throw new AppError(403, "scope_mismatch", "An authenticated tenant and principal are required.");
    }
    return this.connections.run(async client => {
      await client.query("INSERT INTO data_principal_epochs(tenant_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [identity.tenantId, identity.principalId]);
      const epoch = (await client.query("SELECT epoch FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2 FOR UPDATE",
        [identity.tenantId, identity.principalId])).rows[0].epoch;
      if (epoch !== identity.sessionEpoch) throw new SelectionError("selection_invalidated");
      const inserted = (await client.query(`INSERT INTO data_scope_epochs(id,tenant_id,scope_kind,principal_id,token_mode,source,selector,session_epoch)
        VALUES($1,$2,'tenant',NULL,'tenant','user_sources','complete',0)
        ON CONFLICT(tenant_id,scope_kind,principal_id,token_mode,source,selector) DO NOTHING RETURNING id`,
      [randomUUID(), identity.tenantId])).rows[0];
      const scope = (inserted ?? (await client.query(`SELECT id FROM data_scope_epochs WHERE tenant_id=$1
        AND scope_kind='tenant' AND token_mode='tenant' AND source='user_sources' AND selector='complete'`,
      [identity.tenantId])).rows[0])?.id as string | undefined;
      if (!scope) throw new SelectionError("selection_invalidated");
      return scope;
    });
  }

  async capture(identity: SelectionIdentity, input: UserSourceFilter = {}) {
    const query = userSourceFilter(input);
    const stateId = await this.ensureScope(identity);
    return this.selections.captureWith(identity, endpoint, { values: query, allowed: queryFields }, async (client, evaluatedAt) => {
      const state = (await client.query("SELECT epoch FROM data_scope_epochs WHERE id=$1", [stateId])).rows[0];
      const scope = { tenantId: identity.tenantId };
      const metadata = await this.metadataInRead(client, scope, evaluatedAt);
      const cacheExpiry = (await client.query(`SELECT min(expires_at) AS expires_at FROM agent_people_cache
        WHERE tenant_id=$1 AND expires_at>$2`, [identity.tenantId, evaluatedAt])).rows[0].expires_at as Date | null;
      const expiry = new Date(Math.min(evaluatedAt.getTime() + 30 * 60_000, cacheExpiry?.getTime() ?? Infinity));
      const roots: DependencyRoot[] = [{ kind: "user_sources", scopeId: stateId, revision: state.epoch, expiresAt: expiry }];
      for (const source of Object.values(metadata)) {
        if (source.generationId) roots.push({ kind: "generation", scopeId: source.scopeId!, generationId: source.generationId,
          revision: source.revision!, expiresAt: new Date(evaluatedAt.getTime() + 30 * 60_000) });
      }
      const refresh = metadata.app_activity.reportRefreshDate;
      const transition = refresh === null ? null : new Date(Date.parse(`${refresh}T23:59:59.999Z`) + 4 * 86_400_000);
      return { roots, ...(transition && transition > evaluatedAt ? { nextTransition: transition } : {}),
        persist: async (connection, selection) => {
          await connection.query(`INSERT INTO user_source_read_contexts(selection_id,tenant_id,metadata)
            VALUES($1,$2,$3::jsonb)`, [selection.id, identity.tenantId, JSON.stringify(metadata)]);
        } };
    });
  }

  async metadataInRead(client: pg.PoolClient, scope: UserSourceScope, evaluatedAt: Date): Promise<UserSourceMetadataSet> {
    const rows = (await client.query(`SELECT requested.source,s.id AS scope_id,h.revision::text,
      g.id AS generation_id,g.observed_at,g.expires_at,g.row_count,success.report_refresh_date::text,success.retained_count,
      COALESCE(success.report_period,latest.report_period,'D28') AS report_period,
      latest.created_at AS attempted_at,latest.status AS attempt_status,latest.error_code,latest.message
      ,latest.observed_count AS attempt_observed_count
      FROM (VALUES('directory'),('app_activity')) requested(source)
      LEFT JOIN data_scope_epochs s ON s.tenant_id=$1 AND s.scope_kind='tenant' AND s.token_mode='tenant'
        AND s.source=requested.source AND s.selector='complete'
      LEFT JOIN data_generation_heads h ON h.scope_id=s.id
      LEFT JOIN data_generations g ON g.id=h.generation_id AND g.state='published'
        AND g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch
        AND EXISTS(SELECT 1 FROM user_source_attempts proof WHERE proof.generation_id=g.id AND proof.status='available')
      LEFT JOIN user_source_attempts success ON success.generation_id=g.id AND success.status='available'
      LEFT JOIN LATERAL (SELECT attempt.status,attempt.error_code,attempt.message,attempt.observed_count,attempt.report_period,attempt_generation.created_at FROM user_source_attempts attempt
        JOIN data_generations attempt_generation ON attempt_generation.id=attempt.generation_id
        WHERE attempt.scope_id=s.id AND attempt_generation.scope_id=s.id
          AND attempt_generation.scope_epoch=s.epoch AND attempt_generation.session_epoch=s.session_epoch
        ORDER BY attempt_generation.created_at DESC,attempt_generation.id DESC LIMIT 1) latest ON true`,
    [scope.tenantId])).rows;
    const metadata = Object.fromEntries(rows.map(row => {
      const available = row.generation_id !== null;
      const state = !available ? "unavailable"
        : row.expires_at <= evaluatedAt || evaluatedAt.getTime() - row.observed_at.getTime() >= automaticDataSyncIntervalMs
          || row.source === "app_activity" && row.report_refresh_date !== null && !isCopilotAppActivityFresh(row.report_refresh_date, evaluatedAt) ? "stale"
          : row.retained_count>0 || row.source === "app_activity" && row.report_refresh_date === null ? "partial"
          : row.attempt_status === "available" || row.attempt_status === "running" ? "available" : "partial";
      const value: UserSourceMetadata = {
        source: row.source, generationId: row.generation_id, scopeId: row.scope_id,
        revision: row.generation_id ? row.revision : null, expiresAt: row.expires_at?.toISOString() ?? null,
        observedAt: row.observed_at?.toISOString() ?? null, attemptedAt: row.attempted_at?.toISOString() ?? null,
        attemptStatus: row.attempt_status, errorCode: row.error_code, message: row.message, rowCount: available ? exactCount(row.row_count) : null,
        attemptObservedCount: row.attempt_observed_count,
        state, reportRefreshDate: row.report_refresh_date ?? null,
        period: row.source === "app_activity" ? row.report_period : null,
        reportVersion: row.source === "app_activity" ? row.report_period === "D28" ? "v2" : "v1" : null,
      };
      return [row.source, value];
    })) as UserSourceMetadataSet;
    if (metadata.app_activity.state === "available") {
      let cache = activityMatchCounts.get(this.database);
      if (!cache) { cache = new Map(); activityMatchCounts.set(this.database, cache); }
      const key = `${metadata.directory.generationId ?? ""}:${metadata.app_activity.generationId}`;
      let matches = cache.get(key);
      if (matches === undefined) {
        matches = exactCount((await client.query(`SELECT count(*)::text AS n FROM (${userSourceFactsSql()}) facts WHERE activity_identity IS NOT NULL`,
          userSourceSqlParameters({ metadata, evaluatedAt }))).rows[0].n);
        if (cache.size >= 32) cache.delete(cache.keys().next().value!);
        cache.set(key, matches);
      }
      if (matches < metadata.app_activity.rowCount!) metadata.app_activity.state = "partial";
    }
    return metadata;
  }

  refreshStatus(identity: SelectionIdentity) {
    return this.connections.selectedRead(async client => {
      const principal = (await client.query("SELECT epoch FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2 FOR SHARE",
        [identity.tenantId, identity.principalId])).rows[0];
      if (principal && principal.epoch !== identity.sessionEpoch) throw new SelectionError("selection_invalidated");
      const evaluatedAt = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
      const metadata = await this.metadataInRead(client, identity, evaluatedAt);
      const sources = Object.values(metadata);
      const complete = sources.every(source => source.generationId !== null && source.attemptStatus === "available");
      const status = complete ? "succeeded" : sources.some(source => source.generationId !== null) ? "partial"
        : sources.some(source => source.attemptStatus === "waiting_authorization") ? "waiting_authorization"
          : sources.some(source => source.attemptStatus === "permission_required") ? "permission_required" : "failed";
      return { status, count: complete ? metadata.directory.rowCount : metadata.directory.attemptObservedCount, sources: metadata } as const;
    });
  }

  async contextInRead(client: pg.PoolClient, identity: SelectionIdentity,
    selected: Awaited<ReturnType<DataSelections["assert"]>>): Promise<UserSourceReadContext> {
    const row = (await client.query("SELECT metadata FROM user_source_read_contexts WHERE selection_id=$1 AND tenant_id=$2",
      [selected.selection.id, identity.tenantId])).rows[0];
    if (!row || !selected.pins.some(pin => pin.root_kind === "user_sources")) throw new SelectionError("selection_invalidated");
    const metadata = row.metadata as UserSourceMetadataSet;
    for (const source of Object.values(metadata)) {
      if (source.generationId && !selected.pins.some(pin => pin.generation_id === source.generationId && pin.scope_id === source.scopeId)) {
        throw new SelectionError("selection_invalidated");
      }
    }
    const query = userSourceFilter(selected.selection.query_json);
    if (canonicalQuery(query, queryFields) !== selected.selection.query_hash) throw new SelectionError("invalid_cursor");
    return { metadata, evaluatedAt: selected.selection.evaluated_at,
      scope: { tenantId: identity.tenantId },
      selection: { id: selected.selection.id, revision: selected.selection.revision,
        expiresAt: selected.selection.expires_at.toISOString(), evaluatedAt: selected.selection.evaluated_at.toISOString(),
        validatedAt: selected.selection.validated_at.toISOString() },
      query, queryHash: selected.selection.query_hash };
  }

  read<T>(selectionId: string, identity: SelectionIdentity, work: (client: pg.PoolClient, context: UserSourceReadContext) => Promise<T>) {
    return this.selections.read(selectionId, identity, async (client, selected) => work(client, await this.contextInRead(client, identity, selected)));
  }

  page(selectionId: string, identity: SelectionIdentity, options: { limit?: number; cursor?: string } = {}) {
    return this.read(selectionId, identity, async (client, context) => {
      const limit = pageLimit(options.limit);
      const order = context.query.order!;
      const parameters = userSourceSqlParameters(context);
      const where = filters(context.query, parameters);
      const key = sortKeys[context.query.sort!];
      const base = `WITH facts AS NOT MATERIALIZED (${userSourceFactsSql()}),
        ordered AS (SELECT facts.*,${key} AS page_key FROM facts WHERE ${where})`;
      const cursor = await this.cursor(client, options.cursor, identity, context, endpoint, context.queryHash, base, parameters);
      const boundary = keyset(cursor?.boundary, cursor?.direction, order, parameters);
      parameters.push(limit + 1);
      const descending = order === "desc";
      const previous = cursor?.direction === "previous";
      const rowOrder = previous !== descending ? "DESC" : "ASC";
      const namePrefix = context.query.sort === "name" ? `left(coalesce(page_key,''),128) COLLATE "C" ${rowOrder},` : "";
      const rows = (await client.query(`${base} SELECT * FROM ordered WHERE ${boundary} ORDER BY (page_key IS NULL)::int ${previous ? "DESC" : "ASC"},
          ${namePrefix}coalesce(page_key,'') COLLATE "C" ${rowOrder},identity COLLATE "C" ${rowOrder} LIMIT $${parameters.length}`, parameters)).rows;
      const counts = await this.countsInRead(client, context);
      const result = this.envelope(rows, limit, previous, Boolean(cursor), identity, context, endpoint, context.queryHash,
        row => ({ key: row.page_key, id: row.identity, nullRank: row.page_key === null ? 1 : 0 }), facts, counts);
      return bounded({ ...result, sources: context.metadata, summary: await this.summaryInRead(client, context) });
    });
  }

  async countsInRead(client: pg.PoolClient, context: UserSourceReadContext) {
    const parameters = userSourceSqlParameters(context);
    const where = filters(context.query, parameters);
    const row = (await client.query(`WITH facts AS NOT MATERIALIZED (${userSourceFactsSql()})
      SELECT count(*)::text AS total,count(*) FILTER(WHERE ${where})::text AS filtered FROM facts`, parameters)).rows[0];
    return { total: exactCount(row.total), filtered: exactCount(row.filtered) };
  }

  async summaryInRead(client: pg.PoolClient, context: UserSourceReadContext): Promise<UserSourceSummary> {
    const parameters = userSourceSqlParameters(context);
    const where = filters(context.query, parameters);
    const row = (await client.query(`WITH facts AS NOT MATERIALIZED (${userSourceFactsSql()}) SELECT
      count(*) FILTER(WHERE entitlement='paid_active')::text AS paid,
      count(*) FILTER(WHERE entitlement='paid_inactive')::text AS inactive,
      count(*) FILTER(WHERE entitlement='no_paid')::text AS no_paid,
      count(*) FILTER(WHERE entitlement='unknown')::text AS unknown,
      count(*) FILTER(WHERE entitlement='paid_active' AND activity_state='active')::text AS active_app,
      count(*) FILTER(WHERE entitlement='paid_active' AND activity_state='unknown')::text AS unknown_app
      FROM facts WHERE ${where}`, parameters)).rows[0];
    const current = context.metadata.directory.generationId !== null;
    return { checkedUsers: context.metadata.directory.rowCount,
      licensedUsers: current ? exactCount(row.paid) : null, inactivePaidUsers: current ? exactCount(row.inactive) : null,
      noPaidUsers: current ? exactCount(row.no_paid) : null, unknownLicenseUsers: current ? exactCount(row.unknown) : null,
      activeAppUsers: current && isCopilotAppActivityFresh(context.metadata.app_activity.reportRefreshDate, context.evaluatedAt) ? exactCount(row.active_app) : null,
      unknownAppUsers: current ? exactCount(row.unknown_app) : null };
  }

  exact(selectionId: string, identity: SelectionIdentity, ids: readonly string[]) {
    const requested = userSourceObjectIds(ids);
    return this.read(selectionId, identity, async (client, context) => {
      const rows = (await client.query(`WITH selected_directory AS (
        SELECT generation_id,identity,upn,upn_key,display_name,sort_key,company,department,
          account_enabled,user_type,employee_type,service_state,plan_count FROM directory_user_rows
        WHERE generation_id=$1 AND identity=ANY($4::text[])
      ) SELECT * FROM (${userSourceFactsSql(true)}) facts
        ORDER BY identity COLLATE "C"`, [...userSourceSqlParameters(context), requested])).rows;
      return bounded(rows.map(facts));
    });
  }

  people(selectionId: string, identity: SelectionIdentity, ids: readonly string[]) {
    const requested = userSourceObjectIds(ids);
    return this.read(selectionId, identity, async (client, context) => bounded(await userSourcePeopleInRead(client, context.scope,
      context.metadata.directory.generationId ? { generationId: context.metadata.directory.generationId,
        observedAt: new Date(context.metadata.directory.observedAt!) } : null, requested, context.evaluatedAt)));
  }

  projectPeople(selectionId: string, identity: SelectionIdentity, records: readonly UnifiedAgentRecord[]) {
    assertPeopleData(identity);
    const selectedIdentity = structuredClone(identity);
    const snapshot = snapshotAgentPeopleRecords(records, selectedIdentity.tenantId);
    const ids = agentPeopleRecordIds(snapshot);
    return this.read(selectionId, selectedIdentity, async (client, context) => {
      const people = new Map<string, UserSourcePeople>();
      for (let offset = 0; offset < ids.length; offset += 100) {
        for (const person of await userSourcePeopleInRead(client, context.scope,
          context.metadata.directory.generationId ? { generationId: context.metadata.directory.generationId,
            observedAt: new Date(context.metadata.directory.observedAt!) } : null, ids.slice(offset, offset + 100), context.evaluatedAt)) {
          people.set(person.objectId, person);
        }
      }
      return bounded(projectAgentPeopleRecords(snapshot, people));
    });
  }

  plans(selectionId: string, identity: SelectionIdentity, objectId: string, options: { limit?: number; cursor?: string } = {}) {
    const id = userSourceObjectIds([objectId])[0];
    return this.read(selectionId, identity, async (client, context) => {
      const limit = pageLimit(options.limit);
      const childEndpoint = `${endpoint}/${id}/service-plans`;
      const hash = digest(`${context.queryHash}:${id}`);
      const parameters: unknown[] = [context.metadata.directory.generationId, id];
      const base = `WITH ordered AS (
        SELECT identity,plan_id,service,display_name,state,capability_status,
          residual->>'assignedDateTime' AS assigned_text,plan_id AS page_key
          FROM directory_service_plan_rows WHERE generation_id=$1 AND user_id=$2)`;
      const cursor = await this.cursor(client, options.cursor, identity, context, childEndpoint, hash, base, parameters);
      const boundary = keyset(cursor?.boundary, cursor?.direction, "asc", parameters);
      parameters.push(limit + 1);
      const previous = cursor?.direction === "previous";
      const rows = (await client.query(`${base} SELECT * FROM ordered WHERE ${boundary} ORDER BY page_key COLLATE "C" ${previous ? "DESC" : "ASC"},identity COLLATE "C" ${previous ? "DESC" : "ASC"}
        LIMIT $${parameters.length}`, parameters)).rows;
      const n = exactCount((await client.query("SELECT count(*)::text AS n FROM directory_service_plan_rows WHERE generation_id=$1 AND user_id=$2",
        [context.metadata.directory.generationId, id])).rows[0].n);
      return this.envelope(rows, limit, previous, Boolean(cursor), identity, context, childEndpoint, hash,
        row => ({ key: row.page_key, id: row.identity, nullRank: 0 }), row => ({
          servicePlanId: row.plan_id, service: row.service, displayName: row.display_name, state: row.state,
          capabilityStatus: row.capability_status, assignedDateTime: row.assigned_text,
        } as UserSourcePlan), { total: n, filtered: n });
    });
  }

  facets(selectionId: string, identity: SelectionIdentity, options: {
    field: "company" | "department"; search?: string; limit?: number; cursor?: string;
  }) {
    if (!["company", "department"].includes(options.field)) throw new SelectionError("invalid_cursor");
    const search = options.search === undefined ? "" : userSourceSearch(options.search);
    return this.read(selectionId, identity, async (client, context) => {
      const limit = pageLimit(options.limit);
      const field = options.field;
      const facetEndpoint = `${endpoint}/facets/${field}`;
      const hash = digest(`${context.queryHash}:${field}:${search}`);
      const parameters = userSourceSqlParameters(context);
      const query = { ...context.query };
      delete query[field];
      const where = filters(query, parameters);
      parameters.push(search);
      const facetFilter = `strpos(${userSourceSearchSql(`coalesce(${field},'')`)},$${parameters.length})>0`;
      const base = `WITH facts AS NOT MATERIALIZED (${userSourceFactsSql()}), options AS (
        SELECT ${field} AS value,count(*)::text AS count FROM facts WHERE ${where} AND ${facetFilter} GROUP BY ${field}),
        ordered AS (SELECT *,lower(normalize(value,NFKC) COLLATE "default") AS page_key,coalesce(value,chr(1)||'null') AS identity FROM options)`;
      const cursor = await this.cursor(client, options.cursor, identity, context, facetEndpoint, hash, base, parameters);
      const counts = (await client.query(`${base} SELECT (SELECT count(*) FROM (SELECT ${field} FROM (${userSourceFactsSql()}) all_facts GROUP BY ${field}) all_options)::text AS total,
        count(*)::text AS filtered FROM ordered`, parameters)).rows[0];
      const boundary = keyset(cursor?.boundary, cursor?.direction, "asc", parameters);
      parameters.push(limit + 1);
      const previous = cursor?.direction === "previous";
      const rows = (await client.query(`${base} SELECT * FROM ordered WHERE ${boundary}
        ORDER BY (page_key IS NULL)::int ${previous ? "DESC" : "ASC"},coalesce(page_key,'') COLLATE "C" ${previous ? "DESC" : "ASC"},
        identity COLLATE "C" ${previous ? "DESC" : "ASC"} LIMIT $${parameters.length}`, parameters)).rows;
      return this.envelope(rows, limit, previous, Boolean(cursor), identity, context, facetEndpoint, hash,
        row => ({ key: row.page_key, id: row.value === null ? "\u0001null" : row.identity, nullRank: row.page_key === null ? 1 : 0 }),
        row => ({ value: row.value as string | null, count: exactCount(row.count) }),
        { total: exactCount(counts.total), filtered: exactCount(counts.filtered) });
    });
  }

  async savePeople(identity: SelectionIdentity, observations: readonly AgentPersonObservation[], fence: (client: pg.PoolClient) => Promise<void>,
    options: { signal?: AbortSignal; beforeCommit?: () => void } = {}) {
    if (!observations.length) return;
    const ids = userSourceObjectIds(observations.map(row => row.objectId));
    if (ids.length !== observations.length) throw new AppError(400, "invalid_agent_people", "Duplicate people observations.");
    for (const row of observations) {
      if (!["resolved", "not_found", "lookup_failed"].includes(row.status) || !Number.isFinite(Date.parse(row.checkedAt))
        || !personText(row.displayName, 512) || !personText(row.userPrincipalName, 320)
        || row.status !== "resolved" && (row.displayName !== null || row.userPrincipalName !== null)
        || (row.status === "lookup_failed" ? !row.errorCode || !/^[a-z][a-z0-9_]{0,127}$/.test(row.errorCode) : row.errorCode !== undefined)) {
        throw new AppError(400, "invalid_agent_people", "Invalid person observation.");
      }
    }
    const batch = encodeBatch(observations.map(row => ({ ...row, objectId: row.objectId.toLowerCase(), revision: randomUUID() })),
      [identity.tenantId, identity.principalId]);
    await this.connections.run(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`data-sync:${identity.tenantId}`]);
      const principal = (await client.query("SELECT epoch FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2 FOR UPDATE",
        [identity.tenantId, identity.principalId])).rows[0];
      if (!principal || principal.epoch !== identity.sessionEpoch) throw new SelectionError("selection_invalidated");
      await client.query(`SELECT id FROM data_scope_epochs WHERE tenant_id=$1 AND scope_kind='tenant'
        AND source='user_sources' ORDER BY id FOR UPDATE`, [identity.tenantId]);
      await fence(client);
      const count = exactCount((await client.query(`SELECT count(*)::text AS n FROM agent_people_cache
        WHERE tenant_id=$1 AND NOT(object_id=ANY($2::uuid[]))`, [identity.tenantId, ids])).rows[0].n);
      if (count + ids.length > 100_000) throw new AppError(413, "agent_people_limit", "Saved people exceed 100000 identities.");
      await client.query(`INSERT INTO agent_people_cache(tenant_id,principal_id,object_id,revision,status,
        display_name,user_principal_name,checked_at,resolved_at,expires_at,error_code)
        SELECT $1,$2,"objectId",revision,status,"displayName","userPrincipalName","checkedAt",
          CASE WHEN status='resolved' THEN "checkedAt" ELSE NULL END,
          "checkedAt"+CASE status WHEN 'resolved' THEN interval '7 days' WHEN 'not_found' THEN interval '1 day' ELSE interval '15 minutes' END,"errorCode"
        FROM jsonb_to_recordset($3::jsonb) r("objectId" uuid,revision uuid,status text,"displayName" text,"userPrincipalName" text,"checkedAt" timestamptz,"errorCode" text)
        ON CONFLICT(tenant_id,object_id) DO UPDATE SET principal_id=EXCLUDED.principal_id,revision=EXCLUDED.revision,status=EXCLUDED.status,checked_at=EXCLUDED.checked_at,
          expires_at=CASE WHEN EXCLUDED.status='lookup_failed' THEN GREATEST(agent_people_cache.expires_at,EXCLUDED.expires_at)
            ELSE EXCLUDED.expires_at END,error_code=EXCLUDED.error_code,
          display_name=CASE WHEN EXCLUDED.status='lookup_failed' THEN agent_people_cache.display_name ELSE EXCLUDED.display_name END,
          user_principal_name=CASE WHEN EXCLUDED.status='lookup_failed' THEN agent_people_cache.user_principal_name ELSE EXCLUDED.user_principal_name END,
          resolved_at=CASE WHEN EXCLUDED.status='lookup_failed' THEN CASE WHEN agent_people_cache.status='not_found' THEN agent_people_cache.checked_at
            ELSE agent_people_cache.resolved_at END ELSE EXCLUDED.resolved_at END
        WHERE agent_people_cache.checked_at<=EXCLUDED.checked_at`, [identity.tenantId, identity.principalId, batch.json]);
      await fence(client);
    }, false, options.signal, undefined, options.beforeCommit);
  }

  private async cursor(client: pg.PoolClient, cursor: string | undefined, identity: SelectionIdentity, context: UserSourceReadContext,
    route: string, hash: string, base: string, parameters: readonly unknown[]) {
    if (cursor === undefined) return undefined;
    const decoded = this.codec.decode(cursor, {
      identity, endpoint: route, selectionId: context.selection.id, revision: context.selection.revision, queryHash: hash,
    });
    if (decoded.boundary.key !== "\0") return decoded;
    const found = (await client.query(`${base} SELECT page_key,identity FROM ordered
      WHERE encode(sha256(convert_to(identity,'UTF8')),'hex')=$${parameters.length + 1} LIMIT 2`,
    [...parameters, decoded.boundary.id])).rows;
    if (found.length !== 1) throw new SelectionError("selection_invalidated");
    const boundary: CursorBoundary = { key: found[0].page_key, id: found[0].identity,
      nullRank: found[0].page_key === null ? 1 : 0 };
    return { ...decoded, boundary };
  }

  private envelope<T>(rows: pg.QueryResultRow[], limit: number, previous: boolean, hasCursor: boolean,
    identity: SelectionIdentity, context: UserSourceReadContext, route: string, hash: string,
    boundary: (row: pg.QueryResultRow) => CursorBoundary, project: (row: pg.QueryResultRow) => T,
    counts: { total: number; filtered: number }): UserSourcePage<T> {
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    if (previous) page.reverse();
    const token = (row: pg.QueryResultRow, direction: "next" | "previous") => {
      const input = { identity, endpoint: route, selectionId: context.selection.id, revision: context.selection.revision,
        queryHash: hash, direction };
      const edge = boundary(row);
      try { return this.codec.encode({ ...input, boundary: edge }); }
      catch (error) { if (!(error instanceof SelectionError) || error.code !== "invalid_cursor") throw error; }
      // NUL cannot be a PostgreSQL text key; resolve its compact anchor in the pinned relation.
      return this.codec.encode({ ...input, boundary: { key: "\0", id: digest(edge.id), nullRank: 0 } });
    };
    return bounded({ value: page.map(project), counts, selection: context.selection,
      page: { limit, nextCursor: page.length && (previous ? hasCursor : more) ? token(page.at(-1)!, "next") : null,
        previousCursor: page.length && (previous ? more : hasCursor) ? token(page[0], "previous") : null } });
  }
}

const sortKeys = {
  name: "sort_key", upn: "upn_key", company: 'lower(normalize(company,NFKC) COLLATE "default")',
  department: 'lower(normalize(department,NFKC) COLLATE "default")', service: "service_state", activity: "last_activity_date::text",
} as const;

export function userSourceSearch(value: string) {
  if (typeof value !== "string" || value.length > 256 || /[\p{Cc}\p{Cs}]/u.test(value)) throw new SelectionError("invalid_cursor");
  const search = value.normalize("NFKC").toLowerCase().normalize("NFKC").trim();
  if (search.length > 256) throw new SelectionError("invalid_cursor");
  return search;
}
export function userSourceSearchSql(expression: string) {
  return `normalize(lower(normalize(${expression},NFKC) COLLATE "default"),NFKC)`;
}

function filters(query: UserSourceFilter, parameters: unknown[]) {
  const clauses: string[] = ["true"];
  for (const field of ["company", "department"] as const) {
    if (query[field] !== undefined) { parameters.push(query[field]); clauses.push(`${field} IS NOT DISTINCT FROM $${parameters.length}::text`); }
  }
  for (const [key, column] of [["entitlement", "entitlement"], ["serviceState", "service_state"], ["activity", "activity_state"]] as const) {
    if (query[key] !== undefined) { parameters.push(query[key]); clauses.push(`${column}=$${parameters.length}`); }
  }
  if (query.search) {
    parameters.push(query.search);
    clauses.push(`(strpos(${userSourceSearchSql("coalesce(display_name,'')")},$${parameters.length})>0 OR strpos(${userSourceSearchSql("upn")},$${parameters.length})>0)`);
  }
  return clauses.join(" AND ");
}
function keyset(boundary: CursorBoundary | undefined, direction: "next" | "previous" | undefined, order: "asc" | "desc", parameters: unknown[]) {
  if (!boundary) return "true";
  const previous = direction === "previous";
  parameters.push(boundary.nullRank, boundary.key ?? "", boundary.id);
  const n = parameters.length;
  return `((page_key IS NULL)::int ${previous ? "<" : ">"} $${n - 2}::int OR
    (page_key IS NULL)::int=$${n - 2}::int AND (coalesce(page_key,'') COLLATE "C",identity COLLATE "C")
      ${previous !== (order === "desc") ? "<" : ">"} ($${n - 1}::text COLLATE "C",$${n}::text COLLATE "C"))`;
}
function pageLimit(value = 50) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new SelectionError("invalid_cursor");
  return value;
}
function bounded<T>(value: T) {
  if (Buffer.byteLength(JSON.stringify(value)) > 1_048_576) throw new AppError(413, "data_response_bytes", "Response exceeds 1 MiB.");
  return value;
}
function personText(value: string | null, maximum: number) {
  return value === null || typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\r\n\0]/.test(value);
}
function dateString(value: Date | string | null) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}
export function facts(row: pg.QueryResultRow): UserSourceFacts {
  return {
    directory: { objectId: row.identity, userPrincipalName: row.upn, displayName: row.display_name,
      accountEnabled: row.account_enabled, userType: row.user_type, employeeType: row.employee_type,
      companyName: row.company, department: row.department },
    copilotServiceState: row.service_state, servicePlanCount: row.plan_count, entitlement: row.entitlement,
    activityState: row.activity_state, appActivity: row.activity_identity === null ? null : {
      reportRefreshDate: dateString(row.report_refresh_date)!, lastActivityDate: dateString(row.last_activity_date),
      copilotChatLastActivityDate: dateString(row.chat_date), microsoftTeamsCopilotLastActivityDate: dateString(row.teams_date),
      wordCopilotLastActivityDate: dateString(row.word_date), excelCopilotLastActivityDate: dateString(row.excel_date),
      powerpointCopilotLastActivityDate: dateString(row.powerpoint_date), outlookCopilotLastActivityDate: dateString(row.outlook_date),
      onenoteCopilotLastActivityDate: dateString(row.onenote_date), loopCopilotLastActivityDate: dateString(row.loop_date),
    },
  };
}

export function userSourceObjectIds(ids: readonly string[]) {
  if (isProxy(ids) || !Array.isArray(ids) || Object.getPrototypeOf(ids) !== Array.prototype || ids.length > 100
    || Reflect.ownKeys(ids).length !== ids.length + 1) {
    throw new AppError(400, "data_exact_ids_limit", "Supply at most 100 exact directory object IDs.");
  }
  const requested: string[] = [];
  for (let index = 0; index < ids.length; index++) {
    const property = Object.getOwnPropertyDescriptor(ids, String(index));
    if (!property || !Object.hasOwn(property, "value") || typeof property.value !== "string" || !isGraphGuid(property.value)) {
      throw new AppError(400, "data_exact_ids_limit", "Supply at most 100 exact directory object IDs.");
    }
    requested.push(property.value.toLowerCase());
  }
  return [...new Set(requested)];
}

function assertPeopleData(input: unknown) {
  let bytes = 0;
  const ancestors = new Set<object>();
  const invalid = () => new AppError(500, "saved_source_invalid", "Agent people projection requires bounded own-data inventory.");
  const visit = (value: unknown, depth: number): void => {
    bytes += 1;
    if (typeof value === "string") bytes += Buffer.byteLength(value);
    if (bytes > dataLimits.batchBytes) throw new AppError(413, "data_response_bytes", "Response exceeds 1 MiB.");
    if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean"
      || typeof value === "number" && Number.isFinite(value)) return;
    if (isProxy(value) || typeof value !== "object" || depth > 64 || ancestors.has(value)) throw invalid();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) throw invalid();
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) throw invalid();
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") throw invalid();
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !Object.hasOwn(property, "value") || !property.enumerable
        || array && !/^(0|[1-9]\d*)$/.test(key)) throw invalid();
      bytes += Buffer.byteLength(key);
      visit(property.value, depth + 1);
    }
    ancestors.delete(value);
  };
  visit(input, 0);
}

export function snapshotAgentPeopleRecords(records: readonly UnifiedAgentRecord[], tenantId: string): UnifiedAgentRecord[] {
  if (isProxy(records) || !Array.isArray(records)) {
    throw new AppError(500, "saved_source_invalid", "Agent people projection requires an own-data inventory page.");
  }
  if (records.length > 100) throw new AppError(400, "data_page_limit", "Project at most 100 caller records.");
  assertPeopleData(records);
  const snapshot = structuredClone(records).map(record => record);
  for (const record of snapshot) {
    if (!record || typeof record !== "object" || Array.isArray(record) || !Object.hasOwn(record, "powerPlatformResource")
      || record.powerPlatformResource !== null && (!record.powerPlatformResource
        || typeof record.powerPlatformResource !== "object" || !Object.hasOwn(record.powerPlatformResource, "tenantId")
        || !Object.hasOwn(record.powerPlatformResource, "details") || !record.powerPlatformResource.details
        || typeof record.powerPlatformResource.details !== "object" || Array.isArray(record.powerPlatformResource.details))) {
      throw new AppError(500, "saved_source_invalid", "Agent people projection requires valid native inventory.");
    }
    const resource = record.powerPlatformResource;
    if (resource && resource.tenantId !== tenantId) throw new AppError(403, "scope_mismatch", "Inventory belongs to another tenant.");
    if (resource && (resource.sourceSystem !== "power_platform" || !["power_platform", "both"].includes(record.presence))
      || record.columns !== undefined && (!record.columns || typeof record.columns !== "object" || Array.isArray(record.columns))) {
      throw new AppError(500, "saved_source_invalid", "Saved agent people require valid native source and column records.");
    }
    if (recordPeopleReferences(record)
      .some(id => id !== null && id !== undefined && typeof id !== "string")) {
      throw new AppError(500, "saved_source_invalid", "Saved agent person references must be text.");
    }
  }
  return bounded(snapshot);
}

export function agentPeopleRecordIds(records: readonly UnifiedAgentRecord[]) {
  return [...new Set(records.flatMap(recordPeopleReferences)
    .filter((id): id is string => typeof id === "string" && isGraphGuid(id)).map(id => id.toLowerCase()))];
}

function recordPeopleReferences(record: UnifiedAgentRecord): unknown[] {
  const resource = record.powerPlatformResource;
  return [resource ? Object.getOwnPropertyDescriptor(resource, "createdBy")?.value : undefined,
    resource ? Object.getOwnPropertyDescriptor(resource.details, "ownerId")?.value : undefined,
    resource ? Object.getOwnPropertyDescriptor(resource.details, "lastModifiedBy")?.value : undefined];
}

export function projectAgentPeopleRecords(records: readonly UnifiedAgentRecord[], people: ReadonlyMap<string, UserSourcePeople>): UnifiedAgentRecord[] {
  const person = (id: unknown) => typeof id === "string" && isGraphGuid(id) ? people.get(id.toLowerCase()) : undefined;
  return bounded(records.map(record => {
    const { people: _prior, ...inventory } = record;
    const [creatorId, ownerId, modifierId] = recordPeopleReferences(record);
    const owner = person(ownerId), createdBy = person(creatorId), lastModifiedBy = person(modifierId);
    if (inventory.columns) {
      inventory.columns = { ...inventory.columns };
      if (Object.hasOwn(inventory.columns, "owner")) {
        inventory.columns.owner = agentPersonLabel(owner, typeof ownerId === "string" ? ownerId : null);
      }
      if (Object.hasOwn(inventory.columns, "createdBy")) {
        inventory.columns.createdBy = agentPersonLabel(createdBy, typeof creatorId === "string" ? creatorId : null);
      }
    }
    return { ...inventory, ...(owner || createdBy || lastModifiedBy ? { people: {
      ...(owner ? { owner } : {}), ...(createdBy ? { createdBy } : {}), ...(lastModifiedBy ? { lastModifiedBy } : {}),
    } } : {}) };
  }));
}

// The caller supplies a validated selected-read client, never a pool.
export async function userSourcePeopleInRead(
  client: pg.PoolClient, scope: UserSourceScope,
  directory: { generationId: string; observedAt: Date } | null,
  ids: readonly string[], evaluatedAt: Date, includePeopleCache = true,
): Promise<UserSourcePeople[]> {
  const requested = userSourceObjectIds(ids);
  if (!requested.length) return [];
  const rows = (await client.query(`SELECT requested.id,d.identity AS directory_id,d.display_name,d.upn,
      (d.residual->>'retainedObservedAt')::timestamptz AS directory_observed_at,
      c.status,c.display_name AS cached_name,c.user_principal_name AS cached_upn,
      c.checked_at,c.resolved_at,c.expires_at,c.error_code
    FROM unnest($3::text[]) requested(id)
    LEFT JOIN directory_user_rows d ON d.generation_id=$2 AND d.tenant_id=$1 AND d.identity=requested.id
      AND EXISTS(SELECT 1 FROM data_scope_epochs s WHERE s.id=d.scope_id AND s.scope_kind='tenant' AND s.token_mode='tenant')
    LEFT JOIN agent_people_cache c ON c.tenant_id=$1
      AND c.object_id=requested.id::uuid AND c.expires_at>$4 AND $5::boolean
    WHERE d.identity IS NOT NULL OR c.object_id IS NOT NULL ORDER BY requested.id COLLATE "C"`,
  [scope.tenantId, directory?.generationId ?? null, requested, evaluatedAt, includePeopleCache])).rows;
  return rows.map(row => {
    const observedAt: Date | null = row.directory_id !== null && directory !== null
      ? row.directory_observed_at ?? directory.observedAt : null;
    const saved = row.directory_id !== null && directory !== null ? {
      objectId: row.id, displayName: row.display_name, userPrincipalName: row.upn,
      observedAt: observedAt!.toISOString(),
    } : null;
    if (!row.status || saved && observedAt! > row.checked_at) return saved!;
    const conclusive = row.status === "not_found" ? row.checked_at : row.resolved_at;
    const identity = saved && row.status === "lookup_failed" && (!conclusive || observedAt! > conclusive)
      ? saved : { objectId: row.id, displayName: row.cached_name, userPrincipalName: row.cached_upn,
        observedAt: (row.resolved_at ?? row.checked_at).toISOString() };
    return { ...identity, status: row.status, checkedAt: row.checked_at.toISOString(),
      expiresAt: row.expires_at.toISOString(), ...(row.error_code ? { errorCode: row.error_code } : {}) };
  });
}
