import { randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { associationSourceHash, parseRecordId } from "./agentUsageIdentity.js";
import { normalizeNativeIdentity } from "./inventoryIdentity.js";
import { digest, encodeBatch } from "../db/dataBounds.js";
import { officialReportCount as exactCount } from "../db/officialReportBounds.js";
import { reportRelationsSql } from "../db/officialReportQueries.js";
import { LargeTenantUsersReports, bounded, type ReportReadContext, type ReportCurrentData } from "./largeTenantUsersReports.js";
import type { InventoryReportSummary } from "../types/unifiedAgents.js";
import { SelectionError, type SelectionIdentity } from "./dataSelections.js";
import type { AuditActor } from "../types/audit.js";
import { AuditLog } from "./auditLog.js";
import { officialAgentUsageMutation } from "./officialAgentUsageInput.js";
import { requireAdmissions } from "./maintenance.js";
import type { CandidateAgentUsageSummary, CandidateAgentUsageMutation } from "../types/officialReportApi.js";
import { currentInventorySourcesSql, lockInventorySelection } from "../db/inventoryAuthority.js";
export type { CandidateAgentUsageContext, CandidateAgentUsageSummary, CandidateAgentUsageMutation } from "../types/officialReportApi.js";

const authorizedSourcesSql = currentInventorySourcesSql;

export class OfficialAgentUsage {
  constructor(readonly reports: LargeTenantUsersReports) {}

  private async target(client: pg.PoolClient, context: ReportReadContext, recordId: string) {
    if (context.tokenMode !== "delegated") throw new AppError(403, "agent_usage_scope_unavailable", "Agent usage requires current delegated inventory evidence.");
    const target = parseRecordId(recordId), { tenantId, principalId } = context.identity;
    const native = target.source === "graph_packages" ? target.packageId : target.source === "power_platform" ? normalizeNativeIdentity(target.nativeId) : null;
    const environment = target.source === "power_platform" ? (target.environmentId ?? "").toLowerCase() : "";
    const matches = (await client.query(`WITH sources AS (${authorizedSourcesSql})
      SELECT DISTINCT agent_id,control_revision FROM sources WHERE $5::text='canonical'
        OR source=$5 AND normalized_native_id=$6 AND normalized_environment_id=$7 LIMIT 2`,
    [tenantId, principalId, target.source === "canonical" ? target.agentId : null, context.evaluatedAt, target.source, native, environment])).rows;
    if (!matches.length) throw new AppError(404, "agent_not_found", "Exact current delegated inventory evidence is unavailable. Refresh inventory and wait for reconciliation.");
    if (matches.length !== 1) throw new AppError(409, "agent_identity_ambiguous", "The exact source belongs to multiple current agents.");
    const row = matches[0];
    const values = [tenantId, principalId, row.agent_id, context.evaluatedAt];
    const association = (await client.query("SELECT revision::text FROM agent_usage_state WHERE tenant_id=$1", [tenantId])).rows[0]?.revision ?? "0";
    return { id: row.agent_id as string, values, context: {
      selectionId: context.selection.id, reportSetId: context.report.setId,
      usageRevision: digest(JSON.stringify([context.report, association])),
      inventoryRevision: digest(JSON.stringify(["inventory-control-v1", tenantId, principalId, row.agent_id, row.control_revision])), reports: context.report,
    } };
  }

  private links(context: ReportCurrentData, agentId: string) {
    const values = this.reports.parameters(context);
    values.push(context.identity.principalId, agentId, context.evaluatedAt);
    const sourceSql = `SELECT * FROM inventory_live_sources WHERE tenant_id=$4 AND principal_id=$7 AND agent_id=$8
      AND authority_expires_at>GREATEST($9::timestamptz,clock_timestamp())`;
    return { values, sql: `${reportRelationsSql}, sources AS (${sourceSql}),
      linked AS (
        SELECT a.* FROM official_agents a WHERE a.response_source='agents' AND
        (EXISTS(SELECT 1 FROM agent_usage_associations reviewed JOIN sources s ON s.source=reviewed.source
          AND s.normalized_native_id=reviewed.normalized_native_id AND s.normalized_environment_id=reviewed.normalized_environment_id
          WHERE reviewed.tenant_id=$4 AND reviewed.report_set_id=$5 AND reviewed.report_agent_id=a.agent_id)
        OR NOT EXISTS(SELECT 1 FROM agent_usage_associations reviewed WHERE reviewed.tenant_id=$4 AND reviewed.report_set_id=$5 AND reviewed.report_agent_id=a.agent_id)
          AND EXISTS(SELECT 1 FROM sources s WHERE s.source='graph_packages' AND s.native_id=a.agent_id))
      )` };
  }

  async inventorySummaries(client: pg.PoolClient, context: ReportCurrentData, recordIds: readonly string[]): Promise<InventoryReportSummary[]> {
    if (recordIds.length > 100 || new Set(recordIds).size !== recordIds.length) throw new AppError(400, "data_exact_ids_limit", "At most 100 exact inventory IDs.");
    encodeBatch(recordIds);
    const ids = recordIds.map(recordId => {
      const target = parseRecordId(recordId);
      if (target.source !== "canonical") throw new AppError(400, "invalid_agent_usage_record", "Inventory summaries require reconciled canonical IDs.");
      return target.agentId;
    });
    if (new Set(ids).size !== ids.length) throw new AppError(400, "data_exact_ids_limit", "Exact inventory IDs must be distinct.");
    if (!ids.length) return [];
    if (!context.report.setId) return recordIds.map(recordId => ({
      recordId, reportSetId: null, status: "unavailable", responses: null, activeUsers: null, lastActivityDateUtc: null, associationCount: 0,
    }));
    const values = [...this.reports.parameters(context), context.identity.principalId, ids, context.evaluatedAt];
    encodeBatch(ids, values);
    const sourceSql = `SELECT * FROM inventory_live_sources WHERE tenant_id=$4 AND principal_id=$7 AND agent_id=ANY($8::text[])
      AND authority_expires_at>GREATEST($9::timestamptz,clock_timestamp())`;
    const { rows } = await client.query(`${reportRelationsSql}, sources AS (${sourceSql}),
      requested AS (SELECT id,ordinal FROM unnest($8::text[]) WITH ORDINALITY AS target(id,ordinal)),
      memberships AS (
        SELECT s.agent_id AS canonical_id,a.agent_id AS report_agent_id FROM sources s
        JOIN agent_usage_associations reviewed ON reviewed.source=s.source AND reviewed.normalized_native_id=s.normalized_native_id
          AND reviewed.normalized_environment_id=s.normalized_environment_id AND reviewed.tenant_id=$4 AND reviewed.report_set_id=$5
        JOIN official_agents a ON a.agent_id=reviewed.report_agent_id AND a.response_source='agents'
        UNION
        SELECT s.agent_id,a.agent_id FROM sources s JOIN official_agents a ON s.source='graph_packages' AND s.native_id=a.agent_id
          AND a.response_source='agents'
        WHERE NOT EXISTS(SELECT 1 FROM agent_usage_associations reviewed WHERE reviewed.tenant_id=$4 AND reviewed.report_set_id=$5
          AND reviewed.report_agent_id=a.agent_id)
      ), metrics AS (
        SELECT m.canonical_id,count(*) AS n,sum(a.responses) AS responses,max(a.last_activity) AS last_activity,
          bool_or(a.active_users IS NULL) AS unknown_active_users
        FROM memberships m JOIN official_agents a ON a.agent_id=m.report_agent_id GROUP BY m.canonical_id
      ), active AS (
        SELECT m.canonical_id,count(DISTINCT r.username) AS users FROM memberships m JOIN reports r
          ON r.agent_id=m.report_agent_id AND r.kind='userAgents' AND r.responses>0 GROUP BY m.canonical_id
      )
      SELECT requested.id::text AS id,COALESCE(metrics.n,0)::text AS n,metrics.responses::text,metrics.last_activity::text,
        CASE WHEN metrics.n IS NULL OR metrics.unknown_active_users THEN NULL ELSE COALESCE(active.users,0) END::text AS active_users
      FROM requested LEFT JOIN metrics ON metrics.canonical_id=requested.id LEFT JOIN active ON active.canonical_id=requested.id
      ORDER BY requested.ordinal`, values);
    encodeBatch(rows);
    if (rows.length !== ids.length) throw new AppError(500, "agent_usage_projection_incomplete", "Exact inventory summaries were incomplete.");
    return bounded(recordIds.map((recordId, index): InventoryReportSummary => {
      const row = rows[index];
      if (row.id !== ids[index]) throw new AppError(500, "agent_usage_projection_incomplete", "Exact inventory summary identity changed.");
      const count = exactCount(row.n);
      return { recordId, reportSetId: context.report.setId, status: count ? "linked" : "unlinked",
        responses: row.responses === null ? null : exactCount(row.responses), activeUsers: row.active_users === null || !count ? null : exactCount(row.active_users),
        lastActivityDateUtc: row.last_activity === null ? null : new Date(row.last_activity).toISOString(), associationCount: count };
    }));
  }

  summaries(selectionId: string, identity: SelectionIdentity, recordIds: readonly string[]) {
    if (recordIds.length > 100 || new Set(recordIds).size !== recordIds.length) throw new AppError(400, "data_exact_ids_limit", "At most 100 unique exact agent IDs.");
    encodeBatch(recordIds);
    return this.reports.read(selectionId, identity, async (client, context) => {
      const results: CandidateAgentUsageSummary[] = [];
      for (const recordId of recordIds) {
        const target = await this.target(client, context, recordId), { sql, values } = this.links(context, target.id);
        const row = (await client.query(`${sql} SELECT count(*)::text AS n,sum(responses)::text AS responses,max(last_activity)::text AS last_activity,
          CASE WHEN bool_or(active_users IS NULL) THEN NULL ELSE
            (SELECT count(DISTINCT username) FROM reports WHERE kind='userAgents' AND responses>0 AND agent_id IN(SELECT agent_id FROM linked)) END::text AS active_users
          FROM linked`, values)).rows[0];
        const count = exactCount(row.n);
        results.push({ recordId, status: !context.report.setId ? "unavailable" : count ? "linked" : "unlinked",
          responses: row.responses === null ? null : exactCount(row.responses), activeUsers: row.active_users === null || !count ? null : exactCount(row.active_users),
          lastActivityDateUtc: row.last_activity === null ? null : new Date(row.last_activity).toISOString(), associationCount: count, context: target.context });
      }
      return bounded(results);
    });
  }

  candidates(selectionId: string, identity: SelectionIdentity, recordId: string, options: { limit?: number; cursor?: string; inventoryRevision?: string }) {
    return this.reports.read(selectionId, identity, async (client, context) => {
      if (context.endpoint !== "official_agents") throw new AppError(400, "agent_usage_selection", "Candidates require an official_agents selection.");
      const target = await this.target(client, context, recordId);
      if (options.cursor && options.inventoryRevision !== target.context.inventoryRevision) throw new AppError(409, "inventory_changed", "Exact source references changed.");
      const bound = { ...context, queryHash: digest(JSON.stringify([context.queryHash, recordId, target.context])) };
      const page = await this.reports.rowsInRead(client, bound, { ...options, officialAgentsOnly: true });
      const ids = page.raw.map(row => row.agent_id as string);
      const associated = (await client.query(`SELECT report_agent_id FROM agent_usage_associations WHERE tenant_id=$1 AND report_set_id=$2 AND report_agent_id=ANY($3::text[])`,
        [identity.tenantId, context.report.setId, ids])).rows.map(row => row.report_agent_id as string);
      return bounded({ value: page.value.map((row, index) => ({ ...row, associated: associated.includes(ids[index]) })),
        page: page.page, counts: page.counts, selection: context.selection, context: target.context });
    });
  }

  associations(selectionId: string, identity: SelectionIdentity, recordId: string, options: { limit?: number; cursor?: string }) {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, "invalid_cursor", "Page limit must be 1..100.");
    return this.reports.read(selectionId, identity, async (client, context) => {
      const target = await this.target(client, context, recordId), { sql, values } = this.links(context, target.id);
      const expected = { identity, endpoint: "agent-usage-associations", selectionId, revision: context.selection.revision,
        queryHash: digest(JSON.stringify([recordId, target.context])) };
      const cursor = options.cursor ? this.reports.codec.decode(options.cursor, expected) : undefined, previous = cursor?.direction === "previous";
      const count = exactCount((await client.query(`${sql} SELECT count(*)::text AS n FROM linked`, values)).rows[0].n);
      values.push(cursor?.boundary.id ?? "", limit + 1);
      const rows = (await client.query(`${sql} SELECT a.agent_id,a.name,a.responses::text,
        CASE WHEN reviewed.report_agent_id IS NULL THEN 'exact_package_id' ELSE 'reviewed' END AS basis,
        s.source,s.native_id,s.environment_id,s.package_snapshot_id,s.power_platform_snapshot_id
        FROM linked a LEFT JOIN agent_usage_associations reviewed ON reviewed.tenant_id=$4 AND reviewed.report_set_id=$5 AND reviewed.report_agent_id=a.agent_id
        JOIN sources s ON (reviewed.report_agent_id IS NOT NULL AND s.source=reviewed.source AND s.normalized_native_id=reviewed.normalized_native_id
          AND s.normalized_environment_id=reviewed.normalized_environment_id OR reviewed.report_agent_id IS NULL AND s.source='graph_packages' AND s.native_id=a.agent_id)
        WHERE a.agent_id COLLATE "C" ${previous ? "<" : ">"} $10::text COLLATE "C"
        ORDER BY a.agent_id COLLATE "C" ${previous ? "DESC" : "ASC"} LIMIT $11`, values)).rows;
      encodeBatch(rows);
      const more = rows.length > limit, page = rows.slice(0, limit);
      if (previous) page.reverse();
      const encode = (row: pg.QueryResultRow, direction: "next" | "previous") => this.reports.codec.encode({ ...expected, direction,
        boundary: { key: row.agent_id, id: row.agent_id, nullRank: 0 } });
      return bounded({ value: page.map(row => ({ reportAgentId: row.agent_id as string, agentName: row.name as string, responses: exactCount(row.responses),
        basis: row.basis as "reviewed" | "exact_package_id",
        target: row.source === "graph_packages" ? { source: "graph_packages" as const, packageId: row.native_id as string, snapshotId: row.package_snapshot_id as string }
          : { source: "power_platform" as const, nativeId: row.native_id as string, environmentId: row.environment_id as string, snapshotId: row.power_platform_snapshot_id as string } })),
      context: target.context, counts: { total: count, filtered: count }, page: { limit,
        nextCursor: page.length && (previous ? Boolean(cursor) : more) ? encode(page.at(-1)!, "next") : null,
        previousCursor: page.length && (previous ? more : Boolean(cursor)) ? encode(page[0], "previous") : null } });
    });
  }

  async mutate(identity: SelectionIdentity, recordId: string, input: CandidateAgentUsageMutation, actor: AuditActor) {
    if (actor.tenantId !== identity.tenantId || actor.homeAccountId !== identity.principalId) throw AppError.unauthorized();
    requireAdmissions();
    input = officialAgentUsageMutation(input);
    parseRecordId(recordId);
    const metadata = { source: "official_usage", selection: "admin_reviewed", reportSetId: input.reportSetId,
      reportAgentHash: digest(input.reportAgentId), revision: input.usageRevision, inventoryRevision: input.inventoryRevision };
    const audit = new AuditLog(identity, this.reports.database);
    const event = await audit.startEvent({ operationId: `agent-usage:${randomUUID()}`, scope: "single",
      action: input.target ? "associate-agent-usage" : "remove-agent-usage-association", agentId: recordId, actor,
      requestPath: "/api/agents/usage-association", metadata });
    // Ordinary writer transaction; all source locks precede the selected read fences.
    try { return await this.reports.history.connections.run(async client => {
      await lockInventorySelection(client, identity, input.selectionId);
      await this.reports.selections.assert(client, input.selectionId, identity);
      const context = await this.reports.contextInRead(client, identity, input.selectionId);
      const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
      const active = (await client.query("SELECT active_set_id FROM official_usage_state WHERE tenant_id=$1 FOR UPDATE", [identity.tenantId])).rows[0];
      const target = await this.target(client, { ...context, evaluatedAt: now }, recordId);
      if (active?.active_set_id !== input.reportSetId || context.report.setId !== input.reportSetId || target.context.usageRevision !== input.usageRevision) throw new AppError(409, "agent_usage_changed", "Report or associations changed.");
      if (target.context.inventoryRevision !== input.inventoryRevision) throw new AppError(409, "inventory_changed", "Exact inventory source references changed.");
      const report = await client.query(`${reportRelationsSql} SELECT identity FROM official_agents WHERE agent_id=$7 AND response_source='agents'`,
        [...this.reports.parameters(context), input.reportAgentId]);
      if (!report.rowCount) throw new AppError(404, "usage_report_agent_not_found", "Exact Agents export identity is absent.");
      const sources = authorizedSourcesSql;
      const existing = (await client.query(`SELECT * FROM agent_usage_associations WHERE tenant_id=$1 AND report_set_id=$2 AND report_agent_id=$3`,
        [identity.tenantId, input.reportSetId, input.reportAgentId])).rows[0];
      let changed = false;
      let targetSelectionHash: string;
      if (input.target) {
        const nativeId = input.target.source === "graph_packages" ? input.target.packageId : normalizeNativeIdentity(input.target.nativeId);
        const environment = input.target.source === "graph_packages" ? "" : (input.target.environmentId ?? "").toLowerCase();
        const found = (await client.query(`WITH sources AS (${sources}) SELECT source,native_id,environment_id,normalized_native_id,normalized_environment_id
          FROM sources WHERE source=$5 AND normalized_native_id=$6 AND normalized_environment_id=$7`,
          [...target.values, input.target.source, nativeId, environment])).rows[0];
        if (!found) throw new AppError(403, "usage_target_mismatch", "Source does not belong to the authorized current agent.");
        targetSelectionHash = associationSourceHash(found);
        if (existing && (existing.source !== found.source || existing.normalized_native_id !== found.normalized_native_id
          || existing.normalized_environment_id !== found.normalized_environment_id)) throw new AppError(409, "usage_association_conflict", "Remove the existing reviewed mapping before reassigning.");
        if (!existing) {
          await client.query(`INSERT INTO agent_usage_associations(tenant_id,report_set_id,report_agent_id,source,native_id,environment_id,reviewed_by)
            VALUES($1,$2,$3,$4,$5,$6,$7)`, [identity.tenantId, input.reportSetId, input.reportAgentId, found.source, found.native_id, found.environment_id, identity.principalId]);
          changed = true;
        }
      } else {
        if (!existing || !(await client.query(`WITH sources AS (${sources}) SELECT 1 FROM sources WHERE source=$5 AND normalized_native_id=$6 AND normalized_environment_id=$7`,
          [...target.values, existing.source, existing.normalized_native_id, existing.normalized_environment_id])).rowCount) throw new AppError(404, "usage_association_not_found", "Reviewed mapping does not belong to this exact agent.");
        targetSelectionHash = associationSourceHash(existing);
        await client.query("DELETE FROM agent_usage_associations WHERE tenant_id=$1 AND report_set_id=$2 AND report_agent_id=$3", [identity.tenantId, input.reportSetId, input.reportAgentId]);
        changed = true;
      }
      const resulting = await this.target(client, { ...context, evaluatedAt: now }, recordId);
      await new AuditLog(identity, client).completeEvent(event.id, { status: "succeeded",
        metadata: { ...metadata, changed, revision: resulting.context.usageRevision, targetSelectionHash } });
      await this.reports.selections.assert(client, input.selectionId, identity);
      return (await this.target(client, { ...context, evaluatedAt: now }, recordId)).context;
    }); } catch (error) {
      if ((await audit.getEvent(event.id))?.status !== "succeeded") await audit.completeEvent(event.id, {
        status: "failed", errorCode: error instanceof AppError || error instanceof SelectionError ? error.code : "agent_usage_association_failed",
      });
      throw error;
    }
  }

  packagesInRead(client: pg.PoolClient, context: ReportReadContext, references: readonly { snapshotId: string; nativeId: string }[]) {
    if (context.tokenMode !== "delegated") throw new AppError(403, "agent_usage_scope_unavailable", "Package evidence requires delegated scope.");
    if (references.length > 100) throw new AppError(400, "data_exact_ids_limit", "At most 100 exact package references.");
    const batch = encodeBatch(references, [context.identity.tenantId, context.identity.principalId, context.evaluatedAt]);
    return client.query(`SELECT r.generation_id AS snapshot_id,r.native_id,r.display_name,(r.residual->>'isBlocked')::boolean AS is_blocked,
      r.publisher,r.residual->>'availableTo' AS available_to,r.residual->>'deployedTo' AS deployed_to
      FROM jsonb_to_recordset($4::jsonb) ref("snapshotId" uuid,"nativeId" text)
      JOIN package_record_rows r ON r.generation_id=ref."snapshotId" AND r.native_id=ref."nativeId"
      JOIN data_scope_epochs s ON s.id=r.scope_id JOIN inventory_roots root ON root.scope_id=s.id AND root.current
      JOIN data_generations g ON g.id=r.generation_id
      JOIN inventory_memberships m ON m.baseline_id=root.baseline_id AND m.generation_id=r.generation_id AND m.identity=r.identity
        AND m.valid_from_revision<=root.revision AND (m.valid_to_revision IS NULL OR m.valid_to_revision>root.revision)
      WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.token_mode='delegated' AND g.scope_epoch=s.epoch
        AND g.session_epoch=s.session_epoch AND r.expires_at>GREATEST($3,clock_timestamp())`,
    [context.identity.tenantId, context.identity.principalId, context.evaluatedAt, batch.json]).then(result => { encodeBatch(result.rows); return result.rows; });
  }
}
