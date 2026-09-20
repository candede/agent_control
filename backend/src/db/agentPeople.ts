import { randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { isDirectoryObjectId } from "../types/copilotPackage.js";
import type { SavedAgentPerson } from "../types/unifiedAgents.js";
import { requireUserPublication, type DataSyncScope, type UserSourcePublication } from "./dataSync.js";
import { pool, transaction } from "./pool.js";

export type AgentPersonObservation = {
  objectId: string;
  status: "resolved" | "not_found" | "lookup_failed";
  displayName: string | null;
  userPrincipalName: string | null;
  checkedAt: string;
  errorCode?: string;
};

type CacheRow = {
  object_id: string;
  status: AgentPersonObservation["status"];
  display_name: string | null;
  user_principal_name: string | null;
  checked_at: Date;
  resolved_at: Date | null;
  expires_at: Date;
  error_code: string | null;
};

export class AgentPeopleRepository {
  constructor(private readonly database: pg.Pool = pool) {}

  async generation(scope: DataSyncScope, database: Pick<pg.Pool, "query"> = this.database) {
    validateScope(scope);
    const result = await database.query<{ generation: string }>(`SELECT coalesce(
      (SELECT id::text FROM data_sync_runs WHERE tenant_id=$1 AND principal_id=$2 AND clear_saved_data
        ORDER BY started_at DESC,id DESC LIMIT 1),'initial') AS generation`, [scope.tenantId, scope.principalId]);
    return result.rows[0].generation;
  }

  async referencedIds(scope: DataSyncScope): Promise<string[]> {
    validateScope(scope);
    const result = await this.database.query<{ id: string }>(`SELECT DISTINCT lower(person.id) AS id
      FROM power_platform_inventory_resources resource
      JOIN power_platform_inventory_snapshots snapshot
        ON snapshot.id=resource.snapshot_id AND snapshot.tenant_id=resource.tenant_id
        AND snapshot.principal_id=resource.principal_id AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
      CROSS JOIN LATERAL (VALUES (resource.created_by),(resource.details->>'ownerId'),
        (resource.details->>'lastModifiedBy')) person(id)
      WHERE resource.tenant_id=$1 AND resource.principal_id=$2 AND resource.resource_type='microsoft.copilotstudio/agents'
        AND person.id IS NOT NULL
      ORDER BY id LIMIT 10001`, [scope.tenantId, scope.principalId]);
    if (result.rows.length > 10_000) throw new AppError(413, "agent_people_limit", "Agent people exceed the 10,000-identity sync limit.");
    return result.rows.map(row => row.id).filter(isDirectoryObjectId);
  }

  async read(scope: DataSyncScope, ids: readonly string[], database: Pick<pg.Pool, "query"> = this.database): Promise<SavedAgentPerson[]> {
    validateScope(scope);
    const requested = validIds(ids);
    if (!requested.length) return [];
    const result = await database.query<CacheRow>(`SELECT object_id,status,display_name,user_principal_name,
        checked_at,resolved_at,expires_at,error_code FROM agent_people_cache
      WHERE tenant_id=$1 AND principal_id=$2 AND object_id=ANY($3::uuid[]) AND expires_at>clock_timestamp()`,
    [scope.tenantId, scope.principalId, requested]);
    return result.rows.map(row => ({
      objectId: row.object_id, status: row.status, displayName: row.display_name,
      userPrincipalName: row.user_principal_name, observedAt: (row.resolved_at ?? row.checked_at).toISOString(),
      checkedAt: row.checked_at.toISOString(), expiresAt: row.expires_at.toISOString(),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    }));
  }

  async save(scope: DataSyncScope, observations: readonly AgentPersonObservation[],
    context: { generation: string; publication?: UserSourcePublication; signal?: AbortSignal }) {
    validateScope(scope);
    if (!observations.length || observations.length > 500) throw new AppError(400, "invalid_agent_people", "Save between 1 and 500 exact user observations.");
    const ids = validIds(observations.map(value => value.objectId));
    if (ids.length !== observations.length) throw new AppError(400, "invalid_agent_people", "User observations must be distinct.");
    for (const value of observations) {
      if (!["resolved", "not_found", "lookup_failed"].includes(value.status)
        || !Number.isFinite(Date.parse(value.checkedAt))
        || !boundedText(value.displayName, 512) || !boundedText(value.userPrincipalName, 320)
        || (value.status === "lookup_failed" ? !value.errorCode || !/^[a-z][a-z0-9_]{0,127}$/.test(value.errorCode) : value.errorCode !== undefined)
        || (value.status !== "resolved" && (value.displayName !== null || value.userPrincipalName !== null))) {
        throw new AppError(400, "invalid_agent_people", "The directory observation is invalid.");
      }
    }
    return transaction(this.database, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${scope.tenantId}:${scope.principalId}`]);
      if (await this.generation(scope, client) !== context.generation) {
        throw new AppError(409, "dataset_invalidated", "Saved data was cleared while resolving agent people. Reload Agents.");
      }
      if (context.publication) await requireUserPublication(client, scope, context.publication);
      const count = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM agent_people_cache
        WHERE tenant_id=$1 AND principal_id=$2 AND NOT(object_id=ANY($3::uuid[]))`,
      [scope.tenantId, scope.principalId, ids]);
      if (count.rows[0].count + ids.length > 100_000) throw new AppError(413, "agent_people_limit", "The saved people cache exceeded its identity limit.");
      for (const value of observations) {
        const days = value.status === "resolved" ? 7 : value.status === "not_found" ? 1 : 1 / 96;
        await client.query(`INSERT INTO agent_people_cache(tenant_id,principal_id,object_id,revision,status,
            display_name,user_principal_name,checked_at,resolved_at,expires_at,error_code)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $5='resolved' THEN $8::timestamptz ELSE NULL END,
            $8::timestamptz + $9 * interval '1 day',$10)
          ON CONFLICT (tenant_id,principal_id,object_id) DO UPDATE SET
            revision=EXCLUDED.revision,status=EXCLUDED.status,checked_at=EXCLUDED.checked_at,
            expires_at=EXCLUDED.expires_at,error_code=EXCLUDED.error_code,
            display_name=CASE WHEN EXCLUDED.status='lookup_failed' THEN agent_people_cache.display_name ELSE EXCLUDED.display_name END,
            user_principal_name=CASE WHEN EXCLUDED.status='lookup_failed' THEN agent_people_cache.user_principal_name ELSE EXCLUDED.user_principal_name END,
            resolved_at=CASE WHEN EXCLUDED.status='lookup_failed' THEN agent_people_cache.resolved_at ELSE EXCLUDED.resolved_at END
          WHERE agent_people_cache.checked_at<=EXCLUDED.checked_at`,
        [scope.tenantId, scope.principalId, value.objectId.toLowerCase(), randomUUID(), value.status,
          value.displayName, value.userPrincipalName, value.checkedAt, days, value.errorCode ?? null]);
      }
    }, context.signal);
  }
}

function validateScope(scope: DataSyncScope) {
  if (!scope.tenantId || !scope.principalId || scope.tenantId.length > 128 || scope.principalId.length > 256) {
    throw new AppError(403, "scope_mismatch", "Agent people require an exact tenant and account scope.");
  }
}

function validIds(ids: readonly string[]) {
  if (ids.length > 100_000 || ids.some(id => !isDirectoryObjectId(id))) {
    throw new AppError(400, "invalid_agent_people", "Agent people require bounded native user IDs.");
  }
  return [...new Set(ids.map(id => id.toLowerCase()))];
}

function boundedText(value: string | null, limit: number) {
  return value === null || typeof value === "string" && Boolean(value.trim()) && value.length <= limit && !/[\r\n\0]/.test(value);
}
