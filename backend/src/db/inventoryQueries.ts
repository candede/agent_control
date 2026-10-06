import type pg from "pg";
import { DataSelections, CursorCodec, SelectionError, type SelectionIdentity, type DependencyRoot } from "../services/dataSelections.js";
import { LargeTenantUsersReports, type ReportCurrentData } from "../services/largeTenantUsersReports.js";
import { officialAgentsSql } from "./officialReportQueries.js";
import { userSourcePeopleInRead } from "./userSources.js";
import { dataLimitError, digest, encodeBatch, exactCount } from "./dataBounds.js";
import { inventoryAsOf } from "./inventoryGenerations.js";
import { parseUnifiedAgentRecordId, unifiedAgentSortKeys, type UnifiedAgentInventoryQuery,
  type SavedAgentEnvironment, type SavedAgentPerson } from "../types/unifiedAgents.js";
import { normalizePackageAuthoringTool, packageStatusAliases } from "../types/copilotPackage.js";
import { AppError } from "../errors.js";
import { readInventoryResponsibility } from "./inventoryResponsibility.js";
import type { AgentResponsibilityQuery } from "../types/agentResponsibility.js";
import { currentInventorySourcesSql, lockInventorySelection } from "./inventoryAuthority.js";
import { decodeInventoryFacet, encodeInventoryFacet } from "../types/inventoryFacets.js";
import { inventoryNativeRootChoicesSql } from "./inventoryInputScopes.js";
import { pendingInventoryIdentityExpirySql } from "./inventoryIdentityExpiry.js";
import { projectPackageDetailAge } from "../services/packageDetailProjection.js";
import { peakCheckpoint } from "../services/peakMemory.js";

export type InventoryQuery = Omit<UnifiedAgentInventoryQuery, "limit" | "selectionId" | "cursor">;
const queryFields = ["inventoryScope", "type", "view", "endUserAccess", "reportedUsage", "management", "relevance", "recordId",
  "operationIdPrefix", "search", "source", "linkState", "environmentId", "blocked", "publisher", "availableTo", "host", "platform",
  "createdWithinDays", "sortBy", "sortDirection"] as const;
const numericSorts = new Set(["createdAt", "lastModifiedAt", "lastPublishedAt", "observedAt", "responses", "activeUsers", "lastActivity"]);
const unfilteredOrdering = (query: InventoryQuery, source: string) => Object.entries(query).every(([key,value]) =>
  ["sortBy","sortDirection"].includes(key)
  || ["inventoryScope","view","source"].includes(key) && value==="all"
  || key==="inventoryScope" && (source==="inventory_packages" && value==="catalog"
    || source==="inventory_power_platform" && value==="power_platform_only"));
function inventoryCriteria(input: Record<string, unknown>) {
  const entries = Object.keys(input).sort().map(key => {
    const value = input[key];
    if (!queryFields.includes(key as typeof queryFields[number])
      || value !== null && typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number"
      || typeof value === "number" && !Number.isFinite(value)) throw new SelectionError("invalid_cursor");
    return [key, value] as const;
  });
  const values = Object.fromEntries(entries);
  const bytes = Buffer.byteLength(JSON.stringify(values));
  if (bytes > 32768) throw dataLimitError("inventory_query_bytes", 32768, bytes);
  return values;
}
const assignedAccessSql = `regexp_replace(lower(x.value),'[^a-z0-9]','','g') IN (${[
  ...packageStatusAliases.all, ...packageStatusAliases.some,
].map(value => `'${value}'`).join(",")})`;
type Context = { data: ReportCurrentData; selectionId: string;expiresAt: number;scopeId: string; baselineId: string; revision: string; source: string;
  tokenMode: "delegated" | "application"; query: InventoryQuery };
type PageOptions = { limit?: number; cursor?: string; recordId?: string; expectedQuery?: InventoryQuery; explicitExportId?: string;
  exportKind?: "unified_agents" | "graph_packages" | "power_platform_agents" };
const primaryMembersSql = `SELECT f.identity,member.identity AS source_identity,member.domain,member.native_id,member.environment_id,member.scope_id,
  member.residual,member.observed_at,member.expires_at,member.generation_id,member.catalog_generation,member.detail_generation,
  member.evidence,member.total,
  (SELECT channel FROM inventory_attempts attempt WHERE attempt.generation_id=coalesce(member.catalog_generation,member.generation_id)) AS source_channel,
  CASE WHEN member.domain='power_platform' THEN
    (SELECT count(*)::int FROM inventory_facts identifier WHERE identifier.generation_id=member.generation_id
      AND identifier.identity=member.identity AND identifier.kind='identifier') END AS identifier_count,
  CASE WHEN member.domain='power_platform' THEN
    (SELECT CASE WHEN bool_or(detail.kind='collection') THEN jsonb_build_object(
      'connectors',count(*) FILTER(WHERE detail.kind='detail:connectors'),
      'operations',count(*) FILTER(WHERE detail.kind='connectorOperation')) END
    FROM inventory_facts detail WHERE detail.generation_id=member.generation_id AND detail.identity=member.identity
      AND (detail.kind IN ('detail:connectors','connectorOperation') OR detail.kind='collection' AND detail.value='detail:connectors')) END AS connector_counts,
  CASE WHEN member.domain='power_platform' THEN coalesce((SELECT jsonb_agg(payload ORDER BY ordinal) FROM (
    SELECT payload,ordinal,sum(octet_length(payload::text)) OVER(ORDER BY ordinal) AS bytes FROM (
      SELECT identifier.payload,identifier.ordinal FROM inventory_facts identifier
      WHERE identifier.generation_id=member.generation_id AND identifier.identity=member.identity AND identifier.kind='identifier'
      ORDER BY ordinal LIMIT 4) candidates) identifiers WHERE bytes<=4096),'[]'::jsonb) END AS identifiers,
  CASE WHEN member.domain='power_platform' THEN
    (SELECT control.payload FROM inventory_facts control WHERE control.generation_id=f.generation_id AND control.identity=f.identity
      AND control.kind='control:quarantine' AND control.value=member.native_id LIMIT 1) END AS quarantine_identity
  FROM (
    SELECT source.*,membership.evidence,count(*) OVER(PARTITION BY source.domain)::text AS total,
      row_number() OVER(PARTITION BY source.domain ORDER BY source.identity COLLATE "C") AS ordinal
    FROM unified_agent_memberships membership JOIN inventory_records source
      ON source.generation_id=membership.source_generation_id AND source.identity=membership.source_identity
    WHERE membership.generation_id=f.generation_id AND membership.identity=f.identity
  ) member WHERE member.ordinal=1`;

type InventorySummaryCache = Map<string,{ expiresAt: number;row: pg.QueryResultRow;verificationCounts: pg.QueryResultRow }>;
const summaryCaches = new WeakMap<pg.Pool,InventorySummaryCache>();

export class InventoryQueries {
  private readonly summaryCache: InventorySummaryCache;
  readonly reports: LargeTenantUsersReports;
  readonly selections: DataSelections;
  readonly cursors: CursorCodec;
  constructor(readonly database: pg.Pool, secret: string, reportStaleDays = 7,
    private readonly authorizedApplicationScope?: { tenantId: string; principalId: string },
    private readonly requiredSource?: { source: string; tokenMode: "delegated" | "application" }) {
    this.summaryCache = summaryCaches.get(database) ?? new Map();
    summaryCaches.set(database,this.summaryCache);
    this.reports = new LargeTenantUsersReports(database, secret, reportStaleDays);
    this.selections = new DataSelections(database, (client, root, identity) => root.kind === "inventory_delta"
      ? this.validateRoot(client, root, identity)
      : root.kind === "tenant_history" ? this.reports.history.validateRoot(client, root, identity)
        : this.reports.sources.validateRoot(client, root, identity),
    (scope, identity) => scope.tenant_id === identity.tenantId && scope.tenant_id === this.authorizedApplicationScope?.tenantId
      && scope.principal_id === this.authorizedApplicationScope?.principalId && scope.token_mode === "application"
      && scope.source === "inventory_packages");
    this.cursors = new CursorCodec(secret);
  }
  async validateRoot(client: pg.PoolClient, root: DependencyRoot, identity: SelectionIdentity) {
    if (root.kind !== "inventory_delta") throw new SelectionError("selection_invalidated");
    const revision = (await client.query(`SELECT v.inputs FROM inventory_revisions v JOIN inventory_roots r ON r.baseline_id=v.baseline_id
      JOIN data_generations g ON g.id=v.generation_id JOIN data_scope_epochs s ON s.id=v.scope_id
      JOIN data_generations anchor ON anchor.id=v.baseline_id
      WHERE v.scope_id=$1 AND v.revision=$2 AND v.baseline_id=$3 AND v.tenant_id=$4 AND r.collected_before<=$2
        AND s.principal_id=ANY($5::text[]) AND g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch
        AND (s.token_mode<>'application' OR s.source='inventory_packages' AND s.principal_id=$7
          AND EXISTS(SELECT 1 FROM capability_configuration c WHERE c.tenant_id=s.tenant_id
            AND c.capability_id='graph.package.read.application' AND c.enabled AND c.shared_data_scope))
        AND g.state IN ('published','retired') AND g.validated AND g.expires_at>= $6 AND g.expires_at>clock_timestamp()
        AND anchor.state IN ('published','retired')`,
    [root.scopeId, root.revision, root.generationId, identity.tenantId, this.sourceOwners(identity), root.expiresAt,
      this.authorizedApplicationScope?.tenantId === identity.tenantId ? this.authorizedApplicationScope.principalId : ""])).rows[0];
    if (!revision) throw new SelectionError("selection_invalidated");
    const invalid = await client.query(`SELECT 1 FROM jsonb_to_recordset($1::jsonb) r("scopeId" uuid,"baselineId" uuid,epoch bigint,"expiresAt" timestamptz)
      LEFT JOIN data_scope_epochs s ON s.id=r."scopeId" LEFT JOIN data_generations g ON g.id=r."baselineId"
      WHERE s.epoch IS DISTINCT FROM r.epoch OR s.tenant_id<>$2 OR NOT(s.principal_id=ANY($3::text[]))
        OR r."expiresAt"<=clock_timestamp() OR g.state NOT IN ('published','retired') LIMIT 1`, [JSON.stringify(revision.inputs), identity.tenantId, this.sourceOwners(identity)]);
    if (invalid.rowCount) throw new SelectionError("selection_invalidated");
  }

  async capture(identity: SelectionIdentity, scopeId: string, query: InventoryQuery = {}, tokenMode: "delegated" | "application" = "delegated") {
    if (query.sortBy && !unifiedAgentSortKeys.includes(query.sortBy) || query.sortDirection && !["asc", "desc"].includes(query.sortDirection)
      || query.createdWithinDays !== undefined && (!Number.isInteger(query.createdWithinDays) || query.createdWithinDays < 0)) throw new SelectionError("invalid_cursor");
    const sourceScope = await this.reports.sources.ensureScope(identity, "delegated");
    await this.reports.history.ensure(identity.tenantId);
    const criteria = inventoryCriteria(query.availableTo === undefined ? query : { ...query, availableTo: encodeInventoryFacet(query.availableTo) });
    const metadata = { inventoryQuery: digest(JSON.stringify(criteria)),
      ...query.operationIdPrefix === undefined ? {} : { operationIdPrefix: query.operationIdPrefix } };
    return this.selections.captureWith(identity, "inventory", { values: metadata, allowed: ["inventoryQuery", "operationIdPrefix"] }, async (client, at) => {
      const root = (await client.query(`SELECT r.*,g.expires_at,s.epoch FROM inventory_roots r
        JOIN inventory_revisions v ON v.scope_id=r.scope_id AND v.revision=r.revision
        JOIN data_generations g ON g.id=v.generation_id JOIN data_scope_epochs s ON s.id=r.scope_id
        WHERE r.scope_id=$1 AND r.current AND r.tenant_id=$2 AND s.principal_id=ANY($3::text[]) AND s.token_mode=$4`,
      [scopeId, identity.tenantId, this.sourceOwners(identity), tokenMode])).rows[0];
      if (!root) throw new SelectionError("selection_invalidated");
      const data = await this.reports.currentInventoryData(client, identity, at);
      const epoch = (await client.query("SELECT epoch FROM data_scope_epochs WHERE id=$1", [sourceScope])).rows[0].epoch;
      const association = (await client.query("SELECT inventory_association_revision($1)::text AS revision", [identity.tenantId])).rows[0]?.revision ?? "0";
      const roots: DependencyRoot[] = [{ kind: "inventory_delta", scopeId, generationId: root.baseline_id, revision: root.revision, expiresAt: root.expires_at },
        await this.reports.history.root(client, identity.tenantId, at),
        { kind: "user_sources", scopeId: sourceScope, revision: epoch, expiresAt: new Date(at.getTime() + 600_000) }];
      const inputs = (await client.query("SELECT inputs FROM inventory_revisions WHERE scope_id=$1 AND revision=$2", [scopeId, root.revision])).rows[0]?.inputs ?? [];
      for (const input of inputs) roots.push({ kind: "inventory_delta", scopeId: input.scopeId, generationId: input.baselineId,
        revision: input.revision, expiresAt: new Date(input.expiresAt) });
      for (const metadata of Object.values(data.metadata)) if (metadata.generationId) roots.push({
        kind: "generation", scopeId: metadata.scopeId!, generationId: metadata.generationId,
        revision: metadata.revision!, expiresAt: new Date(metadata.expiresAt!),
      });
      const transition = (await client.query(`SELECT least(min(r.expires_at),
        (SELECT min(expires_at) FROM agent_people_cache WHERE tenant_id=$4 AND principal_id=$5 AND expires_at>$3)) AS expires_at FROM inventory_memberships m
        JOIN inventory_records r ON r.generation_id=m.generation_id AND r.identity=m.identity
        WHERE ${inventoryAsOf()} AND r.expires_at>$3`, [root.baseline_id, root.revision, at, identity.tenantId, identity.principalId])).rows[0]?.expires_at;
      return { roots, nextTransition: transition ?? undefined, persist: async (connection, selection) => {
        await connection.query(`INSERT INTO inventory_read_contexts(selection_id,tenant_id,report_context,association_revision,root_scope_id,query_values)
          VALUES($1,$2,$3::jsonb,$4,$5,$6::jsonb)`, [selection.id, identity.tenantId, JSON.stringify(data), association, scopeId, JSON.stringify(criteria)]);
      } };
    });
  }

  private read<T>(id: string, identity: SelectionIdentity, work: (client: pg.PoolClient, context: Context, selection: Record<string, unknown>) => Promise<T>) {
    return this.selections.read(id, identity, async (client, selected) => {
      await client.query("SELECT set_config('jit','off',true)");
      const context = await this.contextFromSelected(client, id, identity, selected);
      const result = await work(client, context, selected.selection);
      peakCheckpoint("response.serialize");
      const serialized = JSON.stringify(result);
      peakCheckpoint("response.serialize");
      if (Buffer.byteLength(serialized) > 1_048_576) throw dataLimitError("data_response_bytes", 1_048_576, Buffer.byteLength(serialized));
      return result;
    });
  }

  async contextInRead(client: pg.PoolClient, id: string, identity: SelectionIdentity, exportId?: string) {
    await client.query("SELECT set_config('jit','off',true)");
    const selected = await this.selections.assert(client, id, identity, exportId);
    return { context: await this.contextFromSelected(client, id, identity, selected), selection: selected.selection };
  }

  private async contextFromSelected(client: pg.PoolClient, id: string, identity: SelectionIdentity,
    selected: Awaited<ReturnType<DataSelections["assert"]>>): Promise<Context> {
    const saved = (await client.query(`SELECT c.*,s.source,s.token_mode FROM inventory_read_contexts c
      JOIN data_scope_epochs s ON s.id=c.root_scope_id WHERE c.selection_id=$1 AND c.tenant_id=$2`, [id, identity.tenantId])).rows[0];
    const association = (await client.query("SELECT inventory_association_revision($1)::text AS revision", [identity.tenantId])).rows[0]?.revision ?? "0";
    if (!saved || saved.association_revision !== association) throw new SelectionError("selection_invalidated");
    const pin = selected.pins.find(pin => pin.scope_id === saved.root_scope_id);
    if (!pin) throw new SelectionError("selection_invalidated");
    if (!["inventory_canonical", "inventory_packages", "inventory_power_platform"].includes(saved.source)
      || this.requiredSource && (saved.source !== this.requiredSource.source || saved.token_mode !== this.requiredSource.tokenMode)) throw new SelectionError("invalid_cursor");
    const data = saved.report_context as ReportCurrentData;
    data.evaluatedAt = selected.selection.evaluated_at;
    const criteria = inventoryCriteria(saved.query_values);
    if (selected.selection.query_json.inventoryQuery !== digest(JSON.stringify(criteria))
      || selected.selection.query_json.operationIdPrefix !== criteria.operationIdPrefix) throw new SelectionError("invalid_cursor");
    const query = criteria.availableTo === undefined ? criteria
      : { ...criteria, availableTo: decodeInventoryFacet(String(criteria.availableTo)) };
    return { data,selectionId: id,expiresAt: new Date(selected.selection.expires_at).getTime(),
      scopeId: saved.root_scope_id, baselineId: pin.generation_id, revision: pin.revision,
      source: saved.source, tokenMode: saved.token_mode, query: query as InventoryQuery };
  }

  private sourceOwners(identity: Pick<SelectionIdentity, "tenantId" | "principalId">) {
    return this.authorizedApplicationScope?.tenantId === identity.tenantId
      ? [identity.principalId, this.authorizedApplicationScope.principalId] : [identity.principalId];
  }

  private relation(context: Context, identities?: string[]) {
    const values: unknown[] = [...this.reports.parameters(context.data), context.baselineId, context.revision, context.data.evaluatedAt,
      context.data.identity.principalId, this.sourceOwners(context.data.identity),context.scopeId];
    const domain = context.source === "inventory_packages" ? "packages"
      : context.source === "inventory_power_platform" ? "power_platform" : "canonical";
    if (identities) values.push(identities);
    const sql = `WITH report_binding AS (SELECT $2::uuid AS activity_generation,$3::boolean AS activity_fresh,
      $6::bigint AS low_activity_threshold), inventory AS ${identities ? "" : "NOT "}MATERIALIZED (
      SELECT r.* FROM inventory_memberships m ${identities ? `CROSS JOIN LATERAL (
        SELECT record.* FROM inventory_records record WHERE record.generation_id=m.generation_id AND record.identity=m.identity
          AND record.scope_id=$12 AND record.domain='${domain}' AND record.expires_at>$9 OFFSET 0
      ) r` : "JOIN inventory_records r ON r.generation_id=m.generation_id AND r.identity=m.identity"}
      JOIN data_scope_epochs scope ON scope.id=r.scope_id
      WHERE ${inventoryAsOf("m", "$7", "$8")} AND scope.principal_id=ANY($11::text[]) AND r.expires_at>$9
        AND r.scope_id=$12 AND r.domain='${domain}'
        ${identities ? "AND m.identity=ANY($13::text[]) AND r.identity=ANY($13::text[])" : ""}
    ), input_roots AS (
      SELECT r."baselineId" AS baseline_id,r.revision FROM inventory_revisions v
        CROSS JOIN LATERAL jsonb_to_recordset(v.inputs) r("baselineId" uuid,revision bigint) WHERE v.scope_id=(SELECT scope_id FROM inventory_roots WHERE baseline_id=$7) AND v.revision=$8
      UNION SELECT $7::uuid,$8::bigint
    ), native_roots AS (${inventoryNativeRootChoicesSql("input_roots")}), environments AS (
      SELECT lower(r.native_id) AS environment_id,CASE WHEN count(DISTINCT r.display_name)=1 THEN min(r.display_name) ELSE min(r.native_id) END AS label
      FROM native_roots root JOIN inventory_memberships m ON m.baseline_id=root.baseline_id
        AND m.valid_from_revision<=root.revision AND (m.valid_to_revision IS NULL OR m.valid_to_revision>root.revision)
      JOIN power_platform_record_rows r ON r.generation_id=m.generation_id AND r.identity=m.identity
      WHERE root.kind='microsoft.powerplatform/environments' AND r.resource_type=root.kind GROUP BY lower(r.native_id)
    ), people_evidence AS (
      SELECT x.generation_id,x.identity,x.kind,x.value AS object_id,
        CASE WHEN c.checked_at IS NULL OR d.identity IS NOT NULL AND (g.observed_at>c.checked_at
          OR c.status='lookup_failed' AND (c.resolved_at IS NULL OR g.observed_at>c.resolved_at))
          THEN nullif(d.display_name,'') ELSE nullif(c.display_name,'') END AS name,
        CASE WHEN c.checked_at IS NULL OR d.identity IS NOT NULL AND (g.observed_at>c.checked_at
          OR c.status='lookup_failed' AND (c.resolved_at IS NULL OR g.observed_at>c.resolved_at))
          THEN nullif(d.upn,'') ELSE nullif(c.user_principal_name,'') END AS upn,
        CASE WHEN d.identity IS NOT NULL AND g.observed_at>c.checked_at THEN NULL ELSE c.status END AS status
      FROM inventory i JOIN inventory_facts x ON x.generation_id=i.generation_id AND x.identity=i.identity
        AND x.kind IN ('person:owner','person:createdBy','person:lastModifiedBy')
      LEFT JOIN LATERAL (SELECT d.identity,d.display_name,d.upn FROM directory_user_rows d
        WHERE d.generation_id=$1 AND d.identity=x.value OFFSET 0) d ON true
      LEFT JOIN data_generations g ON g.id=$1
      LEFT JOIN agent_people_cache c ON c.tenant_id=$4 AND c.principal_id=$10 AND c.object_id::text=x.value AND c.expires_at>$9
    ), people AS NOT MATERIALIZED (
      SELECT *,CASE WHEN status='not_found' THEN object_id||' (not found)'
        ELSE coalesce(CASE WHEN name IS NOT NULL AND upn IS NOT NULL THEN name||' ('||upn||')' ELSE coalesce(name,upn) END,object_id)
          ||CASE WHEN status='lookup_failed' THEN ' (lookup failed)' ELSE '' END END AS label FROM people_evidence
    ), sources AS (
      SELECT i.identity AS canonical_id,r.generation_id,r.identity,r.domain,r.resource_type,r.native_id,r.environment_id,r.observed_at,r.availability,
        CASE WHEN r.domain='packages' THEN 'graph_packages' ELSE 'power_platform' END AS source
      FROM inventory i ${identities ? `CROSS JOIN LATERAL (
        SELECT source_generation_id,source_identity FROM unified_agent_memberships
        WHERE generation_id=i.generation_id AND identity=i.identity OFFSET 0) s
      CROSS JOIN LATERAL (SELECT * FROM inventory_records
        WHERE generation_id=s.source_generation_id AND identity=s.source_identity OFFSET 0) r`
      : `JOIN unified_agent_memberships s ON s.generation_id=i.generation_id AND s.identity=i.identity
      JOIN inventory_records r ON r.generation_id=s.source_generation_id AND r.identity=s.source_identity`}
      WHERE i.domain='canonical'
      UNION ALL SELECT i.identity,i.generation_id,i.identity,i.domain,i.resource_type,i.native_id,i.environment_id,i.observed_at,i.availability,
        CASE WHEN i.domain='packages' THEN 'graph_packages' ELSE 'power_platform' END
      FROM inventory i WHERE i.domain<>'canonical'
    ), source_links AS MATERIALIZED (
      SELECT s.canonical_id,reviewed.report_agent_id AS agent_id FROM sources s JOIN agent_usage_associations reviewed
        ON reviewed.tenant_id=$4 AND reviewed.report_set_id=$5 AND reviewed.source=s.source
        AND reviewed.normalized_native_id=CASE WHEN s.source='power_platform' AND s.native_id ~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
          THEN lower(s.native_id) ELSE s.native_id END
        AND reviewed.normalized_environment_id=CASE WHEN s.source='graph_packages' THEN '' ELSE coalesce(lower(s.environment_id),'') END
      WHERE $5::uuid IS NOT NULL
      UNION
      SELECT s.canonical_id,s.native_id FROM sources s WHERE s.source='graph_packages' AND $5::uuid IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM agent_usage_associations reviewed WHERE reviewed.tenant_id=$4
          AND reviewed.report_set_id=$5 AND reviewed.report_agent_id=s.native_id)
    ), agent_headers AS MATERIALIZED (
      ${identities ? `SELECT header.agent_id FROM (SELECT DISTINCT agent_id FROM source_links) wanted
      CROSS JOIN LATERAL (
        SELECT f.agent_id FROM official_usage_row_facts f
        JOIN official_usage_version_rows r ON r.tenant_id=f.tenant_id AND r.kind=f.kind AND r.payload_hash=f.payload_hash
        JOIN official_usage_set_versions m ON m.tenant_id=r.tenant_id AND m.kind=r.kind AND m.version_id=r.version_id
        WHERE f.tenant_id=$4 AND f.kind='agents' AND f.agent_id=wanted.agent_id
          AND m.tenant_id=$4 AND m.set_id=$5 LIMIT 1 OFFSET 0
      ) header` : `SELECT f.agent_id FROM official_usage_set_versions m
      JOIN official_usage_version_rows r ON r.version_id=m.version_id AND r.tenant_id=m.tenant_id AND r.kind=m.kind
      JOIN official_usage_row_facts f ON f.tenant_id=r.tenant_id AND f.kind=r.kind AND f.payload_hash=r.payload_hash
      WHERE m.tenant_id=$4 AND m.set_id=$5 AND m.kind='agents'`}
    ), linked AS MATERIALIZED (
      SELECT DISTINCT s.canonical_id,s.agent_id FROM source_links s JOIN agent_headers a ON a.agent_id=s.agent_id
    ), linked_agents AS (SELECT DISTINCT agent_id FROM linked), reports AS MATERIALIZED (
      SELECT f.kind,f.agent_id,f.username,f.agent_name,f.creator_type,f.responses,f.licensed_users,f.unlicensed_users,f.last_activity
      FROM linked_agents linked CROSS JOIN LATERAL (
        SELECT fact.kind,fact.agent_id,fact.username,fact.agent_name,fact.creator_type,fact.responses,
          fact.licensed_users,fact.unlicensed_users,fact.last_activity FROM official_usage_row_facts fact
        JOIN official_usage_version_rows r ON r.tenant_id=fact.tenant_id AND r.kind=fact.kind AND r.payload_hash=fact.payload_hash
        JOIN official_usage_set_versions m ON m.version_id=r.version_id AND m.tenant_id=r.tenant_id AND m.kind=r.kind
        WHERE fact.tenant_id=$4 AND fact.kind IN ('agents','userAgents')
          AND fact.agent_id=linked.agent_id AND m.set_id=$5 AND m.tenant_id=$4 OFFSET 0
      ) f WHERE EXISTS(SELECT 1 FROM linked)
    ), official_agents AS (${officialAgentsSql}
    ), metrics AS (
      SELECT l.canonical_id,count(*)::int AS association_count,sum(a.responses) AS responses,max(a.last_activity) AS last_activity,
        CASE WHEN bool_or(a.active_users IS NULL) THEN NULL ELSE
          (SELECT count(DISTINCT f.username) FROM linked other JOIN reports f ON f.agent_id=other.agent_id
            AND f.kind='userAgents' AND f.responses>0 WHERE other.canonical_id=l.canonical_id) END AS active_users
      FROM linked l JOIN official_agents a ON a.agent_id=l.agent_id GROUP BY l.canonical_id
    ), facts AS ${identities ? "" : "NOT "}MATERIALIZED (
      SELECT i.*,metrics.responses,metrics.active_users,coalesce(metrics.association_count,0) AS association_count,
        extract(epoch FROM metrics.last_activity)*1000 AS last_activity,
        coalesce(environments.label,i.environment_id) AS environment_label,
        (SELECT text_value FROM inventory_facts f WHERE f.generation_id=i.generation_id AND f.identity=i.identity AND f.kind='column:createdAt' LIMIT 1) AS created_text
      FROM inventory i LEFT JOIN metrics ON metrics.canonical_id=i.identity LEFT JOIN environments ON environments.environment_id=lower(i.environment_id)
    )`;
    return { sql, values };
  }

  private filter(query: InventoryQuery, values: unknown[], omit?: string, scopeOnly = false) {
    const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
    const clauses = ["true"];
    const fact = (kind: string, value: unknown) => `EXISTS(SELECT 1 FROM inventory_facts x WHERE x.generation_id=f.generation_id AND x.identity=f.identity AND x.kind='${kind}' AND x.value=${add(value)})`;
    if (query.inventoryScope === "catalog") clauses.push("f.presence IN ('both','graph_packages')");
    if (query.inventoryScope === "power_platform_only") clauses.push("f.presence='power_platform'");
    if (scopeOnly) return clauses.join(" AND ");
    for (const field of ["type", "publisher", "host", "platform", "blocked"] as const) {
      if (query[field] !== undefined && field !== omit) clauses.push(fact(field, query[field] === null ? ""
        : field === "platform" ? normalizePackageAuthoringTool(String(query[field])) : String(query[field])));
    }
    if (query.availableTo !== undefined && omit !== "availableTo") {
      const value = query.availableTo;
      clauses.push(value !== null && typeof value === "object" && value.kind === "some-or-all" ? `EXISTS(SELECT 1 FROM inventory_facts x
        WHERE x.generation_id=f.generation_id AND x.identity=f.identity AND x.kind='availableTo' AND ${assignedAccessSql})`
        : fact("availableTo", value ?? ""));
    }

    if (query.environmentId !== undefined && omit !== "environmentId") clauses.push(query.environmentId === null
      ? "coalesce(f.environment_id,'')=''" : `lower(f.environment_id)=lower(${add(query.environmentId)})`);
    if (query.linkState && omit !== "linkState") clauses.push(`f.link_state=${add(query.linkState)}`);
    if (query.source && query.source !== "all" && omit !== "source") clauses.push(query.source === "both" ? "f.presence='both'" : `f.presence IN ('both',${add(query.source)})`);
    if (query.endUserAccess && query.endUserAccess !== "all") clauses.push(`f.availability=${add(query.endUserAccess)}`);
    if (query.management && query.management !== "all") clauses.push(`f.management=${add(query.management)}`);
    if (query.reportedUsage === "used" || query.view === "used") clauses.push("f.responses>0");
    for (const relevance of [query.relevance, query.view].filter(value => value === "organization" || value === "unknown")) {
      const positive = relevance === "organization";
      clauses.push(`${positive ? "" : "NOT "}(coalesce(f.responses>0,false) OR EXISTS(SELECT 1 FROM inventory_facts x WHERE x.generation_id=f.generation_id AND x.identity=f.identity AND x.kind='relevance'))`);
    }
    if (query.view === "user_managed" || query.view === "organization_managed") clauses.push(`f.management=${add(query.view)}`);
    else if (query.view === "available" || query.view === "unavailable" || query.view === "availability_unknown") {
      clauses.push(`f.availability=${add(query.view === "availability_unknown" ? "unknown" : query.view)}`);
    } else if (query.view && !["all", "used", "organization", "unknown"].includes(query.view)) clauses.push(
      `EXISTS(SELECT 1 FROM inventory_facts x WHERE x.generation_id=f.generation_id AND x.identity=f.identity AND x.kind='view' AND x.value=${add(query.view)} AND x.boolean_value)`);
    if (query.search) {
      const search = add(`%${query.search.normalize("NFKC").toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
      clauses.push(`(f.sort_key LIKE ${search} OR lower(coalesce(f.environment_id,'')) LIKE ${search} OR lower(coalesce(f.environment_label,'')) LIKE ${search}
        OR EXISTS(SELECT 1 FROM inventory_facts x WHERE x.generation_id=f.generation_id AND x.identity=f.identity
          AND x.kind IN ('search','publisher','person:owner','person:createdBy','person:lastModifiedBy') AND lower(x.value) LIKE ${search})
        OR EXISTS(SELECT 1 FROM people p WHERE p.generation_id=f.generation_id AND p.identity=f.identity AND lower(p.label) LIKE ${search}))`);
    }
    if (query.createdWithinDays !== undefined) clauses.push(`EXISTS(SELECT 1 FROM inventory_facts x WHERE x.generation_id=f.generation_id
      AND x.identity=f.identity AND x.kind='created' AND x.number_value>=extract(epoch FROM $9::timestamptz)*1000-${add(query.createdWithinDays)}::numeric*86400000)`);
    if (query.recordId) {
      let target;
      try { target = parseUnifiedAgentRecordId(query.recordId); } catch { throw new SelectionError("invalid_cursor"); }
      if (!target) throw new SelectionError("invalid_cursor");
      if (target.source === "canonical") clauses.push(`f.identity=${add(target.agentId)}`);
      else if (target.source === "graph_packages") clauses.push(`EXISTS(SELECT 1 FROM sources s
        WHERE s.canonical_id=f.identity AND s.source='graph_packages' AND s.native_id=${add(target.packageId)})`);
      else clauses.push(`EXISTS(SELECT 1 FROM sources s WHERE s.canonical_id=f.identity AND s.source='power_platform'
        AND s.native_id=${add(target.nativeId)} AND coalesce(lower(s.environment_id),'')=lower(${add(target.environmentId ?? "")}))`);
    }
    if (query.operationIdPrefix) clauses.push(`EXISTS(SELECT 1 FROM sources s JOIN audit_events a ON a.tenant_id=$4
      AND a.principal_id=$10 AND a.agent_id=s.native_id AND a.scope='bulk'
      AND a.observed_at<=$9 AND a.observed_at>$9::timestamptz-interval '90 days'
      WHERE s.canonical_id=f.identity AND s.source='graph_packages' AND starts_with(lower(a.operation_id),lower(${add(query.operationIdPrefix)})))`);
    return clauses.join(" AND ");
  }

  resolveExportReferences(id: string, identity: SelectionIdentity, references: readonly string[]) {
    if (!references.length || references.length > 5000) throw new AppError(400, "invalid_export_selection", "Select 1–5000 exact references.");
    return this.read(id, identity, async (client, context) => {
      if (!(await client.query("SELECT 1 FROM data_scope_epochs WHERE id=$1 AND source='inventory_canonical' AND token_mode='delegated'",
        [context.scopeId])).rowCount) throw new AppError(400, "export_selection_kind", "Unified exports require a canonical selection.");
      const resolved = new Set<string>();
      for (let offset = 0; offset < references.length; offset += 100) {
        const requested = references.slice(offset, offset + 100).map((reference, ordinal) => {
          let target;
          try { target = parseUnifiedAgentRecordId(reference); } catch { /* Invalid references are rejected below. */ }
          if (!target) throw new AppError(400, "invalid_export_selection", "Use exact canonical or source-qualified references.");
          return { ordinal, source: target.source,
            native: target.source === "canonical" ? target.agentId : target.source === "graph_packages" ? target.packageId : target.nativeId,
            environment: target.source === "power_platform" ? target.environmentId ?? "" : "" };
        });
        const { sql, values } = this.relation(context);
        values.push(encodeBatch(requested).json);
        const result = await client.query(`${sql}
          SELECT r.ordinal,min(s.canonical_id) AS id,count(DISTINCT s.canonical_id)::int AS count
          FROM jsonb_to_recordset($${values.length}::jsonb) r(ordinal integer,source text,native text,environment text)
          LEFT JOIN sources s ON r.source='canonical' AND s.canonical_id=r.native OR r.source=s.source AND (
            r.source='graph_packages' AND s.native_id=r.native OR r.source='power_platform'
            AND CASE WHEN s.native_id ~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN lower(s.native_id)=lower(r.native) ELSE s.native_id=r.native END
            AND coalesce(lower(s.environment_id),'')=lower(r.environment))
          GROUP BY r.ordinal ORDER BY r.ordinal`, values);
        if (result.rows.length !== requested.length || result.rows.some(row => row.count !== 1)) {
          throw new AppError(409, "export_selection_changed", "An exact selected source is missing or ambiguous. Reload the inventory and review the selection.");
        }
        for (const row of result.rows) resolved.add(`agent:${row.id}`);
      }
      return [...resolved];
    });
  }

  page(id: string, identity: SelectionIdentity, options: PageOptions = {}) {
    return this.read(id, identity, (client, context, selection) => this.pageInRead(client, context, selection, id, identity, options));
  }

  private async namePageIds(client: pg.PoolClient, context: Context, limit: number, order: "ASC" | "DESC",
    anchorId?: string, exportKind?: PageOptions["exportKind"]) {
    const table = context.source==="inventory_packages" ? "package_record_rows"
      : context.source==="inventory_power_platform" ? "power_platform_record_rows" : "unified_agent_rows";
    const collation = context.source==="inventory_canonical" ? '"inventory_text_order"' : '"C"';
    const values: unknown[] = [context.scopeId,context.baselineId,context.revision,context.data.evaluatedAt,
      this.sourceOwners(context.data.identity),context.data.identity.tenantId];
    const exportDomain = exportKind==="graph_packages" ? "packages" : exportKind==="power_platform_agents" ? "power_platform" : undefined;
    const where = `r.scope_id=$1 AND r.expires_at>$4 AND scope.principal_id=ANY($5::text[]) AND scope.tenant_id=$6
      ${context.source==="inventory_power_platform" && exportKind==="power_platform_agents" ? "AND r.resource_type='microsoft.copilotstudio/agents'" : ""}
      ${context.source==="inventory_canonical" && exportDomain ? `AND EXISTS(
        SELECT 1 FROM unified_agent_memberships member CROSS JOIN LATERAL (
          SELECT domain,resource_type FROM inventory_records source
          WHERE source.generation_id=member.source_generation_id AND source.identity=member.source_identity OFFSET 0
        ) source WHERE member.generation_id=r.generation_id AND member.identity=r.identity
          AND source.domain='${exportDomain}'
          ${exportDomain==="power_platform" ? "AND source.resource_type='microsoft.copilotstudio/agents'" : ""}
        LIMIT 1 OFFSET 0)` : ""}
      AND EXISTS(SELECT 1 FROM inventory_memberships m WHERE m.baseline_id=$2 AND m.identity=r.identity
        AND m.generation_id=r.generation_id AND m.valid_from_revision<=$3
        AND (m.valid_to_revision IS NULL OR m.valid_to_revision>$3) LIMIT 1 OFFSET 0)`;
    if (anchorId!==undefined) {
      const rows = (await client.query(`SELECT r.identity,r.sort_key FROM ${table} r
        JOIN data_scope_epochs scope ON scope.id=r.scope_id WHERE ${where} AND r.identity=$7 LIMIT 2`,[...values,anchorId])).rows;
      if (rows.length!==1) throw new SelectionError("invalid_cursor");
      values.push(rows[0].sort_key,rows[0].identity);
    }
    const boundary = (key: string) => anchorId===undefined ? "" : `AND (${key} COLLATE ${collation},r.identity COLLATE "C")
      ${order==="ASC" ? ">" : "<"} ($7::text COLLATE ${collation},$8::text COLLATE "C")`;
    // Disjoint short/long partitions preserve the full collation order. Only
    // short keys equal their indexed prefix; long keys are never truncated.
    return (await client.query(`SELECT identity FROM (
      (SELECT r.identity,r.sort_key FROM ${table} r JOIN data_scope_epochs scope ON scope.id=r.scope_id
        WHERE ${where} AND length(r.sort_key)<=64 ${boundary("left(r.sort_key,64)")}
        ORDER BY left(r.sort_key,64) COLLATE ${collation} ${order},r.identity COLLATE "C" ${order} LIMIT ${limit})
      UNION ALL
      (SELECT r.identity,r.sort_key FROM ${table} r JOIN data_scope_epochs scope ON scope.id=r.scope_id
        WHERE ${where} AND length(r.sort_key)>64 ${boundary("r.sort_key")}
        ORDER BY r.sort_key COLLATE ${collation} ${order},r.identity COLLATE "C" ${order} LIMIT ${limit})
      ) bounded ORDER BY sort_key COLLATE ${collation} ${order},identity COLLATE "C" ${order} LIMIT ${limit}`,values)).rows
      .map(row => row.identity as string);
  }

  async pageInRead(client: pg.PoolClient, context: Context, selection: Record<string, unknown>, id: string, identity: SelectionIdentity,
    options: PageOptions = {}, exportSummary?: Awaited<ReturnType<InventoryQueries["summaries"]>>) {
      // Sparse union branches can make the planner materialize N rows inside an
      // N-row nested loop after ANALYZE. Keep broad page joins set-based.
      await client.query("SELECT set_config('enable_nestloop','off',true)");
      if (exportSummary && !options.exportKind) throw new Error("inventory_export_summary_scope");
      const byteBudget = options.exportKind ? 1_048_576 : 524_288;
      const limit = pageLimit(options.limit);
      for (const [field, value] of Object.entries(options.expectedQuery ?? {})) {
        if (JSON.stringify(context.query[field as keyof InventoryQuery]) !== JSON.stringify(value)) throw new SelectionError("invalid_cursor");
      }
      let { sql, values } = this.relation(context);
      const query = options.explicitExportId
        ? { sortBy: context.query.sortBy, sortDirection: context.query.sortDirection }
        : options.recordId ? { recordId: options.recordId, sortBy: context.query.sortBy, sortDirection: context.query.sortDirection } : context.query;
      let where = this.filter(query, values);
      if (options.exportKind === "unified_agents") where += " AND f.domain='canonical'";
      else if (options.exportKind) where += ` AND EXISTS(SELECT 1 FROM sources s WHERE s.canonical_id=f.identity
        AND ${options.exportKind === "graph_packages" ? "s.domain='packages'" : "s.domain='power_platform' AND s.resource_type='microsoft.copilotstudio/agents'"})`;
      if (options.explicitExportId) {
        values.push(options.explicitExportId);
        const domain = options.exportKind === "graph_packages" ? "packages"
          : options.exportKind === "power_platform_agents" ? "power_platform" : null;
        where += ` AND EXISTS(SELECT 1 FROM data_export_items e WHERE e.export_id=$${values.length}
          AND e.tenant_id=$4 AND ${domain ? `EXISTS(SELECT 1 FROM sources s WHERE s.canonical_id=f.identity
            AND s.domain='${domain}' AND s.native_id=e.identity)` : "e.identity='agent:'||f.identity"})`;
      }
      const sort = query.sortBy ?? "displayName";
      const numeric = numericSorts.has(sort);
      const collation = context.source === "inventory_canonical"
        ? sort === "versions" ? '"inventory_version_order"' : '"inventory_text_order"' : '"C"';
      const sortCollation = numeric ? "" : `COLLATE ${collation}`;
      const key = sort === "displayName" ? "f.sort_key" : sort === "responses" ? "f.responses" : sort === "activeUsers" ? "f.active_users"
        : sort === "observedAt" ? "extract(epoch FROM f.observed_at)*1000"
        : sort === "environment" ? "lower(normalize(f.environment_label,NFKC))"
        : ["owner", "createdBy"].includes(sort) ? `(SELECT lower(normalize(p.label,NFKC)) FROM people p WHERE p.generation_id=f.generation_id AND p.identity=f.identity AND p.kind='person:${sort}' LIMIT 1)`
        : sort === "lastActivity" ? "f.last_activity" : `(SELECT ${numeric ? "number_value" : "text_value"} FROM inventory_facts x
          WHERE x.generation_id=f.generation_id AND x.identity=f.identity AND x.kind='column:${sort}' LIMIT 1)`;
      const expected = { identity, endpoint: "inventory", selectionId: id, revision: String(selection.revision),
        queryHash: options.exportKind ? digest(`${selection.query_hash}:${options.explicitExportId ?? ""}:${options.exportKind}`) : String(selection.query_hash) };
      const cursor = options.cursor ? this.cursors.decode(options.cursor, expected) : undefined;
      const reverse = cursor?.direction === "previous";
      const desc = query.sortDirection === "desc";
      const order = desc !== reverse ? "DESC" : "ASC";
      const comparison = order === "ASC" ? ">" : "<";
      const cast = numeric ? "numeric" : `text COLLATE ${collation}`;
      const unknownColumns = JSON.stringify(Object.fromEntries(unifiedAgentSortKeys.map(key => [key, null]))).replaceAll("'", "''");
      const exportMatches = !options.exportKind || context.source==="inventory_canonical"
        || options.exportKind==="graph_packages" && context.source==="inventory_packages"
        || options.exportKind==="power_platform_agents" && context.source==="inventory_power_platform";
      const preselected = sort==="displayName" && unfilteredOrdering(query,context.source)
        && !options.explicitExportId && !options.recordId && (!cursor || cursor.boundary.key==="") && exportMatches;
      if (preselected) {
        if (cursor && cursor.boundary.nullRank!==0) throw new SelectionError("invalid_cursor");
        await client.query("SELECT set_config('enable_nestloop','on',true)");
        const ids = await this.namePageIds(client,context,limit+1,order,cursor?.boundary.id,options.exportKind);
        ({ sql,values } = this.relation(context,ids));
      }
      let boundary = "", anchor = "";
      if (cursor && !preselected) {
        if (cursor.boundary.key !== null && cursor.boundary.key !== "") throw new SelectionError("invalid_cursor");
        values.push(cursor.boundary.id);
        const n = values.length;
        anchor = `, anchor AS MATERIALIZED (
          SELECT identity,sort_key FROM matching WHERE ${cursor.boundary.key === ""
            ? "identity" : "encode(sha256(convert_to(identity,'UTF8')),'hex')"}=$${n})`;
        boundary = `AND EXISTS(SELECT 1 FROM anchor WHERE (
          (matching.sort_key IS NULL)::int ${reverse ? "<" : ">"} (anchor.sort_key IS NULL)::int OR
          (matching.sort_key IS NULL)::int=(anchor.sort_key IS NULL)::int AND (
            matching.sort_key::${cast} ${comparison} anchor.sort_key::${cast}
            OR matching.sort_key::${cast} IS NOT DISTINCT FROM anchor.sort_key::${cast}
              AND matching.identity COLLATE "C" ${comparison} anchor.identity COLLATE "C")) )`;
      }
      const rows = (await client.query(`${sql}, matching AS ${cursor?.boundary.key === null ? "" : "NOT "}MATERIALIZED (
          SELECT f.identity,f.generation_id,${key} AS sort_key FROM facts f WHERE ${where}
        )${anchor}, picked AS MATERIALIZED (
          SELECT * FROM matching WHERE true ${boundary}
          ORDER BY (sort_key IS NULL)::int ${reverse ? "DESC" : "ASC"},sort_key ${sortCollation} ${order},identity COLLATE "C" ${order} LIMIT ${limit + 1}
        ), candidates AS MATERIALIZED (
        SELECT f.identity,f.native_id,f.domain,f.resource_type,f.display_name,f.environment_id,f.presence,f.link_state,f.availability,f.management,
          jsonb_build_object('state',f.link_state,'reason',f.residual->'identity'->'reason') AS identity_info,
          CASE WHEN f.domain<>'canonical' THEN f.residual END AS source_residual,
          coalesce((SELECT jsonb_agg(to_jsonb(member_row) ORDER BY member_row.domain)
            FROM (${primaryMembersSql}) member_row),'[]'::jsonb) AS members,
          coalesce((SELECT max(octet_length(environment.residual::text))+2048
            FROM native_roots root JOIN inventory_memberships m ON m.baseline_id=root.baseline_id
              AND m.valid_from_revision<=root.revision AND (m.valid_to_revision IS NULL OR m.valid_to_revision>root.revision)
            JOIN power_platform_record_rows environment ON environment.generation_id=m.generation_id AND environment.identity=m.identity
            WHERE f.environment_id IS NOT NULL AND root.kind='microsoft.powerplatform/environments' AND environment.resource_type=root.kind
              AND lower(environment.native_id)=lower(f.environment_id)),0)+
          coalesce((SELECT sum(coalesce(octet_length(to_jsonb(p.name)::text),0)+coalesce(octet_length(to_jsonb(p.upn)::text),0)
            +octet_length(to_jsonb(p.object_id)::text)+1536) FROM people p
            WHERE p.generation_id=f.generation_id AND p.identity=f.identity),0) AS member_bytes,
          f.responses::text,f.active_users::text,f.last_activity::text,f.association_count,picked.sort_key,
          '${unknownColumns}'::jsonb || coalesce((SELECT jsonb_object_agg(substr(x.kind,8),coalesce(to_jsonb(x.text_value),to_jsonb(x.number_value)))
            FROM inventory_facts x WHERE x.generation_id=f.generation_id AND x.identity=f.identity AND x.kind LIKE 'column:%'),'{}'::jsonb)
          || jsonb_build_object('responses',f.responses,'activeUsers',f.active_users,'lastActivity',f.last_activity,'environment',f.environment_label,
            'observedAt',extract(epoch FROM f.observed_at)*1000,
            'owner',(SELECT p.label FROM people p WHERE p.generation_id=f.generation_id AND p.identity=f.identity AND p.kind='person:owner' LIMIT 1),
            'createdBy',(SELECT p.label FROM people p WHERE p.generation_id=f.generation_id AND p.identity=f.identity AND p.kind='person:createdBy' LIMIT 1)) AS columns
          FROM picked JOIN facts f ON f.generation_id=picked.generation_id AND f.identity=picked.identity),
        sized AS (SELECT *,count(*) OVER() AS candidate_count,
          row_number() OVER(ORDER BY (sort_key IS NULL)::int ${reverse ? "DESC" : "ASC"},sort_key ${sortCollation} ${order},identity COLLATE "C" ${order}) AS position,
          sum(octet_length(row_to_json(c)::text)+member_bytes) OVER(ORDER BY (sort_key IS NULL)::int ${reverse ? "DESC" : "ASC"},
          sort_key ${sortCollation} ${order},identity COLLATE "C" ${order}) AS bytes FROM candidates c)
        SELECT identity,native_id,domain,resource_type,source_residual,display_name,environment_id,presence,link_state,availability,management,identity_info,responses,active_users,last_activity,association_count,members,
          CASE WHEN bytes<=${byteBudget} THEN sort_key END AS sort_key,CASE WHEN bytes<=${byteBudget} THEN columns END AS columns,candidate_count,bytes
          FROM sized WHERE bytes<=${byteBudget} OR position=1 ORDER BY (sort_key IS NULL)::int ${reverse ? "DESC" : "ASC"},
          sort_key ${sortCollation} ${order},identity COLLATE "C" ${order}`, values)).rows;
      if (rows.length && exactCount(rows[0].bytes) > 524288) throw dataLimitError("inventory_page_record_bytes", 524288, exactCount(rows[0].bytes));
      const page = rows.slice(0, limit);
      if (reverse) page.reverse();
      await client.query("SELECT set_config('enable_nestloop','off',true)");
      const summary = exportSummary ?? await this.summaries(client, context);
      await client.query("SELECT set_config('enable_nestloop','on',true)");
      const enrichment = await this.pageEnrichment(client, context, page.map(row => row.identity));
      const sourceRows = page.flatMap(row => row.members as pg.QueryResultRow[]);
      for (const source of sourceRows) {
        source.observed_at = new Date(source.observed_at);
        source.expires_at = new Date(source.expires_at);
        if (source.domain === "packages") source.residual = projectPackageDetailAge(source.residual, context.data.evaluatedAt.getTime());
      }
      encodeBatch(sourceRows);
      const projected = page.map(row => ({ id: row.identity, nativeId: row.native_id, domain: row.domain, resourceType: row.resource_type,
        residual: row.domain === "packages" ? projectPackageDetailAge(row.source_residual, context.data.evaluatedAt.getTime()) : row.source_residual,
        displayName: row.display_name, environmentId: row.environment_id,
        presence: row.presence, linkState: row.link_state, identity: row.identity_info, availability: row.availability, management: row.management,
        responses: row.responses === null ? null : exactCount(row.responses), activeUsers: row.active_users === null ? null : exactCount(row.active_users),
        lastActivity: row.last_activity, associationCount: row.association_count, columns: row.columns,
        members: row.members as pg.QueryResultRow[], environment: enrichment.environments.get(row.identity) ?? null,
        people: enrichment.people.get(row.identity) ?? {} }));
      let pageBytes = 2;
      let retained = 0;
      const ordered = reverse ? [...projected].reverse() : projected;
      for (const row of ordered) {
        const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (bytes > 524288) throw dataLimitError("inventory_page_record_bytes", 524288, bytes);
        if (pageBytes + bytes > byteBudget) {
          if (!retained) throw dataLimitError("inventory_page_record_bytes", 524288, pageBytes + bytes);
          break;
        }
        pageBytes += bytes;
        retained++;
      }
      const value = reverse ? projected.slice(projected.length - retained) : projected.slice(0, retained);
      const retainedPage = reverse ? page.slice(page.length - retained) : page.slice(0, retained);
      const more = rows.length > 0 && exactCount(rows[0].candidate_count) > retained;
      const cursorFor = (row: typeof rows[number] | undefined, direction: "next" | "previous") => {
        if (!row) return null;
        if (row.identity.length <= 512) {
          try { return this.cursors.encode({ ...expected, direction, boundary: { key: "", nullRank: 0, id: row.identity } }); }
          catch (error) { if (!(error instanceof SelectionError) || error.code !== "invalid_cursor") throw error; }
        }
        return this.cursors.encode({ ...expected, direction, boundary: { key: null, nullRank: 1, id: digest(row.identity) } });
      };
      return { value, inventoryScope: context.query.inventoryScope ?? "all",
        page: { limit, nextCursor: (!reverse && more || reverse && Boolean(cursor)) ? cursorFor(retainedPage.at(-1), "next") : null,
          previousCursor: (reverse && more || !reverse && Boolean(cursor)) ? cursorFor(retainedPage[0], "previous") : null },
        selection: { id, revision: selection.revision, expiresAt: selection.expires_at, evaluatedAt: selection.evaluated_at }, ...summary };
  }

  private async pageEnrichment(client: pg.PoolClient, context: Context, ids: readonly string[]) {
    const people = new Map<string, Record<string, SavedAgentPerson>>();
    const environments = new Map<string, SavedAgentEnvironment>();
    if (!ids.length) return { people, environments };
    const references = (await client.query(`SELECT m.identity,r.observed_at,
        coalesce((SELECT jsonb_object_agg(substr(f.kind,8),f.value) FROM inventory_facts f
          WHERE f.generation_id=m.generation_id AND f.identity=m.identity
            AND f.kind IN ('person:owner','person:createdBy','person:lastModifiedBy')),'{}'::jsonb) AS people
      FROM inventory_memberships m JOIN inventory_records r ON r.generation_id=m.generation_id AND r.identity=m.identity
      WHERE ${inventoryAsOf()} AND m.identity=ANY($3::text[]) LIMIT 100`, [context.baselineId, context.revision, ids])).rows;
    encodeBatch(references);
    const objectIds = [...new Set(references.flatMap(row => Object.values(row.people) as string[]))]
      .filter(id => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id));
    const evidence = new Map<string, SavedAgentPerson>();
    for (let offset = 0; offset < objectIds.length; offset += 100) {
      const batch = await userSourcePeopleInRead(client, { ...context.data.identity, tokenMode: "delegated" },
        context.data.metadata.directory.generationId ? { generationId: context.data.metadata.directory.generationId,
          observedAt: new Date(context.data.metadata.directory.observedAt!) } : null, objectIds.slice(offset, offset + 100), context.data.evaluatedAt);
      encodeBatch(batch);
      for (const person of batch) evidence.set(person.objectId, person);
    }
    for (const reference of references) people.set(reference.identity, Object.fromEntries(
      Object.entries(reference.people).map(([role, objectId]) => [role, evidence.get(String(objectId)) ?? {
        objectId: String(objectId), displayName: null, userPrincipalName: null, observedAt: reference.observed_at.toISOString(),
      }])));
    const rows = (await client.query(`WITH inputs AS (
      SELECT r."scopeId" AS scope_id,r."baselineId" AS baseline_id,r.revision FROM inventory_revisions v
        CROSS JOIN LATERAL jsonb_to_recordset(v.inputs) r("scopeId" uuid,"baselineId" uuid,revision bigint)
        WHERE v.scope_id=$4 AND v.revision=$2
      UNION SELECT $4::uuid,$1::uuid,$2::bigint
    ), native_roots AS (${inventoryNativeRootChoicesSql("inputs")}), selected AS (
      SELECT m.identity,r.environment_id FROM inventory_memberships m
      JOIN inventory_records r ON r.generation_id=m.generation_id AND r.identity=m.identity
      WHERE ${inventoryAsOf()} AND m.identity=ANY($3::text[]) AND r.environment_id IS NOT NULL
    ) SELECT selected.identity,environment.value FROM selected CROSS JOIN LATERAL (
      SELECT value FROM (SELECT count(*) OVER() AS matches,
        jsonb_build_object('id',r.native_id,'displayName',r.display_name,'region',r.residual->'location',
        'environmentType',r.residual->'details'->'environmentType','isManaged',r.residual->'details'->'isManaged',
        'groupName',r.residual->'details'->'environmentGroup','groupId',r.residual->'details'->'environmentGroupId',
        'provenance',coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(r.residual->'provenance')
          WHERE key IN ('sourceSystem','nativeId','displayName','location','environmentType','isManaged','environmentGroup','environmentGroupId')),'{}'::jsonb),
        'observation',jsonb_build_object('id',g.id,'snapshotId',g.id,'observedAt',r.observed_at,'expiresAt',r.expires_at,
          'current',EXISTS(SELECT 1 FROM inventory_roots current WHERE current.scope_id=input.scope_id AND current.current
            AND current.baseline_id=input.baseline_id AND current.revision=input.revision))) AS value
      FROM native_roots input JOIN inventory_memberships m ON m.baseline_id=input.baseline_id
        AND m.valid_from_revision<=input.revision AND (m.valid_to_revision IS NULL OR m.valid_to_revision>input.revision)
      JOIN power_platform_record_rows r ON r.generation_id=m.generation_id AND r.identity=m.identity
      JOIN inventory_revisions revision ON revision.scope_id=input.scope_id AND revision.revision=input.revision
      JOIN data_generations g ON g.id=revision.generation_id
      WHERE input.kind='microsoft.powerplatform/environments' AND r.resource_type=input.kind AND lower(r.native_id)=lower(selected.environment_id)
        AND r.expires_at>$5 ORDER BY r.observed_at DESC,r.identity COLLATE "C" LIMIT 2) candidates WHERE matches=1
    ) environment LIMIT 100`, [context.baselineId, context.revision, ids, context.scopeId, context.data.evaluatedAt])).rows;
    encodeBatch(rows);
    for (const row of rows) environments.set(row.identity, row.value);
    return { people, environments };
  }

  private async summaries(client: pg.PoolClient, context: Context) {
    await client.query("SELECT set_config('enable_nestloop','off',true)");
    const { sql, values } = this.relation(context);
    const filtered = this.filter(context.query, values);
    const scoped = this.filter(context.query, values, undefined, true);
    const count = (predicate: string) => `count(*) FILTER(WHERE ${predicate})::text`;
    const parts = [["summary", "true"], ["scopeSummary", "f.scope_match"], ["filteredSummary", "f.filter_match"]].map(([name, predicate]) =>
      `jsonb_build_object('total',${count(predicate)},'linked',${count(`${predicate} AND f.presence='both'`)},
        'graphOnly',${count(`${predicate} AND f.presence='graph_packages'`)},
        'powerPlatformOnly',${count(`${predicate} AND f.presence='power_platform'`)},
        'ambiguous',${count(`${predicate} AND f.link_state='ambiguous'`)},
        'conflicting',${count(`${predicate} AND f.link_state='conflicting'`)}) AS "${name}"`);
    parts.push(`jsonb_build_object('packages',coalesce(sum(f.mutation_targets)
      FILTER(WHERE f.filter_match),0)::text) AS "mutationTargets"`);
    const created = `EXISTS(SELECT 1 FROM inventory_facts relevance WHERE relevance.generation_id=f.generation_id
      AND relevance.identity=f.identity AND relevance.kind='relevance' AND relevance.value='organization_created')`;
    const teams = "f.identity IN (SELECT canonical_id FROM overview_teams)";
    parts.push(`jsonb_build_object('availableToUsers',${count("f.scope_match AND f.availability='available'")},
      'organizationCreated',${count("f.scope_match AND f.organization_created")},'teamsAvailable',${count("f.scope_match AND f.teams_available")},
      'createdOrAvailable',${count("f.scope_match AND (f.organization_created OR f.teams_available)")}) AS "inventoryOverview"`);
    // Only immutable, unfiltered aggregates are cached. Every read still fences
    // the selection first; current job/source freshness is recomputed below.
    const cacheable = unfilteredOrdering(context.query,context.source);
    const entry = cacheable ? this.summaryCache.get(context.selectionId) : undefined;
    const cached = entry && entry.expiresAt>Date.now() ? entry : undefined;
    let row = cached?.row;
    if (!row) {
    row = (await client.query(`${sql}${cacheable ? `, summary_values AS (
      SELECT x.generation_id,x.identity,
        bool_or(x.kind='relevance' AND x.value='organization_created') AS organization_created,
        count(*) FILTER(WHERE x.kind='blocked') AS mutation_targets
      FROM inventory_facts x WHERE x.scope_id=$12 AND x.kind IN ('relevance','blocked')
        AND EXISTS(SELECT 1 FROM inventory i WHERE i.generation_id=x.generation_id AND i.identity=x.identity)
      GROUP BY x.generation_id,x.identity
    )` : ""}, overview_teams AS MATERIALIZED (
      SELECT s.canonical_id FROM sources s WHERE s.domain='packages' AND s.availability='available'
        AND EXISTS(SELECT 1 FROM inventory_facts host WHERE host.generation_id=s.generation_id
          AND host.identity=s.identity AND host.kind='host' AND lower(btrim(host.value))='teams')
      GROUP BY s.canonical_id
    ), summary_facts AS MATERIALIZED (
      ${cacheable ? `SELECT f.presence,f.link_state,f.availability,(${scoped}) AS scope_match,(${filtered}) AS filter_match,
        coalesce(v.organization_created,false) AS organization_created,
        (f.identity IN (SELECT canonical_id FROM overview_teams)) AS teams_available,
        coalesce(v.mutation_targets,0) AS mutation_targets
        FROM inventory f LEFT JOIN summary_values v ON v.generation_id=f.generation_id AND v.identity=f.identity`
      : `SELECT f.presence,f.link_state,f.availability,(${scoped}) AS scope_match,(${filtered}) AS filter_match,
        (${created}) AS organization_created,(${teams}) AS teams_available,
        (SELECT count(*) FROM inventory_facts target WHERE target.generation_id=f.generation_id
          AND target.identity=f.identity AND target.kind='blocked') AS mutation_targets
      FROM facts f`}
    ) SELECT ${parts.join(",")}
      FROM summary_facts f`, values)).rows[0];
    }
    if (!row) throw new Error("inventory_summary_missing");
    const current = (await client.query(`SELECT r.baseline_id,r.revision,c.status FROM inventory_roots r
      LEFT JOIN inventory_reconciliation c ON c.scope_id=r.scope_id WHERE r.scope_id=$1 AND r.current`, [context.scopeId])).rows[0];
    const sources = (await client.query(`WITH roots AS (
      SELECT r."scopeId" AS scope_id,r."baselineId" AS baseline_id,r.revision FROM inventory_revisions v
        CROSS JOIN LATERAL jsonb_to_recordset(v.inputs) r("scopeId" uuid,"baselineId" uuid,revision bigint)
        WHERE v.scope_id=$1 AND v.revision=$2
      UNION SELECT $1::uuid,$3::uuid,$2::bigint), native_roots AS (${inventoryNativeRootChoicesSql("roots")})
      SELECT s.id AS scope_id,s.source,s.selector,s.token_mode,v.row_count,g.id AS generation_id,g.observed_at,g.expires_at,a.channel,a.environment_id,a.resource_types,
        root.baseline_id,a.role_scope,
        CASE WHEN a.domain='power_platform' THEN
        (SELECT count(*)::int FROM inventory_memberships m JOIN power_platform_record_rows r ON r.generation_id=m.generation_id AND r.identity=m.identity
          WHERE m.baseline_id=root.baseline_id AND m.valid_from_revision<=root.revision
            AND (m.valid_to_revision IS NULL OR m.valid_to_revision>root.revision)
            AND r.resource_type='microsoft.copilotstudio/agents') ELSE 0 END AS agent_count,
        a.expected_count,CASE WHEN saved.catalog_complete THEN saved.catalog_page_count ELSE g.page_count END AS page_count,
        saved.catalog_omitted_fields AS unknown_field_count,g.wire_count,a.complete,
        (saved.catalog_complete AND saved.catalog_expires_at>$4) AS catalog_complete,
        saved.catalog_observed_at,saved.catalog_expires_at,
        root.revision AS captured_revision,coalesce(current.baseline_id=root.baseline_id AND current.revision=root.revision,false) AS current
      FROM roots root JOIN inventory_revisions v ON v.scope_id=root.scope_id AND v.revision=root.revision
      JOIN data_generations g ON g.id=v.generation_id JOIN inventory_attempts a ON a.generation_id=g.id
      JOIN inventory_roots saved ON saved.baseline_id=root.baseline_id
      JOIN data_scope_epochs s ON s.id=root.scope_id LEFT JOIN inventory_roots current ON current.scope_id=root.scope_id AND current.current
      WHERE a.domain<>'canonical' ORDER BY s.source,
        CASE WHEN EXISTS(SELECT 1 FROM native_roots selected WHERE selected.scope_id=root.scope_id
          AND selected.kind='microsoft.copilotstudio/agents') THEN 0 ELSE 1 END,s.selector LIMIT 16`,
    [context.scopeId, context.revision, context.baselineId, context.data.evaluatedAt])).rows;
    const expiredIdentity = (await client.query(`SELECT EXISTS(${pendingInventoryIdentityExpirySql}) AS expired`, [context.scopeId])).rows[0].expired;
    const state = !current || current.baseline_id !== context.baselineId || current.revision !== context.revision ? "stale"
      : current.status === "running" ? "reconciling" : expiredIdentity || sources.some(source => !source.current) ? "catching_up" : current.status ?? "idle";
    const summaries = Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      Object.fromEntries(Object.entries(value as Record<string, string>).map(([name, count]) => [name, exactCount(count)]))]));
    const verificationCounts = cached?.verificationCounts ?? (await client.query(`SELECT count(*) FILTER(WHERE r.domain='packages')::int AS packages,
      count(*) FILTER(WHERE r.domain='power_platform' AND r.resource_type='microsoft.copilotstudio/agents')::int AS native_agents,
      count(*)::int AS represented,
      count(DISTINCT (r.domain,r.native_id,CASE WHEN r.domain='packages' THEN '' ELSE lower(coalesce(r.environment_id,'')) END))::int AS unique_sources,
      count(*) FILTER(WHERE r.domain='packages' AND r.residual->>'identityDetailsCollected'='true'
        AND (r.residual->'detailFreshness'->>'state' IS NULL OR r.residual->'detailFreshness'->>'state'='fresh'
          AND coalesce((r.residual->'detailFreshness'->>'expiresAt')::timestamptz>$3
            AND (r.residual->'detailFreshness'->>'observedAt')::timestamptz<=$3,false)))::int AS checked_packages,
      count(*) FILTER(WHERE r.domain='packages' AND (r.residual->'detailFreshness'->>'state'='stale'
        OR r.residual->'detailFreshness'->>'state'='fresh' AND NOT coalesce(
          (r.residual->'detailFreshness'->>'expiresAt')::timestamptz>$3
          AND (r.residual->'detailFreshness'->>'observedAt')::timestamptz<=$3,false)))::int AS stale_packages,
      count(*) FILTER(WHERE r.domain='packages' AND r.residual->'detailFreshness'->>'state'='invalidated')::int AS invalidated_packages
      FROM inventory_memberships m JOIN unified_agent_memberships s ON s.generation_id=m.generation_id AND s.identity=m.identity
      JOIN inventory_records r ON r.generation_id=s.source_generation_id AND r.identity=s.source_identity
      WHERE ${inventoryAsOf()}`, [context.baselineId, context.revision, context.data.evaluatedAt])).rows[0];
    if (cacheable && !cached) {
      peakCheckpoint("response.serialize");
      const serialized = JSON.stringify({ row,verificationCounts }); peakCheckpoint("response.serialize");
      if (Buffer.byteLength(serialized)<=16384) {
        this.summaryCache.delete(context.selectionId);
        while (this.summaryCache.size>=32) this.summaryCache.delete(this.summaryCache.keys().next().value!);
        this.summaryCache.set(context.selectionId,{ expiresAt: context.expiresAt,row,verificationCounts });
      }
    }
    return { counts: { total: summaries.summary.total, scoped: summaries.scopeSummary.total, filtered: summaries.filteredSummary.total,
      packageTargets: summaries.mutationTargets.packages },
      summary: summaries.summary, scopeSummary: summaries.scopeSummary, filteredSummary: summaries.filteredSummary,
      inventoryOverview: summaries.inventoryOverview,
      verificationCounts,
      freshness: { state, capturedRevision: context.revision, sources }, partial: sources.some(source => !source.catalog_complete),
      reports: context.data.report };
  }

  summary(id: string, identity: SelectionIdentity) { return this.read(id, identity, (client, context) => this.summaries(client, context)); }

  private continuation(id: string, identity: SelectionIdentity, selection: Record<string, unknown>, endpoint: string, binding: unknown, cursor?: string) {
    const expected = { identity, endpoint: `inventory:${endpoint}`, selectionId: id, revision: String(selection.revision),
      queryHash: digest(JSON.stringify([selection.query_hash, binding])) };
    const decoded = cursor ? this.cursors.decode(cursor, expected) : undefined;
    if (decoded && decoded.direction !== "next") throw new SelectionError("invalid_cursor");
    const after = decoded?.boundary.key;
    if (decoded && (typeof after !== "string" || decoded.boundary.id !== digest(after))) throw new SelectionError("invalid_cursor");
    return { after, next: (value: string | number | undefined) => value === undefined ? null : this.cursors.encode({
      ...expected, direction: "next", boundary: { nullRank: 0, key: String(value), id: digest(String(value)) },
    }) };
  }

  facets(id: string, identity: SelectionIdentity, field: "type" | "publisher" | "host" | "platform" | "environmentId" | "source" | "linkState" | "blocked" | "availableTo", options: { limit?: number; cursor?: string; search?: string; selected?: boolean } = {}) {
    const limit = pageLimit(options.limit);
    if (!["type", "publisher", "host", "platform", "environmentId", "source", "linkState", "blocked", "availableTo"].includes(field)) throw new SelectionError("invalid_cursor");
    return this.read(id, identity, async (client, context, selection) => {
      if (options.selected && (options.cursor || options.search || !["type", "publisher", "host", "platform", "environmentId", "availableTo"].includes(field))) {
        throw new SelectionError("invalid_cursor");
      }
      let selectedValue = options.selected ? context.query[field] : undefined;
      if (options.selected && selectedValue === undefined) return { value: [], total: 0, nextCursor: null };
      if (field === "environmentId" && typeof selectedValue === "string") selectedValue = selectedValue.toLowerCase();
      if (field === "platform" && typeof selectedValue === "string") selectedValue = normalizePackageAuthoringTool(selectedValue);
      const cursor = this.continuation(id, identity, selection, "facets", [field, options.search ?? "", Boolean(options.selected)], options.cursor);
      const { sql, values } = this.relation(context);
      const where = this.filter(options.selected ? { inventoryScope: context.query.inventoryScope } : context.query, values, field);
      values.push(options.selected ? encodeInventoryFacet(selectedValue as Parameters<typeof encodeInventoryFacet>[0]) : null);
      const selectedWhere = `($${values.length}::text IS NULL OR value=$${values.length})`;
      values.push(field, cursor.after ?? null, options.search ?? "");
      const n = values.length;
      const scalar = ({ environmentId: "f.environment_id", source: "f.presence", linkState: "f.link_state" } as Record<string, string>)[field];
      const literal = scalar ?? "x.value";
      const expression = `CASE WHEN coalesce(${literal},'')='' THEN '~null' ELSE '~string:'||${literal} END`;
      const label = field === "environmentId" ? "coalesce(f.environment_label,'')" : field === "platform" ? "coalesce(x.text_value,x.value)"
        : "coalesce(nullif(" + literal + ",''),'Unknown')";
      const facets = `${sql}, options AS (SELECT ${expression} AS value,min(${label} COLLATE "C") AS label FROM facts f
        ${scalar ? `CROSS JOIN (SELECT $${n - 2}::text AS field) binding` : `JOIN inventory_facts x ON x.generation_id=f.generation_id
          AND x.identity=f.identity AND x.kind=$${n - 2}`}
        WHERE ${where} AND position(lower($${n}::text) IN lower(${label}))>0 GROUP BY ${expression}
        ${field === "availableTo" ? `UNION ALL SELECT '~some-or-all','Allowed for Some or All'
          WHERE position(lower($${n}::text) IN lower('Allowed for Some or All'))>0 AND EXISTS(
            SELECT 1 FROM facts f JOIN inventory_facts x ON x.generation_id=f.generation_id AND x.identity=f.identity
              AND x.kind='availableTo' WHERE ${where} AND ${assignedAccessSql})` : ""})`;
      const total = exactCount((await client.query(`${facets} SELECT count(*)::text AS n FROM options
        WHERE ${selectedWhere} AND ($${n - 1}::text IS NULL OR $${n - 1}::text IS NOT NULL)`, values)).rows[0].n);
      const rows = (await client.query(`${facets}, candidates AS (
        SELECT value,label FROM options WHERE ${selectedWhere} AND ($${n - 1}::text IS NULL OR value COLLATE "C">(
          SELECT value FROM options WHERE encode(sha256(convert_to(value,'UTF8')),'hex')=$${n - 1} LIMIT 1) COLLATE "C")
        ORDER BY value COLLATE "C" LIMIT ${limit + 1}),
        sized AS (SELECT *,count(*) OVER() AS candidate_count,
          sum(octet_length(row_to_json(c)::text)) OVER(ORDER BY value COLLATE "C") AS bytes FROM candidates c)
        SELECT value,label,candidate_count FROM sized WHERE bytes<=524288 ORDER BY value COLLATE "C"`, values)).rows;
      const page = rows.slice(0, limit);
      const more = rows.length > 0 && exactCount(rows[0].candidate_count) > page.length;
      return { value: page.map(({ value, label }) => ({ value: decodeInventoryFacet(value), label })), total,
        nextCursor: cursor.next(more ? digest(page.at(-1)!.value) : undefined) };
    });
  }

  exact(id: string, identity: SelectionIdentity, ids: readonly string[]) {
    if (ids.length > 100) throw dataLimitError("data_exact_ids_limit", 100, ids.length);
    return this.read(id, identity, async (client, context) => {
      await client.query("SET LOCAL jit=off; SET LOCAL enable_nestloop=on");
      const domain = context.source === "inventory_packages" ? "packages" : context.source === "inventory_power_platform" ? "power_platform" : "canonical";
      const rows = (await client.query(`WITH candidates AS (SELECT r.identity,r.generation_id,r.residual,r.domain FROM inventory_memberships m
        CROSS JOIN LATERAL (SELECT r.identity,r.generation_id,r.residual,r.domain FROM inventory_records r
          WHERE r.generation_id=m.generation_id AND r.identity=m.identity AND r.scope_id=$4 AND r.domain='${domain}' OFFSET 0) r
        WHERE ${inventoryAsOf()} AND m.identity=ANY($3::text[]) ORDER BY m.identity LIMIT 100),
        sized AS (SELECT *,sum(octet_length(residual::text)+1024) OVER(ORDER BY identity) AS bytes,
          sum(octet_length(residual::text)+1024) OVER() AS total_bytes FROM candidates)
        SELECT identity,generation_id,residual,domain,total_bytes FROM sized WHERE bytes<=524288`, [context.baselineId, context.revision, ids,context.scopeId])).rows;
      if (rows.length && exactCount(rows[0].total_bytes) > 524288) throw dataLimitError("inventory_exact_bytes", 524288, exactCount(rows[0].total_bytes));
      encodeBatch(rows); return rows;
    });
  }

  packageDetail(id: string, identity: SelectionIdentity, nativeId: string) {
    return this.read(id, identity, async (client, context) => {
      const rows = (await client.query(`WITH selected AS (
        SELECT m.identity AS record_id,$4::uuid AS source_scope_id,'[]'::jsonb AS evidence,r.* FROM inventory_memberships m
        JOIN inventory_records r ON r.generation_id=m.generation_id AND r.identity=m.identity
        WHERE ${inventoryAsOf()} AND m.identity=$3 AND r.domain='packages' AND r.native_id=$3
        UNION ALL
        SELECT m.identity AS record_id,s.source_scope_id,s.evidence,r.* FROM inventory_memberships m
        JOIN unified_agent_memberships s ON s.generation_id=m.generation_id AND s.identity=m.identity
        JOIN inventory_records r ON r.generation_id=s.source_generation_id AND r.identity=s.source_identity
        WHERE ${inventoryAsOf()} AND s.source_identity=$3 AND r.domain='packages' AND r.native_id=$3
      ) SELECT selected.*,
        EXISTS(SELECT 1 FROM inventory_roots root JOIN inventory_memberships live
          ON live.baseline_id=root.baseline_id AND live.valid_from_revision<=root.revision
            AND (live.valid_to_revision IS NULL OR live.valid_to_revision>root.revision)
          JOIN data_scope_epochs scope ON scope.id=root.scope_id
          JOIN inventory_revisions revision ON revision.scope_id=root.scope_id AND revision.revision=root.revision
          JOIN data_generations generation ON generation.id=revision.generation_id
          WHERE root.current AND root.scope_id=selected.source_scope_id AND live.generation_id=selected.generation_id
            AND live.identity=selected.identity AND generation.scope_epoch=scope.epoch
            AND generation.session_epoch=scope.session_epoch AND generation.expires_at>$5) AS current
        FROM selected LIMIT 2`,
      [context.baselineId, context.revision, nativeId, context.scopeId, context.data.evaluatedAt])).rows;
      encodeBatch(rows);
      if (!rows.length) throw new AppError(404, "inventory_record_not_found", "The exact package is absent from this inventory selection.");
      if (rows.length !== 1) throw new AppError(409, "inventory_identity_ambiguous", "The exact package has multiple selected memberships.");
      const row = rows[0];
      const assignments: Record<string, unknown[]> = {};
      let assignmentBytes = 0;
      let accessReadError: string | undefined;
      for (const kind of ["allowedUsersAndGroups", "acquireUsersAndGroups"]) {
        const count = (await client.query(`SELECT count(*)::int AS total,
          coalesce(sum(octet_length(payload::text)),0)::int AS bytes FROM inventory_facts
          WHERE generation_id=$1 AND identity=$2 AND kind=$3`, [row.generation_id, row.identity, kind])).rows[0];
        assignmentBytes += count.bytes;
        if (count.total > 1000 || assignmentBytes > 60_000) {
          accessReadError = "The saved access assignment exceeds the supported 1,000-principal or 60,000-byte control limit.";
          continue;
        }
        const present = (await client.query(`SELECT 1 FROM inventory_facts
          WHERE generation_id=$1 AND identity=$2 AND kind='collection' AND value=$3 LIMIT 1`,
        [row.generation_id, row.identity, kind])).rowCount;
        if (!present) continue;
        assignments[kind] = [];
        for (let after = -1; ;) {
          const page = (await client.query(`SELECT ordinal,payload FROM inventory_facts
            WHERE generation_id=$1 AND identity=$2 AND kind=$3 AND ordinal>$4 ORDER BY ordinal LIMIT 100`,
          [row.generation_id, row.identity, kind, after])).rows;
          encodeBatch(page);
          assignments[kind].push(...page.map(item => item.payload));
          if (page.length < 100) break;
          after = page[page.length - 1].ordinal;
        }
      }
      const detail = { ...projectPackageDetailAge(row.residual, context.data.evaluatedAt.getTime()), ...assignments,
        matchingEvidence: row.evidence, ...(accessReadError ? { accessReadError } : {}),
        observation: { id: row.generation_id, observedAt: row.observed_at, expiresAt: row.expires_at, current: row.current,
          scopeKind: "exact", source: "Microsoft Graph package catalog", apiMaturity: "v1.0 read; preview controls" },
        selectedSource: { selectionId: id, recordId: row.record_id, sourceScopeId: row.source_scope_id,
          sourceIdentity: row.identity, generationId: row.generation_id } };
      const bytes = Buffer.byteLength(JSON.stringify(detail));
      if (bytes > 524288) throw dataLimitError("inventory_detail_bytes", 524288, bytes);
      return detail;
    });
  }

  sourceReferences(id: string, identity: SelectionIdentity, references: readonly { domain: "packages" | "power_platform"; nativeId: string; environmentId: string | null }[]) {
    if (references.length > 100) throw dataLimitError("data_exact_ids_limit", 100, references.length);
    const batch = encodeBatch(references);
    return this.read(id, identity, async (client, context) => {
      const rows = (await client.query(`SELECT DISTINCT m.identity AS canonical_id,
      source.domain,source.native_id,source.environment_id,source.generation_id FROM jsonb_to_recordset($3::jsonb)
        requested(domain text,"nativeId" text,"environmentId" text)
      JOIN inventory_records source ON source.domain=requested.domain AND source.native_id=requested."nativeId"
        AND (requested.domain='packages' OR coalesce(lower(source.environment_id),'')=coalesce(lower(requested."environmentId"),''))
      JOIN unified_agent_memberships member ON member.source_generation_id=source.generation_id AND member.source_identity=source.identity
      JOIN inventory_memberships m ON m.generation_id=member.generation_id AND m.identity=member.identity
      WHERE ${inventoryAsOf()} ORDER BY m.identity,source.domain,source.native_id LIMIT 101`, [context.baselineId, context.revision, batch.json])).rows;
      if (rows.length > 100) throw dataLimitError("inventory_exact_ids_limit", 100, rows.length);
      return rows;
    });
  }

  members(id: string, identity: SelectionIdentity, recordId: string, options: { cursor?: string; limit?: number } = {}) {
    const limit = pageLimit(options.limit);
    return this.read(id, identity, async (client, context, selection) => {
      const cursor = this.continuation(id, identity, selection, "members", recordId, options.cursor);
      const total = exactCount((await client.query(`SELECT count(*)::text AS total FROM inventory_memberships m
        JOIN unified_agent_memberships s ON s.generation_id=m.generation_id AND s.identity=m.identity
        WHERE ${inventoryAsOf()} AND m.identity=$3`, [context.baselineId, context.revision, recordId])).rows[0].total);
      const rows = (await client.query(`SELECT s.source_scope_id,s.source_identity,s.source_generation_id,r.domain,r.native_id,r.environment_id,r.display_name,
        r.observed_at,r.read_started_at,r.expires_at,r.catalog_generation,r.detail_generation,r.control_generation
        FROM inventory_memberships m JOIN unified_agent_memberships s ON s.generation_id=m.generation_id AND s.identity=m.identity
        JOIN inventory_records r ON r.generation_id=s.source_generation_id AND r.identity=s.source_identity
        WHERE ${inventoryAsOf()} AND m.identity=$3 AND (s.source_scope_id::text||':'||s.source_identity) COLLATE "C">$4
        ORDER BY (s.source_scope_id::text||':'||s.source_identity) COLLATE "C" LIMIT ${limit + 1}`, [context.baselineId, context.revision, recordId, cursor.after ?? ""])).rows;
      const last = rows[limit - 1];
      return { value: rows.slice(0, limit), total, nextCursor: cursor.next(rows.length > limit ? `${last.source_scope_id}:${last.source_identity}` : undefined) };
    });
  }

  usage(id: string, identity: SelectionIdentity, recordIds: readonly string[]) {
    if (recordIds.length > 100) throw dataLimitError("data_exact_ids_limit", 100, recordIds.length);
    return this.read(id, identity, async (client, context) => {
      const { sql, values } = this.relation(context);
      values.push(recordIds);
      return (await client.query(`${sql} SELECT identity,responses::text,active_users::text,last_activity::text FROM facts
        WHERE identity=ANY($${values.length}::text[]) ORDER BY identity LIMIT 100`, values)).rows.map(row => ({ id: row.identity,
        status: context.data.report.setId === null ? "unavailable" : row.responses === null ? "unlinked" : "linked",
        responses: row.responses === null ? null : exactCount(row.responses),
        activeUsers: row.active_users === null ? null : exactCount(row.active_users), lastActivity: row.last_activity }));
    });
  }

  sections(id: string, identity: SelectionIdentity, recordId: string, options: {
    sourceScopeId: string; sourceIdentity: string; cursor?: string; limit?: number;
  }) {
    const limit = pageLimit(options.limit);
    return this.read(id, identity, async (client, context, selection) => {
      const cursor = this.continuation(id, identity, selection, "sections", [recordId, options.sourceScopeId, options.sourceIdentity], options.cursor);
      const rows = (await client.query(`WITH sections AS (
        SELECT CASE WHEN f.kind='collection' THEN CASE f.value WHEN 'elementDetails' THEN 'element' ELSE f.value END
          ELSE f.kind END AS kind,count(*) FILTER(WHERE f.kind<>'collection')::int AS total
        FROM inventory_memberships m JOIN unified_agent_memberships s ON s.generation_id=m.generation_id AND s.identity=m.identity
        JOIN inventory_facts f ON f.generation_id=s.source_generation_id AND f.identity=s.source_identity
        WHERE ${inventoryAsOf()} AND m.identity=$3 AND s.source_scope_id=$4 AND s.source_identity=$5
          AND (f.kind LIKE 'detail:%' OR f.kind IN ('collection','element','identifier','connectorOperation','supportedHosts',
            'elementTypes','categories','allowedUsersAndGroups','acquireUsersAndGroups'))
        GROUP BY 1)
        SELECT kind,total,count(*) OVER()::int AS section_count FROM sections WHERE kind COLLATE "C">$6
        ORDER BY kind COLLATE "C" LIMIT ${limit + 1}`,
      [context.baselineId, context.revision, recordId, options.sourceScopeId, options.sourceIdentity, cursor.after ?? ""])).rows;
      encodeBatch(rows);
      return { value: rows.slice(0, limit).map(({ kind, total }) => ({ kind, total })),
        nextCursor: cursor.next(rows.length > limit ? rows[limit - 1].kind : undefined) };
    });
  }

  children(id: string, identity: SelectionIdentity, recordId: string, options: {
    kind: string; cursor?: string; limit?: number; sourceScopeId?: string; sourceIdentity?: string; value?: string;
  }) {
    const limit = pageLimit(options.limit);
    return this.read(id, identity, async (client, context, selection) => {
      if (Boolean(options.sourceScopeId) !== Boolean(options.sourceIdentity)) throw new SelectionError("invalid_cursor");
      const cursor = this.continuation(id, identity, selection, "children", [recordId, options.kind,
        options.sourceScopeId ?? null, options.sourceIdentity ?? null, ...(options.value === undefined ? [] : [options.value])], options.cursor);
      const selected = `SELECT m.generation_id,m.identity FROM inventory_memberships m
        WHERE ${inventoryAsOf()} AND m.identity=$3 AND $6::uuid IS NULL
        UNION ALL SELECT s.source_generation_id,s.source_identity FROM inventory_memberships m
        JOIN unified_agent_memberships s ON s.generation_id=m.generation_id AND s.identity=m.identity
        WHERE ${inventoryAsOf()} AND m.identity=$3 AND s.source_scope_id=$6 AND s.source_identity=$7`;
      const parameters = [context.baselineId, context.revision, recordId, options.kind, cursor.after === undefined ? -1 : Number(cursor.after),
        options.sourceScopeId ?? null, options.sourceIdentity ?? null, options.value ?? null];
      const total = exactCount((await client.query(`WITH selected AS (${selected}) SELECT count(*)::text AS total
        FROM selected s JOIN inventory_facts f ON f.generation_id=s.generation_id AND f.identity=s.identity
        WHERE f.kind=$4 AND ($5::int IS NULL OR $5::int IS NOT NULL) AND ($8::text IS NULL OR f.value=$8)`, parameters)).rows[0].total);
      const rows = (await client.query(`WITH selected AS (${selected}), candidates AS (SELECT f.ordinal,f.kind,f.value,f.payload FROM selected s
        JOIN inventory_facts f ON f.generation_id=s.generation_id AND f.identity=s.identity
        WHERE f.kind=$4 AND f.ordinal>$5 AND ($8::text IS NULL OR f.value=$8) ORDER BY f.ordinal LIMIT ${limit + 1}),
        sized AS (SELECT *,count(*) OVER() AS candidate_count,
          sum(octet_length(row_to_json(c)::text)+1) OVER(ORDER BY ordinal) AS bytes FROM candidates c)
        SELECT ordinal,kind,value,CASE WHEN bytes<=524288 THEN payload END AS payload,candidate_count,bytes
          FROM sized WHERE bytes<=524288 OR ordinal=(SELECT min(ordinal) FROM candidates) ORDER BY ordinal`,
      parameters)).rows;
      if (rows.length && exactCount(rows[0].bytes) > 524288) throw dataLimitError("inventory_child_record_bytes", 524288, exactCount(rows[0].bytes));
      const page = rows.slice(0, limit);
      return { value: page.map(({ ordinal, kind, value, payload }) => ({ ordinal, kind, value, payload })), total,
        nextCursor: cursor.next(rows.length && exactCount(rows[0].candidate_count) > page.length ? page.at(-1)!.ordinal : undefined) };
    });
  }

  people(id: string, identity: SelectionIdentity, objectIds: readonly string[]) {
    return this.read(id, identity, (client, context) => userSourcePeopleInRead(client, { ...identity, tokenMode: "delegated" },
      context.data.metadata.directory.generationId ? { generationId: context.data.metadata.directory.generationId,
        observedAt: new Date(context.data.metadata.directory.observedAt!) } : null, objectIds, context.data.evaluatedAt));
  }

  responsibility(id: string, identity: SelectionIdentity, options: AgentResponsibilityQuery = {}) {
    return this.read(id, identity, async (client, context, selection) => {
      const result = await readInventoryResponsibility(client, this.relation(context), context.data, selection, id, identity, this.cursors, options);
      return { ...result, sourceRows: (await this.summaries(client, context)).freshness.sources };
    });
  }

  responsibilityAgents(id: string, identity: SelectionIdentity, objectId: string, options: { cursor?: string; limit?: number } = {}) {
    const limit = pageLimit(options.limit);
    return this.read(id, identity, async (client, context, selection) => {
      const cursor = this.continuation(id, identity, selection, "responsibility-agents", objectId, options.cursor);
      const rows = (await client.query(`SELECT DISTINCT m.identity,r.display_name FROM inventory_memberships m
        JOIN inventory_facts f ON f.generation_id=m.generation_id AND f.identity=m.identity
        JOIN inventory_records r ON r.generation_id=m.generation_id AND r.identity=m.identity
        WHERE ${inventoryAsOf()} AND f.kind IN ('person:owner','person:createdBy','person:lastModifiedBy') AND f.value=lower($3)
          AND m.identity>$4 ORDER BY m.identity LIMIT ${limit + 1}`, [context.baselineId, context.revision, objectId, cursor.after ?? ""])).rows;
      return { value: rows.slice(0, limit), nextCursor: cursor.next(rows.length > limit ? rows[limit - 1].identity : undefined) };
    });
  }

  currentControl<T>(id: string, identity: SelectionIdentity, recordId: string,
    qualify: (client: pg.PoolClient, reference: { scopeId: string; baselineId: string; revision: string; recordId: string }) => Promise<T>) {
    return this.reports.history.connections.run(async client => {
      await lockInventorySelection(client, identity, id);
      const { context } = await this.contextInRead(client, id, identity);
      const current = (await client.query(`SELECT r.revision,r.baseline_id,c.status,s.token_mode FROM inventory_roots r
        JOIN data_scope_epochs s ON s.id=r.scope_id LEFT JOIN inventory_reconciliation c ON c.scope_id=r.scope_id
        WHERE r.scope_id=$1 AND r.current FOR SHARE OF r`, [context.scopeId])).rows[0];
      if (!current || current.token_mode !== "delegated" || current.revision !== context.revision || current.baseline_id !== context.baselineId || current.status && current.status !== "idle") {
        throw new SelectionError("selection_invalidated");
      }
      const assertLive = async () => {
        if (!(await client.query(`SELECT 1 FROM (${currentInventorySourcesSql}) live LIMIT 1`,
          [identity.tenantId, identity.principalId, recordId, context.data.evaluatedAt])).rowCount) {
          throw new SelectionError("selection_invalidated");
        }
      };
      await assertLive();
      const changed = await client.query(`SELECT 1 FROM inventory_revisions v CROSS JOIN LATERAL
        jsonb_to_recordset(v.inputs) input("scopeId" uuid,"baselineId" uuid,revision bigint)
        LEFT JOIN inventory_roots current ON current.scope_id=input."scopeId" AND current.current
        WHERE v.scope_id=$1 AND v.revision=$2 AND (current.baseline_id IS DISTINCT FROM input."baselineId"
          OR current.revision IS DISTINCT FROM input.revision) LIMIT 1`, [context.scopeId, context.revision]);
      if (changed.rowCount) throw new SelectionError("selection_invalidated");
      const exists = await client.query(`SELECT 1 FROM inventory_memberships m JOIN inventory_records r ON r.generation_id=m.generation_id AND r.identity=m.identity
        WHERE ${inventoryAsOf()} AND m.identity=$3 AND r.expires_at>clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM unified_agent_memberships s JOIN inventory_records source
          ON source.generation_id=s.source_generation_id AND source.identity=s.source_identity
          WHERE s.generation_id=m.generation_id AND s.identity=m.identity AND source.expires_at<=clock_timestamp())`,
        [context.baselineId, context.revision, recordId]);
      if (!exists.rowCount) throw new SelectionError("selection_invalidated");
      const result = await qualify(client, { scopeId: context.scopeId, baselineId: context.baselineId, revision: context.revision, recordId });
      await this.selections.assert(client, id, identity);
      await assertLive();
      return result;
    });
  }

  withCurrentSelection<T>(id: string, identity: SelectionIdentity,
    work: (client: pg.PoolClient, context: Context) => Promise<T>) {
    return this.reports.history.connections.run(client => this.inCurrentSelection(client, id, identity, work));
  }

  async inCurrentSelection<T>(client: pg.PoolClient, id: string, identity: SelectionIdentity,
    work: (client: pg.PoolClient, context: Context) => Promise<T>) {
      await lockInventorySelection(client, identity, id);
      const { context } = await this.contextInRead(client, id, identity);
      const current = (await client.query(`SELECT root.baseline_id,root.revision,scope.token_mode,scope.source
        FROM inventory_roots root JOIN data_scope_epochs scope ON scope.id=root.scope_id
        WHERE root.scope_id=$1 AND root.current FOR SHARE OF root`, [context.scopeId])).rows[0];
      if (!current || current.token_mode !== "delegated" || current.source !== "inventory_canonical"
        || current.baseline_id !== context.baselineId || current.revision !== context.revision
        || (await client.query(`SELECT 1 FROM inventory_control_pending WHERE tenant_id=$1 AND principal_id=$2
          UNION ALL SELECT 1 FROM inventory_native_control_pending WHERE tenant_id=$1 AND principal_id=$2
          UNION ALL SELECT 1 FROM inventory_reconciliation WHERE scope_id=$3 AND (status<>'idle' OR pending_inputs IS NOT NULL) LIMIT 1`,
        [identity.tenantId, identity.principalId, context.scopeId])).rowCount) throw new SelectionError("selection_invalidated");
      if (!(await client.query(`SELECT 1 FROM (${currentInventorySourcesSql}) live
        WHERE canonical_scope_id=$5 LIMIT 1`, [identity.tenantId, identity.principalId, null, context.data.evaluatedAt, context.scopeId])).rowCount) {
        throw new SelectionError("selection_invalidated");
      }
      const result = await work(client, context);
      await this.selections.assert(client, id, identity);
      return result;
  }

  private mutationTargetRelation(context: Context, after: string | null, ids?: readonly string[], recordIds?: readonly string[]) {
    const { sql, values } = this.relation(context);
    const where = this.filter(context.query, values);
    values.push(after, ids ?? null, recordIds?.map(id => id.replace(/^agent:/, "")) ?? null);
    const boundary = values.length - 2, requested = values.length - 1, groups = values.length;
    encodeBatch([], values);
    return { values, sql: `${sql}, selected_targets AS (
        SELECT DISTINCT source.native_id AS id,source.generation_id,source.identity AS source_identity,source.display_name,f.identity AS agent_id
        FROM facts f JOIN unified_agent_memberships member ON member.generation_id=f.generation_id AND member.identity=f.identity
        JOIN package_record_rows source ON source.generation_id=member.source_generation_id AND source.identity=member.source_identity
        WHERE ${where} AND ($${boundary}::text IS NULL OR source.native_id COLLATE "C">$${boundary}::text COLLATE "C")
          AND ($${requested}::text[] IS NULL AND $${groups}::text[] IS NULL
            OR source.native_id=ANY($${requested}::text[]) OR f.identity=ANY($${groups}::text[]))
      )` };
  }

  async mutationTargetCount(client: pg.PoolClient, context: Context, ids?: readonly string[], recordIds?: readonly string[]) {
    const { sql, values } = this.mutationTargetRelation(context, null, ids, recordIds);
    const count = (await client.query(`${sql} SELECT count(DISTINCT id)::text AS total,
      count(DISTINCT id) FILTER(WHERE id=ANY($${values.length - 1}::text[]))::int AS exact_targets,
      count(DISTINCT agent_id) FILTER(WHERE agent_id=ANY($${values.length}::text[]))::int AS groups FROM selected_targets`, values)).rows[0];
    if (ids && count.exact_targets !== ids.length || recordIds && count.groups !== recordIds.length) {
      throw new AppError(409, "package_target_stale_or_absent", "An exact selected package or agent group is absent from the current selection.");
    }
    return exactCount(count.total);
  }

  async refreshTargetIds(client: pg.PoolClient, context: Context, after: string | null, ids?: readonly string[], recordIds?: readonly string[]) {
    const { sql, values } = this.mutationTargetRelation(context, after, ids, recordIds);
    const rows = (await client.query<{ id: string }>(`${sql}
      SELECT DISTINCT id COLLATE "C" AS id FROM selected_targets ORDER BY id LIMIT 250`, values)).rows;
    encodeBatch(rows);
    return rows;
  }

  async mutationTargets(client: pg.PoolClient, context: Context, after: string | null, ids?: readonly string[], recordIds?: readonly string[]) {
    const { sql, values } = this.mutationTargetRelation(context, after, ids, recordIds);
    return (await client.query<{ id: string; generation_id: string; source_identity: string; agent_id: string; display_name: string; membership_count: number }>(
      `${sql}, candidates AS MATERIALIZED (
        SELECT id,generation_id,source_identity,display_name,agent_id,count(*) OVER(PARTITION BY id)::int AS membership_count
        FROM selected_targets ORDER BY id COLLATE "C",generation_id LIMIT 100
      ), budgeted AS (
        SELECT candidates.*,sum(octet_length(to_jsonb(candidates)::text)) OVER(ORDER BY id COLLATE "C",generation_id) AS page_bytes
        FROM candidates
      ) SELECT id,generation_id,source_identity,agent_id,display_name,membership_count FROM budgeted
        WHERE page_bytes<=524288 ORDER BY id COLLATE "C",generation_id`,
    values)).rows;
  }
}
function pageLimit(value = 50) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new SelectionError("invalid_cursor");
  return value;
}
