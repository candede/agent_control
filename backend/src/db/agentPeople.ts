import type pg from "pg";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import { config } from "../config.js";
import { dataConnections } from "./dataConnections.js";
import { SelectionError } from "../services/dataSelections.js";
import { UserSourcesRepository, userSourceObjectIds } from "./userSources.js";
import { requireUserPublication, type DataSyncScope, type UserSourcePublication } from "./dataSync.js";
import type { SavedAgentPerson } from "../types/unifiedAgents.js";
import { pool } from "./pool.js";
import { currentNativeInventorySql } from "./inventoryIdentityQueries.js";

export type AgentPersonObservation = { objectId: string; status: "resolved" | "not_found" | "lookup_failed";
  displayName: string | null; userPrincipalName: string | null; checkedAt: string; errorCode?: string };
export type CachedAgentPerson = SavedAgentPerson & { lastConclusiveAt: string | null };
export type AgentPeopleGeneration = Readonly<{ sessionEpoch: string; scopeId: string; scopeEpoch: string }>;

export class AgentPeopleRepository {
  constructor(private readonly database: pg.Pool = pool) {}
  generation(scope: DataSyncScope): Promise<AgentPeopleGeneration> {
    return dataConnections(this.database).run(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`data-sync:${scope.tenantId}:${scope.principalId}`]);
      await client.query("INSERT INTO data_principal_epochs(tenant_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [scope.tenantId, scope.principalId]);
      const principal = (await client.query("SELECT epoch FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2 FOR UPDATE",
        [scope.tenantId, scope.principalId])).rows[0];
      const state = (await client.query(`INSERT INTO data_scope_epochs
        (id,tenant_id,scope_kind,principal_id,token_mode,source,selector,session_epoch)
        VALUES($1,$2,'principal',$3,'delegated','agent_people','cache',$4)
        ON CONFLICT(tenant_id,scope_kind,principal_id,token_mode,source,selector)
        DO UPDATE SET session_epoch=EXCLUDED.session_epoch RETURNING id,epoch`,
      [randomUUID(), scope.tenantId, scope.principalId, principal.epoch])).rows[0];
      return Object.freeze({ sessionEpoch: principal.epoch, scopeId: state.id, scopeEpoch: state.epoch });
    });
  }
  async referencedIds(scope: DataSyncScope, after = ""): Promise<string[]> {
    const result = await dataConnections(this.database).selectedRead(client => client.query<{ id: string }>(`${currentNativeInventorySql}
      SELECT DISTINCT lower(person.value) COLLATE "C" AS id FROM native resource
      JOIN inventory_facts person ON person.generation_id=resource.generation_id AND person.identity=resource.identity
        AND person.kind IN ('person:owner','person:createdBy','person:lastModifiedBy')
      WHERE person.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND lower(person.value) COLLATE "C">$4::text COLLATE "C" ORDER BY id LIMIT 100`,
    [scope.tenantId, scope.principalId, ["microsoft.copilotstudio/agents"], after]));
    return result.rows.map(row => row.id);
  }
  async directoryIds(scope: DataSyncScope, ids: readonly string[]): Promise<string[]> {
    const requested = userSourceObjectIds(ids);
    const rows = await this.database.query<{ identity: string }>(`SELECT d.identity FROM directory_user_rows d
      JOIN data_scope_epochs s ON s.id=d.scope_id AND s.tenant_id=d.tenant_id
      JOIN data_generation_heads h ON h.scope_id=s.id AND h.generation_id=d.generation_id
      JOIN data_generations g ON g.id=d.generation_id AND g.expires_at>clock_timestamp() AND g.state='published'
      WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.token_mode='delegated' AND s.source='directory'
        AND d.identity=ANY($3::text[]) LIMIT 100`, [scope.tenantId, scope.principalId, requested]);
    return rows.rows.map(row => row.identity);
  }
  async read(scope: DataSyncScope, ids: readonly string[], database: Pick<pg.Pool, "query"> = this.database): Promise<CachedAgentPerson[]> {
    const requested = userSourceObjectIds(ids);
    if (!requested.length) return [];
    const result = await database.query(`SELECT object_id,status,display_name,user_principal_name,checked_at,resolved_at,expires_at,error_code
      FROM agent_people_cache WHERE tenant_id=$1 AND principal_id=$2 AND object_id=ANY($3::uuid[]) AND expires_at>clock_timestamp() LIMIT 100`,
    [scope.tenantId, scope.principalId, requested]);
    return result.rows.map(row => ({ objectId: row.object_id, status: row.status, displayName: row.display_name,
      userPrincipalName: row.user_principal_name, observedAt: (row.resolved_at ?? row.checked_at).toISOString(),
      checkedAt: row.checked_at.toISOString(), expiresAt: row.expires_at.toISOString(),
      lastConclusiveAt: (row.status === "not_found" ? row.checked_at : row.resolved_at)?.toISOString() ?? null,
      ...(row.error_code ? { errorCode: row.error_code } : {}) }));
  }
  save(scope: DataSyncScope, observations: readonly AgentPersonObservation[],
    context: { generation: AgentPeopleGeneration; publication?: UserSourcePublication; signal?: AbortSignal; fence?: () => void }) {
    if (!observations.length) throw new AppError(400, "invalid_agent_people", "Save at least one exact observation.");
    return new UserSourcesRepository(this.database, config.sessionSecret).savePeople({
      ...scope, sessionEpoch: context.generation.sessionEpoch, authorizationHash: "internal-people-observation",
    }, observations, async client => {
      context.signal?.throwIfAborted(); context.fence?.();
      const current = (await client.query(`SELECT id FROM data_scope_epochs WHERE id=$1 AND tenant_id=$2 AND principal_id=$3
        AND scope_kind='principal' AND token_mode='delegated' AND source='agent_people' AND selector='cache'
        AND epoch=$4 AND session_epoch=$5 FOR UPDATE`,
      [context.generation.scopeId, scope.tenantId, scope.principalId,
        context.generation.scopeEpoch, context.generation.sessionEpoch])).rows[0];
      if (!current) throw new SelectionError("selection_invalidated");
      if (context.publication) await requireUserPublication(client, scope, context.publication);
    });
  }
}
