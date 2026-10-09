import type pg from "pg";
import { AppError } from "../errors.js";
import { dataLimits, digest, encodeBatch } from "../db/dataBounds.js";
import { officialReportCount as exactCount } from "../db/officialReportBounds.js";
import { UserSourcesRepository, facts, userSourceSqlParameters, type UserSourceMetadataSet } from "../db/userSources.js";
import { OfficialReportHistory, readableHistorySql } from "../db/officialReportHistory.js";
import { reportRelationsSql, reportPeriodSortKey, selectedDirectoryReportRelationsSql, selectedOfficialReportRelationsSql } from "../db/officialReportQueries.js";
import { reportUuid } from "../db/officialReportImports.js";
import { CursorCodec, DataSelections, SelectionError, assertSelectionIdentity, canonicalQuery, type CursorBoundary, type DependencyRoot, type SelectionIdentity } from "./dataSelections.js";
import type { ReportEndpoint, ReportMetadata, ReportPage, ReportQuery, ReportRow, ReportSummary } from "../types/officialReportData.js";
import type { UserSourceScope } from "../types/userSources.js";
import type { GenerationLease } from "../db/dataGenerations.js";
import type { UserSourceStages } from "../db/userSourceStages.js";
import { officialReportAnalytics, officialReportAnalyticsQuery, projectReportAnalytics, type ReportSql } from "./officialReportAnalytics.js";
import { peakCheckpoint } from "./peakMemory.js";
import { readableReportVersionSql } from "../db/reportCapacitySchema.js";
import { readAutomaticInventoryRevisions } from "../db/inventoryAutomaticRevisions.js";
import type { PublicationRevisions, PublishedSelectedRead } from "../types/dataSelection.js";
import { isPublicationRevisions } from "../types/dataSelection.js";
import { adoptionDataset } from "./adoptionGroups.js";

export const reportQueryFields = ["setId", "scope", "search", "company", "department", "entitlement", "serviceState", "appActivity",
  "reportActivity", "cohort", "licenseCohort", "creatorType", "agentId", "username", "responsesOnly", "startDate", "endDate",
  "lowResponseThreshold", "inactiveDays", "activityWindowDays", "adoptionChamps", "adoptionAgents", "sort", "order"] as const;
const sorts = {
  adoption: ["name"],
  copilot_users: ["name", "upn", "company", "department", "service", "appActivity", "responses", "agentsUsed", "lastActivity"],
  official_users: ["name", "responses", "agentsUsed", "lastActivity"],
  official_agents: ["name", "responses", "activeUsers", "licensedUsers", "unlicensedUsers", "lastActivity"],
  relationships: ["name", "responses", "lastActivity", "creatorType"],
  history: ["reportingPeriod", "acceptedAt"], overview: ["name", "lastActivity"], unresolved: ["name", "responses"], plans: ["name"], observations: ["name"],
} as const;
export function reportQuery(endpoint: ReportEndpoint, input: ReportQuery = {}): ReportQuery {
  if (!(endpoint in sorts) || Object.keys(input).some(key => !reportQueryFields.includes(key as typeof reportQueryFields[number]))) throw new SelectionError("invalid_cursor");
  if (endpoint === "adoption" && Object.keys(input).some(key => !["setId", "search", "company", "department", "adoptionChamps", "adoptionAgents", "sort", "order",
    "lowResponseThreshold", "inactiveDays", "activityWindowDays"].includes(key))) throw new SelectionError("invalid_cursor");
  for (const key of ["adoptionChamps", "adoptionAgents"] as const) {
    if (input[key] !== undefined && (endpoint !== "adoption" || !["with", "without"].includes(input[key]))) throw new SelectionError("invalid_cursor");
  }
  const query = { ...input };
  for (const key of ["company", "department", "creatorType", "agentId", "username"] as const) {
    const value = query[key];
    if (value !== undefined && !(value === null && ["company", "department"].includes(key))
      && (typeof value !== "string" || value.length > (key === "agentId" || key === "username" ? 512 : 256)
        || (key === "agentId" || key === "username") && !value.trim()
        || /[\0\r\n]/.test(value))) throw new SelectionError("invalid_cursor");
  }
  if (query.setId !== undefined) reportUuid(query.setId);
  for (const [key, values] of [
    ["scope", ["history", "selected"]], ["entitlement", ["paid_active", "paid_inactive", "no_paid", "unknown"]],
    ["serviceState", ["enabled", "warning", "partially_enabled", "disabled", "suspended", "locked_out", "unknown"]],
    ["appActivity", ["active", "inactive", "unknown"]], ["reportActivity", ["all", "recent", "inactive", "no-activity"]],
    ["cohort", ["all", "zero", "low", "review", "licensed", "using_agents", "no_agent_activity", "needs_attention", "unknown_metrics"]],
    ["licenseCohort", ["active_without_paid"]], ["order", ["asc", "desc"]],
  ] as const) if (query[key] !== undefined && !(values as readonly unknown[]).includes(query[key])) throw new SelectionError("invalid_cursor");
  if (query.responsesOnly !== undefined && typeof query.responsesOnly !== "boolean") throw new SelectionError("invalid_cursor");
  for (const key of ["startDate", "endDate"] as const) {
    const value = query[key];
    if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString().slice(0, 10) !== value)) throw new SelectionError("invalid_cursor");
  }
  if (query.startDate && query.endDate && query.startDate > query.endDate) throw new SelectionError("invalid_cursor");
  for (const [key, maximum, fallback] of [["lowResponseThreshold", 100000000, 5], ["inactiveDays", 365, 30], ["activityWindowDays", 365, 30]] as const) {
    if (query[key] !== undefined && (!Number.isSafeInteger(query[key]) || query[key]! < 1 || query[key]! > maximum)) throw new SelectionError("invalid_cursor");
    query[key] ??= fallback;
  }
  query.sort ??= endpoint === "history" ? "reportingPeriod" : endpoint === "official_agents" ? "responses" : "name";
  if (!(sorts[endpoint] as readonly string[]).includes(query.sort)) throw new SelectionError("invalid_cursor");
  query.order ??= endpoint === "history" || endpoint === "official_agents" ? "desc" : "asc";
  if (query.search !== undefined) query.search = reportSearch(query.search);
  // A accepted filter must be meaningful on the chosen endpoint, never ignored.
  const organization = ["company", "department", "entitlement", "serviceState", "appActivity", "cohort", "licenseCohort"];
  if (!["copilot_users", "official_users", "adoption"].includes(endpoint) && organization.some(key => key in input)
    || endpoint === "official_users" && ("appActivity" in input || ["licensed", "using_agents", "no_agent_activity", "needs_attention", "unknown_metrics"].includes(input.cohort ?? ""))
    || endpoint !== "overview" && "scope" in input
    || ["history", "overview", "unresolved", "plans", "observations"].includes(endpoint) && ["creatorType", "agentId", "username", "responsesOnly", "reportActivity"].some(key => key in input)) throw new SelectionError("invalid_cursor");
  if (["history", "unresolved", "plans", "observations"].includes(endpoint) && ["startDate", "endDate"].some(key => key in input)
    || endpoint === "official_agents" && input.username !== undefined) throw new SelectionError("invalid_cursor");
  canonicalQuery(query, reportQueryFields);
  return query;
}

export type ReportReadContext = {
  identity: SelectionIdentity; tokenMode: UserSourceScope["tokenMode"]; endpoint: ReportEndpoint; query: ReportQuery; queryHash: string;
  metadata: UserSourceMetadataSet; report: ReportMetadata; evaluatedAt: Date; selection: PublishedSelectedRead;
};
export type ReportCurrentData = Pick<ReportReadContext, "metadata" | "report" | "evaluatedAt" | "query"> & {
  identity: Pick<SelectionIdentity, "tenantId" | "principalId">;
  publicationRevisions: PublicationRevisions;
};

type SelectedAggregate = {
  counts?: { total: number; filtered: number; unresolved: boolean; primaryComplete?: boolean };
  summaryRow?: pg.QueryResultRow; analyticsRow?: pg.QueryResultRow;
};
const selectedAggregates = new WeakMap<pg.Pool, Map<string, { expires: number; value: SelectedAggregate }>>();

export class LargeTenantUsersReports {
  readonly sources; readonly history; readonly selections; readonly codec;
  constructor(readonly database: pg.Pool, secret: string, readonly staleAfterDays: number) {
    if (!Number.isInteger(staleAfterDays) || staleAfterDays < 1 || staleAfterDays > 365) throw new Error("official_freshness_configuration");
    this.sources = new UserSourcesRepository(database, secret);
    this.history = new OfficialReportHistory(database);
    this.selections = new DataSelections(database, (client, root, identity) => root.kind === "tenant_history"
      ? this.history.validateRoot(client, root, identity) : this.sources.validateRoot(client, root, identity));
    this.codec = new CursorCodec(secret);
  }
  private aggregate(context: ReportReadContext, scope: string, value?: SelectedAggregate) {
    let cache = selectedAggregates.get(this.database);
    if (!cache) { cache = new Map(); selectedAggregates.set(this.database, cache); }
    const now = Date.now(), key = digest(`${context.selection.id}\0${context.endpoint}\0${context.queryHash}\0${canonicalQuery(context.query, reportQueryFields)}\0${scope}`);
    for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
    const expires = Date.parse(context.selection.expiresAt);
    if (!Number.isFinite(expires) || expires <= now) return undefined;
    const found = value ?? cache.get(key)?.value;
    if (!found) return undefined;
    if (Buffer.byteLength(JSON.stringify(found)) > 16384) return undefined;
    cache.delete(key);
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires, value: structuredClone(found) });
    return structuredClone(found);
  }

  private rowCursor(input: Omit<Parameters<CursorCodec["encode"]>[0], "boundary">, row: pg.QueryResultRow) {
    if (row.identity.length > 0 && row.identity.length <= 512) {
      try {
        return this.codec.encode({ ...input,
          boundary: { key: row.page_key, id: row.identity, nullRank: row.page_key === null ? 1 : 0 } });
      } catch (error) {
        if (!(error instanceof SelectionError) || error.code !== "invalid_cursor") throw error;
      }
    }
    // PostgreSQL text cannot contain NUL. Resolve compact boundaries only
    // inside the same immutable selected relation.
    return this.codec.encode({ ...input, boundary: { key: "\0", id: digest(row.identity), nullRank: 0 } });
  }

  private async cursorBoundary(client: pg.PoolClient, base: string, values: readonly unknown[], edge?: CursorBoundary): Promise<CursorBoundary | undefined> {
    if (edge?.key !== "\0") return edge;
    const found = (await client.query(`${base} SELECT page_key,identity FROM ordered
      WHERE encode(sha256(convert_to(identity,'UTF8')),'hex')=$${values.length + 1} LIMIT 2`, [...values, edge.id])).rows;
    if (found.length !== 1) throw new SelectionError("selection_invalidated");
    return { key: found[0].page_key, id: found[0].identity, nullRank: found[0].page_key === null ? 1 : 0 };
  }

  private async prepareHistoryCapture(tenantId: string) {
    await this.history.ensure(tenantId);
    while (await this.history.expire(tenantId) > 0) { /* bounded maintenance transactions */ }
  }

  async capture(identity: SelectionIdentity, tokenMode: UserSourceScope["tokenMode"], endpoint: ReportEndpoint, input: ReportQuery = {}) {
    assertSelectionIdentity(identity);
    const query = reportQuery(endpoint, input);
    await this.prepareHistoryCapture(identity.tenantId);
    return this.selections.captureWith(identity, endpoint, { values: query, allowed: reportQueryFields }, async (client, evaluatedAt) => {
      const metadata = await this.sources.metadataInRead(client, { ...identity, tokenMode }, evaluatedAt);
      const history = await this.history.root(client, identity.tenantId, evaluatedAt);
      const report = await this.metadata(client, identity.tenantId, query.setId, evaluatedAt);
      const publicationRevisions = await readAutomaticInventoryRevisions(identity, client);
      const roots: DependencyRoot[] = [history];
      for (const source of Object.values(metadata)) if (source.generationId) roots.push({
        kind: "generation", generationId: source.generationId, scopeId: source.scopeId!, revision: source.revision!,
        expiresAt: new Date(evaluatedAt.getTime() + 30 * 60_000),
      });
      const transitions = [
        metadata.app_activity.reportRefreshDate ? Date.parse(`${metadata.app_activity.reportRefreshDate}T23:59:59.999Z`) + 4 * 86400000 : Infinity,
        report.reportingPeriod?.endDate ? Date.parse(`${report.reportingPeriod.endDate}T23:59:59.999Z`) + (this.staleAfterDays + 1) * 86400000 : Infinity,
        report.acceptedAt ? Date.parse(report.acceptedAt) + (this.staleAfterDays + 1) * 86400000 : Infinity,
      ].filter(value => value > evaluatedAt.getTime());
      const next = Math.min(...transitions);
      return { roots, ...(Number.isFinite(next) ? { nextTransition: new Date(next) } : {}),
        persist: async (connection, selection) => {
          await connection.query(`INSERT INTO official_usage_read_contexts(selection_id,tenant_id,token_mode,metadata,report_metadata,set_id,history_revision,history_epoch)
            VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)`,
          [selection.id, identity.tenantId, tokenMode, JSON.stringify({ ...metadata, publicationRevisions }), JSON.stringify(report), report.setId, report.historyRevision, report.historyEpoch]);
        } };
    });
  }

  async reportForSelection(client: pg.PoolClient, context: ReportReadContext, setId?: string): Promise<ReportMetadata> {
    if (!setId || setId === context.report.setId) return context.report;
    const member = await client.query(`SELECT 1 FROM (${readableHistorySql}) history
      WHERE history.id=$3::uuid AND history.visibility='retained'`,
    [context.identity.tenantId, context.report.historyRevision, setId]);
    if (!member.rowCount) throw new SelectionError("selection_invalidated");
    const report = await this.metadata(client, context.identity.tenantId, setId, context.evaluatedAt);
    return { ...report, activeSetId: context.report.activeSetId, activeRevision: context.report.activeRevision,
      historyRevision: context.report.historyRevision, historyEpoch: context.report.historyEpoch };
  }

  private async metadata(client: pg.PoolClient, tenant: string, setId: string | undefined, now: Date): Promise<ReportMetadata> {
    const state = (await client.query(`SELECT h.revision::text AS history_revision,h.invalidation_epoch::text,
      s.active_set_id,s.revision::text AS active_revision,
      (SELECT count(*) FROM official_usage_history_memberships m WHERE m.tenant_id=h.tenant_id AND m.valid_to_revision IS NULL)::int AS retained,
      (SELECT count(*) FROM official_usage_sets t WHERE t.tenant_id=h.tenant_id AND NOT t.complete AND t.deleted_at IS NULL)::int AS incomplete
      FROM official_usage_history_state h LEFT JOIN official_usage_state s ON s.tenant_id=h.tenant_id WHERE h.tenant_id=$1`, [tenant])).rows[0]
      ?? { history_revision: "0", invalidation_epoch: "0", active_set_id: null, active_revision: "1", retained: 0, incomplete: 0 };
    const chosen = setId ?? state.active_set_id;
    const set = chosen ? (await client.query(`SELECT s.id,s.reporting_start::text,s.reporting_end::text,s.period_provenance,s.accepted_at,s.expires_at
      FROM official_usage_sets s JOIN official_usage_history_memberships m ON m.set_id=s.id AND m.tenant_id=s.tenant_id
      WHERE s.id=$1 AND s.tenant_id=$2 AND s.deleted_at IS NULL AND s.complete AND m.valid_to_revision IS NULL
        AND (s.expires_at IS NULL OR s.expires_at>$3)`, [chosen, tenant, now])).rows[0] : null;
    if (setId && !set) throw new SelectionError("selection_invalidated");
    const versions = set ? (await client.query(`SELECT v.id,v.kind,v.content_hash,v.row_count,v.source_as_of,v.source_as_of_provenance,
      v.source_freshness,v.period_provenance,v.expires_at,a.expires_at AS artifact_expiry,
      ${readableReportVersionSql("v.id","v.tenant_id","v.kind","v.row_count")} AS complete
      FROM official_usage_set_versions m JOIN official_usage_versions v ON v.id=m.version_id AND v.tenant_id=m.tenant_id AND v.kind=m.kind
      JOIN official_usage_artifacts a ON a.id=v.artifact_id AND a.tenant_id=v.tenant_id
      WHERE m.set_id=$1 AND m.tenant_id=$2 AND v.deleted_at IS NULL ORDER BY v.kind`, [set.id, tenant])).rows : [];
    if (set && (versions.length !== 3 || versions.some(row => row.complete !== true
      || row.expires_at && row.expires_at <= now || row.artifact_expiry && row.artifact_expiry <= now))) throw new SelectionError("selection_invalidated");
    const age = (date: number | null) => date === null ? null : Math.max(0, Math.floor((now.getTime() - date) / 86400000));
    const periodAgeDays = age(set?.reporting_end ? Date.parse(`${set.reporting_end}T23:59:59.999Z`) : null);
    const acceptedAgeDays = age(set?.accepted_at?.getTime() ?? null);
    const stale = (periodAgeDays ?? 0) > this.staleAfterDays || (acceptedAgeDays ?? 0) > this.staleAfterDays;
    const expires = [set?.expires_at, ...versions.flatMap(row => [row.expires_at, row.artifact_expiry])].filter((date): date is Date => Boolean(date));
    return { setId: set?.id ?? null, activeSetId: state.active_set_id ?? null, activeRevision: state.active_revision ?? "1",
      historyRevision: state.history_revision, historyEpoch: state.invalidation_epoch,
      availability: set ? stale ? "stale" : "active" : state.incomplete ? "incomplete" : state.retained ? "not_selected" : state.history_revision !== "0" ? "deleted" : "never_imported",
      staleAfterDays: this.staleAfterDays, periodAgeDays, acceptedAgeDays, acceptedAt: set?.accepted_at?.toISOString() ?? null,
      expiresAt: expires.length ? new Date(Math.min(...expires.map(date => date.getTime()))).toISOString() : null,
      reportingPeriod: set ? { startDate: set.reporting_start, endDate: set.reporting_end, provenance: set.period_provenance,
        days: set.reporting_start && set.reporting_end ? (Date.parse(set.reporting_end) - Date.parse(set.reporting_start)) / 86400000 + 1 : null } : null,
      lineages: versions.map(row => ({ kind: row.kind, versionId: row.id, contentHash: row.content_hash, rowCount: row.row_count,
        sourceAsOf: row.source_as_of?.toISOString() ?? null, sourceAsOfProvenance: row.source_as_of_provenance,
        sourceFreshness: row.source_freshness, periodProvenance: row.period_provenance })) };
  }

  async contextInRead(client: pg.PoolClient, identity: SelectionIdentity, selectionId: string): Promise<ReportReadContext> {
    const row = (await client.query(`SELECT s.endpoint,s.query_json,s.query_hash,s.evaluated_at,s.expires_at,s.revision,c.*,clock_timestamp() AS validated_at
      FROM data_read_selections s JOIN official_usage_read_contexts c ON c.selection_id=s.id
      WHERE s.id=$1 AND s.tenant_id=$2 AND s.principal_id=$3`, [selectionId, identity.tenantId, identity.principalId])).rows[0];
    if (!row) throw new SelectionError("selection_invalidated");
    const query = reportQuery(row.endpoint, row.query_json);
    if (canonicalQuery(query, reportQueryFields) !== row.query_hash) throw new SelectionError("invalid_cursor");
    const { publicationRevisions, ...metadata } = row.metadata;
    if (!isPublicationRevisions(publicationRevisions)) throw new SelectionError("selection_invalidated", "unavailable");
    return { identity, tokenMode: row.token_mode, endpoint: row.endpoint, query, queryHash: row.query_hash, metadata,
      report: row.report_metadata, evaluatedAt: row.evaluated_at,
      selection: { id: selectionId, revision: row.revision, expiresAt: row.expires_at.toISOString(), evaluatedAt: row.evaluated_at.toISOString(),
        validatedAt: row.validated_at.toISOString(), publicationRevisions } };
  }
  read<T>(id: string, identity: SelectionIdentity, work: (client: pg.PoolClient, context: ReportReadContext) => Promise<T>) {
    return this.selections.read(id, identity, async client => {
      const result = await work(client, await this.contextInRead(client, identity, id));
      await this.selections.assert(client, id, identity);
      return result;
    });
  }
  async currentInventoryData(client: pg.PoolClient, scope: Pick<SelectionIdentity, "tenantId" | "principalId">, at?: Date): Promise<ReportCurrentData> {
    const state = (await client.query("SELECT current_setting('transaction_isolation') AS isolation,clock_timestamp() AS now")).rows[0];
    if (state.isolation !== "repeatable read") throw new Error("inventory_report_repeatable_read_required");
    const evaluatedAt = at ?? state.now as Date;
    await this.history.prepareRead(client, scope.tenantId);
    const metadata = await this.sources.metadataInRead(client, { ...scope, tokenMode: "delegated" }, evaluatedAt);
    metadata.app_activity = { source: "app_activity", generationId: null, scopeId: null, revision: null,
      expiresAt: null, observedAt: null, attemptedAt: null, attemptStatus: null, attemptObservedCount: null,
      errorCode: null, message: "App activity is not captured for agent inventory.", rowCount: null, state: "unavailable",
      reportRefreshDate: null, period: null, reportVersion: null };
    return { identity: scope, evaluatedAt, query: { lowResponseThreshold: 5 },
      publicationRevisions: await readAutomaticInventoryRevisions(scope, client),
      metadata,
      report: await this.metadata(client, scope.tenantId, undefined, evaluatedAt) };
  }
  parameters(context: Omit<ReportCurrentData, "publicationRevisions">) {
    return [...userSourceSqlParameters(context), context.identity.tenantId, context.report.setId, context.query.lowResponseThreshold];
  }

  dataset(context: ReportReadContext, endpoint = context.endpoint, child?: string): { sql: string; values: unknown[] } {
    if (endpoint === "adoption") return adoptionDataset(this, context);
    const values = this.parameters(context);
    const relation = (table: string, extra = "") => `${reportRelationsSql} SELECT * FROM ${table} ${extra}`;
    if (endpoint === "copilot_users") {
      values.push(context.report.availability === "active");
      return { values, sql: `${reportRelationsSql} SELECT combined.*,
        COALESCE(NULLIF(display_name,''),upn) AS name,
        CASE WHEN NOT $7::boolean THEN 'unknown' WHEN has_activity THEN 'active'
          WHEN user_rows>0 THEN 'none' WHEN unresolved THEN 'unknown' ELSE 'none' END AS agent_activity_state,
        CASE WHEN user_rows IS NULL OR user_rows=0 THEN 'unknown' WHEN responses=0 THEN 'zero'
          WHEN responses<=$6 THEN 'low' ELSE 'outside' END AS review_cohort
        FROM combined` };
    }
    if (endpoint === "official_users") return { values, sql: relation("official_users") };
    if (endpoint === "official_agents") return { values, sql: relation("official_agents") };
    if (endpoint === "relationships") {
      const restrictions = ["kind='userAgents'"];
      if (child) {
        values.push(child);
        restrictions.push(context.endpoint === "copilot_users"
          ? `username IN (SELECT reported_username FROM combined WHERE identity=$${values.length} AND report_match='matched')`
          : `${context.endpoint === "official_agents" ? "agent_id" : "username"}=$${values.length}`);
      }
      return { values, sql: `${reportRelationsSql} SELECT payload_hash AS identity,agent_id,agent_name AS name,creator_type,username,responses,last_activity
        FROM reports WHERE ${restrictions.join(" AND ")}` };
    }
    if (endpoint === "unresolved") return { values, sql: `${reportRelationsSql} SELECT m.username AS identity,m.username,m.username AS name,m.responses,m.has_activity,
      CASE WHEN max(m.match_count)=0 THEN 'not_found' ELSE 'ambiguous' END AS reason FROM matches m
      WHERE m.match_count<>1 OR m.user_rows>1 OR m.alias_ambiguous GROUP BY m.username,m.responses,m.has_activity
      UNION ALL SELECT username AS identity,username,username AS name,responses,has_activity,'ambiguous' AS reason
      FROM resolved WHERE identity_count>1` };
    if (endpoint === "plans") {
      if (!child) throw new SelectionError("invalid_cursor");
      return { values: [context.metadata.directory.generationId, child], sql: `SELECT identity,plan_id,service,display_name AS name,state,capability_status,
        residual->>'assignedDateTime' AS assigned_at FROM directory_service_plan_rows WHERE generation_id=$1 AND user_id=$2` };
    }
    const historyValues: unknown[] = [context.identity.tenantId, context.report.historyRevision, context.report.activeSetId];
    if (endpoint === "observations") {
      if (!child) throw new SelectionError("invalid_cursor");
      return { values: [context.identity.tenantId, context.report.historyRevision, child], sql: `SELECT v.id::text AS identity,v.kind AS name,v.kind,
        v.content_hash,v.row_count,v.accepted_at,v.source_as_of,v.source_as_of_provenance,v.source_freshness,v.supersedes_version_id
        FROM (${readableHistorySql}) s JOIN official_usage_set_versions m ON m.set_id=s.id AND m.tenant_id=s.tenant_id
        JOIN official_usage_versions v ON v.id=m.version_id AND v.tenant_id=m.tenant_id WHERE s.id=$3::uuid` };
    }
    if (endpoint === "history") return { values: historyValues, sql: `SELECT history.*,history.id::text AS identity,
      history.accepted_at::text AS name,(history.id=$3::uuid) AS active FROM (${readableHistorySql}) history` };
    historyValues.push(context.evaluatedAt, context.report.setId, context.query.scope ?? "history", context.query.startDate ?? null,
      context.query.endDate ?? null, context.query.search ?? null);
    return { values: historyValues, sql: `WITH retained AS (${readableHistorySql}), versions AS (
      SELECT DISTINCT ON(v.id) v.id,v.tenant_id,v.kind,s.accepted_at,s.id AS set_id FROM retained s
      JOIN official_usage_set_versions m ON m.set_id=s.id AND m.tenant_id=s.tenant_id
      JOIN official_usage_versions v ON v.id=m.version_id AND v.tenant_id=m.tenant_id AND v.kind=m.kind
      WHERE ($6='selected' AND s.id=$5::uuid OR $6='history' AND s.visibility='retained') AND ($3::uuid IS NULL OR true)
      ORDER BY v.id,s.accepted_at DESC,s.id DESC), evidence AS (
      SELECT f.*,v.id AS version_id,v.accepted_at,v.set_id,
        (($7::date IS NULL OR f.last_activity>=$7) AND ($8::date IS NULL OR f.last_activity<=$8)
          AND ($9::text IS NULL OR strpos(${reportSearchSql("f.agent_id")},$9)>0
            OR strpos(${reportSearchSql("f.agent_name")},$9)>0)) AS query_match
      FROM versions v JOIN official_usage_version_rows r ON r.version_id=v.id
      JOIN official_usage_row_facts f ON f.tenant_id=r.tenant_id AND f.kind=r.kind AND f.payload_hash=r.payload_hash
      WHERE f.kind IN ('agents','userAgents')), names AS (
        SELECT DISTINCT ON(agent_id) agent_id,agent_name,set_id,accepted_at FROM evidence
        ORDER BY agent_id,query_match DESC NULLS LAST,accepted_at DESC,set_id DESC,version_id,payload_hash)
      SELECT e.agent_id AS identity,e.agent_id,max(n.agent_name) AS name,
        bool_or(query_match) AS query_match,count(DISTINCT e.creator_type) FILTER(WHERE query_match) AS creator_type_count,
        max(n.set_id::text) AS latest_set_id,max(n.accepted_at) AS latest_accepted_at,
        count(DISTINCT version_id) FILTER(WHERE query_match) AS observation_count,bool_or(responses>0) FILTER(WHERE query_match) AS has_responses,
        min(last_activity) FILTER(WHERE query_match) AS earliest_activity,max(last_activity) FILTER(WHERE query_match) AS last_activity,
        COALESCE(bool_or(responses>0 AND last_activity BETWEEN ($4::timestamptz AT TIME ZONE 'UTC')::date-29
          AND ($4::timestamptz AT TIME ZONE 'UTC')::date) FILTER(WHERE query_match),false) AS active
      FROM evidence e JOIN names n ON n.agent_id=e.agent_id GROUP BY e.agent_id` };
  }

  filter(context: ReportReadContext, endpoint: ReportEndpoint, values: unknown[], omit?: "company" | "department") {
    if (endpoint === "adoption") return "true";
    const q = context.query, clauses = ["true"], add = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (endpoint === "overview") clauses.push("query_match");
    if (q.search) clauses.push(`(strpos(${reportSearchSql("COALESCE(name,'')")},${add(q.search)})>0 OR strpos(${reportSearchSql("identity")},${add(q.search)})>0
      ${endpoint === "copilot_users" ? `OR strpos(${reportSearchSql("upn_key")},${add(q.search)})>0` : ""}
      ${["copilot_users", "official_users"].includes(endpoint) ? `OR strpos(${reportSearchSql("COALESCE(company,'')")},${add(q.search)})>0
        OR strpos(${reportSearchSql("COALESCE(department,'')")},${add(q.search)})>0` : ""}
      ${["official_agents", "relationships"].includes(endpoint) ? `OR strpos(${reportSearchSql("creator_type")},${add(q.search)})>0` : ""}
      ${endpoint === "relationships" ? `OR strpos(${reportSearchSql("username")},${add(q.search)})>0 OR strpos(${reportSearchSql("agent_id")},${add(q.search)})>0` : ""}
      ${["copilot_users", "official_users"].includes(endpoint) ? `OR EXISTS(SELECT 1 FROM official_usage_set_versions sm JOIN official_usage_version_rows vr ON vr.version_id=sm.version_id
        JOIN official_usage_row_facts rf ON rf.tenant_id=vr.tenant_id AND rf.kind=vr.kind AND rf.payload_hash=vr.payload_hash
        WHERE sm.set_id=${add(context.report.setId)} AND sm.tenant_id=${add(context.identity.tenantId)} AND rf.kind='userAgents'
          AND rf.username=${endpoint === "copilot_users" ? "dataset.reported_username" : "dataset.username"}
          ${q.agentId !== undefined ? `AND rf.agent_id=${add(q.agentId)}` : ""}
          ${q.creatorType !== undefined ? `AND rf.creator_type=${add(q.creatorType)}` : ""}
          ${q.responsesOnly ? "AND rf.responses>0" : ""}
          AND (strpos(${reportSearchSql("rf.agent_name")},${add(q.search)})>0 OR strpos(${reportSearchSql("rf.agent_id")},${add(q.search)})>0))` : ""})`);
    if (["copilot_users", "official_users"].includes(endpoint)) {
      if (q.username !== undefined) clauses.push(`${endpoint === "copilot_users" ? "reported_username" : "username"}=${add(q.username)}`);
      for (const field of ["company", "department"] as const) if (q[field] !== undefined && field !== omit) clauses.push(`${field} IS NOT DISTINCT FROM ${add(q[field])}::text`);
      for (const [key, column] of [["entitlement", "entitlement"], ["serviceState", "service_state"], ["appActivity", "activity_state"]] as const) if (q[key] !== undefined) clauses.push(`${column}=${add(q[key])}`);
      if (q.licenseCohort) clauses.push(`${add(context.metadata.directory.state === "available")}::boolean AND entitlement IN ('paid_inactive','no_paid') AND has_activity`);
      if (q.cohort === "licensed") clauses.push("entitlement='paid_active'");
      if (q.cohort === "using_agents") clauses.push("entitlement='paid_active' AND agent_activity_state='active'");
      if (q.cohort === "no_agent_activity") clauses.push("entitlement='paid_active' AND agent_activity_state='none'");
      if (q.cohort === "needs_attention") clauses.push("entitlement='paid_active' AND (agent_activity_state='none' OR agent_activity_state='active' AND review_cohort='low' OR activity_state='inactive' OR service_state<>'enabled')");
      if (q.cohort === "unknown_metrics") clauses.push("entitlement='paid_active' AND (agent_activity_state='unknown' OR activity_state='unknown')");
      if (q.cohort === "review") clauses.push("review_cohort IN ('zero','low')");
      if (q.cohort === "zero" || q.cohort === "low") clauses.push(`review_cohort=${add(q.cohort)}`);
      if (q.agentId !== undefined || q.creatorType !== undefined || q.responsesOnly) {
        clauses.push(`EXISTS(SELECT 1 FROM official_usage_set_versions sm JOIN official_usage_version_rows vr ON vr.version_id=sm.version_id
          JOIN official_usage_row_facts rf ON rf.tenant_id=vr.tenant_id AND rf.kind=vr.kind AND rf.payload_hash=vr.payload_hash
          WHERE sm.set_id=${add(context.report.setId)} AND sm.tenant_id=${add(context.identity.tenantId)} AND rf.kind='userAgents'
            AND rf.username=${endpoint === "copilot_users" ? "dataset.reported_username" : "dataset.username"}
            ${q.agentId !== undefined ? `AND rf.agent_id=${add(q.agentId)}` : ""}
            ${q.creatorType !== undefined ? `AND rf.creator_type=${add(q.creatorType)}` : ""} ${q.responsesOnly ? "AND rf.responses>0" : ""})`);
      }
    } else {
      if (q.creatorType !== undefined) clauses.push(`creator_type=${add(q.creatorType)}`);
      if (q.agentId !== undefined) clauses.push(`agent_id=${add(q.agentId)}`);
      if (q.username !== undefined) clauses.push(`username=${add(q.username)}`);
      if (q.responsesOnly) clauses.push("responses>0");
    }
    if (endpoint !== "history" && endpoint !== "plans" && endpoint !== "unresolved" && endpoint !== "observations") {
      const date = ["official_users", "copilot_users"].includes(endpoint) ? "user_last_activity" : "last_activity";
      if (q.startDate && endpoint !== "overview") clauses.push(`${date}>=${add(q.startDate)}::date`);
      if (q.endDate && endpoint !== "overview") clauses.push(`${date}<=${add(q.endDate)}::date`);
      if (q.reportActivity === "no-activity") clauses.push(`${date} IS NULL`);
      if (q.reportActivity === "recent" || q.reportActivity === "inactive") {
        // Window anchored to the maximum observed date, not the upload clock.
        const anchor = ["copilot_users", "official_users"].includes(endpoint) ? `(SELECT max(f.last_activity) FROM official_usage_set_versions m
          JOIN official_usage_version_rows r ON r.version_id=m.version_id JOIN official_usage_row_facts f ON f.tenant_id=r.tenant_id AND f.kind=r.kind AND f.payload_hash=r.payload_hash
          WHERE m.tenant_id=${add(context.identity.tenantId)} AND m.set_id=${add(context.report.setId)} AND f.kind='users')` : `(SELECT max(${date}) FROM dataset)`;
        clauses.push(`${date} IS NOT NULL AND ${date} ${q.reportActivity === "recent" ? ">=" : "<"}
          ${anchor}-(${add(q.inactiveDays)}::int-1)`);
      }
    }
    return clauses.join(" AND ");
  }

  async rowsInRead(client: pg.PoolClient, context: ReportReadContext, options: {
    endpoint?: ReportEndpoint; child?: string; childQuery?: ReportQuery; limit?: number; cursor?: string; exactIds?: readonly string[]; exportAfter?: string; explicitExportId?: string; officialAgentsOnly?: boolean;
  } = {}, envelope?: { summary: ReportSql; analytics: ReportSql }) {
    const endpoint = options.endpoint ?? context.endpoint, limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > (options.exportAfter !== undefined ? 250 : 100)) throw new SelectionError("invalid_cursor");
    if (options.exactIds && (options.exactIds.length > 100 || options.exactIds.some(id => typeof id !== "string" || id.length > 512))) throw new SelectionError("invalid_cursor");
    // JIT compilation overwhelms bounded OLTP reads even for small selections.
    // Multi-batch projections must avoid partial-key and quadratic join plans.
    const large = context.report.lineages.reduce((total, lineage) => total + lineage.rowCount, 0) > dataLimits.batchRows;
    await client.query("SELECT set_config('jit','off',true)"
      + (large ? ",set_config('enable_nestloop','off',true),set_config('enable_mergejoin','off',true)" : ""));
    const { sql, values } = this.dataset(context, endpoint, options.child);
    if (options.childQuery && endpoint === context.endpoint) throw new SelectionError("invalid_cursor");
    const childContext = endpoint === context.endpoint ? context : { ...context, query: options.childQuery ? reportQuery(endpoint, options.childQuery) : {
      lowResponseThreshold: context.query.lowResponseThreshold, inactiveDays: context.query.inactiveDays, activityWindowDays: context.query.activityWindowDays,
      sort: "name" as const, order: "asc" as const,
    } };
    const filter = this.filter(childContext, endpoint, values);
    const exactParameter = options.exactIds ? values.push(options.exactIds) : undefined;
    let where = `${filter}${exactParameter ? ` AND identity=ANY($${exactParameter}::text[])` : ""}`;
    if (options.officialAgentsOnly) where += " AND response_source='agents'";
    if (options.explicitExportId) {
      values.push(options.explicitExportId, context.identity.tenantId);
      where += ` AND EXISTS(SELECT 1 FROM data_export_items item WHERE item.export_id=$${values.length - 1} AND item.tenant_id=$${values.length} AND item.identity=dataset.identity)`;
    }
    const key = options.exportAfter !== undefined ? "identity" : sortKey(childContext.query.sort ?? "name", endpoint);
    if (envelope && !sql.startsWith(reportRelationsSql)) throw new Error("report_projection_relation");
    let base = `${envelope ? `${reportRelationsSql}, dataset AS (${sql.slice(reportRelationsSql.length)})` : `WITH dataset AS (${sql})`},
      ordered AS (SELECT *,${key} AS page_key FROM dataset WHERE ${where})`;
    const scope = `${endpoint}:${options.child ?? ""}`, hash = digest(`${context.queryHash}:${scope}:${canonicalQuery(childContext.query, reportQueryFields)}`);
    const countScope = `counts:${hash}:${options.explicitExportId ?? ""}:${Boolean(options.officialAgentsOnly)}`;
    const rootCounts = this.aggregate(context, countScope)?.counts;
    const cachedCounts = options.exactIds ? undefined : rootCounts;
    const expected = { identity: context.identity, endpoint: scope, selectionId: context.selection.id, revision: context.selection.revision, queryHash: hash };
    const cursor = options.cursor ? this.codec.decode(options.cursor, expected) : undefined;
    const previous = cursor?.direction === "previous", descending = options.exportAfter !== undefined ? false : childContext.query.order === "desc";
    const direction = previous !== descending ? "DESC" : "ASC";
    const identityDirection = endpoint === "overview" ? previous ? "DESC" : "ASC" : direction;
    const edge = await this.cursorBoundary(client, base, values, cursor?.boundary);
    let boundary = "true", nonNullBoundary = "true";
    if (edge) {
      values.push(edge.nullRank, edge.key ?? "", edge.id);
      const n = values.length;
      boundary = `((page_key IS NULL)::int ${previous ? "<" : ">"} $${n - 2}::int OR
        (page_key IS NULL)::int=$${n - 2}::int AND
          (COALESCE(page_key,'') COLLATE "C" ${direction === "DESC" ? "<" : ">"} $${n - 1}::text COLLATE "C"
            OR COALESCE(page_key,'') COLLATE "C"=$${n - 1}::text COLLATE "C"
              AND identity COLLATE "C" ${identityDirection === "DESC" ? "<" : ">"} $${n}::text COLLATE "C"))`;
      nonNullBoundary = `(page_key COLLATE "C",identity COLLATE "C") ${direction === "DESC" ? "<" : ">"}
        ($${n - 1}::text COLLATE "C",$${n}::text COLLATE "C")`;
    } else if (options.exportAfter !== undefined) {
      values.push(options.exportAfter); boundary = `identity COLLATE "C">$${values.length}::text COLLATE "C"`;
      nonNullBoundary = boundary;
    }
    const limitParameter = values.push(limit + (options.exportAfter !== undefined ? 0 : 1));
    const appendProjection = (query: ReportSql) => {
      const offset = values.length - 6;
      values.push(...query.values.slice(6));
      return query.sql.replace(/\$(\d+)/g, (original, index: string) => Number(index) <= 6 ? original : `$${Number(index) + offset}`);
    };
    const projections = envelope ? `,CASE WHEN batch_position=1 OR batch_position IS NULL
        THEN (SELECT to_jsonb(projected) FROM (${appendProjection(envelope.summary)}) projected) END AS envelope_summary,
      CASE WHEN batch_position=1 OR batch_position IS NULL
        THEN (SELECT to_jsonb(projected) FROM (${appendProjection(envelope.analytics)}) projected) END AS envelope_analytics` : "";
    const order = `(page_key IS NULL)::int ${previous ? "DESC" : "ASC"},COALESCE(page_key,'') COLLATE "C" ${direction},identity COLLATE "C" ${identityDirection}`;
    const q = childContext.query;
    const directDirectory = endpoint === "copilot_users" && !envelope && rootCounts
      && (options.exactIds || (!q.search && q.appActivity === undefined && q.username === undefined && q.licenseCohort === undefined
        && [undefined, "all", "licensed"].includes(q.cohort) && [undefined, "all"].includes(q.reportActivity)
        && q.agentId === undefined && q.creatorType === undefined && !q.responsesOnly && q.startDate === undefined && q.endDate === undefined)
      && (options.exportAfter !== undefined || ["name", "upn", "company", "department", "service"].includes(q.sort ?? "name")));
    if (directDirectory) {
      await client.query("SELECT set_config('enable_nestloop','on',true),set_config('enable_mergejoin','on',true)");
      const nonNull = (options.exportAfter !== undefined || ["name", "upn", "service"].includes(q.sort ?? "name"))
        && (!edge || edge.nullRank === 0 && edge.key !== null);
      const candidate = options.exactIds ? `SELECT generation_id,identity,upn,upn_key,display_name,sort_key,company,department,
        account_enabled,user_type,employee_type,service_state,plan_count FROM directory_user_rows
        WHERE generation_id=$1 AND identity=ANY($${exactParameter}::text[]) LIMIT 100`
        : `SELECT * FROM (SELECT dataset.*,${key} AS page_key FROM (
        SELECT d.generation_id,d.identity,d.upn,d.upn_key,d.display_name,d.sort_key,d.company,d.department,
          d.account_enabled,d.user_type,d.employee_type,d.service_state,d.plan_count,
          COALESCE(NULLIF(d.display_name,''),d.upn) AS name,
          CASE WHEN d.service_state='unknown' THEN 'unknown'
            WHEN d.service_state IN ('enabled','warning','partially_enabled') THEN 'paid_active'
            WHEN d.plan_count=0 THEN 'no_paid' ELSE 'paid_inactive' END AS entitlement
        FROM directory_user_rows d WHERE d.generation_id=$1
      ) dataset WHERE ${where}) selected WHERE ${nonNull ? nonNullBoundary : boundary}
        ORDER BY ${nonNull ? `page_key COLLATE "C" ${direction},identity COLLATE "C" ${identityDirection}` : order} LIMIT $${limitParameter}`;
      const relation = selectedDirectoryReportRelationsSql(candidate, `$${values.push(rootCounts.unresolved)}`);
      base = `WITH dataset AS (${relation} ${sql.slice(reportRelationsSql.length)}),
        ordered AS (SELECT *,${key} AS page_key FROM dataset WHERE ${where})`;
    }
    const reportedKind = endpoint === "official_users" ? "users" : endpoint === "official_agents" ? "agents"
      : endpoint === "relationships" ? "userAgents" : undefined;
    const directReported = reportedKind && !envelope && rootCounts?.primaryComplete && !options.child
      && !options.explicitExportId && !options.officialAgentsOnly && options.exportAfter === undefined
      && (options.exactIds || (q.sort === "name" && !q.search && q.company === undefined && q.department === undefined
        && q.entitlement === undefined && q.serviceState === undefined && q.appActivity === undefined && q.licenseCohort === undefined
        && q.username === undefined && q.agentId === undefined && q.creatorType === undefined && !q.responsesOnly
        && q.startDate === undefined && q.endDate === undefined && [undefined,"all"].includes(q.cohort)
        && [undefined,"all"].includes(q.reportActivity)))
      && (!edge || edge.nullRank === 0 && edge.key !== null && edge.key !== "\0");
    if (directReported) {
      await client.query("SELECT set_config('enable_nestloop','on',true),set_config('enable_mergejoin','on',true)");
      const identityColumn = reportedKind === "users" ? "username" : reportedKind === "agents" ? "agent_id" : "payload_hash";
      const nameColumn = reportedKind === "users" ? "COALESCE(NULLIF(f.display_name,''),f.username)" : "f.agent_name";
      const prefixBoundary = edge ? ` AND left(page_key,128) COLLATE "C" ${direction === "DESC" ? "<=" : ">="}
        left($${values.push(edge.key)}::text,128) COLLATE "C"` : "";
      const candidate = `SELECT * FROM (
        SELECT f.${identityColumn} AS identity,f.identity_key,f.payload_hash,
          lower(normalize(${nameColumn},NFKC) COLLATE "default") AS page_key
        FROM official_usage_row_facts f WHERE f.tenant_id=$4 AND f.kind='${reportedKind}'
          AND EXISTS(SELECT 1 FROM official_usage_set_versions m JOIN official_usage_version_rows r
            ON r.version_id=m.version_id AND r.tenant_id=m.tenant_id AND r.kind=m.kind
            WHERE m.tenant_id=$4 AND m.set_id=$5 AND m.kind=f.kind AND r.payload_hash=f.payload_hash OFFSET 0)
      ) source_page WHERE ${options.exactIds ? `identity=ANY($${exactParameter}::text[])` : nonNullBoundary+prefixBoundary}
        ORDER BY left(page_key,128) COLLATE "C" ${direction},page_key COLLATE "C" ${direction},
          identity COLLATE "C" ${identityDirection} LIMIT $${limitParameter}`;
      const relation = selectedOfficialReportRelationsSql(reportedKind,candidate);
      base = `WITH dataset AS (${relation} SELECT report_page.* FROM (${sql.slice(reportRelationsSql.length)}) report_page
        WHERE report_page.identity IN(SELECT identity FROM selected_report_keys)),
        ordered AS (SELECT *,${key} AS page_key FROM dataset WHERE ${where})`;
    }
    let countSql: string;
    if (cachedCounts) {
      const n = values.push(String(cachedCounts.total), String(cachedCounts.filtered), cachedCounts.unresolved, cachedCounts.primaryComplete ?? false);
      countSql = `SELECT $${n - 3}::text AS count_total,$${n - 2}::text AS count_filtered,
        $${n - 1}::boolean AS count_unresolved,$${n}::boolean AS count_primary_complete`;
    } else {
      const primaryComplete = reportedKind ? `COALESCE(bool_and(${reportedKind === "users" ? "user_rows=1 AND name IS NOT NULL"
        : reportedKind === "agents" ? "response_source='agents' AND has_primary_name" : "name IS NOT NULL"}),true)
        ${reportedKind === "userAgents" ? "" : `AND count(*)=$${values.push(context.report.lineages.find(lineage => lineage.kind===reportedKind)?.rowCount ?? 0)}::bigint`}` : "false";
      countSql = `SELECT ${options.exactIds ? "count(*)" : `(SELECT count(*) FROM dataset${options.officialAgentsOnly ? " WHERE response_source='agents'" : ""})`}::text AS count_total,
        count(*)::text AS count_filtered,${endpoint === "copilot_users" ? "(SELECT COALESCE(bool_or(unresolved),false) FROM dataset)" : "false"} AS count_unresolved,
        (${primaryComplete}) AS count_primary_complete FROM ordered`;
    }
    // Apply a byte prefix inside SQL, before large accepted UTF-8 rows cross
    // the client boundary. Candidate count preserves continuations on short pages.
    const fetched = (await client.query(`${base}, counts AS (${countSql}), candidate AS MATERIALIZED (
      SELECT * FROM ordered WHERE ${boundary} ORDER BY ${order} LIMIT $${limitParameter}
    ), sized AS (
      SELECT candidate.*,row_number() OVER(ORDER BY ${order}) AS batch_position,count(*) OVER() AS batch_total,
        sum(octet_length(to_jsonb(candidate)::text)+128) OVER(ORDER BY ${order} ROWS UNBOUNDED PRECEDING) AS batch_bytes FROM candidate
    ) SELECT sized.*,counts.count_total,counts.count_filtered,counts.count_unresolved,counts.count_primary_complete ${projections}
      FROM sized RIGHT JOIN counts ON batch_bytes<=524288
      ORDER BY batch_position`, values)).rows;
    encodeBatch(fetched);
    const counts = { total: exactCount(fetched[0].count_total), filtered: exactCount(fetched[0].count_filtered) };
    if (!options.exactIds) this.aggregate(context, countScope, { counts: { ...counts, unresolved: fetched[0].count_unresolved === true,
      primaryComplete: fetched[0].count_primary_complete === true } });
    const raw = fetched.filter(row => row.batch_position !== null);
    if (!raw.length && counts.filtered > 0 && !cursor && options.exportAfter === undefined) throw new AppError(413, "data_row_limit", "A selected row exceeds the response budget.");
    const more = raw.length > 0 && exactCount(raw[0].batch_total) > Math.min(raw.length, limit), rows = raw.slice(0, limit);
    if (previous) rows.reverse();
    const encode = (row: pg.QueryResultRow, direction: "next" | "previous") => this.rowCursor({ ...expected, direction }, row);
    return { raw: rows, value: rows.map(row => project(endpoint, row)), counts,
      summaryRow: envelope ? fetched[0].envelope_summary as pg.QueryResultRow : undefined,
      analyticsRow: envelope ? fetched[0].envelope_analytics as pg.QueryResultRow : undefined,
      page: { limit, nextCursor: rows.length && (previous ? Boolean(cursor) : more) ? encode(rows.at(-1)!, "next") : null,
        previousCursor: rows.length && (previous ? more : Boolean(cursor)) ? encode(rows[0], "previous") : null } };
  }

  page(id: string, identity: SelectionIdentity, options: Parameters<LargeTenantUsersReports["rowsInRead"]>[2] = {}): Promise<ReportPage<ReportRow>> {
    return this.read(id, identity, (client, context) => this.pageInRead(client, context, options));
  }
  historyOptions(id: string, identity: SelectionIdentity, options: { limit?: number; cursor?: string } = {}) {
    return this.read(id, identity, async (client, context) => {
      if (context.endpoint !== "history") throw new SelectionError("invalid_cursor");
      const rows = await this.rowsInRead(client, context, options);
      return bounded({ value: rows.value, page: rows.page, counts: rows.counts, selection: context.selection, reports: context.report });
    });
  }
  async pageInRead(client: pg.PoolClient, context: ReportReadContext, options: Parameters<LargeTenantUsersReports["rowsInRead"]>[2] = {}): Promise<ReportPage<ReportRow>> {
      const memo = this.aggregate(context, "envelope");
      const cached = memo?.summaryRow && memo.analyticsRow ? memo : undefined;
      const analyticsDataset = this.dataset(context), pageDataset = this.dataset(context, options.endpoint, options.child);
      const shared = analyticsDataset.sql.startsWith(reportRelationsSql) && pageDataset.sql.startsWith(reportRelationsSql);
      const split = shared && !cached && context.endpoint === "official_agents"
        && context.report.lineages.reduce((sum,lineage) => sum+lineage.rowCount,0)>dataLimits.batchRows;
      const projection = shared && !cached && !split ? { summary: this.summaryQuery(context),
        analytics: officialReportAnalyticsQuery(this, context, { ...analyticsDataset, sql: analyticsDataset.sql.slice(reportRelationsSql.length) }) } : undefined;
      const rows = await this.rowsInRead(client, context, options, projection);
      if (projection && (!rows.summaryRow || !rows.analyticsRow)) throw new Error("report_projection_metrics");
      let summaryRow = cached?.summaryRow ?? rows.summaryRow, analyticsRow = cached?.analyticsRow ?? rows.analyticsRow;
      if (split) {
        const summary = this.summaryQuery(context), analytics = officialReportAnalyticsQuery(this,context);
        summaryRow = (await client.query(`${reportRelationsSql} SELECT * FROM (${summary.sql}) summary`,summary.values)).rows[0];
        analyticsRow = (await client.query(analytics.sql,analytics.values)).rows[0];
      }
      if (summaryRow && analyticsRow) this.aggregate(context, "envelope", { summaryRow, analyticsRow });
      const summary = summaryRow ? this.projectSummary(summaryRow, context) : await this.summaryInRead(client, context);
      const analytics = analyticsRow ? projectReportAnalytics(analyticsRow, context) : await officialReportAnalytics(client, this, context);
      return bounded({ value: rows.value, page: rows.page, counts: rows.counts, selection: context.selection, reports: context.report,
        sources: context.metadata, filters: context.query, summary, analytics });
  }
  exact(id: string, identity: SelectionIdentity, recordId: string) {
    return this.read(id, identity, (client, context) => this.exactInRead(client, context, recordId));
  }
  async exactInRead(client: pg.PoolClient, context: ReportReadContext, recordId: string) {
      const result = await this.rowsInRead(client, context, { exactIds: [recordId], limit: 1 });
      if (!result.value.length) throw new AppError(404, "data_record_not_found", "Record is not in the selected cohort.");
      return bounded({ value: result.value[0], selection: context.selection, reports: context.report, sources: context.metadata }, 524288);
  }

  facets(id: string, identity: SelectionIdentity, options: { field: "company" | "department" | "creatorType"; search?: string; limit?: number; cursor?: string }) {
    if (!["company", "department", "creatorType"].includes(options.field)) throw new SelectionError("invalid_cursor");
    const search = options.search === undefined ? "" : reportSearch(options.search);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SelectionError("invalid_cursor");
    return this.read(id, identity, async (client, context) => {
      if (options.field === "creatorType" ? context.endpoint !== "official_agents" : !["copilot_users", "official_users", "adoption"].includes(context.endpoint)) throw new SelectionError("invalid_cursor");
      const field = options.field === "creatorType" ? "creator_type" : options.field;
      const query = { ...context.query };
      delete query[options.field];
      const copy = { ...context, query };
      const { sql, values } = this.dataset(copy);
      const where = this.filter(copy, copy.endpoint, values, options.field === "creatorType" ? undefined : options.field);
      values.push(search);
      const facetKey = context.endpoint === "adoption" ? `lower(normalize(${field},NFKC))` : field;
      const facetLabel = context.endpoint === "adoption" ? `min(${field} COLLATE "C")` : field;
      const base = `WITH dataset AS (${sql}), options AS (SELECT ${facetLabel} AS value,count(*)::text AS count FROM dataset
        WHERE ${where} AND strpos(${reportSearchSql(`COALESCE(${field},'')`)},$${values.length})>0 GROUP BY ${facetKey}),
        ordered AS (SELECT *,lower(normalize(value,NFKC) COLLATE "default") AS page_key,COALESCE(value,chr(1)) AS identity FROM options)`;
      const counts = (await client.query(`${base} SELECT count(*)::text AS filtered,
        (SELECT count(*) FROM (SELECT ${facetKey} FROM dataset GROUP BY ${facetKey}) all_options)::text AS total FROM ordered`, values)).rows[0];
      const expected = { identity, endpoint: `facets:${options.field}`, selectionId: id, revision: context.selection.revision,
        queryHash: digest(`${context.queryHash}:${options.field}:${options.search ?? ""}`) };
      const cursor = options.cursor ? this.codec.decode(options.cursor, expected) : undefined, previous = cursor?.direction === "previous";
      const edge = await this.cursorBoundary(client, base, values, cursor?.boundary);
      let boundary = "true";
      if (edge) {
        values.push(edge.nullRank, edge.key ?? "", edge.id);
        boundary = `((page_key IS NULL)::int ${previous ? "<" : ">"} $${values.length - 2} OR
          (page_key IS NULL)::int=$${values.length - 2} AND (COALESCE(page_key,'') COLLATE "C",identity COLLATE "C")
          ${previous ? "<" : ">"} ($${values.length - 1}::text COLLATE "C",$${values.length}::text COLLATE "C"))`;
      }
      values.push(limit + 1);
      const rows = (await client.query(`${base} SELECT * FROM ordered WHERE ${boundary} ORDER BY (page_key IS NULL)::int ${previous ? "DESC" : "ASC"},
        COALESCE(page_key,'') COLLATE "C" ${previous ? "DESC" : "ASC"},identity COLLATE "C" ${previous ? "DESC" : "ASC"} LIMIT $${values.length}`, values)).rows;
      encodeBatch(rows);
      const more = rows.length > limit, page = rows.slice(0, limit);
      if (previous) page.reverse();
      const cursorFor = (row: pg.QueryResultRow, direction: "next" | "previous") => this.rowCursor({ ...expected, direction }, row);
      return bounded({ value: page.map(row => ({ value: row.value as string | null, count: exactCount(row.count) })), selection: context.selection,
        counts: { total: exactCount(counts.total), filtered: exactCount(counts.filtered) },
        page: { limit, nextCursor: page.length && (previous ? Boolean(cursor) : more) ? cursorFor(page.at(-1)!, "next") : null,
          previousCursor: page.length && (previous ? more : Boolean(cursor)) ? cursorFor(page[0], "previous") : null } });
    });
  }

  private summaryQuery(context: ReportReadContext): ReportSql {
    const combined = this.dataset(context, "copilot_users"), params = combined.values;
    const directoryCurrent = context.metadata.directory.state === "available";
    const where = directoryCurrent && ["copilot_users", "official_users"].includes(context.endpoint) ? this.filter(context, "copilot_users", params) : "true";
    const counts = `SELECT count(*)::text AS checked,
      count(*) FILTER(WHERE entitlement='paid_active')::text AS licensed,
      count(*) FILTER(WHERE entitlement='paid_active' AND agent_activity_state='active')::text AS using_agents,
      count(*) FILTER(WHERE entitlement='paid_active' AND agent_activity_state='none')::text AS no_agents,
      count(*) FILTER(WHERE entitlement='paid_active' AND (agent_activity_state='active' OR activity_state='active'))::text AS measured,
      count(*) FILTER(WHERE entitlement='paid_active' AND (agent_activity_state='none' OR agent_activity_state='active' AND review_cohort='low' OR activity_state='inactive' OR service_state<>'enabled'))::text AS attention,
      count(*) FILTER(WHERE entitlement='paid_active' AND (agent_activity_state='unknown' OR activity_state='unknown'))::text AS unknown
      FROM summary_directory dataset WHERE ${where}`;
    return { values: params, sql: `WITH summary_directory AS (${combined.sql.slice(reportRelationsSql.length)}) SELECT
      ${directoryCurrent ? `(SELECT to_jsonb(counted) FROM (${counts}) counted)` : "NULL::jsonb"} AS directory_counts,
      (SELECT count(*) FROM report_users r WHERE NOT EXISTS(SELECT 1 FROM resolved ok WHERE ok.username=r.username AND ok.identity_count=1))::text AS unresolved,
      (SELECT count(*) FROM official_users WHERE has_activity AND entitlement IN ('paid_inactive','no_paid'))::text AS unpaid,
      (SELECT count(*) FROM official_users WHERE has_activity AND entitlement='paid_active')::text AS paid,
      (SELECT count(*) FROM official_users WHERE has_activity AND (entitlement IS NULL OR entitlement='unknown'))::text AS unknown_license,
      (SELECT count(*) FROM report_users WHERE has_activity)::text AS active_users,
      sum(responses) FILTER(WHERE kind='agents')::text AS responses,
      sum(responses) FILTER(WHERE kind='userAgents')::text AS bridge,
      sum(responses) FILTER(WHERE kind='users')::text AS users,
      sum(licensed_users)::text AS licensed,sum(unlicensed_users)::text AS unlicensed FROM reports` };
  }
  async summaryInRead(client: pg.PoolClient, context: ReportReadContext): Promise<ReportSummary> {
    const cached = this.aggregate(context, "envelope");
    if (cached?.summaryRow) return this.projectSummary(cached.summaryRow, context);
    const query = this.summaryQuery(context);
    const source = (await client.query(`${reportRelationsSql} SELECT * FROM (${query.sql}) summary`, query.values)).rows[0];
    this.aggregate(context, "envelope", { ...cached, summaryRow: source });
    return this.projectSummary(source, context);
  }
  private projectSummary(source: pg.QueryResultRow, context: ReportReadContext): ReportSummary {
    const counts = source.directory_counts as pg.QueryResultRow | null;
    const n = nullableCount, directoryCurrent = context.metadata.directory.state === "available";
    const total = (kind: "agents" | "users" | "userAgents", value: string | null) => context.report.lineages.some(lineage => lineage.kind === kind)
      ? n(value ?? "0") : null;
    const metrics = [total("agents", source.responses), total("userAgents", source.bridge), total("users", source.users)]
      .filter((value): value is number => value !== null);
    return { checkedUsers: context.metadata.directory.rowCount, licensedUsers: counts ? exactCount(counts.licensed) : null,
      usingAgentsUsers: counts && context.report.availability === "active" ? exactCount(counts.using_agents) : null,
      noAgentActivityUsers: counts && context.report.availability === "active" ? exactCount(counts.no_agents) : null,
      measuredActivityUsers: counts && (context.report.availability === "active" || context.metadata.app_activity.state === "available") ? exactCount(counts.measured) : null,
      needsAttentionUsers: counts ? exactCount(counts.attention) : null, unknownMetricsUsers: counts ? exactCount(counts.unknown) : null,
      unresolvedIdentities: exactCount(source.unresolved), activeWithoutPaidUsers: directoryCurrent ? exactCount(source.unpaid) : null,
      paidActiveReportUsers: directoryCurrent ? exactCount(source.paid) : null, unknownLicenseActiveReportUsers: exactCount(source.unknown_license),
      reportedResponses: total("agents", source.responses), bridgeResponses: total("userAgents", source.bridge), userReportedResponses: total("users", source.users),
      distinctActiveReportUsers: context.report.setId ? exactCount(source.active_users) : null, licensedOccurrences: total("agents", source.licensed), unlicensedOccurrences: total("agents", source.unlicensed),
      responseReconciliation: metrics.length < 2 ? "not_comparable" : Math.max(...metrics) === Math.min(...metrics) ? "matching" : "mismatch",
      activeUsersAreNonAdditive: true };
  }

  async captureReportIdentities(identity: SelectionIdentity) {
    await this.prepareHistoryCapture(identity.tenantId);
    return this.selections.captureWith(identity, "directory_report_inputs", { values: {}, allowed: ["setId"] }, async (client, evaluatedAt) => {
      const report = await this.metadata(client, identity.tenantId, undefined, evaluatedAt);
      return { roots: [await this.history.root(client, identity.tenantId, evaluatedAt)], queryValues: { setId: report.setId } };
    });
  }
  async feedPositiveIdentities(id: string, identity: SelectionIdentity, stages: UserSourceStages, lease: GenerationLease) {
    if (lease.tenantId !== identity.tenantId) throw new SelectionError("selection_invalidated");
    if (!(await this.database.query(`SELECT 1 FROM data_generations g JOIN data_scope_epochs s ON s.id=g.scope_id
      WHERE g.id=$1 AND g.owner=$2 AND g.tenant_id=$3 AND s.principal_id=$4 AND g.session_epoch=$5 AND s.source='directory'`,
    [lease.id, lease.owner, identity.tenantId, identity.principalId, identity.sessionEpoch])).rowCount) throw new SelectionError("selection_invalidated");
    let after = "";
    for (;;) {
      const rows = await this.selections.read(id, identity, async (client, { selection }) => {
        if (selection.endpoint !== "directory_report_inputs") throw new SelectionError("selection_invalidated");
        return (await client.query(`SELECT DISTINCT f.identity_key COLLATE "C" AS identity_key
          FROM official_usage_set_versions m JOIN official_usage_version_rows r ON r.version_id=m.version_id AND r.tenant_id=m.tenant_id AND r.kind=m.kind
          JOIN official_usage_row_facts f ON f.tenant_id=r.tenant_id AND f.kind=r.kind AND f.payload_hash=r.payload_hash
          WHERE m.tenant_id=$1 AND m.set_id=$2 AND f.kind IN ('users','userAgents') AND f.responses>0
            AND f.identity_key COLLATE "C">$3::text COLLATE "C" ORDER BY 1 LIMIT 250`,
        [identity.tenantId, selection.query_json.setId, after])).rows;
      });
      if (!rows.length) break;
      encodeBatch(rows);
      await stages.identities(lease, rows.map(row => row.identity_key as string));
      after = rows.at(-1)!.identity_key;
    }
  }
}

function reportSearch(value: string) {
  if (typeof value !== "string" || value.length > 256 || /[\p{Cc}\p{Cs}]/u.test(value)) throw new SelectionError("invalid_cursor");
  // Lowercasing can introduce decomposed sequences, so normalize again before persisting.
  const search = value.normalize("NFKC").toLowerCase().normalize("NFKC").trim();
  if (search.length > 256) throw new SelectionError("invalid_cursor");
  return search;
}
function reportSearchSql(expression: string) {
  return `normalize(lower(normalize(${expression},NFKC) COLLATE "default"),NFKC)`;
}
function sortKey(sort: NonNullable<ReportQuery["sort"]>, endpoint: ReportEndpoint) {
  const keys = { name: 'lower(normalize(name,NFKC) COLLATE "default")', upn: "upn_key", company: 'lower(normalize(company,NFKC) COLLATE "default")',
    department: 'lower(normalize(department,NFKC) COLLATE "default")', service: "service_state", appActivity: "last_activity_date::text",
    responses: "lpad(responses::text,16,'0')", agentsUsed: "lpad(agents_used::text,16,'0')",
    lastActivity: ["official_users", "copilot_users"].includes(endpoint) ? "user_last_activity::text" : "last_activity::text",
    activeUsers: "lpad(active_users::text,16,'0')", licensedUsers: "lpad(licensed_users::text,16,'0')",
    unlicensedUsers: "lpad(unlicensed_users::text,16,'0')", acceptedAt: "accepted_at::text", reportingPeriod: reportPeriodSortKey,
    creatorType: 'lower(normalize(NULLIF(btrim(creator_type),\'\'),NFKC) COLLATE "default")' };
  return keys[sort];
}
export function bounded<T>(value: T, maximum = 1048576): T {
  peakCheckpoint("response.serialize");
  const serialized = JSON.stringify(value);
  peakCheckpoint("response.serialize");
  if (Buffer.byteLength(serialized) > maximum) throw new AppError(413, "data_response_bytes", `Response exceeds ${maximum} bytes.`);
  return value;
}
function nullableCount(value: string | number | null | undefined) { return value === null || value === undefined ? null : exactCount(value); }
function date(value: Date | string | null | undefined) { return value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null; }
function project(endpoint: ReportEndpoint, row: pg.QueryResultRow): ReportRow {
  if (endpoint === "copilot_users") {
    const attention: string[] = [];
    if (row.agent_activity_state === "unknown") attention.push("agent_usage_unknown");
    else if (row.agent_activity_state === "none") attention.push("agent_usage_zero");
    else if (row.review_cohort === "low") attention.push("agent_usage_low");
    if (row.activity_state === "unknown") attention.push("app_activity_unknown");
    else if (row.activity_state === "inactive") attention.push("app_activity_inactive");
    if (row.service_state !== "enabled") attention.push(`copilot_service_${row.service_state}`);
    return { ...facts(row), reportedUsername: row.reported_username, reportedResponses: nullableCount(row.responses), reportedAgentsUsed: nullableCount(row.agents_used),
      userLastActivityDateUtc: date(row.user_last_activity),
      bridgeResponses: nullableCount(row.bridge_responses), relationshipCount: exactCount(row.relationship_count ?? "0"),
      agentActivityState: row.agent_activity_state, reportMatch: row.report_match, attention };
  }
  if (endpoint === "official_users") return { username: row.username, displayName: row.name, objectId: row.object_id, company: row.company,
    department: row.department, entitlement: row.entitlement, reportedResponses: nullableCount(row.responses), reportedAgentsUsed: nullableCount(row.agents_used),
    bridgeResponses: nullableCount(row.bridge_responses), relationshipCount: exactCount(row.relationship_count), responseProducingAgentCount: exactCount(row.active_agent_count),
    userLastActivityDateUtc: date(row.user_last_activity), lastActivityDateUtc: date(row.last_activity), missingUserReport: exactCount(row.user_rows) === 0,
    hasReportMismatch: exactCount(row.user_rows) > 0 && exactCount(row.relationship_count) > 0 && (row.responses !== row.bridge_responses || row.agents_used !== row.relationship_count),
    reviewCohort: row.review_cohort, hasActivity: row.has_activity };
  if (endpoint === "official_agents") return { agentId: row.agent_id, agentName: row.name ?? row.agent_id, creatorType: row.creator_type ?? "",
    responses: exactCount(row.responses), responseSource: row.response_source, activeUsers: nullableCount(row.active_users),
    activeUsersBasis: row.active_users === null ? "unknown" : "userAgents_distinct_identity", licensedUserOccurrences: nullableCount(row.licensed_users),
    unlicensedUserOccurrences: nullableCount(row.unlicensed_users), lastActivityDateUtc: date(row.last_activity),
    reportResponses: nullableCount(row.report_responses), bridgeResponses: nullableCount(row.bridge_responses), relationshipCount: exactCount(row.relationship_count),
    responseComparison: row.report_responses === null || row.bridge_responses === null ? "not_comparable" : row.report_responses === row.bridge_responses ? "matching" : "mismatch",
    identityStatus: "unresolved" };
  if (endpoint === "relationships") return { id: row.identity, agentId: row.agent_id, agentName: row.name ?? row.agent_id, creatorType: row.creator_type ?? "",
    username: row.username, responses: exactCount(row.responses), lastActivityDateUtc: date(row.last_activity), identityStatus: "unresolved" };
  if (endpoint === "history") return { id: row.id, bundleId: row.bundle_id, contentHash: row.content_hash, reportingStart: date(row.reporting_start),
    reportingEnd: date(row.reporting_end), periodProvenance: row.period_provenance, supersedesSetId: row.supersedes_set_id,
    acceptedAt: row.accepted_at.toISOString(), visibility: row.visibility, active: row.active };
  if (endpoint === "overview") return { agentId: row.agent_id, agentName: row.name ?? row.agent_id, observationCount: exactCount(row.observation_count),
    hasResponses: row.has_responses, earliestActivityDateUtc: date(row.earliest_activity), lastActivityDateUtc: date(row.last_activity), active30Days: row.active,
    creatorTypeCount: exactCount(row.creator_type_count), latestSetId: row.latest_set_id, latestAcceptedAt: row.latest_accepted_at.toISOString() };
  if (endpoint === "plans") return { servicePlanId: row.plan_id, service: row.service, displayName: row.name, state: row.state,
    capabilityStatus: row.capability_status, assignedDateTime: row.assigned_at };
  if (endpoint === "observations") return { versionId: row.identity, kind: row.kind, contentHash: row.content_hash, rowCount: row.row_count,
    acceptedAt: row.accepted_at.toISOString(), sourceAsOf: row.source_as_of?.toISOString() ?? null, sourceAsOfProvenance: row.source_as_of_provenance,
    sourceFreshness: row.source_freshness, supersedesVersionId: row.supersedes_version_id };
  return { username: row.username, reason: row.reason, responses: nullableCount(row.responses), hasActivity: row.has_activity };
}
