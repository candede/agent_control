import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool } from "../db/pool.js";
import type { AuditEvent, CompleteAuditEvent, ListAuditEventsQuery, StartAuditEvent } from "../types/audit.js";

export type DataScope = { tenantId: string; principalId: string };
type Database = Pick<pg.Pool, "query">;

export function auditMetadata(value: Record<string, unknown> | undefined) {
  if (!value) return undefined;
  const result: Record<string, string | number | boolean> = {};
  for (const key of ["target", "mode", "scope", "template", "rowCount", "requestCount", "previousCount", "resultingCount", "resultingBytes", "source", "snapshotId", "jobId", "reportSetId", "reportingStart", "reportingEnd", "leaseVersion", "correlationId", "confirmationHash", "targetSelectionHash", "prestateHash", "poststateHash", "readbackCount", "reconciliationStatus", "verification"]) {
    const entry = value[key];
    if (typeof entry === "string" && entry.length <= 128 || typeof entry === "number" && Number.isFinite(entry) || typeof entry === "boolean") {
      result[key] = entry as string | number | boolean;
    }
  }
  return result;
}

export class AuditLog {
  constructor(private scope: DataScope, private database: Database = pool) {
    if (!scope.tenantId || !scope.principalId) throw new Error("Audit requires tenant and principal scope.");
  }

  async startEvent(event: StartAuditEvent) {
    if (event.actor.tenantId !== this.scope.tenantId || event.actor.homeAccountId !== this.scope.principalId) {
      throw new Error("Audit actor scope mismatch.");
    }
    const record: AuditEvent = { ...event, id: event.id ?? randomUUID(), startedAt: event.startedAt ?? new Date().toISOString(), status: "started", metadata: auditMetadata(event.metadata) };
    await this.append(record);
    return record;
  }

  async requestEvents(events: StartAuditEvent[]) {
    const records: AuditEvent[] = events.map(event => {
      if (event.actor.tenantId !== this.scope.tenantId || event.actor.homeAccountId !== this.scope.principalId) {
        throw new Error("Audit actor scope mismatch.");
      }
      return { ...event, id: event.id ?? randomUUID(), startedAt: event.startedAt ?? new Date().toISOString(), status: "requested", metadata: auditMetadata(event.metadata) } as AuditEvent;
    });
    if (!records.length) return records;
    await this.database.query(`INSERT INTO audit_events
      (id,event_id,operation_id,tenant_id,principal_id,actor_username,actor_name,scope,action,target_blocked_state,
       agent_id,agent_display_name,started_at,status,message,error_code,request_path,metadata)
      SELECT gen_random_uuid(),entry.event_id,entry.operation_id,$2,$3,entry.actor_username,entry.actor_name,entry.scope,entry.action,entry.target_blocked_state,
        entry.agent_id,entry.agent_display_name,entry.started_at,'requested',entry.message,entry.error_code,entry.request_path,entry.metadata
      FROM jsonb_to_recordset($1::jsonb) AS entry(event_id text,operation_id text,actor_username text,actor_name text,scope text,action text,
        target_blocked_state boolean,agent_id text,agent_display_name text,started_at timestamptz,message text,error_code text,request_path text,metadata jsonb)`, [JSON.stringify(records.map(record => ({
        event_id: record.id, operation_id: record.operationId, actor_username: record.actor.username, actor_name: record.actor.displayName,
        scope: record.scope, action: record.action, target_blocked_state: record.targetBlockedState ?? null, agent_id: record.agentId,
        agent_display_name: record.agentDisplayName ?? null, started_at: record.startedAt, message: record.message ?? null,
        error_code: record.errorCode ?? null, request_path: record.requestPath, metadata: record.metadata ?? null,
      }))), this.scope.tenantId, this.scope.principalId]);
    return records;
  }

  async completeEvent(id: string, update: CompleteAuditEvent) {
    const current = await this.getEvent(id);
    if (!current) throw new Error("Audit event was not found in this scope.");
    const record: AuditEvent = {
      ...current, ...update,
      completedAt: update.completedAt ?? new Date().toISOString(),
      message: update.message?.slice(0, 4096), errorCode: update.errorCode?.slice(0, 256),
      metadata: update.metadata ? auditMetadata(update.metadata) : current.metadata,
    };
    await this.append(record);
    return record;
  }

  private async append(event: AuditEvent) {
    await this.database.query(`INSERT INTO audit_events
      (id,event_id,operation_id,tenant_id,principal_id,actor_username,actor_name,scope,action,target_blocked_state,
       agent_id,agent_display_name,started_at,completed_at,status,message,error_code,request_path,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [randomUUID(), event.id, event.operationId, this.scope.tenantId, this.scope.principalId,
      event.actor.username, event.actor.displayName, event.scope, event.action, event.targetBlockedState ?? null,
      event.agentId, event.agentDisplayName ?? null, event.startedAt, event.completedAt ?? null, event.status,
      event.message ?? null, event.errorCode ?? null, event.requestPath, event.metadata ?? null]);
  }

  async getEvent(id: string) {
    const result = await this.database.query("SELECT * FROM audit_projection WHERE tenant_id=$1 AND principal_id=$2 AND event_id=$3", [this.scope.tenantId, this.scope.principalId, id]);
    return result.rows[0] ? toEvent(result.rows[0]) : undefined;
  }

  async getExportEvents(ids: string[]) {
    const result = await this.database.query(`SELECT * FROM audit_projection
      WHERE tenant_id=$1 AND principal_id=$2 AND event_id=ANY($3::text[])
        AND observed_at>clock_timestamp()-interval '90 days'
      ORDER BY array_position($3::text[],event_id)`, [this.scope.tenantId, this.scope.principalId, ids]);
    return result.rows.map(toEvent);
  }

  private filter(query: ListAuditEventsQuery) {
    const clauses = ["tenant_id=$1", "principal_id=$2"];
    const values: unknown[] = [this.scope.tenantId, this.scope.principalId];
    for (const [key, column] of Object.entries({ agentId: "agent_id", actorUsername: "actor_username", scope: "scope", action: "action", status: "status" })) {
      const value = query[key as keyof ListAuditEventsQuery];
      if (value !== undefined) { values.push(value); clauses.push(`${column}=$${values.length}`); }
    }
    if (query.operationIdPrefix) {
      values.push(escapeLike(query.operationIdPrefix) + "%");
      clauses.push(`operation_id LIKE $${values.length} ESCAPE '\\'`);
    }
    if (query.search) {
      values.push(`%${escapeLike(query.search)}%`);
      clauses.push(`concat_ws(' ',agent_id,agent_display_name,actor_username,actor_name,operation_id,message,error_code) ILIKE $${values.length} ESCAPE '\\'`);
    }
    return { sql: clauses.join(" AND "), values };
  }

  async listEvents(query: ListAuditEventsQuery = {}) {
    const filter = this.filter(query);
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 5000);
    const offset = Math.min(Math.max(Math.trunc(query.offset ?? 0), 0), 100_000);
    const result = await this.database.query(`SELECT * FROM audit_projection WHERE ${filter.sql}
      ORDER BY started_at DESC,event_id DESC LIMIT $${filter.values.length + 1} OFFSET $${filter.values.length + 2}`, [...filter.values, limit, offset]);
    return result.rows.map(toEvent);
  }

  async countEvents(query: ListAuditEventsQuery = {}) {
    const filter = this.filter(query);
    const result = await this.database.query(`SELECT count(*)::int AS count FROM audit_projection WHERE ${filter.sql}`, filter.values);
    return result.rows[0].count as number;
  }
}

function escapeLike(value: string) { return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_"); }

function toEvent(row: Record<string, unknown>): AuditEvent {
  return {
    id: row.event_id, operationId: row.operation_id, scope: row.scope, action: row.action,
    ...(row.target_blocked_state === null ? {} : { targetBlockedState: row.target_blocked_state }),
    agentId: row.agent_id, agentDisplayName: row.agent_display_name ?? undefined,
    actor: { tenantId: row.tenant_id, homeAccountId: row.principal_id, username: row.actor_username, displayName: row.actor_name },
    startedAt: (row.started_at as Date).toISOString(), completedAt: (row.completed_at as Date | null)?.toISOString(),
    status: row.status, message: row.message ?? undefined, errorCode: row.error_code ?? undefined,
    requestPath: row.request_path, metadata: row.metadata ?? undefined,
  } as AuditEvent;
}

export function getAuditLog(scope: DataScope) { return new AuditLog(scope); }