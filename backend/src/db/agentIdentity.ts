import type pg from "pg";
import { AppError } from "../errors.js";
import { isDirectoryObjectId } from "../types/copilotPackage.js";
import type { PackageDataScope } from "./packageInventory.js";
import { pool } from "./pool.js";
import { verifiedAgentIdentityClientIdProvenance, type AgentIdentityCacheStatus, type AgentIdentityResolutionOutcome,
  type AgentIdentityRuntimeProvenance, type AgentIdentityRuntimeStatus, type VerifiedAgentIdentityIds } from "../types/agentInvestigations.js";

export type AgentIdentitySource = {
  recordId: string; snapshotId: string; nativeId: string; environmentId: string; candidateId: string; sourceRevision: string;
};
export type VerifiedAgentIdentity = {
  objectId: string; applicationId: string | null; checkedAt: string; expiresAt: string;
  runtimeStatus?: AgentIdentityRuntimeStatus; runtimeProvenance?: AgentIdentityRuntimeProvenance;
};
export type AgentIdentityCacheState = {
  status: AgentIdentityCacheStatus; value?: VerifiedAgentIdentity; checkedAt?: string; expiresAt?: string; lastErrorCode?: string;
};
export type AgentIdentityFailure = { status: Exclude<AgentIdentityResolutionOutcome, "resolved">; code: string };

const sourceWhere = `resource.tenant_id=$1 AND resource.principal_id=$2 AND resource.snapshot_id=$3
  AND resource.native_id=$4 AND resource.environment_id=$5 AND resource.resource_type='microsoft.copilotstudio/agents'
  AND resource.agent_kind='copilot_studio_agent'
  AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
  AND resource.provenance->'entraAgentId'->>'sourceSystem'='power_platform'
  AND resource.provenance->'entraAgentId'->>'path'='properties.entraAgentId'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(resource.identifiers) identifier
    WHERE identifier->>'kind'='entra_agent_id' AND lower(identifier->>'value')=$6)
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(resource.identifiers) identifier
    WHERE identifier->>'kind'='entra_agent_id' AND lower(identifier->>'value') IS DISTINCT FROM $6)`;
const sourceJoin = `FROM power_platform_inventory_resources resource
  JOIN power_platform_inventory_snapshots snapshot ON snapshot.id=resource.snapshot_id
    AND snapshot.tenant_id=resource.tenant_id AND snapshot.principal_id=resource.principal_id`;

export class AgentIdentityRepository {
  constructor(private readonly database: pg.Pool = pool) {}

  async read(scope: PackageDataScope, source: AgentIdentitySource): Promise<VerifiedAgentIdentity | null> {
    return (await this.readState(scope, source)).value ?? null;
  }

  async readState(scope: PackageDataScope, source: AgentIdentitySource): Promise<AgentIdentityCacheState> {
    const parameters = sourceParameters(scope, source);
    const { rows } = await this.database.query<{
      candidate_id: string; application_id: string | null; checked_at: Date; expires_at: Date; fresh: boolean;
      outcome: AgentIdentityResolutionOutcome; runtime_status: AgentIdentityRuntimeStatus; last_error_code: string | null;
      runtime_provenance: AgentIdentityRuntimeProvenance | null;
    }>(`
      SELECT cache.candidate_id,cache.application_id,cache.checked_at,cache.expires_at,
        cache.expires_at>clock_timestamp() AS fresh,cache.outcome,cache.runtime_status,cache.last_error_code,cache.runtime_provenance ${sourceJoin}
      JOIN agent_identity_cache cache ON cache.tenant_id=resource.tenant_id AND cache.principal_id=resource.principal_id
        AND cache.snapshot_id=resource.snapshot_id AND cache.native_id=resource.native_id AND cache.environment_id=resource.environment_id
      WHERE ${sourceWhere} AND cache.candidate_id=$6::uuid AND cache.record_id=$7 AND cache.source_revision=$8`,
    [...parameters, source.recordId, source.sourceRevision]);
    const value = rows[0];
    if (!value) return { status: "missing" };
    if (value.fresh && value.outcome === "resolved" && (value.application_id !== value.candidate_id
      || value.runtime_status !== "available" || value.runtime_provenance !== verifiedAgentIdentityClientIdProvenance)) {
      throw new AppError(409, "invalid_agent_identity_cache", "The saved mapping lacks verified Entra agent identity client-ID provenance.");
    }
    const dates = { checkedAt: value.checked_at.toISOString(), expiresAt: value.expires_at.toISOString() };
    return { status: value.fresh ? value.outcome : "expired", ...dates,
      ...(value.last_error_code ? { lastErrorCode: value.last_error_code } : {}),
      ...(value.fresh && value.outcome === "resolved" ? { value: {
        objectId: value.candidate_id, applicationId: value.application_id, runtimeStatus: value.runtime_status,
        runtimeProvenance: value.runtime_provenance ?? undefined, ...dates,
      } } : {}) };
  }

  async invalidate(scope: PackageDataScope, source: AgentIdentitySource) {
    sourceParameters(scope, source);
    await this.database.query(`DELETE FROM agent_identity_cache WHERE tenant_id=$1 AND principal_id=$2 AND record_id=$3
      AND snapshot_id=$4 AND candidate_id=$5 AND source_revision=$6`,
    [scope.tenantId, scope.principalId, source.recordId, source.snapshotId, source.candidateId, source.sourceRevision]);
  }

  async save(scope: PackageDataScope, source: AgentIdentitySource, value: VerifiedAgentIdentityIds,
    fence: () => Promise<void>) {
    sourceParameters(scope, source);
    if (value.objectId !== source.candidateId || !isDirectoryObjectId(value.objectId)
      || value.applicationId !== value.objectId || value.runtimeStatus !== "available"
      || value.runtimeProvenance !== verifiedAgentIdentityClientIdProvenance) {
      throw new AppError(502, "agent_identity_mismatch", "Only a verified typed agentIdentity can establish the same object and client ID for this source.");
    }
    return this.write(scope, source, { applicationId: value.applicationId, runtimeStatus: "available",
      runtimeProvenance: value.runtimeProvenance, outcome: "resolved", errorCode: null, ttlMs: 3_600_000 }, fence);
  }

  async saveFailure(scope: PackageDataScope, source: AgentIdentitySource, failure: AgentIdentityFailure, fence: () => Promise<void>) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(failure.code)) {
      throw new AppError(400, "invalid_agent_identity_outcome", "Identity resolution failure metadata must be a bounded diagnostic code.");
    }
    return this.write(scope, source, { applicationId: null, runtimeStatus: "unverified", runtimeProvenance: null,
      outcome: failure.status, errorCode: failure.code, ttlMs: 300_000 }, fence);
  }

  private async write(scope: PackageDataScope, source: AgentIdentitySource, value: {
    applicationId: string | null; runtimeStatus: AgentIdentityRuntimeStatus; runtimeProvenance: AgentIdentityRuntimeProvenance | null;
    outcome: AgentIdentityResolutionOutcome; errorCode: string | null; ttlMs: number;
  }, fence: () => Promise<void>) {
    const parameters = sourceParameters(scope, source);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`agent-identity:${scope.tenantId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${scope.tenantId}:${scope.principalId}`]);
      await fence();
      // Source rows are immutable to runtime; locking them would require forbidden UPDATE privileges.
      // The parent snapshot lock prevents refresh invalidation and cascading deletion until commit.
      const current = await client.query(`SELECT snapshot.id ${sourceJoin} WHERE ${sourceWhere} FOR SHARE OF snapshot`, parameters);
      if (current.rowCount !== 1) throw new AppError(409, "agent_identity_source_changed", "The current saved source changed during identity resolution. Refresh Agents.");
      await client.query(`DELETE FROM agent_identity_cache WHERE tenant_id=$1 AND (expires_at<=clock_timestamp()
        OR (principal_id=$2 AND record_id=$3))`, [scope.tenantId, scope.principalId, source.recordId]);
      const count = (await client.query<{ principal_count: number; tenant_count: number }>(`
        SELECT count(*)::int AS tenant_count,count(*) FILTER (WHERE principal_id=$2)::int AS principal_count
        FROM agent_identity_cache WHERE tenant_id=$1`, [scope.tenantId, scope.principalId])).rows[0];
      if (count.principal_count >= 1_000 || count.tenant_count >= 10_000) {
        throw new AppError(409, "agent_identity_cache_limit", "The saved identity cache is full. Retry after cached mappings expire.");
      }
      const saved = await client.query(`INSERT INTO agent_identity_cache
        (tenant_id,principal_id,snapshot_id,native_id,environment_id,candidate_id,record_id,source_revision,application_id,checked_at,expires_at,
          outcome,runtime_status,last_error_code,runtime_provenance)
        SELECT $1,$2,$3,$4,$5,$6::text::uuid,$7,$8,$9,statement_timestamp(),
          LEAST(statement_timestamp()+($13::int*interval '1 millisecond'),snapshot.expires_at),$10,$11,$12,$14
        ${sourceJoin} WHERE ${sourceWhere}`,
      [...parameters, source.recordId, source.sourceRevision, value.applicationId, value.outcome, value.runtimeStatus, value.errorCode, value.ttlMs, value.runtimeProvenance]);
      if (saved.rowCount !== 1) throw new AppError(409, "agent_identity_source_changed", "The current saved source changed or expired before identity publication. Refresh Agents.");
      await fence();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}

function sourceParameters(scope: PackageDataScope, source: AgentIdentitySource) {
  if (!scope.tenantId || !scope.principalId || !isDirectoryObjectId(source.snapshotId) || !isDirectoryObjectId(source.candidateId)
    || !source.recordId || source.recordId.length > 2_048 || !source.nativeId || source.nativeId.length > 512
    || !source.environmentId || source.environmentId.length > 512 || !/^[a-f0-9]{64}$/.test(source.sourceRevision)) {
    throw new AppError(400, "invalid_agent_identity_source", "Identity resolution requires an exact current source identity.");
  }
  return [scope.tenantId, scope.principalId, source.snapshotId, source.nativeId, source.environmentId, source.candidateId];
}
