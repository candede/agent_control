export const agentIdentityMigrationSql = `
CREATE TABLE agent_identity_cache (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  record_id text NOT NULL CHECK (length(record_id) BETWEEN 1 AND 2048),
  snapshot_id uuid NOT NULL,
  native_id text NOT NULL CHECK (length(native_id) BETWEEN 1 AND 512),
  environment_id text NOT NULL CHECK (length(environment_id) BETWEEN 1 AND 512),
  source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{64}$'),
  candidate_id uuid NOT NULL CHECK (candidate_id<>'00000000-0000-0000-0000-000000000000'),
  application_id uuid CHECK (application_id<>'00000000-0000-0000-0000-000000000000'),
  checked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at>checked_at AND expires_at<=checked_at+interval '1 hour'),
  PRIMARY KEY (tenant_id,principal_id,record_id),
  FOREIGN KEY (snapshot_id,tenant_id,principal_id)
    REFERENCES power_platform_inventory_snapshots(id,tenant_id,principal_id) ON DELETE CASCADE
);
CREATE INDEX agent_identity_cache_expiry ON agent_identity_cache(expires_at);
CREATE FUNCTION clear_admitted_agent_identities() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('data-sync:'||NEW.tenant_id||':'||NEW.principal_id,0));
  DELETE FROM public.agent_identity_cache WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clear_admitted_agent_identities() FROM PUBLIC;
CREATE TRIGGER clear_admitted_agent_identities AFTER INSERT ON data_sync_runs
  FOR EACH ROW WHEN (NEW.clear_saved_data) EXECUTE FUNCTION clear_admitted_agent_identities();
`;

export const agentIdentityOutcomeMigrationSql = `
ALTER TABLE agent_identity_cache
  ADD COLUMN outcome text NOT NULL DEFAULT 'resolved'
    CHECK (outcome IN ('resolved','authorization_required','not_found','provider_error','setup_required')),
  ADD COLUMN runtime_status text NOT NULL DEFAULT 'unverified'
    CHECK (runtime_status IN ('available','missing','shared','unverified')),
  ADD COLUMN last_error_code text CHECK (last_error_code ~ '^[A-Za-z][A-Za-z0-9_.-]{0,127}$');
-- Retain verified object IDs; previous application IDs lack blueprint/creator collision checks.
UPDATE agent_identity_cache SET application_id=NULL;
ALTER TABLE agent_identity_cache
  ADD CONSTRAINT agent_identity_cache_outcome_fields CHECK (
    (outcome='resolved')=(last_error_code IS NULL)
    AND (runtime_status='available')=(application_id IS NOT NULL)
    AND (outcome='resolved' OR runtime_status='unverified')
  );
`;

export const agentIdentityClientIdMigrationSql = `
ALTER TABLE agent_identity_cache ADD COLUMN runtime_provenance text
  CHECK (runtime_provenance IS NULL OR runtime_provenance='verified-entra-agent-identity-client-id');
-- Only resolved rows have successful typed agentIdentity GET evidence. Do not promote failed candidates.
-- That resource's object ID and client ID always coincide; ordinary service principals do not share this rule.
UPDATE agent_identity_cache
  SET application_id=candidate_id,runtime_status='available',
    runtime_provenance='verified-entra-agent-identity-client-id'
  WHERE outcome='resolved';
ALTER TABLE agent_identity_cache ADD CONSTRAINT agent_identity_cache_client_id_provenance CHECK (
  (outcome='resolved')=(runtime_provenance IS NOT NULL)
  AND (runtime_provenance IS NULL OR (runtime_status='available' AND application_id=candidate_id))
);
`;
