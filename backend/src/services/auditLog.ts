import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import type {
  AuditEvent,
  CompleteAuditEvent,
  ListAuditEventsQuery,
  StartAuditEvent,
} from "../types/audit.js";

const defaultListLimit = 100;
const maxListLimit = 5_000;

type AuditEventsFilter = {
  where: string;
  values: Array<string | number>;
};

type AuditEventRow = {
  id: string;
  operation_id: string;
  scope: AuditEvent["scope"];
  action: AuditEvent["action"];
  target_blocked_state: 0 | 1;
  agent_id: string;
  agent_display_name: string | null;
  actor_username: string;
  actor_display_name: string;
  actor_home_account_id: string;
  tenant_id: string | null;
  started_at: string;
  completed_at: string | null;
  status: AuditEvent["status"];
  message: string | null;
  error_code: string | null;
  request_path: string;
  metadata_json: string | null;
};

export class AuditLog {
  private database: DatabaseSync;

  constructor(databasePath = config.auditLog.databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.initialize();
  }

  startEvent(event: StartAuditEvent) {
    const auditEvent: AuditEvent = {
      ...event,
      id: event.id ?? randomUUID(),
      startedAt: event.startedAt ?? new Date().toISOString(),
      status: "started",
    };

    this.database
      .prepare(
        `INSERT INTO audit_events (
          id,
          operation_id,
          scope,
          action,
          target_blocked_state,
          agent_id,
          agent_display_name,
          actor_username,
          actor_display_name,
          actor_home_account_id,
          tenant_id,
          started_at,
          status,
          request_path,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        auditEvent.id,
        auditEvent.operationId,
        auditEvent.scope,
        auditEvent.action,
        auditEvent.targetBlockedState ? 1 : 0,
        auditEvent.agentId,
        auditEvent.agentDisplayName ?? null,
        auditEvent.actor.username,
        auditEvent.actor.displayName,
        auditEvent.actor.homeAccountId,
        auditEvent.actor.tenantId ?? null,
        auditEvent.startedAt,
        auditEvent.status,
        auditEvent.requestPath,
        stringifyMetadata(auditEvent.metadata),
      );

    return auditEvent;
  }

  completeEvent(id: string, update: CompleteAuditEvent) {
    const result = this.database
      .prepare(
        `UPDATE audit_events
        SET completed_at = ?,
            status = ?,
            message = ?,
            error_code = ?,
            metadata_json = COALESCE(?, metadata_json)
        WHERE id = ?`,
      )
      .run(
        update.completedAt ?? new Date().toISOString(),
        update.status,
        update.message ?? null,
        update.errorCode ?? null,
        stringifyMetadata(update.metadata),
        id,
      );

    if (result.changes === 0) {
      throw new Error(`Audit event ${id} was not found.`);
    }

    const auditEvent = this.getEvent(id);

    if (!auditEvent) {
      throw new Error(`Audit event ${id} could not be loaded after update.`);
    }

    return auditEvent;
  }

  getEvent(id: string) {
    const row = this.database
      .prepare("SELECT * FROM audit_events WHERE id = ?")
      .get(id) as AuditEventRow | undefined;

    return row ? toAuditEvent(row) : undefined;
  }

  listEvents(query: ListAuditEventsQuery = {}) {
    const filter = auditEventsFilter(query);
    const values = [
      ...filter.values,
      normalizeLimit(query.limit),
      normalizeOffset(query.offset),
    ];
    const rows = this.database
      .prepare(
        `SELECT * FROM audit_events ${filter.where}
        ORDER BY started_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      )
      .all(...values) as AuditEventRow[];

    return rows.map(toAuditEvent);
  }

  countEvents(query: ListAuditEventsQuery = {}) {
    const filter = auditEventsFilter(query);
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM audit_events ${filter.where}`)
      .get(...filter.values) as { count: number };

    return row.count;
  }

  close() {
    this.database.close();
  }

  private initialize() {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        action TEXT NOT NULL,
        target_blocked_state INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        agent_display_name TEXT,
        actor_username TEXT NOT NULL,
        actor_display_name TEXT NOT NULL,
        actor_home_account_id TEXT NOT NULL,
        tenant_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        message TEXT,
        error_code TEXT,
        request_path TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_events_started_at
        ON audit_events(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_events_agent_id
        ON audit_events(agent_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_events_actor_username
        ON audit_events(actor_username, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_events_operation_id
        ON audit_events(operation_id);
    `);
  }
}

let defaultAuditLog: AuditLog | undefined;

export function getAuditLog() {
  if (!config.auditLog.enabled) {
    return undefined;
  }

  defaultAuditLog ??= new AuditLog();
  return defaultAuditLog;
}

function normalizeLimit(limit: number | undefined) {
  if (!limit || Number.isNaN(limit)) {
    return defaultListLimit;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), maxListLimit);
}

function normalizeOffset(offset: number | undefined) {
  if (!offset || Number.isNaN(offset)) {
    return 0;
  }

  return Math.max(Math.trunc(offset), 0);
}

function auditEventsFilter(query: ListAuditEventsQuery): AuditEventsFilter {
  const clauses: string[] = [];
  const values: Array<string | number> = [];

  if (query.agentId) {
    clauses.push("agent_id = ?");
    values.push(query.agentId);
  }

  if (query.actorUsername) {
    clauses.push("actor_username = ?");
    values.push(query.actorUsername);
  }

  if (query.scope) {
    clauses.push("scope = ?");
    values.push(query.scope);
  }

  if (query.operationIdPrefix) {
    clauses.push("operation_id LIKE ? ESCAPE '\\'");
    values.push(`${escapeLikePrefix(query.operationIdPrefix)}%`);
  }

  if (query.action) {
    clauses.push("action = ?");
    values.push(query.action);
  }

  if (query.status) {
    clauses.push("status = ?");
    values.push(query.status);
  }

  if (query.search) {
    clauses.push(`(
      agent_id LIKE ? ESCAPE '\\'
      OR agent_display_name LIKE ? ESCAPE '\\'
      OR actor_username LIKE ? ESCAPE '\\'
      OR actor_display_name LIKE ? ESCAPE '\\'
      OR operation_id LIKE ? ESCAPE '\\'
      OR message LIKE ? ESCAPE '\\'
      OR error_code LIKE ? ESCAPE '\\'
    )`);
    const searchPattern = `%${escapeLikePrefix(query.search)}%`;
    values.push(
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
    );
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function stringifyMetadata(metadata: Record<string, unknown> | undefined) {
  if (!metadata) {
    return null;
  }

  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(metadata, (_key, value) => {
      if (typeof value === "bigint") {
        return value.toString();
      }

      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }

      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }

        seen.add(value);
      }

      return value;
    });
  } catch (error) {
    return JSON.stringify({
      serializationError:
        error instanceof Error ? error.message : "Unable to serialize metadata",
    });
  }
}

function parseMetadata(metadataJson: string | null) {
  if (!metadataJson) {
    return undefined;
  }

  try {
    return JSON.parse(metadataJson) as Record<string, unknown>;
  } catch {
    return { raw: metadataJson };
  }
}

function escapeLikePrefix(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    operationId: row.operation_id,
    scope: row.scope,
    action: row.action,
    targetBlockedState: row.target_blocked_state === 1,
    agentId: row.agent_id,
    agentDisplayName: row.agent_display_name ?? undefined,
    actor: {
      username: row.actor_username,
      displayName: row.actor_display_name,
      homeAccountId: row.actor_home_account_id,
      tenantId: row.tenant_id ?? undefined,
    },
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    status: row.status,
    message: row.message ?? undefined,
    errorCode: row.error_code ?? undefined,
    requestPath: row.request_path,
    metadata: parseMetadata(row.metadata_json),
  };
}
