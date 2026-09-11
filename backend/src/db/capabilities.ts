import { createHash } from "node:crypto";
import type pg from "pg";
import { pool } from "./pool.js";
import type { CapabilityDefinition, CapabilityId, CapabilityStatus, TokenMode } from "../types/capability.js";

export type CapabilityConfiguration = {
  enabled: boolean;
  sharedDataScope: boolean;
  previewQualified: boolean;
  revision: number;
  updatedAt?: string;
};

export type CapabilityEvidence = {
  status: CapabilityStatus;
  details: Record<string, unknown>;
  observedAt: string;
  expiresAt: string;
  lastSuccessAt?: string;
};

export type EvidenceKey = {
  tenantId: string;
  principalId: string;
  authorizationPrincipalId: string;
  capabilityId: CapabilityId;
  resourceAudience: string;
  environmentId: string;
  tokenMode: Exclude<TokenMode, "local">;
  permissionRevision: string;
  contractRevision: string;
  configurationRevision: number;
};

type ConfigurationRow = {
  enabled: boolean;
  shared_data_scope: boolean;
  preview_qualified: boolean;
  revision: number;
  updated_at: Date;
};

type EvidenceRow = {
  status: CapabilityStatus;
  details: Record<string, unknown>;
  observed_at: Date;
  expires_at: Date;
  last_success_at: Date | null;
};

export class CapabilityRepository {
  constructor(private readonly database: pg.Pool = pool) {}

  async configuration(tenantId: string, capabilityId: CapabilityId): Promise<CapabilityConfiguration> {
    const { rows } = await this.database.query<ConfigurationRow>(
      "SELECT enabled,shared_data_scope,preview_qualified,revision,updated_at FROM capability_configuration WHERE tenant_id=$1 AND capability_id=$2",
      [tenantId, capabilityId],
    );
    const row = rows[0];
    return row ? {
      enabled: row.enabled,
      sharedDataScope: row.shared_data_scope,
      previewQualified: row.preview_qualified,
      revision: row.revision,
      updatedAt: row.updated_at.toISOString(),
    } : { enabled: false, sharedDataScope: false, previewQualified: false, revision: 1 };
  }

  async setApplicationConfiguration(tenantId: string, capabilityId: CapabilityId, enabled: boolean, sharedDataScope: boolean, actorId: string) {
    const { rows } = await this.database.query<ConfigurationRow>(`INSERT INTO capability_configuration
      (tenant_id,capability_id,enabled,shared_data_scope,updated_by) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (tenant_id,capability_id) DO UPDATE SET enabled=EXCLUDED.enabled,shared_data_scope=EXCLUDED.shared_data_scope,
      revision=capability_configuration.revision+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
      RETURNING enabled,shared_data_scope,preview_qualified,revision,updated_at`, [tenantId, capabilityId, enabled, sharedDataScope, actorId]);
    await this.database.query("DELETE FROM capability_evidence WHERE tenant_id=$1 AND capability_id=$2", [tenantId, capabilityId]);
    const row = rows[0];
    return { enabled: row.enabled, sharedDataScope: row.shared_data_scope, previewQualified: row.preview_qualified, revision: row.revision, updatedAt: row.updated_at.toISOString() };
  }

  async evidence(key: EvidenceKey): Promise<CapabilityEvidence | undefined> {
    const { rows } = await this.database.query<EvidenceRow>(`SELECT status,details,observed_at,expires_at,last_success_at FROM capability_evidence
      WHERE tenant_id=$1 AND principal_id=$2 AND authorization_principal_id=$3 AND capability_id=$4 AND resource_audience=$5 AND environment_id=$6
      AND token_mode=$7 AND permission_revision=$8 AND contract_revision=$9 AND configuration_revision=$10`, keyValues(key));
    const row = rows[0];
    return row ? {
      status: row.status, details: row.details, observedAt: row.observed_at.toISOString(), expiresAt: row.expires_at.toISOString(),
      lastSuccessAt: row.last_success_at?.toISOString(),
    } : undefined;
  }

  async recordEvidence(key: EvidenceKey, status: CapabilityStatus, details: Record<string, unknown>, ttlMs: number) {
    const { rows } = await this.database.query<EvidenceRow>(`INSERT INTO capability_evidence
      (tenant_id,principal_id,authorization_principal_id,capability_id,resource_audience,environment_id,token_mode,permission_revision,contract_revision,configuration_revision,status,details,expires_at,last_success_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp()+($13::int*interval '1 millisecond'),CASE WHEN $11='available' THEN clock_timestamp() END)
      ON CONFLICT (tenant_id,principal_id,authorization_principal_id,capability_id,resource_audience,environment_id,token_mode,permission_revision,contract_revision,configuration_revision)
      DO UPDATE SET status=EXCLUDED.status,details=EXCLUDED.details,observed_at=clock_timestamp(),expires_at=EXCLUDED.expires_at,
      last_success_at=CASE WHEN EXCLUDED.status='available' THEN clock_timestamp() ELSE capability_evidence.last_success_at END
      RETURNING status,details,observed_at,expires_at,last_success_at`, [...keyValues(key), status, details, ttlMs]);
    const row = rows[0];
    return { status: row.status, details: row.details, observedAt: row.observed_at.toISOString(), expiresAt: row.expires_at.toISOString(), lastSuccessAt: row.last_success_at?.toISOString() };
  }

  async invalidatePrincipal(tenantId: string, principalId: string) {
    await this.database.query("DELETE FROM capability_evidence WHERE tenant_id=$1 AND authorization_principal_id=$2", [tenantId, principalId]);
  }

  async invalidateCapability(tenantId: string, capabilityId: CapabilityId) {
    await this.database.query("DELETE FROM capability_evidence WHERE tenant_id=$1 AND capability_id=$2", [tenantId, capabilityId]);
  }
}

export function capabilityPermissionRevision(definition: CapabilityDefinition) {
  return createHash("sha256").update(JSON.stringify({ audience: definition.audience, mode: definition.mode, permissions: definition.permissions, acceptedPermissions: definition.acceptedPermissions ?? [] })).digest("hex");
}

export function capabilityContractRevision(definition: CapabilityDefinition) {
  return createHash("sha256").update(JSON.stringify({
    internalRoles: definition.internalRoles,
    providerRoles: definition.providerRoles,
    licenses: definition.licenses,
    configuration: definition.configuration,
    maturity: definition.maturity,
    probe: definition.probe,
  })).digest("hex");
}

function keyValues(key: EvidenceKey) {
  return [key.tenantId, key.principalId, key.authorizationPrincipalId, key.capabilityId, key.resourceAudience, key.environmentId, key.tokenMode, key.permissionRevision, key.contractRevision, key.configurationRevision];
}